// Production hardening for a public URL: rate limits, body caps, admin token, viewer-scoped
// reset, retention sweep + pins, the production live-render fail-safe, security headers, and
// that the consent copy states the retention the sweeper enforces.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = path.join(os.tmpdir(), `tryback-test-deploy-${process.pid}`);
  process.env.TRYBACK_DATA_DIR = dir;
  process.env.TRYON_MODE = "dev";
  process.env.DEV_RENDER_LATENCY_MS = "5";
  delete process.env.CLOTHSY_API_KEY;
  delete process.env.LIVE_ACCESS_CODE;
  delete process.env.ADMIN_TOKEN;
  delete process.env.ALLOW_PUBLIC_LIVE;
  delete process.env.PHOTO_RETENTION_HOURS;
  delete process.env.RENDER_RETENTION_DAYS;
  return { dir };
});

const bg = vi.hoisted(() => ({ pending: [] as Array<() => unknown> }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    bg.pending.push(fn);
  },
}));

import { promises as fs } from "node:fs";
import path from "node:path";
import { POST as createReturnPOST } from "@/app/api/returns/route";
import { GET as returnGET } from "@/app/api/returns/[id]/route";
import { POST as photoPOST } from "@/app/api/returns/[id]/photo/route";
import { POST as resetPOST } from "@/app/api/admin/reset/route";
import { GET as retentionGET, POST as retentionPOST } from "@/app/api/admin/retention/route";
import { GET as statusGET } from "@/app/api/status/route";
import { POST as sizePreviewPOST } from "@/app/api/returns/[id]/size-preview/route";
import { POST as gatePOST } from "@/app/api/returns/[id]/renders/[jobId]/gate/route";
import { CONSENT_COPY } from "@/components/shopper/PhotoOfferStep";
import { readJson } from "@/lib/apiRoute";
import { BodyTooLargeError, readFormDataLimited, withBodyLimit } from "@/lib/bodyLimit";
import { config, PROMISED_PHOTO_RETENTION_HOURS, PROMISED_RENDER_RETENTION_DAYS } from "@/lib/config";
import { adminAuth, allowLiveFromRequest, publicLiveAllowed, viewerHashOf } from "@/lib/live";
import {
  checkRate,
  clientIpSource,
  clientKeyFrom,
  consumeRate,
  normalizeClientIp,
  RATE_RULES,
  rateLimitResponse,
  recordRate,
  resetRateLimits,
  type RateRule,
} from "@/lib/ratelimit";
import { PINS_FILE, readPins, retentionSweepDue, sweepLeadMs, sweepRetention } from "@/lib/retention";
import { mutate, PHOTOS_DIR, readDb, RENDERS_DIR, savePhoto, saveRender } from "@/lib/store";
import type { RenderJob, ReturnCase } from "@/lib/types";
import nextConfig from "@/next.config";
import { z } from "zod";

const BASE = "http://localhost:3000";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RouteContext is a generated global; tests pass plain params.
function ctx<P extends Record<string, string>>(params: P): any {
  return { params: Promise.resolve(params) };
}

