/**
 * TryBack: placeholder product shots for the fictional "Fernweave" catalogue.
 *
 *   npm run assets                                  render every SKU (+ alt shot) into public/catalog
 *   npm run assets -- --check                       verify only: every file exists, PNG, 768×1024, <1 MB
 *   npm run assets -- --only fw-trench-stone,fw-slip-dress-black
 *   npm run assets -- --sheet ./catalog-sheet.png   also write a contact sheet for eyeballing
 *   npm run assets -- --out ./some/dir              write somewhere other than public/catalog
 *
 * Every garment is drawn as an SVG flat-lay in centimetres, from the SKU's own data:
 *   - length, chest and sleeve come from the size-M points of measure, so lengthClass and
 *     tall/petite variants are drawn to scale (one scale per category; a midi is visibly
 *     longer than a knee-length dress, and a Tall variant is longer than its Regular).
 *   - silhouette drives waist/hip/hem proportions; neckline drives the neck shape; sleeveCm
 *     null → sleeveless (straps for a V-neck slip), < 30 → short sleeves, else long sleeves.
 *   - details: collars + plackets + buttons for shirts and shirt dresses, a self-tie belt for
 *     the shirt dress, an overlap + tie for the wrap, lapels + double-breasted buttons +
 *     buckled belt for the trench, rib for knits, slub for linen, twill for gabardine,
 *     sheen for satin.
 * The primary shot is a flat-lay with a soft contact shadow; the alt shot (used by the
 * fidelity gate's retry) hangs the same garment on a wooden hanger with a wall shadow.
 * There is no text inside the images.
 *
 * These are PLACEHOLDERS. Replace public/catalog/*.png with photographed products before
 * spending live try-on credits: the try-on API needs real garment photos. Families with a
 * licensed photo in assets-src/catalog/manifest.json are rendered from it by
 * scripts/import-catalog.ts instead.
 *
 * Never overwrites a photo: existing files are kept, and even --force only regenerates files
 * that carry the placeholder tEXt marker this script writes. Imported photos
 * (scripts/import-catalog.ts marker) and hand-placed photos (no marker) are always kept.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { LENGTH_ORDER, SKUS } from "../lib/catalog";
import { MARKER_KEY, MARKER_PLACEHOLDER, addPngText, classifyCatalogFile, type CatalogFileKind } from "./lib/imaging";
import type { Category, Silhouette, Sku } from "../lib/types";

/* ───────────────────────── Canvas & limits ───────────────────────── */

const WIDTH = 768;
const HEIGHT = 1024;
const PAD_X = 64;
const PAD_Y = 72;
const MAX_BYTES = 1024 * 1024;
/** Re-encode as palette PNG above this size (keeps a margin under MAX_BYTES). */
const SOFT_MAX_BYTES = 900 * 1024;

type Vec = readonly [number, number];
type Presentation = "flat" | "hanger";
type Variant = "primary" | "alt";

/* ───────────────────────── Small vector maths ───────────────────────── */

const rad = (deg: number): number => (deg * Math.PI) / 180;
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const scl = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const vlen = (a: Vec): number => Math.hypot(a[0], a[1]);
const unit = (a: Vec): Vec => {
  const l = vlen(a) || 1;
  return [a[0] / l, a[1] / l];
};
const flipX = (a: Vec): Vec => [-a[0], a[1]];
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const f = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};
const P = (p: Vec): string => `${f(p[0])} ${f(p[1])}`;

class BBox {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  add(...pts: Vec[]): this {
    for (const [x, y] of pts) {
      this.x0 = Math.min(this.x0, x);
      this.y0 = Math.min(this.y0, y);
      this.x1 = Math.max(this.x1, x);
      this.y1 = Math.max(this.y1, y);
    }
    return this;
  }
  /** Adds the points and their mirror images across the centre line. */
  addSym(...pts: Vec[]): this {
    return this.add(...pts, ...pts.map(flipX));
  }
  /** Width when the garment centre line (x = 0) stays at the canvas centre. */
  get symWidth(): number {
    return 2 * Math.max(Math.abs(this.x0), Math.abs(this.x1));
  }
  get height(): number {
    return this.y1 - this.y0;
  }
}

/* ───────────────────────── Path building ───────────────────────── */

type Seg = { k: "L"; to: Vec } | { k: "Q"; c: Vec; to: Vec } | { k: "C"; c1: Vec; c2: Vec; to: Vec };

function segStr(s: Seg): string {
  if (s.k === "L") return ` L${P(s.to)}`;
  if (s.k === "Q") return ` Q${P(s.c)} ${P(s.to)}`;
  return ` C${P(s.c1)} ${P(s.c2)} ${P(s.to)}`;
}

function segPoints(start: Vec, segs: Seg[]): Vec[] {
  const out: Vec[] = [start];
  for (const s of segs) {
    if (s.k === "Q") out.push(s.c);
    if (s.k === "C") out.push(s.c1, s.c2);
    out.push(s.to);
  }
  return out;
}

/** The mirror image of `segs` (which run start → end on the right side), traversed end → start. */
function mirroredReverse(start: Vec, segs: Seg[]): string {
  const ends: Vec[] = [start, ...segs.map((s) => s.to)];
  let d = "";
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const from = flipX(ends[i]);
    if (s.k === "L") d += ` L${P(from)}`;
    else if (s.k === "Q") d += ` Q${P(flipX(s.c))} ${P(from)}`;
    else d += ` C${P(flipX(s.c2))} ${P(flipX(s.c1))} ${P(from)}`;
  }
  return d;
}

/** Closed outline from a right half that starts and ends on the centre line (x = 0). */
function symmetricPath(start: Vec, segs: Seg[]): string {
  return `M${P(start)}${segs.map(segStr).join("")}${mirroredReverse(start, segs)} Z`;
}

function poly(pts: Vec[], close = true): string {
  return `M${pts.map(P).join(" L")}${close ? " Z" : ""}`;
}

function evalSeg(from: Vec, s: Seg, t: number): Vec {
  const u = 1 - t;
  if (s.k === "L") return lerp(from, s.to, t);
  if (s.k === "Q") {
    return [
      u * u * from[0] + 2 * u * t * s.c[0] + t * t * s.to[0],
      u * u * from[1] + 2 * u * t * s.c[1] + t * t * s.to[1],
    ];
  }
  return [
    u * u * u * from[0] + 3 * u * u * t * s.c1[0] + 3 * u * t * t * s.c2[0] + t * t * t * s.to[0],
    u * u * u * from[1] + 3 * u * u * t * s.c1[1] + 3 * u * t * t * s.c2[1] + t * t * t * s.to[1],
  ];
}

function sampleSegs(start: Vec, segs: Seg[], steps = 24): Vec[] {
  const out: Vec[] = [start];
  let from = start;
  for (const s of segs) {
    for (let i = 1; i <= steps; i++) out.push(evalSeg(from, s, i / steps));
    from = s.to;
  }
  return out;
}

