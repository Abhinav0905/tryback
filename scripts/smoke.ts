// Post-deploy smoke test for a running TryBack server (local or deployed).
//
//   npm run smoke -- --base https://tryback-xyz.fly.dev
//   npm run smoke -- --base http://localhost:3000 --admin-token "$ADMIN_TOKEN"
//
// Walks the style/colour return end to end over HTTP with a SYNTHETIC drawn photo (never a
// person), then checks metrics, pages, static assets, security headers, the upload size cap and
// that "Reset demo" only clears this client's own returns. Everything it creates is reset at the
// end (viewer-scoped, so nobody else's data is touched).
//
// Credits: it reads /api/status first and ABORTS if a render from this client would go to the
// live Clothsy API, unless --allow-credits is passed. A replay/code-gated deployment answers
// "dev" for an anonymous client, so the default run costs 0 credits.
//
// Exit code 0 = all passed, 1 = a check failed, 2 = aborted before creating anything.

import { parseArgs } from "node:util";
import sharp from "sharp";

const HELP = `TryBack smoke test

Usage: npm run smoke -- --base <url> [options]

  --base <url>           Server to test (default http://localhost:3000)
  --allow-credits        Continue even if renders from this client would use the live
                         Clothsy API (spends up to MAX_RENDERS_PER_RETURN credits)
  --access-code <code>   Unlock live mode first (POST /api/live) to smoke the live path;
                         still aborts without --allow-credits
  --admin-token <token>  Also check the admin retention endpoint (or SMOKE_ADMIN_TOKEN)
  --check-rate-limit     Also confirm a 429: sends invalid POST /api/returns until limited.
                         Blocks new returns from your IP for ~10 minutes; run it last.
  --timeout <s>          Max seconds to wait for renders (default 150)
  -h, --help             Show this help
`;

interface Opts {
  base: string;
  allowCredits: boolean;
  accessCode: string | null;
  adminToken: string | null;
  checkRateLimit: boolean;
  timeoutMs: number;
}

function parseOpts(): Opts | null {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      "allow-credits": { type: "boolean", default: false },
      "access-code": { type: "string" },
      "admin-token": { type: "string" },
      "check-rate-limit": { type: "boolean", default: false },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) return null;
  const base = (values.base ?? process.env.SMOKE_BASE ?? "http://localhost:3000").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(base)) throw new Error(`--base must be an http(s) URL, got "${base}"`);
  const timeout = Number(values.timeout ?? 150);
  return {
    base,
    allowCredits: values["allow-credits"] ?? false,
    accessCode: values["access-code"] ?? null,
    adminToken: values["admin-token"] ?? process.env.SMOKE_ADMIN_TOKEN ?? null,
    checkRateLimit: values["check-rate-limit"] ?? false,
    timeoutMs: (Number.isFinite(timeout) && timeout > 0 ? timeout : 150) * 1000,
  };
}

/* ───────────── reporting ───────────── */

let failures = 0;
let warnings = 0;
function check(name: string, ok: boolean, detail = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
  return ok;
}
function warn(name: string, detail = ""): void {
  warnings += 1;
  console.log(`WARN  ${name}${detail ? `  (${detail})` : ""}`);
}
function info(msg: string): void {
  console.log(`      ${msg}`);
}

/* ───────────── HTTP ───────────── */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Res<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  bytes: number;
}

class Client {
  cookies = new Map<string, string>();
  constructor(
    readonly base: string,
    readonly label: string,
  ) {}

  private cookieHeader(): string | undefined {
    return this.cookies.size ? [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }

  private remember(headers: Headers): void {
    const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
    for (const c of list) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(c);
      if (!m) continue;
      if (/max-age=0/i.test(c) || m[2] === "") this.cookies.delete(m[1]!);
      else this.cookies.set(m[1]!, m[2]!);
    }
  }

  async req<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; raw?: boolean; timeoutMs?: number } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    let payload: BodyInit | undefined;
    if (body instanceof FormData || body instanceof Uint8Array || typeof body === "string") {
      payload = body as BodyInit;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    this.remember(res.headers);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? "";
    let data: unknown = buf;
    if (!opts.raw && ct.includes("application/json")) {
      try {
        data = JSON.parse(buf.toString("utf8"));
      } catch {
        data = null;
      }
    } else if (!opts.raw && ct.startsWith("text/")) {
      data = buf.toString("utf8");
    }
    return { status: res.status, headers: res.headers, data: data as T, bytes: buf.length };
  }
}

