// Source-aware fidelity gate: pure decision logic (no DOM), unit-tested in node.
// lib/cv/gate.ts computes the metrics in the browser; this module turns them into a
// verdict the shopper UI and the merchant dashboard can trust.
//
//   pass  — every applicable check is within threshold; show "✓ Checked".
//   retry — something failed and a retry with the alternate garment shot is possible.
//   badge — something failed, no retry left: show the render with honest shopper copy.
//   drop  — the render would mislead (identity drift / garment missing), no retry: hide it.

import type { GateMetrics, GateVerdict, TransitionType } from "../types";
import { THRESHOLDS, type GateSevereThresholds, type GateThresholds } from "./thresholds";

export type { GateSevereThresholds, GateThresholds } from "./thresholds";

/** Current gate thresholds, from lib/cv/thresholds.json (re-tune with `npm run tune`, docs/GATE-TUNING.md). */
export const GATE_THRESHOLDS: GateThresholds = { ...THRESHOLDS.gate };

/** Beyond these, a render with no retry left is dropped rather than badged (lib/cv/thresholds.json). */
export const GATE_SEVERE: Readonly<GateSevereThresholds> = Object.freeze({
  /** "Very high" identity drift: a different-looking face. */
  identityDiff: THRESHOLDS.gateSevere.identityDiff,
  /** "Tiny" coverage: the garment is essentially missing from the torso. */
  minCoverage: THRESHOLDS.gateSevere.minCoverage,
});

/** Transitions where the render must NOT keep the original silhouette. */
export const SILHOUETTE_CHANGING: ReadonlySet<TransitionType> = new Set<TransitionType>([
  "shorter",
  "longer",
  "slim_to_loose",
  "loose_to_slim",
]);

/** Shopper-facing badge copy. Honest, short, never about the shopper's body or skin. */
export const GATE_BADGES = {
  silhouette: "Colour preview · silhouette approximate",
  colour: "Colour may look slightly different",
  colourAndSilhouette: "Approximate preview · colour and shape may differ",
  generic: "Preview approximate",
  unchecked: "Preview not quality-checked",
} as const;

type FailureKind = "colour" | "silhouette" | "integrity";

interface Failure {
  kind: FailureKind;
  severe: boolean;
  reason: string;
}

function f2(n: number): string {
  return n.toFixed(2);
}
function f1(n: number): string {
  return n.toFixed(1);
}

