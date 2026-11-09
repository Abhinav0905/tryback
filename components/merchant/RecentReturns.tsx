// Recent returns list: outcome (icon + label), item, time, revenue kept, seeded tag.
import { Badge, cx, formatUsd } from "@/components/ui";
import type { MerchantMetrics } from "@/lib/types";
import { relativeTime } from "./format";
import { CheckIcon, ClockIcon, ArrowRightIcon } from "./icons";

const OUTCOME = {
  exchange: { label: "Exchange", tone: "ok" as const, Icon: CheckIcon },
  refund: { label: "Refund", tone: "neutral" as const, Icon: ArrowRightIcon },
  open: { label: "Open", tone: "info" as const, Icon: ClockIcon },
};

export function RecentReturns({
  items,
  now,
  limit,
  freshIds,
}: {
  items: MerchantMetrics["recent"];
  now: string;
  limit?: number;
  /** Ids that just appeared or changed (briefly highlighted). */
  freshIds?: ReadonlySet<string>;
}) {
  const shown = typeof limit === "number" ? items.slice(0, limit) : items;
  if (shown.length === 0) {
    return (
      <p className="text-sm text-muted">
        No returns yet. Start one from the shopper portal and it will appear here within 2 seconds.
      </p>
    );
  }
  return (
    <ul className="-mx-2 divide-y divide-line">
      {shown.map((r) => {
        const o = OUTCOME[r.outcome];
        const fresh = freshIds?.has(r.id) ?? false;
        return (
          <li
            key={r.id}
            className={cx(
              "flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors duration-700 motion-reduce:transition-none",
              fresh && "bg-accent-soft",
            )}
          >
            <Badge tone={o.tone} className="w-[5.75rem] shrink-0 justify-center">
              <o.Icon size={12} />
              {o.label}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink">{r.skuName}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <time dateTime={r.at}>{relativeTime(r.at, now)}</time>
                {r.seeded ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>Seeded demo</span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="tabular shrink-0 text-right text-sm">
              {r.outcome === "exchange" ? (
                <span className="font-medium text-ink">{formatUsd(r.retained, { sign: true })}</span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
