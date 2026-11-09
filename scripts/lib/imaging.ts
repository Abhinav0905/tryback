/**
 * Pixel helpers for the catalogue importer (scripts/import-catalog.ts) and the placeholder
 * generator (scripts/gen-placeholders.ts). Pure functions on raw buffers so they can be unit
 * tested without sharp; only the file helpers at the bottom touch the disk.
 *
 *   - CIELAB ⇄ sRGB (lib/color.ts has sRGB → Lab; the inverse lives here)
 *   - background matting: a smooth background model interpolated from the border pixels,
 *     Lab distance threshold, largest connected components, hole filling, 1–2 px feather
 *   - edge decontamination, recolouring toward a target colour with the shading preserved
 *   - a smooth vertical stretch below the waist (tall / petite variants)
 *   - PNG tEXt markers so generated files can be told apart from hand-placed photos
 */
import { promises as fs } from "node:fs";
import { deltaE2000, hexToLab, srgbToLab, type Lab } from "../../lib/color";

/** RGBA, 8 bits per channel, straight (not premultiplied) alpha. */
export interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

export type Point = readonly [number, number];
export type Polygon = readonly Point[];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/* ───────────────────────── Colour ───────────────────────── */

const XN = 0.4124564 + 0.3575761 + 0.1804375;
const ZN = 0.0193339 + 0.119192 + 0.9503041;
const EPS = Math.pow(6 / 29, 3);

function labFInv(t: number): number {
  return t > 6 / 29 ? t * t * t : 3 * Math.pow(6 / 29, 2) * (t - 4 / 29);
}

/** CIE L* → relative luminance Y (0..1). */
export function lToY(L: number): number {
  return labFInv((L + 16) / 116);
}

/** Relative luminance Y (0..1) → CIE L*. */
export function yToL(Y: number): number {
  const f = Y > EPS ? Math.cbrt(Y) : Y / (3 * Math.pow(6 / 29, 2)) + 4 / 29;
  return 116 * f - 16;
}

/** CIELAB (D65) → linear sRGB, unclamped (may leave 0..1 for out-of-gamut colours). */
export function labToLinear(lab: Lab): [number, number, number] {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const x = labFInv(fy + a / 500) * XN;
  const y = labFInv(fy);
  const z = labFInv(fy - b / 200) * ZN;
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

export function linearToSrgb8(c: number): number {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

const SRGB_LUT_SIZE = 4096;
const SRGB_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(SRGB_LUT_SIZE + 1);
  for (let i = 0; i <= SRGB_LUT_SIZE; i++) lut[i] = linearToSrgb8(i / SRGB_LUT_SIZE);
  return lut;
})();

/** Fast linear → 8-bit sRGB for values already clamped to 0..1. */
function encode8(c: number): number {
  return SRGB_LUT[(c * SRGB_LUT_SIZE + 0.5) | 0]!;
}

/** CIELAB → 8-bit sRGB (clipped). */
export function labToSrgb8(lab: Lab): [number, number, number] {
  const [r, g, b] = labToLinear(lab);
  return [linearToSrgb8(r), linearToSrgb8(g), linearToSrgb8(b)];
}

/** Per-pixel CIELAB of an RGBA image as three planes. */
export function labPlanes(img: Rgba): { L: Float32Array; A: Float32Array; B: Float32Array } {
  const n = img.width * img.height;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const lab = srgbToLab(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!);
    L[i] = lab[0];
    A[i] = lab[1];
    B[i] = lab[2];
  }
  return { L, A, B };
}

/* ───────────────────────── Masks ───────────────────────── */

