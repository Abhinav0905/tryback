// Dev double: a simulated try-on renderer (sharp, 0 credits). Server-only.
//
// It exists so the whole flow (cards, gate, dashboard, latency clock) can be
// built and demoed without spending credits. Output is deliberately, obviously
// fake: the torso region is re-coloured with the garment's dominant colour and
// hatched, the product shot sits in an inset, and a hazard-striped band reads
// "SIMULATED PREVIEW · dev double · 0 credits". The UI must also label these
// renders "Simulated preview".
//
// The band text is drawn with a built-in stroke font (SVG paths), not <text>,
// so it renders on hosts without system fonts (serverless images often have none).

import sharp, { type OverlayOptions } from "sharp";
import { config } from "../config";
import { TryOnError, type TryOnInput, type TryOnOutput, type TryOnProvider } from "./types";

export const SIMULATED_BAND_TEXT = "SIMULATED PREVIEW · dev double · 0 credits";
/** Top of the product-shot inset as a fraction of the image height (clear of the UI's top pills). */
export const INSET_TOP_FRAC = 0.13;
/** ± fraction applied to the mean simulated latency. */
export const DEV_LATENCY_JITTER = 0.4;

type Sleep = (ms: number) => Promise<void>;
type Rgb = { r: number; g: number; b: number };

export interface DevDoubleOptions {
  /** Mean simulated latency (default config.devRenderLatencyMs), jittered ±40%. */
  latencyMs?: number;
  /** 0..1 probability of a simulated RENDER_FAILED (default config.devFailRate). */
  failRate?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for jitter/failures (default Math.random). */
  random?: () => number;
  now?: () => number;
}

// Not unref'd: a CLI (scripts/probe.ts) must stay alive through Retry-After and poll waits.
const realSleep: Sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortedError(): TryOnError {
  return new TryOnError("ABORTED", "Render aborted", false);
}

async function sleepWithSignal(sleep: Sleep, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortedError();
  if (ms <= 0) return;
  if (!signal) return sleep(ms);
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      sleep(ms),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortedError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class DevDoubleProvider implements TryOnProvider {
  readonly name = "dev" as const;
  private readonly opts: DevDoubleOptions;

  constructor(opts?: DevDoubleOptions) {
    this.opts = opts ?? {};
  }

  /** The latency this instance simulates (mean, before jitter). */
  get meanLatencyMs(): number {
    return Math.max(0, this.opts.latencyMs ?? config.devRenderLatencyMs);
  }

  get failRate(): number {
    const f = this.opts.failRate ?? config.devFailRate;
    return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
  }

  async render(input: TryOnInput, signal?: AbortSignal): Promise<TryOnOutput> {
    const now = this.opts.now ?? Date.now;
    const random = this.opts.random ?? Math.random;
    const sleep = this.opts.sleep ?? realSleep;
    const t0 = now();
    if (signal?.aborted) throw abortedError();

    const jitter = 1 + (random() * 2 - 1) * DEV_LATENCY_JITTER;
    const latency = Math.max(0, Math.round(this.meanLatencyMs * jitter));
    const fails = this.failRate > 0 && random() < this.failRate;

    // Compose while the simulated latency elapses; settle into a tagged result so a
    // compose error can't become an unhandled rejection during the sleep.
    const composing: Promise<{ ok: true; bytes: Buffer } | { ok: false; error: unknown }> = fails
      ? Promise.resolve({ ok: false, error: null })
      : composeSimulatedRender(input.personBytes, input.garmentBytes, { title: input.title }).then(
          (bytes) => ({ ok: true as const, bytes }),
          (error: unknown) => ({ ok: false as const, error }),
        );

    await sleepWithSignal(sleep, latency, signal);
    const result = await composing;
    if (signal?.aborted) throw abortedError();

    if (fails) {
      throw new TryOnError(
        "RENDER_FAILED",
        "Simulated failure from the dev double (DEV_FAIL_RATE). No credit was used.",
        false,
      );
    }
    if (!result.ok) {
      const detail = result.error instanceof Error ? result.error.message : String(result.error);
      throw new TryOnError("UNSUPPORTED_IMAGE", `Dev double could not read the images: ${detail}`, false);
    }

    return {
      bytes: result.bytes,
      contentType: "image/jpeg",
      latencyMs: Math.max(0, Math.round(now() - t0)),
      provider: "dev",
      externalId: null,
      creditCharged: false,
    };
  }
}

/* ───────────────────────── Colour ───────────────────────── */

const srgbToLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (y: number) => 255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055);

