// Gate tuning harness: thresholds.json loading, the synthetic-image maths (lib/cv/synthMath)
// and the threshold selection / report logic behind `npm run tune` (scripts/lib/tune-math).
import { describe, expect, it } from "vitest";
import raw from "@/lib/cv/thresholds.json";
import { THRESHOLDS, parseThresholds, type ThresholdsFile } from "@/lib/cv/thresholds";
import { GATE_SEVERE, GATE_THRESHOLDS, decideGate, gateCheckApplies } from "@/lib/cv/gateMath";
import { PREFLIGHT_THRESHOLDS, evaluatePreflight, preflightCheckValues, type PreflightSignals } from "@/lib/cv/preflight";
import {
  NEGATIVE_KINDS,
  bottomRowsForFraction,
  dilateMask,
  hashSeed,
  hemShiftFeasible,
  hemWarpSourceRow,
  labOffsetForDeltaE,
  labToSrgb,
  mulberry32,
  planNegatives,
  recolourLab,
  rgbToHex,
  shadingTolerantDistance,
  softWeight,
} from "@/lib/cv/synthMath";
import { deltaE2000, hexToLab, srgbToLab, type Lab } from "@/lib/color";
import {
  METRIC_SPECS,
  MIN_POSITIVES_TO_APPLY,
  applyGuard,
  buildThresholdsFile,
  LabelError,
  parseLabelsFile,
  chooseThreshold,
  confusion,
  diffThresholds,
  metricUsed,
  parseLabel,
  parseWearing,
  propose,
  proposeSevere,
  quantile,
  renderReport,
  retryStats,
  roundInGap,
  summarize,
  targetedBy,
  verdictTable,
  type MetricSpec,
  type Sample,
} from "../scripts/lib/tune-math";
import type { BodyKeypoints, GateMetrics, Keypoint, TransitionType } from "@/lib/types";
import { FIXTURE_FILE, FIXTURE_GATE, FIXTURE_SEVERE, FIXTURE_THRESHOLDS_RAW } from "./fixtures/thresholds";

const spec = (key: keyof GateMetrics): MetricSpec => METRIC_SPECS.find((s) => s.key === key)!;
const V = (vals: number[], prefix = "p") => vals.map((v, i) => ({ id: `${prefix}${i}`, v }));

function metrics(o: Partial<GateMetrics> = {}): GateMetrics {
  return { colourDeltaE: 4, residueFraction: 0.03, silhouetteIoU: 0.6, identityDiff: 0.04, hemErrorCm: 2, garmentCoverage: 0.8, ...o };
}

function sample(o: Omit<Partial<Sample>, "metrics"> & { metrics?: Partial<GateMetrics> } = {}): Sample {
  const { metrics: m, ...rest } = o;
  return {
    id: "s",
    base: "s",
    label: "positive",
    origin: "api",
    kind: null,
    ctx: { transition: "colour_only", colourChangeExpected: true, lengthVariant: false },
    ...rest,
    metrics: metrics(m),
  };
}

/* ───────────── thresholds.json ───────────── */