/* ───────────── fixtures (synthetic, no person) ───────────── */

async function syntheticPhoto(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600">
    <rect width="900" height="1600" fill="#cfc9c0"/>
    <ellipse cx="450" cy="230" rx="75" ry="95" fill="#9a8f84"/>
    <path d="M330 340 L570 340 L620 980 L280 980 Z" fill="#d4a017"/>
    <rect x="360" y="980" width="70" height="520" fill="#9a8f84"/><rect x="470" y="980" width="70" height="520" fill="#9a8f84"/>
    <text x="450" y="1560" font-size="40" text-anchor="middle" fill="#555">TryBack smoke test</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const kp = (x: number, y: number) => ({ x, y, visibility: 0.98 });
const KEYPOINTS = {
  nose: kp(450, 240), leftEye: kp(470, 215), rightEye: kp(430, 215), leftShoulder: kp(560, 360), rightShoulder: kp(340, 360),
  leftElbow: kp(600, 600), rightElbow: kp(300, 600), leftWrist: kp(610, 820), rightWrist: kp(290, 820),
  leftHip: kp(520, 820), rightHip: kp(380, 820), leftKnee: kp(505, 1150), rightKnee: kp(395, 1150),
  leftAnkle: kp(500, 1480), rightAnkle: kp(400, 1480),
};

interface Pom { hpsToHemCm: number; sleeveCm: number | null; halfChestCm: number }
interface Sku { id: string; image: string; poms: Record<string, Pom> }
interface Job {
  id: string; skuId: string; status: string; provider: string | null; creditCharged: boolean;
  resultUrl: string | null; gate: { verdict: string } | null; phase: string;
}
interface Ret {
  id: string; status: string; candidates: { skuId: string; size: string }[]; renders: Job[];
  photo: { url: string } | null; diagnosis: unknown; outcome: { type: string } | null;
}
interface AppStatus { mode: string; activeProvider: string; hasClothsyKey: boolean; maxRendersPerReturn: number; liveRendersToday: number; dailyLiveCap: number }

function photoForm(photo: Buffer, pom: Pom): FormData {
  const fd = new FormData();
  fd.append("photo", new Blob([new Uint8Array(photo)], { type: "image/jpeg" }), "smoke.jpg");
  fd.append(
    "payload",
    JSON.stringify({
      adultAttested: true,
      preflight: { ok: true, overridden: true, checks: [{ id: "full_body", ok: true, message: "synthetic smoke-test photo" }] },
      measurements: {
        keypoints: KEYPOINTS,
        calibration: {
          method: "garment", pxPerCm: 6.5, uncertaintyCm: 1.5, hpsY: 330, observedHemY: 330 + pom.hpsToHemCm * 6.5,
          observedSleeveEnd: null, centerX: 450, hemHalfWidthPx: 170, purchasedSize: "M", purchasedPom: pom,
          imageWidth: 900, imageHeight: 1600,
        },
        easeRatio: 1.02, hemCm: pom.hpsToHemCm, garmentMaskArea: 0.18, observedGarmentLab: [70, 5, 65],
      },
    }),
  );
  return fd;
}

const idle = (r: Ret) => r.renders.length > 0 && r.renders.every((j) => j.status !== "queued" && j.status !== "running");

async function waitIdle(c: Client, id: string, timeoutMs: number): Promise<Ret | null> {
  const t0 = Date.now();
  let last: Ret | null = null;
  while (Date.now() - t0 < timeoutMs) {
    const res = await c.req<{ return: Ret }>("GET", `/api/returns/${id}`);
    if (res.status === 200) {
      last = res.data.return;
      if (idle(last)) return last;
    }
    await sleep(1500);
  }
  return last;
}

function gateResult(verdict: string) {
  return {
    gate: {
      verdict,
      metrics: { colourDeltaE: 4, residueFraction: 0.02, silhouetteIoU: 0.7, identityDiff: 0.03, hemErrorCm: null, garmentCoverage: 0.8 },
      reasons: [],
      badge: null,
      computedAt: new Date().toISOString(),
      computeMs: 1,
    },
  };
}

/* ───────────── checks ───────────── */

function checkSecurityHeaders(label: string, h: Headers, https: boolean): void {
  const missing: string[] = [];
  const expect = (name: string, ok: (v: string) => boolean) => {
    const v = h.get(name);
    if (v === null || !ok(v)) missing.push(`${name}=${v ?? "∅"}`);
  };
  expect("x-frame-options", (v) => v.toUpperCase() === "SAMEORIGIN");
  expect("content-security-policy", (v) => v.includes("frame-ancestors 'self'"));
  expect("x-content-type-options", (v) => v === "nosniff");
  expect("referrer-policy", (v) => v.length > 0);
  expect("permissions-policy", (v) => /(^|,\s*)camera=\(self\)/.test(v));
  expect("x-robots-tag", (v) => v.includes("noindex"));
  if (https) expect("strict-transport-security", (v) => v.includes("max-age="));
  if (h.get("x-powered-by") !== null) missing.push(`x-powered-by=${h.get("x-powered-by")} (should be absent)`);
  check(`security headers on ${label}`, missing.length === 0, missing.join(", "));
}

async function checkStaticAssets(c: Client, html: string, firstSku: Sku | undefined): Promise<void> {
  const chunk = /["'](\/_next\/static\/[^"']+\.(?:js|css))["']/.exec(html)?.[1];
  if (chunk) {
    const r = await c.req("GET", chunk, undefined, { raw: true });
    check("Next static chunk served (.next/static copied)", r.status === 200 && r.bytes > 0, chunk);
  } else {
    check("Next static chunk referenced from /", false, "no /_next/static URL in the HTML");
  }
  const head = async (p: string) => {
    let r = await c.req("HEAD", p, undefined, { raw: true, timeoutMs: 60_000 });
    if (r.status === 405) r = await c.req("GET", p, undefined, { raw: true, timeoutMs: 120_000 });
    return r;
  };
  const wasm = await head("/mediapipe/vision_wasm_internal.wasm");
  check("MediaPipe WASM served from public/", wasm.status === 200, `content-type ${wasm.headers.get("content-type")}`);
  if (wasm.status === 200 && !(wasm.headers.get("content-type") ?? "").includes("application/wasm")) {
    warn("WASM content-type isn't application/wasm (MediaPipe falls back to a slower load)");
  }
  const model = await head("/models/pose_landmarker_full.task");
  check("pose model served from public/", model.status === 200);
  if (firstSku) {
    const img = await head(firstSku.image);
    check("catalogue image served from public/", img.status === 200, firstSku.image);
  }
}

async function main(): Promise<void> {
  const opts = parseOpts();
  if (!opts) {
    console.log(HELP);
    return;
  }
  const https = opts.base.startsWith("https://");
  const a = new Client(opts.base, "A");
  const b = new Client(opts.base, "B");
  console.log(`TryBack smoke test → ${opts.base}\n`);

  // 0. Which provider would a render from this client use? Abort before creating anything.
  if (opts.accessCode) {
    const unlock = await a.req<{ ok: boolean }>("POST", "/api/live", { code: opts.accessCode });
    if (!check("access code unlocks live mode", unlock.status === 200 && unlock.data.ok === true, `HTTP ${unlock.status}`)) {
      process.exitCode = 2;
      return;
    }
  }
  const status = await a.req<AppStatus>("GET", "/api/status");
  if (!check("GET /api/status", status.status === 200 && typeof status.data?.activeProvider === "string", `HTTP ${status.status}`)) {
    console.log("\nAborting: the server isn't answering /api/status.");
    process.exitCode = 2;
    return;
  }
  const s = status.data;
  info(`mode=${s.mode} activeProvider=${s.activeProvider} hasClothsyKey=${s.hasClothsyKey} live today=${s.liveRendersToday}/${s.dailyLiveCap}`);
  if (s.activeProvider === "clothsy") {
    if (!opts.allowCredits) {
      console.log(
        `\nABORT: renders from this client would use the LIVE Clothsy API and spend credits (up to ${s.maxRendersPerReturn}).\n` +
          "Re-run with --allow-credits to accept that, or test a replay / LIVE_ACCESS_CODE deployment (0 credits).",
      );
      process.exitCode = 2;
      return;
    }
    warn(`live mode: this run may spend up to ${s.maxRendersPerReturn} credits (--allow-credits)`);
  }

  try {
    // 1. Pages, headers, static files.
    const home = await a.req<string>("GET", "/");
    check("GET / → 200", home.status === 200);
    checkSecurityHeaders("/", home.headers, https);
    checkSecurityHeaders("/api/status", status.headers, https);
    for (const p of ["/r", "/merchant", "/bench", "/demo"]) {
      const r = await a.req("GET", p);
      check(`GET ${p} → 200`, r.status === 200, r.status === 200 ? "" : `HTTP ${r.status}`);
    }

    const catalog = await a.req<{ skus: Sku[] }>("GET", "/api/catalog");
    check("GET /api/catalog", catalog.status === 200 && (catalog.data.skus?.length ?? 0) > 0, `${catalog.data.skus?.length ?? 0} SKUs`);
    await checkStaticAssets(a, typeof home.data === "string" ? home.data : "", catalog.data.skus?.[0]);

    // 2. Style/colour return, end to end (client A).
    const order = await a.req<{ order: { lines: { skuId: string }[] }; skus: Sku[] }>("GET", "/api/orders/1042?email=demo");
    check("order 1042 lookup (email demo)", order.status === 200);
    const sku = order.data.skus?.find((x) => x.id === order.data.order?.lines?.[0]?.skuId);
    const pom = sku?.poms?.M;
    if (!sku || !pom) throw new Error("order 1042 didn't return its SKU with an M size chart");

    const created = await a.req<{ return: Ret }>("POST", "/api/returns", { orderId: "1042", email: "demo", lineIndex: 0 });
    check("create return → 201 + tb_viewer cookie", created.status === 201 && a.cookies.has("tb_viewer"), `HTTP ${created.status}`);
    const id = created.data.return?.id;
    if (!id) throw new Error("no return id");

    const reason = await a.req<{ return: Ret }>("POST", `/api/returns/${id}/reason`, { reason: "style_colour" });
    check("reason style_colour → speculative candidates", reason.status === 200 && reason.data.return.candidates.length >= 1);

    const photoBytes = await syntheticPhoto();
    const t0 = Date.now();
    const photo = await a.req<{ return: Ret }>("POST", `/api/returns/${id}/photo`, photoForm(photoBytes, pom));
    check("photo upload (synthetic) → renders scheduled", photo.status === 200 && photo.data.return.renders.length >= 1, `HTTP ${photo.status}`);

    let r = await waitIdle(a, id, opts.timeoutMs);
    const spec = r?.renders ?? [];
    check(
      "speculative renders finish",
      spec.length > 0 && spec.every((j) => j.status === "success"),
      `${spec.map((j) => `${j.skuId}:${j.status}/${j.provider}`).join(", ")} in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    if (!opts.allowCredits) {
      check("no credits spent (every render from the dev double or cache)", spec.every((j) => !j.creditCharged));
    }

    const form = await a.req<{ return: Ret }>("POST", `/api/returns/${id}/form`, { chips: ["colour_not_me"], freeText: "smoke test" });
    check("form → diagnosis + ranked candidates", form.status === 200 && Boolean(form.data.return?.diagnosis) && form.data.return.candidates.length > 0);
    r = (await waitIdle(a, id, opts.timeoutMs)) ?? r;
    if (!r) throw new Error("return vanished");

    const done = r.renders.filter((j) => j.status === "success" && j.resultUrl);
    const onScreen = done.find((j) => r!.candidates.some((cnd) => cnd.skuId === j.skuId));
    if (done[0]?.resultUrl) {
      const img = await a.req("GET", done[0].resultUrl, undefined, { raw: true });
      check(
        "render image served (immutable, labelled provider)",
        img.status === 200 && (img.headers.get("content-type") ?? "").startsWith("image/") && (img.headers.get("cache-control") ?? "").includes("immutable"),
        `provider ${img.headers.get("x-tryback-provider")}`,
      );
    }
    if (r.photo?.url) {
      const p = await a.req("GET", r.photo.url, undefined, { raw: true });
      check("photo served private, no-store", p.status === 200 && (p.headers.get("cache-control") ?? "").includes("no-store"));
    }
    if (onScreen) {
      const g = await a.req<{ return: Ret }>("POST", `/api/returns/${id}/renders/${onScreen.id}/gate`, gateResult("pass"));
      check("gate verdict stored", g.status === 200 && g.data.return.renders.find((j) => j.id === onScreen.id)?.gate?.verdict === "pass");
    } else {
      warn("no on-screen render to gate");
    }

    const target = r.candidates[0]!;
    const resolved = await a.req<{ return: Ret }>("POST", `/api/returns/${id}/resolve`, { type: "exchange", skuId: target.skuId, size: target.size });
    check("resolve as an exchange", resolved.status === 200 && resolved.data.return.outcome?.type === "exchange", `${target.skuId} ${target.size}`);

    const metrics = await a.req<{ totals?: { exchanges?: number } }>("GET", "/api/metrics?seeded=0");
    check("metrics count the exchange", metrics.status === 200 && (metrics.data.totals?.exchanges ?? 0) >= 1, `exchanges=${metrics.data.totals?.exchanges}`);
    const benchMine = await a.req<{ items: { returnId: string; photoUrl: string | null }[] }>("GET", "/api/bench");
    check("bench shows this browser its own renders", benchMine.status === 200 && benchMine.data.items.some((x) => x.returnId === id && x.photoUrl));
    const benchAnon = await new Client(opts.base, "anon").req<{ items: { returnId: string }[] }>("GET", "/api/bench");
    check("bench hides them from other browsers", benchAnon.status === 200 && !JSON.stringify(benchAnon.data).includes(id));
    const page = await a.req("GET", `/r/${id}`);
    check(`GET /r/<id> → 200`, page.status === 200);

    // 3. Upload cap (client B's fresh return): refused from the declared size, before buffering.
    const createdB = await b.req<{ return: Ret }>("POST", "/api/returns", { orderId: "1043", email: "demo", lineIndex: 0 });
    check("second browser creates its own return", createdB.status === 201 && b.cookies.has("tb_viewer"));
    const idB = createdB.data.return?.id;
    if (idB) {
      const big = new FormData();
      big.append("photo", new Blob([new Uint8Array(4_800_000)], { type: "image/jpeg" }), "big.jpg");
      big.append("payload", JSON.stringify({ adultAttested: true }));
      try {
        const tooBig = await b.req<{ error?: { code?: string } }>("POST", `/api/returns/${idB}/photo`, big, { timeoutMs: 60_000 });
        check("oversized photo → 413", tooBig.status === 413 && tooBig.data?.error?.code === "PHOTO_TOO_LARGE", `HTTP ${tooBig.status}`);
      } catch (err) {
        warn("oversized photo: connection closed before a response", err instanceof Error ? err.message : String(err));
      }
    }

    // 4. "Reset demo" without a token only clears the caller's own returns.
    const resetA = await a.req<{ ok: boolean; scope: string; deletedReturns: number }>("POST", "/api/admin/reset");
    check(
      "reset without a token is viewer-scoped",
      resetA.status === 200 && resetA.data.scope === "viewer" && resetA.data.deletedReturns >= 1,
      `deleted ${resetA.data.deletedReturns}`,
    );
    check("…my return is gone", (await a.req("GET", `/api/returns/${id}`)).status === 404);
    if (idB) check("…another browser's return is untouched", (await b.req("GET", `/api/returns/${idB}`)).status === 200);

    // 5. Admin endpoints refuse anonymous and wrong tokens.
    const badToken = await new Client(opts.base, "x").req("POST", "/api/admin/reset", undefined, { headers: { authorization: "Bearer smoke-test-wrong-token" } });
    check("reset with a wrong admin token → 401", badToken.status === 401);
    const anonRetention = await a.req("GET", "/api/admin/retention");
    check("retention admin endpoint needs the token", anonRetention.status === 401);
    if (opts.adminToken) {
      const ret = await a.req<{ policy: unknown; pins: number; lastReport: unknown; onDisk: unknown }>("GET", "/api/admin/retention", undefined, {
        headers: { authorization: `Bearer ${opts.adminToken}` },
      });
      check("retention status with ADMIN_TOKEN", ret.status === 200, `HTTP ${ret.status}`);
      if (ret.status === 200) info(`retention: ${JSON.stringify({ policy: ret.data.policy, pins: ret.data.pins, onDisk: ret.data.onDisk })}`);
    }

    // 6. Optional: a real 429.
    if (opts.checkRateLimit) {
      let limited: Res | null = null;
      for (let i = 0; i < 60 && !limited; i++) {
        const res = await b.req("POST", "/api/returns", {});
        if (res.status === 429) limited = res;
      }
      check("rate limit → 429 with Retry-After", limited !== null && Number(limited.headers.get("retry-after")) > 0, limited ? `Retry-After ${limited.headers.get("retry-after")}` : "no 429 after 60 requests");
    }
  } finally {
    // Clean up whatever this run created (viewer-scoped: only these two browsers' returns).
    for (const c of [a, b]) {
      if (!c.cookies.has("tb_viewer")) continue;
      await c.req("POST", "/api/admin/reset").catch(() => undefined);
    }
  }

  console.log(failures ? `\n${failures} FAILED${warnings ? `, ${warnings} warning(s)` : ""}` : `\nALL PASSED${warnings ? ` (${warnings} warning(s))` : ""}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFAIL  ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
