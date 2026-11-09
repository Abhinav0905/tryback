import { describe, expect, it } from "vitest";
import {
  ALL_PHASES,
  CAPTURE_ASPECT,
  POLL_FAST_MS,
  POLL_MAX_BACKOFF_MS,
  POLL_SLOW_MS,
  baseStep,
  canRetryJob,
  cardViewFor,
  centerCropRect,
  gateBadgeFor,
  gateableJobs,
  headJob,
  honestClockLine,
  layoutLabels,
  liveLockedFor,
  nextPollDelay,
  offsetKeypoints,
  parseHeightCm,
  pickNextGateJob,
  renderBudgetUsed,
  stepIndexFor,
  stepsFor,
  unavailableGate,
  viewStep,
} from "@/components/shopper/flow";
import {
  formatClock,
  priceDiffLabel,
  priceDiffSentence,
  signedCm,
  sizeVariantLabel,
  stockInfo,
} from "@/components/shopper/format";
import { requireSku } from "@/lib/catalog";
import type { AppStatus, BodyKeypoints, GateResult, PhotoMeasurements, RenderJob, ReturnCase } from "@/lib/types";

/* ───────────── fixtures ───────────── */

const T0 = "2026-11-06T12:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

function makeReturn(over: Partial<ReturnCase> = {}): ReturnCase {
  return {
    id: "ret_test",
    orderId: "1042",
    lineIndex: 0,
    skuId: "fw-wrap-dress-mustard",
    size: "M",
    price: 89,
    status: "started",
    reason: null,
    fitComplaints: [],
    chips: [],
    freeText: "",
    consent: null,
    photo: null,
    photoSkipped: false,
    preflight: null,
    measurements: null,
    diagnosis: null,
    candidates: [],
    renders: [],
    timeline: {
      createdAt: T0,
      reasonAt: null,
      photoAt: null,
      formSubmittedAt: null,
      firstCardAt: null,
      resolvedAt: null,
    },
    outcome: null,
    creditsSpent: 0,
    simulatedRenders: 0,
    ...over,
  };
}

const PHOTO = { url: "/api/photos/ret_test", hash: "h", width: 900, height: 1200, uploadedAt: T0 };
const MEASUREMENTS = { calibration: null } as unknown as PhotoMeasurements;

function gate(verdict: GateResult["verdict"], badge: string | null = null): GateResult {
  return {
    verdict,
    metrics: {
      colourDeltaE: 4,
      residueFraction: null,
      silhouetteIoU: 0.8,
      identityDiff: 0.02,
      hemErrorCm: null,
      garmentCoverage: 0.7,
    },
    reasons: [],
    badge,
    computedAt: T0,
    computeMs: 420,
  };
}

let seq = 0;
function job(over: Partial<RenderJob> = {}): RenderJob {
  seq += 1;
  return {
    id: `job_${seq}`,
    returnId: "ret_test",
    skuId: "fw-wrap-dress-emerald",
    size: "M",
    phase: "speculative",
    transition: "colour_only",
    garmentVariant: "primary",
    status: "queued",
    provider: null,
    fromCache: false,
    cacheKey: `key_${seq}`,
    queuedAt: at(seq),
    startedAt: null,
    finishedAt: null,
    latencyMs: null,
    resultUrl: null,
    error: null,
    creditCharged: false,
    gate: null,
    retryOf: null,
    supersededBy: null,
    externalId: null,
    ...over,
  };
}

function success(over: Partial<RenderJob> = {}): RenderJob {
  const j = job({ status: "success", provider: "dev", ...over });
  return { ...j, resultUrl: j.resultUrl ?? `/api/renders/${j.cacheKey}`, finishedAt: j.finishedAt ?? j.queuedAt };
}

/* ───────────── steps ───────────── */

