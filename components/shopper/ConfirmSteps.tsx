"use client";

// Exchange confirm, refund confirm and the two Done screens.

import { useState, type ReactNode } from "react";
import { Button, Swatch, cx, formatUsd } from "@/components/ui";
import { EXCHANGE_BONUS_USD, getSku } from "@/lib/catalog";
import type { ReturnCase, SizeCode, Sku } from "@/lib/types";
import { api, errorMessage } from "./api";
import { priceDiffSentence, stockInfo } from "./format";
import {
  ErrorNote,
  IconArrowLeft,
  IconArrowRight,
  IconBox,
  IconCheck,
  IconRefund,
  LinkButton,
  ProductImage,
  SectionLabel,
  Spinner,
  StepHeading,
} from "./primitives";
import { ProviderLabel } from "./RenderCard";


function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 mb-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
    >
      <IconArrowLeft className="h-4 w-4" />
      {children}
    </button>
  );
}

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={cx("text-right text-sm", strong ? "font-semibold text-ink" : "text-ink")}>{children}</dd>
    </div>
  );
}

function Thumb({
  src,
  sku,
  caption,
  provider,
}: {
  src: string | null;
  sku: Sku;
  caption: string;
  provider?: "clothsy" | "dev" | null;
}) {
  return (
    <figure className="min-w-0 flex-1">
      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-surface-2">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- photo/render bytes come from API routes
          <img src={src} alt={caption} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <ProductImage sku={sku} className="absolute inset-0 h-full w-full" alt={caption} />
        )}
        {provider ? <ProviderLabel provider={provider} className="absolute bottom-2 left-2" /> : null}
      </div>
      <figcaption className="mt-2 text-xs text-muted">{caption}</figcaption>
    </figure>
  );
}

export function ExchangeConfirm({
  r,
  from,
  target,
  onBack,
  onDone,
}: {
  r: ReturnCase;
  from: Sku;
  target: { skuId: string; size: SizeCode; jobId: string | null };
  onBack: () => void;
  onDone: (next: ReturnCase) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const to = getSku(target.skuId);
  const job = target.jobId ? r.renders.find((j) => j.id === target.jobId && j.status === "success") : undefined;

  if (!to) {
    return (
      <div>
        <BackButton onClick={onBack}>Back</BackButton>
        <ErrorNote>We couldn&apos;t find that item any more. Please pick another option.</ErrorNote>
      </div>
    );
  }

  const diff = to.price - r.price;
  const stock = stockInfo(to, target.size);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      onDone(await api.resolve(r.id, { type: "exchange", skuId: to.id, size: target.size }));
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <div>
      <BackButton onClick={onBack}>Back to options</BackButton>
      <StepHeading eyebrow="Instant exchange" title="Confirm your swap" />

      <div className="flex items-center gap-3">
        <Thumb src={r.photo?.url ?? null} sku={from} caption={`${from.name} · ${r.size}`} />
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <IconArrowRight className="h-4 w-4" />
          <span className="sr-only">to</span>
        </span>
        <Thumb
          src={job?.resultUrl ?? null}
          sku={to}
          caption={`${to.name} · ${target.size}`}
          provider={job?.resultUrl ? job.provider : null}
        />
      </div>

      <dl className="mt-6 divide-y divide-line rounded-2xl border border-line bg-surface px-4">
        <Row label="Sending back">
          <span className="inline-flex items-center gap-1.5">
            <Swatch hex={from.colorHex} />
            {from.name} ({r.size})
          </span>
        </Row>
        <Row label="You'll get">
          <span className="inline-flex items-center gap-1.5">
            <Swatch hex={to.colorHex} />
            {to.name} ({target.size})
          </span>
        </Row>
        <Row label="Price difference" strong>
          {priceDiffSentence(diff)}
        </Row>
        <Row label="Exchange bonus">+{formatUsd(EXCHANGE_BONUS_USD)} store credit</Row>
        <Row label="Delivery">Ships today (instant exchange)</Row>
      </dl>

      <p className="mt-4 text-sm leading-relaxed text-muted">
        We send the new one now. Drop the original at any post office within 30 days — the prepaid label is in your
        email.
      </p>

      {error ? <ErrorNote className="mt-4">{error}</ErrorNote> : null}

      <Button size="lg" className="mt-6 w-full" onClick={() => void confirm()} disabled={pending || !stock.inStock}>
        {pending ? <Spinner /> : null}
        {stock.inStock ? "Confirm exchange" : stock.text}
      </Button>
      <p className="sr-only" aria-live="polite">
        {pending ? "Confirming your exchange" : ""}
      </p>
    </div>
  );
}

