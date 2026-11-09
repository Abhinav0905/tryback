import { createHash } from "node:crypto";
import sharp from "sharp";
import { getSku } from "@/lib/catalog";
import { PhotoPayload } from "@/lib/apiSchemas";
import { scheduleAndRun, toPick } from "@/lib/apiRender";
import {
  advanceStatus,
  ApiError,
  assertNotResolved,
  handle,
  parseWith,
  requireReturn,
  returnResponse,
} from "@/lib/apiRoute";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/bodyLimit";
import { limitRequest, RATE_RULES } from "@/lib/ratelimit";
import { speculativePicks } from "@/lib/retrieval";
import { mutate, savePhoto } from "@/lib/store";
import type { PhotoMeasurements, ReturnCase } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
/** Whole multipart request: the photo plus the JSON payload and part headers. */
const MAX_REQUEST_BYTES = MAX_PHOTO_BYTES + 512 * 1024;
const TOO_LARGE = "That photo is larger than 4 MB. Please retake or choose a smaller one.";
const MAX_SIDE = 1600;
const MIN_SIDE = 256;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png"]);

// POST /api/returns/[id]/photo  multipart: photo (image/jpeg|png ≤4MB) + payload (JSON string
// { adultAttested: true, preflight, measurements }) → { return }.
// The photo is stored locally and only ever sent to the try-on provider — never to the LLM.
export async function POST(req: Request, ctx: RouteContext<"/api/returns/[id]/photo">): Promise<Response> {
  const limited = limitRequest(req, RATE_RULES.photoUpload);
  if (limited) return limited;
  return handle(async () => {
    const { id } = await ctx.params;
    const existing = await requireReturn(id);
    assertNotResolved(existing);
    assertPhotoReplaceable(existing);

    const type = req.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data/i.test(type)) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the photo as multipart/form-data.");
    }

    // Counted while it streams in (Content-Length is optional), so an oversized upload is
    // refused before it is buffered; the declared length short-circuits it entirely.
    let form: FormData;
    try {
      form = await readFormDataLimited(req, MAX_REQUEST_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw new ApiError(413, "PHOTO_TOO_LARGE", TOO_LARGE);
      throw new ApiError(400, "INVALID_FORM", "We couldn't read the upload. Please try again.");
    }

    // Consent first: nothing about the image is processed without the 18+ attestation.
    const payload = readPayload(form.get("payload"));

    const file = form.get("photo");
    if (!(file instanceof Blob) || file.size === 0) {
      throw new ApiError(400, "MISSING_PHOTO", "Attach a photo in the 'photo' field.");
    }
    if (!ACCEPTED_TYPES.has(file.type)) {
      throw new ApiError(415, "UNSUPPORTED_IMAGE_TYPE", "Photos must be JPEG or PNG.");
    }
    if (file.size > MAX_PHOTO_BYTES) {
      throw new ApiError(413, "PHOTO_TOO_LARGE", TOO_LARGE);
    }

    const prepared = await preparePhoto(Buffer.from(await file.arrayBuffer()));
    const measurements = payload.measurements
      ? scaleMeasurements(payload.measurements, prepared.scale, prepared.width, prepared.height)
      : null;
    const hash = createHash("sha256").update(prepared.bytes).digest("hex");

    const sku = getSku(existing.skuId);
    const now = new Date().toISOString();
    // Check-and-write under the store lock: a racing upload that loses the PHOTO_LOCKED check
    // must not overwrite the file behind renders already keyed on the winner's hash.
    const updated = await mutate(async (db) => {
      const r = db.returns[id];
      if (!r) throw new ApiError(404, "RETURN_NOT_FOUND", "We couldn't find that return.");
      assertNotResolved(r);
      assertPhotoReplaceable(r);
      await savePhoto(id, prepared.bytes);
      r.photo = { url: `/api/photos/${id}`, hash, width: prepared.width, height: prepared.height, uploadedAt: now };
      r.photoSkipped = false;
      r.consent = { adultAttested: true, at: now };
      r.preflight = payload.preflight;
      r.measurements = measurements;
      r.timeline.photoAt = now;
      advanceStatus(r, "photo_uploaded");
      if (r.reason === "style_colour" && r.candidates.length === 0 && sku) {
        r.candidates = speculativePicks(sku, r.size, "style_colour", { paidPrice: r.price });
      }
      return r;
    });

    // Style/colour returns: start rendering the top two swaps now, while the shopper fills the form.
    if (updated.reason === "style_colour") {
      const jobs = await scheduleAndRun(
        req,
        id,
        updated.candidates.slice(0, 2).map(toPick),
        updated.diagnosis ? "post_diagnosis" : "speculative",
      );
      if (jobs.length > 0) return returnResponse(await requireReturn(id));
    }
    return returnResponse(updated);
  });
}

