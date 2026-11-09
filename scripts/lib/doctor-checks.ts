// Pure parts of `npm run doctor`: each check turns gathered facts into PASS/WARN/FAIL with a
// fix hint, and summarize() decides readiness. All I/O lives in scripts/doctor.ts.
// Unit-tested in tests/doctor.test.ts.

import Anthropic from "@anthropic-ai/sdk";
import { decideProvider, type ProviderReason } from "../../lib/tryon";
import type { ClothsyAccountResult } from "../../lib/tryon/clothsy";
import type { TryOnMode } from "../../lib/types";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a WARN or FAIL. */
  fix: string | null;
}

export interface DoctorSummary {
  /** No FAIL: the server would make live Clothsy renders and the probe can run. */
  ready: boolean;
  exitCode: 0 | 1;
  pass: number;
  warn: number;
  fail: number;
  failures: Check[];
  warnings: Check[];
}

export const CLOTHSY_KEYS_URL = "https://app.clothsyai.fabricvton.com/api-keys";
export const MIN_NODE = [20, 9, 0] as const;
export const LOW_CREDITS = 5;

const check = (id: string, label: string, status: CheckStatus, detail: string, fix: string | null = null): Check => ({
  id,
  label,
  status,
  detail,
  fix: status === "PASS" ? null : fix,
});

export function summarize(checks: Check[]): DoctorSummary {
  const failures = checks.filter((c) => c.status === "FAIL");
  const warnings = checks.filter((c) => c.status === "WARN");
  return {
    ready: failures.length === 0,
    exitCode: failures.length === 0 ? 0 : 1,
    pass: checks.filter((c) => c.status === "PASS").length,
    warn: warnings.length,
    fail: failures.length,
    failures,
    warnings,
  };
}

/** `clothsy_live_abc…wxyz` → `clothsy_live_…wxyz` (never print a secret). */
export function maskSecret(value: string): string {
  const v = value.trim();
  const prefix = /^(clothsy_live_|clothsy_test_|sk-ant-[a-z0-9]+-|sk-ant-)/i.exec(v)?.[0] ?? "";
  if (v.length <= prefix.length + 8) return `${prefix}…`;
  return `${prefix}…${v.slice(-4)}`;
}

/* ───────────────────────── environment ───────────────────────── */

export function checkNode(version: string): Check {
  const parts = version.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  let ok = true;
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = MIN_NODE[i]!;
    if (a !== b) {
      ok = a > b;
      break;
    }
  }
  return check(
    "node",
    "Node.js version",
    ok ? "PASS" : "FAIL",
    `v${version.replace(/^v/, "")} (needs ≥ ${MIN_NODE.join(".")})`,
    "Install Node 20.9+ (https://nodejs.org) and run npm i again.",
  );
}

export function checkEnvFile(p: { present: boolean; exampleExists: boolean; files: string[] }): Check {
  return check(
    "env-file",
    ".env.local",
    p.present ? "PASS" : "WARN",
    p.present ? `found (loaded: ${p.files.join(", ")}; variables already in the environment win)` : "not found; only the process environment is used",
    p.exampleExists ? "cp .env.example .env.local, then fill in the keys." : "Create .env.local with CLOTHSY_API_KEY=… and TRYON_MODE=auto.",
  );
}

const REASON_TEXT: Record<ProviderReason, string> = {
  live: "Live · Clothsy try-on",
  mode_dev: "dev double (TRYON_MODE=dev)",
  replay: "replay (cache only, misses → dev double)",
  no_key: "dev double (no CLOTHSY_API_KEY)",
  daily_cap: "dev double (DAILY_LIVE_RENDER_CAP reached today)",
};

