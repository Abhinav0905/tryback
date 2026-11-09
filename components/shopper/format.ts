// Pure, shopper-facing formatting helpers. No React, no DOM — unit-tested in node.
// Copy rule: describe garments and numbers, never the shopper's body or skin tone.

import { FIT_CHIPS } from "@/lib/catalog";
import type {
  FitComplaint,
  IssueType,
  LengthVariant,
  PreflightCheckId,
  SizeCode,
  Sku,
  TransitionType,
} from "@/lib/types";

const MINUS = "−";

function usd(n: number): string {
  return Math.abs(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
}

/** Elapsed time as m:ss ("0:07", "1:24"). Negative / non-finite input clamps to 0:00. */
export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = Math.floor(safe / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Compact price difference for cards: "Same price", "$6 more", "$10 back". */
export function priceDiffLabel(diff: number): string {
  if (Math.abs(diff) < 0.005) return "Same price";
  return diff > 0 ? `${usd(diff)} more` : `${usd(diff)} back`;
}

/** Sentence form for the confirm screen. */
export function priceDiffSentence(diff: number): string {
  if (Math.abs(diff) < 0.005) return "No price difference";
  return diff > 0 ? `You pay ${usd(diff)} more` : `We refund the ${usd(diff)} difference`;
}

export type StockTone = "ok" | "warn" | "bad";

export function stockInfo(sku: Sku, size: SizeCode): { inStock: boolean; count: number; text: string; tone: StockTone } {
  const count = sku.inventory[size] ?? 0;
  if (count <= 0) return { inStock: false, count: 0, text: `Out of stock in ${size}`, tone: "bad" };
  if (count <= 2) return { inStock: true, count, text: `Only ${count} left in ${size}`, tone: "warn" };
  return { inStock: true, count, text: `In stock in ${size}`, tone: "ok" };
}

/** "+6 cm", "−1.5 cm", "±0 cm" — one decimal only when needed, true minus sign. */
export function signedCm(n: number): string {
  const r = Math.round(n * 10) / 10;
  if (Math.abs(r) < 0.05) return "±0 cm";
  const abs = Math.abs(r);
  const num = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1);
  return `${r > 0 ? "+" : MINUS}${num} cm`;
}

export const VARIANT_NAMES: Record<LengthVariant, string> = {
  regular: "Regular",
  petite: "Petite",
  tall: "Tall",
};

/** "M" for regular length, "M Tall" / "S Petite" otherwise. */
export function sizeVariantLabel(size: SizeCode, variant: LengthVariant): string {
  return variant === "regular" ? size : `${size} ${VARIANT_NAMES[variant]}`;
}

export const ISSUE_LABELS: Record<IssueType, string> = {
  colour: "Colour",
  too_long: "Longer than wanted",
  too_short: "Shorter than wanted",
  too_clingy: "Too clingy",
  too_boxy: "Too boxy",
  neckline: "Neckline",
  print: "Print",
  fabric: "Fabric",
};

const FIT_LABEL_MAP = new Map<FitComplaint, string>(FIT_CHIPS.map((c) => [c.id, c.label]));

export function fitComplaintLabel(c: FitComplaint): string {
  return FIT_LABEL_MAP.get(c) ?? c.replace(/_/g, " ");
}

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  colour_only: "Colour change",
  like_silhouette: "Similar shape",
  shorter: "Shorter length",
  longer: "Longer length",
  slim_to_loose: "Looser fit",
  loose_to_slim: "Closer fit",
};

export const PREFLIGHT_TITLES: Record<PreflightCheckId, string> = {
  full_body: "Full body in frame",
  single_person: "Just you in the photo",
  frontal: "Facing the camera",
  garment_visible: "The item is clearly visible",
  torso_unobstructed: "Nothing covering the item",
  lighting: "Lighting",
  sharpness: "Sharp, not blurry",
};

/** "Nov 1" from an ISO timestamp; empty string when unparseable. */
export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function percent(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
