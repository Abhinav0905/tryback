// Clothsy AI (by FabricVTON) REST client: the documented API, no SDK. Server-only.
// Every behaviour below is reconciled with the docs and the official `clothsy-ai` SDK
// (0.1.1) in docs/CLOTHSY-NOTES.md, which also lists what only `npm run probe` can verify.
//
//   POST /images         multipart `file` → 201 { id, expiresAt }          (free, 30/min, id valid 24 h)
//   POST /tryons         { personImageId, garmentImageId, title, consent }  → 202 { id, status, pollUrl }
//                        Idempotency-Key header required; 12 starts/min per account.
//                        A reused key returns that earlier try-on's CURRENT status (a new
//                        try-on is always "pending" here), so "success" = a free replay.
//   GET  /tryons/{id}    → { id, status: pending|success|failed, resultUrl|null, message? }
//                        (60 polls/min per account; we poll every 2.5 s through a 50/min limiter)
//   GET  /account        → { credits, scope: "account" | "key" } (free)
//
// Retry policy: 429/500/502/503/504 and network errors are retried with the SAME
// Idempotency-Key (so a retried start can never charge twice), honouring
// Retry-After, backing off 1 s → 2 s → 4 s, at most 4 attempts. Everything else
// fails fast. INVALID_IMAGE_ID drops the cached image ids, re-uploads and starts
// once more. Starts, uploads and polls go through process-wide sliding-window
// limiters (at most 10, 25 and 50 in any 60 s, below the account limits of 12, 30, 60).
// Results are stored byte-for-byte as downloaded, which keeps Clothsy's XMP AI label.

import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import { mutate, readDb } from "../store";
import {
  TryOnError,
  isTryOnError,
  type TryOnInput,
  type TryOnOutput,
  type TryOnProvider,
} from "./types";

/* ───────────────────────── Constants ───────────────────────── */

export const CLOTHSY_LIMITS = {
  maxImageBytes: 4 * 1024 * 1024,
  maxTitleChars: 120,
  pollIntervalMs: 2500,
  timeoutMs: 150_000,
  maxAttempts: 4,
  backoffMs: [1000, 2000, 4000] as readonly number[],
  /** Never wait longer than this for a single Retry-After. */
  maxRetryAfterMs: 60_000,
  requestTimeoutMs: 30_000,
  /** Time a poll sent at the 150 s deadline gets to complete (bounds poll retries, too). */
  pollGraceMs: 10_000,
  downloadTimeoutMs: 60_000,
  /** Reuse an uploaded image id until expiresAt − 1 h. */
  imageIdReuseMarginMs: 60 * 60 * 1000,
  imageIdTtlMs: 24 * 60 * 60 * 1000,
  startsPerMinute: 10,
  uploadsPerMinute: 25,
  /** Docs: 60 polls/min per account (errors page: 30/min per try-on). 2.5 s polling is 24/min per try-on. */
  pollsPerMinute: 50,
} as const;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(["RATE_LIMITED", "INTERNAL_ERROR", "START_FAILED", "UNAVAILABLE"]);
const NON_RETRYABLE_CODES = new Set([
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "MISSING_IDEMPOTENCY_KEY",
  "INVALID_IMAGE_URL",
  "IMAGE_DOWNLOAD_FAILED",
  "UNSUPPORTED_IMAGE",
  "INVALID_IMAGE_ID",
  "INVALID_API_KEY",
  "INSUFFICIENT_CREDITS",
  "CONSENT_REQUIRED",
  "IMAGE_TOO_LARGE",
  "PERSON_PHOTO_REJECTED",
  "IMAGE_REJECTED",
  "GARMENT_REJECTED",
]);

/** Fallback code when the error body carries none. */
const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "INVALID_API_KEY",
  402: "INSUFFICIENT_CREDITS",
  403: "CONSENT_REQUIRED",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "IMAGE_TOO_LARGE",
  422: "IMAGE_REJECTED",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "START_FAILED",
  503: "UNAVAILABLE",
  504: "UNAVAILABLE",
};

/* ───────────────────────── Small helpers ───────────────────────── */

type Sleep = (ms: number) => Promise<void>;
type FetchFn = typeof fetch;