/* ───────────────────────── Colour ───────────────────────── */

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid colour "${hex}"`);
  const v = Number.parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

interface Palette {
  base: string;
  edge: string;
  seam: string;
  stitch: string;
  inside: string;
  highlight: string;
  button: string;
  buttonEdge: string;
  dark: boolean;
  /** Very light fabric (white, ecru): shading is softened so it can't grey the garment out. */
  light: boolean;
}

/**
 * `fill` is the base fill actually painted (calibrated so the garment's mean colour lands on
 * colorHex); detail colours are always derived from the catalogue colour itself.
 */
function paletteFor(sku: Sku, fill: string = sku.colorHex): Palette {
  const base = sku.colorHex;
  const lum = luminance(base);
  const dark = lum < 0.06;
  const light = lum > 0.5;
  // Detail lines go darker on mid/light fabrics and lighter on near-black ones so they stay visible.
  const detail = (darkenBy: number, lightenBy: number): string =>
    dark ? mix(base, "#ffffff", lightenBy) : mix(base, "#000000", darkenBy);
  const horn = sku.silhouette === "trench";
  const button = horn
    ? mix(base, "#2a1f17", 0.78)
    : dark
      ? mix(base, "#ffffff", 0.22)
      : light
        ? mix(base, "#8a8378", 0.16)
        : mix(base, "#ffffff", 0.2);
  return {
    base: fill,
    dark,
    light: lum > 0.72,
    edge: mix(base, "#000000", dark ? 0.45 : light ? 0.22 : 0.32),
    seam: detail(light ? 0.17 : 0.27, 0.14),
    stitch: detail(light ? 0.27 : 0.38, 0.26),
    inside: mix(base, "#000000", dark ? 0.38 : light ? 0.13 : 0.24),
    highlight: mix(base, "#ffffff", dark ? 0.1 : 0.24),
    button,
    buttonEdge: mix(button, "#000000", 0.35),
  };
}

/* ───────────────────────── Garment spec ───────────────────────── */

interface ShapeRule {
  /** Half-width ratios relative to the half-chest width. */
  waist: number;
  hip: number;
  hem: number;
  /** How much higher the side hem sits than the centre hem (cm). */
  hc: number;
  /** Shoulder half-width ÷ chest half-width. */
  shoulder: number;
  dropShoulder: boolean;
  definedWaist: boolean;
  folds: number;
}

const SHAPES: Record<Silhouette, ShapeRule> = {
  wrap: { waist: 0.79, hip: 1.01, hem: 1.2, hc: 1.8, shoulder: 0.8, dropShoulder: false, definedWaist: true, folds: 2 },
  "a-line": { waist: 0.84, hip: 1.2, hem: 1.68, hc: 3.2, shoulder: 0.82, dropShoulder: false, definedWaist: true, folds: 5 },
  shift: { waist: 0.96, hip: 1.03, hem: 1.1, hc: 0.8, shoulder: 0.84, dropShoulder: false, definedWaist: false, folds: 2 },
  bodycon: { waist: 0.78, hip: 0.98, hem: 0.9, hc: 0.6, shoulder: 0.8, dropShoulder: false, definedWaist: false, folds: 0 },
  "shirt-dress": { waist: 0.84, hip: 1.06, hem: 1.18, hc: 1.2, shoulder: 0.83, dropShoulder: false, definedWaist: true, folds: 3 },
  slip: { waist: 0.86, hip: 1.04, hem: 1.32, hc: 2.2, shoulder: 0.8, dropShoulder: false, definedWaist: false, folds: 3 },
  boxy: { waist: 1, hip: 1, hem: 1, hc: 0.4, shoulder: 0.92, dropShoulder: true, definedWaist: false, folds: 0 },
  fitted: { waist: 0.89, hip: 0.96, hem: 0.97, hc: 0.5, shoulder: 0.82, dropShoulder: false, definedWaist: false, folds: 0 },
  relaxed: { waist: 0.99, hip: 1, hem: 1.01, hc: 1, shoulder: 0.9, dropShoulder: true, definedWaist: false, folds: 1 },
  trench: { waist: 0.95, hip: 1.07, hem: 1.23, hc: 1.2, shoulder: 0.9, dropShoulder: true, definedWaist: false, folds: 2 },
};

type Texture = "none" | "rib" | "slub" | "twill" | "sheen";

function textureFor(sku: Sku): Texture {
  const fabric = sku.fabric.toLowerCase();
  if (fabric.includes("rib")) return "rib";
  if (fabric.includes("linen")) return "slub";
  if (fabric.includes("twill") || fabric.includes("gabardine")) return "twill";
  if (fabric.includes("satin")) return "sheen";
  return "none";
}

interface Spec {
  sku: Sku;
  pres: Presentation;
  category: Category;
  L: number;
  ch: number;
  S: number | null;
  nh: number;
  neckStart: Vec;
  neckSegs: Seg[];
  backDip: number;
  sh: number;
  drop: number;
  armY: number;
  wh: number;
  waistY: number;
  hh: number;
  hipY: number;
  hemH: number;
  hc: number;
  sleeveAngle: number;
  cuffW: number;
  puff: number;
  cuffStyle: "plain" | "shirt" | "rib" | "strap";
  cuffLen: number;
  texture: Texture;
  shape: ShapeRule;
  isShirtCollar: boolean;
  isLapelCoat: boolean;
  isStrappy: boolean;
}

function buildSpec(sku: Sku, pres: Presentation): Spec {
  const pom = sku.poms.M;
  const shape = SHAPES[sku.silhouette];
  const L = pom.hpsToHemCm;
  const ch = pom.halfChestCm / 2;
  const S = pom.sleeveCm;
  const isTop = sku.category === "top";
  const isOuter = sku.category === "outerwear";
  const isShirtCollar = sku.neckline === "collar" && !isOuter;
  const isLapelCoat = sku.neckline === "collar" && isOuter;
  const isStrappy = S === null && (sku.neckline === "v" || sku.silhouette === "slip");
  const lengthRank = LENGTH_ORDER.indexOf(sku.lengthClass);

  // Neckline (right half, from centre front up to the neck point at y = 0).
  let nh = 8;
  let neckStart: Vec;
  let neckSegs: Seg[];
  let backDip = 2.2;
  switch (sku.neckline) {
    case "v": {
      nh = 8;
      const depth = sku.silhouette === "wrap" ? 24 : 16;
      neckStart = [0, depth];
      neckSegs = [{ k: "Q", c: [nh * 0.52, depth * 0.45], to: [nh, 0] }];
      break;
    }
    case "crew":
      nh = 8.2;
      neckStart = [0, 8.4];
      neckSegs = [{ k: "C", c1: [nh * 0.6, 8.4], c2: [nh, 5], to: [nh, 0] }];
      break;
    case "scoop":
      nh = 10;
      neckStart = [0, 13];
      neckSegs = [{ k: "C", c1: [nh * 0.65, 13], c2: [nh, 8], to: [nh, 0] }];
      break;
    case "square":
      nh = 11;
      neckStart = [0, 12];
      neckSegs = [
        { k: "L", to: [nh - 1.3, 12] },
        { k: "Q", c: [nh, 12], to: [nh, 10.7] },
        { k: "L", to: [nh, 0] },
      ];
      backDip = 2.6;
      break;
    case "boat":
      nh = 13.5;
      neckStart = [0, 4.2];
      neckSegs = [{ k: "Q", c: [nh * 0.55, 4.2], to: [nh, 0] }];
      backDip = 1.4;
      break;
    case "collar":
    default:
      if (isOuter) {
        nh = 8.6;
        neckStart = [0, 2.4];
        neckSegs = [{ k: "Q", c: [nh * 0.6, 2.4], to: [nh, 0] }];
      } else {
        nh = 7.8;
        neckStart = [0, 8.5];
        neckSegs = [{ k: "C", c1: [nh * 0.55, 8.5], c2: [nh, 5.2], to: [nh, 0] }];
      }
      break;
  }

  const sh = ch * shape.shoulder;
  const drop = shape.dropShoulder ? 3.6 : 4.2;
  const armY = shape.dropShoulder ? 25 : sku.category === "dress" ? 21 : 20;
  const hc = isTop && isShirtCollar ? 6 : shape.hc;
  let hipY = isTop ? Math.min(57, L - 9) : isOuter ? 60 : 57;
  hipY = Math.min(hipY, L - hc - 4);
  let waistY = isOuter ? 40 : 38;
  waistY = Math.min(waistY, hipY - 8);

  const long = S !== null && S >= 30;
  let sleeveAngle = long ? (isTop ? 11 : isOuter ? 12 : 14) : 48;
  if (pres === "hanger") sleeveAngle = long ? sleeveAngle * 0.5 : sleeveAngle - 8;
  const cuffW = long ? 7 + ch * 0.12 - (sku.fit === "fitted" ? 1 : 0) : clamp(ch * 0.54, 12, 14.5);
  const texture = textureFor(sku);
  const cuffStyle: Spec["cuffStyle"] = !long
    ? "plain"
    : texture === "rib"
      ? "rib"
      : isLapelCoat
        ? "strap"
        : isShirtCollar
          ? "shirt"
          : "plain";

  return {
    sku,
    pres,
    category: sku.category,
    L,
    ch,
    S,
    nh,
    neckStart,
    neckSegs,
    backDip,
    sh,
    drop,
    armY,
    wh: ch * shape.waist,
    waistY,
    hh: ch * shape.hip,
    hipY,
    hemH: ch * shape.hem,
    hc,
    sleeveAngle,
    cuffW,
    puff: sku.silhouette === "a-line" ? 1.6 : 0.6,
    cuffStyle,
    cuffLen: cuffStyle === "rib" ? 6 : cuffStyle === "shirt" ? 6.2 : 0,
    texture,
    shape: { ...shape, folds: shape.folds + (lengthRank >= LENGTH_ORDER.indexOf("midi") ? 1 : 0) },
    isShirtCollar,
    isLapelCoat,
    isStrappy,
  };
}

/* ───────────────────────── Rendering context ───────────────────────── */

interface Ctx {
  /** Pixels per centimetre. */
  s: number;
  pal: Palette;
}

/** A stroke width given in output pixels, expressed in the drawing's centimetre units. */
const px = (ctx: Ctx, pixels: number): string => f(pixels / ctx.s);

function strokePath(ctx: Ctx, d: string, color: string, widthPx: number, extra = ""): string {
  const cap = extra.includes("stroke-linecap") ? "" : ` stroke-linecap="round"`;
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${px(ctx, widthPx)}"${cap} stroke-linejoin="round"${extra}/>`;
}

function stitchPath(ctx: Ctx, d: string, color = ctx.pal.stitch): string {
  return strokePath(
    ctx,
    d,
    color,
    1.15,
    ` stroke-dasharray="${px(ctx, 4.5)} ${px(ctx, 3.2)}" stroke-opacity="0.9"`,
  );
}

function seamPath(ctx: Ctx, d: string, widthPx = 1.4): string {
  return strokePath(ctx, d, ctx.pal.seam, widthPx, ` stroke-opacity="0.95"`);
}

function filled(d: string, fill: string, extra = ""): string {
  return `<path d="${d}" fill="${fill}"${extra}/>`;
}

/** Base fill + volume shading + texture for a panel of fabric. */
function fabricPanel(ctx: Ctx, spec: Spec, d: string, withTexture = true): string {
  const tex =
    !withTexture || spec.texture === "none"
      ? ""
      : spec.texture === "sheen"
        ? filled(d, "url(#sheen)")
        : filled(d, `url(#${spec.texture})`);
  return [
    filled(d, ctx.pal.base),
    tex,
    filled(d, "url(#volX)"),
    filled(d, "url(#volY)"),
    strokePath(ctx, d, ctx.pal.edge, 1.5, ` stroke-opacity="0.9"`),
  ].join("");
}

