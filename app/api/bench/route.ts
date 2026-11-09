// GET /api/bench → { items: BenchItem[] }: every successful render of a non-seeded return,
// newest first, with what the in-browser gate needs to re-run (photo URL + measurements).
//
// Privacy: renders and photos show real people. Stats (transition, latency, gate verdict) are
// public, but the photo URL, render URL, return id, cache key and measurements are only sent
// for returns this browser created (cookie tb_viewer) or to LIVE_ACCESS_CODE holders.
import { isAccessCodeHolder, viewerHashOf, viewerToken } from "@/lib/live";
import type { BenchItem } from "@/lib/metrics";
import { readDb } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", Vary: "Cookie" } as const;

export async function GET(req: Request): Promise<Response> {
  try {
    const db = await readDb();
    const admin = isAccessCodeHolder(req);
    const token = viewerToken(req);
    const viewerHash = token ? viewerHashOf(token) : null;
    const items: BenchItem[] = [];
    for (const r of Object.values(db.returns)) {
      if (r.seeded) continue;
      const visible = admin || (viewerHash !== null && r.viewerHash === viewerHash);
      for (const job of r.renders ?? []) {
        if (job.status !== "success" || !job.resultUrl) continue;
        items.push(
          visible
            ? { job, returnId: r.id, photoUrl: r.photo?.url ?? null, sourceSkuId: r.skuId, measurements: r.measurements ?? null }
            : {
                job: { ...job, returnId: "", cacheKey: "", resultUrl: null, externalId: null },
                returnId: "",
                photoUrl: null,
                sourceSkuId: r.skuId,
                measurements: null,
              },
        );
      }
    }
    items.sort((a, b) => (Date.parse(b.job.finishedAt ?? "") || 0) - (Date.parse(a.job.finishedAt ?? "") || 0));
    return Response.json({ items }, { headers: NO_STORE });
  } catch (err) {
    console.error("[api/bench] failed", err);
    return Response.json(
      { error: { code: "BENCH_FAILED", message: "Could not load benchmark renders." } },
      { status: 500, headers: NO_STORE },
    );
  }
}
