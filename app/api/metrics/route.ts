// GET /api/metrics?seeded=1|0 → MerchantMetrics (default seeded=1, never cached).
// Seeded demo history is generated in memory (deterministic, anchored to the start of the
// current UTC day) and is never written to the store, so a reset can't touch it and real
// returns are never mixed into it.
import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "@/lib/config";
import { computeMetrics } from "@/lib/metrics";
import { seedAnchorFor, seededReturns } from "@/lib/seed";
import { readDb } from "@/lib/store";
import type { ReturnCase } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  seeded: z.enum(["0", "1", "true", "false"]).optional(),
  simulated: z.enum(["0", "1", "true", "false"]).optional(),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

let seedCache: { day: string; returns: ReturnCase[] } | null = null;

function seededFor(now: Date): ReturnCase[] {
  const anchor = seedAnchorFor(now);
  const day = anchor.toISOString();
  if (seedCache?.day !== day) seedCache = { day, returns: seededReturns({ endAt: anchor }) };
  return seedCache.returns;
}

function opaqueId(id: string): string {
  return `r_${createHash("sha256").update(`tryback-recent\n${id}`).digest("hex").slice(0, 16)}`;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return errorResponse(400, "INVALID_QUERY", "seeded and simulated must be 1 or 0.");
  }
  const includeSeeded = parsed.data.seeded === undefined || parsed.data.seeded === "1" || parsed.data.seeded === "true";
  const includeSimulated = parsed.data.simulated === "1" || parsed.data.simulated === "true";

  try {
    const now = new Date();
    const db = await readDb();
    const live = Object.values(db.returns);
    const liveIds = new Set(live.map((r) => r.id));
    const history = includeSeeded ? seededFor(now).filter((r) => !liveIds.has(r.id)) : [];
    const metrics = computeMetrics([...history, ...live], {
      includeSeeded,
      includeSimulated,
      creditUsd: config.creditUsd,
      now,
    });
    // Return ids are capabilities (GET /api/returns/<id> exposes the photo): the public
    // dashboard only gets a stable opaque id per return for its "fresh row" highlighting.
    const recent = metrics.recent.map((r) => ({ ...r, id: opaqueId(r.id) }));
    return Response.json({ ...metrics, recent }, { headers: NO_STORE });
  } catch (err) {
    console.error("[api/metrics] failed", err);
    return errorResponse(500, "METRICS_FAILED", "Could not compute metrics.");
  }
}
