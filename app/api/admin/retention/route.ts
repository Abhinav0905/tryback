// Admin-only retention controls (ADMIN_TOKEN as `Authorization: Bearer <token>` or `x-admin-token`).
//   GET  /api/admin/retention → RetentionStatus (policy, last sweep, pins, files on disk)
//   POST /api/admin/retention { action: "sweep", dryRun? }       → { ok, report }
//                             { action: "pin", returnId, note? } → { ok, pinned, totalPins }
//                             { action: "unpin", returnId }      → { ok, unpinned, totalPins }
//                             { action: "unpin_all" }            → { ok, unpinned, totalPins }
// Pins keep a consenting team member's renders past RENDER_RETENTION_DAYS so judges can replay
// them (docs/DEPLOY.md). Used by `npm run purge -- --base <url>`.
import { z } from "zod";
import { ApiError, assertSafeId, handle, json, readJson } from "@/lib/apiRoute";
import { withBodyLimit } from "@/lib/bodyLimit";
import { adminGate } from "@/lib/live";
import {
  pinReturnRenders,
  RetentionError,
  retentionStatus,
  sweepRetention,
  unpinRenders,
} from "@/lib/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sweep"), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("pin"), returnId: z.string().min(1).max(128), note: z.string().max(200).optional() }),
  z.object({ action: z.literal("unpin"), returnId: z.string().min(1).max(128) }),
  z.object({ action: z.literal("unpin_all") }),
]);

function unauthorized(): Response {
  return json(
    { error: { code: "ADMIN_TOKEN_REQUIRED", message: "This endpoint needs the ADMIN_TOKEN (Authorization: Bearer <token>)." } },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="tryback-admin"' } },
  );
}

function mapRetentionError(err: unknown): never {
  if (err instanceof RetentionError) throw new ApiError(err.status, err.code, err.message);
  throw err;
}

export async function GET(req: Request): Promise<Response> {
  const gate = adminGate(req);
  if (gate instanceof Response) return gate;
  if (gate !== "admin") return unauthorized();
  return handle(async () => json(await retentionStatus()));
}

export async function POST(req: Request): Promise<Response> {
  const gate = adminGate(req);
  if (gate instanceof Response) return gate;
  if (gate !== "admin") return unauthorized();
  return handle(async () => {
    const body = await readJson(withBodyLimit(req, 4096), Body, { maxBytes: 4096 });
    switch (body.action) {
      case "sweep":
        return json({ ok: true, report: await sweepRetention({ dryRun: body.dryRun ?? false }) });
      case "pin": {
        const res = await pinReturnRenders(assertSafeId(body.returnId, "return id"), body.note).catch(mapRetentionError);
        return json({ ok: true, ...res });
      }
      case "unpin":
        return json({ ok: true, ...(await unpinRenders({ returnId: assertSafeId(body.returnId, "return id") })) });
      case "unpin_all":
        return json({ ok: true, ...(await unpinRenders({ all: true })) });
    }
  });
}
