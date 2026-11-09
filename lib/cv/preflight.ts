// Photo preflight (browser): checks the shopper photo before upload, coaches the live
// camera, and derives the measurements that power the size path and the gate.
// Everything runs on-device. No check ever comments on the shopper's body or skin —
// only framing, pose, lighting, sharpness and whether the garment is visible.
//
// The decision logic (evaluatePreflight, liveCoach, buildMeasurements, the image
// statistics) is DOM-free so it can be unit-tested in node; only runPreflight needs
// a browser (canvas + MediaPipe).

import { deltaE2000, hexToLab, luma, meanLabMasked, type Lab } from "../color";
import type {
  BodyKeypoints,
  Calibration,
  Keypoint,
  PhotoMeasurements,
  Pom,
  PreflightCheck,
  PreflightCheckId,
  PreflightResult,
  SizeCode,
} from "../types";
import {
  boxMask,
  calibrateFromGarment,
  calibrateFromHeight,
  clampBox,
  easeRatio,
  hipLineY,
  hipWidthPx,
  isVisible,
  maskAnd,
  maskBBox,
  maskCoverageInBox,
  maskFraction,
  noseToAnklePx,
  NOSE_TO_ANKLE_OF_HEIGHT,
  refineMaskByColour,
  shoulderLineY,
  shoulderWidthPx,
  torsoBox,
  torsoVisible,
  upperTorsoBox,
  type Box,
  type Mask,
} from "./geometry";
import { canvasRgba, fitWithin, imageToCanvas } from "./image";
import { detectPoseDetailed } from "./pose";
import { segmentParts, type PartsMasks } from "./segment";
import { THRESHOLDS, type PreflightThresholds } from "./thresholds";

export interface PreflightOutput {
  result: PreflightResult;
  keypoints: BodyKeypoints | null;
  masks: PartsMasks | null;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/* ───────────── Thresholds ───────────── */

/** Current preflight thresholds, from lib/cv/thresholds.json (docs/GATE-TUNING.md). */
export const PREFLIGHT_THRESHOLDS: PreflightThresholds = THRESHOLDS.preflight;

const T = PREFLIGHT_THRESHOLDS;

/* ───────────── Pure image statistics ───────────── */

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

/** Rec. 709 luma of an RGBA buffer. */
export function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const n = width * height;
  const data = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) data[i] = luma(rgba[p], rgba[p + 1], rgba[p + 2]);
  return { data, width, height };
}

export function meanLuminance(gray: GrayImage): number {
  const d = gray.data;
  if (d.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i];
  return s / d.length;
}

/** Variance of the 4-neighbour Laplacian inside `box` (whole image by default). */
export function laplacianVariance(gray: GrayImage, box?: Box): number {
  const { width: w, height: h, data: g } = gray;
  const b = box ? clampBox(box, w, h) : { x0: 0, y0: 0, x1: w, y1: h };
  const x0 = Math.max(1, b.x0);
  const y0 = Math.max(1, b.y0);
  const x1 = Math.min(w - 1, b.x1);
  const y1 = Math.min(h - 1, b.y1);
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      const i = row + x;
      const v = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      n++;
      const d = v - mean;
      mean += d / n;
      m2 += d * (v - mean);
    }
  }
  return n > 1 ? m2 / (n - 1) : 0;
}

/* ───────────── Pure check evaluation ───────────── */

export interface PreflightSignals {
  width: number;
  height: number;
  keypoints: BodyKeypoints | null;
  personCount: number;
  shoulderYawDeg: number | null;
  /** Clothes-mask coverage of the torso box, or null when segmentation was unavailable. */
  garmentCoverage: number | null;
  meanLuminance: number;
  sharpness: number;
}

function check(id: PreflightCheckId, ok: boolean, okMsg: string, failMsg: string, value?: number): PreflightCheck {
  const c: PreflightCheck = { id, ok, message: ok ? okMsg : failMsg };
  if (value !== undefined && Number.isFinite(value)) c.value = Math.round(value * 1000) / 1000;
  return c;
}

function vis(k: Keypoint): boolean {
  return isVisible(k, T.visibility);
}

