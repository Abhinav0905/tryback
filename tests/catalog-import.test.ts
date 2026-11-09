// Catalogue importer: pixel helpers, manifest validation, the synthetic end-to-end pipeline, and
// the real imported product shots in public/catalog (colour accuracy, white background, frame).
import { execFileSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SKUS } from "@/lib/catalog";
import { deltaE2000, hexToLab, srgbToLab, type Lab } from "@/lib/color";
import { garmentDominantColour } from "@/lib/tryon/devDouble";
import { encodeUnderLimit } from "@/lib/tryon/garment";
import {
  CANVAS,
  MARKER_IMPORT,
  MARKER_KEY,
  MARKER_PLACEHOLDER,
  addPngText,
  classifyCatalogBytes,
  labToSrgb8,
  matte,
  readPngText,
  rasterPolygon,
  recolour,
  stretchBelow,
  type Rgba,
} from "@/scripts/lib/imaging";
import {
  FAMILIES,
  creditsMarkdown,
  sharedPxPerCm,
  cutGarment,
  loadManifest,
  outputsFor,
  parseManifest,
  pxPerCmFor,
  renderSkuShot,
  resolveAssetPath,
  type ShotSpec,
} from "@/scripts/lib/catalog-import";

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "assets-src", "catalog", "manifest.json");

/* ───────────────────────── Synthetic fixture ───────────────────────── */

/** A dress silhouette (pixel coords for a W×H image). */
function dressPolygon(W: number, H: number): [number, number][] {
  const cx = W / 2;
  return [
    [cx - 0.12 * W, 0.12 * H],
    [cx + 0.12 * W, 0.12 * H],
    [cx + 0.2 * W, 0.2 * H],
    [cx + 0.17 * W, 0.45 * H],
    [cx + 0.3 * W, 0.88 * H],
    [cx - 0.3 * W, 0.88 * H],
    [cx - 0.17 * W, 0.45 * H],
    [cx - 0.2 * W, 0.2 * H],
  ];
}

/** Grey studio background with a vertical gradient and a dusty-pink garment with fold shading. */
function fixture(W = 300, H = 400): { img: Rgba; truth: Uint8Array } {
  const truth = rasterPolygon(W, H, dressPolygon(W, H));
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const p = i * 4;
      if (truth[i]) {
        const fold = 18 * Math.sin(x / 9) + 8 * Math.sin(y / 23);
        data[p] = Math.max(0, Math.min(255, 196 + fold));
        data[p + 1] = Math.max(0, Math.min(255, 160 + fold));
        data[p + 2] = Math.max(0, Math.min(255, 164 + fold));
      } else {
        const g = 200 + Math.round((y / H) * 18);
        data[p] = g;
        data[p + 1] = g;
        data[p + 2] = g + 2;
      }
      data[p + 3] = 255;
    }
  }
  return { img: { data, width: W, height: H }, truth };
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! > 0;
    const y = b[i]! > 0;
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : 1;
}

function meanAndStdL(img: Rgba, minAlpha = 250): { mean: Lab; stdL: number } {
  let n = 0;
  const s: Lab = [0, 0, 0];
  const ls: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) {
    const p = i * 4;
    if (img.data[p + 3]! < minAlpha) continue;
    const lab = srgbToLab(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!);
    s[0] += lab[0];
    s[1] += lab[1];
    s[2] += lab[2];
    ls.push(lab[0]);
    n++;
  }
  const mean: Lab = [s[0] / n, s[1] / n, s[2] / n];
  const v = ls.reduce((acc, l) => acc + (l - mean[0]) ** 2, 0) / n;
  return { mean, stdL: Math.sqrt(v) };
}

/* ───────────────────────── Pixel helpers ───────────────────────── */

