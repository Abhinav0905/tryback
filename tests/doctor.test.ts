// npm run doctor: pure check logic and aggregation (scripts/lib/doctor-checks.ts) and the
// shared .env loader (scripts/lib/env.ts). No network: account and model results are fed in.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { ClothsyAccountResult } from "@/lib/tryon/clothsy";
import {
  checkAnthropic,
  checkCaps,
  checkCatalog,
  checkClothsyAccount,
  checkClothsyKey,
  checkDataDir,
  checkDiagnosisModel,
  checkEnvFile,
  checkLiveAccess,
  checkMediaPipe,
  checkMode,
  checkNode,
  checkProbeInputs,
  checkTool,
  classifyAnthropicError,
  formatChecklist,
  maskSecret,
  summarize,
  type CatalogRow,
  type Check,
} from "@/scripts/lib/doctor-checks";
import { loadEnvFile, loadProjectEnv, parseEnv } from "@/scripts/lib/env";

const ok = (over: Partial<Extract<ClothsyAccountResult, { ok: true }>> = {}): ClothsyAccountResult => ({
  ok: true,
  httpStatus: 200,
  body: { credits: 20, scope: "account" },
  credits: 20,
  scope: "account",
  latencyMs: 120,
  ...over,
});
const fail = (code: string, httpStatus: number | null, message = "x"): ClothsyAccountResult => ({
  ok: false,
  httpStatus,
  code,
  message,
  retryable: false,
  latencyMs: 50,
});

