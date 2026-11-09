"use client";

// The shopper return flow for /r/[returnId]. The server's ReturnCase is the source
// of truth (polled by useReturnCase); client-only screens (capture, exchange
// confirm, refund confirm, going back) are a thin overlay on top of it.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { getSku } from "@/lib/catalog";
import type { ReturnCase } from "@/lib/types";
import { CaptureStep } from "./CaptureStep";
import { DoneScreen, ExchangeConfirm, RefundConfirm } from "./ConfirmSteps";
import { baseStep, stepIndexFor, stepsFor, viewStep, type Overlay, type ViewStep } from "./flow";
import { PhotoOfferStep } from "./PhotoOfferStep";
import { ErrorNote, LinkButton, Spinner, StepHeading } from "./primitives";
import { ReasonStep } from "./ReasonStep";
import { ResultsStep } from "./ResultsStep";
import { ShopperShell } from "./ShopperShell";
import { SizeStep } from "./SizeStep";
import { StyleFormStep } from "./StyleFormStep";
import { useAppStatus } from "./useAppStatus";
import { useGateRunner } from "./useGateRunner";
import { prefersReducedMotion } from "./useNow";
import { useReturnCase } from "./useReturnCase";

function LoadingSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <p className="sr-only" role="status">
        Loading your return…
      </p>
      <div className="tb-skeleton h-[98px] rounded-2xl" />
      <div className="tb-skeleton mt-6 h-8 w-3/4 rounded-lg" />
      <div className="tb-skeleton h-4 w-1/2 rounded-full" />
      <div className="tb-skeleton h-[76px] rounded-2xl" />
      <div className="tb-skeleton h-[76px] rounded-2xl" />
      <div className="tb-skeleton h-[76px] rounded-2xl" />
    </div>
  );
}

