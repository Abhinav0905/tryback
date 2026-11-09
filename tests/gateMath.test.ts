import { describe, expect, it } from "vitest";
import {
  GATE_BADGES,
  GATE_SEVERE,
  GATE_THRESHOLDS,
  SILHOUETTE_CHANGING,
  decideGate as decideGateWith,
  emptyGateMetrics,
} from "@/lib/cv/gateMath";
import type { GateMetrics, TransitionType } from "@/lib/types";
import { TRANSITIONS } from "@/lib/types";
import { FIXTURE_GATE, FIXTURE_SEVERE } from "./fixtures/thresholds";

// Verdicts below are pinned against fixed thresholds (the hand-set defaults), not the live
// lib/cv/thresholds.json, so re-tuning that file (npm run tune -- --apply) keeps this suite green.
const T = FIXTURE_GATE;
const decideGate = (m: GateMetrics, c: Parameters<typeof decideGateWith>[1], t = T, s = FIXTURE_SEVERE) => decideGateWith(m, c, t, s);

/** Metrics that pass every check comfortably. */
function good(overrides: Partial<GateMetrics> = {}): GateMetrics {
  return {
    colourDeltaE: 4.2,
    residueFraction: 0.03,
    silhouetteIoU: 0.71,
    identityDiff: 0.04,
    hemErrorCm: 1.8,
    garmentCoverage: 0.82,
    ...overrides,
  };
}

function ctx(transition: TransitionType, opts: { colourChangeExpected?: boolean; canRetry?: boolean } = {}) {
  return { transition, colourChangeExpected: opts.colourChangeExpected ?? true, canRetry: opts.canRetry ?? false };
}

describe("GATE_THRESHOLDS", () => {
  it("the live thresholds (lib/cv/thresholds.json, hand-set or tuned) are sane, ordered limits", () => {
    const L = GATE_THRESHOLDS;
    expect(L.colourDeltaE).toBeGreaterThan(0);
    expect(L.residue).toBeGreaterThan(0);
    expect(L.residue).toBeLessThan(1);
    expect(L.silhouetteIoU).toBeGreaterThan(0);
    expect(L.silhouetteIoU).toBeLessThan(1);
    expect(L.identityDiff).toBeLessThan(GATE_SEVERE.identityDiff);
    expect(L.minCoverage).toBeGreaterThan(GATE_SEVERE.minCoverage);
    expect(L.hemErrorCm).toBeGreaterThan(0);
  });

  it("decideGate uses the live thresholds by default", () => {
    const m = { ...emptyGateMetrics(), colourDeltaE: GATE_THRESHOLDS.colourDeltaE + 1, garmentCoverage: 0.9 };
    const c = { transition: "colour_only" as const, colourChangeExpected: true, canRetry: false };
    expect(decideGateWith(m, c).verdict).toBe("badge");
    expect(decideGateWith({ ...m, colourDeltaE: GATE_THRESHOLDS.colourDeltaE }, c).verdict).toBe("pass");
  });

  it("treat exactly the four shape-changing transitions as silhouette-changing", () => {
    expect([...SILHOUETTE_CHANGING].sort()).toEqual(["longer", "loose_to_slim", "shorter", "slim_to_loose"]);
  });
});

describe("decideGate: pass", () => {
  it.each(TRANSITIONS.map((t) => [t]))("passes clean metrics on %s", (transition) => {
    const r = decideGate(good(), ctx(transition));
    expect(r).toEqual({ verdict: "pass", reasons: [], badge: null });
  });

  it("passes at exactly the thresholds (limits are inclusive)", () => {
    const r = decideGate(
      good({
        colourDeltaE: T.colourDeltaE,
        residueFraction: T.residue,
        silhouetteIoU: T.silhouetteIoU,
        identityDiff: T.identityDiff,
        hemErrorCm: T.hemErrorCm,
        garmentCoverage: T.minCoverage,
      }),
      ctx("shorter"),
    );
    expect(r.verdict).toBe("pass");
  });

  it("ignores null metrics as long as something was measured", () => {
    const r = decideGate({ ...emptyGateMetrics(), colourDeltaE: 3, garmentCoverage: 0.9 }, ctx("colour_only"));
    expect(r.verdict).toBe("pass");
  });
});

describe("decideGate: retry when a retry is available", () => {
  it("retries a colour miss and carries the badge copy for a server-side downgrade", () => {
    const r = decideGate(good({ colourDeltaE: 18.4 }), ctx("colour_only", { canRetry: true }));
    expect(r.verdict).toBe("retry");
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/^colour ΔE00 18\.4 > 12\.0/);
    expect(r.badge).toBe(GATE_BADGES.colour);
    expect(r.fallbackVerdict).toBe("badge");
  });

  it("retries even severe failures first (a fresh garment shot may fix them)", () => {
    const r = decideGate(good({ identityDiff: 0.45, garmentCoverage: 0.02 }), ctx("like_silhouette", { canRetry: true }));
    expect(r.verdict).toBe("retry");
    expect(r.reasons).toHaveLength(2);
  });

  it("a severe failure falls back to drop, never to a badge, if the server can't retry", () => {
    const severe = good({ identityDiff: 0.42, garmentCoverage: 0.03 });
    const retry = decideGate(severe, ctx("like_silhouette", { canRetry: true }));
    expect(retry).toMatchObject({ verdict: "retry", badge: null, fallbackVerdict: "drop" });
    // …which is exactly what the same metrics decide with no retry available.
    expect(decideGate(severe, ctx("like_silhouette", { canRetry: false })).verdict).toBe("drop");
  });

  it("only sets fallbackVerdict on a retry", () => {
    expect(decideGate(good({ colourDeltaE: 18.4 }), ctx("colour_only")).fallbackVerdict).toBeUndefined();
    expect(decideGate(good(), ctx("colour_only", { canRetry: true })).fallbackVerdict).toBeUndefined();
  });
});