export function checkMode(p: {
  rawMode: string | undefined;
  mode: TryOnMode;
  hasKey: boolean;
  liveAccessCode: string | null;
  liveToday: number;
  dailyCap: number;
}): Check {
  const unlocked = decideProvider({ mode: p.mode, allowLive: true, hasKey: p.hasKey, liveCount: p.liveToday, dailyCap: p.dailyCap });
  const visitor = decideProvider({
    mode: p.mode,
    allowLive: !p.liveAccessCode,
    hasKey: p.hasKey,
    liveCount: p.liveToday,
    dailyCap: p.dailyCap,
  });
  const raw = (p.rawMode ?? "").trim();
  const unknownRaw = raw !== "" && !["auto", "live", "dev", "replay"].includes(raw.toLowerCase());
  const detail =
    `TRYON_MODE=${raw || "(unset → auto)"}${unknownRaw ? " (unknown value, treated as auto)" : ""} · ` +
    (p.liveAccessCode
      ? `unlocked browser → ${REASON_TEXT[unlocked.reason]} · public visitor → ${REASON_TEXT[visitor.reason]}`
      : `every browser → ${REASON_TEXT[unlocked.reason]}`);
  switch (unlocked.reason) {
    case "live":
      return check("mode", "Provider the server would use", unknownRaw ? "WARN" : "PASS", detail, "Set TRYON_MODE=auto (or live).");
    case "mode_dev":
      return check("mode", "Provider the server would use", "FAIL", detail, "Set TRYON_MODE=auto in .env.local (dev always simulates).");
    case "replay":
      return check(
        "mode",
        "Provider the server would use",
        "WARN",
        detail,
        "Replay mode never spends credits (right for a public judging link). For live renders set TRYON_MODE=auto.",
      );
    case "no_key":
      return check("mode", "Provider the server would use", "WARN", detail, "Add CLOTHSY_API_KEY (see the Clothsy key line).");
    case "daily_cap":
      return check(
        "mode",
        "Provider the server would use",
        "WARN",
        `${detail} · ${p.liveToday}/${p.dailyCap} live renders today (UTC)`,
        "Raise DAILY_LIVE_RENDER_CAP or wait for the next UTC day.",
      );
  }
}

/* ───────────────────────── Clothsy ───────────────────────── */

export function checkClothsyKey(p: { key: string | null; publicLeaks: string[] }): Check {
  if (p.publicLeaks.length > 0) {
    return check(
      "clothsy-key",
      "CLOTHSY_API_KEY",
      "FAIL",
      `exposed to the browser via ${p.publicLeaks.join(", ")}`,
      "Remove the NEXT_PUBLIC_ variable: Next.js inlines NEXT_PUBLIC_* into client code, so anyone could spend your credits.",
    );
  }
  if (!p.key) {
    return check(
      "clothsy-key",
      "CLOTHSY_API_KEY",
      "FAIL",
      "not set: every render is simulated",
      `Sign in with Google at ${CLOTHSY_KEYS_URL} → Developer API → Create API key (starts clothsy_live_, shown once; 20 free credits), then add CLOTHSY_API_KEY=clothsy_live_… to .env.local.`,
    );
  }
  const looksRight = /^clothsy_live_[A-Za-z0-9_-]{8,}$/.test(p.key.trim());
  return check(
    "clothsy-key",
    "CLOTHSY_API_KEY",
    looksRight ? "PASS" : "WARN",
    `set (${maskSecret(p.key)})${looksRight ? "" : "; documented keys start with clothsy_live_"}`,
    "Copy the whole key again: no quotes, no spaces, starting clothsy_live_.",
  );
}

