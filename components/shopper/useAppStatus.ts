"use client";

// GET /api/status, shared by every shopper component on the page (one request per
// 30 s at most). Drives the demo banner, the "Continue anyway (dev)" escape hatch
// and the render cap the gate runner needs to know whether a retry is possible.

import { useEffect, useState } from "react";
import type { AppStatus } from "@/lib/types";
import { api } from "./api";

const TTL_MS = 30_000;
let cached: { at: number; promise: Promise<AppStatus> } | null = null;

export function loadAppStatus(force = false): Promise<AppStatus> {
  const now = Date.now();
  if (!force && cached && now - cached.at < TTL_MS) return cached.promise;
  const promise = api.status();
  cached = { at: now, promise };
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}

export function useAppStatus(): { status: AppStatus | null; failed: boolean } {
  const [state, setState] = useState<{ status: AppStatus | null; failed: boolean }>({ status: null, failed: false });

  useEffect(() => {
    let alive = true;
    loadAppStatus().then(
      (status) => {
        if (alive) setState({ status, failed: false });
      },
      () => {
        if (alive) setState({ status: null, failed: true });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