/** Even-odd scanline fill of a polygon (pixel centres) into a 0/1 mask. */
export function rasterPolygon(width: number, height: number, poly: Polygon, into?: Uint8Array): Uint8Array {
  const mask = into ?? new Uint8Array(width * height);
  if (poly.length < 3) return mask;
  const xs: number[] = [];
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const x1 = Math.min(width - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = x0; x <= x1; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Binary dilation (r > 0) or erosion (r < 0) with a square structuring element (separable). */
export function morph(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r === 0) return mask.slice();
  const rad = Math.abs(r);
  const want = r > 0 ? 1 : 0; // dilation spreads 1s, erosion spreads 0s
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = 1 - want;
      for (let k = Math.max(0, x - rad); k <= Math.min(width - 1, x + rad); k++) {
        if (mask[row + k] === want) {
          v = want;
          break;
        }
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let v = 1 - want;
      for (let k = Math.max(0, y - rad); k <= Math.min(height - 1, y + rad); k++) {
        if (tmp[k * width + x] === want) {
          v = want;
          break;
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/** 8-connected component labels of a 0/1 mask; returns labels (0 = background) and sizes (index = label). */
export function components(mask: Uint8Array, width: number, height: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(mask.length);
  const sizes: number[] = [0];
  const stack: number[] = [];
  let next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    next += 1;
    let size = 0;
    labels[i] = next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || (dx === 0 && dy === 0)) continue;
          const q = yy * width + xx;
          if (mask[q] && !labels[q]) {
            labels[q] = next;
            stack.push(q);
          }
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Keep the largest 8-connected component plus any component at least `minFrac` of its size. */
export function keepLargest(mask: Uint8Array, width: number, height: number, minFrac = 1): Uint8Array {
  const { labels, sizes } = components(mask, width, height);
  let best = 0;
  for (let l = 1; l < sizes.length; l++) if (sizes[l]! > (sizes[best] ?? 0)) best = l;
  const out = new Uint8Array(mask.length);
  if (!best) return out;
  const keep = sizes.map((s, l) => l === best || (l > 0 && s >= sizes[best]! * minFrac));
  for (let i = 0; i < mask.length; i++) if (keep[labels[i]!]) out[i] = 1;
  return out;
}

/** Fill background regions not connected to the border (4-connected) that are at most `maxArea` pixels. */
export function fillHoles(mask: Uint8Array, width: number, height: number, maxArea: number): Uint8Array {
  const out = mask.slice();
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  const region: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || seen[i]) continue;
    region.length = 0;
    let touchesBorder = false;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      region.push(p);
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      const nb = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
      for (const q of nb) {
        if (q >= 0 && !mask[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (!touchesBorder && region.length <= maxArea) for (const p of region) out[p] = 1;
  }
  return out;
}

/** Separable box blur of an 8-bit plane (radius r), used twice for a cheap Gaussian-like feather. */
export function boxBlur(plane: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return plane.slice();
  const tmp = new Float32Array(plane.length);
  const out = new Uint8Array(plane.length);
  const win = 2 * r + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += plane[row + clamp(k, 0, width - 1)]!;
    for (let x = 0; x < width; x++) {
      tmp[row + x] = acc / win;
      acc += plane[row + clamp(x + r + 1, 0, width - 1)]! - plane[row + clamp(x - r, 0, width - 1)]!;
    }
  }
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, height - 1) * width + x]!;
    for (let y = 0; y < height; y++) {
      out[y * width + x] = Math.round(acc / win);
      acc += tmp[clamp(y + r + 1, 0, height - 1) * width + x]! - tmp[clamp(y - r, 0, height - 1) * width + x]!;
    }
  }
  return out;
}

/** Box blur of a float plane (radius r, `passes` passes ≈ Gaussian for 3). */
export function boxBlurF(plane: Float32Array, width: number, height: number, r: number, passes = 3): Float32Array {
  let src = plane;
  if (r <= 0) return plane.slice();
  const win = 2 * r + 1;
  for (let pass = 0; pass < passes; pass++) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, width - 1)]!;
      for (let x = 0; x < width; x++) {
        tmp[row + x] = acc / win;
        acc += src[row + clamp(x + r + 1, 0, width - 1)]! - src[row + clamp(x - r, 0, width - 1)]!;
      }
    }
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, height - 1) * width + x]!;
      for (let y = 0; y < height; y++) {
        out[y * width + x] = acc / win;
        acc += tmp[clamp(y + r + 1, 0, height - 1) * width + x]! - tmp[clamp(y - r, 0, height - 1) * width + x]!;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Normalised blur: the blur of `plane` restricted to pixels where `weight` > 0, so values from
 * outside the garment never bleed in. Pixels with no weighted neighbours get `fallback`.
 */
export function maskedBlur(
  plane: Float32Array,
  weight: Float32Array,
  width: number,
  height: number,
  r: number,
  fallback = 0,
): Float32Array {
  const num = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) num[i] = plane[i]! * weight[i]!;
  const bn = boxBlurF(num, width, height, r);
  const bw = boxBlurF(weight, width, height, r);
  const out = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) out[i] = bw[i]! > 1e-4 ? bn[i]! / bw[i]! : fallback;
  return out;
}

