// Node.js server boot (called from instrumentation.ts): starts the hourly retention sweeper and
// logs configuration that makes a public deployment unsafe or broken. Server-only.

import { constants, promises as fs } from "node:fs";
import { config, PROMISED_PHOTO_RETENTION_HOURS, PROMISED_RENDER_RETENTION_DAYS } from "./config";
import { publicLiveAllowed } from "./live";
import { CLIENT_IP_SOURCES, clientIpSource } from "./ratelimit";
import { startRetentionSweeper } from "./retention";
import { DATA_DIR } from "./store";

/** Human-readable warnings about the current configuration (empty when all is well). */
export function configWarnings(): string[] {
  const out: string[] = [];
  const production = process.env.NODE_ENV === "production";
  if (config.clothsyApiKey && !config.liveAccessCode && config.tryOnMode !== "dev" && config.tryOnMode !== "replay") {
    if (!publicLiveAllowed()) {
      out.push(
        "CLOTHSY_API_KEY is set but LIVE_ACCESS_CODE isn't, so live renders are OFF for everyone on this production " +
          "server (treated as replay). Set LIVE_ACCESS_CODE (recommended) or ALLOW_PUBLIC_LIVE=1.",
      );
    } else if (production) {
      out.push(
        `ALLOW_PUBLIC_LIVE=1 without LIVE_ACCESS_CODE: anyone with the URL can spend credits (up to DAILY_LIVE_RENDER_CAP=${config.dailyLiveRenderCap}/day).`,
      );
    }
  }
  if (production && !config.adminToken) {
    out.push("ADMIN_TOKEN isn't set: full resets and /api/admin/retention are disabled (Reset demo still clears each visitor's own returns).");
  }
  if (config.adminToken && config.adminToken.length < 16) {
    out.push("ADMIN_TOKEN is shorter than 16 characters; use e.g. `openssl rand -hex 24`.");
  }
  const rawPhoto = Number.parseFloat(process.env.PHOTO_RETENTION_HOURS ?? "");
  if (rawPhoto > PROMISED_PHOTO_RETENTION_HOURS) {
    out.push(
      `PHOTO_RETENTION_HOURS=${rawPhoto} exceeds the ${PROMISED_PHOTO_RETENTION_HOURS} h promised in the consent copy; using ${config.photoRetentionHours}.`,
    );
  }
  const rawRender = Number.parseFloat(process.env.RENDER_RETENTION_DAYS ?? "");
  if (rawRender > PROMISED_RENDER_RETENTION_DAYS) {
    out.push(
      `RENDER_RETENTION_DAYS=${rawRender} exceeds the ${PROMISED_RENDER_RETENTION_DAYS} days promised in the consent copy; ` +
        `using ${config.renderRetentionDays}. Pin team renders instead (docs/DEPLOY.md).`,
    );
  }
  const ipHeader = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (ipHeader && !(CLIENT_IP_SOURCES as readonly string[]).includes(ipHeader)) {
    out.push(`CLIENT_IP_HEADER=${ipHeader} isn't one of ${CLIENT_IP_SOURCES.join(", ")}; using ${clientIpSource()}.`);
  }
  return out;
}

export async function bootNodeServer(): Promise<void> {
  // Data dir: the JSON store, photos and render cache. On a host it must be a persistent volume.
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(DATA_DIR, constants.W_OK);
    console.log(`[tryback] data dir ${DATA_DIR} · TRYON_MODE=${config.tryOnMode} · client IP from ${clientIpSource()}`);
  } catch (err) {
    console.warn(`[tryback] data dir ${DATA_DIR} is not writable: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const w of configWarnings()) console.warn(`[tryback] ${w}`);
  startRetentionSweeper();
}
