// scripts/probe.ts pure logic: options, consent flag, plan and budget, photo checks, image
// analysis and the report. No network, no credits, no person photos (synthetic pixels only).

import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSku } from "@/lib/catalog";
import { REPLAY_HEADER_CANDIDATES } from "@/lib/tryon/clothsy";
import {
  DEFAULT_MAX_CREDITS,
  MIN_PERSON_SHORT_SIDE,
  UsageError,
  aspectDeltaPct,
  buildPlan,
  buildRecommendations,
  creditDecision,
  describeJsonShape,
  extensionFor,
  hasAiLabel,
  jpegOrPng,
  paddingVerdict,
  parseProbeArgs,
  personLabels,
  PROBE_SKU_PREFERENCE,
  suggestProbeSkus,
  renderBudgetFor,
  renderReport,
  replayVerdict,
  uniformSides,
  validatePersonPhoto,
  type ObservedRender,
  type ProbeObserved,
} from "@/scripts/lib/probe-core";

const ROOT = "/repo";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Uint8Array.from(Buffer.from("RIFF0000WEBPVP8 "));

describe("parseProbeArgs", () => {
  it("defaults: --max-credits 4, no consent, no replay check, report files under probe/", () => {
    const o = parseProbeArgs([], ROOT)!;
    expect(DEFAULT_MAX_CREDITS).toBe(4);
    expect(o.maxCredits).toBe(4);
    expect(o.consent).toBe(false);
    expect(o.checkReplay).toBe(false);
    // No --skus: the probe picks photographed SKUs at run time (suggestProbeSkus), never drawings by default.
    expect(o.skuIds).toBeNull();
    expect(o.allowDrawings).toBe(false);
    expect(o.reportFile).toBe(path.resolve(ROOT, "probe/REPORT.md"));
    expect(o.observedFile).toBe(path.resolve(ROOT, "probe/observed.json"));
    expect(o.peopleDir).toBe(path.resolve(ROOT, "probe/people"));
  });

  it("reads --i-have-consent, --check-replay, --skip-credit-check and the variant", () => {
    const o = parseProbeArgs(["--i-have-consent", "--check-replay", "--skip-credit-check", "--variant", "both", "--max-credits", "7"], ROOT)!;
    expect(o).toMatchObject({ consent: true, checkReplay: true, skipCreditCheck: true, maxCredits: 7, variants: ["primary", "alt"] });
    const p = parseProbeArgs(["--skus", "fw-shift-dress-navy, fw-shirt-dress-rust,fw-shift-dress-navy", "--allow-drawings"], ROOT)!;
    expect(p).toMatchObject({ skuIds: ["fw-shift-dress-navy", "fw-shirt-dress-rust"], allowDrawings: true });
  });

  it("rejects bad input with UsageError, and --help returns null", () => {
    expect(parseProbeArgs(["--help"], ROOT)).toBeNull();
    expect(() => parseProbeArgs(["--max-credits", "-1"], ROOT)).toThrow(UsageError);
    expect(() => parseProbeArgs(["--concurrency", "9"], ROOT)).toThrow(UsageError);
    expect(() => parseProbeArgs(["--variant", "side"], ROOT)).toThrow(UsageError);
    expect(() => parseProbeArgs(["--skus", " , "], ROOT)).toThrow(UsageError);
    expect(() => parseProbeArgs(["--consent"], ROOT)).toThrow(UsageError); // unknown flag, strict
    expect(() => parseProbeArgs(["--check-replay", "--max-credits", "0"], ROOT)).toThrow(/at least 1/);
  });
});

