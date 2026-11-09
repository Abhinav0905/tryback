// Try-on entry point for the orchestrator and /api/status. Server-only.
//
// Picks a provider (live Clothsy vs the simulated dev double), and wraps every
// render in a content-addressed cache:
//   bytes    → store.saveRender(cacheKey)         (.data/renders/<key>.img)
//   metadata → db.renderIndex[cacheKey]           (provider, latency, contentType, externalId)
//   counter  → db.liveRendersByDay[utcDay()]      (live successes only; drives DAILY_LIVE_RENDER_CAP)
//
// The store lock (mutate) is only ever held for the bookkeeping writes, never
// while a provider is rendering.

import { createHash } from "node:crypto";
import { config, RENDER_PIPELINE_VERSION } from "../config";
import {
  hasRender,
  mutate,
  readDb,
  readRender,
  renderBlobName,
  saveRender,
  utcDay,
  type Db,
  type RenderIndexEntry,
} from "../store";
import { ClothsyProvider, ensureStoreLoaded } from "./clothsy";
import { DevDoubleProvider } from "./devDouble";
import type { TryOnMode } from "../types";
import { TryOnError, isTryOnError, type TryOnInput, type TryOnOutput, type TryOnProvider } from "./types";

export * from "./types";
export {
  ClothsyProvider,
  clothsyAccount,
  creditsFromAccount,
  fetchClothsyAccount,
  parseClothsyAccount,
  type ClothsyAccountInfo,
  type ClothsyAccountResult,
} from "./clothsy";
export { DevDoubleProvider } from "./devDouble";
export { loadGarmentImage } from "./garment";

export const API_VERSION: string = RENDER_PIPELINE_VERSION;

const CACHE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Why resolveProvider chose what it chose (surfaced in logs and /api/status). */
export type ProviderReason =
  | "mode_dev" // TRYON_MODE=dev
  | "replay" // TRYON_MODE=replay, or this session isn't allowed live renders
  | "live" // live Clothsy render
  | "no_key" // auto/live mode without CLOTHSY_API_KEY
  | "daily_cap"; // DAILY_LIVE_RENDER_CAP reached for today (UTC)

export type RenderWithCacheResult = TryOnOutput & {
  fromCache: boolean;
  /** Stored version of the bytes (null = the key's first write); part of the result URL. */
  version: string | null;
};

/** Test seam: stand-ins for the real providers. `clothsy: null` simulates "no API key". */
export interface ProviderOverrides {
  clothsy?: TryOnProvider | null;
  dev?: TryOnProvider;
}

interface TryOnState {
  liveCount: { day: string; count: number } | null;
  /** Live renders currently running in this process (reserved against the daily cap). */
  inflightLive: number;
  /** Renders in progress by cache key (coalesces duplicate requests). */
  inflight: Map<string, Promise<RenderWithCacheResult>>;
  clothsy: { key: string; provider: ClothsyProvider } | null;
  dev: { key: string; provider: DevDoubleProvider } | null;
  overrides: ProviderOverrides | null;
  refreshing: Promise<number> | null;
}

// Process-wide (survives Next dev HMR).
const g = globalThis as unknown as { __trybackTryon?: TryOnState };
g.__trybackTryon ??= {
  liveCount: null,
  inflightLive: 0,
  inflight: new Map(),
  clothsy: null,
  dev: null,
  overrides: null,
  refreshing: null,
};
const state = g.__trybackTryon;

/* ───────────────────────── Cache key ───────────────────────── */

/**
 * Content address of a render. `garmentHash` (sha256 of the prepared product shot) is part of
 * the key when known, so replacing a catalogue image (e.g. placeholders → real photos) never
 * replays renders of the old image, and the idempotency key changes with the request body.
 */
export function renderCacheKey(p: {
  personHash: string;
  skuId: string;
  garmentVariant: "primary" | "alt";
  garmentHash?: string | null;
}): string {
  const garment = p.garmentHash ? `\n${p.garmentHash}` : "";
  return createHash("sha256")
    .update(`tryback-render\n${API_VERSION}\n${p.personHash}\n${p.skuId}\n${p.garmentVariant}${garment}`)
    .digest("hex")
    .slice(0, 40);
}

/**
 * App URL of a render. The bytes behind a URL never change (it is served as immutable), so
 * a re-render of the same key is a new version with its own URL.
 */
export function renderResultUrl(cacheKey: string, version: string | null | undefined): string {
  return version ? `/api/renders/${cacheKey}?v=${encodeURIComponent(version)}` : `/api/renders/${cacheKey}`;
}

