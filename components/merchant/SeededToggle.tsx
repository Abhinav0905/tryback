"use client";

import { cx } from "@/components/ui";

/** Switch for including the labelled, seeded demo history in every number on the page. */
export function SeededToggle({
  checked,
  onChange,
  compact = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cx(
        "group inline-flex items-center gap-2.5 rounded-xl py-1.5 pr-2 text-left text-sm text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors motion-reduce:transition-none",
          checked ? "border-accent bg-accent" : "border-line bg-surface-2",
        )}
      >
        <span
          className={cx(
            "absolute h-3.5 w-3.5 rounded-full shadow-card transition-transform motion-reduce:transition-none",
            checked ? "translate-x-[18px] bg-accent-ink" : "translate-x-[3px] bg-muted",
          )}
        />
      </span>
      <span className={compact ? "text-xs" : undefined}>Include seeded demo history (labelled)</span>
    </button>
  );
}
