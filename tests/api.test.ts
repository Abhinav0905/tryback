// End-to-end over the route handlers (no server): order lookup → return → reason →
// photo → speculative renders → form → diagnosis + post-diagnosis renders → gate
// retry/downgrade → cap → resolve. Uses the dev double and an isolated data dir.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = path.join(os.tmpdir(), `tryback-test-api-${process.pid}`);
  process.env.TRYBACK_DATA_DIR = dir;
  process.env.TRYON_MODE = "dev";
  process.env.DEV_RENDER_LATENCY_MS = "5";
  process.env.DEV_FAIL_RATE = "0";
  process.env.MAX_RENDERS_PER_RETURN = "5";
  delete process.env.CLOTHSY_API_KEY;
  delete process.env.LIVE_ACCESS_CODE;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  return { dir };
});

// `after()` needs a Next request scope; collect the callbacks so tests can await them.
// Like the real thing, callbacks only run after the response — here, when a test drains them.
const bg = vi.hoisted(() => ({ pending: [] as Array<() => unknown> }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    bg.pending.push(fn);
  },
}));

// Synthetic product shots (independent of `npm run assets`).
vi.mock("@/lib/tryon/garment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tryon/garment")>();
  const sharp = (await import("sharp")).default;
  const { createHash } = await import("node:crypto");
  return {
    ...actual,
    loadGarmentImage: async (sku: { colorHex: string }, variant: "primary" | "alt") => {
      const bytes = await sharp({ create: { width: 384, height: 512, channels: 3, background: "#ffffff" } })
        .composite([
          {
            input: await sharp({ create: { width: 220, height: 380, channels: 3, background: sku.colorHex } }).png().toBuffer(),
            left: 82,
            top: variant === "alt" ? 40 : 66,
          },
        ])
        .jpeg({ quality: 90 })
        .toBuffer();
      return { bytes, hash: createHash("sha256").update(bytes).digest("hex"), contentType: "image/jpeg" as const };
    },
  };
});

import { promises as fs } from "node:fs";
import sharp from "sharp";
import { GET as catalogGET } from "@/app/api/catalog/route";
import { GET as orderGET } from "@/app/api/orders/[orderId]/route";
import { POST as createReturnPOST } from "@/app/api/returns/route";
import { GET as returnGET } from "@/app/api/returns/[id]/route";
import { POST as reasonPOST } from "@/app/api/returns/[id]/reason/route";
import { POST as photoPOST } from "@/app/api/returns/[id]/photo/route";
import { POST as skipPhotoPOST } from "@/app/api/returns/[id]/skip-photo/route";
import { POST as formPOST } from "@/app/api/returns/[id]/form/route";
import { POST as gatePOST } from "@/app/api/returns/[id]/renders/[jobId]/gate/route";
import { POST as sizePreviewPOST } from "@/app/api/returns/[id]/size-preview/route";
import { POST as resolvePOST } from "@/app/api/returns/[id]/resolve/route";
import { GET as renderGET } from "@/app/api/renders/[key]/route";
import { GET as photoGET } from "@/app/api/photos/[id]/route";
import { GET as statusGET } from "@/app/api/status/route";
import { POST as livePOST } from "@/app/api/live/route";
import { GET as benchGET } from "@/app/api/bench/route";
import { GET as metricsGET } from "@/app/api/metrics/route";
import type { BenchItem } from "@/lib/metrics";
import { allowLiveFromRequest } from "@/lib/live";
import { requireSku } from "@/lib/catalog";
import type { AppStatus, BodyKeypoints, GateResult, PhotoMeasurements, PreflightResult, ReturnCase } from "@/lib/types";

const BASE = "http://localhost:3000";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RouteContext is a generated global; tests pass plain params.
function ctx<P extends Record<string, string>>(params: P): any {
  return { params: Promise.resolve(params) };
}