// Not unref'd: a CLI (scripts/probe.ts) must stay alive through Retry-After and poll waits.
const realSleep: Sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortedError(): TryOnError {
  return new TryOnError("ABORTED", "Render aborted", false);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

/**
 * Settle with `p`, or reject with ABORTED as soon as `signal` fires. The abort
 * listener is always removed, so a long-lived signal (the probe shares one across
 * every poll) doesn't accumulate listeners.
 */
export function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Wrap an injectable sleep so it rejects as soon as `signal` aborts. */
export async function sleepWithSignal(sleep: Sleep, ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await raceAbort(sleep(ms), signal);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sniffImageType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Retry-After as seconds or an HTTP date → ms (null when absent/invalid). */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

function isRetryable(status: number, code: string): boolean {
  if (NON_RETRYABLE_CODES.has(code)) return false;
  if (RETRYABLE_STATUS.has(status)) return true;
  return status >= 500 && RETRYABLE_CODES.has(code);
}

function describeCause(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` (${cause.message})` : "";
    return `${err.name === "TimeoutError" ? "request timed out" : err.message}${causeMsg}`;
  }
  return String(err);
}

/** Parse a non-2xx response into a TryOnError using the documented `{ error, code }` body. */
async function errorFromResponse(res: Response, context: string, codeOverride?: string): Promise<TryOnError> {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const text = await res.text();
    if (text) {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object") {
        const b = body as { code?: unknown; error?: unknown; message?: unknown };
        if (typeof b.code === "string" && b.code) code = b.code;
        if (typeof b.error === "string") message = b.error;
        else if (b.error && typeof b.error === "object") {
          const inner = b.error as { message?: unknown; code?: unknown };
          if (typeof inner.message === "string") message = inner.message;
          if (!code && typeof inner.code === "string") code = inner.code;
        } else if (typeof b.message === "string") message = b.message;
      }
    }
  } catch {
    // Not JSON (proxy/CDN error page); fall back to the status.
  }
  const resolved = codeOverride ?? code ?? STATUS_CODES[res.status] ?? (res.status >= 500 ? "INTERNAL_ERROR" : "HTTP_ERROR");
  const retryable = isRetryable(res.status, code ?? resolved);
  const detail = message ?? (res.statusText || `HTTP ${res.status}`);
  return new TryOnError(resolved, `Clothsy ${context} failed (${res.status} ${code ?? resolved}): ${detail}`, retryable, res.status);
}

/** Per-request timeout combined with the caller's signal. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Request timed out", "TimeoutError")), ms);
  (timer as { unref?: () => void }).unref?.();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * A fresh key for the single post-reupload start (the first start never began, so this cannot
 * double-charge). Its own `_u1` namespace: the orchestrator's attempt suffix is `_r<n>`, so the
 * two never collide (a collision would replay this start's outcome for a later attempt).
 */
export function reuploadIdempotencyKey(key: string): string {
  return `${key.slice(0, 125)}_u1`;
}

/* ───────────────────────── Replays & observed headers ───────────────────────── */

/**
 * Replay headers we look for. Neither the docs nor the SDK name one (the SDK reads no response
 * header except Retry-After), so these are guesses kept for the probe to confirm or rule out.
 */
/** Result-download statuses that mean a replayed try-on's result URL has expired or been removed. */
export const REPLAY_EXPIRED_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

export const REPLAY_HEADER_CANDIDATES = [
  "idempotent-replayed",
  "idempotency-replayed",
  "x-idempotent-replayed",
  "x-idempotency-replayed",
] as const;

/**
 * Whether a POST /tryons answer is a replay of an earlier try-on (so this call adds no credit).
 * Only a FIRST attempt can be a replay of someone else's start: on a retry, the earlier attempt
 * of this same call may be the one that started it. Signals, strongest first:
 *  - status "success": documented, a new try-on is "Always pending here"; a reused key returns
 *    the earlier try-on's current status (SDK client.js `create()` doc comment);
 *  - a replay header set to "true" (unverified, see REPLAY_HEADER_CANDIDATES).
 */
export function detectStartReplay(p: {
  attempt: number;
  headers: Headers;
  bodyStatus: string | null | undefined;
}): { replayed: boolean; signal: "status" | "header" | null } {
  if (p.attempt !== 1) return { replayed: false, signal: null };
  if ((p.bodyStatus ?? "").toLowerCase() === "success") return { replayed: true, signal: "status" };
  for (const name of REPLAY_HEADER_CANDIDATES) {
    if ((p.headers.get(name) ?? "").trim().toLowerCase() === "true") return { replayed: true, signal: "header" };
  }
  return { replayed: false, signal: null };
}

const INTERESTING_HEADER_RE = /idempot|replay|request-?id|trace|ratelimit|rate-limit|retry-after|content-type|content-length|location|cache-control|expires/i;

/** Response headers worth recording in the probe report (never cookies or auth). */
export function headersOfInterest(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n === "set-cookie" || n.includes("auth")) return;
    if (INTERESTING_HEADER_RE.test(n)) out[n] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  });
  return out;
}

