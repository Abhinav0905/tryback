// Source-aware fidelity gate (browser). Compares a try-on render with the shopper's
// original photo and decides whether to show it, retry it, badge it, or hide it.
// Runs on-device: the photo never leaves the browser for this step.
//
// Both images are analysed at the original photo's aspect, scaled so the longest side
// is ≤640 px (the render is drawn at those dimensions, i.e. resized to the original's
// frame). Keypoints and calibration are mapped into the same space, so every metric
// matches what it would be at full resolution, at a fraction of the cost (<1.5 s warm).

import { deltaE2000, hexToLab, labAt, meanLabMasked, type Lab } from "../color";
import type { GateMetrics, GateResult, PhotoMeasurements, SizeCode, Sku, TransitionType } from "../types";
import { GATE_BADGES, MAX_GATE_REASON_CHARS, decideGate, emptyGateMetrics } from "./gateMath";
import {
  boxMask,
  clampBox,
  findHemY,
  hipLineY,
  isVisible,
  maskAnd,
  maskBBox,
  maskCoverageInBox,
  maskIoU,
  maskOr,
  scaleKeypoints,
  shoulderWidthPx,
  torsoBox,
  torsoVisible,
  type Box,
  type Mask,
} from "./geometry";
import { canvasRgba, fitWithin, imageToCanvas, imageToCanvasCover, loadImage } from "./image";
import { wornGarmentMask } from "./preflight";
import { segmentParts } from "./segment";

export interface GateInput {
  originalUrl: string;
  renderUrl: string;
  measurements: PhotoMeasurements;
  sourceSku: Sku;
  targetSku: Sku;
  targetSize: SizeCode;
  transition: TransitionType;
  canRetry: boolean;
}

/** Longest side of the analysis canvases. */
export const GATE_ANALYSIS_MAX_SIDE = 640;
/** Colour change between source and target (ΔE00) above which residue is measured. */
export const COLOUR_CHANGE_DELTA_E = 20;
/** Residue: a rendered pixel this close (ΔE00) to the returned garment's colour is "old garment". */
export const RESIDUE_PIXEL_DELTA_E = 10;
/** Lighting offset clamp (per Lab channel). */
export const LIGHTING_OFFSET_CLAMP = 25;
/** Whole-gate time budget, including a cold model load. */
export const GATE_TIMEOUT_MS = 20_000;
/** Render vs photo aspect difference (relative) above which the render is centre-cropped, not stretched. */
export const ASPECT_TOLERANCE = 0.02;

const SAMPLE_STEP = 2;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(n: number | null, dp: number): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Target colour as it should look under the photo's lighting. */
export function expectedRenderLab(target: Lab, source: Lab, observed: Lab | null): Lab {
  if (!observed) return target;
  const off = [0, 1, 2].map((i) => clamp(observed[i] - source[i], -LIGHTING_OFFSET_CLAMP, LIGHTING_OFFSET_CLAMP));
  return [clamp(target[0] + off[0], 0, 100), target[1] + off[1], target[2] + off[2]];
}

/** Share of sampled `region` pixels within ΔE00 < threshold of `ref`; null if too few samples. */
export function fractionNear(
  rgba: Uint8ClampedArray,
  region: Mask,
  ref: Lab,
  threshold = RESIDUE_PIXEL_DELTA_E,
  step = SAMPLE_STEP,
  minSamples = 30,
): number | null {
  const { width: w, height: h, data } = region;
  let n = 0;
  let hit = 0;
  for (let y = 0; y < h; y += step) {
    const row = y * w;
    for (let x = 0; x < w; x += step) {
      const i = row + x;
      if (data[i] === 0) continue;
      n++;
      if (deltaE2000(labAt(rgba, i * 4), ref) < threshold) hit++;
    }
  }
  return n >= minSamples ? hit / n : null;
}

