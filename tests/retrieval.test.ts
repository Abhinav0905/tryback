import { describe, expect, it } from "vitest";
import { requireSku, SKUS } from "@/lib/catalog";
import { chroma, deltaE2000, hexToLab } from "@/lib/color";
import {
  CANDIDATES_SHOWN,
  classifyTransition,
  colourDistance,
  rankCandidates,
  sizeOptions,
  speculativePicks,
} from "@/lib/retrieval";
import type { Diagnosis, DiagnosisIssue, KeepAttribute, PhotoMeasurements } from "@/lib/types";

const wrapMustard = requireSku("fw-wrap-dress-mustard");
const linenWhite = requireSku("fw-linen-shirt-white");

function diag(issues: Array<[DiagnosisIssue["type"], number]>, keep: KeepAttribute[]): Diagnosis {
  return {
    issues: issues.map(([type, confidence]) => ({ type, confidence, evidence: "test" })),
    keepAttributes: keep,
    summary: "",
    source: "rules",
  };
}

describe("classifyTransition", () => {
  it("same family, same length variant, different colour → colour_only", () => {
    expect(classifyTransition(wrapMustard, requireSku("fw-wrap-dress-emerald"))).toBe("colour_only");
  });

  it("wrap → A-line is slim_to_loose and back is loose_to_slim", () => {
    const aline = requireSku("fw-aline-midi-cobalt");
    expect(classifyTransition(wrapMustard, aline)).toBe("slim_to_loose");
    expect(classifyTransition(aline, wrapMustard)).toBe("loose_to_slim");
  });

  it("regular → Tall variant is longer, Tall → regular is shorter", () => {
    const tall = requireSku("fw-linen-shirt-white-tall");
    expect(classifyTransition(linenWhite, tall)).toBe("longer");
    expect(classifyTransition(tall, linenWhite)).toBe("shorter");
    expect(classifyTransition(requireSku("fw-trench-stone"), requireSku("fw-trench-stone-tall"))).toBe("longer");
  });

  it("similar looseness with a different length class → longer/shorter", () => {
    const slip = requireSku("fw-slip-dress-black"); // midi, looseness close to the wrap
    expect(classifyTransition(wrapMustard, slip)).toBe("longer");
    expect(classifyTransition(slip, wrapMustard)).toBe("shorter");
  });

  it("identical SKU → like_silhouette", () => {
    expect(classifyTransition(wrapMustard, wrapMustard)).toBe("like_silhouette");
  });

  it("covers every SKU pair without throwing", () => {
    for (const a of SKUS) for (const b of SKUS) expect(typeof classifyTransition(a, b)).toBe("string");
  });
});

