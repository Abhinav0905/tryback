// Pure body/garment geometry on segmentation masks + pose keypoints.
// No DOM, no Node APIs: runs in the browser CV pipeline and in vitest (node) with
// synthetic masks. All coordinates are pixels in the normalised photo.
//
// The core idea: the shopper is wearing the garment they are returning, and we know
// that garment's tape-measured points of measure (POM). Its high-point-shoulder → hem
// length in pixels ÷ the same length in cm gives px/cm, so other sizes / length
// variants can be drawn as measured hem lines on the real photo at zero credits.

import { deltaE76, labAt, type Lab } from "../color";
import type {
  BodyKeypoints,
  Calibration,
  Keypoint,
  Point,
  Pom,
  SizeCode,
  SizeLine,
  SizeOption,
  Sku,
} from "../types";

/** 1 = garment/clothes pixel, 0 = anything else. Row-major, length width×height. */
export interface Mask {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/* ───────────── Tunables (exported for tests / bench) ───────────── */

/** Landmarks below this visibility are treated as missing. */
export const MIN_VISIBILITY = 0.5;
/** HPS sits above the shoulder-joint line by about this fraction of shoulder width. */
export const HPS_OFFSET_OF_SHOULDER_WIDTH = 0.12;
/** A row belongs to the garment when at least this share of the leg corridor is covered. */
export const HEM_CORRIDOR_COVERAGE = 0.35;
/** Hip-length tops may end slightly above the hip landmarks: tolerance as a share of torso height. */
export const HEM_ABOVE_HIP_TOLERANCE = 0.1;
/** Nose → ankle vertical span as a share of standing height (anthropometric average). */
export const NOSE_TO_ANKLE_OF_HEIGHT = 0.87;
/**
 * BlazePose hip landmarks sit inside the body outline; the visible hip width is
 * roughly this multiple of the landmark distance. easeRatio divides by it so that
 * ~1.0 means the garment follows the body (clingy) and >1.3 means loose.
 */
export const HIP_BODY_WIDTH_FACTOR = 1.5;
/** Accepted px/cm range for any calibration. */
export const PX_PER_CM_RANGE = { min: 1, max: 40 } as const;
/** Plausible adult shoulder-landmark distance (cm) and stature (cm), for sanity checks. */
export const SHOULDER_WIDTH_CM_RANGE = { min: 22, max: 60 } as const;
export const STATURE_CM_RANGE = { min: 125, max: 225 } as const;
/** Calibration band floor/ceiling (± cm). */
export const MIN_UNCERTAINTY_CM = 1.0;
export const MAX_UNCERTAINTY_CM = 6.0;
/** Largest typical same-family hem delta (tall +6 cm plus a size step): scales anchor disagreement into the band. */
export const SLEEVE_DISAGREEMENT_REF_CM = 8;

/* ───────────── Small helpers ───────────── */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function median(values: number[]): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function isVisible(k: Keypoint | null | undefined, min = MIN_VISIBILITY): boolean {
  return !!k && Number.isFinite(k.x) && Number.isFinite(k.y) && (k.visibility ?? 0) >= min;
}

function maskAt(mask: Mask, x: number, y: number): boolean {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= mask.width || yi >= mask.height) return false;
  return mask.data[yi * mask.width + xi] !== 0;
}

/** Shoulders and hips all visible: the minimum for any torso geometry. */
export function torsoVisible(kp: BodyKeypoints, min = MIN_VISIBILITY): boolean {
  return (
    isVisible(kp.leftShoulder, min) &&
    isVisible(kp.rightShoulder, min) &&
    isVisible(kp.leftHip, min) &&
    isVisible(kp.rightHip, min)
  );
}

export function shoulderWidthPx(kp: BodyKeypoints): number {
  return dist(kp.leftShoulder, kp.rightShoulder);
}

export function hipWidthPx(kp: BodyKeypoints): number {
  return dist(kp.leftHip, kp.rightHip);
}

export function hipLineY(kp: BodyKeypoints): number {
  return (kp.leftHip.y + kp.rightHip.y) / 2;
}

