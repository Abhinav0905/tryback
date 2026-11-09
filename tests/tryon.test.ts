// Try-on providers: Clothsy REST client (mocked fetch, fake clock), dev double,
// garment preparation, and the render cache. No network, no credits.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate this file's JSON store from other test files running in parallel.
const TEST_DATA_DIR = vi.hoisted(() => {
  const dir = `.data-test/tryon-${process.pid}-${Date.now()}`;
  process.env.TRYBACK_DATA_DIR = dir;
  return dir;
});

import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { SKUS } from "@/lib/catalog";
import { mutate, readDb, readRender, renderBlobName, utcDay } from "@/lib/store";
import type { Sku } from "@/lib/types";
import {
  CLOTHSY_LIMITS,
  ClothsyProvider,
  SlidingWindowLimiter,
  TokenBucket,
  REPLAY_HEADER_CANDIDATES,
  clothsyAccount,
  createClothsyLimiter,
  creditsFromAccount,
  detectStartReplay,
  fetchClothsyAccount,
  headersOfInterest,
  parseClothsyAccount,
  parseRetryAfter,
  type ClothsyObservation,
  sharedClothsyLimiter,
  sleepWithSignal,
  storeImageIdCache,
} from "@/lib/tryon/clothsy";
import { DevDoubleProvider, INSET_TOP_FRAC, composeSimulatedRender, garmentDominantColour } from "@/lib/tryon/devDouble";
import { clearGarmentCache, encodeUnderLimit, loadGarmentImage } from "@/lib/tryon/garment";
import {
  API_VERSION,
  activeProviderName,
  decideProvider,
  liveRendersToday,
  renderCacheKey,
  renderResultUrl,
  renderWithCache,
  resolveProvider,
  setProviderOverrides,
} from "@/lib/tryon";
import { TryOnError, isTryOnError, type TryOnInput, type TryOnOutput, type TryOnProvider } from "@/lib/tryon/types";

afterAll(async () => {
  await fs.rm(path.resolve(TEST_DATA_DIR), { recursive: true, force: true });
});