/**
 * Paint over small regions (sewn-in labels, accession tags, stains) with a smooth fill taken
 * from the surrounding fabric, so they don't survive recolouring as odd patches.
 */
export function patchRegions(img: Rgba, alpha: Uint8Array, polys: readonly Polygon[]): Rgba {
  if (!polys.length) return img;
  const { width, height } = img;
  const n = width * height;
  const data = img.data.slice();
  for (const poly of polys) {
    const region = rasterPolygon(width, height, poly);
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const r = Math.max(6, Math.round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 3));
    const weight = new Float32Array(n);
    for (let i = 0; i < n; i++) weight[i] = !region[i] && alpha[i]! >= 250 ? 1 : 0;
    for (let c = 0; c < 3; c++) {
      const plane = new Float32Array(n);
      for (let i = 0; i < n; i++) plane[i] = data[i * 4 + c]!;
      const filled = maskedBlur(plane, weight, width, height, r, 128);
      for (let i = 0; i < n; i++) if (region[i]) data[i * 4 + c] = Math.round(clamp(filled[i]!, 0, 255));
    }
  }
  return { data, width, height };
}

/** Bounding box of pixels where plane[i] >= thr, or null when there are none. */
export function bbox(
  plane: Uint8Array,
  width: number,
  height: number,
  thr = 1,
): { left: number; top: number; width: number; height: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (plane[y * width + x]! >= thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/* ───────────────────────── Background matting ───────────────────────── */

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Running median of a 1-D profile (window clamped at the ends): bridges a garment touching the border. */
function runningMedian(profile: Float32Array, win: number): Float32Array {
  const out = new Float32Array(profile.length);
  const half = Math.max(1, Math.floor(win / 2));
  const buf: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    buf.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(profile.length - 1, i + half); k++) buf.push(profile[k]!);
    out[i] = median(buf);
  }
  return out;
}

export interface BackgroundModel {
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
}

/**
 * Smooth background estimate: robust Lab profiles along the four borders (per-column / per-row
 * medians over a `ring`-pixel band, then a wide running median), blended inwards with a bilinear
 * Coons patch. Handles gradients and vignetting on a wall, sheet or studio sweep. `flat` uses one
 * colour (the median of the whole ring) instead.
 */
