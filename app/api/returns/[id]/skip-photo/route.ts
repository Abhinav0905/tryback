import { ApiError, assertNotResolved, handle, returnResponse, updateReturnOr404, assertSafeId } from "@/lib/apiRoute";

// POST /api/returns/[id]/skip-photo → { return }   (photoSkipped = true; no renders, 0 credits)
export async function POST(_req: Request, ctx: RouteContext<"/api/returns/[id]/skip-photo">): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    assertSafeId(id, "return id");
    const updated = await updateReturnOr404(id, (r) => {
      assertNotResolved(r);
      if (r.photo) throw new ApiError(409, "PHOTO_ALREADY_UPLOADED", "A photo is already on file for this return.");
      r.photoSkipped = true;
    });
    return returnResponse(updated);
  });
}