function jsonReq(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function drain(): Promise<void> {
  while (bg.pending.length) await Promise.all(bg.pending.splice(0).map((fn) => fn()));
}

async function getReturn(id: string): Promise<ReturnCase> {
  const res = await returnGET(new Request(`${BASE}/api/returns/${id}`), ctx({ id }));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await body<{ return: ReturnCase }>(res)).return;
}

function keypoints(scale = 1): BodyKeypoints {
  const k = (x: number, y: number) => ({ x: x * scale, y: y * scale, visibility: 0.95 });
  return {
    nose: k(500, 200), leftEye: k(490, 190), rightEye: k(510, 190),
    leftShoulder: k(420, 330), rightShoulder: k(580, 330), leftElbow: k(400, 500), rightElbow: k(600, 500),
    leftWrist: k(395, 650), rightWrist: k(605, 650), leftHip: k(450, 700), rightHip: k(550, 700),
    leftKnee: k(455, 950), rightKnee: k(545, 950), leftAnkle: k(460, 1200), rightAnkle: k(540, 1200),
  };
}

const preflight: PreflightResult = {
  ok: true,
  overridden: false,
  checks: [{ id: "full_body", ok: true, message: "Full body in frame" }],
};

function measurements(): PhotoMeasurements {
  return {
    keypoints: keypoints(),
    calibration: {
      method: "garment", pxPerCm: 6, uncertaintyCm: 1.5, hpsY: 300, observedHemY: 888, observedSleeveEnd: { x: 395, y: 640 },
      centerX: 500, hemHalfWidthPx: 120, purchasedSize: "M",
      purchasedPom: { hpsToHemCm: 98, sleeveCm: 58, halfChestCm: 46 }, imageWidth: 1200, imageHeight: 2000,
    },
    easeRatio: 1.03,
    hemCm: 98,
    garmentMaskArea: 0.21,
    observedGarmentLab: [68, 5, 62],
  };
}

async function photoForm(opts: { adult?: unknown; type?: string; bytes?: Buffer; m?: PhotoMeasurements | null } = {}): Promise<FormData> {
  const bytes =
    opts.bytes ??
    (await sharp({ create: { width: 1200, height: 2000, channels: 3, background: { r: 120, g: 124, b: 130 } } })
      .composite([{ input: await sharp({ create: { width: 200, height: 900, channels: 3, background: "#C9A227" } }).png().toBuffer(), left: 400, top: 300 }])
      .png()
      .toBuffer());
  const fd = new FormData();
  fd.set("photo", new File([new Uint8Array(bytes)], "photo.png", { type: opts.type ?? "image/png" }));
  fd.set(
    "payload",
    JSON.stringify({ adultAttested: "adult" in opts ? opts.adult : true, preflight, measurements: opts.m === undefined ? measurements() : opts.m }),
  );
  return fd;
}

function gate(verdict: GateResult["verdict"], badge: string | null = null): GateResult {
  return {
    verdict,
    metrics: { colourDeltaE: 9.5, residueFraction: 0.31, silhouetteIoU: 0.92, identityDiff: 0.03, hemErrorCm: null, garmentCoverage: 0.8 },
    reasons: ["residue 0.31 > 0.20"],
    badge,
    computedAt: new Date().toISOString(),
    computeMs: 420,
  };
}

beforeAll(async () => {
  await fs.rm(env.dir, { recursive: true, force: true });
});
afterAll(async () => {
  await drain();
  await fs.rm(env.dir, { recursive: true, force: true });
});

