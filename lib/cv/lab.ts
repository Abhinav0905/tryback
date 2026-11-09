// Dev-only gate lab (browser). Powers app/dev/gate-lab and `npm run tune`
// (scripts/tune-gate.ts drives it over the Chrome DevTools Protocol).
//
// It runs the SAME code paths as the shopper flow: normalizePhoto → runPreflight →
// buildMeasurements for the person photo, and the fidelity gate's computeGate for a
// render, with the same MediaPipe models. On top it can make synthetic test images
// (a recoloured "colour-only" render, and broken variants of a good render) so gate
// thresholds can be calibrated. Everything stays in this browser tab: no image is
// uploaded anywhere. Synthetic images are test fixtures only — never shown to shoppers.

import { getSku } from "../catalog";
import { deltaE2000, hexToLab, labAt, meanLabMasked, type Lab } from "../color";
import { classifyTransition } from "../retrieval";
import type { GateMetrics, PhotoMeasurements, PreflightCheck, SizeCode, Sku, TransitionType } from "../types";
import { SIZES } from "../types";
import { ASPECT_TOLERANCE, computeGateDetailed, expectedRenderLab, type GateDebug } from "./gate";
import { decideGate, type GateDecision } from "./gateMath";
import {
  boxMask,
  clampBox,
  hipLineY,
  maskAnd,
  maskBBox,
  torsoBox,
  torsoVisible,
  type Box,
  type Mask,
} from "./geometry";
import { canvasRgba, fitWithin, imageToCanvas, imageToCanvasCover, loadImage, normalizePhoto } from "./image";
import { activeDelegate, warmUpVision } from "./mediapipe";
import {
  buildMeasurements,
  preflightCheckValues,
  runPreflightDetailed,
  wornGarmentMask,
  type PreflightOutput,
  type PreflightSignals,
  type PreflightValue,
} from "./preflight";
import { segmentParts, type PartsMasks } from "./segment";
import {
  bottomRowsForFraction,
  dilateMask,
  hashSeed,
  hemShiftFeasible,
  hemWarpSourceRow,
  labOffsetForDeltaE,
  labToSrgb,
  mulberry32,
  recolourLab,
  rgbToHex,
  shadingTolerantDistance,
  softWeight,
  type SynthKind,
} from "./synthMath";
import { THRESHOLDS } from "./thresholds";

export const GATE_LAB_VERSION = 1;

/* ───────────── Public API types (also used by scripts/tune-gate.ts) ───────────── */

export interface LabCtx {
  /** SKU the person is wearing in the photo (the "returned" garment). */
  sourceSkuId: string;
  /** Purchased size of the worn garment (default M). */
  size?: SizeCode;
  /** SKU the render shows. */
  targetSkuId?: string;
  /** Colour-only virtual target: the worn garment in this colour (self-test positives). */
  targetColorHex?: string;
  /**
   * Override the worn SKU's catalogue colour: a hex, or "auto" for the colour measured in the
   * photo (as if the catalogue colour matched the real garment). Self-tests use "auto".
   */
  sourceColorHex?: string;
  targetSize?: SizeCode;
  /** Override classifyTransition(source, target). */
  transition?: TransitionType;
  /** Optional stated height (calibration fallback), as in the size flow. */
  heightCm?: number;
}

export interface GarmentPhotoColour {
  lab: Lab;
  hex: string;
  /** Share of the product image classed as garment (not background). */
  garmentShare: number;
  backgroundHex: string;
}

export interface LabMetricsResult {
  metrics: GateMetrics;
  colourChangeExpected: boolean;
  transition: TransitionType;
  lengthVariant: boolean;
  source: { id: string; colorHex: string };
  target: { id: string; colorHex: string; size: SizeCode };
  decision: { canRetry: GateDecision; noRetry: GateDecision };
  debug: GateDebug;
  measurements: {
    calibration: { method: string; pxPerCm: number; uncertaintyCm: number; hpsY: number; observedHemY: number } | null;
    observedGarmentLab: Lab | null;
    easeRatio: number | null;
  };
  preflight: { ok: boolean; checks: PreflightCheck[] };
  /** Measured colour of the catalogue product image, vs the SKU's colorHex. */
  garment: (GarmentPhotoColour & { catalogueHex: string; deltaE: number }) | null;
  timings: { personMs: number; gateMs: number };
}