/** Once previews exist for a photo, it can't be swapped out from under them. */
function assertPhotoReplaceable(r: ReturnCase): void {
  if (r.photo && r.renders.length > 0) {
    throw new ApiError(409, "PHOTO_LOCKED", "Previews were already made from your photo for this return.");
  }
}

function readPayload(raw: FormDataEntryValue | null) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ApiError(400, "ADULT_ATTESTATION_REQUIRED", "Please confirm you're 18 or older and the person in the photo.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The 'payload' field is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || (value as { adultAttested?: unknown }).adultAttested !== true) {
    throw new ApiError(400, "ADULT_ATTESTATION_REQUIRED", "Please confirm you're 18 or older and the person in the photo.");
  }
  return parseWith(PhotoPayload, value);
}

interface PreparedPhoto {
  bytes: Buffer;
  width: number;
  height: number;
  /** Final width ÷ uploaded (EXIF-oriented) width; keypoints are scaled by this. */
  scale: number;
}

/**
 * Verify the bytes really are a JPEG/PNG and normalise to a JPEG ≤1600px. The
 * client already normalises, so most uploads pass through untouched; anything
 * that is PNG, oversized, EXIF-rotated or carries metadata (e.g. GPS) is re-encoded.
 */
async function preparePhoto(input: Buffer): Promise<PreparedPhoto> {
  const meta = await sharp(input)
    .metadata()
    .catch(() => null);
  if (!meta) throw new ApiError(422, "INVALID_IMAGE", "We couldn't read that image. Please retake the photo.");
  if (meta.format !== "jpeg" && meta.format !== "png") {
    throw new ApiError(415, "UNSUPPORTED_IMAGE_TYPE", "Photos must be JPEG or PNG.");
  }
  if (!meta.width || !meta.height) {
    throw new ApiError(422, "INVALID_IMAGE", "We couldn't read that image. Please retake the photo.");
  }
  const orientation = meta.orientation ?? 1;
  const rotated = orientation >= 5 && orientation <= 8;
  const w = rotated ? meta.height : meta.width;
  const h = rotated ? meta.width : meta.height;
  if (Math.min(w, h) < MIN_SIDE) {
    throw new ApiError(422, "IMAGE_TOO_SMALL", "That photo is too small. Please use a full-length photo at least 256 px wide.");
  }

  const needsReencode =
    meta.format !== "jpeg" ||
    Math.max(w, h) > MAX_SIDE ||
    orientation !== 1 ||
    Boolean(meta.exif) ||
    Boolean(meta.xmp) ||
    input.length > MAX_PHOTO_BYTES;
  if (!needsReencode) return { bytes: input, width: w, height: h, scale: 1 };

  try {
    for (let quality = 90; ; quality -= 10) {
      const { data, info } = await sharp(input)
        .rotate()
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= MAX_PHOTO_BYTES || quality <= 60) {
        return { bytes: data, width: info.width, height: info.height, scale: info.width / w };
      }
    }
  } catch {
    throw new ApiError(422, "INVALID_IMAGE", "We couldn't process that image. Please retake the photo.");
  }
}

/** Keep client pixel coordinates aligned with the stored (possibly downscaled) JPEG. */
function scaleMeasurements(m: PhotoMeasurements, s: number, width: number, height: number): PhotoMeasurements {
  if (!m.calibration && Math.abs(s - 1) < 1e-9) return m;
  const kp = Object.fromEntries(
    Object.entries(m.keypoints).map(([k, p]) => [k, { x: p.x * s, y: p.y * s, visibility: p.visibility }]),
  ) as unknown as PhotoMeasurements["keypoints"];
  const c = m.calibration;
  return {
    ...m,
    keypoints: kp,
    calibration: c
      ? {
          ...c,
          pxPerCm: c.pxPerCm * s,
          hpsY: c.hpsY * s,
          observedHemY: c.observedHemY * s,
          observedSleeveEnd: c.observedSleeveEnd ? { x: c.observedSleeveEnd.x * s, y: c.observedSleeveEnd.y * s } : null,
          centerX: c.centerX * s,
          hemHalfWidthPx: c.hemHalfWidthPx * s,
          imageWidth: width,
          imageHeight: height,
        }
      : null,
  };
}