export function RefundConfirm({
  r,
  sku,
  onBack,
  backLabel,
  onDone,
}: {
  r: ReturnCase;
  sku: Sku;
  onBack: () => void;
  backLabel: string;
  onDone: (next: ReturnCase) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSwaps = r.renders.some((j) => j.status === "success");

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      onDone(await api.resolve(r.id, { type: "refund" }));
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <div>
      <BackButton onClick={onBack}>{backLabel}</BackButton>
      <StepHeading
        eyebrow="Refund"
        title={r.reason === "other" ? "Let's get your refund started" : "Refund instead?"}
        sub="No problem — no questions asked."
      />

      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
        <ProductImage sku={sku} className="h-[72px] w-[54px] shrink-0 rounded-lg ring-1 ring-line" alt="" />
        <div className="min-w-0">
          <SectionLabel>Returning</SectionLabel>
          <p className="mt-0.5 truncate font-medium">{sku.name}</p>
          <p className="text-sm text-muted">Size {r.size}</p>
        </div>
      </div>

      <dl className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface px-4">
        <Row label="Refund" strong>
          {formatUsd(r.price)}
        </Row>
        <Row label="To">Your original payment method</Row>
        <Row label="When">5–7 business days after it arrives</Row>
      </dl>

      {hasSwaps && r.reason === "style_colour" ? (
        <p className="mt-4 text-sm text-muted">Your previews stay here until you decide — going back costs nothing.</p>
      ) : null}

      {error ? <ErrorNote className="mt-4">{error}</ErrorNote> : null}

      <Button size="lg" className="mt-6 w-full" onClick={() => void confirm()} disabled={pending}>
        {pending ? <Spinner /> : null}
        Confirm refund
      </Button>
      <p className="sr-only" aria-live="polite">
        {pending ? "Confirming your refund" : ""}
      </p>
    </div>
  );
}

export function DoneScreen({ r, sku }: { r: ReturnCase; sku: Sku }) {
  const outcome = r.outcome;
  const isExchange = outcome?.type === "exchange";
  const to = isExchange && outcome?.skuId ? getSku(outcome.skuId) : undefined;
  // Any shown render of the new SKU (renders are per garment; size doesn't change the look).
  const shown = to
    ? r.renders.filter(
        (j) => j.skuId === to.id && j.status === "success" && j.resultUrl && !j.supersededBy && j.gate?.verdict !== "drop",
      )
    : [];
  const job = shown.find((j) => j.size === outcome?.size) ?? shown[0];

  return (
    <div className="pt-2">
      <div
        className={cx(
          "mb-6 flex h-14 w-14 items-center justify-center rounded-full motion-safe:transition-[scale,opacity] motion-safe:duration-500 motion-safe:starting:scale-75 motion-safe:starting:opacity-0",
          isExchange ? "bg-ok-soft text-ok" : "bg-surface-2 text-ink",
        )}
      >
        {isExchange ? <IconCheck className="h-7 w-7" /> : <IconRefund className="h-7 w-7" />}
      </div>

      {isExchange && to && outcome ? (
        <>
          <StepHeading
            title="Exchange confirmed — your new item ships today"
            sub={`Your ${to.name} in ${outcome.size} is on its way. Keep wearing the old one until the new one arrives.`}
          />
          <div className="overflow-hidden rounded-3xl border border-line bg-surface shadow-card">
            <div className="relative aspect-[4/3] bg-surface-2">
              {job?.resultUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- render bytes come from /api/renders
                <img src={job.resultUrl} alt={`Preview of the ${to.name}`} className="absolute inset-0 h-full w-full object-cover object-top" />
              ) : (
                <ProductImage sku={to} className="absolute inset-0 h-full w-full" />
              )}
              {job?.provider ? <ProviderLabel provider={job.provider} className="absolute bottom-3 left-3" /> : null}
            </div>
            <dl className="divide-y divide-line px-4">
              <Row label="New item">
                <span className="inline-flex items-center gap-1.5">
                  <Swatch hex={to.colorHex} />
                  {to.name} ({outcome.size})
                </span>
              </Row>
              <Row label="Price difference">{priceDiffSentence(outcome.priceDiff)}</Row>
              <Row label="Exchange bonus">+{formatUsd(EXCHANGE_BONUS_USD)} store credit</Row>
            </dl>
          </div>
          <div className="mt-5 flex items-start gap-3 rounded-2xl bg-surface-2 p-4 text-sm">
            <IconBox className="mt-0.5 h-5 w-5 shrink-0 text-muted" />
            <p className="leading-relaxed text-muted">
              Send the {sku.name} back within 30 days with the prepaid label we&apos;ve emailed you.
            </p>
          </div>
        </>
      ) : (
        <>
          <StepHeading
            title="Refund requested"
            sub={`${formatUsd(r.price)} goes back to your original payment method 5–7 business days after the ${sku.name} arrives.`}
          />
          <div className="flex items-start gap-3 rounded-2xl bg-surface-2 p-4 text-sm">
            <IconBox className="mt-0.5 h-5 w-5 shrink-0 text-muted" />
            <p className="leading-relaxed text-muted">
              Your prepaid return label is on its way to your email. Drop the parcel at any post office within 30 days.
            </p>
          </div>
        </>
      )}

      {r.photo ? (
        <p className="mt-4 text-xs leading-relaxed text-muted">
          TryBack deletes your photo within 24 hours of upload and the previews made from it within 14 days. If live
          previews were made, Clothsy AI (our try-on provider) deletes its copy within 35 days.
        </p>
      ) : null}

      <div className="mt-8 grid gap-3">
        <LinkButton href="/r" variant="secondary" size="lg">
          Start another return
        </LinkButton>
        <LinkButton href="/merchant" variant="ghost" size="md">
          See what the merchant sees
        </LinkButton>
      </div>
    </div>
  );
}