/** Mean |gray(a) − gray(b)| / 255 inside `box`. */
export function meanAbsGrayDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, box: Box, step = 1): number | null {
  let n = 0;
  let s = 0;
  for (let y = box.y0; y < box.y1; y += step) {
    for (let x = box.x0; x < box.x1; x += step) {
      const p = (y * width + x) * 4;
      const ga = 0.2126 * a[p] + 0.7152 * a[p + 1] + 0.0722 * a[p + 2];
      const gb = 0.2126 * b[p] + 0.7152 * b[p + 1] + 0.0722 * b[p + 2];
      s += Math.abs(ga - gb);
      n++;
    }
  }
  return n > 0 ? s / n / 255 : null;
}

function padBox(b: Box, frac: number, w: number, h: number): Box {
  const px = (b.x1 - b.x0) * frac;
  const py = (b.y1 - b.y0) * frac;
  return clampBox({ x0: b.x0 - px, y0: b.y0 - py, x1: b.x1 + px, y1: b.y1 + py }, w, h);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

/** Minimum clothes-mask size (in the ≤640 px analysis frame) before IoU means anything. */
const MIN_IOU_MASK_PIXELS = 200;
const MIN_IOU_MASK_FRACTION = 0.005;

function maskPixelCount(mask: Mask): number {
  let n = 0;
  const d = mask.data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) n++;
  return n;
}

/** Intermediate values behind one gate run (dev gate lab / threshold tuning only). */
export interface GateDebug {
  /** Analysis frame (the original photo fitted within GATE_ANALYSIS_MAX_SIDE). */
  width: number;
  height: number;
  original: { width: number; height: number };
  render: { width: number; height: number };
  /** False when the render's aspect differed by >2% and it was centre-cropped. */
  sameAspect: boolean;
  hasPose: boolean;
  torso: Box | null;
  /** Face box the identity diff was measured in (padded), or null. */
  faceBox: Box | null;
  faceBoxFrom: "segmentation" | "keypoints" | null;
  sourceLab: Lab;
  targetLab: Lab;
  observedLab: Lab | null;
  observedFrom: "measurements" | "photo" | null;
  renderLab: Lab | null;
  /** True when the torso ∩ clothes sample was too small and the whole clothes mask was used. */
  renderLabFromWholeMask: boolean;
  expectedLab: Lab | null;
  origGarmentPx: number;
  renderGarmentPx: number;
  minIouMaskPx: number;
  /** Hem positions in the analysis frame (px), when calibration allowed a hem check. */
  expectedHemY: number | null;
  renderHemY: number | null;
  pxPerCm: number | null;
}

