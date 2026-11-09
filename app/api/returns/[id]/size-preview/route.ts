import { getSku } from "@/lib/catalog";
import { SizePreviewBody } from "@/lib/apiSchemas";
import { scheduleAndRun } from "@/lib/apiRender";
import { ApiError, assertNotResolved, handle, readJson, requireReturn, returnResponse } from "@/lib/apiRoute";
import { JSON_BODY_LIMIT, withBodyLimit } from "@/lib/bodyLimit";
import { hasActiveJob, remainingRenderBudget } from "@/lib/orchestrator";
import { limitRequest, RATE_RULES } from "@/lib/ratelimit";
import { classifyTransition } from "@/lib/retrieval";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST /api/returns/[id]/size-preview { skuId, size } → { return }
// One optional render (1 credit) of a size/length option on the shopper's photo.
// Idempotent per SKU: try-on can't show size, so another size of the same SKU reuses the render.
export async function POST(req: Request, ctx: RouteContext<"/api/returns/[id]/size-preview">): Promise<Response> {
  const limited = limitRequest(req, RATE_RULES.sizePreview);
  if (limited) return limited;
  return handle(async () => {
    const { id } = await ctx.params;
    const { skuId, size } = await readJson(withBodyLimit(req, JSON_BODY_LIMIT), SizePreviewBody);
    const current = await requireReturn(id);
    assertNotResolved(current);
    if (!current.photo || current.photoSkipped) {
      throw new ApiError(409, "PHOTO_REQUIRED", "A photo is needed for a preview on you.");
    }
    const source = getSku(current.skuId);
    const target = getSku(skuId);
    if (!source || !target) throw new ApiError(404, "SKU_NOT_FOUND", "We couldn't find that item.");
    if (target.family !== source.family) {
      throw new ApiError(400, "NOT_A_SIZE_OPTION", "Size previews are for other sizes or lengths of the same item.");
    }
    if (target.id === source.id && size === current.size) {
      throw new ApiError(400, "SAME_ITEM", "That's the size you already have.");
    }
    if ((target.inventory[size] ?? 0) <= 0) {
      throw new ApiError(409, "OUT_OF_STOCK", `${target.name} is out of stock in ${size}.`);
    }
    if (hasActiveJob(current, target.id)) return returnResponse(current);
    if (remainingRenderBudget(current) <= 0) {
      throw new ApiError(409, "RENDER_CAP_REACHED", "You've reached the preview limit for this return.");
    }

    const jobs = await scheduleAndRun(
      req,
      id,
      [{ skuId: target.id, size, transition: classifyTransition(source, target) }],
      "size_preview",
    );
    if (jobs.length === 0) {
      throw new ApiError(409, "RENDER_CAP_REACHED", "You've reached the preview limit for this return.");
    }
    return returnResponse(await requireReturn(id));
  });
}
