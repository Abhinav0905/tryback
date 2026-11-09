import { errorResponse, isSafeId } from "@/lib/apiRoute";
import { readPhoto } from "@/lib/store";

export const runtime = "nodejs";

// GET /api/photos/[id] → the shopper's photo (JPEG). Never cached anywhere.
export async function GET(_req: Request, ctx: RouteContext<"/api/photos/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isSafeId(id)) return errorResponse(400, "INVALID_ID", "That photo id isn't valid.");
    const bytes = await readPhoto(id);
    if (!bytes) return errorResponse(404, "PHOTO_NOT_FOUND", "That photo is no longer available.");
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err) {
    console.error("[api/photos] failed", err);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong on our side. Please try again.");
  }
}
