// Seeded demo history for the merchant dashboard (fictional brand "Fernweave").
//
// Deterministic by construction: a mulberry32 PRNG with a fixed seed drives every
// choice, and every timestamp is derived from an anchor date that the caller passes
// in (or the SEED_ANCHOR_ISO constant). Nothing here reads Math.random or Date.now.
// The same anchor always yields byte-identical returns; a different anchor shifts
// timestamps only.
//
// Every case is marked `seeded: true` and the dashboard labels it as seeded demo
// history. Seeded cases never carry real photos or measurements; their photo/render
// URLs are placeholders and are never fetched (the bench and the reset route skip
// seeded cases).

import { EXCHANGE_BONUS_USD, LENGTH_ORDER, SILHOUETTE_LOOSENESS, SKUS, STYLE_CHIPS, getSku, requireSku } from "./catalog";
import type {
  Candidate,
  Diagnosis,
  DiagnosisIssue,
  FitComplaint,
  GateMetrics,
  GateResult,
  GateVerdict,
  IssueType,
  KeepAttribute,
  PreflightResult,
  ReasonCode,
  RenderJob,
  RenderPhase,
  ReturnCase,
  ReturnStatus,
  SizeCode,
  Sku,
  TransitionType,
} from "./types";
import { SIZES } from "./types";

/* ───────────── Public constants ───────────── */

/** Default anchor: seeded history ends here when no anchor is passed in. */
export const SEED_ANCHOR_ISO = "2026-11-06T00:00:00.000Z";
export const SEED_WINDOW_DAYS = 21;
export const SEED_RETURN_COUNT = 40;
/** Tuned so the generated history lands on the documented targets (see tests/metrics.test.ts). */
export const SEED_DEFAULT = 14423;
/** Every seeded id starts with this prefix. */
export const SEED_ID_PREFIX = "seed_";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ───────────── PRNG ───────────── */

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private spare: number | null = null;
  constructor(private readonly next: () => number) {}

  float(): number {
    return this.next();
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() from empty list");
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
    let r = this.next() * total;
    for (const [value, w] of entries) {
      r -= Math.max(0, w);
      if (r < 0) return value;
    }
    return entries[entries.length - 1][0];
  }
  /** Standard normal via Box–Muller (caches the spare deviate). */
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u <= Number.EPSILON) u = this.next();
    const v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
  hex(length: number): string {
    let out = "";
    while (out.length < length) out += Math.floor(this.next() * 16).toString(16);
    return out;
  }
}

/* ───────────── Behaviour model ───────────── */

/** Purchased SKU mix and per-SKU reason mix (style/colour, fit/size, other). */
const PURCHASES: ReadonlyArray<{ skuId: string; weight: number; reasons: readonly [number, number, number] }> = [
  { skuId: "fw-wrap-dress-mustard", weight: 7, reasons: [0.75, 0.15, 0.1] },
  { skuId: "fw-slip-dress-champagne", weight: 4, reasons: [0.6, 0.25, 0.15] },
  { skuId: "fw-knit-top-oat", weight: 4, reasons: [0.55, 0.35, 0.1] },
  { skuId: "fw-shift-dress-terracotta", weight: 4, reasons: [0.6, 0.25, 0.15] },
  { skuId: "fw-aline-midi-cobalt", weight: 4, reasons: [0.45, 0.4, 0.15] },
  { skuId: "fw-shirt-dress-ecru", weight: 3, reasons: [0.6, 0.25, 0.15] },
  { skuId: "fw-linen-shirt-white", weight: 4, reasons: [0.3, 0.55, 0.15] },
  { skuId: "fw-trench-stone", weight: 3, reasons: [0.3, 0.55, 0.15] },
  { skuId: "fw-wrap-dress-navy", weight: 2, reasons: [0.6, 0.25, 0.15] },
  { skuId: "fw-slip-dress-black", weight: 2, reasons: [0.55, 0.3, 0.15] },
  { skuId: "fw-aline-midi-sage", weight: 2, reasons: [0.5, 0.35, 0.15] },
  { skuId: "fw-shirt-dress-rust", weight: 1, reasons: [0.6, 0.25, 0.15] },
];

/** Probability that each issue shows up in a style/colour diagnosis, per style family. Garment-only issues. */
const ISSUE_PROFILE: Record<string, Partial<Record<IssueType, number>>> = {
  "wrap-dress": { colour: 0.5, too_clingy: 0.45, neckline: 0.18 },
  "slip-dress": { colour: 0.35, fabric: 0.4, too_clingy: 0.3 },
  "knit-top": { too_clingy: 0.55, colour: 0.3, too_short: 0.15 },
  "shift-dress": { too_boxy: 0.5, colour: 0.35, too_short: 0.2 },
  "aline-midi": { too_long: 0.4, colour: 0.35, neckline: 0.15 },
  "shirt-dress": { colour: 0.45, too_boxy: 0.3, fabric: 0.15 },
  "linen-shirt": { too_boxy: 0.5, colour: 0.25, fabric: 0.2 },
  trench: { too_boxy: 0.4, too_long: 0.3, colour: 0.2 },
};

