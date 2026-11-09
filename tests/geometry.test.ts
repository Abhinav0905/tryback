import { describe, expect, it } from "vitest";
import {
  boxMask,
  calibrateFromGarment,
  calibrateFromHeight,
  easeRatio,
  emptyMask,
  findHemY,
  findSleeveEnd,
  formatDeltaCm,
  highPointShoulderY,
  maskBBox,
  maskCoverageInBox,
  maskIoU,
  refineMaskByColour,
  resampleNearest,
  rowRun,
  scaleKeypoints,
  torsoBox,
  type Mask,
} from "@/lib/cv/geometry";
import { hexToLab, hexToRgb } from "@/lib/color";
import { requireSku } from "@/lib/catalog";
import type { BodyKeypoints, Keypoint, Pom, SizeOption } from "@/lib/types";
import { projectSizeLines } from "@/lib/cv/geometry";

/* ───────────── Synthetic scene ─────────────
 * A 600×1000 photo of an adult at exactly 5 px/cm:
 *   shoulders 38 cm apart (190 px), hip landmarks 24 cm apart (120 px),
 *   nose→ankle 718 px = 0.87 × 165 cm, HPS = 230 − 0.12×190 = 207.2.
 * A knee-length wrap dress (HPS→hem 98 cm) ends at 207.2 + 490 = 697.2.
 */
const W = 600;
const H = 1000;
const PX_PER_CM = 5;

function k(x: number, y: number, visibility = 0.99): Keypoint {
  return { x, y, visibility };
}

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

const KP = person();
const HPS = 230 - 0.12 * 190;
const WRAP_M: Pom = { hpsToHemCm: 98, sleeveCm: 58, halfChestCm: 46 };

/** Fill rows y0..y1 (inclusive) with spans that interpolate linearly from [a0,b0] to [a1,b1]. */
function trapezoid(mask: Mask, y0: number, y1: number, top: [number, number], bottom: [number, number]) {
  for (let y = y0; y <= y1; y++) {
    const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
    const xa = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const xb = Math.round(top[1] + (bottom[1] - top[1]) * t);
    for (let x = Math.max(0, xa); x <= Math.min(mask.width - 1, xb); x++) mask.data[y * mask.width + x] = 1;
  }
}

/** Paint a thick polyline (an arm sleeve) from the shoulder along the chain for `lengthPx`. */
function sleeve(mask: Mask, chain: Keypoint[], lengthPx: number, halfWidth = 16) {
  let remaining = lengthPx;
  for (let i = 0; i < chain.length - 1 && remaining > 0; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const use = Math.min(L, remaining);
    const nx = -(b.y - a.y) / L;
    const ny = (b.x - a.x) / L;
    // Flat (square) cap: paint perpendicular strokes so the sleeve ends exactly at `use`.
    for (let d = 0; d <= use; d += 0.5) {
      const cx = a.x + ((b.x - a.x) * d) / L;
      const cy = a.y + ((b.y - a.y) * d) / L;
      for (let o = -halfWidth; o <= halfWidth; o += 0.5) {
        const x = Math.round(cx + nx * o);
        const y = Math.round(cy + ny * o);
        if (x >= 0 && y >= 0 && x < mask.width && y < mask.height) mask.data[y * mask.width + x] = 1;
      }
    }
    remaining -= use;
  }
}

function leftArm(kp: BodyKeypoints) {
  const ext = { x: kp.leftWrist.x + (kp.leftWrist.x - kp.leftElbow.x) * 0.4, y: kp.leftWrist.y + (kp.leftWrist.y - kp.leftElbow.y) * 0.4, visibility: 1 };
  return [kp.leftShoulder, kp.leftElbow, kp.leftWrist, ext];
}
function rightArm(kp: BodyKeypoints) {
  const ext = { x: kp.rightWrist.x + (kp.rightWrist.x - kp.rightElbow.x) * 0.4, y: kp.rightWrist.y + (kp.rightWrist.y - kp.rightElbow.y) * 0.4, visibility: 1 };
  return [kp.rightShoulder, kp.rightElbow, kp.rightWrist, ext];
}