export function shoulderLineY(kp: BodyKeypoints): number {
  return (kp.leftShoulder.y + kp.rightShoulder.y) / 2;
}

/** Torso centre line x: mean of shoulder and hip landmarks. */
export function torsoCenterX(kp: BodyKeypoints): number {
  return (kp.leftShoulder.x + kp.rightShoulder.x + kp.leftHip.x + kp.rightHip.x) / 4;
}

/* ───────────── Mask utilities ───────────── */

export function emptyMask(width: number, height: number): Mask {
  return { data: new Uint8Array(width * height), width, height };
}

/** Clamp a box to the image and round it to integer pixel edges (x1/y1 exclusive). */
export function clampBox(box: Box, width: number, height: number): Box {
  const x0 = clamp(Math.floor(Math.min(box.x0, box.x1)), 0, width);
  const x1 = clamp(Math.ceil(Math.max(box.x0, box.x1)), 0, width);
  const y0 = clamp(Math.floor(Math.min(box.y0, box.y1)), 0, height);
  const y1 = clamp(Math.ceil(Math.max(box.y0, box.y1)), 0, height);
  return { x0, y0, x1, y1 };
}

export function boxMask(width: number, height: number, box: Box): Mask {
  const m = emptyMask(width, height);
  const b = clampBox(box, width, height);
  for (let y = b.y0; y < b.y1; y++) m.data.fill(1, y * width + b.x0, y * width + b.x1);
  return m;
}

export function maskAnd(a: Mask, b: Mask): Mask {
  assertSameSize(a, b);
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] !== 0 && b.data[i] !== 0 ? 1 : 0;
  return { data: out, width: a.width, height: a.height };
}

export function maskOr(a: Mask, b: Mask): Mask {
  assertSameSize(a, b);
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] !== 0 || b.data[i] !== 0 ? 1 : 0;
  return { data: out, width: a.width, height: a.height };
}

function assertSameSize(a: Mask, b: Mask): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Mask size mismatch: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
}

/** Number of set pixels. */
export function maskCount(mask: Mask): number {
  let n = 0;
  const d = mask.data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) n++;
  return n;
}

/** Fraction (0..1) of the whole image covered by the mask. */
export function maskFraction(mask: Mask): number {
  const total = mask.width * mask.height;
  return total > 0 ? maskCount(mask) / total : 0;
}

/** Fraction (0..1) of the box's pixels covered by the mask; 0 for an empty box. */
export function maskCoverageInBox(mask: Mask, box: Box, step = 1): number {
  const b = clampBox(box, mask.width, mask.height);
  const s = Math.max(1, Math.floor(step));
  let hit = 0;
  let total = 0;
  for (let y = b.y0; y < b.y1; y += s) {
    const row = y * mask.width;
    for (let x = b.x0; x < b.x1; x += s) {
      total++;
      if (mask.data[row + x] !== 0) hit++;
    }
  }
  return total > 0 ? hit / total : 0;
}