/* ───────────────────────── Providers ───────────────────────── */

export function setProviderOverrides(overrides: ProviderOverrides | null): void {
  state.overrides = overrides;
  state.inflight.clear();
}

function devProvider(): TryOnProvider {
  if (state.overrides?.dev) return state.overrides.dev;
  const key = `${config.devRenderLatencyMs}|${config.devFailRate}`;
  if (state.dev?.key !== key) state.dev = { key, provider: new DevDoubleProvider() };
  return state.dev.provider;
}

function clothsyProvider(): TryOnProvider | null {
  if (state.overrides && state.overrides.clothsy !== undefined) return state.overrides.clothsy;
  const apiKey = config.clothsyApiKey;
  if (!apiKey) return null;
  const key = `${apiKey}|${config.clothsyApiBase}`;
  if (state.clothsy?.key !== key) state.clothsy = { key, provider: new ClothsyProvider() };
  return state.clothsy.provider;
}

/* ───────────────────────── Daily live counter ───────────────────────── */

function setLiveCount(count: number): void {
  state.liveCount = { day: utcDay(), count };
}

/** Best-known live renders today (sync). Primed by every renderWithCache/liveRendersToday call. */
function knownLiveCount(): number {
  const today = utcDay();
  if (!state.liveCount) {
    void liveRendersToday().catch(() => undefined);
    return 0;
  }
  return state.liveCount.day === today ? state.liveCount.count : 0;
}

/** Live (credit-consuming) renders recorded today (UTC), read from the store. */
export function liveRendersToday(): Promise<number> {
  state.refreshing ??= ensureStoreLoaded()
    .then(() => readDb())
    .then((db) => {
      const n = db.liveRendersByDay[utcDay()] ?? 0;
      setLiveCount(n);
      return n;
    })
    .finally(() => {
      state.refreshing = null;
    });
  return state.refreshing;
}

/* ───────────────────────── Resolution ───────────────────────── */

/**
 * The provider rules as a pure function (no store reads, no provider construction), shared by
 * resolveProvider and `npm run doctor`. `liveCount` is only consulted when it matters.
 * Rules: mode dev → dev; replay or !allowLive → 'replay' (cache only, else dev);
 * live/auto with key and under the daily cap → clothsy; else dev.
 */
export function decideProvider(p: {
  mode: TryOnMode;
  allowLive: boolean;
  hasKey: boolean;
  liveCount: number | (() => number);
  dailyCap: number;
}): { name: "clothsy" | "dev"; reason: ProviderReason } {
  if (p.mode === "dev") return { name: "dev", reason: "mode_dev" };
  if (p.mode === "replay" || !p.allowLive) return { name: "dev", reason: "replay" };
  if (!p.hasKey) return { name: "dev", reason: "no_key" };
  const live = typeof p.liveCount === "function" ? p.liveCount() : p.liveCount;
  if (live >= p.dailyCap) return { name: "dev", reason: "daily_cap" };
  return { name: "clothsy", reason: "live" };
}

/**
 * Rules: see decideProvider. In-flight live renders count against the cap so a burst can't
 * overshoot it.
 */
export function resolveProvider(opts: { allowLive: boolean }): { provider: TryOnProvider; reason: ProviderReason } {
  const mode = config.tryOnMode;
  const clothsy = mode === "dev" || mode === "replay" || !opts.allowLive ? null : clothsyProvider();
  const decision = decideProvider({
    mode,
    allowLive: opts.allowLive,
    hasKey: clothsy !== null,
    liveCount: () => knownLiveCount() + state.inflightLive,
    dailyCap: config.dailyLiveRenderCap,
  });
  return { provider: decision.name === "clothsy" && clothsy ? clothsy : devProvider(), reason: decision.reason };
}

/** Which provider a new render would use right now (for /api/status). */
export function activeProviderName(opts: { allowLive: boolean }): "clothsy" | "dev" {
  return resolveProvider(opts).provider.name;
}

/* ───────────────────────── Cached render ───────────────────────── */

/**
 * Hit → cached bytes (fromCache: true, creditCharged: false, original provider and
 * latency), EXCEPT when the active provider is clothsy and the cached entry came
 * from 'dev': then it upgrades to a live render. On a live success it increments
 * db.liveRendersByDay[utcDay()]. Concurrent calls for one key share one render.
 */
