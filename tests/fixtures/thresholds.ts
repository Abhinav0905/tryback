// Fixed gate thresholds for unit tests: the hand-set values the gate was designed around.
//
// Tests that pin a verdict ("ΔE 18.4 retries", "IoU 0.96 badges on shorter") pass these to
// decideGate and the tuner explicitly instead of reading lib/cv/thresholds.json, so
// `npm run tune -- --apply` (which rewrites that file from real renders) never turns the suite
// red. tests/tune.test.ts still checks that the live file parses and is what the gate uses.

import { parseThresholds, type GateSevereThresholds, type GateThresholds, type ThresholdsFile } from "@/lib/cv/thresholds";

export const FIXTURE_THRESHOLDS_RAW = {
  version: 1,
  source: "test fixture: the hand-set defaults",
  tunedAt: null,
  gate: { colourDeltaE: 12, residue: 0.2, silhouetteIoU: 0.92, identityDiff: 0.15, minCoverage: 0.25, hemErrorCm: 6 },
  gateSevere: { identityDiff: 0.3, minCoverage: 0.08 },
  preflight: {
    visibility: 0.5,
    headTopMargin: 0.04,
    feetBottomMargin: 0.97,
    shoulderHipRatio: { min: 0.9, max: 2.6 },
    minShoulderToTorso: 0.45,
    maxYawDeg: 35,
    minGarmentCoverage: 0.3,
    luminance: { min: 60, max: 215 },
    minSharpness: 25,
    analysisMaxSide: 512,
  },
} as const;

export const FIXTURE_FILE: ThresholdsFile = parseThresholds(JSON.parse(JSON.stringify(FIXTURE_THRESHOLDS_RAW)));
export const FIXTURE_GATE: GateThresholds = { ...FIXTURE_FILE.gate };
export const FIXTURE_SEVERE: GateSevereThresholds = { ...FIXTURE_FILE.gateSevere };