/** Loud colourways get more colour complaints. */
const COLOUR_BOOST: Record<string, number> = { Mustard: 0.12, Terracotta: 0.1, Ecru: 0.05 };

const FIT_PROFILE: Record<string, ReadonlyArray<readonly [FitComplaint, number]>> = {
  "linen-shirt": [["too_short", 0.5], ["sleeves_short", 0.4], ["too_loose", 0.2]],
  trench: [["too_short", 0.45], ["sleeves_short", 0.35], ["too_tight", 0.2]],
  "aline-midi": [["too_long", 0.55], ["too_loose", 0.25]],
  "knit-top": [["too_tight", 0.5], ["too_short", 0.3]],
  "wrap-dress": [["too_tight", 0.4], ["too_short", 0.35]],
  "slip-dress": [["too_long", 0.45], ["too_tight", 0.3]],
  "shift-dress": [["too_loose", 0.45], ["too_short", 0.3]],
  "shirt-dress": [["too_short", 0.35], ["sleeves_long", 0.3], ["too_loose", 0.25]],
};

/**
 * Clothsy render latency by transition (lognormal: median ms, sigma). Silhouette changes are
 * slower and fail the fidelity gate more often; slim → loose is the hardest case.
 */
const LATENCY_MODEL: Record<TransitionType, { median: number; sigma: number }> = {
  colour_only: { median: 15_200, sigma: 0.3 },
  like_silhouette: { median: 17_200, sigma: 0.3 },
  shorter: { median: 17_800, sigma: 0.3 },
  longer: { median: 19_800, sigma: 0.32 },
  slim_to_loose: { median: 23_800, sigma: 0.28 },
  loose_to_slim: { median: 19_200, sigma: 0.32 },
};

/** First-attempt gate verdict mix by transition: [pass, badge, retry, drop]. */
const GATE_MODEL: Record<TransitionType, readonly [number, number, number, number]> = {
  colour_only: [0.82, 0.08, 0.06, 0.04],
  like_silhouette: [0.74, 0.12, 0.08, 0.06],
  shorter: [0.7, 0.14, 0.1, 0.06],
  longer: [0.66, 0.16, 0.1, 0.08],
  slim_to_loose: [0.48, 0.22, 0.2, 0.1],
  loose_to_slim: [0.64, 0.16, 0.12, 0.08],
};

/** Verdict mix for a gate-triggered retry (alternate product shot; no further retries). */
const RETRY_GATE_MODEL: readonly [number, number, number] = [0.6, 0.3, 0.1]; // pass, badge, drop

const MAX_RENDERS_PER_RETURN = 5;
/** Median time a shopper spends on the reason form after the photo (speculative renders run meanwhile). */
const FORM_FILL_MEDIAN_MS = 17_000;
const RENDER_FAIL_RATE = 0.04;

const ISSUE_PHRASE: Record<IssueType, string> = {
  colour: "the colour",
  too_clingy: "the close fit",
  too_boxy: "the boxy shape",
  too_long: "the length (longer than wanted)",
  too_short: "the length (shorter than wanted)",
  neckline: "the neckline",
  print: "the print",
  fabric: "the fabric feel",
};

const ISSUE_FIX_TRANSITION: Partial<Record<IssueType, TransitionType>> = {
  too_clingy: "slim_to_loose",
  too_boxy: "loose_to_slim",
  too_long: "shorter",
  too_short: "longer",
  colour: "colour_only",
  print: "colour_only",
};

/* ───────────── Catalogue helpers ───────────── */

function familyName(sku: Sku): string {
  return sku.name.split(" — ")[0];
}

const VARIANT_RANK = { petite: -1, regular: 0, tall: 1 } as const;

/** Local, dependency-free transition classifier for seed data (mirrors the retrieval rules). */
function transitionOf(from: Sku, to: Sku): TransitionType {
  if (from.family === to.family) {
    const dv = VARIANT_RANK[to.lengthVariant] - VARIANT_RANK[from.lengthVariant];
    if (dv > 0) return "longer";
    if (dv < 0) return "shorter";
    return "colour_only";
  }
  const dLoose = SILHOUETTE_LOOSENESS[to.silhouette] - SILHOUETTE_LOOSENESS[from.silhouette];
  if (dLoose >= 2) return "slim_to_loose";
  if (dLoose <= -2) return "loose_to_slim";
  const dLen = LENGTH_ORDER.indexOf(to.lengthClass) - LENGTH_ORDER.indexOf(from.lengthClass);
  if (dLen > 0) return "longer";
  if (dLen < 0) return "shorter";
  return "like_silhouette";
}