export async function renderWithCache(p: {
  cacheKey: string;
  input: TryOnInput;
  allowLive: boolean;
  signal?: AbortSignal;
}): Promise<RenderWithCacheResult> {
  if (!CACHE_KEY_RE.test(p.cacheKey)) {
    throw new TryOnError("BAD_INPUT", `Invalid render cache key: ${p.cacheKey}`, false);
  }
  const existing = state.inflight.get(p.cacheKey);
  if (existing) {
    const shared = await existing;
    return { ...shared, fromCache: true, creditCharged: false };
  }
  const run = renderUncoalesced(p);
  state.inflight.set(p.cacheKey, run);
  try {
    return await run;
  } finally {
    if (state.inflight.get(p.cacheKey) === run) state.inflight.delete(p.cacheKey);
  }
}

function fromEntry(entry: RenderIndexEntry, bytes: Buffer): RenderWithCacheResult {
  return {
    bytes,
    contentType: entry.contentType,
    latencyMs: entry.latencyMs,
    provider: entry.provider,
    externalId: entry.externalId,
    creditCharged: false,
    fromCache: true,
    version: entry.version ?? null,
  };
}

function readEntryBytes(cacheKey: string, entry: RenderIndexEntry): Promise<Buffer | null> {
  return readRender(renderBlobName(cacheKey, entry.version));
}

async function renderUncoalesced(p: {
  cacheKey: string;
  input: TryOnInput;
  allowLive: boolean;
  signal?: AbortSignal;
}): Promise<RenderWithCacheResult> {
  await ensureStoreLoaded();
  const db: Db = await readDb();
  setLiveCount(db.liveRendersByDay[utcDay()] ?? 0);
  const entry = db.renderIndex[p.cacheKey] ?? null;

  const { provider, reason } = resolveProvider({ allowLive: p.allowLive });
  const upgrade = entry !== null && provider.name === "clothsy" && entry.provider === "dev";

  if (entry && !upgrade) {
    const bytes = await readEntryBytes(p.cacheKey, entry);
    if (bytes) return fromEntry(entry, bytes);
    // Index entry without bytes (e.g. deleted renders dir): render again.
  }

  // A live render holds a reservation against the daily cap until the counter below is
  // committed, so a request arriving while this one is being stored can't overshoot the cap.
  const live = provider.name === "clothsy";
  if (live) state.inflightLive += 1;
  try {
    let output: TryOnOutput;
    try {
      output = await provider.render(p.input, p.signal);
    } catch (err) {
      if (upgrade && entry && !(isTryOnError(err) && err.code === "ABORTED")) {
        // The live upgrade failed; the simulated render we already have is still valid.
        const bytes = await readEntryBytes(p.cacheKey, entry);
        if (bytes) {
          const code = isTryOnError(err) ? err.code : "ERROR";
          console.warn(`[tryon] live upgrade of ${p.cacheKey} failed (${code}); serving the cached simulated preview`);
          return fromEntry(entry, bytes);
        }
      }
      throw err;
    }

    // Never overwrite bytes a URL already points at (served immutable): a re-render of a
    // key that has an index entry or a stored file is written as a new version.
    const reused = entry !== null || (await hasRender(p.cacheKey).catch(() => false));
    const version = reused ? `${output.provider}-${Date.now().toString(36)}` : null;
    try {
      await saveRender(renderBlobName(p.cacheKey, version), output.bytes);
    } catch (err) {
      throw new TryOnError(
        "CACHE_WRITE_FAILED",
        `Render succeeded but could not be stored: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    const indexEntry: RenderIndexEntry = {
      provider: output.provider,
      latencyMs: output.latencyMs,
      createdAt: new Date().toISOString(),
      contentType: output.contentType,
      externalId: output.externalId,
      ...(version ? { version } : {}),
    };
    let count: number;
    try {
      count = await mutate((d) => {
        d.renderIndex[p.cacheKey] = indexEntry;
        const day = utcDay();
        if (output.provider === "clothsy") d.liveRendersByDay[day] = (d.liveRendersByDay[day] ?? 0) + 1;
        return d.liveRendersByDay[day] ?? 0;
      });
    } catch (err) {
      // Without an index entry /api/renders/<key> can't serve the image. Retrying is
      // credit-safe: the same Idempotency-Key replays the finished try-on.
      if (output.provider === "clothsy") setLiveCount(knownLiveCount() + 1);
      throw new TryOnError(
        "CACHE_WRITE_FAILED",
        `Render succeeded (${reason}) but could not be indexed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    setLiveCount(count);

    return { ...output, fromCache: false, version };
  } finally {
    if (live) state.inflightLive = Math.max(0, state.inflightLive - 1);
  }
}