describe("baseStep / viewStep", () => {
  it("walks the style path", () => {
    expect(baseStep(makeReturn())).toBe("reason");
    expect(baseStep(makeReturn({ reason: "style_colour" }))).toBe("photo_offer");
    expect(baseStep(makeReturn({ reason: "style_colour", photo: PHOTO }))).toBe("style_form");
    expect(baseStep(makeReturn({ reason: "style_colour", photoSkipped: true }))).toBe("style_form");
    const formDone = makeReturn({
      reason: "style_colour",
      photo: PHOTO,
      timeline: { ...makeReturn().timeline, formSubmittedAt: at(20) },
    });
    expect(baseStep(formDone)).toBe("results");
  });

  it("walks the size path and the other path", () => {
    expect(baseStep(makeReturn({ reason: "fit_size" }))).toBe("photo_offer");
    expect(baseStep(makeReturn({ reason: "fit_size", photo: PHOTO }))).toBe("size");
    expect(baseStep(makeReturn({ reason: "fit_size", photoSkipped: true }))).toBe("size");
    expect(baseStep(makeReturn({ reason: "other" }))).toBe("refund_confirm");
  });

  it("resolved always wins, even over overlays", () => {
    const r = makeReturn({ reason: "style_colour", status: "resolved" });
    expect(baseStep(r)).toBe("done");
    expect(viewStep(r, { kind: "refund_confirm", from: "skip" })).toBe("done");
  });

  it("overlays sit on top of the base step", () => {
    const r = makeReturn({ reason: "style_colour" });
    expect(viewStep(r, null)).toBe("photo_offer");
    expect(viewStep(r, { kind: "capture", source: "camera", file: null })).toBe("capture");
    expect(viewStep(r, { kind: "refund_confirm", from: "skip" })).toBe("refund_confirm");
    expect(viewStep(r, { kind: "exchange", skuId: "x", size: "M", jobId: null })).toBe("exchange");
    expect(viewStep(r, { kind: "reason" })).toBe("reason");
  });

  it("maps views onto the step indicator for each reason", () => {
    const style = stepsFor("style_colour");
    expect(style.map((s) => s.id)).toEqual(["reason", "photo", "details", "swaps", "confirm"]);
    expect(stepIndexFor("capture", style)).toBe(1);
    expect(stepIndexFor("results", style)).toBe(3);
    expect(stepIndexFor("exchange", style)).toBe(4);
    const fit = stepsFor("fit_size");
    expect(stepIndexFor("size", fit)).toBe(2);
    expect(stepsFor("other").map((s) => s.id)).toEqual(["reason", "confirm"]);
    expect(stepIndexFor("refund_confirm", stepsFor(null))).toBe(3);
  });
});

/* ───────────── polling ───────────── */

describe("nextPollDelay", () => {
  it("polls fast while a job is queued or running, slow otherwise", () => {
    expect(nextPollDelay(makeReturn({ renders: [job({ status: "running" })] }), 0)).toBe(POLL_FAST_MS);
    expect(nextPollDelay(makeReturn({ renders: [job({ status: "queued" })] }), 0)).toBe(POLL_FAST_MS);
    expect(nextPollDelay(makeReturn({ renders: [success()] }), 0)).toBe(POLL_SLOW_MS);
    expect(nextPollDelay(makeReturn(), 0)).toBe(POLL_SLOW_MS);
  });

  it("stops when resolved and backs off on errors", () => {
    expect(nextPollDelay(makeReturn({ status: "resolved" }), 0)).toBeNull();
    expect(nextPollDelay(makeReturn({ status: "resolved" }), 3)).toBeNull();
    expect(nextPollDelay(null, 0)).toBe(POLL_FAST_MS);
    expect(nextPollDelay(makeReturn(), 1)).toBe(3000);
    expect(nextPollDelay(makeReturn(), 2)).toBe(6000);
    expect(nextPollDelay(makeReturn(), 10)).toBe(POLL_MAX_BACKOFF_MS);
  });
});

/* ───────────── gate runner selection ───────────── */

function candidate(skuId: string): ReturnCase["candidates"][number] {
  return { skuId, size: "M", transition: "colour_only", score: 1, fixes: [], why: "", priceDiff: 0 };
}

/** After the form: these SKUs are the cards on screen. */
function shown(...skuIds: string[]): Partial<ReturnCase> {
  return {
    candidates: skuIds.map(candidate),
    timeline: { ...makeReturn().timeline, photoAt: at(0), formSubmittedAt: at(20) },
  };
}