/** Grey level (0..255, sRGB) with the same relative luminance as `c`. */
function luminanceGrey(c: Rgb): number {
  const y = 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
  return Math.round(linearToSrgb(y));
}

/** Mean of a single-channel 8-bit buffer (128 when empty). */
function meanOf(buf: Buffer): number {
  if (buf.length === 0) return 128;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]!;
  return sum / buf.length;
}

function toHex(c: Rgb): string {
  return `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Dominant colour of a garment product shot: collects the non-white pixels,
 * runs sharp `stats()` on them, then averages the pixels near the histogram's
 * dominant bin (robust to seams, shading and anti-aliased edges).
 */
export async function garmentDominantColour(garmentBytes: Buffer): Promise<Rgb> {
  const { data, info } = await sharp(garmentBytes)
    .flatten({ background: "#ffffff" })
    .resize({ width: 96, height: 96, fit: "inside" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const total = info.width * info.height;
  const picked: number[] = [];
  for (let i = 0; i + 2 < data.length; i += ch) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r >= 246 && g >= 246 && b >= 246) continue; // white studio background
    picked.push(r, g, b);
  }
  const n = picked.length / 3;
  if (n < Math.max(12, total * 0.01)) {
    // Essentially all white: a white garment on white. Use the whole (flattened) image.
    // Note: stats() measures its *input*, ignoring pipeline ops, so feed it the raw pixels.
    const { dominant } = await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).stats();
    return dominant;
  }
  const strip = Buffer.from(picked);
  const stats = await sharp(strip, { raw: { width: n, height: 1, channels: 3 } }).stats();
  const dom = stats.dominant;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let k = 0;
  for (let i = 0; i < strip.length; i += 3) {
    const r = strip[i]!;
    const g = strip[i + 1]!;
    const b = strip[i + 2]!;
    if (Math.abs(r - dom.r) + Math.abs(g - dom.g) + Math.abs(b - dom.b) <= 60) {
      sr += r;
      sg += g;
      sb += b;
      k++;
    }
  }
  if (k >= n * 0.25) return { r: Math.round(sr / k), g: Math.round(sg / k), b: Math.round(sb / k) };
  const [cr, cg, cb] = stats.channels;
  return { r: Math.round(cr?.mean ?? dom.r), g: Math.round(cg?.mean ?? dom.g), b: Math.round(cb?.mean ?? dom.b) };
}

/* ───────────────────────── Garment region ───────────────────────── */

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Approximate garment silhouette for a centred, full-body, front-facing photo.
 * The hem height and flare come from the API title ("midi", "A-line", "hip length"…),
 * so length/silhouette swaps look different in the simulated card too.
 */
function garmentPolygon(W: number, H: number, title: string): { points: [number, number][]; region: Region; feather: number } {
  const t = title.toLowerCase();
  const hemFrac = /\bmaxi\b/.test(t)
    ? 0.86
    : /\bmidi\b/.test(t)
      ? 0.74
      : /above-knee|\bmini\b/.test(t)
        ? 0.57
        : /\bknee\b/.test(t)
          ? 0.64
          : /\bcrop/.test(t)
            ? 0.4
            : /hip length|\b(top|shirt|blouse|tee|knit|sweater)\b/.test(t)
              ? 0.49
              : 0.62;
  const flare = /a-line|flare|trench|coat|shift|oversized|boxy/.test(t)
    ? 1
    : /bodycon|slip|fitted|wrap/.test(t)
      ? 0.6
      : 0.8;

  const u = Math.min(H, W * 1.6);
  const cx = W / 2;
  const maxHalf = W * 0.47;
  const half = (f: number) => Math.min(maxHalf, f * u);

  const neckY = 0.165 * H;
  const shoulderY = 0.185 * H;
  const armY = 0.27 * H;
  const waistY = 0.4 * H;
  const hipY = 0.5 * H;
  const hemY = hemFrac * H;

  const right: [number, number][] = [
    [cx + half(0.035), neckY],
    [cx + half(0.1), shoulderY],
    [cx + half(0.088), armY],
    [cx + half(0.072), waistY],
  ];
  if (hemY > hipY + 0.02 * H) {
    right.push([cx + half(0.09), hipY]);
    right.push([cx + half(0.09 + Math.max(0, hemFrac - 0.5) * 0.28 * flare), hemY]);
  } else {
    right.push([cx + half(0.085), hemY]);
  }
  const left = right.map(([x, y]) => [2 * cx - x, y] as [number, number]).reverse();
  const neckDip: [number, number] = [cx, neckY + 0.035 * H];
  const points: [number, number][] = [neckDip, ...right, ...left];

  const feather = Math.max(1, 0.006 * H);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const pad = Math.ceil(feather * 3);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(H, Math.ceil(Math.max(...ys) + pad));
  return {
    points,
    region: { left: x0, top: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) },
    feather,
  };
}

function polygonPath(points: [number, number][], dx: number, dy: number): string {
  return (
    points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${(x - dx).toFixed(1)} ${(y - dy).toFixed(1)}`).join(" ") + " Z"
  );
}