/** GET /account outcome → check. `null` = not called (no key). */
export function checkClothsyAccount(result: ClothsyAccountResult | null): Check {
  const label = "Clothsy account (GET /account, 0 credits)";
  if (!result || (!result.ok && result.code === "NO_API_KEY")) {
    return check("clothsy-account", label, "FAIL", "not checked: no key", "Add CLOTHSY_API_KEY first.");
  }
  if (result.ok) {
    if (result.credits === null) {
      return check(
        "clothsy-account",
        label,
        "WARN",
        `HTTP ${result.httpStatus}, but no numeric credits field (docs: { credits, scope })`,
        "Run the probe: probe/REPORT.md records the actual shape. The probe refuses to run without a credits number unless you pass --skip-credit-check.",
      );
    }
    const scope = result.scope ? `, scope ${result.scope}` : "";
    if (result.credits <= 0) {
      return check(
        "clothsy-account",
        label,
        "FAIL",
        `key valid, 0 credits left${scope}`,
        "Out of credits: email contact@fabricvton.com to buy more (docs: Account → 'To buy more credits, email us').",
      );
    }
    return check(
      "clothsy-account",
      label,
      result.credits < LOW_CREDITS ? "WARN" : "PASS",
      `key valid, ${result.credits} credit(s) left${scope} (${result.latencyMs} ms)`,
      `Fewer than ${LOW_CREDITS} credits: keep the probe to --max-credits ${Math.max(1, result.credits - 1)} and save the rest for the demo take.`,
    );
  }
  const where = result.httpStatus ? `HTTP ${result.httpStatus} ` : "";
  switch (result.code) {
    case "INVALID_API_KEY":
      return check(
        "clothsy-account",
        label,
        "FAIL",
        `${where}INVALID_API_KEY: the key is missing, malformed or revoked`,
        `Copy the key again (it is shown once) or create a new one at ${CLOTHSY_KEYS_URL}; only one key per account is active.`,
      );
    case "NETWORK_ERROR": {
      const tls = /certificate|issuer|self[- ]signed|SSL|TLS/i.test(result.message);
      return check(
        "clothsy-account",
        label,
        "FAIL",
        `could not reach the API: ${result.message}`,
        tls
          ? "Company proxy/CA: start with NODE_EXTRA_CA_CERTS=/path/to/company-root.pem npm run doctor (and the same for npm run dev)."
          : "Check the network and CLOTHSY_API_BASE (default https://api.clothsyai.fabricvton.com/api/v1), then retry.",
      );
    }
    case "RATE_LIMITED":
    case "INTERNAL_ERROR":
    case "UNAVAILABLE":
    case "START_FAILED":
    case "BAD_RESPONSE":
      return check("clothsy-account", label, "WARN", `${where}${result.code}: ${result.message}`, "Temporary on Clothsy's side: retry in a minute.");
    default:
      return check("clothsy-account", label, "FAIL", `${where}${result.code}: ${result.message}`, "Check CLOTHSY_API_BASE and the key.");
  }
}

/* ───────────────────────── Anthropic ───────────────────────── */

export type AnthropicProbe =
  | { kind: "absent" }
  | { kind: "ok"; modelId: string; displayName: string | null; latencyMs: number }
  | { kind: "error"; error: unknown };

/**
 * Validate the Anthropic key without generating tokens: GET /v1/models/{model} (Models API,
 * documented in the claude-api skill as `client.models.retrieve(id)`). Lives here so the error
 * classes used by classifyAnthropicError come from the same SDK module instance.
 */
export async function probeAnthropic(model: string, opts: { timeoutMs?: number } = {}): Promise<AnthropicProbe> {
  const t0 = Date.now();
  try {
    const client = new Anthropic({ maxRetries: 0, timeout: opts.timeoutMs ?? 10_000 });
    const info = await client.models.retrieve(model);
    return { kind: "ok", modelId: info.id, displayName: info.display_name ?? null, latencyMs: Date.now() - t0 };
  } catch (error) {
    return { kind: "error", error };
  }
}

function isA(err: unknown, ctor: unknown): boolean {
  return typeof ctor === "function" && err instanceof (ctor as abstract new (...args: never[]) => unknown);
}

/** SDK error → what it means for the key (most specific class first, per the claude-api skill). */
export function classifyAnthropicError(err: unknown): "auth" | "permission" | "not_found" | "rate_limit" | "server" | "connection" | "other" {
  if (isA(err, Anthropic.AuthenticationError)) return "auth";
  if (isA(err, Anthropic.PermissionDeniedError)) return "permission";
  if (isA(err, Anthropic.NotFoundError)) return "not_found";
  if (isA(err, Anthropic.RateLimitError)) return "rate_limit";
  if (isA(err, Anthropic.InternalServerError)) return "server";
  if (isA(err, Anthropic.APIConnectionError)) return "connection";
  return "other";
}

