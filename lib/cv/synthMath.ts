// Pure maths behind the dev gate lab's synthetic test images (lib/cv/lab.ts) and the
// threshold tuner (scripts/tune-gate.ts). No DOM: unit-tested in node.
//
// Synthetic images are for calibrating the fidelity gate only. They are never shown to
// shoppers, never sent to the try-on API, and always labelled "synthetic" in reports.

import { deltaE2000, type Lab } from "../color";

/* ───────────── Lab → sRGB (inverse of lib/color srgbToLab, D65) ───────────── */

const M_INV = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
] as const;
const XN = 0.4124564 + 0.3575761 + 0.1804375;
const YN = 0.2126729 + 0.7151522 + 0.072175;
const ZN = 0.0193339 + 0.119192 + 0.9503041;
const D = 6 / 29;

function labFInv(t: number): number {
  return t > D ? t * t * t : 3 * D * D * (t - 4 / 29);
}

function linearToSrgb255(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

/** CIELAB → sRGB 0..255 (rounded, clamped). `inGamut` is false when any channel had to be clamped. */
export function labToSrgb(lab: Lab): { rgb: [number, number, number]; inGamut: boolean } {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const x = labFInv(fx) * XN;
  const y = labFInv(fy) * YN;
  const z = labFInv(fz) * ZN;
  const lin = [
    M_INV[0][0] * x + M_INV[0][1] * y + M_INV[0][2] * z,
    M_INV[1][0] * x + M_INV[1][1] * y + M_INV[1][2] * z,
    M_INV[2][0] * x + M_INV[2][1] * y + M_INV[2][2] * z,
  ];
  let inGamut = true;
  const rgb = lin.map((c) => {
    const v = linearToSrgb255(Math.max(0, c));
    if (c < -1e-4 || v > 255.5) inGamut = false;
    return Math.min(255, Math.max(0, Math.round(v)));
  }) as [number, number, number];
  return { rgb, inGamut };
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => Math.min(255, Math.max(0, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/* ───────────── Deterministic randomness ───────────── */

/** FNV-1a hash of a string → 32-bit seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: deterministic floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────────── Colour edits ───────────── */

/**
 * A Lab offset whose CIEDE2000 distance from `base` is ≈ `targetDeltaE`, along hue angle
 * `hueDeg` in the a*b* plane with a share of lightness change (darker for light colours,
 * lighter for dark ones). Bisection on the offset length (ΔE00 is not linear in Lab).
 */
export function labOffsetForDeltaE(
  base: Lab,
  targetDeltaE: number,
  hueDeg: number,
  lightnessShare = 0.3,
): { offset: Lab; deltaE: number } {
  const h = (hueDeg * Math.PI) / 180;
  const lSign = base[0] > 50 ? -1 : 1;
  const raw: Lab = [lSign * lightnessShare, Math.cos(h), Math.sin(h)];
  const n = Math.hypot(raw[0], raw[1], raw[2]);
  const dir: Lab = [raw[0] / n, raw[1] / n, raw[2] / n];
  const at = (s: number): Lab => [Math.min(100, Math.max(0, base[0] + dir[0] * s)), base[1] + dir[1] * s, base[2] + dir[2] * s];
  let lo = 0;
  let hi = 200;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (deltaE2000(base, at(mid)) < targetDeltaE) lo = mid;
    else hi = mid;
  }
  const end = at(hi);
  return { offset: [end[0] - base[0], end[1] - base[1], end[2] - base[2]], deltaE: deltaE2000(base, end) };
}

/**
 * Recolour one pixel from a garment whose mean colour is `from` to one whose mean is `to`,
 * keeping its shading (lightness deviation, slightly compressed to limit gamut clipping)
 * and part of its chroma texture. The garment's mean maps exactly onto `to` (before clipping).
 */
export function recolourLab(px: Lab, from: Lab, to: Lab, chromaKeep = 0.6, lightnessKeep = 0.75): Lab {
  return [
    Math.min(100, Math.max(0, to[0] + (px[0] - from[0]) * lightnessKeep)),
    to[1] + (px[1] - from[1]) * chromaKeep,
    to[2] + (px[2] - from[2]) * chromaKeep,
  ];
}

/**
 * Colour distance that tolerates shading: lightness differences count half, so folds and
 * shadows of one garment stay "the same garment" while a differently coloured one doesn't.
 */
export function shadingTolerantDistance(a: Lab, b: Lab): number {
  return Math.hypot((a[0] - b[0]) * 0.5, a[1] - b[1], a[2] - b[2]);
}

/** 1 up to `near`, linear fade to 0 at `far`. */
export function softWeight(d: number, near: number, far: number): number {
  if (d <= near) return 1;
  if (d >= far) return 0;
  return (far - d) / (far - near);
}

/* ───────────── Geometry edits ───────────── */

/**
 * Hem-shift warp: for output row `y`, the (fractional) source row to sample. Rows above
 * `hipY` are untouched; [hipY, hemY] is stretched/compressed onto [hipY, hemY + shiftPx]
 * and the rest of the frame onto what is left, so the hem moves by `shiftPx` (positive =
 * longer) while the frame stays the same size.
 */
export function hemWarpSourceRow(y: number, hipY: number, hemY: number, shiftPx: number, height: number): number {
  const newHem = hemY + shiftPx;
  if (y <= hipY) return y;
  if (y <= newHem) return hipY + ((y - hipY) * (hemY - hipY)) / (newHem - hipY);
  const last = height - 1;
  if (newHem >= last) return hemY;
  return hemY + ((y - newHem) * (last - hemY)) / (last - newHem);
}

/** Whether a hem shift is possible: hip above both hems, both hems inside the frame with room below. */
export function hemShiftFeasible(hipY: number, hemY: number, shiftPx: number, height: number): boolean {
  const newHem = hemY + shiftPx;
  return hemY > hipY + 4 && newHem > hipY + 4 && hemY < height - 4 && newHem < height - 4;
}

/**
 * Lowest-first row cut: rows y ≥ the returned value hold at least `fraction` of the mask's
 * pixels (rowCounts[y] = mask pixels in row y). Returns rowCounts.length when fraction ≤ 0.
 */
export function bottomRowsForFraction(rowCounts: readonly number[], fraction: number): number {
  const total = rowCounts.reduce((a, b) => a + b, 0);
  if (fraction <= 0 || total === 0) return rowCounts.length;
  const want = Math.min(1, fraction) * total;
  let acc = 0;
  for (let y = rowCounts.length - 1; y >= 0; y--) {
    acc += rowCounts[y];
    if (acc >= want) return y;
  }
  return 0;
}

/* ───────────── Synthetic negative plan ───────────── */

/** Failure modes the tuner synthesises from each good render. */
export const NEGATIVE_KINDS = ["colour", "residue", "identity", "missing", "hem", "silhouette"] as const;
export type NegativeKind = (typeof NEGATIVE_KINDS)[number];

/** Preflight failure modes synthesised from each person photo. */
export const PREFLIGHT_NEGATIVE_KINDS = ["pf-dark", "pf-bright", "pf-blur", "pf-crop-feet"] as const;
export type PreflightNegativeKind = (typeof PREFLIGHT_NEGATIVE_KINDS)[number];

export type SynthKind = NegativeKind | "recolour" | PreflightNegativeKind;

export interface SynthSpec {
  /** Short id suffix, e.g. "colour-17". */
  id: string;
  kind: NegativeKind;
  params: Record<string, number | string>;
}

/**
 * Deterministic synthetic negatives for one good render (seeded by its id):
 * - colour: two shifts of the rendered garment, ΔE00 ≈ 15–20 and 20–25;
 * - residue: 30–50 % of the original garment pasted back (hem-up, and in patches);
 * - identity: face blurred, pixelated, or shifted sideways (proxies for a regenerated face);
 * - missing: garment area filled with background;
 * - hem: hem moved ±8–12 cm (only when the photo is calibrated);
 * - silhouette: the original photo recoloured to the target (only on silhouette-changing transitions).
 */
export function planNegatives(opts: {
  seed: string;
  kinds: readonly NegativeKind[];
  hemApplicable: boolean;
  silhouetteApplicable: boolean;
}): SynthSpec[] {
  const rnd = mulberry32(hashSeed(opts.seed));
  const r = () => rnd();
  const out: SynthSpec[] = [];
  const want = new Set(opts.kinds);
  if (want.has("colour")) {
    const hue = Math.round(r() * 360);
    const d1 = Math.round(15 + 5 * r());
    const d2 = Math.round(20 + 5 * r());
    out.push({ id: `colour-${d1}`, kind: "colour", params: { deltaE: d1, hueDeg: hue } });
    out.push({ id: `colour-${d2}`, kind: "colour", params: { deltaE: d2, hueDeg: (hue + 140) % 360 } });
  }
  if (want.has("residue")) {
    const f1 = Math.round((0.3 + 0.2 * r()) * 100) / 100;
    const f2 = Math.round((0.3 + 0.2 * r()) * 100) / 100;
    out.push({ id: `residue-hem-${Math.round(f1 * 100)}`, kind: "residue", params: { fraction: f1, mode: "hem" } });
    out.push({ id: `residue-patches-${Math.round(f2 * 100)}`, kind: "residue", params: { fraction: f2, mode: "patches" } });
  }
  if (want.has("identity")) {
    out.push({ id: "identity-blur", kind: "identity", params: { mode: "blur", strength: Math.round((0.1 + 0.06 * r()) * 1000) / 1000 } });
    out.push({ id: "identity-pixelate", kind: "identity", params: { mode: "pixelate", blocks: 5 + Math.floor(r() * 3) } });
    out.push({ id: "identity-shift", kind: "identity", params: { mode: "shift", strength: Math.round((0.2 + 0.1 * r()) * 100) / 100 } });
  }
  if (want.has("missing")) {
    out.push({ id: "missing", kind: "missing", params: { fraction: 1 } });
  }
  if (want.has("hem") && opts.hemApplicable) {
    const up = Math.round(8 + 4 * r());
    const down = Math.round(8 + 4 * r());
    out.push({ id: `hem+${up}`, kind: "hem", params: { cm: up } });
    out.push({ id: `hem-${down}`, kind: "hem", params: { cm: -down } });
  }
  if (want.has("silhouette") && opts.silhouetteApplicable) {
    out.push({ id: "silhouette-leak", kind: "silhouette", params: {} });
  }
  return out;
}

/* ───────────── Masks ───────────── */

/** Square dilation of a 0/1 mask by `r` px (separable running max). */
export function dilateMask(data: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const rad = Math.max(0, Math.round(r));
  if (rad === 0) return data.slice();
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(rad, width); x++) count += data[row + x] ? 1 : 0;
    for (let x = 0; x < width; x++) {
      const add = x + rad;
      if (add < width && data[row + add]) count++;
      const drop = x - rad - 1;
      if (drop >= 0 && data[row + drop]) count--;
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(rad, height); y++) count += tmp[y * width + x] ? 1 : 0;
    for (let y = 0; y < height; y++) {
      const add = y + rad;
      if (add < height && tmp[add * width + x]) count++;
      const drop = y - rad - 1;
      if (drop >= 0 && tmp[drop * width + x]) count--;
      out[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}
