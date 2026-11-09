// Day-1 probe matrix: person photos × SKUs through the LIVE Clothsy API, measuring what the
// docs don't say (output size/aspect, replay headers, account shape) before the demo.
//
//   npm run probe -- --dry-run          (plan + input checks, no API calls)
//   npm run probe -- --i-have-consent --people probe/people --max-credits 7 --check-replay
//
// - Without --skus it picks two SKUs whose product images are photos (the same pick as
//   npm run doctor), and a live run refuses generated drawings unless --allow-drawings.
//
// - Refuses to upload without --i-have-consent (we send consent:true for every try-on).
// - Reads GET /account first (free) and refuses a plan that could exceed the account's credits
//   or --max-credits (default 4). Prints the plan and its worst-case cost.
// - Writes result images byte-for-byte (keeps the XMP AI label) to probe/out/<person>__<sku>.<ext>,
//   appends JSON lines to probe/results.jsonl, and writes probe/REPORT.md + probe/observed.json.
// - --check-replay re-sends ONE successful pair with the same Idempotency-Key and compares credits.
// - Uses ClothsyProvider directly, so the process-wide rate limits and retry policy apply.
// - Idempotency keys derive from (pipeline version, photo, product shot, SKU, variant), so
//   re-running a pair replays the finished try-on instead of charging again.
//
// Only photos of consenting adults. Photos go to the try-on API only, never to an LLM.

import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { loadProjectEnv } from "./lib/env";
import { classifyCatalogFile } from "./lib/imaging";
import {
  PERSON_FILE_RE,
  PROBE_HELP,
  UsageError,
  aspectDeltaPct,
  buildPlan,
  creditDecision,
  DEFAULT_SKUS,
  PROBE_SKU_PREFERENCE,
  suggestProbeSkus,
  describeJsonShape,
  extensionFor,
  hasAiLabel,
  paddingVerdict,
  parseProbeArgs,
  percentile,
  personLabels,
  renderBudgetFor,
  renderReport,
  replayVerdict,
  uniformSides,
  validatePersonPhoto,
  type AccountSnapshot,
  type ObservedRender,
  type PlanPair,
  type ProbeObserved,
  type ReplayCheck,
  type Variant,
} from "./lib/probe-core";

const ROOT = process.cwd();
const PERSON_MAX_SIDE = 1600;
const PERSON_MAX_BYTES = 3_800_000;
const OUT_EXTS = ["jpg", "png", "webp"] as const;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** Project-relative when inside the project, else absolute. */
const rel = (p: string) => {
  const r = path.relative(ROOT, p);
  return !r ? "." : r.startsWith("..") ? p : r;
};
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

/** Same normalisation the browser applies: EXIF-correct, ≤1600 px, JPEG, < 3.8 MB, metadata dropped. */
async function normalisePerson(file: string): Promise<Buffer> {
  const src = await fs.readFile(file);
  for (const [side, quality] of [
    [PERSON_MAX_SIDE, 90],
    [PERSON_MAX_SIDE, 82],
    [1280, 82],
    [1024, 80],
  ] as const) {
    const out = await sharp(src)
      .rotate()
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({ quality })
      .toBuffer();
    if (out.length < PERSON_MAX_BYTES) return out;
  }
  throw new Error(`${path.basename(file)} could not be compressed under 3.8 MB`);
}

/** Pixel size as displayed (EXIF orientations 5–8 swap width and height). */
async function displayDims(bytes: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(bytes).metadata();
  const swap = (m.orientation ?? 1) >= 5;
  return { width: (swap ? m.height : m.width) ?? 0, height: (swap ? m.width : m.height) ?? 0 };
}