/* ───────────────────────── Stroke font ───────────────────────── */

// Glyphs on a 4×6 grid (y down, baseline at 6). Strokes separated by "|".
const GLYPH_SRC: Record<string, string> = {
  A: "0,6 0,2 2,0 4,2 4,6|0,3.6 4,3.6",
  B: "0,0 0,6 3,6 4,5 4,4 3,3 0,3|0,0 3,0 4,1 4,2 3,3",
  C: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5",
  D: "0,0 0,6 2.5,6 4,4.5 4,1.5 2.5,0 0,0",
  E: "4,0 0,0 0,6 4,6|0,3 3,3",
  F: "4,0 0,0 0,6|0,3 3,3",
  G: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.5 2.5,3.5",
  H: "0,0 0,6|4,0 4,6|0,3 4,3",
  I: "1,0 3,0|2,0 2,6|1,6 3,6",
  J: "1,0 4,0|3,0 3,5 2,6 1,6 0,5",
  K: "0,0 0,6|4,0 0,3.5|1.4,2.6 4,6",
  L: "0,0 0,6 4,6",
  M: "0,6 0,0 2,3 4,0 4,6",
  N: "0,6 0,0 4,6 4,0",
  O: "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0",
  P: "0,6 0,0 3,0 4,1 4,2 3,3 0,3",
  Q: "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2.6,4.6 4,6",
  R: "0,6 0,0 3,0 4,1 4,2 3,3 0,3|2,3 4,6",
  S: "4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5",
  T: "0,0 4,0|2,0 2,6",
  U: "0,0 0,5 1,6 3,6 4,5 4,0",
  V: "0,0 2,6 4,0",
  W: "0,0 1,6 2,3 3,6 4,0",
  X: "0,0 4,6|4,0 0,6",
  Y: "0,0 2,3 4,0|2,3 2,6",
  Z: "0,0 4,0 0,6 4,6",
  "0": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|3.6,0.8 0.4,5.2",
  "1": "1,1 2,0 2,6|1,6 3,6",
  "2": "0,1 1,0 3,0 4,1 4,2 0,6 4,6",
  "3": "0,0 4,0 2,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5",
  "4": "3,6 3,0 0,4 4,4",
  "5": "4,0 0,0 0,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5",
  "6": "3.5,0 1.5,0 0,1.5 0,5 1,6 3,6 4,5 4,3.5 3,2.5 0,2.5",
  "7": "0,0 4,0 1.5,6",
  "8": "1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3 1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3",
  "9": "4,3.5 1,3.5 0,2.5 0,1 1,0 3,0 4,1 4,4.5 2.5,6 0.5,6",
  a: "0.5,2.5 3,2.5 4,3.5 4,6|4,4 1,4 0,4.8 0,5.2 1,6 3,6 4,5",
  b: "0,0 0,6|0,3.5 1,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5",
  c: "4,3.3 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5.2",
  d: "4,0 4,6|4,3.5 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5",
  e: "0,4.2 4,4.2 4,3.5 3,2.5 1,2.5 0,3.5 0,5 1,6 3.6,6",
  i: "0.5,2.5 0.5,6|0.5,1 0.5,1.01",
  l: "0.5,0 0.5,6",
  n: "0,2.5 0,6|0,3.5 1,2.5 3,2.5 4,3.5 4,6",
  o: "1,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5 0,3.5 1,2.5",
  r: "0,2.5 0,6|0,3.8 1.3,2.5 3,2.5",
  s: "4,3 3,2.5 1,2.5 0,3.2 1,4.2 3,4.3 4,5.1 3,6 1,6 0,5.5",
  t: "1,0.6 1,5 2,6 3,6|0,2.5 3,2.5",
  u: "0,2.5 0,5 1,6 3,6 4,5|4,2.5 4,6",
  v: "0,2.5 2,6 4,2.5",
  "·": "0.5,3.2 0.5,3.21",
  "-": "0,3.2 3,3.2",
  ".": "0.5,6 0.5,6.01",
};
const GLYPH_WIDTH: Record<string, number> = { i: 1, l: 1, "·": 1, ".": 1, r: 3, t: 3, "-": 3, " ": 2.4 };
const LETTER_GAP = 1.6;