/** Bodice from the shoulders to the hips, then a gently flared skirt to `hemY`. */
function dressMask(opts: { hemY?: number; skirtFlare?: number; sleevePx?: number | null; hipHalf?: number } = {}): Mask {
  const hemY = opts.hemY ?? 697;
  const flare = opts.skirtFlare ?? 25;
  const half = opts.hipHalf ?? 85;
  const m = emptyMask(W, H);
  trapezoid(m, 215, 500, [300 - half, 300 + half], [300 - half, 300 + half]);
  trapezoid(m, 501, hemY, [300 - half, 300 + half], [300 - half - flare, 300 + half + flare]);
  if (opts.sleevePx) {
    sleeve(m, leftArm(KP), opts.sleevePx);
    sleeve(m, rightArm(KP), opts.sleevePx);
  }
  return m;
}

/* ───────────── Tests ───────────── */

describe("torso & HPS", () => {
  it("torsoBox spans shoulders → hips regardless of left/right order", () => {
    expect(torsoBox(KP)).toEqual({ x0: 205, y0: 230, x1: 395, y1: 500 });
  });
  it("HPS is the shoulder line raised by 0.12 × shoulder width", () => {
    expect(highPointShoulderY(KP)).toBeCloseTo(HPS, 9);
  });
});

describe("findHemY", () => {
  it("finds the hem of a flared skirt", () => {
    expect(findHemY(dressMask(), KP)).toBe(697);
  });

  it("ignores a disconnected blob near the feet (shoes)", () => {
    const m = dressMask();
    trapezoid(m, 820, 850, [240, 360], [240, 360]);
    expect(findHemY(m, KP)).toBe(697);
  });

  it("bridges thin horizontal gaps in a noisy mask", () => {
    const m = dressMask();
    for (const y of [600, 601, 602]) m.data.fill(0, y * W, (y + 1) * W);
    expect(findHemY(m, KP)).toBe(697);
  });

  it("requires ≥35% corridor coverage (a narrow strip is not a skirt)", () => {
    const m = dressMask({ hemY: 520 });
    // 20 px strip below the hem inside a 120 px corridor = 17% coverage.
    trapezoid(m, 521, 800, [290, 309], [290, 309]);
    expect(findHemY(m, KP)).toBe(520);
  });

  it("returns null when the garment ends above the hips (cropped top)", () => {
    const m = emptyMask(W, H);
    trapezoid(m, 215, 380, [215, 385], [215, 385]);
    expect(findHemY(m, KP)).toBeNull();
  });

  it("returns null when the hips are not visible", () => {
    const kp = person({ leftHip: k(360, 500, 0.2) });
    expect(findHemY(dressMask(), kp)).toBeNull();
  });
});

describe("findSleeveEnd", () => {
  it("finds the end of a long sleeve along shoulder→elbow→wrist", () => {
    const m = dressMask({ sleevePx: 58 * PX_PER_CM });
    const end = findSleeveEnd(m, KP, "left");
    expect(end).not.toBeNull();
    // 290 px along the chain: past the elbow (152 px) and the wrist (282 px).
    expect(end!.y).toBeGreaterThan(KP.leftWrist.y - 5);
    expect(end!.y).toBeLessThan(KP.leftWrist.y + 30);
  });

  it("finds a short sleeve on the upper arm", () => {
    const m = dressMask({ sleevePx: 100 });
    const end = findSleeveEnd(m, KP, "right");
    expect(end).not.toBeNull();
    expect(end!.y).toBeGreaterThan(300);
    expect(end!.y).toBeLessThan(KP.rightElbow.y);
  });

  it("returns null for a sleeveless garment", () => {
    const m = emptyMask(W, H);
    trapezoid(m, 300, 697, [230, 370], [200, 400]); // bodice starts below the shoulders
    expect(findSleeveEnd(m, KP, "left")).toBeNull();
  });

  it("returns null when the wrist isn't visible", () => {
    const kp = person({ leftWrist: k(425, 510, 0.1) });
    expect(findSleeveEnd(dressMask({ sleevePx: 290 }), kp, "left")).toBeNull();
  });
});

