import { EXCHANGE_BONUS_USD, getSku } from "@/lib/catalog";
import { ResolveBody } from "@/lib/apiSchemas";
import { ApiError, assertNotResolved, handle, readJson, requireReturn, returnResponse, updateReturnOr404 } from "@/lib/apiRoute";
import { JSON_BODY_LIMIT, withBodyLimit } from "@/lib/bodyLimit";
import type { ReturnOutcome } from "@/lib/types";

// POST /api/returns/[id]/resolve { type: 'exchange', skuId, size } | { type: 'refund' } → { return }
export async function POST(req: Request, ctx: RouteContext<"/api/returns/[id]/resolve">): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(withBodyLimit(req, JSON_BODY_LIMIT), ResolveBody);
    const current = await requireReturn(id);
    assertNotResolved(current);
    const at = new Date().toISOString();

    let outcome: ReturnOutcome;
    if (body.type === "exchange") {
      const target = getSku(body.skuId);
      if (!target) throw new ApiError(404, "SKU_NOT_FOUND", "We couldn't find that item.");
      if (target.id === current.skuId && body.size === current.size) {
        throw new ApiError(400, "SAME_ITEM", "That's the item you already have — pick a different size, colour or style.");
      }
      if ((target.inventory[body.size] ?? 0) <= 0) {
        throw new ApiError(409, "OUT_OF_STOCK", `${target.name} is out of stock in ${body.size}.`);
      }
      outcome = {
        type: "exchange",
        skuId: target.id,
        size: body.size,
        priceDiff: target.price - current.price,
        retainedRevenue: current.price,
        // The +$10 store credit promised on the photo offer and confirm screens.
        bonusCredit: EXCHANGE_BONUS_USD,
        at,
      };
    } else {
      outcome = { type: "refund", skuId: null, size: null, priceDiff: 0, retainedRevenue: 0, at };
    }

    const updated = await updateReturnOr404(id, (r) => {
      assertNotResolved(r);
      r.outcome = outcome;
      r.status = "resolved";
      r.timeline.resolvedAt = at;
      // Don't spend credits on previews nobody will see.
      for (const j of r.renders) {
        if (j.status === "queued") {
          j.status = "skipped";
          j.finishedAt = at;
        }
      }
    });
    return returnResponse(updated);
  });
}
