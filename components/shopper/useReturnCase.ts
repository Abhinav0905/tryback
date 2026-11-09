"use client";

// Polls GET /api/returns/[id]:
//   · every 1.5 s while any render job is queued/running, otherwise every 6 s;
//   · stops once the return is resolved, or on 404;
//   · pauses while the tab is hidden and refreshes immediately when it's visible again;
//   · aborts in-flight requests on unmount and whenever a mutation response is applied;
//   · backs off exponentially (≤30 s) after consecutive errors.
// Mutation responses (POST …) are applied with `apply`, which also discards any poll
// that was already in flight so an older snapshot can never overwrite a newer one.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReturnCase } from "@/lib/types";
import { ApiError, api, isAbortError } from "./api";
import { nextPollDelay } from "./flow";

export interface ReturnCaseState {
  data: ReturnCase | null;
  /** Last polling error (cleared on the next success). */
  error: ApiError | null;
  notFound: boolean;
  /** We have data but the last poll(s) failed. */
  reconnecting: boolean;
  /** Apply a fresh ReturnCase from a mutation response. Stable identity. */
  apply: (r: ReturnCase) => void;
  /** Poll right now. Stable identity. */
  refresh: () => void;
}

interface Controller {
  ticket: number;
  minValidTicket: number;
  failures: number;
  timer: number | undefined;
  abort: AbortController | null;
  data: ReturnCase | null;
  reschedule: (delay: number | null) => void;
}

export function useReturnCase(returnId: string): ReturnCaseState {
  const [data, setData] = useState<ReturnCase | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const ctl = useRef<Controller>({
    ticket: 0,
    minValidTicket: 0,
    failures: 0,
    timer: undefined,
    abort: null,
    data: null,
    reschedule: () => undefined,
  });

  const apply = useCallback((r: ReturnCase) => {
    const c = ctl.current;
    c.minValidTicket = c.ticket + 1; // everything already in flight is now stale
    c.abort?.abort();
    c.failures = 0;
    c.data = r;
    setData(r);
    setError(null);
    c.reschedule(nextPollDelay(r, 0));
  }, []);

  const refresh = useCallback(() => ctl.current.reschedule(0), []);

  useEffect(() => {
    const c = ctl.current;
    let disposed = false;

    const schedule = (delay: number | null) => {
      window.clearTimeout(c.timer);
      c.timer = undefined;
      if (disposed || delay === null) return;
      c.timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (disposed) return;
      if (document.visibilityState === "hidden") return; // resumed by the visibility listener
      c.abort?.abort();
      const ticket = ++c.ticket;
      const ac = new AbortController();
      c.abort = ac;
      try {
        const r = await api.getReturn(returnId, ac.signal);
        if (disposed || ticket < c.minValidTicket) return; // superseded by a mutation
        c.failures = 0;
        c.data = r;
        setData(r);
        setError(null);
        schedule(nextPollDelay(r, 0));
      } catch (e) {
        if (disposed || isAbortError(e) || ticket < c.minValidTicket) return;
        const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", "Something went wrong.", 0);
        setError(err);
        if (err.status === 404) return; // nothing to poll
        c.failures += 1;
        schedule(nextPollDelay(c.data, c.failures));
      } finally {
        if (c.abort === ac) c.abort = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const delay = nextPollDelay(c.data, 0);
      if (delay !== null) schedule(0);
    };

    c.reschedule = schedule;
    document.addEventListener("visibilitychange", onVisibility);
    schedule(0);

    return () => {
      disposed = true;
      window.clearTimeout(c.timer);
      c.timer = undefined;
      c.abort?.abort();
      c.abort = null;
      c.reschedule = () => undefined;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [returnId]);

  const notFound = error?.status === 404;
  return {
    data,
    error,
    notFound,
    reconnecting: data !== null && error !== null && !notFound,
    apply,
    refresh,
  };
}