describe("rankCandidates", () => {
  const clingyColour = diag(
    [
      ["colour", 0.8],
      ["too_clingy", 0.8],
    ],
    ["category", "length", "neckline"],
  );

  it("wrap mustard + too_clingy + colour → an A-line in a different colour ranks first", () => {
    const ranked = rankCandidates(wrapMustard, "M", clingyColour);
    const top = requireSku(ranked[0].skuId);
    expect(top.silhouette).toBe("a-line");
    expect(colourDistance(wrapMustard, top)).toBeGreaterThan(20);
    expect(ranked[0].transition).toBe("slim_to_loose");
    expect(ranked[0].fixes).toEqual(expect.arrayContaining(["colour", "too_clingy"]));
    expect(ranked[0].why).toBe(`Looser A-line through the hip, in ${top.colorName}`);
    expect(ranked[0].priceDiff).toBe(top.price - wrapMustard.price);
    expect(ranked[0].size).toBe("M");
  });

  it("only returns same-category SKUs in stock in the size, never the purchased SKU", () => {
    for (const size of ["XS", "S", "M", "L", "XL"] as const) {
      const ranked = rankCandidates(wrapMustard, size, clingyColour, { limit: 50 });
      for (const c of ranked) {
        const s = requireSku(c.skuId);
        expect(s.id).not.toBe(wrapMustard.id);
        expect(s.category).toBe("dress");
        expect(s.inventory[size]).toBeGreaterThan(0);
        expect(c.size).toBe(size);
      }
    }
    // Shirt dress in Ecru has 0 stock in M.
    expect(rankCandidates(wrapMustard, "M", clingyColour, { limit: 50 }).map((c) => c.skuId)).not.toContain(
      "fw-shirt-dress-ecru",
    );
  });

  it("is deterministic and sorted by score", () => {
    const a = rankCandidates(wrapMustard, "M", clingyColour, { limit: 10 });
    const b = rankCandidates(wrapMustard, "M", clingyColour, { limit: 10 });
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
  });

  it("respects limit and exclude", () => {
    expect(rankCandidates(wrapMustard, "M", clingyColour, { limit: 2 })).toHaveLength(2);
    expect(rankCandidates(wrapMustard, "M", clingyColour, { limit: 0 })).toEqual([]);
    const first = rankCandidates(wrapMustard, "M", clingyColour)[0].skuId;
    expect(rankCandidates(wrapMustard, "M", clingyColour, { exclude: [first] }).map((c) => c.skuId)).not.toContain(first);
  });

  it("diversifies families in the top results", () => {
    const top = rankCandidates(wrapMustard, "M", clingyColour, { limit: CANDIDATES_SHOWN });
    const families = new Set(top.map((c) => requireSku(c.skuId).family));
    expect(families.size).toBeGreaterThanOrEqual(3);
  });

  it("colour-only complaint keeps the silhouette: same style in another colour wins", () => {
    const ranked = rankCandidates(
      wrapMustard,
      "M",
      diag([["colour", 0.8]], ["category", "silhouette", "length", "neckline", "fit"]),
    );
    const top = requireSku(ranked[0].skuId);
    expect(top.family).toBe("wrap-dress");
    expect(ranked[0].transition).toBe("colour_only");
    expect(ranked[0].fixes).toEqual(["colour"]);
    expect(ranked[0].why).toBe(`Same wrap dress you chose, in ${top.colorName}`);
  });

  it("penalises changing keep attributes", () => {
    const keepAll = rankCandidates(
      wrapMustard,
      "M",
      diag([["colour", 0.8]], ["category", "silhouette", "length", "neckline", "fit"]),
      { limit: 50 },
    );
    const keepNone = rankCandidates(wrapMustard, "M", diag([["colour", 0.8]], ["category"]), { limit: 50 });
    const score = (list: typeof keepAll, id: string) => list.find((c) => c.skuId === id)!.score;
    // The A-line changes silhouette, length, neckline and fit; the wrap in navy changes none of them.
    expect(score(keepNone, "fw-aline-midi-cobalt") - score(keepAll, "fw-aline-midi-cobalt")).toBeGreaterThan(1);
    expect(score(keepNone, "fw-wrap-dress-navy")).toBeCloseTo(score(keepAll, "fw-wrap-dress-navy"), 6);
  });

  it("too_boxy on a relaxed linen shirt prefers a more shaped top", () => {
    const ranked = rankCandidates(linenWhite, "M", diag([["too_boxy", 0.8]], ["category", "colour"]));
    const top = requireSku(ranked[0].skuId);
    expect(top.family).toBe("knit-top");
    expect(ranked[0].transition).toBe("loose_to_slim");
    expect(ranked[0].fixes).toContain("too_boxy");
    expect(ranked[0].why).toMatch(/^More shaped fitted cut/);
  });

  it("too_short on the linen shirt recommends the Tall variant", () => {
    const ranked = rankCandidates(linenWhite, "M", diag([["too_short", 0.8]], ["category", "silhouette", "colour", "neckline", "fit"]));
    expect(ranked[0].skuId).toBe("fw-linen-shirt-white-tall");
    expect(ranked[0].transition).toBe("longer");
    expect(ranked[0].fixes).toEqual(["too_short"]);
    expect(ranked[0].why).toBe("Tall length: +6 cm at the hem");
    expect(ranked[0].priceDiff).toBe(5);
  });

  it("neckline, print and fabric issues reward the matching change", () => {
    const neck = rankCandidates(wrapMustard, "M", diag([["neckline", 0.8]], ["category"]))[0];
    expect(requireSku(neck.skuId).neckline).not.toBe("v");
    expect(neck.fixes).toContain("neckline");
    expect(neck.why).toMatch(/instead of a V-neck/);

    const print = rankCandidates(wrapMustard, "M", diag([["print", 0.8]], ["category", "silhouette"]))[0];
    const printSku = requireSku(print.skuId);
    expect(chroma(hexToLab(printSku.colorHex))).toBeLessThan(chroma(hexToLab(wrapMustard.colorHex)));
    expect(print.fixes).toContain("print");

    const fabric = rankCandidates(wrapMustard, "M", diag([["fabric", 0.8]], ["category"]))[0];
    expect(requireSku(fabric.skuId).fabric).not.toBe(wrapMustard.fabric);
    expect(fabric.fixes).toContain("fabric");
  });

  it("too_long rewards a shorter length", () => {
    const slip = requireSku("fw-slip-dress-black"); // midi
    const top = rankCandidates(slip, "M", diag([["too_long", 0.8]], ["category"]))[0];
    expect(top.fixes).toContain("too_long");
    expect(["shorter", "slim_to_loose", "loose_to_slim"]).toContain(top.transition);
    const s = requireSku(top.skuId);
    expect(["cropped", "hip", "thigh", "above-knee", "knee"]).toContain(s.lengthClass);
  });

  it("applies a price-band penalty beyond ±$25 and reports priceDiff against the paid price", () => {
    const d = diag([["colour", 0.8]], ["category"]);
    const atList = rankCandidates(wrapMustard, "M", d, { limit: 50 });
    const cheapPaid = rankCandidates(wrapMustard, "M", d, { limit: 50, paidPrice: 40 });
    const a = atList.find((c) => c.skuId === "fw-aline-midi-cobalt")!;
    const b = cheapPaid.find((c) => c.skuId === "fw-aline-midi-cobalt")!;
    expect(b.priceDiff).toBe(49);
    expect(a.score - b.score).toBeGreaterThan(0.2); // $24 beyond the band
    // Within the band (±$25) there is no penalty.
    const inBand = rankCandidates(wrapMustard, "M", d, { limit: 50, paidPrice: 70 }).find(
      (c) => c.skuId === "fw-aline-midi-cobalt",
    )!;
    expect(inBand.score).toBeCloseTo(a.score, 6);
  });

  it("a close-fitting ease ratio nudges roomier cuts (tie-breaker only)", () => {
    const d = diag([["too_clingy", 0.6]], ["category"]);
    const measurements = { easeRatio: 1.02 } as PhotoMeasurements;
    const without = rankCandidates(wrapMustard, "M", d, { limit: 50 }).find((c) => c.skuId === "fw-shift-dress-navy")!;
    const withEase = rankCandidates(wrapMustard, "M", d, { limit: 50, measurements }).find(
      (c) => c.skuId === "fw-shift-dress-navy",
    )!;
    expect(withEase.score - without.score).toBeCloseTo(0.05, 6);
  });

  it("weights issues by confidence", () => {
    const weak = rankCandidates(wrapMustard, "M", diag([["colour", 0.2]], ["category"]), { limit: 50 });
    const strong = rankCandidates(wrapMustard, "M", diag([["colour", 0.9]], ["category"]), { limit: 50 });
    const s = (l: typeof weak) => l.find((c) => c.skuId === "fw-wrap-dress-navy")!.score;
    expect(s(strong)).toBeGreaterThan(s(weak));
  });

  it("uses a real ΔE2000 colour distance", () => {
    expect(colourDistance(wrapMustard, wrapMustard)).toBe(0);
    const navy = requireSku("fw-wrap-dress-navy");
    expect(colourDistance(wrapMustard, navy)).toBeCloseTo(
      deltaE2000(hexToLab(wrapMustard.colorHex), hexToLab(navy.colorHex)),
      9,
    );
  });
});

