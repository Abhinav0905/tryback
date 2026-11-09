"use client";

// "What didn't work?" — chips + optional text, while the speculative renders that
// started at photo upload keep running (honest clock + dimmed skeletons).

import { useId, useState, type FormEvent } from "react";
import { Button, Chip } from "@/components/ui";
import { STYLE_CHIPS, getSku } from "@/lib/catalog";
import type { ReturnCase, Sku } from "@/lib/types";
import { api, errorMessage } from "./api";
import { HonestClockLive } from "./HonestClock";
import { ErrorNote, IconShield, ItemSummary, Spinner, StepHeading } from "./primitives";
import { SkeletonCard } from "./RenderCard";

const MAX_TEXT = 500;

export function StyleFormStep({ r, sku, onDone }: { r: ReturnCase; sku: Sku; onDone: (next: ReturnCase) => void }) {
  const [chips, setChips] = useState<string[]>(r.chips ?? []);
  const [text, setText] = useState(r.freeText ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const textId = useId();
  const countId = useId();
  const legendId = useId();

  const hasPhoto = r.photo !== null;
  const speculative = r.renders.filter((j) => j.phase === "speculative" && j.status !== "skipped");
  const ready = speculative.filter((j) => j.status === "success").length;
  const failed = speculative.filter((j) => j.status === "failed").length;
  const empty = chips.length === 0 && text.trim() === "";

  const toggle = (id: string) => setChips((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (empty) return;
    setSubmitting(true);
    setError(null);
    try {
      onDone(await api.form(r.id, { chips, freeText: text.trim().slice(0, MAX_TEXT) }));
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <ItemSummary sku={sku} size={r.size} price={r.price} label="What you have now" className="mb-7" />
      <StepHeading
        title="What didn't work about it?"
        sub="Pick any that fit. We use your answers — not your photo — to choose the swaps."
      />

      {hasPhoto && r.timeline.photoAt ? (
        <section aria-label="Previews in progress" className="mb-7">
          <HonestClockLive photoAt={r.timeline.photoAt} total={speculative.length} ready={ready} failed={failed} />
          {speculative.length ? (
            <div className="mt-3 grid grid-cols-2 gap-3">
              {speculative.slice(0, 2).map((j) => {
                const target = getSku(j.skuId);
                const state = j.status === "success" ? "ready" : j.status === "failed" ? "failed" : "rendering";
                return (
                  <SkeletonCard
                    key={j.id}
                    state={state}
                    label={`${target?.name ?? "Swap"}: ${state === "ready" ? "ready" : state === "failed" ? "skipped" : "rendering"}`}
                  />
                );
              })}
            </div>
          ) : null}
        </section>
      ) : (
        <p className="mb-7 rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
          We&apos;ll show alternatives on product photos — no photo, no try-on, 0 credits.
        </p>
      )}

      <fieldset aria-labelledby={legendId} disabled={submitting}>
        <legend id={legendId} className="mb-3 text-sm font-medium text-ink">
          Pick all that apply
        </legend>
        <div className="flex flex-wrap gap-2">
          {STYLE_CHIPS.map((c) => (
            <Chip key={c.id} selected={chips.includes(c.id)} onClick={() => toggle(c.id)}>
              {c.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      <div className="mt-6">
        <label htmlFor={textId} className="block text-sm font-medium text-ink">
          Anything else? <span className="font-normal text-muted">(optional)</span>
        </label>
        <textarea
          id={textId}
          value={text}
          onChange={(e) => setText(e.currentTarget.value.slice(0, MAX_TEXT))}
          maxLength={MAX_TEXT}
          rows={3}
          disabled={submitting}
          aria-describedby={countId}
          placeholder="e.g. I love the shape but wanted something softer"
          className="mt-2 w-full resize-none rounded-2xl border border-line bg-surface px-4 py-3 text-[15px] leading-relaxed outline-none placeholder:text-muted/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-60"
        />
        <p id={countId} className="tabular mt-1 text-right text-xs text-muted">
          {text.length}/{MAX_TEXT}
        </p>
      </div>

      {touched && empty ? (
        <p role="alert" className="mt-2 text-sm text-warn">
          Pick at least one, or tell us in your own words.
        </p>
      ) : null}
      {error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}

      <Button type="submit" size="lg" className="mt-5 w-full" disabled={submitting}>
        {submitting ? <Spinner /> : null}
        {submitting ? "Finding your best swaps…" : hasPhoto ? "Show my swaps" : "Show alternatives"}
      </Button>
      <p className="sr-only" aria-live="polite">
        {submitting ? "Finding your best swaps" : ""}
      </p>

      <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted">
        <IconShield className="mt-px h-4 w-4 shrink-0" />
        Only your answers and the product details are used to understand what went wrong — never your photo, and
        never anything about your body.
      </p>
    </form>
  );
}
