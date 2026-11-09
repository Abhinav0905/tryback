"use client";

// Chart primitives for the merchant views: plain HTML/CSS + design tokens, no chart library.
// Follows the dataviz method: thin marks (≤ 24 px) with 4 px rounded data-ends square at the
// baseline, a 2 px surface gap between touching fills, solid hairline grids, values in text
// tokens (never the series colour), per-mark hover + keyboard-focus tooltips that never gate a
// value (every value is printed or available in a table view), and status colours only where
// the colour means good/bad — always with an icon and a label.

import { useId, useState, type ReactNode } from "react";
import { Swatch, cx } from "@/components/ui";
import { getSku } from "@/lib/catalog";
import type { GateVerdict, IssueType, MerchantMetrics, TransitionType } from "@/lib/types";
import {
  ISSUE_LABEL,
  TRANSITION_HINT,
  TRANSITION_LABEL,
  VERDICT_HINT,
  VERDICT_LABEL,
  VERDICT_ORDER,
  formatLatency,
  formatPct,
  niceMaxMs,
} from "./format";
import { AlertIcon, CheckIcon, ClockIcon, VerdictIcon } from "./icons";

/* ───────────── Tooltip ───────────── */

/**
 * Hover + focus tooltip. The wrapped element is the hit target (bigger than the mark); the
 * tooltip enhances only — the same value is always printed nearby or in a table view.
 */
export function Tip({
  content,
  children,
  className,
  align = "start",
  label,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  /** Accessible name for the focusable target. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div
      tabIndex={0}
      role={label ? "group" : undefined}
      aria-label={label}
      aria-describedby={id}
      className={cx(
        "group/tip relative rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      )}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      {children}
      <div
        id={id}
        role="tooltip"
        hidden={!open}
        className={cx(
          "pointer-events-none absolute bottom-full z-30 mb-2 w-max max-w-[18rem] rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-ink shadow-card",
          align === "start" && "left-0",
          align === "center" && "left-1/2 -translate-x-1/2",
          align === "end" && "right-0",
        )}
      >
        {content}
      </div>
    </div>
  );
}

/** Tooltip body: value first (strong), label second. */
function TipLine({ value, label, keyClass }: { value: ReactNode; label: ReactNode; keyClass?: string }) {
  return (
    <div className="flex items-center gap-2">
      {keyClass ? <span aria-hidden className={cx("h-0.5 w-3 rounded-full", keyClass)} /> : null}
      <span className="tabular font-semibold">{value}</span>
      <span className="text-muted">{label}</span>
    </div>
  );
}

/* ───────────── Status tones ───────────── */

export type StatusTone = "ok" | "warn" | "bad";

export function passTone(rate: number | null): StatusTone | null {
  if (rate === null) return null;
  if (rate >= 0.7) return "ok";
  if (rate >= 0.5) return "warn";
  return "bad";
}

const TONE_FILL: Record<StatusTone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };
const TONE_TRACK: Record<StatusTone, string> = { ok: "bg-ok-soft", warn: "bg-warn-soft", bad: "bg-bad-soft" };
const TONE_TEXT: Record<StatusTone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad" };

export const VERDICT_FILL: Record<GateVerdict, string> = {
  pass: "bg-ok",
  badge: "bg-warn",
  retry: "bg-info",
  drop: "bg-bad",
};
export const VERDICT_TEXT: Record<GateVerdict, string> = {
  pass: "text-ok",
  badge: "text-warn",
  retry: "text-info",
  drop: "text-bad",
};

/* ───────────── Meter ───────────── */

/** Ratio against 100%: the fill carries severity, the track is a lighter step of the same ramp. */
export function PassMeter({ rate, className }: { rate: number | null; className?: string }) {
  const tone = passTone(rate);
  if (rate === null || tone === null) {
    return <span className={cx("text-xs text-muted", className)}>Not gated yet</span>;
  }
  const pct = Math.round(rate * 100);
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <div className={cx("h-1.5 min-w-10 flex-1 overflow-hidden rounded-full", TONE_TRACK[tone])} aria-hidden>
        <div className={cx("h-full rounded-full", TONE_FILL[tone])} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="tabular inline-flex items-center gap-1 text-xs font-medium text-ink">
        {tone === "ok" ? (
          <CheckIcon size={12} className={TONE_TEXT[tone]} />
        ) : (
          <AlertIcon size={12} className={TONE_TEXT[tone]} />
        )}
        {pct}%<span className="sr-only"> gate pass rate</span>
      </span>
    </div>
  );
}

