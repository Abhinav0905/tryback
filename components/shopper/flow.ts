// Pure state logic for the shopper flow: which screen to show, how often to poll,
// which render job the client gate should check next, and what each render card
// should display. No React, no DOM — unit-tested in node (tests/shopper.test.ts).

import { getSku } from "@/lib/catalog";
import type {
  AppStatus,
  BodyKeypoints,
  GateResult,
  ReasonCode,
  RenderJob,
  RenderPhase,
  ReturnCase,
  SizeCode,
} from "@/lib/types";
import { formatClock } from "./format";

/* ───────────────────────── Steps ───────────────────────── */

/** Screens derived purely from the server's ReturnCase. */
export type BaseStep = "reason" | "refund_confirm" | "photo_offer" | "style_form" | "results" | "size" | "done";

/** Client-only screens layered over the base step (never persisted). */
export type Overlay =
  | { kind: "reason" }
  | { kind: "photo_offer" }
  | { kind: "capture"; source: "camera" | "upload"; file: File | null }
  | { kind: "refund_confirm"; from: "skip" | "reason" }
  | { kind: "exchange"; skuId: string; size: SizeCode; jobId: string | null }
  | null;

export type ViewStep = BaseStep | "capture" | "exchange";

export function baseStep(r: ReturnCase): BaseStep {
  if (r.status === "resolved") return "done";
  if (!r.reason) return "reason";
  if (r.reason === "other") return "refund_confirm";
  if (!r.photo && !r.photoSkipped) return "photo_offer";
  if (r.reason === "fit_size") return "size";
  if (!r.timeline.formSubmittedAt) return "style_form";
  return "results";
}

export function viewStep(r: ReturnCase, overlay: Overlay): ViewStep {
  const base = baseStep(r);
  if (base === "done" || !overlay) return base;
  switch (overlay.kind) {
    case "reason":
      return "reason";
    case "photo_offer":
      return "photo_offer";
    case "capture":
      return "capture";
    case "refund_confirm":
      return "refund_confirm";
    case "exchange":
      return "exchange";
  }
}

export type StepId = "reason" | "photo" | "details" | "swaps" | "sizes" | "confirm";
export interface StepDef {
  id: StepId;
  label: string;
}

export function stepsFor(reason: ReasonCode | null): StepDef[] {
  const reasonStep: StepDef = { id: "reason", label: "Reason" };
  const photo: StepDef = { id: "photo", label: "Photo" };
  const confirm: StepDef = { id: "confirm", label: "Confirm" };
  switch (reason) {
    case "style_colour":
      return [reasonStep, photo, { id: "details", label: "Details" }, { id: "swaps", label: "Swaps" }, confirm];
    case "fit_size":
      return [reasonStep, photo, { id: "sizes", label: "Sizes" }, confirm];
    case "other":
      return [reasonStep, confirm];
    default:
      return [reasonStep, photo, { id: "swaps", label: "Options" }, confirm];
  }
}

const VIEW_TO_STEP: Record<ViewStep, StepId> = {
  reason: "reason",
  photo_offer: "photo",
  capture: "photo",
  style_form: "details",
  results: "swaps",
  size: "sizes",
  exchange: "confirm",
  refund_confirm: "confirm",
  done: "confirm",
};

export function stepIndexFor(view: ViewStep, steps: StepDef[]): number {
  const i = steps.findIndex((s) => s.id === VIEW_TO_STEP[view]);
  return i < 0 ? 0 : i;
}

/* ───────────────────────── Polling ───────────────────────── */

export const POLL_FAST_MS = 1500;
export const POLL_SLOW_MS = 6000;
export const POLL_MAX_BACKOFF_MS = 30000;

export function hasActiveJobs(r: ReturnCase): boolean {
  return r.renders.some((j) => j.status === "queued" || j.status === "running");
}

/**
 * Delay before the next GET /api/returns/[id]. `null` = stop polling.
 * 1.5 s while any job is queued/running, 6 s otherwise, stop once resolved;
 * exponential backoff (capped at 30 s) after consecutive errors.
 */