describe("catalog, orders, status, live", () => {
  it("GET /api/catalog", async () => {
    const { skus } = await body<{ skus: unknown[] }>(await catalogGET());
    expect(skus.length).toBeGreaterThan(10);
  });

  it("GET /api/orders/[orderId] matches email case-insensitively, allows 'demo', 404s otherwise", async () => {
    const ok = await orderGET(new Request(`${BASE}/api/orders/1042?email=PRIYA@example.com`), ctx({ orderId: "1042" }));
    expect(ok.status).toBe(200);
    const data = await body<{ order: { id: string }; skus: { id: string }[] }>(ok);
    expect(data.order.id).toBe("1042");
    expect(data.skus.map((s) => s.id)).toEqual(["fw-wrap-dress-mustard", "fw-knit-top-oat"]);

    expect((await orderGET(new Request(`${BASE}/api/orders/1042?email=demo`), ctx({ orderId: "1042" }))).status).toBe(200);
    const wrong = await orderGET(new Request(`${BASE}/api/orders/1042?email=x@y.z`), ctx({ orderId: "1042" }));
    expect(wrong.status).toBe(404);
    expect(await body(wrong)).toEqual({ error: { code: "ORDER_NOT_FOUND", message: expect.any(String) } });
    expect((await orderGET(new Request(`${BASE}/api/orders/9999?email=demo`), ctx({ orderId: "9999" }))).status).toBe(404);
    expect((await orderGET(new Request(`${BASE}/api/orders/1042`), ctx({ orderId: "1042" }))).status).toBe(400);
  });

  it("GET /api/status reports the dev double", async () => {
    const s = await body<AppStatus>(await statusGET(new Request(`${BASE}/api/status`)));
    expect(s).toMatchObject({ mode: "dev", activeProvider: "dev", hasClothsyKey: false, hasAnthropicKey: false, maxRendersPerReturn: 5 });
    expect(typeof s.liveRendersToday).toBe("number");
  });

  it("POST /api/live sets the tb_live cookie only for the right code", async () => {
    expect(await body(await livePOST(jsonReq("/api/live", { code: "anything" })))).toEqual({ ok: true }); // no code configured
    // fetch() with a string body and no header sends text/plain — still accepted as JSON.
    const plain = await livePOST(new Request(`${BASE}/api/live`, { method: "POST", body: JSON.stringify({ code: "x" }) }));
    expect(plain.status).toBe(200);
    expect((await livePOST(jsonReq("/api/live", {}))).status).toBe(400);
    process.env.LIVE_ACCESS_CODE = "judges-2026";
    try {
      const bad = await livePOST(jsonReq("/api/live", { code: "nope" }));
      expect(bad.status).toBe(401);
      expect((await body<{ ok: boolean }>(bad)).ok).toBe(false);
      const good = await livePOST(jsonReq("/api/live", { code: "judges-2026" }));
      expect(good.status).toBe(200);
      const cookie = good.headers.get("set-cookie")!;
      expect(cookie).toMatch(/^tb_live=judges-2026;/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Max-Age=604800/);
      expect(await allowLiveFromRequest(new Request(BASE, { headers: { cookie: "a=1; tb_live=judges-2026" } }))).toBe(true);
      expect(await allowLiveFromRequest(new Request(BASE, { headers: { cookie: "tb_live=wrong" } }))).toBe(false);
      expect(await allowLiveFromRequest(new Request(BASE))).toBe(false);
      expect(await body<AppStatus>(await statusGET(new Request(`${BASE}/api/status`)))).toMatchObject({ activeProvider: "dev" });
    } finally {
      delete process.env.LIVE_ACCESS_CODE;
    }
  });
});

