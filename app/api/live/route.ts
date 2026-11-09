import { handle, json, readJson } from "@/lib/apiRoute";
import { LiveBody } from "@/lib/apiSchemas";
import { JSON_BODY_LIMIT, withBodyLimit } from "@/lib/bodyLimit";
import { config, LIVE_COOKIE } from "@/lib/config";
import { safeEqual } from "@/lib/live";
import { clientKeyFrom } from "@/lib/ratelimit";

export const runtime = "nodejs";

const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;
const WINDOW_MS = 10 * 60 * 1000;
/** Wrong guesses per client (by proxy-reported IP) per window. */
const MAX_ATTEMPTS = 10;
/**
 * Wrong guesses from everyone together per window. X-Forwarded-For is client-supplied on hosts
 * that don't overwrite it, so the per-client limit alone can be dodged; this bounds guessing
 * to ~6/min overall while leaving room for judges who mistype.
 */
const MAX_GLOBAL_ATTEMPTS = 60;
const MAX_TRACKED_CLIENTS = 5000;
const GLOBAL_KEY = "*";

interface Window {
  count: number;
  resetAt: number;
}

// Process-wide attempt counters (slow brute-forcing of the access code).
const g = globalThis as unknown as { __trybackLiveAttempts?: Map<string, Window> };
g.__trybackLiveAttempts ??= new Map();
const attempts = g.__trybackLiveAttempts;

function windowFor(key: string, now: number): Window {
  const a = attempts.get(key);
  return a && a.resetAt > now ? a : { count: 0, resetAt: now + WINDOW_MS };
}

function prune(now: number): void {
  for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  // Still too many distinct (possibly spoofed) clients: forget the oldest, keep the global window.
  for (const k of attempts.keys()) {
    if (attempts.size <= MAX_TRACKED_CLIENTS) break;
    if (k !== GLOBAL_KEY) attempts.delete(k);
  }
}

function cookieHeader(req: Request, value: string, maxAge: number): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const secure = proto === "https" ? "; Secure" : "";
  return `${LIVE_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

// POST /api/live { code } → { ok } — unlocks live (credit-spending) renders for this browser
// by setting the httpOnly cookie tb_live (7 days). Without LIVE_ACCESS_CODE, live is open to all.
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const { code } = await readJson(withBodyLimit(req, JSON_BODY_LIMIT), LiveBody);
    const expected = config.liveAccessCode;
    if (!expected) return json({ ok: true });

    const now = Date.now();
    prune(now);
    // Client identity from the proxy (Fly-Client-IP, X-Forwarded-For, X-Real-IP), or null when
    // there is none (then only the global limit applies).
    const key = clientKeyFrom(req);
    const global = windowFor(GLOBAL_KEY, now);
    const client = key ? windowFor(key, now) : null;
    const blocked = [global, client].find((w) => w && w.count >= (w === global ? MAX_GLOBAL_ATTEMPTS : MAX_ATTEMPTS));
    if (blocked) {
      const retryAfter = Math.max(1, Math.ceil((blocked.resetAt - now) / 1000));
      return json(
        { ok: false, error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in a few minutes." } },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    if (!safeEqual(code.trim(), expected)) {
      global.count += 1;
      attempts.set(GLOBAL_KEY, global);
      if (key && client) {
        client.count += 1;
        attempts.set(key, client);
      }
      return json({ ok: false, error: { code: "INVALID_CODE", message: "That access code isn't right." } }, { status: 401 });
    }

    if (key) attempts.delete(key);
    return json({ ok: true }, { headers: { "Set-Cookie": cookieHeader(req, expected, COOKIE_MAX_AGE_S) } });
  });
}

// DELETE /api/live → { ok: true } — forget the live unlock on this browser.
export async function DELETE(req: Request): Promise<Response> {
  return json({ ok: true }, { headers: { "Set-Cookie": cookieHeader(req, "", 0) } });
}