function fixesFor(transition: TransitionType, from: Sku, to: Sku): IssueType[] {
  const fixes: IssueType[] = [];
  if (transition === "slim_to_loose") fixes.push("too_clingy");
  if (transition === "loose_to_slim") fixes.push("too_boxy");
  if (transition === "shorter") fixes.push("too_long");
  if (transition === "longer") fixes.push("too_short");
  if (from.neckline !== to.neckline) fixes.push("neckline");
  if (from.colorHex !== to.colorHex) fixes.push("colour");
  if (from.fabric !== to.fabric) fixes.push("fabric");
  return fixes;
}

function whyFor(transition: TransitionType, to: Sku): string {
  const colour = to.colorName.toLowerCase();
  switch (transition) {
    case "colour_only":
      return `Same ${familyName(to)} in ${colour}`;
    case "slim_to_loose":
      return `A looser ${familyName(to).toLowerCase()} with more ease, in ${colour}`;
    case "loose_to_slim":
      return `A closer-cut ${familyName(to).toLowerCase()}, in ${colour}`;
    case "shorter":
      return `A shorter ${familyName(to).toLowerCase()}, in ${colour}`;
    case "longer":
      return `A longer ${familyName(to).toLowerCase()}, in ${colour}`;
    case "like_silhouette":
      return `A similar shape with a different neckline, in ${colour}`;
  }
}

function inStock(sku: Sku, size: SizeCode): boolean {
  return (sku.inventory[size] ?? 0) > 0;
}

/** Picks a transition type uniformly first, then a SKU within it, so one common transition doesn't swamp the mix. */
function pickByTransition(rng: Rng, from: Sku, pool: readonly Sku[], exclude: readonly TransitionType[]): Sku | null {
  const groups = new Map<TransitionType, Sku[]>();
  for (const s of pool) {
    const t = transitionOf(from, s);
    if (exclude.includes(t)) continue;
    const list = groups.get(t);
    if (list) list.push(s);
    else groups.set(t, [s]);
  }
  if (groups.size === 0) return null;
  const t = rng.pick([...groups.keys()]);
  return rng.pick(groups.get(t) ?? []);
}

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ───────────── Builders ───────────── */

interface Ctx {
  rng: Rng;
  jobSeq: number;
}

interface SeedJob {
  job: RenderJob;
  finishedMs: number;
}

const OK_PREFLIGHT: PreflightResult = {
  ok: true,
  overridden: false,
  checks: [
    { id: "full_body", ok: true, message: "Full outfit in frame" },
    { id: "single_person", ok: true, message: "One person" },
    { id: "frontal", ok: true, message: "Shoulders square to the camera" },
    { id: "garment_visible", ok: true, message: "Garment clearly visible" },
    { id: "torso_unobstructed", ok: true, message: "Nothing covering the garment" },
    { id: "lighting", ok: true, message: "Lighting looks even" },
    { id: "sharpness", ok: true, message: "Photo is sharp" },
  ],
};