function button(ctx: Ctx, c: Vec, r: number, holes: 2 | 4 = 4): string {
  const { button: fill, buttonEdge } = ctx.pal;
  const h = r * 0.28;
  const holeR = r * 0.14;
  const holePts: Vec[] =
    holes === 4
      ? [
          [c[0] - h, c[1] - h],
          [c[0] + h, c[1] - h],
          [c[0] - h, c[1] + h],
          [c[0] + h, c[1] + h],
        ]
      : [
          [c[0] - h, c[1]],
          [c[0] + h, c[1]],
        ];
  return [
    `<circle cx="${f(c[0] + r * 0.12)}" cy="${f(c[1] + r * 0.2)}" r="${f(r)}" fill="#000" fill-opacity="0.16"/>`,
    `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(r)}" fill="${fill}" stroke="${buttonEdge}" stroke-width="${px(ctx, 1)}"/>`,
    `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(r * 0.72)}" fill="none" stroke="${buttonEdge}" stroke-opacity="0.35" stroke-width="${px(ctx, 0.8)}"/>`,
    ...holePts.map(
      (p) => `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${f(holeR)}" fill="${buttonEdge}" fill-opacity="0.8"/>`,
    ),
    `<path d="M${P([c[0] - r * 0.6, c[1] - r * 0.35])} Q${P([c[0] - r * 0.3, c[1] - r * 0.75])} ${P([c[0] + r * 0.2, c[1] - r * 0.72])}" fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="${px(ctx, 0.9)}" stroke-linecap="round"/>`,
  ].join("");
}

/** A tie / belt tail: a soft band from `a` to `b` with an angled cut end. */
function tailPath(a: Vec, b: Vec, w0: number, w1: number, bend: number): { d: string; pts: Vec[] } {
  const dir = unit(sub(b, a));
  const nrm: Vec = [-dir[1], dir[0]];
  const a1 = add(a, scl(nrm, w0 / 2));
  const a2 = add(a, scl(nrm, -w0 / 2));
  const b1 = add(add(b, scl(nrm, w1 / 2)), scl(dir, w1 * 0.55));
  const b2 = add(b, scl(nrm, -w1 / 2));
  const mid = add(lerp(a, b, 0.5), scl(nrm, bend));
  const c1 = add(mid, scl(nrm, w0 / 2));
  const c2 = add(mid, scl(nrm, -w0 / 2));
  return {
    d: `M${P(a1)} Q${P(c1)} ${P(b1)} L${P(b2)} Q${P(c2)} ${P(a2)} Z`,
    pts: [a1, a2, b1, b2, c1, c2],
  };
}

/* ───────────────────────── Garment builder ───────────────────────── */

interface Garment {
  bbox: BBox;
  /** Fabric silhouettes (body, sleeves, ties): used for the colour-calibration mask. */
  silhouette: string[];
  draw(ctx: Ctx): string;
}

/**
 * Sleeve, right side. P = shoulder point, A = underarm. The underarm seam runs from A along
 * the hang direction to the cuff (I); the outer edge runs from P over a rounded sleeve cap
 * to the bicep (E, full sleeve width) and then tapers to the cuff (O). Short sleeves go
 * straight from P to O with a little puff.
 */
interface SleeveGeo {
  P: Vec;
  A: Vec;
  /** Bicep point on the outer edge (long sleeves only). */
  E: Vec | null;
  O: Vec;
  I: Vec;
  /** Hang direction and the inward normal (towards the body). */
  d: Vec;
  nIn: Vec;
  /** Unit directions of the outer edge (E→O or P→O) and the underarm seam (A→I). */
  dTop: Vec;
  dUnder: Vec;
  S: number;
  short: boolean;
}

function sleeveGeo(spec: Spec, S: number): SleeveGeo {
  const P0: Vec = [spec.sh, spec.drop];
  const A: Vec = [spec.ch, spec.armY];
  const th = rad(spec.sleeveAngle);
  const d: Vec = [Math.sin(th), Math.cos(th)];
  const nOut: Vec = [Math.cos(th), -Math.sin(th)];
  const nIn = scl(nOut, -1);
  const short = S < 30;
  const armDepth = spec.armY - spec.drop;
  const under = short ? Math.max(5, S - armDepth * 0.45) : S - armDepth * 0.75;
  const I = add(A, scl(d, under));
  const O = add(I, scl(nOut, spec.cuffW));
  const E = short ? null : add(add(A, scl(nOut, Math.max(11, spec.ch * 0.56))), scl(d, 2.5));
  return {
    P: P0,
    A,
    E,
    O,
    I,
    d,
    nIn,
    dTop: unit(sub(O, E ?? P0)),
    dUnder: unit(sub(I, A)),
    S,
    short,
  };
}