describe("style/colour return, end to end", () => {
  let id = "";
  let viewerCookie = "";

  it("creates a return", async () => {
    expect((await createReturnPOST(jsonReq("/api/returns", "{oops"))).status).toBe(400);
    expect((await createReturnPOST(jsonReq("/api/returns", { orderId: "1042", email: "demo", lineIndex: 7 }))).status).toBe(400);
    expect((await createReturnPOST(jsonReq("/api/returns", { orderId: "1042", email: "bad@x.y", lineIndex: 0 }))).status).toBe(404);
    const res = await createReturnPOST(jsonReq("/api/returns", { orderId: "1042", email: "priya@example.com", lineIndex: 0 }));
    expect(res.status).toBe(201);
    const r = (await body<{ return: ReturnCase }>(res)).return;
    expect(r).toMatchObject({ status: "started", skuId: "fw-wrap-dress-mustard", size: "M", price: 89, renders: [] });
    id = r.id;
    // This browser is remembered (httpOnly), so /bench can show it its own photo and renders.
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^tb_viewer=[a-f0-9]{32};.*HttpOnly/);
    viewerCookie = setCookie.split(";")[0];
    const again = await createReturnPOST(
      new Request(`${BASE}/api/returns`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: viewerCookie },
        body: JSON.stringify({ orderId: "1042", email: "demo", lineIndex: 1 }),
      }),
    );
    expect(again.headers.get("set-cookie")).toBeNull(); // existing token reused
    expect((await body<{ return: ReturnCase }>(again)).return.viewerHash).toBe(r.viewerHash);
  });

  it("rejects unknown/unsafe ids", async () => {
    expect((await returnGET(new Request(`${BASE}/api/returns/x`), ctx({ id: "ret_missing" }))).status).toBe(404);
    expect((await returnGET(new Request(`${BASE}/api/returns/x`), ctx({ id: "../etc" }))).status).toBe(400);
  });

  it("sets the reason and speculative candidates", async () => {
    expect((await reasonPOST(jsonReq("/x", { reason: "bogus" }), ctx({ id }))).status).toBe(400);
    const r = (await body<{ return: ReturnCase }>(await reasonPOST(jsonReq("/x", { reason: "style_colour" }), ctx({ id })))).return;
    expect(r.status).toBe("reason_selected");
    expect(r.candidates).toHaveLength(2);
    expect(r.renders).toEqual([]); // no photo yet
  });

  it("rejects a photo without the 18+ attestation", async () => {
    const res = await photoPOST(new Request(`${BASE}/x`, { method: "POST", body: await photoForm({ adult: false }) }), ctx({ id }));
    expect(res.status).toBe(400);
    expect((await body<{ error: { code: string } }>(res)).error.code).toBe("ADULT_ATTESTATION_REQUIRED");
    const gif = await photoPOST(new Request(`${BASE}/x`, { method: "POST", body: await photoForm({ type: "image/gif" }) }), ctx({ id }));
    expect(gif.status).toBe(415);
    const junk = await photoPOST(
      new Request(`${BASE}/x`, { method: "POST", body: await photoForm({ type: "image/jpeg", bytes: Buffer.from("not an image") }) }),
      ctx({ id }),
    );
    expect(junk.status).toBe(422);
    expect((await getReturn(id)).photo).toBeNull();
  });

  it("stores the photo (re-encoded to JPEG ≤1600px, measurements rescaled) and starts 2 speculative renders", async () => {
    const res = await photoPOST(new Request(`${BASE}/x`, { method: "POST", body: await photoForm() }), ctx({ id }));
    expect(res.status).toBe(200);
    const r = (await body<{ return: ReturnCase }>(res)).return;
    expect(r.status).toBe("photo_uploaded");
    expect(r.consent?.adultAttested).toBe(true);
    expect(r.photo).toMatchObject({ url: `/api/photos/${id}`, width: 960, height: 1600 });
    const s = 960 / 1200;
    expect(r.measurements!.keypoints.leftHip.x).toBeCloseTo(450 * s, 6);
    expect(r.measurements!.calibration!.pxPerCm).toBeCloseTo(6 * s, 6);
    expect(r.measurements!.calibration!.imageHeight).toBe(1600);
    expect(r.timeline.photoAt).not.toBeNull();
    expect(r.renders.map((j) => [j.phase, j.status])).toEqual([
      ["speculative", "queued"],
      ["speculative", "queued"],
    ]);

    await drain();
    const done = await getReturn(id);
    expect(done.renders.every((j) => j.status === "success" && j.provider === "dev")).toBe(true);
    expect(done.simulatedRenders).toBe(2);
    expect(done.timeline.firstCardAt).not.toBeNull();

    const photo = await photoGET(new Request(`${BASE}/api/photos/${id}`), ctx({ id }));
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect(photo.headers.get("cache-control")).toBe("private, no-store");
    expect((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).format).toBe("jpeg");

    const key = done.renders[0].cacheKey;
    const img = await renderGET(new Request(`${BASE}/api/renders/${key}`), ctx({ key }));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(img.headers.get("x-tryback-provider")).toBe("dev");
    expect((await renderGET(new Request(BASE), ctx({ key: "..%2f" }))).status).toBe(400);
    expect((await renderGET(new Request(BASE), ctx({ key: "f".repeat(40) }))).status).toBe(404);
  });

  it("locks the photo once previews exist", async () => {
    const res = await photoPOST(new Request(`${BASE}/x`, { method: "POST", body: await photoForm() }), ctx({ id }));
    expect(res.status).toBe(409);
  });

  it("submits the form: rules diagnosis, top-4 candidates, up to 2 new renders", async () => {
    expect((await formPOST(jsonReq("/x", { chips: ["not_a_chip"], freeText: "" }), ctx({ id }))).status).toBe(400);
    expect((await formPOST(jsonReq("/x", { chips: [], freeText: "x".repeat(501) }), ctx({ id }))).status).toBe(400);

    const res = await formPOST(jsonReq("/x", { chips: ["colour_not_me", "too_clingy"], freeText: "wanted it looser" }), ctx({ id }));
    expect(res.status).toBe(200);
    const r = (await body<{ return: ReturnCase }>(res)).return;
    expect(r.status).toBe("form_submitted");
    expect(r.timeline.formSubmittedAt).not.toBeNull();
    expect(r.diagnosis).toMatchObject({ source: "rules" });
    expect(r.diagnosis!.issues.map((i) => i.type)).toEqual(expect.arrayContaining(["colour", "too_clingy"]));
    expect(r.candidates).toHaveLength(4);
    expect(requireSku(r.candidates[0].skuId).silhouette).toBe("a-line");
    expect(r.candidates[0].why).toMatch(/^Looser A-line through the hip, in /);

    const postDiag = r.renders.filter((j) => j.phase === "post_diagnosis");
    expect(postDiag.length).toBeGreaterThanOrEqual(1);
    expect(postDiag.length).toBeLessThanOrEqual(2);
    expect(r.renders.length).toBeLessThanOrEqual(5);
    // Every rendered/queued SKU is unique per variant.
    const keys = r.renders.map((j) => `${j.skuId}:${j.garmentVariant}`);
    expect(new Set(keys).size).toBe(keys.length);
    await drain();
  });

  it("gate: stores pass, spawns one retry, then downgrades retry → badge when no retry is possible", async () => {
    const r = await getReturn(id);
    const success = r.renders.filter((j) => j.status === "success");
    expect(success.length).toBeGreaterThanOrEqual(3);

    const passJob = success[0];
    const pass = (await body<{ return: ReturnCase }>(
      await gatePOST(jsonReq("/x", { gate: gate("pass") }), ctx({ id, jobId: passJob.id })),
    )).return;
    expect(pass.renders.find((j) => j.id === passJob.id)!.gate!.verdict).toBe("pass");

    expect((await gatePOST(jsonReq("/x", { gate: { verdict: "maybe" } }), ctx({ id, jobId: passJob.id }))).status).toBe(400);
    expect((await gatePOST(jsonReq("/x", { gate: gate("pass") }), ctx({ id, jobId: "job_nope" }))).status).toBe(404);

    // A speculative render re-ranked out of the top 4 is never shown, so it can't spend a retry.
    const offScreen = success.find((j) => !r.candidates.some((c) => c.skuId === j.skuId));
    if (offScreen) {
      const refused = (await body<{ return: ReturnCase }>(
        await gatePOST(jsonReq("/x", { gate: gate("retry") }), ctx({ id, jobId: offScreen.id })),
      )).return;
      expect(refused.renders.find((j) => j.id === offScreen.id)!.gate!.verdict).toBe("badge");
      expect(refused.renders.some((j) => j.retryOf === offScreen.id)).toBe(false);
    }

    // Retry on a card on screen whose SKU has an alt image (all dresses have one).
    const retryTarget = success.find(
      (j) => j.id !== passJob.id && requireSku(j.skuId).altImage && r.candidates.some((c) => c.skuId === j.skuId),
    )!;
    const after = (await body<{ return: ReturnCase }>(
      await gatePOST(jsonReq("/x", { gate: gate("retry") }), ctx({ id, jobId: retryTarget.id })),
    )).return;
    const original = after.renders.find((j) => j.id === retryTarget.id)!;
    expect(original.gate!.verdict).toBe("retry");
    const retry = after.renders.find((j) => j.retryOf === retryTarget.id)!;
    expect(retry).toBeDefined();
    expect(original.supersededBy).toBe(retry.id);
    expect(retry).toMatchObject({ phase: "retry", garmentVariant: "alt", status: "queued" });
    expect(after.renders).toHaveLength(5); // 2 speculative + 2 post-diagnosis + 1 retry = the cap
    await drain();
    const ran = (await getReturn(id)).renders.find((j) => j.id === retry.id)!;
    expect(ran.status).toBe("success");

    // A retry can't be retried: the verdict is downgraded to badge with the default text, reasons kept.
    const down = (await body<{ return: ReturnCase }>(
      await gatePOST(jsonReq("/x", { gate: gate("retry") }), ctx({ id, jobId: retry.id })),
    )).return;
    const g = down.renders.find((j) => j.id === retry.id)!.gate!;
    expect(g.verdict).toBe("badge");
    expect(g.badge).toBe("Preview approximate");
    expect(g.reasons[0]).toBe("residue 0.31 > 0.20");
    expect(down.renders).toHaveLength(5);

    // A badge text supplied by the gate is kept on downgrade.
    const other = success.find((j) => j.id !== retryTarget.id && j.id !== passJob.id && j.id !== offScreen?.id)!;
    const kept = (await body<{ return: ReturnCase }>(
      await gatePOST(jsonReq("/x", { gate: gate("retry", "Colour preview · silhouette approximate") }), ctx({ id, jobId: other.id })),
    )).return;
    expect(kept.renders.find((j) => j.id === other.id)!.gate).toMatchObject({
      verdict: "badge",
      badge: "Colour preview · silhouette approximate",
    });

    // A severe failure whose retry is refused is hidden, not shown with "Preview approximate".
    const severe = { ...gate("retry"), badge: null, fallbackVerdict: "drop" as const };
    const dropped = (await body<{ return: ReturnCase }>(
      await gatePOST(jsonReq("/x", { gate: severe }), ctx({ id, jobId: other.id })),
    )).return;
    expect(dropped.renders.find((j) => j.id === other.id)!.gate).toMatchObject({ verdict: "drop", badge: null });
  });

  it("/bench shows photos and renders only to the browser that made the return (or code holders)", async () => {
    const items = async (cookie?: string) =>
      (await body<{ items: BenchItem[] }>(await benchGET(new Request(`${BASE}/api/bench`, cookie ? { headers: { cookie } } : {})))).items.filter(
        (it) => it.job.skuId && it.sourceSkuId === "fw-wrap-dress-mustard",
      );

    const anon = await items();
    expect(anon.length).toBeGreaterThan(0);
    for (const it of anon) {
      expect(it).toMatchObject({ returnId: "", photoUrl: null, measurements: null });
      expect(it.job).toMatchObject({ returnId: "", cacheKey: "", resultUrl: null });
      expect(JSON.stringify(it)).not.toContain(id);
    }
    expect(anon.some((it) => it.job.gate !== null)).toBe(true); // stats stay public

    const mine = (await items(viewerCookie)).filter((it) => it.returnId === id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].photoUrl).toBe(`/api/photos/${id}`);
    expect(mine[0].job.resultUrl).toMatch(/^\/api\/renders\//);

    process.env.LIVE_ACCESS_CODE = "judges-2026";
    try {
      expect((await items("tb_live=judges-2026")).some((it) => it.returnId === id)).toBe(true);
      expect((await items("tb_live=wrong")).some((it) => it.returnId === id)).toBe(false);
    } finally {
      delete process.env.LIVE_ACCESS_CODE;
    }

    // The public dashboard lists recent returns under opaque ids, never the return id itself.
    const m = await body<{ recent: { id: string }[] }>(await metricsGET(new Request(`${BASE}/api/metrics?seeded=0`)));
    expect(m.recent.length).toBeGreaterThan(0);
    expect(m.recent.some((r) => r.id === id)).toBe(false);
    expect(m.recent.every((r) => /^r_[a-f0-9]{16}$/.test(r.id))).toBe(true);
  });

  it("serves renders by version and rejects malformed versions", async () => {
    const key = (await getReturn(id)).renders[0].cacheKey;
    expect((await renderGET(new Request(`${BASE}/api/renders/${key}?v=../x`), ctx({ key }))).status).toBe(400);
    expect((await renderGET(new Request(`${BASE}/api/renders/${key}?v=clothsy-zzz`), ctx({ key }))).status).toBe(404);
    expect((await renderGET(new Request(`${BASE}/api/renders/${key}`), ctx({ key }))).status).toBe(200);
  });

  it("size preview respects the per-return cap", async () => {
    const r = await getReturn(id);
    expect(r.renders.filter((j) => j.status !== "skipped")).toHaveLength(5);
    const res = await sizePreviewPOST(jsonReq("/x", { skuId: "fw-wrap-dress-mustard", size: "L" }), ctx({ id }));
    expect(res.status).toBe(409);
    expect((await body<{ error: { code: string } }>(res)).error.code).toBe("RENDER_CAP_REACHED");
    expect((await sizePreviewPOST(jsonReq("/x", { skuId: "fw-aline-midi-cobalt", size: "M" }), ctx({ id }))).status).toBe(400);
  });

  it("resolves as an exchange (stock validated) exactly once", async () => {
    const oos = await resolvePOST(jsonReq("/x", { type: "exchange", skuId: "fw-shirt-dress-ecru", size: "M" }), ctx({ id }));
    expect(oos.status).toBe(409);
    expect((await body<{ error: { code: string } }>(oos)).error.code).toBe("OUT_OF_STOCK");
    expect((await resolvePOST(jsonReq("/x", { type: "exchange", skuId: "fw-wrap-dress-mustard", size: "M" }), ctx({ id }))).status).toBe(400);

    const res = await resolvePOST(jsonReq("/x", { type: "exchange", skuId: "fw-aline-midi-cobalt", size: "M" }), ctx({ id }));
    expect(res.status).toBe(200);
    const r = (await body<{ return: ReturnCase }>(res)).return;
    expect(r.status).toBe("resolved");
    expect(r.outcome).toMatchObject({
      type: "exchange",
      skuId: "fw-aline-midi-cobalt",
      size: "M",
      priceDiff: 0,
      retainedRevenue: 89,
      bonusCredit: 10, // the +$10 store credit the shopper was promised
    });
    expect(r.timeline.resolvedAt).not.toBeNull();

    const again = await resolvePOST(jsonReq("/x", { type: "refund" }), ctx({ id }));
    expect(again.status).toBe(409);
    expect((await body<{ error: { code: string } }>(again)).error.code).toBe("ALREADY_RESOLVED");
  });
});