describe("imaging helpers", () => {
  it("CIELAB → sRGB inverts lib/color for every catalogue colour", () => {
    for (const sku of SKUS) {
      const lab = hexToLab(sku.colorHex);
      const [r, g, b] = labToSrgb8(lab);
      expect(deltaE2000(srgbToLab(r, g, b), lab)).toBeLessThan(0.5);
    }
  });

  it("rasterises polygons by pixel centres", () => {
    const m = rasterPolygon(20, 20, [
      [5, 5],
      [15, 5],
      [15, 15],
      [5, 15],
    ]);
    expect(m.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("stretches only below the waist", () => {
    const W = 4;
    const H = 50;
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([y * 5, 0, 0, 255], (y * W + x) * 4);
    const out = stretchBelow({ data, width: W, height: H }, 20, 10, 4);
    expect(out.height).toBe(60);
    for (let y = 0; y < 20; y++) expect(out.data[y * W * 4]).toBe(y * 5);
    // The last row is still the original hem.
    expect(out.data[(out.height - 1) * W * 4]).toBe((H - 1) * 5);
  });

  it("round-trips PNG text markers and classifies catalogue files", async () => {
    const png768 = await sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 3, background: "#fff" } }).png().toBuffer();
    const imported = addPngText(png768, { [MARKER_KEY]: MARKER_IMPORT, Author: "A. Person" });
    expect(readPngText(imported)).toMatchObject({ [MARKER_KEY]: MARKER_IMPORT, Author: "A. Person" });
    expect((await sharp(imported).metadata()).width).toBe(CANVAS.width); // still a valid PNG
    expect(classifyCatalogBytes(imported)).toBe("imported");
    expect(classifyCatalogBytes(addPngText(png768, { [MARKER_KEY]: MARKER_PLACEHOLDER }))).toBe("placeholder");
    // An unmarked PNG in the catalogue frame is a hand-placed photo (a user re-saving their own
    // garment photo at 768×1024 must never be regenerated over or reported as a drawing).
    expect(classifyCatalogBytes(png768)).toBe("photo");
    // Anything else is a hand-placed photo and must never be overwritten.
    const other = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#eee" } }).png().toBuffer();
    expect(classifyCatalogBytes(other)).toBe("photo");
    const jpeg = await sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 3, background: "#eee" } }).jpeg().toBuffer();
    expect(classifyCatalogBytes(jpeg)).toBe("photo");
  });

  it("every committed drawing carries the placeholder marker, so unmarked files are always photos", async () => {
    const dir = path.join(process.cwd(), "public", "catalog");
    const kinds = new Map<string, string>();
    for (const sku of SKUS) {
      for (const img of [sku.image, sku.altImage]) {
        if (!img) continue;
        kinds.set(img, classifyCatalogBytes(await fs.readFile(path.join(dir, path.basename(img)))));
      }
    }
    const placeholders = [...kinds].filter(([, k]) => k === "placeholder").map(([f]) => f);
    // Families still drawn (assets-src/catalog/manifest.json "drawing") are marked placeholders;
    // nothing in the catalogue is an unmarked file unless someone placed a photo by hand.
    const manifest = JSON.parse(await fs.readFile(path.join(process.cwd(), "assets-src", "catalog", "manifest.json"), "utf8")) as {
      families: Record<string, { source: string }>;
    };
    for (const sku of SKUS) {
      const source = manifest.families[sku.family]?.source;
      const kind = kinds.get(sku.image);
      if (source === "drawing") expect(kind, sku.image).toBe("placeholder");
      if (source === "photo") expect(kind, sku.image).toBe("imported");
    }
    // Exactly the drawn families' images are placeholders (none once every family is photographed).
    const drawnImages = new Set(
      SKUS.filter((s) => manifest.families[s.family]?.source === "drawing").flatMap((s) => [s.image, s.altImage].filter(Boolean) as string[]),
    );
    expect(placeholders.sort()).toEqual([...drawnImages].sort());
  });
});

/* ───────────────────────── Matte + recolour ───────────────────────── */

