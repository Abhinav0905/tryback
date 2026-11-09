// Small helpers shared by the TryBack route handlers: JSON responses, the error
// shape `{ error: { code, message } }`, zod body parsing and return-case access.
// Server-only.

import type { z } from "zod";
import { getOrder } from "./catalog";
import { getReturn, mutate } from "./store";
import type { Order, ReturnCase, ReturnStatus } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const NO_STORE = "no-store";

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(data, {
    status: init.status ?? 200,
    headers: { "Cache-Control": NO_STORE, ...init.headers },
  });
}

export function errorResponse(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return json({ error: { code, message } }, { status, headers });
}

/** Run a handler body, mapping ApiError → its status and anything else → 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message);
    console.error("[api] unhandled error", err);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong on our side. Please try again.");
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** Validate a value with a schema or throw a 400 VALIDATION_ERROR. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const res = schema.safeParse(value);
  if (!res.success) throw new ApiError(400, "VALIDATION_ERROR", formatZodError(res.error));
  return res.data;
}

/** Read + validate a JSON body (≤ maxBytes). Empty bodies parse as `{}`. */
export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  // Lenient on purpose: fetch() with a string body and no header sends text/plain.
  const type = req.headers.get("content-type") ?? "";
  if (/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(type)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json.");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.");
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new ApiError(400, "INVALID_BODY", "Could not read the request body.");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.");
  let value: unknown = {};
  if (text.trim()) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.");
    }
  }
  return parseWith(schema, value);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function assertSafeId(id: string, what = "id"): string {
  if (!isSafeId(id)) throw new ApiError(400, "INVALID_ID", `That ${what} isn't valid.`);
  return id;
}

/** Load a return case or throw 400 (unsafe id) / 404. */
export async function requireReturn(id: string): Promise<ReturnCase> {
  assertSafeId(id, "return id");
  const r = await getReturn(id);
  if (!r) throw new ApiError(404, "RETURN_NOT_FOUND", "We couldn't find that return.");
  return r;
}

/**
 * Mutate one return atomically; throws ApiError 404 if it vanished. `fn` may throw
 * ApiError (e.g. 409) — the store rolls back and the route maps it.
 */
export function updateReturnOr404(id: string, fn: (r: ReturnCase) => void): Promise<ReturnCase> {
  return mutate((db) => {
    const r = db.returns[id];
    if (!r) throw new ApiError(404, "RETURN_NOT_FOUND", "We couldn't find that return.");
    fn(r);
    return r;
  });
}

export function assertNotResolved(r: ReturnCase): void {
  if (r.status === "resolved") throw new ApiError(409, "ALREADY_RESOLVED", "This return has already been completed.");
}

const STATUS_ORDER: readonly ReturnStatus[] = ["started", "reason_selected", "photo_uploaded", "form_submitted", "resolved"];

/** Move status forward only (never backwards). */
export function advanceStatus(r: ReturnCase, next: ReturnStatus): void {
  if (STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(r.status)) r.status = next;
}

export function returnResponse(r: ReturnCase, status = 200): Response {
  return json({ return: r }, { status });
}

/* ───────────── Orders ───────────── */

/** Demo shortcut: the email "demo" unlocks the fictional demo orders. */
export const DEMO_EMAIL = "demo";

/** Look up an order by number + email (case-insensitive) or throw a 404 that doesn't reveal which part was wrong. */
export function orderForEmail(orderId: string, email: string): Order {
  const order = getOrder(orderId);
  const e = email.trim().toLowerCase();
  if (!order || (e !== DEMO_EMAIL && e !== order.email.toLowerCase())) {
    throw new ApiError(404, "ORDER_NOT_FOUND", "We couldn't find an order with that number and email.");
  }
  return order;
}