export function backgroundModel(
  lab: { L: Float32Array; A: Float32Array; B: Float32Array },
  width: number,
  height: number,
  opts: { ring?: number; flat?: boolean } = {},
): BackgroundModel {
  const ring = Math.max(1, Math.min(opts.ring ?? Math.max(4, Math.round(Math.min(width, height) * 0.01)), Math.floor(Math.min(width, height) / 4)));
  const planes = [lab.L, lab.A, lab.B];
  const n = width * height;
  const out = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n) };
  const outs = [out.L, out.A, out.B];

  if (opts.flat) {
    planes.forEach((plane, c) => {
      const vals: number[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (x < ring || y < ring || x >= width - ring || y >= height - ring) vals.push(plane[y * width + x]!);
        }
      }
      outs[c]!.fill(median(vals));
    });
    return out;
  }

  planes.forEach((plane, c) => {
    const top = new Float32Array(width);
    const bottom = new Float32Array(width);
    const left = new Float32Array(height);
    const right = new Float32Array(height);
    const vals: number[] = [];
    for (let x = 0; x < width; x++) {
      vals.length = 0;
      for (let y = 0; y < ring; y++) vals.push(plane[y * width + x]!);
      top[x] = median(vals);
      vals.length = 0;
      for (let y = height - ring; y < height; y++) vals.push(plane[y * width + x]!);
      bottom[x] = median(vals);
    }
    for (let y = 0; y < height; y++) {
      vals.length = 0;
      for (let x = 0; x < ring; x++) vals.push(plane[y * width + x]!);
      left[y] = median(vals);
      vals.length = 0;
      for (let x = width - ring; x < width; x++) vals.push(plane[y * width + x]!);
      right[y] = median(vals);
    }
    const T = runningMedian(top, Math.round(width * 0.25));
    const Bt = runningMedian(bottom, Math.round(width * 0.25));
    const Lf = runningMedian(left, Math.round(height * 0.25));
    const R = runningMedian(right, Math.round(height * 0.25));
    const p00 = (T[0]! + Lf[0]!) / 2;
    const p10 = (T[width - 1]! + R[0]!) / 2;
    const p01 = (Bt[0]! + Lf[height - 1]!) / 2;
    const p11 = (Bt[width - 1]! + R[height - 1]!) / 2;
    const o = outs[c]!;
    for (let y = 0; y < height; y++) {
      const v = height > 1 ? y / (height - 1) : 0;
      for (let x = 0; x < width; x++) {
        const u = width > 1 ? x / (width - 1) : 0;
        o[y * width + x] =
          (1 - v) * T[x]! +
          v * Bt[x]! +
          (1 - u) * Lf[y]! +
          u * R[y]! -
          ((1 - u) * (1 - v) * p00 + u * (1 - v) * p10 + (1 - u) * v * p01 + u * v * p11);
      }
    }
  });
  return out;
}

export interface MatteOptions {
  /** ΔE threshold (Lab distance to the background model) above which a pixel is garment. Default 12. */
  tolerance?: number;
  /** Weight of the L* difference in the distance (lower it to ignore soft shadows on the wall). Default 1. */
  lightnessWeight?: number;
  /** Single median background colour instead of the interpolated border model. */
  flat?: boolean;
  /** Border band (px) used to sample the background. */
  ring?: number;
  /** Fill enclosed background holes up to this fraction of the image area. Default 0.004. */
  holeMaxFrac?: number;
  /** Also keep components at least this fraction of the largest (detached ties, sleeves). Default 0.04. */
  minComponentFrac?: number;
  /** Forced background (stands, dress-form necks, clips): polygons in image pixels. */
  erase?: readonly Polygon[];
  /** Forced garment (e.g. a white collar that matches the wall): polygons in image pixels. */
  include?: readonly Polygon[];
  /** Feather radius in px (two box-blur passes). Default 1. */
  feather?: number;
  /** Edge smoothing radius in px (blur + re-threshold of the binary mask). Default 2. */
  smooth?: number;
  /**
   * Drop pixels whose Lab distance from the garment's median colour exceeds this (dress-form
   * necks, stands, a dark lining showing under a hem). Off by default.
   */
  garmentDistance?: number;
}

