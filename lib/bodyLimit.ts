// Request-body size limits that hold even when the client sends no Content-Length (chunked):
// the body stream is counted as it arrives and errors past the limit, so nothing larger is
// ever buffered. Server-only.

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Declared Content-Length, or null when absent/invalid. */
export function declaredLength(req: Request): number | null {
  const raw = req.headers.get("content-length")?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * A copy of `body` that errors with BodyTooLargeError once more than `maxBytes` have arrived.
 * `onExceeded` runs when that happens (callers that only see a wrapped error can tell why).
 */
export function limitStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded?: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          onExceeded?.();
          controller.error(new BodyTooLargeError(maxBytes));
        } else {
          controller.enqueue(chunk);
        }
      },
    }),
  );
}

/**
 * The same request with its body capped at `maxBytes` (method, URL and headers unchanged), for
 * helpers that read the whole body. Reading past the cap rejects instead of buffering on.
 */
export function withBodyLimit(req: Request, maxBytes: number): Request {
  if (!req.body) return req;
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: limitStream(req.body, maxBytes),
    signal: req.signal,
    // Required by Node's fetch for a streamed request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/**
 * Parse a multipart/form-data body without ever holding more than `maxBytes` of it.
 * Throws BodyTooLargeError when the declared or actual size is over; rethrows parse errors.
 */
export async function readFormDataLimited(req: Request, maxBytes: number): Promise<FormData> {
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!req.body) return req.formData();
  let tooLarge = false;
  const limited = limitStream(req.body, maxBytes, () => {
    tooLarge = true;
  });
  const res = new Response(limited, { headers: { "content-type": req.headers.get("content-type") ?? "" } });
  try {
    return await res.formData();
  } catch (err) {
    if (tooLarge) throw new BodyTooLargeError(maxBytes);
    throw err;
  }
}

/** Cap for JSON request bodies (matches readJson's default in lib/apiRoute.ts). */
export const JSON_BODY_LIMIT = 64 * 1024;