describe("lib/cv/thresholds.json", () => {
  it("is valid and is what the gate and preflight use", () => {
    expect(parseThresholds(raw)).toEqual(THRESHOLDS);
    expect(GATE_THRESHOLDS).toEqual(THRESHOLDS.gate);
    expect({ ...GATE_SEVERE }).toEqual(THRESHOLDS.gateSevere);
    expect(PREFLIGHT_THRESHOLDS).toEqual(THRESHOLDS.preflight);
  });

  it("keeps severe thresholds beyond the normal ones", () => {
    expect(THRESHOLDS.gateSevere.identityDiff).toBeGreaterThan(THRESHOLDS.gate.identityDiff);
    expect(THRESHOLDS.gateSevere.minCoverage).toBeLessThan(THRESHOLDS.gate.minCoverage);
  });

  // Fixed values (tests/fixtures/thresholds.ts), so a tuned thresholds.json keeps these green.
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(FIXTURE_THRESHOLDS_RAW));

  it("rejects missing, non-numeric and out-of-range values with the offending path", () => {
    const a = clone();
    delete (a.gate as Record<string, unknown>).residue;
    expect(() => parseThresholds(a)).toThrow(/gate\.residue/);
    const b = clone();
    (b.gate as Record<string, unknown>).identityDiff = "0.1";
    expect(() => parseThresholds(b)).toThrow(/gate\.identityDiff/);
    const c = clone();
    (c.gate as Record<string, unknown>).minCoverage = 1.5;
    expect(() => parseThresholds(c)).toThrow(/gate\.minCoverage/);
    const d = clone();
    (d.preflight as Record<string, unknown>).luminance = { min: 200, max: 100 };
    expect(() => parseThresholds(d)).toThrow(/luminance/);
    expect(() => parseThresholds({ ...clone(), version: 2 })).toThrow(/version/);
  });

  it("rejects severe thresholds that would not be beyond the normal ones", () => {
    const a = clone();
    (a.gateSevere as Record<string, unknown>).identityDiff = 0.1;
    expect(() => parseThresholds(a)).toThrow(/gateSevere\.identityDiff/);
    const b = clone();
    (b.gateSevere as Record<string, unknown>).minCoverage = 0.3;
    expect(() => parseThresholds(b)).toThrow(/gateSevere\.minCoverage/);
  });

  it("keeps optional provenance", () => {
    const t = parseThresholds({ ...clone(), tunedAt: "2026-11-10T00:00:00.000Z", tuning: { goodRenders: 9 } });
    expect(t.tuning).toEqual({ goodRenders: 9 });
    expect(t.tunedAt).toBe("2026-11-10T00:00:00.000Z");
  });
});

/* ───────────── gateMath additions ───────────── */

describe("gateCheckApplies / decideGate severe parameter", () => {
  const ctx = (transition: TransitionType, colourChangeExpected = true, lengthVariant = false) => ({
    transition,
    colourChangeExpected,
    lengthVariant,
  });

  it("matches decideGate: residue only with a colour change, IoU only on a silhouette change that isn't a length variant", () => {
    expect(gateCheckApplies("residueFraction", ctx("colour_only", false))).toBe(false);
    expect(gateCheckApplies("residueFraction", ctx("colour_only", true))).toBe(true);
    expect(gateCheckApplies("silhouetteIoU", ctx("colour_only"))).toBe(false);
    expect(gateCheckApplies("silhouetteIoU", ctx("slim_to_loose"))).toBe(true);
    expect(gateCheckApplies("silhouetteIoU", ctx("longer", true, true))).toBe(false);
    for (const k of ["colourDeltaE", "identityDiff", "hemErrorCm", "garmentCoverage"] as const) {
      expect(gateCheckApplies(k, ctx("colour_only", false))).toBe(true);
    }
    // decideGate agrees.
    const leaky = metrics({ residueFraction: 0.9, silhouetteIoU: 0.99 });
    const F = [FIXTURE_GATE, FIXTURE_SEVERE] as const;
    expect(decideGate(leaky, { ...ctx("colour_only", false), canRetry: false }, ...F).verdict).toBe("pass");
    expect(decideGate(leaky, { ...ctx("slim_to_loose", false), canRetry: false }, ...F).verdict).toBe("badge");
    expect(decideGate(leaky, { ...ctx("longer", false, true), canRetry: false }, ...F).verdict).toBe("pass");
  });

  it("uses the severe thresholds it is given", () => {
    const m = metrics({ identityDiff: 0.2 });
    const c = { ...ctx("colour_only"), canRetry: false };
    expect(decideGate(m, c, FIXTURE_GATE, FIXTURE_SEVERE).verdict).toBe("badge");
    expect(decideGate(m, c, FIXTURE_GATE, { identityDiff: 0.18, minCoverage: 0.08 }).verdict).toBe("drop");
  });
});

/* ───────────── preflight values ───────────── */

