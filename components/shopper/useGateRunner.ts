"use client";

// Client-side fidelity gate runner. Whenever a render job is `success` with no gate
// and not superseded, run `runGate` in the browser (MediaPipe on-device — the photo
// never leaves for an LLM) and POST the result. Guarantees:
//   · one job at a time;
//   · a job that already has a gate is never re-run, and a job id is attempted once
//     (tracked in refs, so re-renders and polling don't trigger duplicates);
//   · if the gate itself can't run (model failed to load…), an honest
//     "Preview not auto-checked" badge is posted instead of leaving the card stuck;
//   · a computed gate whose POST failed transiently is re-posted (≤3 tries), not recomputed;
//   · a gate the server rejects for good (e.g. 400) is replaced once by the honest fallback,
//     so the card can't stay on "Checking…";
//   · only cards the shopper sees are gated (see pickNextGateJob), in candidate order.

import { useEffect, useEffectEvent, useRef } from "react";
import { getSku } from "@/lib/catalog";
import type { GateResult, RenderJob, ReturnCase } from "@/lib/types";
import { ApiError, api } from "./api";
import { canRetryJob, pickNextGateJob, unavailableGate } from "./flow";

const MAX_POST_ATTEMPTS = 3;

export function useGateRunner(opts: {
  r: ReturnCase | null;
  maxRenders: number;
  onResult: (r: ReturnCase) => void;
}): void {
  const { r, maxRenders } = opts;
  const attempted = useRef(new Set<string>());
  const computed = useRef(new Map<string, GateResult>());
  const postAttempts = useRef(new Map<string, number>());
  const fellBack = useRef(new Set<string>());
  const busy = useRef(false);
  const mounted = useRef(true);
  const onResult = useEffectEvent((next: ReturnCase) => opts.onResult(next));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!r || busy.current) return;
    const job = pickNextGateJob(r, attempted.current);
    if (!job || !r.photo || !r.measurements || !job.resultUrl) return;

    const sourceSku = getSku(r.skuId);
    const targetSku = getSku(job.skuId);
    attempted.current.add(job.id);
    if (!sourceSku || !targetSku) return;

    busy.current = true;
    const snapshot = r;
    const photoUrl = r.photo.url;
    const measurements = r.measurements;
    const renderUrl = job.resultUrl;

    const run = async (j: RenderJob) => {
      let gate = computed.current.get(j.id);
      if (!gate) {
        const started = performance.now();
        try {
          const { runGate } = await import("@/lib/cv/gate");
          gate = await runGate({
            originalUrl: photoUrl,
            renderUrl,
            measurements,
            sourceSku,
            targetSku,
            targetSize: j.size,
            transition: j.transition,
            canRetry: canRetryJob(snapshot, j, maxRenders),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "unknown error";
          gate = unavailableGate(msg, performance.now() - started, new Date().toISOString());
        }
        computed.current.set(j.id, gate);
      }

      try {
        const next = await api.gate(snapshot.id, j.id, gate);
        computed.current.delete(j.id);
        // Free the runner *before* applying, so the re-render can start the next job.
        busy.current = false;
        if (mounted.current) onResult(next);
      } catch (e) {
        const tries = (postAttempts.current.get(j.id) ?? 0) + 1;
        postAttempts.current.set(j.id, tries);
        const transient = !(e instanceof ApiError) || e.transient;
        if (transient && tries < MAX_POST_ATTEMPTS) {
          // Let the next poll pick it up again; the computed gate is reused, not recomputed.
          attempted.current.delete(j.id);
        } else if (!fellBack.current.has(j.id)) {
          // Rejected for good: post the honest "not auto-checked" badge instead (once).
          fellBack.current.add(j.id);
          postAttempts.current.delete(j.id);
          const msg = e instanceof Error ? e.message : "the check couldn't be saved";
          computed.current.set(j.id, unavailableGate(msg, gate.computeMs, new Date().toISOString()));
          attempted.current.delete(j.id);
        } else {
          computed.current.delete(j.id);
        }
      }
    };

    void run(job).finally(() => {
      busy.current = false;
    });
  }, [r, maxRenders]);
}