describe("fit/size and no-photo paths", () => {
  async function newReturn(orderId: string, lineIndex: number): Promise<string> {
    const res = await createReturnPOST(jsonReq("/api/returns", { orderId, email: "demo", lineIndex }));
    return (await body<{ return: ReturnCase }>(res)).return.id;
  }

  it("fit_size: stores complaints, uploads a photo with no renders, previews one size, refunds", async () => {
    const id = await newReturn("1043", 0); // linen shirt M
    const r = (await body<{ return: ReturnCase }>(
      await reasonPOST(jsonReq("/x", { reason: "fit_size", fitComplaints: ["too_short", "too_short"] }), ctx({ id })),
    )).return;
    expect(r.fitComplaints).toEqual(["too_short"]);
    expect(r.candidates).toEqual([]);

    const up = (await body<{ return: ReturnCase }>(
      await photoPOST(new Request(`${BASE}/x`, { method: "POST", body: await photoForm({ m: null }) }), ctx({ id })),
    )).return;
    expect(up.renders).toEqual([]);
    expect(up.measurements).toBeNull();

    expect((await sizePreviewPOST(jsonReq("/x", { skuId: "fw-wrap-dress-navy", size: "M" }), ctx({ id }))).status).toBe(400);
    const prev = (await body<{ return: ReturnCase }>(
      await sizePreviewPOST(jsonReq("/x", { skuId: "fw-linen-shirt-white-tall", size: "M" }), ctx({ id })),
    )).return;
    expect(prev.renders).toHaveLength(1);
    expect(prev.renders[0]).toMatchObject({ phase: "size_preview", transition: "longer", skuId: "fw-linen-shirt-white-tall" });
    // Same SKU again (another size) is idempotent — try-on can't show size.
    const again = (await body<{ return: ReturnCase }>(
      await sizePreviewPOST(jsonReq("/x", { skuId: "fw-linen-shirt-white-tall", size: "L" }), ctx({ id })),
    )).return;
    expect(again.renders).toHaveLength(1);
    await drain();

    const done = (await body<{ return: ReturnCase }>(await resolvePOST(jsonReq("/x", { type: "refund" }), ctx({ id })))).return;
    expect(done.outcome).toMatchObject({ type: "refund", skuId: null, retainedRevenue: 0, priceDiff: 0 });
  });

  it("no-photo path: skip photo, form ranks catalogue alternatives with zero renders", async () => {
    const id = await newReturn("1044", 1); // shift dress S
    await reasonPOST(jsonReq("/x", { reason: "style_colour" }), ctx({ id }));
    const skipped = (await body<{ return: ReturnCase }>(await skipPhotoPOST(new Request(`${BASE}/x`, { method: "POST" }), ctx({ id })))).return;
    expect(skipped.photoSkipped).toBe(true);
    const r = (await body<{ return: ReturnCase }>(
      await formPOST(jsonReq("/x", { chips: ["too_boxy"], freeText: "" }), ctx({ id })),
    )).return;
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.renders).toEqual([]);
    expect(r.creditsSpent).toBe(0);
    expect((await sizePreviewPOST(jsonReq("/x", { skuId: "fw-shift-dress-navy", size: "S" }), ctx({ id }))).status).toBe(409);
  });

  it("the style form is refused for non-style returns", async () => {
    const id = await newReturn("1044", 0);
    await reasonPOST(jsonReq("/x", { reason: "other" }), ctx({ id }));
    const res = await formPOST(jsonReq("/x", { chips: [], freeText: "" }), ctx({ id }));
    expect(res.status).toBe(409);
  });
});

