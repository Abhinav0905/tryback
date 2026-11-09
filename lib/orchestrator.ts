// Render orchestration: schedules try-on jobs on a return case and runs them.
//
// Invariants:
//   • Every state transition is its own short `mutate()`; the store lock is never
//     held while a provider is rendering.
//   • `runJobs` / `runRenderJob` never throw and never leave unhandled rejections —
//     they are called from `after()` where nobody is listening.
//   • The per-return render cap counts every job except 'skipped' (retries included).

// Server-only module (store uses node:fs).
import { createHash } from "node:crypto";
import { getSku } from "./catalog";
import { config } from "./config";
import { mutate, newId, readDb, readPhoto } from "./store";
import { renderCacheKey, renderResultUrl, renderWithCache } from "./tryon";
import { loadGarmentImage } from "./tryon/garment";
import { describeTryOnError, isTryOnError } from "./tryon/types";
import type { RenderJob, RenderPhase, ReturnCase, SizeCode, TransitionType } from "./types";

export interface RenderPick {
  skuId: string;
  size: SizeCode;
  transition: TransitionType;
}

/** Phases whose first success counts as the shopper's "first card". */
const CARD_PHASES: ReadonlySet<RenderPhase> = new Set(["speculative", "post_diagnosis", "retry"]);

/** Statuses that mean a job for this sku+variant is already in hand (or on its way). */
const ACTIVE_STATUSES: ReadonlySet<RenderJob["status"]> = new Set(["queued", "running", "success"]);

/** Jobs that count toward MAX_RENDERS_PER_RETURN. */
export function countedJobs(r: ReturnCase): number {
  return r.renders.filter((j) => j.status !== "skipped").length;
}

/** Renders still available under the per-return cap. */
export function remainingRenderBudget(r: ReturnCase): number {
  return Math.max(0, config.maxRendersPerReturn - countedJobs(r));
}

/** True if a queued/running/successful job exists for this sku + garment variant. */
export function hasActiveJob(r: ReturnCase, skuId: string, variant: RenderJob["garmentVariant"] = "primary"): boolean {
  return r.renders.some((j) => j.skuId === skuId && j.garmentVariant === variant && ACTIVE_STATUSES.has(j.status));
}

/**
 * Failures that depend only on this photo + garment image, so rendering the same SKU again
 * would fail the same way (and waste a render slot).
 */
const DETERMINISTIC_FAILURES: ReadonlySet<string> = new Set([
  "GARMENT_REJECTED",
  "IMAGE_REJECTED",
  "PERSON_PHOTO_REJECTED",
  "UNSUPPORTED_IMAGE",
  "IMAGE_TOO_LARGE",
  "GARMENT_IMAGE_MISSING",
  "UNKNOWN_SKU",
  "PHOTO_MISSING",
  "PHOTO_MISMATCH",
]);

/** True if a primary render of this SKU already failed for a reason a re-render can't fix. */
export function hasDeterministicFailure(r: ReturnCase, skuId: string): boolean {
  return r.renders.some(
    (j) =>
      j.skuId === skuId &&
      j.garmentVariant === "primary" &&
      j.status === "failed" &&
      j.error !== null &&
      DETERMINISTIC_FAILURES.has(j.error.code),
  );
}

/**
 * The shopper's first card: the earliest finished render that is actually on screen, i.e. a
 * swap phase, a SKU still among the candidates (the form re-ranks them), not dropped by the gate.
 */
export function firstCardAtFor(r: ReturnCase): string | null {
  const shown = new Set(r.candidates.map((c) => c.skuId));
  let first: string | null = null;
  for (const j of r.renders) {
    if (!CARD_PHASES.has(j.phase) || j.status !== "success" || !j.finishedAt || !j.resultUrl) continue;
    if (!shown.has(j.skuId) || j.gate?.verdict === "drop") continue;
    if (first === null || j.finishedAt < first) first = j.finishedAt;
  }
  return first;
}

/** Hashes of the product shots the picks would render (by sku id); missing images are left out. */
async function garmentHashes(skuIds: string[], variant: RenderJob["garmentVariant"]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(skuIds)].map(async (id) => {
      const sku = getSku(id);
      if (!sku || (variant === "alt" && !sku.altImage)) return;
      try {
        out.set(id, (await loadGarmentImage(sku, variant)).hash);
      } catch {
        // The job will fail with GARMENT_IMAGE_MISSING when it runs; its key doesn't matter.
      }
    }),
  );
  return out;
}

