// Pure threshold-selection maths for `npm run tune` (scripts/tune-gate.ts). No I/O.
//
// Each gate metric has one threshold. Given the metric's values on GOOD renders (positives:
// real API successes, or the self-test's synthetic colour-only renders) and on BAD ones
// (synthetic negatives built from each good render, plus any real renders the user labelled
// bad), pick the threshold that keeps false flags on good renders at or below
// `maxFalseFlag` (default 5 %) while catching as many bad ones as possible, then centre it
// in the gap so it doesn't sit on a data point. Everything here is unit-tested in
// tests/tune.test.ts.

import { GATE_BADGES, decideGate, gateCheckApplies } from "../../lib/cv/gateMath";
import type { NegativeKind } from "../../lib/cv/synthMath";
import { parseThresholds, type GateSevereThresholds, type GateThresholds, type ThresholdsFile } from "../../lib/cv/thresholds";
import type { GateMetrics, TransitionType } from "../../lib/types";

export type MetricKey = keyof GateMetrics;

export interface MetricSpec {
  key: MetricKey;
  threshold: keyof GateThresholds;
  /** "upper": fails when value > threshold. "lower": fails when value < threshold. */
  direction: "upper" | "lower";
  label: string;
  decimals: number;
  /** Allowed range of the threshold (thresholds.json validation is stricter where needed). */
  lo: number;
  hi: number;
  severe?: keyof GateSevereThresholds;
  /** Synthetic negative kinds this metric is meant to catch. */
  targets: readonly NegativeKind[];
}

export const METRIC_SPECS: readonly MetricSpec[] = [
  // lo/hi: the sane range. A good render that needs a threshold outside it means the gate is
  // mis-measuring that metric (e.g. no hem found → a 60 cm "error"); the tuner then keeps the
  // current value and says so instead of following it.
  { key: "colourDeltaE", threshold: "colourDeltaE", direction: "upper", label: "Colour ΔE00", decimals: 1, lo: 2, hi: 30, targets: ["colour"] },
  { key: "residueFraction", threshold: "residue", direction: "upper", label: "Residue share", decimals: 2, lo: 0.02, hi: 0.6, targets: ["residue"] },
  { key: "silhouetteIoU", threshold: "silhouetteIoU", direction: "upper", label: "Silhouette IoU", decimals: 2, lo: 0.3, hi: 0.99, targets: ["silhouette"] },
  { key: "identityDiff", threshold: "identityDiff", direction: "upper", label: "Identity diff", decimals: 3, lo: 0.01, hi: 0.4, severe: "identityDiff", targets: ["identity"] },
  { key: "hemErrorCm", threshold: "hemErrorCm", direction: "upper", label: "Hem error (cm)", decimals: 1, lo: 1, hi: 20, targets: ["hem"] },
  { key: "garmentCoverage", threshold: "minCoverage", direction: "lower", label: "Garment coverage", decimals: 2, lo: 0.05, hi: 0.9, severe: "minCoverage", targets: ["missing"] },
];

/** Label words a user can give for a bad render → the metric meant to catch it. */
export const REASON_WORDS: Record<string, MetricKey> = {
  colour: "colourDeltaE",
  color: "colourDeltaE",
  residue: "residueFraction",
  silhouette: "silhouetteIoU",
  shape: "silhouetteIoU",
  identity: "identityDiff",
  face: "identityDiff",
  hem: "hemErrorCm",
  length: "hemErrorCm",
  missing: "garmentCoverage",
  coverage: "garmentCoverage",
};

export interface SampleCtx {
  transition: TransitionType;
  colourChangeExpected: boolean;
  lengthVariant: boolean;
}

export type SampleOrigin =
  /** A real try-on render the user did not mark bad. */
  | "api"
  /** A real try-on render the user marked bad. */
  | "labelled"
  /** Self-test: a synthetic colour-only render (person photo recoloured). */
  | "selftest"
  /** A synthetic negative derived from a positive. */
  | "synthetic";

export interface Sample {
  id: string;
  /** The positive this sample derives from (its own id for positives). */
  base: string;
  label: "positive" | "negative";
  origin: SampleOrigin;
  /** Negative kind ("real" for a labelled bad render), null for positives. */
  kind: NegativeKind | "real" | null;
  /** Labelled bad renders: metrics the user expects to catch it (empty = any). */
  reasons?: MetricKey[];
  /**
   * Real renders only: the user's labels file names this render explicitly ("good", "bad" or
   * "skip"). An unlabelled render still counts as good for the proposal, but --apply refuses.
   */
  reviewed?: boolean;
  metrics: GateMetrics;
  ctx: SampleCtx;
}

/* ───────────── small stats ───────────── */

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Linear-interpolated quantile (q in 0..1) of an ascending array; null when empty. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Summary {
  n: number;
  min: number | null;
  p5: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  max: number | null;
}

export function summarize(values: readonly number[]): Summary {
  const s = values.filter(isNum).sort((a, b) => a - b);
  return {
    n: s.length,
    min: s.length ? s[0] : null,
    p5: quantile(s, 0.05),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p95: quantile(s, 0.95),
    max: s.length ? s[s.length - 1] : null,
  };
}