/* ───────────────────────── helpers ───────────────────────── */

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let seq = 0;
/** A unique small JPEG per call (unique hash → no cross-test cache hits). */
async function uniqueJpeg(): Promise<Buffer> {
  seq++;
  return sharp({
    create: {
      width: 48 + seq,
      height: 64 + seq,
      channels: 3,
      background: { r: (seq * 37) % 256, g: (seq * 91) % 256, b: (seq * 53) % 256 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function makeInput(key = `tb_${"a".repeat(20)}${seq}`): Promise<TryOnInput> {
  const personBytes = await uniqueJpeg();
  const garmentBytes = await uniqueJpeg();
  return {
    personBytes,
    personHash: sha256(personBytes),
    garmentBytes,
    garmentHash: sha256(garmentBytes),
    title: "Women's knee-length wrap dress, V-neck, long sleeves, tie waist, fitted, emerald",
    idempotencyKey: key,
  };
}

async function expectTryOnError(p: Promise<unknown>, code: string): Promise<TryOnError> {
  try {
    await p;
  } catch (err) {
    expect(isTryOnError(err)).toBe(true);
    expect((err as TryOnError).code).toBe(code);
    return err as TryOnError;
  }
  throw new Error(`expected TryOnError ${code}, but it resolved`);
}

function fakeClock(start = Date.now()) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const BASE = "https://api.clothsy.test/api/v1";
const CDN = "https://cdn.clothsy.test";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Recorded {
  route: string;
  url: string;
  headers: Headers;
  json: Record<string, unknown> | null;
  form: FormData | null;
}

type Reply = () => Response | Promise<Response>;

/** In-memory Clothsy: sensible defaults, plus per-route queued overrides. */
class MockClothsy {
  calls: Recorded[] = [];
  pendingPolls = 1;
  pollStatus: "success" | "failed" | "pending" = "success";
  failedMessage = "Try-on failed: garment not detected";
  resultBytes: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  onPoll: ((n: number) => void) | null = null;
  private queues = new Map<string, Array<Reply | Error>>();
  private uploads = 0;
  private polls = new Map<string, number>();

  queue(route: string, ...items: Array<Reply | Error>): this {
    this.queues.set(route, [...(this.queues.get(route) ?? []), ...items]);
    return this;
  }

  count(route: string): number {
    return this.calls.filter((c) => c.route === route).length;
  }

  of(route: string): Recorded[] {
    return this.calls.filter((c) => c.route === route);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    let route: string;
    if (url.startsWith(BASE)) {
      const p = url.slice(BASE.length).replace(/^\/tryons\/[^/]+$/, "/tryons/:id");
      route = `${method} ${p}`;
    } else if (url.startsWith(CDN)) route = `${method} cdn`;
    else route = `${method} ${url}`;

    const body = init?.body;
    this.calls.push({
      route,
      url,
      headers: new Headers(init?.headers),
      json: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : null,
      form: body instanceof FormData ? body : null,
    });

    const q = this.queues.get(route);
    if (q && q.length) {
      const next = q.shift()!;
      if (next instanceof Error) throw next;
      return next();
    }
    return this.defaultReply(route, url);
  };

  private defaultReply(route: string, url: string): Response {
    switch (route) {
      case "POST /images":
        this.uploads++;
        return json(201, { id: `img_${this.uploads}`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      case "POST /tryons":
        return json(202, { id: "try_1", status: "pending", pollUrl: `${BASE}/tryons/try_1` });
      case "GET /tryons/:id": {
        const id = url.split("/").pop()!;
        const n = (this.polls.get(id) ?? 0) + 1;
        this.polls.set(id, n);
        this.onPoll?.(n);
        if (this.pollStatus === "pending" || n <= this.pendingPolls) {
          return json(200, { id, status: "pending", resultUrl: null });
        }
        if (this.pollStatus === "failed") {
          return json(200, { id, status: "failed", resultUrl: null, message: this.failedMessage });
        }
        return json(200, { id, status: "success", resultUrl: `${CDN}/r/${id}.jpg` });
      }
      case "GET cdn":
        return new Response(new Uint8Array(this.resultBytes), { status: 200, headers: { "content-type": "image/jpeg" } });
      default:
        return json(404, { error: `no route ${route}`, code: "NOT_FOUND" });
    }
  }
}

function makeProvider(api: MockClothsy, clock = fakeClock()) {
  const provider = new ClothsyProvider({
    apiKey: "test_key",
    baseUrl: BASE,
    fetchImpl: api.fetch,
    sleep: clock.sleep,
    now: clock.now,
    limiter: createClothsyLimiter({ startsPerMinute: 1000, uploadsPerMinute: 1000, now: clock.now }),
  });
  return { provider, clock };
}

/* ───────────────────────── Clothsy ───────────────────────── */

describe("ClothsyProvider", () => {
  it("happy path: uploads via multipart `file`, starts with consent + Idempotency-Key, polls, downloads without auth", async () => {
    const api = new MockClothsy();
    const { provider, clock } = makeProvider(api);
    const input = await makeInput("tb_happy_path_key_0001");

    const out = await provider.render(input);

    // uploads
    const uploads = api.of("POST /images");
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.headers.get("authorization")).toBe("Bearer test_key");
      const file = u.form?.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect((file as Blob).type).toBe("image/jpeg");
    }
    const sizes = uploads.map((u) => (u.form!.get("file") as Blob).size).sort((a, b) => a - b);
    expect(sizes).toEqual([input.personBytes.length, input.garmentBytes.length].sort((a, b) => a - b));

    // start
    const [start] = api.of("POST /tryons");
    expect(start!.headers.get("idempotency-key")).toBe("tb_happy_path_key_0001");
    expect(start!.headers.get("content-type")).toBe("application/json");
    expect(start!.headers.get("authorization")).toBe("Bearer test_key");
    expect(start!.json).toMatchObject({ title: input.title, consent: true });
    expect(new Set([start!.json!.personImageId, start!.json!.garmentImageId])).toEqual(new Set(["img_1", "img_2"]));
    expect(Object.keys(start!.json!).sort()).toEqual(["consent", "garmentImageId", "personImageId", "title"]);

    // poll + download
    expect(api.count("GET /tryons/:id")).toBe(2);
    const [download] = api.of("GET cdn");
    expect(download!.headers.get("authorization")).toBeNull();
    expect(clock.sleeps).toEqual([2500, 2500]);

    expect(out).toMatchObject({
      contentType: "image/jpeg",
      provider: "clothsy",
      externalId: "try_1",
      creditCharged: true,
      latencyMs: 5000,
    });
    expect(out.bytes.equals(api.resultBytes)).toBe(true);

    // image ids cached by sha256 in db.imageIds and reused
    const db = await readDb();
    expect(db.imageIds[input.personHash]?.id).toMatch(/^img_/);
    expect(db.imageIds[input.garmentHash]?.id).toMatch(/^img_/);

    await provider.render({ ...input, idempotencyKey: "tb_happy_path_key_0002" });
    expect(api.count("POST /images")).toBe(2);
  });

  it("dedupes concurrent uploads of the same photo", async () => {
    const api = new MockClothsy();
    const { provider } = makeProvider(api);
    const input = await makeInput("tb_concurrent_0001");
    await Promise.all([
      provider.render(input),
      provider.render({ ...input, idempotencyKey: "tb_concurrent_0002" }),
    ]);
    expect(api.count("POST /images")).toBe(2); // person + garment, once each
    expect(api.count("POST /tryons")).toBe(2);
  });

  it("retries 429 with the SAME Idempotency-Key, honouring Retry-After, then 503 with backoff", async () => {
    const api = new MockClothsy().queue(
      "POST /tryons",
      () => json(429, { error: "Too many requests", code: "RATE_LIMITED" }, { "retry-after": "7" }),
      () => json(503, { error: "Busy", code: "UNAVAILABLE" }),
    );
    const { provider, clock } = makeProvider(api);
    const input = await makeInput("tb_retry_same_key_01");

    const out = await provider.render(input);

    const starts = api.of("POST /tryons");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((s) => s.headers.get("idempotency-key")))).toEqual(new Set(["tb_retry_same_key_01"]));
    expect(clock.sleeps.slice(0, 2)).toEqual([7000, 2000]);
    expect(out.creditCharged).toBe(true);
  });

  it("does not retry 422 rejections", async () => {
    const api = new MockClothsy().queue("POST /tryons", () =>
      json(422, { error: "No person detected", code: "PERSON_PHOTO_REJECTED" }),
    );
    const { provider, clock } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput()), "PERSON_PHOTO_REJECTED");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(422);
    expect(err.message).toContain("No person detected");
    expect(api.count("POST /tryons")).toBe(1);
    expect(api.count("GET /tryons/:id")).toBe(0);
    expect(clock.sleeps).toEqual([]);
  });

  it.each([
    [401, "INVALID_API_KEY"],
    [402, "INSUFFICIENT_CREDITS"],
    [403, "CONSENT_REQUIRED"],
    [413, "IMAGE_TOO_LARGE"],
  ])("does not retry %i %s", async (status, code) => {
    const api = new MockClothsy().queue("POST /tryons", () => json(status, { error: code, code }));
    const { provider } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput()), code);
    expect(err.retryable).toBe(false);
    expect(api.count("POST /tryons")).toBe(1);
  });

  it("maps status:failed to RENDER_FAILED (not retryable) and never downloads", async () => {
    const api = new MockClothsy();
    api.pollStatus = "failed";
    const { provider } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput()), "RENDER_FAILED");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("Try-on failed: garment not detected");
    expect(api.count("GET cdn")).toBe(0);
  });

  it("on INVALID_IMAGE_ID drops cached ids, re-uploads and starts once more", async () => {
    const api = new MockClothsy().queue("POST /tryons", () =>
      json(400, { error: "Unknown image id", code: "INVALID_IMAGE_ID" }),
    );
    const { provider } = makeProvider(api);
    const input = await makeInput("tb_invalid_image_id_1");
    const future = new Date(Date.now() + 10 * 3_600_000).toISOString();
    await storeImageIdCache.set(input.personHash, { id: "img_stale_person", expiresAt: future });
    await storeImageIdCache.set(input.garmentHash, { id: "img_stale_garment", expiresAt: future });

    const out = await provider.render(input);

    const starts = api.of("POST /tryons");
    expect(starts).toHaveLength(2);
    expect(starts[0]!.json).toMatchObject({ personImageId: "img_stale_person", garmentImageId: "img_stale_garment" });
    expect(starts[1]!.json!.personImageId).not.toBe("img_stale_person");
    expect(starts[1]!.json!.garmentImageId).not.toBe("img_stale_garment");
    expect(starts[0]!.headers.get("idempotency-key")).toBe("tb_invalid_image_id_1");
    // `_u1`, never `_r1`: the orchestrator's next attempt key must not replay this start.
    expect(starts[1]!.headers.get("idempotency-key")).toBe("tb_invalid_image_id_1_u1");
    expect(api.count("POST /images")).toBe(2);
    expect(out.externalId).toBe("try_1");

    const db = await readDb();
    expect(db.imageIds[input.personHash]?.id).not.toBe("img_stale_person");
    expect(db.imageIds[input.garmentHash]?.id).not.toBe("img_stale_garment");
  });

  it("re-uploads only once: a second INVALID_IMAGE_ID fails", async () => {
    const bad = () => json(400, { error: "Unknown image id", code: "INVALID_IMAGE_ID" });
    const api = new MockClothsy().queue("POST /tryons", bad, bad);
    const { provider } = makeProvider(api);
    await expectTryOnError(provider.render(await makeInput()), "INVALID_IMAGE_ID");
    expect(api.count("POST /tryons")).toBe(2);
  });

  it("reuses cached image ids only until expiresAt − 1 h", async () => {
    const api = new MockClothsy();
    const { provider } = makeProvider(api);
    const input = await makeInput();
    const soon = new Date(Date.now() + 30 * 60_000).toISOString(); // inside the 1 h margin
    await storeImageIdCache.set(input.personHash, { id: "img_expiring", expiresAt: soon });
    await provider.render(input);
    expect(api.count("POST /images")).toBe(2);
    expect(api.of("POST /tryons")[0]!.json!.personImageId).not.toBe("img_expiring");
  });

  it("gives up after 4 attempts on 500, backing off 1 s, 2 s, 4 s", async () => {
    const err500 = () => json(500, { error: "boom", code: "INTERNAL_ERROR" });
    const api = new MockClothsy().queue("POST /tryons", err500, err500, err500, err500);
    const { provider, clock } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput()), "INTERNAL_ERROR");
    expect(err.retryable).toBe(true);
    expect(api.count("POST /tryons")).toBe(4);
    expect(clock.sleeps).toEqual([1000, 2000, 4000]);
  });

  it("retries network errors (502 START_FAILED and a dropped connection)", async () => {
    const api = new MockClothsy()
      .queue("POST /images", new TypeError("fetch failed"))
      .queue("POST /tryons", () => json(502, { error: "upstream", code: "START_FAILED" }));
    const { provider } = makeProvider(api);
    const out = await provider.render(await makeInput());
    expect(out.provider).toBe("clothsy");
    expect(api.count("POST /images")).toBe(3);
    expect(api.count("POST /tryons")).toBe(2);
  });

  it("times out with TIMEOUT after 150 s of pending polls", async () => {
    const api = new MockClothsy();
    api.pollStatus = "pending";
    const { provider, clock } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput()), "TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(api.count("GET /tryons/:id")).toBe(60);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(150_000);
  });

  it("bounds poll retries by the 150 s budget (Retry-After can't stretch a render past it)", async () => {
    const api = new MockClothsy();
    api.pollStatus = "pending";
    const { provider, clock } = makeProvider(api);
    const t0 = clock.now();
    // From ~148 s on, every poll answers 503 with Retry-After: 60.
    api.onPoll = (n) => {
      if (n >= 59) api.queue("GET /tryons/:id", () => json(503, { error: "busy", code: "UNAVAILABLE" }, { "retry-after": "60" }));
    };
    const err = await expectTryOnError(provider.render(await makeInput()), "TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(clock.now() - t0).toBeLessThanOrEqual(150_000 + CLOTHSY_LIMITS.pollGraceMs);
  });

  it("supports AbortSignal mid-poll", async () => {
    const api = new MockClothsy();
    api.pollStatus = "pending";
    const ctrl = new AbortController();
    api.onPoll = (n) => {
      if (n === 2) ctrl.abort();
    };
    const { provider } = makeProvider(api);
    await expectTryOnError(provider.render(await makeInput(), ctrl.signal), "ABORTED");
    expect(api.count("GET /tryons/:id")).toBe(2);
  });

  it("validates input locally before any request", async () => {
    const api = new MockClothsy();
    const { provider } = makeProvider(api);
    const input = await makeInput();
    await expectTryOnError(provider.render({ ...input, idempotencyKey: "short" }), "BAD_INPUT");
    await expectTryOnError(provider.render({ ...input, personBytes: Buffer.from("GIF89a....") }), "UNSUPPORTED_IMAGE");
    await expectTryOnError(
      provider.render({ ...input, garmentBytes: Buffer.concat([input.garmentBytes, Buffer.alloc(4 * 1024 * 1024)]) }),
      "IMAGE_TOO_LARGE",
    );
    expect(api.calls).toHaveLength(0);
  });

  it("reports NO_API_KEY when no key is configured", async () => {
    vi.stubEnv("CLOTHSY_API_KEY", "");
    const api = new MockClothsy();
    const provider = new ClothsyProvider({ baseUrl: BASE, fetchImpl: api.fetch });
    await expectTryOnError(provider.render(await makeInput()), "NO_API_KEY");
    expect(api.calls).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("marks a first-attempt idempotent replay as not charged (replay header, if the API sends one)", async () => {
    const api = new MockClothsy().queue("POST /tryons", () =>
      json(202, { id: "try_1", status: "pending" }, { "idempotent-replayed": "true" }),
    );
    const { provider } = makeProvider(api);
    const out = await provider.render(await makeInput());
    expect(out.creditCharged).toBe(false);
    expect(out.replayed).toBe(true);
  });

  it("treats status:success on the first start as a free replay of a finished try-on (documented)", async () => {
    // Docs: a new try-on is always "pending" on POST /tryons; a reused key returns the earlier
    // try-on's current status (SDK create() doc comment). No header needed.
    const api = new MockClothsy().queue("POST /tryons", () =>
      json(200, { id: "try_9", status: "success", resultUrl: `${CDN}/r/try_9.jpg` }),
    );
    const { provider } = makeProvider(api);
    const out = await provider.render(await makeInput("tb_replay_status_0001"));
    expect(out).toMatchObject({ creditCharged: false, replayed: true, externalId: "try_9" });
    expect(api.count("GET /tryons/:id")).toBe(0); // settled on start: no polling
    expect(api.count("GET cdn")).toBe(1);
  });

  it("a replayed start that says success without resultUrl fetches it with one immediate GET (seen live)", async () => {
    // Live probe 2026-11-09: POST /tryons with a reused key → 202 {id, status:"success", pollUrl}, no resultUrl.
    const api = new MockClothsy()
      .queue("POST /tryons", () => json(202, { id: "try_7", status: "success", pollUrl: "/api/v1/tryons/try_7" }))
      .queue("GET /tryons/:id", () => json(200, { id: "try_7", status: "success", resultUrl: `${CDN}/r/try_7.jpg` }));
    const { provider } = makeProvider(api);
    const out = await provider.render(await makeInput("tb_replay_no_url_001"));
    expect(out).toMatchObject({ creditCharged: false, replayed: true, externalId: "try_7" });
    expect(api.count("GET /tryons/:id")).toBe(1);
    expect(api.count("GET cdn")).toBe(1);
  });

  it("charges a fresh pending start, and a success that only arrives on a retry of this same call", async () => {
    const fresh = new MockClothsy();
    const a = await makeProvider(fresh).provider.render(await makeInput("tb_fresh_start_0001"));
    expect(a).toMatchObject({ creditCharged: true, replayed: false });

    // First attempt dropped after reaching the server; the retry returns our own finished try-on.
    const retried = new MockClothsy().queue(
      "POST /tryons",
      new TypeError("fetch failed"),
      () => json(200, { id: "try_2", status: "success", resultUrl: `${CDN}/r/try_2.jpg` }),
    );
    const b = await makeProvider(retried).provider.render(await makeInput("tb_retry_success_01"));
    expect(b).toMatchObject({ creditCharged: true, replayed: false });
  });

  it("a replay whose result URL expired is REPLAY_RESULT_EXPIRED (the orchestrator then moves to a new key)", async () => {
    const api = new MockClothsy()
      .queue("POST /tryons", () => json(200, { id: "try_old", status: "success", resultUrl: `${CDN}/r/try_old.jpg` }))
      .queue("GET cdn", () => new Response("gone", { status: 404 }));
    const { provider } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput("tb_replay_expired_01")), "REPLAY_RESULT_EXPIRED");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(404);
    // A download failure on a fresh (charged) try-on keeps its code: re-sending the key replays it for free.
    const fresh = new MockClothsy().queue("GET cdn", () => new Response("gone", { status: 404 }));
    await expectTryOnError(makeProvider(fresh).provider.render(await makeInput("tb_fresh_dl_fail_01")), "DOWNLOAD_FAILED");
  });

  it("a replayed FAILED try-on is RENDER_FAILED (the orchestrator then moves to a new key)", async () => {
    const api = new MockClothsy().queue("POST /tryons", () =>
      json(200, { id: "try_3", status: "failed", resultUrl: null, message: "That try-on did not finish." }),
    );
    const { provider } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput()), "RENDER_FAILED");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("did not finish");
  });

  it("maps 404 NOT_FOUND and 405 METHOD_NOT_ALLOWED to non-retryable errors", async () => {
    const api = new MockClothsy().queue("GET /tryons/:id", () => json(404, { error: "No try-on", code: "NOT_FOUND" }));
    const { provider } = makeProvider(api);
    const err = await expectTryOnError(provider.render(await makeInput()), "NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(api.count("GET /tryons/:id")).toBe(1);

    const api2 = new MockClothsy().queue("POST /tryons", () => new Response("", { status: 405 }));
    const err2 = await expectTryOnError(makeProvider(api2).provider.render(await makeInput()), "METHOD_NOT_ALLOWED");
    expect(err2.retryable).toBe(false);
    expect(api2.count("POST /tryons")).toBe(1);
  });

  it("reports starts, polls and downloads to an observer, with headers of interest only", async () => {
    const api = new MockClothsy().queue("POST /tryons", () =>
      json(202, { id: "try_1", status: "pending", pollUrl: "/api/v1/tryons/try_1" }, {
        "x-request-id": "req_123",
        "set-cookie": "secret=1",
        "x-ratelimit-remaining": "11",
      }),
    );
    const clock = fakeClock();
    const events: ClothsyObservation[] = [];
    const provider = new ClothsyProvider({
      apiKey: "test_key",
      baseUrl: BASE,
      fetchImpl: api.fetch,
      sleep: clock.sleep,
      now: clock.now,
      limiter: createClothsyLimiter({ startsPerMinute: 1000, uploadsPerMinute: 1000, now: clock.now }),
      onEvent: (e) => {
        events.push(e);
        throw new Error("observers must not break renders");
      },
    });
    const out = await provider.render(await makeInput("tb_observed_key_0001"));
    expect(out.creditCharged).toBe(true);
    const start = events.find((e) => e.kind === "start");
    expect(start).toMatchObject({
      kind: "start",
      httpStatus: 202,
      attempt: 1,
      idempotencyKey: "tb_observed_key_0001",
      tryOnId: "try_1",
      bodyStatus: "pending",
      pollUrl: "/api/v1/tryons/try_1",
      replayed: false,
      replaySignal: null,
    });
    expect(start && start.kind === "start" ? start.headers : {}).toEqual({
      "content-type": "application/json",
      "x-ratelimit-remaining": "11",
      "x-request-id": "req_123",
    });
    expect(events.filter((e) => e.kind === "poll").map((e) => (e.kind === "poll" ? [e.tryOnId, e.n, e.bodyStatus] : null))).toEqual([
      ["try_1", 1, "pending"],
      ["try_1", 2, "success"],
    ]);
    expect(events.find((e) => e.kind === "download")).toMatchObject({
      kind: "download",
      tryOnId: "try_1",
      httpStatus: 200,
      contentTypeHeader: "image/jpeg",
      sniffedType: "image/jpeg",
    });
  });

  it("keeps result bytes exactly as downloaded (preserves the XMP AI label)", async () => {
    const api = new MockClothsy();
    api.resultBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      Buffer.from("<x:xmpmeta>compositeWithTrainedAlgorithmicMedia</x:xmpmeta>", "latin1"),
    ]);
    const { provider } = makeProvider(api);
    const out = await provider.render(await makeInput());
    expect(out.bytes.equals(api.resultBytes)).toBe(true);
  });
});