/** What the provider saw on the wire, for scripts/probe.ts (the app passes no observer). */
export type ClothsyObservation =
  | {
      kind: "start";
      httpStatus: number;
      attempt: number;
      idempotencyKey: string;
      tryOnId: string;
      bodyStatus: string | null;
      pollUrl: string | null;
      replayed: boolean;
      replaySignal: "status" | "header" | null;
      headers: Record<string, string>;
    }
  | { kind: "poll"; tryOnId: string; httpStatus: number; n: number; bodyStatus: string | null }
  | {
      kind: "download";
      tryOnId: string;
      httpStatus: number;
      contentTypeHeader: string | null;
      sniffedType: string | null;
      bytes: number;
      headers: Record<string, string>;
    };

/* ───────────────────────── Rate limiting ───────────────────────── */

/** What the provider needs from a rate limiter. */
export interface RateLimiter {
  readonly capacity: number;
  readonly windowMs: number;
  /** ms until an acquisition is allowed (0 = now). */
  waitMs(): number;
  available(): number;
  /** Wait for and consume one slot. Callers are served in arrival order. */
  take(sleep: Sleep, signal?: AbortSignal): Promise<void>;
}

/**
 * FIFO sliding-window limiter: at most `capacity` acquisitions in ANY trailing `windowMs`.
 * Unlike a token bucket (a full bucket on top of the steady refill allows up to ~2× capacity
 * in one window), this enforces the per-minute account limit exactly.
 */
export class SlidingWindowLimiter implements RateLimiter {
  private readonly stamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(t: number): void {
    while (this.stamps.length > 0 && this.stamps[0]! <= t - this.windowMs) this.stamps.shift();
  }

  waitMs(): number {
    const t = this.now();
    this.prune(t);
    if (this.stamps.length < this.capacity) return 0;
    return Math.max(1, this.stamps[0]! + this.windowMs - t);
  }

  available(): number {
    this.prune(this.now());
    return Math.max(0, this.capacity - this.stamps.length);
  }

  take(sleep: Sleep, signal?: AbortSignal): Promise<void> {
    const turn = this.tail.then(async () => {
      for (;;) {
        throwIfAborted(signal);
        const wait = this.waitMs();
        if (wait === 0) {
          this.stamps.push(this.now());
          return;
        }
        await sleepWithSignal(sleep, wait, signal);
      }
    });
    this.tail = turn.catch(() => undefined);
    return raceAbort(turn, signal);
  }
}

/** FIFO token bucket: `capacity` tokens refilled evenly over `windowMs`. */
export class TokenBucket implements RateLimiter {
  private tokens: number;
  private last: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs);
  }

  /** ms until a token is free (0 = available now). */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.max(1, Math.ceil(((1 - this.tokens) * this.windowMs) / this.capacity));
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Wait for and consume one token. Callers are served in arrival order. */
  take(sleep: Sleep, signal?: AbortSignal): Promise<void> {
    const turn = this.tail.then(async () => {
      for (;;) {
        throwIfAborted(signal);
        const wait = this.waitMs();
        if (wait === 0) {
          this.tokens -= 1;
          return;
        }
        await sleepWithSignal(sleep, wait, signal);
      }
    });
    this.tail = turn.catch(() => undefined);
    return raceAbort(turn, signal);
  }
}

export interface ClothsyRateLimiter {
  starts: RateLimiter;
  uploads: RateLimiter;
  /** Optional so limiters built before polls were limited (e.g. across dev HMR) keep working. */
  polls?: RateLimiter;
}

export function createClothsyLimiter(opts?: {
  startsPerMinute?: number;
  uploadsPerMinute?: number;
  pollsPerMinute?: number;
  now?: () => number;
}): ClothsyRateLimiter {
  return {
    starts: new SlidingWindowLimiter(opts?.startsPerMinute ?? CLOTHSY_LIMITS.startsPerMinute, 60_000, opts?.now),
    uploads: new SlidingWindowLimiter(opts?.uploadsPerMinute ?? CLOTHSY_LIMITS.uploadsPerMinute, 60_000, opts?.now),
    polls: new SlidingWindowLimiter(opts?.pollsPerMinute ?? CLOTHSY_LIMITS.pollsPerMinute, 60_000, opts?.now),
  };
}

// Process-wide (survives Next dev HMR and multiple provider instances).
const g = globalThis as unknown as { __trybackClothsyLimiter?: ClothsyRateLimiter };

export function sharedClothsyLimiter(): ClothsyRateLimiter {
  g.__trybackClothsyLimiter ??= createClothsyLimiter();
  return g.__trybackClothsyLimiter;
}

/* ───────────────────────── Image-id cache ───────────────────────── */

export interface ImageIdEntry {
  id: string;
  expiresAt: string;
}

export interface ImageIdCache {
  get(hash: string): Promise<ImageIdEntry | null>;
  set(hash: string, entry: ImageIdEntry): Promise<void>;
  delete(hash: string): Promise<void>;
}

