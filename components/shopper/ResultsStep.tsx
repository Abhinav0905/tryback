"use client";

// Results: the real photo pinned as "What you have now", the diagnosis, then one
// RenderCard per candidate in rank order. Renders that failed the gate are tucked
// behind a disclosure. With no photo, the same swaps show on catalogue imagery.

import { useId, useState } from "react";
import { Button, Swatch } from "@/components/ui";
import { getSku } from "@/lib/catalog";
import type { Candidate, Diagnosis, ReturnCase, Sku } from "@/lib/types";
import { cardViewFor, hasActiveJobs, type CardView } from "./flow";
import { ISSUE_LABELS } from "./format";
import { HonestClockLine } from "./HonestClock";
import { IconCamera, IconChevron, ProductImage, SectionLabel, StepHeading } from "./primitives";
import { RenderCard, type SwapTarget } from "./RenderCard";

interface Item {
  c: Candidate;
  sku: Sku;
  view: CardView;
}

export function PinnedNow({ r, sku }: { r: ReturnCase; sku: Sku }) {
  return (
    <div className="sticky top-0 z-10 -mx-5 mb-5 border-b border-line bg-bg/85 px-5 py-2.5 backdrop-blur-md">
      <div className="flex items-center gap-3">
        {r.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- shopper photo comes from /api/photos
          <img
            src={r.photo.url}
            alt={`Your photo wearing the ${sku.name}`}
            className="h-14 w-[42px] shrink-0 rounded-lg object-cover"
          />
        ) : (
          <ProductImage sku={sku} className="h-14 w-[42px] shrink-0 rounded-lg ring-1 ring-line" alt="" />
        )}
        <div className="min-w-0">
          <SectionLabel>What you have now</SectionLabel>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm font-medium">
            <Swatch hex={sku.colorHex} className="shrink-0" />
            <span className="truncate">
              {sku.name} · {r.size}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

function DiagnosisCard({ diagnosis }: { diagnosis: Diagnosis | null }) {
  if (!diagnosis) {
    return (
      <div className="rounded-2xl bg-surface-2 p-4" aria-busy="true">
        <SectionLabel>What we heard</SectionLabel>
        <span className="tb-skeleton mt-3 block h-3 w-11/12 rounded-full" />
        <span className="tb-skeleton mt-2 block h-3 w-2/3 rounded-full" />
        <span className="sr-only">Reading your answers…</span>
      </div>
    );
  }
  const issues = [...diagnosis.issues].sort((a, b) => b.confidence - a.confidence);
  return (
    <section className="rounded-2xl bg-surface-2 p-4">
      <SectionLabel>What we heard</SectionLabel>
      <p className="mt-1.5 text-[15px] leading-relaxed text-ink">{diagnosis.summary}</p>
      {issues.length ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Issues">
          {issues.map((i) => (
            <li
              key={i.type}
              className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-ink"
            >
              {ISSUE_LABELS[i.type] ?? i.type}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        {diagnosis.source === "llm"
          ? "Summarised by an AI text model from your answers and the product details only — never your photo."
          : "Matched from your answers and the product details — your photo isn't used for this."}
      </p>
    </section>
  );
}

export function ResultsStep({
  r,
  sku,
  onSwap,
  onAddPhoto,
}: {
  r: ReturnCase;
  sku: Sku;
  onSwap: (t: SwapTarget) => void;
  onAddPhoto: () => void;
}) {
  const [showDropped, setShowDropped] = useState(false);
  const droppedId = useId();

  const items: Item[] = [];
  for (const c of r.candidates) {
    const target = getSku(c.skuId);
    if (target) items.push({ c, sku: target, view: cardViewFor(r, c.skuId, c.size) });
  }
  const visible = items.filter((i) => i.view.kind !== "dropped");
  const dropped = items.filter((i) => i.view.kind === "dropped");
  const hasPhoto = r.photo !== null;
  const rendered = items.filter((i) => i.view.kind !== "catalog");
  const readyCount = visible.filter((i) => i.view.kind === "ready").length;
  const firstSwappable = visible.findIndex((i) => (i.sku.inventory[i.c.size] ?? 0) > 0);

  return (
    <div>
      <PinnedNow r={r} sku={sku} />
      <StepHeading
        eyebrow={hasPhoto ? "Previews on your photo" : "Product photos · 0 credits"}
        title={hasPhoto ? "Swaps that fix it, on you" : "Swaps that fix it"}
      />

      <DiagnosisCard diagnosis={r.diagnosis} />

      {hasPhoto ? (
        <HonestClockLine timeline={r.timeline} rendering={hasActiveJobs(r)} className="mt-4" />
      ) : (
        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-surface p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Want to see these on you?</p>
            <p className="text-xs text-muted">Add one photo wearing the {sku.name} — about 20 seconds.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onAddPhoto}>
            <IconCamera className="h-4 w-4" />
            Add photo
          </Button>
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {hasPhoto && rendered.length ? `${readyCount} of ${rendered.length} previews ready` : ""}
      </p>

      {visible.length ? (
        <ol className="mt-6 space-y-6" aria-label="Swaps">
          {visible.map((it, idx) => (
            <li
              key={`${it.c.skuId}:${it.c.size}`}
              className="motion-safe:transition-[opacity,translate] motion-safe:duration-500 motion-safe:starting:translate-y-2 motion-safe:starting:opacity-0"
            >
              <RenderCard
                sku={it.sku}
                size={it.c.size}
                why={it.c.why}
                priceDiff={it.c.priceDiff}
                view={it.view}
                photoUrl={r.photo?.url ?? null}
                emphasis={idx === firstSwappable}
                onSwap={onSwap}
              />
            </li>
          ))}
        </ol>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-line px-5 py-8 text-center">
          <p className="font-medium">No in-stock swaps in size {r.size} right now</p>
          <p className="mt-1 text-sm text-muted">
            We&apos;d rather not suggest something that doesn&apos;t fix it. A refund is one tap away below.
          </p>
        </div>
      ) : null}

      {dropped.length ? (
        <section className="mt-6">
          <button
            type="button"
            aria-expanded={showDropped}
            aria-controls={droppedId}
            onClick={() => setShowDropped((v) => !v)}
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span>
              {dropped.length === 1
                ? "1 preview didn't pass our quality check"
                : `${dropped.length} previews didn't pass our quality check`}
            </span>
            <IconChevron className={`h-4 w-4 shrink-0 motion-safe:transition-transform ${showDropped ? "rotate-90" : ""}`} />
          </button>
          <div id={droppedId} hidden={!showDropped}>
            {showDropped ? (
              <ol className="mt-4 space-y-6">
                {dropped.map((it) => (
                  <li key={`${it.c.skuId}:${it.c.size}`}>
                    <RenderCard
                      sku={it.sku}
                      size={it.c.size}
                      why={it.c.why}
                      priceDiff={it.c.priceDiff}
                      view={it.view}
                      photoUrl={null}
                      onSwap={onSwap}
                    />
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