function iso(ms: number): string {
  return new Date(Math.round(ms)).toISOString();
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function gateMetricsFor(rng: Rng, verdict: GateVerdict, transition: TransitionType, from: Sku, to: Sku): GateMetrics {
  const silhouetteChange = transition !== "colour_only";
  const colourChange = from.colorHex !== to.colorHex;
  const good = verdict === "pass";
  return {
    colourDeltaE: round(good ? rng.range(2.5, 8.5) : verdict === "badge" ? rng.range(7, 13) : rng.range(6, 22), 1),
    residueFraction: colourChange
      ? round(verdict === "retry" ? rng.range(0.21, 0.36) : good ? rng.range(0.01, 0.12) : rng.range(0.06, 0.22), 2)
      : null,
    silhouetteIoU: round(
      silhouetteChange
        ? verdict === "retry"
          ? rng.range(0.86, 0.94)
          : rng.range(0.52, 0.8)
        : rng.range(0.82, 0.95),
      2,
    ),
    identityDiff: round(verdict === "drop" ? rng.range(0.1, 0.22) : rng.range(0.02, 0.07), 3),
    hemErrorCm: rng.chance(0.6) ? round(good ? rng.range(0.4, 3.2) : rng.range(2.5, 7.5), 1) : null,
    garmentCoverage: round(verdict === "drop" ? rng.range(0.3, 0.5) : rng.range(0.58, 0.86), 2),
  };
}

function gateFor(
  rng: Rng,
  verdict: GateVerdict,
  transition: TransitionType,
  from: Sku,
  to: Sku,
  finishedMs: number,
  downgraded: boolean,
): GateResult {
  const metrics = gateMetricsFor(rng, verdict, transition, from, to);
  const reasons: string[] = [];
  let badge: string | null = null;
  if (verdict === "retry" || downgraded) {
    if (metrics.residueFraction !== null && metrics.residueFraction > 0.2) {
      reasons.push(`residue ${metrics.residueFraction.toFixed(2)} > 0.20 (original colour leaking at hem)`);
    } else {
      reasons.push(`silhouette IoU ${(metrics.silhouetteIoU ?? 0.9).toFixed(2)} > 0.85 (returned garment leaking)`);
    }
  }
  if (verdict === "badge") {
    if (!downgraded && metrics.colourDeltaE !== null && metrics.colourDeltaE > 10) {
      reasons.push(`colour ΔE ${metrics.colourDeltaE.toFixed(1)} > 10`);
      badge = "Colour approximate";
    } else {
      if (!downgraded) reasons.push(`silhouette IoU ${(metrics.silhouetteIoU ?? 0.8).toFixed(2)} (shape change partly rendered)`);
      badge = downgraded ? "Preview approximate" : "Colour preview · silhouette approximate";
    }
  }
  if (verdict === "drop") {
    if ((metrics.identityDiff ?? 0) > 0.12) reasons.push(`identity drift ${(metrics.identityDiff ?? 0).toFixed(2)} > 0.12`);
    else reasons.push(`garment coverage ${(metrics.garmentCoverage ?? 0).toFixed(2)} < 0.45`);
  }
  const computeMs = Math.round(rng.range(650, 1400));
  return {
    verdict,
    metrics,
    reasons,
    badge,
    computedAt: iso(finishedMs + rng.range(400, 1200) + computeMs),
    computeMs,
  };
}

function makeJob(
  ctx: Ctx,
  p: {
    returnId: string;
    sku: Sku;
    size: SizeCode;
    phase: RenderPhase;
    transition: TransitionType;
    variant: "primary" | "alt";
    queuedMs: number;
    retryOf: string | null;
  },
): SeedJob {
  const { rng } = ctx;
  ctx.jobSeq += 1;
  const id = `${SEED_ID_PREFIX}job_${String(ctx.jobSeq).padStart(3, "0")}`;
  const cacheKey = rng.hex(40);
  const startedMs = p.queuedMs + rng.range(250, 1400);
  const failed = rng.chance(RENDER_FAIL_RATE);
  const model = LATENCY_MODEL[p.transition];
  const base = rng.logNormal(model.median * (p.variant === "alt" ? 1.04 : 1), model.sigma);
  const latencyMs = Math.round(Math.min(58_000, Math.max(7_000, base)));
  const finishedMs = failed ? startedMs + rng.range(9_000, 30_000) : startedMs + latencyMs;
  const job: RenderJob = {
    id,
    returnId: p.returnId,
    skuId: p.sku.id,
    size: p.size,
    phase: p.phase,
    transition: p.transition,
    garmentVariant: p.variant,
    status: failed ? "failed" : "success",
    provider: "clothsy",
    fromCache: false,
    cacheKey,
    queuedAt: iso(p.queuedMs),
    startedAt: iso(startedMs),
    finishedAt: iso(finishedMs),
    latencyMs: failed ? null : latencyMs,
    resultUrl: failed ? null : `/api/renders/${cacheKey}`,
    error: failed ? { code: "RENDER_FAILED", message: "Try-on failed; the credit was refunded." } : null,
    creditCharged: !failed,
    gate: null,
    retryOf: p.retryOf,
    supersededBy: null,
    externalId: `tryon_${rng.hex(20)}`,
  };
  return { job, finishedMs };
}

function sampleIssues(rng: Rng, sku: Sku): DiagnosisIssue[] {
  const profile = { ...(ISSUE_PROFILE[sku.family] ?? { colour: 0.5 }) };
  const boost = COLOUR_BOOST[sku.colorName] ?? 0;
  if (boost && profile.colour !== undefined) profile.colour = Math.min(0.95, profile.colour + boost);
  const entries = Object.entries(profile) as [IssueType, number][];
  const picked = entries.filter(([, p]) => rng.chance(p)).map(([t]) => t);
  if (picked.length === 0) picked.push(rng.weighted(entries));
  return picked.map((type) => {
    const chip = STYLE_CHIPS.find((c) => c.issue === type);
    return {
      type,
      confidence: round(rng.range(0.55, 0.93), 2),
      evidence: chip ? `chip: ${chip.label}` : `free text mentions ${type.replace("_", " ")}`,
    };
  });
}

function diagnosisFor(rng: Rng, issues: DiagnosisIssue[]): Diagnosis {
  const types = new Set(issues.map((i) => i.type));
  const keep: KeepAttribute[] = ["category"];
  if (!types.has("too_long") && !types.has("too_short")) keep.push("length");
  if (!types.has("neckline")) keep.push("neckline");
  if (!types.has("colour") && !types.has("print")) keep.push("colour");
  if (!types.has("too_clingy") && !types.has("too_boxy")) keep.push("silhouette");
  const phrases = issues.map((i) => ISSUE_PHRASE[i.type]);
  const joined =
    phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  const keepWords = keep.filter((k) => k !== "category").map((k) => (k === "colour" ? "colour" : k));
  const summary =
    `${joined.charAt(0).toUpperCase()}${joined.slice(1)} didn't work out` +
    (keepWords.length ? `; alternatives keep the ${keepWords.join(" and ")} you liked.` : ".");
  const llm = rng.chance(0.7);
  return {
    issues,
    keepAttributes: keep,
    summary,
    source: llm ? "llm" : "rules",
    ...(llm ? { model: "claude-opus-5-5" } : {}),
  };
}

function sampleFitComplaints(rng: Rng, sku: Sku): FitComplaint[] {
  const profile = FIT_PROFILE[sku.family] ?? [["too_tight", 0.5]];
  const picked = profile.filter(([, p]) => rng.chance(p)).map(([c]) => c);
  if (picked.length === 0) picked.push(profile[0][0]);
  return picked;
}

/** Size/variant the shopper exchanges into for a fit return, or null if nothing in stock fits. */
function sizeExchangeTarget(sku: Sku, size: SizeCode, complaints: FitComplaint[]): { sku: Sku; size: SizeCode } | null {
  const idx = SIZES.indexOf(size);
  const wantsLength = complaints.includes("too_short") || complaints.includes("sleeves_short");
  if (wantsLength) {
    const tall = SKUS.find(
      (s) => s.family === sku.family && s.colorHex === sku.colorHex && s.lengthVariant === "tall" && inStock(s, size),
    );
    if (tall) return { sku: tall, size };
  }
  let step = 0;
  if (complaints.includes("too_tight") || wantsLength) step = 1;
  else if (complaints.includes("too_loose") || complaints.includes("too_long") || complaints.includes("sleeves_long"))
    step = -1;
  const target = SIZES[idx + step];
  if (!target || step === 0) return null;
  return inStock(sku, target) ? { sku, size: target } : null;
}

/* ───────────── One return ───────────── */

interface Draft {
  r: ReturnCase;
  lastMs: number;
}

function baseReturn(id: string, n: number, sku: Sku, size: SizeCode, createdMs: number): ReturnCase {
  return {
    id,
    orderId: `H${2100 + n}`,
    lineIndex: 0,
    skuId: sku.id,
    size,
    price: sku.price,
    status: "started",
    reason: null,
    fitComplaints: [],
    chips: [],
    freeText: "",
    consent: null,
    photo: null,
    photoSkipped: false,
    preflight: null,
    measurements: null,
    diagnosis: null,
    candidates: [],
    renders: [],
    timeline: {
      createdAt: iso(createdMs),
      reasonAt: null,
      photoAt: null,
      formSubmittedAt: null,
      firstCardAt: null,
      resolvedAt: null,
    },
    outcome: null,
    creditsSpent: 0,
    simulatedRenders: 0,
    seeded: true,
  };
}

function attachPhoto(rng: Rng, r: ReturnCase, photoMs: number): void {
  r.consent = { adultAttested: true, at: iso(photoMs - rng.range(2_000, 6_000)) };
  r.photo = {
    url: `/api/photos/${r.id}`,
    hash: rng.hex(64),
    width: 1200,
    height: 1600,
    uploadedAt: iso(photoMs),
  };
  r.preflight = structuredClone(OK_PREFLIGHT);
  r.timeline.photoAt = iso(photoMs);
  r.status = "photo_uploaded";
}

function addCandidate(r: ReturnCase, from: Sku, to: Sku, size: SizeCode, score: number): Candidate {
  const transition = transitionOf(from, to);
  const c: Candidate = {
    skuId: to.id,
    size,
    transition,
    score: round(score, 2),
    fixes: fixesFor(transition, from, to),
    why: whyFor(transition, to),
    priceDiff: to.price - r.price,
  };
  r.candidates.push(c);
  return c;
}

function styleAlternatives(rng: Rng, sku: Sku, size: SizeCode): { colourSwap: Sku | null; others: Sku[] } {
  const sameFamily = SKUS.filter(
    (s) => s.family === sku.family && s.id !== sku.id && s.lengthVariant === sku.lengthVariant && inStock(s, size),
  );
  const category = sku.category === "outerwear" ? ["outerwear"] : [sku.category];
  const others = SKUS.filter(
    (s) =>
      s.family !== sku.family && category.includes(s.category) && s.lengthVariant === "regular" && inStock(s, size),
  );
  // Outerwear has one family: use the tall variant as the "other" option.
  if (others.length === 0) {
    others.push(
      ...SKUS.filter((s) => s.family === sku.family && s.lengthVariant !== sku.lengthVariant && inStock(s, size)),
    );
  }
  return { colourSwap: sameFamily.length ? rng.pick(sameFamily) : null, others };
}

function resolveAt(
  rng: Rng,
  d: Draft,
  outcome: "exchange" | "refund",
  target: { sku: Sku; size: SizeCode } | null,
): void {
  const at = d.lastMs + rng.range(25_000, 140_000);
  const r = d.r;
  r.status = "resolved";
  r.timeline.resolvedAt = iso(at);
  if (outcome === "exchange" && target) {
    r.outcome = {
      type: "exchange",
      skuId: target.sku.id,
      size: target.size,
      priceDiff: target.sku.price - r.price,
      retainedRevenue: r.price,
      bonusCredit: EXCHANGE_BONUS_USD,
      at: iso(at),
    };
  } else {
    r.outcome = { type: "refund", skuId: null, size: null, priceDiff: 0, retainedRevenue: 0, at: iso(at) };
  }
  d.lastMs = at;
}

function buildStyleReturn(ctx: Ctx, d: Draft, sku: Sku, size: SizeCode, mayStayOpen: boolean): void {
  const { rng } = ctx;
  const r = d.r;
  const issues = sampleIssues(rng, sku);
  r.chips = issues
    .map((i) => STYLE_CHIPS.find((c) => c.issue === i.type)?.id)
    .filter((x): x is string => typeof x === "string");
  const { colourSwap, others } = styleAlternatives(rng, sku, size);
  const optIn = rng.chance(0.74);

  if (!optIn) {
    // No-photo path: alternatives on catalogue imagery, zero credits.
    r.photoSkipped = true;
    const formMs = d.lastMs + rng.range(18_000, 45_000);
    r.timeline.formSubmittedAt = iso(formMs);
    r.diagnosis = diagnosisFor(rng, issues);
    r.status = "form_submitted";
    const picks = [colourSwap, ...others.slice(0, 2)].filter((s): s is Sku => s !== null);
    picks.forEach((s, i) => addCandidate(r, sku, s, size, 0.86 - i * 0.07));
    d.lastMs = formMs;
    if (mayStayOpen && rng.chance(0.4)) return;
    const target = rng.chance(0.3) && r.candidates.length ? r.candidates[0] : null;
    resolveAt(rng, d, target ? "exchange" : "refund", target ? { sku: requireSku(target.skuId), size: target.size } : null);
    return;
  }

  // Photo path: speculative renders start at upload, while the shopper fills in the form.
  const photoMs = d.lastMs + rng.range(28_000, 95_000);
  attachPhoto(rng, r, photoMs);
  const jobs: SeedJob[] = [];

  const silhouettePick = pickByTransition(rng, sku, others, ["colour_only"]) ?? (others.length ? rng.pick(others) : null);
  const speculative = [colourSwap, silhouettePick].filter((s): s is Sku => s !== null);
  speculative.forEach((s, i) => {
    const c = addCandidate(r, sku, s, size, 0.8 - i * 0.05);
    jobs.push(
      makeJob(ctx, {
        returnId: r.id,
        sku: s,
        size,
        phase: "speculative",
        transition: c.transition,
        variant: "primary",
        queuedMs: photoMs + rng.range(80, 400),
        retryOf: null,
      }),
    );
  });

  const formMs = photoMs + rng.logNormal(FORM_FILL_MEDIAN_MS, 0.3);
  r.timeline.formSubmittedAt = iso(formMs);
  r.diagnosis = diagnosisFor(rng, issues);
  r.status = "form_submitted";
  const diagnosisMs = formMs + rng.range(1_400, 4_200);

  // Post-diagnosis picks: prefer alternatives whose transition fixes a diagnosed issue.
  const wanted = new Set(issues.map((i) => ISSUE_FIX_TRANSITION[i.type]).filter(Boolean));
  const remaining = others.filter((s) => !speculative.some((x) => x.id === s.id));
  // Shuffle, then stable-sort the issue-fixing transitions first; the second pick prefers a new transition.
  const ranked = shuffle(rng, remaining).sort(
    (a, b) => Number(wanted.has(transitionOf(sku, b))) - Number(wanted.has(transitionOf(sku, a))),
  );
  const postPicks: Sku[] = ranked.slice(0, 1);
  if (ranked.length > 1 && rng.chance(0.65)) {
    const used = new Set(postPicks.map((x) => transitionOf(sku, x)));
    postPicks.push(ranked.slice(1).find((x) => !used.has(transitionOf(sku, x))) ?? ranked[1]);
  }
  postPicks.forEach((s, i) => {
    const c = addCandidate(r, sku, s, size, 0.9 - i * 0.04);
    jobs.push(
      makeJob(ctx, {
        returnId: r.id,
        sku: s,
        size,
        phase: "post_diagnosis",
        transition: c.transition,
        variant: "primary",
        queuedMs: diagnosisMs + rng.range(50, 300),
        retryOf: null,
      }),
    );
  });

  // Client-side gate on each success; "retry" spawns one alt-image re-render when allowed.
  const initial = [...jobs];
  for (const sj of initial) {
    if (sj.job.status !== "success") continue;
    const target = requireSku(sj.job.skuId);
    const [pPass, pBadge, pRetry, pDrop] = GATE_MODEL[sj.job.transition];
    let verdict = rng.weighted<GateVerdict>([
      ["pass", pPass],
      ["badge", pBadge],
      ["retry", pRetry],
      ["drop", pDrop],
    ]);
    const canRetry = Boolean(target.altImage) && jobs.length < MAX_RENDERS_PER_RETURN;
    const downgraded = verdict === "retry" && !canRetry;
    if (downgraded) verdict = "badge";
    sj.job.gate = gateFor(rng, verdict, sj.job.transition, sku, target, sj.finishedMs, downgraded);
    if (verdict === "retry") {
      const queuedMs = Date.parse(sj.job.gate.computedAt) + rng.range(150, 600);
      const retry = makeJob(ctx, {
        returnId: r.id,
        sku: target,
        size,
        phase: "retry",
        transition: sj.job.transition,
        variant: "alt",
        queuedMs,
        retryOf: sj.job.id,
      });
      sj.job.supersededBy = retry.job.id;
      if (retry.job.status === "success") {
        const [rp, rb, rd] = RETRY_GATE_MODEL;
        const v = rng.weighted<GateVerdict>([
          ["pass", rp],
          ["badge", rb],
          ["drop", rd],
        ]);
        retry.job.gate = gateFor(rng, v, retry.job.transition, sku, target, retry.finishedMs, false);
      }
      jobs.push(retry);
    }
  }

  r.renders = jobs.map((j) => j.job);
  r.creditsSpent = r.renders.filter((j) => j.creditCharged).length;
  const visible = jobs.filter((j) => j.job.status === "success").map((j) => j.finishedMs);
  if (visible.length) r.timeline.firstCardAt = iso(Math.min(...visible));
  d.lastMs = Math.max(formMs, ...jobs.map((j) => j.finishedMs));

  if (mayStayOpen && rng.chance(0.4)) return;

  // Shoppers exchange far more often when a checked preview is on screen.
  const shown = r.renders.filter(
    (j) => j.status === "success" && j.supersededBy === null && (j.gate?.verdict === "pass" || j.gate?.verdict === "badge"),
  );
  if (shown.length && rng.chance(0.64)) {
    const chosen = rng.weighted(shown.map((j) => [j, j.gate?.verdict === "pass" ? 3 : 1] as const));
    resolveAt(rng, d, "exchange", { sku: requireSku(chosen.skuId), size: chosen.size });
  } else {
    resolveAt(rng, d, "refund", null);
  }
}

function buildFitReturn(ctx: Ctx, d: Draft, sku: Sku, size: SizeCode, mayStayOpen: boolean): void {
  const { rng } = ctx;
  const r = d.r;
  r.fitComplaints = sampleFitComplaints(rng, sku);
  const target = sizeExchangeTarget(sku, size, r.fitComplaints);
  if (rng.chance(0.58)) {
    const photoMs = d.lastMs + rng.range(30_000, 80_000);
    attachPhoto(rng, r, photoMs);
    d.lastMs = photoMs + rng.range(20_000, 60_000);
    // Size lines are measured on the photo at zero credits; a few shoppers pay one credit to preview.
    if (target && rng.chance(0.3)) {
      const transition: TransitionType = target.sku.id !== sku.id ? transitionOf(sku, target.sku) : "like_silhouette";
      const sj = makeJob(ctx, {
        returnId: r.id,
        sku: target.sku,
        size: target.size,
        phase: "size_preview",
        transition,
        variant: "primary",
        queuedMs: d.lastMs,
        retryOf: null,
      });
      if (sj.job.status === "success") {
        const [pPass, pBadge, , pDrop] = GATE_MODEL[transition];
        const v = rng.weighted<GateVerdict>([
          ["pass", pPass],
          ["badge", pBadge],
          ["drop", pDrop],
        ]);
        sj.job.gate = gateFor(rng, v, transition, sku, target.sku, sj.finishedMs, false);
      }
      r.renders.push(sj.job);
      r.creditsSpent = sj.job.creditCharged ? 1 : 0;
      d.lastMs = sj.finishedMs;
    }
  } else {
    r.photoSkipped = true;
    d.lastMs += rng.range(15_000, 40_000);
  }
  if (mayStayOpen && rng.chance(0.4)) return;
  if (target && rng.chance(0.62)) resolveAt(rng, d, "exchange", target);
  else resolveAt(rng, d, "refund", null);
}

function buildOtherReturn(ctx: Ctx, d: Draft, mayStayOpen: boolean): void {
  const { rng } = ctx;
  if (mayStayOpen && rng.chance(0.3)) return;
  d.lastMs += rng.range(10_000, 40_000);
  resolveAt(rng, d, "refund", null);
}

/* ───────────── Entry point ───────────── */

export interface SeedOptions {
  /** History ends at this instant (default SEED_ANCHOR_ISO). Pass e.g. the start of the current UTC day. */
  endAt?: Date | string | number;
  /** PRNG seed (default SEED_DEFAULT). */
  seed?: number;
  /** Number of returns (default SEED_RETURN_COUNT). */
  count?: number;
}

function toMs(v: Date | string | number): number {
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`Invalid seed anchor: ${String(v)}`);
  return ms;
}

