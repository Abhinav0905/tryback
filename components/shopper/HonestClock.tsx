"use client";

// The "honest clock": zero is the moment the photo was uploaded (when speculative
// renders start), not the moment the shopper finished the form. We show it live
// on the form step and as a one-line receipt on the results.

import { cx } from "@/components/ui";
import type { ReturnCase } from "@/lib/types";
import { honestClockLine } from "./flow";
import { formatClock, plural } from "./format";
import { IconClock } from "./primitives";
import { useNow } from "./useNow";

export function HonestClockLive({
  photoAt,
  total,
  ready,
  failed,
  className,
}: {
  photoAt: string;
  total: number;
  ready: number;
  failed: number;
  className?: string;
}) {
  const now = useNow(true);
  const start = Date.parse(photoAt);
  const elapsed = Number.isFinite(start) ? now - start : 0;
  const rendering = Math.max(0, total - ready - failed);

  let status: string;
  if (total === 0) status = "Previews will start when we know what you're after";
  else if (rendering > 0) status = `${plural(total, "preview")} rendering on your photo · ${ready} ready`;
  else if (ready > 0) status = `${ready} of ${total} previews ready`;
  else status = "We'll pick fresh swaps from your answers";

  return (
    <div className={cx("flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3", className)}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <IconClock className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted">Renders started at photo upload</p>
        <p className="text-sm font-medium text-ink" aria-live="polite" aria-atomic="true">
          {status}
        </p>
      </div>
      <span role="timer" className="tabular text-lg font-semibold text-ink" aria-label={`${Math.floor(elapsed / 1000)} seconds since upload`}>
        {formatClock(elapsed)}
      </span>
    </div>
  );
}

export function HonestClockLine({
  timeline,
  rendering,
  className,
}: {
  timeline: ReturnCase["timeline"];
  /** Any render still queued/running; when false and there's no first card, the clock stops. */
  rendering: boolean;
  className?: string;
}) {
  const now = useNow(timeline.firstCardAt === null && rendering);
  const line = honestClockLine(timeline, now, { rendering });
  if (!line) return null;
  return (
    <p className={cx("tabular flex items-start gap-1.5 text-xs leading-relaxed text-muted", className)}>
      <IconClock className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{line}</span>
    </p>
  );
}