describe("plan and budget", () => {
  const people = personLabels(["/p/ana.jpg", "/p/ben.png", "/p/ana.png"]);

  it("labels people from file names and de-duplicates", () => {
    expect(people.map((p) => p.person)).toEqual(["ana", "ben", "ana-2"]);
  });

  it("is breadth-first (every photo and SKU before alt shots) and defers pairs over the budget", () => {
    const pairs = buildPlan({
      people: people.slice(0, 2),
      skuIds: ["a", "b"],
      variants: ["primary", "alt"],
      outDir: "/out",
      force: false,
      renderBudget: 4,
      existing: () => null,
    });
    expect(pairs.map((p) => `${p.variant}:${p.skuId}:${p.person}:${p.action}`)).toEqual([
      "primary:a:ana:run",
      "primary:a:ben:run",
      "primary:b:ana:run",
      "primary:b:ben:run",
      "alt:a:ana:defer-budget",
      "alt:a:ben:defer-budget",
      "alt:b:ana:defer-budget",
      "alt:b:ben:defer-budget",
    ]);
    expect(pairs[4]!.outBase).toBe(path.join("/out", "ana__a__alt"));
  });

  it("skips pairs whose output exists unless --force, without spending budget on them", () => {
    const existing = (base: string) => (base.endsWith("ana__a") ? `${base}.png` : null);
    const pairs = buildPlan({ people: people.slice(0, 2), skuIds: ["a"], variants: ["primary"], outDir: "/out", force: false, renderBudget: 1, existing });
    expect(pairs.map((p) => p.action)).toEqual(["skip-existing", "run"]);
    expect(pairs[0]!.existing).toBe("/out/ana__a.png");
    const forced = buildPlan({ people: people.slice(0, 2), skuIds: ["a"], variants: ["primary"], outDir: "/out", force: true, renderBudget: 1, existing });
    expect(forced.map((p) => p.action)).toEqual(["run", "defer-budget"]);
  });

  it("reserves one credit for --check-replay", () => {
    expect(renderBudgetFor(4, false)).toBe(4);
    expect(renderBudgetFor(4, true)).toBe(3);
    expect(renderBudgetFor(0, true)).toBe(0);
  });

  it("refuses a plan over --max-credits or over the account's credits; needs a credits number", () => {
    expect(creditDecision({ renders: 4, checkReplay: false, maxCredits: 4, credits: 20, skipCreditCheck: false })).toEqual({
      ok: true,
      estimated: 4,
      reason: null,
    });
    expect(creditDecision({ renders: 4, checkReplay: true, maxCredits: 4, credits: 20, skipCreditCheck: false })).toMatchObject({
      ok: false,
      estimated: 5,
      reason: expect.stringContaining("--max-credits is 4"),
    });
    expect(creditDecision({ renders: 3, checkReplay: true, maxCredits: 5, credits: 3, skipCreditCheck: false })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("account has 3 left"),
    });
    expect(creditDecision({ renders: 2, checkReplay: false, maxCredits: 4, credits: null, skipCreditCheck: false }).ok).toBe(false);
    expect(creditDecision({ renders: 2, checkReplay: false, maxCredits: 4, credits: null, skipCreditCheck: true }).ok).toBe(true);
  });
});

describe("person photo checks", () => {
  it("accepts only JPEG/PNG signatures", () => {
    expect(jpegOrPng(JPEG)).toBe("image/jpeg");
    expect(jpegOrPng(PNG)).toBe("image/png");
    expect(jpegOrPng(WEBP)).toBeNull();
    expect(jpegOrPng(new Uint8Array())).toBeNull();
  });

  it(`rejects non-JPEG/PNG files and photos under ${MIN_PERSON_SHORT_SIDE} px on the short side`, () => {
    expect(validatePersonPhoto({ name: "a.jpg", head: JPEG, width: 1200, height: 1600 })).toBeNull();
    expect(validatePersonPhoto({ name: "a.png", head: PNG, width: 600, height: 900 })).toBeNull();
    expect(validatePersonPhoto({ name: "a.webp", head: WEBP, width: 1200, height: 1600 })).toMatch(/not a JPEG or PNG/);
    expect(validatePersonPhoto({ name: "renamed.jpg", head: WEBP, width: 1200, height: 1600 })).toMatch(/signature/);
    expect(validatePersonPhoto({ name: "small.jpg", head: JPEG, width: 599, height: 1600 })).toMatch(/at least 600 px/);
    expect(validatePersonPhoto({ name: "landscape.jpg", head: JPEG, width: 1600, height: 500 })).toMatch(/1600×500/);
    expect(validatePersonPhoto({ name: "x.jpg", head: JPEG, width: undefined, height: 10 })).toMatch(/unreadable/);
  });
});

/** Synthetic RGB image: noisy centre, optional flat bands (no people involved). */
function synth(width: number, height: number, flat: { left?: number; right?: number; top?: number; bottom?: number } = {}): Uint8Array {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const inBand =
        x < (flat.left ?? 0) || x >= width - (flat.right ?? 0) || y < (flat.top ?? 0) || y >= height - (flat.bottom ?? 0);
      const v = inBand ? 255 : (x * 37 + y * 91 + ((x * y) % 13) * 17) % 256;
      data[i] = v;
      data[i + 1] = inBand ? 255 : (v * 3) % 256;
      data[i + 2] = inBand ? 255 : (v * 7) % 256;
    }
  }
  return data;
}

