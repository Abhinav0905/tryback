import { GateBody } from "@/lib/apiSchemas";
import { runInBackground } from "@/lib/apiRender";
import { ApiError, assertSafeId, handle, readJson, requireReturn, returnResponse, updateReturnOr404 } from "@/lib/apiRoute";
import { JSON_BODY_LIMIT, withBodyLimit } from "@/lib/bodyLimit";
import { firstCardAtFor, requestGateRetry } from "@/lib/orchestrator";
import { clientKeyFrom, consumeRate, rateLimitResponse, RATE_RULES } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 300;

const FALLBACK_BADGE = "Preview approximate";

// POST /api/returns/[id]/renders/[jobId]/gate { gate } → { return }
// Stores the client-side fidelity gate. A 'retry' verdict spawns one retry with the
// alternate product shot; if no retry is possible it is downgraded to the gate's
// `fallbackVerdict`: 'drop' for a severe failure (identity drift, garment missing),
// otherwise 'badge'.
export async function POST(req: Request, ctx: RouteContext<"/api/returns/[id]/renders/[jobId]/gate">): Promise<Response> {
  const client = clientKeyFrom(req);
  const any = consumeRate(RATE_RULES.gate, client);
  if (!any.ok) return rateLimitResponse(any);
  return handle(async () => {
    const { id, jobId } = await ctx.params;
    assertSafeId(jobId, "render id");
    const { gate } = await readJson(withBodyLimit(req, JSON_BODY_LIMIT), GateBody);
    // A retry verdict can start a render (a credit when live): tighter limit, checked before
    // anything is stored so the shopper's gate runner simply re-posts later.
    if (gate.verdict === "retry") {
      const retry = consumeRate(RATE_RULES.gateRetry, client);
      if (!retry.ok) return rateLimitResponse(retry);
    }
    await requireReturn(id);

    await updateReturnOr404(id, (r) => {
      const job = r.renders.find((j) => j.id === jobId);
      if (!job) throw new ApiError(404, "RENDER_NOT_FOUND", "We couldn't find that preview.");
      if (job.status !== "success") {
        throw new ApiError(409, "RENDER_NOT_READY", "Only finished previews can be checked.");
      }
      job.gate = gate;
      r.timeline.firstCardAt = firstCardAtFor(r);
    });

    if (gate.verdict === "retry") {
      const retry = await requestGateRetry(id, jobId);
      if (retry) {
        await runInBackground(req, id, [retry.id]);
      } else {
        await updateReturnOr404(id, (r) => {
          const job = r.renders.find((j) => j.id === jobId);
          if (!job?.gate || job.gate.verdict !== "retry") return;
          const drop = job.gate.fallbackVerdict === "drop";
          job.gate = {
            ...job.gate,
            verdict: drop ? "drop" : "badge",
            badge: drop ? null : job.gate.badge?.trim() || FALLBACK_BADGE,
            reasons: [...job.gate.reasons, drop ? "retry unavailable → hidden (severe)" : "retry unavailable → shown with a badge"],
          };
          r.timeline.firstCardAt = firstCardAtFor(r);
        });
      }
    }
    return returnResponse(await requireReturn(id));
  });
}