function fullBodyCheck(kp: BodyKeypoints | null, W: number, H: number): PreflightCheck {
  const fail = (msg: string, v?: number) => check("full_body", false, "", msg, v);
  if (!kp) return fail("We couldn't find you in the photo — stand in the middle of the frame, head to toe.");
  const parts: Keypoint[] = [
    kp.nose,
    kp.leftShoulder,
    kp.rightShoulder,
    kp.leftHip,
    kp.rightHip,
    kp.leftKnee,
    kp.rightKnee,
    kp.leftAnkle,
    kp.rightAnkle,
  ];
  const minVis = Math.min(...parts.map((p) => p.visibility));
  const inside = (p: Keypoint) => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H;
  const feetOk =
    vis(kp.leftAnkle) &&
    vis(kp.rightAnkle) &&
    inside(kp.leftAnkle) &&
    inside(kp.rightAnkle) &&
    Math.max(kp.leftAnkle.y, kp.rightAnkle.y) <= H * T.feetBottomMargin;
  const headOk = vis(kp.nose) && inside(kp.nose) && kp.nose.y >= H * T.headTopMargin;
  const middleOk = parts.slice(1, 7).every((p) => vis(p) && inside(p));
  if (!feetOk) return fail("Step back — we need to see your feet.", minVis);
  if (!headOk) return fail("Step back or raise the camera so your whole head is in the photo.", minVis);
  if (!middleOk) return fail("Step back so we can see you from head to toe.", minVis);
  return check("full_body", true, "Head to toe in frame", "", minVis);
}

function frontalCheck(kp: BodyKeypoints | null, yawDeg: number | null): PreflightCheck {
  const failMsg = "Face the camera straight on, with your shoulders square.";
  if (!kp || !torsoVisible(kp, T.visibility)) return check("frontal", false, "", failMsg);
  const sw = shoulderWidthPx(kp);
  const hw = hipWidthPx(kp);
  const torsoH = hipLineY(kp) - shoulderLineY(kp);
  const ratio = hw > 0 ? sw / hw : Number.POSITIVE_INFINITY;
  const squareness = torsoH > 0 ? sw / torsoH : 0;
  const ratioOk = ratio >= T.shoulderHipRatio.min && ratio <= T.shoulderHipRatio.max;
  const yawOk = yawDeg === null || yawDeg <= T.maxYawDeg;
  const ok = ratioOk && squareness >= T.minShoulderToTorso && yawOk;
  return check("frontal", ok, "Shoulders square to the camera", failMsg, squareness);
}

function garmentCheck(kp: BodyKeypoints | null, coverage: number | null): PreflightCheck {
  if (coverage === null) {
    return check("garment_visible", false, "", "We couldn't check the item in this photo — please retake it.");
  }
  if (!kp) return check("garment_visible", false, "", "We couldn't find the item — wear it and stand facing the camera.", coverage);
  return check(
    "garment_visible",
    coverage >= T.minGarmentCoverage,
    "Item clearly visible",
    "We can't see the item clearly — wear it, and make sure a jacket or bag isn't covering it.",
    coverage,
  );
}

function unobstructedCheck(kp: BodyKeypoints | null): PreflightCheck {
  const failMsg = "Lower your arms to your sides so the front of the item is visible.";
  if (!kp || !torsoVisible(kp, T.visibility)) return check("torso_unobstructed", false, "", failMsg);
  const box = upperTorsoBox(kp);
  const inBox = (k: Keypoint) => vis(k) && k.x >= box.x0 && k.x <= box.x1 && k.y >= box.y0 && k.y <= box.y1;
  const n = (inBox(kp.leftWrist) ? 1 : 0) + (inBox(kp.rightWrist) ? 1 : 0);
  return check("torso_unobstructed", n < 2, "Arms clear of the item", failMsg, n);
}

function lightingCheck(lum: number): PreflightCheck {
  if (lum < T.luminance.min) {
    return check("lighting", false, "", "It's a bit dark — face a window or turn on more lights.", lum);
  }
  if (lum > T.luminance.max) {
    return check("lighting", false, "", "Too bright — move out of direct sun or away from a bright window behind you.", lum);
  }
  return check("lighting", true, "Lighting looks good", "", lum);
}

function sharpnessCheck(v: number): PreflightCheck {
  return check(
    "sharpness",
    v >= T.minSharpness,
    "Photo is sharp",
    "The photo is blurry — hold still, or prop the phone up and use the timer.",
    v,
  );
}