/* ───────────── which samples count for a metric ───────────── */

/** The sample has a value for this metric and the gate would use it (same rule as decideGate). */
export function metricUsed(spec: MetricSpec, s: Sample): boolean {
  return isNum(s.metrics[spec.key]) && gateCheckApplies(spec.key, s.ctx);
}

/** A negative this metric is meant to catch. */
export function targetedBy(spec: MetricSpec, s: Sample): boolean {
  if (s.label !== "negative") return false;
  if (s.kind === "real") return !s.reasons || s.reasons.length === 0 || s.reasons.includes(spec.key);
  return s.kind !== null && spec.targets.includes(s.kind);
}

export function flags(spec: MetricSpec, value: number, threshold: number): boolean {
  return spec.direction === "upper" ? value > threshold : value < threshold;
}

export interface Confusion {
  /** Negatives flagged. */
  tp: number;
  /** Negatives missed. */
  fn: number;
  /** Positives flagged (false flags: a wasted retry credit, or a needless badge). */
  fp: number;
  /** Positives passed. */
  tn: number;
  falseFlagRate: number | null;
  catchRate: number | null;
}

export function confusion(spec: MetricSpec, pos: readonly number[], neg: readonly number[], t: number): Confusion {
  const fp = pos.filter((v) => flags(spec, v, t)).length;
  const tp = neg.filter((v) => flags(spec, v, t)).length;
  return {
    tp,
    fn: neg.length - tp,
    fp,
    tn: pos.length - fp,
    falseFlagRate: pos.length ? fp / pos.length : null,
    catchRate: neg.length ? tp / neg.length : null,
  };
}

/* ───────────── threshold choice ───────────── */

export type ChoiceStatus =
  /** Current threshold already sits in the best gap: kept. */
  | "ok"
  | "tightened"
  | "loosened"
  /** No positives with a value for this metric: kept. */
  | "no-positives"
  /** No negatives above the allowed false flags (nothing to separate): kept (current is within the false-flag budget). */
  | "kept-not-separable"
  /** Good renders need a threshold outside the sane range: the metric is mis-measured on them. Kept; investigate. */
  | "unreliable";

export interface Valued {
  id: string;
  v: number;
}

export interface ThresholdChoice {
  key: MetricKey;
  spec: MetricSpec;
  current: number;
  proposed: number;
  status: ChoiceStatus;
  positives: Summary;
  negatives: Summary;
  currentConfusion: Confusion;
  proposedConfusion: Confusion;
  /** Rule-of-succession estimate of the false-flag rate on a NEW good render at the proposed threshold: (fp + 1) / (n + 1). */
  newRenderFalseFlag: number | null;
  /** The gap the proposal was centred in (original units), when there was one. */
  gap: { from: number; to: number } | null;
  notes: string[];
}