describe("gate runner selection", () => {
  it("only gates successful, ungated, non-superseded jobs with an image", () => {
    const ok = success({ finishedAt: at(30) });
    const r = makeReturn({
      ...shown("fw-wrap-dress-emerald"),
      photo: PHOTO,
      measurements: MEASUREMENTS,
      renders: [
        job({ status: "running" }),
        success({ gate: gate("pass") }),
        success({ supersededBy: "job_x" }),
        job({ status: "success", resultUrl: null }),
        ok,
      ],
    });
    expect(gateableJobs(r).map((j) => j.id)).toEqual([ok.id]);
    expect(pickNextGateJob(r, new Set())?.id).toBe(ok.id);
    expect(pickNextGateJob(r, new Set([ok.id]))).toBeNull();
  });

  it("picks the oldest finished job first and needs a photo + measurements", () => {
    const late = success({ finishedAt: at(50) });
    const early = success({ finishedAt: at(40) });
    const r = makeReturn({ ...shown("fw-wrap-dress-emerald"), photo: PHOTO, measurements: MEASUREMENTS, renders: [late, early] });
    expect(pickNextGateJob(r, new Set())?.id).toBe(early.id);
    expect(pickNextGateJob({ ...r, measurements: null }, new Set())).toBeNull();
    expect(pickNextGateJob({ ...r, photo: null }, new Set())).toBeNull();
  });

  it("gates only cards on screen: after the form, candidates only, in rank order; size previews always", () => {
    const navy = success({ skuId: "fw-wrap-dress-navy", finishedAt: at(10) }); // speculative, re-ranked out
    const cobalt = success({ skuId: "fw-aline-midi-cobalt", finishedAt: at(40) });
    const black = success({ skuId: "fw-aline-midi-black", finishedAt: at(30) });
    const base = { photo: PHOTO, measurements: MEASUREMENTS, renders: [navy, cobalt, black] };

    // Before the form the shopper sees no cards: nothing is gated (no retry spent on a pick that may drop out).
    const beforeForm = makeReturn({ ...base, candidates: [candidate("fw-wrap-dress-navy"), candidate("fw-aline-midi-black")] });
    expect(gateableJobs(beforeForm)).toEqual([]);

    const r = makeReturn({ ...base, ...shown("fw-aline-midi-cobalt", "fw-aline-midi-black") });
    expect(gateableJobs(r).map((j) => j.skuId).sort()).toEqual(["fw-aline-midi-black", "fw-aline-midi-cobalt"]);
    expect(pickNextGateJob(r, new Set())?.id).toBe(cobalt.id); // rank 1 first, though black finished earlier
    expect(pickNextGateJob(r, new Set([cobalt.id]))?.id).toBe(black.id);

    const preview = success({ skuId: "fw-linen-shirt-white-tall", phase: "size_preview" });
    const size = makeReturn({ photo: PHOTO, measurements: MEASUREMENTS, reason: "fit_size", renders: [preview] });
    expect(pickNextGateJob(size, new Set())?.id).toBe(preview.id);
  });

  it("mirrors the server's retry preconditions", () => {
    const j = success({ skuId: "fw-wrap-dress-emerald" }); // wrap dress has an alt image
    const r = makeReturn({ ...shown("fw-wrap-dress-emerald"), renders: [j, job({ status: "skipped" })] });
    expect(renderBudgetUsed(r)).toBe(1);
    expect(canRetryJob(r, j, 5)).toBe(true);
    expect(canRetryJob(r, j, 1)).toBe(false); // at cap
    expect(canRetryJob(r, { ...j, retryOf: "job_0" }, 5)).toBe(false);
    expect(canRetryJob(r, { ...j, supersededBy: "job_9" }, 5)).toBe(false);
    const noAlt = success({ skuId: "fw-knit-top-cocoa" }); // knit top has no alt image
    expect(canRetryJob(makeReturn({ ...shown("fw-knit-top-cocoa"), renders: [noAlt] }), noAlt, 5)).toBe(false);
    // Not a card on screen any more (re-ranked out): no retry.
    expect(canRetryJob(makeReturn({ ...shown("fw-aline-midi-cobalt"), renders: [j] }), j, 5)).toBe(false);
    // Size previews never retry: the button promised 1 credit.
    const preview = success({ skuId: "fw-trench-stone-tall", phase: "size_preview" }); // trench has an alt image
    expect(requireSku("fw-trench-stone-tall").altImage).not.toBeNull();
    expect(canRetryJob(makeReturn({ renders: [preview] }), preview, 5)).toBe(false);
  });

  it("builds an honest, schema-safe fallback gate", () => {
    const g = unavailableGate("x".repeat(400), -5, T0);
    expect(g.verdict).toBe("badge");
    expect(g.badge).toBe("Preview not auto-checked");
    expect(g.reasons[0].length).toBeLessThanOrEqual(300);
    expect(g.computeMs).toBe(0);
    expect(Object.values(g.metrics).every((v) => v === null)).toBe(true);
  });
});