export interface LabPreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  values: PreflightValue[];
  signals: Omit<PreflightSignals, "keypoints"> & { keypointsFound: boolean };
  width: number;
  height: number;
  /** True when the upload would be passed through byte-for-byte (metadata-free JPEG ≤1600 px). */
  passthrough: boolean;
  ms: number;
}

export interface LabSynthResult {
  ok: boolean;
  /** Why no image was produced (e.g. "no calibration for a hem shift"). */
  skipped?: string;
  kind: SynthKind;
  ref?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  info: Record<string, unknown>;
}

/* ───────────── Image refs (keep big images in the page, pass short handles) ───────────── */

const refs = new Map<string, { blob: Blob; url: string }>();
let refSeq = 0;

async function dataUrlToBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`couldn't read image (${res.status})`);
  return res.blob();
}

/** Store an image (data URL or blob URL) in the page; returns a "ref:N" handle usable anywhere a data URL is. */
export async function put(src: string): Promise<string> {
  const blob = await dataUrlToBlob(src);
  const ref = `ref:${++refSeq}`;
  refs.set(ref, { blob, url: URL.createObjectURL(blob) });
  return ref;
}

function storeBlob(blob: Blob): string {
  const ref = `ref:${++refSeq}`;
  refs.set(ref, { blob, url: URL.createObjectURL(blob) });
  return ref;
}

function urlOf(src: string): string {
  if (src.startsWith("ref:")) {
    const r = refs.get(src);
    if (!r) throw new Error(`unknown image ref ${src}`);
    return r.url;
  }
  return src;
}

async function blobOf(src: string): Promise<Blob> {
  if (src.startsWith("ref:")) {
    const r = refs.get(src);
    if (!r) throw new Error(`unknown image ref ${src}`);
    return r.blob;
  }
  return dataUrlToBlob(src);
}

/** Free stored images and cached analyses. */
export function reset(): void {
  for (const r of refs.values()) URL.revokeObjectURL(r.url);
  refs.clear();
  for (const p of personCache.values()) void p.then((a) => URL.revokeObjectURL(a.url)).catch(() => undefined);
  personCache.clear();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}

/* ───────────── Person analysis (same path as CaptureStep) ───────────── */

interface PersonAnalysis {
  url: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  pre: PreflightOutput & { signals: PreflightSignals };
  measurements: PhotoMeasurements;
  source: Sku;
  size: SizeCode;
  passthrough: boolean;
  ms: number;
}

const personCache = new Map<string, Promise<PersonAnalysis>>();

function requireSize(s: string | undefined, fallback: SizeCode): SizeCode {
  if (s === undefined) return fallback;
  if (!(SIZES as readonly string[]).includes(s)) throw new Error(`unknown size "${s}"`);
  return s as SizeCode;
}

function requireSkuById(id: string | undefined, what: string): Sku {
  if (!id) throw new Error(`${what} is required`);
  const sku = getSku(id);
  if (!sku) throw new Error(`unknown ${what} "${id}"`);
  return sku;
}

async function normalise(src: string): Promise<{ url: string; width: number; height: number; passthrough: boolean; blob: Blob }> {
  const input = await blobOf(src);
  const norm = await normalizePhoto(input, { mirrored: false });
  return { url: norm.url, width: norm.width, height: norm.height, passthrough: norm.blob === input, blob: norm.blob };
}

function analysePerson(src: string, sourceSkuId: string, size: SizeCode, heightCm?: number): Promise<PersonAnalysis> {
  const key = `${src.length}:${src.slice(0, 64)}:${src.slice(-64)}|${sourceSkuId}|${size}|${heightCm ?? ""}`;
  let p = personCache.get(key);
  if (!p) {
    p = (async () => {
      const t0 = performance.now();
      const source = requireSkuById(sourceSkuId, "sourceSkuId");
      const norm = await normalise(src);
      const img = await loadImage(norm.url);
      const pre = await runPreflightDetailed(img, norm.width, norm.height);
      const measurements = buildMeasurements(
        pre,
        { size, pom: source.poms[size], colorHex: source.colorHex },
        heightCm ? { heightCm } : undefined,
      );
      // JSON round trip, exactly like the upload → server → gate path.
      const stored = JSON.parse(JSON.stringify(measurements)) as PhotoMeasurements;
      return {
        url: norm.url,
        width: norm.width,
        height: norm.height,
        rgba: pre.rgba,
        pre,
        measurements: stored,
        source,
        size,
        passthrough: norm.passthrough,
        ms: Math.round(performance.now() - t0),
      };
    })();
    p.catch(() => personCache.delete(key));
    personCache.set(key, p);
  }
  return p;
}