export function nextPollDelay(r: ReturnCase | null, consecutiveErrors: number): number | null {
  if (r?.status === "resolved") return null;
  if (consecutiveErrors > 0) {
    return Math.min(POLL_FAST_MS * 2 ** consecutiveErrors, POLL_MAX_BACKOFF_MS);
  }
  if (!r) return POLL_FAST_MS;
  return hasActiveJobs(r) ? POLL_FAST_MS : POLL_SLOW_MS;
}

/* ───────────────────────── Client gate runner ───────────────────────── */

/**
 * True when the job's render is (or will be) on screen: a size preview the shopper asked for,
 * or a swap render whose SKU is still a candidate once the form has re-ranked them. Before
 * the form the candidates are only the speculative picks, and the shopper sees no cards yet.
 */
export function isShownJob(r: ReturnCase, job: RenderJob): boolean {
  if (job.phase === "size_preview") return true;
  return r.timeline.formSubmittedAt !== null && r.candidates.some((c) => c.skuId === job.skuId);
}

/** Jobs the client gate should check: finished, ungated, not superseded, with an image, shown. */
export function gateableJobs(r: ReturnCase): RenderJob[] {
  return r.renders.filter(
    (j) => j.status === "success" && j.gate === null && !j.supersededBy && j.resultUrl !== null && isShownJob(r, j),
  );
}

/** Next job to gate, skipping ids already attempted / in flight. Candidate rank order, then oldest first. */
export function pickNextGateJob(r: ReturnCase, exclude: ReadonlySet<string>): RenderJob | null {
  if (!r.photo || !r.measurements) return null;
  const rank = new Map(r.candidates.map((c, i) => [c.skuId, i]));
  const order = (j: RenderJob) => (j.phase === "size_preview" ? -1 : (rank.get(j.skuId) ?? Number.MAX_SAFE_INTEGER));
  const jobs = gateableJobs(r).filter((j) => !exclude.has(j.id));
  jobs.sort((a, b) => order(a) - order(b) || (a.finishedAt ?? a.queuedAt).localeCompare(b.finishedAt ?? b.queuedAt));
  return jobs[0] ?? null;
}

/** Jobs that count against MAX_RENDERS_PER_RETURN (everything except 'skipped'). */
export function renderBudgetUsed(r: ReturnCase): number {
  return r.renders.filter((j) => j.status !== "skipped").length;
}

/**
 * Mirrors orchestrator.requestGateRetry's preconditions so the gate knows if 'retry' is possible:
 * never for a size preview (its button promises 1 credit), only for a swap card still on screen.
 */
export function canRetryJob(r: ReturnCase, job: RenderJob, maxRenders: number): boolean {
  if (job.retryOf !== null || job.supersededBy !== null) return false;
  if (job.phase === "size_preview" || !r.candidates.some((c) => c.skuId === job.skuId)) return false;
  const sku = getSku(job.skuId);
  if (!sku?.altImage) return false;
  return renderBudgetUsed(r) < maxRenders;
}

/** Honest fallback when the in-browser gate can't run (e.g. the vision model failed to load). */
export function unavailableGate(message: string, computeMs: number, nowIso: string): GateResult {
  return {
    verdict: "badge",
    metrics: {
      colourDeltaE: null,
      residueFraction: null,
      silhouetteIoU: null,
      identityDiff: null,
      hemErrorCm: null,
      garmentCoverage: null,
    },
    reasons: [`gate unavailable: ${message}`.slice(0, 300)],
    badge: "Preview not auto-checked",
    computedAt: nowIso,
    computeMs: Math.max(0, Math.round(computeMs)),
  };
}

/* ───────────────────────── Render cards ───────────────────────── */

export type CardView =
  | { kind: "catalog"; why: "no_photo" | "not_rendered" | "failed"; job: RenderJob | null }
  | { kind: "rendering"; job: RenderJob; retrying: boolean }
  | { kind: "checking"; job: RenderJob; retrying: boolean }
  | { kind: "ready"; job: RenderJob; gate: GateResult | null; badgeText: string | null }
  | { kind: "dropped"; job: RenderJob; gate: GateResult };