function roundTo(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** A value in [lo, hi) near the midpoint, rounded to `decimals` (more digits if the gap is tiny). */
export function roundInGap(lo: number, hi: number, decimals: number): number {
  const mid = (lo + hi) / 2;
  for (let d = decimals; d <= decimals + 3; d++) {
    const r = roundTo(mid, d);
    if (r >= lo && r < hi) return r;
  }
  return mid;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Pick one metric's threshold.
 *
 * Work in "flag space" (value as-is for upper metrics, negated for lower ones) so a sample
 * is flagged iff x > t. With n positives, at most f = ⌊maxFalseFlag·n⌋ may be flagged, so
 * t ≥ tMin = the (n−f)-th smallest positive. Catching is monotone, so the best catch comes
 * from the smallest such t; the first negative above tMin (nextNeg) bounds the gap
 * [pStar, nextNeg) — pStar = the largest positive below nextNeg — in which every t catches
 * the same negatives and flags the fewest positives. Keep the current threshold if it is
 * already in that gap, otherwise centre the proposal in it. With no negative above tMin
 * there is nothing to separate: keep the current threshold if it is within the false-flag
 * budget, else loosen it just past tMin.
 */
export function chooseThreshold(
  spec: MetricSpec,
  posIn: readonly Valued[],
  negIn: readonly Valued[],
  current: number,
  maxFalseFlag = 0.05,
): ThresholdChoice {
  const sign = spec.direction === "upper" ? 1 : -1;
  const pos = posIn.filter((p) => isNum(p.v));
  const neg = negIn.filter((p) => isNum(p.v));
  const P = pos.map((p) => ({ id: p.id, x: sign * p.v })).sort((a, b) => a.x - b.x);
  const N = neg.map((p) => sign * p.v).sort((a, b) => a - b);
  const posVals = pos.map((p) => p.v);
  const negVals = neg.map((p) => p.v);
  const notes: string[] = [];
  const keeps = (st: ChoiceStatus) => st === "ok" || st === "no-positives" || st === "kept-not-separable" || st === "unreliable";
  const result = (proposedRaw: number, statusIn: ChoiceStatus, gap: ThresholdChoice["gap"]): ThresholdChoice => {
    let status = statusIn;
    let proposed = keeps(status) ? current : clamp(proposedRaw, spec.lo, spec.hi);
    if (!keeps(status) && proposed !== proposedRaw) {
      const fpClamped = posVals.filter((v) => flags(spec, v, proposed)).length;
      if (fpClamped > Math.floor(Math.max(0, maxFalseFlag) * posVals.length)) {
        // Even the loosest sane threshold flags too many good renders: the metric itself is off.
        const worst = spec.direction === "upper" ? Math.max(...posVals) : Math.min(...posVals);
        notes.push(
          `good renders reach ${roundTo(worst, spec.decimals + 1)}, beyond the sane range [${spec.lo}, ${spec.hi}]: the gate is mis-measuring this metric on them. Kept the current threshold; check those renders in the per-render table`,
        );
        status = "unreliable";
        proposed = current;
      } else {
        notes.push(`clamped to the allowed range [${spec.lo}, ${spec.hi}]`);
      }
    }
    const pc = confusion(spec, posVals, negVals, proposed);
    return {
      key: spec.key,
      spec,
      current,
      proposed,
      status,
      positives: summarize(posVals),
      negatives: summarize(negVals),
      currentConfusion: confusion(spec, posVals, negVals, current),
      proposedConfusion: pc,
      newRenderFalseFlag: posVals.length ? (pc.fp + 1) / (posVals.length + 1) : null,
      gap,
      notes,
    };
  };

  const n = P.length;
  if (n === 0) {
    notes.push("no good render had this metric in play, so there is nothing to tune");
    return result(current, "no-positives", null);
  }
  const allowed = Math.floor(Math.max(0, maxFalseFlag) * n);
  const tMinEntry = P[n - 1 - allowed];
  const tMin = tMinEntry.x;
  if (allowed === 0 && n < 20) {
    notes.push(`with ${n} good render(s), a ${Math.round(maxFalseFlag * 100)} % budget allows no false flag at all`);
  }
  // Outlier note: the worst good render sits further from the next one than the rest span.
  if (n >= 3) {
    const gapTop = P[n - 1].x - P[n - 2].x;
    const spread = P[n - 2].x - P[0].x;
    if (gapTop > Math.max(spread, 10 ** -spec.decimals)) {
      notes.push(`one good render (${P[n - 1].id}) is far from the others; check it, and if the gate mis-measured it, label it "skip" or "bad"`);
    }
  }

  const c = sign * current;
  const nextNegIdx = N.findIndex((x) => x > tMin);
  if (nextNegIdx === -1) {
    const fpCur = P.filter((p) => p.x > c).length;
    if (fpCur <= allowed) {
      notes.push(N.length ? "no bad render lies beyond the good ones, so no threshold separates them" : "no bad renders to calibrate against");
      return result(current, "kept-not-separable", null);
    }
    const step = 10 ** -spec.decimals;
    const x = tMin + Math.max(Math.abs(tMin) * 0.1, step);
    notes.push(`current threshold flags ${fpCur} of ${n} good renders`);
    const raw = sign * roundTo(x, spec.decimals);
    return result(raw, sign * raw > c ? "loosened" : "tightened", null);
  }
  const nextNeg = N[nextNegIdx];
  const below = P.filter((p) => p.x < nextNeg);
  const pStar = below[below.length - 1].x; // exists: tMin ∈ P and tMin < nextNeg
  const gap = sign > 0 ? { from: pStar, to: nextNeg } : { from: -nextNeg, to: -pStar };
  if (c >= pStar && c < nextNeg) return result(current, "ok", gap);
  const x = roundInGap(pStar, nextNeg, spec.decimals);
  const raw = sign * x;
  const status: ChoiceStatus = x > c ? "loosened" : "tightened";
  return result(raw, status, gap);
}

/* ───────────── severe thresholds (drop instead of badge) ───────────── */

/**
 * Severe thresholds are never tightened automatically (dropping a render is the strongest
 * action). They are only moved outwards to stay beyond the proposed threshold and beyond
 * every good render.
 */
export function proposeSevere(
  current: GateSevereThresholds,
  proposedGate: GateThresholds,
  positives: { identityDiff: readonly number[]; garmentCoverage: readonly number[] },
): GateSevereThresholds {
  const idMax = positives.identityDiff.length ? Math.max(...positives.identityDiff) : 0;
  const covMin = positives.garmentCoverage.length ? Math.min(...positives.garmentCoverage) : 1;
  const identityDiff = Math.min(0.95, roundTo(Math.max(current.identityDiff, proposedGate.identityDiff * 1.5, idMax * 1.25), 3));
  const minCoverage = Math.max(0.005, roundTo(Math.min(current.minCoverage, proposedGate.minCoverage * 0.5, covMin * 0.75), 3));
  return { identityDiff, minCoverage };
}

/* ───────────── whole-gate outcomes ───────────── */

export interface Outcome {
  /** decideGate with a retry available: "retry" = at least one check failed. */
  withRetry: string;
  /** decideGate with no retry left: pass | badge | drop. */
  noRetry: string;
  flagged: boolean;
  unchecked: boolean;
  reasons: string[];
}

export function gateOutcome(s: Sample, t: GateThresholds, severe: GateSevereThresholds): Outcome {
  const a = decideGate(s.metrics, { ...s.ctx, canRetry: true }, t, severe);
  const b = decideGate(s.metrics, { ...s.ctx, canRetry: false }, t, severe);
  return {
    withRetry: a.verdict,
    noRetry: b.verdict,
    flagged: a.verdict === "retry",
    unchecked: a.verdict === "badge" && a.badge === GATE_BADGES.unchecked,
    reasons: a.reasons,
  };
}

export interface GroupRow {
  group: string;
  n: number;
  pass: number;
  flagged: number;
  dropped: number;
  unchecked: number;
}

export function groupOf(s: Sample): string {
  if (s.label === "positive") return s.origin === "selftest" ? "good · synthetic colour-only (self-test)" : "good · real render";
  if (s.kind === "real") return "bad · real render (labelled)";
  return `bad · synthetic ${s.kind}`;
}

export function verdictTable(samples: readonly Sample[], t: GateThresholds, severe: GateSevereThresholds): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  for (const s of samples) {
    const g = groupOf(s);
    const row = rows.get(g) ?? { group: g, n: 0, pass: 0, flagged: 0, dropped: 0, unchecked: 0 };
    const o = gateOutcome(s, t, severe);
    row.n++;
    if (o.flagged) row.flagged++;
    else if (o.unchecked) row.unchecked++;
    else row.pass++;
    if (o.noRetry === "drop") row.dropped++;
    rows.set(g, row);
  }
  return [...rows.values()].sort((a, b) => a.group.localeCompare(b.group));
}

export interface RetryStats {
  /** Renders the rate is measured on (real renders, or self-test positives when there are none). */
  basis: "real" | "self-test";
  renders: number;
  flagged: number;
  flaggedGood: number;
  flaggedBad: number;
  retryRate: number | null;
}

/** Expected retries (each one costs a credit): share of real renders the gate would send back. */
export function retryStats(samples: readonly Sample[], t: GateThresholds, severe: GateSevereThresholds): RetryStats {
  const real = samples.filter((s) => s.origin === "api" || s.origin === "labelled");
  const basis: RetryStats["basis"] = real.length ? "real" : "self-test";
  const pool = real.length ? real : samples.filter((s) => s.origin === "selftest");
  let flaggedGood = 0;
  let flaggedBad = 0;
  for (const s of pool) {
    if (!gateOutcome(s, t, severe).flagged) continue;
    if (s.label === "positive") flaggedGood++;
    else flaggedBad++;
  }
  const flagged = flaggedGood + flaggedBad;
  return { basis, renders: pool.length, flagged, flaggedGood, flaggedBad, retryRate: pool.length ? flagged / pool.length : null };
}

/* ───────────── the proposal ───────────── */

export interface Proposal {
  gate: GateThresholds;
  gateSevere: GateSevereThresholds;
  choices: ThresholdChoice[];
  maxFalseFlag: number;
}

export function propose(samples: readonly Sample[], current: ThresholdsFile, maxFalseFlag = 0.05): Proposal {
  const gate: GateThresholds = { ...current.gate };
  const choices: ThresholdChoice[] = [];
  for (const spec of METRIC_SPECS) {
    const pos = samples.filter((s) => s.label === "positive" && metricUsed(spec, s)).map((s) => ({ id: s.id, v: s.metrics[spec.key] as number }));
    const neg = samples.filter((s) => targetedBy(spec, s) && metricUsed(spec, s)).map((s) => ({ id: s.id, v: s.metrics[spec.key] as number }));
    const choice = chooseThreshold(spec, pos, neg, current.gate[spec.threshold], maxFalseFlag);
    gate[spec.threshold] = choice.proposed;
    choices.push(choice);
  }
  const positives = samples.filter((s) => s.label === "positive");
  const gateSevere = proposeSevere(current.gateSevere, gate, {
    identityDiff: positives.map((s) => s.metrics.identityDiff).filter(isNum),
    garmentCoverage: positives.map((s) => s.metrics.garmentCoverage).filter(isNum),
  });
  return { gate, gateSevere, choices, maxFalseFlag };
}

/* ───────────── applying ───────────── */

export const MIN_POSITIVES_TO_APPLY = 6;

/**
 * --apply is allowed only on ≥6 real good renders, never on self-test (synthetic) data, and only
 * once the user has looked at every real render and labelled it. Without labels every successful
 * render counts as good, so one bad render (say, a different-looking face) would pull its
 * threshold looser until renders like it pass.
 */
export function applyGuard(samples: readonly Sample[], mode: "probe" | "selftest"): { ok: boolean; reason: string } {
  if (mode === "selftest") return { ok: false, reason: "self-test data is synthetic; thresholds are only applied from real renders" };
  const real = samples.filter((s) => s.label === "positive" && s.origin === "api");
  if (real.length < MIN_POSITIVES_TO_APPLY) {
    return { ok: false, reason: `only ${real.length} good real render(s); --apply needs at least ${MIN_POSITIVES_TO_APPLY}` };
  }
  const unreviewed = real.filter((s) => s.reviewed !== true).map((s) => s.id);
  if (unreviewed.length) {
    const list = unreviewed.length > 4 ? `${unreviewed.slice(0, 4).join(", ")}, …` : unreviewed.join(", ");
    return {
      ok: false,
      reason:
        `${unreviewed.length} of ${real.length} real render(s) are not labelled yet (${list}). Look at each render and mark it ` +
        `"good", "bad" or "skip" in labels.json first: an unchecked bad render would loosen the gate until renders like it pass`,
    };
  }
  return { ok: true, reason: `${real.length} good real renders, all labelled` };
}

/** The new thresholds file (validated). Preflight thresholds are carried over unchanged. */
export function buildThresholdsFile(current: ThresholdsFile, p: Proposal, meta: { at: string; source: string; tuning: Record<string, unknown> }): ThresholdsFile {
  return parseThresholds({
    version: 1,
    source: meta.source,
    tunedAt: meta.at,
    gate: p.gate,
    gateSevere: p.gateSevere,
    preflight: current.preflight,
    tuning: meta.tuning,
  });
}

export function diffThresholds(a: ThresholdsFile, b: ThresholdsFile): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a.gate) as (keyof GateThresholds)[]) {
    if (a.gate[k] !== b.gate[k]) out.push(`gate.${k}: ${a.gate[k]} → ${b.gate[k]}`);
  }
  for (const k of Object.keys(a.gateSevere) as (keyof GateSevereThresholds)[]) {
    if (a.gateSevere[k] !== b.gateSevere[k]) out.push(`gateSevere.${k}: ${a.gateSevere[k]} → ${b.gateSevere[k]}`);
  }
  return out;
}