describe("preflightCheckValues", () => {
  const k = (x: number, y: number, visibility = 0.99): Keypoint => ({ x, y, visibility });
  const person = (o: Partial<BodyKeypoints> = {}): BodyKeypoints => ({
    nose: k(300, 120),
    leftEye: k(310, 108),
    rightEye: k(290, 108),
    leftShoulder: k(395, 230),
    rightShoulder: k(205, 230),
    leftElbow: k(420, 380),
    rightElbow: k(180, 380),
    leftWrist: k(425, 510),
    rightWrist: k(175, 510),
    leftHip: k(360, 500),
    rightHip: k(240, 500),
    leftKnee: k(350, 720),
    rightKnee: k(250, 720),
    leftAnkle: k(345, 838),
    rightAnkle: k(255, 838),
    ...o,
  });
  const signals = (o: Partial<PreflightSignals> = {}): PreflightSignals => ({
    width: 600,
    height: 1000,
    keypoints: person(),
    personCount: 1,
    shoulderYawDeg: 5,
    garmentCoverage: 0.85,
    meanLuminance: 140,
    sharpness: 120,
    ...o,
  });
  const failedChecks = (s: PreflightSignals) => [...new Set(preflightCheckValues(s).filter((v) => v.ok === false).map((v) => v.check))].sort();
  const evalFailed = (s: PreflightSignals) => evaluatePreflight(s).checks.filter((c) => !c.ok).map((c) => c.id).sort();

  it("reports every signal against its thresholds.json key", () => {
    const vals = preflightCheckValues(signals());
    expect(vals.every((v) => v.ok === true)).toBe(true);
    const sharp = vals.find((v) => v.check === "sharpness")!;
    expect(sharp).toMatchObject({ value: 120, min: PREFLIGHT_THRESHOLDS.minSharpness, threshold: "preflight.minSharpness" });
    expect(vals.find((v) => v.check === "lighting")).toMatchObject({ min: PREFLIGHT_THRESHOLDS.luminance.min, max: PREFLIGHT_THRESHOLDS.luminance.max });
  });

  it("agrees with evaluatePreflight on which checks fail", () => {
    const cases: PreflightSignals[] = [
      signals(),
      signals({ meanLuminance: 30 }),
      signals({ meanLuminance: 240 }),
      signals({ sharpness: 3 }),
      signals({ garmentCoverage: 0.1 }),
      signals({ shoulderYawDeg: 60 }),
      signals({ personCount: 2 }),
      signals({ keypoints: person({ leftAnkle: k(345, 990), rightAnkle: k(255, 990) }) }),
      signals({ keypoints: person({ leftWrist: k(320, 300), rightWrist: k(280, 300) }) }),
    ];
    for (const c of cases) expect(failedChecks(c)).toEqual(evalFailed(c));
  });

  it("marks unmeasurable values as n/a when no person is found", () => {
    const vals = preflightCheckValues(signals({ keypoints: null, personCount: 0, garmentCoverage: 0 }));
    expect(vals.find((v) => v.check === "full_body")!.ok).toBeNull();
    expect(vals.find((v) => v.check === "single_person")!.ok).toBe(false);
  });
});

/* ───────────── synthetic-image maths ───────────── */

