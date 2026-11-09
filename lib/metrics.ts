// Merchant metrics — pure functions (no I/O, no clock reads except the optional `now`
// default). Safe to import from server routes, client components and tests.
//
// Definitions (kept deliberately explicit because the dashboard quotes them):
// - Percentiles use linear interpolation between closest ranks (Excel PERCENTILE.INC / R type 7).
// - API latency samples = successful renders with a numeric latency that actually hit the
//   provider: cache hits (copied latency, 0 credits) are excluded, and so are dev-double
//   ("Simulated preview") renders unless `includeSimulated` is set. Gate-triggered retries
//   are real renders and are counted.
// - Per-transition gate pass rate = pass / gated, over the same samples.
// - The gate verdict breakdown covers every gated render shown to shoppers (all providers).
// - Time to first card after the form = max(0, firstCardAt − formSubmittedAt) per return.
// - Seeded demo returns carry generated latencies, not measurements: latency.seededSamples counts
//   how many samples came from them so the dashboard can label those figures as illustrative.
// - Photo opt-in rate = returns with a photo / returns that reached the photo offer.
// - Credits per return = credits spent / returns started; cost = credits per return × $/credit.

import { getSku } from "./catalog";
import type {
  GateVerdict,
  IssueType,
  LatencyStats,
  MerchantMetrics,
  PhotoMeasurements,
  ProviderName,
  RenderJob,
  ReturnCase,
  ReturnOutcome,
  TransitionType,
} from "./types";
import { TRANSITIONS } from "./types";

/** Revenue kept by an outcome, net of the exchange bonus (store credit is a cost of the exchange). */
function netRetained(o: ReturnOutcome): number {
  const kept = Number.isFinite(o.retainedRevenue) ? o.retainedRevenue : 0;
  const bonus = typeof o.bonusCredit === "number" && Number.isFinite(o.bonusCredit) ? o.bonusCredit : 0;
  return kept - bonus;
}

/* ───────────── Percentiles ───────────── */

/**
 * Linear-interpolated percentile of an ascending-sorted array (q in 0..1).
 * Returns null for an empty array.
 */
