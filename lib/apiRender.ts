// Route-side glue for background renders: schedule jobs, then run them with
// `after()` so the HTTP response returns immediately. Server-only.

import { after } from "next/server";
import { allowLiveFromRequest } from "./live";
import { runJobs, scheduleRenders, type RenderPick } from "./orchestrator";
import type { Candidate, RenderJob, RenderPhase } from "./types";

export function toPick(c: Pick<Candidate, "skuId" | "size" | "transition">): RenderPick {
  return { skuId: c.skuId, size: c.size, transition: c.transition };
}

/**
 * Schedule renders (dedupe + cap enforced by the orchestrator) and start them in
 * the background after the response. Live access is decided from this request's
 * cookie now, because the background task has no request to read.
 */
export async function scheduleAndRun(
  req: Request,
  returnId: string,
  picks: RenderPick[],
  phase: RenderPhase,
): Promise<RenderJob[]> {
  const jobs = await scheduleRenders(returnId, picks, phase);
  if (jobs.length > 0) {
    const allowLive = await allowLiveFromRequest(req);
    const ids = jobs.map((j) => j.id);
    after(() => runJobs(returnId, ids, { allowLive }));
  }
  return jobs;
}

/** Start already-scheduled jobs (e.g. a gate retry) in the background. */
export async function runInBackground(req: Request, returnId: string, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const allowLive = await allowLiveFromRequest(req);
  after(() => runJobs(returnId, jobIds, { allowLive }));
}