/* ───────────── labels ───────────── */

export interface RenderLabel {
  label: "good" | "bad" | "skip";
  reasons: MetricKey[];
  note?: string;
}

/** A labels file problem the user has to fix (message names the entry and the accepted values). */
export class LabelError extends Error {}

/** The words accepted in a label's "why" list. */
export const REASON_WORD_LIST: readonly string[] = Object.keys(REASON_WORDS);

/**
 * Parse one entry of probe/labels.json "renders": "good" | "bad" | "skip" | { label, why?: string[], note? }.
 * Null for an entry of the wrong shape. Throws LabelError for an unknown "why" word: a typo
 * would otherwise leave the reasons empty, which means "any metric", and pull every threshold
 * tighter (each false retry costs a live credit).
 */
export function parseLabel(v: unknown): RenderLabel | null {
  if (v === "good" || v === "bad" || v === "skip") return { label: v, reasons: [] };
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.label !== "good" && o.label !== "bad" && o.label !== "skip") return null;
  const why = Array.isArray(o.why) ? o.why : typeof o.why === "string" ? [o.why] : [];
  const reasons: MetricKey[] = [];
  for (const w of why) {
    const word = String(w).toLowerCase().trim();
    const key = REASON_WORDS[word];
    if (!key) throw new LabelError(`unknown "why" word "${String(w)}" (use: ${REASON_WORD_LIST.join(", ")})`);
    if (!reasons.includes(key)) reasons.push(key);
  }
  return { label: o.label, reasons, ...(typeof o.note === "string" ? { note: o.note } : {}) };
}

