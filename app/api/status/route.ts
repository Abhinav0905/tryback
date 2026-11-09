import { after } from "next/server";
import { errorResponse, json } from "@/lib/apiRoute";
import { config } from "@/lib/config";
import { allowLiveFromRequest } from "@/lib/live";
import { retentionSweepDue, runScheduledSweep } from "@/lib/retention";
import { activeProviderName, liveRendersToday } from "@/lib/tryon";
import type { AppStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/status → AppStatus (which provider a new render from THIS session would use).
// Never exposes keys — only whether they are configured.
// Also the health-check path, so it doubles as a fallback trigger for the hourly retention
// sweep (normally started at boot by instrumentation.ts): when one is overdue, it runs after
// the response.
export async function GET(req: Request): Promise<Response> {
  try {
    const liveToday = await liveRendersToday(); // also primes the provider's daily-cap counter
    const allowLive = await allowLiveFromRequest(req);
    const status: AppStatus = {
      mode: config.tryOnMode,
      activeProvider: activeProviderName({ allowLive }),
      hasClothsyKey: config.clothsyApiKey !== null,
      hasAnthropicKey: config.anthropicConfigured,
      liveRendersToday: liveToday,
      dailyLiveCap: config.dailyLiveRenderCap,
      maxRendersPerReturn: config.maxRendersPerReturn,
    };
    if (retentionSweepDue()) after(() => runScheduledSweep());
    return json(status);
  } catch (err) {
    console.error("[api/status] failed", err);
    return errorResponse(500, "INTERNAL_ERROR", "Status is unavailable right now.");
  }
}