describe("replay detection and headers", () => {
  it("only a first attempt can be a replay; status success beats headers; header names are candidates", () => {
    const h = (o: Record<string, string> = {}) => new Headers(o);
    expect(detectStartReplay({ attempt: 1, headers: h(), bodyStatus: "pending" })).toEqual({ replayed: false, signal: null });
    expect(detectStartReplay({ attempt: 1, headers: h(), bodyStatus: "SUCCESS" })).toEqual({ replayed: true, signal: "status" });
    expect(detectStartReplay({ attempt: 2, headers: h(), bodyStatus: "success" })).toEqual({ replayed: false, signal: null });
    for (const name of REPLAY_HEADER_CANDIDATES) {
      expect(detectStartReplay({ attempt: 1, headers: h({ [name]: " True " }), bodyStatus: "pending" })).toEqual({
        replayed: true,
        signal: "header",
      });
    }
    expect(detectStartReplay({ attempt: 1, headers: h({ "idempotent-replayed": "false" }), bodyStatus: null }).replayed).toBe(false);
  });

  it("headersOfInterest keeps idempotency/request/rate-limit headers and drops cookies and auth", () => {
    const out = headersOfInterest(
      new Headers({
        "Idempotency-Key": "k",
        "X-Request-Id": "r",
        "RateLimit-Remaining": "3",
        "Retry-After": "2",
        "Set-Cookie": "a=b",
        "WWW-Authenticate": "Bearer",
        Server: "x",
      }),
    );
    expect(out).toEqual({ "idempotency-key": "k", "x-request-id": "r", "ratelimit-remaining": "3", "retry-after": "2" });
  });
});

