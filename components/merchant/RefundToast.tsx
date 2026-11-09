"use client";

// "Refund avoided +$79" toast ($89 kept, net of the $10 exchange bonus), raised when exchanges increase between polls.
// The live region is always mounted so screen readers announce each new toast;
// the slide-in only runs when the user hasn't asked for reduced motion.

import { useEffect, useState } from "react";
import { cx, formatUsd } from "@/components/ui";
import { CheckIcon, DropIcon } from "./icons";

export interface RefundToastData {
  id: number;
  amount: number;
  count: number;
  skuName: string | null;
}

const VISIBLE_MS = 6500;

export function RefundToast({ toast, onDismiss }: { toast: RefundToastData | null; onDismiss: () => void }) {
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    if (!toast) return;
    const enter = requestAnimationFrame(() => setShown(toast.id));
    const leave = setTimeout(onDismiss, VISIBLE_MS);
    return () => {
      cancelAnimationFrame(enter);
      clearTimeout(leave);
    };
  }, [toast, onDismiss]);

  const visible = toast !== null && shown === toast.id;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-end sm:inset-x-auto sm:right-6 sm:bottom-6"
    >
      {toast ? (
        <div
          className={cx(
            "pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl border border-accent bg-surface p-4 shadow-card",
            "transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
            visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0 motion-reduce:translate-y-0 motion-reduce:opacity-100",
          )}
        >
          <span aria-hidden className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
            <CheckIcon size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-base font-semibold text-ink">
              {toast.count > 1 ? `${toast.count} refunds avoided` : "Refund avoided"}{" "}
              <span className="text-accent">{formatUsd(toast.amount, { sign: true })}</span>
            </p>
            <p className="mt-0.5 text-sm text-muted">
              {toast.skuName ? `Exchange confirmed · ${toast.skuName}` : "Exchange confirmed"}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="-mr-1 -mt-1 rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            aria-label="Dismiss notification"
          >
            <DropIcon size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