/* ───────────── render cards ───────────── */

describe("cardViewFor", () => {
  const SKU = "fw-wrap-dress-emerald";
  const base = { photo: PHOTO, measurements: MEASUREMENTS };

  it("shows catalogue imagery without a photo or without a job", () => {
    expect(cardViewFor(makeReturn(), SKU, "M")).toMatchObject({ kind: "catalog", why: "no_photo" });
    expect(cardViewFor(makeReturn(base), SKU, "M")).toMatchObject({ kind: "catalog", why: "not_rendered" });
  });

  it("walks rendering → checking → ready (pass / badge) → dropped", () => {
    expect(cardViewFor(makeReturn({ ...base, renders: [job({ skuId: SKU, status: "running" })] }), SKU, "M").kind).toBe(
      "rendering",
    );
    expect(cardViewFor(makeReturn({ ...base, renders: [success({ skuId: SKU })] }), SKU, "M").kind).toBe("checking");

    const pass = cardViewFor(makeReturn({ ...base, renders: [success({ skuId: SKU, gate: gate("pass") })] }), SKU, "M");
    expect(pass).toMatchObject({ kind: "ready", badgeText: null });
    expect(gateBadgeFor(pass)).toMatchObject({ tone: "ok", text: "Checked" });

    const badge = cardViewFor(
      makeReturn({ ...base, renders: [success({ skuId: SKU, gate: gate("badge", "Colour preview · silhouette approximate") })] }),
      SKU,
      "M",
    );
    expect(gateBadgeFor(badge)).toMatchObject({ tone: "warn", text: "Colour preview · silhouette approximate" });

    const noText = cardViewFor(makeReturn({ ...base, renders: [success({ skuId: SKU, gate: gate("badge") })] }), SKU, "M");
    expect(gateBadgeFor(noText)?.text).toBe("Preview approximate");

    const dropped = cardViewFor(makeReturn({ ...base, renders: [success({ skuId: SKU, gate: gate("drop") })] }), SKU, "M");
    expect(dropped.kind).toBe("dropped");
  });

  it("shows Re-checking… while a gate-triggered retry runs", () => {
    const original = success({ skuId: SKU, gate: gate("retry") });
    const retry = job({ skuId: SKU, phase: "retry", garmentVariant: "alt", retryOf: original.id, status: "running" });
    original.supersededBy = retry.id;
    const view = cardViewFor(makeReturn({ ...base, renders: [original, retry] }), SKU, "M");
    expect(view).toMatchObject({ kind: "rendering", retrying: true });
    expect(gateBadgeFor(view)).toMatchObject({ tone: "info", text: "Re-checking…" });

    const retryDone = { ...retry, status: "success" as const, resultUrl: "/api/renders/r2" };
    const checking = cardViewFor(makeReturn({ ...base, renders: [original, retryDone] }), SKU, "M");
    expect(gateBadgeFor(checking)?.text).toBe("Re-checking…");
  });

  it("falls back to the original render (badged) when the retry fails", () => {
    const original = success({ skuId: SKU, gate: gate("retry", "Fit approximate") });
    const retry = job({ skuId: SKU, phase: "retry", retryOf: original.id, status: "failed" });
    original.supersededBy = retry.id;
    const view = cardViewFor(makeReturn({ ...base, renders: [original, retry] }), SKU, "M");
    expect(view).toMatchObject({ kind: "ready", badgeText: "Fit approximate" });
    expect(view.job?.id).toBe(original.id);
  });

  it("hides the original when the retry fails and the original failed severely", () => {
    const original = success({ skuId: SKU, gate: { ...gate("retry"), fallbackVerdict: "drop" } });
    const retry = job({ skuId: SKU, phase: "retry", retryOf: original.id, status: "failed" });
    original.supersededBy = retry.id;
    const view = cardViewFor(makeReturn({ ...base, renders: [original, retry] }), SKU, "M");
    expect(view).toMatchObject({ kind: "dropped" });
    expect(view.job?.id).toBe(original.id);
  });

  it("separates size previews from swap renders", () => {
    const preview = success({ skuId: SKU, phase: "size_preview", gate: gate("pass") });
    const r = makeReturn({ ...base, renders: [preview] });
    expect(cardViewFor(r, SKU, "M").kind).toBe("catalog");
    expect(cardViewFor(r, SKU, "M", ["size_preview"]).kind).toBe("ready");
  });

  it("matches size previews per SKU regardless of size (server dedupes renders per garment)", () => {
    const tall = "fw-linen-shirt-white-tall";
    const preview = success({ skuId: tall, size: "M", phase: "size_preview", gate: gate("pass") });
    const r = makeReturn({ ...base, skuId: "fw-linen-shirt-white", reason: "fit_size", renders: [preview] });
    expect(cardViewFor(r, tall, "L", ALL_PHASES).kind).toBe("catalog");
    expect(cardViewFor(r, tall, null, ALL_PHASES)).toMatchObject({ kind: "ready" });
    expect(cardViewFor(r, "fw-linen-shirt-sky-tall", null, ALL_PHASES).kind).toBe("catalog");
  });

  it("headJob prefers the live end of a chain", () => {
    const a = success({ supersededBy: "b" });
    const b = job({ id: "b", retryOf: a.id });
    expect(headJob([a, b])?.id).toBe("b");
    expect(headJob([])).toBeNull();
  });
});