describe("rate limiting", () => {
  it("token bucket allows 10 starts, then waits ~6 s for the 11th", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(10, 60_000, clock.now);
    for (let i = 0; i < 10; i++) await bucket.take(clock.sleep);
    expect(clock.sleeps).toEqual([]);
    await bucket.take(clock.sleep);
    expect(clock.sleeps).toEqual([6000]);
  });

  it("sliding window: never more than 10 starts in any 60 s, even after a burst", async () => {
    const clock = fakeClock(0);
    const limiter = new SlidingWindowLimiter(10, 60_000, clock.now);
    const at: number[] = [];
    for (let i = 0; i < 40; i++) {
      await limiter.take(clock.sleep);
      at.push(clock.now());
    }
    let max = 0;
    for (const t of at) max = Math.max(max, at.filter((u) => u >= t && u < t + 60_000).length);
    expect(max).toBe(10);
    // The old token bucket (full bucket + steady refill) let 19 through in one minute.
    const bucketClock = fakeClock(0);
    const bucket = new TokenBucket(10, 60_000, bucketClock.now);
    const bt: number[] = [];
    for (let i = 0; i < 40; i++) {
      await bucket.take(bucketClock.sleep);
      bt.push(bucketClock.now());
    }
    expect(Math.max(...bt.map((t) => bt.filter((u) => u >= t && u < t + 60_000).length))).toBeGreaterThan(12);
  });

  it("shared limiter is process-wide on globalThis: 10 starts/min, 25 uploads/min, 50 polls/min", () => {
    const a = sharedClothsyLimiter();
    expect(sharedClothsyLimiter()).toBe(a);
    expect((globalThis as Record<string, unknown>).__trybackClothsyLimiter).toBe(a);
    expect(a.starts.capacity).toBe(10);
    expect(a.uploads.capacity).toBe(25);
    expect(a.polls?.capacity).toBe(50);
    expect(CLOTHSY_LIMITS.pollsPerMinute).toBeLessThan(60); // documented account limit
  });

  it("polls consume poll slots (several renders in flight stay under the account's 60 polls/min)", async () => {
    const api = new MockClothsy();
    api.pendingPolls = 3; // 4 polls per render
    const clock = fakeClock(0);
    const limiter = createClothsyLimiter({ startsPerMinute: 1000, uploadsPerMinute: 1000, pollsPerMinute: 2, now: clock.now });
    const provider = new ClothsyProvider({
      apiKey: "k",
      baseUrl: BASE,
      fetchImpl: api.fetch,
      sleep: clock.sleep,
      now: clock.now,
      limiter,
    });
    await provider.render(await makeInput("tb_poll_limit_0001"));
    expect(api.count("GET /tryons/:id")).toBe(4);
    // Polls 3 and 4 had to wait for the 60 s window to free a slot.
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
  });

  it("works with a limiter that has no poll bucket (built before polls were limited)", async () => {
    const api = new MockClothsy();
    const clock = fakeClock();
    const full = createClothsyLimiter({ startsPerMinute: 1000, uploadsPerMinute: 1000, now: clock.now });
    const provider = new ClothsyProvider({
      apiKey: "k",
      baseUrl: BASE,
      fetchImpl: api.fetch,
      sleep: clock.sleep,
      now: clock.now,
      limiter: { starts: full.starts, uploads: full.uploads },
    });
    const out = await provider.render(await makeInput("tb_no_poll_bucket_1"));
    expect(out.provider).toBe("clothsy");
  });

  it("start requests consume start tokens", async () => {
    const api = new MockClothsy();
    const clock = fakeClock();
    const limiter = createClothsyLimiter({ startsPerMinute: 1, uploadsPerMinute: 100, now: clock.now });
    const provider = new ClothsyProvider({
      apiKey: "k",
      baseUrl: BASE,
      fetchImpl: api.fetch,
      sleep: clock.sleep,
      now: clock.now,
      limiter,
    });
    const input = await makeInput("tb_bucket_key_0001");
    await provider.render(input);
    await provider.render({ ...input, idempotencyKey: "tb_bucket_key_0002" });
    // second start had to wait a full minute for the single token to refill (minus poll time)
    expect(clock.sleeps).toContain(60_000 - 5000);
  });

  it("abortable sleeps don't leak listeners on a long-lived signal", async () => {
    const ctrl = new AbortController();
    const clock = fakeClock();
    for (let i = 0; i < 50; i++) await sleepWithSignal(clock.sleep, 2500, ctrl.signal);
    const bucket = new TokenBucket(100, 60_000, clock.now);
    for (let i = 0; i < 20; i++) await bucket.take(clock.sleep, ctrl.signal);
    expect(getEventListeners(ctrl.signal, "abort")).toHaveLength(0);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeNull();
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
  });
});