describe("speculativePicks", () => {
  it("returns one silhouette change + one colour change, in stock in the size", () => {
    const picks = speculativePicks(wrapMustard, "M", "style_colour");
    expect(picks).toHaveLength(2);
    const [silhouette, colour] = picks.map((p) => requireSku(p.skuId));
    expect(silhouette.family).not.toBe(wrapMustard.family);
    expect(picks[0].transition).toBe("slim_to_loose");
    expect(colour.family).toBe(wrapMustard.family);
    expect(picks[1].transition).toBe("colour_only");
    expect(colourDistance(wrapMustard, colour)).toBeGreaterThan(20);
    for (const p of picks) {
      expect(requireSku(p.skuId).inventory.M).toBeGreaterThan(0);
      expect(p.why.length).toBeGreaterThan(5);
    }
    expect(new Set(picks.map((p) => p.skuId)).size).toBe(2);
  });

  it("goes slimmer for roomy cuts", () => {
    const picks = speculativePicks(linenWhite, "M", "style_colour");
    expect(picks[0].transition).toBe("loose_to_slim");
    expect(requireSku(picks[1].skuId).family).toBe("linen-shirt");
  });

  it("still returns two distinct in-stock picks for a single-family category (outerwear)", () => {
    const trench = requireSku("fw-trench-stone");
    const picks = speculativePicks(trench, "M", "style_colour");
    expect(picks).toHaveLength(2);
    expect(new Set(picks.map((p) => p.skuId)).size).toBe(2);
    for (const p of picks) {
      expect(p.skuId).not.toBe(trench.id);
      expect(requireSku(p.skuId).inventory.M).toBeGreaterThan(0);
    }
  });

  it("returns nothing for fit or other reasons", () => {
    expect(speculativePicks(wrapMustard, "M", "fit_size")).toEqual([]);
    expect(speculativePicks(wrapMustard, "M", "other")).toEqual([]);
  });
});