/* ───────────── honest clock ───────────── */

describe("honestClockLine", () => {
  const tl = makeReturn().timeline;

  it("is null without a photo", () => {
    expect(honestClockLine(tl, Date.parse(at(10)))).toBeNull();
  });

  it("reads like the contract example", () => {
    const line = honestClockLine({ ...tl, photoAt: at(0), formSubmittedAt: at(24), firstCardAt: at(27) }, 0);
    expect(line).toBe("Renders started at photo upload · form done 0:24 · first card 0:27 (3 s after form)");
  });

  it("handles a first card that beat the form, and a pending first card", () => {
    expect(honestClockLine({ ...tl, photoAt: at(0), formSubmittedAt: at(30), firstCardAt: at(18) }, 0)).toContain(
      "first card 0:18 (ready before the form was done)",
    );
    expect(honestClockLine({ ...tl, photoAt: at(0), formSubmittedAt: at(30) }, Date.parse(at(41)))).toBe(
      "Renders started at photo upload · form done 0:30 · first card rendering · 0:41",
    );
  });

  it("stops when nothing is rendering and no card came", () => {
    expect(honestClockLine({ ...tl, photoAt: at(0), formSubmittedAt: at(30) }, Date.parse(at(900)), { rendering: false })).toBe(
      "Renders started at photo upload · form done 0:30 · no previews could be shown",
    );
  });

  it("times a photo added after the form from the photo only", () => {
    // Skip photo → form at 0:20 → browse → "Add photo" at 0:26 → first card at 0:27.
    const line = honestClockLine({ ...tl, formSubmittedAt: at(20), photoAt: at(26), firstCardAt: at(27) }, 0);
    expect(line).toBe("Renders started at photo upload · first card 0:01");
  });
});

/* ───────────── geometry helpers ───────────── */

