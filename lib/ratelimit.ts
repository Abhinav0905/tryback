// In-memory request limits for a single server process (TryBack runs as one Node server with a
// persistent disk; see docs/DEPLOY.md). Fixed windows per client and per rule, plus a global
// window per rule. Client identity comes from the one header the deployment's proxy sets
// (clientIpSource / CLIENT_IP_HEADER); the global cap still bounds anything that slips through.
//
// Server-only. State lives on globalThis so every route bundle in the process shares it.

export interface RateRule {
  /** Stable id (also the bucket name). */
  id: string;
  /** Requests per client per window. */
  perClient: number;
  /** Requests from everyone together per window. */
  global: number;
  windowMs: number;
}

const TEN_MIN = 10 * 60 * 1000;

/**
 * Limits are generous for a real shopper (one return uses 1 photo, ≤5 renders, one gate post
 * per render) and tight on the paths that can spend credits or LLM calls.
 */
export const RATE_RULES = {
  /** POST /api/returns */
  createReturn: { id: "create_return", perClient: 30, global: 600, windowMs: TEN_MIN },
  /** POST /api/returns/[id]/photo (starts up to 2 renders) */
  photoUpload: { id: "photo_upload", perClient: 20, global: 200, windowMs: TEN_MIN },
  /** POST /api/returns/[id]/form (diagnosis may call the LLM; starts up to 2 renders) */
  form: { id: "form", perClient: 30, global: 300, windowMs: TEN_MIN },
  /** POST /api/returns/[id]/size-preview (1 credit each when live) */
  sizePreview: { id: "size_preview", perClient: 10, global: 60, windowMs: TEN_MIN },
  /** POST /api/returns/[id]/renders/[jobId]/gate, any verdict (/bench re-runs post one per render) */
  gate: { id: "gate", perClient: 240, global: 2400, windowMs: TEN_MIN },
  /** Gate posts with verdict "retry" (each can start a render) */
  gateRetry: { id: "gate_retry", perClient: 10, global: 60, windowMs: TEN_MIN },
  /** Wrong ADMIN_TOKEN attempts */
  adminAuthFailure: { id: "admin_auth_failure", perClient: 10, global: 60, windowMs: TEN_MIN },
} as const satisfies Record<string, RateRule>;

const GLOBAL_KEY = "*";
const MAX_TRACKED_CLIENTS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

const g = globalThis as unknown as { __trybackRateLimits?: Map<string, Map<string, Window>> };
g.__trybackRateLimits ??= new Map();
const buckets = g.__trybackRateLimits;

/* ───────────── Client identity ───────────── */

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/;

/**
 * Expand an IPv6 address and keep its /64 prefix: one subscriber usually holds a whole /64,
 * so rotating the interface id must not mint new clients. Null if it isn't valid IPv6.
 */