/** Garment alpha (0..255) of an RGBA photo on a plain-ish background. */
export function matte(img: Rgba, opts: MatteOptions = {}): { alpha: Uint8Array; mask: Uint8Array; distance: Float32Array } {
  const { width, height } = img;
  const n = width * height;
  const lab = labPlanes(img);
  const bg = backgroundModel(lab, width, height, { ring: opts.ring, flat: opts.flat });
  const tol = opts.tolerance ?? 12;
  const wL = opts.lightnessWeight ?? 1;
  const distance = new Float32Array(n);
  let mask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dL = (lab.L[i]! - bg.L[i]!) * wL;
    const da = lab.A[i]! - bg.A[i]!;
    const db = lab.B[i]! - bg.B[i]!;
    const d = Math.sqrt(dL * dL + da * da + db * db);
    distance[i] = d;
    if (d > tol) mask[i] = 1;
  }
  for (const poly of opts.include ?? []) rasterPolygon(width, height, poly, mask);
  if (opts.erase?.length) {
    const erase = new Uint8Array(n);
    for (const poly of opts.erase) rasterPolygon(width, height, poly, erase);
    for (let i = 0; i < n; i++) if (erase[i]) mask[i] = 0;
  }
  if (opts.garmentDistance !== undefined) {
    const ls: number[] = [];
    const as: number[] = [];
    const bs: number[] = [];
    for (let i = 0; i < n; i += 3) {
      if (!mask[i]) continue;
      ls.push(lab.L[i]!);
      as.push(lab.A[i]!);
      bs.push(lab.B[i]!);
    }
    if (ls.length) {
      const mL = median(ls);
      const mA = median(as);
      const mB = median(bs);
      const maxD = opts.garmentDistance;
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const d = Math.hypot(lab.L[i]! - mL, lab.A[i]! - mA, lab.B[i]! - mB);
        if (d > maxD) mask[i] = 0;
      }
    }
  }
  // Open (drop speckle), keep the garment, close small gaps, fill enclosed holes.
  mask = morph(morph(mask, width, height, -1), width, height, 1);
  mask = keepLargest(mask, width, height, opts.minComponentFrac ?? 0.04);
  mask = morph(morph(mask, width, height, 2), width, height, -2);
  mask = fillHoles(mask, width, height, Math.round(n * (opts.holeMaxFrac ?? 0.004)));
  const smooth = Math.max(0, Math.round(opts.smooth ?? 2));
  if (smooth) {
    // Round off jagged threshold edges: blur the binary mask and re-threshold at 50%.
    const plane = new Uint8Array(n);
    for (let i = 0; i < n; i++) plane[i] = mask[i] ? 255 : 0;
    const soft = boxBlur(boxBlur(plane, width, height, smooth), width, height, smooth);
    for (let i = 0; i < n; i++) mask[i] = soft[i]! >= 128 ? 1 : 0;
  }
  if (opts.erase?.length) {
    // Erased regions stay erased even after closing.
    const erase = new Uint8Array(n);
    for (const poly of opts.erase) rasterPolygon(width, height, poly, erase);
    for (let i = 0; i < n; i++) if (erase[i]) mask[i] = 0;
  }
  const f = Math.max(0, Math.round(opts.feather ?? 1));
  const plane = new Uint8Array(n);
  for (let i = 0; i < n; i++) plane[i] = mask[i] ? 255 : 0;
  const alpha = f ? boxBlur(boxBlur(plane, width, height, f), width, height, f) : plane;
  return { alpha, mask, distance };
}

/**
 * Replace the colour of edge pixels (alpha < 255, or within `inset` px of the mask edge) with the
 * average of nearby interior pixels, so the old background never tints the feathered rim.
 */
export function decontaminate(img: Rgba, alpha: Uint8Array, inset = 2): Rgba {
  const { width, height } = img;
  const n = width * height;
  const data = img.data.slice();
  let valid: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = alpha[i] === 255 ? 1 : 0;
  valid = morph(valid, width, height, -inset);
  const todo: number[] = [];
  for (let i = 0; i < n; i++) if (!valid[i] && alpha[i]! > 0) todo.push(i);
  for (let pass = 0; pass < inset + 8 && todo.length; pass++) {
    const fixed: number[] = [];
    const rest: number[] = [];
    for (const p of todo) {
      const x = p % width;
      const y = (p - x) / width;
      let r = 0;
      let g = 0;
      let b = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const q = yy * width + xx;
          if (!valid[q]) continue;
          r += data[q * 4]!;
          g += data[q * 4 + 1]!;
          b += data[q * 4 + 2]!;
          k++;
        }
      }
      if (k) {
        data[p * 4] = Math.round(r / k);
        data[p * 4 + 1] = Math.round(g / k);
        data[p * 4 + 2] = Math.round(b / k);
        fixed.push(p);
      } else rest.push(p);
    }
    for (const p of fixed) valid[p] = 1;
    todo.length = 0;
    todo.push(...rest);
  }
  for (let i = 0; i < n; i++) data[i * 4 + 3] = alpha[i]!;
  return { data, width, height };
}

/* ───────────────────────── Geometry ───────────────────────── */

/**
 * Lengthen (extraPx > 0) or shorten (extraPx < 0) everything below row `y0` by `extraPx` rows,
 * with the stretch easing in over `ramp` rows so there is no visible seam at the waist.
 */