/** Tight bounding box of set pixels (x1/y1 exclusive), or null for an empty mask. */
export function maskBBox(mask: Mask): Box | null {
  const { width: w, height: h, data } = mask;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Nearest-neighbour resample of a single-channel buffer (e.g. a 256×256 category mask)
 * to dw×dh. Pixel centres are mapped, so there is no half-pixel drift.
 */
export function resampleNearest(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (src.length < sw * sh) throw new Error("resampleNearest: source buffer too small");
  if (sw === dw && sh === dh) return src.slice(0, sw * sh);
  const out = new Uint8Array(dw * dh);
  const xs = new Int32Array(dw);
  for (let x = 0; x < dw; x++) xs[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    const srow = sy * sw;
    const drow = y * dw;
    for (let x = 0; x < dw; x++) out[drow + x] = src[srow + xs[x]];
  }
  return out;
}

/** Resample a mask to new dimensions (nearest neighbour). */
export function resizeMask(mask: Mask, width: number, height: number): Mask {
  return { data: resampleNearest(mask.data, mask.width, mask.height, width, height), width, height };
}

/**
 * Keep only mask pixels whose colour is close to `ref` (the worn garment's mean Lab).
 * Separates the returned garment from other clothing (trousers, a jacket) that the
 * clothes class also covers. Lightness differences are down-weighted (÷2) so folds and
 * shading on the same fabric survive.
 */
export function refineMaskByColour(
  rgba: Uint8ClampedArray,
  mask: Mask,
  ref: Lab,
  maxDistance = 20,
): Mask {
  const { width, height } = mask;
  if (rgba.length < width * height * 4) throw new Error("refineMaskByColour: rgba too small");
  const out = new Uint8Array(width * height);
  const ref2: Lab = [ref[0] / 2, ref[1], ref[2]];
  for (let i = 0; i < out.length; i++) {
    if (mask.data[i] === 0) continue;
    const lab = labAt(rgba, i * 4);
    if (deltaE76([lab[0] / 2, lab[1], lab[2]], ref2) <= maxDistance) out[i] = 1;
  }
  return { data: out, width, height };
}

/** Scale keypoints, e.g. from the photo's pixel space into a smaller analysis canvas. */
export function scaleKeypoints(kp: BodyKeypoints, sx: number, sy: number = sx): BodyKeypoints {
  const out = {} as BodyKeypoints;
  for (const key of Object.keys(kp) as (keyof BodyKeypoints)[]) {
    const k = kp[key];
    out[key] = { x: k.x * sx, y: k.y * sy, visibility: k.visibility };
  }
  return out;
}

/**
 * The contiguous run of set pixels on row `y` that contains (or is nearest to) `cx`,
 * searched within [xMin, xMax]. Gaps up to `maxGap` px are bridged (mask noise).
 */
export function rowRun(
  mask: Mask,
  y: number,
  cx: number,
  opts: { xMin?: number; xMax?: number; maxGap?: number; seekRadius?: number } = {},
): { x0: number; x1: number } | null {
  const yi = Math.round(y);
  if (yi < 0 || yi >= mask.height) return null;
  const xMin = clamp(Math.floor(opts.xMin ?? 0), 0, mask.width - 1);
  const xMax = clamp(Math.ceil(opts.xMax ?? mask.width - 1), 0, mask.width - 1);
  const maxGap = Math.max(0, Math.floor(opts.maxGap ?? 2));
  const seek = Math.max(0, Math.floor(opts.seekRadius ?? 0));
  const row = yi * mask.width;
  const at = (x: number) => mask.data[row + x] !== 0;

  let start = clamp(Math.round(cx), xMin, xMax);
  if (!at(start)) {
    let found = -1;
    for (let d = 1; d <= seek; d++) {
      if (start - d >= xMin && at(start - d)) {
        found = start - d;
        break;
      }
      if (start + d <= xMax && at(start + d)) {
        found = start + d;
        break;
      }
    }
    if (found < 0) return null;
    start = found;
  }
  let x0 = start;
  let gap = 0;
  for (let x = start - 1; x >= xMin; x--) {
    if (at(x)) {
      x0 = x;
      gap = 0;
    } else if (++gap > maxGap) break;
  }
  let x1 = start;
  gap = 0;
  for (let x = start + 1; x <= xMax; x++) {
    if (at(x)) {
      x1 = x;
      gap = 0;
    } else if (++gap > maxGap) break;
  }
  return { x0, x1 };
}

/* ───────────── Body landmarks → garment geometry ───────────── */

/** Axis-aligned box spanning the shoulder and hip landmarks. */
export function torsoBox(kp: BodyKeypoints): { x0: number; y0: number; x1: number; y1: number } {
  const xs = [kp.leftShoulder.x, kp.rightShoulder.x, kp.leftHip.x, kp.rightHip.x];
  return {
    x0: Math.min(...xs),
    y0: Math.min(kp.leftShoulder.y, kp.rightShoulder.y),
    x1: Math.max(...xs),
    y1: Math.max(kp.leftHip.y, kp.rightHip.y),
  };
}

/** Upper half of the torso box (shoulders → mid-torso): where folded arms would block the garment. */
export function upperTorsoBox(kp: BodyKeypoints): Box {
  const b = torsoBox(kp);
  return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y0 + (b.y1 - b.y0) / 2 };
}