describe("sizeOptions", () => {
  it("linen shirt M + too_short → recommends the Tall variant and says L won't fix it", () => {
    const options = sizeOptions(linenWhite, "M", ["too_short"]);
    const recommended = options.filter((o) => o.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]).toMatchObject({
      skuId: "fw-linen-shirt-white-tall",
      size: "M",
      lengthVariant: "tall",
      deltaHemCm: 6,
      deltaSleeveCm: 4,
      deltaChestCircCm: 0,
      fixes: ["too_short"],
      inStock: true,
      priceDiff: 5,
    });
    expect(recommended[0].note).toMatch(/without changing size/);

    const l = options.find((o) => o.skuId === "fw-linen-shirt-white" && o.size === "L")!;
    expect(l.fixes).toEqual([]);
    expect(l.deltaHemCm).toBe(1.5);
    expect(l.deltaChestCircCm).toBe(5);
    expect(l.note).toBe("L adds only +1.5 cm length but +5 cm chest — sizing up won't fix 'too short'");
    expect(l.tradeoffs).toContain("+5 cm wider through the chest");
  });

  it("covers every size × length variant of the same style and colour, except what they're wearing", () => {
    const options = sizeOptions(linenWhite, "M", ["too_short"]);
    expect(options).toHaveLength(9); // (regular + tall) × 5 sizes − the purchased one
    expect(options.some((o) => o.skuId === linenWhite.id && o.size === "M")).toBe(false);
    for (const o of options) expect(requireSku(o.skuId).colorName).toBe("White");
    const tallXs = options.find((o) => o.skuId === "fw-linen-shirt-white-tall" && o.size === "XS")!;
    expect(tallXs.inStock).toBe(false);
    expect(tallXs.recommended).toBe(false);
    expect(tallXs.note).toMatch(/Out of stock/);
  });

  it("applies the documented thresholds for fixes", () => {
    const options = sizeOptions(linenWhite, "M", []);
    const xl = options.find((o) => o.skuId === linenWhite.id && o.size === "XL")!;
    // XL: +3 cm hem (≥3 → fixes too_short), +10 cm chest (fixes too_tight), +2 cm sleeve (fixes sleeves_short)
    expect(xl.fixes).toEqual(expect.arrayContaining(["too_short", "too_tight", "sleeves_short"]));
    const s = options.find((o) => o.skuId === linenWhite.id && o.size === "S")!;
    expect(s.fixes).toEqual(["too_loose"]); // −1.5 hem, −5 chest, −1 sleeve
    expect(options.some((o) => o.recommended)).toBe(false); // no complaints → no recommendation
  });

  it("too_tight → sizing up one is recommended with an honest note", () => {
    const options = sizeOptions(wrapMustard, "M", ["too_tight"]);
    const rec = options.find((o) => o.recommended)!;
    expect(rec).toMatchObject({ skuId: wrapMustard.id, size: "L", fixes: ["too_tight"] });
    expect(rec.note).toMatch(/chest/);
  });

  it("too_long with no petite variant: sizing down one won't fix it, and the note says so", () => {
    const trench = requireSku("fw-trench-stone");
    const options = sizeOptions(trench, "M", ["too_long"]);
    const s = options.find((o) => o.skuId === trench.id && o.size === "S")!;
    expect(s.fixes).toEqual([]);
    expect(s.note).toBe("S is only 1.5 cm shorter but 5 cm narrower through the chest — sizing down won't fix 'too long'");
    const rec = options.find((o) => o.recommended);
    if (rec) expect(rec.fixes).toContain("too_long");
  });

  it("sleeveless styles report null sleeve deltas", () => {
    const slip = requireSku("fw-slip-dress-black");
    for (const o of sizeOptions(slip, "M", ["too_short"])) expect(o.deltaSleeveCm).toBeNull();
  });

  it("reports priceDiff against the paid price", () => {
    const o = sizeOptions(linenWhite, "M", ["too_short"], { paidPrice: 50 }).find((x) => x.recommended)!;
    expect(o.priceDiff).toBe(14);
  });
});