function isNum(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Server limit on one gate reason (GateResultSchema). */
export const MAX_GATE_REASON_CHARS = 300;

export interface GateDecision {
  verdict: GateVerdict;
  reasons: string[];
  badge: string | null;
  /** Only with verdict 'retry': the verdict to use if the server can't retry ('drop' for severe failures). */
  fallbackVerdict?: "badge" | "drop";
}

/**
 * Whether a metric takes part in the verdict for this render context (decideGate uses
 * exactly this; the tuning script uses it to pick which renders count for a threshold).
 * - residueFraction only when a colour change is expected;
 * - silhouetteIoU only on a silhouette-changing transition that isn't a length variant;
 * - every other metric whenever it could be measured.
 */
export function gateCheckApplies(
  metric: keyof GateMetrics,
  ctx: { transition: TransitionType; colourChangeExpected: boolean; lengthVariant?: boolean },
): boolean {
  if (metric === "residueFraction") return ctx.colourChangeExpected;
  if (metric === "silhouetteIoU") return SILHOUETTE_CHANGING.has(ctx.transition) && !ctx.lengthVariant;
  return true;
}

/**
 * Decide the gate verdict for one render.
 * - Silhouette leakage (IoU) only counts on silhouette-changing transitions, and not for a
 *   length variant of the same garment (Tall/Petite): a correct +6 cm render barely moves
 *   the mask, so there the hem error is the right check.
 * - Residue only counts when a colour change is expected.
 * - Failing + canRetry → 'retry', with `fallbackVerdict` (and the badge copy) to use if the
 *   server can't retry. A severe failure falls back to 'drop' (badge null), never a badge.
 * - Failing + no retry → 'badge', or 'drop' when identity drift is very high or the
 *   garment coverage is tiny.
 */
export function decideGate(
  m: GateMetrics,
  ctx: {
    transition: TransitionType;
    colourChangeExpected: boolean;
    canRetry: boolean;
    /** Target is another length variant of the same garment family (skips the IoU leakage check). */
    lengthVariant?: boolean;
  },
  thresholds: GateThresholds = GATE_THRESHOLDS,
  severeThresholds: Readonly<GateSevereThresholds> = GATE_SEVERE,
): GateDecision {
  const t = thresholds;
  const failures: Failure[] = [];

  if (isNum(m.colourDeltaE) && m.colourDeltaE > t.colourDeltaE) {
    failures.push({
      kind: "colour",
      severe: false,
      reason: `colour ΔE00 ${f1(m.colourDeltaE)} > ${f1(t.colourDeltaE)} (rendered colour off target)`,
    });
  }

  if (gateCheckApplies("residueFraction", ctx) && isNum(m.residueFraction) && m.residueFraction > t.residue) {
    failures.push({
      kind: "colour",
      severe: false,
      reason: `residue ${f2(m.residueFraction)} > ${f2(t.residue)} (returned garment's colour still visible)`,
    });
  }

  if (gateCheckApplies("silhouetteIoU", ctx) && isNum(m.silhouetteIoU) && m.silhouetteIoU > t.silhouetteIoU) {
    failures.push({
      kind: "silhouette",
      severe: false,
      reason: `silhouette IoU ${f2(m.silhouetteIoU)} > ${f2(t.silhouetteIoU)} on ${ctx.transition} (original shape leaking through)`,
    });
  }

  if (isNum(m.hemErrorCm) && m.hemErrorCm > t.hemErrorCm) {
    failures.push({
      kind: "silhouette",
      severe: false,
      reason: `hem off by ${f1(m.hemErrorCm)} cm > ${f1(t.hemErrorCm)} cm (length not as specified)`,
    });
  }

  if (isNum(m.identityDiff) && m.identityDiff > t.identityDiff) {
    const severe = m.identityDiff > severeThresholds.identityDiff;
    failures.push({
      kind: "integrity",
      severe,
      reason: `identity diff ${f2(m.identityDiff)} > ${f2(t.identityDiff)}${severe ? " (severe)" : ""} (face region changed)`,
    });
  }

  if (isNum(m.garmentCoverage) && m.garmentCoverage < t.minCoverage) {
    const severe = m.garmentCoverage < severeThresholds.minCoverage;
    failures.push({
      kind: "integrity",
      severe,
      reason: `coverage ${f2(m.garmentCoverage)} < ${f2(t.minCoverage)}${severe ? " (severe)" : ""} (garment missing from torso)`,
    });
  }

  const anyMetric = [
    m.colourDeltaE,
    m.residueFraction,
    m.silhouetteIoU,
    m.identityDiff,
    m.hemErrorCm,
    m.garmentCoverage,
  ].some(isNum);

  if (failures.length === 0) {
    if (!anyMetric) {
      // Nothing could be measured: don't claim a pass, and a retry wouldn't help.
      return { verdict: "badge", reasons: ["no gate metrics could be computed"], badge: GATE_BADGES.unchecked };
    }
    if (!isNum(m.colourDeltaE) && !isNum(m.garmentCoverage)) {
      // The rendered garment itself was never observed (no colour sample, no torso coverage),
      // so a low IoU or a quiet face box proves nothing about the preview. Don't claim a pass.
      return {
        verdict: "badge",
        reasons: ["rendered garment not found, so colour and coverage couldn't be checked"],
        badge: GATE_BADGES.unchecked,
      };
    }
    return { verdict: "pass", reasons: [], badge: null };
  }

  const reasons = failures.map((x) => x.reason.slice(0, MAX_GATE_REASON_CHARS));
  const severe = failures.some((x) => x.severe);
  const badge = severe ? null : badgeFor(failures);

  if (ctx.canRetry) return { verdict: "retry", reasons, badge, fallbackVerdict: severe ? "drop" : "badge" };
  if (severe) return { verdict: "drop", reasons, badge: null };
  return { verdict: "badge", reasons, badge };
}

function badgeFor(failures: Failure[]): string {
  const colour = failures.some((x) => x.kind === "colour");
  const silhouette = failures.some((x) => x.kind === "silhouette");
  if (colour && silhouette) return GATE_BADGES.colourAndSilhouette;
  if (silhouette) return GATE_BADGES.silhouette;
  if (colour) return GATE_BADGES.colour;
  return GATE_BADGES.generic;
}

/** All-null metrics, for error paths. */
export function emptyGateMetrics(): GateMetrics {
  return {
    colourDeltaE: null,
    residueFraction: null,
    silhouetteIoU: null,
    identityDiff: null,
    hemErrorCm: null,
    garmentCoverage: null,
  };
}