describe("decideGate: length variants of the same garment", () => {
  // A correct +6 cm Tall render barely moves the garment mask (IoU ≈ 0.95): the IoU leakage
  // check must not fire there; the hem error is the right metric.
  it.each([["longer"], ["shorter"]] as const)("skips the IoU leakage check on a same-family %s", (transition) => {
    const m = good({ silhouetteIoU: 0.96, hemErrorCm: 1.2 });
    expect(decideGate(m, { ...ctx(transition, { canRetry: true }), lengthVariant: true }).verdict).toBe("pass");
    // Across families the same IoU still means the old shape leaked through.
    expect(decideGate(m, ctx(transition, { canRetry: true })).verdict).toBe("retry");
  });

  it("still fails a length variant whose hem is far off", () => {
    const r = decideGate(good({ silhouetteIoU: 0.96, hemErrorCm: 9 }), { ...ctx("longer"), lengthVariant: true });
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe(GATE_BADGES.silhouette);
  });
});

describe("decideGate: badge when failing with no retry", () => {
  it("uses honest silhouette copy for leakage on a silhouette-changing transition", () => {
    const r = decideGate(good({ silhouetteIoU: 0.96 }), ctx("shorter"));
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe("Colour preview · silhouette approximate");
    expect(r.reasons[0]).toContain("silhouette IoU 0.96 > 0.92 on shorter");
  });

  it("uses colour copy for a colour miss", () => {
    const r = decideGate(good({ colourDeltaE: 15 }), ctx("colour_only"));
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe("Colour may look slightly different");
  });

  it("uses colour copy for residue of the returned garment's colour", () => {
    const r = decideGate(good({ residueFraction: 0.31 }), ctx("like_silhouette", { colourChangeExpected: true }));
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe(GATE_BADGES.colour);
    expect(r.reasons[0]).toMatch(/^residue 0\.31 > 0\.20/);
  });

  it("flags a hem far from the projected length as a silhouette issue", () => {
    const r = decideGate(good({ hemErrorCm: 9.5 }), ctx("longer"));
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe(GATE_BADGES.silhouette);
    expect(r.reasons[0]).toContain("hem off by 9.5 cm");
  });

  it("combines colour and silhouette copy when both fail", () => {
    const r = decideGate(good({ colourDeltaE: 20, silhouetteIoU: 0.97 }), ctx("slim_to_loose"));
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe(GATE_BADGES.colourAndSilhouette);
    expect(r.reasons).toHaveLength(2);
  });

  it("badges moderate identity drift or low coverage generically", () => {
    expect(decideGate(good({ identityDiff: 0.2 }), ctx("colour_only")).badge).toBe(GATE_BADGES.generic);
    const low = decideGate(good({ garmentCoverage: 0.15 }), ctx("colour_only"));
    expect(low.verdict).toBe("badge");
    expect(low.badge).toBe("Preview approximate");
  });

  it("never claims a pass when the rendered garment wasn't observed (only IoU / face measured)", () => {
    const r = decideGate(
      { ...emptyGateMetrics(), silhouetteIoU: 0, identityDiff: 0.02 },
      ctx("slim_to_loose", { canRetry: true }),
    );
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe(GATE_BADGES.unchecked);
  });

  it("never claims a pass when nothing could be measured", () => {
    const r = decideGate(emptyGateMetrics(), ctx("colour_only", { canRetry: true }));
    expect(r.verdict).toBe("badge");
    expect(r.badge).toBe(GATE_BADGES.unchecked);
  });
});

describe("decideGate: drop", () => {
  it("drops very high identity drift with no retry", () => {
    const r = decideGate(good({ identityDiff: 0.42 }), ctx("colour_only"));
    expect(r.verdict).toBe("drop");
    expect(r.badge).toBeNull();
    expect(r.reasons[0]).toContain("(severe)");
  });

  it("drops a render whose garment barely covers the torso with no retry", () => {
    const r = decideGate(good({ garmentCoverage: 0.04 }), ctx("like_silhouette"));
    expect(r.verdict).toBe("drop");
  });

  it("drops when a severe failure accompanies a mild one", () => {
    const r = decideGate(good({ colourDeltaE: 14, identityDiff: 0.5 }), ctx("colour_only"));
    expect(r.verdict).toBe("drop");
    expect(r.reasons).toHaveLength(2);
  });
});

describe("decideGate: source-aware rules", () => {
  it.each([["colour_only"], ["like_silhouette"]] as const)(
    "does not count high IoU as leakage on %s (the shape should match)",
    (transition) => {
      expect(decideGate(good({ silhouetteIoU: 0.98 }), ctx(transition)).verdict).toBe("pass");
    },
  );

  it.each([...SILHOUETTE_CHANGING].map((t) => [t]))("counts high IoU as leakage on %s", (transition) => {
    expect(decideGate(good({ silhouetteIoU: 0.98 }), ctx(transition)).verdict).toBe("badge");
  });

  it("ignores residue when no colour change is expected", () => {
    const r = decideGate(good({ residueFraction: 0.9 }), ctx("shorter", { colourChangeExpected: false }));
    expect(r.verdict).toBe("pass");
  });

  it("counts residue when a colour change is expected", () => {
    const r = decideGate(good({ residueFraction: 0.9 }), ctx("shorter", { colourChangeExpected: true }));
    expect(r.verdict).toBe("badge");
  });

  it("accepts custom thresholds (bench tuning)", () => {
    const strict = { ...T, colourDeltaE: 3 };
    expect(decideGate(good(), ctx("colour_only"), strict).verdict).toBe("badge");
  });
});
