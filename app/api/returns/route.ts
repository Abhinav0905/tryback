import { getSku } from "@/lib/catalog";
import { CreateReturnBody } from "@/lib/apiSchemas";
import { ApiError, handle, json, orderForEmail, readJson } from "@/lib/apiRoute";
import { JSON_BODY_LIMIT, withBodyLimit } from "@/lib/bodyLimit";
import { ensureViewer } from "@/lib/live";
import { limitRequest, RATE_RULES } from "@/lib/ratelimit";
import { mutate, newId } from "@/lib/store";
import type { ReturnCase } from "@/lib/types";

// POST /api/returns { orderId, email, lineIndex } → 201 { return }
// Tags the return with this browser's viewer token (cookie tb_viewer), so /bench can show the
// shopper's own photo and renders to them without exposing everyone's to every visitor.
export async function POST(req: Request): Promise<Response> {
  const limited = limitRequest(req, RATE_RULES.createReturn);
  if (limited) return limited;
  return handle(async () => {
    const body = await readJson(withBodyLimit(req, JSON_BODY_LIMIT), CreateReturnBody);
    const order = orderForEmail(body.orderId, body.email);
    const line = order.lines[body.lineIndex];
    if (!line) throw new ApiError(400, "INVALID_LINE", "That item isn't part of this order.");
    if (!getSku(line.skuId)) throw new ApiError(422, "UNKNOWN_SKU", "That item is no longer in the catalogue.");

    const viewer = ensureViewer(req);
    const now = new Date().toISOString();
    const r: ReturnCase = {
      id: newId("ret"),
      orderId: order.id,
      lineIndex: body.lineIndex,
      skuId: line.skuId,
      size: line.size,
      price: line.price,
      status: "started",
      reason: null,
      fitComplaints: [],
      chips: [],
      freeText: "",
      consent: null,
      photo: null,
      photoSkipped: false,
      preflight: null,
      measurements: null,
      diagnosis: null,
      candidates: [],
      renders: [],
      timeline: {
        createdAt: now,
        reasonAt: null,
        photoAt: null,
        formSubmittedAt: null,
        firstCardAt: null,
        resolvedAt: null,
      },
      outcome: null,
      creditsSpent: 0,
      simulatedRenders: 0,
      viewerHash: viewer.hash,
    };
    await mutate((db) => {
      db.returns[r.id] = r;
    });
    return json({ return: r }, { status: 201, headers: viewer.setCookie ? { "Set-Cookie": viewer.setCookie } : {} });
  });
}
