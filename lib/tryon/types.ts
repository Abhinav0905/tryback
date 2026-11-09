// Try-on provider contract (server-only). Both the live Clothsy client and the
// simulated dev double implement `TryOnProvider`, so the orchestrator never
// needs to know which one produced a render.

export interface TryOnInput {
  /** Normalised JPEG from the client (EXIF-corrected, un-mirrored, ≤1600px). */
  personBytes: Buffer;
  /** sha256 hex of personBytes. */
  personHash: string;
  /** Prepared garment image (JPEG/PNG ≤4MB, ≤1600px), see lib/tryon/garment.ts. */
  garmentBytes: Buffer;
  /** sha256 hex of garmentBytes. */
  garmentHash: string;
  /** sku.apiTitle (≤120 chars). */
  title: string;
  /** 8–128 chars [A-Za-z0-9_-]. The orchestrator uses `tb_${cacheKey}`. */
  idempotencyKey: string;
}

export interface TryOnOutput {
  bytes: Buffer;
  contentType: string;
  latencyMs: number;
  provider: "clothsy" | "dev";
  externalId: string | null;
  /** True only when this call consumed a real Clothsy credit. */
  creditCharged: boolean;
  /**
   * Clothsy only: the start returned an earlier try-on for a reused Idempotency-Key (no new
   * credit). Detected from `status: "success"` on the first start attempt (a new try-on is
   * always `pending` there) or a replay header, if the API sends one. See docs/CLOTHSY-NOTES.md.
   */
  replayed?: boolean;
}

/**
 * Error codes produced by the providers. Clothsy API codes are passed through
 * verbatim; the rest are local. `code` stays a plain string so unknown future
 * API codes survive unchanged.
 */
export type TryOnErrorCode =
  // Clothsy API (documented)
  | "MISSING_IDEMPOTENCY_KEY"
  | "INVALID_IMAGE_URL"
  | "IMAGE_DOWNLOAD_FAILED"
  | "UNSUPPORTED_IMAGE"
  | "INVALID_IMAGE_ID"
  | "INVALID_API_KEY"
  | "INSUFFICIENT_CREDITS"
  | "CONSENT_REQUIRED"
  | "IMAGE_TOO_LARGE"
  | "PERSON_PHOTO_REJECTED"
  | "IMAGE_REJECTED"
  | "GARMENT_REJECTED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "START_FAILED"
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "BAD_REQUEST"
  // Local
  | "RENDER_FAILED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "DOWNLOAD_FAILED"
  /** A replayed Idempotency-Key returned a finished try-on whose result URL has expired. */
  | "REPLAY_RESULT_EXPIRED"
  | "BAD_RESPONSE"
  | "ABORTED"
  | "NO_API_KEY"
  | "BAD_INPUT"
  | "GARMENT_IMAGE_MISSING"
  | "CACHE_WRITE_FAILED"
  | "HTTP_ERROR";

export class TryOnError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: string, message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "TryOnError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }

  toJSON(): { code: string; message: string; retryable: boolean; status?: number } {
    return { code: this.code, message: this.message, retryable: this.retryable, status: this.status };
  }
}

/** `instanceof` breaks across duplicated module instances (Next dev HMR); this doesn't. */
export function isTryOnError(err: unknown): err is TryOnError {
  if (err instanceof TryOnError) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; retryable?: unknown };
  return e.name === "TryOnError" && typeof e.code === "string" && typeof e.retryable === "boolean";
}

export interface TryOnProvider {
  readonly name: "clothsy" | "dev";
  render(input: TryOnInput, signal?: AbortSignal): Promise<TryOnOutput>;
}

/**
 * Shopper-safe copy for an error code. Never judges the body or skin tone:
 * photo rejections are framed as "the photo", not "you".
 */
export function describeTryOnError(code: string): string {
  switch (code) {
    case "PERSON_PHOTO_REJECTED":
    case "IMAGE_REJECTED":
      return "The preview service couldn't use this photo. A brighter, full-length photo usually works.";
    case "GARMENT_REJECTED":
    case "GARMENT_IMAGE_MISSING":
      return "This item's product photo couldn't be used for a preview.";
    case "UNSUPPORTED_IMAGE":
    case "IMAGE_TOO_LARGE":
      return "The photo format couldn't be processed. Try retaking it.";
    case "RENDER_FAILED":
      return "This preview didn't render.";
    case "TIMEOUT":
      return "This preview took too long, so we stopped waiting.";
    case "RATE_LIMITED":
    case "UNAVAILABLE":
    case "INTERNAL_ERROR":
    case "START_FAILED":
    case "NETWORK_ERROR":
    case "DOWNLOAD_FAILED":
    case "REPLAY_RESULT_EXPIRED":
    case "BAD_RESPONSE":
      return "The preview service is busy right now.";
    case "INSUFFICIENT_CREDITS":
    case "INVALID_API_KEY":
    case "NO_API_KEY":
      return "Live previews are unavailable right now.";
    case "ABORTED":
      return "This preview was cancelled.";
    default:
      return "This preview couldn't be created.";
  }
}
