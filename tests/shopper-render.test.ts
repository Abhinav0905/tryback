// Render smoke tests for the shopper screens (react-dom/server in node, no DOM):
// they catch runtime errors in rendering logic and pin the contract copy.

import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DoneScreen, ExchangeConfirm, RefundConfirm } from "@/components/shopper/ConfirmSteps";
import { CONSENT_COPY, PhotoOfferStep } from "@/components/shopper/PhotoOfferStep";
import { ReasonStep } from "@/components/shopper/ReasonStep";
import { ResultsStep } from "@/components/shopper/ResultsStep";
import { SizeStep } from "@/components/shopper/SizeStep";
import { StyleFormStep } from "@/components/shopper/StyleFormStep";
import { requireSku } from "@/lib/catalog";
import type {
  AppStatus,
  BodyKeypoints,
  Candidate,
  GateResult,
  PhotoMeasurements,
  RenderJob,
  ReturnCase,
} from "@/lib/types";

const T0 = "2026-11-06T12:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const noop = () => undefined;

function render<P extends object>(c: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(h(c as ComponentType<object>, props));
}

const DEV_STATUS: AppStatus = {
  mode: "dev",
  activeProvider: "dev",
  hasClothsyKey: false,
  hasAnthropicKey: false,
  liveRendersToday: 0,
  dailyLiveCap: 40,
  maxRendersPerReturn: 5,
};

const kp = { x: 450, y: 600, visibility: 0.95 };
const KEYPOINTS = Object.fromEntries(
  [
    "nose", "leftEye", "rightEye", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist",
    "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
  ].map((k) => [k, kp]),
) as unknown as BodyKeypoints;

function base(over: Partial<ReturnCase> = {}): ReturnCase {
  return {
    id: "ret_smoke",
    orderId: "1042",
    lineIndex: 0,
    skuId: "fw-wrap-dress-mustard",
    size: "M",
    price: 89,
    status: "reason_selected",
    reason: "style_colour",
    fitComplaints: [],
    chips: [],
    freeText: "",
    consent: { adultAttested: true, at: T0 },
    photo: { url: "/api/photos/ret_smoke", hash: "h", width: 900, height: 1200, uploadedAt: T0 },
    photoSkipped: false,
    preflight: null,
    measurements: null,
    diagnosis: null,
    candidates: [],
    renders: [],
    timeline: { createdAt: T0, reasonAt: T0, photoAt: at(0), formSubmittedAt: null, firstCardAt: null, resolvedAt: null },
    outcome: null,
    creditsSpent: 0,
    simulatedRenders: 0,
    ...over,
  };
}

function gate(verdict: GateResult["verdict"], badge: string | null = null): GateResult {
  return {
    verdict,
    metrics: { colourDeltaE: 3.2, residueFraction: 0.04, silhouetteIoU: 0.81, identityDiff: 0.02, hemErrorCm: null, garmentCoverage: 0.74 },
    reasons: verdict === "drop" ? ["identity drift 0.21 > 0.12"] : [],
    badge,
    computedAt: T0,
    computeMs: 640,
  };
}

let n = 0;
function job(skuId: string, over: Partial<RenderJob> = {}): RenderJob {
  n += 1;
  return {
    id: `job_${n}`,
    returnId: "ret_smoke",
    skuId,
    size: "M",
    phase: "post_diagnosis",
    transition: "colour_only",
    garmentVariant: "primary",
    status: "success",
    provider: "dev",
    fromCache: false,
    cacheKey: `k${n}`,
    queuedAt: at(n),
    startedAt: at(n),
    finishedAt: at(n + 8),
    latencyMs: 8000,
    resultUrl: `/api/renders/k${n}`,
    error: null,
    creditCharged: false,
    gate: null,
    retryOf: null,
    supersededBy: null,
    externalId: null,
    ...over,
  };
}

const cand = (skuId: string, why: string, priceDiff = 0): Candidate => ({
  skuId,
  size: "M",
  transition: "colour_only",
  score: 1,
  fixes: ["colour"],
  why,
  priceDiff,
});

