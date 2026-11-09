"use client";

// /r/order/[orderId]?email= — pick the item to return, create the return, go.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, formatUsd } from "@/components/ui";
import type { Order, Sku } from "@/lib/types";
import { ApiError, api, errorMessage, isAbortError } from "./api";
import { shortDate } from "./format";
import { ErrorNote, IconChevron, LinkButton, ProductImage, Spinner, StepHeading } from "./primitives";
import { ShopperShell } from "./ShopperShell";

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string; notFound: boolean }
  | { kind: "ready"; order: Order; skus: Sku[] };

export function OrderLines({ orderId, email }: { orderId: string; email: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>(() =>
    email ? { kind: "loading" } : { kind: "error", message: "Add the email you used for this order.", notFound: true },
  );
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!email) return;
    const ac = new AbortController();
    api.order(orderId, email, ac.signal).then(
      ({ order, skus }) => setLoad({ kind: "ready", order, skus }),
      (e: unknown) => {
        if (isAbortError(e)) return;
        const notFound = e instanceof ApiError && e.status === 404;
        setLoad({
          kind: "error",
          notFound,
          message: notFound ? "We couldn't find that order with that email." : errorMessage(e),
        });
      },
    );
    return () => ac.abort();
  }, [orderId, email, attempt]);

  const start = async (lineIndex: number) => {
    setPendingLine(lineIndex);
    setCreateError(null);
    try {
      const r = await api.createReturn({ orderId, email, lineIndex });
      router.push(`/r/${encodeURIComponent(r.id)}`);
    } catch (e) {
      setCreateError(errorMessage(e));
      setPendingLine(null);
    }
  };

  const lookupHref = `/r?order=${encodeURIComponent(orderId)}`;

  return (
    <ShopperShell>
      {load.kind === "loading" ? (
        <div aria-busy="true" className="space-y-4">
          <p className="sr-only" role="status">
            Loading your order…
          </p>
          <div className="tb-skeleton h-8 w-2/3 rounded-lg" />
          <div className="tb-skeleton h-4 w-1/2 rounded-full" />
          <div className="tb-skeleton mt-6 h-[104px] rounded-2xl" />
          <div className="tb-skeleton h-[104px] rounded-2xl" />
        </div>
      ) : null}

      {load.kind === "error" ? (
        <div>
          <StepHeading title={load.notFound ? "Order not found" : "Something went wrong"} />
          <ErrorNote>{load.message}</ErrorNote>
          <div className="mt-5 grid gap-3">
            {load.notFound ? (
              <LinkButton href={lookupHref} size="lg">
                Check the details
              </LinkButton>
            ) : (
              <Button
                size="lg"
                onClick={() => {
                  setLoad({ kind: "loading" });
                  setAttempt((a) => a + 1);
                }}
              >
                Try again
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {load.kind === "ready" ? (
        <div>
          <StepHeading
            eyebrow={`Order #${load.order.id}${load.order.deliveredAt ? ` · delivered ${shortDate(load.order.deliveredAt)}` : ""}`}
            title={`Hi ${load.order.customerName} — what's going back?`}
            sub="Choose one item. You can start another return afterwards."
          />
          <ul className="space-y-3">
            {load.order.lines.map((line, i) => {
              const sku = load.skus.find((s) => s.id === line.skuId);
              if (!sku) return null;
              return (
                <li key={`${line.skuId}-${i}`}>
                  <button
                    type="button"
                    onClick={() => void start(i)}
                    disabled={pendingLine !== null}
                    className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface p-3 text-left shadow-card hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 motion-safe:transition-colors"
                  >
                    <ProductImage sku={sku} className="h-[96px] w-[72px] shrink-0 rounded-xl ring-1 ring-line" alt="" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-snug">{sku.name}</span>
                      <span className="mt-1 block text-sm text-muted">
                        Size {line.size} · {formatUsd(line.price)}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">{sku.fabric}</span>
                    </span>
                    {pendingLine === i ? (
                      <Spinner className="h-5 w-5 text-muted" label="Starting your return" />
                    ) : (
                      <IconChevron className="h-5 w-5 shrink-0 text-muted" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {createError ? <ErrorNote className="mt-4">{createError}</ErrorNote> : null}
          <p className="mt-6 text-xs text-muted">
            Returns are free within 30 days of delivery. Not your order?{" "}
            <Link href="/r" className="underline underline-offset-2 hover:text-ink">
              Look up another
            </Link>
            .
          </p>
        </div>
      ) : null}
    </ShopperShell>
  );
}