/** High-point-shoulder y: the shoulder-joint line raised by ~0.12 × shoulder width. */
export function highPointShoulderY(kp: BodyKeypoints): number {
  return shoulderLineY(kp) - HPS_OFFSET_OF_SHOULDER_WIDTH * shoulderWidthPx(kp);
}

/**
 * Lowest garment row in the leg corridor (between the hip landmarks), scanning down
 * from hip level. A row counts when ≥35% of the corridor is garment; the scan follows
 * the contiguous run from the hips (bridging ~1% of image height of noise), so shoes or
 * clutter near the feet can't be mistaken for the hem. Null when the garment does not
 * reach hip level or the hips aren't visible.
 */
export function findHemY(mask: Mask, kp: BodyKeypoints): number | null {
  if (!torsoVisible(kp)) return null;
  const { width: W, height: H } = mask;
  const lh = kp.leftHip;
  const rh = kp.rightHip;
  const hipY = hipLineY(kp);
  const torsoH = hipY - shoulderLineY(kp);
  if (!(torsoH > 0)) return null;

  const x0 = clamp(Math.round(Math.min(lh.x, rh.x)), 0, W - 1);
  const x1 = clamp(Math.round(Math.max(lh.x, rh.x)), 0, W - 1);
  if (x1 - x0 < 2) return null;
  const xStep = Math.max(1, Math.floor((x1 - x0) / 64));

  if (hipY >= H) return null; // hips below the frame
  const startY = clamp(Math.round(hipY - HEM_ABOVE_HIP_TOLERANCE * torsoH), 0, H - 1);
  const maxGap = Math.max(2, Math.round(H * 0.01));

  let last: number | null = null;
  let gap = 0;
  for (let y = startY; y < H; y++) {
    const row = y * W;
    let hit = 0;
    let n = 0;
    for (let x = x0; x <= x1; x += xStep) {
      n++;
      if (mask.data[row + x] !== 0) hit++;
    }
    if (hit / n >= HEM_CORRIDOR_COVERAGE) {
      last = y;
      gap = 0;
    } else if (++gap > maxGap) {
      break;
    }
  }
  return last;
}

interface SleeveEnd {
  point: Point;
  /** Path length (px) from the shoulder landmark along shoulder→elbow→wrist to the end. */
  lengthPx: number;
}

/** Walks the arm chain; returns the sleeve end and its path length, or null. */
export function sleeveEndDetail(mask: Mask, kp: BodyKeypoints, side: "left" | "right"): SleeveEnd | null {
  const s = side === "left" ? kp.leftShoulder : kp.rightShoulder;
  const e = side === "left" ? kp.leftElbow : kp.rightElbow;
  const w = side === "left" ? kp.leftWrist : kp.rightWrist;
  if (!isVisible(s) || !isVisible(e) || !isVisible(w)) return null;
  if (!isVisible(kp.leftShoulder) || !isVisible(kp.rightShoulder)) return null;
  const shoulderW = shoulderWidthPx(kp);
  if (shoulderW < 4) return null;

  // Chain: shoulder → elbow → wrist → past the wrist (cuffs can reach onto the hand).
  const ext: Point = { x: w.x + (w.x - e.x) * 0.3, y: w.y + (w.y - e.y) * 0.3 };
  const pts: Point[] = [s, e, w, ext];
  const segLen = [dist(s, e), dist(e, w), dist(w, ext)];
  const total = segLen[0] + segLen[1] + segLen[2];
  const upper = segLen[0];
  if (upper < 3 || total < 6) return null;

  const pointAt = (d: number): { p: Point; dir: Point } => {
    let rem = clamp(d, 0, total);
    for (let i = 0; i < 3; i++) {
      const L = segLen[i];
      if (rem <= L || i === 2) {
        const a = pts[i];
        const b = pts[i + 1];
        const t = L > 0 ? rem / L : 0;
        const dir = L > 0 ? { x: (b.x - a.x) / L, y: (b.y - a.y) / L } : { x: 0, y: 1 };
        return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir };
      }
      rem -= L;
    }
    return { p: ext, dir: { x: 0, y: 1 } };
  };

  // Sample across the arm (perpendicular strip inside the arm's width).
  const halfW = Math.max(1.5, 0.09 * shoulderW);
  const step = Math.max(1, total / 180);
  const maxGap = 0.04 * total + 2;
  let lastCovered = -1;
  let gapLen = 0;
  for (let d = 0; d <= total + 1e-9; d += step) {
    const { p, dir } = pointAt(d);
    const nx = -dir.y;
    const ny = dir.x;
    let hit = 0;
    for (let k = -2; k <= 2; k++) {
      const o = (k / 2) * halfW;
      if (maskAt(mask, p.x + nx * o, p.y + ny * o)) hit++;
    }
    if (hit >= 3) {
      lastCovered = d;
      gapLen = 0;
    } else {
      if (lastCovered < 0 && d > 0.25 * upper) break; // never covered near the shoulder: sleeveless
      gapLen += step;
      if (lastCovered >= 0 && gapLen > maxGap) break;
    }
  }
  if (lastCovered < 0.12 * upper) return null; // only strap/bodice at the shoulder
  if (lastCovered >= total - 1.5 * step) return null; // covered past the hand: end not observable
  return { point: pointAt(lastCovered).p, lengthPx: lastCovered };
}

