"use client";

import { cx } from "@/components/ui";
import type { PreflightCheck } from "@/lib/types";
import { PREFLIGHT_TITLES, plural } from "./format";
import { IconAlert, IconCheck } from "./primitives";

/** Photo checks run on-device by runPreflight. `checks === null` renders the loading skeleton. */
export function PreflightChecklist({ checks, className }: { checks: PreflightCheck[] | null; className?: string }) {
  if (!checks) {
    return (
      <div className={cx("space-y-2", className)} aria-hidden>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5">
            <span className="tb-skeleton h-6 w-6 shrink-0 rounded-full" />
            <span className="tb-skeleton h-3 rounded-full" style={{ width: `${48 + ((i * 17) % 40)}%` }} />
          </div>
        ))}
      </div>
    );
  }

  const failing = checks.filter((c) => !c.ok);
  // Fixes first, then confirmations.
  const ordered = [...failing, ...checks.filter((c) => c.ok)];

  return (
    <div className={className}>
      <p className="mb-3 text-sm font-medium" role="status">
        {failing.length === 0 ? (
          <span className="text-ok">All {checks.length} checks passed</span>
        ) : (
          <span className="text-warn">{plural(failing.length, "thing")} to fix before we can use this photo</span>
        )}
      </p>
      <ul className="space-y-2">
        {ordered.map((c) => (
          <li
            key={c.id}
            className={cx(
              "flex items-start gap-3 rounded-xl px-3 py-2.5",
              c.ok ? "bg-surface" : "border border-warn/30 bg-warn-soft",
            )}
          >
            <span
              className={cx(
                "mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                c.ok ? "bg-ok-soft text-ok" : "bg-surface text-warn",
              )}
            >
              {c.ok ? <IconCheck className="h-3.5 w-3.5" /> : <IconAlert className="h-3.5 w-3.5" />}
              <span className="sr-only">{c.ok ? "Passed:" : "Needs a fix:"}</span>
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">{PREFLIGHT_TITLES[c.id] ?? c.id}</span>
              {c.message ? (
                <span className={cx("block text-[13px] leading-snug", c.ok ? "text-muted" : "text-ink")}>
                  {c.message}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
