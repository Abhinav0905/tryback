"use client";

// "Try-on API" panel: what the try-on provider cares about — render latency (p50/p95)
// and fidelity-gate pass rate by transition type, plus the shopper-perceived wait after
// the form (renders start at photo upload, so most of the API time is hidden).
//
// Seeded demo returns carry generated latencies. Whenever any figure here includes them
// (metrics.latency.seededSamples), the panel says so on the tiles, above the chart and in the
// footnote: they are illustrative, not measurements of the Clothsy API.

import { useState } from "react";
import { Badge, cx } from "@/components/ui";
import type { MerchantMetrics } from "@/lib/types";
import { LatencyByTransition, LatencyTable, latencyRowsFrom } from "./charts";
import { formatCount, formatLatency, formatPct } from "./format";
import { ClockIcon } from "./icons";
import { Panel, ViewToggle } from "./Panel";

function MiniStat({ label, value, sub, emphasis = false }: { label: string; value: string; sub?: string; emphasis?: boolean }) {
  return (
    <div className={cx("min-w-0 rounded-xl px-3 py-2.5", emphasis ? "bg-accent-soft" : "bg-surface-2")}>
      <div className="truncate text-xs text-muted">{label}</div>
      <div className={cx("mt-0.5 text-xl font-semibold tracking-tight", emphasis ? "text-accent" : "text-ink")}>{value}</div>
      {sub ? <div className="truncate text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function TryOnApiPanel({
  metrics,
  compact = false,
  dim = false,
}: {
  metrics: MerchantMetrics;
  compact?: boolean;
  dim?: boolean;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const overall = metrics.latency.overall;
  const ttfc = metrics.latency.timeToFirstCardAfterFormMs;
  const rows = latencyRowsFrom(metrics);
  const hasLatency = overall.count > 0;
  const seeded = metrics.latency.seededSamples ?? { renders: 0, firstCards: 0 };
  const illustrative = seeded.renders > 0 || seeded.firstCards > 0;
  const measuredRenders = Math.max(0, overall.count - seeded.renders);
  const renderSub =
    seeded.renders === 0
      ? `${formatCount(overall.count)} renders measured`
      : measuredRenders > 0
        ? `${formatCount(measuredRenders)} measured + ${formatCount(seeded.renders)} seeded`
        : `${formatCount(seeded.renders)} seeded · illustrative`;

  return (
    <Panel
      title="Try-on API"
      eyebrow="Clothsy AI by FabricVTON"
      subtitle={
        compact
          ? undefined
          : "Render latency and fidelity-gate pass rate by transition type, plus the wait shoppers actually feel."
      }
      dim={dim}
      actions={
        <ViewToggle
          label="Latency view"
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]}
        />
      }
    >
      {illustrative ? (
        <div className="mb-3">
          <Badge tone="warn">Includes seeded history · latencies illustrative, not measured</Badge>
        </div>
      ) : null}
      <div className={cx("mb-4 grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 @2xl:grid-cols-4")}>
        <MiniStat label="Median render (p50)" value={formatLatency(overall.p50)} sub={renderSub} />
        <MiniStat
          label="Tail render (p95)"
          value={formatLatency(overall.p95)}
          sub={seeded.renders > 0 ? "illustrative, not measured" : "95% finish faster"}
        />
        <MiniStat
          emphasis
          label="First card after form (p50)"
          value={formatLatency(ttfc.p50)}
          sub={
            ttfc.count > 0
              ? seeded.firstCards > 0
                ? `p95 ${formatLatency(ttfc.p95)} · ${formatCount(seeded.firstCards)}/${formatCount(ttfc.count)} seeded`
                : `p95 ${formatLatency(ttfc.p95)} · ${formatCount(ttfc.count)} returns`
              : "No timed returns yet"
          }
        />
        <MiniStat
          label="Gate pass · all previews"
          value={formatPct(metrics.gate.total > 0 ? metrics.gate.pass / metrics.gate.total : null)}
          sub={`${formatCount(metrics.gate.total)} previews checked`}
        />
      </div>

      {hasLatency ? (
        view === "chart" ? (
          <LatencyByTransition rows={rows} />
        ) : (
          <LatencyTable rows={rows} caption="Render latency and gate pass rate by transition type" />
        )
      ) : (
        <div className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">
          No Clothsy renders measured yet. Set <code className="font-mono text-ink">CLOTHSY_API_KEY</code> and run a
          return from the shopper portal. (Including the seeded demo history shows illustrative numbers.)
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
        <ClockIcon size={14} className="mt-0.5 shrink-0 text-ink" />
        <p>
          <span className="font-medium text-ink">Renders start at photo upload</span>, while the shopper fills in the
          reason form
          {overall.p50 !== null && ttfc.p50 !== null
            ? `, so a ${formatLatency(overall.p50)} median render becomes a ${formatLatency(ttfc.p50)} median wait after the form. `
            : ", so most of each render overlaps the form instead of adding to the wait. "}
          {illustrative ? (
            <>
              The seeded demo history&apos;s latencies are generated for illustration, not measured on the Clothsy API;
              turn seeded history off to see only renders measured on this server.{" "}
            </>
          ) : null}
          Measured latency counts live Clothsy renders only (cache hits and simulated previews excluded); gate-triggered
          retries count. The gate runs in the shopper&apos;s browser before a preview is shown.
        </p>
      </div>
    </Panel>
  );
}