describe("shopper screens render", () => {
  it("reason step shows the three options", () => {
    const html = render(ReasonStep, { r: base({ status: "started", reason: null }), sku: requireSku("fw-wrap-dress-mustard"), onDone: noop });
    expect(html).toContain("Style or colour didn&#x27;t work");
    expect(html).toContain("Fit or size");
    expect(html).toContain("Something else");
  });

  it("photo offer carries the consent copy and both pitches", () => {
    const sku = requireSku("fw-wrap-dress-mustard");
    const props = {
      sku,
      consented: false,
      onConsentChange: noop,
      onTakePhoto: noop,
      onFile: noop,
      onSkipped: noop,
      onBack: noop,
      backLabel: "Change reason",
    };
    const style = render(PhotoOfferStep, { ...props, r: base({ photo: null }) });
    expect(style).toContain("See 3 swaps on you");
    expect(style).toContain("+$10 exchange bonus");
    expect(style).toContain(CONSENT_COPY.replace(/'/g, "&#x27;"));
    expect(style).toContain("Take photo");
    expect(style).toContain("Upload photo");
    expect(style).toContain("Skip photo");
    const fit = render(PhotoOfferStep, { ...props, r: base({ photo: null, reason: "fit_size" }) });
    expect(fit).toContain("We&#x27;ll measure the other sizes on the photo");
    expect(fit).toContain("No AI needed");
  });

  it("style form shows the honest clock and skeletons while speculative renders run", () => {
    const r = base({
      status: "photo_uploaded",
      renders: [
        job("fw-wrap-dress-emerald", { phase: "speculative", status: "running", resultUrl: null, provider: null }),
        job("fw-aline-midi-cobalt", { phase: "speculative" }),
      ],
    });
    const html = render(StyleFormStep, { r, sku: requireSku("fw-wrap-dress-mustard"), onDone: noop });
    expect(html).toContain("Renders started at photo upload");
    expect(html).toContain("Colour isn&#x27;t me");
    expect(html).toContain("Rendering");
    expect(html).toContain("Ready");
  });

  it("results show pinned photo, gate states, provider labels and hidden drops", () => {
    const original = job("fw-wrap-dress-navy", { gate: gate("retry"), phase: "speculative" });
    const retry = job("fw-wrap-dress-navy", { phase: "retry", garmentVariant: "alt", retryOf: original.id, status: "running", resultUrl: null, provider: null });
    original.supersededBy = retry.id;
    const r = base({
      status: "form_submitted",
      timeline: { createdAt: T0, reasonAt: T0, photoAt: at(0), formSubmittedAt: at(24), firstCardAt: at(27), resolvedAt: null },
      diagnosis: { issues: [{ type: "colour", confidence: 0.9, evidence: "chip" }], keepAttributes: ["silhouette"], summary: "The shape worked; the colour didn't.", source: "rules" },
      candidates: [
        cand("fw-wrap-dress-emerald", "Same wrap, in emerald"),
        cand("fw-wrap-dress-navy", "Same wrap, in navy"),
        cand("fw-aline-midi-cobalt", "Looser A-line in cobalt"),
        cand("fw-shift-dress-navy", "Easy shift in navy", -4),
        cand("fw-shirt-dress-sage", "Shirt dress in sage", 6),
      ],
      renders: [
        job("fw-wrap-dress-emerald", { gate: gate("pass"), phase: "speculative" }),
        original,
        retry,
        job("fw-aline-midi-cobalt", { gate: gate("drop") }),
        job("fw-shift-dress-navy", { gate: gate("badge", "Colour preview · silhouette approximate"), provider: "clothsy" }),
      ],
    });
    const html = render(ResultsStep, { r, sku: requireSku("fw-wrap-dress-mustard"), onSwap: noop, onAddPhoto: noop });
    expect(html).toContain("What you have now");
    expect(html).toContain("The shape worked; the colour didn&#x27;t.");
    expect(html).toContain("Checked");
    expect(html).toContain("Re-checking…");
    expect(html).toContain("Colour preview · silhouette approximate");
    expect(html).toContain("Simulated preview");
    expect(html).toContain("AI-generated preview");
    expect(html).toContain("1 preview didn&#x27;t pass our quality check");
    expect(html).toContain("Product photo"); // shirt dress was never rendered
    expect(html).toContain("Swap for this");
    expect(html).toContain('role="slider"');
    expect(html).toContain("form done 0:24 · first card 0:27 (3 s after form)");
    expect(html).not.toContain("Looser A-line in cobalt"); // dropped card stays collapsed
  });

  it("no-photo results use catalogue imagery", () => {
    const r = base({
      photo: null,
      photoSkipped: true,
      status: "form_submitted",
      timeline: { createdAt: T0, reasonAt: T0, photoAt: null, formSubmittedAt: at(20), firstCardAt: null, resolvedAt: null },
      candidates: [cand("fw-wrap-dress-emerald", "Same wrap, in emerald")],
    });
    const html = render(ResultsStep, { r, sku: requireSku("fw-wrap-dress-mustard"), onSwap: noop, onAddPhoto: noop });
    expect(html).toContain("Product photos · 0 credits");
    expect(html).toContain("Want to see these on you?");
    expect(html).not.toContain("Renders started at photo upload");
  });

  it("size path draws measured lines, options and the grading callout", () => {
    const sku = requireSku("fw-linen-shirt-white");
    const measurements: PhotoMeasurements = {
      keypoints: KEYPOINTS,
      calibration: {
        method: "garment",
        pxPerCm: 6,
        uncertaintyCm: 1.5,
        hpsY: 200,
        observedHemY: 200 + sku.poms.M.hpsToHemCm * 6,
        observedSleeveEnd: null,
        centerX: 450,
        hemHalfWidthPx: 160,
        purchasedSize: "M",
        purchasedPom: sku.poms.M,
        imageWidth: 900,
        imageHeight: 1200,
      },
      easeRatio: 1.2,
      hemCm: null,
      garmentMaskArea: 0.3,
      observedGarmentLab: null,
    };
    const r = base({ skuId: sku.id, price: 59, reason: "fit_size", fitComplaints: ["too_short"], measurements, status: "photo_uploaded" });
    const html = render(SizeStep, { r, sku, status: DEV_STATUS, onSwap: noop, onApply: noop, onAddPhoto: noop });
    expect(html).toContain("Try-on can&#x27;t show size, so we don&#x27;t fake it");
    expect(html).toContain("What you&#x27;re wearing · M");
    expect(html).toContain("<svg");
    expect(html).toContain("Recommended");
    expect(html).toContain("Why not just size up?");
    expect(html).toContain("Swap to M Tall");
    expect(html).toContain("Preview on me (simulated · 0 credits)");

    const tableOnly = render(SizeStep, {
      r: { ...r, measurements: { ...measurements, calibration: null } },
      sku,
      status: DEV_STATUS,
      onSwap: noop,
      onApply: noop,
      onAddPhoto: noop,
    });
    expect(tableOnly).toContain("We couldn&#x27;t measure on this photo");
    expect(tableOnly).not.toContain("<figure");
  });

  it("confirm and done screens", () => {
    const sku = requireSku("fw-wrap-dress-mustard");
    const r = base({ status: "form_submitted" });
    const ex = render(ExchangeConfirm, { r, from: sku, target: { skuId: "fw-wrap-dress-emerald", size: "M", jobId: null }, onBack: noop, onDone: noop });
    expect(ex).toContain("Ships today (instant exchange)");
    expect(ex).toContain("No price difference");
    expect(ex).toContain("Confirm exchange");

    const refund = render(RefundConfirm, { r, sku, onBack: noop, backLabel: "Back", onDone: noop });
    expect(refund).toContain("Confirm refund");
    expect(refund).toContain("$89");

    const doneEx = render(DoneScreen, {
      r: { ...r, status: "resolved", outcome: { type: "exchange", skuId: "fw-wrap-dress-emerald", size: "M", priceDiff: 0, retainedRevenue: 89, at: at(60) } },
      sku,
    });
    expect(doneEx).toContain("Exchange confirmed — your new item ships today");
    expect(doneEx).not.toContain("refund was avoided"); // merchant wording stays on the merchant toast
    const doneRefund = render(DoneScreen, {
      r: { ...r, status: "resolved", outcome: { type: "refund", skuId: null, size: null, priceDiff: 0, retainedRevenue: 0, at: at(60) } },
      sku,
    });
    expect(doneRefund).toContain("Refund requested");
  });
});

describe("SizeLinesOverlay", () => {
  it("labels a hem that falls outside the photo as such, without drawing a line for it", async () => {
    const { SizeLinesOverlay } = await import("@/components/shopper/SizeLinesOverlay");
    const cal = {
      method: "garment" as const, pxPerCm: 6, uncertaintyCm: 1.5, hpsY: 300, observedHemY: 1180, observedSleeveEnd: null,
      centerX: 450, hemHalfWidthPx: 120, purchasedSize: "M" as const,
      purchasedPom: { hpsToHemCm: 98, sleeveCm: 58, halfChestCm: 46 }, imageWidth: 900, imageHeight: 1200,
    };
    const line = (label: string, hemY: number) => ({
      key: label,
      tone: "recommended" as const,
      line: { skuId: "fw-wrap-dress-mustard-tall", size: "M" as const, lengthVariant: "tall" as const, hemY, bandPx: 9, deltaHemCm: 6, label },
    });
    const html = render(SizeLinesOverlay, {
      photoUrl: "/api/photos/x",
      alt: "photo",
      cal,
      wearingLabel: "What you're wearing · M",
      lines: [line("M Tall · +6 cm", 1180 + 36)], // below the 1200 px frame
    });
    expect(html).toContain("M Tall · +6 cm · below photo ↓");
    expect(html).toContain("ends below the photo");
    expect(html).not.toMatch(/y[12]="1216"/); // no line or connector drawn at the off-frame hem
  });
});