describe("synthMath", () => {
  it("labToSrgb inverts srgbToLab", () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 300; i++) {
      const rgb: [number, number, number] = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)];
      const back = labToSrgb(srgbToLab(...rgb));
      expect(back.inGamut).toBe(true);
      back.rgb.forEach((c, j) => expect(Math.abs(c - rgb[j])).toBeLessThanOrEqual(1));
    }
    expect(labToSrgb([50, 0, -120]).inGamut).toBe(false);
    expect(rgbToHex(labToSrgb(hexToLab("#2851A3")).rgb)).toBe("#2851a3");
  });

  it("labOffsetForDeltaE hits the requested CIEDE2000 distance", () => {
    for (const base of [hexToLab("#C9A227"), hexToLab("#1F2A44"), hexToLab("#EDE6D6")] as Lab[]) {
      for (const want of [15, 20, 25]) {
        const { offset, deltaE } = labOffsetForDeltaE(base, want, 120);
        const moved: Lab = [base[0] + offset[0], base[1] + offset[1], base[2] + offset[2]];
        expect(deltaE).toBeCloseTo(want, 1);
        expect(deltaE2000(base, moved)).toBeCloseTo(want, 1);
      }
    }
  });

  it("recolourLab moves a garment's mean onto the target and keeps its shading", () => {
    const from: Lab = [40, 20, 30];
    const to: Lab = [55, -20, 10];
    const px: Lab[] = [
      [30, 25, 35],
      [50, 15, 25],
    ];
    const out = px.map((p) => recolourLab(p, from, to));
    const mean = [0, 1, 2].map((i) => (out[0][i] + out[1][i]) / 2);
    mean.forEach((v, i) => expect(v).toBeCloseTo(to[i], 6));
    expect(out[1][0] - out[0][0]).toBeGreaterThan(0); // darker pixel stays darker
  });

  it("shading-tolerant distance and soft weights", () => {
    expect(shadingTolerantDistance([20, 10, 10], [60, 10, 10])).toBeCloseTo(20, 6);
    expect(softWeight(5, 10, 20)).toBe(1);
    expect(softWeight(15, 10, 20)).toBeCloseTo(0.5, 6);
    expect(softWeight(25, 10, 20)).toBe(0);
  });

  it("hem warp moves the hem by the requested shift and keeps the frame", () => {
    const hip = 500;
    const hem = 800;
    const H = 1000;
    for (const shift of [60, -60]) {
      expect(hemShiftFeasible(hip, hem, shift, H)).toBe(true);
      expect(hemWarpSourceRow(hem + shift, hip, hem, shift, H)).toBeCloseTo(hem, 6);
      expect(hemWarpSourceRow(hip, hip, hem, shift, H)).toBe(hip);
      expect(hemWarpSourceRow(100, hip, hem, shift, H)).toBe(100);
      expect(hemWarpSourceRow(H - 1, hip, hem, shift, H)).toBeCloseTo(H - 1, 6);
      let prev = -1;
      for (let y = 0; y < H; y++) {
        const s = hemWarpSourceRow(y, hip, hem, shift, H);
        expect(s).toBeGreaterThanOrEqual(prev);
        prev = s;
      }
    }
    expect(hemShiftFeasible(hip, 990, 60, H)).toBe(false);
    expect(hemShiftFeasible(hip, 520, -60, H)).toBe(false);
  });

  it("bottomRowsForFraction picks rows from the hem up", () => {
    const rows = [0, 10, 10, 10, 10, 0];
    expect(bottomRowsForFraction(rows, 0.25)).toBe(4);
    expect(bottomRowsForFraction(rows, 0.5)).toBe(3);
    expect(bottomRowsForFraction(rows, 1)).toBe(1);
    expect(bottomRowsForFraction(rows, 0)).toBe(rows.length);
  });

  it("dilateMask grows a pixel into a square", () => {
    const w = 7;
    const h = 7;
    const m = new Uint8Array(w * h);
    m[3 * w + 3] = 1;
    const d = dilateMask(m, w, h, 1);
    let n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[y * w + x]) n++;
    expect(n).toBe(9);
    expect(d[2 * w + 2]).toBe(1);
    expect(d[1 * w + 1]).toBe(0);
    expect(dilateMask(m, w, h, 0)).toEqual(m);
  });

  it("planNegatives is deterministic and only plans what applies", () => {
    const a = planNegatives({ seed: "x", kinds: NEGATIVE_KINDS, hemApplicable: true, silhouetteApplicable: true });
    const b = planNegatives({ seed: "x", kinds: NEGATIVE_KINDS, hemApplicable: true, silhouetteApplicable: true });
    expect(a).toEqual(b);
    expect(new Set(a.map((s) => s.kind))).toEqual(new Set(NEGATIVE_KINDS));
    for (const s of a.filter((x) => x.kind === "colour")) {
      expect(s.params.deltaE).toBeGreaterThanOrEqual(15);
      expect(s.params.deltaE).toBeLessThanOrEqual(25);
    }
    for (const s of a.filter((x) => x.kind === "residue")) {
      expect(s.params.fraction).toBeGreaterThanOrEqual(0.3);
      expect(s.params.fraction).toBeLessThanOrEqual(0.5);
    }
    const c = planNegatives({ seed: "x", kinds: NEGATIVE_KINDS, hemApplicable: false, silhouetteApplicable: false });
    expect(c.some((s) => s.kind === "hem" || s.kind === "silhouette")).toBe(false);
    expect(planNegatives({ seed: "x", kinds: ["missing"], hemApplicable: true, silhouetteApplicable: true }).map((s) => s.kind)).toEqual(["missing"]);
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });
});

