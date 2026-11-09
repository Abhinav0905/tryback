// Pure parts of scripts/probe.ts: options, plan, budget, photo checks, image analysis and the
// REPORT.md / observed.json content. No network, no file writes (unit-tested in tests/probe.test.ts).

import path from "node:path";
import { parseArgs } from "node:util";

/**
 * Fallback SKUs when fewer than two preferred SKUs have photographed product images. Without
 * --skus the probe picks SKUs with suggestProbeSkus(), i.e. photographed garments first.
 */
export const DEFAULT_SKUS = "fw-wrap-dress-emerald,fw-aline-midi-cobalt";

/**
 * SKUs worth probing, best first: the ones the hero demo renders (order 1042, Wrap Dress —
 * Mustard M, "Style or colour" with the "Colour isn't me" + "Too clingy" chips: speculative
 * fw-aline-midi-black + fw-wrap-dress-navy, then fw-aline-midi-cobalt, fw-shift-dress-navy and
 * fw-shirt-dress-rust after the form), then the other dresses.
 */
export const PROBE_SKU_PREFERENCE: readonly string[] = [
  "fw-aline-midi-black",
  "fw-wrap-dress-navy",
  "fw-aline-midi-cobalt",
  "fw-shift-dress-navy",
  "fw-shirt-dress-rust",
  "fw-wrap-dress-emerald",
  "fw-shirt-dress-sage",
  "fw-shift-dress-terracotta",
  "fw-aline-midi-sage",
  "fw-shirt-dress-ecru",
];

/**
 * The `--skus` to suggest: the first `n` preferred SKUs whose product image is a real photo
 * (imported or hand-placed, not a generated drawing), topped up from DEFAULT_SKUS when fewer
 * than `n` are photos, so credits go on photographed garments whenever there are any.
 */
export function suggestProbeSkus(isPhoto: (skuId: string) => boolean, n = 2): string[] {
  const photos = PROBE_SKU_PREFERENCE.filter(isPhoto);
  const fill = DEFAULT_SKUS.split(",").filter((id) => !photos.includes(id));
  return [...photos, ...fill].slice(0, n);
}
export const DEFAULT_MAX_CREDITS = 4;
/** Person photos below this on the short side are refused before any upload. */
export const MIN_PERSON_SHORT_SIDE = 600;
/** Files the probe looks at in --people. Only JPEG and PNG are accepted (the API's formats). */
export const PERSON_FILE_RE = /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?|avif)$/i;
/** The gate centre-crops a render whose aspect differs from the photo's by more than this. */
export const GATE_ASPECT_TOLERANCE_PCT = 2;

export const PROBE_HELP = `TryBack probe: run person photos × SKUs through the LIVE Clothsy try-on API.

Usage:
  npm run probe -- --i-have-consent [options]

Required for a live run:
  --i-have-consent      Confirms every person in --people is an adult who agreed to their
                        photo being sent to Clothsy AI for virtual try-on (we send consent:true)
  --ai-people           Instead of --i-have-consent: every photo in --people shows an AI-generated
                        person (no real person's likeness); the report records this

Options:
  --people <dir>        Folder of person photos (JPEG or PNG, ≥${MIN_PERSON_SHORT_SIDE} px short side)   [probe/people]
  --skus <a,b,...>      Comma-separated SKU ids      [two SKUs whose product images are photos,
                        preferring the hero demo's renders; npm run doctor prints the same pick]
  --allow-drawings      Let a live run render SKUs whose product image is still a generated
                        drawing (refused by default: Clothsy may reject it or render it badly)
  --max-credits <n>     Hard cap on credits this run may use          [${DEFAULT_MAX_CREDITS}]
  --variant <v>         primary | alt | both (garment product shot)   [primary]
  --concurrency <n>     Parallel renders (1-4; rate limits still apply) [2]
  --check-replay        After the run, re-submit ONE successful pair with the same
                        Idempotency-Key and compare account credits (may cost 1 credit
                        if the API does not dedupe; counted against --max-credits)
  --skip-credit-check   Run even if GET /account doesn't report credits (not recommended)
  --out <dir>           Output folder for result images               [probe/out]
  --results <file>      JSONL log to append to                        [probe/results.jsonl]
  --report <file>       Markdown report                               [probe/REPORT.md]
  --observed <file>     Machine-readable observations                 [probe/observed.json]
  --force               Re-run pairs whose output image already exists (a re-run replays
                        the earlier try-on for free if the API dedupes the key)
  --dry-run             Print the plan and check inputs; no API calls, no credits
  -h, --help            Show this help

Photos go to the try-on API only, never to an LLM. Never use anyone's photo without consent.`;

