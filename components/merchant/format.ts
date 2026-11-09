// Display helpers for the merchant dashboard, demo and bench (pure; client-safe).
import { formatSeconds } from "@/components/ui";
import type { GateVerdict, IssueType, TransitionType } from "@/lib/types";

export const TRANSITION_LABEL: Record<TransitionType, string> = {
  colour_only: "Colour only",
  like_silhouette: "Similar shape",
  shorter: "Shorter",
  longer: "Longer",
  slim_to_loose: "Slim → loose",
  loose_to_slim: "Loose → slim",
};

export const TRANSITION_HINT: Record<TransitionType, string> = {
  colour_only: "Same garment, different colourway",
  like_silhouette: "Different style, similar looseness and length",
  shorter: "Alternative hem sits higher",
  longer: "Alternative hem sits lower",
  slim_to_loose: "Close fit → looser cut (hardest case)",
  loose_to_slim: "Loose cut → closer fit",
};

export const ISSUE_LABEL: Record<IssueType, string> = {
  colour: "Colour",
  too_long: "Too long",
  too_short: "Too short",
  too_clingy: "Too clingy",
  too_boxy: "Too boxy",
  neckline: "Neckline",
  print: "Print",
  fabric: "Fabric",
};

export const VERDICT_LABEL: Record<GateVerdict, string> = {
  pass: "Passed",
  badge: "Shown with badge",
  retry: "Re-rendered",
  drop: "Hidden",
};

export const VERDICT_HINT: Record<GateVerdict, string> = {
  pass: "Shown as checked",
  badge: "Shown with an “approximate” label",
  retry: "Re-rendered from the alternate product shot",
  drop: "Never shown to the shopper",
};

export const VERDICT_ORDER: readonly GateVerdict[] = ["pass", "badge", "retry", "drop"];

/** "41%" (or "—" for null). */
export function formatPct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Latency in seconds via the shared formatter ("18 s", "4.7 s", "—"). */
export function formatLatency(ms: number | null | undefined): string {
  return formatSeconds(ms);
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatCredits(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n < 10 ? n.toFixed(2).replace(/\.?0+$/, "") || "0" : Math.round(n).toLocaleString("en-US");
}

/** Small USD amounts ("$0.12", "$0.004" → "<$0.01"). */
export function formatSmallUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** "just now", "3 min ago", "5 h ago", "2 d ago" relative to `nowIso`. */
export function relativeTime(iso: string, nowIso: string): string {
  const t = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(now)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

/** Round an axis maximum (ms) up to a clean multiple of 10 s (or 5 s when small). */
export function niceMaxMs(maxMs: number): { max: number; step: number } {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return { max: 40_000, step: 10_000 };
  const step = maxMs <= 20_000 ? 5_000 : 10_000;
  return { max: Math.max(step, Math.ceil(maxMs / step) * step), step };
}