/** The worn SKU as the gate should see it (optionally with its colour overridden). */
function resolveSource(ctx: LabCtx, person: PersonAnalysis): Sku {
  const want = ctx.sourceColorHex;
  if (!want) return person.source;
  let hex: string;
  if (want === "auto") {
    const lab = person.measurements.observedGarmentLab;
    if (!lab) throw new Error('sourceColorHex "auto": the worn garment was not found in the photo');
    hex = rgbToHex(labToSrgb(lab).rgb);
  } else {
    hexToLab(want); // validates
    hex = want.startsWith("#") ? want : `#${want}`;
  }
  return { ...person.source, colorHex: hex };
}

function resolveTarget(ctx: LabCtx, source: Sku): Sku {
  if (ctx.targetColorHex) {
    hexToLab(ctx.targetColorHex); // validates
    const hex = ctx.targetColorHex.startsWith("#") ? ctx.targetColorHex : `#${ctx.targetColorHex}`;
    return { ...source, id: `${source.id}~${hex.slice(1).toLowerCase()}`, colorHex: hex, colorName: `virtual ${hex}` };
  }
  return requireSkuById(ctx.targetSkuId, "targetSkuId");
}

/* ───────────── Catalogue product image colour ───────────── */

/** Mean colour of the garment in a product shot (background = the image border's colour). */
export async function garmentColour(src: string): Promise<GarmentPhotoColour | null> {
  const img = await loadImage(urlOf(src));
  const { width: w, height: h } = fitWithin(img.naturalWidth, img.naturalHeight, 256);
  const c = imageToCanvas(img, w, h);
  try {
    const rgba = canvasRgba(c);
    const border = new Uint8Array(w * h);
    const bw = Math.max(1, Math.round(Math.min(w, h) * 0.03));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < bw || y < bw || x >= w - bw || y >= h - bw) border[y * w + x] = 1;
    const bg = meanLabMasked(rgba, border, w, h, { minPixels: 10 });
    if (!bg) return null;
    const garment = new Uint8Array(w * h);
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (rgba[i * 4 + 3] < 128) continue; // transparent PNG background
      if (deltaE2000(labAt(rgba, i * 4), bg) > 15) {
        garment[i] = 1;
        n++;
      }
    }
    // The core of the garment (central half of its bounding box) avoids hangers and edges.
    const bb = maskBBox({ data: garment, width: w, height: h });
    if (!bb || n < 50) return null;
    const core = maskAnd(
      { data: garment, width: w, height: h },
      boxMask(w, h, {
        x0: bb.x0 + (bb.x1 - bb.x0) * 0.25,
        x1: bb.x1 - (bb.x1 - bb.x0) * 0.25,
        y0: bb.y0 + (bb.y1 - bb.y0) * 0.2,
        y1: bb.y1 - (bb.y1 - bb.y0) * 0.2,
      }),
    );
    const lab = meanLabMasked(rgba, core.data, w, h, { minPixels: 20 }) ?? meanLabMasked(rgba, garment, w, h, { minPixels: 20 });
    if (!lab) return null;
    return {
      lab: lab.map((v) => Math.round(v * 100) / 100) as Lab,
      hex: rgbToHex(labToSrgb(lab).rgb),
      garmentShare: Math.round((n / (w * h)) * 1000) / 1000,
      backgroundHex: rgbToHex(labToSrgb(bg).rgb),
    };
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

/* ───────────── metrics / preflight ───────────── */