function newJob(
  r: ReturnCase,
  personHash: string,
  pick: RenderPick,
  phase: RenderPhase,
  variant: RenderJob["garmentVariant"],
  now: string,
  garmentHash: string | null,
): RenderJob {
  return {
    id: newId("job"),
    returnId: r.id,
    skuId: pick.skuId,
    size: pick.size,
    phase,
    transition: pick.transition,
    garmentVariant: variant,
    status: "queued",
    provider: null,
    fromCache: false,
    cacheKey: renderCacheKey({ personHash, skuId: pick.skuId, garmentVariant: variant, garmentHash }),
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    latencyMs: null,
    resultUrl: null,
    error: null,
    creditCharged: false,
    gate: null,
    retryOf: null,
    supersededBy: null,
    externalId: null,
  };
}

/**
 * Append queued jobs atomically. Skips unknown SKUs and picks already
 * rendered/queued for the same sku+variant, and stops at the per-return cap.
 * Returns only the NEW jobs (possibly empty). Requires an uploaded photo.
 */
export async function scheduleRenders(returnId: string, picks: RenderPick[], phase: RenderPhase): Promise<RenderJob[]> {
  if (picks.length === 0) return [];
  const variant: RenderJob["garmentVariant"] = phase === "retry" ? "alt" : "primary";
  // Product shots are hashed into the cache key; load them before taking the store lock.
  const garments = await garmentHashes(
    picks.map((p) => p.skuId),
    variant,
  );
  return mutate((db) => {
    const r = db.returns[returnId];
    if (!r) throw new Error(`Return ${returnId} not found`);
    if (!r.photo || r.photoSkipped || r.status === "resolved") return [];

    const now = new Date().toISOString();
    const created: RenderJob[] = [];
    const seen = new Set<string>();

    for (const pick of picks) {
      if (countedJobs(r) >= config.maxRendersPerReturn) break;
      const sku = getSku(pick.skuId);
      if (!sku) continue;
      if (variant === "alt" && !sku.altImage) continue;
      if (seen.has(pick.skuId) || hasActiveJob(r, pick.skuId, variant)) continue;
      seen.add(pick.skuId);
      const job = newJob(r, r.photo.hash, pick, phase, variant, now, garments.get(pick.skuId) ?? null);
      r.renders.push(job);
      created.push(job);
    }
    return created;
  });
}

/** Run several jobs concurrently. Never throws. */
export async function runJobs(returnId: string, jobIds: string[], opts: { allowLive: boolean }): Promise<void> {
  try {
    const results = await Promise.allSettled(jobIds.map((id) => runRenderJob(returnId, id, opts)));
    for (const res of results) {
      if (res.status === "rejected") console.error("[orchestrator] job runner rejected", res.reason);
    }
  } catch (err) {
    console.error("[orchestrator] runJobs failed", err);
  }
}

interface Claimed {
  skuId: string;
  variant: RenderJob["garmentVariant"];
  cacheKey: string;
  personHash: string | null;
  /** Refunded, terminal failures already recorded for this cache key (see renderIdempotencyKey). */
  attempt: number;
}

/**
 * Failures after which the try-on API holds a *failed, uncharged* outcome for the key: the
 * try-on ended `failed` (credit refunded) or a request was rejected (4xx), so nothing was or
 * will be charged. Only these move a cache key to its next idempotency key. After a TIMEOUT,
 * a failed download or cache write, a network/5xx error or a stale job, the try-on may have
 * finished (and been paid for): the next attempt reuses the key and replays it for free.
 */
export const REFUNDED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "RENDER_FAILED",
  "BAD_REQUEST",
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

/**
 * Failures after which the cache key must also move to a fresh idempotency key, although the
 * credit was spent: the key replays an earlier, finished try-on whose result URL has expired
 * (REPLAY_RESULT_EXPIRED), so reusing it can never produce an image again.
 */
export const FRESH_KEY_FAILURE_CODES: ReadonlySet<string> = new Set([...REFUNDED_FAILURE_CODES, "REPLAY_RESULT_EXPIRED"]);

/**
 * Idempotency key for a render attempt: `tb_${cacheKey}` for the first attempt, as the
 * contract says, so a crashed-and-rerun render never charges twice. The try-on API also
 * replays *failures* for a reused key, so after a refunded failure (REFUNDED_FAILURE_CODES,
 * counted per cache key in db.renderAttempts, across returns and demo resets) the next
 * attempt gets a suffix (`_r1`, `_r2`, …). The provider's re-upload key uses `_u1`.
 */
export function renderIdempotencyKey(cacheKey: string, attempt: number): string {
  return attempt > 0 ? `tb_${cacheKey}_r${attempt}` : `tb_${cacheKey}`;
}

