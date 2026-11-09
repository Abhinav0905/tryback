// DOM-free parts of the browser CV modules (preflight checks, live coach, measurements,
// gate pixel helpers). runPreflight/runGate themselves need canvas + MediaPipe and are
// exercised in the browser.
import { beforeEach, describe, expect, it } from "vitest";
import { PREFLIGHT_TITLES } from "@/components/shopper/format";
import {
  buildMeasurements,
  evaluatePreflight,
  laplacianVariance,
  liveCoach,
  meanLuminance,
  PREFLIGHT_THRESHOLDS,
  resetLiveCoach,
  rgbaToGray,
  type PreflightOutput,
  type PreflightSignals,
} from "@/lib/cv/preflight";
import { expectedRenderLab, fractionNear, meanAbsGrayDiff } from "@/lib/cv/gate";
import { boxMask, emptyMask, type Mask } from "@/lib/cv/geometry";
import { deltaE2000, hexToLab, hexToRgb } from "@/lib/color";
import type { BodyKeypoints, Keypoint, Pom } from "@/lib/types";

const W = 600;
const H = 1000;

function k(x: number, y: number, visibility = 0.99): Keypoint {
  return { x, y, visibility };
}

/** Same synthetic adult as tests/geometry.test.ts (5 px/cm, 165 cm). */
function person(overrides: Partial<BodyKeypoints> = {}): BodyKeypoints {
  return {
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
    ...overrides,
  };
}

function signals(overrides: Partial<PreflightSignals> = {}): PreflightSignals {
  return {
    width: W,
    height: H,
    keypoints: person(),
    personCount: 1,
    shoulderYawDeg: 5,
    garmentCoverage: 0.85,
    meanLuminance: 140,
    sharpness: 120,
    ...overrides,
  };
}

function byId(r: ReturnType<typeof evaluatePreflight>, id: string) {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`missing check ${id}`);
  return c;
}