describe("matte and recolour on a synthetic garment", () => {
  it("separates the garment from a graded background", () => {
    const { img, truth } = fixture();
    const { mask, alpha } = matte(img, { tolerance: 10 });
    expect(iou(mask, truth)).toBeGreaterThan(0.97);
    // Corners are background.
    expect(alpha[0]).toBe(0);
    expect(alpha[alpha.length - 1]).toBe(0);
  });

  it("erase polygons remove a stand even when it differs from the background", () => {
    const { img, truth } = fixture();
    const W = img.width;
    const H = img.height;
    // A dark pole under the hem, touching the garment.
    for (let y = Math.round(0.88 * H) - 2; y < H; y++) for (let x = W / 2 - 3; x < W / 2 + 3; x++) img.data.set([40, 40, 40, 255], (y * W + x) * 4);
    const withPole = matte(img, { tolerance: 10 });
    expect(iou(withPole.mask, truth)).toBeLessThan(0.995);
    const erased = matte(img, {
      tolerance: 10,
      erase: [
        [
          [W / 2 - 10, 0.885 * H],
          [W / 2 + 10, 0.885 * H],
          [W / 2 + 10, H],
          [W / 2 - 10, H],
        ],
      ],
    });
    let poleLeft = 0;
    for (let y = Math.round(0.9 * H); y < H; y++) poleLeft += erased.mask[y * W + W / 2]!;
    expect(poleLeft).toBe(0);
  });

  it.each(["#1F2A44", "#1C1C1C", "#F4F3EF", "#EDE6D6", "#D8C3A5", "#2851A3", "#C9A227", "#9CAF88"])(
    "recolours to %s with the mean on target and the folds kept",
    (hex) => {
      const { img, truth } = fixture();
      const alphaImg: Rgba = { data: img.data.slice(), width: img.width, height: img.height };
      for (let i = 0; i < truth.length; i++) alphaImg.data[i * 4 + 3] = truth[i] ? 255 : 0;
      const r = recolour(alphaImg, hex);
      expect(r.deltaE).toBeLessThan(1);
      const { mean, stdL } = meanAndStdL(r.image);
      expect(deltaE2000(mean, hexToLab(hex))).toBeLessThan(1);
      // Shading survives even at the ends of the range (black folds, white shadows).
      expect(stdL).toBeGreaterThan(1.5);
      // Background pixels are untouched (alpha 0 stays 0).
      expect(r.image.data[3]).toBe(0);
    },
  );
});

/* ───────────────────────── Manifest ───────────────────────── */

function drawingManifest(): { version: 1; families: Record<string, unknown> } {
  return { version: 1, families: Object.fromEntries(FAMILIES.map((f) => [f, { source: "drawing" }])) };
}

const CREDIT = {
  title: "Test garment",
  author: "Test author",
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  sourceUrl: "https://example.org/garment",
};

describe("manifest validation", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tryback-manifest-"));
    await fs.mkdir(path.join(dir, "raw", "trench"), { recursive: true });
    await fs.writeFile(path.join(dir, "raw", "trench", "ok.jpg"), await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ccc" } }).jpeg().toBuffer());
    const outside = path.join(os.tmpdir(), `tryback-outside-${process.pid}.jpg`);
    await fs.writeFile(outside, "x");
    await fs.symlink(outside, path.join(dir, "raw", "trench", "link.jpg"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join(os.tmpdir(), `tryback-outside-${process.pid}.jpg`), { force: true });
  });

  it("accepts a valid manifest", () => {
    const m = drawingManifest();
    m.families.trench = { source: "photo", primary: { file: "raw/trench/ok.jpg", credit: CREDIT } };
    expect(parseManifest(m, dir).families.trench?.source).toBe("photo");
  });

  it.each([
    ["../outside.jpg", /\.\./],
    ["raw/../../outside.jpg", /\.\./],
    ["/etc/hosts.jpg", /relative/],
    ["raw\\trench\\ok.jpg", /Invalid/],
    ["raw/trench/ok.txt", /\.jpg/],
    ["raw/trench/link.jpg", /link/],
    ["raw/trench/missing.jpg", /not found/],
  ])("rejects the asset path %s", (file, msg) => {
    const m = drawingManifest();
    m.families.trench = { source: "photo", primary: { file, credit: CREDIT } };
    expect(() => parseManifest(m, dir)).toThrow(msg);
    expect(() => resolveAssetPath(dir, file)).toThrow();
  });

  it("rejects unknown or missing families, NC licences and incomplete credits", () => {
    const unknown = drawingManifest();
    unknown.families["ball-gown"] = { source: "drawing" };
    expect(() => parseManifest(unknown, dir)).toThrow(/ball-gown/);

    const missing = drawingManifest();
    delete missing.families["knit-top"];
    expect(() => parseManifest(missing, dir)).toThrow(/knit-top: missing/);

    const nc = drawingManifest();
    nc.families.trench = { source: "photo", primary: { file: "raw/trench/ok.jpg", credit: { ...CREDIT, license: "CC BY-NC 4.0" } } };
    expect(() => parseManifest(nc, dir)).toThrow(/license/);

    const noUrl = drawingManifest();
    noUrl.families.trench = { source: "photo", primary: { file: "raw/trench/ok.jpg", credit: { ...CREDIT, licenseUrl: undefined } } };
    expect(() => parseManifest(noUrl, dir)).toThrow(/licenseUrl/);

    const typo = drawingManifest();
    typo.families.trench = { source: "photo", primary: { file: "raw/trench/ok.jpg", credit: CREDIT, cropp: {} } };
    expect(() => parseManifest(typo, dir)).toThrow();
  });
});