/** Gate metrics for one render of `personSrc`, exactly as runGate computes them, plus intermediate values. */
export async function metrics(
  personSrc: string,
  renderSrc: string,
  garmentSrc: string | null,
  ctx: LabCtx,
): Promise<LabMetricsResult> {
  const size = requireSize(ctx.size, "M");
  const person = await analysePerson(personSrc, ctx.sourceSkuId, size, ctx.heightCm);
  const source = resolveSource(ctx, person);
  const target = resolveTarget(ctx, source);
  const targetSize = requireSize(ctx.targetSize, size);
  const transition = ctx.transition ?? classifyTransition(source, target);
  // Same rule as runGate.
  const lengthVariant = source.family === target.family && source.id !== target.id;

  const t0 = performance.now();
  const { metrics: m, colourChangeExpected, debug } = await computeGateDetailed({
    originalUrl: person.url,
    renderUrl: urlOf(renderSrc),
    measurements: person.measurements,
    sourceSku: source,
    targetSku: target,
    targetSize,
    transition,
    canRetry: true,
  });
  const gateMs = Math.round(performance.now() - t0);
  const base = { transition, colourChangeExpected, lengthVariant };

  let garment: LabMetricsResult["garment"] = null;
  if (garmentSrc) {
    const g = await garmentColour(garmentSrc).catch(() => null);
    if (g) garment = { ...g, catalogueHex: target.colorHex, deltaE: Math.round(deltaE2000(g.lab, hexToLab(target.colorHex)) * 100) / 100 };
  }

  const cal = person.measurements.calibration;
  return {
    metrics: m,
    colourChangeExpected,
    transition,
    lengthVariant,
    source: { id: source.id, colorHex: source.colorHex },
    target: { id: target.id, colorHex: target.colorHex, size: targetSize },
    decision: {
      canRetry: decideGate(m, { ...base, canRetry: true }),
      noRetry: decideGate(m, { ...base, canRetry: false }),
    },
    debug,
    measurements: {
      calibration: cal
        ? { method: cal.method, pxPerCm: cal.pxPerCm, uncertaintyCm: cal.uncertaintyCm, hpsY: cal.hpsY, observedHemY: cal.observedHemY }
        : null,
      observedGarmentLab: person.measurements.observedGarmentLab,
      easeRatio: person.measurements.easeRatio,
    },
    preflight: { ok: person.pre.result.ok, checks: person.pre.result.checks },
    garment,
    timings: { personMs: person.ms, gateMs },
  };
}

/** Preflight on a person photo (normalised like an upload), with the raw value behind every check. */
export async function preflight(personSrc: string): Promise<LabPreflightResult> {
  const t0 = performance.now();
  const norm = await normalise(personSrc);
  try {
    const img = await loadImage(norm.url);
    const pre = await runPreflightDetailed(img, norm.width, norm.height);
    const { keypoints, ...rest } = pre.signals;
    return {
      ok: pre.result.ok,
      checks: pre.result.checks,
      values: preflightCheckValues(pre.signals),
      signals: { ...rest, keypointsFound: keypoints !== null },
      width: norm.width,
      height: norm.height,
      passthrough: norm.passthrough,
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    URL.revokeObjectURL(norm.url);
  }
}

/* ───────────── synthetic images ───────────── */

function newCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D isn't available");
  return { c, ctx };
}

/** The render drawn into the person photo's frame with the gate's own rule (stretch, or centre-crop when the aspect differs). */
async function renderInPhotoFrame(renderSrc: string, W: number, H: number): Promise<HTMLCanvasElement> {
  const render = await loadImage(urlOf(renderSrc));
  const same = Math.abs(render.naturalWidth / render.naturalHeight / (W / H) - 1) <= ASPECT_TOLERANCE;
  return same ? imageToCanvas(render, W, H) : imageToCanvasCover(render, render.naturalWidth, render.naturalHeight, W, H);
}

function torsoOf(person: PersonAnalysis): Box | null {
  const kp = person.pre.keypoints;
  if (!kp || !torsoVisible(kp)) return null;
  return clampBox(torsoBox(kp), person.width, person.height);
}

/**
 * Per-pixel weights for "the garment": 1 inside the clothes mask, and in a thin band around
 * it (the 256 px segmentation is coarse) a fade by shading-tolerant colour closeness to `ref`.
 */
function garmentWeights(rgba: Uint8ClampedArray, clothes: Mask, ref: Lab, near = 20, far = 34): Float32Array {
  const { width: w, height: h } = clothes;
  const grown = dilateMask(clothes.data, w, h, Math.max(2, Math.round(Math.max(w, h) * 0.006)));
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (clothes.data[i]) out[i] = 1;
    else if (grown[i]) out[i] = softWeight(shadingTolerantDistance(labAt(rgba, i * 4), ref), near, far);
  }
  return out;
}

function meanLabWeighted(rgba: Uint8ClampedArray, wts: Float32Array, region: Uint8Array | null): Lab | null {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let n = 0;
  for (let i = 0; i < wts.length; i += 2) {
    if (wts[i] < 0.5 || (region && !region[i])) continue;
    const l = labAt(rgba, i * 4);
    s0 += l[0];
    s1 += l[1];
    s2 += l[2];
    n++;
  }
  return n >= 30 ? [s0 / n, s1 / n, s2 / n] : null;
}