/* ───────────── threshold selection ───────────── */

describe("tune-math statistics", () => {
  it("quantile interpolates and summarize ignores non-numbers", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
    const s = summarize([3, 1, 2, Number.NaN]);
    expect(s).toMatchObject({ n: 3, min: 1, p50: 2, max: 3 });
  });

  it("confusion counts flags in the metric's direction", () => {
    const c = confusion(spec("colourDeltaE"), [2, 4, 13], [10, 20, 30], 12);
    expect(c).toMatchObject({ fp: 1, tn: 2, tp: 2, fn: 1 });
    const cov = confusion(spec("garmentCoverage"), [0.9, 0.2], [0.01, 0.4], 0.25);
    expect(cov).toMatchObject({ fp: 1, tn: 1, tp: 1, fn: 1 });
  });

  it("roundInGap rounds inside the gap", () => {
    expect(roundInGap(5, 9, 1)).toBe(7);
    const r = roundInGap(0.0131, 0.0139, 2);
    expect(r).toBeGreaterThanOrEqual(0.0131);
    expect(r).toBeLessThan(0.0139);
  });
});

describe("chooseThreshold", () => {
  it("centres the threshold in the gap between good and bad renders", () => {
    const c = chooseThreshold(spec("colourDeltaE"), V([2, 3, 4, 5, 6, 7]), V([15, 18, 22], "n"), 20);
    expect(c.status).toBe("tightened");
    expect(c.proposed).toBe(11);
    expect(c.proposedConfusion).toMatchObject({ fp: 0, tp: 3 });
    expect(c.gap).toEqual({ from: 7, to: 15 });
    expect(c.newRenderFalseFlag).toBeCloseTo(1 / 7, 6);
  });

  it("keeps the current threshold when it already sits in the best gap", () => {
    const c = chooseThreshold(spec("colourDeltaE"), V([2, 3, 4, 5, 6, 7]), V([15, 18, 22], "n"), 12);
    expect(c.status).toBe("ok");
    expect(c.proposed).toBe(12);
  });

  it("loosens a threshold that flags good renders", () => {
    const c = chooseThreshold(spec("identityDiff"), V([0.05, 0.08, 0.12, 0.18, 0.2, 0.21]), V([0.3, 0.4], "n"), 0.15);
    expect(c.status).toBe("loosened");
    expect(c.proposed).toBeGreaterThanOrEqual(0.21);
    expect(c.proposed).toBeLessThan(0.3);
    expect(c.currentConfusion.fp).toBe(3);
    expect(c.proposedConfusion.fp).toBe(0);
  });

  it("allows the false-flag budget once there are enough good renders", () => {
    const pos = Array.from({ length: 20 }, (_, i) => i / 10); // 0 … 1.9
    pos[19] = 9; // one outlier
    const c = chooseThreshold(spec("hemErrorCm"), V(pos), V([4, 5, 6], "n"), 6);
    // 5 % of 20 = 1 allowed false flag: the outlier is flagged, the negatives are caught.
    expect(c.proposedConfusion.fp).toBe(1);
    expect(c.proposedConfusion.tp).toBe(3);
    expect(c.proposed).toBeGreaterThan(1.8);
    expect(c.proposed).toBeLessThan(4);
    expect(c.notes.join(" ")).toMatch(/far from the others/);
  });

  it("works for the lower-bound coverage metric", () => {
    // Current 0.6 flags the 0.5 render; lowering a minimum is a loosening.
    const c = chooseThreshold(spec("garmentCoverage"), V([0.6, 0.7, 0.8, 0.9, 0.95, 0.5]), V([0, 0.02, 0.1], "n"), 0.6);
    expect(c.status).toBe("loosened");
    expect(c.proposed).toBeCloseTo(0.3, 6);
    expect(c.proposedConfusion).toMatchObject({ fp: 0, tp: 3 });
  });

  it("keeps the current threshold when there is nothing to separate", () => {
    const c = chooseThreshold(spec("colourDeltaE"), V([2, 3, 4]), [], 12);
    expect(c.status).toBe("kept-not-separable");
    expect(c.proposed).toBe(12);
    const none = chooseThreshold(spec("colourDeltaE"), [], V([20], "n"), 12);
    expect(none.status).toBe("no-positives");
  });

  it("refuses to follow good renders beyond the sane range (metric mis-measured)", () => {
    const c = chooseThreshold(spec("hemErrorCm"), V([2, 3, 69, 69]), V([11], "n"), 6);
    expect(c.status).toBe("unreliable");
    expect(c.proposed).toBe(6);
    expect(c.notes.join(" ")).toMatch(/mis-measuring/);
  });
});