export function ReturnFlow({ returnId }: { returnId: string }) {
  const { data: r, error, notFound, reconnecting, apply, refresh } = useReturnCase(returnId);
  const { status } = useAppStatus();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [consented, setConsented] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useGateRunner({ r, maxRenders: status?.maxRendersPerReturn ?? 5, onResult: apply });

  // A step's request (form, photo upload…) can finish after the shopper tapped "Skip to
  // refund": keep them on the refund screen they chose instead of pulling them to results.
  // The refund itself resolves the return, and "done" wins over any overlay (viewStep).
  const advance = useCallback(
    (next: ReturnCase) => {
      apply(next);
      setOverlay((cur) => (cur?.kind === "refund_confirm" ? cur : null));
    },
    [apply],
  );

  const view: ViewStep | null = r ? viewStep(r, overlay) : null;
  const viewKey = view ?? (notFound ? "not_found" : "loading");

  // Move focus to the new step's heading (and scroll to top) whenever the step changes.
  const prevKey = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevKey.current;
    prevKey.current = viewKey;
    if (prev === null || prev === "loading" || prev === viewKey) return;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    const h = mainRef.current?.querySelector<HTMLElement>("[data-step-heading]");
    h?.focus({ preventScroll: true });
  }, [viewKey]);

  if (notFound) {
    return (
      <ShopperShell>
        <StepHeading title="We couldn't find this return" sub="The link may be old, or the demo data was reset." />
        <LinkButton href="/r" size="lg" className="w-full">
          Find your order
        </LinkButton>
      </ShopperShell>
    );
  }

  if (!r || !view) {
    return (
      <ShopperShell>
        {error ? (
          <div className="space-y-4">
            <ErrorNote>{error.message}</ErrorNote>
            <Button variant="secondary" size="lg" className="w-full" onClick={refresh}>
              Try again
            </Button>
          </div>
        ) : (
          <LoadingSkeleton />
        )}
      </ShopperShell>
    );
  }

  const sku = getSku(r.skuId);
  if (!sku) {
    return (
      <ShopperShell>
        <ErrorNote>This item is no longer in the catalogue. Please contact support for a refund.</ErrorNote>
      </ShopperShell>
    );
  }

  const base = baseStep(r);
  const steps = stepsFor(r.reason);
  const current = stepIndexFor(view, steps);
  const skipToRefund =
    view === "done" || view === "refund_confirm" ? undefined : () => setOverlay({ kind: "refund_confirm", from: "skip" });

  let content: ReactNode;
  switch (view) {
    case "reason":
      content = <ReasonStep r={r} sku={sku} onDone={advance} />;
      break;

    case "refund_confirm": {
      const fromSkip = overlay?.kind === "refund_confirm" && overlay.from === "skip";
      content = (
        <RefundConfirm
          r={r}
          sku={sku}
          backLabel={fromSkip ? "Back" : "Change reason"}
          onBack={() => setOverlay(fromSkip && base !== "refund_confirm" ? null : { kind: "reason" })}
          onDone={advance}
        />
      );
      break;
    }

    case "photo_offer": {
      const fromBase = base === "photo_offer";
      content = (
        <PhotoOfferStep
          r={r}
          sku={sku}
          consented={consented}
          onConsentChange={setConsented}
          onTakePhoto={() => setOverlay({ kind: "capture", source: "camera", file: null })}
          onFile={(file) => setOverlay({ kind: "capture", source: "upload", file })}
          onSkipped={advance}
          onBack={fromBase ? () => setOverlay({ kind: "reason" }) : () => setOverlay(null)}
          backLabel={fromBase ? "Change reason" : "Back"}
        />
      );
      break;
    }

    case "capture":
      content =
        overlay?.kind === "capture" && consented ? (
          <CaptureStep
            r={r}
            sku={sku}
            status={status}
            source={overlay.source}
            initialFile={overlay.file}
            onUploaded={advance}
            onBack={() => setOverlay(base === "photo_offer" ? null : { kind: "photo_offer" })}
          />
        ) : (
          <PhotoOfferStep
            r={r}
            sku={sku}
            consented={consented}
            onConsentChange={setConsented}
            onTakePhoto={() => setOverlay({ kind: "capture", source: "camera", file: null })}
            onFile={(file) => setOverlay({ kind: "capture", source: "upload", file })}
            onSkipped={advance}
            onBack={() => setOverlay(null)}
            backLabel="Back"
          />
        );
      break;

    case "style_form":
      content = <StyleFormStep r={r} sku={sku} onDone={advance} />;
      break;

    case "results":
      content = (
        <ResultsStep
          r={r}
          sku={sku}
          onSwap={(t) => setOverlay({ kind: "exchange", ...t })}
          onAddPhoto={() => setOverlay({ kind: "photo_offer" })}
        />
      );
      break;

    case "size":
      content = (
        <SizeStep
          r={r}
          sku={sku}
          status={status}
          onSwap={(t) => setOverlay({ kind: "exchange", ...t })}
          onApply={apply}
          onAddPhoto={() => setOverlay({ kind: "photo_offer" })}
        />
      );
      break;

    case "exchange":
      content =
        overlay?.kind === "exchange" ? (
          <ExchangeConfirm
            r={r}
            from={sku}
            target={overlay}
            onBack={() => setOverlay(null)}
            onDone={advance}
          />
        ) : null;
      break;

    case "done":
      content = <DoneScreen r={r} sku={sku} />;
      break;
  }

  return (
    <ShopperShell
      steps={view === "done" ? undefined : steps}
      currentStep={current}
      onSkipToRefund={skipToRefund}
      notice={
        reconnecting ? (
          <p role="status" className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
            <Spinner className="h-3 w-3" />
            Reconnecting… your progress is saved.
          </p>
        ) : null
      }
    >
      <div
        ref={mainRef}
        key={viewKey}
        className="motion-safe:transition-[opacity,translate] motion-safe:duration-300 motion-safe:ease-out motion-safe:starting:translate-y-1.5 motion-safe:starting:opacity-0"
      >
        {content}
      </div>
    </ShopperShell>
  );
}