export function checkAnthropic(probe: AnthropicProbe, model: string): Check {
  const label = "ANTHROPIC_API_KEY (optional)";
  if (probe.kind === "absent") {
    return check("anthropic", label, "PASS", "not set: the keyword rules handle the form text (that's fine)", null);
  }
  if (probe.kind === "ok") {
    return check(
      "anthropic",
      label,
      "PASS",
      `key valid; ${model} is available${probe.displayName ? ` (${probe.displayName})` : ""}. Checked with GET /v1/models/${model}, 0 tokens (${probe.latencyMs} ms)`,
    );
  }
  const kind = classifyAnthropicError(probe.error);
  const msg = probe.error instanceof Error ? probe.error.message.slice(0, 160) : String(probe.error);
  switch (kind) {
    case "auth":
      return check("anthropic", label, "FAIL", `401: the key is invalid (${msg})`, "Fix ANTHROPIC_API_KEY or delete the line: without it diagnosis uses rules.");
    case "permission":
      return check("anthropic", label, "FAIL", `403: this key can't use ${model} (${msg})`, "Use a key from a workspace with model access, or remove it.");
    case "not_found":
      return check("anthropic", label, "FAIL", `404: model ${model} not found or not available to this key`, "Set DIAGNOSIS_MODEL=claude-opus-5-5 (or remove the line).");
    case "connection": {
      const tls = /certificate|issuer|self[- ]signed|SSL|TLS/i.test(msg);
      return check(
        "anthropic",
        label,
        "WARN",
        `could not reach the API (${msg})`,
        tls ? "Company proxy/CA: start with NODE_EXTRA_CA_CERTS=/path/to/company-root.pem." : "Check the network; diagnosis falls back to rules meanwhile.",
      );
    }
    case "rate_limit":
    case "server":
      return check("anthropic", label, "WARN", `temporary API error (${msg})`, "Retry later; diagnosis falls back to rules meanwhile.");
    default:
      return check("anthropic", label, "WARN", `unexpected error (${msg})`, "Diagnosis falls back to rules if Claude can't be called.");
  }
}

export function checkDiagnosisModel(p: { raw: string | undefined; model: string; anthropicConfigured: boolean }): Check {
  const custom = Boolean(p.raw?.trim());
  const plausible = /^claude-[a-z0-9.-]+$/.test(p.model);
  return check(
    "diagnosis-model",
    "DIAGNOSIS_MODEL",
    plausible ? "PASS" : "WARN",
    `${p.model}${custom ? "" : " (default)"}${p.anthropicConfigured ? "" : "; unused without ANTHROPIC_API_KEY"}`,
    "Use an exact model id such as claude-opus-5-5.",
  );
}

/* ───────────────────────── files & tools ───────────────────────── */

export interface CatalogRow {
  file: string;
  exists: boolean;
  drawing: boolean;
  width: number | null;
  height: number | null;
  /** Prepared JPEG size from lib/tryon/garment.ts, or null when preparation failed. */
  preparedBytes: number | null;
  error: string | null;
}