/** Start of the UTC day containing `d`: a stable per-day anchor for request-time seeding. */
export function seedAnchorFor(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * ~40 historical returns over the 21 days before `endAt`, all `seeded: true`.
 * Realistic Clothsy latencies (p50 ≈ 18 s, p95 ≈ 34 s; slim → loose slowest with the
 * lowest gate pass rate), a gate verdict mix with alt-image retries, credits, honest-clock
 * timings, diagnoses and outcomes (~45% exchange, the rest refunds, a few still open).
 */
export function seededReturns(opts: SeedOptions = {}): ReturnCase[] {
  const endMs = toMs(opts.endAt ?? SEED_ANCHOR_ISO);
  const count = Math.max(0, Math.floor(opts.count ?? SEED_RETURN_COUNT));
  const startMs = endMs - SEED_WINDOW_DAYS * DAY;
  const rng = new Rng(mulberry32(opts.seed ?? SEED_DEFAULT));
  const ctx: Ctx = { rng, jobSeq: 0 };

  // Arrival times: spread over the window, daytime hours, then sorted chronologically.
  const arrivals: number[] = [];
  for (let i = 0; i < count; i++) {
    const day = Math.min(SEED_WINDOW_DAYS - 1, Math.floor(((i + rng.float()) * SEED_WINDOW_DAYS) / Math.max(1, count)));
    const hour = rng.weighted<number>([
      [8, 1], [9, 2], [10, 3], [11, 3], [12, 4], [13, 4], [14, 3], [15, 3],
      [16, 3], [17, 3], [18, 4], [19, 5], [20, 5], [21, 4], [22, 2],
    ]);
    arrivals.push(startMs + day * DAY + hour * HOUR + rng.int(0, 59) * MINUTE + rng.int(0, 59) * SECOND);
  }
  arrivals.sort((a, b) => a - b);

  const out: ReturnCase[] = [];
  arrivals.forEach((createdMs, i) => {
    const purchase = rng.weighted(PURCHASES.map((p) => [p, p.weight] as const));
    const sku = getSku(purchase.skuId) ?? SKUS[0];
    const size = rng.weighted<SizeCode>([
      ["XS", 0.6],
      ["S", 2],
      ["M", 3],
      ["L", 2],
      ["XL", 0.7],
    ]);
    const id = `${SEED_ID_PREFIX}ret_${String(i + 1).padStart(2, "0")}`;
    const d: Draft = { r: baseReturn(id, i + 1, sku, size, createdMs), lastMs: createdMs };
    const [ps, pf, po] = purchase.reasons;
    const reason = rng.weighted<ReasonCode>([
      ["style_colour", ps],
      ["fit_size", pf],
      ["other", po],
    ]);
    const reasonMs = createdMs + rng.range(12_000, 55_000);
    d.r.reason = reason;
    d.r.timeline.reasonAt = iso(reasonMs);
    d.r.status = "reason_selected" satisfies ReturnStatus;
    d.lastMs = reasonMs;
    // Only the most recent returns can still be open.
    const mayStayOpen = endMs - createdMs < 3 * DAY;
    if (reason === "style_colour") buildStyleReturn(ctx, d, sku, size, mayStayOpen);
    else if (reason === "fit_size") buildFitReturn(ctx, d, sku, size, mayStayOpen);
    else buildOtherReturn(ctx, d, mayStayOpen);
    out.push(d.r);
  });
  return out;
}
