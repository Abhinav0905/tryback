/**
 * TryBack: import licensed garment photos into the Fernweave catalogue.
 *
 *   npx tsx scripts/import-catalog.ts                     import every "photo" family in the manifest
 *   npx tsx scripts/import-catalog.ts --only trench,linen-shirt
 *   npx tsx scripts/import-catalog.ts --dry-run           process everything, write nothing
 *   npx tsx scripts/import-catalog.ts --sheet sheet.png   also write a labelled contact sheet of all images
 *   npx tsx scripts/import-catalog.ts --force             also overwrite hand-placed photos in public/catalog
 *
 * Reads assets-src/catalog/manifest.json. For each family:
 *   "source": "photo"    rendered from the photo(s) it names (see scripts/lib/catalog-import.ts)
 *   "source": "drawing"  left alone: the placeholder from `npm run assets` stays
 *   "source": "manual"   left alone: product photos you dropped into public/catalog yourself
 *
 * Safety: an existing file is only replaced when it was written by this importer or by the
 * placeholder generator; anything else (a photo you placed by hand) is kept unless --force.
 * Also writes public/catalog/CREDITS.md and public/catalog/credits.html from the manifest.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SKUS } from "../lib/catalog";
import type { Category } from "../lib/types";
import {
  ALT_FRAME,
  FAMILIES,
  categoryOf,
  creditsHtml,
  creditsMarkdown,
  cutGarment,
  loadManifest,
  outputsFor,
  pxPerCmFor,
  sharedPxPerCm,
  renderSkuShot,
  type GarmentCut,
  type Manifest,
  type PhotoEntry,
} from "./lib/catalog-import";
import { CANVAS, classifyCatalogFile } from "./lib/imaging";
import { placeholderPxPerCm } from "./gen-placeholders";

interface Args {
  only: string[] | null;
  dryRun: boolean;
  force: boolean;
  sheet: string | null;
  manifest: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    only: null,
    dryRun: false,
    force: false,
    sheet: null,
    manifest: path.join("assets-src", "catalog", "manifest.json"),
    out: path.join("public", "catalog"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--only") args.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--sheet") args.sheet = next();
    else if (a === "--manifest") args.manifest = next();
    else if (a === "--out") args.out = next();
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/import-catalog.ts [--only family1,family2] [--dry-run] [--force] [--sheet sheet.png]\n" +
          "                                     [--manifest assets-src/catalog/manifest.json] [--out public/catalog]\n" +
          `Families: ${FAMILIES.join(", ")}`,
      );
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

interface Prepared {
  family: string;
  entry: PhotoEntry;
  primary: GarmentCut;
  alt: GarmentCut | null;
}

async function contactSheet(files: { file: string; label: string }[], dest: string): Promise<void> {
  const cols = 8;
  const tw = CANVAS.width / 4;
  const th = CANVAS.height / 4;
  const labelH = 16;
  const gap = 8;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(
    files.map(async ({ file, label }, i) => {
      const left = gap + (i % cols) * (tw + gap);
      const top = gap + Math.floor(i / cols) * (th + labelH + gap);
      const img = await sharp(file).resize(tw, th, { fit: "contain", background: "#ffffff" }).png().toBuffer();
      const text = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${labelH}"><text x="2" y="12" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#222">${label.replace(/[<&>]/g, "")}</text></svg>`,
      );
      return [
        { input: img, left, top },
        { input: text, left, top: top + th },
      ];
    }),
  );
  await sharp({
    create: { width: gap + cols * (tw + gap), height: gap + rows * (th + labelH + gap), channels: 3, background: "#d9d6d0" },
  })
    .composite(tiles.flat())
    .png()
    .toFile(dest);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  try {
    await fs.access(path.join(root, "lib", "catalog.ts"));
  } catch {
    throw new Error(`Run this from the project root. cwd=${root}`);
  }
  const manifestFile = path.resolve(root, args.manifest);
  const baseDir = path.dirname(manifestFile);
  const outDir = path.resolve(root, args.out);
  const manifest: Manifest = await loadManifest(manifestFile);

  if (args.only) {
    const unknown = args.only.filter((f) => !FAMILIES.includes(f));
    if (unknown.length) throw new Error(`Unknown family: ${unknown.join(", ")} (families: ${FAMILIES.join(", ")})`);
  }

  // Cut every photo family (all of them: the px-per-cm scale is shared per category, so an
  // --only run must still see the whole category to match a full run).
  const t0 = Date.now();
  const prepared: Prepared[] = [];
  for (const family of FAMILIES) {
    const entry = manifest.families[family]!;
    if (entry.source !== "photo") continue;
    const primary = await cutGarment(baseDir, entry.primary);
    const alt = entry.alt ? await cutGarment(baseDir, entry.alt) : null;
    prepared.push({ family, entry, primary, alt });
  }
  const photoFit = new Map<Category, number>();
  for (const p of prepared) {
    const cat = categoryOf(p.family);
    const skus = SKUS.filter((s) => s.family === p.family);
    const shots = [{ cut: p.primary, skus, frame: 1 }, ...(p.alt ? [{ cut: p.alt, skus, frame: ALT_FRAME }] : [])];
    photoFit.set(cat, Math.min(photoFit.get(cat) ?? Infinity, pxPerCmFor(shots)));
  }
  // Same scale as the placeholder drawings of the category, so mixed cards compare honestly.
  const scales = sharedPxPerCm(photoFit, placeholderPxPerCm());

  let written = 0;
  let kept = 0;
  const worst: { file: string; deltaE: number }[] = [];
  for (const p of prepared) {
    if (args.only && !args.only.includes(p.family)) continue;
    const pxPerCm = scales.get(categoryOf(p.family))!;
    console.log(`${p.family}: ${pxPerCm.toFixed(2)} px/cm (${categoryOf(p.family)})`);
    for (const job of outputsFor(p.family)) {
      const dest = path.join(outDir, job.file);
      const kind = await classifyCatalogFile(dest);
      if (kind === "photo" && !args.force) {
        kept += 1;
        console.log(`  keep ${job.file}: a hand-placed photo is there (use --force to replace it, or set "source": "manual")`);
        continue;
      }
      const useAlt = job.variant === "alt";
      const shot = useAlt && p.entry.alt && p.alt ? p.entry.alt : p.entry.primary;
      const cut = useAlt && p.alt ? p.alt : p.primary;
      const r = await renderSkuShot(cut, job.sku, {
        pxPerCm,
        frame: useAlt ? ALT_FRAME : 1,
        mirror: useAlt && !p.alt,
        waist: p.entry.waist,
        shot,
      });
      worst.push({ file: job.file, deltaE: r.deltaE });
      const status = args.dryRun ? "would write" : kind === "missing" ? "write" : `replace ${kind}`;
      console.log(
        `  ${status.padEnd(19)} ${job.file.padEnd(34)} ${(r.bytes / 1024).toFixed(0).padStart(4)} KB  garment ${String(r.garmentPx).padStart(3)} px  ΔE00 ${r.deltaE.toFixed(2)}`,
      );
      if (!args.dryRun) {
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(dest, r.png);
        written += 1;
      }
    }
  }
  for (const family of FAMILIES) {
    const e = manifest.families[family]!;
    if (e.source !== "photo" && (!args.only || args.only.includes(family))) console.log(`${family}: ${e.source}, left as is`);
  }

  if (!args.dryRun) {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "CREDITS.md"), creditsMarkdown(manifest));
    await fs.writeFile(path.join(outDir, "credits.html"), creditsHtml(manifest));
  }
  const maxDe = worst.reduce((m, w) => Math.max(m, w.deltaE), 0);
  console.log(
    `${args.dryRun ? "Dry run: " : ""}${args.dryRun ? worst.length : written} image(s) ${args.dryRun ? "rendered, nothing written" : "written"}` +
      `${kept ? `, ${kept} hand-placed kept` : ""} in ${((Date.now() - t0) / 1000).toFixed(1)} s · worst colour ΔE00 ${maxDe.toFixed(2)}` +
      (args.dryRun ? "" : ` · credits → ${path.relative(root, path.join(outDir, "CREDITS.md"))}`),
  );

  if (args.sheet) {
    const files: { file: string; label: string }[] = [];
    for (const sku of SKUS) {
      const src = manifest.families[sku.family]!.source;
      for (const web of [sku.image, sku.altImage]) {
        if (!web) continue;
        const file = path.join(outDir, path.basename(web));
        const exists = await fs.access(file).then(() => true, () => false);
        if (exists) files.push({ file, label: `${path.basename(web, ".png").replace(/^fw-/, "")} · ${src}` });
      }
    }
    const dest = path.resolve(root, args.sheet);
    await contactSheet(files, dest);
    console.log(`Contact sheet (${files.length} images) → ${dest}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