/** Where the sleeve ends along shoulder→elbow→wrist, or null (sleeveless / not visible). */
export function findSleeveEnd(mask: Mask, kp: BodyKeypoints, side: "left" | "right"): Point | null {
  return sleeveEndDetail(mask, kp, side)?.point ?? null;
}

/** Half-width of the garment just above the hem, centred on the torso line. */
function hemHalfWidth(mask: Mask, kp: BodyKeypoints, hemY: number): number {
  const cx = torsoCenterX(kp);
  const hipW = hipWidthPx(kp);
  const ys = [0.01, 0.02, 0.035].map((f) => hemY - Math.max(2, f * mask.height));
  const widths: number[] = [];
  for (const y of ys) {
    const run = rowRun(mask, y, cx, { maxGap: 3, seekRadius: Math.round(hipW * 0.3) });
    if (run) widths.push((run.x1 - run.x0 + 1) / 2);
  }
  return median(widths) ?? hipW * HIP_BODY_WIDTH_FACTOR * 0.6;
}

/** A "hem" on the last rows of the image is just where the frame cuts the garment off. */
export function hemAtFrameEdge(hemY: number, imageHeight: number): boolean {
  return hemY >= imageHeight - 1 - Math.max(2, Math.round(imageHeight * 0.003));
}

/** Sanity checks that a px/cm scale fits an adult body in the photo. */
function scaleFitsBody(kp: BodyKeypoints, pxPerCm: number): boolean {
  if (!(pxPerCm >= PX_PER_CM_RANGE.min && pxPerCm <= PX_PER_CM_RANGE.max)) return false;
  const shoulderCm = shoulderWidthPx(kp) / pxPerCm;
  if (shoulderCm < SHOULDER_WIDTH_CM_RANGE.min || shoulderCm > SHOULDER_WIDTH_CM_RANGE.max) return false;
  const span = noseToAnklePx(kp);
  if (span !== null) {
    const stature = span / pxPerCm / NOSE_TO_ANKLE_OF_HEIGHT;
    if (stature < STATURE_CM_RANGE.min || stature > STATURE_CM_RANGE.max) return false;
  }
  return true;
}

/** Vertical nose → ankle span (px) when the nose and at least one ankle are visible. */
export function noseToAnklePx(kp: BodyKeypoints): number | null {
  if (!isVisible(kp.nose)) return null;
  const ankles = [kp.leftAnkle, kp.rightAnkle].filter((k) => isVisible(k));
  if (ankles.length === 0) return null;
  const ankleY = ankles.reduce((s, k) => s + k.y, 0) / ankles.length;
  const span = ankleY - kp.nose.y;
  return span > 0 ? span : null;
}