function writeLab(out: Uint8ClampedArray, p: number, lab: Lab, weight: number): void {
  const { rgb } = labToSrgb(lab);
  out[p] = out[p] + (rgb[0] - out[p]) * weight;
  out[p + 1] = out[p + 1] + (rgb[1] - out[p + 1]) * weight;
  out[p + 2] = out[p + 2] + (rgb[2] - out[p + 2]) * weight;
}

async function encode(c: HTMLCanvasElement, wantDataUrl: boolean): Promise<{ ref: string; dataUrl?: string }> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.92),
  );
  const ref = storeBlob(blob);
  return wantDataUrl ? { ref, dataUrl: await blobToDataUrl(blob) } : { ref };
}

interface SynthParams extends LabCtx {
  [k: string]: unknown;
  /** Return the image as a data URL too (default true). */
  returnDataUrl?: boolean;
  seed?: string;
}

function numParam(p: SynthParams, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Make a synthetic variant for calibration:
 * - "recolour": the person photo with the worn garment recoloured to the target colour
 *   (a colour-only "render" for self-tests; also the silhouette-leak negative);
 * - "colour" | "residue" | "identity" | "missing" | "hem" | "silhouette": a good render broken
 *   in one specific way (negatives);
 * - "pf-dark" | "pf-bright" | "pf-blur" | "pf-crop-feet": a person photo broken for preflight.
 */
export async function synth(personSrc: string, renderSrc: string | null, kind: SynthKind, params: SynthParams): Promise<LabSynthResult> {
  const wantDataUrl = params.returnDataUrl !== false;
  const size = requireSize(params.size, "M");

  if (kind.startsWith("pf-")) return synthPreflight(personSrc, kind, params, wantDataUrl);

  const person = await analysePerson(personSrc, params.sourceSkuId, size, params.heightCm);
  const W = person.width;
  const H = person.height;
  const kp = person.pre.keypoints;
  const torso = torsoOf(person);
  const skip = (why: string): LabSynthResult => ({ ok: false, skipped: why, kind, info: {} });
  if (!kp || !torso) return skip("no pose found in the person photo");

  const source = resolveSource(params, person);
  if (kind === "recolour" || kind === "silhouette") {
    const target = resolveTarget(params, source);
    const observed = person.measurements.observedGarmentLab;
    if (!observed || !person.pre.masks) return skip("the worn garment wasn't found in the person photo");
    const expected = expectedRenderLab(hexToLab(target.colorHex), hexToLab(source.colorHex), observed);
    const { c, ctx } = newCanvas(W, H);
    try {
      const out = new Uint8ClampedArray(person.rgba);
      const wts = garmentWeights(person.rgba, person.pre.masks.clothes, observed);
      let changed = 0;
      let clipped = 0;
      for (let i = 0; i < W * H; i++) {
        const wgt = wts[i];
        if (wgt <= 0) continue;
        const p = i * 4;
        const lab = recolourLab(labAt(person.rgba, p), observed, expected);
        if (!labToSrgb(lab).inGamut) clipped++;
        writeLab(out, p, lab, wgt);
        changed++;
      }
      ctx.putImageData(new ImageData(out, W, H), 0, 0);
      const enc = await encode(c, wantDataUrl);
      return {
        ok: true,
        kind,
        ...enc,
        width: W,
        height: H,
        info: {
          targetHex: target.colorHex,
          expectedLab: expected,
          observedLab: observed,
          changedShare: Math.round((changed / (W * H)) * 1000) / 1000,
          clippedShare: changed ? Math.round((clipped / changed) * 1000) / 1000 : 0,
          note: kind === "silhouette" ? "original garment shape kept, recoloured to the target (silhouette leak)" : "synthetic colour-only render",
        },
      };
    } finally {
      c.width = 0;
      c.height = 0;
    }
  }

  if (!renderSrc) return skip(`"${kind}" needs a render`);
  // The gate's own view of this render (face box, hem, garment colour), so every edit
  // lands exactly where the gate measures.
  const target = resolveTarget(params, source);
  const g = await computeGateDetailed({
    originalUrl: person.url,
    renderUrl: urlOf(renderSrc),
    measurements: person.measurements,
    sourceSku: source,
    targetSku: target,
    targetSize: requireSize(params.targetSize, size),
    transition: params.transition ?? classifyTransition(source, target),
    canRetry: true,
  });
  const up = W / g.debug.width; // analysis frame → photo frame
  const rc = await renderInPhotoFrame(renderSrc, W, H);
  try {
    const rgba = canvasRgba(rc);
    const ctx2 = rc.getContext("2d", { willReadFrequently: true });
    if (!ctx2) throw new Error("Canvas 2D isn't available");
    const rnd = mulberry32(hashSeed(params.seed ?? `${kind}`));
    const before = g.metrics;

    if (kind === "colour") {
      const renderLab = g.debug.renderLab;
      if (!renderLab) return skip("no garment found in the render");
      const masks: PartsMasks = await segmentParts(rc, W, H);
      const want = numParam(params, "deltaE", 18);
      const { offset } = labOffsetForDeltaE(renderLab, want, numParam(params, "hueDeg", rnd() * 360));
      const wts = garmentWeights(rgba, masks.clothes, renderLab);
      const out = new Uint8ClampedArray(rgba);
      for (let i = 0; i < W * H; i++) {
        if (wts[i] <= 0) continue;
        const l = labAt(rgba, i * 4);
        writeLab(out, i * 4, [Math.min(100, Math.max(0, l[0] + offset[0])), l[1] + offset[1], l[2] + offset[2]], wts[i]);
      }
      const torsoMask = boxMask(W, H, torso).data;
      const a = meanLabWeighted(rgba, wts, torsoMask) ?? meanLabWeighted(rgba, wts, null);
      const b = meanLabWeighted(out, wts, torsoMask) ?? meanLabWeighted(out, wts, null);
      ctx2.putImageData(new ImageData(out, W, H), 0, 0);
      return done(rc, kind, wantDataUrl, {
        requestedDeltaE: want,
        achievedDeltaE: a && b ? Math.round(deltaE2000(a, b) * 10) / 10 : null,
        offset: offset.map((v) => Math.round(v * 10) / 10),
        before,
      });
    }

    if (kind === "residue") {
      const observed = person.measurements.observedGarmentLab;
      if (!observed || !person.pre.masks) return skip("the worn garment wasn't found in the person photo");
      const orig = wornGarmentMask(person.rgba, person.pre.masks.clothes, torso, observed);
      const fraction = Math.min(1, Math.max(0, numParam(params, "fraction", 0.4)));
      const mode = params.mode === "patches" ? "patches" : "hem";
      const sel = new Uint8Array(W * H);
      let total = 0;
      for (let i = 0; i < W * H; i++) total += orig.data[i] ? 1 : 0;
      if (total < 200) return skip("worn garment too small to paste back");
      if (mode === "hem") {
        const rows = Array.from({ length: H }, (_, y) => {
          let n = 0;
          for (let x = 0; x < W; x++) n += orig.data[y * W + x] ? 1 : 0;
          return n;
        });
        const cut = bottomRowsForFraction(rows, fraction);
        for (let i = cut * W; i < W * H; i++) sel[i] = orig.data[i];
      } else {
        const block = Math.max(8, Math.round((torso.x1 - torso.x0) * 0.12));
        const cells: { x: number; y: number; n: number }[] = [];
        for (let by = 0; by < H; by += block) {
          for (let bx = 0; bx < W; bx += block) {
            let n = 0;
            for (let y = by; y < Math.min(H, by + block); y++) for (let x = bx; x < Math.min(W, bx + block); x++) n += orig.data[y * W + x] ? 1 : 0;
            if (n > 0) cells.push({ x: bx, y: by, n });
          }
        }
        for (let i = cells.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [cells[i], cells[j]] = [cells[j], cells[i]];
        }
        let acc = 0;
        for (const cell of cells) {
          if (acc >= fraction * total) break;
          acc += cell.n;
          for (let y = cell.y; y < Math.min(H, cell.y + block); y++) {
            for (let x = cell.x; x < Math.min(W, cell.x + block); x++) {
              const i = y * W + x;
              sel[i] = orig.data[i];
            }
          }
        }
      }
      const out = new Uint8ClampedArray(rgba);
      let pasted = 0;
      for (let i = 0; i < W * H; i++) {
        if (!sel[i]) continue;
        const p = i * 4;
        out[p] = person.rgba[p];
        out[p + 1] = person.rgba[p + 1];
        out[p + 2] = person.rgba[p + 2];
        pasted++;
      }
      ctx2.putImageData(new ImageData(out, W, H), 0, 0);
      return done(rc, kind, wantDataUrl, { mode, requestedFraction: fraction, pastedFraction: Math.round((pasted / total) * 1000) / 1000, before });
    }

    if (kind === "identity") {
      const face = g.debug.faceBox;
      if (!face) return skip("the gate found no face box");
      const fb = clampBox({ x0: face.x0 * up, y0: face.y0 * up, x1: face.x1 * up, y1: face.y1 * up }, W, H);
      const fw = fb.x1 - fb.x0;
      const fh = fb.y1 - fb.y0;
      if (fw < 6 || fh < 6) return skip("face too small");
      const mode = typeof params.mode === "string" ? params.mode : "blur";
      const { c: patch, ctx: pctx } = newCanvas(fw, fh);
      try {
        pctx.drawImage(rc, fb.x0, fb.y0, fw, fh, 0, 0, fw, fh);
        ctx2.save();
        ctx2.beginPath();
        ctx2.rect(fb.x0, fb.y0, fw, fh);
        ctx2.clip();
        if (mode === "pixelate") {
          const blocks = Math.max(2, Math.round(numParam(params, "blocks", 6)));
          const { c: tiny, ctx: tctx } = newCanvas(blocks, Math.max(2, Math.round((blocks * fh) / fw)));
          tctx.drawImage(patch, 0, 0, tiny.width, tiny.height);
          ctx2.imageSmoothingEnabled = false;
          ctx2.drawImage(tiny, fb.x0, fb.y0, fw, fh);
          ctx2.imageSmoothingEnabled = true;
          tiny.width = 0;
        } else if (mode === "shift") {
          const dx = Math.max(1, Math.round(fw * numParam(params, "strength", 0.25)));
          ctx2.drawImage(patch, fb.x0 + dx, fb.y0);
          ctx2.drawImage(patch, fw - dx, 0, dx, fh, fb.x0, fb.y0, dx, fh);
        } else {
          const px = Math.max(1, fw * numParam(params, "strength", 0.12));
          ctx2.filter = `blur(${px.toFixed(1)}px)`;
          ctx2.drawImage(patch, fb.x0, fb.y0);
          ctx2.filter = "none";
        }
        ctx2.restore();
      } finally {
        patch.width = 0;
      }
      return done(rc, kind, wantDataUrl, { mode, faceBox: fb, faceFrom: g.debug.faceBoxFrom, before });
    }

    if (kind === "missing") {
      const masks: PartsMasks = await segmentParts(rc, W, H);
      // Background colour from the frame border (median per channel; top and sides, not the floor).
      const ch: number[][] = [[], [], []];
      const bw = Math.max(2, Math.round(Math.min(W, H) * 0.03));
      for (let y = 0; y < H; y += 3) {
        for (let x = 0; x < W; x += 3) {
          if (x >= bw && y >= bw && x < W - bw) continue;
          const p = (y * W + x) * 4;
          ch[0].push(rgba[p]);
          ch[1].push(rgba[p + 1]);
          ch[2].push(rgba[p + 2]);
        }
      }
      const med = ch.map((a) => a.sort((m, n) => m - n)[Math.floor(a.length / 2)] ?? 128);
      const fraction = Math.min(1, Math.max(0, numParam(params, "fraction", 1)));
      const grown = dilateMask(masks.clothes.data, W, H, Math.max(2, Math.round(Math.max(W, H) * 0.008)));
      const bb = maskBBox({ data: grown, width: W, height: H });
      if (!bb) return skip("no garment found in the render");
      const yMax = bb.y0 + (bb.y1 - bb.y0) * fraction;
      const out = new Uint8ClampedArray(rgba);
      for (let y = 0; y < Math.min(H, Math.ceil(yMax)); y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!grown[i]) continue;
          const noise = (rnd() - 0.5) * 10;
          out[i * 4] = med[0] + noise;
          out[i * 4 + 1] = med[1] + noise;
          out[i * 4 + 2] = med[2] + noise;
        }
      }
      ctx2.putImageData(new ImageData(out, W, H), 0, 0);
      return done(rc, kind, wantDataUrl, { fraction, fill: rgbToHex(med as [number, number, number]), before });
    }

    if (kind === "hem") {
      const cal = person.measurements.calibration;
      if (!cal) return skip("no calibration (the size ruler) for this photo");
      if (g.debug.renderHemY === null) return skip("the gate found no hem in the render");
      const cm = numParam(params, "cm", 10);
      const hemY = g.debug.renderHemY * up;
      const hipY = hipLineY(kp);
      const shift = cm * cal.pxPerCm;
      if (!hemShiftFeasible(hipY, hemY, shift, H)) return skip(`a ${cm} cm hem shift doesn't fit in the frame`);
      const out = new Uint8ClampedArray(rgba);
      for (let y = Math.max(0, Math.floor(hipY)); y < H; y++) {
        const sy = hemWarpSourceRow(y, hipY, hemY, shift, H);
        const y0 = Math.max(0, Math.min(H - 1, Math.floor(sy)));
        const y1 = Math.min(H - 1, y0 + 1);
        const t = sy - y0;
        for (let x = 0; x < W; x++) {
          const p = (y * W + x) * 4;
          const a = (y0 * W + x) * 4;
          const b = (y1 * W + x) * 4;
          out[p] = rgba[a] * (1 - t) + rgba[b] * t;
          out[p + 1] = rgba[a + 1] * (1 - t) + rgba[b + 1] * t;
          out[p + 2] = rgba[a + 2] * (1 - t) + rgba[b + 2] * t;
        }
      }
      ctx2.putImageData(new ImageData(out, W, H), 0, 0);
      return done(rc, kind, wantDataUrl, { cm, shiftPx: Math.round(shift), hemY: Math.round(hemY), hipY: Math.round(hipY), pxPerCm: cal.pxPerCm, before });
    }

    return skip(`unknown kind "${kind}"`);
  } finally {
    rc.width = 0;
    rc.height = 0;
  }
}