describe("calibrateFromGarment", () => {
  it("recovers px/cm from the worn garment's HPS→hem length", () => {
    const cal = calibrateFromGarment(KP, dressMask({ sleevePx: 58 * PX_PER_CM }), "M", WRAP_M);
    expect(cal).not.toBeNull();
    expect(cal!.method).toBe("garment");
    expect(cal!.pxPerCm).toBeCloseTo((697 - HPS) / 98, 9);
    expect(Math.abs(cal!.pxPerCm - PX_PER_CM)).toBeLessThan(0.05);
    expect(cal!.observedHemY).toBe(697);
    expect(cal!.hpsY).toBeCloseTo(HPS, 9);
    expect(cal!.observedSleeveEnd).not.toBeNull();
    expect(cal!.uncertaintyCm).toBeGreaterThanOrEqual(1);
    expect(cal!.uncertaintyCm).toBeLessThan(2.5);
    expect(cal!.centerX).toBeCloseTo(300, 9);
    expect(cal!.hemHalfWidthPx).toBeGreaterThan(95);
    expect(cal!.hemHalfWidthPx).toBeLessThan(115);
    expect(cal!.imageWidth).toBe(W);
    expect(cal!.imageHeight).toBe(H);
    expect(cal!.purchasedSize).toBe("M");
  });

  it("widens the band when the sleeve anchor disagrees with the hem anchor", () => {
    const agree = calibrateFromGarment(KP, dressMask({ sleevePx: 290 }), "M", WRAP_M)!;
    const disagree = calibrateFromGarment(KP, dressMask({ sleevePx: 200 }), "M", WRAP_M)!;
    expect(disagree).not.toBeNull();
    expect(disagree.pxPerCm).toBeCloseTo(agree.pxPerCm, 9); // hem stays the ruler
    expect(disagree.uncertaintyCm).toBeGreaterThan(agree.uncertaintyCm + 2);
  });

  it("works without a sleeve cross-check for sleeveless garments", () => {
    const slip: Pom = { hpsToHemCm: 98, sleeveCm: null, halfChestCm: 47 };
    const cal = calibrateFromGarment(KP, dressMask(), "M", slip)!;
    expect(cal).not.toBeNull();
    expect(cal.observedSleeveEnd).toBeNull();
    expect(cal.uncertaintyCm).toBeGreaterThanOrEqual(1.5);
  });

  it("returns null when the hem is above the hips", () => {
    const m = emptyMask(W, H);
    trapezoid(m, 215, 400, [215, 385], [215, 385]);
    expect(calibrateFromGarment(KP, m, "M", WRAP_M)).toBeNull();
  });

  it("returns null when px/cm falls outside 1..40", () => {
    expect(calibrateFromGarment(KP, dressMask(), "M", { ...WRAP_M, hpsToHemCm: 5 })).toBeNull();
    expect(calibrateFromGarment(KP, dressMask(), "M", { ...WRAP_M, hpsToHemCm: 900 })).toBeNull();
  });

  it("returns null when the implied body proportions are implausible", () => {
    // A 40 cm POM would make this person ~400 cm tall.
    expect(calibrateFromGarment(KP, dressMask(), "M", { ...WRAP_M, hpsToHemCm: 40 })).toBeNull();
  });

  it("returns null when the garment runs off the bottom of the frame", () => {
    const m = dressMask({ hemY: H - 1 });
    expect(findHemY(m, KP)).toBe(H - 1);
    expect(calibrateFromGarment(KP, m, "M", { ...WRAP_M, hpsToHemCm: 158 })).toBeNull();
    expect(calibrateFromHeight(KP, m, 165, "M", WRAP_M)).toBeNull();
  });

  it("returns null with low keypoint visibility", () => {
    const kp = person({ rightShoulder: k(205, 230, 0.3) });
    expect(calibrateFromGarment(kp, dressMask(), "M", WRAP_M)).toBeNull();
  });
});

describe("calibrateFromHeight", () => {
  it("derives px/cm from the nose→ankle span (≈0.87 × height)", () => {
    const cal = calibrateFromHeight(KP, dressMask(), 165, "M", WRAP_M);
    expect(cal).not.toBeNull();
    expect(cal!.method).toBe("height");
    expect(cal!.pxPerCm).toBeCloseTo(718 / (0.87 * 165), 9);
    expect(cal!.observedHemY).toBe(697);
    expect(cal!.uncertaintyCm).toBeGreaterThanOrEqual(2);
  });

  it("returns null for implausible heights or missing ankles", () => {
    expect(calibrateFromHeight(KP, dressMask(), 40, "M", WRAP_M)).toBeNull();
    const kp = person({ leftAnkle: k(345, 838, 0.1), rightAnkle: k(255, 838, 0.1) });
    expect(calibrateFromHeight(kp, dressMask(), 165, "M", WRAP_M)).toBeNull();
  });

  it("returns null when the worn garment's hem can't be found", () => {
    const m = emptyMask(W, H);
    trapezoid(m, 215, 380, [215, 385], [215, 385]);
    expect(calibrateFromHeight(KP, m, 165, "M", WRAP_M)).toBeNull();
  });
});