function ipv6Prefix64(ip: string): string | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return `${groups.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Normalise an address from a proxy header; null when it isn't a plausible IP. */
export function normalizeClientIp(raw: string): string | null {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]")); // [v6]:port
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":")); // v4:port
  if (ip.startsWith("::ffff:") && IPV4.test(ip.slice(7))) ip = ip.slice(7); // v4-mapped v6
  if (IPV4.test(ip)) return ip.split(".").every((o) => Number(o) <= 255) ? ip : null;
  if (IPV6.test(ip) && ip.includes(":")) return ipv6Prefix64(ip);
  return null;
}

/**
 * Which request header names the caller. Only a header the proxy in front of us *sets* can be
 * trusted; any other header arrives exactly as the client sent it, so trusting it would let a
 * client pick a fresh rate-limit key per request.
 *   fly-client-ip     Fly.io's edge sets it (default when FLY_APP_NAME is set)
 *   true-client-ip    Cloudflare sets it; Render runs behind Cloudflare (default when RENDER is set)
 *   cf-connecting-ip  Cloudflare, same value
 *   x-real-ip         set by your own nginx/Caddy (`header_up X-Real-IP {remote_host}`)
 *   x-forwarded-for   the LAST hop, i.e. the address the nearest proxy appended (default elsewhere:
 *                     Caddy and nginx's $proxy_add_x_forwarded_for append it, and Next fills the
 *                     header from the socket when no proxy sent one)
 *   none              no per-client windows; only the global caps apply
 */
export const CLIENT_IP_SOURCES = ["fly-client-ip", "true-client-ip", "cf-connecting-ip", "x-real-ip", "x-forwarded-for", "none"] as const;
export type ClientIpSource = (typeof CLIENT_IP_SOURCES)[number];

/** CLIENT_IP_HEADER if it names a known source, else the host's default (see CLIENT_IP_SOURCES). */
export function clientIpSource(env: Record<string, string | undefined> = process.env): ClientIpSource {
  const explicit = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (explicit && (CLIENT_IP_SOURCES as readonly string[]).includes(explicit)) return explicit as ClientIpSource;
  if (env.FLY_APP_NAME) return "fly-client-ip";
  if (env.RENDER || env.RENDER_SERVICE_ID) return "true-client-ip";
  return "x-forwarded-for";
}

/**
 * Who is calling, read from the one header the deployment's proxy sets (clientIpSource). Null
 * when that header is missing or not an IP; then only the global window applies. Other headers
 * are ignored on purpose: off Fly a client-sent `Fly-Client-IP` is just a string it chose.
 */
export function clientKeyFrom(req: Request, source: ClientIpSource = clientIpSource()): string | null {
  if (source === "none") return null;
  const raw = req.headers.get(source);
  if (!raw) return null;
  const value = source === "x-forwarded-for" ? raw.split(",").at(-1) : raw;
  return value ? normalizeClientIp(value) : null;
}

/* ───────────── Windows ───────────── */

export type RateDecision = { ok: true } | { ok: false; retryAfterS: number; scope: "client" | "global" };

function bucketFor(rule: RateRule): Map<string, Window> {
  let b = buckets.get(rule.id);
  if (!b) {
    b = new Map();
    buckets.set(rule.id, b);
  }
  return b;
}

function live(b: Map<string, Window>, key: string, rule: RateRule, now: number): Window {
  const w = b.get(key);
  return w && w.resetAt > now ? w : { count: 0, resetAt: now + rule.windowMs };
}

function prune(b: Map<string, Window>, now: number): void {
  if (b.size <= MAX_TRACKED_CLIENTS) return;
  for (const [k, w] of b) if (w.resetAt <= now) b.delete(k);
  // Still too many (spoofed) clients: forget the oldest; the global window is kept.
  for (const k of b.keys()) {
    if (b.size <= MAX_TRACKED_CLIENTS) break;
    if (k !== GLOBAL_KEY) b.delete(k);
  }
}

/** Would one more request be allowed? (Doesn't count it.) */
export function checkRate(rule: RateRule, clientKey: string | null, now = Date.now()): RateDecision {
  const b = bucketFor(rule);
  const global = live(b, GLOBAL_KEY, rule, now);
  if (global.count >= rule.global) {
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((global.resetAt - now) / 1000)), scope: "global" };
  }
  if (clientKey) {
    const client = live(b, clientKey, rule, now);
    if (client.count >= rule.perClient) {
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((client.resetAt - now) / 1000)), scope: "client" };
    }
  }
  return { ok: true };
}

/** Count one request against the client's and the global window (whether or not it is over). */
export function recordRate(rule: RateRule, clientKey: string | null, now = Date.now()): void {
  const b = bucketFor(rule);
  prune(b, now);
  const global = live(b, GLOBAL_KEY, rule, now);
  global.count += 1;
  b.set(GLOBAL_KEY, global);
  if (clientKey) {
    const client = live(b, clientKey, rule, now);
    client.count += 1;
    b.set(clientKey, client);
  }
}

/** Check and, if allowed, count the request. */
export function consumeRate(rule: RateRule, clientKey: string | null, now = Date.now()): RateDecision {
  const d = checkRate(rule, clientKey, now);
  if (d.ok) recordRate(rule, clientKey, now);
  return d;
}

/** 429 response in the API's error shape; the shopper UI shows `message` as is. */
export function rateLimitResponse(d: Extract<RateDecision, { ok: false }>): Response {
  const minutes = Math.max(1, Math.ceil(d.retryAfterS / 60));
  const wait = minutes === 1 ? "a minute" : `${minutes} minutes`;
  const message =
    d.scope === "client"
      ? `That's a lot of requests in a short time. Please wait ${wait} and try again.`
      : `TryBack is busy right now. Please try again in ${wait}.`;
  return Response.json(
    { error: { code: "RATE_LIMITED", message } },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(d.retryAfterS) } },
  );
}

/** Route helper: null when allowed (and counted), else the 429 to return. */
export function limitRequest(req: Request, rule: RateRule): Response | null {
  const d = consumeRate(rule, clientKeyFrom(req));
  return d.ok ? null : rateLimitResponse(d);
}

/** Test seam: forget every window. */
export function resetRateLimits(): void {
  buckets.clear();
}