async function done(c: HTMLCanvasElement, kind: SynthKind, wantDataUrl: boolean, info: Record<string, unknown>): Promise<LabSynthResult> {
  const enc = await encode(c, wantDataUrl);
  return { ok: true, kind, ...enc, width: c.width, height: c.height, info };
}

async function synthPreflight(personSrc: string, kind: SynthKind, params: SynthParams, wantDataUrl: boolean): Promise<LabSynthResult> {
  const norm = await normalise(personSrc);
  try {
    const img = await loadImage(norm.url);
    const W = norm.width;
    const H = norm.height;
    const cropFrac = kind === "pf-crop-feet" ? Math.min(0.5, Math.max(0.02, numParam(params, "fraction", 0.12))) : 0;
    const outH = Math.round(H * (1 - cropFrac));
    const { c, ctx } = newCanvas(W, outH);
    try {
      if (kind === "pf-blur") {
        const px = Math.max(1, Math.max(W, H) * numParam(params, "strength", 0.006));
        ctx.filter = `blur(${px.toFixed(1)}px)`;
        ctx.drawImage(img, 0, 0, W, H);
        ctx.filter = "none";
      } else {
        ctx.drawImage(img, 0, 0, W, H);
      }
      if (kind === "pf-dark" || kind === "pf-bright") {
        const d = ctx.getImageData(0, 0, W, outH);
        const f = numParam(params, "factor", kind === "pf-dark" ? 0.3 : 0.25);
        for (let p = 0; p < d.data.length; p += 4) {
          for (let k = 0; k < 3; k++) {
            const v = d.data[p + k];
            d.data[p + k] = kind === "pf-dark" ? v * f : 255 - (255 - v) * f;
          }
        }
        ctx.putImageData(d, 0, 0);
      }
      const enc = await encode(c, wantDataUrl);
      return { ok: true, kind, ...enc, width: W, height: outH, info: { cropFraction: cropFrac || undefined } };
    } finally {
      c.width = 0;
      c.height = 0;
    }
  } finally {
    URL.revokeObjectURL(norm.url);
  }
}

/* ───────────── misc ───────────── */

export async function info(): Promise<{
  version: number;
  delegates: { pose: string | null; segmenter: string | null };
  thresholds: typeof THRESHOLDS;
  userAgent: string;
}> {
  return {
    version: GATE_LAB_VERSION,
    delegates: { pose: await activeDelegate("pose:IMAGE"), segmenter: await activeDelegate("segmenter") },
    thresholds: THRESHOLDS,
    userAgent: navigator.userAgent,
  };
}

export async function warm(): Promise<void> {
  await warmUpVision();
}

export const gateLabApi = { version: GATE_LAB_VERSION, put, metrics, preflight, synth, garmentColour, info, warm, reset };
export type GateLabApi = typeof gateLabApi;