describe("projectSizeLines", () => {
  const cal = calibrateFromGarment(KP, dressMask({ sleevePx: 290 }), "M", WRAP_M)!;
  const sku = requireSku("fw-wrap-dress-mustard");

  function option(size: SizeOption["size"], deltaHemCm: number, lengthVariant: SizeOption["lengthVariant"] = "regular"): SizeOption {
    return {
      skuId: sku.id,
      size,
      lengthVariant,
      deltaHemCm,
      deltaSleeveCm: 1,
      deltaChestCircCm: 5,
      fixes: [],
      tradeoffs: [],
      recommended: false,
      inStock: true,
      priceDiff: 0,
      note: "",
    };
  }

  it("draws each option relative to the observed hem with a ± band", () => {
    const lines = projectSizeLines(cal, [option("L", 1.5), option("S", -1.5)], [sku]);
    expect(lines).toHaveLength(2);
    expect(lines[0].hemY).toBeCloseTo(cal.observedHemY + 1.5 * cal.pxPerCm, 9);
    expect(lines[0].bandPx).toBeCloseTo(cal.uncertaintyCm * cal.pxPerCm, 9);
    expect(lines[0].label).toBe("L Regular · +1.5 cm");
    expect(lines[1].label).toBe("S Regular · −1.5 cm");
    expect(lines[1].hemY).toBeLessThan(cal.observedHemY);
  });

  it("uses the SKU's length variant and formats whole-cm deltas", () => {
    const tall = requireSku("fw-trench-stone-tall");
    const lines = projectSizeLines(cal, [{ ...option("M", 6, "tall"), skuId: tall.id }], [tall]);
    expect(lines[0].label).toBe("M Tall · +6 cm");
  });

  it("falls back to SKU POMs when an option's delta is missing", () => {
    const lines = projectSizeLines(cal, [option("XL", Number.NaN)], [sku]);
    expect(lines[0].deltaHemCm).toBeCloseTo(sku.poms.XL.hpsToHemCm - WRAP_M.hpsToHemCm, 9);
    expect(lines[0].label).toBe("XL Regular · +3 cm");
  });

  it("formats deltas with a true minus sign", () => {
    expect(formatDeltaCm(0)).toBe("±0 cm");
    expect(formatDeltaCm(-5)).toBe("−5 cm");
    expect(formatDeltaCm(1.54)).toBe("+1.5 cm");
  });
});

describe("easeRatio", () => {
  it("is ≈1.0 for a garment that follows the body", () => {
    // Visible hip width = 120 px landmark distance × 1.5 = 180 px; the bodice is 171 px wide.
    const r = easeRatio(dressMask({ hipHalf: 85 }), KP);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0.9);
    expect(r!).toBeLessThan(1.1);
  });

  it("is >1.3 for a loose trapezoid silhouette that extends past the arms", () => {
    const m = emptyMask(W, H);
    trapezoid(m, 215, 450, [215, 385], [150, 450]);
    trapezoid(m, 451, 800, [150, 450], [120, 480]);
    const r = easeRatio(m, KP)!;
    expect(r).toBeGreaterThan(1.3);
  });

  it("is conservative when a loose garment's edge is hidden behind the arms", () => {
    const m = emptyMask(W, H);
    trapezoid(m, 215, 450, [215, 385], [175, 425]); // edge coincides with the wrists (x=175/425)
    trapezoid(m, 451, 800, [175, 425], [170, 430]);
    const r = easeRatio(m, KP)!;
    expect(r).toBeGreaterThan(1.0);
    expect(r).toBeLessThan(1.3);
  });

  it("does not count sleeves of arms hanging next to the hips", () => {
    const clingy = dressMask({ hipHalf: 85 });
    // Arms hang right next to the hips; widen the sleeves so they touch the dress.
    const kp = person({ leftWrist: k(400, 540), rightWrist: k(200, 540), leftElbow: k(405, 380), rightElbow: k(195, 380) });
    const m = dressMask({ hipHalf: 85 });
    sleeve(m, leftArm(kp), 400, 20);
    sleeve(m, rightArm(kp), 400, 20);
    const base = easeRatio(clingy, kp)!;
    const withSleeves = easeRatio(m, kp)!;
    expect(withSleeves).toBeLessThan(base + 0.15);
  });

  it("returns null without a garment at the hips", () => {
    expect(easeRatio(emptyMask(W, H), KP)).toBeNull();
  });
});