/** Gate metrics plus everything they were computed from. Same code path as runGate. */
export async function computeGateDetailed(
  input: GateInput,
): Promise<{ metrics: GateMetrics; colourChangeExpected: boolean; debug: GateDebug }> {
  const [orig, render] = await Promise.all([loadImage(input.originalUrl), loadImage(input.renderUrl)]);
  const OW = orig.naturalWidth;
  const OH = orig.naturalHeight;
  const { width: w, height: h } = fitWithin(OW, OH, GATE_ANALYSIS_MAX_SIDE);

  const origCanvas = imageToCanvas(orig, w, h);
  // Render resized to the original's frame. If the provider returned another aspect (e.g. a
  // fixed 3:4 output for a 9:16 photo, person letterboxed to fit), stretching it would squash
  // the face and skew every metric, so centre-crop it to the photo's aspect instead.
  const renderAspect = render.naturalWidth / render.naturalHeight;
  const sameAspect = Math.abs(renderAspect / (OW / OH) - 1) <= ASPECT_TOLERANCE;
  const renderCanvas = sameAspect
    ? imageToCanvas(render, w, h)
    : imageToCanvasCover(render, render.naturalWidth, render.naturalHeight, w, h);
  try {
    const origRgba = canvasRgba(origCanvas);
    const renderRgba = canvasRgba(renderCanvas);
    const origMasks = await segmentParts(origCanvas, w, h);
    const renderMasks = await segmentParts(renderCanvas, w, h);

    // Keypoints/calibration live in the uploaded photo's pixel space.
    const m = input.measurements;
    const refW = m.calibration?.imageWidth ?? OW;
    const refH = m.calibration?.imageHeight ?? OH;
    const sx = w / refW;
    const sy = h / refH;
    const kp = scaleKeypoints(m.keypoints, sx, sy);
    const hasPose = torsoVisible(kp);
    const torso: Box | null = hasPose ? clampBox(torsoBox(kp), w, h) : null;
    const torsoMask = torso ? boxMask(w, h, torso) : null;

    /* Colours */
    const sourceLab = hexToLab(input.sourceSku.colorHex);
    const targetLab = hexToLab(input.targetSku.colorHex);
    const colourChangeExpected = deltaE2000(sourceLab, targetLab) > COLOUR_CHANGE_DELTA_E;

    const origRegion = torsoMask ? maskAnd(origMasks.clothes, torsoMask) : origMasks.clothes;
    const observed: Lab | null =
      m.observedGarmentLab ?? meanLabMasked(origRgba, origRegion.data, w, h, { step: SAMPLE_STEP, minPixels: 30 });

    let renderRegion = torsoMask ? maskAnd(renderMasks.clothes, torsoMask) : renderMasks.clothes;
    let renderLab = meanLabMasked(renderRgba, renderRegion.data, w, h, { step: SAMPLE_STEP, minPixels: 30 });
    let renderLabFromWholeMask = false;
    if (!renderLab && torsoMask) {
      renderRegion = renderMasks.clothes;
      renderLab = meanLabMasked(renderRgba, renderRegion.data, w, h, { step: SAMPLE_STEP, minPixels: 30 });
      renderLabFromWholeMask = renderLab !== null;
    }
    const expectedLab = renderLab ? expectedRenderLab(targetLab, sourceLab, observed) : null;
    const colourDeltaE = renderLab && expectedLab ? deltaE2000(expectedLab, renderLab) : null;

    /* The worn / rendered garment itself: the 'clothes' class refined by each garment's colour,
       so trousers, layers or a bag (unchanged between the two images) don't push IoU toward 1. */
    const origGarmentMask = torso ? wornGarmentMask(origRgba, origMasks.clothes, torso, observed) : origMasks.clothes;
    const renderGarmentMask = torso ? wornGarmentMask(renderRgba, renderMasks.clothes, torso, renderLab) : renderMasks.clothes;

    /* Residue of the returned garment's colour (only meaningful when the colour should change) */
    let residueFraction: number | null = null;
    if (colourChangeExpected && observed) {
      const where = torsoMask ? maskOr(origGarmentMask, torsoMask) : origGarmentMask;
      residueFraction = fractionNear(renderRgba, maskAnd(renderMasks.clothes, where), observed);
    }

    /* Silhouette overlap (meaningless when either image has no clothes segmented: IoU would be 0) */
    const minMaskPx = Math.max(MIN_IOU_MASK_PIXELS, Math.round(w * h * MIN_IOU_MASK_FRACTION));
    const origGarmentPx = maskPixelCount(origGarmentMask);
    const renderGarmentPx = maskPixelCount(renderGarmentMask);
    const silhouetteIoU =
      origGarmentPx >= minMaskPx && renderGarmentPx >= minMaskPx ? maskIoU(origGarmentMask, renderGarmentMask) : null;

    /* Identity drift in the face box */
    let faceBox = maskBBox(origMasks.face);
    let faceBoxFrom: GateDebug["faceBoxFrom"] = faceBox ? "segmentation" : null;
    if (faceBox && (faceBox.x1 - faceBox.x0) * (faceBox.y1 - faceBox.y0) < 16) {
      faceBox = null;
      faceBoxFrom = null;
    }
    if (!faceBox && isVisible(kp.nose) && isVisible(kp.leftShoulder) && isVisible(kp.rightShoulder)) {
      const r = 0.22 * shoulderWidthPx(kp);
      faceBox = { x0: kp.nose.x - r, y0: kp.nose.y - 1.3 * r, x1: kp.nose.x + r, y1: kp.nose.y + r };
      faceBoxFrom = "keypoints";
    }
    const paddedFace = faceBox ? padBox(faceBox, 0.1, w, h) : null;
    const identityDiff = paddedFace ? meanAbsGrayDiff(origRgba, renderRgba, w, paddedFace) : null;

    /* Hem position vs the target's projected length */
    let hemErrorCm: number | null = null;
    let expectedHemY: number | null = null;
    let renderHemY: number | null = null;
    let hemPxPerCm: number | null = null;
    const cal = m.calibration;
    const targetPom = input.targetSku.poms[input.targetSize];
    if (cal && hasPose && torso && targetPom) {
      const pxPerCm = cal.pxPerCm * sy;
      // Anchored at the observed hem, exactly like the size overlay (projectSizeLines):
      // observed hem + (target length − purchased length). Identical to hps + target length
      // under garment calibration; under height calibration it stays consistent with the lines.
      const expectedY = (cal.observedHemY + (targetPom.hpsToHemCm - cal.purchasedPom.hpsToHemCm) * cal.pxPerCm) * sy;
      const renderHem = findHemY(renderGarmentMask, kp);
      expectedHemY = expectedY;
      renderHemY = renderHem;
      hemPxPerCm = pxPerCm;
      if (renderHem !== null) {
        const bothOffFrame = expectedY >= h - 2 && renderHem >= h - 3;
        hemErrorCm = bothOffFrame ? 0 : Math.abs(renderHem - expectedY) / pxPerCm;
      } else if (expectedY > hipLineY(kp)) {
        // Rendered garment stops above the hips but should reach below: lower bound.
        hemErrorCm = (expectedY - hipLineY(kp)) / pxPerCm;
      }
    }

    /* Coverage of the torso by the rendered garment */
    const garmentCoverage = torso ? maskCoverageInBox(renderMasks.clothes, torso, SAMPLE_STEP) : null;

    return {
      metrics: {
        colourDeltaE: round(colourDeltaE, 2),
        residueFraction: round(residueFraction, 4),
        silhouetteIoU: round(silhouetteIoU, 4),
        identityDiff: round(identityDiff, 4),
        hemErrorCm: round(hemErrorCm, 2),
        garmentCoverage: round(garmentCoverage, 4),
      },
      colourChangeExpected,
      debug: {
        width: w,
        height: h,
        original: { width: OW, height: OH },
        render: { width: render.naturalWidth, height: render.naturalHeight },
        sameAspect,
        hasPose,
        torso,
        faceBox: paddedFace,
        faceBoxFrom,
        sourceLab,
        targetLab,
        observedLab: observed,
        observedFrom: m.observedGarmentLab ? "measurements" : observed ? "photo" : null,
        renderLab,
        renderLabFromWholeMask,
        expectedLab,
        origGarmentPx,
        renderGarmentPx,
        minIouMaskPx: minMaskPx,
        expectedHemY,
        renderHemY,
        pxPerCm: hemPxPerCm,
      },
    };
  } finally {
    for (const c of [origCanvas, renderCanvas]) {
      c.width = 0;
      c.height = 0;
    }
  }
}