export function percentile(sorted: readonly number[], q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (n - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** count / p50 / p95 of an unsorted list. Non-finite values are ignored. */
export function latencyStats(values: readonly number[]): LatencyStats {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { count: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95) };
}

/* ───────────── Helpers ───────────── */

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** True when a render job is a provider latency sample (see header for the definition). */
export function isLatencySample(job: RenderJob, includeSimulated = false): boolean {
  if (job.status !== "success") return false;
  if (job.fromCache) return false;
  if (typeof job.latencyMs !== "number" || !Number.isFinite(job.latencyMs) || job.latencyMs < 0) return false;
  if (job.provider === "dev" && !includeSimulated) return false;
  return job.provider === "clothsy" || job.provider === "dev";
}

/** Time of the latest thing that happened on a return (resolution first, then the newest timeline event). */
export function returnActivityAt(r: ReturnCase): string {
  if (r.outcome?.at && parseMs(r.outcome.at) !== null) return r.outcome.at;
  const t = r.timeline;
  const candidates = [t?.resolvedAt, t?.firstCardAt, t?.formSubmittedAt, t?.photoAt, t?.reasonAt, t?.createdAt];
  let best: { iso: string; ms: number } | null = null;
  for (const c of candidates) {
    const ms = parseMs(c);
    if (ms !== null && c && (best === null || ms > best.ms)) best = { iso: c, ms };
  }
  return best?.iso ?? t?.createdAt ?? new Date(0).toISOString();
}

/**
 * A photo was uploaded at some point. `consent` is set only by the photo upload and is kept by the
 * retention sweep (lib/retention.ts), which clears `photo` 24 h after upload, so opt-ins still count.
 */
function optedInPhoto(r: ReturnCase): boolean {
  return Boolean(r.photo || r.consent);
}

function reachedPhotoOffer(r: ReturnCase): boolean {
  return r.reason === "style_colour" || r.reason === "fit_size" || optedInPhoto(r) || r.photoSkipped === true;
}

/* ───────────── computeMetrics ───────────── */

export interface ComputeMetricsOptions {
  includeSeeded: boolean;
  /** USD per try-on credit. */
  creditUsd: number;
  now?: Date;
  /** Count dev-double renders as latency samples (default false: they are simulated). */
  includeSimulated?: boolean;
  /** Length of the `recent` list (default 12). */
  recentLimit?: number;
}

export function computeMetrics(returns: readonly ReturnCase[], opts: ComputeMetricsOptions): MerchantMetrics {
  const now = opts.now ?? new Date();
  const includeSimulated = opts.includeSimulated ?? false;
  const recentLimit = Math.max(0, Math.floor(opts.recentLimit ?? 12));
  const scoped = returns.filter((r) => opts.includeSeeded || r.seeded !== true);

  /* Totals */
  let photoOptIns = 0;
  let reached = 0;
  let exchanges = 0;
  let refunds = 0;
  let revenueRetained = 0;
  let creditsSpent = 0;
  let simulatedRenders = 0;
  for (const r of scoped) {
    if (optedInPhoto(r)) photoOptIns += 1;
    if (reachedPhotoOffer(r)) reached += 1;
    if (r.outcome?.type === "exchange") exchanges += 1;
    if (r.outcome?.type === "refund") refunds += 1;
    if (r.outcome) revenueRetained += netRetained(r.outcome);
    if (Number.isFinite(r.creditsSpent)) creditsSpent += r.creditsSpent;
    if (Number.isFinite(r.simulatedRenders)) simulatedRenders += r.simulatedRenders;
  }
  const returnsStarted = scoped.length;
  const creditsPerReturn = returnsStarted > 0 ? creditsSpent / returnsStarted : null;
  const costPerReturnUsd =
    creditsPerReturn !== null && Number.isFinite(opts.creditUsd) ? creditsPerReturn * opts.creditUsd : null;

  /* Latency + per-transition gate pass rate */
  const all: number[] = [];
  const byT = new Map<TransitionType, { lat: number[]; gated: number; passed: number }>(
    TRANSITIONS.map((t) => [t, { lat: [], gated: 0, passed: 0 }]),
  );
  const gate = { total: 0, pass: 0, retry: 0, badge: 0, drop: 0 };
  const firstCard: number[] = [];
  const seededSamples = { renders: 0, firstCards: 0 };

  for (const r of scoped) {
    for (const job of r.renders ?? []) {
      if (job.gate) {
        const v: GateVerdict = job.gate.verdict;
        if (v === "pass" || v === "retry" || v === "badge" || v === "drop") {
          gate.total += 1;
          gate[v] += 1;
        }
      }
      if (!isLatencySample(job, includeSimulated)) continue;
      const bucket = byT.get(job.transition);
      all.push(job.latencyMs as number);
      if (r.seeded === true) seededSamples.renders += 1;
      if (!bucket) continue;
      bucket.lat.push(job.latencyMs as number);
      if (job.gate) {
        bucket.gated += 1;
        if (job.gate.verdict === "pass") bucket.passed += 1;
      }
    }
    const formMs = parseMs(r.timeline?.formSubmittedAt);
    const cardMs = parseMs(r.timeline?.firstCardAt);
    const photoMs = parseMs(r.timeline?.photoAt);
    // A photo added after the form (no-photo path → "Add photo") would count browsing time as
    // render wait: only returns whose renders started before the form was submitted count.
    const photoBeforeForm = photoMs === null || formMs === null || photoMs <= formMs;
    if (formMs !== null && cardMs !== null && photoBeforeForm) {
      firstCard.push(Math.max(0, cardMs - formMs));
      if (r.seeded === true) seededSamples.firstCards += 1;
    }
  }

  const byTransition = {} as MerchantMetrics["latency"]["byTransition"];
  for (const t of TRANSITIONS) {
    const b = byT.get(t) ?? { lat: [], gated: 0, passed: 0 };
    byTransition[t] = { ...latencyStats(b.lat), gatePassRate: b.gated > 0 ? b.passed / b.gated : null };
  }

  /* Per-SKU diagnoses */
  const skuMap = new Map<string, { returns: number; issues: Partial<Record<IssueType, number>> }>();
  for (const r of scoped) {
    const issues = r.diagnosis?.issues;
    if (!issues || issues.length === 0) continue;
    const entry = skuMap.get(r.skuId) ?? { returns: 0, issues: {} };
    entry.returns += 1;
    for (const type of new Set(issues.map((i) => i.type))) {
      entry.issues[type] = (entry.issues[type] ?? 0) + 1;
    }
    skuMap.set(r.skuId, entry);
  }
  const skuDiagnoses = [...skuMap.entries()]
    .map(([skuId, v]) => ({ skuId, name: getSku(skuId)?.name ?? skuId, returns: v.returns, issues: v.issues }))
    .sort((a, b) => b.returns - a.returns || a.name.localeCompare(b.name));

  /* Recent returns */
  const recent = scoped
    .map((r) => ({ r, at: returnActivityAt(r) }))
    .sort((a, b) => (parseMs(b.at) ?? 0) - (parseMs(a.at) ?? 0) || b.r.id.localeCompare(a.r.id))
    .slice(0, recentLimit)
    .map(({ r, at }) => ({
      id: r.id,
      skuName: getSku(r.skuId)?.name ?? r.skuId,
      outcome: (r.outcome?.type ?? "open") as "exchange" | "refund" | "open",
      at,
      retained: r.outcome ? netRetained(r.outcome) : 0,
      seeded: r.seeded === true,
    }));

  return {
    generatedAt: now.toISOString(),
    includesSeeded: opts.includeSeeded,
    totals: {
      returnsStarted,
      photoOptIns,
      photoOptInRate: reached > 0 ? photoOptIns / reached : null,
      exchanges,
      refunds,
      revenueRetained,
      creditsSpent,
      simulatedRenders,
      creditsPerReturn,
      costPerReturnUsd,
    },
    latency: {
      overall: latencyStats(all),
      byTransition,
      timeToFirstCardAfterFormMs: latencyStats(firstCard),
      seededSamples,
    },
    gate,
    skuDiagnoses,
    recent,
  };
}

/* ───────────── Transition benchmark (/bench) ───────────── */

/** One row of GET /api/bench. */
export interface BenchItem {
  job: RenderJob;
  returnId: string;
  photoUrl: string | null;
  sourceSkuId: string;
  measurements: PhotoMeasurements | null;
}

export interface BenchRow {
  transition: TransitionType;
  /** All successful renders in this bucket (including cache hits). */
  count: number;
  /** Renders that hit a provider (latency samples). */
  measured: number;
  /** Of `measured`, how many came from the dev double (simulated latency). */
  measuredSimulated: number;
  /** Cache replays (not latency samples: their latency is a copy). */
  cached: number;
  providers: Record<ProviderName, number>;
  latency: LatencyStats;
  verdicts: Record<GateVerdict | "ungated", number>;
  items: BenchItem[];
}

/**
 * Groups bench items by transition (fixed TRANSITIONS order). Latency excludes cache hits
 * (their latency is a copy of the original render's) but includes simulated renders, which
 * the bench labels per row.
 */
export function computeBenchRows(items: readonly BenchItem[]): BenchRow[] {
  return TRANSITIONS.map((transition) => {
    const mine = items.filter((it) => it.job.transition === transition);
    const verdicts: BenchRow["verdicts"] = { pass: 0, badge: 0, retry: 0, drop: 0, ungated: 0 };
    const providers: BenchRow["providers"] = { clothsy: 0, dev: 0 };
    const lat: number[] = [];
    let cached = 0;
    let measuredSimulated = 0;
    for (const it of mine) {
      const v = it.job.gate?.verdict;
      if (v === "pass" || v === "badge" || v === "retry" || v === "drop") verdicts[v] += 1;
      else verdicts.ungated += 1;
      if (it.job.provider) providers[it.job.provider] += 1;
      if (it.job.fromCache) cached += 1;
      if (isLatencySample(it.job, true)) {
        lat.push(it.job.latencyMs as number);
        if (it.job.provider === "dev") measuredSimulated += 1;
      }
    }
    return {
      transition,
      count: mine.length,
      measured: lat.length,
      measuredSimulated,
      cached,
      providers,
      latency: latencyStats(lat),
      verdicts,
      items: mine,
    };
  });
}