export function stretchBelow(img: Rgba, y0: number, extraPx: number, ramp = Math.round(img.height * 0.08)): Rgba {
  const { width, height } = img;
  const extra = Math.round(extraPx);
  if (extra === 0) return { data: img.data.slice(), width, height };
  const start = clamp(Math.round(y0), 0, height - 1);
  const span = height - start;
  const r = Math.max(1, Math.min(ramp, Math.floor(span / 2)));
  // Stretch density ramps linearly from 1 to k over r rows, then stays k:
  //   total(span) = span + (k - 1)(span - r/2) = span + extra
  const k = 1 + extra / (span - r / 2);
  const outH = height + extra;
  // dest(y) for source row y (monotone), sampled at row centres.
  const destOf = (ys: number): number => {
    if (ys <= start) return ys;
    const t = ys - start;
    if (t <= r) return start + t + ((k - 1) * t * t) / (2 * r);
    return start + r + ((k - 1) * r) / 2 + k * (t - r);
  };
  const out = new Uint8Array(width * outH * 4);
  let ys = 0;
  for (let yd = 0; yd < outH; yd++) {
    const target = yd + 0.5;
    // Find the fractional source row whose destination is `target` (bisection; monotone).
    let lo = Math.max(0, ys - 2);
    let hi = height;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (destOf(mid) < target) lo = mid;
      else hi = mid;
    }
    const src = clamp((lo + hi) / 2 - 0.5, 0, height - 1);
    ys = Math.floor(src);
    const y1 = Math.min(height - 1, ys + 1);
    const w = src - ys;
    const a = ys * width * 4;
    const b = y1 * width * 4;
    const o = yd * width * 4;
    for (let i = 0; i < width * 4; i++) out[o + i] = Math.round(img.data[a + i]! * (1 - w) + img.data[b + i]! * w);
  }
  return { data: out, width, height: outH };
}

export function flipHorizontal(img: Rgba): Rgba {
  const { width, height } = img;
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (y * width + (width - 1 - x)) * 4;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
      out[d + 3] = img.data[s + 3]!;
    }
  }
  return { data: out, width, height };
}

/* ───────────────────────── Recolouring ───────────────────────── */

export interface RecolourOptions {
  /** Pixels (same size as the image) to leave untouched, e.g. a hanger hook. */
  protect?: Uint8Array | null;
  /** Shading strength: 1 keeps the photo's L* deviations, < 1 flattens, > 1 deepens. Default 1. */
  shading?: number;
  /** L* range the result may use. Defaults 3..97: blacks keep visible folds, whites keep shadows. */
  floorL?: number;
  ceilL?: number;
  /** Calibration passes nudging the base colour until the garment's mean Lab sits on the target. */
  passes?: number;
  /** Damp lightness variation broader than `radius` px to `keep` (0..1) of its strength. */
  largeScale?: { keep: number; radius: number };
}

export interface RecolourResult {
  image: Rgba;
  /** Mean CIELAB of the opaque, unprotected garment pixels of the result. */
  meanLab: Lab;
  /** CIEDE2000 between meanLab and the target. */
  deltaE: number;
}

function percentile(sorted: Float32Array, q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

/** Mean CIELAB of RGBA pixels with alpha >= minAlpha and not in `exclude`. */
export function meanLabOf(img: Rgba, minAlpha = 250, exclude?: Uint8Array | null): Lab | null {
  let sL = 0;
  let sA = 0;
  let sB = 0;
  let k = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (img.data[p + 3]! < minAlpha || exclude?.[i]) continue;
    const lab = srgbToLab(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!);
    sL += lab[0];
    sA += lab[1];
    sB += lab[2];
    k++;
  }
  return k ? [sL / k, sA / k, sB / k] : null;
}

