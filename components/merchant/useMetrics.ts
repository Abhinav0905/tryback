"use client";

// Polls GET /api/metrics every `intervalMs` (default 2 s) with visibility awareness:
// polling pauses while the tab is hidden and fetches immediately when it becomes visible.
// Requests never overlap; the last good payload is kept on errors and while a toggle
// refetches (the UI dims it rather than flashing skeletons). Repeated failures back off.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MerchantMetrics } from "@/lib/types";

export interface MetricsState {
  data: MerchantMetrics | null;
  /** Last error message (cleared on the next success). */
  error: string | null;
  /** True while the tab is hidden and polling is paused. */
  paused: boolean;
  /** Client time (ms) of the last successful fetch. */
  lastOkAt: number | null;
  /** True when the shown data doesn't match the requested seeded toggle yet. */
  stale: boolean;
  refresh: () => void;
}

export function useMetrics(opts: {
  includeSeeded: boolean;
  intervalMs?: number;
  /** Called on every successful poll with the previous payload (null on the first). */
  onUpdate?: (prev: MerchantMetrics | null, next: MerchantMetrics) => void;
}): MetricsState {
  const { includeSeeded, intervalMs = 2000 } = opts;
  const [data, setData] = useState<MerchantMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const onUpdateRef = useRef(opts.onUpdate);
  const dataRef = useRef<MerchantMetrics | null>(null);
  const kickRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    onUpdateRef.current = opts.onUpdate;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let failures = 0;

    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = (ms: number) => {
      clear();
      timer = setTimeout(run, ms);
    };

    async function run(): Promise<void> {
      timer = null;
      if (cancelled) return;
      if (isHidden()) {
        setPaused(true);
        return;
      }
      controller?.abort();
      const ctl = new AbortController();
      controller = ctl;
      try {
        const res = await fetch(`/api/metrics?seeded=${includeSeeded ? "1" : "0"}`, {
          cache: "no-store",
          signal: ctl.signal,
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(await readError(res));
        const next = (await res.json()) as MerchantMetrics;
        if (cancelled || ctl.signal.aborted) return;
        failures = 0;
        const prev = dataRef.current;
        dataRef.current = next;
        setData(next);
        setError(null);
        setPaused(false);
        setLastOkAt(Date.now());
        onUpdateRef.current?.(prev, next);
      } catch (err) {
        if (cancelled || ctl.signal.aborted) return;
        failures += 1;
        setError(err instanceof Error && err.message ? err.message : "Network error");
      }
      if (cancelled || isHidden()) return;
      const backoff = failures > 2 ? Math.min(intervalMs * 2 ** (failures - 2), 15_000) : intervalMs;
      schedule(backoff);
    }

    const onVisibility = () => {
      if (isHidden()) {
        clear();
        setPaused(true);
      } else {
        setPaused(false);
        schedule(0);
      }
    };

    kickRef.current = () => schedule(0);
    document.addEventListener("visibilitychange", onVisibility);
    schedule(0);
    return () => {
      cancelled = true;
      clear();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [includeSeeded, intervalMs]);

  const refresh = useCallback(() => kickRef.current(), []);

  return {
    data,
    error,
    paused,
    lastOkAt,
    stale: data !== null && data.includesSeeded !== includeSeeded,
    refresh,
  };
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
    // not JSON
  }
  return `Request failed (${res.status})`;
}