describe("propose / apply", () => {
  const current: ThresholdsFile = FIXTURE_FILE;

  function dataset(nGood: number, origin: "api" | "selftest" = "api"): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < nGood; i++) {
      const id = `g${i}`;
      out.push(sample({ id, base: id, origin, ...(origin === "api" ? { reviewed: true } : {}), metrics: { colourDeltaE: 3 + i * 0.3, identityDiff: 0.03 + i * 0.005, garmentCoverage: 0.7 + i * 0.01 } }));
      out.push(sample({ id: `${id}#colour`, base: id, label: "negative", origin: "synthetic", kind: "colour", metrics: { colourDeltaE: 10 + i } }));
      out.push(sample({ id: `${id}#identity`, base: id, label: "negative", origin: "synthetic", kind: "identity", metrics: { identityDiff: 0.2 + i * 0.01 } }));
      out.push(sample({ id: `${id}#missing`, base: id, label: "negative", origin: "synthetic", kind: "missing", metrics: { garmentCoverage: 0.01 } }));
    }
    return out;
  }

  it("only counts a sample for metrics the gate uses, and negatives for the metrics that target them", () => {
    const s = sample({ ctx: { transition: "colour_only", colourChangeExpected: false, lengthVariant: false } });
    expect(metricUsed(spec("residueFraction"), s)).toBe(false);
    expect(metricUsed(spec("silhouetteIoU"), s)).toBe(false);
    expect(metricUsed(spec("colourDeltaE"), s)).toBe(true);
    const neg = sample({ label: "negative", origin: "synthetic", kind: "colour" });
    expect(targetedBy(spec("colourDeltaE"), neg)).toBe(true);
    expect(targetedBy(spec("identityDiff"), neg)).toBe(false);
    const real = sample({ label: "negative", origin: "labelled", kind: "real", reasons: ["identityDiff"] });
    expect(targetedBy(spec("identityDiff"), real)).toBe(true);
    expect(targetedBy(spec("colourDeltaE"), real)).toBe(false);
    expect(targetedBy(spec("colourDeltaE"), { ...real, reasons: [] })).toBe(true);
  });

  it("proposes thresholds that separate the data and a valid thresholds file", () => {
    const samples = dataset(8);
    const p = propose(samples, current);
    expect(p.gate.colourDeltaE).toBeGreaterThan(3 + 7 * 0.3);
    expect(p.gate.colourDeltaE).toBeLessThan(10);
    expect(p.choices.find((c) => c.key === "colourDeltaE")!.status).toBe("tightened");
    expect(p.gate.identityDiff).toBeGreaterThan(0.065);
    expect(p.gate.identityDiff).toBeLessThan(0.2);
    expect(p.gateSevere.identityDiff).toBeGreaterThan(p.gate.identityDiff);
    expect(p.gateSevere.minCoverage).toBeLessThan(p.gate.minCoverage);
    const file = buildThresholdsFile(current, p, { at: "2026-11-10T00:00:00.000Z", source: "test", tuning: { n: 8 } });
    expect(file.preflight).toEqual(current.preflight);
    expect(diffThresholds(current, file).some((d) => d.startsWith("gate.colourDeltaE"))).toBe(true);
    const flaggedGood = verdictTable(samples, p.gate, p.gateSevere).find((r) => r.group.startsWith("good"))!;
    expect(flaggedGood.flagged).toBe(0);
    expect(retryStats(samples, p.gate, p.gateSevere)).toMatchObject({ basis: "real", renders: 8, flagged: 0 });
  });

  it("never tightens severe thresholds", () => {
    const s = proposeSevere({ identityDiff: 0.3, minCoverage: 0.08 }, { ...current.gate, identityDiff: 0.05, minCoverage: 0.4 }, {
      identityDiff: [0.02],
      garmentCoverage: [0.9],
    });
    expect(s).toEqual({ identityDiff: 0.3, minCoverage: 0.08 });
    const t = proposeSevere({ identityDiff: 0.3, minCoverage: 0.08 }, { ...current.gate, identityDiff: 0.25, minCoverage: 0.1 }, {
      identityDiff: [0.28],
      garmentCoverage: [0.09],
    });
    expect(t.identityDiff).toBeGreaterThanOrEqual(0.375);
    expect(t.minCoverage).toBeLessThanOrEqual(0.05);
  });

  it(`refuses --apply on self-test data and with fewer than ${MIN_POSITIVES_TO_APPLY} good real renders`, () => {
    expect(applyGuard(dataset(10, "selftest"), "selftest").ok).toBe(false);
    expect(applyGuard(dataset(MIN_POSITIVES_TO_APPLY - 1), "probe").ok).toBe(false);
    expect(applyGuard(dataset(MIN_POSITIVES_TO_APPLY), "probe").ok).toBe(true);
    // Labelled-bad renders don't count as good ones.
    const mixed = dataset(MIN_POSITIVES_TO_APPLY).map((s, i) => (i === 0 ? { ...s, label: "negative" as const, origin: "labelled" as const, kind: "real" as const } : s));
    expect(applyGuard(mixed, "probe").ok).toBe(false);
  });

  it("refuses --apply while any real render is unlabelled (an unchecked bad render would loosen the gate)", () => {
    // Five clean renders and one with a different-looking face, nobody has looked at them yet.
    const base = dataset(MIN_POSITIVES_TO_APPLY).map((s) => (s.origin === "api" ? { ...s, reviewed: undefined } : s));
    const unlabelled = base.map((s) => (s.id === "g5" ? { ...s, metrics: { ...s.metrics, identityDiff: 0.33 } } : s));
    // The proposal would loosen identity to let the outlier pass…
    expect(propose(unlabelled, current).gate.identityDiff).toBeGreaterThan(0.33);
    // …so apply is refused until every render carries an explicit label.
    const g = applyGuard(unlabelled, "probe");
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/6 of 6 real render\(s\) are not labelled/);
    const oneLeft = unlabelled.map((s) => (s.origin === "api" && s.id !== "g5" ? { ...s, reviewed: true } : s));
    expect(applyGuard(oneLeft, "probe")).toMatchObject({ ok: false, reason: expect.stringContaining("(g5)") });
    // Labelled bad: it becomes a negative, identity stays tight, and the five good ones are too few.
    const labelled = oneLeft.map((s) => (s.id === "g5" ? { ...s, label: "negative" as const, origin: "labelled" as const, kind: "real" as const, reasons: ["identityDiff" as const] } : s));
    expect(propose(labelled, current).gate.identityDiff).toBeLessThan(0.33);
    expect(applyGuard(labelled, "probe").ok).toBe(false);
    expect(applyGuard(oneLeft.map((s) => (s.origin === "api" ? { ...s, reviewed: true } : s)), "probe").ok).toBe(true);
  });

  it("renders a report with the self-test banner and every section", () => {
    const samples = dataset(3, "selftest");
    const md = renderReport({
      mode: "selftest",
      at: "2026-11-07T00:00:00.000Z",
      current,
      proposal: propose(samples, current),
      samples,
      guard: applyGuard(samples, "selftest"),
      applied: null,
      skipped: [{ id: "g0#hem+10", why: "doesn't fit" }],
      preflight: [],
      garments: [{ sku: "fw-wrap-dress-emerald", catalogueHex: "#1F7A5A", photoHex: "#3a5f40", deltaE: 12.3 }],
      warnings: ["example warning"],
      environment: { Browser: "test" },
    });
    for (const h of ["Self-test, not a calibration", "## Thresholds: current vs proposed", "## Distributions", "## Confusion matrices", "## Whole gate", "## Expected retry rate", "## Severe thresholds", "update colorHex", "## Per render", "## Skipped synthetic variants"]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("refused");
  });
});