/* ───────────────────────── Synthetic end-to-end ───────────────────────── */

describe("pipeline on a synthetic photo", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tryback-import-"));
    await fs.mkdir(path.join(dir, "raw", "linen-shirt"), { recursive: true });
    const { img } = fixture(600, 800);
    await sharp(Buffer.from(img.data), { raw: { width: 600, height: 800, channels: 4 } })
      .removeAlpha()
      .jpeg({ quality: 92 })
      .toFile(path.join(dir, "raw", "linen-shirt", "fixture.jpg"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("renders every SKU of the family in the placeholder frame, on target, white background, tall longer", async () => {
    const shot: ShotSpec = { file: "raw/linen-shirt/fixture.jpg", background: { mode: "auto", tolerance: 10 }, credit: CREDIT as ShotSpec["credit"] };
    const cut = await cutGarment(dir, shot);
    const skus = SKUS.filter((s) => s.family === "linen-shirt");
    const pxPerCm = pxPerCmFor([{ cut, skus, frame: 1 }]);
    const heights = new Map<string, number>();
    for (const job of outputsFor("linen-shirt")) {
      const r = await renderSkuShot(cut, job.sku, { pxPerCm, shot, waist: 0.45, frame: job.variant === "alt" ? 0.93 : 1, mirror: job.variant === "alt" });
      expect(r.deltaE).toBeLessThan(1);
      heights.set(job.sku.id, r.garmentPx);
      const { data, info } = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([CANVAS.width, CANVAS.height]);
      expect(readPngText(r.png)[MARKER_KEY]).toBe(MARKER_IMPORT);
      // The padding frame is pure white.
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if (x >= CANVAS.padX - 8 && x < info.width - CANVAS.padX + 8 && y >= CANVAS.padY - 8 && y < info.height - CANVAS.padY + 8) continue;
          const p = (y * info.width + x) * info.channels;
          expect(data[p] + data[p + 1] + data[p + 2]).toBe(765);
        }
      }
    }
    // Tall adds 6 cm: the garment is that much longer at the shared px/cm.
    const regular = heights.get("fw-linen-shirt-white")!;
    const tall = heights.get("fw-linen-shirt-white-tall")!;
    expect(tall - regular).toBeGreaterThanOrEqual(Math.floor(6 * pxPerCm) - 1);
  }, 30_000); // renders every SKU of a family: slow when the whole suite runs in parallel

  it("CLI: replaces placeholders, keeps hand-placed photos unless --force, writes nothing on --dry-run", async () => {
    const m = drawingManifest();
    m.families["linen-shirt"] = { source: "photo", primary: { file: "raw/linen-shirt/fixture.jpg", background: { tolerance: 10 }, credit: CREDIT } };
    const manifestFile = path.join(dir, "manifest.json");
    await fs.writeFile(manifestFile, JSON.stringify(m));
    const out = path.join(dir, "out");
    await fs.mkdir(out, { recursive: true });
    const handPlaced = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#abcdef" } }).png().toBuffer();
    const frame = await sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 3, background: "#fff" } }).png().toBuffer();
    const placeholder = addPngText(frame, { [MARKER_KEY]: MARKER_PLACEHOLDER });
    // A user's own photo saved in the catalogue frame (768×1024 PNG, no marker) is a photo too.
    const handPlacedFramed = await sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 3, background: "#c0a080" } }).png().toBuffer();
    await fs.writeFile(path.join(out, "fw-linen-shirt-sky.png"), handPlaced);
    await fs.writeFile(path.join(out, "fw-linen-shirt-white.png"), placeholder);
    await fs.writeFile(path.join(out, "fw-linen-shirt-olive.png"), handPlacedFramed);
    const run = (...extra: string[]) =>
      execFileSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/import-catalog.ts", "--manifest", manifestFile, "--out", out, ...extra], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe",
      });

    run("--dry-run");
    expect(await fs.readdir(out)).toHaveLength(3);

    const log = run();
    expect(log).toMatch(/keep fw-linen-shirt-sky\.png/);
    expect(log).toMatch(/keep fw-linen-shirt-olive\.png/);
    expect((await fs.readFile(path.join(out, "fw-linen-shirt-sky.png"))).equals(handPlaced)).toBe(true);
    expect((await fs.readFile(path.join(out, "fw-linen-shirt-olive.png"))).equals(handPlacedFramed)).toBe(true);
    expect(readPngText(await fs.readFile(path.join(out, "fw-linen-shirt-white.png")))[MARKER_KEY]).toBe(MARKER_IMPORT);
    for (const f of ["fw-linen-shirt-olive.png", "fw-linen-shirt-white-tall.png", "fw-linen-shirt-sky-tall.png", "CREDITS.md", "credits.html"]) {
      expect(existsSync(path.join(out, f)), f).toBe(true);
    }
    // Families left as drawings were not written.
    expect(existsSync(path.join(out, "fw-trench-stone.png"))).toBe(false);

    run("--force");
    expect(readPngText(await fs.readFile(path.join(out, "fw-linen-shirt-sky.png")))[MARKER_KEY]).toBe(MARKER_IMPORT);
  }, 60_000);
});

