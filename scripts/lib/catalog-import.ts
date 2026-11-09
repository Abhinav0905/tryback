/**
 * Catalogue importer core: turns licensed garment photos (assets-src/catalog/raw/**) into the
 * product shots in public/catalog, one PNG per SKU (+ "-alt" where the SKU has an alt shot),
 * in the same 768×1024 frame as the generated placeholders. Driven by
 * assets-src/catalog/manifest.json; the CLI is scripts/import-catalog.ts.
 *
 * Per family with "source": "photo":
 *   rotate/crop → background matte (border model, Lab threshold, largest components, feather)
 *   → optional patches (labels, tags) → edge decontamination → cut to the garment
 *   → per SKU: scale to a shared px-per-cm for the category (lengths compare honestly), stretch
 *     below the waist by the real tall/petite length delta, recolour in CIELAB to colorHex,
 *     centre on white → PNG with a tEXt marker + attribution.
 * Alt shot: the manifest's alt photo if given, otherwise the primary mirrored and framed 7%
 * smaller (a different-looking input for the gate's one retry, same garment).
 */
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { SKUS, VARIANT_OFFSETS } from "../../lib/catalog";
import { deltaE2000, hexToLab } from "../../lib/color";
import type { Category, Sku } from "../../lib/types";
import {
  CANVAS,
  MARKER_IMPORT,
  MARKER_KEY,
  addPngText,
  bbox,
  composeOnWhite,
  decontaminate,
  flipHorizontal,
  matte,
  patchRegions,
  rasterPolygon,
  recolour,
  stretchBelow,
  type Polygon,
  type Rgba,
} from "./imaging";

/* ───────────────────────── Manifest schema ───────────────────────── */

const ALLOWED_LICENSES = [
  "CC0 1.0",
  "Public domain",
  "No Copyright - United States",
  "CC BY 2.0",
  "CC BY 3.0",
  "CC BY 4.0",
  "CC BY-SA 2.0",
  "CC BY-SA 3.0",
  "CC BY-SA 4.0",
  "Own photo",
  /** Made with an image generator for this demo; no real product or photographer to credit. */
  "AI-generated",
] as const;
export type License = (typeof ALLOWED_LICENSES)[number];

const point = z.tuple([z.number().finite(), z.number().finite()]);
const polygon = z.array(point).min(3).max(200);
const https = z.string().regex(/^https:\/\/[^\s]+$/, "must be an https:// URL");

const creditSchema = z
  .object({
    title: z.string().min(1).max(300),
    author: z.string().min(1).max(300),
    license: z.enum(ALLOWED_LICENSES),
    licenseUrl: https.optional(),
    sourceUrl: https.optional(),
    /** Extra provenance (holding institution, rights statement), shown in CREDITS.md. */
    note: z.string().max(600).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.license !== "Own photo" && c.license !== "AI-generated" && !c.sourceUrl) ctx.addIssue({ code: "custom", message: "sourceUrl is required for third-party photos" });
    if (c.license.startsWith("CC BY") && !c.licenseUrl) ctx.addIssue({ code: "custom", message: "licenseUrl is required for CC BY / CC BY-SA" });
  });
export type Credit = z.infer<typeof creditSchema>;

