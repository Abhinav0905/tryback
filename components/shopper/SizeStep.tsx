"use client";

// Size path (fit_size): the returned garment is the ruler. Every other size / length
// variant is drawn as a measured hem line on the real photo — zero credits. Try-on
// can't show size, so we don't fake it; an optional 1-credit preview is offered for
// the look only.

import { useId, useState } from "react";
import { Badge, Button, cx, formatUsd } from "@/components/ui";
import { GRADE, SKUS, getSku } from "@/lib/catalog";
import { projectSizeLines } from "@/lib/cv/geometry";
import { sizeOptions } from "@/lib/retrieval";
import type { AppStatus, FitComplaint, ReturnCase, SizeOption, Sku } from "@/lib/types";
import { api, errorMessage } from "./api";
import { ALL_PHASES, cardViewFor, renderBudgetUsed } from "./flow";
import { fitComplaintLabel, signedCm, sizeVariantLabel } from "./format";
import { ErrorNote, IconCamera, IconRuler, ItemSummary, Spinner, StepHeading } from "./primitives";
import { RenderCard, type SwapTarget } from "./RenderCard";
import { SizeLinesOverlay, type OverlayLine } from "./SizeLinesOverlay";

const optionKey = (o: { skuId: string; size: string }) => `${o.skuId}:${o.size}`;
const LENGTH_COMPLAINTS: FitComplaint[] = ["too_short", "too_long", "sleeves_short", "sleeves_long"];
const MAX_MUTED_LINES = 3;

function rankOptions(options: SizeOption[]): SizeOption[] {
  return [...options].sort(
    (a, b) =>
      Number(b.recommended) - Number(a.recommended) ||
      b.fixes.length - a.fixes.length ||
      Number(b.inStock) - Number(a.inStock) ||
      Math.abs(a.deltaChestCircCm) - Math.abs(b.deltaChestCircCm) ||
      Math.abs(a.deltaHemCm) - Math.abs(b.deltaHemCm),
  );
}

function deltaSummary(o: SizeOption): string {
  const parts = [`Hem ${signedCm(o.deltaHemCm)}`, `Chest ${signedCm(o.deltaChestCircCm)}`];
  if (o.deltaSleeveCm !== null) parts.push(`Sleeves ${signedCm(o.deltaSleeveCm)}`);
  return parts.join(" · ");
}

