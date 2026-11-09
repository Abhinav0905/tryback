"use client";

// The hero of the results screen: a 3:4 render with a compare slider against the
// shopper's real photo, gate + provider labels, why/price/stock, and the swap CTA.

import { useId, type ReactNode } from "react";
import { Badge, Button, Swatch, cx, formatSeconds } from "@/components/ui";
import type { GateResult, ProviderName, SizeCode, Sku } from "@/lib/types";
import { CompareSlider } from "./CompareSlider";
import { gateBadgeFor, showsRender, type CardView } from "./flow";
import { formatClock, percent, priceDiffLabel, stockInfo, TRANSITION_LABELS } from "./format";
import { IconAlert, IconCheck, ProductImage, Spinner } from "./primitives";
import { useNow } from "./useNow";

export interface SwapTarget {
  skuId: string;
  size: SizeCode;
  jobId: string | null;
}

/* ───────────── Labels ───────────── */

export function ProviderLabel({
  provider,
  fromCache = false,
  className,
}: {
  provider: ProviderName;
  /** Served from the render cache: say so, so an instant replay isn't mistaken for render speed. */
  fromCache?: boolean;
  className?: string;
}) {
  const simulated = provider === "dev";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium backdrop-blur",
        simulated ? "bg-warn-soft/90 text-warn" : "bg-surface/85 text-ink",
        className,
      )}
    >
      {simulated ? "Simulated preview" : "AI-generated preview"}
      {fromCache ? <span className="font-normal opacity-80">· replayed from cache</span> : null}
    </span>
  );
}

export function GateBadge({ view, className }: { view: CardView; className?: string }) {
  const b = gateBadgeFor(view);
  if (!b) return null;
  return (
    <Badge tone={b.tone} className={cx("shadow-sm backdrop-blur", className)}>
      {b.icon === "check" ? <IconCheck className="h-3.5 w-3.5" /> : null}
      {b.icon === "alert" ? <IconAlert className="h-3.5 w-3.5" /> : null}
      {b.icon === "spin" ? <Spinner className="h-3 w-3" /> : null}
      {b.text}
    </Badge>
  );
}

function metricRows(gate: GateResult): [string, string][] {
  const m = gate.metrics;
  const rows: [string, string][] = [];
  if (m.colourDeltaE !== null) rows.push(["Colour match (ΔE2000)", m.colourDeltaE.toFixed(1)]);
  if (m.residueFraction !== null) rows.push(["Old colour left over", percent(m.residueFraction)]);
  if (m.silhouetteIoU !== null) rows.push(["Shape overlap (IoU)", m.silhouetteIoU.toFixed(2)]);
  if (m.identityDiff !== null) rows.push(["Face region change", percent(m.identityDiff, 1)]);
  if (m.hemErrorCm !== null) rows.push(["Hem vs measured", `${m.hemErrorCm.toFixed(1)} cm`]);
  if (m.garmentCoverage !== null) rows.push(["Garment coverage", percent(m.garmentCoverage)]);
  return rows;
}