/**
 * Recolour a garment toward `targetHex` in CIELAB while keeping the photo's shading:
 *   - chroma and hue come from the target (the source garment's own colour is discarded);
 *   - L* deviations from the garment's mean are kept (scaled by `shading`) and compressed
 *     asymmetrically near the ends of the range, so a black garment keeps highlights and
 *     visible folds and a white one keeps its shadows instead of clipping;
 *   - each pixel is the base colour under a different illumination (linear RGB × Y'/Y), which
 *     keeps the hue steady from shadow to highlight; highlights that leave the gamut are
 *     desaturated toward their own grey level;
 *   - a few calibration passes nudge the base colour so the measured mean Lab of the result
 *     lands on the target (what the fidelity gate and the dev double compare against).
 */
export function recolour(img: Rgba, targetHex: string, opts: RecolourOptions = {}): RecolourResult {
  const { width, height } = img;
  const n = width * height;
  const protect = opts.protect ?? null;
  const target = hexToLab(targetHex);
  const floorL = opts.floorL ?? 3;
  const ceilL = opts.ceilL ?? 97;
  const shading = opts.shading ?? 1;

  let srcL = new Float32Array(n);
  const inSample = (i: number): boolean => img.data[i * 4 + 3]! >= 250 && !protect?.[i];
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (!img.data[p + 3]) continue;
    srcL[i] = srgbToLab(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!)[0];
  }
  if (opts.largeScale && opts.largeScale.keep < 1) {
    // Damp broad lightness differences (stains, a two-tone bodice, uneven studio light) while
    // keeping folds and texture: L = mean + keep·(low − mean) + (L − low).
    const weight = new Float32Array(n);
    let sum = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!inSample(i)) continue;
      weight[i] = 1;
      sum += srcL[i]!;
      k++;
    }
    const mean0 = k ? sum / k : 50;
    const low = maskedBlur(srcL, weight, width, height, Math.max(2, Math.round(opts.largeScale.radius)), mean0);
    const keep = clamp(opts.largeScale.keep, 0, 1);
    const adjusted = new Float32Array(n);
    for (let i = 0; i < n; i++) adjusted[i] = mean0 + (low[i]! - mean0) * keep + (srcL[i]! - low[i]!);
    srcL = adjusted;
  }
  const sample: number[] = [];
  for (let i = 0; i < n; i++) if (inSample(i)) sample.push(srcL[i]!);
  const sorted = Float32Array.from(sample).sort();
  const meanL = sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : 50;
  const p2 = percentile(sorted, 0.02);
  const p98 = percentile(sorted, 0.98);

  const render = (base: Lab): Rgba => {
    const Lb = clamp(base[0], floorL + 0.5, ceilL - 0.5);
    const lin = labToLinear([Lb, base[1], base[2]]).map((c) => Math.max(0, c)) as [number, number, number];
    const Yb = Math.max(1e-6, lToY(Lb));
    const kDown = Math.min(shading, (Lb - floorL) / Math.max(1e-3, meanL - p2));
    const kUp = Math.min(shading, (ceilL - Lb) / Math.max(1e-3, p98 - meanL));
    const out = new Uint8Array(img.data.length);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const a = img.data[p + 3]!;
      if (!a || protect?.[i]) {
        out[p] = img.data[p]!;
        out[p + 1] = img.data[p + 1]!;
        out[p + 2] = img.data[p + 2]!;
        out[p + 3] = a;
        continue;
      }
      const dev = srcL[i]! - meanL;
      const L = clamp(Lb + dev * (dev < 0 ? kDown : kUp), floorL, ceilL);
      const Y = lToY(L);
      const f = Y / Yb;
      let r = lin[0] * f;
      let g = lin[1] * f;
      let b = lin[2] * f;
      const mx = Math.max(r, g, b);
      if (mx > 1) {
        // Out of gamut: blend toward the pixel's own grey (same Y) until it fits.
        const s = Y >= 1 ? 0 : (1 - Y) / (mx - Y);
        r = Y + (r - Y) * s;
        g = Y + (g - Y) * s;
        b = Y + (b - Y) * s;
      }
      out[p] = encode8(clamp(r, 0, 1));
      out[p + 1] = encode8(clamp(g, 0, 1));
      out[p + 2] = encode8(clamp(b, 0, 1));
      out[p + 3] = a;
    }
    return { data: out, width, height };
  };

  let base: Lab = [...target];
  let image = render(base);
  let mean = meanLabOf(image, 250, protect) ?? target;
  let dE = deltaE2000(mean, target);
  for (let pass = 0; pass < (opts.passes ?? 5) && dE > 0.4; pass++) {
    base = [
      clamp(base[0] + (target[0] - mean[0]), floorL + 0.5, ceilL - 0.5),
      base[1] + (target[1] - mean[1]),
      base[2] + (target[2] - mean[2]),
    ];
    const nextImage = render(base);
    const nextMean = meanLabOf(nextImage, 250, protect) ?? target;
    const nextDE = deltaE2000(nextMean, target);
    if (nextDE >= dE) break;
    image = nextImage;
    mean = nextMean;
    dE = nextDE;
  }
  return { image, meanLab: mean, deltaE: dE };
}

