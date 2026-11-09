// Calibrate the fidelity-gate thresholds from real try-on renders (docs/GATE-TUNING.md).
//
//   npm run tune                         # after `npm run probe`: report only
//   npm run tune -- --apply              # write lib/cv/thresholds.json (≥6 good real renders, every render labelled)
//   npm run tune -- --labels probe/labels.json --wearing fw-wrap-dress-mustard:M
//   npm run tune -- --preflight-only     # photo checks on probe/people before spending credits
//   npm run tune -- --self-test          # prove the harness on probe/fixtures-local (no renders needed)
//
// How it works: starts a private `next dev` (or uses --base), opens /dev/gate-lab in headless
// Chrome and, through window.__gateLab, runs the SAME browser code the shopper flow uses
// (normalizePhoto → runPreflight → buildMeasurements, then the gate's computeGate with the same
// MediaPipe models). For every good render it also builds synthetic bad variants in the page
// (colour shift, pasted-back residue, face edits, missing garment, moved hem, silhouette leak),
// measures everything, and picks thresholds with scripts/lib/tune-math.ts.
//
// Images go from disk to the local browser as data URLs and stay on this machine. Nothing is
// sent to the try-on API or to an LLM, and no credits are spent.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { launchChrome, sleep, waitForHttp, type Browser, type Page } from "./lib/cdp";
import { snapshotNextProjectFiles } from "./lib/next-files";
import {
  applyGuard,
  buildThresholdsFile,
  diffThresholds,
  fmt,
  LABEL_TODO,
  LabelError,
  parseLabelsFile,
  parseWearing,
  propose,
  renderReport,
  CATALOGUE_COLOUR_WARN_DE,
  type GarmentRow,
  type MetricKey,
  type LabelsFile,
  type PreflightRow,
  type RenderLabel,
  type Sample,
} from "./lib/tune-math";
import type { LabCtx, LabMetricsResult, LabPreflightResult, LabSynthResult } from "../lib/cv/lab";
import { NEGATIVE_KINDS, PREFLIGHT_NEGATIVE_KINDS, planNegatives, type NegativeKind } from "../lib/cv/synthMath";
import { gateCheckApplies } from "../lib/cv/gateMath";
import { parseThresholds, type ThresholdsFile } from "../lib/cv/thresholds";
import { getSku } from "../lib/catalog";
import { SIZES, type SizeCode } from "../lib/types";

const ROOT = process.cwd();
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const DEFAULT_THRESHOLDS_FILE = path.join(ROOT, "lib", "cv", "thresholds.json");
const DEFAULT_WEARING = "fw-wrap-dress-mustard:M";
const FIXTURES_DIR = "probe/fixtures-local";

const HELP = `TryBack gate tuning: calibrate the fidelity-gate thresholds from real renders.

Usage:
  npm run tune -- [options]

Inputs
  --probe-dir <dir>       Probe folder (results.jsonl, out/)                 [probe]
  --results <file>        Probe log                                          [<probe-dir>/results.jsonl]
  --people <dir>          Person photos the probe used                       [<probe-dir>/people]
  --labels <file>         Your labels (see docs/GATE-TUNING.md)              [<probe-dir>/labels.json if present]
  --wearing <spec>        What the people wear in their photos: "sku[:size]" for everyone,
                          or "alex=sku:size,sam=sku:size" per person          [labels.wearing, else ${DEFAULT_WEARING}]
  --self-test             Use ${FIXTURES_DIR}/selftest.json instead of probe renders
  --preflight-only        Only run the photo checks on --people (before you spend credits)

Tuning
  --negatives <kinds>     Synthetic bad variants: ${NEGATIVE_KINDS.join(",")} | none   [all]
  --max-false-flag <x>    Max share of good renders a threshold may flag     [0.05]
  --limit <n>             Use at most n good renders (quick runs)
  --apply                 Write the proposal to lib/cv/thresholds.json (backup + diff).
                          Refused with fewer than 6 good real renders, while any render is
                          unlabelled (missing or "todo" in --labels), and in --self-test.
  --thresholds <file>     Thresholds file to compare against / apply to     [lib/cv/thresholds.json]

Output
  --report <file>         Markdown report      [<probe-dir>/tune-report.md]
  --metrics-out <file>    One JSON line per render  [<probe-dir>/tune-metrics.jsonl]
  --save-synth            Also save the synthetic images to <probe-dir>/tune-synth/

Server
  --base <url>            Use a running TryBack server (dev, or ENABLE_GATE_LAB=1) instead of starting one
  --port <n>              Port for the server this script starts             [3199]
  --dist-dir <dir>        NEXT_DIST_DIR for that server                      [.next-tune]
  --headful               Show the Chrome window
  -h, --help              Show this help

Photos stay on this machine: they go to a local headless Chrome only.`;