function post(p: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function newReturn(cookie?: string): Promise<{ id: string; cookie: string }> {
  const res = await createReturnPOST(
    post("/api/returns", { orderId: "1042", email: "demo", lineIndex: 0 }, cookie ? { cookie } : {}),
  );
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { return: ReturnCase }).return.id;
  const set = res.headers.get("set-cookie");
  return { id, cookie: cookie ?? set!.split(";")[0]! };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function backdate(file: string, ms: number): Promise<void> {
  const t = new Date(Date.now() - ms);
  await fs.utimes(file, t, t);
}

function job(returnId: string, cacheKey: string): RenderJob {
  const at = new Date().toISOString();
  return {
    id: `job_${cacheKey.slice(0, 8)}`,
    returnId,
    skuId: "fw-wrap-dress-emerald",
    size: "M",
    phase: "speculative",
    transition: "colour_only",
    garmentVariant: "primary",
    status: "success",
    provider: "dev",
    fromCache: false,
    cacheKey,
    queuedAt: at,
    startedAt: at,
    finishedAt: at,
    latencyMs: 10,
    resultUrl: `/api/renders/${cacheKey}`,
    error: null,
    creditCharged: false,
    gate: null,
    retryOf: null,
    supersededBy: null,
    externalId: null,
  };
}

beforeAll(async () => {
  await fs.rm(env.dir, { recursive: true, force: true });
});
afterEach(() => {
  resetRateLimits();
  vi.unstubAllEnvs();
  delete process.env.ADMIN_TOKEN;
});
afterAll(async () => {
  while (bg.pending.length) await Promise.allSettled(bg.pending.splice(0).map((fn) => fn()));
  await fs.rm(env.dir, { recursive: true, force: true });
});

/* ───────────── Rate limits ───────────── */

describe("rate limits", () => {
  it("normalises proxy-reported addresses and groups IPv6 by /64", () => {
    expect(normalizeClientIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeClientIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeClientIp("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(normalizeClientIp("[2001:DB8:abcd:0012:ffff::9]:443")).toBe("2001:db8:abcd:12::/64");
    expect(normalizeClientIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeClientIp("999.1.1.1")).toBeNull();
    expect(normalizeClientIp("not-an-ip")).toBeNull();
    expect(normalizeClientIp("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(normalizeClientIp("1::2::3")).toBeNull();
  });

  it("reads the client from the one header the host's proxy sets, never a client-chosen one", () => {
    const req = (h: Record<string, string>) => new Request(BASE, { headers: h });
    // Default off Fly/Render: the LAST X-Forwarded-For hop (appended by the nearest proxy, or
    // filled from the socket by Next). A client-sent Fly-Client-IP or leading XFF hops are ignored.
    expect(clientIpSource({})).toBe("x-forwarded-for");
    const spoof = req({ "fly-client-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.9, 192.0.2.7", "x-real-ip": "198.51.100.2" });
    expect(clientKeyFrom(spoof, "x-forwarded-for")).toBe("192.0.2.7");
    expect(clientKeyFrom(req({ "x-forwarded-for": "garbage", "x-real-ip": "198.51.100.2" }), "x-forwarded-for")).toBeNull();
    // On Fly the edge sets Fly-Client-IP (and overwrites a client's copy).
    expect(clientIpSource({ FLY_APP_NAME: "tryback-x" })).toBe("fly-client-ip");
    expect(clientKeyFrom(spoof, "fly-client-ip")).toBe("198.51.100.1");
    expect(clientKeyFrom(req({ "x-forwarded-for": "203.0.113.9" }), "fly-client-ip")).toBeNull();
    // Render sits behind Cloudflare, which sets True-Client-IP.
    expect(clientIpSource({ RENDER: "true" })).toBe("true-client-ip");
    expect(clientKeyFrom(req({ "true-client-ip": "198.51.100.3", "x-forwarded-for": "203.0.113.9" }), "true-client-ip")).toBe("198.51.100.3");
    // Explicit override (a VPS whose nginx sets X-Real-IP), "none", and junk values.
    expect(clientIpSource({ CLIENT_IP_HEADER: "X-Real-IP", FLY_APP_NAME: "x" })).toBe("x-real-ip");
    expect(clientKeyFrom(spoof, "x-real-ip")).toBe("198.51.100.2");
    expect(clientKeyFrom(spoof, "none")).toBeNull();
    expect(clientIpSource({ CLIENT_IP_HEADER: "cookie" })).toBe("x-forwarded-for");
    expect(clientKeyFrom(req({}))).toBeNull();
  });

  it("limits per client, and globally so rotating spoofed addresses doesn't help", () => {
    const rule: RateRule = { id: "t1", perClient: 3, global: 5, windowMs: 60_000 };
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(consumeRate(rule, "203.0.113.1", now).ok).toBe(true);
    const blocked = consumeRate(rule, "203.0.113.1", now + 1000);
    expect(blocked).toEqual({ ok: false, retryAfterS: 59, scope: "client" });
    expect(consumeRate(rule, "203.0.113.2", now).ok).toBe(true);
    expect(consumeRate(rule, "203.0.113.3", now).ok).toBe(true);
    expect(consumeRate(rule, "203.0.113.4", now)).toMatchObject({ ok: false, scope: "global" });
    expect(consumeRate(rule, null, now)).toMatchObject({ ok: false, scope: "global" });
    // A new window opens after windowMs.
    expect(consumeRate(rule, "203.0.113.1", now + 60_001).ok).toBe(true);
  });

  it("checkRate doesn't count; recordRate counts even when over", () => {
    const rule: RateRule = { id: "t2", perClient: 1, global: 10, windowMs: 60_000 };
    expect(checkRate(rule, "a.b", 0).ok).toBe(true);
    expect(checkRate(rule, "203.0.113.1", 0).ok).toBe(true);
    recordRate(rule, "203.0.113.1", 0);
    expect(checkRate(rule, "203.0.113.1", 0).ok).toBe(false);
  });

  it("429 carries Retry-After and the API error shape", async () => {
    const res = rateLimitResponse({ ok: false, retryAfterS: 125, scope: "client" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("125");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toContain("3 minutes");
  });

  it("new returns: 429 after the per-client limit, other clients unaffected", async () => {
    const from = (ip: string) => createReturnPOST(post("/api/returns", {}, { "x-forwarded-for": ip }));
    for (let i = 0; i < RATE_RULES.createReturn.perClient; i++) expect((await from("203.0.113.10")).status).toBe(400);
    const res = await from("203.0.113.10");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await from("203.0.113.11")).status).toBe(400);
  });

  it("photo uploads, size previews and gate retries are limited per client", async () => {
    const { id } = await newReturn();
    const ip = { "x-forwarded-for": "203.0.113.20" };
    for (let i = 0; i < RATE_RULES.photoUpload.perClient; i++) {
      const r = await photoPOST(new Request(`${BASE}/x`, { method: "POST", headers: ip, body: "x" }), ctx({ id }));
      expect(r.status).toBe(415);
    }
    expect((await photoPOST(new Request(`${BASE}/x`, { method: "POST", headers: ip, body: "x" }), ctx({ id }))).status).toBe(429);

    for (let i = 0; i < RATE_RULES.sizePreview.perClient; i++) {
      expect((await sizePreviewPOST(post("/x", { skuId: "x", size: "M" }, ip), ctx({ id }))).status).not.toBe(429);
    }
    expect((await sizePreviewPOST(post("/x", { skuId: "x", size: "M" }, ip), ctx({ id }))).status).toBe(429);

    const gate = (verdict: string) => ({
      gate: {
        verdict,
        metrics: { colourDeltaE: 1, residueFraction: null, silhouetteIoU: null, identityDiff: null, hemErrorCm: null, garmentCoverage: null },
        reasons: [],
        badge: null,
        computedAt: new Date().toISOString(),
        computeMs: 1,
      },
    });
    for (let i = 0; i < RATE_RULES.gateRetry.perClient; i++) {
      expect((await gatePOST(post("/x", gate("retry"), ip), ctx({ id, jobId: "job_x" }))).status).toBe(404);
    }
    expect((await gatePOST(post("/x", gate("retry"), ip), ctx({ id, jobId: "job_x" }))).status).toBe(429);
    // Non-retry verdicts only count against the (much larger) general gate limit.
    expect((await gatePOST(post("/x", gate("pass"), ip), ctx({ id, jobId: "job_x" }))).status).toBe(404);
  });
});

/* ───────────── Body limits ───────────── */

function chunkedBody(chunks: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent++ >= chunks) c.close();
      else c.enqueue(new Uint8Array(size).fill(97));
    },
  });
}

describe("request body limits", () => {
  it("parses multipart under the cap and refuses over it, declared or streamed", async () => {
    const fd = new FormData();
    fd.set("payload", "{}");
    fd.set("photo", new File([new Uint8Array(1000)], "p.jpg", { type: "image/jpeg" }));
    const ok = await readFormDataLimited(new Request(BASE, { method: "POST", body: fd }), 10_000);
    expect((ok.get("photo") as File).size).toBe(1000);

    const declared = new Request(BASE, { method: "POST", headers: { "content-length": "20000" }, body: "x" });
    await expect(readFormDataLimited(declared, 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);

    const streamed = new Request(BASE, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zz" },
      body: chunkedBody(50, 1024),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readFormDataLimited(streamed, 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("a chunked JSON body over the cap is refused, not buffered", async () => {
    const big = new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunkedBody(200, 1024),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readJson(withBodyLimit(big, 64 * 1024), z.object({}))).rejects.toMatchObject({ status: 400 });
    const small = post("/x", { a: 1 });
    expect(await readJson(withBodyLimit(small, 64 * 1024), z.object({ a: z.number() }))).toEqual({ a: 1 });
  });

  it("photo route: 413 for an oversized upload without Content-Length", async () => {
    const { id } = await newReturn();
    const res = await photoPOST(
      new Request(`${BASE}/x`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=zz" },
        body: chunkedBody(6 * 1024, 1024),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      ctx({ id }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PHOTO_TOO_LARGE");
  });
});

/* ───────────── Admin token, public live ───────────── */

describe("admin token and live-render fail-safe", () => {
  it("reads Bearer / x-admin-token, ignores other schemes, compares the token", () => {
    const req = (h: Record<string, string>) => new Request(BASE, { headers: h });
    expect(adminAuth(req({}))).toBe("none");
    expect(adminAuth(req({ authorization: "Basic dXNlcjpwYXNz" }))).toBe("none");
    expect(adminAuth(req({ authorization: "Bearer whatever" }))).toBe("invalid"); // no ADMIN_TOKEN on the server
    process.env.ADMIN_TOKEN = "s3cret-admin-token-0123456789";
    expect(adminAuth(req({ authorization: "Bearer s3cret-admin-token-0123456789" }))).toBe("admin");
    expect(adminAuth(req({ "x-admin-token": "s3cret-admin-token-0123456789" }))).toBe("admin");
    expect(adminAuth(req({ authorization: "Bearer nope" }))).toBe("invalid");
  });

  it("a production server without LIVE_ACCESS_CODE needs ALLOW_PUBLIC_LIVE for live renders", async () => {
    expect(publicLiveAllowed()).toBe(true); // NODE_ENV=test
    vi.stubEnv("NODE_ENV", "production");
    expect(publicLiveAllowed()).toBe(false);
    expect(await allowLiveFromRequest(new Request(BASE))).toBe(false);
    vi.stubEnv("ALLOW_PUBLIC_LIVE", "1");
    expect(await allowLiveFromRequest(new Request(BASE))).toBe(true);
    vi.stubEnv("ALLOW_PUBLIC_LIVE", "");
    vi.stubEnv("LIVE_ACCESS_CODE", "judges-2026");
    expect(await allowLiveFromRequest(new Request(BASE, { headers: { cookie: "tb_live=judges-2026" } }))).toBe(true);
    expect(await allowLiveFromRequest(new Request(BASE))).toBe(false);
  });

  it("retention env can shorten but never exceed what the copy promises", () => {
    expect(config.photoRetentionHours).toBe(24);
    expect(config.renderRetentionDays).toBe(14);
    vi.stubEnv("PHOTO_RETENTION_HOURS", "2");
    vi.stubEnv("RENDER_RETENTION_DAYS", "90");
    expect(config.photoRetentionHours).toBe(2);
    expect(config.renderRetentionDays).toBe(14);
    vi.stubEnv("PHOTO_RETENTION_HOURS", "-1");
    expect(config.photoRetentionHours).toBe(24);
  });

  it("the consent and done-screen copy state the enforced retention", async () => {
    expect(CONSENT_COPY).toContain(`${PROMISED_PHOTO_RETENTION_HOURS} hours`);
    expect(CONSENT_COPY).toContain(`${PROMISED_RENDER_RETENTION_DAYS} days`);
    const done = await fs.readFile(path.join(process.cwd(), "components/shopper/ConfirmSteps.tsx"), "utf8");
    expect(done).toContain(`deletes your photo within ${PROMISED_PHOTO_RETENTION_HOURS} hours of upload`);
    expect(done).toContain(`within ${PROMISED_RENDER_RETENTION_DAYS} days`);
    // The shopper is told the photo goes to the try-on provider, and how long that provider keeps it.
    expect(CONSENT_COPY).toContain("Clothsy AI");
    expect(CONSENT_COPY).toContain("35 days");
    expect(done).toContain("35 days");
  });
});

/* ───────────── Reset scoping ───────────── */

describe("POST /api/admin/reset", () => {
  it("without a token clears only this browser's returns", async () => {
    const a1 = await newReturn();
    const a2 = await newReturn(a1.cookie);
    const b = await newReturn();
    await savePhoto(a1.id, Buffer.from("photo"));

    const res = await resetPOST(new Request(`${BASE}/api/admin/reset`, { method: "POST", headers: { cookie: a1.cookie } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, scope: "viewer", deletedReturns: 2, photoErrors: 0 });
    expect((await returnGET(new Request(BASE), ctx({ id: a1.id }))).status).toBe(404);
    expect((await returnGET(new Request(BASE), ctx({ id: a2.id }))).status).toBe(404);
    expect((await returnGET(new Request(BASE), ctx({ id: b.id }))).status).toBe(200);
    expect(await exists(path.join(PHOTOS_DIR, `${a1.id}.jpg`))).toBe(false);

    // No cookie at all: nothing to clear.
    const anon = await resetPOST(new Request(`${BASE}/api/admin/reset`, { method: "POST" }));
    expect(await anon.json()).toMatchObject({ ok: true, scope: "viewer", deletedReturns: 0 });
    expect((await returnGET(new Request(BASE), ctx({ id: b.id }))).status).toBe(200);
  });

  it("a wrong token is a 401 (never a silent viewer reset); the right one wipes everything", async () => {
    const a = await newReturn();
    const b = await newReturn();
    const reset = (h: Record<string, string>) => resetPOST(new Request(`${BASE}/api/admin/reset`, { method: "POST", headers: h }));

    const disabled = await reset({ authorization: "Bearer guess", cookie: a.cookie });
    expect(disabled.status).toBe(401);
    expect(((await disabled.json()) as { error: { message: string } }).error.message).toContain("ADMIN_TOKEN");
    expect((await returnGET(new Request(BASE), ctx({ id: a.id }))).status).toBe(200);

    process.env.ADMIN_TOKEN = "s3cret-admin-token-0123456789";
    expect((await reset({ authorization: "Bearer nope" })).status).toBe(401);
    const all = await reset({ authorization: "Bearer s3cret-admin-token-0123456789" });
    expect(await all.json()).toMatchObject({ ok: true, scope: "all" });
    expect((await returnGET(new Request(BASE), ctx({ id: a.id }))).status).toBe(404);
    expect((await returnGET(new Request(BASE), ctx({ id: b.id }))).status).toBe(404);
    expect(viewerHashOf("x")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("wrong tokens are rate-limited", async () => {
    process.env.ADMIN_TOKEN = "s3cret-admin-token-0123456789";
    const reset = () =>
      resetPOST(
        new Request(`${BASE}/api/admin/reset`, {
          method: "POST",
          headers: { authorization: "Bearer nope", "x-forwarded-for": "203.0.113.30" },
        }),
      );
    for (let i = 0; i < RATE_RULES.adminAuthFailure.perClient; i++) expect((await reset()).status).toBe(401);
    const blocked = await reset();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
  });

  it("wrong guesses from everyone can't lock out the real admin token", async () => {
    process.env.ADMIN_TOKEN = "s3cret-admin-token-0123456789";
    const reset = (token: string, ip: string) =>
      resetPOST(new Request(`${BASE}/api/admin/reset`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip } }));
    let status = 0;
    for (let i = 0; i < RATE_RULES.adminAuthFailure.global + 5 && status !== 429; i++) status = (await reset("nope", `198.51.100.${i}`)).status;
    expect(status).toBe(429); // the global failure window is used up…
    expect((await reset("nope", "192.0.2.200")).status).toBe(429);
    const ok = await reset("s3cret-admin-token-0123456789", "192.0.2.201"); // …but the right token still works
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, scope: "all" });
  });
});

/* ───────────── Retention ───────────── */

describe("retention sweep", () => {
  it("deletes expired photos (clearing the reference) and renders, keeps fresh, pinned and seeded data", async () => {
    const old = await newReturn();
    const fresh = await newReturn();
    const seeded = await newReturn();
    const pinnedReturn = await newReturn();
    const longAgo = new Date(Date.now() - 25 * HOUR).toISOString();
    const recent = new Date(Date.now() - 1 * HOUR).toISOString();
    const photo = (id: string, uploadedAt: string) => ({ url: `/api/photos/${id}`, hash: "h", width: 900, height: 1600, uploadedAt });

    const K_OLD = "a".repeat(40);
    const K_FRESH = "b".repeat(40);
    const K_PINNED = "c".repeat(40);
    const K_ORPHAN = "d".repeat(40);
    const oldAt = new Date(Date.now() - 15 * DAY).toISOString();
    const entry = (createdAt: string) => ({ provider: "dev" as const, latencyMs: 5, createdAt, contentType: "image/jpeg", externalId: null });

    await mutate((db) => {
      db.returns[old.id]!.photo = photo(old.id, longAgo);
      db.returns[fresh.id]!.photo = photo(fresh.id, recent);
      db.returns[seeded.id]!.photo = photo(seeded.id, longAgo);
      db.returns[seeded.id]!.seeded = true;
      db.returns[pinnedReturn.id]!.renders = [job(pinnedReturn.id, K_PINNED)];
      db.renderIndex[K_OLD] = entry(oldAt);
      db.renderIndex[K_FRESH] = entry(new Date().toISOString());
      db.renderIndex[K_PINNED] = entry(oldAt);
    });
    for (const id of [old.id, fresh.id, seeded.id]) await savePhoto(id, Buffer.from(`photo ${id}`));
    await backdate(path.join(PHOTOS_DIR, `${old.id}.jpg`), 25 * HOUR);
    await backdate(path.join(PHOTOS_DIR, `${seeded.id}.jpg`), 25 * HOUR);
    await savePhoto("ret_orphanold", Buffer.from("orphan"));
    await backdate(path.join(PHOTOS_DIR, "ret_orphanold.jpg"), 30 * HOUR);
    await savePhoto("ret_orphannew", Buffer.from("orphan new")); // e.g. mid-upload: too fresh to touch

    for (const name of [K_OLD, `${K_OLD}_clothsy-abc`, K_FRESH, K_PINNED, K_ORPHAN]) await saveRender(name, Buffer.from(name));
    for (const name of [K_OLD, `${K_OLD}_clothsy-abc`, K_PINNED, K_ORPHAN]) await backdate(path.join(RENDERS_DIR, `${name}.img`), 15 * DAY);

    // Pins go through the admin endpoint (token required).
    const pinReq = (h: Record<string, string>) => retentionPOST(post("/api/admin/retention", { action: "pin", returnId: pinnedReturn.id }, h));
    expect((await pinReq({})).status).toBe(401);
    process.env.ADMIN_TOKEN = "s3cret-admin-token-0123456789";
    const auth = { authorization: "Bearer s3cret-admin-token-0123456789" };
    const pinned = await pinReq(auth);
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ ok: true, pinned: [K_PINNED], totalPins: 1 });
    expect(Object.keys(await readPins())).toEqual([K_PINNED]);

    const dry = await sweepRetention({ dryRun: true });
    expect(dry.photos).toMatchObject({ refsCleared: 1, orphansDeleted: 1 });
    expect(dry.renders).toMatchObject({ indexEntriesDeleted: 1, filesDeleted: 3, pinnedKept: 1 });
    expect(await exists(path.join(PHOTOS_DIR, `${old.id}.jpg`))).toBe(true);

    const report = await sweepRetention();
    expect(report.photos).toEqual({ refsCleared: 1, filesDeleted: 2, orphansDeleted: 1, errors: 0 });
    expect(report.renders).toEqual({ indexEntriesDeleted: 1, filesDeleted: 3, pinnedKept: 1, errors: 0 });

    const db = await readDb();
    expect(db.returns[old.id]!.photo).toBeNull();
    expect(db.returns[old.id]!.consent).toBeNull(); // untouched (never set in this fixture)
    expect(db.returns[fresh.id]!.photo?.uploadedAt).toBe(recent);
    expect(db.returns[seeded.id]!.photo).not.toBeNull();
    expect(Object.keys(db.renderIndex).sort()).toEqual([K_FRESH, K_PINNED]);
    expect(await exists(path.join(PHOTOS_DIR, `${old.id}.jpg`))).toBe(false);
    expect(await exists(path.join(PHOTOS_DIR, `${fresh.id}.jpg`))).toBe(true);
    expect(await exists(path.join(PHOTOS_DIR, `${seeded.id}.jpg`))).toBe(true);
    expect(await exists(path.join(PHOTOS_DIR, "ret_orphanold.jpg"))).toBe(false);
    expect(await exists(path.join(PHOTOS_DIR, "ret_orphannew.jpg"))).toBe(true);
    expect(await exists(path.join(RENDERS_DIR, `${K_OLD}.img`))).toBe(false);
    expect(await exists(path.join(RENDERS_DIR, `${K_OLD}_clothsy-abc.img`))).toBe(false);
    expect(await exists(path.join(RENDERS_DIR, `${K_ORPHAN}.img`))).toBe(false);
    expect(await exists(path.join(RENDERS_DIR, `${K_FRESH}.img`))).toBe(true);
    expect(await exists(path.join(RENDERS_DIR, `${K_PINNED}.img`))).toBe(true);

    // Nothing left to do: a second sweep is a no-op.
    const again = await sweepRetention();
    expect(again.photos.filesDeleted + again.renders.filesDeleted + again.renders.indexEntriesDeleted).toBe(0);

    // Unpinning lets the next sweep apply the normal rule.
    const unpin = await retentionPOST(post("/api/admin/retention", { action: "unpin", returnId: pinnedReturn.id }, auth));
    expect(await unpin.json()).toMatchObject({ ok: true, unpinned: 1, totalPins: 0 });
    const swept = await retentionPOST(post("/api/admin/retention", { action: "sweep" }, auth));
    expect(((await swept.json()) as { report: { renders: { indexEntriesDeleted: number } } }).report.renders.indexEntriesDeleted).toBe(1);
    expect(await exists(path.join(RENDERS_DIR, `${K_PINNED}.img`))).toBe(false);
    expect(JSON.parse(await fs.readFile(PINS_FILE, "utf8"))).toEqual({ version: 1, renders: {} });

    const status = await retentionGET(new Request(BASE, { headers: auth }));
    expect(await status.json()).toMatchObject({ policy: { photoRetentionHours: 24, renderRetentionDays: 14 }, pins: 0 });
    expect((await retentionGET(new Request(BASE))).status).toBe(401);
  });

  it("deletes a photo before its 24 hours are up, never long before (hourly sweeps)", async () => {
    expect(sweepLeadMs(24 * HOUR)).toBe(HOUR);
    expect(sweepLeadMs(14 * DAY)).toBe(HOUR);
    expect(sweepLeadMs(2 * HOUR)).toBe(HOUR / 2); // a shortened retention keeps most of its window
    const now = Date.now();
    const due = await newReturn();
    const early = await newReturn();
    await mutate((db) => {
      const photo = (id: string, ageMs: number) => ({ url: `/api/photos/${id}`, hash: "h", width: 900, height: 1600, uploadedAt: new Date(now - ageMs).toISOString() });
      db.returns[due.id]!.photo = photo(due.id, 23.5 * HOUR); // the next hourly sweep would be past 24 h
      db.returns[early.id]!.photo = photo(early.id, 22 * HOUR);
    });
    for (const id of [due.id, early.id]) await savePhoto(id, Buffer.from(`photo ${id}`));
    await sweepRetention({ now });
    const db = await readDb();
    expect(db.returns[due.id]!.photo).toBeNull();
    expect(db.returns[early.id]!.photo).not.toBeNull();
  });

  it("pin errors map to API errors", async () => {
    process.env.ADMIN_TOKEN = "s3cret-admin-token-0123456789";
    const auth = { authorization: "Bearer s3cret-admin-token-0123456789" };
    const none = await retentionPOST(post("/api/admin/retention", { action: "pin", returnId: "ret_missing" }, auth));
    expect(none.status).toBe(404);
    const { id } = await newReturn();
    const empty = await retentionPOST(post("/api/admin/retention", { action: "pin", returnId: id }, auth));
    expect(empty.status).toBe(409);
    expect((await retentionPOST(post("/api/admin/retention", { action: "explode" }, auth))).status).toBe(400);
  });

  it("GET /api/status schedules an overdue sweep after the response", async () => {
    expect(retentionSweepDue()).toBe(true);
    const before = bg.pending.length;
    expect((await statusGET(new Request(`${BASE}/api/status`))).status).toBe(200);
    expect(bg.pending.length).toBe(before + 1);
    await Promise.all(bg.pending.splice(0).map((fn) => fn()));
    expect(retentionSweepDue()).toBe(false);
    await statusGET(new Request(`${BASE}/api/status`));
    expect(bg.pending.length).toBe(0);
  });
});

/* ───────────── next.config ───────────── */

describe("next.config", () => {
  it("builds a standalone server without X-Powered-By and sends the security headers everywhere", async () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.serverExternalPackages).toContain("sharp");
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    const h = Object.fromEntries((all?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
    expect(h["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toMatch(/(^|, )camera=\(self\)/);
    expect(h["x-robots-tag"]).toMatch(/noindex/);
    // Config headers override a route's own value, so the photo route's no-referrer is re-applied.
    const photos = rules.find((r) => r.source === "/api/photos/:path*");
    expect(photos?.headers).toEqual([{ key: "Referrer-Policy", value: "no-referrer" }]);
    expect(rules.indexOf(photos!)).toBeGreaterThan(rules.indexOf(all!));
  });
});

describe("deploy configs", () => {
  it("cap live renders per day well below the 20 free credits (the cap guards the reserve)", async () => {
    const fly = await fs.readFile(path.join(process.cwd(), "fly.toml"), "utf8");
    const render = await fs.readFile(path.join(process.cwd(), "render.yaml"), "utf8");
    const flyCap = Number(/^\s*DAILY_LIVE_RENDER_CAP\s*=\s*"(\d+)"/m.exec(fly)?.[1]);
    const renderCap = Number(/key: DAILY_LIVE_RENDER_CAP\s+value: "(\d+)"/.exec(render)?.[1]);
    for (const cap of [flyCap, renderCap]) {
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(8);
    }
  });
});
