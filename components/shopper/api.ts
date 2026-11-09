// Typed client for the TryBack API routes (contract table B). Browser-safe:
// plain fetch, no server imports. Every error surfaces as an ApiError with a
// shopper-readable message; aborts propagate untouched so callers can ignore them.

import type {
  AppStatus,
  FitComplaint,
  GateResult,
  Order,
  PhotoMeasurements,
  PreflightResult,
  ReasonCode,
  ReturnCase,
  SizeCode,
  Sku,
} from "@/lib/types";

export class ApiError extends Error {
  readonly code: string;
  /** HTTP status; 0 for network failures. */
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }

  /** Worth retrying later (offline, rate limited, server hiccup). */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

export function errorMessage(e: unknown, fallback = "Something went wrong. Please try again."): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function fallbackMessage(status: number): string {
  if (status === 400 || status === 422) return "Something in that request wasn't quite right.";
  if (status === 404) return "We couldn't find that.";
  if (status === 409) return "That changed while you were looking. Please try again.";
  if (status === 413) return "That photo is too large.";
  if (status === 429) return "Lots of requests right now. Give it a moment and try again.";
  if (status >= 500) return "Something went wrong on our side. Please try again.";
  return "Something went wrong. Please try again.";
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApiError("NETWORK", "We couldn't reach TryBack. Check your connection and try again.", 0);
  }

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof err?.code === "string" ? err.code : `HTTP_${res.status}`;
    const message = typeof err?.message === "string" && err.message ? err.message : fallbackMessage(res.status);
    throw new ApiError(code, message, res.status);
  }
  if (body === null) {
    throw new ApiError("BAD_RESPONSE", "We got an unexpected response. Please try again.", res.status);
  }
  return body as T;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const enc = encodeURIComponent;

async function ret(p: Promise<{ return: ReturnCase }>): Promise<ReturnCase> {
  const body = await p;
  if (!body || typeof body !== "object" || !body.return) {
    throw new ApiError("BAD_RESPONSE", "We got an unexpected response. Please try again.", 200);
  }
  return body.return;
}

export interface PhotoPayload {
  adultAttested: true;
  preflight: PreflightResult;
  /** Null only for a dev-mode override where no person could be measured (server accepts null). */
  measurements: PhotoMeasurements | null;
}

export type ResolveBody = { type: "exchange"; skuId: string; size: SizeCode } | { type: "refund" };

export const api = {
  status: (signal?: AbortSignal) => request<AppStatus>("/api/status", { signal }),

  order: (orderId: string, email: string, signal?: AbortSignal) =>
    request<{ order: Order; skus: Sku[] }>(`/api/orders/${enc(orderId)}?email=${enc(email)}`, { signal }),

  createReturn: (body: { orderId: string; email: string; lineIndex: number }) =>
    ret(request("/api/returns", postJson(body))),

  getReturn: (id: string, signal?: AbortSignal) => ret(request(`/api/returns/${enc(id)}`, { signal })),

  reason: (id: string, body: { reason: ReasonCode; fitComplaints?: FitComplaint[] }) =>
    ret(request(`/api/returns/${enc(id)}/reason`, postJson(body))),

  photo: (id: string, photo: Blob, payload: PhotoPayload) => {
    const fd = new FormData();
    const file = photo.type === "image/jpeg" ? photo : new Blob([photo], { type: "image/jpeg" });
    fd.append("photo", file, "photo.jpg");
    fd.append("payload", JSON.stringify(payload));
    return ret(request(`/api/returns/${enc(id)}/photo`, { method: "POST", body: fd }));
  },

  skipPhoto: (id: string) => ret(request(`/api/returns/${enc(id)}/skip-photo`, postJson({}))),

  form: (id: string, body: { chips: string[]; freeText: string }) =>
    ret(request(`/api/returns/${enc(id)}/form`, postJson(body))),

  gate: (id: string, jobId: string, gate: GateResult) =>
    ret(request(`/api/returns/${enc(id)}/renders/${enc(jobId)}/gate`, postJson({ gate }))),

  sizePreview: (id: string, body: { skuId: string; size: SizeCode }) =>
    ret(request(`/api/returns/${enc(id)}/size-preview`, postJson(body))),

  resolve: (id: string, body: ResolveBody) => ret(request(`/api/returns/${enc(id)}/resolve`, postJson(body))),

  /** Unlock live renders for this browser (sets the httpOnly tb_live cookie). Throws ApiError on a wrong code. */
  unlockLive: (code: string) => request<{ ok: boolean }>("/api/live", postJson({ code })),
};