function glyphFor(ch: string): { width: number; d: string } {
  const key = GLYPH_SRC[ch] !== undefined ? ch : GLYPH_SRC[ch.toUpperCase()] !== undefined ? ch.toUpperCase() : " ";
  const src = GLYPH_SRC[key] ?? "";
  const d = src
    .split("|")
    .filter(Boolean)
    .map((stroke) =>
      stroke
        .trim()
        .split(/\s+/)
        .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.replace(",", " ")}`)
        .join(" "),
    )
    .join(" ");
  return { width: GLYPH_WIDTH[key] ?? 4, d };
}

/** SVG <path> data for `text` in glyph units, plus its advance width. */
function strokeText(text: string): { d: string; width: number } {
  let x = 0;
  const parts: string[] = [];
  for (const ch of text) {
    const g = glyphFor(ch);
    if (g.d) parts.push(`<path transform="translate(${x.toFixed(2)} 0)" d="${g.d}"/>`);
    x += g.width + LETTER_GAP;
  }
  return { d: parts.join(""), width: Math.max(0, x - LETTER_GAP) };
}

/* ───────────────────────── Overlays ───────────────────────── */

function bandSvg(W: number, bandH: number, text: string): Buffer {
  const stripeH = Math.max(3, Math.round(bandH * 0.14));
  const bodyH = bandH - stripeH;
  const padX = Math.max(6, Math.round(W * 0.03));
  const { d, width } = strokeText(text);
  let scale = (bodyH * 0.44) / 6;
  if (width * scale > W - 2 * padX) scale = (W - 2 * padX) / Math.max(1, width);
  const tx = (W - width * scale) / 2;
  const ty = stripeH + (bodyH - 6 * scale) / 2;
  const sw = Math.max(1.6, stripeH * 0.9);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${bandH}" viewBox="0 0 ${W} ${bandH}">` +
      `<defs><pattern id="hz" width="${sw * 2}" height="${sw * 2}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="${sw}" height="${sw * 2}" fill="#f2b705"/><rect x="${sw}" width="${sw}" height="${sw * 2}" fill="#141414"/></pattern></defs>` +
      `<rect x="0" y="0" width="${W}" height="${stripeH}" fill="url(#hz)"/>` +
      `<rect x="0" y="${stripeH}" width="${W}" height="${bodyH}" fill="#141414" fill-opacity="0.88"/>` +
      `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})" fill="none" stroke="#ffffff" ` +
      `stroke-width="0.85" stroke-linecap="round" stroke-linejoin="round">${d}</g>` +
      `</svg>`,
  );
}

function maskSvg(region: Region, path: string, feather: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}">` +
      `<defs><filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${feather.toFixed(2)}"/></filter></defs>` +
      `<path d="${path}" fill="#ffffff" filter="url(#f)"/></svg>`,
  );
}

function hatchSvg(region: Region, path: string, H: number): Buffer {
  const gap = Math.max(4, Math.round(H * 0.014));
  const lw = Math.max(1, H * 0.0022);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}">` +
      `<defs><pattern id="h" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">` +
      `<line x1="0" y1="0" x2="0" y2="${gap}" stroke="#ffffff" stroke-opacity="0.22" stroke-width="${lw.toFixed(2)}"/></pattern>` +
      `<clipPath id="c"><path d="${path}"/></clipPath></defs>` +
      `<rect width="${region.width}" height="${region.height}" fill="url(#h)" clip-path="url(#c)"/>` +
      `<path d="${path}" fill="none" stroke="#ffffff" stroke-opacity="0.75" stroke-width="${(lw * 1.4).toFixed(2)}" ` +
      `stroke-dasharray="${(lw * 6).toFixed(1)} ${(lw * 4).toFixed(1)}" stroke-linejoin="round"/></svg>`,
  );
}