/* ───────────── Latency by transition ───────────── */

export interface LatencyRow {
  transition: TransitionType;
  count: number;
  p50: number | null;
  p95: number | null;
  gatePassRate: number | null;
  /** Optional suffix under the label, e.g. "2 simulated". */
  note?: string;
}

export function latencyRowsFrom(metrics: MerchantMetrics): LatencyRow[] {
  return (Object.keys(TRANSITION_LABEL) as TransitionType[]).map((t) => {
    const s = metrics.latency.byTransition[t];
    return { transition: t, count: s?.count ?? 0, p50: s?.p50 ?? null, p95: s?.p95 ?? null, gatePassRate: s?.gatePassRate ?? null };
  });
}

/**
 * One row per transition on a shared seconds axis: the solid segment runs 0 → p50 (typical
 * wait), the lighter step of the same hue continues to p95 (tail). Gate pass rate sits beside
 * it as a severity meter. Two series (p50, p95 tail) → legend always shown.
 */
export function LatencyByTransition({
  rows,
  showGate = true,
  minCountForEmphasis = 3,
}: {
  rows: LatencyRow[];
  showGate?: boolean;
  minCountForEmphasis?: number;
}) {
  const maxP95 = Math.max(0, ...rows.map((r) => r.p95 ?? r.p50 ?? 0));
  const { max, step } = niceMaxMs(maxP95);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  const pct = (ms: number) => Math.min(100, Math.max(0, (ms / max) * 100));

  const eligible = rows.filter((r) => r.count >= minCountForEmphasis && r.p50 !== null);
  const slowest =
    eligible.length >= 2 ? eligible.reduce((a, b) => ((b.p50 ?? 0) > (a.p50 ?? 0) ? b : a)).transition : null;

  const grid = showGate
    ? "@xl:grid-cols-[8.75rem_minmax(0,1fr)_5.5rem_7rem]"
    : "@xl:grid-cols-[8.75rem_minmax(0,1fr)_5.5rem]";

  return (
    <div className="@container">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-[2px] bg-info" /> p50 (median)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-[2px] bg-info/35" /> to p95 (tail)
        </span>
        {showGate ? (
          <span className="inline-flex items-center gap-1.5 @xl:ml-auto">
            <span className="h-1.5 w-3 rounded-full bg-ok" /> gate pass rate
          </span>
        ) : null}
      </div>

      <ul className="space-y-1" aria-label="Render latency and gate pass rate by transition type">
        {rows.map((r) => {
          const has = r.count > 0 && r.p50 !== null;
          const p50 = r.p50 ?? 0;
          const p95 = Math.max(p50, r.p95 ?? p50);
          const p50Pct = pct(p50);
          const p95Pct = pct(p95);
          const hasTail = p95Pct - p50Pct > 0.8;
          const summary = has
            ? `${TRANSITION_LABEL[r.transition]}: ${r.count} renders, p50 ${formatLatency(r.p50)}, p95 ${formatLatency(r.p95)}, gate pass ${formatPct(r.gatePassRate)}`
            : `${TRANSITION_LABEL[r.transition]}: no renders yet`;
          return (
            <li key={r.transition}>
              <Tip
                label={summary}
                className="-mx-2 px-2 py-1.5 hover:bg-surface-2/60"
                content={
                  <div className="space-y-0.5">
                    <div className="font-medium">{TRANSITION_LABEL[r.transition]}</div>
                    <div className="text-muted">{TRANSITION_HINT[r.transition]}</div>
                    {has ? (
                      <>
                        <TipLine value={formatLatency(r.p50)} label="p50" keyClass="bg-info" />
                        <TipLine value={formatLatency(r.p95)} label="p95" keyClass="bg-info/35" />
                        <TipLine value={formatPct(r.gatePassRate)} label="gate pass rate" />
                        <TipLine value={r.count} label={r.count === 1 ? "render" : "renders"} />
                      </>
                    ) : (
                      <div className="text-muted">No renders yet</div>
                    )}
                  </div>
                }
              >
                <div className={cx("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1", grid)}>
                  <div className="order-1 min-w-0">
                    <div className="truncate text-sm font-medium text-ink">{TRANSITION_LABEL[r.transition]}</div>
                    <div className="tabular flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                      <span>
                        n = {r.count}
                        {r.note ? ` · ${r.note}` : ""}
                      </span>
                      {slowest === r.transition ? (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-surface-2 px-1.5 text-[10px] font-medium text-ink">
                          <ClockIcon size={10} /> slowest
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="tabular order-2 text-right text-sm @xl:order-3">
                    {has ? (
                      <>
                        <span className="font-semibold text-ink">{formatLatency(r.p50)}</span>
                        <span className="text-muted"> / {formatLatency(r.p95)}</span>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </div>

                  <div className="relative order-3 col-span-2 h-5 @xl:order-2 @xl:col-span-1" aria-hidden>
                    {ticks.map((t) => (
                      <span
                        key={t}
                        className="absolute inset-y-0 w-px bg-line"
                        style={{ left: `${pct(t)}%` }}
                      />
                    ))}
                    {has ? (
                      <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2">
                        <span
                          className={cx("absolute inset-y-0 left-0 bg-info", !hasTail && "rounded-r-[4px]")}
                          style={{ width: hasTail ? `calc(${p50Pct}% - 1px)` : `${Math.max(p50Pct, 0.8)}%` }}
                        />
                        {hasTail ? (
                          <span
                            className="absolute inset-y-0 rounded-r-[4px] bg-info/35"
                            style={{ left: `calc(${p50Pct}% + 1px)`, width: `calc(${p95Pct - p50Pct}% - 1px)` }}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted">No renders yet</span>
                    )}
                  </div>

                  {showGate ? (
                    <div className="order-4 col-span-2 flex items-center gap-2 @xl:col-span-1">
                      <span className="shrink-0 text-[11px] text-muted @xl:hidden">Gate pass</span>
                      <PassMeter rate={r.gatePassRate} className="min-w-0 flex-1" />
                    </div>
                  ) : null}
                </div>
              </Tip>
            </li>
          );
        })}
      </ul>

      {/* Axis (aligned with the track column) */}
      <div className={cx("mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3", grid)} aria-hidden>
        <div className="hidden @xl:block" />
        <div className="tabular relative col-span-2 h-4 text-[10px] text-muted @xl:col-span-1">
          {ticks.map((t, i) => (
            <span
              key={t}
              className={cx(
                "absolute top-0 whitespace-nowrap",
                i === 0 ? "translate-x-0" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${pct(t)}%` }}
            >
              {t / 1000} s
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Table twin of LatencyByTransition (the accessible, copyable view). */
export function LatencyTable({ rows, caption }: { rows: LatencyRow[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th scope="col" className="py-2 pr-3 font-medium">Transition</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Renders</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">p50</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">p95</th>
            <th scope="col" className="py-2 text-right font-medium">Gate pass</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.transition} className="border-b border-line last:border-0">
              <th scope="row" className="py-2 pr-3 font-medium text-ink">
                {TRANSITION_LABEL[r.transition]}
              </th>
              <td className="py-2 pr-3 text-right">{r.count}</td>
              <td className="py-2 pr-3 text-right">{formatLatency(r.p50)}</td>
              <td className="py-2 pr-3 text-right">{formatLatency(r.p95)}</td>
              <td className="py-2 text-right">{formatPct(r.gatePassRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────── Gate verdicts: tall segmented bar ───────────── */

/**
 * One whole (gated renders) split into ≤ 4 status parts. Each part is its own 4 px-cornered
 * block separated by a 2 px surface gap; its share is printed inside only when it fits, and
 * the legend repeats name + icon (status colours never carry meaning alone).
 */
export function GateVerdictBar({ gate, compact = false }: { gate: MerchantMetrics["gate"]; compact?: boolean }) {
  const total = gate.total;
  if (total === 0) {
    return <p className="text-sm text-muted">No previews have been through the fidelity gate yet.</p>;
  }
  const parts = VERDICT_ORDER.map((v) => ({ v, n: gate[v], share: gate[v] / total }));
  return (
    <div>
      <div
        role="group"
        aria-label={`Gate verdicts for ${total} previews`}
        className="flex h-7 w-full gap-0.5"
      >
        {parts
          .filter((p) => p.n > 0)
          .map((p) => (
            <div key={p.v} className="h-full min-w-1" style={{ flex: `${p.n} 1 0%` }}>
              <Tip
                align="center"
                label={`${VERDICT_LABEL[p.v]}: ${p.n} of ${total} (${formatPct(p.share)})`}
                className="h-full"
                content={
                  <div className="space-y-0.5">
                    <TipLine value={`${p.n} · ${formatPct(p.share)}`} label={VERDICT_LABEL[p.v]} />
                    <div className="text-muted">{VERDICT_HINT[p.v]}</div>
                  </div>
                }
              >
                <div
                  className={cx(
                    "flex h-full items-center rounded-[4px] px-1.5 text-[11px] font-semibold text-surface",
                    VERDICT_FILL[p.v],
                  )}
                >
                  {p.share >= 0.12 ? <span className="tabular">{formatPct(p.share)}</span> : null}
                </div>
              </Tip>
            </div>
          ))}
      </div>
      <ul className={cx("mt-3 grid gap-x-4 gap-y-1.5 text-sm", compact ? "grid-cols-2" : "grid-cols-2 @lg:grid-cols-4")}>
        {parts.map((p) => (
          <li key={p.v} className="flex min-w-0 items-start gap-2">
            <span
              aria-hidden
              className={cx("mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-surface", VERDICT_FILL[p.v])}
            >
              <VerdictIcon verdict={p.v} size={11} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-ink">{VERDICT_LABEL[p.v]}</span>
              <span className="tabular block text-xs text-muted">
                {p.n} · {formatPct(p.share)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── Per-SKU diagnosis bars ───────────── */

/**
 * Small multiples: one block per SKU, its top issues as ranked horizontal bars on a shared
 * 0–100% scale. One series (share of diagnosed returns) → one hue, no legend; values at the tip.
 */
export function SkuDiagnosisBars({
  items,
  limit,
  issuesPerSku = 3,
}: {
  items: MerchantMetrics["skuDiagnoses"];
  limit?: number;
  issuesPerSku?: number;
}) {
  // Prefer SKUs with at least 2 diagnosed returns (a single return reads as a misleading 100%),
  // unless that would leave fewer than 3 SKUs to show.
  const robust = items.filter((s) => s.returns >= 2);
  const pool = robust.length >= 3 ? robust : items;
  const shown = typeof limit === "number" ? pool.slice(0, limit) : pool;
  const hidden = items.length - shown.length;
  if (shown.length === 0) {
    return (
      <p className="text-sm text-muted">
        No diagnosed returns yet. Diagnoses appear once a shopper submits the style &amp; colour form.
      </p>
    );
  }
  return (
    <ul className="space-y-4">
      {shown.map((s) => {
        const sku = getSku(s.skuId);
        const issues = (Object.entries(s.issues) as [IssueType, number][])
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1] || ISSUE_LABEL[a[0]].localeCompare(ISSUE_LABEL[b[0]]))
          .slice(0, issuesPerSku);
        return (
          <li key={s.skuId}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {sku ? <Swatch hex={sku.colorHex} className="translate-y-px" /> : null}
                <span className="truncate text-sm font-medium text-ink">{s.name}</span>
              </div>
              <span className="tabular shrink-0 text-xs text-muted">
                {s.returns} diagnosed {s.returns === 1 ? "return" : "returns"}
              </span>
            </div>
            <ul className="space-y-1">
              {issues.map(([type, n]) => {
                const share = s.returns > 0 ? n / s.returns : 0;
                return (
                  <li key={type}>
                    <Tip
                      label={`${s.name}: ${ISSUE_LABEL[type]} in ${n} of ${s.returns} diagnosed returns (${formatPct(share)})`}
                      className="-mx-1 px-1 py-0.5 hover:bg-surface-2/60"
                      content={
                        <div className="space-y-0.5">
                          <TipLine value={formatPct(share)} label={ISSUE_LABEL[type]} keyClass="bg-accent" />
                          <div className="text-muted">
                            {n} of {s.returns} diagnosed returns
                          </div>
                        </div>
                      }
                    >
                      <div className="grid grid-cols-[6.25rem_minmax(0,1fr)] items-center gap-3">
                        <span className="truncate text-xs text-muted">{ISSUE_LABEL[type]}</span>
                        <div className="relative h-4 border-l border-line" aria-hidden>
                          {/* Track area leaves room on the right so a 100% bar keeps its tip label. */}
                          <div className="absolute inset-y-0 left-0 right-16 flex items-center">
                            <div
                              className="h-2 shrink-0 rounded-r-[4px] bg-accent"
                              style={{ width: `${Math.max(1.5, share * 100)}%` }}
                            />
                            <span className="tabular ml-1.5 whitespace-nowrap text-xs font-medium text-ink">
                              {formatPct(share)}
                              <span className="font-normal text-muted"> · {n}</span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </Tip>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
      {hidden > 0 ? (
        <li className="text-xs text-muted">
          {hidden} more {hidden === 1 ? "SKU" : "SKUs"} with fewer diagnosed returns not shown.
        </li>
      ) : null}
    </ul>
  );
}
