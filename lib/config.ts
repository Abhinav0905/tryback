// Server-side configuration (env). Do not import from client components.
import type { TryOnMode } from "./types";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  get clothsyApiKey(): string | null {
    return process.env.CLOTHSY_API_KEY?.trim() || null;
  },
  get clothsyApiBase(): string {
    return (process.env.CLOTHSY_API_BASE ?? "https://api.clothsyai.fabricvton.com/api/v1").replace(/\/$/, "");
  },
  /** auto: live if a Clothsy key exists, else dev. live: require key. dev: always simulated. replay: cache only, misses fall back to dev. */
  get tryOnMode(): TryOnMode {
    const m = (process.env.TRYON_MODE ?? "auto").toLowerCase();
    return m === "live" || m === "dev" || m === "replay" ? m : "auto";
  },
  get dailyLiveRenderCap(): number {
    return int("DAILY_LIVE_RENDER_CAP", 40);
  },
  get maxRendersPerReturn(): number {
    return int("MAX_RENDERS_PER_RETURN", 5);
  },
  /** If set, live renders are only allowed for sessions carrying cookie tb_live=<code>. */
  get liveAccessCode(): string | null {
    return process.env.LIVE_ACCESS_CODE?.trim() || null;
  },
  get anthropicConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  },
  get diagnosisModel(): string {
    return process.env.DIAGNOSIS_MODEL?.trim() || "claude-opus-5-5";
  },
  /** USD per Clothsy credit, for the unit-economics panel. */
  get creditUsd(): number {
    return num("CREDIT_USD", 0.08);
  },
  /** Mean simulated latency of the dev double. */
  get devRenderLatencyMs(): number {
    return int("DEV_RENDER_LATENCY_MS", 6000);
  },
  /** 0..1 probability that a dev render fails (to exercise error states). */
  get devFailRate(): number {
    return num("DEV_FAIL_RATE", 0);
  },
  /**
   * Bearer token for admin-only operations (full demo wipe, retention sweep/pins).
   * Null when unset: then nobody can run them over HTTP.
   */
  get adminToken(): string | null {
    return process.env.ADMIN_TOKEN?.trim() || null;
  },
  /**
   * Production servers without LIVE_ACCESS_CODE treat everyone as replay unless this is "1",
   * so a public URL with a Clothsy key can't be used to drain credits by accident.
   */
  get allowPublicLive(): boolean {
    return process.env.ALLOW_PUBLIC_LIVE === "1" || process.env.ALLOW_PUBLIC_LIVE === "true";
  },
  /** Hours a shopper photo is kept (default and maximum: what the consent copy promises). */
  get photoRetentionHours(): number {
    return retention("PHOTO_RETENTION_HOURS", PROMISED_PHOTO_RETENTION_HOURS);
  },
  /** Days a cached render is kept (default and maximum: what the consent copy promises). Pinned renders are exempt. */
  get renderRetentionDays(): number {
    return retention("RENDER_RETENTION_DAYS", PROMISED_RENDER_RETENTION_DAYS);
  },
};

/**
 * Retention promised to shoppers in the consent and done-screen copy. The env vars can only
 * shorten it; a longer value is clamped (and logged at boot) so the copy never overstates deletion.
 */
export const PROMISED_PHOTO_RETENTION_HOURS = 24;
export const PROMISED_RENDER_RETENTION_DAYS = 14;

function retention(name: string, max: number): number {
  const n = num(name, max);
  return n > 0 ? Math.min(n, max) : max;
}

/** Bumped when the provider/preprocessing changes so cached renders are not reused across versions. */
export const RENDER_PIPELINE_VERSION = "clothsy-v1.p1";

export const LIVE_COOKIE = "tb_live";
