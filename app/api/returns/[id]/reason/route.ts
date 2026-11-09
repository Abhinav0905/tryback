import { getSku } from "@/lib/catalog";
import { ReasonBody } from "@/lib/apiSchemas";
import { scheduleAndRun, toPick } from "@/lib/apiRender";
import {
  advanceStatus,
  ApiError,
  assertNotResolved,
  handle,
  readJson,
  requireReturn,
  returnResponse,
  updateReturnOr404,
} from "@/lib/apiRoute";
import { JSON_BODY_LIMIT, withBodyLimit } from "@/lib/bodyLimit";
import { CANDIDATES_SHOWN, rankCandidates, speculativePicks } from "@/lib/retrieval";
import type { FitComplaint } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST /api/returns/[id]/reason { reason, fitComplaints? } → { return }
// style_colour → candidates = speculativePicks (rendered at photo upload).
export async function POST(req: Request, ctx: RouteContext<"/api/returns/[id]/reason">): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(withBodyLimit(req, JSON_BODY_LIMIT), ReasonBody);
    const current = await requireReturn(id);
    assertNotResolved(current);
    const sku = getSku(current.skuId);
    if (!sku) throw new ApiError(422, "UNKNOWN_SKU", "That item is no longer in the catalogue.");

    const fitComplaints: FitComplaint[] = body.reason === "fit_size" ? [...new Set(body.fitComplaints ?? [])] : [];

    const now = new Date().toISOString();
    const updated = await updateReturnOr404(id, (r) => {
      assertNotResolved(r);
      r.reason = body.reason;
      r.fitComplaints = fitComplaints;
      r.timeline.reasonAt = now;
      if (body.reason === "style_colour") {
        r.candidates = r.diagnosis
          ? rankCandidates(sku, r.size, r.diagnosis, { measurements: r.measurements, limit: CANDIDATES_SHOWN, paidPrice: r.price })
          : speculativePicks(sku, r.size, "style_colour", { paidPrice: r.price });
      } else {
        r.candidates = [];
      }
      advanceStatus(r, "reason_selected");
    });

    // Photo already on file (shopper came back and changed the reason): start the swaps now.
    if (updated.reason === "style_colour" && updated.photo && !updated.photoSkipped) {
      const jobs = await scheduleAndRun(
        req,
        id,
        updated.candidates.slice(0, 2).map(toPick),
        updated.diagnosis ? "post_diagnosis" : "speculative",
      );
      if (jobs.length > 0) return returnResponse(await requireReturn(id));
    }
    return returnResponse(updated);
  });
}