export class UsageError extends Error {}

export type Variant = "primary" | "alt";

export interface ProbeOptions {
  peopleDir: string;
  /** null: pick automatically (suggestProbeSkus over the photographed catalogue images). */
  skuIds: string[] | null;
  allowDrawings: boolean;
  maxCredits: number;
  variants: Variant[];
  concurrency: number;
  outDir: string;
  resultsFile: string;
  reportFile: string;
  observedFile: string;
  force: boolean;
  dryRun: boolean;
  consent: boolean;
  /** --ai-people: the person photos are AI-generated (counts as the consent step). */
  aiPeople: boolean;
  checkReplay: boolean;
  skipCreditCheck: boolean;
}

/** Parse CLI args. Returns null for --help. Throws UsageError on bad input. */
export function parseProbeArgs(argv: string[], root: string = process.cwd()): ProbeOptions | null {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        people: { type: "string", default: "probe/people" },
        skus: { type: "string" },
        "allow-drawings": { type: "boolean", default: false },
        "max-credits": { type: "string", default: String(DEFAULT_MAX_CREDITS) },
        variant: { type: "string", default: "primary" },
        concurrency: { type: "string", default: "2" },
        out: { type: "string", default: "probe/out" },
        results: { type: "string", default: "probe/results.jsonl" },
        report: { type: "string", default: "probe/REPORT.md" },
        observed: { type: "string", default: "probe/observed.json" },
        force: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "i-have-consent": { type: "boolean", default: false },
        "ai-people": { type: "boolean", default: false },
        "check-replay": { type: "boolean", default: false },
        "skip-credit-check": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (values.help) return null;

  const maxCredits = Number(values["max-credits"]);
  if (!Number.isInteger(maxCredits) || maxCredits < 0) {
    throw new UsageError(`--max-credits must be a non-negative integer (got "${values["max-credits"]}")`);
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new UsageError(`--concurrency must be 1-4 (got "${values.concurrency}")`);
  }
  const variant = values.variant;
  if (variant !== "primary" && variant !== "alt" && variant !== "both") {
    throw new UsageError(`--variant must be primary, alt or both (got "${variant}")`);
  }
  const skuIds = values.skus === undefined ? null : [...new Set(values.skus.split(",").map((s) => s.trim()).filter(Boolean))];
  if (skuIds !== null && skuIds.length === 0) throw new UsageError("--skus needs at least one SKU id");
  if (values["check-replay"] && maxCredits < 1) {
    throw new UsageError("--check-replay needs --max-credits of at least 1 (the replay may cost 1 credit)");
  }

  return {
    peopleDir: path.resolve(root, values.people),
    skuIds,
    allowDrawings: values["allow-drawings"],
    maxCredits,
    variants: variant === "both" ? ["primary", "alt"] : [variant],
    concurrency,
    outDir: path.resolve(root, values.out),
    resultsFile: path.resolve(root, values.results),
    reportFile: path.resolve(root, values.report),
    observedFile: path.resolve(root, values.observed),
    force: values.force,
    dryRun: values["dry-run"],
    consent: values["i-have-consent"] || values["ai-people"],
    aiPeople: values["ai-people"],
    checkReplay: values["check-replay"],
    skipCreditCheck: values["skip-credit-check"],
  };
}

/* ───────────────────────── people & plan ───────────────────────── */

export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "person";