/** Both sides' sleeve ends, reduced to the most trustworthy one relative to the expected length. */
function bestSleeve(mask: Mask, kp: BodyKeypoints, pxPerCm: number, expectedCm: number | null) {
  const ends = (["left", "right"] as const)
    .map((side) => sleeveEndDetail(mask, kp, side))
    .filter((e): e is SleeveEnd => e !== null)
    .map((e) => ({ ...e, cm: e.lengthPx / pxPerCm }));
  if (ends.length === 0) return null;
  if (expectedCm === null) return { point: ends[0].point, cm: ends[0].cm };
  if (ends.length === 2 && Math.abs(ends[0].cm - ends[1].cm) <= 0.15 * expectedCm) {
    const closer = Math.abs(ends[0].cm - expectedCm) <= Math.abs(ends[1].cm - expectedCm) ? ends[0] : ends[1];
    return { point: closer.point, cm: (ends[0].cm + ends[1].cm) / 2 };
  }
  ends.sort((a, b) => Math.abs(a.cm - expectedCm) - Math.abs(b.cm - expectedCm));
  return { point: ends[0].point, cm: ends[0].cm };
}

/**
 * Garment-as-ruler calibration: px/cm = (observed hem y − HPS y) ÷ POM HPS→hem.
 * When the garment has sleeves and a sleeve end is visible, its implied length is a
 * second, independent anchor: agreement keeps the band tight (≥1 cm), disagreement
 * widens it. Null when the geometry is implausible (hem above the hips, px/cm outside
 * 1..40, body proportions that don't fit an adult, low keypoint visibility).
 */
export function calibrateFromGarment(
  kp: BodyKeypoints,
  mask: Mask,
  purchasedSize: SizeCode,
  pom: Pom,
): Calibration | null {
  if (!torsoVisible(kp)) return null;
  if (!(pom.hpsToHemCm > 0)) return null;
  const hpsY = highPointShoulderY(kp);
  const hipY = hipLineY(kp);
  const torsoH = hipY - shoulderLineY(kp);
  if (!(torsoH > 0)) return null;

  const hemY = findHemY(mask, kp);
  if (hemY === null) return null;
  if (hemY < hipY - HEM_ABOVE_HIP_TOLERANCE * torsoH) return null; // hem above the hips
  if (hemAtFrameEdge(hemY, mask.height)) return null; // garment runs out of frame: hem not observed
  const spanPx = hemY - hpsY;
  if (!(spanPx > 0)) return null;
  const pxPerCm = spanPx / pom.hpsToHemCm;
  if (!scaleFitsBody(kp, pxPerCm)) return null;

  let sleeveTermCm = 1.5; // no second anchor: a little wider than the floor
  let observedSleeveEnd: Point | null = null;
  if (pom.sleeveCm !== null && pom.sleeveCm > 0) {
    const sleeve = bestSleeve(mask, kp, pxPerCm, pom.sleeveCm);
    if (sleeve) {
      observedSleeveEnd = sleeve.point;
      // Relative scale disagreement between the two anchors. A projected line moves by
      // |Δhem| × that error, and same-family deltas reach ~8 cm, so widen by 8 cm × rel.
      // Past 40% the sleeve reading itself is unreliable (pushed-up sleeves, bent arms).
      const rel = Math.abs(sleeve.cm - pom.sleeveCm) / pom.sleeveCm;
      sleeveTermCm = MIN_UNCERTAINTY_CM + SLEEVE_DISAGREEMENT_REF_CM * Math.min(rel, 0.4);
    }
  }
  // ±2 px of mask-edge quantisation, expressed in cm.
  const uncertaintyCm = clamp(
    Math.max(MIN_UNCERTAINTY_CM, sleeveTermCm) + 2 / pxPerCm,
    MIN_UNCERTAINTY_CM,
    MAX_UNCERTAINTY_CM,
  );

  return {
    method: "garment",
    pxPerCm,
    uncertaintyCm,
    hpsY,
    observedHemY: hemY,
    observedSleeveEnd,
    centerX: torsoCenterX(kp),
    hemHalfWidthPx: hemHalfWidth(mask, kp, hemY),
    purchasedSize,
    purchasedPom: pom,
    imageWidth: mask.width,
    imageHeight: mask.height,
  };
}