class UsageError extends Error {}

interface Options {
  probeDir: string;
  resultsFile: string;
  peopleDir: string;
  labelsFile: string | null;
  wearing: string | null;
  selfTest: boolean;
  preflightOnly: boolean;
  negatives: NegativeKind[];
  maxFalseFlag: number;
  limit: number | null;
  apply: boolean;
  thresholdsFile: string;
  reportFile: string;
  metricsFile: string;
  saveSynth: boolean;
  base: string | null;
  port: number;
  distDir: string;
  headful: boolean;
}

function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      "probe-dir": { type: "string", default: "probe" },
      results: { type: "string" },
      people: { type: "string" },
      labels: { type: "string" },
      wearing: { type: "string" },
      "self-test": { type: "boolean", default: false },
      "preflight-only": { type: "boolean", default: false },
      negatives: { type: "string", default: NEGATIVE_KINDS.join(",") },
      "max-false-flag": { type: "string", default: "0.05" },
      limit: { type: "string" },
      apply: { type: "boolean", default: false },
      thresholds: { type: "string" },
      report: { type: "string" },
      "metrics-out": { type: "string" },
      "save-synth": { type: "boolean", default: false },
      base: { type: "string" },
      port: { type: "string", default: "3199" },
      "dist-dir": { type: "string", default: ".next-tune" },
      headful: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return null;
  const probeDir = path.resolve(ROOT, values["probe-dir"]);
  const negatives =
    values.negatives === "none"
      ? []
      : [...new Set(values.negatives.split(",").map((s) => s.trim()).filter(Boolean))].map((k) => {
          if (!(NEGATIVE_KINDS as readonly string[]).includes(k)) throw new UsageError(`--negatives: unknown kind "${k}"`);
          return k as NegativeKind;
        });
  const maxFalseFlag = Number(values["max-false-flag"]);
  if (!(maxFalseFlag >= 0 && maxFalseFlag < 0.5)) throw new UsageError("--max-false-flag must be in [0, 0.5)");
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) throw new UsageError("--limit must be a positive integer");
  const port = Number(values.port);
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError("--port must be a valid port");
  const selfTest = values["self-test"];
  const preflightOnly = values["preflight-only"];
  if (selfTest && preflightOnly) throw new UsageError("--self-test and --preflight-only don't combine");
  const outBase = selfTest ? path.resolve(ROOT, FIXTURES_DIR) : probeDir;
  const labelsDefault = path.join(probeDir, "labels.json");
  return {
    probeDir,
    resultsFile: path.resolve(ROOT, values.results ?? path.join(probeDir, "results.jsonl")),
    peopleDir: path.resolve(ROOT, values.people ?? path.join(probeDir, "people")),
    labelsFile: values.labels ? path.resolve(ROOT, values.labels) : existsSync(labelsDefault) ? labelsDefault : null,
    wearing: values.wearing ?? null,
    selfTest,
    preflightOnly,
    negatives,
    maxFalseFlag,
    limit,
    apply: values.apply,
    thresholdsFile: values.thresholds ? path.resolve(ROOT, values.thresholds) : DEFAULT_THRESHOLDS_FILE,
    reportFile: path.resolve(
      ROOT,
      values.report ?? path.join(outBase, selfTest ? "selftest-report.md" : preflightOnly ? "preflight-report.md" : "tune-report.md"),
    ),
    metricsFile: path.resolve(ROOT, values["metrics-out"] ?? path.join(outBase, selfTest ? "selftest-metrics.jsonl" : "tune-metrics.jsonl")),
    saveSynth: values["save-synth"],
    base: values.base ? values.base.replace(/\/+$/, "") : null,
    port,
    distDir: values["dist-dir"],
    headful: values.headful,
  };
}

/* ───────────── helpers ───────────── */

const rel = (p: string) => path.relative(ROOT, p) || ".";
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "person";

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
}

async function dataUrlOf(file: string, bytes?: Buffer): Promise<string> {
  const b = bytes ?? (await fs.readFile(file));
  return `data:${mimeOf(file)};base64,${b.toString("base64")}`;
}