function buildGarment(sku: Sku, pres: Presentation): Garment {
  const spec = buildSpec(sku, pres);
  const { L, ch, nh, sh, drop, armY, wh, waistY, hh, hipY, hemH, hc } = spec;
  const bbox = new BBox();

  /* ── Outline (right half, centre front neck → centre hem) ── */
  const segs: Seg[] = [...spec.neckSegs];
  let strapTop: Vec | null = null;
  let strapBottom: Vec | null = null;
  let cupTop: Vec | null = null;
  if (spec.isStrappy) {
    // Slip bodice: replace the shoulders with a cup edge and an underarm.
    const depth = 25;
    cupTop = [9.2, 12.5];
    strapTop = [8.4, 0];
    strapBottom = [9.0, 12.8];
    spec.neckStart = [0, depth];
    segs.length = 0;
    segs.push({ k: "Q", c: [4.6, 17.6], to: cupTop });
    segs.push({ k: "Q", c: [15.6, 18.6], to: [ch * 0.96, armY - 1] });
    segs.push({ k: "C", c1: [ch, armY + 6], c2: [wh, waistY - 8], to: [wh, waistY] });
  } else {
    segs.push({ k: "L", to: [sh, drop] });
    segs.push({
      k: "C",
      c1: [sh - 0.7, drop + (armY - drop) * 0.5],
      c2: [ch - 1.6, armY - 1.3],
      to: [ch, armY],
    });
    segs.push({
      k: "C",
      c1: [ch, armY + (waistY - armY) * 0.45],
      c2: [wh, waistY - (waistY - armY) * 0.3],
      to: [wh, waistY],
    });
  }
  const hemSideY = L - hc;
  segs.push({
    k: "C",
    c1: [wh, waistY + (hipY - waistY) * 0.42],
    c2: [hh, hipY - (hipY - waistY) * 0.35],
    to: [hh, hipY],
  });
  segs.push({
    k: "C",
    c1: [hh + (hemH - hh) * 0.22, hipY + (hemSideY - hipY) * 0.35],
    c2: [hemH - (hemH - hh) * 0.12, hemSideY - (hemSideY - hipY) * 0.3],
    to: [hemH, hemSideY],
  });
  segs.push({ k: "Q", c: [hemH * 0.45, L], to: [0, L] });
  const bodyD = symmetricPath(spec.neckStart, segs);
  bbox.addSym(...segPoints(spec.neckStart, segs));

  // Right-side polyline for "how wide is the garment at y?" lookups.
  const sideSamples = sampleSegs(spec.neckStart, segs, 32).filter((p) => p[0] > 0.01);
  const halfWidthAt = (y: number): number => {
    let best = 0;
    for (let i = 1; i < sideSamples.length; i++) {
      const a = sideSamples[i - 1];
      const b = sideSamples[i];
      if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) {
        const t = (y - a[1]) / (b[1] - a[1]);
        best = Math.max(best, a[0] + (b[0] - a[0]) * t);
      }
    }
    return best;
  };
  /** y of the hem at horizontal offset x (inverse of the hem's quadratic curve). */
  const hemY = (x: number): number => {
    const ax = Math.min(Math.abs(x), hemH);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const t = (lo + hi) / 2;
      const xt = hemH * (1 - t) * (1 - 0.1 * t);
      if (xt > ax) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    return L - hc * (1 - t) * (1 - t);
  };

  /* ── Sleeves ── */
  const sleeves: { d: string; geo: SleeveGeo; side: 1 | -1 }[] = [];
  if (spec.S !== null) {
    const geo = sleeveGeo(spec, spec.S);
    const nOut = scl(geo.nIn, -1);
    // Closing point tucked inside the body so no gap shows along the armhole seam.
    const tuck: Vec = [sh - 3.5, (drop + armY) / 2];
    if (geo.E) {
      const c1 = add(lerp(geo.P, geo.E, 0.35), [0.6, -1.6]);
      const c2 = sub(geo.E, scl(geo.d, 5));
      bbox.addSym(c1, geo.E);
      for (const side of [1, -1] as const) {
        const X = (p: Vec): Vec => [p[0] * side, p[1]];
        const under = add(lerp(geo.I, geo.A, 0.5), scl(nOut, 0.5));
        const d = `M${P(X(geo.P))} C${P(X(c1))} ${P(X(c2))} ${P(X(geo.E))} L${P(X(geo.O))} L${P(X(geo.I))} Q${P(X(under))} ${P(X(geo.A))} L${P(X(tuck))} Z`;
        sleeves.push({ d, geo, side });
      }
    } else {
      const puffC = add(lerp(geo.P, geo.O, 0.5), scl(nOut, spec.puff));
      bbox.addSym(puffC);
      for (const side of [1, -1] as const) {
        const X = (p: Vec): Vec => [p[0] * side, p[1]];
        const d = `M${P(X(geo.P))} Q${P(X(puffC))} ${P(X(geo.O))} L${P(X(geo.I))} L${P(X(geo.A))} L${P(X(tuck))} Z`;
        sleeves.push({ d, geo, side });
      }
    }
    bbox.addSym(geo.P, geo.O, geo.I, geo.A);
  }

  /* ── Hanger ── */
  const hb = spec.isStrappy ? ch * 0.95 : sh - 1.6;
  const barTopEnd = spec.isStrappy ? 3.2 : drop + 0.9;
  const barCentreTop = spec.isStrappy ? -0.6 : 0.9;
  if (pres === "hanger") bbox.add([0, -13.4], [6.4, -13.4], [-hb - 0.5, barTopEnd], [hb + 0.5, barTopEnd]);

  /* ── Detail geometry that extends the bbox ── */
  const tails: { d: string }[] = [];
  if (sku.silhouette === "wrap") {
    const knot: Vec = [-wh - 0.4, waistY + 0.4];
    for (const [end, w0, w1, bend] of [
      [[-wh - 4.8, waistY + 30] as Vec, 3.0, 2.6, -1.2],
      [[-wh + 2.6, waistY + 25.5] as Vec, 2.8, 2.4, 0.9],
    ] as const) {
      const t = tailPath(knot, end, w0, w1, bend);
      tails.push({ d: t.d });
      bbox.add(...t.pts);
    }
  }
  if (sku.silhouette === "shirt-dress") {
    const knot: Vec = [5.5, waistY + 0.5];
    for (const [end, bend] of [
      [[3.2, waistY + 23] as Vec, -0.8],
      [[9.6, waistY + 19.5] as Vec, 0.9],
    ] as const) {
      const t = tailPath(knot, end, 3.0, 2.7, bend);
      tails.push({ d: t.d });
      bbox.add(...t.pts);
    }
  }
  if (spec.isShirtCollar || spec.isLapelCoat) bbox.addSym([nh + 3.4, -3.6]);
  if (spec.isLapelCoat) bbox.addSym([18.6, 11.6]);
  if (strapTop) bbox.addSym(strapTop);

  /* ── Drawing ── */
  const draw = (ctx: Ctx): string => {
    const { pal } = ctx;
    const out: string[] = [];
    const clip = `<clipPath id="bodyClip"><path d="${bodyD}"/></clipPath>`;
    out.push(`<defs>${clip}</defs>`);

    /* Shadow (contact shadow for the flat-lay; wall shadow on the hanger). */
    const shadowShapes = [bodyD, ...sleeves.map((s) => s.d), ...tails.map((t) => t.d)];
    const sh0 = pres === "flat" ? { dx: 0.25, dy: 0.55, op: 0.1, filt: "shadowSoft" } : { dx: 1.3, dy: 1.9, op: 0.16, filt: "shadowWide" };
    out.push(
      `<g filter="url(#${sh0.filt})" opacity="${sh0.op}" transform="translate(${f(sh0.dx)} ${f(sh0.dy)})">${shadowShapes
        .map((d) => filled(d, "#000"))
        .join("")}${
        strapTop && strapBottom
          ? [1, -1]
              .map((side) =>
                strokePath(ctx, poly([[strapTop![0] * side, strapTop![1]], [strapBottom![0] * side, strapBottom![1]]], false), "#000", 0.8 * ctx.s),
              )
              .join("")
          : ""
      }${pres === "hanger" ? hangerShape(ctx, hb, barTopEnd, barCentreTop, true) : ""}</g>`,
    );

    /* Sleeves (behind the body). */
    for (const { d, geo, side } of sleeves) {
      out.push(fabricPanel(ctx, spec, d));
      out.push(sleeveDetails(ctx, spec, geo, side));
    }

    /* Inside of the garment visible through the neck opening. */
    if (spec.isStrappy && cupTop) {
      const inside = `M${P(flipX(cupTop))} Q${P([0, 16.4])} ${P(cupTop)} Q${P([4.6, 17.6])} ${P([0, 25])} Q${P([-4.6, 17.6])} ${P(flipX(cupTop))} Z`;
      out.push(filled(inside, pal.inside), filled(inside, "url(#volY)"));
    } else if (spec.isLapelCoat) {
      const inside = poly([[-nh, 0], [nh, 0], [-9, 31]]);
      out.push(filled(inside, pal.inside), filled(inside, "url(#volX)"));
    } else {
      // Under a shirt collar the back neckline sits higher, hidden by the collar band.
      const backY = spec.isShirtCollar ? -1.6 : spec.backDip;
      const inside = `M${P(spec.neckStart)}${spec.neckSegs.map(segStr).join("")} Q${P([0, backY])} ${P([-nh, 0])}${mirroredReverse(
        spec.neckStart,
        spec.neckSegs,
      )} Z`;
      out.push(filled(inside, pal.inside), filled(inside, "url(#volY)"));
    }

    /* Back collar band (shirts) or stand (coat), seen from the front. */
    if (spec.isShirtCollar || spec.isLapelCoat) {
      const w = nh + 0.5;
      const band = `M${P([-w, 0.6])} Q${P([0, -3.6])} ${P([w, 0.6])} L${P([w - 0.3, 1.6])} Q${P([0, -1.1])} ${P([-w + 0.3, 1.6])} Z`;
      out.push(filled(band, mix(pal.base, pal.inside, 0.45)), strokePath(ctx, band, pal.edge, 1.2, ` stroke-opacity="0.8"`));
      out.push(stitchPath(ctx, `M${P([-w + 0.7, 1.05])} Q${P([0, -3.0])} ${P([w - 0.7, 1.05])}`));
    }

    /* Hanger bar + hook sit inside the garment, in front of the back panel. */
    if (pres === "hanger") out.push(hangerShape(ctx, hb, barTopEnd, barCentreTop, false));

    /* Straps go over the hanger bar. */
    if (strapTop && strapBottom) {
      for (const side of [1, -1]) {
        const d = poly([[strapTop[0] * side, strapTop[1] - (pres === "hanger" ? 0.6 : 0)], [strapBottom[0] * side, strapBottom[1]]], false);
        out.push(strokePath(ctx, d, pal.edge, 0.8 * ctx.s + 2.2), strokePath(ctx, d, pal.base, 0.8 * ctx.s));
        out.push(strokePath(ctx, d, pal.highlight, 0.22 * ctx.s, ` stroke-opacity="0.55"`));
      }
    }

    /* Body. */
    out.push(fabricPanel(ctx, spec, bodyD));

    /* Interior details, clipped to the body. */
    const inner: string[] = [];
    const folds = foldLines(spec, hemY);
    if (folds.length) {
      inner.push(
        `<g filter="url(#blurFold)">${folds
          .map(
            (d) =>
              strokePath(ctx, d, "#000", 4.2, ` stroke-opacity="${pal.dark ? 0.16 : 0.085}"`) +
              `<g transform="translate(0.75 0)">${strokePath(ctx, d, "#fff", 2.6, ` stroke-opacity="${pal.dark ? 0.08 : 0.13}"`)}</g>`,
          )
          .join("")}</g>`,
      );
    }
    // Hem stitching.
    const hy = sku.silhouette === "slip" ? 0.9 : spec.texture === "rib" ? 0 : 1.6;
    if (hy > 0) {
      const a: Vec = [hemH - 0.6, hemSideY - hy];
      const c: Vec = [hemH * 0.45, L - hy];
      inner.push(stitchPath(ctx, `M${P(flipX(a))} Q${P(flipX(c))} ${P([0, L - hy])} Q${P(c)} ${P(a)}`));
    }
    // Waist seam.
    if (spec.shape.definedWaist) {
      const w = halfWidthAt(waistY) + 0.2;
      inner.push(seamPath(ctx, `M${P([-w, waistY])} Q${P([0, waistY + 1.3])} ${P([w, waistY])}`));
      inner.push(stitchPath(ctx, `M${P([-w, waistY + 0.9])} Q${P([0, waistY + 2.2])} ${P([w, waistY + 0.9])}`));
    }
    // Gathers under the waist seam of a flared skirt.
    if (sku.silhouette === "a-line") {
      const w = halfWidthAt(waistY) - 1;
      for (let x = -w; x <= w + 0.01; x += 1.45) {
        const y0 = waistY + 0.7 + 1.3 * (1 - (x / w) ** 2) * 0.9;
        inner.push(strokePath(ctx, poly([[x, y0], [x * 1.05, y0 + 3.4]], false), "#000", 1.4, ` stroke-opacity="0.09"`));
      }
    }
    // Bust darts.
    if (sku.silhouette === "shift" || sku.silhouette === "bodycon") {
      for (const side of [1, -1]) {
        const y = armY + 3.5;
        inner.push(seamPath(ctx, poly([[(halfWidthAt(y) - 0.2) * side, y], [ch * 0.5 * side, y + 1.6]], false), 1.2));
      }
    }
    // Slip: bust seam.
    if (spec.isStrappy) {
      for (const side of [1, -1]) {
        inner.push(seamPath(ctx, `M${P([0, 25])} Q${P([9 * side, 29.6])} ${P([(halfWidthAt(25.2) - 0.2) * side, 25.2])}`, 1.2));
      }
    }
    // Shirt placket (buttons are drawn on top, after the clip group).
    if (spec.isShirtCollar) {
      const top = spec.neckStart[1] - 0.2;
      const pl = 1.7;
      inner.push(filled(poly([[-pl, top], [pl, top], [pl, L + 1], [-pl, L + 1]]), "#000", ` fill-opacity="0.035"`));
      inner.push(seamPath(ctx, poly([[pl, top], [pl, L + 1]], false), 1.3));
      inner.push(stitchPath(ctx, poly([[pl - 0.45, top + 0.5], [pl - 0.45, L + 1]], false)));
      inner.push(stitchPath(ctx, poly([[-pl + 0.45, top + 0.5], [-pl + 0.45, L + 1]], false)));
    }
    // Chest pocket on shirts.
    if (spec.isShirtCollar && sku.category === "top") {
      const x0 = -ch * 0.66;
      const x1 = x0 + 10.6;
      const y0 = 18.5;
      const y1 = 30.5;
      const pocket = poly([[x0, y0], [x1, y0], [x1, y1 - 1.6], [(x0 + x1) / 2, y1], [x0, y1 - 1.6]]);
      inner.push(filled(pocket, "#000", ` fill-opacity="0.04"`), seamPath(ctx, pocket, 1.2));
      inner.push(stitchPath(ctx, poly([[x0 + 0.5, y0 + 1.6], [x1 - 0.5, y0 + 1.6]], false)));
      inner.push(
        stitchPath(ctx, poly([[x0 + 0.5, y0 + 2], [x0 + 0.5, y1 - 2], [(x0 + x1) / 2, y1 - 0.5], [x1 - 0.5, y1 - 2], [x1 - 0.5, y0 + 2]], false)),
      );
    }
    // Rib neckband + hem band on knits.
    if (spec.texture === "rib") {
      const neckFront = `M${P([-nh + 0.2, 0.9])} C${P([-nh + 0.2, 6])} ${P([-nh * 0.6, 9.3])} ${P([0, 9.3])} C${P([nh * 0.6, 9.3])} ${P([nh - 0.2, 6])} ${P([nh - 0.2, 0.9])}`;
      inner.push(strokePath(ctx, neckFront, mix(pal.base, "#000000", 0.06), 1.9 * ctx.s));
      inner.push(
        strokePath(ctx, neckFront, "#000", 1.9 * ctx.s, ` stroke-opacity="0.1" stroke-linecap="butt" stroke-dasharray="0.2 0.3"`),
      );
      inner.push(seamPath(ctx, `M${P([-nh - 0.3, 1.8])} C${P([-nh - 0.3, 7.2])} ${P([-nh * 0.62, 10.4])} ${P([0, 10.4])} C${P([nh * 0.62, 10.4])} ${P([nh + 0.3, 7.2])} ${P([nh + 0.3, 1.8])}`, 1.2));
      const bandTop = L - 5.2;
      inner.push(strokePath(ctx, poly([[-hemH - 1, L - 2.4], [hemH + 1, L - 2.4]], false), "#000", 5.6 * ctx.s, ` stroke-opacity="0.11" stroke-linecap="butt" stroke-dasharray="0.2 0.3"`));
      inner.push(seamPath(ctx, `M${P([-hemH - 1, bandTop + 0.2])} Q${P([0, bandTop + 0.5])} ${P([hemH + 1, bandTop + 0.2])}`, 1.3));
    }
    // Coat: front edge, pockets.
    if (spec.isLapelCoat) {
      inner.push(strokePath(ctx, poly([[-9, 31], [-9, L + 1]], false), "#000", 4, ` stroke-opacity="0.12" filter="url(#blurFold)"`));
      inner.push(strokePath(ctx, poly([[-9, 31], [-9, L + 1]], false), pal.edge, 1.5));
      inner.push(stitchPath(ctx, poly([[-8.3, 31.5], [-8.3, L + 1]], false)));
      for (const side of [1, -1]) {
        const a: Vec = [17.2 * side, hipY - 7.5];
        const b: Vec = [21.6 * side, hipY + 3.5];
        const welt = poly([a, b, add(b, [-2.5 * side, 0.6]), add(a, [-2.5 * side, 0.6])]);
        inner.push(filled(welt, "#000", ` fill-opacity="0.05"`), seamPath(ctx, welt, 1.2));
        inner.push(stitchPath(ctx, poly([add(a, [-0.5 * side, 0.4]), add(b, [-0.5 * side, 0.4])], false)));
      }
    }
    // Wrap: overlap edges (bodice + skirt) with a soft shadow on the under-panel.
    if (sku.silhouette === "wrap") {
      const bodice = `M${P([0, spec.neckStart[1]])} C${P([-4, spec.neckStart[1] + 6])} ${P([-wh + 5, waistY - 3])} ${P([-wh + 0.6, waistY - 1.2])}`;
      const skirtEnd: Vec = [-hemH * 0.36, hemY(-hemH * 0.36) + 0.4];
      const skirt = `M${P([-wh + 1.4, waistY + 1.8])} C${P([-wh + 3.2, waistY + 20])} ${P([-hemH * 0.44, L - 22])} ${P(skirtEnd)}`;
      for (const d of [bodice, skirt]) {
        inner.push(`<g transform="translate(-0.45 0.15)" filter="url(#blurFold)">${strokePath(ctx, d, "#000", 6, ` stroke-opacity="${pal.dark ? 0.3 : 0.16}"`)}</g>`);
        inner.push(strokePath(ctx, d, pal.edge, 1.6));
        inner.push(`<g transform="translate(0.35 0)">${strokePath(ctx, d, pal.highlight, 1.1, ` stroke-opacity="0.7"`)}</g>`);
        inner.push(`<g transform="translate(0.95 0.1)">${stitchPath(ctx, d)}</g>`);
      }
    }
    out.push(`<g clip-path="url(#bodyClip)">${inner.join("")}</g>`);

    /* Placket buttons (shirts, shirt dresses), skipping the belt. */
    if (spec.isShirtCollar) {
      const belted = sku.silhouette === "shirt-dress";
      for (let y = spec.neckStart[1] + 3.6; y < L - 6; y += 8.4) {
        if (belted && Math.abs(y - waistY) < 4) continue;
        out.push(button(ctx, [0, y], 0.62, 4));
      }
    }

    /* Self-fabric sash / belt across the waist. */
    if (sku.silhouette === "wrap" || sku.silhouette === "shirt-dress" || spec.isLapelCoat) {
      const bh = spec.isLapelCoat ? 2.6 : sku.silhouette === "wrap" ? 1.5 : 1.7;
      const w = halfWidthAt(waistY) + 0.35;
      const y0 = waistY - bh + 0.4;
      const y1 = waistY + bh + 0.4;
      const belt = `M${P([-w, y0])} Q${P([0, y0 + 1.1])} ${P([w, y0])} L${P([w, y1])} Q${P([0, y1 + 1.1])} ${P([-w, y1])} Z`;
      out.push(`<g transform="translate(0.15 0.45)" filter="url(#blurFold)">${filled(belt, "#000", ` fill-opacity="0.18"`)}</g>`);
      out.push(fabricPanel(ctx, spec, belt, spec.texture !== "sheen"));
      out.push(stitchPath(ctx, `M${P([-w + 0.3, y0 + 0.55])} Q${P([0, y0 + 1.65])} ${P([w - 0.3, y0 + 0.55])}`));
      out.push(stitchPath(ctx, `M${P([-w + 0.3, y1 - 0.55])} Q${P([0, y1 + 0.55])} ${P([w - 0.3, y1 - 0.55])}`));
      if (spec.isLapelCoat) {
        // Belt loops, buckle and loose tail.
        for (const side of [1, -1]) {
          const x = (w - 1.4) * side;
          const loop = poly([[x - 0.7, y0 - 0.9], [x + 0.7, y0 - 0.9], [x + 0.7, y1 + 1.1], [x - 0.7, y1 + 1.1]]);
          out.push(fabricPanel(ctx, spec, loop, false));
        }
        const tail = tailPath([-11.5, y1 - 0.8], [-15.5, y1 + 16], bh * 2 - 0.4, bh * 2 - 0.6, -0.8);
        out.push(fabricPanel(ctx, spec, tail.d), stitchPath(ctx, poly([lerp([-11.5, y1 - 0.8], [-15.5, y1 + 16], 0.15), lerp([-11.5, y1 - 0.8], [-15.5, y1 + 16], 0.85)], false)));
        const bx = -9;
        const buckle = `M${P([bx - 2.4, y0 - 1.2])} h4.8 v${f(y1 - y0 + 2.4)} h-4.8 Z M${P([bx - 1.6, y0 - 0.4])} v${f(y1 - y0 + 0.8)} h3.2 v${f(-(y1 - y0 + 0.8))} Z`;
        out.push(`<path d="${buckle}" fill="${pal.button}" fill-rule="evenodd" stroke="${pal.buttonEdge}" stroke-width="${px(ctx, 1)}"/>`);
        out.push(strokePath(ctx, poly([[bx - 1.6, waistY + 0.4], [bx + 1.9, waistY + 0.4]], false), pal.buttonEdge, 2.4));
      }
    }

    /* Tie tails + knot (wrap, shirt dress). */
    if (tails.length) {
      for (const t of tails) {
        out.push(`<g transform="translate(0.2 0.5)" filter="url(#blurFold)">${filled(t.d, "#000", ` fill-opacity="0.16"`)}</g>`);
        out.push(fabricPanel(ctx, spec, t.d));
      }
      const k: Vec = sku.silhouette === "wrap" ? [-wh - 0.4, waistY + 0.4] : [5.5, waistY + 0.5];
      const knot = `M${P([k[0] - 2.2, k[1]])} Q${P([k[0] - 2.2, k[1] - 2.1])} ${P([k[0], k[1] - 2.1])} Q${P([k[0] + 2.3, k[1] - 2.1])} ${P([k[0] + 2.2, k[1]])} Q${P([k[0] + 2.2, k[1] + 2.1])} ${P([k[0], k[1] + 2.1])} Q${P([k[0] - 2.2, k[1] + 2.1])} ${P([k[0] - 2.2, k[1]])} Z`;
      out.push(fabricPanel(ctx, spec, knot));
      out.push(strokePath(ctx, `M${P([k[0] - 1.1, k[1] - 1.5])} Q${P([k[0] + 0.4, k[1]])} ${P([k[0] - 0.9, k[1] + 1.6])}`, pal.seam, 1.2));
    }

    /* Shirt collar leaves. */
    if (spec.isShirtCollar) {
      const nd = spec.neckStart[1];
      for (const side of [1, -1]) {
        const X = (p: Vec): Vec => [p[0] * side, p[1]];
        const A: Vec = [0.9, nd - 0.9];
        const B: Vec = [nh + 0.3, -1.7];
        const C: Vec = [nh + 3.4, 1.5];
        const D: Vec = [nh - 0.3, nd + 3.8];
        const leaf = `M${P(X(A))} Q${P(X([nh * 0.55, 1.2]))} ${P(X(B))} L${P(X(C))} Q${P(X([nh + 2.4, nd - 1]))} ${P(X(D))} L${P(X(A))} Z`;
        out.push(`<g transform="translate(${f(0.25 * side)} 0.5)" filter="url(#blurFold)">${filled(leaf, "#000", ` fill-opacity="0.2"`)}</g>`);
        out.push(fabricPanel(ctx, spec, leaf));
        const cen: Vec = [(A[0] + B[0] + C[0] + D[0]) / 4, (A[1] + B[1] + C[1] + D[1]) / 4];
        const ins = (p: Vec): Vec => X(lerp(p, cen, 0.14));
        out.push(stitchPath(ctx, `M${P(ins(C))} L${P(ins(D))} L${P(ins(A))}`));
        if (sku.category === "top") out.push(button(ctx, X(lerp(D, cen, 0.3)), 0.42, 2));
      }
    }

    /* Trench: storm flap, epaulettes, lapels. */
    if (spec.isLapelCoat) {
      const flap = `M${P([-nh - 1.6, 0.6])} L${P([-sh + 0.6, drop - 0.3])} L${P([-sh + 0.9, 18.5])} Q${P([-sh + 2, 21.2])} ${P([-14, 20.6])} L${P([-11, 12])} Z`;
      out.push(`<g transform="translate(0.2 0.5)" filter="url(#blurFold)">${filled(flap, "#000", ` fill-opacity="0.16"`)}</g>`);
      out.push(fabricPanel(ctx, spec, flap));
      out.push(stitchPath(ctx, `M${P([-sh + 1.6, 4])} L${P([-sh + 1.9, 18])} Q${P([-sh + 2.8, 20])} ${P([-14.5, 19.6])}`));
      out.push(button(ctx, [-sh + 3.6, 17.6], 0.75, 4));
      for (const side of [1, -1]) {
        const X = (p: Vec): Vec => [p[0] * side, p[1]];
        const a: Vec = [nh + 4.5, 1.2];
        const b: Vec = [sh - 0.2, drop - 0.1];
        const dir = unit(sub(b, a));
        const nrm: Vec = [-dir[1] * 1.5, dir[0] * 1.5];
        const ep = poly([X(add(a, nrm)), X(add(b, nrm)), X(sub(b, nrm)), X(sub(a, nrm))]);
        out.push(fabricPanel(ctx, spec, ep, false));
        out.push(stitchPath(ctx, poly([X(add(lerp(a, b, 0.05), scl(nrm, 0.6))), X(add(lerp(a, b, 0.95), scl(nrm, 0.6)))], false)));
        out.push(button(ctx, X(lerp(a, b, 0.14)), 0.7, 4));
      }
      const lapel = (side: 1 | -1): string => {
        const X = (p: Vec): Vec => [p[0] * side, p[1]];
        const brk: Vec = [-9, 31];
        const neck: Vec = X([nh, 0]);
        const top: Vec = X([nh - 1, -1.4]);
        const tip: Vec = X([15.4, 3.4]);
        const notch: Vec = X([13.2, 8.2]);
        const peak: Vec = X([18.4, 11.4]);
        const outerC: Vec = side === 1 ? [10.5, 25.5] : [-16.6, 22.5];
        return `M${P(neck)} L${P(top)} Q${P(X([nh + 3.6, -1.2]))} ${P(tip)} L${P(notch)} L${P(peak)} Q${P(outerC)} ${P(brk)} L${P(neck)} Z`;
      };
      for (const side of [-1, 1] as const) {
        const d = lapel(side);
        out.push(`<g transform="translate(${f(0.3 * side)} 0.6)" filter="url(#blurFold)">${filled(d, "#000", ` fill-opacity="0.2"`)}</g>`);
        out.push(fabricPanel(ctx, spec, d));
        const X = (p: Vec): Vec => [p[0] * side, p[1]];
        out.push(seamPath(ctx, poly([X([13.2, 8.2]), X([nh + 0.9, 6.4])], false), 1.2));
        out.push(stitchPath(ctx, `M${P(X([17.2, 11.6]))} Q${P(side === 1 ? [9.6, 25] : [-15.5, 22.3])} ${P([-9.4, 29.6])}`));
      }
      // Double-breasted buttons, symmetric about the centre front.
      for (const y of [34.5, 47.5, 56]) {
        for (const x of [-6, 6]) out.push(button(ctx, [x, y], 1.05, 4));
      }
    }

    /* Hanger hook in front of everything at the neck. */
    if (pres === "hanger") out.push(hookShape(ctx));
    return out.join("");
  };

  return { bbox, silhouette: [bodyD, ...sleeves.map((s) => s.d), ...tails.map((t) => t.d)], draw };
}