async function insetCard(garmentBytes: Buffer, w: number, h: number): Promise<Buffer> {
  const pad = Math.max(3, Math.round(Math.min(w, h) * 0.06));
  const radius = Math.max(4, Math.round(Math.min(w, h) * 0.08));
  const thumb = await sharp(garmentBytes)
    .flatten({ background: "#ffffff" })
    .resize({ width: w - 2 * pad, height: h - 2 * pad, fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();
  const rounded = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" fill="#fff"/></svg>`,
  );
  const border = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${radius - 1}" ` +
      `fill="none" stroke="#141414" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="6 4"/></svg>`,
  );
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([
      { input: thumb, left: pad, top: pad },
      { input: rounded, blend: "dest-in" },
      { input: border },
    ])
    .png()
    .toBuffer();
}

/* ───────────────────────── Composer ───────────────────────── */

/**
 * Build the simulated render: same pixel size as the (orientation-corrected)
 * person photo, JPEG. Exported for tests and the /bench tooling.
 */
export async function composeSimulatedRender(
  personBytes: Buffer,
  garmentBytes: Buffer,
  opts?: { title?: string; quality?: number },
): Promise<Buffer> {
  const { data, info } = await sharp(personBytes)
    .rotate()
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const rawOpts = { raw: { width: W, height: H, channels: info.channels } } as const;
  const overlays: OverlayOptions[] = [];

  if (W >= 32 && H >= 32) {
    const colour = await garmentDominantColour(garmentBytes);
    const { points, region, feather } = garmentPolygon(W, H, opts?.title ?? "");
    const localPath = polygonPath(points, region.left, region.top);

    // Re-colour: keep the photo's shading (compressed), move its luminance to the
    // garment's, then tint chroma to the garment colour. Clearly flat and fake.
    // stats() ignores extract(), so average the extracted grey pixels directly.
    const regionGrey = await sharp(data, rawOpts).extract(region).greyscale().raw().toBuffer();
    const meanGrey = meanOf(regionGrey);
    const contrast = 0.55;
    const offset = luminanceGrey(colour) - contrast * meanGrey;
    const grey = await sharp(data, rawOpts).extract(region).greyscale().linear(contrast, offset).png().toBuffer();
    const tinted = await sharp(grey).toColourspace("srgb").tint(colour).png().toBuffer();
    const recoloured = await sharp(tinted)
      .ensureAlpha()
      .composite([{ input: maskSvg(region, localPath, feather), blend: "dest-in" }])
      .png()
      .toBuffer();
    overlays.push({ input: recoloured, left: region.left, top: region.top });
    overlays.push({ input: hatchSvg(region, localPath, H), left: region.left, top: region.top });

    // Product-shot inset, top right, below the band where the UI puts its provenance pill
    // ("Simulated preview · replayed from cache"), so the pill never covers the inset.
    const iw = Math.round(W * 0.26);
    const ih = Math.round(H * 0.26);
    const margin = Math.max(4, Math.round(Math.min(W, H) * 0.025));
    const insetTop = Math.max(margin, Math.round(H * INSET_TOP_FRAC));
    if (iw >= 40 && ih >= 40 && iw + margin <= W && insetTop + ih <= H) {
      overlays.push({ input: await insetCard(garmentBytes, iw, ih), left: W - iw - margin, top: insetTop });
    }
  }

  if (H >= 16) {
    const bandH = Math.min(Math.floor(H / 3), Math.max(18, Math.round(H * 0.07)));
    overlays.push({ input: bandSvg(W, bandH, SIMULATED_BAND_TEXT), left: 0, top: H - bandH });
  }

  return sharp(data, rawOpts)
    .composite(overlays)
    .jpeg({ quality: opts?.quality ?? 86 })
    .toBuffer();
}

/** Exposed for debugging and tests. */
export const __devDoubleInternals = { garmentPolygon, luminanceGrey, toHex, strokeText };
