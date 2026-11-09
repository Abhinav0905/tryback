import { describe, expect, it } from "vitest";
import { rowNote } from "@/components/merchant/BenchView";
import { getSku } from "@/lib/catalog";
import {
  computeBenchRows,
  computeMetrics,
  isLatencySample,
  latencyStats,
  percentile,
  returnActivityAt,
  type BenchItem,
} from "@/lib/metrics";
import {
  SEED_ANCHOR_ISO,
  SEED_ID_PREFIX,
  SEED_RETURN_COUNT,
  SEED_WINDOW_DAYS,
  mulberry32,
  seedAnchorFor,
  seededReturns,
} from "@/lib/seed";
import type { GateResult, GateVerdict, RenderJob, ReturnCase, TransitionType } from "@/lib/types";
import { TRANSITIONS } from "@/lib/types";

/* ───────────── Fixtures ───────────── */

const T0 = Date.parse("2026-11-05T12:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function gate(verdict: GateVerdict): GateResult {
  return {
    verdict,
    metrics: {
      colourDeltaE: 4,
      residueFraction: null,
      silhouetteIoU: 0.7,
      identityDiff: 0.03,
      hemErrorCm: null,
      garmentCoverage: 0.7,
    },
    reasons: [],
    badge: verdict === "badge" ? "Preview approximate" : null,
    computedAt: at(100),
    computeMs: 900,
  };
}

let jobSeq = 0;
function job(p: Partial<RenderJob> & { transition?: TransitionType } = {}): RenderJob {
  jobSeq += 1;
  return {
    id: `job_${jobSeq}`,
    returnId: "ret_x",
    skuId: "fw-wrap-dress-emerald",
    size: "M",
    phase: "speculative",
    transition: "colour_only",
    garmentVariant: "primary",
    status: "success",
    provider: "clothsy",
    fromCache: false,
    cacheKey: `key${jobSeq}`,
    queuedAt: at(0),
    startedAt: at(1),
    finishedAt: at(20),
    latencyMs: 18_000,
    resultUrl: `/api/renders/key${jobSeq}`,
    error: null,
    creditCharged: true,
    gate: null,
    retryOf: null,
    supersededBy: null,
    externalId: null,
    ...p,
  };
}

function ret(p: Partial<ReturnCase> = {}): ReturnCase {
  return {
    id: `ret_${Math.random().toString(36).slice(2, 10)}`,
    orderId: "1042",
    lineIndex: 0,
    skuId: "fw-wrap-dress-mustard",
    size: "M",
    price: 89,
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
      createdAt: at(0),
      reasonAt: null,
      photoAt: null,
      formSubmittedAt: null,
      firstCardAt: null,
      resolvedAt: null,
    },
    outcome: null,
    creditsSpent: 0,
    simulatedRenders: 0,
    ...p,
  };
}

const PHOTO = { url: "/api/photos/x", hash: "h", width: 1200, height: 1600, uploadedAt: at(30) };

function exchange(retained = 89, sec = 300): ReturnCase["outcome"] {
  return { type: "exchange", skuId: "fw-wrap-dress-emerald", size: "M", priceDiff: 0, retainedRevenue: retained, at: at(sec) };
}
function refund(sec = 300): ReturnCase["outcome"] {
  return { type: "refund", skuId: null, size: null, priceDiff: 0, retainedRevenue: 0, at: at(sec) };
}

const OPTS = { includeSeeded: true, creditUsd: 0.08, now: new Date(T0) };

/* ───────────── percentile / latencyStats ───────────── */

describe("percentile (linear interpolation)", () => {
  it("returns null for an empty list", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("returns the only value for a single-element list", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it("interpolates between closest ranks (PERCENTILE.INC)", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10);
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48, 10);
    expect(percentile([0, 100], 0.25)).toBeCloseTo(25, 10);
  });

  it("hits the endpoints at q=0 and q=1 and clamps out-of-range q", () => {
    expect(percentile([3, 5, 9], 0)).toBe(3);
    expect(percentile([3, 5, 9], 1)).toBe(9);
    expect(percentile([3, 5, 9], -1)).toBe(3);
    expect(percentile([3, 5, 9], 2)).toBe(9);
  });
});