/** Sleeve hems, cuffs, creases. */
function sleeveDetails(ctx: Ctx, spec: Spec, g: SleeveGeo, side: 1 | -1): string {
  const X = (p: Vec): Vec => [p[0] * side, p[1]];
  const out: string[] = [];
  /** Points `k` cm back from the cuff along the outer edge / underarm seam. */
  const backTop = (k: number): Vec => sub(g.O, scl(g.dTop, k));
  const backUnder = (k: number): Vec => sub(g.I, scl(g.dUnder, k));
  if (g.E) {
    // Soft lengthwise crease down the middle of the sleeve.
    const a = lerp(lerp(g.A, g.E, 0.5), lerp(g.I, g.O, 0.5), 0.12);
    const b = lerp(lerp(g.A, g.E, 0.5), lerp(g.I, g.O, 0.5), 0.84);
    out.push(
      `<g filter="url(#blurFold)">${strokePath(ctx, poly([X(a), X(b)], false), "#000", 3.4, ` stroke-opacity="${ctx.pal.dark ? 0.16 : 0.075}"`)}${strokePath(
        ctx,
        poly([X(add(a, [0.8, 0])), X(add(b, [0.8, 0]))], false),
        "#fff",
        2,
        ` stroke-opacity="0.12"`,
      )}</g>`,
    );
  }
  if (spec.cuffStyle === "shirt" || spec.cuffStyle === "rib") {
    const T = backTop(spec.cuffLen);
    const B = backUnder(spec.cuffLen);
    const cuffD = poly([X(T), X(g.O), X(g.I), X(B)]);
    out.push(filled(cuffD, "#000", ` fill-opacity="0.05"`), seamPath(ctx, poly([X(T), X(B)], false), 1.3));
    if (spec.cuffStyle === "shirt") {
      out.push(stitchPath(ctx, poly([X(backTop(spec.cuffLen - 0.5)), X(backUnder(spec.cuffLen - 0.5))], false)));
      out.push(stitchPath(ctx, poly([X(backTop(0.55)), X(backUnder(0.55))], false)));
      out.push(button(ctx, X(lerp(lerp(T, g.O, 0.5), lerp(B, g.I, 0.5), 0.3)), 0.5, 4));
    } else {
      // Rib: a dashed stroke across the cuff draws stripes that run along the sleeve.
      const clipId = `cuffClip${side === 1 ? "R" : "L"}`;
      const m1 = lerp(T, g.O, 0.5);
      const m2 = lerp(B, g.I, 0.5);
      const across = unit(sub(m2, m1));
      out.push(`<clipPath id="${clipId}"><path d="${cuffD}"/></clipPath>`);
      out.push(
        `<g clip-path="url(#${clipId})">${strokePath(
          ctx,
          poly([X(sub(m1, scl(across, 1.5))), X(add(m2, scl(across, 1.5)))], false),
          "#000",
          (spec.cuffLen + 3) * ctx.s,
          ` stroke-opacity="${ctx.pal.dark ? 0.22 : 0.11}" stroke-linecap="butt" stroke-dasharray="0.2 0.3"`,
        )}</g>`,
      );
    }
  } else if (spec.cuffStyle === "strap") {
    const t0 = backTop(10);
    const b0 = backUnder(10);
    const t1 = backTop(7);
    const b1 = backUnder(7);
    const outward = scl(g.nIn, -0.5);
    const strap = poly([X(add(t0, outward)), X(add(t1, outward)), X(b1), X(b0)]);
    out.push(`<g transform="translate(0.15 0.4)" filter="url(#blurFold)">${filled(strap, "#000", ` fill-opacity="0.18"`)}</g>`);
    out.push(fabricPanel(ctx, spec, strap, false));
    const bc = lerp(lerp(t0, t1, 0.5), lerp(b0, b1, 0.5), 0.24);
    out.push(
      `<rect x="${f(X(bc)[0] - 1.2)}" y="${f(bc[1] - 1.5)}" width="2.4" height="3" fill="none" stroke="${ctx.pal.button}" stroke-width="${px(ctx, 2.2)}" transform="rotate(${f(-spec.sleeveAngle * side)} ${f(X(bc)[0])} ${f(bc[1])})"/>`,
    );
    out.push(stitchPath(ctx, poly([X(backTop(1.6)), X(backUnder(1.6))], false)));
  } else {
    out.push(stitchPath(ctx, poly([X(add(backTop(1.4), scl(g.nIn, 0.3))), X(sub(backUnder(1.4), scl(g.nIn, 0.3)))], false)));
  }
  return out.join("");
}