// Last on purpose: it exhausts the process-wide guessing window.
describe("access-code guessing limits", () => {
  const guess = (headers: Record<string, string> = {}) =>
    livePOST(
      new Request(`${BASE}/api/live`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ code: "guess" }),
      }),
    );

  it("doesn't let one client lock everyone out, but caps guesses overall even with a spoofed X-Forwarded-For", async () => {
    process.env.LIVE_ACCESS_CODE = "judges-2026";
    try {
      // No proxy header: 12 wrong guesses are rejected, not rate-limited (no shared 10-guess bucket).
      for (let i = 0; i < 12; i++) expect((await guess()).status).toBe(401);
      // A per-client limit still applies to a proxy-identified client…
      for (let i = 0; i < 10; i++) expect((await guess({ "x-forwarded-for": "203.0.113.7" })).status).toBe(401);
      expect((await guess({ "x-forwarded-for": "203.0.113.7" })).status).toBe(429);
      // …and rotating X-Forwarded-For doesn't buy unlimited guesses.
      let status = 0;
      for (let i = 0; i < 100 && status !== 429; i++) status = (await guess({ "x-forwarded-for": `198.51.100.${i}` })).status;
      expect(status).toBe(429);
    } finally {
      delete process.env.LIVE_ACCESS_CODE;
    }
  });
});