export const SHOPPER_PHASES: readonly RenderPhase[] = ["speculative", "post_diagnosis", "retry"];
export const ALL_PHASES: readonly RenderPhase[] = ["speculative", "post_diagnosis", "retry", "size_preview"];

/**
 * Jobs for a SKU. `size: null` matches any size — the server dedupes renders per SKU
 * (try-on can't show size), so a size preview of another size reuses the same render.
 */
export function jobsFor(
  r: ReturnCase,
  skuId: string,
  size: SizeCode | null,
  phases: readonly RenderPhase[] = SHOPPER_PHASES,
): RenderJob[] {
  return r.renders.filter(
    (j) =>
      j.skuId === skuId && (size === null || j.size === size) && j.status !== "skipped" && phases.includes(j.phase),
  );
}

/** The live end of a retry chain: not superseded, most recently queued. */
export function headJob(jobs: RenderJob[]): RenderJob | null {
  const live = jobs.filter((j) => !j.supersededBy);
  const pool = live.length ? live : jobs;
  let best: RenderJob | null = null;
  for (const j of pool) if (!best || j.queuedAt >= best.queuedAt) best = j;
  return best;
}

const APPROXIMATE = "Preview approximate";

export function cardViewFor(
  r: ReturnCase,
  skuId: string,
  size: SizeCode | null,
  phases: readonly RenderPhase[] = SHOPPER_PHASES,
): CardView {
  if (!r.photo) return { kind: "catalog", why: "no_photo", job: null };
  const jobs = jobsFor(r, skuId, size, phases);
  const head = headJob(jobs);
  if (!head) return { kind: "catalog", why: "not_rendered", job: null };

  const retrying = head.retryOf !== null;
  const original = retrying ? (jobs.find((j) => j.id === head.retryOf) ?? null) : null;

  switch (head.status) {
    case "queued":
    case "running":
      return { kind: "rendering", job: head, retrying };
    case "failed":
    case "skipped": {
      // A failed retry falls back to the original render, honestly badged — or hidden when
      // the original failed severely (its gate said: drop if no retry).
      if (original && original.status === "success" && original.resultUrl) {
        if (original.gate?.fallbackVerdict === "drop") return { kind: "dropped", job: original, gate: original.gate };
        return {
          kind: "ready",
          job: original,
          gate: original.gate,
          badgeText: original.gate?.badge ?? APPROXIMATE,
        };
      }
      return { kind: "catalog", why: "failed", job: head };
    }
    case "success": {
      if (!head.resultUrl) return { kind: "catalog", why: "failed", job: head };
      const gate = head.gate;
      if (!gate) return { kind: "checking", job: head, retrying };
      if (gate.verdict === "drop") return { kind: "dropped", job: head, gate };
      if (gate.verdict === "pass") return { kind: "ready", job: head, gate, badgeText: null };
      return { kind: "ready", job: head, gate, badgeText: gate.badge ?? APPROXIMATE };
    }
  }
}

export type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info";

export function gateBadgeFor(view: CardView): { tone: BadgeTone; text: string; icon: "check" | "alert" | "spin" | null } | null {
  switch (view.kind) {
    case "rendering":
      return view.retrying ? { tone: "info", text: "Re-checking…", icon: "spin" } : null;
    case "checking":
      return view.retrying
        ? { tone: "info", text: "Re-checking…", icon: "spin" }
        : { tone: "neutral", text: "Checking…", icon: "spin" };
    case "ready":
      return view.badgeText
        ? { tone: "warn", text: view.badgeText, icon: "alert" }
        : { tone: "ok", text: "Checked", icon: "check" };
    case "dropped":
      return { tone: "bad", text: "Didn't pass", icon: "alert" };
    case "catalog":
      return null;
  }
}

/** True when the card is currently displaying (or blurring) a try-on render. */
export function showsRender(view: CardView): boolean {
  return view.kind === "ready" || view.kind === "checking" || view.kind === "dropped";
}