/** The value the labels template uses for a render nobody has looked at yet. */
export const LABEL_TODO = "todo";

export interface LabelsFile {
  /** Person (or "*") → "sku:size" they wear in their photo. */
  wearing: Record<string, string>;
  /** Render id → the user's label. Renders absent here (or still "todo") are unreviewed. */
  renders: Record<string, RenderLabel>;
  /** Render ids still marked "todo". */
  todo: string[];
}

/** Parse probe/labels.json. Throws LabelError naming the offending entry. */
export function parseLabelsFile(raw: unknown): LabelsFile {
  const out: LabelsFile = { wearing: {}, renders: {}, todo: [] };
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.wearing && typeof o.wearing === "object") {
    for (const [k, v] of Object.entries(o.wearing as Record<string, unknown>)) if (typeof v === "string") out.wearing[k] = v;
  }
  if (o.renders && typeof o.renders === "object") {
    for (const [k, v] of Object.entries(o.renders as Record<string, unknown>)) {
      if (v === LABEL_TODO) {
        out.todo.push(k);
        continue;
      }
      let l: RenderLabel | null;
      try {
        l = parseLabel(v);
      } catch (err) {
        throw new LabelError(`renders["${k}"]: ${(err as Error).message}`);
      }
      if (!l) throw new LabelError(`renders["${k}"] must be "good", "bad", "skip" or { "label": …, "why": [...] }`);
      out.renders[k] = l;
    }
  }
  return out;
}

/** "sku" | "sku:size" → parts. */
export function parseWearing(spec: string): { skuId: string; size: string } {
  const [skuId, size] = spec.split(":").map((s) => s.trim());
  return { skuId, size: size || "M" };
}

/* ───────────── formatting ───────────── */

export function fmt(v: number | null | undefined, d = 2): string {
  return isNum(v) ? v.toFixed(d) : "—";
}