function requireSize(s: string): SizeCode {
  if (!(SIZES as readonly string[]).includes(s)) throw new UsageError(`unknown size "${s}" (use ${SIZES.join(", ")})`);
  return s as SizeCode;
}

/** People listed like scripts/probe.ts names them (safe basename, -2/-3 for duplicates). */
async function listPeople(dir: string): Promise<{ person: string; file: string }[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => IMAGE_EXT.test(f) && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
  const used = new Map<string, number>();
  return files.map((f) => {
    const base = safeName(f.replace(IMAGE_EXT, ""));
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return { person: n > 0 ? `${base}-${n + 1}` : base, file: path.join(dir, f) };
  });
}

interface ProbeLine {
  person: string;
  sku: string;
  variant: "primary" | "alt";
  status: string;
  out: string | null;
}

async function readProbeResults(file: string): Promise<ProbeLine[]> {
  if (!existsSync(file)) return [];
  const latest = new Map<string, ProbeLine>();
  for (const line of (await fs.readFile(file, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as ProbeLine;
      if (!o.person || !o.sku) continue;
      // --check-replay re-sends a finished pair; its row says nothing about the render on disk.
      if ((o as { replayCheck?: boolean }).replayCheck) continue;
      latest.set(`${o.person}|${o.sku}|${o.variant ?? "primary"}`, { ...o, variant: o.variant === "alt" ? "alt" : "primary" });
    } catch {
      /* skip malformed lines */
    }
  }
  return [...latest.values()];
}

async function readLabels(file: string | null): Promise<LabelsFile> {
  if (!file) return { wearing: {}, renders: {}, todo: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    throw new UsageError(`can't read labels ${rel(file)}: ${(err as Error).message}`);
  }
  try {
    return parseLabelsFile(raw);
  } catch (err) {
    if (err instanceof LabelError) throw new UsageError(`labels ${rel(file)}: ${err.message}`);
    throw err;
  }
}

/** Person → { skuId, size } from --wearing / labels.wearing / default. */
function wearingResolver(cli: string | null, fromLabels: Record<string, string>): (person: string) => { skuId: string; size: SizeCode } {
  const map: Record<string, string> = { ...fromLabels };
  if (cli) {
    if (cli.includes("=")) {
      for (const part of cli.split(",")) {
        const [k, v] = part.split("=").map((s) => s.trim());
        if (k && v) map[k] = v;
      }
    } else {
      map["*"] = cli;
    }
  }
  return (person) => {
    const spec = map[person] ?? map["*"] ?? DEFAULT_WEARING;
    const { skuId, size } = parseWearing(spec);
    if (!getSku(skuId)) throw new UsageError(`wearing: unknown SKU "${skuId}" for ${person}`);
    return { skuId, size: requireSize(size) };
  };
}

/* ───────────── server + browser ───────────── */

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(false)));
  });
}

interface Server {
  base: string;
  stop: () => Promise<void>;
}

