// Gate + preflight thresholds, loaded from lib/cv/thresholds.json so they can be
// re-tuned from real renders (npm run tune, see docs/GATE-TUNING.md) without code edits.
// Pure and isomorphic: imported by the browser gate, node tests and the tuning script.
//
// The JSON is validated when this module loads: a malformed file fails loudly at build /
// test time instead of silently weakening the gate.

import raw from "./thresholds.json";

export interface GateThresholds {
  /** Max CIEDE2000 between the lighting-corrected expected colour and the rendered garment. */
  colourDeltaE: number;
  /** Max share of rendered garment pixels still matching the returned garment's colour. */
  residue: number;
  /** Max IoU with the original garment silhouette on a silhouette-changing transition (higher ⇒ shape was copied). */
  silhouetteIoU: number;
  /** Max mean abs grayscale difference (0..1) in the face box. */
  identityDiff: number;
  /** Min share of the torso box covered by the rendered garment. */
  minCoverage: number;
  /** Max |rendered hem − projected hem| in cm. */
  hemErrorCm: number;
}

/** Beyond these, a render with no retry left is dropped rather than badged. */
export interface GateSevereThresholds {
  /** "Very high" identity drift: a different-looking face. */
  identityDiff: number;
  /** "Tiny" coverage: the garment is essentially missing from the torso. */
  minCoverage: number;
}

export interface PreflightThresholds {
  /** Landmark visibility required for "visible". */
  readonly visibility: number;
  /** Nose must sit below this share of the frame height (room for the top of the head). */
  readonly headTopMargin: number;
  /** Ankles must sit above this share of the frame height (room for the feet). */
  readonly feetBottomMargin: number;
  /** Shoulder-landmark width ÷ hip-landmark width for a plausible, square-on adult pose. */
  readonly shoulderHipRatio: { readonly min: number; readonly max: number };
  /** Shoulder width ÷ shoulder→hip height; drops as the torso turns (≈0.7 square-on, ≈0.35 at 60°). */
  readonly minShoulderToTorso: number;
  /** Max torso yaw (deg) from world-space shoulder depth, when available. */
  readonly maxYawDeg: number;
  /** Clothes mask must cover this share of the torso box. */
  readonly minGarmentCoverage: number;
  /** Mean luma (0..255) range. */
  readonly luminance: { readonly min: number; readonly max: number };
  /** Min variance of the Laplacian on a ≤512 px grayscale of the person region. */
  readonly minSharpness: number;
  /** Longest side of the grayscale used for lighting and sharpness. */
  readonly analysisMaxSide: number;
}

export interface ThresholdsFile {
  version: 1;
  /** Where the numbers came from ("hand-set defaults…", "npm run tune on N real renders…"). */
  source: string;
  /** ISO time of the last `npm run tune -- --apply`, or null. */
  tunedAt: string | null;
  gate: GateThresholds;
  gateSevere: GateSevereThresholds;
  preflight: PreflightThresholds;
  /** Free-form provenance written by the tuning script (sample counts, report path). */
  tuning?: Record<string, unknown>;
}

export const GATE_THRESHOLD_KEYS = [
  "colourDeltaE",
  "residue",
  "silhouetteIoU",
  "identityDiff",
  "minCoverage",
  "hemErrorCm",
] as const satisfies readonly (keyof GateThresholds)[];

type Path = string;

function fail(path: Path, msg: string): never {
  throw new Error(`lib/cv/thresholds.json: ${path} ${msg}`);
}

function obj(x: unknown, path: Path): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(path, "must be an object");
  return x as Record<string, unknown>;
}

function num(o: Record<string, unknown>, key: string, path: Path, lo: number, hi: number): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${path}.${key}`, `must be a finite number (got ${JSON.stringify(v)})`);
  if (v < lo || v > hi) fail(`${path}.${key}`, `must be within [${lo}, ${hi}] (got ${v})`);
  return v;
}

function range(o: Record<string, unknown>, key: string, path: Path, lo: number, hi: number): { min: number; max: number } {
  const r = obj(o[key], `${path}.${key}`);
  const min = num(r, "min", `${path}.${key}`, lo, hi);
  const max = num(r, "max", `${path}.${key}`, lo, hi);
  if (!(min < max)) fail(`${path}.${key}`, `min must be below max (got ${min} ≥ ${max})`);
  return { min, max };
}

/** Validate an untrusted thresholds object (the JSON file, or a proposal before it is written). Throws on any problem. */
export function parseThresholds(input: unknown): ThresholdsFile {
  const root = obj(input, "(root)");
  if (root.version !== 1) fail("version", `must be 1 (got ${JSON.stringify(root.version)})`);
  if (typeof root.source !== "string") fail("source", "must be a string");
  if (root.tunedAt !== null && typeof root.tunedAt !== "string") fail("tunedAt", "must be an ISO string or null");

  const g = obj(root.gate, "gate");
  const gate: GateThresholds = {
    colourDeltaE: num(g, "colourDeltaE", "gate", 0.5, 100),
    residue: num(g, "residue", "gate", 0, 1),
    silhouetteIoU: num(g, "silhouetteIoU", "gate", 0, 1),
    identityDiff: num(g, "identityDiff", "gate", 0, 1),
    minCoverage: num(g, "minCoverage", "gate", 0, 1),
    hemErrorCm: num(g, "hemErrorCm", "gate", 0.1, 100),
  };

  const s = obj(root.gateSevere, "gateSevere");
  const gateSevere: GateSevereThresholds = {
    identityDiff: num(s, "identityDiff", "gateSevere", 0, 1),
    minCoverage: num(s, "minCoverage", "gateSevere", 0, 1),
  };
  if (!(gateSevere.identityDiff > gate.identityDiff)) {
    fail("gateSevere.identityDiff", `must be above gate.identityDiff (${gateSevere.identityDiff} ≤ ${gate.identityDiff})`);
  }
  if (!(gateSevere.minCoverage < gate.minCoverage)) {
    fail("gateSevere.minCoverage", `must be below gate.minCoverage (${gateSevere.minCoverage} ≥ ${gate.minCoverage})`);
  }

  const p = obj(root.preflight, "preflight");
  const preflight: PreflightThresholds = {
    visibility: num(p, "visibility", "preflight", 0, 1),
    headTopMargin: num(p, "headTopMargin", "preflight", 0, 0.5),
    feetBottomMargin: num(p, "feetBottomMargin", "preflight", 0.5, 1),
    shoulderHipRatio: range(p, "shoulderHipRatio", "preflight", 0, 10),
    minShoulderToTorso: num(p, "minShoulderToTorso", "preflight", 0, 5),
    maxYawDeg: num(p, "maxYawDeg", "preflight", 0, 90),
    minGarmentCoverage: num(p, "minGarmentCoverage", "preflight", 0, 1),
    luminance: range(p, "luminance", "preflight", 0, 255),
    minSharpness: num(p, "minSharpness", "preflight", 0, 100_000),
    analysisMaxSide: num(p, "analysisMaxSide", "preflight", 64, 4096),
  };

  const out: ThresholdsFile = {
    version: 1,
    source: root.source,
    tunedAt: (root.tunedAt as string | null) ?? null,
    gate,
    gateSevere,
    preflight,
  };
  if (root.tuning !== undefined) out.tuning = obj(root.tuning, "tuning");
  return out;
}

/** The thresholds in effect (validated at load). */
export const THRESHOLDS: Readonly<ThresholdsFile> = parseThresholds(raw);
