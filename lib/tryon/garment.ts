// Garment image preparation for the try-on API. Server-only.
//
// Reads public/<sku.image | sku.altImage>, flattens transparency onto white,
// fits within 1600 px, encodes JPEG q92 and guarantees the result is under 4 MB
// (the Clothsy upload limit). Results are memoised per (sku, variant) and
// invalidated automatically when the source file changes on disk, so
// `npm run assets` during `next dev` is picked up without a restart.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Sku } from "../types";
import { TryOnError } from "./types";

export const GARMENT_MAX_SIDE = 1600;
export const GARMENT_JPEG_QUALITY = 92;
/** Strictly below 4 MB under either reading (4,000,000 or 4 MiB). */
export const GARMENT_MAX_BYTES = 4_000_000 - 1;

export interface PreparedGarment {
  bytes: Buffer;
  hash: string;
  contentType: "image/jpeg";
}

type Variant = "primary" | "alt";

interface MemoEntry {
  stamp: string;
  promise: Promise<PreparedGarment>;
}

const g = globalThis as unknown as { __trybackGarmentMemo?: Map<string, MemoEntry> };
g.__trybackGarmentMemo ??= new Map();
const memo = g.__trybackGarmentMemo;

/** The public path used for a variant (alt falls back to the primary shot when the SKU has none). */
export function garmentPublicPath(sku: Sku, variant: Variant): string {
  return variant === "alt" && sku.altImage ? sku.altImage : sku.image;
}

/** Absolute file path under <cwd>/public, refusing anything that escapes it. */
export function garmentFilePath(publicPath: string): string {
  const publicDir = path.resolve(process.cwd(), "public");
  const rel = publicPath.replace(/^\/+/, "");
  const abs = path.resolve(publicDir, rel);
  if (abs !== publicDir && !abs.startsWith(publicDir + path.sep)) {
    throw new TryOnError("BAD_INPUT", `Garment image path escapes public/: ${publicPath}`, false);
  }
  return abs;
}

export async function loadGarmentImage(
  sku: Sku,
  variant: "primary" | "alt",
): Promise<{ bytes: Buffer; hash: string; contentType: "image/jpeg" }> {
  const publicPath = garmentPublicPath(sku, variant);
  const file = garmentFilePath(publicPath);

  let stat: { mtimeMs: number; size: number };
  try {
    stat = await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TryOnError(
        "GARMENT_IMAGE_MISSING",
        `Garment image not found: public${publicPath.startsWith("/") ? "" : "/"}${publicPath} (run "npm run assets").`,
        false,
      );
    }
    throw err;
  }

  const key = `${sku.id}:${variant}`;
  const stamp = `${file}|${stat.mtimeMs}|${stat.size}`;
  const hit = memo.get(key);
  if (hit && hit.stamp === stamp) return hit.promise;

  const promise = prepare(file, publicPath);
  memo.set(key, { stamp, promise });
  promise.catch(() => {
    if (memo.get(key)?.promise === promise) memo.delete(key);
  });
  return promise;
}

async function prepare(file: string, publicPath: string): Promise<PreparedGarment> {
  let source: Buffer;
  try {
    source = await fs.readFile(file);
  } catch (err) {
    throw new TryOnError("GARMENT_IMAGE_MISSING", `Could not read garment image ${publicPath}: ${(err as Error).message}`, false);
  }

  let bytes: Buffer;
  try {
    bytes = await encodeUnderLimit(source);
  } catch (err) {
    if (err instanceof TryOnError) throw err;
    throw new TryOnError("UNSUPPORTED_IMAGE", `Garment image ${publicPath} could not be decoded: ${(err as Error).message}`, false);
  }
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex"), contentType: "image/jpeg" };
}

/** Flatten → fit ≤1600 → JPEG q92; step quality, then size, down until under the byte limit. */
export async function encodeUnderLimit(source: Buffer, maxBytes: number = GARMENT_MAX_BYTES): Promise<Buffer> {
  const encode = (side: number, quality: number) =>
    sharp(source, { failOn: "error" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .jpeg({ quality, chromaSubsampling: quality >= 90 ? "4:4:4" : "4:2:0" })
      .toBuffer();

  let side = GARMENT_MAX_SIDE;
  for (const quality of [GARMENT_JPEG_QUALITY, 85, 78, 70]) {
    const out = await encode(side, quality);
    if (out.length <= maxBytes) return out;
  }
  for (side = Math.round(GARMENT_MAX_SIDE * 0.8); side >= 256; side = Math.round(side * 0.8)) {
    const out = await encode(side, 75);
    if (out.length <= maxBytes) return out;
  }
  throw new TryOnError("IMAGE_TOO_LARGE", "Garment image could not be compressed under 4 MB.", false);
}

/** Test/dev helper: drop all memoised garments. */
export function clearGarmentCache(): void {
  memo.clear();
}