/**
 * queued → running(startedAt) → success | failed. Idempotent: a job that is not
 * 'queued' (already running, finished, or skipped) is left alone. Never throws.
 */
export async function runRenderJob(returnId: string, jobId: string, opts: { allowLive: boolean }): Promise<void> {
  // 1. Claim the job (short lock).
  let claimed: Claimed | null;
  try {
    claimed = await mutate((db): Claimed | null => {
      const job = db.returns[returnId]?.renders.find((j) => j.id === jobId);
      if (!job || job.status !== "queued") return null;
      job.status = "running";
      job.startedAt = new Date().toISOString();
      const r = db.returns[returnId];
      return {
        skuId: job.skuId,
        variant: job.garmentVariant,
        cacheKey: job.cacheKey,
        personHash: r.photo?.hash ?? null,
        attempt: db.renderAttempts?.[job.cacheKey] ?? 0,
      };
    });
  } catch (err) {
    console.error(`[orchestrator] could not claim job ${jobId}`, err);
    return;
  }
  if (!claimed) return;

  // 2. Render with no lock held.
  try {
    const sku = getSku(claimed.skuId);
    if (!sku) throw new LocalError("UNKNOWN_SKU", `Unknown SKU ${claimed.skuId}`);
    if (claimed.variant === "alt" && !sku.altImage) {
      throw new LocalError("GARMENT_IMAGE_MISSING", "No alternate product image for this item");
    }
    const personBytes = await readPhoto(returnId);
    if (!personBytes) throw new LocalError("PHOTO_MISSING", "The photo for this return is no longer available");
    const personHash = createHash("sha256").update(personBytes).digest("hex");
    // The cache key was derived from the recorded hash: never cache other bytes under it.
    if (claimed.personHash && claimed.personHash !== personHash) {
      throw new LocalError("PHOTO_MISMATCH", "The stored photo doesn't match this return's photo record");
    }
    const garment = await loadGarmentImage(sku, claimed.variant);

    const out = await renderWithCache({
      cacheKey: claimed.cacheKey,
      allowLive: opts.allowLive,
      input: {
        personBytes,
        personHash,
        garmentBytes: garment.bytes,
        garmentHash: garment.hash,
        title: sku.apiTitle,
        idempotencyKey: renderIdempotencyKey(claimed.cacheKey, claimed.attempt),
      },
    });

    // 3. Record success + accounting (short lock).
    await mutate((db) => {
      const r = db.returns[returnId];
      const job = r?.renders.find((j) => j.id === jobId);
      if (!r || !job) return;
      const finishedAt = new Date().toISOString();
      job.status = "success";
      job.finishedAt = finishedAt;
      job.latencyMs = Math.max(0, Math.round(out.latencyMs));
      job.provider = out.provider;
      job.fromCache = out.fromCache;
      job.creditCharged = out.creditCharged;
      job.externalId = out.externalId;
      job.resultUrl = renderResultUrl(claimed.cacheKey, out.version);
      job.error = null;
      r.creditsSpent += out.creditCharged ? 1 : 0;
      r.simulatedRenders += out.provider === "dev" ? 1 : 0;
      r.timeline.firstCardAt = firstCardAtFor(r);
    });
  } catch (err) {
    const error = toJobError(err);
    console.warn(`[orchestrator] job ${jobId} failed: ${error.code} — ${rawMessage(err)}`);
    try {
      await mutate((db) => {
        // Refunded failures (and a replay whose result expired) move this cache key to a fresh
        // idempotency key for any later attempt.
        if (FRESH_KEY_FAILURE_CODES.has(error.code)) {
          db.renderAttempts ??= {};
          db.renderAttempts[claimed.cacheKey] = Math.max(db.renderAttempts[claimed.cacheKey] ?? 0, claimed.attempt) + 1;
        }
        const job = db.returns[returnId]?.renders.find((j) => j.id === jobId);
        if (!job) return;
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = error;
        job.creditCharged = false;
      });
    } catch (writeErr) {
      console.error(`[orchestrator] could not record failure for job ${jobId}`, writeErr);
    }
  }
}

/**
 * True when a gate-triggered retry may be spent on this job: a swap card the shopper can
 * actually see (its SKU is still a candidate; the form re-ranks them). Never for a size
 * preview: that button promises "1 credit", and a length variant's look barely changes.
 */
export function retryableCard(r: ReturnCase, job: RenderJob): boolean {
  if (job.phase === "size_preview") return false;
  return r.candidates.some((c) => c.skuId === job.skuId);
}