/** Stable labels from file names (`ana.jpg` → `ana`; duplicates get `-2`, `-3`). */
export function personLabels(files: string[]): { person: string; personFile: string }[] {
  const used = new Map<string, number>();
  return files.map((personFile) => {
    const base = safeName(path.basename(personFile).replace(PERSON_FILE_RE, ""));
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return { person: n > 0 ? `${base}-${n + 1}` : base, personFile };
  });
}

export interface PlanPair {
  person: string;
  personFile: string;
  skuId: string;
  variant: Variant;
  /** Output path without extension (the result keeps the API's format: .jpg, .png or .webp). */
  outBase: string;
  /** An output from an earlier run, if any. */
  existing: string | null;
  action: "run" | "skip-existing" | "defer-budget";
}

export function outBaseFor(outDir: string, person: string, skuId: string, variant: Variant): string {
  return path.join(outDir, `${person}__${skuId}${variant === "alt" ? "__alt" : ""}`);
}

/**
 * Breadth-first (variant → SKU → person) so a tight budget still covers every photo and SKU
 * before spending on alt shots. At most `renderBudget` pairs are marked "run".
 */
export function buildPlan(p: {
  people: { person: string; personFile: string }[];
  skuIds: string[];
  variants: Variant[];
  outDir: string;
  force: boolean;
  renderBudget: number;
  existing: (outBase: string) => string | null;
}): PlanPair[] {
  const pairs: PlanPair[] = [];
  for (const variant of p.variants) {
    for (const skuId of p.skuIds) {
      for (const { person, personFile } of p.people) {
        const outBase = outBaseFor(p.outDir, person, skuId, variant);
        const existing = p.existing(outBase);
        pairs.push({ person, personFile, skuId, variant, outBase, existing, action: existing && !p.force ? "skip-existing" : "run" });
      }
    }
  }
  let budget = Math.max(0, p.renderBudget);
  for (const pair of pairs) {
    if (pair.action !== "run") continue;
    if (budget > 0) budget--;
    else pair.action = "defer-budget";
  }
  return pairs;
}

/** Renders the plan may start: --max-credits minus the one credit a replay check may cost. */
export function renderBudgetFor(maxCredits: number, checkReplay: boolean): number {
  return Math.max(0, maxCredits - (checkReplay ? 1 : 0));
}

export interface CreditDecision {
  ok: boolean;
  /** Worst-case credits: 1 per planned render, +1 for --check-replay. */
  estimated: number;
  reason: string | null;
}

/** Refuse a run whose worst case exceeds --max-credits or the account's remaining credits. */
export function creditDecision(p: {
  renders: number;
  checkReplay: boolean;
  maxCredits: number;
  credits: number | null;
  skipCreditCheck: boolean;
}): CreditDecision {
  const estimated = p.renders + (p.checkReplay ? 1 : 0);
  if (estimated > p.maxCredits) {
    return { ok: false, estimated, reason: `the plan needs up to ${estimated} credit(s) but --max-credits is ${p.maxCredits}` };
  }
  if (p.credits === null) {
    if (p.skipCreditCheck) return { ok: true, estimated, reason: null };
    return {
      ok: false,
      estimated,
      reason: "GET /account did not report a credits number (run npm run doctor; --skip-credit-check overrides)",
    };
  }
  if (estimated > p.credits) {
    return { ok: false, estimated, reason: `the plan needs up to ${estimated} credit(s) but the account has ${p.credits} left` };
  }
  return { ok: true, estimated, reason: null };
}

/* ───────────────────────── photo checks ───────────────────────── */

/** "image/jpeg" | "image/png" from the file signature, else null. */
export function jpegOrPng(head: Uint8Array): "image/jpeg" | "image/png" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= 8 && png.every((b, i) => head[i] === b)) return "image/png";
  return null;
}

/** A blocking problem with a person photo, or null when it is usable. */
export function validatePersonPhoto(p: {
  name: string;
  head: Uint8Array;
  width: number | null | undefined;
  height: number | null | undefined;
}): string | null {
  if (!jpegOrPng(p.head)) {
    return `${p.name}: not a JPEG or PNG file (no JPEG/PNG signature). Export it as JPEG and try again.`;
  }
  if (!p.width || !p.height) return `${p.name}: unreadable image`;
  const short = Math.min(p.width, p.height);
  if (short < MIN_PERSON_SHORT_SIDE) {
    return `${p.name}: only ${p.width}×${p.height} px; the short side must be at least ${MIN_PERSON_SHORT_SIDE} px (use the original photo)`;
  }
  return null;
}