describe("clothsyAccount", () => {
  it("returns the /account body with auth, null on failure or without a key", async () => {
    const api = new MockClothsy();
    const seen: Headers[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers));
      return String(input).endsWith("/account") ? json(200, { credits: 17 }) : api.fetch(input, init);
    };
    const body = await clothsyAccount({ apiKey: "k1", baseUrl: BASE, fetchImpl });
    expect(body).toEqual({ credits: 17 });
    expect(creditsFromAccount(body)).toBe(17);
    expect(creditsFromAccount({ data: { credits: { remaining: 3 } } })).toBe(3);
    expect(creditsFromAccount("nope")).toBeNull();
    expect(seen[0]!.get("authorization")).toBe("Bearer k1");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing: typeof fetch = async () => json(401, { error: "bad key", code: "INVALID_API_KEY" });
    expect(await clothsyAccount({ apiKey: "k1", baseUrl: BASE, fetchImpl: failing })).toBeNull();
    const throwing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await clothsyAccount({ apiKey: "k1", baseUrl: BASE, fetchImpl: throwing })).toBeNull();
    warn.mockRestore();

    vi.stubEnv("CLOTHSY_API_KEY", "");
    expect(await clothsyAccount({ baseUrl: BASE, fetchImpl })).toBeNull();
    vi.unstubAllEnvs();
  });

  it("parses the documented { credits, scope } body (and tolerates numeric strings)", () => {
    expect(parseClothsyAccount({ credits: 42, scope: "account" })).toEqual({ credits: 42, scope: "account" });
    expect(parseClothsyAccount({ credits: 3, scope: "key" })).toEqual({ credits: 3, scope: "key" });
    expect(parseClothsyAccount({ credits: "7" })).toEqual({ credits: 7, scope: null });
    expect(parseClothsyAccount({ balance: { remaining: 5 } })).toEqual({ credits: 5, scope: null });
    expect(parseClothsyAccount(null)).toEqual({ credits: null, scope: null });
    expect(parseClothsyAccount({ scope: 9 })).toEqual({ credits: null, scope: null });
  });

  it("fetchClothsyAccount returns the exact outcome without throwing", async () => {
    const ok = await fetchClothsyAccount({
      apiKey: "k1",
      baseUrl: BASE,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(`${BASE}/account`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k1");
        return json(200, { credits: 20, scope: "account" });
      },
    });
    expect(ok).toMatchObject({ ok: true, httpStatus: 200, credits: 20, scope: "account", body: { credits: 20, scope: "account" } });

    const bad = await fetchClothsyAccount({
      apiKey: "k1",
      baseUrl: BASE,
      fetchImpl: async () => json(401, { error: "The key is missing, malformed or revoked.", code: "INVALID_API_KEY" }),
    });
    expect(bad).toMatchObject({ ok: false, httpStatus: 401, code: "INVALID_API_KEY", retryable: false });

    const down = await fetchClothsyAccount({
      apiKey: "k1",
      baseUrl: BASE,
      fetchImpl: async () => json(503, { error: "Busy", code: "UNAVAILABLE" }),
    });
    expect(down).toMatchObject({ ok: false, httpStatus: 503, code: "UNAVAILABLE", retryable: true });

    const tls = await fetchClothsyAccount({
      apiKey: "k1",
      baseUrl: BASE,
      fetchImpl: async () => {
        throw new TypeError("fetch failed", { cause: new Error("unable to get local issuer certificate") });
      },
    });
    expect(tls).toMatchObject({ ok: false, httpStatus: null, code: "NETWORK_ERROR" });
    expect(!tls.ok && tls.message).toContain("unable to get local issuer certificate");

    const html = await fetchClothsyAccount({
      apiKey: "k1",
      baseUrl: BASE,
      fetchImpl: async () => new Response("<html>", { status: 200 }),
    });
    expect(html).toMatchObject({ ok: false, code: "BAD_RESPONSE" });

    vi.stubEnv("CLOTHSY_API_KEY", "");
    expect(await fetchClothsyAccount({ baseUrl: BASE, fetchImpl: async () => json(200, {}) })).toMatchObject({
      ok: false,
      code: "NO_API_KEY",
    });
    vi.unstubAllEnvs();
  });
});

