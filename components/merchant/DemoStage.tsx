"use client";

// /demo: the shopper flow in a phone frame on the left, the live merchant dashboard on
// the right, and a "Reset demo" control. Built for screen-recording the 2:30 demo video;
// stacks vertically on narrow viewports.

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { BRAND } from "@/lib/catalog";
import { Dashboard } from "./Dashboard";
import { ExternalIcon, RefreshIcon } from "./icons";
import { PhoneFrame } from "./PhoneFrame";

type ResetState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function DemoStage() {
  const [phoneKey, setPhoneKey] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [reset, setReset] = useState<ResetState>({ kind: "idle" });

  async function onReset() {
    setReset({ kind: "busy" });
    try {
      const res = await fetch("/api/admin/reset", { method: "POST", headers: { accept: "application/json" } });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; scope?: "all" | "viewer"; deletedReturns?: number; keptRenders?: number; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? `Reset failed (${res.status})`);
      const n = body.deletedReturns ?? 0;
      const returns = `${n} ${n === 1 ? "return" : "returns"}`;
      const kept = `${body.keptRenders ?? 0} cached renders kept (re-runs cost 0 credits)`;
      setReset({
        kind: "done",
        message:
          body.scope === "all"
            ? `Demo reset · ${returns} cleared · ${kept}`
            : `Cleared ${returns} made in this browser · other visitors' returns stay · ${kept}`,
      });
      setPhoneKey((k) => k + 1);
      setRefreshSignal((k) => k + 1);
    } catch (err) {
      setReset({ kind: "error", message: err instanceof Error ? err.message : "Reset failed" });
    }
  }

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            className="rounded-md text-base font-semibold tracking-tight text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            TryBack
          </Link>
          <span className="text-muted" aria-hidden>
            /
          </span>
          <h1 className="text-base font-medium text-ink">Live demo</h1>
          <Badge tone="neutral" className="hidden sm:inline-flex">
            {BRAND.name} is a fictional brand
          </Badge>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <p
            role="status"
            aria-live="polite"
            className={cx(
              "max-w-md truncate text-xs",
              reset.kind === "error" ? "text-bad" : "text-muted",
              reset.kind === "idle" || reset.kind === "busy" ? "sr-only" : undefined,
            )}
          >
            {reset.kind === "done" || reset.kind === "error" ? reset.message : reset.kind === "busy" ? "Resetting demo…" : ""}
          </p>
          <Button size="sm" variant="ghost" onClick={() => setPhoneKey((k) => k + 1)}>
            <RefreshIcon /> Reload phone
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={onReset}
            disabled={reset.kind === "busy"}
            title="Clears the returns made in this browser. Other visitors' returns and the seeded history stay."
          >
            {reset.kind === "busy" ? "Resetting…" : "Reset demo"}
          </Button>
          <Link
            href="/merchant"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Full dashboard <ExternalIcon size={13} />
          </Link>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.4fr)]">
        <section
          aria-label="Shopper return portal on a phone"
          className="flex min-h-0 flex-col items-center gap-3 border-line bg-surface-2/50 px-4 py-6 lg:border-r lg:py-5"
        >
          <div className="text-xs font-medium text-muted">Shopper · /r</div>
          <div className="w-full min-h-0 flex-1">
            <PhoneFrame src="/r" title="TryBack shopper return portal" reloadKey={phoneKey} />
          </div>
        </section>
        <section aria-label="Merchant dashboard" className="min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
          <Dashboard compact refreshSignal={refreshSignal} />
        </section>
      </div>
    </div>
  );
}