/** Skirt / body fold lines (stroked softly, clipped to the body by the caller). */
function foldLines(spec: Spec, hemY: (x: number) => number): string[] {
  const n = spec.shape.folds;
  if (n <= 0) return [];
  const out: string[] = [];
  const top = spec.shape.definedWaist ? spec.waistY + 4 : spec.sku.category === "top" ? spec.L - 22 : spec.hipY - 6;
  const bias = spec.sku.silhouette === "slip";
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : (i / (n - 1)) * 2 - 1; // -1..1
    const xTop = u * spec.wh * 0.6 + (bias ? 3 : 0);
    const xBot = u * spec.hemH * 0.72 + (bias ? -5 + u * 2 : 0);
    const yBot = hemY(xBot) - 0.3;
    const yTop = top + Math.abs(u) * 3 + (i % 2) * 4;
    const ctrl: Vec = [(xTop + xBot) / 2 + (i % 2 === 0 ? 1.2 : -1.2), (yTop + yBot) / 2];
    out.push(`M${P([xTop, yTop])} Q${P(ctrl)} ${P([xBot, yBot])}`);
  }
  return out;
}

function hangerShape(ctx: Ctx, hb: number, endY: number, centreY: number, silhouetteOnly: boolean): string {
  const t = 1.9;
  const bar = `M${P([-hb, endY])} Q${P([0, centreY - (endY - centreY) * 0.95])} ${P([hb, endY])} Q${P([hb + 0.7, endY + t * 0.5])} ${P([hb, endY + t])} Q${P([0, centreY + t - (endY - centreY) * 0.95])} ${P([-hb, endY + t])} Q${P([-hb - 0.7, endY + t * 0.5])} ${P([-hb, endY])} Z`;
  if (silhouetteOnly) return filled(bar, "#000") + strokePath(ctx, hookD(), "#000", 0.55 * ctx.s);
  return [
    filled(bar, "url(#wood)"),
    strokePath(ctx, bar, "#7a5230", 1.1, ` stroke-opacity="0.8"`),
    `<path d="M${P([-hb * 0.8, endY + 0.35 - (endY - centreY) * 0.3])} Q${P([0, centreY + 0.2 - (endY - centreY) * 0.95])} ${P([hb * 0.8, endY + 0.35 - (endY - centreY) * 0.3])}" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="${px(ctx, 1.4)}" stroke-linecap="round"/>`,
  ].join("");
}

