import { getSku } from "@/lib/catalog";
import { OrderQuery } from "@/lib/apiSchemas";
import { assertSafeId, handle, json, orderForEmail, parseWith } from "@/lib/apiRoute";
import type { Sku } from "@/lib/types";

// GET /api/orders/[orderId]?email=  → { order, skus }
// 404 when the order doesn't exist or the email doesn't match (case-insensitive). email=demo works for demo orders.
export async function GET(req: Request, ctx: RouteContext<"/api/orders/[orderId]">): Promise<Response> {
  return handle(async () => {
    const { orderId } = await ctx.params;
    assertSafeId(orderId.replace(/^#/, ""), "order number");
    const { email } = parseWith(OrderQuery, { email: new URL(req.url).searchParams.get("email") ?? "" });
    const order = orderForEmail(orderId, email);
    const skus: Sku[] = [];
    for (const line of order.lines) {
      const sku = getSku(line.skuId);
      if (sku && !skus.some((s) => s.id === sku.id)) skus.push(sku);
    }
    return json({ order, skus });
  });
}
