// POST /api/admin/reset → deletes non-seeded returns and their photos.
//   · With ADMIN_TOKEN (Authorization: Bearer <token> or x-admin-token): every non-seeded return.
//   · Without a token: only the returns this browser created (cookie tb_viewer), so the public
//     /demo "Reset demo" button resets each visitor's own demo without touching anyone else's.
//   · A wrong token is a 401 (never silently downgraded), rate-limited like code guesses.
// The render cache (renderIndex + RENDERS_DIR) and the daily live-render counter are kept:
// renders are content-addressed, so re-running the demo with the same photo costs 0 credits.
// (Retention still deletes them after RENDER_RETENTION_DAYS; see lib/retention.ts.)
import { adminGate, viewerHashFromRequest } from "@/lib/live";
import { deletePhoto, mutate } from "@/lib/store";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: Request): Promise<Response> {
  const gate = adminGate(req);
  if (gate instanceof Response) return gate;
  const scope = gate === "admin" ? "all" : "viewer";
  const viewerHash = scope === "viewer" ? viewerHashFromRequest(req) : null;

  try {
    const { removed, keptRenders } = await mutate((db) => {
      const ids = Object.values(db.returns)
        .filter((r) => !r.seeded && (scope === "all" || (viewerHash !== null && r.viewerHash === viewerHash)))
        .map((r) => r.id);
      for (const id of ids) delete db.returns[id];
      return { removed: ids, keptRenders: Object.keys(db.renderIndex).length };
    });

    // Photo deletion happens outside the store lock (never nest store calls).
    const results = await Promise.allSettled(removed.map((id) => deletePhoto(id)));
    const photoErrors = results.filter((r) => r.status === "rejected").length;
    if (photoErrors > 0) console.warn(`[api/admin/reset] ${photoErrors} photo(s) could not be deleted`);

    return Response.json(
      {
        ok: true,
        scope,
        deletedReturns: removed.length,
        photoErrors,
        keptRenders,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[api/admin/reset] failed", err);
    return Response.json(
      { error: { code: "RESET_FAILED", message: "Could not reset the demo data." } },
      { status: 500, headers: NO_STORE },
    );
  }
}