const shotSchema = z
  .object({
    /** Path relative to assets-src/catalog, e.g. "raw/trench/coat.jpg". */
    file: z.string().min(1).max(300),
    /** Degrees clockwise, applied before the crop. */
    rotate: z.number().min(-180).max(180).optional(),
    /** In source pixels (after rotation). */
    crop: z
      .object({ left: z.number().int().min(0), top: z.number().int().min(0), width: z.number().int().min(16), height: z.number().int().min(16) })
      .strict()
      .optional(),
    background: z
      .object({
        mode: z.enum(["auto", "flat"]).default("auto"),
        tolerance: z.number().min(1).max(80).optional(),
        lightnessWeight: z.number().min(0).max(2).optional(),
        garmentDistance: z.number().min(5).max(150).optional(),
        holeMaxFrac: z.number().min(0).max(0.2).optional(),
        minComponentFrac: z.number().min(0).max(1).optional(),
        feather: z.number().int().min(0).max(4).optional(),
        smooth: z.number().int().min(0).max(8).optional(),
      })
      .strict()
      .optional(),
    /** Polygons (source pixels) forced to background: stands, dress-form necks, hands, tags. */
    erase: z.array(polygon).max(50).optional(),
    /** Polygons forced to garment (e.g. a white collar on a white wall). */
    include: z.array(polygon).max(50).optional(),
    /** Polygons painted over with surrounding fabric before recolouring (labels, ink numbers). */
    patch: z.array(polygon).max(50).optional(),
    /** Polygons kept in their original colour (a wooden hanger hook). Not counted as garment. */
    protect: z.array(polygon).max(50).optional(),
    /** Shading strength for the recolour (1 = as photographed). */
    shading: z.number().min(0.2).max(2).optional(),
    /** Damp broad lightness variation (stains, two-tone panels): keep 0..1 of it, radius as a fraction of garment height. */
    largeScale: z.object({ keep: z.number().min(0).max(1), radius: z.number().min(0.005).max(0.5) }).strict().optional(),
    credit: creditSchema,
  })
  .strict();
export type ShotSpec = z.infer<typeof shotSchema>;

const familyEntrySchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("drawing"), note: z.string().max(600).optional() }).strict(),
  z.object({ source: z.literal("manual"), note: z.string().max(600).optional() }).strict(),
  z
    .object({
      source: z.literal("photo"),
      primary: shotSchema,
      alt: shotSchema.nullable().optional(),
      /** Waist position as a fraction of the garment's shoulder-to-hem height (tall/petite stretch below it). */
      waist: z.number().min(0.15).max(0.85).optional(),
      note: z.string().max(600).optional(),
    })
    .strict(),
]);
export type FamilyEntry = z.infer<typeof familyEntrySchema>;
export type PhotoEntry = Extract<FamilyEntry, { source: "photo" }>;

const manifestSchema = z
  .object({
    $comment: z.string().optional(),
    version: z.literal(1),
    families: z.record(z.string(), familyEntrySchema),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;

export const FAMILIES: readonly string[] = [...new Set(SKUS.map((s) => s.family))];

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

/**
 * Resolve a manifest file path inside `baseDir`, refusing anything that could read outside it:
 * absolute paths, "..", backslashes, NUL, non-image extensions, and symlinks that escape.
 */
export function resolveAssetPath(baseDir: string, rel: string, opts: { mustExist?: boolean } = {}): string {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || rel.includes("\\")) throw new Error(`Invalid asset path: ${JSON.stringify(rel)}`);
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) throw new Error(`Asset path must be relative to assets-src/catalog: ${rel}`);
  if (rel.split("/").some((seg) => seg === ".." || seg === "")) throw new Error(`Asset path must not contain "..": ${rel}`);
  if (!IMAGE_EXT.test(rel)) throw new Error(`Asset must be a .jpg, .png or .webp image: ${rel}`);
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) throw new Error(`Asset path escapes assets-src/catalog: ${rel}`);
  if (opts.mustExist !== false) {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new Error(`Asset not found: ${rel}`);
    }
    const realBase = realpathSync(base);
    if (!real.startsWith(realBase + path.sep)) throw new Error(`Asset path escapes assets-src/catalog via a link: ${rel}`);
  }
  return abs;
}