function hookD(): string {
  return "M0 1 L0 -6.4 C0 -11.4 6.4 -11.4 6.4 -8.2 C6.4 -6.6 5.2 -5.9 4.1 -6.3";
}

function hookShape(ctx: Ctx): string {
  return [
    strokePath(ctx, hookD(), "#7d8186", 0.55 * ctx.s),
    `<g transform="translate(-0.12 -0.1)">${strokePath(ctx, hookD(), "#d3d6da", 0.16 * ctx.s, ` stroke-opacity="0.9"`)}</g>`,
    `<rect x="-0.55" y="-0.4" width="1.1" height="1.6" rx="0.25" fill="#8d9196" stroke="#5f6368" stroke-width="${px(ctx, 0.8)}"/>`,
  ].join("");
}

/* ───────────────────────── SVG document ───────────────────────── */

function defs(ctx: Ctx): string {
  const blurPx = (pixels: number) => f(pixels / ctx.s);
  const k = ctx.pal.light ? 0.55 : 1;
  const sh = (o: number) => f(o * k);
  return `<defs>
  <linearGradient id="volX" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#000" stop-opacity="${sh(0.17)}"/>
    <stop offset="0.15" stop-color="#000" stop-opacity="${sh(0.04)}"/>
    <stop offset="0.4" stop-color="#fff" stop-opacity="0.09"/>
    <stop offset="0.58" stop-color="#fff" stop-opacity="0.05"/>
    <stop offset="0.85" stop-color="#000" stop-opacity="${sh(0.05)}"/>
    <stop offset="1" stop-color="#000" stop-opacity="${sh(0.19)}"/>
  </linearGradient>
  <linearGradient id="volY" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.07"/>
    <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="${sh(0.09)}"/>
  </linearGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0.45">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/>
    <stop offset="0.26" stop-color="#fff" stop-opacity="0.2"/>
    <stop offset="0.38" stop-color="#fff" stop-opacity="0"/>
    <stop offset="0.6" stop-color="#fff" stop-opacity="0.12"/>
    <stop offset="0.7" stop-color="#fff" stop-opacity="0"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="wood" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#a8743f"/>
    <stop offset="0.5" stop-color="#c99a64"/>
    <stop offset="1" stop-color="#a8743f"/>
  </linearGradient>
  <pattern id="rib" patternUnits="userSpaceOnUse" width="0.85" height="10">
    <rect x="0" y="0" width="0.3" height="10" fill="#000" fill-opacity="${ctx.pal.dark ? 0.2 : 0.085}"/>
    <rect x="0.46" y="0" width="0.12" height="10" fill="#fff" fill-opacity="0.08"/>
  </pattern>
  <pattern id="slub" patternUnits="userSpaceOnUse" width="3.3" height="2.1">
    <rect x="0" y="0.25" width="2.1" height="0.09" fill="#000" fill-opacity="${sh(0.06)}"/>
    <rect x="1.4" y="1.05" width="1.9" height="0.07" fill="#000" fill-opacity="${sh(0.045)}"/>
    <rect x="0.4" y="1.65" width="1.3" height="0.08" fill="#fff" fill-opacity="0.1"/>
    <rect x="2.6" y="0" width="0.06" height="2.1" fill="#000" fill-opacity="0.03"/>
  </pattern>
  <pattern id="twill" patternUnits="userSpaceOnUse" width="0.62" height="0.62" patternTransform="rotate(38)">
    <rect x="0" y="0" width="0.2" height="0.62" fill="#000" fill-opacity="${ctx.pal.dark ? 0.16 : 0.06}"/>
  </pattern>
  <filter id="shadowSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${blurPx(6)}"/></filter>
  <filter id="shadowWide" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${blurPx(13)}"/></filter>
  <filter id="blurFold" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${blurPx(2.2)}"/></filter>
</defs>`;
}

function placement(g: Garment, s: number): string {
  const tx = WIDTH / 2;
  const ty = HEIGHT / 2 - (s * (g.bbox.y0 + g.bbox.y1)) / 2;
  return `translate(${f(tx)} ${f(ty)}) scale(${f(s)})`;
}