const gs = globalThis as unknown as { __trybackStorePrimed?: Promise<unknown> };

/**
 * Load the JSON store once before touching it from parallel code paths.
 * store.load() now memoises its first load itself; this shared first read is kept
 * as a cheap belt-and-braces guard for this module's callers.
 */
export function ensureStoreLoaded(): Promise<unknown> {
  gs.__trybackStorePrimed ??= readDb().catch((err: unknown) => {
    gs.__trybackStorePrimed = undefined;
    throw err;
  });
  return gs.__trybackStorePrimed;
}

/** Default cache: `db.imageIds` in the JSON store, keyed by sha256 of the uploaded bytes. */
export const storeImageIdCache: ImageIdCache = {
  async get(hash) {
    await ensureStoreLoaded();
    const db = await readDb();
    return db.imageIds[hash] ?? null;
  },
  async set(hash, entry) {
    await ensureStoreLoaded();
    await mutate((db) => {
      const now = Date.now();
      for (const [k, v] of Object.entries(db.imageIds)) {
        if (Date.parse(v.expiresAt) <= now) delete db.imageIds[k];
      }
      db.imageIds[hash] = entry;
    });
  },
  async delete(hash) {
    await ensureStoreLoaded();
    await mutate((db) => {
      delete db.imageIds[hash];
    });
  },
};

/* ───────────────────────── Response schemas ───────────────────────── */

const UploadSchema = z.object({
  id: z.string().min(1),
  expiresAt: z.string().nullish(),
});

const TryOnSchema = z.object({
  id: z.string().min(1),
  status: z.string().nullish(),
  pollUrl: z.string().nullish(),
  resultUrl: z.string().nullish(),
  message: z.string().nullish(),
});
type TryOnBody = z.infer<typeof TryOnSchema>;

function readJson<S extends z.ZodType>(schema: S, context: string) {
  return async (res: Response): Promise<z.infer<S>> => {
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
      throw new TryOnError("BAD_RESPONSE", `Clothsy ${context}: response was not JSON`, true, res.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new TryOnError(
        "BAD_RESPONSE",
        `Clothsy ${context}: unexpected response shape (${parsed.error.issues[0]?.message ?? "invalid"})`,
        true,
        res.status,
      );
    }
    return parsed.data;
  };
}

/* ───────────────────────── Provider ───────────────────────── */

export interface ClothsyProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Clock used for latency, poll deadline and image-id expiry (default Date.now). */
  now?: () => number;
  /** Defaults to the process-wide limiter (10 starts/min, 25 uploads/min). */
  limiter?: ClothsyRateLimiter;
  /** Defaults to db.imageIds in the JSON store. */
  imageIdCache?: ImageIdCache;
  pollIntervalMs?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  /** Sees starts, polls and downloads as they happen (used by the probe). Must not throw. */
  onEvent?: (e: ClothsyObservation) => void;
}

interface CallSpec {
  method: "GET" | "POST";
  url: string;
  context: string;
  auth: boolean;
  headers?: Record<string, string>;
  body?: () => BodyInit;
  bucket?: keyof ClothsyRateLimiter;
  timeoutMs: number;
  /** Force this code on non-2xx responses (used for result downloads from the CDN). */
  codeOverride?: string;
  signal?: AbortSignal;
  /**
   * Hard stop (in this.now() time): request timeouts and retry waits are cut to it, and once
   * it passes the call throws `error()` instead of starting another attempt or wait.
   */
  deadline?: { at: number; error: () => TryOnError };
}

interface CallResult<T> {
  value: T;
  res: Response;
  attempt: number;
}

export class ClothsyProvider implements TryOnProvider {
  readonly name = "clothsy" as const;

  private readonly explicitKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchFn;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly limiter: ClothsyRateLimiter;
  private readonly cache: ImageIdCache;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onEvent: ((e: ClothsyObservation) => void) | null;
  /** In-flight uploads by content hash, so parallel renders of one photo upload it once. */
  private readonly uploads = new Map<string, Promise<string>>();

  constructor(opts?: ClothsyProviderOptions) {
    this.explicitKey = opts?.apiKey;
    this.baseUrl = (opts?.baseUrl ?? config.clothsyApiBase).replace(/\/+$/, "");
    this.fetchImpl = opts?.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts?.sleep ?? realSleep;
    this.now = opts?.now ?? Date.now;
    this.limiter = opts?.limiter ?? sharedClothsyLimiter();
    this.cache = opts?.imageIdCache ?? storeImageIdCache;
    this.pollIntervalMs = opts?.pollIntervalMs ?? CLOTHSY_LIMITS.pollIntervalMs;
    this.timeoutMs = opts?.timeoutMs ?? CLOTHSY_LIMITS.timeoutMs;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? CLOTHSY_LIMITS.requestTimeoutMs;
    this.onEvent = opts?.onEvent ?? null;
  }