function OptionRow({
  o,
  checked,
  name,
  onSelect,
}: {
  o: SizeOption;
  checked: boolean;
  name: string;
  onSelect: () => void;
}) {
  const label = sizeVariantLabel(o.size, o.lengthVariant);
  return (
    <label
      className={cx(
        "block cursor-pointer rounded-2xl border bg-surface p-4 motion-safe:transition-colors",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        checked ? "border-accent shadow-card" : "border-line hover:border-muted",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      <span className="flex items-start gap-3">
        <span
          aria-hidden
          className={cx(
            "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
            checked ? "border-accent" : "border-line",
          )}
        >
          {checked ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold">{label}</span>
            {o.recommended ? <Badge tone="accent">Recommended</Badge> : null}
            {!o.inStock ? <Badge tone="bad">Out of stock</Badge> : null}
            {o.priceDiff !== 0 ? (
              <span className="tabular ml-auto text-sm text-muted">{formatUsd(o.priceDiff, { sign: true })}</span>
            ) : null}
          </span>
          <span className="tabular mt-1 block text-sm text-muted">{deltaSummary(o)}</span>
          {o.fixes.length ? (
            <span className="mt-1.5 block text-sm font-medium text-ok">
              Fixes: {o.fixes.map((f) => fitComplaintLabel(f).toLowerCase()).join(", ")}
            </span>
          ) : null}
          {checked && (o.tradeoffs.length || o.note) ? (
            <span className="mt-2 block space-y-1 text-[13px] leading-snug">
              {o.tradeoffs.map((t) => (
                <span key={t} className="block text-warn">
                  {t}
                </span>
              ))}
              {o.note ? <span className="block text-muted">{o.note}</span> : null}
            </span>
          ) : null}
        </span>
      </span>
    </label>
  );
}

export function SizeStep({
  r,
  sku,
  status,
  onSwap,
  onApply,
  onAddPhoto,
}: {
  r: ReturnCase;
  sku: Sku;
  status: AppStatus | null;
  onSwap: (t: SwapTarget) => void;
  onApply: (next: ReturnCase) => void;
  onAddPhoto: () => void;
}) {
  const groupName = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const options = rankOptions(sizeOptions(sku, r.size, r.fitComplaints, { paidPrice: r.price }));
  const recommended = options.find((o) => o.recommended) ?? null;
  const fallback = options.find((o) => o.inStock && o.fixes.length > 0) ?? options[0] ?? null;
  const selected = options.find((o) => optionKey(o) === selectedKey) ?? recommended ?? fallback;

  const cal = r.photo ? (r.measurements?.calibration ?? null) : null;
  const relevant = r.fitComplaints.length ? options.filter((o) => o.fixes.length > 0 || o.recommended) : options;
  const listedBase = showAll || relevant.length === 0 ? options : relevant;
  const listed = selected && !listedBase.includes(selected) ? [...listedBase, selected] : listedBase;
  const hiddenCount = options.length - listed.length;

  // Lines: selected + recommended + a few other options that fix something.
  let overlayLines: OverlayLine[] = [];
  if (cal) {
    const projected = projectSizeLines(cal, options, [...SKUS]);
    const byKey = new Map(projected.map((l) => [optionKey(l), l]));
    const chosen: OverlayLine[] = [];
    const push = (o: SizeOption | null, tone: OverlayLine["tone"]) => {
      if (!o) return;
      const k = optionKey(o);
      const line = byKey.get(k);
      if (line && !chosen.some((c) => c.key === k)) chosen.push({ key: k, line, tone });
    };
    push(selected, "selected");
    push(recommended, "recommended");
    for (const o of relevant.filter((x) => x.fixes.length > 0).slice(0, MAX_MUTED_LINES + 2)) {
      if (chosen.filter((c) => c.tone === "muted").length >= MAX_MUTED_LINES) break;
      push(o, "muted");
    }
    overlayLines = chosen;
  }

  // Grading truth: sizing up/down barely changes length but changes the chest a lot.
  const lengthComplaint = r.fitComplaints.some((c) => LENGTH_COMPLAINTS.includes(c));
  const gradingNote = options.find((o) => /won't fix/.test(o.note))?.note ?? null;
  const showGrading = lengthComplaint || gradingNote !== null;

  // Optional 1-credit look preview for the selected option. Only for a *different* garment
  // (a length variant): another size of the same garment would render identically.
  const sameGarment = selected !== null && selected.skuId === r.skuId;
  const previewView = selected && !sameGarment ? cardViewFor(r, selected.skuId, null, ALL_PHASES) : null;
  const maxRenders = status?.maxRendersPerReturn ?? 5;
  const budgetLeft = renderBudgetUsed(r) < maxRenders;
  const simulated = status?.activeProvider === "dev";
  const selectedSku = selected ? getSku(selected.skuId) : undefined;

  const requestPreview = async () => {
    if (!selected) return;
    setPreviewPending(true);
    setPreviewError(null);
    try {
      onApply(await api.sizePreview(r.id, { skuId: selected.skuId, size: selected.size }));
    } catch (e) {
      setPreviewError(errorMessage(e));
    } finally {
      setPreviewPending(false);
    }
  };

  const wearing = sizeVariantLabel(r.size, sku.lengthVariant);

  return (
    <div>
      <ItemSummary sku={sku} size={r.size} price={r.price} label="What you're wearing" className="mb-7" />
      <StepHeading
        eyebrow="Measured on your photo · 0 credits"
        title="Where every other size would end"
        sub="Try-on can't show size, so we don't fake it — these lines are measured from the garment you're wearing."
      />

      {r.fitComplaints.length ? (
        <p className="-mt-2 mb-5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
          You said:
          {r.fitComplaints.map((c) => (
            <Badge key={c} tone="neutral">
              {fitComplaintLabel(c)}
            </Badge>
          ))}
        </p>
      ) : null}

      {cal && r.photo ? (
        <>
          <SizeLinesOverlay
            photoUrl={r.photo.url}
            alt={`Your photo wearing the ${sku.name}`}
            cal={cal}
            wearingLabel={`What you're wearing · ${wearing}`}
            lines={overlayLines}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Solid line: where your {wearing} ends now. Dashed: where the others would end, ±
            {cal.uncertaintyCm.toFixed(1)} cm. {cal.method === "garment" ? "Scaled from the garment's known length." : "Scaled from your height."}
          </p>
        </>
      ) : r.photo ? (
        <div className="rounded-2xl border border-line bg-surface-2 p-4 text-sm">
          <p className="font-medium">We couldn&apos;t measure on this photo</p>
          <p className="mt-1 text-muted">So here are the garment measurements instead — same numbers, no lines.</p>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4">
          <IconRuler className="h-6 w-6 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">See these as lines on you</p>
            <p className="text-xs text-muted">One photo in the item. Measured on your device, 0 credits.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onAddPhoto}>
            <IconCamera className="h-4 w-4" />
            Add photo
          </Button>
        </div>
      )}

      {showGrading ? (
        <aside className="mt-5 rounded-2xl border border-info/25 bg-info-soft p-4 text-sm text-ink">
          <p className="font-semibold text-info">Why not just size up?</p>
          <p className="mt-1 leading-relaxed">
            {gradingNote ??
              `Between sizes, length changes by only ${GRADE.lengthCm} cm while the chest changes by ${GRADE.halfChestCm * 2} cm. A length variant fixes length without changing the fit.`}
          </p>
        </aside>
      ) : null}

      <fieldset className="mt-7">
        <legend className="mb-3 text-sm font-medium">Options in {sku.colorName.toLowerCase()}</legend>
        {options.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            This style doesn&apos;t come in other sizes or lengths.
          </p>
        ) : (
          <div className="space-y-2.5">
            {listed.map((o) => (
              <OptionRow
                key={optionKey(o)}
                o={o}
                name={groupName}
                checked={selected !== null && optionKey(o) === optionKey(selected)}
                onSelect={() => setSelectedKey(optionKey(o))}
              />
            ))}
          </div>
        )}
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-3 rounded-lg px-1 py-1 text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Show all {options.length} sizes
          </button>
        ) : null}
        {r.fitComplaints.length > 0 && !recommended && options.length > 0 ? (
          <p className="mt-3 text-sm text-muted">
            Nothing in stock fixes everything you mentioned — the options above fix part of it.
          </p>
        ) : null}
      </fieldset>

      {selected && selectedSku ? (
        <section className="mt-7 space-y-3" aria-label="Your choice">
          {previewView && previewView.kind !== "catalog" ? (
            <RenderCard
              sku={selectedSku}
              size={selected.size}
              why="Look preview only — use the measured lines above for length."
              priceDiff={selected.priceDiff}
              view={previewView}
              photoUrl={r.photo?.url ?? null}
            />
          ) : null}

          <Button
            size="lg"
            className="w-full"
            disabled={!selected.inStock}
            onClick={() =>
              onSwap({
                skuId: selected.skuId,
                size: selected.size,
                jobId: previewView?.kind === "ready" ? previewView.job.id : null,
              })
            }
          >
            {selected.inStock
              ? `Swap to ${sizeVariantLabel(selected.size, selected.lengthVariant)}`
              : `${sizeVariantLabel(selected.size, selected.lengthVariant)} is out of stock`}
          </Button>

          {r.photo && sameGarment ? (
            <p className="text-center text-xs leading-relaxed text-muted">
              A try-on preview can&apos;t show a different size of the same garment — the measured lines above are the
              honest answer.
            </p>
          ) : null}
          {r.photo && previewView?.kind === "catalog" ? (
            <Button
              variant="ghost"
              size="md"
              className="w-full"
              disabled={previewPending || !budgetLeft || !selected.inStock}
              onClick={() => void requestPreview()}
            >
              {previewPending ? <Spinner /> : null}
              {!budgetLeft
                ? "Preview limit reached for this return"
                : simulated
                  ? "Preview on me (simulated · 0 credits)"
                  : "Preview on me (1 credit)"}
            </Button>
          ) : null}
          {previewError ? <ErrorNote>{previewError}</ErrorNote> : null}
        </section>
      ) : null}
    </div>
  );
}