/** Composite an RGBA garment onto a white RGB canvas at (left, top). */
export function composeOnWhite(garment: Rgba, canvasW: number, canvasH: number, left: number, top: number): Uint8Array {
  const out = new Uint8Array(canvasW * canvasH * 3).fill(255);
  for (let y = 0; y < garment.height; y++) {
    const cy = y + top;
    if (cy < 0 || cy >= canvasH) continue;
    for (let x = 0; x < garment.width; x++) {
      const cx = x + left;
      if (cx < 0 || cx >= canvasW) continue;
      const s = (y * garment.width + x) * 4;
      const a = garment.data[s + 3]! / 255;
      if (a === 0) continue;
      const d = (cy * canvasW + cx) * 3;
      out[d] = Math.round(garment.data[s]! * a + 255 * (1 - a));
      out[d + 1] = Math.round(garment.data[s + 1]! * a + 255 * (1 - a));
      out[d + 2] = Math.round(garment.data[s + 2]! * a + 255 * (1 - a));
    }
  }
  return out;
}

/* ───────────────────────── PNG text markers ───────────────────────── */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert tEXt chunks (Latin-1 key/value) right after IHDR. */
export function addPngText(png: Buffer, entries: Record<string, string>): Buffer {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIG)) throw new Error("Not a PNG");
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4;
  const chunks = Object.entries(entries).map(([k, v]) => {
    const data = Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "latin1")]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write("tEXt", 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  });
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}

/** All tEXt chunks of a PNG ({} for anything that isn't a PNG). */
export function readPngText(png: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIG)) return out;
  let p = 8;
  while (p + 8 <= png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString("latin1", p + 4, p + 8);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "tEXt" && p + 8 + len <= png.length) {
      const data = png.subarray(p + 8, p + 8 + len);
      const z = data.indexOf(0);
      if (z > 0) out[data.toString("latin1", 0, z)] = data.toString("latin1", z + 1);
    }
    p += 12 + len;
  }
  return out;
}

/** tEXt key both generators stamp on their output. */
export const MARKER_KEY = "TryBack";
export const MARKER_PLACEHOLDER = "placeholder";
export const MARKER_IMPORT = "catalog-import";

/** Placeholder canvas (scripts/gen-placeholders.ts); imported photos use the same frame. */
export const CANVAS = { width: 768, height: 1024, padX: 64, padY: 72 } as const;

export type CatalogFileKind = "missing" | "placeholder" | "imported" | "photo";

/**
 * What is at a catalogue path, from the TryBack tEXt marker alone:
 *   - "imported": written by scripts/import-catalog.ts
 *   - "placeholder": written by scripts/gen-placeholders.ts (every committed drawing carries it)
 *   - "photo": anything else, i.e. a product photo someone dropped in by hand, whatever its size
 *     or format (a hand-made 768×1024 PNG included). Never overwritten without an explicit --force.
 */
export async function classifyCatalogFile(file: string): Promise<CatalogFileKind> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
  return classifyCatalogBytes(buf);
}

export function classifyCatalogBytes(buf: Buffer): Exclude<CatalogFileKind, "missing"> {
  const text = readPngText(buf);
  if (text[MARKER_KEY] === MARKER_IMPORT) return "imported";
  if (text[MARKER_KEY] === MARKER_PLACEHOLDER) return "placeholder";
  return "photo";
}