export function pct(v: number | null | undefined): string {
  return isNum(v) ? `${Math.round(v * 100)} %` : "—";
}

/* ───────────── report ───────────── */

export interface PreflightRow {
  photo: string;
  /** "original" or a synthetic preflight variant ("pf-dark", …). */
  variant: string;
  ok: boolean;
  failed: string[];
  values: {
    check: string;
    signal: string;
    threshold: string;
    value: number | null;
    min: number | null;
    max: number | null;
    ok: boolean | null;
  }[];
}

export interface GarmentRow {
  sku: string;
  catalogueHex: string;
  photoHex: string;
  deltaE: number;
}

export interface ReportInput {
  /** "preflight": photo checks only (npm run tune -- --preflight-only). */
  mode: "probe" | "selftest" | "preflight";
  at: string;
  current: ThresholdsFile;
  proposal: Proposal;
  samples: readonly Sample[];
  guard: { ok: boolean; reason: string };
  /** Set when --apply wrote a file. */
  applied: { file: string; diff: string[] } | null;
  skipped: readonly { id: string; why: string }[];
  preflight: readonly PreflightRow[];
  garments: readonly GarmentRow[];
  warnings: readonly string[];
  environment: Record<string, string>;
}

function table(head: string[], rows: (string | number)[][]): string {
  const esc = (c: string | number) => String(c).replace(/\|/g, "\\|");
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

function frac(a: number, b: number): string {
  return b ? `${a}/${b} (${Math.round((a / b) * 100)} %)` : "—";
}

/** Garment photo colour this far (ΔE00) from the catalogue colorHex breaks the colour check for every render. */
export const CATALOGUE_COLOUR_WARN_DE = 8;

export function renderReport(r: ReportInput): string {
  const { proposal: p, current: cur, samples } = r;
  const pos = samples.filter((s) => s.label === "positive");
  const neg = samples.filter((s) => s.label === "negative");
  const kinds = new Map<string, number>();
  for (const s of neg) kinds.set(String(s.kind), (kinds.get(String(s.kind)) ?? 0) + 1);
  const out: string[] = [];

  if (r.mode === "preflight") {
    out.push(`# Photo preflight report`, ``);
    out.push(`Generated ${r.at} · thresholds in effect: ${cur.source}`, ``);
    const originals = r.preflight.filter((x) => x.variant === "original");
    out.push(
      `${originals.filter((x) => x.ok).length} of ${originals.length} photo(s) pass every check. A photo that fails would be sent back for a retake in the app, so fix it (or the threshold) before spending credits on it.`,
      ``,
    );
    for (const w of r.warnings) out.push(`- ⚠ ${w}`);
    out.push(...preflightSection(r.preflight));
    out.push(`## Environment`, ``, table(["", ""], Object.entries(r.environment).map(([k, v]) => [k, v])), ``);
    return out.join("\n");
  }

  out.push(`# Gate tuning report`, ``);
  out.push(`Generated ${r.at} · mode **${r.mode === "selftest" ? "self-test" : "probe renders"}** · thresholds in effect: ${cur.source}${cur.tunedAt ? ` (tuned ${cur.tunedAt})` : ""}`, ``);
  if (r.mode === "selftest") {
    out.push(
      `> **Self-test, not a calibration.** Every "good render" below is a synthetic colour-only image made by recolouring a CC0 mannequin photo in the browser; nothing here is a try-on render. The numbers show the harness works end to end. Do not ship thresholds from them (\`--apply\` is disabled in this mode).`,
      ``,
    );
  }
  out.push(`## Summary`, ``);
  out.push(`- Good renders: **${pos.length}** (${pos.filter((s) => s.origin === "api").length} real, ${pos.filter((s) => s.origin === "selftest").length} synthetic self-test)`);
  out.push(
    `- Bad renders: **${neg.length}** — ${[...kinds].map(([k, n]) => `${k === "real" ? "labelled real" : `synthetic ${k}`} ×${n}`).join(", ") || "none"}`,
  );
  if (r.skipped.length) out.push(`- Synthetic variants skipped: ${r.skipped.length} (listed at the end)`);
  out.push(`- False-flag budget on good renders: ${Math.round(p.maxFalseFlag * 100)} %`);
  const rsCur = retryStats(samples, cur.gate, cur.gateSevere);
  const rsNew = retryStats(samples, p.gate, p.gateSevere);
  out.push(
    `- Expected retry rate on ${rsCur.basis === "real" ? "real renders" : "self-test renders"} (each retry costs 1 credit): current **${pct(rsCur.retryRate)}** → proposed **${pct(rsNew.retryRate)}**`,
  );
  out.push(
    `- \`--apply\`: ${r.applied ? `**applied** to ${r.applied.file} (${r.applied.diff.length ? r.applied.diff.join("; ") : "no change"})` : r.guard.ok ? "allowed (not requested)" : `refused — ${r.guard.reason}`}`,
  );
  for (const w of r.warnings) out.push(`- ⚠ ${w}`);
  out.push(``);

  out.push(`## Thresholds: current vs proposed`, ``);
  out.push(
    table(
      ["Metric", "thresholds.json", "Current", "Proposed", "Status", "Good flagged (cur → new)", "Bad caught (cur → new)", "New-render false-flag est."],
      p.choices.map((c) => [
        c.spec.label,
        `gate.${c.spec.threshold} (${c.spec.direction === "upper" ? "fail if >" : "fail if <"})`,
        fmt(c.current, c.spec.decimals),
        c.proposed === c.current ? fmt(c.proposed, c.spec.decimals) : `**${fmt(c.proposed, Math.max(c.spec.decimals, decimalsOf(c.proposed)))}**`,
        c.status,
        `${frac(c.currentConfusion.fp, c.positives.n)} → ${frac(c.proposedConfusion.fp, c.positives.n)}`,
        `${frac(c.currentConfusion.tp, c.negatives.n)} → ${frac(c.proposedConfusion.tp, c.negatives.n)}`,
        pct(c.newRenderFalseFlag),
      ]),
    ),
    ``,
  );
  for (const c of p.choices) {
    const bits = [...c.notes];
    if (c.gap) bits.unshift(`best gap ${fmt(c.gap.from, c.spec.decimals + 1)} … ${fmt(c.gap.to, c.spec.decimals + 1)}`);
    if (bits.length) out.push(`- **${c.spec.label}**: ${bits.join("; ")}`);
  }
  out.push(
    ``,
    `"New-render false-flag est." is (good renders flagged + 1) / (good renders + 1): with few renders even a threshold that flags none of them can't promise 5 % on the next one. More renders tighten it.`,
    ``,
  );

  out.push(`## Distributions`, ``);
  const rows: (string | number)[][] = [];
  for (const c of p.choices) {
    for (const [set, sm] of [
      ["good", c.positives],
      ["bad (targeted)", c.negatives],
    ] as const) {
      rows.push([c.spec.label, set, sm.n, fmt(sm.min, 3), fmt(sm.p5, 3), fmt(sm.p25, 3), fmt(sm.p50, 3), fmt(sm.p75, 3), fmt(sm.p95, 3), fmt(sm.max, 3)]);
    }
  }
  out.push(table(["Metric", "Set", "n", "min", "p5", "p25", "p50", "p75", "p95", "max"], rows), ``);
  out.push(
    `"bad (targeted)" = the negatives this metric is meant to catch (colour shift → ΔE, pasted-back garment → residue, face edits → identity, filled garment → coverage, moved hem → hem error, recoloured original on a silhouette change → IoU, plus any render you labelled bad). Residue only counts when the colour should change; IoU only on silhouette-changing transitions.`,
    ``,
  );

  out.push(`## Confusion matrices`, ``);
  out.push(
    table(
      ["Metric", "Threshold", "Bad flagged (TP)", "Bad missed (FN)", "Good flagged (FP)", "Good passed (TN)"],
      p.choices.flatMap((c) => [
        [c.spec.label, `current ${fmt(c.current, c.spec.decimals)}`, c.currentConfusion.tp, c.currentConfusion.fn, c.currentConfusion.fp, c.currentConfusion.tn],
        [c.spec.label, `proposed ${fmt(c.proposed, Math.max(c.spec.decimals, decimalsOf(c.proposed)))}`, c.proposedConfusion.tp, c.proposedConfusion.fn, c.proposedConfusion.fp, c.proposedConfusion.tn],
      ]),
    ),
    ``,
  );

  out.push(`## Whole gate (decideGate on every render)`, ``);
  for (const [name, t, sv] of [
    ["Current thresholds", cur.gate, cur.gateSevere],
    ["Proposed thresholds", p.gate, p.gateSevere],
  ] as const) {
    out.push(`**${name}**`, ``);
    out.push(
      table(
        ["Group", "n", "Pass", "Flagged (retry)", "Not checkable", "Dropped if no retry left"],
        verdictTable(samples, t, sv).map((g) => [g.group, g.n, frac(g.pass, g.n), frac(g.flagged, g.n), g.unchecked, g.dropped]),
      ),
      ``,
    );
  }

  out.push(`## Expected retry rate (credits)`, ``);
  out.push(
    table(
      ["Thresholds", "Renders", "Would retry", "of which good (wasted credit)", "of which bad (useful retry)", "Retry rate"],
      [
        ["current", rsCur.renders, rsCur.flagged, rsCur.flaggedGood, rsCur.flaggedBad, pct(rsCur.retryRate)],
        ["proposed", rsNew.renders, rsNew.flagged, rsNew.flaggedGood, rsNew.flaggedBad, pct(rsNew.retryRate)],
      ],
    ),
    ``,
    `Measured on ${rsCur.basis === "real" ? "the real renders (good + labelled bad)" : "the self-test renders"}. Each retry re-renders with the alternate product shot and costs one more credit (capped by MAX_RENDERS_PER_RETURN).`,
    ``,
  );

  out.push(`## Severe thresholds (drop instead of badge)`, ``);
  out.push(
    table(
      ["thresholds.json", "Current", "Proposed", "Rule"],
      [
        ["gateSevere.identityDiff", fmt(cur.gateSevere.identityDiff, 3), fmt(p.gateSevere.identityDiff, 3), "never tightened; ≥ 1.5 × identity threshold and ≥ 1.25 × worst good render"],
        ["gateSevere.minCoverage", fmt(cur.gateSevere.minCoverage, 3), fmt(p.gateSevere.minCoverage, 3), "never raised; ≤ 0.5 × coverage threshold and ≤ 0.75 × lowest good render"],
      ],
    ),
    ``,
  );

  if (r.garments.length) {
    out.push(`## Catalogue product photos vs colorHex`, ``);
    out.push(
      table(
        ["SKU", "colorHex (lib/catalog.ts)", "Measured in product photo", "ΔE00", ""],
        r.garments.map((g) => [g.sku, g.catalogueHex, g.photoHex, fmt(g.deltaE, 1), g.deltaE > CATALOGUE_COLOUR_WARN_DE ? "⚠ update colorHex" : "ok"]),
      ),
      ``,
      `The colour check compares the render with the SKU's colorHex. If you replaced a product image with a photo of your own garment, its colorHex must match that garment, or every render of it fails the colour check (and tuning would wrongly loosen it). Fix colorHex first when ΔE00 > ${CATALOGUE_COLOUR_WARN_DE}.`,
      ``,
    );
  }

  out.push(...preflightSection(r.preflight));

  out.push(`## Per render`, ``);
  out.push(
    table(
      ["Render", "Set", "Transition", "ΔE", "Residue", "IoU", "Identity", "Hem cm", "Coverage", "Current", "Proposed"],
      samples.map((s) => {
        const a = gateOutcome(s, cur.gate, cur.gateSevere);
        const b = gateOutcome(s, p.gate, p.gateSevere);
        const m = s.metrics;
        return [
          s.id,
          s.label === "positive" ? `good (${s.origin})` : `bad (${s.kind})`,
          `${s.ctx.transition}${s.ctx.lengthVariant ? " · variant" : ""}`,
          fmt(m.colourDeltaE, 1),
          s.ctx.colourChangeExpected ? fmt(m.residueFraction, 3) : `(${fmt(m.residueFraction, 3)})`,
          gateCheckApplies("silhouetteIoU", s.ctx) ? fmt(m.silhouetteIoU, 2) : `(${fmt(m.silhouetteIoU, 2)})`,
          fmt(m.identityDiff, 3),
          fmt(m.hemErrorCm, 1),
          fmt(m.garmentCoverage, 2),
          a.withRetry,
          b.withRetry,
        ];
      }),
    ),
    ``,
    `Values in brackets are measured but not used by the gate for that render (residue without a colour change, IoU without a silhouette change).`,
    ``,
  );

  if (r.skipped.length) {
    out.push(`## Skipped synthetic variants`, ``);
    out.push(table(["Variant", "Why"], r.skipped.map((s) => [s.id, s.why])), ``);
  }

  out.push(`## Environment`, ``);
  out.push(table(["", ""], Object.entries(r.environment).map(([k, v]) => [k, v])), ``);
  out.push(
    `## Next steps`,
    ``,
    `1. Look at the flagged good renders above. If the gate is right (the render really is off), mark it \`"bad"\` in probe/labels.json; if it mis-measured, leave it \`"good"\`.`,
    `2. Re-run \`npm run tune\`. When you have at least ${MIN_POSITIVES_TO_APPLY} good real renders and the proposal looks sane, run \`npm run tune -- --apply\` (backs up and prints a diff).`,
    `3. \`npx vitest run\` and commit lib/cv/thresholds.json.`,
    ``,
  );
  return out.join("\n");
}

function decimalsOf(v: number): number {
  const s = String(v);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function preflightSection(rows: readonly PreflightRow[]): string[] {
  const out: string[] = [];
  if (rows.length) {
    out.push(`## Photo preflight`, ``);
    out.push(
      table(
        ["Photo", "Variant", "Result", "Failed checks"],
        rows.map((x) => [x.photo, x.variant, x.ok ? "pass" : "fail", x.failed.join(", ") || "—"]),
      ),
      ``,
    );
    for (const x of rows.filter((y) => y.variant === "original")) {
      out.push(`**${x.photo}** — each value vs its threshold (lib/cv/thresholds.json)`, ``);
      out.push(
        table(
          ["Check", "Signal", "Value", "Allowed", "OK", "thresholds.json"],
          x.values.map((v) => [
            v.check,
            v.signal,
            fmt(v.value, 3),
            v.min !== null && v.max !== null ? `${v.min} … ${v.max}` : v.min !== null ? `≥ ${v.min}` : v.max !== null ? `≤ ${v.max}` : "—",
            v.ok === null ? "n/a" : v.ok ? "yes" : "**no**",
            v.threshold,
          ]),
        ),
        ``,
      );
    }
    out.push(
      `The pf-* rows are synthetic copies of each photo (darkened, washed out, blurred, feet cropped): each should fail its check. Preflight thresholds are not changed by --apply; edit \`preflight.*\` in lib/cv/thresholds.json by hand if a good photo of yours fails a check.`,
      ``,
    );
  }

  return out;
}