describe("evaluatePreflight", () => {
  it("passes a well-framed photo and reports all seven checks in order", () => {
    const r = evaluatePreflight(signals());
    expect(r.ok).toBe(true);
    expect(r.overridden).toBe(false);
    expect(r.checks.map((c) => c.id)).toEqual([
      "full_body",
      "single_person",
      "frontal",
      "garment_visible",
      "torso_unobstructed",
      "lighting",
      "sharpness",
    ]);
    for (const c of r.checks) expect(c.message.length).toBeGreaterThan(0);
    // The checklist shows each row's title with its message underneath: never the same words twice.
    for (const c of r.checks) expect(c.message.toLowerCase(), c.id).not.toBe(PREFLIGHT_TITLES[c.id].toLowerCase());
  });

  it("full_body: asks to step back when the feet are cut off", () => {
    const r = evaluatePreflight(signals({ keypoints: person({ leftAnkle: k(345, 995), rightAnkle: k(255, 990) }) }));
    expect(r.ok).toBe(false);
    expect(byId(r, "full_body").message).toMatch(/feet/);
  });

  it("full_body: fails when a landmark has low visibility", () => {
    const r = evaluatePreflight(signals({ keypoints: person({ rightAnkle: k(255, 838, 0.3) }) }));
    expect(byId(r, "full_body").ok).toBe(false);
    expect(byId(r, "full_body").value).toBeCloseTo(0.3, 3);
  });

  it("full_body: asks for the head when the nose is at the top edge", () => {
    const r = evaluatePreflight(signals({ keypoints: person({ nose: k(300, 10) }) }));
    expect(byId(r, "full_body").message).toMatch(/head/);
  });

  it("single_person: distinguishes nobody from a second person", () => {
    expect(byId(evaluatePreflight(signals({ personCount: 2 })), "single_person").message).toMatch(/only person/);
    const none = evaluatePreflight(signals({ personCount: 0, keypoints: null }));
    expect(byId(none, "single_person").message).toMatch(/couldn't find a person/);
    expect(none.ok).toBe(false);
  });

  it("frontal: fails when the torso is turned (narrow shoulders) or yaw is large", () => {
    const turned = person({ leftShoulder: k(330, 230), rightShoulder: k(250, 230), leftHip: k(320, 500), rightHip: k(270, 500) });
    expect(byId(evaluatePreflight(signals({ keypoints: turned })), "frontal").ok).toBe(false);
    expect(byId(evaluatePreflight(signals({ shoulderYawDeg: 50 })), "frontal").ok).toBe(false);
    expect(byId(evaluatePreflight(signals({ shoulderYawDeg: null })), "frontal").ok).toBe(true);
  });

  it("garment_visible: needs ≥30% of the torso covered by clothes", () => {
    expect(byId(evaluatePreflight(signals({ garmentCoverage: 0.29 })), "garment_visible").ok).toBe(false);
    expect(byId(evaluatePreflight(signals({ garmentCoverage: 0.3 })), "garment_visible").ok).toBe(true);
    expect(byId(evaluatePreflight(signals({ garmentCoverage: null })), "garment_visible").message).toMatch(/retake/);
  });

  it("torso_unobstructed: fails only when both wrists are inside the upper torso", () => {
    const folded = person({ leftWrist: k(320, 300), rightWrist: k(280, 310) });
    expect(byId(evaluatePreflight(signals({ keypoints: folded })), "torso_unobstructed").ok).toBe(false);
    const oneHand = person({ leftWrist: k(320, 300) }); // e.g. holding the phone for a mirror selfie
    expect(byId(evaluatePreflight(signals({ keypoints: oneHand })), "torso_unobstructed").ok).toBe(true);
  });

  it("lighting: 60..215 mean luminance", () => {
    expect(byId(evaluatePreflight(signals({ meanLuminance: 40 })), "lighting").message).toMatch(/dark/);
    expect(byId(evaluatePreflight(signals({ meanLuminance: 230 })), "lighting").message).toMatch(/bright/);
    expect(byId(evaluatePreflight(signals({ meanLuminance: 60 })), "lighting").ok).toBe(true);
    expect(byId(evaluatePreflight(signals({ meanLuminance: 215 })), "lighting").ok).toBe(true);
  });

  it("sharpness: variance of the Laplacian above the threshold", () => {
    const t = PREFLIGHT_THRESHOLDS.minSharpness;
    expect(byId(evaluatePreflight(signals({ sharpness: t - 1 })), "sharpness").ok).toBe(false);
    expect(byId(evaluatePreflight(signals({ sharpness: t })), "sharpness").ok).toBe(true);
  });

  it("never mentions skin or body shape in any message", () => {
    const worst = evaluatePreflight(signals({ keypoints: null, personCount: 3, garmentCoverage: 0, meanLuminance: 5, sharpness: 0 }));
    for (const c of worst.checks) expect(c.message).not.toMatch(/skin|body shape|weight|figure|tone/i);
  });
});

describe("image statistics", () => {
  function grayImage(w: number, h: number, f: (x: number, y: number) => number) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = f(x, y);
        rgba.set([v, v, v, 255], (y * w + x) * 4);
      }
    return rgbaToGray(rgba, w, h);
  }

  it("meanLuminance averages luma", () => {
    expect(meanLuminance(grayImage(10, 10, () => 100))).toBeCloseTo(100, 6);
    expect(meanLuminance(grayImage(10, 10, (x) => (x < 5 ? 0 : 200)))).toBeCloseTo(100, 6);
  });

  it("laplacianVariance is 0 for flat images and high for sharp detail, low after blur", () => {
    expect(laplacianVariance(grayImage(32, 32, () => 128))).toBe(0);
    const checker = grayImage(64, 64, (x, y) => (((x >> 1) + (y >> 1)) % 2 ? 230 : 25));
    const sharp = laplacianVariance(checker);
    expect(sharp).toBeGreaterThan(PREFLIGHT_THRESHOLDS.minSharpness * 10);
    // A smooth gradient (heavily blurred edge) has almost no Laplacian energy.
    const blurred = grayImage(64, 64, (x) => 25 + (205 * x) / 63);
    expect(laplacianVariance(blurred)).toBeLessThan(PREFLIGHT_THRESHOLDS.minSharpness);
  });

  it("laplacianVariance can be restricted to a region", () => {
    const half = grayImage(64, 64, (x, y) => (x < 32 ? 128 : ((x + y) % 2 ? 230 : 25)));
    expect(laplacianVariance(half, { x0: 0, y0: 0, x1: 30, y1: 64 })).toBe(0);
    expect(laplacianVariance(half, { x0: 34, y0: 0, x1: 64, y1: 64 })).toBeGreaterThan(1000);
  });
});