describe("geometry helpers", () => {
  it("centre-crops to 3:4 like object-fit: cover", () => {
    expect(centerCropRect(1920, 1080, CAPTURE_ASPECT)).toEqual({ x: 555, y: 0, width: 810, height: 1080 });
    expect(centerCropRect(1080, 1920, CAPTURE_ASPECT)).toEqual({ x: 0, y: 240, width: 1080, height: 1440 });
    expect(centerCropRect(0, 100, CAPTURE_ASPECT).width).toBe(0);
  });

  it("offsets every keypoint", () => {
    const p = { x: 100, y: 200, visibility: 0.9 };
    const names: (keyof BodyKeypoints)[] = [
      "nose", "leftEye", "rightEye", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist",
      "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
    ];
    const kp = Object.fromEntries(names.map((n) => [n, p])) as unknown as BodyKeypoints;
    const out = offsetKeypoints(kp, 40, 10);
    expect(out.leftAnkle).toEqual({ x: 60, y: 190, visibility: 0.9 });
    expect(Object.keys(out)).toHaveLength(15);
  });

  it("lays labels out without overlaps, in order, inside bounds", () => {
    const ys = layoutLabels([100, 102, 104, 400], 20, 10, 500);
    expect(ys[0]).toBe(100);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(20);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(20);
    expect(ys[3]).toBe(400);
    const crowdedBottom = layoutLabels([495, 496, 497], 20, 0, 500);
    expect(Math.max(...crowdedBottom)).toBeLessThanOrEqual(500);
    expect(crowdedBottom[1] - crowdedBottom[0]).toBeGreaterThanOrEqual(20);
    expect(layoutLabels([-50], 10, 5, 100)).toEqual([5]);
  });

  it("parses an optional height", () => {
    expect(parseHeightCm("")).toBeNull();
    expect(parseHeightCm("168")).toBe(168);
    expect(parseHeightCm(" 172,5 ")).toBe(172.5);
    expect(parseHeightCm("5'6")).toBeNull();
    expect(parseHeightCm("90")).toBeNull();
  });
});

/* ───────────── formatting ───────────── */

describe("format", () => {
  it("formats clocks", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7_900)).toBe("0:07");
    expect(formatClock(84_000)).toBe("1:24");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("labels price differences kindly", () => {
    expect(priceDiffLabel(0)).toBe("Same price");
    expect(priceDiffLabel(6)).toBe("$6 more");
    expect(priceDiffLabel(-10)).toBe("$10 back");
    expect(priceDiffSentence(0)).toBe("No price difference");
    expect(priceDiffSentence(6)).toBe("You pay $6 more");
    expect(priceDiffSentence(-10)).toBe("We refund the $10 difference");
  });

  it("describes stock", () => {
    const ecru = requireSku("fw-shirt-dress-ecru"); // inventory M = 0, XS = 1
    expect(stockInfo(ecru, "M")).toMatchObject({ inStock: false, tone: "bad", text: "Out of stock in M" });
    expect(stockInfo(ecru, "XS")).toMatchObject({ inStock: true, tone: "warn", text: "Only 1 left in XS" });
    expect(stockInfo(requireSku("fw-wrap-dress-emerald"), "M")).toMatchObject({ inStock: true, tone: "ok" });
  });

  it("formats signed centimetres and size labels", () => {
    expect(signedCm(6)).toBe("+6 cm");
    expect(signedCm(-1.5)).toBe("−1.5 cm");
    expect(signedCm(0.01)).toBe("±0 cm");
    expect(sizeVariantLabel("M", "regular")).toBe("M");
    expect(sizeVariantLabel("M", "tall")).toBe("M Tall");
  });
});

describe("liveLockedFor (judge unlock + mode pill)", () => {
  const base: AppStatus = {
    mode: "auto",
    activeProvider: "dev",
    hasClothsyKey: true,
    hasAnthropicKey: false,
    liveRendersToday: 3,
    dailyLiveCap: 40,
    maxRendersPerReturn: 5,
  };
  it("is true only when a key exists, live mode applies, the cap isn't hit, yet renders would be simulated", () => {
    expect(liveLockedFor(base)).toBe(true);
    expect(liveLockedFor({ ...base, mode: "live" })).toBe(true);
    expect(liveLockedFor(null)).toBe(false);
    expect(liveLockedFor({ ...base, activeProvider: "clothsy" })).toBe(false);
    expect(liveLockedFor({ ...base, hasClothsyKey: false })).toBe(false);
    expect(liveLockedFor({ ...base, mode: "replay" })).toBe(false);
    expect(liveLockedFor({ ...base, mode: "dev" })).toBe(false);
    expect(liveLockedFor({ ...base, liveRendersToday: 40 })).toBe(false);
  });
});