/* ───────────────────────── Dev double ───────────────────────── */

async function garmentPng(hex: string, transparent = true): Promise<Buffer> {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">` +
        (transparent ? "" : `<rect width="300" height="400" fill="#ffffff"/>`) +
        `<path d="M110 40 L190 40 L210 160 L250 370 L50 370 L90 160 Z" fill="${hex}"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}

/** Mean RGB of a square patch. (sharp's stats() ignores extract(), so read raw pixels.) */
async function regionMean(img: Buffer, left: number, top: number, size = 9): Promise<[number, number, number]> {
  const { data, info } = await sharp(img)
    .extract({ left, top, width: size, height: size })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += info.channels) for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!;
  const n = data.length / info.channels;
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

describe("DevDoubleProvider", () => {
  it("renders a JPEG the size of the person photo: garment-coloured torso, inset, SIMULATED band", async () => {
    const W = 600;
    const H = 800;
    const person = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .jpeg()
      .toBuffer();
    const garment = await garmentPng("#2851A3");
    const sleeps: number[] = [];
    const dev = new DevDoubleProvider({
      latencyMs: 6000,
      failRate: 0,
      random: () => 0.5,
      sleep: async (ms) => void sleeps.push(ms),
    });

    const out = await dev.render({
      personBytes: person,
      personHash: sha256(person),
      garmentBytes: garment,
      garmentHash: sha256(garment),
      title: "Women's A-line midi dress, cobalt",
      idempotencyKey: "tb_dev_double_0001",
    });

    expect(out).toMatchObject({ provider: "dev", contentType: "image/jpeg", externalId: null, creditCharged: false });
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", W, H]);
    expect(sleeps).toEqual([6000]);

    const [r, g, b] = await regionMean(out.bytes, W / 2 - 4, Math.round(H * 0.33));
    expect(b).toBeGreaterThan(r + 40); // cobalt, not the grey photo
    expect(b).toBeGreaterThan(g + 30);

    const band = await regionMean(out.bytes, 2, H - 12, 6);
    expect(Math.max(...band)).toBeLessThan(70); // dark band at the bottom

    const margin = Math.max(4, Math.round(Math.min(W, H) * 0.025));
    const iw = Math.round(W * 0.26);
    const insetTop = Math.round(H * INSET_TOP_FRAC);
    const inset = await regionMean(out.bytes, W - margin - Math.round(iw / 2), insetTop + 5, 3);
    expect(Math.min(...inset)).toBeGreaterThan(225); // white product card, top right…
    // …starting below the strip where the UI's provenance pill sits, so the pill never covers it.
    const above = await regionMean(out.bytes, W - margin - Math.round(iw / 2), Math.round(insetTop / 2), 3);
    expect(Math.min(...above)).toBeLessThan(225);
  });

  it("jitters latency within ±40% of the mean", async () => {
    const person = await uniqueJpeg();
    const garment = await garmentPng("#1F7A5A");
    for (const [rand, expected] of [
      [0, 600],
      [0.999999, 1400],
    ] as const) {
      const sleeps: number[] = [];
      const dev = new DevDoubleProvider({ latencyMs: 1000, random: () => rand, sleep: async (ms) => void sleeps.push(ms) });
      await dev.render({
        personBytes: person,
        personHash: sha256(person),
        garmentBytes: garment,
        garmentHash: sha256(garment),
        title: "x",
        idempotencyKey: "tb_dev_jitter_0001",
      });
      expect(sleeps[0]).toBe(expected);
    }
  });

  it("fails at failRate with RENDER_FAILED and honours abort", async () => {
    const input = await makeInput();
    const failing = new DevDoubleProvider({ latencyMs: 10, failRate: 1, sleep: async () => undefined });
    const err = await expectTryOnError(failing.render(input), "RENDER_FAILED");
    expect(err.retryable).toBe(false);

    const ctrl = new AbortController();
    ctrl.abort();
    const dev = new DevDoubleProvider({ latencyMs: 10, sleep: async () => undefined });
    await expectTryOnError(dev.render(input, ctrl.signal), "ABORTED");
  });

  it("samples the garment's dominant colour from non-white pixels", async () => {
    const c = await garmentDominantColour(await garmentPng("#C9A227"));
    expect(Math.abs(c.r - 0xc9)).toBeLessThan(8);
    expect(Math.abs(c.g - 0xa2)).toBeLessThan(8);
    expect(Math.abs(c.b - 0x27)).toBeLessThan(8);
    // An off-white garment on a white background still reads as off-white.
    const w = await garmentDominantColour(await garmentPng("#F4F3EF", false));
    expect(Math.abs(w.r - 0xf4)).toBeLessThan(8);
  });

  it("handles tiny images without throwing", async () => {
    const tiny = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const out = await composeSimulatedRender(tiny, await garmentPng("#000000"));
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([20, 20]);
  });
});

/* ───────────────────────── Garment preparation ───────────────────────── */

describe("loadGarmentImage", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tryback-garment-"));
    await fs.mkdir(path.join(root, "public", "catalog"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    clearGarmentCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const sku = (over: Partial<Sku>): Sku => ({ ...SKUS[0]!, ...over });

  it("flattens alpha onto white, fits within 1600 px, encodes JPEG < 4 MB, and memoises", async () => {
    const big = await sharp({
      create: { width: 2400, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200"><circle cx="1200" cy="600" r="400" fill="#1F7A5A"/></svg>`,
          ),
        },
      ])
      .png()
      .toBuffer();
    await fs.writeFile(path.join(root, "public/catalog/test-a.png"), big);
    const s = sku({ id: "fw-test-a", image: "/catalog/test-a.png", altImage: null });

    const a = await loadGarmentImage(s, "primary");
    expect(a.contentType).toBe("image/jpeg");
    expect(a.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(a.bytes.length).toBeLessThan(4_000_000);
    expect(a.hash).toBe(sha256(a.bytes));
    const meta = await sharp(a.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 800]);
    const corner = await regionMean(a.bytes, 0, 0, 4);
    expect(Math.min(...corner)).toBeGreaterThan(250); // transparent → white, not black

    const again = await loadGarmentImage(s, "primary");
    expect(again.bytes).toBe(a.bytes); // memoised
    const alt = await loadGarmentImage(s, "alt"); // no altImage → primary shot
    expect(alt.hash).toBe(a.hash);
  });

  it("uses altImage for the alt variant and invalidates when the file changes", async () => {
    const png = (hex: string) =>
      sharp({ create: { width: 200, height: 300, channels: 3, background: hex } }).png().toBuffer();
    await fs.writeFile(path.join(root, "public/catalog/b.png"), await png("#2851A3"));
    await fs.writeFile(path.join(root, "public/catalog/b-alt.png"), await png("#9CAF88"));
    const s = sku({ id: "fw-test-b", image: "/catalog/b.png", altImage: "/catalog/b-alt.png" });

    const primary = await loadGarmentImage(s, "primary");
    const alt = await loadGarmentImage(s, "alt");
    expect(alt.hash).not.toBe(primary.hash);

    await fs.writeFile(path.join(root, "public/catalog/b.png"), await png("#C0643F"));
    const later = new Date(Date.now() + 5000);
    await fs.utimes(path.join(root, "public/catalog/b.png"), later, later);
    const updated = await loadGarmentImage(s, "primary");
    expect(updated.hash).not.toBe(primary.hash);
  });

  it("reports missing files and refuses paths outside public/", async () => {
    await expectTryOnError(
      loadGarmentImage(sku({ id: "fw-missing", image: "/catalog/nope.png" }), "primary"),
      "GARMENT_IMAGE_MISSING",
    );
    await expectTryOnError(
      loadGarmentImage(sku({ id: "fw-escape", image: "/../../etc/passwd" }), "primary"),
      "BAD_INPUT",
    );
  });

  it("steps quality/size down to meet the byte limit", async () => {
    const noise = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: "#777", noise: { type: "gaussian", mean: 128, sigma: 60 } },
    })
      .png()
      .toBuffer();
    const out = await encodeUnderLimit(noise, 120_000);
    expect(out.length).toBeLessThanOrEqual(120_000);
  });
});