describe("liveCoach", () => {
  beforeEach(() => resetLiveCoach());

  it("gives one tip at a time, in priority order", () => {
    expect(liveCoach(null, 0, W, H)).toEqual({ ready: false, tip: "Step into the frame — head to toe" });
    expect(liveCoach(person(), 2, W, H).tip).toBe("Just you in the frame, please");
    expect(liveCoach(person({ leftAnkle: k(345, 990) }), 1, W, H).tip).toBe("Step back — we need to see your feet");
    expect(liveCoach(person({ leftWrist: k(380, 200), leftElbow: k(420, 300) }), 1, W, H).tip).toBe("Arms relaxed by your sides");
  });

  it("asks the shopper to hold still before declaring ready", () => {
    expect(liveCoach(person(), 1, W, H)).toEqual({ ready: false, tip: "Hold still" });
    expect(liveCoach(person(), 1, W, H)).toEqual({ ready: true, tip: "Great — hold for the timer" });
    // A big jump between frames resets readiness.
    const moved = person({ nose: k(360, 120), leftShoulder: k(455, 230), rightShoulder: k(265, 230), leftHip: k(420, 500), rightHip: k(300, 500) });
    expect(liveCoach(moved, 1, W, H).tip).toBe("Hold still");
  });

  it("coaches distance and centring", () => {
    const small = person({ nose: k(300, 400), leftAnkle: k(345, 700), rightAnkle: k(255, 700) });
    expect(liveCoach(small, 1, W, H).tip).toBe("Come a little closer");
    const offCentre: BodyKeypoints = Object.fromEntries(
      Object.entries(person()).map(([key, p]) => [key, { ...p, x: p.x - 200 }]),
    ) as unknown as BodyKeypoints;
    expect(liveCoach(offCentre, 1, W, H).tip).toBe("Move to the centre of the frame");
  });
});

