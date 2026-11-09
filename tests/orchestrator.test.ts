import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Isolated data dir + forced dev double, set before any module reads the env.
const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = path.join(os.tmpdir(), `tryback-test-orchestrator-${process.pid}`);
  process.env.TRYBACK_DATA_DIR = dir;
  process.env.TRYON_MODE = "dev";
  process.env.DEV_RENDER_LATENCY_MS = "5";
  process.env.DEV_FAIL_RATE = "0";
  process.env.MAX_RENDERS_PER_RETURN = "5";
  delete process.env.CLOTHSY_API_KEY;
  delete process.env.LIVE_ACCESS_CODE;
  return { dir };
});

// Product shots come from `npm run assets`; give the orchestrator synthetic ones so this
// suite doesn't depend on generated files. A SKU in `garment.failFor` throws like a missing file.
const garment = vi.hoisted(() => ({ failFor: new Set<string>(), calls: [] as Array<[string, string]> }));
vi.mock("@/lib/tryon/garment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tryon/garment")>();
  const sharp = (await import("sharp")).default;
  const { createHash } = await import("node:crypto");
  const { TryOnError } = await import("@/lib/tryon/types");
  return {
    ...actual,
    loadGarmentImage: vi.fn(async (sku: { id: string; colorHex: string }, variant: "primary" | "alt") => {
      garment.calls.push([sku.id, variant]);
      if (garment.failFor.has(sku.id)) {
        throw new TryOnError("GARMENT_IMAGE_MISSING", `Garment image not found for ${sku.id}`, false);
      }
      const bytes = await sharp({ create: { width: 384, height: 512, channels: 3, background: "#ffffff" } })
        .composite([
          {
            input: await sharp({ create: { width: 220, height: 380, channels: 3, background: sku.colorHex } })
              .png()
              .toBuffer(),
            left: 82,
            top: variant === "alt" ? 40 : 66,
          },
        ])
        .jpeg({ quality: 90 })
        .toBuffer();
      return { bytes, hash: createHash("sha256").update(bytes).digest("hex"), contentType: "image/jpeg" as const };
    }),
  };
});

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  countedJobs,
  failStaleJobs,
  firstCardAtFor,
  hasActiveJob,
  hasDeterministicFailure,
  hasStaleJob,
  STALE_JOB_MS,
  remainingRenderBudget,
  renderIdempotencyKey,
  requestGateRetry,
  runJobs,
  runRenderJob,
  scheduleRenders,
  skipQueuedJobs,
  type RenderPick,
} from "@/lib/orchestrator";
import { classifyTransition } from "@/lib/retrieval";
import { requireSku } from "@/lib/catalog";
import { deletePhoto, getReturn, hasRender, mutate, newId, readDb, readRender, savePhoto, DATA_DIR } from "@/lib/store";
import { renderCacheKey, setProviderOverrides, TryOnError, type TryOnInput, type TryOnProvider } from "@/lib/tryon";
import { loadGarmentImage } from "@/lib/tryon/garment";
import type { Candidate, ReturnCase } from "@/lib/types";

let photo: Buffer;
let photoHash: string;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