/* ───────────────────────── Honest clock ───────────────────────── */

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * "Renders started at photo upload · form done 0:24 · first card 0:27 (3 s after form)".
 * Null when there was no photo (nothing was rendered).
 * - A photo added after the form (no-photo path → "Add photo") is timed from the photo only:
 *   the form was done before the photo existed, so "form done" / "after form" would be fiction.
 * - `rendering: false` (nothing queued or running) with no first card: no card is coming,
 *   so say so instead of ticking forever.
 */
export function honestClockLine(
  t: ReturnCase["timeline"],
  nowMs: number,
  opts: { rendering?: boolean } = {},
): string | null {
  const photo = ms(t.photoAt);
  if (photo === null) return null;
  const formAt = ms(t.formSubmittedAt);
  const form = formAt !== null && formAt >= photo ? formAt : null;
  const first = ms(t.firstCardAt);
  const parts = ["Renders started at photo upload"];
  if (form !== null) parts.push(`form done ${formatClock(form - photo)}`);
  if (first !== null) {
    let card = `first card ${formatClock(first - photo)}`;
    if (form !== null) {
      const after = first - form;
      card += after >= 0 ? ` (${Math.round(after / 1000)} s after form)` : " (ready before the form was done)";
    }
    parts.push(card);
  } else if (opts.rendering === false) {
    parts.push("no previews could be shown");
  } else {
    parts.push(`first card rendering · ${formatClock(nowMs - photo)}`);
  }
  return parts.join(" · ");
}

/* ───────────────────────── Geometry helpers (camera + overlay) ───────────────────────── */

export const CAPTURE_ASPECT = 3 / 4; // width / height, portrait

/** Centre crop of a w×h frame to the given aspect (w/h) — matches CSS object-fit: cover. */
export function centerCropRect(
  width: number,
  height: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  if (width / height > aspect) {
    const w = Math.round(height * aspect);
    return { x: Math.round((width - w) / 2), y: 0, width: w, height };
  }
  const h = Math.round(width / aspect);
  return { x: 0, y: Math.round((height - h) / 2), width, height: h };
}

/** Translate keypoints into a crop's coordinate space. */
export function offsetKeypoints(kp: BodyKeypoints, dx: number, dy: number): BodyKeypoints {
  const out = {} as BodyKeypoints;
  for (const key of Object.keys(kp) as (keyof BodyKeypoints)[]) {
    const p = kp[key];
    out[key] = { x: p.x - dx, y: p.y - dy, visibility: p.visibility };
  }
  return out;
}

/**
 * Vertical label placement without overlaps: keeps input order by y, pushes labels
 * apart by at least `minGap`, and keeps them inside [minY, maxY] where possible.
 */
export function layoutLabels(ys: number[], minGap: number, minY: number, maxY: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const { y, i } of order) {
    const placed = Math.max(y, prev + minGap, minY);
    out[i] = placed;
    prev = placed;
  }
  let next = Infinity;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k].i;
    const placed = Math.min(out[i], next - minGap, maxY);
    out[i] = placed;
    next = placed;
  }
  return out;
}

/** Parse an optional height field (cm). Null when empty or outside a plausible adult range. */
export function parseHeightCm(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 120 || n > 230) return null;
  return Math.round(n * 10) / 10;
}

/* ───────────────────────── App status ───────────────────────── */

/**
 * Live renders are possible on this server but locked for this browser: a Clothsy key is set,
 * the mode would go live, the daily cap isn't reached, yet a new render would use the dev
 * double. That only happens when LIVE_ACCESS_CODE is set and this browser hasn't unlocked,
 * and the server then behaves as replay (cached renders, misses simulated).
 */
export function liveLockedFor(status: AppStatus | null): boolean {
  if (!status) return false;
  return (
    (status.mode === "auto" || status.mode === "live") &&
    status.hasClothsyKey &&
    status.activeProvider === "dev" &&
    status.liveRendersToday < status.dailyLiveCap
  );
}