/* ───────────────────────── Real catalogue ───────────────────────── */

async function garmentStats(file: string): Promise<{ mean: Lab; height: number; borderWhite: boolean }> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const s: Lab = [0, 0, 0];
  let n = 0;
  let top = H;
  let bottom = -1;
  let borderWhite = true;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      const r = data[p]!;
      const g = data[p + 1]!;
      const b = data[p + 2]!;
      const white = r === 255 && g === 255 && b === 255;
      if (x < 24 || y < 24 || x >= W - 24 || y >= H - 24) {
        if (!white) borderWhite = false;
        continue;
      }
      if (white) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if ((x + y) % 2) continue; // subsample for speed
      const lab = srgbToLab(r, g, b);
      s[0] += lab[0];
      s[1] += lab[1];
      s[2] += lab[2];
      n++;
    }
  }
  return { mean: [s[0] / n, s[1] / n, s[2] / n], height: bottom - top + 1, borderWhite };
}

describe("imported catalogue images (public/catalog)", async () => {
  const manifest = await loadManifest(MANIFEST);
  const photoFamilies = FAMILIES.filter((f) => manifest.families[f]?.source === "photo");

  it("the manifest is valid and every catalogue image exists", () => {
    expect(photoFamilies.length).toBeGreaterThan(0);
    for (const sku of SKUS) {
      for (const web of [sku.image, sku.altImage]) {
        if (web) expect(existsSync(path.join(ROOT, "public", web)), web).toBe(true);
      }
    }
  });

  const jobs = photoFamilies.flatMap((f) => outputsFor(f));
  it.each(jobs.map((j) => [j.file, j] as const))("%s: frame, marker, white background, colour on target", async (_file, job) => {
    const file = path.join(ROOT, "public", "catalog", job.file);
    const buf = await fs.readFile(file);
    const meta = await sharp(buf).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", CANVAS.width, CANVAS.height]);
    expect(readPngText(buf)[MARKER_KEY]).toBe(MARKER_IMPORT);
    const st = await garmentStats(file);
    expect(st.borderWhite).toBe(true);
    // Mean garment colour (anti-aliased rim included) reads as the SKU colour.
    expect(deltaE2000(st.mean, hexToLab(job.sku.colorHex))).toBeLessThan(6);
    // The dev double samples the same colour from the prepared product shot.
    const dom = await garmentDominantColour(await encodeUnderLimit(buf));
    expect(deltaE2000(srgbToLab(dom.r, dom.g, dom.b), hexToLab(job.sku.colorHex))).toBeLessThan(8);
  });

  it("tall variants are visibly longer than regular ones", async () => {
    const pairs = SKUS.filter((s) => s.lengthVariant === "tall" && manifest.families[s.family]?.source === "photo").map((tall) => [
      SKUS.find((s) => s.family === tall.family && s.colorName === tall.colorName && s.lengthVariant === "regular")!,
      tall,
    ]);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [reg, tall] of pairs) {
      const a = await garmentStats(path.join(ROOT, "public", reg!.image));
      const b = await garmentStats(path.join(ROOT, "public", tall!.image));
      expect(b.height - a.height, `${tall!.id} vs ${reg!.id}`).toBeGreaterThan(25);
    }
  });

  it("CREDITS.md is in sync with the manifest and names every photo source", async () => {
    const md = await fs.readFile(path.join(ROOT, "public", "catalog", "CREDITS.md"), "utf8");
    expect(md).toBe(creditsMarkdown(manifest));
    for (const f of photoFamilies) {
      const e = manifest.families[f]!;
      if (e.source !== "photo") continue;
      expect(md).toContain(e.primary.credit.author.replace(/([\\`*_[\]<>|])/g, "\\$1"));
      if (e.primary.credit.license.startsWith("CC BY-SA")) expect(md).toContain("licensed under the same CC BY-SA licence");
    }
    expect(existsSync(path.join(ROOT, "public", "catalog", "credits.html"))).toBe(true);
  });

  it("photographed and drawn garments of a category share one px-per-cm, so lengths compare honestly", async () => {
    expect(sharedPxPerCm(new Map([["dress", 8.8], ["top", 6]]), new Map([["dress", 6.77], ["top", 6.65]]))).toEqual(
      new Map([["dress", 6.77], ["top", 6]]),
    );
    expect(sharedPxPerCm(new Map([["outerwear", 7]]), new Map())).toEqual(new Map([["outerwear", 7]]));
    // Dresses only: their bounding box is shoulder-to-hem; a drawn long-sleeved top's sleeves hang
    // below its hem, so its box isn't a length measure.
    for (const category of ["dress"] as const) {
      const ratios: { id: string; r: number }[] = [];
      for (const sku of SKUS.filter((s) => s.category === category && s.lengthVariant === "regular")) {
        const st = await garmentStats(path.join(ROOT, "public", sku.image));
        ratios.push({ id: sku.id, r: st.height / sku.poms.M.hpsToHemCm });
      }
      const rs = ratios.map((x) => x.r);
      expect(Math.max(...rs) / Math.min(...rs), `${category}: ${JSON.stringify(ratios)}`).toBeLessThan(1.12);
    }
  });

  it("CREDITS.md only describes shots and variants that exist", async () => {
    const md = await fs.readFile(path.join(ROOT, "public", "catalog", "CREDITS.md"), "utf8");
    const sections = md.split(/^## /m).slice(1);
    for (const f of photoFamilies) {
      const skus = SKUS.filter((s) => s.family === f);
      const name = skus[0]!.name.split(" — ")[0]!.replace(/ (Tall|Petite)$/, "");
      const body = sections.find((x) => x.startsWith(`${name}\n`)) ?? "";
      expect(body, f).not.toBe("");
      const entry = manifest.families[f]!;
      const ownAltPhoto = entry.source === "photo" && Boolean(entry.alt);
      expect(body.includes("mirrored"), `${f}: alt sentence`).toBe(skus.some((s) => s.altImage) && !ownAltPhoto);
      expect(body.includes("Petite"), `${f}: Petite`).toBe(skus.some((s) => s.lengthVariant === "petite"));
      expect(body.includes("Tall variants"), `${f}: Tall`).toBe(skus.some((s) => s.lengthVariant === "tall"));
    }
  });
});