async function computeGate(input: GateInput): Promise<GateMetrics & { colourChangeExpected: boolean }> {
  const { metrics, colourChangeExpected } = await computeGateDetailed(input);
  return { ...metrics, colourChangeExpected };
}

/**
 * Run the fidelity gate for one render. Never throws: any internal failure returns a
 * 'badge' verdict with reason "gate_error: …" so the card still renders honestly.
 */
export async function runGate(input: GateInput): Promise<GateResult> {
  const t0 = now();
  try {
    const { colourChangeExpected, ...metrics } = await withTimeout(computeGate(input), GATE_TIMEOUT_MS);
    const decision = decideGate(metrics, {
      transition: input.transition,
      colourChangeExpected,
      canRetry: input.canRetry,
      lengthVariant: input.sourceSku.family === input.targetSku.family && input.sourceSku.id !== input.targetSku.id,
    });
    return {
      verdict: decision.verdict,
      metrics,
      reasons: decision.reasons,
      badge: decision.badge,
      ...(decision.fallbackVerdict ? { fallbackVerdict: decision.fallbackVerdict } : {}),
      computedAt: new Date().toISOString(),
      computeMs: Math.round(now() - t0),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: "badge",
      metrics: emptyGateMetrics(),
      reasons: [`gate_error: ${message}`.slice(0, MAX_GATE_REASON_CHARS)],
      badge: GATE_BADGES.unchecked,
      computedAt: new Date().toISOString(),
      computeMs: Math.round(now() - t0),
    };
  }
}