/** Parse + validate a manifest object. Throws with every problem listed. */
export function parseManifest(raw: unknown, baseDir: string, opts: { checkFiles?: boolean } = {}): Manifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid catalogue manifest:\n${lines.join("\n")}`);
  }
  const m = parsed.data;
  const problems: string[] = [];
  const known = new Set(FAMILIES);
  for (const f of Object.keys(m.families)) if (!known.has(f)) problems.push(`families.${f}: not a catalogue family (${FAMILIES.join(", ")})`);
  for (const f of FAMILIES) if (!m.families[f]) problems.push(`families.${f}: missing (use {"source": "drawing"} to keep the placeholder)`);
  for (const [f, e] of Object.entries(m.families)) {
    if (e.source !== "photo") continue;
    for (const [which, shot] of [["primary", e.primary], ["alt", e.alt]] as const) {
      if (!shot) continue;
      try {
        resolveAssetPath(baseDir, shot.file, { mustExist: opts.checkFiles !== false });
      } catch (err) {
        problems.push(`families.${f}.${which}.file: ${(err as Error).message}`);
      }
    }
  }
  if (problems.length) throw new Error(`Invalid catalogue manifest:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return m;
}

export async function loadManifest(file: string, opts: { checkFiles?: boolean } = {}): Promise<Manifest> {
  const text = await fs.readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseManifest(raw, path.dirname(file), opts);
}

/* ───────────────────────── Shot processing ───────────────────────── */

/** Working resolution for matting (longest side). */
const WORK_MAX_SIDE = 1600;

export interface GarmentCut {
  /** Garment RGBA (decontaminated), cropped to the alpha bounding box. */
  rgba: Rgba;
  /** Protected pixels (hanger hook), same size as rgba. */
  protect: Uint8Array | null;
  /** Garment rows (unprotected, alpha ≥ 128) inside the cut: shoulder/top and hem. */
  garmentTop: number;
  garmentBottom: number;
}

function transformPolys(polys: readonly (readonly (readonly [number, number])[])[] | undefined, dx: number, dy: number, s: number): Polygon[] {
  return (polys ?? []).map((poly) => poly.map(([x, y]) => [(x - dx) * s, (y - dy) * s] as const));
}