/**
 * Gate asked for a retry: spawn one retry with the alternate product shot.
 * Only if the job succeeded, is not itself a retry, has not been retried yet, is a visible
 * swap card (retryableCard), the SKU has an alt image, and the return is under its render
 * cap. Otherwise null.
 */
export async function requestGateRetry(returnId: string, jobId: string): Promise<RenderJob | null> {
  const before = await getReturnSnapshot(returnId, jobId);
  const altHash = before ? ((await garmentHashes([before.skuId], "alt")).get(before.skuId) ?? null) : null;
  return mutate((db) => {
    const r = db.returns[returnId];
    const job = r?.renders.find((j) => j.id === jobId);
    if (!r || !job || !r.photo || r.status === "resolved") return null;
    if (job.status !== "success" || job.retryOf !== null || job.supersededBy !== null) return null;
    if (!retryableCard(r, job)) return null;
    const sku = getSku(job.skuId);
    if (!sku?.altImage) return null;
    if (countedJobs(r) >= config.maxRendersPerReturn) return null;

    const retry = newJob(
      r,
      r.photo.hash,
      { skuId: job.skuId, size: job.size, transition: job.transition },
      "retry",
      "alt",
      new Date().toISOString(),
      altHash,
    );
    retry.retryOf = job.id;
    job.supersededBy = retry.id;
    r.renders.push(retry);
    return retry;
  });
}

/** The job's SKU, read without the lock (to preload its product shot before locking). */
async function getReturnSnapshot(returnId: string, jobId: string): Promise<{ skuId: string } | null> {
  const r = (await readDb()).returns[returnId];
  const job = r?.renders.find((j) => j.id === jobId);
  return job ? { skuId: job.skuId } : null;
}

/** Mark still-queued jobs as skipped (e.g. the return was resolved). Returns how many. */
export async function skipQueuedJobs(returnId: string): Promise<number> {
  return mutate((db) => {
    const r = db.returns[returnId];
    if (!r) return 0;
    let n = 0;
    for (const j of r.renders) {
      if (j.status === "queued") {
        j.status = "skipped";
        j.finishedAt = new Date().toISOString();
        n++;
      }
    }
    return n;
  });
}

/* ───────────── Orphaned jobs ───────────── */

/**
 * Jobs run in `after()` callbacks, which don't survive a process restart or crash. A job
 * still queued/running this long after it started (or was queued) was orphaned. The bound is
 * well above a real render's worst case (uploads + start retries + 150 s of polling) and
 * above routes' maxDuration (300 s).
 */
export const STALE_JOB_MS = 6 * 60 * 1000;

export const STALE_JOB_ERROR = {
  code: "RENDER_STALE",
  message: "This preview took too long, so we stopped waiting for it.",
} as const;

function isStale(j: RenderJob, nowMs: number): boolean {
  if (j.status !== "queued" && j.status !== "running") return false;
  const since = Date.parse(j.startedAt ?? j.queuedAt);
  return Number.isFinite(since) && nowMs - since > STALE_JOB_MS;
}

/** Cheap check (no lock) so polling only takes the store lock when there's something to sweep. */
export function hasStaleJob(r: ReturnCase, nowMs: number = Date.now()): boolean {
  return r.renders.some((j) => isStale(j, nowMs));
}

/** Mark orphaned queued/running jobs as failed so the shopper UI stops waiting. Returns how many. */
export async function failStaleJobs(returnId: string, nowMs: number = Date.now()): Promise<number> {
  return mutate((db) => {
    const r = db.returns[returnId];
    if (!r) return 0;
    let n = 0;
    for (const j of r.renders) {
      if (!isStale(j, nowMs)) continue;
      j.status = "failed";
      j.finishedAt = new Date(nowMs).toISOString();
      j.error = { ...STALE_JOB_ERROR };
      j.creditCharged = false;
      n++;
    }
    return n;
  });
}

/* ───────────── Errors ───────────── */

class LocalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalError";
  }
}

const LOCAL_MESSAGES: Record<string, string> = {
  UNKNOWN_SKU: "This item is no longer in the catalogue.",
  PHOTO_MISSING: "Your photo is no longer available, so this preview couldn't be made.",
  GARMENT_IMAGE_MISSING: "This item's product photo couldn't be used for a preview.",
  PHOTO_MISMATCH: "Your photo changed while this preview was queued, so it wasn't made.",
};

function toJobError(err: unknown): { code: string; message: string } {
  if (isTryOnError(err) || err instanceof LocalError) {
    return { code: err.code, message: LOCAL_MESSAGES[err.code] ?? describeTryOnError(err.code) };
  }
  return { code: "INTERNAL_ERROR", message: describeTryOnError("UNKNOWN") };
}

function rawMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
