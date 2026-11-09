// Headline KPI tiles. Values use proportional figures (no tabular-nums at display size).
import type { ReactNode } from "react";
import { cx, formatUsd } from "@/components/ui";
import type { MerchantMetrics } from "@/lib/types";
import { formatCount, formatCredits, formatPct, formatSmallUsd } from "./format";

export function KpiTile({
  label,
  value,
  sub,
  highlight = false,
  compact = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  highlight?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={cx(
        "min-w-0 rounded-2xl border bg-surface shadow-card transition-[border-color,box-shadow] duration-500 motion-reduce:transition-none",
        compact ? "p-3.5" : "p-4 sm:p-5",
        highlight ? "border-accent ring-2 ring-accent/30" : "border-line",
      )}
    >
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cx("mt-1 font-semibold tracking-tight text-ink", compact ? "text-2xl" : "text-3xl")}>{value}</div>
      {sub ? <div className="mt-1 text-xs leading-relaxed text-muted">{sub}</div> : null}
    </div>
  );
}

export function KpiRow({
  metrics,
  compact = false,
  highlightRevenue = false,
}: {
  metrics: MerchantMetrics;
  compact?: boolean;
  highlightRevenue?: boolean;
}) {
  const t = metrics.totals;
  const resolved = t.exchanges + t.refunds;
  const open = Math.max(0, t.returnsStarted - resolved);
  const exchangeRate = resolved > 0 ? t.exchanges / resolved : null;
  const perPhotoReturn = t.photoOptIns > 0 ? t.creditsSpent / t.photoOptIns : null;

  return (
    <div className={cx("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-4")}>
      <KpiTile
        compact={compact}
        label="Refunds → exchanges"
        value={formatPct(exchangeRate)}
        sub={
          resolved > 0 ? (
            <>
              {formatCount(t.exchanges)} exchanges · {formatCount(t.refunds)} refunds
              {open > 0 ? ` · ${formatCount(open)} open` : ""}
            </>
          ) : (
            "No resolved returns yet"
          )
        }
      />
      <KpiTile
        compact={compact}
        highlight={highlightRevenue}
        label="Revenue retained"
        value={formatUsd(t.revenueRetained)}
        sub="Kept as exchanges, net of the exchange bonus"
      />
      <KpiTile
        compact={compact}
        label="Photo opt-in"
        value={formatPct(t.photoOptInRate)}
        sub={`${formatCount(t.photoOptIns)} ${t.photoOptIns === 1 ? "shopper" : "shoppers"} took the photo`}
      />
      <KpiTile
        compact={compact}
        label="Credits per return"
        value={formatCredits(t.creditsPerReturn)}
        sub={
          <>
            {formatSmallUsd(t.costPerReturnUsd)} per return · {formatCount(t.creditsSpent)} credits
            {perPhotoReturn !== null ? ` · ${formatCredits(perPhotoReturn)} per photo return` : ""}
            {t.simulatedRenders > 0 ? ` · ${formatCount(t.simulatedRenders)} simulated (0 credits)` : ""}
          </>
        }
      />
    </div>
  );
}