function renderSvg(sku: Sku, g: Garment, s: number, fill: string): string {
  const ctx: Ctx = { s, pal: paletteFor(sku, fill) };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
${defs(ctx)}
<g transform="${placement(g, s)}">${g.draw(ctx)}</g>
</svg>`;
}

/** White-on-black fabric mask, shrunk 2 px so anti-aliased edges and outlines don't count. */
function maskSvg(g: Garment, s: number): string {
  const shapes = g.silhouette.map((d) => `<path d="${d}" fill="#fff" stroke="#000" stroke-width="${f(4 / s)}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#000"/>
<g transform="${placement(g, s)}">${shapes}</g>
</svg>`;
}

/* ───────────────────────── Colour calibration ───────────────────────── */

/** Mean RGB of the fabric (mask) pixels of a rendered shot. */
async function meanFabricRgb(svg: string, mask: Buffer): Promise<RGB> {
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 })
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const acc: RGB = [0, 0, 0];
  let n = 0;
  for (let i = 0, px = 0; i < data.length; i += info.channels, px++) {
    if (mask[px] < 250) continue;
    acc[0] += data[i];
    acc[1] += data[i + 1];
    acc[2] += data[i + 2];
    n++;
  }
  if (n === 0) throw new Error("Empty fabric mask");
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}

/**
 * Shading, seams and texture shift the garment's average colour (light colours darken, near-
 * blacks lighten). The try-on output and the fidelity gate both lean on colorHex, so nudge
 * the base fill until the fabric's mean colour sits on colorHex (two passes are plenty).
 */
async function calibratedFill(sku: Sku, g: Garment, s: number): Promise<{ fill: string; drift: number }> {
  const mask = await sharp(Buffer.from(maskSvg(g, s)), { density: 72 }).greyscale().raw().toBuffer();
  const target = hexToRgb(sku.colorHex);
  let fill = sku.colorHex;
  let drift = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const mean = await meanFabricRgb(renderSvg(sku, g, s, fill), mask);
    drift = Math.hypot(target[0] - mean[0], target[1] - mean[1], target[2] - mean[2]);
    if (drift < 2 || pass === 2) break;
    const cur = hexToRgb(fill);
    fill = rgbToHex([cur[0] + target[0] - mean[0], cur[1] + target[1] - mean[1], cur[2] + target[2] - mean[2]]);
  }
  return { fill, drift };
}

/* ───────────────────────── Jobs, scale, encoding ───────────────────────── */

interface Job {
  sku: Sku;
  variant: Variant;
  pres: Presentation;
  file: string;
  garment: Garment;
}

/** sku.image is "/catalog/<id>.png": keep the basename, write it into outDir. */
function outFile(outDir: string, webPath: string): string {
  return path.join(outDir, path.basename(webPath));
}

function planJobs(skus: readonly Sku[], outDir: string): Job[] {
  const jobs: Job[] = [];
  for (const sku of skus) {
    jobs.push({ sku, variant: "primary", pres: "flat", file: outFile(outDir, sku.image), garment: buildGarment(sku, "flat") });
    if (sku.altImage) {
      jobs.push({ sku, variant: "alt", pres: "hanger", file: outFile(outDir, sku.altImage), garment: buildGarment(sku, "hanger") });
    }
  }
  return jobs;
}

/** One scale per (category, presentation) so lengths compare honestly within a category. */
function scalesFor(jobs: Job[]): Map<string, number> {
  const availW = WIDTH - 2 * PAD_X;
  const availH = HEIGHT - 2 * PAD_Y;
  const scales = new Map<string, number>();
  for (const j of jobs) {
    const key = `${j.sku.category}:${j.pres}`;
    const b = j.garment.bbox;
    // Hanger shots are deliberately a touch smaller: a different framing, not just a hook.
    const fit = Math.min(availW / (b.symWidth + 2), availH / (b.height + 2)) * (j.pres === "hanger" ? 0.93 : 1);
    scales.set(key, Math.min(scales.get(key) ?? Infinity, fit));
  }
  return scales;
}

/**
 * Pixels per centimetre of the drawings, per category (the front, "flat" shot; garments are drawn
 * in cm). scripts/import-catalog.ts caps photos at the same scale, so a photographed and a drawn
 * garment of one category compare honestly in length on the results cards.
 */
export function placeholderPxPerCm(): Map<Category, number> {
  const out = new Map<Category, number>();
  for (const [key, s] of scalesFor(planJobs(SKUS, "."))) {
    const [category, pres] = key.split(":");
    if (pres === "flat") out.set(category as Category, s);
  }
  return out;
}

async function encodePng(svg: string): Promise<Buffer> {
  const raster = sharp(Buffer.from(svg), { density: 72 }).flatten({ background: "#ffffff" });
  let out = await raster.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (out.length > SOFT_MAX_BYTES) {
    out = await raster.clone().png({ compressionLevel: 9, palette: true, quality: 95, dither: 0.6 }).toBuffer();
  }
  // Marker so later runs (and scripts/import-catalog.ts) know this file is safe to regenerate.
  return addPngText(out, { [MARKER_KEY]: MARKER_PLACEHOLDER });
}

interface CheckRow {
  file: string;
  ok: boolean;
  bytes: number;
  problem: string | null;
  kind: CatalogFileKind;
}

/** Real product photos replacing a placeholder only need to be a readable image the garment prep can use. */
const MIN_PHOTO_SIDE = 256;
const MAX_PHOTO_FILE_BYTES = 20 * 1024 * 1024;

async function checkFile(file: string): Promise<CheckRow> {
  try {
    const st = await fs.stat(file);
    const meta = await sharp(file).metadata();
    const problems: string[] = [];
    const notes: string[] = [];
    if (meta.format !== "png" && meta.format !== "jpeg" && meta.format !== "webp") {
      problems.push(`format ${meta.format ?? "unknown"}`);
    }
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_PHOTO_SIDE) {
      problems.push(`${meta.width}×${meta.height} (min side ${MIN_PHOTO_SIDE})`);
    }
    if (st.size > MAX_PHOTO_FILE_BYTES) problems.push(`${(st.size / 1048576).toFixed(1)} MB > 20 MB`);
    const kind = await classifyCatalogFile(file);
    if (kind === "placeholder" && st.size > MAX_BYTES) problems.push(`placeholder ${(st.size / 1024).toFixed(0)} KB > 1 MB`);
    // Garment prep (lib/tryon/garment.ts) fits any of these to ≤1600 px and <4 MB JPEG.
    if (problems.length === 0 && kind === "imported") notes.push("photo (scripts/import-catalog.ts)");
    else if (problems.length === 0 && kind === "photo") notes.push(`real photo ${meta.width}×${meta.height} ${meta.format}`);
    return {
      file,
      ok: problems.length === 0,
      bytes: st.size,
      problem: [...problems, ...notes].join(", ") || null,
      kind,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { file, ok: false, bytes: 0, problem: code === "ENOENT" ? "missing" : (err as Error).message, kind: "missing" };
  }
}

async function contactSheet(files: string[], dest: string): Promise<void> {
  const cols = 8;
  const tw = WIDTH / 4;
  const th = HEIGHT / 4;
  const gap = 8;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(
    files.map(async (file, i) => ({
      input: await sharp(file).resize(tw, th).png().toBuffer(),
      left: gap + (i % cols) * (tw + gap),
      top: gap + Math.floor(i / cols) * (th + gap),
    })),
  );
  await sharp({
    create: {
      width: gap + cols * (tw + gap),
      height: gap + rows * (th + gap),
      channels: 3,
      background: "#d9d6d0",
    },
  })
    .composite(tiles)
    .png()
    .toFile(dest);
}

/* ───────────────────────── CLI ───────────────────────── */

interface Args {
  check: boolean;
  /** Overwrite existing files. Without it, existing images (e.g. real product photos) are kept. */
  force: boolean;
  only: string[] | null;
  sheet: string | null;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, force: false, only: null, sheet: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--check") args.check = true;
    else if (a === "--force") args.force = true;
    else if (a === "--only") args.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--sheet") args.sheet = next();
    else if (a === "--out") args.out = next();
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npm run assets -- [--check] [--force] [--only id1,id2] [--sheet sheet.png] [--out dir]\n" +
          "Writes only missing images; --force regenerates every placeholder. Photos (imported or hand-placed) are never overwritten.",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  try {
    await fs.access(path.join(root, "lib", "catalog.ts"));
  } catch {
    throw new Error(`Run this from the project root (npm run assets). cwd=${root}`);
  }
  const outDir = path.resolve(root, args.out ?? path.join("public", "catalog"));

  let skus: readonly Sku[] = SKUS;
  if (args.only) {
    const unknown = args.only.filter((id) => !SKUS.some((s) => s.id === id));
    if (unknown.length) throw new Error(`Unknown SKU id(s): ${unknown.join(", ")}`);
    skus = SKUS.filter((s) => args.only!.includes(s.id));
  }

  // Scales come from the whole catalogue so --only renders match a full run.
  const allJobs = planJobs(SKUS, outDir);
  const scales = scalesFor(allJobs);
  const jobs = allJobs.filter((j) => skus.includes(j.sku));

  const driftByFile = new Map<string, number>();
  if (!args.check) {
    await fs.mkdir(outDir, { recursive: true });
    const t0 = Date.now();
    let kept = 0;
    let keptPhotos = 0;
    let written = 0;
    for (const j of jobs) {
      // Never clobber a photo (imported or hand-placed); without --force, keep every existing file.
      const kind = await classifyCatalogFile(j.file);
      if (kind === "imported" || kind === "photo") {
        keptPhotos += 1;
        continue;
      }
      if (kind === "placeholder" && !args.force) {
        kept += 1;
        continue;
      }
      written += 1;
      const s = scales.get(`${j.sku.category}:${j.pres}`);
      if (!s) throw new Error(`No scale for ${j.sku.id}`);
      const { fill, drift } = await calibratedFill(j.sku, j.garment, s);
      driftByFile.set(j.file, drift);
      const png = await encodePng(renderSvg(j.sku, j.garment, s, fill));
      await fs.writeFile(j.file, png);
    }
    console.log(
      `Rendered ${written} image(s) for ${skus.length} SKUs in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${path.relative(root, outDir) || "."}` +
        (kept ? ` · kept ${kept} existing placeholder(s) (use --force to regenerate them)` : "") +
        (keptPhotos ? ` · kept ${keptPhotos} photo(s), never overwritten (scripts/import-catalog.ts manages imported ones)` : ""),
    );
  }

  // Verify every expected file: a readable PNG/JPEG/WebP, min side 256 px, ≤ 20 MB. Generated
  // placeholders are 768×1024 PNGs; imported and hand-placed photos are accepted as they are (noted).
  const rows = await Promise.all(jobs.map((j) => checkFile(j.file)));
  const failed = rows.filter((r) => !r.ok);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const largest = rows.reduce((m, r) => (r.bytes > m.bytes ? r : m), rows[0] ?? { file: "-", bytes: 0, ok: true, problem: null });
  for (const r of rows) {
    const status = r.ok ? "ok " : "ERR";
    const drift = driftByFile.get(r.file);
    const driftNote = drift === undefined ? "" : `  colour drift ${drift.toFixed(1)}`;
    console.log(
      `  ${status} ${path.relative(root, r.file).padEnd(52)} ${(r.bytes / 1024).toFixed(0).padStart(5)} KB${driftNote}${r.problem ? `  ${r.problem}` : ""}`,
    );
  }
  const photos = rows.filter((r) => r.kind === "imported" || r.kind === "photo").length;
  console.log(
    `${rows.length - failed.length}/${rows.length} files OK · ${photos} photo(s), ${rows.length - photos - failed.length} placeholder(s) · total ${(total / 1024 / 1024).toFixed(2)} MB · largest ${path.basename(largest.file)} ${(largest.bytes / 1024).toFixed(0)} KB`,
  );

  // Report (never delete) PNGs in the folder that no SKU references, e.g. stale renames.
  if (!args.only) {
    const expected = new Set(allJobs.map((j) => path.basename(j.file)));
    const present = await fs.readdir(outDir).catch(() => [] as string[]);
    const stray = present.filter((n) => n.endsWith(".png") && !expected.has(n));
    if (stray.length) console.log(`Note: ${stray.length} PNG(s) not referenced by any SKU: ${stray.join(", ")}`);
  }

  if (args.sheet && failed.length === 0) {
    const dest = path.resolve(root, args.sheet);
    await contactSheet(
      jobs.map((j) => j.file),
      dest,
    );
    console.log(`Contact sheet → ${dest}`);
  }

  if (failed.length) {
    console.error(`${failed.length} file(s) failed the check${args.check ? "; run npm run assets to regenerate" : ""}.`);
    process.exitCode = 1;
  }
}

// Run only as a script (scripts/import-catalog.ts imports placeholderPxPerCm from here).
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