  private emit(e: ClothsyObservation): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(e);
    } catch {
      // An observer must never break a render.
    }
  }

  private apiKey(): string | null {
    const k = this.explicitKey ?? config.clothsyApiKey;
    return k && k.trim() ? k.trim() : null;
  }

  async render(input: TryOnInput, signal?: AbortSignal): Promise<TryOnOutput> {
    const t0 = this.now();
    throwIfAborted(signal);
    if (!this.apiKey()) {
      throw new TryOnError("NO_API_KEY", "CLOTHSY_API_KEY is not set; live renders are unavailable.", false);
    }
    const person = this.checkImage(input.personBytes, input.personHash, "person photo");
    const garment = this.checkImage(input.garmentBytes, input.garmentHash, "garment image");
    if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
      throw new TryOnError("BAD_INPUT", "Idempotency key must be 8–128 chars of [A-Za-z0-9_-].", false);
    }
    const title = input.title.trim().slice(0, CLOTHSY_LIMITS.maxTitleChars);

    let [personImageId, garmentImageId] = await Promise.all([
      this.ensureImageId(input.personBytes, person.hash, person.type, false, signal),
      this.ensureImageId(input.garmentBytes, garment.hash, garment.type, false, signal),
    ]);

    let started: { body: TryOnBody; replayed: boolean };
    try {
      started = await this.start({ personImageId, garmentImageId, title }, input.idempotencyKey, signal);
    } catch (err) {
      if (!isTryOnError(err) || err.code !== "INVALID_IMAGE_ID") throw err;
      // An id expired or was never ours: forget both, upload again, start once more.
      await Promise.all([
        this.cache.delete(person.hash).catch(() => undefined),
        this.cache.delete(garment.hash).catch(() => undefined),
      ]);
      [personImageId, garmentImageId] = await Promise.all([
        this.ensureImageId(input.personBytes, person.hash, person.type, true, signal),
        this.ensureImageId(input.garmentBytes, garment.hash, garment.type, true, signal),
      ]);
      started = await this.start(
        { personImageId, garmentImageId, title },
        reuploadIdempotencyKey(input.idempotencyKey),
        signal,
      );
    }

    const tryOnId = started.body.id;
    const resultUrl = await this.waitForResult(started.body, signal);
    let downloaded: { bytes: Buffer; contentType: string };
    try {
      downloaded = await this.download(resultUrl, tryOnId, signal);
    } catch (err) {
      // A replayed key handed back an earlier try-on whose result URL has expired (docs: result
      // URLs last 24 h). The same key would replay the same dead URL forever, so report a code
      // that tells the orchestrator to move this render to a fresh key (1 credit, but it recovers).
      if (started.replayed && isTryOnError(err) && err.code === "DOWNLOAD_FAILED" && err.status !== undefined && REPLAY_EXPIRED_STATUSES.has(err.status)) {
        throw new TryOnError(
          "REPLAY_RESULT_EXPIRED",
          `Clothsy replayed try-on ${tryOnId} for this key, but its result is gone (HTTP ${err.status}); the next attempt uses a new key.`,
          false,
          err.status,
        );
      }
      throw err;
    }
    const { bytes, contentType } = downloaded;

    return {
      bytes,
      contentType,
      latencyMs: Math.max(0, Math.round(this.now() - t0)),
      provider: "clothsy",
      externalId: tryOnId,
      // A start that was already a replay on its first attempt was paid for by an earlier call.
      creditCharged: !started.replayed,
      replayed: started.replayed,
    };
  }

  /* ───────────── steps ───────────── */

  private checkImage(
    bytes: Buffer,
    hash: string,
    what: string,
  ): { hash: string; type: "image/jpeg" | "image/png" } {
    if (!bytes || bytes.length === 0) throw new TryOnError("BAD_INPUT", `The ${what} is empty.`, false);
    if (bytes.length > CLOTHSY_LIMITS.maxImageBytes) {
      throw new TryOnError("IMAGE_TOO_LARGE", `The ${what} is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 4 MB.`, false, 413);
    }
    const type = sniffImageType(bytes);
    if (type !== "image/jpeg" && type !== "image/png") {
      throw new TryOnError("UNSUPPORTED_IMAGE", `The ${what} must be a JPEG or PNG.`, false, 400);
    }
    return { hash: SHA256_HEX_RE.test(hash) ? hash : sha256Hex(bytes), type };
  }

  private async ensureImageId(
    bytes: Buffer,
    hash: string,
    type: "image/jpeg" | "image/png",
    fresh: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!fresh) {
      const cached = await this.cache.get(hash).catch(() => null);
      if (cached && Date.parse(cached.expiresAt) - CLOTHSY_LIMITS.imageIdReuseMarginMs > this.now()) {
        return cached.id;
      }
    }
    const inflight = this.uploads.get(hash);
    if (inflight) {
      try {
        return await raceAbort(inflight, signal);
      } catch (err) {
        // The other caller's upload was aborted, not ours: upload ourselves.
        if (!(isTryOnError(err) && err.code === "ABORTED") || signal?.aborted) throw err;
      }
    }
    const run = (async () => {
      const entry = await this.upload(bytes, hash, type, signal);
      await this.cache.set(hash, entry).catch((e: unknown) => {
        console.warn(`[clothsy] could not cache image id: ${describeCause(e)}`);
      });
      return entry.id;
    })();
    this.uploads.set(hash, run);
    try {
      return await run;
    } finally {
      if (this.uploads.get(hash) === run) this.uploads.delete(hash);
    }
  }

  private async upload(
    bytes: Buffer,
    hash: string,
    type: "image/jpeg" | "image/png",
    signal?: AbortSignal,
  ): Promise<ImageIdEntry> {
    const filename = `${hash.slice(0, 16)}.${type === "image/png" ? "png" : "jpg"}`;
    const { value } = await this.call(
      {
        method: "POST",
        url: `${this.baseUrl}/images`,
        context: "image upload",
        auth: true,
        bucket: "uploads",
        timeoutMs: this.requestTimeoutMs,
        signal,
        body: () => {
          const form = new FormData();
          form.append("file", new Blob([new Uint8Array(bytes)], { type }), filename);
          return form;
        },
      },
      readJson(UploadSchema, "image upload"),
    );
    const expiresMs = value.expiresAt ? Date.parse(value.expiresAt) : Number.NaN;
    const expiresAt = Number.isNaN(expiresMs)
      ? new Date(this.now() + CLOTHSY_LIMITS.imageIdTtlMs).toISOString()
      : new Date(expiresMs).toISOString();
    return { id: value.id, expiresAt };
  }

  private async start(
    ids: { personImageId: string; garmentImageId: string; title: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ body: TryOnBody; replayed: boolean }> {
    const payload = JSON.stringify({
      personImageId: ids.personImageId,
      garmentImageId: ids.garmentImageId,
      ...(ids.title ? { title: ids.title } : {}),
      consent: true,
    });
    const { value, res, attempt } = await this.call(
      {
        method: "POST",
        url: `${this.baseUrl}/tryons`,
        context: "try-on start",
        auth: true,
        bucket: "starts",
        timeoutMs: this.requestTimeoutMs,
        signal,
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: () => payload,
      },
      readJson(TryOnSchema, "try-on start"),
    );
    const replay = detectStartReplay({ attempt, headers: res.headers, bodyStatus: value.status });
    this.emit({
      kind: "start",
      httpStatus: res.status,
      attempt,
      idempotencyKey,
      tryOnId: value.id,
      bodyStatus: value.status ?? null,
      pollUrl: value.pollUrl ?? null,
      replayed: replay.replayed,
      replaySignal: replay.signal,
      headers: headersOfInterest(res.headers),
    });
    return { body: value, replayed: replay.replayed };
  }

  /** Poll GET /tryons/{id} every 2.5 s until success/failed, giving up after 150 s. */
  private async waitForResult(startBody: TryOnBody, signal?: AbortSignal): Promise<string> {
    const id = startBody.id;
    // A replayed start (reused Idempotency-Key) answers 202 with status "success" but, as the
    // 2026-11-09 probe showed, without resultUrl: that only comes from GET /tryons/{id}. Fetch it
    // right away instead of treating the start body as malformed.
    const startDone = (startBody.status ?? "").toLowerCase() === "success";
    const settled = startDone && !startBody.resultUrl ? null : this.settledResult(startBody);
    if (settled) return settled;
    let pollNow = startDone;

    const deadline = this.now() + this.timeoutMs;
    const timeout = () =>
      new TryOnError("TIMEOUT", `Clothsy try-on ${id} was still pending after ${Math.round(this.timeoutMs / 1000)} s.`, true);
    for (let n = 1; ; n++) {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw timeout();
      if (!pollNow) await sleepWithSignal(this.sleep, Math.min(this.pollIntervalMs, remaining), signal);
      pollNow = false;
      // Built from the id, like the SDK's retrieve(); pollUrl is the same path relative to the
      // API origin (docs), so it is recorded by the probe but not needed here.
      const { value, res } = await this.call(
        {
          method: "GET",
          url: `${this.baseUrl}/tryons/${encodeURIComponent(id)}`,
          context: "try-on poll",
          auth: true,
          bucket: "polls",
          timeoutMs: this.requestTimeoutMs,
          signal,
          // Poll retries (Retry-After up to 60 s, 30 s request timeouts) must not outlive the 150 s
          // budget; the grace only lets the last poll (sent at the deadline) complete.
          deadline: { at: deadline + CLOTHSY_LIMITS.pollGraceMs, error: timeout },
        },
        readJson(TryOnSchema, "try-on poll"),
      );
      this.emit({ kind: "poll", tryOnId: id, httpStatus: res.status, n, bodyStatus: value.status ?? null });
      const done = this.settledResult(value);
      if (done) return done;
    }
  }

  /** resultUrl when the body says success; throws RENDER_FAILED on failed; null while pending. */
  private settledResult(body: TryOnBody): string | null {
    const status = (body.status ?? "pending").toLowerCase();
    if (status === "failed") {
      throw new TryOnError(
        "RENDER_FAILED",
        body.message?.trim() || "The try-on failed and the credit was refunded.",
        false,
      );
    }
    if (status === "success") {
      if (!body.resultUrl) {
        throw new TryOnError("BAD_RESPONSE", `Clothsy try-on ${body.id} succeeded without a resultUrl.`, true);
      }
      return body.resultUrl;
    }
    return null;
  }

  /** Download the result right away (no auth; the URL expires in 24 h). */
  private async download(
    resultUrl: string,
    tryOnId: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    let url: URL;
    try {
      url = new URL(resultUrl, `${this.baseUrl}/`);
    } catch {
      throw new TryOnError("BAD_RESPONSE", `Clothsy returned an invalid resultUrl: ${resultUrl}`, false);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TryOnError("BAD_RESPONSE", `Clothsy returned a non-HTTP resultUrl (${url.protocol}).`, false);
    }
    const { value } = await this.call(
      {
        method: "GET",
        url: url.toString(),
        context: "result download",
        auth: false,
        timeoutMs: CLOTHSY_LIMITS.downloadTimeoutMs,
        codeOverride: "DOWNLOAD_FAILED",
        signal,
      },
      async (res) => {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length === 0) throw new TryOnError("DOWNLOAD_FAILED", "The result image was empty.", true);
        const header = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
        const sniffed = sniffImageType(bytes);
        this.emit({
          kind: "download",
          tryOnId,
          httpStatus: res.status,
          contentTypeHeader: header || null,
          sniffedType: sniffed,
          bytes: bytes.length,
          headers: headersOfInterest(res.headers),
        });
        // Docs: JPEG or PNG (the AI-label page also mentions WebP). Bytes are kept as downloaded.
        const contentType = sniffed ?? (header.startsWith("image/") ? header : null);
        if (!contentType) throw new TryOnError("DOWNLOAD_FAILED", "The result was not an image.", true);
        return { bytes, contentType };
      },
    );
    return value;
  }

  /* ───────────── transport with retry policy ───────────── */

  private async call<T>(spec: CallSpec, read: (res: Response) => Promise<T>): Promise<CallResult<T>> {
    const key = this.apiKey();
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(spec.signal);
      if (spec.deadline && spec.deadline.at - this.now() <= 0) throw spec.deadline.error();
      const bucket = spec.bucket ? this.limiter[spec.bucket] : undefined;
      if (bucket) await bucket.take(this.sleep, spec.signal);
      // Measured after any limiter wait, so the request timeout never outlives the deadline.
      const left = spec.deadline ? spec.deadline.at - this.now() : Number.POSITIVE_INFINITY;
      if (left <= 0) throw spec.deadline!.error();

      const headers: Record<string, string> = { Accept: spec.auth ? "application/json" : "image/*", ...spec.headers };
      if (spec.auth && key) headers.Authorization = `Bearer ${key}`;

      const { signal: reqSignal, cleanup } = withTimeout(spec.signal, Math.max(1, Math.min(spec.timeoutMs, left)));
      let failure: TryOnError;
      let retryAfterMs: number | null = null;
      try {
        const res = await this.fetchImpl(spec.url, {
          method: spec.method,
          headers,
          body: spec.body?.(),
          signal: reqSignal,
          redirect: "follow",
        });
        if (res.ok) {
          const value = await read(res);
          return { value, res, attempt };
        }
        failure = await errorFromResponse(res, spec.context, spec.codeOverride);
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
      } catch (err) {
        if (spec.signal?.aborted) throw abortedError();
        failure = isTryOnError(err)
          ? err
          : new TryOnError(
              spec.codeOverride ?? "NETWORK_ERROR",
              `Clothsy ${spec.context} failed: ${describeCause(err)}`,
              true,
            );
      } finally {
        cleanup();
      }

      if (!failure.retryable || attempt >= CLOTHSY_LIMITS.maxAttempts) throw failure;
      const backoff = CLOTHSY_LIMITS.backoffMs[Math.min(attempt - 1, CLOTHSY_LIMITS.backoffMs.length - 1)] ?? 4000;
      const wait = retryAfterMs !== null ? Math.min(retryAfterMs, CLOTHSY_LIMITS.maxRetryAfterMs) : backoff;
      if (spec.deadline && this.now() + wait >= spec.deadline.at) throw spec.deadline.error();
      await sleepWithSignal(this.sleep, wait, spec.signal);
    }
  }
}

