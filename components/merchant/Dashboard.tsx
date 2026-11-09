"use client";

// Fernweave merchant dashboard (fictional brand). Polls /api/metrics every 2 s with
// visibility awareness, raises a "Refund avoided" toast when exchanges increase, and
// renders in two densities: full (/merchant) and compact (/demo's right-hand side).

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, cx } from "@/components/ui";
import { BRAND } from "@/lib/catalog";
import type { MerchantMetrics } from "@/lib/types";
import { GateVerdictBar, SkuDiagnosisBars } from "./charts";
import { formatCount } from "./format";
import { AlertIcon, RefreshIcon } from "./icons";
import { KpiRow } from "./KpiRow";
import { Panel } from "./Panel";
import { RecentReturns } from "./RecentReturns";
import { RefundToast, type RefundToastData } from "./RefundToast";
import { SeededToggle } from "./SeededToggle";
import { TryOnApiPanel } from "./TryOnApiPanel";
import { useMetrics } from "./useMetrics";

const HIGHLIGHT_MS = 4000;

export function Dashboard({
  compact = false,
  initialIncludeSeeded = true,
  syncUrl = false,
  refreshSignal = 0,
}: {
  compact?: boolean;
  initialIncludeSeeded?: boolean;
  /** Reflect the seeded toggle in the page URL (?seeded=0) so reloads keep it. */
  syncUrl?: boolean;
  /** Bump to force an immediate refetch (e.g. after "Reset demo"). */
  refreshSignal?: number;
}) {
  const [includeSeeded, setIncludeSeeded] = useState(initialIncludeSeeded);
  const [toast, setToast] = useState<RefundToastData | null>(null);
  const [highlightRevenue, setHighlightRevenue] = useState(false);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const toastSeq = useRef(0);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onUpdate = useCallback((prev: MerchantMetrics | null, next: MerchantMetrics) => {
    if (!prev || prev.includesSeeded !== next.includesSeeded) return;

    // New or changed rows in the recent list get a short highlight.
    const before = new Map(prev.recent.map((r) => [r.id, `${r.outcome}|${r.at}`]));
    const fresh = next.recent.filter((r) => before.get(r.id) !== `${r.outcome}|${r.at}`).map((r) => r.id);
    if (fresh.length) {
      setFreshIds(new Set(fresh));
      if (freshTimer.current) clearTimeout(freshTimer.current);
      freshTimer.current = setTimeout(() => setFreshIds(new Set()), HIGHLIGHT_MS);
    }

    const gained = next.totals.exchanges - prev.totals.exchanges;
    if (gained > 0) {
      const delta = next.totals.revenueRetained - prev.totals.revenueRetained;
      const latest = next.recent.find((r) => r.outcome === "exchange" && !r.seeded) ?? next.recent.find((r) => r.outcome === "exchange");
      toastSeq.current += 1;
      setToast({
        id: toastSeq.current,
        amount: delta > 0 ? delta : (latest?.retained ?? 0),
        count: gained,
        skuName: gained === 1 ? (latest?.skuName ?? null) : null,
      });
      setHighlightRevenue(true);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightRevenue(false), HIGHLIGHT_MS);
    }
  }, []);

  const { data, error, paused, lastOkAt, stale, refresh } = useMetrics({ includeSeeded, onUpdate });

  useEffect(() => {
    if (refreshSignal > 0) refresh();
  }, [refreshSignal, refresh]);

  useEffect(() => {
    const fresh = freshTimer;
    const highlight = highlightTimer;
    return () => {
      if (fresh.current) clearTimeout(fresh.current);
      if (highlight.current) clearTimeout(highlight.current);
    };
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const toggleSeeded = (next: boolean) => {
    setIncludeSeeded(next);
    if (syncUrl) {
      const url = new URL(window.location.href);
      if (next) url.searchParams.delete("seeded");
      else url.searchParams.set("seeded", "0");
      window.history.replaceState(window.history.state, "", url);
    }
  };

  const status = <LiveStatus error={error} paused={paused} lastOkAt={lastOkAt} />;

  return (
    <div className={cx("@container w-full", compact ? "space-y-3" : "space-y-5")}>
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {compact ? (
              <h2 className="text-lg font-semibold tracking-tight text-ink">{BRAND.name} · Returns</h2>
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{BRAND.name} · Returns</h1>
            )}
            <Badge tone="neutral">Fictional brand</Badge>
          </div>
          <p className={cx("mt-1 text-muted", compact ? "text-xs" : "text-sm")}>
            Exchange-first returns by TryBack · try-on by Clothsy AI (FabricVTON). {BRAND.name} is a fictional demo
            brand.
          </p>
        </div>
        {!compact ? (
          <nav aria-label="TryBack pages" className="flex flex-wrap items-center gap-1 text-sm">
            <Link className="rounded-lg px-3 py-2 text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" href="/r">
              Shopper portal
            </Link>
            <Link className="rounded-lg px-3 py-2 text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" href="/demo">
              Demo
            </Link>
            <Link className="rounded-lg px-3 py-2 text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" href="/bench">
              Transition bench
            </Link>
          </nav>
        ) : null}
      </header>

      {/* Filter row: scopes everything below it */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line py-2">
        <SeededToggle checked={includeSeeded} onChange={toggleSeeded} compact={compact} />
        {includeSeeded ? <Badge tone="info">Includes seeded demo history</Badge> : <Badge tone="neutral">Live returns only</Badge>}
        <div className="ml-auto">{status}</div>
      </div>

      {data === null ? (
        error ? (
          <Card className="flex flex-col items-start gap-3 p-5" role="alert">
            <div className="flex items-center gap-2 text-sm font-medium text-bad">
              <AlertIcon size={16} /> Couldn&apos;t load the dashboard
            </div>
            <p className="text-sm text-muted">{error}. Retrying automatically.</p>
            <Button size="sm" variant="secondary" onClick={refresh}>
              <RefreshIcon /> Retry now
            </Button>
          </Card>
        ) : (
          <DashboardSkeleton compact={compact} />
        )
      ) : (
        <div className={cx("transition-opacity", stale && "opacity-60")} aria-busy={stale}>
          <div className={compact ? "space-y-3" : "space-y-5"}>
            <KpiRow metrics={data} compact={compact} highlightRevenue={highlightRevenue} />

            {compact ? (
              <>
                <TryOnApiPanel metrics={data} compact />
                <div className="grid gap-3 @3xl:grid-cols-2">
                  <Panel title="Recent returns" subtitle={`${formatCount(data.totals.returnsStarted)} returns`}>
                    <RecentReturns items={data.recent} now={data.generatedAt} limit={5} freshIds={freshIds} />
                  </Panel>
                  <Panel title="Fidelity gate" subtitle={`${formatCount(data.gate.total)} previews checked before showing`}>
                    <GateVerdictBar gate={data.gate} compact />
                  </Panel>
                </div>
                <Panel title="Why items come back" subtitle="Share of diagnosed style & colour returns">
                  <SkuDiagnosisBars items={data.skuDiagnoses} limit={3} issuesPerSku={2} />
                </Panel>
              </>
            ) : (
              <div className="grid gap-5 @5xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-5">
                  <TryOnApiPanel metrics={data} />
                  <Panel
                    title="Why items come back"
                    subtitle="Per SKU: share of diagnosed style & colour returns citing each issue (garment attributes only)."
                  >
                    <SkuDiagnosisBars items={data.skuDiagnoses} limit={6} />
                  </Panel>
                </div>
                <div className="min-w-0 space-y-5">
                  <Panel
                    title="Fidelity gate"
                    subtitle={`${formatCount(data.gate.total)} previews checked in the shopper's browser before showing`}
                  >
                    <GateVerdictBar gate={data.gate} />
                  </Panel>
                  <Panel
                    title="Recent returns"
                    subtitle={`${formatCount(data.totals.returnsStarted)} returns started${data.includesSeeded ? " · seeded rows labelled" : ""}`}
                  >
                    <RecentReturns items={data.recent} now={data.generatedAt} freshIds={freshIds} />
                  </Panel>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <RefundToast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

function LiveStatus({ error, paused, lastOkAt }: { error: string | null; paused: boolean; lastOkAt: number | null }) {
  const state = error ? "error" : paused ? "paused" : lastOkAt ? "live" : "loading";
  const time = lastOkAt
    ? new Date(lastOkAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span
        aria-hidden
        className={cx(
          "inline-block h-2 w-2 rounded-full",
          state === "live" && "bg-ok",
          state === "error" && "bg-bad",
          state === "paused" && "bg-muted",
          state === "loading" && "bg-line",
        )}
      />
      <span role={state === "error" ? "alert" : undefined}>
        {state === "live" && <>Live · polling every 2 s</>}
        {state === "paused" && <>Paused while this tab is hidden</>}
        {state === "loading" && <>Connecting…</>}
        {state === "error" && <>Connection problem · retrying</>}
      </span>
      {time ? <span className="tabular hidden sm:inline">· updated {time}</span> : null}
    </div>
  );
}

function DashboardSkeleton({ compact }: { compact: boolean }) {
  return (
    <div className={compact ? "space-y-3" : "space-y-5"} aria-busy="true" aria-label="Loading dashboard">
      <div className={cx("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-4")}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="tb-skeleton h-28 rounded-2xl" />
        ))}
      </div>
      <div className={cx("grid gap-5", !compact && "@5xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]")}>
        <div className="tb-skeleton h-96 rounded-2xl" />
        {!compact ? <div className="tb-skeleton h-96 rounded-2xl" /> : null}
      </div>
    </div>
  );
}