describe("summarize", () => {
  const c = (status: Check["status"]): Check => ({ id: status, label: status, status, detail: "", fix: null });

  it("ready (exit 0) only without FAIL; WARN never blocks", () => {
    expect(summarize([c("PASS"), c("WARN")])).toMatchObject({ ready: true, exitCode: 0, pass: 1, warn: 1, fail: 0 });
    const s = summarize([c("PASS"), c("FAIL"), c("WARN"), c("FAIL")]);
    expect(s).toMatchObject({ ready: false, exitCode: 1, pass: 1, warn: 1, fail: 2 });
    expect(s.failures).toHaveLength(2);
    expect(summarize([])).toMatchObject({ ready: true, exitCode: 0 });
  });

  it("formatChecklist ends with the next command when ready, and with the failures otherwise", () => {
    const pass: Check = { id: "a", label: "A", status: "PASS", detail: "fine", fix: null };
    const bad: Check = { id: "b", label: "B", status: "FAIL", detail: "broken", fix: "do X" };
    const ready = formatChecklist([pass], summarize([pass]), { color: false, nextCommand: "npm run probe -- …" });
    expect(ready).toContain("PASS  A  fine");
    expect(ready.trim().endsWith("Ready for live. Next: npm run probe -- …")).toBe(true);
    const notReady = formatChecklist([pass, bad], summarize([pass, bad]), { color: false, nextCommand: "x" });
    expect(notReady).toContain("→ do X");
    expect(notReady).toContain("Not ready for live because:\n  - B: broken");
    expect(notReady).not.toContain("\x1b[");
    // The consent flag is the operator's own step: printed as a note, never pre-filled.
    const withNote = formatChecklist([pass], summarize([pass]), { color: false, nextCommand: "npm run probe -- --people p", nextNote: "Add --i-have-consent once…" });
    expect(withNote.trim().endsWith("Ready for live. Next: npm run probe -- --people p\nAdd --i-have-consent once…")).toBe(true);
    expect(formatChecklist([pass, bad], summarize([pass, bad]), { color: false, nextCommand: "x", nextNote: "NOTE" })).not.toContain("NOTE");
  });

  it("the doctor's suggested probe command never pre-fills --i-have-consent", () => {
    const src = readFileSync(path.join(process.cwd(), "scripts", "doctor.ts"), "utf8");
    const cmd = /const nextCommand = `([^`]+)`/.exec(src)?.[1] ?? "";
    expect(cmd).toContain("npm run probe -- ");
    expect(cmd).not.toContain("--i-have-consent");
  });
});

describe("secrets", () => {
  it("masks keys to a prefix and the last 4 characters", () => {
    expect(maskSecret("clothsy_live_abcdefghijklmnop1234")).toBe("clothsy_live_…1234");
    expect(maskSecret("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV")).toBe("sk-ant-api03-…STUV");
    expect(maskSecret("clothsy_live_short")).toBe("clothsy_live_…");
    expect(maskSecret("tiny")).toBe("…");
  });

  it("CLOTHSY_API_KEY: missing → FAIL with where to get it; NEXT_PUBLIC_ leak → FAIL; odd format → WARN", () => {
    const missing = checkClothsyKey({ key: null, publicLeaks: [] });
    expect(missing.status).toBe("FAIL");
    expect(missing.fix).toContain("https://app.clothsyai.fabricvton.com/api-keys");
    expect(missing.fix).toContain("CLOTHSY_API_KEY=clothsy_live_");
    expect(checkClothsyKey({ key: "clothsy_live_x", publicLeaks: ["NEXT_PUBLIC_CLOTHSY_API_KEY"] }).status).toBe("FAIL");
    const good = checkClothsyKey({ key: "clothsy_live_abcdefghijkl9999", publicLeaks: [] });
    expect(good).toMatchObject({ status: "PASS", fix: null });
    expect(good.detail).toContain("…9999");
    expect(good.detail).not.toContain("abcdefghijkl");
    expect(checkClothsyKey({ key: "sk_test_123456789", publicLeaks: [] }).status).toBe("WARN");
  });
});

describe("Clothsy account check", () => {
  it("PASS with credits and scope from the documented body", () => {
    const c = checkClothsyAccount(ok());
    expect(c.status).toBe("PASS");
    expect(c.detail).toContain("20 credit(s) left, scope account");
  });

  it("low credits WARN, zero credits FAIL, unknown shape WARN", () => {
    expect(checkClothsyAccount(ok({ credits: 3 })).status).toBe("WARN");
    const zero = checkClothsyAccount(ok({ credits: 0 }));
    expect(zero.status).toBe("FAIL");
    expect(zero.fix).toContain("contact@fabricvton.com");
    expect(checkClothsyAccount(ok({ credits: null, body: { balance: "?" } })).status).toBe("WARN");
  });

  it("maps errors: 401 FAIL, TLS/network FAIL with NODE_EXTRA_CA_CERTS hint, 5xx WARN, no key FAIL", () => {
    const bad = checkClothsyAccount(fail("INVALID_API_KEY", 401));
    expect(bad.status).toBe("FAIL");
    expect(bad.detail).toContain("HTTP 401 INVALID_API_KEY");
    const tls = checkClothsyAccount(fail("NETWORK_ERROR", null, "fetch failed (unable to get local issuer certificate)"));
    expect(tls.status).toBe("FAIL");
    expect(tls.fix).toContain("NODE_EXTRA_CA_CERTS");
    expect(checkClothsyAccount(fail("NETWORK_ERROR", null, "ECONNREFUSED")).fix).toContain("CLOTHSY_API_BASE");
    expect(checkClothsyAccount(fail("UNAVAILABLE", 503)).status).toBe("WARN");
    expect(checkClothsyAccount(fail("NO_API_KEY", null)).status).toBe("FAIL");
    expect(checkClothsyAccount(null).status).toBe("FAIL");
  });
});

describe("Anthropic check (models.retrieve, 0 tokens)", () => {
  const h = new Headers();
  it("absent is fine (rules), ok names the model", () => {
    expect(checkAnthropic({ kind: "absent" }, "claude-opus-5-5")).toMatchObject({ status: "PASS" });
    const good = checkAnthropic({ kind: "ok", modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", latencyMs: 80 }, "claude-opus-5-5");
    expect(good.status).toBe("PASS");
    expect(good.detail).toContain("GET /v1/models/claude-opus-5-5, 0 tokens");
  });

  it("classifies SDK errors most-specific first", () => {
    expect(classifyAnthropicError(new Anthropic.AuthenticationError(401, undefined, "x", h))).toBe("auth");
    expect(classifyAnthropicError(new Anthropic.PermissionDeniedError(403, undefined, "x", h))).toBe("permission");
    expect(classifyAnthropicError(new Anthropic.NotFoundError(404, undefined, "x", h))).toBe("not_found");
    expect(classifyAnthropicError(new Anthropic.RateLimitError(429, undefined, "x", h))).toBe("rate_limit");
    expect(classifyAnthropicError(new Anthropic.InternalServerError(529, undefined, "x", h))).toBe("server");
    expect(classifyAnthropicError(new Anthropic.APIConnectionTimeoutError())).toBe("connection");
    expect(classifyAnthropicError(new Error("?"))).toBe("other");
  });

  it("bad key or unknown model FAIL; network trouble WARN", () => {
    expect(checkAnthropic({ kind: "error", error: new Anthropic.AuthenticationError(401, undefined, "x", h) }, "m").status).toBe("FAIL");
    const nf = checkAnthropic({ kind: "error", error: new Anthropic.NotFoundError(404, undefined, "x", h) }, "claude-nope");
    expect(nf.status).toBe("FAIL");
    expect(nf.fix).toContain("DIAGNOSIS_MODEL=claude-opus-5-5");
    const conn = checkAnthropic(
      { kind: "error", error: new Anthropic.APIConnectionError({ message: "self-signed certificate in certificate chain" }) },
      "m",
    );
    expect(conn.status).toBe("WARN");
    expect(conn.fix).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("DIAGNOSIS_MODEL: default, custom and implausible values", () => {
    expect(checkDiagnosisModel({ raw: undefined, model: "claude-opus-5-5", anthropicConfigured: false }).detail).toContain("(default)");
    expect(checkDiagnosisModel({ raw: "claude-sonnet-5-5", model: "claude-sonnet-5-5", anthropicConfigured: true }).status).toBe("PASS");
    expect(checkDiagnosisModel({ raw: "gpt-4", model: "gpt-4", anthropicConfigured: true }).status).toBe("WARN");
  });
});

describe("mode, caps and access", () => {
  const base = { rawMode: "auto", mode: "auto" as const, hasKey: true, liveAccessCode: null, liveToday: 0, dailyCap: 40 };

  it("resolves the provider like the server (decideProvider)", () => {
    expect(checkMode(base)).toMatchObject({ status: "PASS" });
    expect(checkMode(base).detail).toContain("every browser → Live · Clothsy try-on");
    expect(checkMode({ ...base, rawMode: "dev", mode: "dev" }).status).toBe("FAIL");
    expect(checkMode({ ...base, rawMode: "replay", mode: "replay" }).status).toBe("WARN");
    expect(checkMode({ ...base, hasKey: false }).status).toBe("WARN");
    expect(checkMode({ ...base, liveToday: 40 }).detail).toContain("40/40");
    const gated = checkMode({ ...base, liveAccessCode: "judges-2026" });
    expect(gated.detail).toContain("unlocked browser → Live · Clothsy try-on · public visitor → replay");
    expect(checkMode({ ...base, rawMode: "LIVEE", mode: "auto" }).status).toBe("WARN");
  });

  it("fails when the daily cap exceeds the credits left (the cap must protect the reserve), warns when caps are odd", () => {
    const fine = checkCaps({ dailyCap: 15, maxPerReturn: 5, rawDaily: "15", rawMax: "5", credits: 20, liveToday: 0 });
    expect(fine.status).toBe("PASS");
    const over = checkCaps({ dailyCap: 40, maxPerReturn: 5, rawDaily: "40", rawMax: "5", credits: 20, liveToday: 2 });
    expect(over.status).toBe("FAIL");
    expect(over.fix).toContain("DAILY_LIVE_RENDER_CAP=18");
    expect(over.fix).toContain("fly.toml");
    expect(checkCaps({ dailyCap: 40, maxPerReturn: 9, rawDaily: "40", rawMax: "9", credits: 13, liveToday: 0 }).status).toBe("FAIL");
    expect(checkCaps({ dailyCap: 40, maxPerReturn: 9, rawDaily: undefined, rawMax: "9", credits: null, liveToday: 0 }).status).toBe("WARN");
    expect(checkCaps({ dailyCap: 40, maxPerReturn: 5, rawDaily: "forty", rawMax: undefined, credits: null, liveToday: 0 }).status).toBe("WARN");
  });

  it("LIVE_ACCESS_CODE: WARN when a key could spend credits on a public URL without one", () => {
    expect(checkLiveAccess({ hasKey: true, mode: "auto", code: null }).status).toBe("WARN");
    expect(checkLiveAccess({ hasKey: false, mode: "auto", code: null }).status).toBe("PASS");
    expect(checkLiveAccess({ hasKey: true, mode: "replay", code: null }).status).toBe("PASS");
    expect(checkLiveAccess({ hasKey: true, mode: "auto", code: "abc" }).status).toBe("WARN");
    expect(checkLiveAccess({ hasKey: true, mode: "auto", code: "a-long-random-code" }).status).toBe("PASS");
  });
});

describe("files and tools", () => {
  const row = (over: Partial<CatalogRow> = {}): CatalogRow => ({
    file: "public/catalog/a.png",
    exists: true,
    drawing: false,
    width: 1200,
    height: 1600,
    preparedBytes: 400_000,
    error: null,
    ...over,
  });

  it("catalogue: counts photos vs drawings; missing or unusable FAIL; drawings WARN", () => {
    expect(checkCatalog([row(), row({ file: "b" })], 3_999_999)).toMatchObject({ status: "PASS" });
    const drawings = checkCatalog([row({ drawing: true, width: 768, height: 1024 }), row()], 3_999_999);
    expect(drawings.status).toBe("WARN");
    expect(drawings.detail).toContain("2 image(s): 1 photo(s), 1 generated drawing(s)");
    expect(drawings.fix).toContain("same file name");
    expect(checkCatalog([row({ exists: false, preparedBytes: null })], 3_999_999).status).toBe("FAIL");
    expect(checkCatalog([row({ preparedBytes: 5_000_000 })], 3_999_999).status).toBe("FAIL");
    expect(checkCatalog([row({ preparedBytes: null, error: "unsupported image format" })], 3_999_999).detail).toContain("unsupported image format");
    expect(checkCatalog([row({ width: 400, height: 500 })], 3_999_999).status).toBe("WARN");
  });

  it("MediaPipe, data dir, tools and probe inputs", () => {
    expect(checkMediaPipe([{ path: "a", bytes: 10 }]).status).toBe("PASS");
    expect(checkMediaPipe([{ path: "a", bytes: 10 }, { path: "b", bytes: null }]).detail).toBe("missing: b");
    expect(checkDataDir({ dir: ".data", exists: true, writable: true, error: null }).status).toBe("PASS");
    expect(checkDataDir({ dir: ".data", exists: false, writable: true, error: null }).detail).toContain("will be created");
    expect(checkDataDir({ dir: "/ro", exists: true, writable: false, error: "EACCES" }).status).toBe("FAIL");
    expect(checkTool({ id: "ffmpeg", name: "ffmpeg", found: null, purpose: "npm run record", fix: "brew install ffmpeg" }).status).toBe("WARN");
    expect(checkProbeInputs({ dir: "probe/people", exists: true, usable: 3, other: 1 }).status).toBe("PASS");
    // Two people × two SKUs is 4 renders, below the 6 good renders tune --apply needs.
    expect(checkProbeInputs({ dir: "probe/people", exists: true, usable: 2, other: 0 })).toMatchObject({ status: "WARN", fix: expect.stringContaining("6 renders") });
    expect(checkProbeInputs({ dir: "probe/people", exists: false, usable: 0, other: 0 }).fix).toContain("mkdir -p probe/people");
  });

  it("node version and .env.local presence", () => {
    expect(checkNode("20.9.0").status).toBe("PASS");
    expect(checkNode("v22.1.0").status).toBe("PASS");
    expect(checkNode("20.8.1").status).toBe("FAIL");
    expect(checkNode("18.19.0").status).toBe("FAIL");
    expect(checkEnvFile({ present: false, exampleExists: true, files: [] }).fix).toBe("cp .env.example .env.local, then fill in the keys.");
    expect(checkEnvFile({ present: true, exampleExists: true, files: [".env.local"] }).status).toBe("PASS");
  });
});

describe("scripts/lib/env", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tryback-env-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parses KEY=VALUE with export, quotes, escapes and trailing comments", () => {
    const m = parseEnv(
      [
        "# comment",
        "export A=1",
        'B="two words # not a comment"',
        "C='single'",
        "D=plain # trailing",
        'E="line\\nbreak"',
        "EMPTY=",
        "not a line",
      ].join("\n"),
    );
    expect(Object.fromEntries(m)).toEqual({ A: "1", B: "two words # not a comment", C: "single", D: "plain", E: "line\nbreak", EMPTY: "" });
  });

  it("existing variables win; .env.local beats .env; missing files load nothing", () => {
    writeFileSync(path.join(dir, ".env.local"), "X=local\nY=local\n");
    writeFileSync(path.join(dir, ".env"), "Y=env\nZ=env\n");
    const env = { X: "shell" } as unknown as NodeJS.ProcessEnv;
    const r = loadProjectEnv(dir, env);
    expect(r.files).toEqual([".env.local", ".env"]);
    expect(r.loaded.sort()).toEqual(["Y", "Z"]);
    expect(env).toMatchObject({ X: "shell", Y: "local", Z: "env" });
    expect(loadEnvFile(path.join(dir, "nope"), env)).toEqual([]);
  });
});