describe("image analysis", () => {
  it("aspect delta in percent", () => {
    expect(aspectDeltaPct({ width: 900, height: 1600 }, { width: 900, height: 1600 })).toBe(0);
    expect(aspectDeltaPct({ width: 900, height: 1600 }, { width: 450, height: 800 })).toBe(0);
    expect(aspectDeltaPct({ width: 900, height: 1600 }, { width: 768, height: 1024 })).toBe(33.3);
  });

  it("finds flat bands and separates added padding from a plain background", () => {
    const input = synth(120, 200);
    const padded = synth(160, 200, { left: 20, right: 20 });
    const inSides = uniformSides(input, 120, 200, 3);
    const outSides = uniformSides(padded, 160, 200, 3);
    expect(inSides).toEqual({ top: false, bottom: false, left: false, right: false });
    expect(outSides).toEqual({ top: false, bottom: false, left: true, right: true });
    expect(paddingVerdict(inSides, outSides)).toEqual({ padded: true, sides: ["left", "right"] });
    expect(paddingVerdict(inSides, inSides)).toEqual({ padded: false, sides: [] });
    // Plain wall above the head in both: can't tell.
    const wall = uniformSides(synth(120, 200, { top: 30 }), 120, 200, 3);
    expect(paddingVerdict(wall, wall)).toEqual({ padded: null, sides: ["top"] });
  });

  it("detects Clothsy's XMP AI label and picks file extensions by type", () => {
    expect(hasAiLabel(Buffer.from("…Iptc4xmpExt:DigitalSourceType=compositeWithTrainedAlgorithmicMedia…"))).toBe(true);
    expect(hasAiLabel(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("image/jpeg")).toBe("jpg");
  });
});

describe("report", () => {
  it("describeJsonShape redacts strings except enum-like keys", () => {
    expect(describeJsonShape({ credits: 20, scope: "account", email: "a@b.c", nested: { id: "img_123", ok: true }, list: [1, 2, 3] })).toEqual({
      credits: 20,
      scope: "account",
      email: "<string:5>",
      nested: { id: "<string:7>", ok: true },
      list: [1, "…2 more"],
    });
  });

  it("replayVerdict compares credits before/after", () => {
    expect(replayVerdict({ ok: true, before: 10, after: 10 }).verdict).toBe("free");
    expect(replayVerdict({ ok: true, before: 10, after: 9 }).verdict).toBe("charged");
    expect(replayVerdict({ ok: true, before: 10, after: 7 }).verdict).toBe("inconclusive");
    expect(replayVerdict({ ok: true, before: null, after: 9 }).verdict).toBe("inconclusive");
    expect(replayVerdict({ ok: false, before: 10, after: 10 }).verdict).toBe("failed");
  });

  function render(over: Partial<ObservedRender> = {}): ObservedRender {
    return {
      person: "ana",
      sku: "fw-wrap-dress-emerald",
      variant: "primary",
      status: "success",
      code: null,
      message: null,
      latencyMs: 21_000,
      creditCharged: true,
      replayed: false,
      input: { width: 900, height: 1600, bytes: 300_000 },
      output: {
        file: "probe/out/ana__fw-wrap-dress-emerald.jpg",
        width: 900,
        height: 1600,
        bytes: 250_000,
        contentType: "image/jpeg",
        contentTypeHeader: "image/jpeg",
        aiLabel: true,
        padded: false,
        paddedSides: [],
      },
      aspectDeltaPct: 0,
      start: { httpStatus: 202, attempt: 1, bodyStatus: "pending", pollUrl: "/api/v1/tryons/x", replaySignal: null, headers: { "x-request-id": "r" } },
      polls: 8,
      downloadHeaders: { "content-type": "image/jpeg" },
      ...over,
    };
  }

  function observed(renders: ObservedRender[], over: Partial<ProbeObserved> = {}): ProbeObserved {
    const acct = (credits: number) => ({ at: "t", ok: true, httpStatus: 200, credits, scope: "account", code: null, message: null, shape: { credits, scope: "account" } });
    return {
      generatedAt: "2026-11-06T00:00:00.000Z",
      apiVersion: "clothsy-v1.p1",
      apiBase: "https://api.clothsyai.fabricvton.com/api/v1",
      options: { skus: ["fw-wrap-dress-emerald"], variants: ["primary"], maxCredits: 4, concurrency: 2, checkReplay: false },
      plan: { pairs: renders.length, rendered: renders.length, skipped: 0, deferred: 0, estimatedCredits: renders.length },
      accountBefore: acct(20),
      accountAfter: acct(20 - renders.filter((r) => r.creditCharged).length),
      renders,
      replayCheck: null,
      interrupted: false,
      ...over,
    };
  }

  it("same aspect: the gate's centre-crop branch won't trigger; credits reconcile; no replay header", () => {
    const recs = buildRecommendations(observed([render(), render({ sku: "fw-aline-midi-cobalt" })]), REPLAY_HEADER_CANDIDATES);
    const all = recs.join("\n");
    expect(all).toMatch(/keeps the photo's aspect ratio/);
    expect(all).toMatch(/Credits used: 2, matching/);
    expect(all).toMatch(/No idempotency\/replay header/);
    expect(all).toMatch(/matches the documented shape/);
    expect(all).toMatch(/All 2 result\(s\) carry/);
    expect(all).toMatch(/--check-replay/);
  });

  it("padded output: says the centre-crop assumption is wrong; cropped output: says to verify alignment", () => {
    const padded = render({
      aspectDeltaPct: 33.3,
      output: { ...render().output!, width: 768, height: 1024, padded: true, paddedSides: ["left", "right"] },
    });
    expect(buildRecommendations(observed([padded]), REPLAY_HEADER_CANDIDATES).join("\n")).toMatch(/centre-crop assumption is WRONG/);
    const cropped = render({ aspectDeltaPct: 12.5, output: { ...render().output!, width: 768, height: 1024 } });
    expect(buildRecommendations(observed([cropped]), REPLAY_HEADER_CANDIDATES).join("\n")).toMatch(/crops or reframes/);
  });

  it("names unknown replay headers, failure advice, mismatched credits and a missing AI label", () => {
    const withHeader = render({ start: { ...render().start!, headers: { "idempotency-replayed": "false", "x-idempotent-replay": "no" } } });
    const failed = render({ status: "failed", code: "PERSON_PHOTO_REJECTED", output: null, creditCharged: false, aspectDeltaPct: null });
    const unlabelled = render({ output: { ...render().output!, aiLabel: false } });
    const o = observed([withHeader, failed, unlabelled]);
    o.accountAfter = { ...o.accountAfter!, credits: 15 };
    const all = buildRecommendations(o, REPLAY_HEADER_CANDIDATES).join("\n");
    expect(all).toMatch(/Add x-idempotent-replay to REPLAY_HEADER_CANDIDATES/);
    expect(all).toMatch(/PERSON_PHOTO_REJECTED \(1×\): the person photo must clearly show exactly one adult/);
    expect(all).toMatch(/Credits used: 5, but the client counted 2/);
    expect(all).toMatch(/1 of 2 result\(s\) had no XMP AI label/);
  });

  it("no success: says nothing could be measured", () => {
    const failed = render({ status: "failed", code: "INVALID_API_KEY", output: null, start: null, creditCharged: false });
    const recs = buildRecommendations(observed([failed]), REPLAY_HEADER_CANDIDATES);
    expect(recs[0]).toMatch(/No render succeeded/);
    expect(recs.join("\n")).toMatch(/npm run doctor/);
  });

  it("renders REPORT.md with every section and no image data", () => {
    const md = renderReport(
      observed([render()], {
        replayCheck: {
          person: "ana",
          sku: "fw-wrap-dress-emerald",
          variant: "primary",
          idempotencyKey: "probe_abc",
          creditsBefore: 19,
          creditsAfter: 19,
          status: "success",
          code: null,
          replayedFlag: true,
          start: { ...render().start!, httpStatus: 200, bodyStatus: "success" },
          ...replayVerdict({ ok: true, before: 19, after: 19 }),
        },
      }),
      REPLAY_HEADER_CANDIDATES,
    );
    for (const h of ["# Clothsy probe report", "## Recommendations", "## Renders", "## Response headers of interest", "## Account (GET /account, redacted)", "## Replay check"]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("| ana | fw-wrap-dress-emerald | primary | success |");
    expect(md).toContain("**FREE**");
    expect(md).not.toMatch(/data:image|base64/);
  });
});

describe("suggestProbeSkus", () => {
  it("lists real catalogue SKUs only", () => {
    for (const id of PROBE_SKU_PREFERENCE) expect(getSku(id), id).toBeDefined();
  });
  it("prefers photographed hero-path SKUs, in order", () => {
    const photos = new Set(["fw-shirt-dress-rust", "fw-shift-dress-navy", "fw-trench-stone"]);
    expect(suggestProbeSkus((id) => photos.has(id))).toEqual(["fw-shift-dress-navy", "fw-shirt-dress-rust"]);
    expect(suggestProbeSkus(() => true)).toEqual(["fw-aline-midi-black", "fw-wrap-dress-navy"]);
  });
  it("tops up from the defaults when fewer than n SKUs are photos", () => {
    expect(suggestProbeSkus(() => false)).toEqual(["fw-wrap-dress-emerald", "fw-aline-midi-cobalt"]);
    expect(suggestProbeSkus((id) => id === "fw-shirt-dress-sage")).toEqual(["fw-shirt-dress-sage", "fw-wrap-dress-emerald"]);
    expect(suggestProbeSkus((id) => id === "fw-wrap-dress-emerald")).toEqual(["fw-wrap-dress-emerald", "fw-aline-midi-cobalt"]);
  });
});
