// Garment/face/person segmentation (browser) with MediaPipe selfie_multiclass_256x256.
// The model works at 256×256; we feed a downscaled canvas (no accuracy loss, much less
// GPU upload/readback), then nearest-neighbour upsample the category mask to width×height.

import type { Mask } from "./geometry";
import { resampleNearest } from "./geometry";
import { SEG, withSegmenter } from "./mediapipe";

export interface PartsMasks {
  clothes: Mask;
  face: Mask;
  person: Mask;
}

/** Longest side of the image handed to the segmenter. */
const SEGMENT_INPUT_MAX_SIDE = 512;

function downscaledSource(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): { input: HTMLImageElement | HTMLCanvasElement; release: () => void } {
  const scale = Math.min(1, SEGMENT_INPUT_MAX_SIDE / Math.max(width, height));
  if (scale >= 1) return { input: source, release: () => undefined };
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D isn't available in this browser.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return {
    input: c,
    release: () => {
      c.width = 0;
      c.height = 0;
    },
  };
}

/** Raw category mask (values 0..5) at the model's output resolution. */
export async function segmentCategories(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): Promise<{ categories: Uint8Array; width: number; height: number }> {
  if (typeof document === "undefined") throw new Error("segmentParts runs in the browser only.");
  if (!(width > 0 && height > 0)) throw new Error("segmentParts: width and height must be positive");
  const { input, release } = downscaledSource(source, width, height);
  try {
    return await withSegmenter((seg) => {
      const result = seg.segment(input);
      try {
        const cm = result.categoryMask;
        if (!cm) throw new Error("The segmenter returned no category mask.");
        // Copy out: the mask's buffer is owned by MediaPipe and freed on close().
        const categories = new Uint8Array(cm.getAsUint8Array());
        // Category indices must be 0..5. Anything else means a delegate returned a
        // differently encoded mask; throwing here makes withSegmenter retry on CPU.
        for (let i = 0; i < categories.length; i++) {
          if (categories[i] > SEG.others) throw new Error(`Unexpected segmentation category ${categories[i]}`);
        }
        return { categories, width: cm.width, height: cm.height };
      } finally {
        result.close();
      }
    });
  } finally {
    release();
  }
}

/** Split a width×height category buffer into binary masks in one pass. */
export function categoriesToParts(categories: Uint8Array, width: number, height: number): PartsMasks {
  const n = width * height;
  const clothes = new Uint8Array(n);
  const face = new Uint8Array(n);
  const person = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = categories[i];
    if (c === SEG.background) continue;
    person[i] = 1;
    if (c === SEG.clothes) clothes[i] = 1;
    else if (c === SEG.faceSkin) face[i] = 1;
  }
  return {
    clothes: { data: clothes, width, height },
    face: { data: face, width, height },
    person: { data: person, width, height },
  };
}

/** Clothes / face-skin / whole-person masks, upsampled (nearest neighbour) to width×height. */
export async function segmentParts(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): Promise<PartsMasks> {
  const w = Math.round(width);
  const h = Math.round(height);
  const raw = await segmentCategories(source, w, h);
  const full = resampleNearest(raw.categories, raw.width, raw.height, w, h);
  return categoriesToParts(full, w, h);
}