/* ───────────────────────── image analysis ───────────────────────── */

export interface Dims {
  width: number;
  height: number;
}

export const aspectOf = (d: Dims) => d.width / d.height;

/** Relative aspect difference in percent (0 = same shape). */
export function aspectDeltaPct(input: Dims, output: Dims): number {
  const a = aspectOf(input);
  const b = aspectOf(output);
  return Math.round((Math.abs(b - a) / a) * 1000) / 10;
}

export interface Sides {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

/**
 * Which edges of an image are a flat colour (a band of `bandFrac` of the side, per-channel
 * standard deviation ≤ maxStd). Input is raw interleaved pixels, e.g. from sharp `.raw()`.
 */
export function uniformSides(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  opts: { bandFrac?: number; maxStd?: number } = {},
): Sides {
  const bandFrac = opts.bandFrac ?? 0.03;
  const maxStd = opts.maxStd ?? 4;
  const bandH = Math.max(2, Math.round(height * bandFrac));
  const bandW = Math.max(2, Math.round(width * bandFrac));
  const flat = (x0: number, y0: number, x1: number, y1: number): boolean => {
    const c = Math.min(3, channels);
    const sum = new Array<number>(c).fill(0);
    const sq = new Array<number>(c).fill(0);
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * channels;
        for (let k = 0; k < c; k++) {
          const v = data[i + k]!;
          sum[k]! += v;
          sq[k]! += v * v;
        }
        n++;
      }
    }
    if (n === 0) return false;
    for (let k = 0; k < c; k++) {
      const mean = sum[k]! / n;
      const variance = Math.max(0, sq[k]! / n - mean * mean);
      if (Math.sqrt(variance) > maxStd) return false;
    }
    return true;
  };
  return {
    top: flat(0, 0, width, bandH),
    bottom: flat(0, height - bandH, width, height),
    left: flat(0, 0, bandW, height),
    right: flat(width - bandW, 0, width, height),
  };
}

/**
 * Padding the API added: edges that are flat in the output but not in the input. A photo
 * with a plain background already has flat edges, so those sides can't be judged (null).
 */
export function paddingVerdict(input: Sides, output: Sides): { padded: boolean | null; sides: string[] } {
  const keys = ["top", "bottom", "left", "right"] as const;
  const added = keys.filter((k) => output[k] && !input[k]);
  const unknown = keys.filter((k) => output[k] && input[k]);
  if (added.length > 0) return { padded: true, sides: [...added] };
  if (unknown.length > 0) return { padded: null, sides: [...unknown] };
  return { padded: false, sides: [] };
}

/** True when the file carries Clothsy's XMP AI label (IPTC compositeWithTrainedAlgorithmicMedia). */
export function hasAiLabel(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes("compositeWithTrainedAlgorithmicMedia", 0, "latin1");
}

