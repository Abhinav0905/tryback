"use client";

// Mobile-first chrome for every shopper screen: fictional-brand header, demo-mode
// banner, step indicator, and the persistent "Skip to refund" footer.

import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import { BRAND } from "@/lib/catalog";
import { liveLockedFor, type StepDef } from "./flow";
import { useAppStatus } from "./useAppStatus";

export function StepIndicator({ steps, current, className }: { steps: StepDef[]; current: number; className?: string }) {
  const active = steps[current];
  return (
    <nav aria-label="Return progress" className={className}>
      <ol className="flex gap-1.5">
        {steps.map((s, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={s.id} className="min-w-0 flex-1" aria-current={state === "current" ? "step" : undefined}>
              <span
                aria-hidden
                className={cx(
                  "block h-1 rounded-full motion-safe:transition-colors motion-safe:duration-500",
                  state === "done" && "bg-accent",
                  state === "current" && "bg-ink",
                  state === "todo" && "bg-line",
                )}
              />
              <span
                className={cx(
                  "mt-1.5 block truncate text-[11px]",
                  state === "current" ? "font-medium text-ink" : "text-muted",
                )}
              >
                <span className="sr-only">
                  {state === "done" ? "Completed: " : state === "current" ? "Current step: " : "Upcoming: "}
                </span>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      {active ? (
        <p className="sr-only">
          Step {current + 1} of {steps.length}: {active.label}
        </p>
      ) : null}
    </nav>
  );
}

/**
 * Shown whenever a new render would be simulated. In replay mode (or a live deployment this
 * browser hasn't unlocked) cached live renders still replay, so the banner says exactly that
 * instead of claiming everything is simulated.
 */
export function DemoBanner({ replay = false }: { replay?: boolean }) {
  return (
    <p
      role="note"
      className="mt-4 flex items-center gap-2 rounded-xl bg-warn-soft px-3 py-2 text-xs font-medium text-warn"
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
      {replay
        ? "Replay mode — cached previews replay, new ones are simulated, 0 credits"
        : "Demo mode — renders are simulated, 0 credits"}
    </p>
  );
}

export function ShopperShell({
  children,
  steps,
  currentStep,
  onSkipToRefund,
  notice,
}: {
  children: ReactNode;
  steps?: StepDef[];
  currentStep?: number;
  /** When set, the sticky "Skip to refund" footer is shown. */
  onSkipToRefund?: () => void;
  notice?: ReactNode;
}) {
  const { status } = useAppStatus();
  return (
    <div className="flex w-full flex-1 flex-col">
      <a
        href="#shopper-main"
        className="sr-only rounded-lg bg-surface px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:shadow-card"
      >
        Skip to content
      </a>
      <header className="mx-auto w-full max-w-[460px] px-5 pt-5">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/r"
            className="flex items-baseline gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            <span className="text-[17px] font-semibold tracking-tight">{BRAND.name}</span>
            <span className="rounded-full border border-line px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-muted">
              Fictional brand
            </span>
          </Link>
          <span className="text-xs text-muted">
            Returns by <span className="font-semibold text-ink">TryBack</span>
          </span>
        </div>
        {status?.activeProvider === "dev" ? (
          <DemoBanner replay={status.mode === "replay" || liveLockedFor(status)} />
        ) : null}
        {steps && currentStep !== undefined ? (
          <StepIndicator steps={steps} current={currentStep} className="mt-5" />
        ) : null}
        {notice}
      </header>

      <main id="shopper-main" className="mx-auto w-full max-w-[460px] flex-1 px-5 pb-10 pt-6">
        {children}
      </main>

      {onSkipToRefund ? (
        <footer className="sticky bottom-0 z-20 border-t border-line bg-bg/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-[460px] items-center justify-between gap-3 px-5 py-2.5">
            <p className="text-xs text-muted">Rather have your money back?</p>
            <button
              type="button"
              onClick={onSkipToRefund}
              className="rounded-lg px-2 py-1.5 text-sm font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              Skip to refund
            </button>
          </div>
        </footer>
      ) : (
        <footer className="mx-auto w-full max-w-[460px] px-5 pb-6 text-[11px] leading-relaxed text-muted">
          {BRAND.name} is a fictional brand created for the TryBack hackathon demo.{" "}
          <a
            href="/catalog/credits.html"
            target="_blank"
            rel="noopener"
            className="rounded-sm underline decoration-line underline-offset-2 hover:text-ink hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Product photo credits
          </a>
        </footer>
      )}
    </div>
  );
}

/** Live status pill for the landing page: which try-on mode is active right now. */
export function ModePill({ className }: { className?: string }) {
  const { status, failed } = useAppStatus();
  if (failed) {
    return (
      <span className={cx("inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-muted", className)}>
        Status unavailable
      </span>
    );
  }
  if (!status) {
    return (
      <span
        aria-hidden
        className={cx("tb-skeleton inline-block h-[26px] w-44 rounded-full", className)}
      />
    );
  }
  let label: string;
  let detail: string | null = null;
  let tone: "ok" | "warn" | "info";
  if (status.mode === "replay" || liveLockedFor(status)) {
    label = "Replay mode";
    detail = "cached renders, misses simulated";
    tone = "info";
  } else if (status.activeProvider === "clothsy") {
    label = "Live · Clothsy try-on";
    detail = `${status.liveRendersToday}/${status.dailyLiveCap} live renders today`;
    tone = "ok";
  } else {
    label = "Demo mode";
    detail = "simulated renders, 0 credits";
    tone = "warn";
  }
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        tone === "ok" && "bg-ok-soft text-ok",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "info" && "bg-info-soft text-info",
        className,
      )}
    >
      <span aria-hidden className="relative flex h-2 w-2">
        {tone === "ok" ? (
          <span className="absolute inline-flex h-full w-full rounded-full bg-ok opacity-60 motion-safe:animate-ping" />
        ) : null}
        <span
          className={cx(
            "relative inline-flex h-2 w-2 rounded-full",
            tone === "ok" && "bg-ok",
            tone === "warn" && "bg-warn",
            tone === "info" && "bg-info",
          )}
        />
      </span>
      {label}
      {detail ? <span className="font-normal opacity-80">· {detail}</span> : null}
    </span>
  );
}