async function synthPhoto(seed: string): Promise<Buffer> {
  // A plain "person" silhouette on a grey backdrop; content varies by seed so hashes differ.
  const tint = createHash("md5").update(seed).digest()[0];
  const body = await sharp({ create: { width: 240, height: 700, channels: 3, background: { r: 200, g: 120 + (tint % 60), b: 60 } } })
    .png()
    .toBuffer();
  return sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 120, g: 124, b: 130 } } })
    .composite([{ input: body, left: 180, top: 120 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

/** SKUs these tests render; by default they are all on screen (candidates) so retries/first card apply. */
const TEST_SKUS = [
  "fw-aline-midi-cobalt",
  "fw-aline-midi-sage",
  "fw-aline-midi-black",
  "fw-shift-dress-navy",
  "fw-shirt-dress-rust",
  "fw-shirt-dress-sage",
  "fw-wrap-dress-navy",
  "fw-wrap-dress-emerald",
  "fw-knit-top-cocoa",
];

function candidate(skuId: string): Candidate {
  return { skuId, size: "M", transition: "colour_only", score: 1, fixes: [], why: "", priceDiff: 0 };
}

async function garmentHash(skuId: string, variant: "primary" | "alt" = "primary"): Promise<string> {
  return (await loadGarmentImage(requireSku(skuId), variant)).hash;
}

async function createReturn(
  opts: { photoBytes?: Buffer | null; skuId?: string; status?: ReturnCase["status"]; candidates?: string[] } = {},
): Promise<ReturnCase> {
  const id = newId("ret");
  const now = new Date().toISOString();
  const bytes = opts.photoBytes === undefined ? photo : opts.photoBytes;
  const r: ReturnCase = {
    id,
    orderId: "1042",
    lineIndex: 0,
    skuId: opts.skuId ?? "fw-wrap-dress-mustard",
    size: "M",
    price: 89,
    status: opts.status ?? "photo_uploaded",
    reason: "style_colour",
    fitComplaints: [],
    chips: [],
    freeText: "",
    consent: bytes ? { adultAttested: true, at: now } : null,
    photo: bytes
      ? { url: `/api/photos/${id}`, hash: createHash("sha256").update(bytes).digest("hex"), width: 600, height: 900, uploadedAt: now }
      : null,
    photoSkipped: false,
    preflight: null,
    measurements: null,
    diagnosis: null,
    candidates: (opts.candidates ?? TEST_SKUS).map(candidate),
    renders: [],
    timeline: { createdAt: now, reasonAt: now, photoAt: bytes ? now : null, formSubmittedAt: null, firstCardAt: null, resolvedAt: null },
    outcome: null,
    creditsSpent: 0,
    simulatedRenders: 0,
  };
  if (bytes) await savePhoto(id, bytes);
  await mutate((db) => {
    db.returns[id] = r;
  });
  return r;
}

function pick(skuId: string): RenderPick {
  return { skuId, size: "M", transition: classifyTransition(requireSku("fw-wrap-dress-mustard"), requireSku(skuId)) };
}

async function mustGet(id: string): Promise<ReturnCase> {
  const r = await getReturn(id);
  if (!r) throw new Error(`missing return ${id}`);
  return r;
}

beforeAll(async () => {
  await fs.rm(env.dir, { recursive: true, force: true });
  photo = await synthPhoto("main");
  photoHash = createHash("sha256").update(photo).digest("hex");
  process.on("unhandledRejection", onUnhandled);
});

afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
  await fs.rm(env.dir, { recursive: true, force: true });
});

beforeEach(() => {
  garment.failFor.clear();
  garment.calls.length = 0;
  process.env.MAX_RENDERS_PER_RETURN = "5";
  process.env.DEV_FAIL_RATE = "0";
});

afterEach(() => {
  expect(unhandled).toEqual([]);
});

describe("setup", () => {
  it("uses the isolated data dir and the dev double", () => {
    expect(DATA_DIR).toBe(env.dir);
    expect(process.env.TRYON_MODE).toBe("dev");
  });
});

describe("scheduleRenders", () => {
  it("appends queued primary jobs with content-addressed cache keys and returns only new ones", async () => {
    const r = await createReturn();
    const jobs = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt"), pick("fw-wrap-dress-navy")], "speculative");
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j).toMatchObject({
        returnId: r.id,
        size: "M",
        phase: "speculative",
        garmentVariant: "primary",
        status: "queued",
        provider: null,
        fromCache: false,
        startedAt: null,
        finishedAt: null,
        resultUrl: null,
        error: null,
        creditCharged: false,
        gate: null,
        retryOf: null,
        supersededBy: null,
      });
      expect(j.cacheKey).toBe(
        renderCacheKey({ personHash: photoHash, skuId: j.skuId, garmentVariant: "primary", garmentHash: await garmentHash(j.skuId) }),
      );
    }
    expect(jobs[0].transition).toBe("slim_to_loose");
    expect(jobs[1].transition).toBe("colour_only");
    const stored = await mustGet(r.id);
    expect(stored.renders.map((j) => j.id)).toEqual(jobs.map((j) => j.id));
  });

  it("dedupes picks already queued/rendered for the same sku+variant, and within one call", async () => {
    const r = await createReturn();
    expect(await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt"), pick("fw-aline-midi-cobalt")], "speculative")).toHaveLength(1);
    expect(await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt")], "post_diagnosis")).toEqual([]);
    const fresh = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt"), pick("fw-shift-dress-navy")], "post_diagnosis");
    expect(fresh.map((j) => j.skuId)).toEqual(["fw-shift-dress-navy"]);
    expect((await mustGet(r.id)).renders).toHaveLength(2);
  });

  it("skips unknown SKUs and returns nothing without a photo or once resolved", async () => {
    const r = await createReturn();
    expect(await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt"), { ...pick("fw-aline-midi-cobalt"), skuId: "nope" }], "speculative")).toHaveLength(1);

    const noPhoto = await createReturn({ photoBytes: null });
    expect(await scheduleRenders(noPhoto.id, [pick("fw-aline-midi-cobalt")], "speculative")).toEqual([]);

    const resolved = await createReturn({ status: "resolved" });
    expect(await scheduleRenders(resolved.id, [pick("fw-aline-midi-cobalt")], "speculative")).toEqual([]);

    await expect(scheduleRenders("ret_missing", [pick("fw-aline-midi-cobalt")], "speculative")).rejects.toThrow(/not found/);
  });

  it("enforces MAX_RENDERS_PER_RETURN, counting every job except 'skipped'", async () => {
    process.env.MAX_RENDERS_PER_RETURN = "3";
    const r = await createReturn();
    const ids = ["fw-aline-midi-cobalt", "fw-aline-midi-sage", "fw-shift-dress-navy", "fw-shirt-dress-rust", "fw-wrap-dress-navy"];
    const jobs = await scheduleRenders(r.id, ids.map(pick), "speculative");
    expect(jobs.map((j) => j.skuId)).toEqual(ids.slice(0, 3));
    expect(await scheduleRenders(r.id, [pick("fw-wrap-dress-emerald")], "post_diagnosis")).toEqual([]);
    expect(remainingRenderBudget(await mustGet(r.id))).toBe(0);

    // Skipped jobs free a slot; failed ones don't.
    await mutate((db) => {
      db.returns[r.id].renders[0].status = "skipped";
      db.returns[r.id].renders[1].status = "failed";
    });
    const after = await scheduleRenders(r.id, [pick("fw-wrap-dress-emerald"), pick("fw-shirt-dress-sage")], "post_diagnosis");
    expect(after.map((j) => j.skuId)).toEqual(["fw-wrap-dress-emerald"]);
    expect(countedJobs(await mustGet(r.id))).toBe(3);
  });

  it("allows re-rendering a SKU whose earlier job failed (counts toward the cap)", async () => {
    const r = await createReturn();
    const [first] = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt")], "speculative");
    await mutate((db) => {
      db.returns[r.id].renders[0].status = "failed";
    });
    expect(hasActiveJob(await mustGet(r.id), "fw-aline-midi-cobalt")).toBe(false);
    const [second] = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt")], "post_diagnosis");
    expect(second.id).not.toBe(first.id);
    expect(countedJobs(await mustGet(r.id))).toBe(2);
  });
});

describe("runJobs / runRenderJob", () => {
  it("renders with the dev double and records success + accounting", async () => {
    const r = await createReturn();
    const jobs = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt"), pick("fw-wrap-dress-navy")], "speculative");
    await runJobs(r.id, jobs.map((j) => j.id), { allowLive: false });

    const after = await mustGet(r.id);
    expect(after.renders.every((j) => j.status === "success")).toBe(true);
    for (const j of after.renders) {
      expect(j.provider).toBe("dev");
      expect(j.fromCache).toBe(false);
      expect(j.creditCharged).toBe(false);
      expect(j.error).toBeNull();
      expect(j.resultUrl).toBe(`/api/renders/${j.cacheKey}`);
      expect(typeof j.latencyMs).toBe("number");
      expect(Date.parse(j.startedAt!)).toBeLessThanOrEqual(Date.parse(j.finishedAt!));
      expect(await hasRender(j.cacheKey)).toBe(true);
      const bytes = await readRender(j.cacheKey);
      expect((await sharp(bytes!).metadata()).format).toBe("jpeg");
    }
    expect(after.creditsSpent).toBe(0);
    expect(after.simulatedRenders).toBe(2);
    const finished = after.renders.map((j) => j.finishedAt!).sort();
    expect(after.timeline.firstCardAt).toBe(finished[0]);

    const db = await readDb();
    for (const j of after.renders) expect(db.renderIndex[j.cacheKey]).toMatchObject({ provider: "dev", contentType: "image/jpeg" });
    expect(garment.calls).toEqual(expect.arrayContaining([["fw-aline-midi-cobalt", "primary"], ["fw-wrap-dress-navy", "primary"]]));
  });

  it("serves a cache hit for the same photo + garment without a new render", async () => {
    const a = await createReturn();
    const [ja] = await scheduleRenders(a.id, [pick("fw-shift-dress-navy")], "speculative");
    await runJobs(a.id, [ja.id], { allowLive: false });

    const b = await createReturn(); // same photo bytes → same person hash → same cache key
    const [jb] = await scheduleRenders(b.id, [pick("fw-shift-dress-navy")], "speculative");
    expect(jb.cacheKey).toBe(ja.cacheKey);
    await runJobs(b.id, [jb.id], { allowLive: false });

    const job = (await mustGet(b.id)).renders[0];
    expect(job).toMatchObject({ status: "success", fromCache: true, provider: "dev", creditCharged: false });
    expect(job.latencyMs).toBe((await mustGet(a.id)).renders[0].latencyMs);
  });

  it("does not set firstCardAt for size previews", async () => {
    const r = await createReturn({ skuId: "fw-linen-shirt-white" });
    const [job] = await scheduleRenders(
      r.id,
      [{ skuId: "fw-linen-shirt-white-tall", size: "M", transition: "longer" }],
      "size_preview",
    );
    await runJobs(r.id, [job.id], { allowLive: false });
    const after = await mustGet(r.id);
    expect(after.renders[0].status).toBe("success");
    expect(after.timeline.firstCardAt).toBeNull();
  });

  it("is idempotent: a job that is no longer queued is left alone", async () => {
    const r = await createReturn();
    const [job] = await scheduleRenders(r.id, [pick("fw-aline-midi-sage")], "speculative");
    await runRenderJob(r.id, job.id, { allowLive: false });
    const once = await mustGet(r.id);
    garment.calls.length = 0;
    await runRenderJob(r.id, job.id, { allowLive: false });
    const twice = await mustGet(r.id);
    expect(twice.renders[0]).toEqual(once.renders[0]);
    expect(twice.simulatedRenders).toBe(1);
    expect(garment.calls).toEqual([]);
  });

  it("marks provider/garment errors as failed with {code, message} and keeps going", async () => {
    garment.failFor.add("fw-shirt-dress-rust");
    const r = await createReturn();
    const jobs = await scheduleRenders(r.id, [pick("fw-shirt-dress-rust"), pick("fw-aline-midi-black")], "post_diagnosis");
    await expect(runJobs(r.id, jobs.map((j) => j.id), { allowLive: false })).resolves.toBeUndefined();

    const after = await mustGet(r.id);
    const failed = after.renders.find((j) => j.skuId === "fw-shirt-dress-rust")!;
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("GARMENT_IMAGE_MISSING");
    expect(failed.error?.message).toMatch(/product photo/);
    expect(failed.finishedAt).not.toBeNull();
    expect(failed.resultUrl).toBeNull();
    expect(after.renders.find((j) => j.skuId === "fw-aline-midi-black")!.status).toBe("success");
    expect(after.simulatedRenders).toBe(1);
  });

  it("maps a simulated provider failure (DEV_FAIL_RATE=1) to RENDER_FAILED", async () => {
    process.env.DEV_FAIL_RATE = "1";
    const r = await createReturn({ photoBytes: await synthPhoto("fail-rate") });
    const [job] = await scheduleRenders(r.id, [pick("fw-wrap-dress-emerald")], "speculative");
    await runJobs(r.id, [job.id], { allowLive: false });
    const after = await mustGet(r.id);
    expect(after.renders[0]).toMatchObject({ status: "failed", creditCharged: false });
    expect(after.renders[0].error?.code).toBe("RENDER_FAILED");
    expect(after.timeline.firstCardAt).toBeNull();
    expect(after.simulatedRenders).toBe(0);
  });

  it("fails cleanly when the photo is gone", async () => {
    const r = await createReturn({ photoBytes: await synthPhoto("deleted") });
    const [job] = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt")], "speculative");
    await deletePhoto(r.id);
    await runJobs(r.id, [job.id], { allowLive: false });
    expect((await mustGet(r.id)).renders[0].error?.code).toBe("PHOTO_MISSING");
  });

  it("never throws for unknown returns or jobs", async () => {
    await expect(runJobs("ret_unknown", ["job_unknown"], { allowLive: false })).resolves.toBeUndefined();
    await expect(runRenderJob("ret_unknown", "job_unknown", { allowLive: true })).resolves.toBeUndefined();
    const r = await createReturn();
    await expect(runJobs(r.id, ["job_nope"], { allowLive: false })).resolves.toBeUndefined();
  });

  it("skipQueuedJobs skips queued jobs so they never render", async () => {
    const r = await createReturn();
    const [job] = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt")], "speculative");
    expect(await skipQueuedJobs(r.id)).toBe(1);
    await runJobs(r.id, [job.id], { allowLive: false });
    const after = await mustGet(r.id);
    expect(after.renders[0].status).toBe("skipped");
    expect(remainingRenderBudget(after)).toBe(5);
  });
});

describe("renderIdempotencyKey", () => {
  it("is tb_<cacheKey> first, and gets a fresh suffix after earlier failures (the API replays failures)", () => {
    const key = "a".repeat(40);
    expect(renderIdempotencyKey(key, 0)).toBe(`tb_${key}`);
    expect(renderIdempotencyKey(key, 1)).toBe(`tb_${key}_r1`);
    expect(renderIdempotencyKey(key, 2)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});

describe("failStaleJobs", () => {
  it("fails queued/running jobs orphaned past STALE_JOB_MS and leaves fresh or finished ones alone", async () => {
    const r = await createReturn({ photoBytes: await synthPhoto("stale") });
    const [orphan, fresh, done] = await scheduleRenders(
      r.id,
      [pick("fw-aline-midi-cobalt"), pick("fw-shift-dress-navy"), pick("fw-aline-midi-black")],
      "speculative",
    );
    await runRenderJob(r.id, done.id, { allowLive: false });
    const now = Date.now();
    const old = new Date(now - STALE_JOB_MS - 1000).toISOString();
    await mutate((db) => {
      const job = db.returns[r.id].renders.find((j) => j.id === orphan.id)!;
      job.status = "running";
      job.startedAt = old;
      db.returns[r.id].renders.find((j) => j.id === done.id)!.startedAt = old;
    });

    const before = await mustGet(r.id);
    expect(hasStaleJob(before, now)).toBe(true);
    expect(await failStaleJobs(r.id, now)).toBe(1);

    const after = await mustGet(r.id);
    const byId = (id: string) => after.renders.find((j) => j.id === id)!;
    expect(byId(orphan.id)).toMatchObject({ status: "failed", creditCharged: false, error: { code: "RENDER_STALE" } });
    expect(byId(fresh.id).status).toBe("queued");
    expect(byId(done.id).status).toBe("success");
    expect(hasStaleJob(after, now)).toBe(false);
    // A failed orphan no longer blocks re-rendering that SKU.
    expect(hasActiveJob(after, "fw-aline-midi-cobalt")).toBe(false);
  });
});

describe("requestGateRetry", () => {
  async function successfulJob(skuId = "fw-aline-midi-cobalt", returnSku?: string) {
    const r = await createReturn({ skuId: returnSku });
    const [job] = await scheduleRenders(r.id, [{ ...pick(skuId), transition: "slim_to_loose" }], "post_diagnosis");
    await runJobs(r.id, [job.id], { allowLive: false });
    return { r, job: (await mustGet(r.id)).renders[0] };
  }

  it("spawns one alt-image retry and links it to the original", async () => {
    const { r, job } = await successfulJob();
    expect(job.status).toBe("success");
    const retry = await requestGateRetry(r.id, job.id);
    expect(retry).not.toBeNull();
    expect(retry).toMatchObject({
      phase: "retry",
      garmentVariant: "alt",
      retryOf: job.id,
      skuId: job.skuId,
      size: job.size,
      transition: job.transition,
      status: "queued",
    });
    expect(retry!.cacheKey).toBe(
      renderCacheKey({ personHash: photoHash, skuId: job.skuId, garmentVariant: "alt", garmentHash: await garmentHash(job.skuId, "alt") }),
    );
    expect(retry!.cacheKey).not.toBe(job.cacheKey);

    const stored = await mustGet(r.id);
    expect(stored.renders.find((j) => j.id === job.id)!.supersededBy).toBe(retry!.id);

    const firstCard = stored.timeline.firstCardAt;
    await runJobs(r.id, [retry!.id], { allowLive: false });
    const done = await mustGet(r.id);
    const ran = done.renders.find((j) => j.id === retry!.id)!;
    expect(ran.status).toBe("success");
    expect(garment.calls).toContainEqual([job.skuId, "alt"]);
    expect(done.timeline.firstCardAt).toBe(firstCard);
    expect(done.simulatedRenders).toBe(2);
  });

  it("only retries once: not for an already-superseded job, nor for the retry itself", async () => {
    const { r, job } = await successfulJob("fw-shift-dress-navy");
    const retry = await requestGateRetry(r.id, job.id);
    expect(retry).not.toBeNull();
    expect(await requestGateRetry(r.id, job.id)).toBeNull();
    await runJobs(r.id, [retry!.id], { allowLive: false });
    expect(await requestGateRetry(r.id, retry!.id)).toBeNull();
  });

  it("returns null when the SKU has no alternate product shot", async () => {
    const { r, job } = await successfulJob("fw-knit-top-cocoa", "fw-linen-shirt-white");
    expect(requireSku("fw-knit-top-cocoa").altImage).toBeNull();
    expect(job.status).toBe("success");
    expect(await requestGateRetry(r.id, job.id)).toBeNull();
    expect((await mustGet(r.id)).renders[0].supersededBy).toBeNull();
  });

  it("returns null for a size preview (its button promised 1 credit) and for a card no longer on screen", async () => {
    const r = await createReturn({ skuId: "fw-trench-stone" });
    const [preview] = await scheduleRenders(r.id, [{ skuId: "fw-trench-stone-tall", size: "M", transition: "longer" }], "size_preview");
    await runJobs(r.id, [preview.id], { allowLive: false });
    expect(requireSku("fw-trench-stone-tall").altImage).not.toBeNull();
    expect(await requestGateRetry(r.id, preview.id)).toBeNull();

    const { r: r2, job } = await successfulJob("fw-shift-dress-navy");
    await mutate((db) => {
      db.returns[r2.id].candidates = [candidate("fw-aline-midi-cobalt")]; // the form re-ranked it out
    });
    expect(await requestGateRetry(r2.id, job.id)).toBeNull();
    expect((await mustGet(r2.id)).renders).toHaveLength(1);
  });

  it("returns null at the render cap", async () => {
    process.env.MAX_RENDERS_PER_RETURN = "1";
    const { r, job } = await successfulJob("fw-aline-midi-sage");
    expect(await requestGateRetry(r.id, job.id)).toBeNull();
  });

  it("returns null for jobs that haven't succeeded, unknown jobs and resolved returns", async () => {
    const r = await createReturn();
    const [queued] = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt")], "speculative");
    expect(await requestGateRetry(r.id, queued.id)).toBeNull();
    expect(await requestGateRetry(r.id, "job_nope")).toBeNull();
    expect(await requestGateRetry("ret_nope", queued.id)).toBeNull();

    const { r: r2, job } = await successfulJob("fw-shirt-dress-sage");
    await mutate((db) => {
      db.returns[r2.id].status = "resolved";
    });
    expect(await requestGateRetry(r2.id, job.id)).toBeNull();
  });
});

describe("firstCardAtFor (the shopper's first visible card)", () => {
  it("ignores renders re-ranked out of the candidates and renders the gate dropped", async () => {
    const r = await createReturn({ photoBytes: await synthPhoto("first-card"), candidates: ["fw-aline-midi-cobalt", "fw-wrap-dress-navy"] });
    const [navy] = await scheduleRenders(r.id, [pick("fw-wrap-dress-navy")], "speculative");
    await runJobs(r.id, [navy.id], { allowLive: false });
    const [cobalt] = await scheduleRenders(r.id, [pick("fw-aline-midi-cobalt")], "speculative");
    await runJobs(r.id, [cobalt.id], { allowLive: false });

    const both = await mustGet(r.id);
    const finished = (id: string) => both.renders.find((j) => j.id === id)!.finishedAt;
    expect(both.timeline.firstCardAt).toBe(finished(navy.id)); // navy finished first

    // The form re-ranks: navy is no longer a card on screen.
    expect(firstCardAtFor({ ...both, candidates: [candidate("fw-aline-midi-cobalt")] })).toBe(finished(cobalt.id));

    // A dropped render was never shown either.
    const dropped = structuredClone(both);
    dropped.renders.find((j) => j.id === navy.id)!.gate = {
      verdict: "drop",
      metrics: { colourDeltaE: null, residueFraction: null, silhouetteIoU: null, identityDiff: 0.5, hemErrorCm: null, garmentCoverage: null },
      reasons: [],
      badge: null,
      computedAt: new Date().toISOString(),
      computeMs: 1,
    };
    expect(firstCardAtFor(dropped)).toBe(finished(cobalt.id));
    expect(firstCardAtFor({ ...both, candidates: [] })).toBeNull();
  });
});

describe("idempotency attempts across failures", () => {
  afterEach(() => setProviderOverrides(null));

  function spyProvider(state: { fail: string | null; keys: string[] }): TryOnProvider {
    return {
      name: "dev",
      async render(input: TryOnInput) {
        state.keys.push(input.idempotencyKey);
        if (state.fail) throw new TryOnError(state.fail, `simulated ${state.fail}`, state.fail !== "RENDER_FAILED");
        return { bytes: photo, contentType: "image/jpeg", latencyMs: 5, provider: "dev", externalId: null, creditCharged: false };
      },
    };
  }

  it("moves to a fresh key only after a refunded failure, and remembers it across returns", async () => {
    const state = { fail: "RENDER_FAILED" as string | null, keys: [] as string[] };
    setProviderOverrides({ dev: spyProvider(state) });
    const bytes = await synthPhoto("attempts");

    const a = await createReturn({ photoBytes: bytes });
    const [ja] = await scheduleRenders(a.id, [pick("fw-aline-midi-cobalt")], "speculative");
    await runJobs(a.id, [ja.id], { allowLive: false });
    const K = ja.cacheKey;
    expect(state.keys).toEqual([`tb_${K}`]);
    expect((await readDb()).renderAttempts[K]).toBe(1);

    // Another return with the same photo (e.g. after a demo reset): the replayed failure is avoided.
    // A TIMEOUT may still finish and be charged, so it keeps the key (a re-run replays it for free).
    state.fail = "TIMEOUT";
    const b = await createReturn({ photoBytes: bytes });
    const [jb] = await scheduleRenders(b.id, [pick("fw-aline-midi-cobalt")], "speculative");
    expect(jb.cacheKey).toBe(K);
    await runJobs(b.id, [jb.id], { allowLive: false });
    expect((await readDb()).renderAttempts[K]).toBe(1);

    state.fail = null;
    const [jb2] = await scheduleRenders(b.id, [pick("fw-aline-midi-cobalt")], "post_diagnosis");
    await runJobs(b.id, [jb2.id], { allowLive: false });
    expect(state.keys).toEqual([`tb_${K}`, `tb_${K}_r1`, `tb_${K}_r1`]);
    expect((await mustGet(b.id)).renders.find((j) => j.id === jb2.id)!.status).toBe("success");
  });

  it("moves to a fresh key when a replayed try-on's result has expired (the old key can never produce an image)", async () => {
    const state = { fail: "REPLAY_RESULT_EXPIRED" as string | null, keys: [] as string[] };
    setProviderOverrides({ dev: spyProvider(state) });
    const bytes = await synthPhoto("replay-expired");
    const a = await createReturn({ photoBytes: bytes });
    const [ja] = await scheduleRenders(a.id, [pick("fw-shift-dress-navy")], "speculative");
    await runJobs(a.id, [ja.id], { allowLive: false });
    const K = ja.cacheKey;
    expect((await readDb()).renderAttempts[K]).toBe(1);
    state.fail = null;
    const [jb] = await scheduleRenders(a.id, [pick("fw-shift-dress-navy")], "post_diagnosis");
    await runJobs(a.id, [jb.id], { allowLive: false });
    expect(state.keys).toEqual([`tb_${K}`, `tb_${K}_r1`]);
  });
});

describe("photo integrity and deterministic failures", () => {
  it("refuses to render (and cache) bytes that don't match the recorded photo hash", async () => {
    const r = await createReturn({ photoBytes: await synthPhoto("swap-a") });
    const [job] = await scheduleRenders(r.id, [pick("fw-aline-midi-sage")], "speculative");
    await savePhoto(r.id, await synthPhoto("swap-b")); // a racing upload overwrote the file
    await runJobs(r.id, [job.id], { allowLive: false });
    const after = (await mustGet(r.id)).renders[0];
    expect(after.status).toBe("failed");
    expect(after.error?.code).toBe("PHOTO_MISMATCH");
    expect(await hasRender(job.cacheKey)).toBe(false);
  });

  it("flags SKUs whose render failed for a reason a re-render can't fix", async () => {
    garment.failFor.add("fw-shirt-dress-sage");
    const r = await createReturn({ photoBytes: await synthPhoto("deterministic") });
    const jobs = await scheduleRenders(r.id, [pick("fw-shirt-dress-sage"), pick("fw-aline-midi-cobalt")], "speculative");
    await runJobs(r.id, jobs.map((j) => j.id), { allowLive: false });
    const after = await mustGet(r.id);
    expect(hasDeterministicFailure(after, "fw-shirt-dress-sage")).toBe(true);
    expect(hasDeterministicFailure(after, "fw-aline-midi-cobalt")).toBe(false);
  });

  it("keys renders on the product shot too, so a replaced catalogue image never replays old renders", () => {
    const base = { personHash: photoHash, skuId: "fw-aline-midi-cobalt", garmentVariant: "primary" as const };
    expect(renderCacheKey({ ...base, garmentHash: "a".repeat(64) })).not.toBe(renderCacheKey({ ...base, garmentHash: "b".repeat(64) }));
  });
});