/**
 * Fallback: px/cm from the shopper's stated height (nose → ankle ≈ 0.87 × height).
 * Still needs the worn garment's hem to anchor the lines; null when it isn't found.
 */
export function calibrateFromHeight(
  kp: BodyKeypoints,
  mask: Mask,
  heightCm: number,
  purchasedSize: SizeCode,
  pom: Pom,
): Calibration | null {
  if (!(heightCm >= STATURE_CM_RANGE.min && heightCm <= STATURE_CM_RANGE.max)) return null;
  if (!torsoVisible(kp)) return null;
  const span = noseToAnklePx(kp);
  if (span === null) return null;
  const pxPerCm = span / (NOSE_TO_ANKLE_OF_HEIGHT * heightCm);
  if (!(pxPerCm >= PX_PER_CM_RANGE.min && pxPerCm <= PX_PER_CM_RANGE.max)) return null;
  const shoulderCm = shoulderWidthPx(kp) / pxPerCm;
  if (shoulderCm < SHOULDER_WIDTH_CM_RANGE.min || shoulderCm > SHOULDER_WIDTH_CM_RANGE.max) return null;

  const hpsY = highPointShoulderY(kp);
  const hipY = hipLineY(kp);
  const torsoH = hipY - shoulderLineY(kp);
  if (!(torsoH > 0)) return null;
  const hemY = findHemY(mask, kp);
  if (hemY === null || hemY < hipY - HEM_ABOVE_HIP_TOLERANCE * torsoH || hemY <= hpsY) return null;
  if (hemAtFrameEdge(hemY, mask.height)) return null;

  const observedHemCm = (hemY - hpsY) / pxPerCm;
  const sleeve = bestSleeve(mask, kp, pxPerCm, pom.sleeveCm);
  // Body proportions vary ~3% between people; that error scales with the measured length.
  const uncertaintyCm = clamp(
    Math.max(2, 0.03 * observedHemCm) + 2 / pxPerCm,
    MIN_UNCERTAINTY_CM,
    MAX_UNCERTAINTY_CM,
  );

  return {
    method: "height",
    pxPerCm,
    uncertaintyCm,
    hpsY,
    observedHemY: hemY,
    observedSleeveEnd: sleeve?.point ?? null,
    centerX: torsoCenterX(kp),
    hemHalfWidthPx: hemHalfWidth(mask, kp, hemY),
    purchasedSize,
    purchasedPom: pom,
    imageWidth: mask.width,
    imageHeight: mask.height,
  };
}

/* ───────────── Size lines ───────────── */

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "+1.5 cm", "−5 cm", "±0 cm" (true minus sign, one decimal only when needed). */
export function formatDeltaCm(delta: number): string {
  const r = Math.round(delta * 10) / 10;
  if (Math.abs(r) < 0.05) return "±0 cm";
  const abs = Math.abs(r);
  const num = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1);
  return `${r > 0 ? "+" : "−"}${num} cm`;
}

/**
 * Projects each size/length option as a hem line on the photo: observed hem +
 * Δhem × px/cm, with a ± band from the calibration uncertainty. Preserves option order.
 * Labels read like "L Regular · +1.5 cm".
 */
export function projectSizeLines(cal: Calibration, options: SizeOption[], skus: Sku[]): SizeLine[] {
  const byId = new Map(skus.map((s) => [s.id, s]));
  const lines: SizeLine[] = [];
  for (const o of options) {
    const sku = byId.get(o.skuId);
    let delta = o.deltaHemCm;
    if (!Number.isFinite(delta)) {
      if (!sku) continue;
      delta = sku.poms[o.size].hpsToHemCm - cal.purchasedPom.hpsToHemCm;
    }
    const variant = sku?.lengthVariant ?? o.lengthVariant;
    lines.push({
      skuId: o.skuId,
      size: o.size,
      lengthVariant: variant,
      hemY: cal.observedHemY + delta * cal.pxPerCm,
      bandPx: cal.uncertaintyCm * cal.pxPerCm,
      deltaHemCm: delta,
      label: `${o.size} ${capitalise(variant)} · ${formatDeltaCm(delta)}`,
    });
  }
  return lines;
}

