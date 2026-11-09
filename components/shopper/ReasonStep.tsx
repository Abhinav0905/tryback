"use client";

import { useId, useState, type ReactNode } from "react";
import { Button, Chip, cx } from "@/components/ui";
import { FIT_CHIPS } from "@/lib/catalog";
import type { FitComplaint, ReasonCode, ReturnCase, Sku } from "@/lib/types";
import { api, errorMessage } from "./api";
import {
  ErrorNote,
  IconChevron,
  IconRefund,
  IconRuler,
  IconSwap,
  ItemSummary,
  Spinner,
  StepHeading,
} from "./primitives";

function ReasonOption({
  icon,
  title,
  detail,
  onClick,
  pending,
  disabled,
  expanded,
  controls,
  selected,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      aria-controls={controls}
      className={cx(
        "group flex w-full items-center gap-4 rounded-2xl border bg-surface p-4 text-left shadow-card",
        "motion-safe:transition-[border-color,transform] motion-safe:active:scale-[0.99]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-accent" : "border-line hover:border-muted",
      )}
    >
      <span
        className={cx(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
          selected ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-medium leading-snug text-ink">{title}</span>
        <span className="mt-0.5 block text-sm text-muted">{detail}</span>
      </span>
      {pending ? (
        <Spinner className="h-5 w-5 text-muted" label="Saving" />
      ) : (
        <IconChevron
          className={cx(
            "h-5 w-5 shrink-0 text-muted motion-safe:transition-transform",
            expanded && "rotate-90",
          )}
        />
      )}
    </button>
  );
}

export function ReasonStep({ r, sku, onDone }: { r: ReturnCase; sku: Sku; onDone: (next: ReturnCase) => void }) {
  const [fitOpen, setFitOpen] = useState(r.reason === "fit_size");
  const [complaints, setComplaints] = useState<FitComplaint[]>(r.fitComplaints ?? []);
  const [pending, setPending] = useState<ReasonCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fitPanelId = useId();
  const fitLegendId = useId();

  const submit = async (reason: ReasonCode) => {
    setPending(reason);
    setError(null);
    try {
      const next = await api.reason(
        r.id,
        reason === "fit_size" ? { reason, fitComplaints: complaints } : { reason },
      );
      onDone(next);
    } catch (e) {
      setError(errorMessage(e));
      setPending(null);
    }
  };

  const toggle = (c: FitComplaint) =>
    setComplaints((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const busy = pending !== null;

  return (
    <div>
      <ItemSummary sku={sku} size={r.size} price={r.price} className="mb-7" />
      <StepHeading title="Why is it going back?" sub="Pick the closest. Whatever you choose, a refund stays one tap away." />

      <ul className="space-y-3">
        <li>
          <ReasonOption
            icon={<IconSwap />}
            title="Style or colour didn't work"
            detail="See in-stock swaps on you before you decide"
            onClick={() => void submit("style_colour")}
            pending={pending === "style_colour"}
            disabled={busy}
          />
        </li>
        <li>
          <ReasonOption
            icon={<IconRuler />}
            title="Fit or size"
            detail="We'll measure the other sizes for you"
            onClick={() => setFitOpen((v) => !v)}
            expanded={fitOpen}
            controls={fitPanelId}
            selected={fitOpen}
            pending={pending === "fit_size"}
            disabled={busy}
          />
          {fitOpen ? (
            <div
              id={fitPanelId}
              className="mt-2 rounded-2xl border border-line bg-surface-2 p-4 motion-safe:transition-[opacity,translate] motion-safe:duration-300 motion-safe:starting:-translate-y-1 motion-safe:starting:opacity-0"
            >
              <fieldset aria-describedby={fitLegendId}>
                <legend id={fitLegendId} className="mb-3 text-sm font-medium text-ink">
                  What&apos;s off? Pick all that apply.
                </legend>
                <div className="flex flex-wrap gap-2">
                  {FIT_CHIPS.map((c) => (
                    <Chip
                      key={c.id}
                      selected={complaints.includes(c.id)}
                      onClick={() => toggle(c.id)}
                      disabled={busy}
                    >
                      {c.label}
                    </Chip>
                  ))}
                </div>
              </fieldset>
              <Button
                className="mt-4 w-full"
                size="lg"
                disabled={complaints.length === 0 || busy}
                onClick={() => void submit("fit_size")}
              >
                {pending === "fit_size" ? <Spinner /> : null}
                Continue
              </Button>
              {complaints.length === 0 ? (
                <p className="mt-2 text-center text-xs text-muted">Choose at least one to continue.</p>
              ) : null}
            </div>
          ) : null}
        </li>
        <li>
          <ReasonOption
            icon={<IconRefund />}
            title="Something else"
            detail="Damaged, late, or changed your mind"
            onClick={() => void submit("other")}
            pending={pending === "other"}
            disabled={busy}
          />
        </li>
      </ul>

      {error ? <ErrorNote className="mt-4">{error}</ErrorNote> : null}
    </div>
  );
}