/* ───────────────────────── Account ───────────────────────── */

/** Documented GET /account body: `{ credits: number, scope: "account" | "key" }` (free to call). */
export interface ClothsyAccountInfo {
  credits: number | null;
  /** "account": the key draws on the account balance; "key": the key has its own allowance. */
  scope: string | null;
}

export type ClothsyAccountResult =
  | ({ ok: true; httpStatus: number; body: unknown; latencyMs: number } & ClothsyAccountInfo)
  | { ok: false; httpStatus: number | null; code: string; message: string; retryable: boolean; latencyMs: number };

/** Read credits (documented `credits`, with tolerant fallbacks) and scope from an /account body. */
export function parseClothsyAccount(body: unknown): ClothsyAccountInfo {
  const scope =
    body && typeof body === "object" && typeof (body as { scope?: unknown }).scope === "string"
      ? (body as { scope: string }).scope
      : null;
  return { credits: creditsFromAccount(body), scope };
}

/**
 * GET /account with the exact outcome: credits and scope, or the API error code
 * (401 INVALID_API_KEY, 500 INTERNAL_ERROR, 503 UNAVAILABLE), NETWORK_ERROR or NO_API_KEY.
 * Costs no credits and never starts a try-on. Never throws.
 */
export async function fetchClothsyAccount(opts?: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ClothsyAccountResult> {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const apiKey = (opts?.apiKey ?? config.clothsyApiKey)?.trim();
  if (!apiKey) {
    return { ok: false, httpStatus: null, code: "NO_API_KEY", message: "CLOTHSY_API_KEY is not set.", retryable: false, latencyMs: 0 };
  }
  const base = (opts?.baseUrl ?? config.clothsyApiBase).replace(/\/+$/, "");
  const doFetch: FetchFn = opts?.fetchImpl ?? ((input, init) => fetch(input, init));
  const { signal, cleanup } = withTimeout(undefined, opts?.timeoutMs ?? 8000);
  try {
    const res = await doFetch(`${base}/account`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      const err = await errorFromResponse(res, "account lookup");
      return { ok: false, httpStatus: res.status, code: err.code, message: err.message, retryable: err.retryable, latencyMs: elapsed() };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        code: "BAD_RESPONSE",
        message: "Clothsy account lookup: response was not JSON",
        retryable: true,
        latencyMs: elapsed(),
      };
    }
    return { ok: true, httpStatus: res.status, body, ...parseClothsyAccount(body), latencyMs: elapsed() };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      code: "NETWORK_ERROR",
      message: `Clothsy account lookup failed: ${describeCause(err)}`,
      retryable: true,
      latencyMs: elapsed(),
    };
  } finally {
    cleanup();
  }
}