/** Turn measured signals into the seven shopper-facing checks. Pure. */
export function evaluatePreflight(s: PreflightSignals): PreflightResult {
  const kp = s.keypoints;
  const checks: PreflightCheck[] = [
    fullBodyCheck(kp, s.width, s.height),
    check(
      "single_person",
      s.personCount === 1,
      "One person detected",
      s.personCount === 0
        ? "We couldn't find a person — stand in the middle of the frame."
        : "Make sure you're the only person in the photo.",
      s.personCount,
    ),
    frontalCheck(kp, s.shoulderYawDeg),
    garmentCheck(kp, s.garmentCoverage),
    unobstructedCheck(kp),
    lightingCheck(s.meanLuminance),
    sharpnessCheck(s.sharpness),
  ];
  return { ok: checks.every((c) => c.ok), checks, overridden: false };
}

/** One raw value behind a preflight check, against the threshold it is compared with. */
export interface PreflightValue {
  check: PreflightCheckId;
  /** Which signal: e.g. "minVisibility", "sharpness", "luminance". */
  signal: string;
  /** The thresholds.json key(s) it is compared with, e.g. "preflight.minSharpness". */
  threshold: string;
  value: number | null;
  min: number | null;
  max: number | null;
  /** null when the value couldn't be measured. */
  ok: boolean | null;
}

/**
 * The raw value behind every preflight sub-check, each against its threshold. Pure.
 * For tuning reports: a check fails when any of its sub-values is out of range (or, for
 * the pose checks, when no person was found). Mirrors evaluatePreflight's logic.
 */
export function preflightCheckValues(s: PreflightSignals, t: PreflightThresholds = T): PreflightValue[] {
  const out: PreflightValue[] = [];
  const add = (
    check: PreflightCheckId,
    signal: string,
    threshold: string,
    value: number | null,
    min: number | null,
    max: number | null,
  ) => {
    const ok = value === null || !Number.isFinite(value) ? null : (min === null || value >= min) && (max === null || value <= max);
    out.push({ check, signal, threshold, value: value !== null && Number.isFinite(value) ? value : null, min, max, ok });
  };
  const kp = s.keypoints;
  const H = s.height;
  const visOf = (k: Keypoint) => isVisible(k, t.visibility);

  if (kp) {
    const parts = [kp.nose, kp.leftShoulder, kp.rightShoulder, kp.leftHip, kp.rightHip, kp.leftKnee, kp.rightKnee, kp.leftAnkle, kp.rightAnkle];
    add("full_body", "minVisibility (nose…ankles)", "preflight.visibility", Math.min(...parts.map((p) => p.visibility)), t.visibility, null);
    add("full_body", "noseY / height", "preflight.headTopMargin", kp.nose.y / H, t.headTopMargin, null);
    add("full_body", "lowest ankleY / height", "preflight.feetBottomMargin", Math.max(kp.leftAnkle.y, kp.rightAnkle.y) / H, null, t.feetBottomMargin);
  } else {
    add("full_body", "person found", "-", null, null, null);
  }
  add("single_person", "personCount", "-", s.personCount, 1, 1);

  if (kp && torsoVisible(kp, t.visibility)) {
    const sw = shoulderWidthPx(kp);
    const hw = hipWidthPx(kp);
    const torsoH = hipLineY(kp) - shoulderLineY(kp);
    add("frontal", "shoulderWidth / hipWidth", "preflight.shoulderHipRatio", hw > 0 ? sw / hw : null, t.shoulderHipRatio.min, t.shoulderHipRatio.max);
    add("frontal", "shoulderWidth / torsoHeight", "preflight.minShoulderToTorso", torsoH > 0 ? sw / torsoH : 0, t.minShoulderToTorso, null);
    add("frontal", "shoulder yaw (deg)", "preflight.maxYawDeg", s.shoulderYawDeg, null, t.maxYawDeg);
    const box = upperTorsoBox(kp);
    const inBox = (k: Keypoint) => visOf(k) && k.x >= box.x0 && k.x <= box.x1 && k.y >= box.y0 && k.y <= box.y1;
    add("torso_unobstructed", "wrists over upper torso", "-", (inBox(kp.leftWrist) ? 1 : 0) + (inBox(kp.rightWrist) ? 1 : 0), null, 1);
  } else {
    add("frontal", "torso visible", "preflight.visibility", null, null, null);
    add("torso_unobstructed", "torso visible", "preflight.visibility", null, null, null);
  }
  add("garment_visible", "clothes coverage of torso box", "preflight.minGarmentCoverage", kp ? s.garmentCoverage : null, t.minGarmentCoverage, null);
  add("lighting", "mean luma (0..255)", "preflight.luminance", s.meanLuminance, t.luminance.min, t.luminance.max);
  add("sharpness", "Laplacian variance (person region)", "preflight.minSharpness", s.sharpness, t.minSharpness, null);
  return out;
}

