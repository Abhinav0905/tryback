import { handle, requireReturn, returnResponse } from "@/lib/apiRoute";
import { failStaleJobs, hasStaleJob } from "@/lib/orchestrator";

// GET /api/returns/[id] → { return }  (Cache-Control: no-store; polled by the shopper UI)
// Also sweeps render jobs orphaned by a server restart (see STALE_JOB_MS), so a card
// never spins forever.
export async function GET(_req: Request, ctx: RouteContext<"/api/returns/[id]">): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const r = await requireReturn(id);
    if (hasStaleJob(r)) {
      await failStaleJobs(id);
      return returnResponse(await requireReturn(id));
    }
    return returnResponse(r);
  });
}