/* ───────────────────────── Cache + resolution ───────────────────────── */

function fakeProvider(name: "clothsy" | "dev", opts?: { fail?: string; gate?: Promise<void> }) {
  const calls: TryOnInput[] = [];
  const provider: TryOnProvider & { calls: TryOnInput[] } = {
    name,
    calls,
    async render(input: TryOnInput): Promise<TryOnOutput> {
      calls.push(input);
      if (opts?.gate) await opts.gate;
      if (opts?.fail) throw new TryOnError(opts.fail, `fake ${opts.fail}`, false);
      return {
        bytes: Buffer.from(`${name}-render-${calls.length}`),
        contentType: "image/jpeg",
        latencyMs: name === "clothsy" ? 17_000 : 6_000,
        provider: name,
        externalId: name === "clothsy" ? `try_${calls.length}` : null,
        creditCharged: name === "clothsy",
      };
    },
  };
  return provider;
}

function stubInput(): TryOnInput {
  seq++;
  const b = Buffer.from(`person-${seq}`);
  return {
    personBytes: b,
    personHash: sha256(b),
    garmentBytes: Buffer.from("garment"),
    garmentHash: sha256(Buffer.from("garment")),
    title: "t",
    idempotencyKey: `tb_stub_${seq}_xxxxxxxx`,
  };
}

function freshKey(): string {
  seq++;
  return renderCacheKey({ personHash: sha256(Buffer.from(`k${seq}`)), skuId: "fw-wrap-dress-emerald", garmentVariant: "primary" });
}

async function setLiveToday(n: number): Promise<void> {
  await mutate((db) => {
    db.liveRendersByDay[utcDay()] = n;
  });
  await liveRendersToday();
}