async function startServer(opts: Options): Promise<Server> {
  if (opts.base) return { base: opts.base, stop: async () => undefined };
  if (await portInUse(opts.port)) {
    throw new UsageError(`port ${opts.port} is busy. Pass --port <free port>, or --base http://localhost:<port> to use a server you already run.`);
  }
  const nextBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  if (!existsSync(nextBin)) throw new Error("next is not installed (run npm install)");
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "tryback-tune-data-"));
  // next dev with NEXT_DIST_DIR rewrites tsconfig.json and next-env.d.ts; put them back on stop.
  const restoreNextFiles = snapshotNextProjectFiles(ROOT);
  const log: string[] = [];
  const child: ChildProcess = spawn(nextBin, ["dev", "-p", String(opts.port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      NEXT_DIST_DIR: opts.distDir,
      TRYBACK_DATA_DIR: dataDir,
      TRYON_MODE: "dev", // the lab never renders; dev mode guarantees no live API call
      ENABLE_GATE_LAB: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const keep = (b: Buffer) => {
    log.push(b.toString());
    if (log.length > 200) log.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const stop = async () => {
    if (child.exitCode === null && child.pid) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
      if (child.exitCode === null) {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    // next dev's worker closes its socket a moment after the group is signalled.
    for (let i = 0; i < 50 && (await portInUse(opts.port)); i++) await sleep(100);
    rmSync(dataDir, { recursive: true, force: true });
    restoreNextFiles();
  };
  // "localhost", not 127.0.0.1: next dev blocks its dev assets for other hostnames (allowedDevOrigins).
  const base = `http://localhost:${opts.port}`;
  console.log(`Starting next dev on ${base} (NEXT_DIST_DIR=${opts.distDir}; first compile can take a minute)…`);
  try {
    await Promise.race([
      waitForHttp(`${base}/dev/gate-lab`, 240_000),
      new Promise<never>((_, reject) => child.once("exit", (code) => reject(new Error(`next dev exited (${code})`)))),
    ]);
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n--- next dev output ---\n${log.join("").slice(-3000)}`);
  }
  return { base, stop };
}

async function openLab(browser: Browser, base: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${base}/dev/gate-lab`, 120_000);
  try {
    await page.waitForFunction("(window.__gateLab && window.__gateLab.ready) || window.__gateLabError", 120_000);
  } catch {
    throw new Error(
      `/dev/gate-lab didn't load the lab. On a production server set ENABLE_GATE_LAB=1; on a dev server open it via ` +
        `http://localhost:<port> (next dev blocks its scripts for other hostnames unless listed in allowedDevOrigins).`,
    );
  }
  const err = await page.evaluate<string | undefined>("window.__gateLabError");
  if (err) throw new Error(`gate lab failed to load: ${err}`);
  await page.evaluate("window.__gateLab.warm()");
  return page;
}

class Lab {
  constructor(private page: Page) {}
  private call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate<T>(`window.__gateLab.${fn}(${args.map((a) => JSON.stringify(a ?? null)).join(", ")})`);
  }
  put(dataUrl: string) {
    return this.call<string>("put", dataUrl);
  }
  metrics(person: string, render: string, garment: string | null, ctx: LabCtx) {
    return this.call<LabMetricsResult>("metrics", person, render, garment, ctx);
  }
  preflight(person: string) {
    return this.call<LabPreflightResult>("preflight", person);
  }
  synth(person: string, render: string | null, kind: string, params: Record<string, unknown>) {
    return this.call<LabSynthResult>("synth", person, render, kind, params);
  }
  info() {
    return this.call<{ delegates: { pose: string | null; segmenter: string | null }; userAgent: string }>("info");
  }
}

/* ───────────── inputs ───────────── */

interface PositiveSpec {
  id: string;
  person: string;
  personFile: string;
  /** Rotated/mirrored copies of fixtures are prepared in node. */
  personBytes?: Buffer;
  ctx: LabCtx;
  origin: "api" | "selftest";
  label: RenderLabel;
  /** Probe renders: the labels file names this render (not missing, not "todo"). */
  reviewed: boolean;
  /** Probe: the render file. Self-test: null (the render is synthesised in the page). */
  renderFile: string | null;
  garmentFile: string | null;
}

interface SelfTestFixture {
  file: string;
  sourceSkuId: string;
  size?: string;
  sourceColorHex?: string;
  targets: string[];
  mirror?: boolean;
  source?: string;
  license?: string;
}

async function selfTestInputs(): Promise<PositiveSpec[]> {
  const cfgFile = path.resolve(ROOT, FIXTURES_DIR, "selftest.json");
  if (!existsSync(cfgFile)) {
    throw new UsageError(
      `no ${rel(cfgFile)}. Put a CC0/public-domain full-body photo of a mannequin there and describe it ` +
        `(see docs/GATE-TUNING.md, "Self-test"). These fixtures stay local and are never committed.`,
    );
  }
  const cfg = JSON.parse(await fs.readFile(cfgFile, "utf8")) as { figures: SelfTestFixture[] };
  const out: PositiveSpec[] = [];
  for (const fig of cfg.figures ?? []) {
    const file = path.resolve(path.dirname(cfgFile), fig.file);
    if (!existsSync(file)) throw new UsageError(`self-test fixture missing: ${rel(file)}`);
    if (!getSku(fig.sourceSkuId)) throw new UsageError(`self-test: unknown SKU ${fig.sourceSkuId}`);
    const size = requireSize(fig.size ?? "M");
    const base = safeName(path.basename(fig.file).replace(IMAGE_EXT, ""));
    const variants: { person: string; bytes?: Buffer }[] = [{ person: base }];
    if (fig.mirror) variants.push({ person: `${base}-mirrored`, bytes: await sharp(file).rotate().flop().jpeg({ quality: 92 }).toBuffer() });
    for (const v of variants) {
      for (const hex of fig.targets) {
        out.push({
          id: `${v.person}__${hex.replace("#", "").toLowerCase()}`,
          person: v.person,
          personFile: file,
          personBytes: v.bytes,
          ctx: { sourceSkuId: fig.sourceSkuId, size, targetColorHex: hex, sourceColorHex: fig.sourceColorHex ?? "auto" },
          origin: "selftest",
          reviewed: false,
          label: { label: "good", reasons: [] },
          renderFile: null,
          garmentFile: null,
        });
      }
    }
  }
  return out;
}

async function probeInputs(opts: Options, labels: LabelsFile): Promise<{ specs: PositiveSpec[]; problems: string[] }> {
  const problems: string[] = [];
  const lines = (await readProbeResults(opts.resultsFile)).filter((l) => l.status === "success");
  const people = new Map((await listPeople(opts.peopleDir)).map((p) => [p.person, p.file]));
  const wearing = wearingResolver(opts.wearing, labels.wearing);
  const specs: PositiveSpec[] = [];
  for (const l of lines) {
    const id = `${l.person}__${l.sku}${l.variant === "alt" ? "__alt" : ""}`;
    const renderFile = l.out ? path.resolve(ROOT, l.out) : path.join(opts.probeDir, "out", `${id}.jpg`);
    const personFile = people.get(l.person);
    const sku = getSku(l.sku);
    if (!existsSync(renderFile)) {
      problems.push(`${id}: render file missing (${rel(renderFile)})`);
      continue;
    }
    if (!personFile) {
      problems.push(`${id}: no photo for "${l.person}" in ${rel(opts.peopleDir)}`);
      continue;
    }
    if (!sku) {
      problems.push(`${id}: unknown SKU ${l.sku}`);
      continue;
    }
    // Unlabelled renders count as good for the proposal; applyGuard refuses --apply until each is labelled.
    const reviewed = id in labels.renders;
    const label: RenderLabel = labels.renders[id] ?? { label: "good", reasons: [] };
    if (label.label === "skip") continue;
    const w = wearing(l.person);
    const garmentPublic = l.variant === "alt" && sku.altImage ? sku.altImage : sku.image;
    const garmentFile = path.join(ROOT, "public", garmentPublic.replace(/^\/+/, ""));
    specs.push({
      id,
      person: l.person,
      personFile,
      ctx: { sourceSkuId: w.skuId, size: w.size, targetSkuId: sku.id, targetSize: w.size },
      origin: "api",
      label,
      reviewed,
      renderFile,
      garmentFile: existsSync(garmentFile) ? garmentFile : null,
    });
  }
  return { specs, problems };
}

/* ───────────── main ───────────── */

async function main(): Promise<number> {
  let opts: Options | null;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`tune: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (!opts) {
    console.log(HELP);
    return 0;
  }
  const mode: "probe" | "selftest" = opts.selfTest ? "selftest" : "probe";
  const thresholdsFile = opts.thresholdsFile;
  let current: ThresholdsFile;
  try {
    current = parseThresholds(JSON.parse(readFileSync(thresholdsFile, "utf8")));
  } catch (err) {
    console.error(`tune: can't read ${rel(thresholdsFile)}: ${(err as Error).message}`);
    return 2;
  }
  const labels = await readLabels(opts.labelsFile);
  const warnings: string[] = [];

  // Inputs first: fail fast before starting servers.
  let specs: PositiveSpec[] = [];
  if (opts.selfTest) {
    specs = await selfTestInputs();
  } else if (!opts.preflightOnly) {
    const r = await probeInputs(opts, labels);
    specs = r.specs;
    for (const p of r.problems) warnings.push(p);
    if (specs.length === 0) {
      console.error(
        `tune: no successful probe renders found in ${rel(opts.resultsFile)}.\n` +
          `Run the probe first (npm run probe -- --people ${rel(opts.peopleDir)} …), or try the harness with --self-test.` +
          (r.problems.length ? `\nProblems:\n  - ${r.problems.join("\n  - ")}` : ""),
      );
      return 2;
    }
    const unlabelled = specs.filter((s) => !s.reviewed).map((s) => s.id);
    if (unlabelled.length) {
      const tpl = path.join(opts.probeDir, "labels.template.json");
      const body = {
        _help:
          `Copy to labels.json (or merge into it). Open each render in probe/out and replace "${LABEL_TODO}" with "good" if you would show it to a shopper, "bad" if not (optionally {"label":"bad","why":["colour","identity"]}; why words: colour, residue, silhouette, identity, hem, missing), or "skip" to leave it out. "wearing" says which SKU and size each person wears in their photo ("*" = everyone). --apply refuses while any render is unlabelled.`,
        wearing: { "*": opts.wearing ?? DEFAULT_WEARING },
        renders: Object.fromEntries(unlabelled.map((id) => [id, LABEL_TODO])),
      };
      await fs.writeFile(tpl, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      console.log(
        `${unlabelled.length} render(s) not labelled yet: they count as good for this proposal, and --apply is refused until each is labelled. Template: ${rel(tpl)}.`,
      );
    }
  }
  if (opts.limit !== null && specs.length > opts.limit) specs = specs.slice(0, opts.limit);

  const people = opts.preflightOnly ? await listPeople(opts.peopleDir) : [];
  if (opts.preflightOnly && people.length === 0) {
    console.error(`tune: no jpg/png/webp photos in ${rel(opts.peopleDir)}`);
    return 2;
  }

  const server = await startServer(opts);
  let browser: Browser | null = null;
  const cleanup = async () => {
    if (browser) await browser.close().catch(() => undefined);
    browser = null;
    await server.stop();
  };
  process.once("SIGINT", () => {
    console.warn("\nInterrupted: stopping the browser and server…");
    void cleanup().then(() => process.exit(130));
  });

  try {
    browser = await launchChrome({ headless: !opts.headful, width: 1280, height: 900 });
    const page = await openLab(browser, server.base);
    const lab = new Lab(page);
    const env = await lab.info();
    console.log(`Gate lab ready (MediaPipe delegates: pose ${env.delegates.pose ?? "?"}, segmenter ${env.delegates.segmenter ?? "?"})`);

    /* Person photos: one ref each */
    const personRefs = new Map<string, string>();
    const personRef = async (key: string, file: string, bytes?: Buffer) => {
      let ref = personRefs.get(key);
      if (!ref) {
        ref = await lab.put(await dataUrlOf(file, bytes));
        personRefs.set(key, ref);
      }
      return ref;
    };

    /* Preflight on every photo involved (+ synthetic preflight failures) */
    const preflightRows: PreflightRow[] = [];
    const photoList = opts.preflightOnly
      ? people.map((p) => ({ person: p.person, file: p.file, bytes: undefined as Buffer | undefined }))
      : [...new Map(specs.map((s) => [s.person, { person: s.person, file: s.personFile, bytes: s.personBytes }])).values()];
    for (const ph of photoList) {
      const ref = await personRef(ph.person, ph.file, ph.bytes);
      const res = await lab.preflight(ref);
      preflightRows.push({ photo: ph.person, variant: "original", ok: res.ok, failed: res.checks.filter((c) => !c.ok).map((c) => c.id), values: res.values });
      console.log(`preflight ${ph.person}: ${res.ok ? "pass" : `FAIL (${res.checks.filter((c) => !c.ok).map((c) => c.id).join(", ")})`}`);
      for (const kind of PREFLIGHT_NEGATIVE_KINDS) {
        const s = await lab.synth(ref, null, kind, { sourceSkuId: "fw-wrap-dress-mustard", returnDataUrl: opts.saveSynth });
        if (!s.ok || !s.ref) continue;
        if (opts.saveSynth && s.dataUrl) await saveSynth(opts, `${ph.person}__${kind}`, s.dataUrl);
        const r2 = await lab.preflight(s.ref);
        preflightRows.push({ photo: ph.person, variant: kind, ok: r2.ok, failed: r2.checks.filter((c) => !c.ok).map((c) => c.id), values: r2.values });
      }
      if (!res.ok && !opts.preflightOnly) warnings.push(`photo ${ph.person} fails preflight (${res.checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}); the shopper app would ask for a retake`);
    }

    const samples: Sample[] = [];
    const skipped: { id: string; why: string }[] = [];
    const garments = new Map<string, GarmentRow>();
    const metricLines: string[] = [];

    if (!opts.preflightOnly) {
      let i = 0;
      for (const spec of specs) {
        i++;
        const t0 = Date.now();
        const pRef = await personRef(spec.person, spec.personFile, spec.personBytes);
        let renderRef: string;
        let synthInfo: Record<string, unknown> | null = null;
        if (spec.renderFile) {
          renderRef = await lab.put(await dataUrlOf(spec.renderFile));
        } else {
          const s = await lab.synth(pRef, null, "recolour", { ...spec.ctx, seed: spec.id, returnDataUrl: opts.saveSynth });
          if (!s.ok || !s.ref) {
            skipped.push({ id: spec.id, why: s.skipped ?? "recolour failed" });
            continue;
          }
          if (opts.saveSynth && s.dataUrl) await saveSynth(opts, `${spec.id}__good`, s.dataUrl);
          renderRef = s.ref;
          synthInfo = s.info;
        }
        const garmentData = spec.garmentFile ? await dataUrlOf(spec.garmentFile) : null;
        const m = await lab.metrics(pRef, renderRef, garmentData, spec.ctx);
        if (m.garment && spec.ctx.targetSkuId) {
          garments.set(spec.ctx.targetSkuId, { sku: spec.ctx.targetSkuId, catalogueHex: m.garment.catalogueHex, photoHex: m.garment.hex, deltaE: m.garment.deltaE });
        }
        const ctx = { transition: m.transition, colourChangeExpected: m.colourChangeExpected, lengthVariant: m.lengthVariant };
        const isBad = spec.label.label === "bad";
        const pos: Sample = {
          id: spec.id,
          base: spec.id,
          label: isBad ? "negative" : "positive",
          origin: isBad ? "labelled" : spec.origin,
          kind: isBad ? "real" : null,
          ...(isBad ? { reasons: spec.label.reasons as MetricKey[] } : {}),
          ...(spec.origin === "api" ? { reviewed: spec.reviewed } : {}),
          metrics: m.metrics,
          ctx,
        };
        samples.push(pos);
        metricLines.push(JSON.stringify({ ...pos, person: spec.person, target: m.target, source: m.source, debug: m.debug, calibration: m.measurements.calibration, synthInfo }));
        console.log(
          `[${i}/${specs.length}] ${spec.id} (${isBad ? "labelled bad" : "good"}) ΔE ${fmt(m.metrics.colourDeltaE, 1)} res ${fmt(m.metrics.residueFraction, 2)} IoU ${fmt(m.metrics.silhouetteIoU, 2)} id ${fmt(m.metrics.identityDiff, 3)} hem ${fmt(m.metrics.hemErrorCm, 1)} cov ${fmt(m.metrics.garmentCoverage, 2)} → ${m.decision.canRetry.verdict}`,
        );
        if (isBad) continue; // synthetic negatives are built from good renders only

        const plan = planNegatives({
          seed: spec.id,
          kinds: opts.negatives,
          hemApplicable: m.measurements.calibration !== null && m.metrics.hemErrorCm !== null,
          silhouetteApplicable: gateCheckApplies("silhouetteIoU", ctx),
        });
        for (const n of plan) {
          const nid = `${spec.id}#${n.id}`;
          const s = await lab.synth(pRef, n.kind === "silhouette" ? null : renderRef, n.kind === "silhouette" ? "silhouette" : n.kind, {
            ...spec.ctx,
            ...n.params,
            seed: nid,
            returnDataUrl: opts.saveSynth,
          });
          if (!s.ok || !s.ref) {
            skipped.push({ id: nid, why: s.skipped ?? "failed" });
            continue;
          }
          if (opts.saveSynth && s.dataUrl) await saveSynth(opts, nid.replace("#", "__"), s.dataUrl);
          const nm = await lab.metrics(pRef, s.ref, null, spec.ctx);
          const neg: Sample = { id: nid, base: spec.id, label: "negative", origin: "synthetic", kind: n.kind, metrics: nm.metrics, ctx };
          samples.push(neg);
          metricLines.push(JSON.stringify({ ...neg, params: n.params, synthInfo: s.info }));
        }
        console.log(`      + ${plan.length} synthetic variants (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      }
    }

    /* Catalogue colour warnings */
    for (const g of garments.values()) {
      if (g.deltaE > CATALOGUE_COLOUR_WARN_DE) {
        warnings.push(`${g.sku}: product photo colour ${g.photoHex} is ΔE00 ${g.deltaE.toFixed(1)} from colorHex ${g.catalogueHex}; update colorHex in lib/catalog.ts before trusting the colour threshold`);
      }
    }

    const at = new Date().toISOString();
    const proposal = propose(samples, current, opts.maxFalseFlag);
    const guard = opts.preflightOnly ? { ok: false, reason: "preflight-only run" } : applyGuard(samples, mode);
    let applied: { file: string; diff: string[] } | null = null;

    if (opts.apply && !opts.preflightOnly) {
      if (!guard.ok) {
        console.error(`\ntune: --apply refused: ${guard.reason}.`);
      } else {
        const next = buildThresholdsFile(current, proposal, {
          at,
          source: `npm run tune on ${samples.filter((s) => s.origin === "api").length} good real render(s) (${at.slice(0, 10)})`,
          tuning: {
            report: rel(opts.reportFile),
            goodRenders: samples.filter((s) => s.origin === "api").length,
            labelledBad: samples.filter((s) => s.origin === "labelled").length,
            syntheticNegatives: samples.filter((s) => s.origin === "synthetic").length,
            maxFalseFlag: opts.maxFalseFlag,
            previous: { gate: current.gate, gateSevere: current.gateSevere },
          },
        });
        const diff = diffThresholds(current, next);
        const backup = path.join(opts.probeDir, `thresholds.backup-${at.replace(/[:.]/g, "-")}.json`);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(thresholdsFile, backup);
        await fs.writeFile(thresholdsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        applied = { file: rel(thresholdsFile), diff };
        console.log(`\nApplied to ${rel(thresholdsFile)} (backup: ${rel(backup)})`);
        console.log(diff.length ? diff.map((d) => `  ${d}`).join("\n") : "  (no threshold changed)");
        console.log(
          "Run npm test. thresholds.json is bundled into the browser code, so restart npm run dev, or rebuild (npm run build) / redeploy a production server, to use the new thresholds.",
        );
      }
    }

    const report = renderReport({
      mode: opts.preflightOnly ? "preflight" : mode,
      at,
      current,
      proposal,
      samples,
      guard,
      applied,
      skipped,
      preflight: preflightRows,
      garments: [...garments.values()],
      warnings,
      environment: {
        "MediaPipe delegates": `pose ${env.delegates.pose ?? "?"}, segmenter ${env.delegates.segmenter ?? "?"}`,
        Browser: env.userAgent.replace(/^Mozilla\/5\.0 /, ""),
        Server: opts.base ? opts.base : `next dev (NEXT_DIST_DIR=${opts.distDir})`,
        Labels: opts.labelsFile ? rel(opts.labelsFile) : "none (unlabelled renders count as good; --apply refused until each is labelled)",
        "Thresholds file": rel(thresholdsFile),
      },
    });
    await fs.mkdir(path.dirname(opts.reportFile), { recursive: true });
    await fs.writeFile(opts.reportFile, report, "utf8");
    if (metricLines.length) await fs.writeFile(opts.metricsFile, `${metricLines.join("\n")}\n`, "utf8");

    // Console summary
    console.log(`\nReport: ${rel(opts.reportFile)}${metricLines.length ? ` · metrics: ${rel(opts.metricsFile)}` : ""}`);
    if (!opts.preflightOnly) {
      console.log("\nmetric            current   proposed  status");
      for (const c of proposal.choices) {
        console.log(`${c.spec.label.padEnd(18)}${fmt(c.current, c.spec.decimals).padStart(8)}  ${fmt(c.proposed, c.spec.decimals + 1).padStart(8)}  ${c.status}`);
      }
      if (!opts.apply) console.log(guard.ok ? "\nRe-run with --apply to write these." : `\n--apply would be refused: ${guard.reason}.`);
    }
    for (const w of warnings) console.warn(`warning: ${w}`);
    return opts.apply && !guard.ok && !opts.preflightOnly ? 1 : 0;
  } finally {
    await cleanup();
  }
}

async function saveSynth(opts: Options, name: string, dataUrl: string): Promise<void> {
  const dir = opts.selfTest ? path.resolve(ROOT, FIXTURES_DIR, "synth") : path.join(opts.probeDir, "tune-synth");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${safeName(name)}.jpg`), Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
}

let finished = false;
process.on("beforeExit", () => {
  if (!finished) {
    finished = true;
    console.error("tune: exited before finishing");
    process.exitCode = 1;
  }
});

main().then(
  (code) => {
    finished = true;
    process.exitCode = code;
  },
  (err: unknown) => {
    finished = true;
    console.error(`tune: ${err instanceof UsageError ? err.message : err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);
