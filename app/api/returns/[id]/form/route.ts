import { getSku } from "@/lib/catalog";
import { FormBody } from "@/lib/apiSchemas";
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
import { diagnose } from "@/lib/diagnosis";
import { firstCardAtFor, hasActiveJob, hasDeterministicFailure } from "@/lib/orchestrator";
import { limitRequest, RATE_RULES } from "@/lib/ratelimit";
import { CANDIDATES_SHOWN, rankCandidates } from "@/lib/retrieval";

export const runtime = "nodejs";
export const maxDuration = 300;

/** New renders the form may start (on top of the speculative ones already running). */
const POST_DIAGNOSIS_RENDERS = 2;

// POST /api/returns/[id]/form { chips, freeText } → { return }
// Diagnosis is text-only (chips, note, garment attributes, ease/hem) — the photo never goes to the LLM.
export async function POST(req: Request, ctx: RouteContext<"/api/returns/[id]/form">): Promise<Response> {
  const limited = limitRequest(req, RATE_RULES.form);
  if (limited) return limited;
  return handle(async () => {
    const { id } = await ctx.params;
    const submittedAt = new Date().toISOString();
    const body = await readJson(withBodyLimit(req, JSON_BODY_LIMIT), FormBody);
    const current = await requireReturn(id);
    assertNotResolved(current);
    if (current.reason !== "style_colour") {
      throw new ApiError(409, "WRONG_STEP", "The style form is only for style or colour returns.");
    }
    const sku = getSku(current.skuId);
    if (!sku) throw new ApiError(422, "UNKNOWN_SKU", "That item is no longer in the catalogue.");

    const chips = [...new Set(body.chips)];
    const freeText = body.freeText.replace(/\s+/g, " ").trim();

    // Record the submission immediately so the honest clock (and pollers) see it.
    await updateReturnOr404(id, (r) => {
      assertNotResolved(r);
      r.chips = chips;
      r.freeText = freeText;
      r.timeline.formSubmittedAt ??= submittedAt;
    });

    const m = current.measurements;
    const diagnosis = await diagnose({
      sku,
      size: current.size,
      chips,
      freeText,
      measurements: m ? { easeRatio: m.easeRatio, hemCm: m.hemCm } : null,
    });
    const candidates = rankCandidates(sku, current.size, diagnosis, {
      measurements: m,
      limit: CANDIDATES_SHOWN,
      paidPrice: current.price,
    });

    const updated = await updateReturnOr404(id, (r) => {
      assertNotResolved(r);
      r.diagnosis = diagnosis;
      r.candidates = candidates;
      // A speculative render that dropped out of the top 4 is no longer a card on screen.
      r.timeline.firstCardAt = firstCardAtFor(r);
      advanceStatus(r, "form_submitted");
    });

    if (updated.photo && !updated.photoSkipped) {
      // Already-rendered candidates that still rank in the top 4 keep their render;
      // the best unrendered ones get up to two new renders (per-return cap applies).
      // A SKU whose render already failed for a reason a re-render can't fix is passed over.
      const picks = candidates
        .filter((c) => !hasActiveJob(updated, c.skuId) && !hasDeterministicFailure(updated, c.skuId))
        .slice(0, POST_DIAGNOSIS_RENDERS)
        .map(toPick);
      const jobs = await scheduleAndRun(req, id, picks, "post_diagnosis");
      if (jobs.length > 0) return returnResponse(await requireReturn(id));
    }
    return returnResponse(updated);
  });
}
