// npm run doctor [-- --json]: is this machine ready for live Clothsy renders?
//
// Prints a PASS/WARN/FAIL checklist with a fix per line. Exit 0 = ready for live (no FAIL),
// 1 = not ready. It never starts a try-on and never generates tokens: Clothsy is checked with
// GET /account (free) and Anthropic with GET /v1/models/{DIAGNOSIS_MODEL} (no tokens).
// Secrets are never printed (masked to their last 4 characters).

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { findChrome } from "./lib/cdp";
import { loadProjectEnv } from "./lib/env";

const ROOT = process.cwd();

const MEDIAPIPE_FILES = [
  "public/models/pose_landmarker_full.task",
  "public/models/selfie_multiclass_256x256.tflite",
  "public/mediapipe/vision_wasm_internal.js",
  "public/mediapipe/vision_wasm_internal.wasm",
  "public/mediapipe/vision_wasm_module_internal.js",
  "public/mediapipe/vision_wasm_module_internal.wasm",
];

async function fileSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(path.resolve(ROOT, p));
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Writable check that leaves nothing behind (a temp file is created and removed only if the dir exists). */
async function probeDataDir(dir: string): Promise<{ exists: boolean; writable: boolean; error: string | null }> {
  if (existsSync(dir)) {
    const tmp = path.join(dir, `.doctor-${process.pid}.tmp`);
    try {
      await fs.writeFile(tmp, "ok");
      await fs.rm(tmp, { force: true });
      return { exists: true, writable: true, error: null };
    } catch (err) {
      return { exists: true, writable: false, error: (err as Error).message };
    }
  }
  let parent = path.dirname(dir);
  while (!existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
  try {
    await fs.access(parent, fsConstants.W_OK);
    return { exists: false, writable: true, error: null };
  } catch (err) {
    return { exists: false, writable: false, error: (err as Error).message };
  }
}

/** Live renders recorded today, read straight from db.json (read-only; the store would create dirs). */
async function liveRendersTodayReadOnly(dataDir: string): Promise<number> {
  try {
    const db = JSON.parse(await fs.readFile(path.join(dataDir, "db.json"), "utf8")) as { liveRendersByDay?: Record<string, number> };
    return db.liveRendersByDay?.[new Date().toISOString().slice(0, 10)] ?? 0;
  } catch {
    return 0;
  }
}

function which(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  return (r.stdout || r.stderr).split("\n")[0]?.trim().slice(0, 80) || cmd;
}

async function main(): Promise<number> {
  const json = process.argv.includes("--json");
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npm run doctor [-- --json]\nChecks keys, mode, catalogue, models, data dir and tools. Exit 0 = ready for live.");
    return 0;
  }
  const env = loadProjectEnv(ROOT);

  // Imported after the env is loaded (lib/store resolves TRYBACK_DATA_DIR at import time).
  const checks = await import("./lib/doctor-checks");
  const { config } = await import("../lib/config");
  const { fetchClothsyAccount } = await import("../lib/tryon/clothsy");
  const { SKUS } = await import("../lib/catalog");
  const { loadGarmentImage, garmentFilePath, GARMENT_MAX_BYTES } = await import("../lib/tryon/garment");
  const { suggestProbeSkus, jpegOrPng } = await import("./lib/probe-core");
  const { classifyCatalogFile } = await import("./lib/imaging");

  const dataDir = path.resolve(process.env.TRYBACK_DATA_DIR ?? ".data");
  const liveToday = await liveRendersTodayReadOnly(dataDir);
  const key = config.clothsyApiKey;

  // Network checks run in parallel; both are free.
  const accountP = key ? fetchClothsyAccount({ timeoutMs: 10_000 }) : Promise.resolve(null);
  const anthropicP: Promise<import("./lib/doctor-checks").AnthropicProbe> = config.anthropicConfigured
    ? checks.probeAnthropic(config.diagnosisModel)
    : Promise.resolve({ kind: "absent" });

  // Catalogue: every SKU's primary and alt shot, prepared exactly as for upload.
  const catalogPaths = new Map<string, { sku: (typeof SKUS)[number]; variant: "primary" | "alt" }>();
  for (const sku of SKUS) {
    catalogPaths.set(sku.image, { sku, variant: "primary" });
    if (sku.altImage) catalogPaths.set(sku.altImage, { sku, variant: "alt" });
  }
  const catalogRows = await Promise.all(
    [...catalogPaths].map(async ([publicPath, { sku, variant }]) => {
      const file = garmentFilePath(publicPath);
      const relFile = path.relative(ROOT, file);
      if (!existsSync(file)) {
        return { file: relFile, exists: false, drawing: false, width: null, height: null, preparedBytes: null, error: null };
      }
      try {
        // The TryBack tEXt marker tells imported photos (same 768×1024 frame) from placeholders.
        const [meta, kind] = await Promise.all([sharp(file).metadata(), classifyCatalogFile(file)]);
        const prepared = await loadGarmentImage(sku, variant);
        return {
          file: relFile,
          exists: true,
          drawing: kind === "placeholder",
          width: meta.width ?? null,
          height: meta.height ?? null,
          preparedBytes: prepared.bytes.length,
          error: null,
        };
      } catch (err) {
        return { file: relFile, exists: true, drawing: false, width: null, height: null, preparedBytes: null, error: (err as Error).message };
      }
    }),
  );

  // Probe inputs.
  const peopleDir = path.join(ROOT, "probe/people");
  let usable = 0;
  let other = 0;
  if (existsSync(peopleDir)) {
    for (const f of await fs.readdir(peopleDir)) {
      if (f.startsWith(".")) continue;
      const fh = await fs.open(path.join(peopleDir, f), "r").catch(() => null);
      if (!fh) continue;
      const head = Buffer.alloc(16);
      try {
        await fh.read(head, 0, 16, 0);
      } finally {
        await fh.close();
      }
      if (jpegOrPng(head)) usable++;
      else other++;
    }
  }

  const publicLeaks = Object.keys(process.env).filter(
    (k) => /^NEXT_PUBLIC_.*(CLOTHSY|ANTHROPIC)/i.test(k) && Boolean(process.env[k]?.trim()),
  );

  const account = await accountP;
  const anthropic = await anthropicP;
  const credits = account && account.ok ? account.credits : null;

  const list = [
    checks.checkNode(process.versions.node),
    checks.checkEnvFile({ present: env.files.includes(".env.local"), exampleExists: existsSync(path.join(ROOT, ".env.example")), files: env.files }),
    checks.checkMode({
      rawMode: process.env.TRYON_MODE,
      mode: config.tryOnMode,
      hasKey: key !== null,
      liveAccessCode: config.liveAccessCode,
      liveToday,
      dailyCap: config.dailyLiveRenderCap,
    }),
    checks.checkClothsyKey({ key, publicLeaks }),
    checks.checkClothsyAccount(account),
    checks.checkAnthropic(anthropic, config.diagnosisModel),
    checks.checkDiagnosisModel({ raw: process.env.DIAGNOSIS_MODEL, model: config.diagnosisModel, anthropicConfigured: config.anthropicConfigured }),
    checks.checkCatalog(catalogRows, GARMENT_MAX_BYTES),
    checks.checkMediaPipe(await Promise.all(MEDIAPIPE_FILES.map(async (p) => ({ path: p, bytes: await fileSize(p) })))),
    checks.checkDataDir({ dir: path.relative(ROOT, dataDir).startsWith("..") ? dataDir : path.relative(ROOT, dataDir) || ".", ...(await probeDataDir(dataDir)) }),
    checks.checkCaps({
      dailyCap: config.dailyLiveRenderCap,
      maxPerReturn: config.maxRendersPerReturn,
      rawDaily: process.env.DAILY_LIVE_RENDER_CAP,
      rawMax: process.env.MAX_RENDERS_PER_RETURN,
      credits,
      liveToday,
    }),
    checks.checkLiveAccess({ hasKey: key !== null, mode: config.tryOnMode, code: config.liveAccessCode }),
    checks.checkTool({
      id: "chrome",
      name: "Chrome / Chromium",
      found: findChrome(),
      purpose: "npm run record and npm run tune",
      fix: "Install Google Chrome, or set CHROME_PATH=/path/to/chrome.",
    }),
    // npm run record encodes with AVFoundation on macOS (Xcode command line tools), ffmpeg elsewhere.
    process.platform === "darwin" && which("xcrun", ["--find", "swiftc"])
      ? checks.checkTool({
          id: "ffmpeg",
          name: "Video encoder (npm run record)",
          found: "AVFoundation via xcrun swiftc (ffmpeg optional on macOS)",
          purpose: "npm run record",
          fix: "",
        })
      : checks.checkTool({
          id: "ffmpeg",
          name: "ffmpeg",
          found: which("ffmpeg", ["-version"]),
          purpose: "npm run record (video encoding)",
          fix: process.platform === "darwin" ? "xcode-select --install (AVFoundation encoder), or brew install ffmpeg." : "apt install ffmpeg (or brew install ffmpeg).",
        }),
    checks.checkProbeInputs({ dir: "probe/people", exists: existsSync(peopleDir), usable, other }),
  ];

  const summary = checks.summarize(list);
  // Probe SKUs whose primary product image is a real photo, preferring the hero demo's renders.
  const photoSkus = new Set(
    [...catalogPaths].filter(([, v], i) => v.variant === "primary" && catalogRows[i]!.exists && !catalogRows[i]!.drawing).map(([, v]) => v.sku.id),
  );
  const probeSkus = suggestProbeSkus((id) => photoSkus.has(id)).join(",");
  // Worst case: every photo × 2 SKUs renders, plus 1 credit for the replay check.
  const probePeople = Math.min(Math.max(usable, 2), 3);
  // No --i-have-consent here on purpose: adding it is the operator's own attestation (see nextNote).
  const nextCommand = `npm run probe -- --people probe/people --skus ${probeSkus} --max-credits ${probePeople * 2 + 1} --check-replay`;
  const nextNote =
    "Add --i-have-consent to that command only once every person in probe/people is an adult (18+) who agreed to their photo being sent to Clothsy AI for virtual try-on. Without it the probe stops before uploading anything.";
  if (json) {
    console.log(
      JSON.stringify(
        {
          ready: summary.ready,
          exitCode: summary.exitCode,
          summary: { pass: summary.pass, warn: summary.warn, fail: summary.fail },
          checks: list,
          next: summary.ready ? nextCommand : null,
          nextNote: summary.ready ? nextNote : null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(checks.formatChecklist(list, summary, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, nextCommand, nextNote }));
  }
  return summary.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error("doctor: fatal:", err);
    process.exitCode = 1;
  },
);