describe("preflight-only report", () => {
  it("shows only the photo checks", () => {
    const current = FIXTURE_FILE;
    const md = renderReport({
      mode: "preflight",
      at: "2026-11-07T00:00:00.000Z",
      current,
      proposal: propose([], current),
      samples: [],
      guard: { ok: false, reason: "preflight-only run" },
      applied: null,
      skipped: [],
      preflight: [
        {
          photo: "alex",
          variant: "original",
          ok: false,
          failed: ["lighting"],
          values: [{ check: "lighting", signal: "mean luma (0..255)", threshold: "preflight.luminance", value: 40, min: 60, max: 215, ok: false }],
        },
        { photo: "alex", variant: "pf-blur", ok: false, failed: ["sharpness"], values: [] },
      ],
      garments: [],
      warnings: [],
      environment: {},
    });
    expect(md).toContain("# Photo preflight report");
    expect(md).toContain("0 of 1 photo(s) pass");
    expect(md).toContain("60 … 215");
    expect(md).not.toContain("## Thresholds: current vs proposed");
  });
});

describe("labels", () => {
  it("parses render labels and reason words", () => {
    expect(parseLabel("good")).toEqual({ label: "good", reasons: [] });
    expect(parseLabel({ label: "bad", why: ["Face", "colour", "face"] })).toEqual({ label: "bad", reasons: ["identityDiff", "colourDeltaE"] });
    expect(parseLabel({ label: "bad", why: "hem", note: "too short" })).toEqual({ label: "bad", reasons: ["hemErrorCm"], note: "too short" });
    expect(parseLabel("meh")).toBeNull();
    expect(parseLabel({ label: "great" })).toBeNull();
  });

  it("rejects unknown why words instead of silently treating the render as bad on every metric", () => {
    expect(() => parseLabel({ label: "bad", why: ["colours"] })).toThrow(LabelError);
    expect(() => parseLabel({ label: "bad", why: ["skin"] })).toThrow(/unknown "why" word "skin" \(use: colour, color, residue/);
  });

  it("parses a labels file: todo entries are unreviewed, bad entries name the render", () => {
    const f = parseLabelsFile({ wearing: { "*": "fw-wrap-dress-mustard:M" }, renders: { a: "good", b: "todo", c: { label: "bad", why: ["identity"] } } });
    expect(f.wearing).toEqual({ "*": "fw-wrap-dress-mustard:M" });
    expect(Object.keys(f.renders)).toEqual(["a", "c"]);
    expect(f.todo).toEqual(["b"]);
    expect(() => parseLabelsFile({ renders: { x: { label: "bad", why: ["colours"] } } })).toThrow(/renders\["x"\]: unknown "why" word/);
    expect(() => parseLabelsFile({ renders: { x: "meh" } })).toThrow(/renders\["x"\] must be/);
    expect(parseLabelsFile(null)).toEqual({ wearing: {}, renders: {}, todo: [] });
  });

  it("parses wearing specs", () => {
    expect(parseWearing("fw-wrap-dress-mustard:S")).toEqual({ skuId: "fw-wrap-dress-mustard", size: "S" });
    expect(parseWearing("fw-wrap-dress-mustard")).toEqual({ skuId: "fw-wrap-dress-mustard", size: "M" });
  });
});
