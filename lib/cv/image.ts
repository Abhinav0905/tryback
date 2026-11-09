// Browser image helpers: normalise the shopper photo before anything else touches it.
// The normalised JPEG is the exact file uploaded to the server and the coordinate
// space for every keypoint and mask. Runs on-device only.

export const MAX_PHOTO_SIDE = 1600;
/** Upload budget (server limit is 4 MB; keep headroom for multipart overhead). */
export const MAX_PHOTO_BYTES = 3.8 * 1024 * 1024;
const START_QUALITY = 0.9;
const MIN_QUALITY = 0.5;

function assertBrowser(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("lib/cv/image runs in the browser only.");
  }
}

function context2d(canvas: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", opts);
  if (!ctx) throw new Error("Canvas 2D isn't available in this browser.");
  return ctx;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Couldn't encode the photo."))),
      type,
      quality,
    );
  });
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/** Decode with EXIF orientation applied. createImageBitmap first; <img> as a fallback (older Safari). */
async function decodeOriented(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* fall through to <img>, which applies EXIF orientation by default in modern browsers */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * True for a baseline-clean JPEG: no APP1 (EXIF/XMP: orientation, GPS…) or APP13 (IPTC)
 * segment before the image data. Null when the markers can't be walked (treated as "no").
 */
export async function isMetadataFreeJpeg(file: Blob): Promise<boolean | null> {
  const view = new DataView(await file.slice(0, 512 * 1024).arrayBuffer());
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 <= view.byteLength) {
    const marker = view.getUint16(off);
    if ((marker & 0xff00) !== 0xff00) return null;
    if (marker === 0xffda || marker === 0xffd9) return true; // start of scan: no metadata before the pixels
    if (marker === 0xffe1 || marker === 0xffed) return false;
    const len = view.getUint16(off + 2);
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

/**
 * EXIF-correct, un-mirror (front-camera captures), fit within `maxSide` (default 1600),
 * and encode as JPEG q0.9, lowering quality (then size) until it's under 3.8 MB.
 * An upload that already is a metadata-free JPEG within the limits is passed through
 * byte-for-byte: re-encoding depends on the browser's decoder and encoder, so the same file
 * would hash differently in Safari, Firefox and Chrome and miss the shared render cache.
 * The caller owns the returned object URL and should `URL.revokeObjectURL` it when done.
 */
export async function normalizePhoto(
  file: Blob,
  opts?: { mirrored?: boolean; maxSide?: number },
): Promise<{ blob: Blob; width: number; height: number; url: string }> {
  assertBrowser();
  if (!file || file.size === 0) throw new Error("That photo looks empty — please try again.");
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("That file isn't an image. Please choose a photo (JPEG or PNG).");
  }

  let decoded: Decoded;
  try {
    decoded = await decodeOriented(file);
  } catch {
    throw new Error("We couldn't read that photo. Try a JPEG or PNG (some HEIC photos aren't supported by this browser).");
  }

  try {
    if (decoded.width < 64 || decoded.height < 64) {
      throw new Error("That photo is too small — please use a full-resolution photo.");
    }
    const maxSide = Math.max(256, Math.floor(opts?.maxSide ?? MAX_PHOTO_SIDE));
    if (
      !opts?.mirrored &&
      file.type === "image/jpeg" &&
      file.size < MAX_PHOTO_BYTES &&
      Math.max(decoded.width, decoded.height) <= maxSide &&
      (await isMetadataFreeJpeg(file).catch(() => null)) === true
    ) {
      return { blob: file, width: decoded.width, height: decoded.height, url: URL.createObjectURL(file) };
    }
    let scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));

    for (let attempt = 0; attempt < 4; attempt++) {
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = createCanvas(width, height);
      const ctx = context2d(canvas);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // JPEG has no alpha: flatten onto white so transparent PNGs don't turn black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      if (opts?.mirrored) {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(decoded.source, 0, 0, width, height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      for (let q = START_QUALITY; q >= MIN_QUALITY - 1e-9; q -= 0.1) {
        const blob = await toBlob(canvas, "image/jpeg", Math.round(q * 100) / 100);
        if (blob.size < MAX_PHOTO_BYTES) {
          releaseCanvas(canvas);
          return { blob, width, height, url: URL.createObjectURL(blob) };
        }
      }
      releaseCanvas(canvas);
      scale *= 0.8; // still too big at the lowest quality: shrink and try again
    }
    throw new Error("That photo is too large to upload — please try a smaller one.");
  } finally {
    decoded.release();
  }
}

/** Free a canvas's backing store early (Safari keeps large canvases alive otherwise). */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** Load and decode an image. Cross-origin http(s) sources are requested with CORS so canvases stay readable. */
export async function loadImage(src: string): Promise<HTMLImageElement> {
  assertBrowser();
  const img = new Image();
  img.decoding = "async";
  try {
    const u = new URL(src, window.location.href);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.origin !== window.location.origin) {
      img.crossOrigin = "anonymous";
    }
  } catch {
    /* relative or opaque URL: same origin */
  }
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Couldn't load image ${src.startsWith("blob:") ? "(local photo)" : src}`));
    img.src = src;
  });
  if (typeof img.decode === "function") {
    try {
      await img.decode();
    } catch {
      /* already loaded; decode() can reject spuriously in some browsers */
    }
  }
  if (!img.naturalWidth || !img.naturalHeight) throw new Error(`Image has no pixels: ${src}`);
  return img;
}

/** Draw any image source onto a new canvas of exactly width×height (stretching if aspect differs). */
export function imageToCanvas(img: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  assertBrowser();
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas, { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Draw `img` (srcW×srcH) onto a width×height canvas, centre-cropped to the canvas aspect
 * (like CSS object-fit: cover), so proportions are kept when the aspects differ.
 */
export function imageToCanvasCover(
  img: CanvasImageSource,
  srcW: number,
  srcH: number,
  width: number,
  height: number,
): HTMLCanvasElement {
  assertBrowser();
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas, { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const target = canvas.width / canvas.height;
  let sw = srcW;
  let sh = srcH;
  if (srcW / srcH > target) sw = srcH * target;
  else sh = srcW / target;
  ctx.drawImage(img, (srcW - sw) / 2, (srcH - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** RGBA pixels of a canvas. */
export function canvasRgba(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const ctx = context2d(canvas, { willReadFrequently: true });
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Fit (w, h) inside a box whose longest side is `maxSide`, never upscaling. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}