export function GateDetails({ gate, transitionLabel }: { gate: GateResult; transitionLabel?: string }) {
  const rows = metricRows(gate);
  return (
    <details className="group rounded-xl bg-surface-2 px-3 py-2 text-xs">
      <summary className="cursor-pointer list-none select-none rounded text-muted focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1">
          <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5 motion-safe:transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M9 6l6 6-6 6" />
          </svg>
          How we checked this preview
        </span>
      </summary>
      <div className="mt-2 space-y-2 text-muted">
        <p>
          Checked on your device in {formatSeconds(gate.computeMs)}
          {transitionLabel ? ` · ${transitionLabel.toLowerCase()}` : ""}. We compare the preview with your photo
          before showing it.
        </p>
        {rows.length ? (
          <dl className="tabular grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className="text-right text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {gate.reasons.length ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {gate.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/* ───────────── Media area ───────────── */

function Elapsed({ since }: { since: string }) {
  const now = useNow(true);
  const t = Date.parse(since);
  return <span className="tabular">{formatClock(Number.isFinite(t) ? now - t : 0)}</span>;
}

function CardMedia({ view, sku, photoUrl }: { view: CardView; sku: Sku; photoUrl: string | null }) {
  switch (view.kind) {
    case "catalog":
      return (
        <>
          <ProductImage sku={sku} className="absolute inset-0 h-full w-full" />
          <span className="absolute bottom-3 left-3 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] font-medium text-muted backdrop-blur">
            {view.why === "failed" ? "Product photo · preview couldn't be made" : "Product photo"}
          </span>
        </>
      );
    case "rendering":
      return (
        <div className="tb-skeleton absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <Spinner className="h-5 w-5 text-muted" />
          <p className="text-sm font-medium text-ink">
            {view.retrying ? "Trying a cleaner product shot…" : "Rendering on your photo…"}
          </p>
          <p className="text-xs text-muted">
            <Elapsed since={view.job.startedAt ?? view.job.queuedAt} />
            {view.job.status === "queued" ? " · in line" : ""}
          </p>
        </div>
      );
    case "checking":
      return (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- render bytes come from /api/renders */}
          <img
            src={view.job.resultUrl ?? ""}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-70 blur-2xl"
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/40 text-center">
            <Spinner className="h-5 w-5 text-ink" />
            <p className="text-sm font-medium text-ink">Checking the preview…</p>
          </div>
        </>
      );
    case "ready":
      if (!view.job.resultUrl) return null;
      return photoUrl ? (
        <CompareSlider
          beforeSrc={photoUrl}
          afterSrc={view.job.resultUrl}
          beforeAlt="Your photo wearing the item you're returning"
          afterAlt={`Preview of the ${sku.name} on your photo`}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- render bytes come from /api/renders
        <img src={view.job.resultUrl} alt={`Preview of the ${sku.name}`} className="absolute inset-0 h-full w-full object-cover" />
      );
    case "dropped":
      return (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- render bytes come from /api/renders */}
          <img
            src={view.job.resultUrl ?? ""}
            alt={`Rejected preview of the ${sku.name}`}
            className="absolute inset-0 h-full w-full object-cover opacity-60 grayscale"
          />
          <div className="absolute inset-x-3 bottom-3 rounded-xl bg-surface/90 px-3 py-2 text-xs text-ink backdrop-blur">
            This preview didn&apos;t look right, so we hid it. The product itself is fine to swap for.
          </div>
        </>
      );
  }
}

/* ───────────── Card ───────────── */

export function RenderCard({
  sku,
  size,
  why,
  priceDiff,
  view,
  photoUrl,
  emphasis = false,
  actionLabel = "Swap for this",
  onSwap,
  footer,
}: {
  sku: Sku;
  size: SizeCode;
  why: string | null;
  priceDiff: number;
  view: CardView;
  /** The shopper's real photo (enables the compare slider). */
  photoUrl: string | null;
  emphasis?: boolean;
  actionLabel?: string;
  onSwap?: (t: SwapTarget) => void;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const stock = stockInfo(sku, size);
  const job = view.job;
  const provider = job?.provider ?? null;
  const gate = view.kind === "ready" || view.kind === "dropped" ? view.gate : null;
  const renderJobId = view.kind === "ready" ? view.job.id : null;

  return (
    <article
      aria-labelledby={titleId}
      className="overflow-hidden rounded-3xl border border-line bg-surface shadow-card motion-safe:transition-shadow"
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-surface-2">
        <CardMedia view={view} sku={sku} photoUrl={photoUrl} />
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <GateBadge view={view} />
          {provider && showsRender(view) ? (
            <ProviderLabel provider={provider} fromCache={job?.fromCache ?? false} className="ml-auto" />
          ) : null}
        </div>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 id={titleId} className="flex min-w-0 items-center gap-2 text-[17px] font-medium leading-snug">
            <Swatch hex={sku.colorHex} className="shrink-0" />
            <span className="min-w-0">{sku.name}</span>
          </h3>
          <span className="tabular shrink-0 pt-0.5 text-sm font-medium">{priceDiffLabel(priceDiff)}</span>
        </div>
        {why ? <p className="text-[15px] leading-relaxed text-muted">{why}</p> : null}
        <p
          className={cx(
            "flex items-center gap-1.5 text-xs font-medium",
            stock.tone === "ok" && "text-ok",
            stock.tone === "warn" && "text-warn",
            stock.tone === "bad" && "text-bad",
          )}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          {stock.text}
          {stock.inStock ? " · ships today" : ""}
        </p>
        {gate ? <GateDetails gate={gate} transitionLabel={job ? TRANSITION_LABELS[job.transition] : undefined} /> : null}
        {footer}
        {onSwap ? (
          <Button
            variant={emphasis ? "primary" : "secondary"}
            size="lg"
            className="w-full"
            disabled={!stock.inStock}
            onClick={() => onSwap({ skuId: sku.id, size, jobId: renderJobId })}
          >
            {stock.inStock ? actionLabel : `Out of stock in ${size}`}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** Dimmed placeholder card used on the form step while speculative renders run. */
export function SkeletonCard({ state, label }: { state: "rendering" | "ready" | "failed"; label: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface opacity-80">
      <div className={cx("relative aspect-[3/4]", state === "rendering" ? "tb-skeleton" : "bg-surface-2")}>
        <span
          className={cx(
            "absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
            state === "ready" && "bg-ok-soft text-ok",
            state === "rendering" && "bg-surface/80 text-muted",
            state === "failed" && "bg-surface/80 text-muted",
          )}
        >
          {state === "ready" ? <IconCheck className="h-3 w-3" /> : null}
          {state === "rendering" ? <Spinner className="h-3 w-3" /> : null}
          {state === "ready" ? "Ready" : state === "rendering" ? "Rendering" : "Skipped"}
        </span>
      </div>
      <div className="space-y-1.5 p-2.5">
        <span className="tb-skeleton block h-2.5 w-3/4 rounded-full" />
        <span className="sr-only">{label}</span>
        <span className="tb-skeleton block h-2.5 w-1/2 rounded-full" />
      </div>
    </div>
  );
}
