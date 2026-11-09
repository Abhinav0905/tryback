"use client";

// Judge access: when the server has a Clothsy key but this browser isn't unlocked
// (LIVE_ACCESS_CODE is set and the tb_live cookie is missing), offer a small code
// field that POSTs /api/live. Hidden in every other state, so the public link shows
// nothing extra in dev or replay mode, or once the daily live cap is reached.

import { useState, type FormEvent } from "react";
import { Button, cx } from "@/components/ui";
import { api, errorMessage } from "./api";
import { liveLockedFor } from "./flow";
import { ErrorNote, Spinner } from "./primitives";
import { useAppStatus } from "./useAppStatus";

export function LiveUnlock({ className }: { className?: string }) {
  const { status } = useAppStatus();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!liveLockedFor(status)) return null;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.unlockLive(code.trim());
      // The status cache and every ModePill read it once per page: reload to pick up live mode.
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err, "That access code didn't work."));
      setBusy(false);
    }
  }

  return (
    <details className={cx("group text-sm", className)}>
      <summary className="cursor-pointer list-none select-none text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        Have a judge access code? Unlock live try-on
      </summary>
      <form onSubmit={submit} className="mt-3 flex max-w-sm flex-wrap items-center gap-2">
        <label htmlFor="tb-live-code" className="sr-only">
          Access code
        </label>
        <input
          id="tb-live-code"
          type="password"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
        />
        <Button type="submit" size="sm" disabled={busy || !code.trim()}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
          Unlock
        </Button>
        {error ? <ErrorNote className="w-full">{error}</ErrorNote> : null}
      </form>
    </details>
  );
}
