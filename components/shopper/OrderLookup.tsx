"use client";

// /r — find an order by number + email, with one-tap demo orders.

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button, cx } from "@/components/ui";
import { ORDERS, getSku } from "@/lib/catalog";
import { ApiError, api, errorMessage } from "./api";
import { ErrorNote, IconArrowRight, SectionLabel, Spinner, StepHeading } from "./primitives";

const DEMO_EMAIL = "demo";
const DEMO_ORDER_IDS = ["1042", "1043", "1044"] as const;

export function OrderLookup({ initialOrder = "", initialEmail = "" }: { initialOrder?: string; initialEmail?: string }) {
  const router = useRouter();
  const [orderId, setOrderId] = useState(initialOrder);
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const orderFieldId = useId();
  const emailFieldId = useId();
  const errorId = useId();

  const cleanOrder = orderId.replace(/^#/, "").trim();
  const cleanEmail = email.trim();
  const missingOrder = touched && !cleanOrder;
  const missingEmail = touched && !cleanEmail;

  const go = async (id: string, em: string, source: string) => {
    setPending(source);
    setError(null);
    try {
      await api.order(id, em);
      router.push(`/r/order/${encodeURIComponent(id)}?email=${encodeURIComponent(em)}`);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "We couldn't find an order with that number and email. Check both and try again."
          : errorMessage(e),
      );
      setPending(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!cleanOrder || !cleanEmail) return;
    void go(cleanOrder, cleanEmail, "form");
  };

  const fieldClass =
    "mt-1.5 h-12 w-full rounded-xl border bg-surface px-4 text-[16px] outline-none placeholder:text-muted/70 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-60";

  return (
    <div>
      <StepHeading
        eyebrow="Returns & exchanges"
        title="Start a return"
        sub="Find your order, tell us what didn't work, and — if you like — see swaps on you before you decide."
      />

      <form onSubmit={onSubmit} noValidate className="space-y-4" aria-describedby={error ? errorId : undefined}>
        <div>
          <label htmlFor={orderFieldId} className="text-sm font-medium">
            Order number
          </label>
          <input
            id={orderFieldId}
            value={orderId}
            onChange={(e) => setOrderId(e.currentTarget.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="e.g. 1042"
            aria-invalid={missingOrder || undefined}
            disabled={pending !== null}
            className={cx(fieldClass, missingOrder ? "border-bad" : "border-line")}
          />
          {missingOrder ? <p className="mt-1 text-xs text-bad">Enter your order number.</p> : null}
        </div>
        <div>
          <label htmlFor={emailFieldId} className="text-sm font-medium">
            Email used for the order
          </label>
          <input
            id={emailFieldId}
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            type="text"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@example.com"
            aria-invalid={missingEmail || undefined}
            disabled={pending !== null}
            className={cx(fieldClass, missingEmail ? "border-bad" : "border-line")}
          />
          {missingEmail ? <p className="mt-1 text-xs text-bad">Enter the email you ordered with.</p> : null}
        </div>
        {error ? (
          <div id={errorId}>
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
        <Button type="submit" size="lg" className="w-full" disabled={pending !== null}>
          {pending === "form" ? <Spinner /> : null}
          Find my order
        </Button>
      </form>

      <section aria-labelledby="demo-orders" className="mt-10">
        <SectionLabel>
          <span id="demo-orders">Demo orders</span>
        </SectionLabel>
        <p className="mt-1 text-xs text-muted">Fictional customers · email &ldquo;demo&rdquo;</p>
        <ul className="mt-3 space-y-2">
          {DEMO_ORDER_IDS.map((id) => {
            const order = ORDERS.find((o) => o.id === id);
            if (!order) return null;
            const first = getSku(order.lines[0]?.skuId ?? "");
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => {
                    setOrderId(id);
                    setEmail(DEMO_EMAIL);
                    setTouched(false);
                    void go(id, DEMO_EMAIL, id);
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                >
                  <span className="tabular flex h-10 w-14 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-sm font-semibold">
                    #{id}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{order.customerName}</span>
                    <span className="block truncate text-xs text-muted">
                      {first?.name ?? "Order"}
                      {order.lines.length > 1 ? ` + ${order.lines.length - 1} more` : ""}
                    </span>
                  </span>
                  {pending === id ? (
                    <Spinner className="h-4 w-4 text-muted" label="Opening order" />
                  ) : (
                    <IconArrowRight className="h-4 w-4 text-muted" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