async function edgeSides(bytes: Buffer) {
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize({ width: 256, height: 256, fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return uniformSides(data, info.width, info.height, info.channels);
}

function existingOutput(outBase: string): string | null {
  for (const ext of OUT_EXTS) if (existsSync(`${outBase}.${ext}`)) return `${outBase}.${ext}`;
  return null;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd()).join("\n");
}

interface ResultLine {
  at: string;
  person: string;
  sku: string;
  variant: Variant;
  status: "success" | "failed";
  code: string | null;
  message: string | null;
  latencyMs: number | null;
  creditCharged: boolean;
  replayed: boolean | null;
  externalId: string | null;
  bytes: number | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  aspectDeltaPct: number | null;
  out: string | null;
  apiVersion: string;
  replayCheck?: boolean;
}

async function main(): Promise<number> {
  const env = loadProjectEnv(ROOT);

  let opts;
  try {
    opts = parseProbeArgs(process.argv.slice(2), ROOT);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`probe: ${err.message}\n\n${PROBE_HELP}`);
      return 2;
    }
    throw err;
  }
  if (!opts) {
    console.log(PROBE_HELP);
    return 0;
  }

  // Imported after the env is loaded: lib/store resolves TRYBACK_DATA_DIR at import time.
  const { getSku, SKUS } = await import("../lib/catalog");
  const { config } = await import("../lib/config");
  const { ClothsyProvider, REPLAY_HEADER_CANDIDATES, fetchClothsyAccount } = await import("../lib/tryon/clothsy");
  type Observation = import("../lib/tryon/clothsy").ClothsyObservation;
  const { loadGarmentImage, garmentPublicPath, garmentFilePath } = await import("../lib/tryon/garment");
  const { API_VERSION } = await import("../lib/tryon");
  const { isTryOnError } = await import("../lib/tryon/types");

  console.log(`TryBack probe · pipeline ${API_VERSION} · ${opts.dryRun ? "DRY RUN (no API calls)" : "LIVE (spends credits)"}`);
  if (env.files.length) console.log(`Env: ${env.files.join(", ")} (${env.loaded.length} variable(s) loaded; the environment wins)`);

  // SKUs: --skus, else two SKUs whose product images are photos (the same pick as npm run doctor).
  let skuIds = opts.skuIds;
  if (skuIds === null) {
    const isPhoto = new Map<string, boolean>();
    for (const id of new Set([...PROBE_SKU_PREFERENCE, ...DEFAULT_SKUS.split(",")])) {
      const sku = getSku(id);
      if (!sku) continue;
      const kind = await classifyCatalogFile(garmentFilePath(garmentPublicPath(sku, "primary")));
      isPhoto.set(id, kind === "imported" || kind === "photo");
    }
    skuIds = suggestProbeSkus((id) => isPhoto.get(id) === true);
    console.log(`SKUs: ${skuIds.join(", ")} (picked automatically: product images that are photos; --skus to choose others)`);
  }
  const unknown = skuIds.filter((id) => !getSku(id));
  if (unknown.length) {
    console.error(`probe: unknown SKU(s): ${unknown.join(", ")}\nKnown SKUs:\n  ${SKUS.map((s) => s.id).join("\n  ")}`);
    return 2;
  }
  const skus = skuIds.map((id) => getSku(id)!);

  // People
  let peopleFiles: string[];
  try {
    peopleFiles = (await fs.readdir(opts.peopleDir))
      .filter((f) => PERSON_FILE_RE.test(f) && !f.startsWith("."))
      .sort()
      .map((f) => path.join(opts.peopleDir, f));
  } catch {
    console.error(
      `probe: people folder not found: ${rel(opts.peopleDir)}\n` +
        `Create it and add 3 full-body, front-facing JPEG photos of consenting adults (≥600 px short side; 3 people × 2 SKUs = the 6 renders npm run tune needs).`,
    );
    return 2;
  }
  if (peopleFiles.length === 0) {
    console.error(`probe: no photos in ${rel(opts.peopleDir)} (JPEG or PNG of consenting adults)`);
    return 2;
  }

  // Input checks (both modes). Blocking problems stop a live run before any API call.
  const blocking: string[] = [];
  const notes: string[] = [];
  const rejected = new Set<string>();
  for (const f of peopleFiles) {
    try {
      const fh = await fs.open(f, "r");
      const head = Buffer.alloc(16);
      try {
        await fh.read(head, 0, 16, 0);
      } finally {
        await fh.close();
      }
      let dims: { width: number; height: number } | null = null;
      try {
        dims = await displayDims(await fs.readFile(f));
      } catch {
        dims = null;
      }
      const problem = validatePersonPhoto({ name: path.basename(f), head, width: dims?.width, height: dims?.height });
      if (problem) {
        blocking.push(problem);
        rejected.add(f);
      }
    } catch (err) {
      blocking.push(`${path.basename(f)}: ${(err as Error).message}`);
      rejected.add(f);
    }
  }
  for (const sku of skus) {
    for (const variant of opts.variants) {
      if (variant === "alt" && !sku.altImage) notes.push(`${sku.id} has no alt image; alt uses the primary shot`);
      const file = garmentFilePath(garmentPublicPath(sku, variant));
      if (!existsSync(file)) {
        blocking.push(`missing garment image ${rel(file)} (run "npm run assets" or add a real product photo)`);
        continue;
      }
      try {
        // The TryBack tEXt marker tells imported photos (same 768×1024 frame) from placeholders.
        if ((await classifyCatalogFile(file)) === "placeholder") {
          const why = `${rel(file)} is a generated drawing; Clothsy may reject it or render it badly, and those renders are no use for npm run tune`;
          if (opts.allowDrawings) notes.push(`${why} (rendering it anyway: --allow-drawings)`);
          else {
            blocking.push(
              `${why}. Photograph the garment (README → Product photos), drop --skus to let the probe pick photographed SKUs, or pass --allow-drawings`,
            );
          }
        }
      } catch (err) {
        blocking.push(`${rel(file)}: ${(err as Error).message}`);
      }
    }
  }

  // Plan: breadth-first, capped by --max-credits (minus 1 reserved for --check-replay).
  // Rejected photos are left out of the plan (and a live run refuses until they're fixed).
  const people = personLabels(peopleFiles).filter((p) => !rejected.has(p.personFile));
  const renderBudget = renderBudgetFor(opts.maxCredits, opts.checkReplay);
  const pairs = buildPlan({
    people,
    skuIds,
    variants: opts.variants,
    outDir: opts.outDir,
    force: opts.force,
    renderBudget,
    existing: existingOutput,
  });
  const toRun = pairs.filter((p) => p.action === "run");
  const skipped = pairs.filter((p) => p.action === "skip-existing").length;
  const deferred = pairs.filter((p) => p.action === "defer-budget").length;
  const estimate = toRun.length + (opts.checkReplay ? 1 : 0);

  console.log(
    `\nPlan: ${people.length} photo(s) × ${skus.length} SKU(s) × ${opts.variants.length} shot(s) = ${pairs.length} pair(s)` +
      (rejected.size ? ` (${rejected.size} photo(s) excluded, see below)` : "") +
      "\n",
  );
  console.log(
    table([
      ["#", "person", "sku", "shot", "action"],
      ...pairs.map((p, i) => [
        String(i + 1),
        p.person,
        p.skuId,
        p.variant,
        p.action === "run"
          ? "render (≤1 credit)"
          : p.action === "skip-existing"
            ? `skip (${rel(p.existing!)} exists; --force to redo)`
            : `deferred (over --max-credits ${opts.maxCredits})`,
      ]),
    ]),
  );
  console.log(
    `\nEstimated cost: up to ${estimate} credit(s) = ${toRun.length} render(s)` +
      (opts.checkReplay ? " + 1 possible replay-check credit" : "") +
      ` · cap --max-credits ${opts.maxCredits}` +
      (skipped ? ` · ${skipped} skipped` : "") +
      (deferred ? ` · ${deferred} deferred (raise --max-credits to include them)` : ""),
  );
  if (notes.length) console.log(`\nNotes:\n  - ${notes.join("\n  - ")}`);
  if (blocking.length) console.log(`\nMust fix before a live run:\n  - ${blocking.join("\n  - ")}`);

  if (opts.dryRun) {
    if (!opts.consent) console.log("\nA live run also needs --i-have-consent (or --ai-people if every photo shows an AI-generated person).");
    console.log(`\nDry run: nothing was uploaded and no credits were used.`);
    return blocking.length ? 1 : 0;
  }
  if (blocking.length) {
    console.error(`\nprobe: fix the problems above first (nothing was uploaded).`);
    return 2;
  }
  if (!opts.consent) {
    console.error(
      `\nprobe: refusing to upload without --i-have-consent (or --ai-people for AI-generated people).\n` +
        `Add it only if every person in ${rel(opts.peopleDir)} is an adult (18+) who agreed to their photo being sent\n` +
        `to Clothsy AI to create virtual try-on images. TryBack sends consent:true with each try-on on that basis.\n` +
        `Clothsy deletes uploaded photos within 35 days; results are saved in ${rel(opts.outDir)} (never commit them).`,
    );
    return 2;
  }
  if (toRun.length === 0 && !opts.checkReplay) {
    console.log("\nNothing to render.");
    return 0;
  }
  if (!config.clothsyApiKey) {
    console.error(`\nprobe: CLOTHSY_API_KEY is not set (add it to .env.local, then run npm run doctor).`);
    return 2;
  }

  const snapshot = async (): Promise<AccountSnapshot> => {
    const r = await fetchClothsyAccount();
    const at = new Date().toISOString();
    return r.ok
      ? { at, ok: true, httpStatus: r.httpStatus, credits: r.credits, scope: r.scope, code: null, message: null, shape: describeJsonShape(r.body) }
      : { at, ok: false, httpStatus: r.httpStatus, credits: null, scope: null, code: r.code, message: r.message, shape: null };
  };

  const accountBefore = await snapshot();
  if (!accountBefore.ok) {
    console.error(`\nprobe: GET /account failed: ${accountBefore.code} ${accountBefore.message}\nRun npm run doctor for the fix.`);
    if (!opts.skipCreditCheck) return 2;
  } else {
    console.log(`\nAccount: ${accountBefore.credits ?? "?"} credit(s) left (scope ${accountBefore.scope ?? "?"})`);
  }
  const decision = creditDecision({
    renders: toRun.length,
    checkReplay: opts.checkReplay,
    maxCredits: opts.maxCredits,
    credits: accountBefore.credits,
    skipCreditCheck: opts.skipCreditCheck,
  });
  if (!decision.ok) {
    console.error(`probe: refusing to run: ${decision.reason}.`);
    return 2;
  }

  await fs.mkdir(opts.outDir, { recursive: true });
  await fs.mkdir(path.dirname(opts.resultsFile), { recursive: true });

  // Prepare each person photo once.
  const personCache = new Map<string, Promise<{ bytes: Buffer; hash: string }>>();
  const personInput = (file: string) => {
    let p = personCache.get(file);
    if (!p) {
      p = normalisePerson(file).then((bytes) => ({ bytes, hash: sha256(bytes) }));
      personCache.set(file, p);
    }
    return p;
  };

  // Observations are routed to the render they belong to (renders run concurrently).
  const byKey = new Map<string, ObservedRender>();
  const byTryOn = new Map<string, ObservedRender>();
  const downloadTypeHeader = new Map<string, string | null>();
  const onEvent = (e: Observation) => {
    if (e.kind === "start") {
      const r = byKey.get(e.idempotencyKey) ?? byKey.get(e.idempotencyKey.replace(/_u1$/, ""));
      if (!r) return;
      r.start = {
        httpStatus: e.httpStatus,
        attempt: e.attempt,
        bodyStatus: e.bodyStatus,
        pollUrl: e.pollUrl,
        replaySignal: e.replaySignal,
        headers: e.headers,
      };
      byTryOn.set(e.tryOnId, r);
    } else if (e.kind === "poll") {
      const r = byTryOn.get(e.tryOnId);
      if (r) r.polls++;
    } else {
      const r = byTryOn.get(e.tryOnId);
      if (r) r.downloadHeaders = e.headers;
      downloadTypeHeader.set(e.tryOnId, e.contentTypeHeader);
    }
  };

  const ctrl = new AbortController();
  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
    console.warn("\nInterrupted: aborting in-flight renders (try-ons already started may still finish and be charged).");
    ctrl.abort();
  });

  const provider = new ClothsyProvider({ onEvent });
  const observed: ObservedRender[] = [];

  /** Render one pair, write its output and observations. */
  const renderPair = async (pair: PlanPair, label: string, replayCheck = false): Promise<ObservedRender> => {
    const sku = getSku(pair.skuId)!;
    const rec: ObservedRender = {
      person: pair.person,
      sku: pair.skuId,
      variant: pair.variant,
      status: "failed",
      code: null,
      message: null,
      latencyMs: null,
      creditCharged: null,
      replayed: null,
      input: null,
      output: null,
      aspectDeltaPct: null,
      start: null,
      polls: 0,
      downloadHeaders: null,
    };
    let outRel: string | null = null;
    let externalId: string | null = null;
    try {
      const [person, garment] = await Promise.all([personInput(pair.personFile), loadGarmentImage(sku, pair.variant)]);
      const inputDims = await displayDims(person.bytes);
      rec.input = { ...inputDims, bytes: person.bytes.length };
      const idempotencyKey = `probe_${sha256(`${API_VERSION}|${person.hash}|${garment.hash}|${sku.id}|${pair.variant}`).slice(0, 40)}`;
      byKey.set(idempotencyKey, rec);
      console.log(`${label} … ${replayCheck ? "re-sending with the same Idempotency-Key" : "rendering"}`);
      const out = await provider.render(
        {
          personBytes: person.bytes,
          personHash: person.hash,
          garmentBytes: garment.bytes,
          garmentHash: garment.hash,
          title: sku.apiTitle,
          idempotencyKey,
        },
        ctrl.signal,
      );
      externalId = out.externalId;
      // Byte-for-byte, so Clothsy's XMP AI label survives (docs: don't re-save through an image library).
      const file = `${pair.outBase}${replayCheck ? "__replay" : ""}.${extensionFor(out.contentType)}`;
      await fs.writeFile(file, out.bytes);
      outRel = rel(file);
      const outDims = await displayDims(out.bytes);
      const padding = paddingVerdict(await edgeSides(person.bytes), await edgeSides(out.bytes));
      Object.assign(rec, {
        status: "success",
        latencyMs: out.latencyMs,
        creditCharged: out.creditCharged,
        replayed: out.replayed ?? false,
        aspectDeltaPct: aspectDeltaPct(inputDims, outDims),
        output: {
          file: outRel,
          ...outDims,
          bytes: out.bytes.length,
          contentType: out.contentType,
          contentTypeHeader: out.externalId ? (downloadTypeHeader.get(out.externalId) ?? null) : null,
          aiLabel: hasAiLabel(out.bytes),
          padded: padding.padded,
          paddedSides: padding.sides,
        },
      } satisfies Partial<ObservedRender>);
      console.log(
        `${label} ✓ ${secs(out.latencyMs)} · ${outDims.width}×${outDims.height} ${out.contentType} → ${outRel}` +
          (out.replayed ? " (replayed, no new credit)" : ""),
      );
    } catch (err) {
      rec.code = isTryOnError(err) ? err.code : "ERROR";
      rec.message = err instanceof Error ? err.message : String(err);
      console.log(`${label} ✗ ${rec.code}: ${rec.message}`);
    }
    const line: ResultLine = {
      at: new Date().toISOString(),
      person: rec.person,
      sku: rec.sku,
      variant: rec.variant,
      status: rec.status,
      code: rec.code,
      message: rec.message,
      latencyMs: rec.latencyMs,
      creditCharged: rec.creditCharged === true,
      replayed: rec.replayed,
      externalId,
      bytes: rec.output?.bytes ?? null,
      contentType: rec.output?.contentType ?? null,
      width: rec.output?.width ?? null,
      height: rec.output?.height ?? null,
      aspectDeltaPct: rec.aspectDeltaPct,
      out: outRel,
      apiVersion: API_VERSION,
      ...(replayCheck ? { replayCheck: true } : {}),
    };
    await fs.appendFile(opts.resultsFile, `${JSON.stringify(line)}\n`, "utf8");
    return rec;
  };

  // Main matrix.
  let started = 0;
  let next = 0;
  const total = toRun.length;
  const worker = async () => {
    for (;;) {
      if (ctrl.signal.aborted) return;
      const i = next++;
      if (i >= total) return;
      if (started >= renderBudget) return; // hard budget guard
      started++;
      const pair = toRun[i]!;
      const rec = await renderPair(pair, `[${i + 1}/${total}] ${pair.person} × ${pair.skuId}${pair.variant === "alt" ? " (alt)" : ""}`);
      observed.push(rec);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, total) }, () => worker()));

  // Optional replay check: ONE already-successful pair, same Idempotency-Key, credits before/after.
  let replayCheck: ReplayCheck | null = null;
  if (opts.checkReplay && !ctrl.signal.aborted) {
    const fromRun = toRun.find((p) => observed.some((r) => r.status === "success" && r.person === p.person && r.sku === p.skuId && r.variant === p.variant));
    const candidate = fromRun ?? pairs.find((p) => p.action === "skip-existing") ?? null;
    if (!candidate) {
      console.log("\n--check-replay: no successful pair to re-send, skipped (0 credits).");
    } else {
      console.warn(
        `\n--check-replay: re-sending ${candidate.person} × ${candidate.skuId} with the same Idempotency-Key.\n` +
          `WARNING: if the API does not dedupe keys, this costs 1 credit (it is within --max-credits ${opts.maxCredits}).`,
      );
      const before = await snapshot();
      const rec = await renderPair(candidate, `[replay] ${candidate.person} × ${candidate.skuId}`, true);
      const after = await snapshot();
      const verdict = replayVerdict({ ok: rec.status === "success", before: before.credits, after: after.credits });
      const key = [...byKey.entries()].find(([, r]) => r === rec)?.[0] ?? "?";
      replayCheck = {
        person: candidate.person,
        sku: candidate.skuId,
        variant: candidate.variant,
        idempotencyKey: key,
        creditsBefore: before.credits,
        creditsAfter: after.credits,
        status: rec.status,
        code: rec.code,
        replayedFlag: rec.replayed,
        start: rec.start,
        ...verdict,
      };
      console.log(`Replay check: ${verdict.verdict.toUpperCase()}: ${verdict.text}`);
    }
  }

  const accountAfter = await snapshot();

  const report: ProbeObserved = {
    generatedAt: new Date().toISOString(),
    apiVersion: API_VERSION,
    apiBase: config.clothsyApiBase,
    options: {
      skus: skuIds,
      variants: opts.variants,
      maxCredits: opts.maxCredits,
      concurrency: opts.concurrency,
      checkReplay: opts.checkReplay,
      aiPeople: opts.aiPeople,
    },
    plan: { pairs: pairs.length, rendered: observed.length, skipped, deferred, estimatedCredits: decision.estimated },
    accountBefore,
    accountAfter,
    renders: observed,
    replayCheck,
    interrupted,
  };
  await fs.mkdir(path.dirname(opts.observedFile), { recursive: true });
  await fs.writeFile(opts.observedFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.mkdir(path.dirname(opts.reportFile), { recursive: true });
  await fs.writeFile(opts.reportFile, renderReport(report, REPLAY_HEADER_CANDIDATES), "utf8");

  // Summary
  const ok = observed.filter((r) => r.status === "success");
  const failed = observed.filter((r) => r.status === "failed");
  const latencies = ok.map((r) => r.latencyMs!).sort((a, b) => a - b);
  const byCode = new Map<string, number>();
  for (const f of failed) byCode.set(f.code ?? "ERROR", (byCode.get(f.code ?? "ERROR") ?? 0) + 1);
  const used =
    accountBefore.credits !== null && accountAfter.credits !== null ? accountBefore.credits - accountAfter.credits : null;
  console.log(
    `\nDone${interrupted ? " (interrupted)" : ""}: ${ok.length} ok, ${failed.length} failed` +
      ` · credits used ${used ?? "?"} (client counted ${ok.filter((r) => r.creditCharged).length + (replayCheck?.verdict === "charged" ? 1 : 0)})` +
      ` · latency p50 ${secs(percentile(latencies, 50))}, p95 ${secs(percentile(latencies, 95))}`,
  );
  if (byCode.size) console.log(`Failures: ${[...byCode].map(([c, n]) => `${c}×${n}`).join(", ")}`);
  console.log(`Images: ${rel(opts.outDir)} · log: ${rel(opts.resultsFile)}`);
  console.log(`Report: ${rel(opts.reportFile)} (read the Recommendations section) · data: ${rel(opts.observedFile)}`);
  return failed.length || interrupted || replayCheck?.verdict === "charged" ? 1 : 0;
}

let finished = false;
process.on("beforeExit", () => {
  if (!finished) {
    finished = true;
    console.error("probe: exited before finishing (event loop drained unexpectedly)");
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
    console.error("probe: fatal:", err);
    process.exitCode = 1;
  },
);