/* ───────────── Browser: run on a photo ───────────── */

function grayFromCanvas(canvas: HTMLCanvasElement): { gray: GrayImage; scale: number } {
  const fit = fitWithin(canvas.width, canvas.height, T.analysisMaxSide);
  const small = imageToCanvas(canvas, fit.width, fit.height);
  try {
    return { gray: rgbaToGray(canvasRgba(small), fit.width, fit.height), scale: fit.scale };
  } finally {
    small.width = 0;
    small.height = 0;
  }
}

/** Region used for sharpness: the person (so portrait-mode background blur doesn't fail the photo). */
function personRegion(kp: BodyKeypoints | null, masks: PartsMasks | null): Box | null {
  if (masks) {
    const bb = maskBBox(masks.person);
    if (bb && (bb.x1 - bb.x0) * (bb.y1 - bb.y0) > 0.02 * masks.person.width * masks.person.height) return bb;
  }
  if (kp) {
    const pts = Object.values(kp).filter((k) => vis(k));
    if (pts.length >= 4) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const padX = (Math.max(...xs) - Math.min(...xs)) * 0.25;
      return { x0: Math.min(...xs) - padX, y0: Math.min(...ys) - 40, x1: Math.max(...xs) + padX, y1: Math.max(...ys) + 40 };
    }
  }
  return null;
}

/**
 * Run every preflight check on the normalised photo. Pose-model failures propagate (the
 * UI shows a retry state); a segmentation failure degrades to masks:null and a failed
 * garment check rather than throwing.
 */
export async function runPreflight(img: HTMLImageElement, width: number, height: number): Promise<PreflightOutput> {
  const { signals: _signals, ...out } = await runPreflightDetailed(img, width, height);
  void _signals;
  return out;
}

/**
 * runPreflight plus the raw signals behind the seven checks (dev gate lab / threshold
 * tuning). Same code path: runPreflight is this with `signals` stripped.
 */