describe("latencyStats", () => {
  it("sorts unsorted input and counts samples", () => {
    expect(latencyStats([4000, 1000, 3000, 2000])).toEqual({ count: 4, p50: 2500, p95: expect.closeTo(3850, 6) });
  });

  it("ignores non-finite values", () => {
    expect(latencyStats([NaN, 1000, Infinity, 3000])).toEqual({ count: 2, p50: 2000, p95: expect.closeTo(2900, 6) });
  });

  it("returns nulls when there are no samples", () => {
    expect(latencyStats([])).toEqual({ count: 0, p50: null, p95: null });
  });
});

/* ───────────── computeMetrics ───────────── */

describe("computeMetrics — totals", () => {
  const style = ret({
    id: "ret_style",
    reason: "style_colour",
    photo: PHOTO,
    consent: { adultAttested: true, at: at(29) },
    outcome: exchange(89),
    status: "resolved",
    creditsSpent: 3,
    simulatedRenders: 1,
  });
  const fitSkipped = ret({ id: "ret_fit", reason: "fit_size", photoSkipped: true, outcome: refund(), status: "resolved" });
  const other = ret({ id: "ret_other", reason: "other", outcome: refund(), status: "resolved" });
  const abandoned = ret({ id: "ret_new" });
  const seeded = ret({
    id: "seed_ret_01",
    seeded: true,
    reason: "style_colour",
    photo: PHOTO,
    outcome: exchange(59),
    creditsSpent: 4,
  });

  it("counts returns, opt-ins, outcomes, revenue and credits", () => {
    const m = computeMetrics([style, fitSkipped, other, abandoned], OPTS);
    expect(m.totals.returnsStarted).toBe(4);
    expect(m.totals.photoOptIns).toBe(1);
    // Reached the photo offer: style + fit (other goes straight to refund; abandoned never chose a reason).
    expect(m.totals.photoOptInRate).toBeCloseTo(1 / 2, 10);
    expect(m.totals.exchanges).toBe(1);
    expect(m.totals.refunds).toBe(2);
    expect(m.totals.revenueRetained).toBe(89);
    expect(m.totals.creditsSpent).toBe(3);
    expect(m.totals.simulatedRenders).toBe(1);
    expect(m.totals.creditsPerReturn).toBeCloseTo(3 / 4, 10);
    expect(m.totals.costPerReturnUsd).toBeCloseTo((3 / 4) * 0.08, 10);
  });

  it("includes seeded history only when asked", () => {
    const withSeed = computeMetrics([style, seeded], { ...OPTS, includeSeeded: true });
    const without = computeMetrics([style, seeded], { ...OPTS, includeSeeded: false });
    expect(withSeed.includesSeeded).toBe(true);
    expect(withSeed.totals.returnsStarted).toBe(2);
    expect(withSeed.totals.exchanges).toBe(2);
    expect(withSeed.totals.revenueRetained).toBe(89 + 59);
    expect(withSeed.totals.creditsSpent).toBe(7);
    expect(without.includesSeeded).toBe(false);
    expect(without.totals.returnsStarted).toBe(1);
    expect(without.totals.revenueRetained).toBe(89);
    expect(without.recent.every((r) => !r.seeded)).toBe(true);
  });

  it("still counts an opt-in after the retention sweep deleted the photo (consent is kept)", () => {
    const swept = { ...style, id: "ret_swept", photo: null };
    const m = computeMetrics([swept, fitSkipped], OPTS);
    expect(m.totals.photoOptIns).toBe(1);
    expect(m.totals.photoOptInRate).toBeCloseTo(1 / 2, 10);
    // A return that only consented-and-swept, with no reason recorded, still reached the offer.
    const bare = ret({ id: "ret_bare", consent: { adultAttested: true, at: at(29) } });
    expect(computeMetrics([bare], OPTS).totals.photoOptInRate).toBe(1);
  });

  it("returns null ratios for an empty set instead of dividing by zero", () => {
    const m = computeMetrics([], OPTS);
    expect(m.totals.returnsStarted).toBe(0);
    expect(m.totals.photoOptInRate).toBeNull();
    expect(m.totals.creditsPerReturn).toBeNull();
    expect(m.totals.costPerReturnUsd).toBeNull();
    expect(m.latency.overall).toEqual({ count: 0, p50: null, p95: null });
    expect(m.gate).toEqual({ total: 0, pass: 0, retry: 0, badge: 0, drop: 0 });
    expect(m.skuDiagnoses).toEqual([]);
    expect(m.recent).toEqual([]);
    for (const t of TRANSITIONS) {
      expect(m.latency.byTransition[t]).toEqual({ count: 0, p50: null, p95: null, gatePassRate: null });
    }
  });

  it("returns null cost when the credit price is not a finite number", () => {
    const m = computeMetrics([style], { ...OPTS, creditUsd: Number.NaN });
    expect(m.totals.creditsPerReturn).toBe(3);
    expect(m.totals.costPerReturnUsd).toBeNull();
  });

  it("uses `now` for generatedAt", () => {
    expect(computeMetrics([], OPTS).generatedAt).toBe(new Date(T0).toISOString());
  });

  it("does not mutate its input", () => {
    const input = [style, fitSkipped, seeded];
    const before = JSON.stringify(input);
    computeMetrics(input, OPTS);
    computeMetrics(input, { ...OPTS, includeSeeded: false });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("computeMetrics — latency & gate", () => {
  const renders: RenderJob[] = [
    job({ transition: "colour_only", latencyMs: 10_000, gate: gate("pass") }),
    job({ transition: "colour_only", latencyMs: 20_000, gate: gate("badge") }),
    job({ transition: "colour_only", latencyMs: 30_000, gate: null }), // not gated yet: latency yes, pass-rate no
    job({ transition: "slim_to_loose", latencyMs: 40_000, gate: gate("retry"), supersededBy: "job_retry" }),
    job({ id: "job_retry", transition: "slim_to_loose", phase: "retry", garmentVariant: "alt", latencyMs: 30_000, gate: gate("pass"), retryOf: "x" }),
    // Excluded from latency: no latency, failed, cache hit, simulated.
    job({ transition: "colour_only", latencyMs: null, gate: null }),
    job({ transition: "colour_only", status: "failed", latencyMs: 5_000, resultUrl: null, creditCharged: false }),
    job({ transition: "colour_only", fromCache: true, latencyMs: 99_000, gate: gate("drop"), creditCharged: false }),
    job({ transition: "shorter", provider: "dev", latencyMs: 6_000, gate: gate("pass"), creditCharged: false }),
    job({ transition: "longer", status: "running", latencyMs: null, finishedAt: null }),
  ];
  const r = ret({ id: "ret_lat", reason: "style_colour", photo: PHOTO, renders });

  it("skips renders with no latency, failures, cache hits and simulated renders; counts retries", () => {
    const m = computeMetrics([r], OPTS);
    expect(m.latency.overall.count).toBe(5);
    const sorted = [10_000, 20_000, 30_000, 30_000, 40_000];
    expect(m.latency.overall.p50).toBe(percentile(sorted, 0.5));
    expect(m.latency.overall.p95).toBeCloseTo(percentile(sorted, 0.95) as number, 6);
  });

  it("breaks latency and gate pass rate down by transition", () => {
    const m = computeMetrics([r], OPTS);
    const co = m.latency.byTransition.colour_only;
    expect(co.count).toBe(3);
    expect(co.p50).toBe(20_000);
    expect(co.gatePassRate).toBeCloseTo(1 / 2, 10); // pass + badge gated; the ungated one is ignored
    const s2l = m.latency.byTransition.slim_to_loose;
    expect(s2l.count).toBe(2); // original + retry
    expect(s2l.p50).toBe(35_000);
    expect(s2l.gatePassRate).toBeCloseTo(1 / 2, 10);
    expect(m.latency.byTransition.shorter).toEqual({ count: 0, p50: null, p95: null, gatePassRate: null });
    expect(m.latency.byTransition.longer.count).toBe(0);
    expect(Object.keys(m.latency.byTransition).sort()).toEqual([...TRANSITIONS].sort());
  });

  it("can opt in to simulated renders as latency samples", () => {
    const m = computeMetrics([r], { ...OPTS, includeSimulated: true });
    expect(m.latency.overall.count).toBe(6);
    expect(m.latency.byTransition.shorter).toEqual({ count: 1, p50: 6_000, p95: 6_000, gatePassRate: 1 });
  });

  it("counts every gated render in the verdict breakdown (all providers, cache hits included)", () => {
    const m = computeMetrics([r], OPTS);
    expect(m.gate).toEqual({ total: 6, pass: 3, retry: 1, badge: 1, drop: 1 });
    expect(m.gate.total).toBe(m.gate.pass + m.gate.retry + m.gate.badge + m.gate.drop);
  });

  it("isLatencySample matches the documented definition", () => {
    expect(isLatencySample(job())).toBe(true);
    expect(isLatencySample(job({ latencyMs: 0 }))).toBe(true);
    expect(isLatencySample(job({ latencyMs: -1 }))).toBe(false);
    expect(isLatencySample(job({ latencyMs: Number.NaN }))).toBe(false);
    expect(isLatencySample(job({ status: "queued" }))).toBe(false);
    expect(isLatencySample(job({ fromCache: true }))).toBe(false);
    expect(isLatencySample(job({ provider: "dev" }))).toBe(false);
    expect(isLatencySample(job({ provider: "dev" }), true)).toBe(true);
    expect(isLatencySample(job({ provider: null }), true)).toBe(false);
  });
});

describe("computeMetrics — time to first card after the form", () => {
  const timeline = (form: number | null, card: number | null): ReturnCase["timeline"] => ({
    createdAt: at(0),
    reasonAt: at(5),
    photoAt: at(30),
    formSubmittedAt: form === null ? null : at(form),
    firstCardAt: card === null ? null : at(card),
    resolvedAt: null,
  });

  it("is max(0, firstCardAt − formSubmittedAt) and skips returns missing either timestamp", () => {
    const m = computeMetrics(
      [
        ret({ timeline: timeline(50, 53) }), // 3 s after the form
        ret({ timeline: timeline(50, 45) }), // ready before the form → 0
        ret({ timeline: timeline(50, 60) }), // 10 s
        ret({ timeline: timeline(50, null) }), // no card yet → skipped
        ret({ timeline: timeline(null, 40) }), // no form (e.g. size path) → skipped
        ret({ timeline: { ...timeline(50, 53), firstCardAt: "not a date" } }), // unparsable → skipped
      ],
      OPTS,
    );
    const s = m.latency.timeToFirstCardAfterFormMs;
    expect(s.count).toBe(3);
    expect(s.p50).toBe(3_000);
    expect(s.p95).toBeCloseTo(percentile([0, 3_000, 10_000], 0.95) as number, 6);
  });

  it("skips a photo added after the form (the gap would be browsing time, not render wait)", () => {
    const m = computeMetrics(
      [
        ret({ timeline: timeline(50, 53) }),
        ret({ timeline: { ...timeline(20, 33), photoAt: at(26) } }), // skip photo → form → "Add photo"
      ],
      OPTS,
    );
    expect(m.latency.timeToFirstCardAfterFormMs.count).toBe(1);
    expect(m.latency.timeToFirstCardAfterFormMs.p50).toBe(3_000);
  });
});

describe("computeMetrics — exchange bonus", () => {
  it("nets the store-credit bonus out of revenue retained (totals and recent rows)", () => {
    const withBonus = { ...exchange(89)!, bonusCredit: 10 };
    const m = computeMetrics([ret({ outcome: withBonus, status: "resolved" }), ret({ outcome: exchange(59), status: "resolved" })], OPTS);
    expect(m.totals.revenueRetained).toBe(79 + 59);
    expect(m.recent.map((r) => r.retained).sort()).toEqual([59, 79]);
  });
});

describe("computeMetrics — per-SKU diagnoses", () => {
  const diag = (...types: Array<"colour" | "too_clingy" | "neckline">) => ({
    issues: types.map((type) => ({ type, confidence: 0.8, evidence: `chip: ${type}` })),
    keepAttributes: [],
    summary: "x",
    source: "rules" as const,
  });

  it("counts each issue once per return and sorts SKUs by diagnosed returns", () => {
    const m = computeMetrics(
      [
        ret({ skuId: "fw-wrap-dress-mustard", diagnosis: diag("colour", "too_clingy") }),
        ret({ skuId: "fw-wrap-dress-mustard", diagnosis: diag("colour", "colour") }),
        ret({ skuId: "fw-wrap-dress-mustard", diagnosis: diag("neckline") }),
        ret({ skuId: "fw-slip-dress-champagne", diagnosis: diag("too_clingy") }),
        ret({ skuId: "fw-slip-dress-champagne", diagnosis: diag("colour") }),
        ret({ skuId: "fw-slip-dress-champagne", diagnosis: null }),
        ret({ skuId: "fw-knit-top-oat", diagnosis: diag() }), // no issues → not counted
        ret({ skuId: "fw-unknown-sku", diagnosis: diag("colour") }),
      ],
      OPTS,
    );
    expect(m.skuDiagnoses[0]).toEqual({
      skuId: "fw-wrap-dress-mustard",
      name: getSku("fw-wrap-dress-mustard")?.name,
      returns: 3,
      issues: { colour: 2, too_clingy: 1, neckline: 1 },
    });
    expect(m.skuDiagnoses.map((s) => s.skuId)).toEqual([
      "fw-wrap-dress-mustard",
      "fw-slip-dress-champagne",
      "fw-unknown-sku",
    ]);
    expect(m.skuDiagnoses[1]).toMatchObject({ returns: 2, issues: { too_clingy: 1, colour: 1 } });
    expect(m.skuDiagnoses[2].name).toBe("fw-unknown-sku"); // falls back to the id
  });
});

describe("computeMetrics — recent returns", () => {
  it("orders by latest activity, maps outcomes and respects the limit", () => {
    const m = computeMetrics(
      [
        ret({ id: "a", outcome: exchange(89, 100), status: "resolved" }),
        ret({ id: "b", outcome: refund(400), status: "resolved" }),
        ret({ id: "c", timeline: { createdAt: at(200), reasonAt: at(250), photoAt: null, formSubmittedAt: null, firstCardAt: null, resolvedAt: null } }),
        ret({ id: "d", seeded: true, outcome: exchange(59, 50) }),
      ],
      { ...OPTS, recentLimit: 3 },
    );
    expect(m.recent.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(m.recent[0]).toMatchObject({ outcome: "refund", retained: 0, seeded: false, at: at(400) });
    expect(m.recent[1]).toMatchObject({ outcome: "open", retained: 0, at: at(250) });
    expect(m.recent[2]).toMatchObject({ outcome: "exchange", retained: 89, skuName: getSku("fw-wrap-dress-mustard")?.name });
  });

  it("defaults to the 12 most recent and flags seeded rows", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      ret({ id: `r${i}`, seeded: i % 2 === 0, timeline: { ...ret().timeline, createdAt: at(i) } }),
    );
    const m = computeMetrics(many, OPTS);
    expect(m.recent).toHaveLength(12);
    expect(m.recent[0].id).toBe("r19");
    expect(m.recent[1]).toMatchObject({ id: "r18", seeded: true });
  });

  it("returnActivityAt prefers the outcome time, then the newest timeline event", () => {
    expect(returnActivityAt(ret({ outcome: refund(900) }))).toBe(at(900));
    expect(
      returnActivityAt(
        ret({ timeline: { createdAt: at(0), reasonAt: at(10), photoAt: at(40), formSubmittedAt: at(70), firstCardAt: at(65), resolvedAt: null } }),
      ),
    ).toBe(at(70));
  });
});

/* ───────────── Bench rows ───────────── */

describe("computeBenchRows", () => {
  it("returns one row per transition in fixed order with verdicts, providers and latency", () => {
    const item = (j: RenderJob): BenchItem => ({
      job: j,
      returnId: "ret_b",
      photoUrl: "/api/photos/ret_b",
      sourceSkuId: "fw-wrap-dress-mustard",
      measurements: null,
    });
    const rows = computeBenchRows([
      item(job({ transition: "colour_only", latencyMs: 10_000, gate: gate("pass") })),
      item(job({ transition: "colour_only", provider: "dev", latencyMs: 6_000, gate: null })),
      item(job({ transition: "colour_only", fromCache: true, latencyMs: 10_000, gate: gate("badge") })),
      item(job({ transition: "slim_to_loose", latencyMs: 30_000, gate: gate("drop") })),
    ]);
    expect(rows.map((r) => r.transition)).toEqual([...TRANSITIONS]);
    const co = rows[0];
    expect(co.count).toBe(3);
    expect(co.measured).toBe(2);
    expect(co.measuredSimulated).toBe(1);
    expect(co.cached).toBe(1);
    expect(co.providers).toEqual({ clothsy: 2, dev: 1 });
    expect(co.latency).toEqual({ count: 2, p50: 8_000, p95: expect.closeTo(9_800, 6) });
    expect(co.verdicts).toEqual({ pass: 1, badge: 1, retry: 0, drop: 0, ungated: 1 });
    expect(rows.find((r) => r.transition === "slim_to_loose")?.verdicts.drop).toBe(1);
    expect(rows.find((r) => r.transition === "longer")?.count).toBe(0);
  });
});

/* ───────────── Seed ───────────── */

describe("mulberry32", () => {
  it("is deterministic and stays in [0, 1)", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(990);
    expect(mulberry32(124)()).not.toBe(mulberry32(123)());
  });
});

describe("seededReturns", () => {
  const seeds = seededReturns();
  const m = computeMetrics(seeds, { includeSeeded: true, creditUsd: 0.08, now: new Date(SEED_ANCHOR_ISO) });

  it("is deterministic", () => {
    expect(JSON.stringify(seededReturns())).toBe(JSON.stringify(seeds));
  });

  it("shifts only timestamps when the anchor changes", () => {
    const shifted = seededReturns({ endAt: new Date(Date.parse(SEED_ANCHOR_ISO) + 3 * 86_400_000) });
    const strip = (rs: ReturnCase[]) =>
      JSON.stringify(rs, (k, v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? "<t>" : v));
    expect(strip(shifted)).toBe(strip(seeds));
    expect(shifted[0].timeline.createdAt).not.toBe(seeds[0].timeline.createdAt);
  });

  it("produces ~40 labelled, unique, catalogue-valid returns", () => {
    expect(seeds).toHaveLength(SEED_RETURN_COUNT);
    expect(seeds.every((r) => r.seeded === true)).toBe(true);
    expect(new Set(seeds.map((r) => r.id)).size).toBe(seeds.length);
    expect(seeds.every((r) => r.id.startsWith(SEED_ID_PREFIX))).toBe(true);
    for (const r of seeds) {
      expect(getSku(r.skuId)).toBeDefined();
      for (const j of r.renders) {
        expect(getSku(j.skuId)).toBeDefined();
        expect(j.returnId).toBe(r.id);
      }
      if (r.outcome?.type === "exchange") expect(getSku(r.outcome.skuId ?? "")).toBeDefined();
    }
    const jobIds = seeds.flatMap((r) => r.renders.map((j) => j.id));
    expect(new Set(jobIds).size).toBe(jobIds.length);
  });

  it("keeps every timestamp inside the 21-day window before the anchor, in causal order", () => {
    const end = Date.parse(SEED_ANCHOR_ISO);
    const start = end - SEED_WINDOW_DAYS * 86_400_000;
    for (const r of seeds) {
      const t = r.timeline;
      const created = Date.parse(t.createdAt);
      expect(created).toBeGreaterThanOrEqual(start);
      const all = [t.reasonAt, t.photoAt, t.formSubmittedAt, t.firstCardAt, t.resolvedAt, r.outcome?.at]
        .filter((x): x is string => typeof x === "string")
        .map(Date.parse);
      for (const x of all) {
        expect(x).toBeGreaterThanOrEqual(created);
        expect(x).toBeLessThanOrEqual(end);
      }
      for (const j of r.renders) {
        expect(Date.parse(j.startedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(j.queuedAt));
        expect(Date.parse(j.finishedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(j.startedAt ?? ""));
        if (j.latencyMs !== null) {
          expect(Date.parse(j.finishedAt ?? "") - Date.parse(j.startedAt ?? "")).toBe(j.latencyMs);
        }
      }
      if (t.formSubmittedAt && t.photoAt) expect(Date.parse(t.formSubmittedAt)).toBeGreaterThan(Date.parse(t.photoAt));
    }
  });

  it("hits the latency targets (p50 ≈ 18 s, p95 ≈ 34 s); slim → loose is slowest with the lowest pass rate", () => {
    expect(m.latency.overall.count).toBeGreaterThanOrEqual(45);
    expect(m.latency.overall.p50 as number).toBeGreaterThan(16_500);
    expect(m.latency.overall.p50 as number).toBeLessThan(19_500);
    expect(m.latency.overall.p95 as number).toBeGreaterThan(31_000);
    expect(m.latency.overall.p95 as number).toBeLessThan(37_000);
    const bt = m.latency.byTransition;
    for (const t of TRANSITIONS) expect(bt[t].count).toBeGreaterThanOrEqual(3);
    const s2l = bt.slim_to_loose;
    for (const t of TRANSITIONS) {
      if (t === "slim_to_loose") continue;
      expect(s2l.p50 as number).toBeGreaterThan(bt[t].p50 as number);
      expect(s2l.gatePassRate as number).toBeLessThan(bt[t].gatePassRate as number);
    }
  });

  it("mixes gate verdicts, and every retry is linked to the render it supersedes", () => {
    expect(m.gate.pass).toBeGreaterThan(m.gate.total / 2);
    expect(m.gate.badge).toBeGreaterThan(0);
    expect(m.gate.retry).toBeGreaterThan(0);
    expect(m.gate.drop).toBeGreaterThan(0);
    const jobs = new Map(seeds.flatMap((r) => r.renders.map((j) => [j.id, j] as const)));
    const retries = [...jobs.values()].filter((j) => j.retryOf !== null);
    expect(retries.length).toBeGreaterThan(0);
    for (const rj of retries) {
      const original = jobs.get(rj.retryOf ?? "");
      expect(original?.supersededBy).toBe(rj.id);
      expect(original?.gate?.verdict).toBe("retry");
      expect(rj.phase).toBe("retry");
      expect(rj.garmentVariant).toBe("alt");
      expect(rj.gate?.verdict).not.toBe("retry");
    }
    for (const r of seeds) expect(r.renders.length).toBeLessThanOrEqual(5);
  });

  it("books credits and the honest clock consistently", () => {
    for (const r of seeds) {
      expect(r.creditsSpent).toBe(r.renders.filter((j) => j.creditCharged).length);
      expect(r.simulatedRenders).toBe(0);
      const visible = r.renders
        .filter((j) => j.status === "success" && j.phase !== "size_preview")
        .map((j) => Date.parse(j.finishedAt ?? ""));
      if (visible.length) expect(Date.parse(r.timeline.firstCardAt ?? "")).toBe(Math.min(...visible));
      else expect(r.timeline.firstCardAt).toBeNull();
      if (r.photo) expect(r.consent?.adultAttested).toBe(true);
    }
    expect(m.totals.creditsSpent).toBeGreaterThan(30);
    expect(m.latency.timeToFirstCardAfterFormMs.count).toBeGreaterThan(8);
  });

  it("counts seeded latency samples, so the dashboard can label them illustrative rather than measured", () => {
    // Every latency sample here comes from the generated history: none was measured on the Clothsy API.
    expect(m.latency.overall.count).toBeGreaterThan(0);
    expect(m.latency.seededSamples.renders).toBe(m.latency.overall.count);
    expect(m.latency.seededSamples.firstCards).toBe(m.latency.timeToFirstCardAfterFormMs.count);
    const unseeded = computeMetrics(seeds, { includeSeeded: false, creditUsd: 0.08, now: new Date(SEED_ANCHOR_ISO) });
    expect(unseeded.latency.overall.count).toBe(0);
    expect(unseeded.latency.seededSamples).toEqual({ renders: 0, firstCards: 0 });
  });

  it("resolves ~45% as exchanges, the rest refunds, with a few still open", () => {
    const open = seeds.filter((r) => r.outcome === null).length;
    expect(m.totals.exchanges / seeds.length).toBeGreaterThan(0.38);
    expect(m.totals.exchanges / seeds.length).toBeLessThan(0.52);
    expect(open).toBeGreaterThanOrEqual(1);
    expect(open).toBeLessThanOrEqual(5);
    expect(m.totals.exchanges + m.totals.refunds + open).toBe(seeds.length);
    for (const r of seeds) {
      if (r.outcome?.type === "exchange") expect(r.outcome.retainedRevenue).toBe(r.price);
      if (r.outcome?.type === "refund") expect(r.outcome.retainedRevenue).toBe(0);
      expect(r.status === "resolved").toBe(r.outcome !== null);
    }
  });

  it("mixes reasons and produces diagnoses with no body or skin-tone language", () => {
    const reasons = new Set(seeds.map((r) => r.reason));
    expect(reasons).toEqual(new Set(["style_colour", "fit_size", "other"]));
    expect(m.skuDiagnoses.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(seeds.map((r) => [r.diagnosis, r.candidates.map((c) => c.why), r.freeText])).toLowerCase();
    for (const banned of ["skin", "complexion", "tone", "body", "figure", "weight", "flatter", "curvy", "slim you"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("seedAnchorFor returns the start of the UTC day", () => {
    expect(seedAnchorFor(new Date("2026-11-20T17:45:12.000Z")).toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });
});

describe("bench row note", () => {
  it("qualifies n with counts over the same renders, so it never reads like 7 out of 4", () => {
    expect(rowNote({ measured: 4, measuredSimulated: 4, cached: 3 })).toBe("all simulated · 3 cache replays not counted");
    expect(rowNote({ measured: 1, measuredSimulated: 1, cached: 1 })).toBe("simulated · 1 cache replay not counted");
    expect(rowNote({ measured: 5, measuredSimulated: 2, cached: 0 })).toBe("2 simulated");
    expect(rowNote({ measured: 3, measuredSimulated: 0, cached: 0 })).toBeUndefined();
  });
});