/**
 * GET /account, best effort for /api/status and the probe. Resolves to the
 * parsed JSON body, or null when no key is configured or the call fails.
 * Never throws.
 */
export async function clothsyAccount(opts?: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<unknown> {
  const result = await fetchClothsyAccount({ ...opts, timeoutMs: opts?.timeoutMs ?? 5000 });
  if (result.ok) return result.body;
  if (result.code !== "NO_API_KEY") console.warn(`[clothsy] ${result.message}`);
  return null;
}

/**
 * Pull a remaining-credits number out of an /account body. The documented field is `credits`
 * (docs + SDK `account.credits()` → `Number(data.credits)`); the other keys are tolerated so an
 * unannounced shape change degrades to a number rather than to "unknown".
 */
export function creditsFromAccount(account: unknown): number | null {
  if (!account || typeof account !== "object") return null;
  const a = account as Record<string, unknown>;
  for (const k of ["credits", "creditsRemaining", "remainingCredits", "credit_balance", "creditBalance", "balance"]) {
    const v = a[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      for (const ik of ["remaining", "available", "balance"]) {
        const iv = inner[ik];
        if (typeof iv === "number" && Number.isFinite(iv)) return iv;
      }
    }
  }
  for (const k of ["account", "data"]) {
    if (a[k] && typeof a[k] === "object") {
      const nested = creditsFromAccount(a[k]);
      if (nested !== null) return nested;
    }
  }
  return null;
}
