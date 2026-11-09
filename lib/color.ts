// Colour science helpers: sRGB → CIELAB (D65) and CIEDE2000.
// Isomorphic and pure (no DOM, no Node APIs): used by the client CV gate and by
// server-side retrieval. CIEDE2000 follows Sharma, Wu & Dalal (2005),
// "The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary
// Test Data, and Mathematical Observations" and matches their test data to 1e-4.

export type Lab = [number, number, number];

/* ───────────── Hex ───────────── */

const HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#C9A227" | "C9A227" | "#abc" → [r, g, b] in 0..255. Throws on malformed input. */
export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.trim();
  if (!HEX_RE.test(s)) throw new Error(`Invalid hex colour: "${hex}"`);
  let h = s.startsWith("#") ? s.slice(1) : s;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/* ───────────── sRGB → linear → XYZ (D65) → Lab ───────────── */

function srgbChannelToLinear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linearisation lookup for integer channel values (hot path for per-pixel work). */
const LINEAR_LUT: Float64Array = (() => {
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbChannelToLinear(i);
  return lut;
})();

function toLinear(c: number): number {
  if (Number.isInteger(c) && c >= 0 && c <= 255) return LINEAR_LUT[c];
  return srgbChannelToLinear(Math.min(255, Math.max(0, c)));
}

// IEC 61966-2-1 sRGB → XYZ matrix (D65). The reference white is the matrix row sums,
// so sRGB white maps to exactly L*=100, a*=b*=0.
const M = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
] as const;
const XN = M[0][0] + M[0][1] + M[0][2]; // 0.95047
const YN = M[1][0] + M[1][1] + M[1][2]; // 1.00000
const ZN = M[2][0] + M[2][1] + M[2][2]; // 1.08883

const EPS = Math.pow(6 / 29, 3); // 0.008856…
const KAPPA_INV = 1 / (3 * Math.pow(6 / 29, 2)); // 7.787…

function labF(t: number): number {
  return t > EPS ? Math.cbrt(t) : t * KAPPA_INV + 4 / 29;
}

function linearToLab(rl: number, gl: number, bl: number): Lab {
  const x = (M[0][0] * rl + M[0][1] * gl + M[0][2] * bl) / XN;
  const y = (M[1][0] * rl + M[1][1] * gl + M[1][2] * bl) / YN;
  const z = (M[2][0] * rl + M[2][1] * gl + M[2][2] * bl) / ZN;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** sRGB (0..255 per channel, D65) → CIELAB. */
export function srgbToLab(r: number, g: number, b: number): Lab {
  return linearToLab(toLinear(r), toLinear(g), toLinear(b));
}

export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex);
  return srgbToLab(r, g, b);
}

/* ───────────── CIEDE2000 ───────────── */

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const POW25_7 = Math.pow(25, 7);

function hueDeg(b: number, ap: number): number {
  if (b === 0 && ap === 0) return 0;
  const h = Math.atan2(b, ap) * DEG;
  return h >= 0 ? h : h + 360;
}

/** CIEDE2000 colour difference (kL = kC = kH = 1). */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = Math.pow((C1 + C2) / 2, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  const CpProd = C1p * C2p;
  let dhp = 0;
  if (CpProd !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(CpProd) * Math.sin((dhp / 2) * RAD);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (CpProd !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * RAD) +
    0.24 * Math.cos(2 * hbarp * RAD) +
    0.32 * Math.cos((3 * hbarp + 6) * RAD) -
    0.2 * Math.cos((4 * hbarp - 63) * RAD);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Lm50sq = (Lbarp - 50) * (Lbarp - 50);
  const SL = 1 + (0.015 * Lm50sq) / Math.sqrt(20 + Lm50sq);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * RAD) * RC;

  const tL = dLp / SL;
  const tC = dCp / SC;
  const tH = dHp / SH;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/** CIE 1976 ΔE*ab (plain Euclidean distance) — cheap, for per-pixel prefilters. */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function chroma(lab: Lab): number {
  return Math.hypot(lab[1], lab[2]);
}

/* ───────────── Masked statistics ───────────── */

/**
 * Mean CIELAB of the RGBA pixels where `mask` is non-zero. Pixels are subsampled on a
 * `step`×`step` grid (default 1 = every pixel); fully transparent pixels are skipped.
 * Returns null when fewer than `minPixels` (default 1) pixels were sampled.
 */
export function meanLabMasked(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  opts?: { step?: number; minPixels?: number },
): Lab | null {
  const step = Math.max(1, Math.floor(opts?.step ?? 1));
  const minPixels = Math.max(1, opts?.minPixels ?? 1);
  if (width <= 0 || height <= 0) return null;
  if (mask.length < width * height || rgba.length < width * height * 4) {
    throw new Error("meanLabMasked: buffer sizes do not match width×height");
  }
  let sL = 0;
  let sA = 0;
  let sB = 0;
  let n = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      const i = row + x;
      if (mask[i] === 0) continue;
      const p = i * 4;
      if (rgba[p + 3] === 0) continue;
      const lab = linearToLab(LINEAR_LUT[rgba[p]], LINEAR_LUT[rgba[p + 1]], LINEAR_LUT[rgba[p + 2]]);
      sL += lab[0];
      sA += lab[1];
      sB += lab[2];
      n++;
    }
  }
  if (n < minPixels) return null;
  return [sL / n, sA / n, sB / n];
}

/** Lab of one RGBA pixel at byte offset `p` (p = pixelIndex × 4). */
export function labAt(rgba: Uint8ClampedArray, p: number): Lab {
  return linearToLab(LINEAR_LUT[rgba[p]], LINEAR_LUT[rgba[p + 1]], LINEAR_LUT[rgba[p + 2]]);
}

/** Rec. 709 luma (0..255) of an sRGB pixel, for grayscale work. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
