// Live-render access control. When LIVE_ACCESS_CODE is set, only sessions that
// unlocked with that code (cookie tb_live) may spend real Clothsy credits;
// everyone else is treated as replay (cached renders, else the dev double).

// Server-only module.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config, LIVE_COOKIE } from "./config";
import { RATE_RULES, checkRate, clientKeyFrom, rateLimitResponse, recordRate } from "./ratelimit";

/** Random per-browser token (httpOnly) recording which returns this browser created. */
export const VIEWER_COOKIE = "tb_viewer";
const VIEWER_TOKEN_RE = /^[a-f0-9]{32}$/;
const VIEWER_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Parse a Cookie header into a name → value map (first occurrence wins). */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Constant-time string comparison (avoids leaking the code through timing). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still spend comparable time so length isn't trivially observable.
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** True when this request may trigger live (credit-consuming) renders. */
export async function allowLiveFromRequest(req: Request): Promise<boolean> {
  const code = config.liveAccessCode;
  if (!code) return publicLiveAllowed();
  const cookie = parseCookies(req.headers.get("cookie"))[LIVE_COOKIE];
  return typeof cookie === "string" && safeEqual(cookie, code);
}

/**
 * Without LIVE_ACCESS_CODE, live renders are open to every visitor. That's fine on a laptop
 * (`next dev`), but on a production server it lets anyone with the URL spend credits, so there
 * it needs an explicit ALLOW_PUBLIC_LIVE=1; otherwise everyone is treated as replay.
 */
export function publicLiveAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || config.allowPublicLive;
}

/* ───────────── Admin token (ADMIN_TOKEN) ───────────── */

export type AdminAuth = "admin" | "none" | "invalid";

/** The token a request presents: `x-admin-token`, or `Authorization: Bearer <token>`. Other schemes (e.g. Basic) are ignored. */
export function presentedAdminToken(req: Request): string | null {
  const header = req.headers.get("x-admin-token");
  if (header !== null) return header.trim();
  const auth = req.headers.get("authorization")?.trim();
  const m = auth ? /^Bearer\s+(\S.*)$/i.exec(auth) : null;
  return m ? m[1]!.trim() : null;
}

/**
 * "admin" for the right ADMIN_TOKEN (constant-time compare), "none" when no token is presented,
 * and "invalid" for a wrong token or when the server has no ADMIN_TOKEN configured.
 */
export function adminAuth(req: Request): AdminAuth {
  const presented = presentedAdminToken(req);
  if (presented === null) return "none";
  const expected = config.adminToken;
  if (!expected) return "invalid";
  return safeEqual(presented, expected) ? "admin" : "invalid";
}

/**
 * Admin check for a route handler: "admin" for the right token, "none" when no token was
 * presented, otherwise the 401 (wrong token / no ADMIN_TOKEN on the server) or 429 to return.
 * Wrong tokens are rate-limited per client and overall, like access-code guesses. The right
 * token is checked first (constant-time) and always gets through: otherwise anyone could lock
 * the operator out by burning the global failure window with wrong guesses.
 */
export function adminGate(req: Request): "admin" | "none" | Response {
  if (presentedAdminToken(req) === null) return "none";
  if (adminAuth(req) === "admin") return "admin";
  const client = clientKeyFrom(req);
  const blocked = checkRate(RATE_RULES.adminAuthFailure, client);
  if (!blocked.ok) return rateLimitResponse(blocked);
  recordRate(RATE_RULES.adminAuthFailure, client);
  const message = config.adminToken
    ? "That admin token isn't right."
    : "Admin operations are disabled on this server (ADMIN_TOKEN isn't set).";
  return Response.json(
    { error: { code: "INVALID_ADMIN_TOKEN", message } },
    { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": 'Bearer realm="tryback-admin"' } },
  );
}

/** sha256 of this browser's tb_viewer token, or null if it has none. */
export function viewerHashFromRequest(req: Request): string | null {
  const t = viewerToken(req);
  return t ? viewerHashOf(t) : null;
}

/**
 * True when this browser unlocked with LIVE_ACCESS_CODE (the team / judges' admin view).
 * False when no code is configured: then nobody is an admin.
 */
export function isAccessCodeHolder(req: Request): boolean {
  const code = config.liveAccessCode;
  if (!code) return false;
  const cookie = parseCookies(req.headers.get("cookie"))[LIVE_COOKIE];
  return typeof cookie === "string" && safeEqual(cookie, code);
}

/** This browser's viewer token, or null if it has none (or a malformed one). */
export function viewerToken(req: Request): string | null {
  const t = parseCookies(req.headers.get("cookie"))[VIEWER_COOKIE];
  return typeof t === "string" && VIEWER_TOKEN_RE.test(t) ? t : null;
}

export function viewerHashOf(token: string): string {
  return createHash("sha256").update(`tryback-viewer\n${token}`).digest("hex");
}

/** The viewer token to use for a request, and the Set-Cookie header when it is new. */
export function ensureViewer(req: Request): { hash: string; setCookie: string | null } {
  const existing = viewerToken(req);
  if (existing) return { hash: viewerHashOf(existing), setCookie: null };
  const token = randomBytes(16).toString("hex");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const secure = proto === "https" ? "; Secure" : "";
  return {
    hash: viewerHashOf(token),
    setCookie: `${VIEWER_COOKIE}=${token}; Path=/; Max-Age=${VIEWER_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`,
  };
}