/** Matte one photo and cut the garment out. `baseDir` is assets-src/catalog. */
export async function cutGarment(baseDir: string, shot: ShotSpec): Promise<GarmentCut> {
  const file = resolveAssetPath(baseDir, shot.file);
  let pipeline = sharp(file, { failOn: "error" }).rotate();
  if (shot.rotate) {
    const { dominant } = await sharp(file).rotate().stats();
    pipeline = sharp(await pipeline.toBuffer()).rotate(shot.rotate, { background: dominant });
  }
  let buf = await pipeline.toBuffer();
  const meta = await sharp(buf).metadata();
  const crop = shot.crop ?? { left: 0, top: 0, width: meta.width ?? 0, height: meta.height ?? 0 };
  if (crop.left + crop.width > (meta.width ?? 0) || crop.top + crop.height > (meta.height ?? 0)) {
    throw new Error(`${shot.file}: crop ${JSON.stringify(crop)} exceeds the image (${meta.width}×${meta.height})`);
  }
  buf = await sharp(buf).extract(crop).toBuffer();
  const s = Math.min(1, WORK_MAX_SIDE / Math.max(crop.width, crop.height));
  const { data, info } = await sharp(buf)
    .resize({ width: Math.round(crop.width * s), height: Math.round(crop.height * s), fit: "fill" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const img: Rgba = { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
  const sx = info.width / crop.width;
  const bg = shot.background ?? { mode: "auto" as const };
  const { alpha } = matte(img, {
    flat: bg.mode === "flat",
    tolerance: bg.tolerance,
    lightnessWeight: bg.lightnessWeight,
    garmentDistance: bg.garmentDistance,
    holeMaxFrac: bg.holeMaxFrac,
    minComponentFrac: bg.minComponentFrac,
    feather: bg.feather,
    smooth: bg.smooth,
    erase: transformPolys(shot.erase, crop.left, crop.top, sx),
    include: transformPolys(shot.include, crop.left, crop.top, sx),
  });
  const patched = patchRegions(img, alpha, transformPolys(shot.patch, crop.left, crop.top, sx));
  const clean = decontaminate(patched, alpha, 3);

  let protect: Uint8Array | null = null;
  const protectPolys = transformPolys(shot.protect, crop.left, crop.top, sx);
  if (protectPolys.length) {
    protect = new Uint8Array(img.width * img.height);
    for (const p of protectPolys) rasterPolygon(img.width, img.height, p, protect);
  }

  const box = bbox(alpha, img.width, img.height, 1);
  if (!box) throw new Error(`${shot.file}: no garment found (check the crop and background tolerance)`);
  const cut = new Uint8Array(box.width * box.height * 4);
  const cutProtect = protect ? new Uint8Array(box.width * box.height) : null;
  let top = Infinity;
  let bottom = -1;
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const si = (y + box.top) * img.width + (x + box.left);
      const di = y * box.width + x;
      cut.set(clean.data.subarray(si * 4, si * 4 + 4), di * 4);
      if (cutProtect && protect) cutProtect[di] = protect[si]!;
      if (alpha[si]! >= 128 && !protect?.[si]) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (bottom < 0) throw new Error(`${shot.file}: the whole garment is protected`);
  return { rgba: { data: cut, width: box.width, height: box.height }, protect: cutProtect, garmentTop: top, garmentBottom: bottom };
}

/* ───────────────────────── Layout ───────────────────────── */

export const ALT_FRAME = 0.93;

/** Regular-length size-M shoulder-to-hem of a SKU's family, and this SKU's own. */
export function lengthsCm(sku: Sku): { regular: number; own: number } {
  const own = sku.poms.M.hpsToHemCm;
  return { own, regular: Math.round((own - VARIANT_OFFSETS[sku.lengthVariant].lengthCm) * 10) / 10 };
}

/**
 * Largest px-per-cm at which every shot of these families (longest variant included) fits the
 * placeholder frame. One value per category, so a midi reads longer than a knee-length dress.
 */
export function pxPerCmFor(
  shots: { cut: GarmentCut; skus: readonly Sku[]; frame: number }[],
  canvas: { width: number; height: number; padX: number; padY: number } = CANVAS,
): number {
  const availW = canvas.width - 2 * canvas.padX;
  const availH = canvas.height - 2 * canvas.padY;
  let best = Infinity;
  for (const { cut, skus, frame } of shots) {
    const gH = cut.garmentBottom - cut.garmentTop + 1;
    for (const sku of skus) {
      const { regular, own } = lengthsCm(sku);
      const heightCm = (cut.rgba.height / gH) * regular + Math.max(0, own - regular);
      const widthCm = (cut.rgba.width / gH) * regular;
      best = Math.min(best, availH / (heightCm * frame), availW / (widthCm * frame));
    }
  }
  return best;
}

/**
 * The px-per-cm to render each photographed category at: the largest that fits every photo shot
 * (pxPerCmFor), capped at the placeholder drawings' scale for that category, so photographed and
 * drawn garments of one category share a scale and their lengths compare honestly side by side.
 */
export function sharedPxPerCm(photoFit: ReadonlyMap<Category, number>, drawings: ReadonlyMap<Category, number>): Map<Category, number> {
  const out = new Map<Category, number>();
  for (const [cat, fit] of photoFit) {
    const cap = drawings.get(cat);
    out.set(cat, cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.min(fit, cap) : fit);
  }
  return out;
}

async function resizeRgba(img: Rgba, width: number, height: number): Promise<Rgba> {
  const { data, info } = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize({ width, height, fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

async function resizeMask(mask: Uint8Array, w: number, h: number, width: number, height: number): Promise<Uint8Array> {
  const plane = Buffer.alloc(w * h);
  for (let i = 0; i < mask.length; i++) plane[i] = mask[i] ? 255 : 0;
  const out = await sharp(plane, { raw: { width: w, height: h, channels: 1 } }).resize({ width, height, fit: "fill" }).raw().toBuffer();
  const m = new Uint8Array(width * height);
  for (let i = 0; i < m.length; i++) m[i] = out[i]! >= 128 ? 1 : 0;
  return m;
}

export interface RenderedShot {
  png: Buffer;
  /** Mean Lab of the garment vs colorHex (CIEDE2000). */
  deltaE: number;
  /** Garment height on the canvas in px (unprotected rows). */
  garmentPx: number;
  bytes: number;
}

/**
 * Render one SKU image from a cut garment: scale by px-per-cm, stretch for tall/petite, recolour,
 * centre on the canvas, encode PNG with the importer marker and attribution text.
 */
export async function renderSkuShot(
  cut: GarmentCut,
  sku: Sku,
  opts: { pxPerCm: number; frame?: number; mirror?: boolean; waist?: number; shot: ShotSpec },
): Promise<RenderedShot> {
  const frame = opts.frame ?? 1;
  const { regular, own } = lengthsCm(sku);
  const gH = cut.garmentBottom - cut.garmentTop + 1;
  const f = (opts.pxPerCm * regular * frame) / gH;
  const w = Math.max(1, Math.round(cut.rgba.width * f));
  const h = Math.max(1, Math.round(cut.rgba.height * f));
  let img = await resizeRgba(cut.rgba, w, h);
  let protect = cut.protect ? await resizeMask(cut.protect, cut.rgba.width, cut.rgba.height, w, h) : null;
  const extra = (own - regular) * opts.pxPerCm * frame;
  if (Math.abs(extra) >= 0.5) {
    const y0 = (cut.garmentTop + (opts.waist ?? 0.45) * gH) * f;
    img = stretchBelow(img, y0, extra);
    if (protect) {
      // Protected parts (a hook) sit above the waist; keep them aligned by padding rows.
      const p = new Uint8Array(img.width * img.height);
      p.set(protect.subarray(0, Math.min(protect.length, p.length)));
      protect = p;
    }
  }
  if (opts.mirror) {
    img = flipHorizontal(img);
    if (protect) {
      const p = new Uint8Array(protect.length);
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) p[y * img.width + (img.width - 1 - x)] = protect[y * img.width + x]!;
      protect = p;
    }
  }
  const radius = opts.shot.largeScale ? Math.max(2, opts.shot.largeScale.radius * gH * f) : 0;
  const rec = recolour(img, sku.colorHex, {
    protect,
    shading: opts.shot.shading,
    largeScale: opts.shot.largeScale ? { keep: opts.shot.largeScale.keep, radius } : undefined,
  });
  const left = Math.round((CANVAS.width - rec.image.width) / 2);
  const top = Math.round((CANVAS.height - rec.image.height) / 2);
  const rgb = composeOnWhite(rec.image, CANVAS.width, CANVAS.height, left, top);
  let png: Buffer = await sharp(Buffer.from(rgb), { raw: { width: CANVAS.width, height: CANVAS.height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const c = opts.shot.credit;
  png = addPngText(png, {
    [MARKER_KEY]: MARKER_IMPORT,
    Title: `${sku.name} (Fernweave, fictional brand)`,
    Author: ascii(c.author),
    Copyright: ascii(`${c.license}${c.licenseUrl ? ` ${c.licenseUrl}` : ""}`),
    Source: ascii(c.sourceUrl ?? "own photo"),
    Comment: ascii(`Derived from "${c.title}": background removed, recoloured to ${sku.colorHex}, resized${extra ? ", length adjusted" : ""}${opts.mirror ? ", mirrored" : ""}. Generated by scripts/import-catalog.ts.`),
  });
  return { png, deltaE: deltaE2000(rec.meanLab, hexToLab(sku.colorHex)), garmentPx: Math.round(gH * f + extra), bytes: png.length };
}

/** PNG tEXt is Latin-1; keep attribution readable by transliterating the rest. */
function ascii(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "?");
}

/* ───────────────────────── Planning ───────────────────────── */

export interface OutputJob {
  sku: Sku;
  variant: "primary" | "alt";
  /** Basename in public/catalog. */
  file: string;
}

/** Every output file of a family, exactly the SKU image and alt-image set the catalogue references. */
export function outputsFor(family: string): OutputJob[] {
  const jobs: OutputJob[] = [];
  for (const sku of SKUS.filter((s) => s.family === family)) {
    jobs.push({ sku, variant: "primary", file: path.basename(sku.image) });
    if (sku.altImage) jobs.push({ sku, variant: "alt", file: path.basename(sku.altImage) });
  }
  return jobs;
}

export function categoryOf(family: string): Category {
  const sku = SKUS.find((s) => s.family === family);
  if (!sku) throw new Error(`Unknown family ${family}`);
  return sku.category;
}

/* ───────────────────────── Credits ───────────────────────── */

function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]<>|])/g, "\\$1");
}

/** Link destinations: percent-encode what would end or break a Markdown link. */
function mdUrl(url: string): string {
  return url.replace(/[()\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

interface CreditRow {
  family: string;
  name: string;
  files: string[];
  which: string;
  credit: Credit | null;
  alt: string | null;
  note?: string;
  source: FamilyEntry["source"];
}

function creditRows(m: Manifest): CreditRow[] {
  const rows: CreditRow[] = [];
  for (const family of FAMILIES) {
    const e = m.families[family]!;
    const name = SKUS.find((s) => s.family === family)!.name.split(" — ")[0]!.replace(/ (Tall|Petite)$/, "");
    const files = outputsFor(family).map((j) => j.file);
    if (e.source === "photo") {
      rows.push({
        family,
        name,
        files: files.filter((f) => !f.endsWith("-alt.png") || !e.alt),
        which: e.alt ? "front shots" : "all shots",
        credit: e.primary.credit,
        alt:
          e.alt || !SKUS.some((s) => s.family === family && s.altImage)
            ? null
            : "The alternate (-alt) shot is the same photo mirrored and framed 7% smaller.",
        note: e.note,
        source: e.source,
      });
      if (e.alt) rows.push({ family, name, files: files.filter((f) => f.endsWith("-alt.png")), which: "alternate shots", credit: e.alt.credit, alt: null, source: e.source });
    } else rows.push({ family, name, files, which: "all shots", credit: null, alt: null, note: e.note, source: e.source });
  }
  return rows;
}

function modifiedFor(family: string): string {
  const has = (v: string) => SKUS.some((s) => s.family === family && s.lengthVariant === v);
  const variants =
    has("tall") && has("petite")
      ? "Tall and Petite variants lengthened or shortened"
      : has("tall")
        ? "Tall variants lengthened"
        : has("petite")
          ? "Petite variants shortened"
          : null;
  return `background removed, recoloured to each colourway, resized and centred${variants ? `; ${variants} below the waist by the catalogue's length difference` : ""}; derived colourways`;
}

/** public/catalog/CREDITS.md generated from the manifest. */
export function creditsMarkdown(m: Manifest): string {
  const out: string[] = [
    "# Product photo credits",
    "",
    "Fernweave is a fictional brand made up for the TryBack hackathon demo. Each family's product shots are",
    "**AI-generated product images** made for this demo (no real product exists), **photographs of real",
    "garments** (licensed as listed below), or **generated placeholder drawings** (`scripts/gen-placeholders.ts`).",
    "Images and photos are edited by `scripts/import-catalog.ts`. None of the garments are Fernweave products;",
    "they stand in for them. Edited photos keep the source photo's licence: derivatives of CC BY-SA photos are",
    "licensed **CC BY-SA** under the same version, and the project's MIT licence does not apply to them.",
    "",
    "_Generated from `assets-src/catalog/manifest.json` by `npm run catalog:import`. Do not edit by hand._",
    "",
  ];
  for (const r of creditRows(m)) {
    out.push(`## ${mdEscape(r.name)}${r.which === "alternate shots" ? " (alternate shots)" : ""}`, "");
    out.push(`Files: ${r.files.map((f) => `\`${f}\``).join(", ")}`, "");
    if (!r.credit) {
      out.push(
        r.source === "manual"
          ? "- Product photos placed by hand in `public/catalog/` (see the team for their source)."
          : "- Generated placeholder drawing (`scripts/gen-placeholders.ts`), not a photograph. MIT, like the rest of the code.",
      );
      if (r.note) out.push(`- ${mdEscape(r.note)}`);
      out.push("");
      continue;
    }
    const c = r.credit;
    const lic = c.licenseUrl ? `[${mdEscape(c.license)}](${mdUrl(c.licenseUrl)})` : mdEscape(c.license);
    out.push(`- Title: ${c.sourceUrl ? `[${mdEscape(c.title)}](${mdUrl(c.sourceUrl)})` : mdEscape(c.title)}`);
    out.push(`- Author: ${mdEscape(c.author)}`);
    out.push(`- License: ${lic}${c.license.startsWith("CC BY-SA") ? ". These derivatives are licensed under the same CC BY-SA licence." : ""}`);
    if (c.note) out.push(`- Note: ${mdEscape(c.note)}`);
    out.push(`- Modified: ${modifiedFor(r.family)}.`);
    if (r.alt) out.push(`- ${r.alt}`);
    if (r.note) out.push(`- ${mdEscape(r.note)}`);
    out.push("");
  }
  return out.join("\n");
}

/** public/catalog/credits.html: the same content, readable in a browser (linked from the shopper footer). */
export function creditsHtml(m: Manifest): string {
  const items = creditRows(m)
    .map((r) => {
      const head = `<h2>${htmlEscape(r.name)}${r.which === "alternate shots" ? " <small>(alternate shots)</small>" : ""}</h2>`;
      const files = `<p class="files">${r.files.map((f) => `<code>${htmlEscape(f)}</code>`).join(" ")}</p>`;
      if (!r.credit) {
        const what =
          r.source === "manual"
            ? "Product photos placed by hand."
            : "Generated placeholder drawing (scripts/gen-placeholders.ts), not a photograph. MIT, like the rest of the code.";
        return `<section>${head}${files}<p>${what}</p>${r.note ? `<p>${htmlEscape(r.note)}</p>` : ""}</section>`;
      }
      const c = r.credit;
      const link = (text: string, url?: string) => (url ? `<a href="${htmlEscape(url)}" rel="noopener">${htmlEscape(text)}</a>` : htmlEscape(text));
      return `<section>${head}${files}<dl>
<dt>Title</dt><dd>${link(c.title, c.sourceUrl)}</dd>
<dt>Author</dt><dd>${htmlEscape(c.author)}</dd>
<dt>License</dt><dd>${link(c.license, c.licenseUrl)}${c.license.startsWith("CC BY-SA") ? ". These derivatives are licensed under the same CC BY-SA licence." : ""}</dd>
${c.note ? `<dt>Note</dt><dd>${htmlEscape(c.note)}</dd>` : ""}
<dt>Modified</dt><dd>${htmlEscape(modifiedFor(r.family))}.${r.alt ? ` ${htmlEscape(r.alt)}` : ""}</dd>
</dl></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Product photo credits</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f6;--fg:#1c1c1c;--muted:#6b6b6b;--line:#e4e1da}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#efede8;--muted:#a3a19b;--line:#2c2b29}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:28px 0 6px;padding-top:16px;border-top:1px solid var(--line)}
small,.files,.lead{color:var(--muted)}code{font-size:12px;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:8px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
a{color:inherit}
</style></head><body><main>
<h1>Product photo credits</h1>
<p class="lead">Fernweave is a fictional brand made up for the TryBack hackathon demo. Its product shots are either photographs of real garments (licensed as listed, then edited) or generated placeholder drawings. None of the photographed garments are Fernweave products. Edited images keep the source licence; derivatives of CC BY-SA photos are CC BY-SA.</p>
${items}
</main></body></html>
`;
}