/* ───────────── Ease & overlap ───────────── */

/**
 * Garment width at hip level ÷ body hip width, where body hip width is estimated as
 * the hip-landmark distance × HIP_BODY_WIDTH_FACTOR. ~1.0 = follows the body (clingy),
 * >1.3 = loose. Median over a few rows around the hip line. When the garment run ends
 * at an arm hanging beside the hips (a sleeve merging with the body of the garment),
 * that side is cut at the arm's inner edge — conservative, so sleeves never read as
 * "loose". A garment that clearly extends past the arm keeps its full width.
 * Null when it can't be measured.
 */
export function easeRatio(mask: Mask, kp: BodyKeypoints): number | null {
  if (!torsoVisible(kp)) return null;
  const hipDist = hipWidthPx(kp);
  if (hipDist < 4) return null;
  const hipY = hipLineY(kp);
  const torsoH = hipY - shoulderLineY(kp);
  if (!(torsoH > 0)) return null;
  const cx = (kp.leftHip.x + kp.rightHip.x) / 2;
  const bodyHalf = (hipDist * HIP_BODY_WIDTH_FACTOR) / 2;
  const armHalf = 0.1 * shoulderWidthPx(kp);
  const armBand = 1.3 * armHalf;

  const widths: number[] = [];
  for (const f of [-0.06, -0.03, 0, 0.03, 0.06]) {
    const y = hipY + f * torsoH;
    const run = rowRun(mask, y, cx, {
      xMin: cx - 1.8 * bodyHalf,
      xMax: cx + 1.8 * bodyHalf,
      maxGap: Math.max(2, Math.round(hipDist * 0.03)),
      seekRadius: Math.round(hipDist * 0.25),
    });
    if (!run) continue;
    let { x0, x1 } = run;
    for (const [e, w] of [
      [kp.leftElbow, kp.leftWrist],
      [kp.rightElbow, kp.rightWrist],
    ] as const) {
      const ax = armXAtRow(e, w, y);
      if (ax === null || Math.abs(ax - cx) < bodyHalf * 0.5) continue; // arm in front of the torso
      if (ax > cx && Math.abs(x1 - ax) <= armBand) x1 = Math.max(cx, ax - armHalf);
      else if (ax < cx && Math.abs(x0 - ax) <= armBand) x0 = Math.min(cx, ax + armHalf);
    }
    widths.push(x1 - x0 + 1);
  }
  const w = median(widths);
  if (w === null || widths.length < 3) return null;
  return w / (hipDist * HIP_BODY_WIDTH_FACTOR);
}

/** x of the forearm (elbow→wrist) at row y, if that segment spans the row and is visible. */
function armXAtRow(e: Keypoint, w: Keypoint, y: number): number | null {
  if (!isVisible(e) || !isVisible(w)) return null;
  const lo = Math.min(e.y, w.y);
  const hi = Math.max(e.y, w.y);
  const pad = (hi - lo) * 0.15;
  if (y < lo - pad || y > hi + pad) return null;
  if (hi - lo < 1) return (e.x + w.x) / 2;
  const t = clamp((y - e.y) / (w.y - e.y), 0, 1.15);
  return e.x + (w.x - e.x) * t;
}

/** Intersection over union of two masks (b is resampled to a's size if needed). 0 when both are empty. */
export function maskIoU(a: Mask, b: Mask): number {
  const bd = a.width === b.width && a.height === b.height ? b.data : resampleNearest(b.data, b.width, b.height, a.width, a.height);
  const ad = a.data;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < ad.length; i++) {
    const x = ad[i] !== 0;
    const y = bd[i] !== 0;
    if (x || y) {
      union++;
      if (x && y) inter++;
    }
  }
  return union > 0 ? inter / union : 0;
}

/** Midpoint helper re-exported for overlays (shoulder/hip centres). */
export function midpoint(a: Point, b: Point): Point {
  return mid(a, b);
}