export function extensionFor(contentType: string): "jpg" | "png" | "webp" {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

/* ───────────────────────── observations & report ───────────────────────── */

const KEEP_STRING_KEYS = new Set(["scope", "status", "code", "type"]);

/**
 * A redacted outline of a JSON value: numbers and booleans are kept, strings are replaced by
 * `<string:N>` except for a few enum-like keys (scope, status, code, type).
 */
export function describeJsonShape(value: unknown, key: string | null = null, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return key && KEEP_STRING_KEYS.has(key) && value.length <= 40 ? value : `<string:${value.length}>`;
  if (Array.isArray(value)) {
    if (depth > 3) return `<array:${value.length}>`;
    return value.length === 0 ? [] : [describeJsonShape(value[0], null, depth + 1), ...(value.length > 1 ? [`…${value.length - 1} more`] : [])];
  }
  if (typeof value === "object") {
    if (depth > 3) return "<object>";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = describeJsonShape(v, k, depth + 1);
    return out;
  }
  return `<${typeof value}>`;
}

export interface AccountSnapshot {
  at: string;
  ok: boolean;
  httpStatus: number | null;
  credits: number | null;
  scope: string | null;
  code: string | null;
  message: string | null;
  /** Redacted, see describeJsonShape. */
  shape: unknown;
}

export interface ObservedStart {
  httpStatus: number;
  attempt: number;
  bodyStatus: string | null;
  pollUrl: string | null;
  replaySignal: "status" | "header" | null;
  headers: Record<string, string>;
}

export interface ObservedOutput {
  file: string;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
  contentTypeHeader: string | null;
  aiLabel: boolean;
  padded: boolean | null;
  paddedSides: string[];
}

export interface ObservedRender {
  person: string;
  sku: string;
  variant: Variant;
  status: "success" | "failed";
  code: string | null;
  message: string | null;
  latencyMs: number | null;
  creditCharged: boolean | null;
  replayed: boolean | null;
  input: (Dims & { bytes: number }) | null;
  output: ObservedOutput | null;
  aspectDeltaPct: number | null;
  start: ObservedStart | null;
  polls: number;
  downloadHeaders: Record<string, string> | null;
}

export interface ReplayCheck {
  person: string;
  sku: string;
  variant: Variant;
  idempotencyKey: string;
  creditsBefore: number | null;
  creditsAfter: number | null;
  status: "success" | "failed";
  code: string | null;
  replayedFlag: boolean | null;
  start: ObservedStart | null;
  verdict: "free" | "charged" | "inconclusive" | "failed";
  text: string;
}

export interface ProbeObserved {
  generatedAt: string;
  apiVersion: string;
  apiBase: string;
  options: { skus: string[]; variants: Variant[]; maxCredits: number; concurrency: number; checkReplay: boolean; aiPeople?: boolean };
  plan: { pairs: number; rendered: number; skipped: number; deferred: number; estimatedCredits: number };
  accountBefore: AccountSnapshot | null;
  accountAfter: AccountSnapshot | null;
  renders: ObservedRender[];
  replayCheck: ReplayCheck | null;
  interrupted: boolean;
}

export function replayVerdict(p: {
  ok: boolean;
  before: number | null;
  after: number | null;
}): { verdict: ReplayCheck["verdict"]; text: string } {
  if (!p.ok) return { verdict: "failed", text: "The re-submission failed, so the check is inconclusive (see its error code)." };
  if (p.before === null || p.after === null) {
    return { verdict: "inconclusive", text: "Account credits could not be read before and after, so the cost of a replay is unknown." };
  }
  const used = p.before - p.after;
  if (used === 0) return { verdict: "free", text: "Verified: re-sending a finished try-on's Idempotency-Key cost 0 credits." };
  if (used === 1) {
    return {
      verdict: "charged",
      text: "A re-sent Idempotency-Key was CHARGED 1 credit: the API did not dedupe it. The README credit plan and the render cache's 'replays are free' assumption must change.",
    };
  }
  return { verdict: "inconclusive", text: `Credits moved by ${used} during the check (other usage on the account?), so it is inconclusive.` };
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

const FAILURE_ADVICE: Record<string, string> = {
  PERSON_PHOTO_REJECTED: "the person photo must clearly show exactly one adult, full length, facing the camera, in good light.",
  IMAGE_REJECTED: "Clothsy couldn't use one of the images; try a different person photo or a cleaner product shot.",
  GARMENT_REJECTED: "replace that SKU's product image in public/catalog/ with a real photo (garment alone, plain background).",
  UNSUPPORTED_IMAGE: "only JPEG and PNG are accepted.",
  IMAGE_TOO_LARGE: "images must be under 4 MB (the probe re-encodes person photos; check the catalogue file).",
  INVALID_API_KEY: "the key is missing, malformed or revoked: run npm run doctor.",
  INSUFFICIENT_CREDITS: "the account is out of credits.",
  RATE_LIMITED: "lower --concurrency; the client already stays under 10 starts/min.",
  TIMEOUT: "the try-on may still finish and be charged; re-running the same command replays it for free.",
  RENDER_FAILED: "the try-on ended 'failed' and the credit was refunded; a re-run needs --force (the same key replays the failure, so the app moves to a new key automatically).",
  NETWORK_ERROR: "behind a company proxy, start with NODE_EXTRA_CA_CERTS=/path/to/company-root.pem.",
};

const REPLAY_HEADER_RE = /idempot|replay/i;

/** Concrete, checkable recommendations from what the probe saw. */
export function buildRecommendations(o: ProbeObserved, knownReplayHeaders: readonly string[]): string[] {
  const recs: string[] = [];
  const ok = o.renders.filter((r) => r.status === "success" && r.output);
  const failed = o.renders.filter((r) => r.status === "failed");

  if (o.renders.length > 0 && ok.length === 0) {
    recs.push("No render succeeded, so nothing about the output could be measured. Fix the failures below first.");
  }
  for (const code of [...new Set(failed.map((f) => f.code ?? "ERROR"))]) {
    recs.push(`${code} (${failed.filter((f) => (f.code ?? "ERROR") === code).length}×): ${FAILURE_ADVICE[code] ?? "see the message in the table."}`);
  }

  if (ok.length > 0) {
    // Aspect and the gate's centre-crop assumption.
    const deltas = ok.map((r) => r.aspectDeltaPct ?? 0);
    const maxDelta = Math.max(...deltas);
    const padded = ok.filter((r) => r.output!.padded === true);
    if (maxDelta <= GATE_ASPECT_TOLERANCE_PCT) {
      recs.push(
        `Output keeps the photo's aspect ratio (max difference ${maxDelta}%, tolerance ${GATE_ASPECT_TOLERANCE_PCT}%). The gate resizes the render onto the photo; its centre-crop branch won't trigger, so silhouette IoU and hem error compare like with like.`,
      );
    } else if (padded.length > 0) {
      recs.push(
        `Output is padded/letterboxed on ${[...new Set(padded.flatMap((r) => r.output!.paddedSides))].join(", ")} (aspect differs by up to ${maxDelta}%). The gate's centre-crop assumption is WRONG here: strip the flat border before comparing (lib/cv/gate.ts), or silhouette IoU and hem error will be off.`,
      );
    } else {
      recs.push(
        `Output aspect differs from the photo by up to ${maxDelta}% with no added border: the API crops or reframes. The gate centre-crops, which is right only for a centred crop. Overlay probe/out/* on the original photos and check the head and hem line up before trusting silhouette IoU and hem error.`,
      );
    }

    // Size.
    const sizes = [...new Set(ok.map((r) => `${r.output!.width}×${r.output!.height}`))];
    const inputs = [...new Set(ok.map((r) => (r.input ? `${r.input.width}×${r.input.height}` : "?")))];
    const smaller = ok.filter((r) => r.input && Math.max(r.output!.width, r.output!.height) < Math.max(r.input.width, r.input.height));
    recs.push(
      `Output size ${sizes.join(", ")} for input ${inputs.join(", ")}.` +
        (smaller.length
          ? " Renders come back smaller than the photo; the gate upscales them, so expect ±1 cm more hem noise."
          : " Renders are at least as large as the photo; no upscaling in the gate."),
    );

    // Content type and the AI label.
    const types = [...new Set(ok.map((r) => r.output!.contentType))];
    const mismatched = ok.filter((r) => r.output!.contentTypeHeader && r.output!.contentTypeHeader !== r.output!.contentType);
    recs.push(
      `Result format: ${types.join(", ")}.` +
        (mismatched.length ? ` The Content-Type header disagreed with the bytes ${mismatched.length}×; the app stores the sniffed type.` : "") +
        " Renders are stored byte-for-byte, which keeps the AI label.",
    );
    const labelled = ok.filter((r) => r.output!.aiLabel).length;
    recs.push(
      labelled === ok.length
        ? `All ${ok.length} result(s) carry Clothsy's XMP AI label (compositeWithTrainedAlgorithmicMedia).`
        : `${ok.length - labelled} of ${ok.length} result(s) had no XMP AI label. The UI's visible "AI-generated preview" caption stays mandatory.`,
    );

    // Latency.
    const lat = ok.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b);
    const p95 = percentile(lat, 95)!;
    recs.push(
      `Latency p50 ${secs(percentile(lat, 50))}, p95 ${secs(p95)} (budget 150 s).` +
        (p95 > 45_000 ? " Slower than the docs' 'under 30 seconds': keep the honest clock and expect the first card later than the form." : ""),
    );
  }

  // Start response: status codes and headers.
  const starts = o.renders.map((r) => r.start).filter((s): s is ObservedStart => s !== null);
  if (starts.length > 0) {
    const codes = [...new Set(starts.map((s) => s.httpStatus))];
    const bodies = [...new Set(starts.map((s) => s.bodyStatus ?? "null"))];
    recs.push(`POST /tryons answered HTTP ${codes.join("/")} with status ${bodies.join("/")} (docs: 202 pending).`);
    const replayHeaders = [...new Set(starts.flatMap((s) => Object.keys(s.headers)).filter((h) => REPLAY_HEADER_RE.test(h)))];
    if (replayHeaders.length === 0) {
      recs.push(
        "No idempotency/replay header on POST /tryons. The client detects replays from status 'success' on the first start attempt (documented), which needs no header.",
      );
    } else {
      const unknown = replayHeaders.filter((h) => !knownReplayHeaders.includes(h));
      recs.push(
        `Idempotency-related header(s) seen: ${replayHeaders.join(", ")}.` +
          (unknown.length ? ` Add ${unknown.join(", ")} to REPLAY_HEADER_CANDIDATES in lib/tryon/clothsy.ts if it marks replays.` : " lib/tryon/clothsy.ts already recognises them."),
      );
    }
  }

  // Account shape and credits.
  const before = o.accountBefore;
  const after = o.accountAfter;
  if (before?.ok) {
    recs.push(
      before.credits === null
        ? "GET /account did not return a numeric `credits` field: update parseClothsyAccount in lib/tryon/clothsy.ts to the shape in this report."
        : `GET /account matches the documented shape (credits: ${before.credits}, scope: ${before.scope ?? "absent"}).`,
    );
  }
  if (before?.credits != null && after?.credits != null) {
    const used = before.credits - after.credits;
    const counted = o.renders.filter((r) => r.creditCharged).length + (o.replayCheck?.verdict === "charged" ? 1 : 0);
    recs.push(
      used === counted
        ? `Credits used: ${used}, matching the ${counted} render(s) the client counted as charged.`
        : `Credits used: ${used}, but the client counted ${counted} as charged. Check for other usage on the account; if none, creditCharged is wrong for some responses.`,
    );
  }
  if (o.replayCheck) recs.push(`Replay check: ${o.replayCheck.text}`);
  else recs.push("Replays were not tested. Re-run with --check-replay (may cost 1 credit) to confirm a reused Idempotency-Key is free.");
  return recs;
}

function mdCell(v: unknown): string {
  return String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** probe/REPORT.md content. */
export function renderReport(o: ProbeObserved, knownReplayHeaders: readonly string[]): string {
  const lines: string[] = [];
  lines.push("# Clothsy probe report", "");
  lines.push(
    `Generated ${o.generatedAt} · pipeline \`${o.apiVersion}\` · API \`${o.apiBase}\`${o.interrupted ? " · **interrupted**" : ""}`,
    "",
    `Plan: ${o.plan.pairs} pair(s) (${o.options.skus.join(", ")}; ${o.options.variants.join("+")} shot), ${o.plan.rendered} rendered, ${o.plan.skipped} skipped (output exists), ${o.plan.deferred} deferred (over budget). Worst-case cost ${o.plan.estimatedCredits} credit(s), cap --max-credits ${o.options.maxCredits}.`,
    "",
    "Person photos are referred to by file name only. No image is embedded in this report." +
      (o.options.aiPeople ? " The person photos are AI-generated (--ai-people), not real people." : ""),
    "",
  );

  lines.push("## Recommendations", "");
  for (const r of buildRecommendations(o, knownReplayHeaders)) lines.push(`- ${r}`);
  lines.push("");

  lines.push("## Renders", "");
  lines.push("| person | sku | shot | status | code | latency | input px | output px | aspect Δ | type | padding | AI label | charged |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of o.renders) {
    const out = r.output;
    lines.push(
      `| ${[
        r.person,
        r.sku,
        r.variant,
        r.status,
        r.code ?? "",
        secs(r.latencyMs),
        r.input ? `${r.input.width}×${r.input.height}` : "—",
        out ? `${out.width}×${out.height}` : "—",
        r.aspectDeltaPct === null ? "—" : `${r.aspectDeltaPct}%`,
        out ? out.contentType + (out.contentTypeHeader && out.contentTypeHeader !== out.contentType ? ` (header ${out.contentTypeHeader})` : "") : "—",
        out ? (out.padded === null ? `unclear (${out.paddedSides.join(", ")} flat in both)` : out.padded ? out.paddedSides.join(", ") : "none") : "—",
        out ? (out.aiLabel ? "yes" : "no") : "—",
        r.creditCharged === null ? "—" : r.creditCharged ? "yes" : r.replayed ? "no (replay)" : "no",
      ]
        .map(mdCell)
        .join(" | ")} |`,
    );
  }
  const failures = o.renders.filter((r) => r.status === "failed");
  if (failures.length) {
    lines.push("", "Failure messages:", "");
    for (const f of failures) lines.push(`- ${f.person} × ${f.sku}: \`${f.code ?? "ERROR"}\` ${mdCell(f.message)}`);
  }
  lines.push("");

  lines.push("## Response headers of interest", "");
  const seen = o.renders.filter((r) => r.start);
  if (seen.length === 0) lines.push("No try-on was started.");
  for (const r of seen) {
    const s = r.start!;
    lines.push(
      `- ${r.person} × ${r.sku}: POST /tryons → HTTP ${s.httpStatus}, status \`${s.bodyStatus ?? "null"}\`, attempt ${s.attempt}, pollUrl \`${s.pollUrl ?? "null"}\`, replay signal ${s.replaySignal ?? "none"}, ${r.polls} poll(s)`,
    );
    lines.push(`  - start headers: \`${JSON.stringify(s.headers)}\``);
    if (r.downloadHeaders) lines.push(`  - result download headers: \`${JSON.stringify(r.downloadHeaders)}\``);
  }
  lines.push("");

  lines.push("## Account (GET /account, redacted)", "");
  for (const [label, a] of [
    ["Before", o.accountBefore],
    ["After", o.accountAfter],
  ] as const) {
    if (!a) {
      lines.push(`- ${label}: not checked`);
      continue;
    }
    lines.push(
      a.ok
        ? `- ${label} (${a.at}): HTTP ${a.httpStatus}, credits ${a.credits ?? "?"}, scope ${a.scope ?? "?"}, shape \`${JSON.stringify(a.shape)}\``
        : `- ${label} (${a.at}): failed \`${a.code}\` ${mdCell(a.message)}`,
    );
  }
  lines.push("");

  lines.push("## Replay check", "");
  if (!o.replayCheck) lines.push("Not run (pass --check-replay).");
  else {
    const c = o.replayCheck;
    lines.push(
      `Re-submitted ${c.person} × ${c.sku} (${c.variant}) with Idempotency-Key \`${c.idempotencyKey}\`: ${c.status}${c.code ? ` (${c.code})` : ""}; credits ${c.creditsBefore ?? "?"} → ${c.creditsAfter ?? "?"}; client replay flag ${c.replayedFlag ?? "—"}; start ${c.start ? `HTTP ${c.start.httpStatus}, status \`${c.start.bodyStatus ?? "null"}\`, headers \`${JSON.stringify(c.start.headers)}\`` : "—"}.`,
      "",
      `**${c.verdict.toUpperCase()}**: ${c.text}`,
    );
  }
  lines.push("", "Behaviours and evidence: docs/CLOTHSY-NOTES.md.", "");
  return lines.join("\n");
}