describe("maskIoU & mask utilities", () => {
  it("IoU is 1 for identical, 0 for disjoint and 1/3 for half-overlapping squares", () => {
    const a = boxMask(100, 100, { x0: 0, y0: 0, x1: 40, y1: 40 });
    const b = boxMask(100, 100, { x0: 20, y0: 0, x1: 60, y1: 40 });
    const c = boxMask(100, 100, { x0: 60, y0: 60, x1: 90, y1: 90 });
    expect(maskIoU(a, a)).toBe(1);
    expect(maskIoU(a, c)).toBe(0);
    expect(maskIoU(a, b)).toBeCloseTo(1 / 3, 9);
  });

  it("IoU of two empty masks is 0 (no silhouette, no leakage signal)", () => {
    expect(maskIoU(emptyMask(10, 10), emptyMask(10, 10))).toBe(0);
  });

  it("IoU resamples masks of different sizes", () => {
    const a = boxMask(100, 100, { x0: 0, y0: 0, x1: 50, y1: 100 });
    const b = boxMask(50, 50, { x0: 0, y0: 0, x1: 25, y1: 50 });
    expect(maskIoU(a, b)).toBeCloseTo(1, 9);
  });

  it("resampleNearest upsamples a category mask without drift", () => {
    // 2×2 → 4×4: each source pixel becomes a 2×2 block.
    const src = new Uint8Array([0, 4, 2, 5]);
    const out = resampleNearest(src, 2, 2, 4, 4);
    expect(Array.from(out)).toEqual([0, 0, 4, 4, 0, 0, 4, 4, 2, 2, 5, 5, 2, 2, 5, 5]);
    // 256×256 → 600×1000 keeps the category set and the proportions.
    const big = new Uint8Array(256 * 256);
    for (let y = 0; y < 256; y++) for (let x = 128; x < 256; x++) big[y * 256 + x] = 4;
    const up = resampleNearest(big, 256, 256, 600, 1000);
    expect(up[0]).toBe(0);
    expect(up[599]).toBe(4);
    expect(up[999 * 600 + 299]).toBe(0);
    expect(up[999 * 600 + 300]).toBe(4);
  });

  it("coverage, bbox and row runs behave on rectangles", () => {
    const m = boxMask(100, 100, { x0: 10, y0: 20, x1: 30, y1: 60 });
    expect(maskCoverageInBox(m, { x0: 10, y0: 20, x1: 30, y1: 60 })).toBe(1);
    expect(maskCoverageInBox(m, { x0: 10, y0: 20, x1: 50, y1: 60 })).toBeCloseTo(0.5, 9);
    expect(maskCoverageInBox(m, { x0: 0, y0: 0, x1: 0, y1: 0 })).toBe(0);
    expect(maskBBox(m)).toEqual({ x0: 10, y0: 20, x1: 30, y1: 60 });
    expect(maskBBox(emptyMask(5, 5))).toBeNull();
    expect(rowRun(m, 30, 15)).toEqual({ x0: 10, x1: 29 });
    expect(rowRun(m, 30, 40)).toBeNull();
    expect(rowRun(m, 30, 40, { seekRadius: 15 })).toEqual({ x0: 10, x1: 29 });
  });

  it("scaleKeypoints scales positions and keeps visibility", () => {
    const s = scaleKeypoints(KP, 0.5);
    expect(s.nose).toEqual({ x: 150, y: 60, visibility: 0.99 });
  });
});

describe("refineMaskByColour", () => {
  it("separates the worn garment from differently coloured clothing below it", () => {
    // Mustard top over navy trousers: the clothes class covers both.
    const w = 20;
    const h = 20;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const mustard = hexToRgb("#C9A227");
    const darker = mustard.map((c) => Math.round(c * 0.8)); // same fabric in shadow
    const navy = hexToRgb("#1F2A44");
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = y < 8 ? mustard : y < 10 ? darker : navy;
        const p = (y * w + x) * 4;
        rgba.set([c[0], c[1], c[2], 255], p);
      }
    const clothes = boxMask(w, h, { x0: 0, y0: 0, x1: w, y1: h });
    const refined = refineMaskByColour(rgba, clothes, hexToLab("#C9A227"));
    expect(maskBBox(refined)).toEqual({ x0: 0, y0: 0, x1: w, y1: 10 });
  });
});