describe("buildMeasurements", () => {
  const WRAP_M: Pom = { hpsToHemCm: 98, sleeveCm: null, halfChestCm: 46 };

  function fillMask(m: Mask, y0: number, y1: number, x0: number, x1: number) {
    for (let y = y0; y <= y1; y++) m.data.fill(1, y * m.width + x0, y * m.width + x1 + 1);
  }

  /** White backdrop; mustard dress from the shoulders to y=697 (knee); optional navy trousers below. */
  function scene(opts: { trousers?: boolean } = {}): PreflightOutput {
    const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
    const clothes = emptyMask(W, H);
    const mustard = hexToRgb("#C9A227");
    const navy = hexToRgb("#1F2A44");
    const paint = (y0: number, y1: number, x0: number, x1: number, c: number[]) => {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) rgba.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
      fillMask(clothes, y0, y1, x0, x1);
    };
    paint(215, 697, 215, 385, mustard);
    if (opts.trousers) paint(698, 830, 240, 360, navy);
    const face = boxMask(W, H, { x0: 270, y0: 80, x1: 330, y1: 160 });
    const personMask = boxMask(W, H, { x0: 170, y0: 60, x1: 430, y1: 860 });
    return {
      result: evaluatePreflight(signals()),
      keypoints: person(),
      masks: { clothes, face, person: personMask },
      rgba,
      width: W,
      height: H,
    };
  }

  it("calibrates from the worn garment and records its colour and ease", () => {
    const m = buildMeasurements(scene(), { size: "M", pom: WRAP_M, colorHex: "#C9A227" });
    expect(m.calibration?.method).toBe("garment");
    expect(m.calibration!.pxPerCm).toBeCloseTo(5, 1);
    expect(m.hemCm).toBe(98);
    expect(m.easeRatio).not.toBeNull();
    expect(m.easeRatio!).toBeGreaterThan(0.9);
    expect(m.easeRatio!).toBeLessThan(1.05);
    expect(m.observedGarmentLab).not.toBeNull();
    expect(deltaE2000(m.observedGarmentLab!, hexToLab("#C9A227"))).toBeLessThan(0.5);
    expect(m.garmentMaskArea).toBeGreaterThan(0.1);
    expect(m.garmentMaskArea).toBeLessThan(0.2);
  });

  it("uses colour to ignore differently coloured clothing below the garment", () => {
    const m = buildMeasurements(scene({ trousers: true }), { size: "M", pom: WRAP_M, colorHex: "#C9A227" });
    expect(m.calibration?.observedHemY).toBe(697);
  });

  it("falls back to stated height when the garment ruler is implausible", () => {
    // A POM that would make the person ~400 cm tall is rejected; height takes over.
    const pom: Pom = { ...WRAP_M, hpsToHemCm: 40 };
    const none = buildMeasurements(scene(), { size: "M", pom, colorHex: "#C9A227" });
    expect(none.calibration).toBeNull();
    expect(none.hemCm).toBeNull();
    const m = buildMeasurements(scene(), { size: "M", pom, colorHex: "#C9A227" }, { heightCm: 165 });
    expect(m.calibration?.method).toBe("height");
    expect(m.hemCm).toBeCloseTo(98, 0);
  });

  it("widens the band when stated height disagrees with the garment ruler", () => {
    const base = buildMeasurements(scene(), { size: "M", pom: WRAP_M, colorHex: "#C9A227" });
    const off = buildMeasurements(scene(), { size: "M", pom: WRAP_M, colorHex: "#C9A227" }, { heightCm: 190 });
    expect(off.calibration!.pxPerCm).toBeCloseTo(base.calibration!.pxPerCm, 9);
    expect(off.calibration!.uncertaintyCm).toBeGreaterThan(base.calibration!.uncertaintyCm);
  });

  it("degrades gracefully without a pose (dev override path)", () => {
    const pre = { ...scene(), keypoints: null };
    const m = buildMeasurements(pre, { size: "M", pom: WRAP_M, colorHex: "#C9A227" });
    expect(m.calibration).toBeNull();
    expect(m.easeRatio).toBeNull();
    expect(m.observedGarmentLab).toBeNull();
    expect(m.keypoints.nose.visibility).toBe(0);
  });
});

describe("gate pixel helpers", () => {
  it("expectedRenderLab applies the clamped lighting offset", () => {
    const source = hexToLab("#C9A227");
    const target = hexToLab("#1F7A5A");
    expect(expectedRenderLab(target, source, null)).toEqual(target);
    const darker: [number, number, number] = [source[0] - 10, source[1] + 2, source[2] - 40];
    const e = expectedRenderLab(target, source, darker);
    expect(e[0]).toBeCloseTo(target[0] - 10, 9);
    expect(e[1]).toBeCloseTo(target[1] + 2, 9);
    expect(e[2]).toBeCloseTo(target[2] - 25, 9); // clamped at ±25
  });

  it("fractionNear counts pixels close to a reference colour", () => {
    const w = 20;
    const h = 20;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const mustard = hexToRgb("#C9A227");
    const emerald = hexToRgb("#1F7A5A");
    for (let i = 0; i < w * h; i++) {
      const c = i % w < 5 ? mustard : emerald; // 25% residue
      rgba.set([c[0], c[1], c[2], 255], i * 4);
    }
    const all = boxMask(w, h, { x0: 0, y0: 0, x1: w, y1: h });
    expect(fractionNear(rgba, all, hexToLab("#C9A227"), 10, 1)).toBeCloseTo(0.25, 9);
    expect(fractionNear(rgba, emptyMask(w, h), hexToLab("#C9A227"))).toBeNull();
  });

  it("meanAbsGrayDiff is 0 for identical pixels and 1 for black vs white", () => {
    const w = 4;
    const white = new Uint8ClampedArray(w * w * 4).fill(255);
    const black = new Uint8ClampedArray(w * w * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    const box = { x0: 0, y0: 0, x1: w, y1: w };
    expect(meanAbsGrayDiff(white, white, w, box)).toBe(0);
    expect(meanAbsGrayDiff(white, black, w, box)).toBeCloseTo(1, 9);
  });
});