export function checkCatalog(rows: CatalogRow[], maxBytes: number): Check {
  const label = "Catalogue images (public/catalog)";
  const missing = rows.filter((r) => !r.exists);
  const broken = rows.filter((r) => r.exists && (r.error || r.preparedBytes === null || r.preparedBytes > maxBytes));
  const drawings = rows.filter((r) => r.exists && r.drawing);
  const photos = rows.filter((r) => r.exists && !r.drawing);
  const small = photos.filter((r) => r.width !== null && r.height !== null && Math.min(r.width, r.height) < 600);
  const list = (rs: CatalogRow[]) => rs.slice(0, 4).map((r) => r.file).join(", ") + (rs.length > 4 ? `, +${rs.length - 4} more` : "");
  const counts = `${rows.length} image(s): ${photos.length} photo(s), ${drawings.length} generated drawing(s)`;
  if (missing.length || broken.length) {
    return check(
      "catalog",
      label,
      "FAIL",
      `${counts}; ${missing.length ? `missing: ${list(missing)}` : ""}${missing.length && broken.length ? "; " : ""}${broken.length ? `unusable: ${list(broken)} (${broken[0]!.error ?? "over 4 MB after encoding"})` : ""}`,
      'Run "npm run assets" to restore missing placeholders (it never overwrites), or replace the file with a JPEG/PNG photo.',
    );
  }
  if (drawings.length) {
    return check(
      "catalog",
      label,
      "WARN",
      `${counts} (e.g. ${list(drawings)}). Every image encodes under 4 MB`,
      "Photograph one real garment per drawn family (hanger or flat lay, plain background), save it as assets-src/catalog/raw/<family>/<name>.jpg, set that family to \"photo\" in assets-src/catalog/manifest.json and run npm run catalog:import -- --only <family> (it makes every colourway). Or drop finished photos into public/catalog under the same file name; npm run assets never overwrites them.",
    );
  }
  if (small.length) {
    return check("catalog", label, "WARN", `${counts}; low resolution: ${list(small)}`, "Use photos at least 600 px on the short side.");
  }
  return check("catalog", label, "PASS", `${counts}; all encode under 4 MB for upload`);
}

export function checkMediaPipe(files: { path: string; bytes: number | null }[]): Check {
  const missing = files.filter((f) => !f.bytes);
  return check(
    "mediapipe",
    "MediaPipe model + WASM files",
    missing.length ? "FAIL" : "PASS",
    missing.length ? `missing: ${missing.map((f) => f.path).join(", ")}` : `${files.length} file(s) present`,
    "Restore public/models and public/mediapipe from the repo (git checkout -- public/models public/mediapipe).",
  );
}

export function checkDataDir(p: { dir: string; exists: boolean; writable: boolean; error: string | null }): Check {
  return check(
    "data-dir",
    "Data dir (TRYBACK_DATA_DIR)",
    p.writable ? "PASS" : "FAIL",
    `${p.dir} ${p.exists ? (p.writable ? "is writable" : "is NOT writable") : p.writable ? "will be created (parent writable)" : "can't be created"}${p.error ? ` (${p.error})` : ""}. Deploy on one server with a persistent disk`,
    "Point TRYBACK_DATA_DIR at a writable folder on a persistent disk.",
  );
}

export function checkCaps(p: {
  dailyCap: number;
  maxPerReturn: number;
  rawDaily: string | undefined;
  rawMax: string | undefined;
  credits: number | null;
  liveToday: number;
}): Check {
  const notes: string[] = [];
  let status: CheckStatus = "PASS";
  const fixes: string[] = [];
  const badInt = (raw: string | undefined) => raw !== undefined && raw.trim() !== "" && !/^\d+$/.test(raw.trim());
  if (badInt(p.rawDaily) || badInt(p.rawMax)) {
    status = "WARN";
    notes.push("a non-integer value is ignored (default used)");
    fixes.push("Use whole numbers.");
  }
  if (p.maxPerReturn < 1) {
    status = "WARN";
    notes.push("MAX_RENDERS_PER_RETURN < 1 means no live renders");
    fixes.push("Set MAX_RENDERS_PER_RETURN=5.");
  } else if (p.maxPerReturn > 5) {
    status = "WARN";
    notes.push(`MAX_RENDERS_PER_RETURN=${p.maxPerReturn} is above the 5 the credit plan assumes`);
    fixes.push("Keep MAX_RENDERS_PER_RETURN=5 (2 speculative + 2 post-form + 1 gate retry).");
  }
  if (p.credits !== null && p.dailyCap > p.credits) {
    // FAIL, not WARN: the cap is the only thing that keeps the last credits for the demo take and
    // the judges' pre-warm (README → Credit budget plan); the deployed server needs the same value.
    status = "FAIL";
    notes.push(`the daily cap (${p.dailyCap}) is above the credits left (${p.credits}), so the account runs dry before the cap falls back to the dev double`);
    fixes.push(
      `Set DAILY_LIVE_RENDER_CAP=${Math.max(0, p.credits - 2)} in .env.local (keeps a small reserve), and at most the credits left on your deployment (fly.toml / render.yaml).`,
    );
  }
  return check(
    "caps",
    "Credit caps",
    status,
    `DAILY_LIVE_RENDER_CAP=${p.dailyCap} (${p.liveToday} used today, UTC) · MAX_RENDERS_PER_RETURN=${p.maxPerReturn}${notes.length ? ` · ${notes.join("; ")}` : ""}`,
    fixes.join(" "),
  );
}