describe("renderCacheKey / resolveProvider / renderWithCache", () => {
  beforeEach(async () => {
    vi.stubEnv("TRYON_MODE", "auto");
    vi.stubEnv("DAILY_LIVE_RENDER_CAP", "40");
    await setLiveToday(0);
  });

  afterEach(() => {
    setProviderOverrides(null);
    vi.unstubAllEnvs();
  });

  it("cache key is 40 hex chars, deterministic, and varies by person, sku, variant and API version", () => {
    const base = { personHash: "a".repeat(64), skuId: "fw-wrap-dress-emerald", garmentVariant: "primary" as const };
    const k = renderCacheKey(base);
    expect(k).toMatch(/^[a-f0-9]{40}$/);
    expect(renderCacheKey(base)).toBe(k);
    expect(renderCacheKey({ ...base, garmentVariant: "alt" })).not.toBe(k);
    expect(renderCacheKey({ ...base, skuId: "fw-aline-midi-cobalt" })).not.toBe(k);
    expect(renderCacheKey({ ...base, personHash: "b".repeat(64) })).not.toBe(k);
    // The product shot is part of the address: replacing a catalogue image never replays old renders.
    const g1 = renderCacheKey({ ...base, garmentHash: "c".repeat(64) });
    expect(g1).not.toBe(k);
    expect(renderCacheKey({ ...base, garmentHash: "d".repeat(64) })).not.toBe(g1);
    expect(API_VERSION).toBe("clothsy-v1.p1");
  });

  it("resolves providers by mode, access, key and daily cap", async () => {
    const clothsy = fakeProvider("clothsy");
    const dev = fakeProvider("dev");
    setProviderOverrides({ clothsy, dev });

    expect(resolveProvider({ allowLive: true })).toMatchObject({ provider: clothsy, reason: "live" });
    expect(activeProviderName({ allowLive: true })).toBe("clothsy");
    expect(resolveProvider({ allowLive: false })).toMatchObject({ provider: dev, reason: "replay" });
    expect(activeProviderName({ allowLive: false })).toBe("dev");

    vi.stubEnv("TRYON_MODE", "dev");
    expect(resolveProvider({ allowLive: true }).reason).toBe("mode_dev");
    vi.stubEnv("TRYON_MODE", "replay");
    expect(resolveProvider({ allowLive: true }).reason).toBe("replay");
    vi.stubEnv("TRYON_MODE", "live");
    expect(resolveProvider({ allowLive: true }).reason).toBe("live");

    vi.stubEnv("TRYON_MODE", "auto");
    await setLiveToday(40);
    expect(resolveProvider({ allowLive: true })).toMatchObject({ provider: dev, reason: "daily_cap" });

    setProviderOverrides({ clothsy: null, dev });
    expect(resolveProvider({ allowLive: true })).toMatchObject({ provider: dev, reason: "no_key" });
  });

  it("decideProvider is the same rule set, pure (no store reads, lazy live count)", () => {
    const base = { allowLive: true, hasKey: true, liveCount: 0, dailyCap: 40 } as const;
    expect(decideProvider({ ...base, mode: "dev" })).toEqual({ name: "dev", reason: "mode_dev" });
    expect(decideProvider({ ...base, mode: "replay" })).toEqual({ name: "dev", reason: "replay" });
    expect(decideProvider({ ...base, mode: "auto", allowLive: false })).toEqual({ name: "dev", reason: "replay" });
    expect(decideProvider({ ...base, mode: "auto", hasKey: false })).toEqual({ name: "dev", reason: "no_key" });
    expect(decideProvider({ ...base, mode: "live", liveCount: 40 })).toEqual({ name: "dev", reason: "daily_cap" });
    expect(decideProvider({ ...base, mode: "auto" })).toEqual({ name: "clothsy", reason: "live" });
    const count = vi.fn(() => 3);
    decideProvider({ ...base, mode: "dev", liveCount: count });
    expect(count).not.toHaveBeenCalled();
    expect(decideProvider({ ...base, mode: "auto", liveCount: count, dailyCap: 3 }).reason).toBe("daily_cap");
  });

  it("uses the real providers when not overridden", () => {
    vi.stubEnv("CLOTHSY_API_KEY", "");
    expect(resolveProvider({ allowLive: true })).toMatchObject({ reason: "no_key" });
    expect(resolveProvider({ allowLive: true }).provider).toBeInstanceOf(DevDoubleProvider);
    vi.stubEnv("CLOTHSY_API_KEY", "sk_test");
    expect(resolveProvider({ allowLive: true }).provider).toBeInstanceOf(ClothsyProvider);
  });

  it("miss renders and caches; hit returns cached bytes with fromCache and no credit", async () => {
    const dev = fakeProvider("dev");
    setProviderOverrides({ clothsy: null, dev });
    const cacheKey = freshKey();
    const input = stubInput();

    const first = await renderWithCache({ cacheKey, input, allowLive: true });
    expect(first).toMatchObject({ fromCache: false, provider: "dev", creditCharged: false, latencyMs: 6000 });
    expect((await readRender(cacheKey))?.equals(first.bytes)).toBe(true);
    expect((await readDb()).renderIndex[cacheKey]).toMatchObject({ provider: "dev", latencyMs: 6000, contentType: "image/jpeg" });

    const second = await renderWithCache({ cacheKey, input, allowLive: true });
    expect(second).toMatchObject({ fromCache: true, provider: "dev", creditCharged: false, latencyMs: 6000 });
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(dev.calls).toHaveLength(1);
    expect((await readDb()).liveRendersByDay[utcDay()] ?? 0).toBe(0); // dev renders don't count
  });

  it("upgrades a cached dev render to live, counts it, then serves the live render from cache", async () => {
    const cacheKey = freshKey();
    const input = stubInput();
    setProviderOverrides({ clothsy: null, dev: fakeProvider("dev") });
    await renderWithCache({ cacheKey, input, allowLive: true });

    const clothsy = fakeProvider("clothsy");
    setProviderOverrides({ clothsy, dev: fakeProvider("dev") });
    const simulatedBytes = await readRender(cacheKey);
    const live = await renderWithCache({ cacheKey, input, allowLive: true });
    expect(live).toMatchObject({ fromCache: false, provider: "clothsy", creditCharged: true, externalId: "try_1" });
    expect((await readDb()).renderIndex[cacheKey]?.provider).toBe("clothsy");
    expect((await readDb()).liveRendersByDay[utcDay()]).toBe(1);
    // The live render is a new version with its own URL; the simulated bytes behind the old
    // (immutable-cached) URL are untouched, so neither image is ever shown under the wrong label.
    expect(live.version).toMatch(/^clothsy-[a-z0-9]+$/);
    expect(renderResultUrl(cacheKey, live.version)).toBe(`/api/renders/${cacheKey}?v=${live.version}`);
    expect((await readRender(cacheKey))?.equals(simulatedBytes!)).toBe(true);
    expect((await readRender(renderBlobName(cacheKey, live.version)))?.equals(live.bytes)).toBe(true);

    const cached = await renderWithCache({ cacheKey, input, allowLive: true });
    expect(cached).toMatchObject({ fromCache: true, provider: "clothsy", creditCharged: false, latencyMs: 17_000, version: live.version });
    expect(cached.bytes.equals(live.bytes)).toBe(true);
    expect(clothsy.calls).toHaveLength(1);

    // replay / locked sessions still get the cached live render
    const replay = await renderWithCache({ cacheKey, input, allowLive: false });
    expect(replay).toMatchObject({ fromCache: true, provider: "clothsy" });
  });

  it("falls back to the cached simulated render when a live upgrade fails", async () => {
    const cacheKey = freshKey();
    const input = stubInput();
    setProviderOverrides({ clothsy: null, dev: fakeProvider("dev") });
    await renderWithCache({ cacheKey, input, allowLive: true });

    setProviderOverrides({ clothsy: fakeProvider("clothsy", { fail: "INSUFFICIENT_CREDITS" }), dev: fakeProvider("dev") });
    const out = await renderWithCache({ cacheKey, input, allowLive: true });
    expect(out).toMatchObject({ fromCache: true, provider: "dev" });
  });

  it("propagates live failures on a cache miss", async () => {
    setProviderOverrides({ clothsy: fakeProvider("clothsy", { fail: "PERSON_PHOTO_REJECTED" }), dev: fakeProvider("dev") });
    await expectTryOnError(renderWithCache({ cacheKey: freshKey(), input: stubInput(), allowLive: true }), "PERSON_PHOTO_REJECTED");
  });

  it("coalesces concurrent renders of one key (one provider call, one credit)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const clothsy = fakeProvider("clothsy", { gate });
    setProviderOverrides({ clothsy, dev: fakeProvider("dev") });
    const cacheKey = freshKey();
    const input = stubInput();
    const a = renderWithCache({ cacheKey, input, allowLive: true });
    const b = renderWithCache({ cacheKey, input, allowLive: true });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(clothsy.calls).toHaveLength(1);
    expect([ra.creditCharged, rb.creditCharged].filter(Boolean)).toHaveLength(1);
    expect(rb.fromCache).toBe(true);
  });

  it("counts in-flight live renders against the daily cap", async () => {
    vi.stubEnv("DAILY_LIVE_RENDER_CAP", "1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const clothsy = fakeProvider("clothsy", { gate });
    const dev = fakeProvider("dev");
    setProviderOverrides({ clothsy, dev });

    const a = renderWithCache({ cacheKey: freshKey(), input: stubInput(), allowLive: true });
    await vi.waitFor(() => expect(clothsy.calls).toHaveLength(1));
    const b = await renderWithCache({ cacheKey: freshKey(), input: stubInput(), allowLive: true });
    expect(b.provider).toBe("dev");
    release();
    expect((await a).provider).toBe("clothsy");
    expect(await liveRendersToday()).toBe(1);
    expect(resolveProvider({ allowLive: true }).reason).toBe("daily_cap");
  });

  it("keeps the daily-cap reservation until the live render is counted (no overshoot while it's stored)", async () => {
    vi.stubEnv("DAILY_LIVE_RENDER_CAP", "1");
    const dev = fakeProvider("dev");
    let second: Promise<Awaited<ReturnType<typeof renderWithCache>>> | null = null;
    const clothsy: TryOnProvider = {
      name: "clothsy",
      async render(): Promise<TryOnOutput> {
        // Another request arrives just as this live render returns, while it is being stored.
        setImmediate(() => {
          second = renderWithCache({ cacheKey: freshKey(), input: stubInput(), allowLive: true });
        });
        return { bytes: Buffer.alloc(200_000, 7), contentType: "image/jpeg", latencyMs: 20, provider: "clothsy", externalId: "x", creditCharged: true };
      },
    };
    setProviderOverrides({ clothsy, dev });
    const first = await renderWithCache({ cacheKey: freshKey(), input: stubInput(), allowLive: true });
    expect(first.provider).toBe("clothsy");
    await vi.waitFor(() => expect(second).not.toBeNull());
    expect((await second!).provider).toBe("dev");
    expect(await liveRendersToday()).toBe(1);
  });

  it("rejects unsafe cache keys", async () => {
    await expectTryOnError(renderWithCache({ cacheKey: "../etc", input: stubInput(), allowLive: true }), "BAD_INPUT");
  });
});