export async function runPreflightDetailed(
  img: HTMLImageElement,
  width: number,
  height: number,
): Promise<PreflightOutput & { signals: PreflightSignals }> {
  const W = Math.round(width);
  const H = Math.round(height);
  const canvas = imageToCanvas(img, W, H);
  try {
    const rgba = canvasRgba(canvas);
    const pose = await detectPoseDetailed(canvas, W, H);

    let masks: PartsMasks | null = null;
    try {
      masks = await segmentParts(canvas, W, H);
    } catch (err) {
      console.warn("[TryBack CV] segmentation failed during preflight:", err);
    }

    const { gray, scale } = grayFromCanvas(canvas);
    const region = personRegion(pose.keypoints, masks);
    const grayRegion = region
      ? { x0: region.x0 * scale, y0: region.y0 * scale, x1: region.x1 * scale, y1: region.y1 * scale }
      : undefined;

    const garmentCoverage =
      masks && pose.keypoints && torsoVisible(pose.keypoints, T.visibility)
        ? maskCoverageInBox(masks.clothes, torsoBox(pose.keypoints), 2)
        : masks
          ? 0
          : null;

    const signals: PreflightSignals = {
      width: W,
      height: H,
      keypoints: pose.keypoints,
      personCount: pose.personCount,
      shoulderYawDeg: pose.shoulderYawDeg,
      garmentCoverage,
      meanLuminance: meanLuminance(gray),
      sharpness: laplacianVariance(gray, grayRegion),
    };
    const result = evaluatePreflight(signals);

    return { result, keypoints: pose.keypoints, masks, rgba, width: W, height: H, signals };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/* ───────────── Live camera coaching (~4 fps) ───────────── */

const coach: { prev: BodyKeypoints | null } = { prev: null };

/** Forget motion history (call when the camera starts or the shopper retakes). */
export function resetLiveCoach(): void {
  coach.prev = null;
}

const TIPS = {
  enter: "Step into the frame — head to toe",
  onlyYou: "Just you in the frame, please",
  feet: "Step back — we need to see your feet",
  head: "Step back — keep your head in the frame",
  fullBody: "Step back so we can see you head to toe",
  closer: "Come a little closer",
  centre: "Move to the centre of the frame",
  face: "Turn to face the camera",
  arms: "Arms relaxed by your sides",
  still: "Hold still",
  ready: "Great — hold for the timer",
} as const;

/** Mean keypoint motion between frames as a share of the nose→ankle span. */
function motion(a: BodyKeypoints, b: BodyKeypoints, spanPx: number): number {
  const keys: (keyof BodyKeypoints)[] = ["nose", "leftShoulder", "rightShoulder", "leftHip", "rightHip", "leftAnkle", "rightAnkle"];
  let s = 0;
  for (const k of keys) s += Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y);
  return s / keys.length / Math.max(1, spanPx);
}

/** One short tip at a time for the live camera overlay; `ready` starts the timer. */
export function liveCoach(
  kp: BodyKeypoints | null,
  personCount: number,
  width: number,
  height: number,
): { ready: boolean; tip: string } {
  const prev = coach.prev;
  coach.prev = kp;
  const no = (tip: string) => ({ ready: false, tip });

  if (!kp || personCount === 0) return no(TIPS.enter);
  if (personCount > 1) return no(TIPS.onlyYou);

  const feetOk =
    vis(kp.leftAnkle) && vis(kp.rightAnkle) && Math.max(kp.leftAnkle.y, kp.rightAnkle.y) <= height * T.feetBottomMargin;
  if (!feetOk) return no(TIPS.feet);
  if (!vis(kp.nose) || kp.nose.y < height * T.headTopMargin) return no(TIPS.head);
  if (!torsoVisible(kp, T.visibility)) return no(TIPS.fullBody);

  const span = noseToAnklePx(kp) ?? 0;
  if (span < 0.45 * height) return no(TIPS.closer);

  const cx = (kp.leftHip.x + kp.rightHip.x) / 2;
  if (cx < 0.25 * width || cx > 0.75 * width) return no(TIPS.centre);

  const torsoH = hipLineY(kp) - shoulderLineY(kp);
  if (!(torsoH > 0) || shoulderWidthPx(kp) / torsoH < T.minShoulderToTorso) return no(TIPS.face);

  const box = upperTorsoBox(kp);
  const inBox = (k: Keypoint) => vis(k) && k.x >= box.x0 && k.x <= box.x1 && k.y >= box.y0 && k.y <= box.y1;
  const raised = (w: Keypoint, e: Keypoint) => vis(w) && vis(e) && w.y < e.y;
  if (
    (inBox(kp.leftWrist) && inBox(kp.rightWrist)) ||
    raised(kp.leftWrist, kp.leftElbow) ||
    raised(kp.rightWrist, kp.rightElbow)
  ) {
    return no(TIPS.arms);
  }

  if (!prev || motion(prev, kp, span) > 0.02) return no(TIPS.still);
  return { ready: true, tip: TIPS.ready };
}

/* ───────────── Measurements ───────────── */

/** Placeholder pose (all landmarks invisible) for the dev "continue anyway" path. */
function invisibleKeypoints(width: number, height: number): BodyKeypoints {
  const c: Keypoint = { x: width / 2, y: height / 2, visibility: 0 };
  return {
    nose: c,
    leftEye: c,
    rightEye: c,
    leftShoulder: c,
    rightShoulder: c,
    leftElbow: c,
    rightElbow: c,
    leftWrist: c,
    rightWrist: c,
    leftHip: c,
    rightHip: c,
    leftKnee: c,
    rightKnee: c,
    leftAnkle: c,
    rightAnkle: c,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Observed colour this far (ΔE00) from the catalogue colour suggests another garment is in the way. */
const PURCHASE_COLOUR_MISMATCH = 45;

/**
 * The returned garment as seen in the photo: clothes pixels whose colour matches the
 * torso sample (separates it from trousers / layers the clothes class also covers).
 * Falls back to the raw clothes mask when the colour filter would remove too much of
 * the torso (prints, strong lighting gradients).
 */
export function wornGarmentMask(
  rgba: Uint8ClampedArray,
  clothes: Mask,
  torso: Box,
  reference: Lab | null,
  maxDistance = 20,
): Mask {
  if (!reference) return clothes;
  const refined = refineMaskByColour(rgba, clothes, reference, maxDistance);
  const before = maskCoverageInBox(clothes, torso, 2);
  const after = maskCoverageInBox(refined, torso, 2);
  return before > 0 && after / before >= 0.6 ? refined : clothes;
}

/**
 * Derive PhotoMeasurements from a preflight run: garment-first calibration (height
 * fallback when `opts.heightCm` is given), ease at the hips, hem length, garment mask
 * area, and the observed garment colour (lighting reference for the gate).
 */
export function buildMeasurements(
  pre: PreflightOutput,
  purchased: { size: SizeCode; pom: Pom; colorHex: string },
  opts?: { heightCm?: number },
): PhotoMeasurements {
  const { width: W, height: H, rgba, masks } = pre;
  const kp = pre.keypoints ?? invisibleKeypoints(W, H);
  const garmentMaskArea = masks ? round(maskFraction(masks.clothes), 4) : 0;

  if (!masks || !pre.keypoints || !torsoVisible(kp, T.visibility)) {
    return { keypoints: kp, calibration: null, easeRatio: null, hemCm: null, garmentMaskArea, observedGarmentLab: null };
  }

  const torso = clampBox(torsoBox(kp), W, H);
  const torsoClothes = maskAnd(masks.clothes, boxMask(W, H, torso));
  const observed = meanLabMasked(rgba, torsoClothes.data, W, H, { step: 2, minPixels: 50 });

  let purchasedLab: Lab | null = null;
  try {
    purchasedLab = hexToLab(purchased.colorHex);
  } catch {
    purchasedLab = null;
  }
  // Prefer the observed colour (real lighting); the catalogue colour is only a fallback
  // reference, with a wider tolerance, when the torso sample was too small.
  const garment = observed
    ? wornGarmentMask(rgba, masks.clothes, torso, observed, 20)
    : wornGarmentMask(rgba, masks.clothes, torso, purchasedLab, 30);

  let calibration: Calibration | null = calibrateFromGarment(kp, garment, purchased.size, purchased.pom);
  const heightCm = opts?.heightCm;
  if (!calibration && heightCm) {
    calibration = calibrateFromHeight(kp, garment, heightCm, purchased.size, purchased.pom);
  } else if (calibration && heightCm) {
    // Second opinion from stated height: widen the band if the two scales disagree.
    const span = noseToAnklePx(kp);
    if (span !== null) {
      const pxH = span / (NOSE_TO_ANKLE_OF_HEIGHT * heightCm);
      const rel = Math.abs(pxH - calibration.pxPerCm) / calibration.pxPerCm;
      if (rel > 0.06) calibration.uncertaintyCm = Math.min(6, Math.max(calibration.uncertaintyCm, 1 + 8 * Math.min(rel, 0.4)));
    }
  }
  if (calibration && observed && purchasedLab && deltaE2000(observed, purchasedLab) > PURCHASE_COLOUR_MISMATCH) {
    // The visible garment doesn't look like the purchased colour (layering, odd light):
    // keep the ruler but be honest about the extra doubt.
    calibration.uncertaintyCm = Math.min(6, calibration.uncertaintyCm + 1);
  }

  const ease = easeRatio(garment, kp);
  let hemCm: number | null = null;
  if (calibration) {
    hemCm =
      calibration.method === "garment"
        ? purchased.pom.hpsToHemCm // equals the POM by construction
        : round((calibration.observedHemY - calibration.hpsY) / calibration.pxPerCm, 1);
  }

  return {
    keypoints: kp,
    calibration,
    easeRatio: ease === null ? null : round(ease, 3),
    hemCm,
    garmentMaskArea,
    observedGarmentLab: observed ? [round(observed[0], 2), round(observed[1], 2), round(observed[2], 2)] : null,
  };
}