export function checkLiveAccess(p: { hasKey: boolean; mode: TryOnMode; code: string | null }): Check {
  const label = "LIVE_ACCESS_CODE";
  const liveCapable = p.hasKey && p.mode !== "dev" && p.mode !== "replay";
  if (!p.code) {
    return check(
      label.toLowerCase(),
      label,
      liveCapable ? "WARN" : "PASS",
      liveCapable ? "not set: on a public URL every visitor would spend your credits" : "not set (no live renders in this configuration)",
      "Set LIVE_ACCESS_CODE=<a long random code> before deploying; share it only with judges. Locally it's fine.",
    );
  }
  const weak = p.code.length < 8;
  return check(
    label.toLowerCase(),
    label,
    weak ? "WARN" : "PASS",
    `set (${p.code.length} chars): only browsers that unlocked it spend credits; everyone else gets replay`,
    "Use at least 8 random characters.",
  );
}

export function checkTool(p: { id: string; name: string; found: string | null; purpose: string; fix: string }): Check {
  return check(p.id, p.name, p.found ? "PASS" : "WARN", p.found ? `found: ${p.found}` : `not found (only needed for ${p.purpose})`, p.fix);
}

export function checkProbeInputs(p: { dir: string; exists: boolean; usable: number; other: number }): Check {
  const label = "Probe photos (probe/people)";
  if (p.usable >= 3) {
    return check("probe-people", label, "PASS", `${p.usable} JPEG/PNG photo(s) in ${p.dir}${p.other ? `, ${p.other} other file(s) ignored` : ""}`);
  }
  return check(
    "probe-people",
    label,
    "WARN",
    p.exists ? `${p.usable} JPEG/PNG photo(s) in ${p.dir}` : `${p.dir} does not exist yet`,
    `mkdir -p ${p.dir} and add 3 full-body, front-facing JPEG photos of consenting adults (≥600 px short side; the folder is gitignored). Three people × two SKUs gives the 6 renders npm run tune -- --apply needs.`,
  );
}

/* ───────────────────────── output ───────────────────────── */

const COLORS: Record<CheckStatus, string> = { PASS: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m" };

export function formatChecklist(checks: Check[], summary: DoctorSummary, opts: { color: boolean; nextCommand: string; nextNote?: string }): string {
  const tag = (s: CheckStatus) => (opts.color ? `${COLORS[s]}${s}\x1b[0m` : s);
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines: string[] = ["TryBack doctor: is this machine ready for live Clothsy renders?", ""];
  for (const c of checks) {
    lines.push(`${tag(c.status)}  ${c.label.padEnd(width)}  ${c.detail}`);
    if (c.fix) lines.push(`${" ".repeat(6 + width)}  → ${c.fix}`);
  }
  lines.push("", `${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail`);
  if (summary.failures.length) {
    lines.push("", "Not ready for live because:");
    for (const f of summary.failures) lines.push(`  - ${f.label}: ${f.detail}`);
  }
  if (summary.warnings.length) {
    lines.push("", "Warnings (don't block, but read them):");
    for (const w of summary.warnings) lines.push(`  - ${w.label}: ${w.fix ?? w.detail}`);
  }
  lines.push(
    "",
    summary.ready
      ? `Ready for live. Next: ${opts.nextCommand}`
      : "Not ready for live. Fix the FAIL lines above, then run npm run doctor again.",
  );
  if (summary.ready && opts.nextNote) lines.push(opts.nextNote);
  return lines.join("\n");
}
