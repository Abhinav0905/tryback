// Candidate retrieval for exchanges. Pure and deterministic: no I/O, no clocks,
// no randomness, so it is safe to import from server routes, client components
// and tests alike. Everything is driven by the catalogue attributes plus the
// (text-only) diagnosis — never by anything about the shopper's body.

import { familyOf, FIT_ORDER, LENGTH_ORDER, SILHOUETTE_LOOSENESS, SKUS } from "./catalog";
import { chroma, deltaE2000, hexToLab } from "./color";
import type {
  Candidate,
  Category,
  Diagnosis,
  FitComplaint,
  IssueType,
  KeepAttribute,
  LengthClass,
  LengthVariant,
  Neckline,
  PhotoMeasurements,
  ReasonCode,
  Silhouette,
  SizeCode,
  SizeOption,
  Sku,
  TransitionType,
} from "./types";
import { SIZES } from "./types";

/* ───────────── Tunables ───────────── */

/** ΔE2000 above which two garment colours read as a genuinely different colour. */
export const COLOUR_CHANGE_DELTA_E = 20;
/** ΔE2000 below which we consider the colour "kept". */
const SAME_COLOUR_DELTA_E = 10;
/** Price differences inside ±$25 are not penalised. */
export const PRICE_BAND_USD = 25;
/** Penalty for changing an attribute the shopper implicitly likes. */
const KEEP_PENALTY = 0.3;
/** Greedy diversity penalty per already-selected candidate from the same style family. */
const FAMILY_REPEAT_PENALTY = 0.12;
/** Hem changes smaller than this (cm) are not a visible length change (same style, other length variant). */
const HEM_MOVE_CM = 3;
/** Across different styles in the same length class, the hem must differ by this much to count. */
const CROSS_STYLE_HEM_MOVE_CM = 5;
/** How many ranked alternatives a return shows after diagnosis. */
export const CANDIDATES_SHOWN = 4;

/**
 * Within one looseness tier, some cuts solve a fit complaint better: an A-line
 * flares from the waist (most room through the hip), while wrap / belted cuts
 * define the waist (most shape). Applied only when the issue is actually fixed.
 */
const HIP_ROOM_BONUS: Partial<Record<Silhouette, number>> = { "a-line": 0.1, boxy: 0.05 };
const WAIST_SHAPE_BONUS: Partial<Record<Silhouette, number>> = { wrap: 0.1, "shirt-dress": 0.05, trench: 0.05, fitted: 0.05 };

/* ───────────── Attribute helpers (exported for UI/tests) ───────────── */

/** Combined looseness: silhouette dominates, fit intent refines. Higher = roomier. */
export function loosenessOf(s: Sku): number {
  return SILHOUETTE_LOOSENESS[s.silhouette] + 0.5 * FIT_ORDER.indexOf(s.fit);
}

function lengthIndex(s: Sku): number {
  return LENGTH_ORDER.indexOf(s.lengthClass);
}

/** ΔE2000 between two SKUs' dominant colours. */
export function colourDistance(a: Sku, b: Sku): number {
  if (a.colorHex.toLowerCase() === b.colorHex.toLowerCase()) return 0;
  return deltaE2000(hexToLab(a.colorHex), hexToLab(b.colorHex));
}

/**
 * Length move from `from` to `to`: `dir` +1 longer, −1 shorter, 0 same, and how
 * convincingly (`strength` 0..1). A different length class, or a Tall/Petite
 * variant of the same style (≥3 cm), is a full move. Across styles within one
 * length class only a ≥5 cm hem difference counts, at half strength.
 */
function lengthMove(from: Sku, to: Sku, size: SizeCode): { dir: number; strength: number } {
  const d = lengthIndex(to) - lengthIndex(from);
  if (d !== 0) return { dir: Math.sign(d), strength: 1 };
  const hem = to.poms[size].hpsToHemCm - from.poms[size].hpsToHemCm;
  if (from.family === to.family && Math.abs(hem) >= HEM_MOVE_CM) return { dir: Math.sign(hem), strength: 1 };
  if (Math.abs(hem) >= CROSS_STYLE_HEM_MOVE_CM) return { dir: Math.sign(hem), strength: 0.5 };
  return { dir: 0, strength: 0 };
}

const SILHOUETTE_LABEL: Record<Silhouette, string> = {
  wrap: "wrap dress",
  "a-line": "A-line",
  shift: "shift dress",
  bodycon: "bodycon",
  "shirt-dress": "shirt dress",
  slip: "slip dress",
  boxy: "boxy cut",
  fitted: "fitted cut",
  relaxed: "relaxed cut",
  trench: "trench",
};

const LENGTH_LABEL: Record<LengthClass, string> = {
  cropped: "cropped",
  hip: "hip",
  thigh: "thigh",
  "above-knee": "above-knee",
  knee: "knee",
  midi: "midi",
  maxi: "maxi",
};

const NECKLINE_LABEL: Record<Neckline, string> = {
  v: "V-neck",
  crew: "crew neck",
  square: "square neckline",
  collar: "collared neckline",
  scoop: "scoop neck",
  boat: "boat neck",
};

const BODY_ZONE: Record<Category, string> = {
  dress: "through the hip",
  top: "through the body",
  outerwear: "through the body",
};

const VARIANT_LABEL: Record<LengthVariant, string> = {
  regular: "Regular",
  petite: "Petite",
  tall: "Tall",
};

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s: string): string {
  // Keep acronyms / proper casing like "A-line" and "V-neck" intact.
  if (/^[A-Z][-A-Z]/.test(s)) return s;
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

/** "Wrap Dress Tall — Mustard" → "wrap dress". */
function styleName(s: Sku): string {
  return (s.name.split(" — ")[0] ?? s.name).replace(/\s+(Tall|Petite)$/, "").toLowerCase();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtCm(n: number): string {
  return String(round1(Math.abs(n)));
}

function signedCm(n: number): string {
  const r = round1(n);
  if (r > 0) return `+${r}`;
  if (r < 0) return `−${Math.abs(r)}`;
  return "0";
}

/* ───────────── Transitions ───────────── */

/**
 * How `to` differs from the garment the shopper is wearing (`from`). Drives the
 * fidelity-gate thresholds and the benchmark buckets.
 */
export function classifyTransition(from: Sku, to: Sku): TransitionType {
  if (from.family === to.family) {
    if (from.lengthVariant !== to.lengthVariant) {
      const d = to.poms.M.hpsToHemCm - from.poms.M.hpsToHemCm;
      return d >= 0 ? "longer" : "shorter";
    }
    return from.colorHex.toLowerCase() !== to.colorHex.toLowerCase() ? "colour_only" : "like_silhouette";
  }
  const dLoose = loosenessOf(to) - loosenessOf(from);
  if (dLoose >= 1) return "slim_to_loose";
  if (dLoose <= -1) return "loose_to_slim";
  const dLen = lengthIndex(to) - lengthIndex(from);
  if (dLen > 0) return "longer";
  if (dLen < 0) return "shorter";
  return "like_silhouette";
}

/* ───────────── Ranking ───────────── */

interface Signals {
  colourChanged: boolean;
  dLoose: number;
  move: number;
  moveStrength: number;
  hemDeltaCm: number;
  necklineChanged: boolean;
  quieter: boolean;
  fabricChanged: boolean;
}

/** Which keep-attributes an issue makes fair game to change. */
const ISSUE_RELEASES: Record<IssueType, KeepAttribute[]> = {
  colour: ["colour"],
  print: ["colour"],
  too_clingy: ["silhouette", "fit"],
  too_boxy: ["silhouette", "fit"],
  too_short: ["length"],
  too_long: ["length"],
  neckline: ["neckline"],
  fabric: [],
};

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function scoreOne(
  src: Sku,
  c: Sku,
  size: SizeCode,
  diagnosis: Diagnosis,
  paid: number,
  measurements: PhotoMeasurements | null | undefined,
): { score: number; fixes: IssueType[]; signals: Signals } {
  const dE = colourDistance(src, c);
  const srcLab = hexToLab(src.colorHex);
  const cLab = hexToLab(c.colorHex);
  const signals: Signals = {
    colourChanged: dE > COLOUR_CHANGE_DELTA_E,
    dLoose: loosenessOf(c) - loosenessOf(src),
    move: lengthMove(src, c, size).dir,
    moveStrength: lengthMove(src, c, size).strength,
    hemDeltaCm: c.poms[size].hpsToHemCm - src.poms[size].hpsToHemCm,
    necklineChanged: c.neckline !== src.neckline,
    quieter: chroma(cLab) < chroma(srcLab) - 8,
    fabricChanged: c.fabric !== src.fabric,
  };

  let score = 0;
  const fixes: IssueType[] = [];
  const released = new Set<KeepAttribute>();

  for (const issue of diagnosis.issues) {
    const w = clamp01(issue.confidence);
    if (w <= 0) continue;
    if (w >= 0.3) for (const k of ISSUE_RELEASES[issue.type]) released.add(k);

    switch (issue.type) {
      case "colour": {
        if (signals.colourChanged) {
          score += w * (0.7 + 0.3 * clamp01((dE - COLOUR_CHANGE_DELTA_E) / 40));
          fixes.push("colour");
        } else {
          score -= w * 0.6;
        }
        break;
      }
      case "too_clingy":
      case "too_boxy": {
        // too_clingy wants more room; too_boxy wants more shape.
        const d = issue.type === "too_clingy" ? signals.dLoose : -signals.dLoose;
        if (d >= 1) {
          const bonus = (issue.type === "too_clingy" ? HIP_ROOM_BONUS : WAIST_SHAPE_BONUS)[c.silhouette] ?? 0;
          score += w * (Math.min(1, 0.6 + 0.15 * d) + bonus);
          fixes.push(issue.type);
        } else if (d > 0) {
          score += w * 0.25;
        } else if (d === 0) {
          score -= w * 0.15;
        } else {
          score -= w * 0.6;
        }
        break;
      }
      case "too_short":
      case "too_long": {
        const wanted = issue.type === "too_short" ? 1 : -1;
        if (signals.move === wanted) {
          score += w * signals.moveStrength;
          fixes.push(issue.type);
        } else if (signals.move === -wanted) {
          score -= w * 0.6;
        } else {
          score -= w * 0.15;
        }
        break;
      }
      case "neckline": {
        if (signals.necklineChanged) {
          score += w * 0.9;
          fixes.push("neckline");
        } else {
          score -= w * 0.3;
        }
        break;
      }
      case "print": {
        const drop = chroma(srcLab) - chroma(cLab);
        if (signals.quieter) {
          score += w * Math.min(1, 0.5 + drop / 40);
          fixes.push("print");
        } else if (drop < 0) {
          score -= w * 0.3;
        }
        break;
      }
      case "fabric": {
        if (signals.fabricChanged) {
          score += w * 0.9;
          fixes.push("fabric");
        } else {
          score -= w * 0.3;
        }
        break;
      }
    }
  }

  // Close-fitting garment measured on the photo: nudge roomier cuts (tie-breaker only).
  const ease = measurements?.easeRatio;
  if (typeof ease === "number" && ease < 1.08 && signals.dLoose >= 1) score += 0.05;

  // Changing what the shopper implicitly likes costs points (unless an issue asked for it).
  const keep = new Set(diagnosis.keepAttributes);
  const changed: Record<KeepAttribute, boolean> = {
    category: c.category !== src.category,
    silhouette: c.silhouette !== src.silhouette,
    length: signals.move !== 0,
    neckline: signals.necklineChanged,
    colour: dE > SAME_COLOUR_DELTA_E,
    fit: c.fit !== src.fit,
  };
  for (const k of keep) {
    if (changed[k] && !released.has(k)) score -= KEEP_PENALTY;
  }

  // Price band: beyond ±$25 the swap stops feeling like an exchange.
  const priceDiff = c.price - paid;
  const excess = Math.max(0, Math.abs(priceDiff) - PRICE_BAND_USD);
  if (excess > 0) score -= Math.min(0.6, (excess / PRICE_BAND_USD) * 0.3);

  // Deeper stock is a (tiny) tie-breaker: fewer "sold out" surprises.
  score += 0.02 * (Math.min(c.inventory[size], 5) / 5);

  return { score, fixes, signals };
}

function whyCopy(src: Sku, c: Sku, diagnosis: Diagnosis, fixes: IssueType[], s: Signals): string {
  const phrases: string[] = [];
  const ordered = [...diagnosis.issues].sort((a, b) => b.confidence - a.confidence);
  for (const issue of ordered) {
    if (!fixes.includes(issue.type) || phrases.length >= 2) continue;
    switch (issue.type) {
      case "too_clingy":
        phrases.push(`Looser ${SILHOUETTE_LABEL[c.silhouette]} ${BODY_ZONE[c.category]}`);
        break;
      case "too_boxy":
        phrases.push(`More shaped ${SILHOUETTE_LABEL[c.silhouette]}`);
        break;
      case "too_short":
      case "too_long": {
        const dir = issue.type === "too_short" ? "Longer" : "Shorter";
        if (c.family === src.family && c.lengthVariant !== src.lengthVariant) {
          phrases.push(`${VARIANT_LABEL[c.lengthVariant]} length: ${signedCm(s.hemDeltaCm)} cm at the hem`);
        } else {
          phrases.push(`${dir} ${LENGTH_LABEL[c.lengthClass]} length`);
        }
        break;
      }
      case "neckline":
        phrases.push(`${capitalise(NECKLINE_LABEL[c.neckline])} instead of a ${NECKLINE_LABEL[src.neckline]}`);
        break;
      case "fabric":
        phrases.push(`${c.fabric} instead of ${src.fabric.toLowerCase()}`);
        break;
      case "print":
        if (!s.colourChanged || !fixes.includes("colour")) phrases.push(`A quieter ${c.colorName.toLowerCase()}`);
        break;
      case "colour":
        break; // appended as the colour suffix below
    }
  }

  const colourSuffix = s.colourChanged ? `, in ${c.colorName}` : "";
  if (phrases.length === 0) {
    if (c.family === src.family) {
      return s.colourChanged
        ? `Same ${styleName(c)} you chose, in ${c.colorName}`
        : `Same ${styleName(c)}, ${VARIANT_LABEL[c.lengthVariant].toLowerCase()} length`;
    }
    return `${capitalise(SILHOUETTE_LABEL[c.silhouette])} in ${c.colorName}`;
  }
  const head = phrases[0];
  const tail = phrases[1] ? `, ${lowerFirst(phrases[1])}` : "";
  return `${head}${tail}${colourSuffix}`;
}

export interface RankOptions {
  measurements?: PhotoMeasurements | null;
  limit?: number;
  exclude?: string[];
  /** USD the shopper paid for the line (defaults to the purchased SKU's list price). */
  paidPrice?: number;
}

/**
 * Rank in-stock alternatives (same category, available in `size`) against the
 * diagnosis. Deterministic: ties break on SKU id.
 */
export function rankCandidates(
  sku: Sku,
  size: SizeCode,
  diagnosis: Diagnosis,
  opts: RankOptions = {},
): Candidate[] {
  const limit = Math.max(0, opts.limit ?? 6);
  const exclude = new Set(opts.exclude ?? []);
  const paid = opts.paidPrice ?? sku.price;

  const pool = SKUS.filter(
    (c) => c.id !== sku.id && c.category === sku.category && c.inventory[size] > 0 && !exclude.has(c.id),
  );

  const scored = pool.map((c) => {
    const { score, fixes, signals } = scoreOne(sku, c, size, diagnosis, paid, opts.measurements);
    return { c, score, fixes, signals };
  });

  // Greedy selection with a family-diversity penalty so the top cards aren't
  // three colourways of the same dress.
  const selected: Candidate[] = [];
  const familyCount = new Map<string, number>();
  const remaining = [...scored];
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestEff = -Infinity;
    remaining.forEach((r, i) => {
      const eff = r.score - FAMILY_REPEAT_PENALTY * (familyCount.get(r.c.family) ?? 0);
      if (eff > bestEff + 1e-9 || (Math.abs(eff - bestEff) <= 1e-9 && r.c.id < remaining[bestIdx].c.id)) {
        bestEff = eff;
        bestIdx = i;
      }
    });
    const best = remaining.splice(bestIdx, 1)[0];
    familyCount.set(best.c.family, (familyCount.get(best.c.family) ?? 0) + 1);
    selected.push({
      skuId: best.c.id,
      size,
      transition: classifyTransition(sku, best.c),
      score: Math.round(bestEff * 1000) / 1000,
      fixes: best.fixes,
      why: whyCopy(sku, best.c, diagnosis, best.fixes, best.signals),
      priceDiff: best.c.price - paid,
    });
  }
  return selected;
}

/**
 * Two picks to render speculatively at photo upload, before the reason form is
 * submitted: one silhouette change and one colour change, both in stock in `size`.
 */
export function speculativePicks(
  sku: Sku,
  size: SizeCode,
  reason: ReasonCode,
  opts: { paidPrice?: number } = {},
): Candidate[] {
  if (reason !== "style_colour") return [];
  const sameFamily = familyOf(sku).map((s) => s.id);
  // Close cuts are most often returned for feeling clingy; roomy cuts for feeling shapeless.
  const direction: IssueType = loosenessOf(sku) <= 2 ? "too_clingy" : "too_boxy";

  const silhouette = rankCandidates(
    sku,
    size,
    {
      issues: [{ type: direction, confidence: 0.7, evidence: "speculative silhouette pick" }],
      keepAttributes: ["category", "colour", "neckline"],
      summary: "",
      source: "rules",
    },
    { limit: 1, exclude: sameFamily, paidPrice: opts.paidPrice },
  );

  const colour = rankCandidates(
    sku,
    size,
    {
      issues: [{ type: "colour", confidence: 0.7, evidence: "speculative colour pick" }],
      keepAttributes: ["category", "silhouette", "length", "neckline", "fit"],
      summary: "",
      source: "rules",
    },
    { limit: 1, exclude: silhouette.map((c) => c.skuId), paidPrice: opts.paidPrice },
  );

  const picks = [...silhouette, ...colour];
  if (picks.length < 2) {
    // Small families / categories: top up with the best general alternative.
    const extra = rankCandidates(
      sku,
      size,
      {
        issues: [
          { type: "colour", confidence: 0.5, evidence: "speculative" },
          { type: direction, confidence: 0.5, evidence: "speculative" },
        ],
        keepAttributes: ["category"],
        summary: "",
        source: "rules",
      },
      { limit: 2 - picks.length, exclude: picks.map((p) => p.skuId), paidPrice: opts.paidPrice },
    );
    picks.push(...extra);
  }
  return picks;
}

/* ───────────── Size path (zero credits) ───────────── */

const COMPLAINT_LABEL: Record<FitComplaint, string> = {
  too_short: "too short",
  too_long: "too long",
  too_tight: "too tight",
  too_loose: "too loose",
  sleeves_long: "sleeves too long",
  sleeves_short: "sleeves too short",
};

const VARIANT_ORDER: Record<LengthVariant, number> = { petite: 0, regular: 1, tall: 2 };

/**
 * Every other size × length variant of the same style in the same colour, with
 * measured deltas against the garment the shopper is wearing, the complaints it
 * fixes, honest side effects and a grading note.
 */
export function sizeOptions(
  sku: Sku,
  size: SizeCode,
  complaints: FitComplaint[],
  opts: { paidPrice?: number } = {},
): SizeOption[] {
  const paid = opts.paidPrice ?? sku.price;
  const wanted = new Set(complaints);
  const base = sku.poms[size];
  const sizeIdx = SIZES.indexOf(size);
  const siblings = familyOf(sku).filter((s) => s.colorHex.toLowerCase() === sku.colorHex.toLowerCase());

  const options: (SizeOption & { cost: number })[] = [];
  for (const s of siblings) {
    for (const z of SIZES) {
      if (s.id === sku.id && z === size) continue;
      const pom = s.poms[z];
      const dHem = round1(pom.hpsToHemCm - base.hpsToHemCm);
      const dSleeve =
        pom.sleeveCm !== null && base.sleeveCm !== null ? round1(pom.sleeveCm - base.sleeveCm) : null;
      const dChest = round1(2 * (pom.halfChestCm - base.halfChestCm));

      const applies: FitComplaint[] = [];
      if (dHem >= 3) applies.push("too_short");
      if (dHem <= -3) applies.push("too_long");
      if (dChest >= 4) applies.push("too_tight");
      if (dChest <= -4) applies.push("too_loose");
      if (dSleeve !== null && dSleeve >= 2) applies.push("sleeves_short");
      if (dSleeve !== null && dSleeve <= -2) applies.push("sleeves_long");
      const fixes = wanted.size > 0 ? applies.filter((f) => wanted.has(f)) : applies;

      const tradeoffs: string[] = [];
      if (Math.abs(dChest) >= 4 && !wanted.has(dChest > 0 ? "too_tight" : "too_loose")) {
        tradeoffs.push(
          dChest > 0 ? `+${fmtCm(dChest)} cm wider through the chest` : `${fmtCm(dChest)} cm narrower through the chest`,
        );
      }
      if (Math.abs(dHem) >= 3 && !wanted.has(dHem > 0 ? "too_short" : "too_long")) {
        tradeoffs.push(dHem > 0 ? `+${fmtCm(dHem)} cm longer at the hem` : `${fmtCm(dHem)} cm shorter at the hem`);
      }
      if (dSleeve !== null && Math.abs(dSleeve) >= 2 && !wanted.has(dSleeve > 0 ? "sleeves_short" : "sleeves_long")) {
        tradeoffs.push(dSleeve > 0 ? `Sleeves +${fmtCm(dSleeve)} cm longer` : `Sleeves ${fmtCm(dSleeve)} cm shorter`);
      }

      const sizeStep = SIZES.indexOf(z) - sizeIdx;
      const variantChanged = s.lengthVariant !== sku.lengthVariant;
      const inStock = s.inventory[z] > 0;
      const priceDiff = s.price - paid;

      options.push({
        skuId: s.id,
        size: z,
        lengthVariant: s.lengthVariant,
        deltaHemCm: dHem,
        deltaSleeveCm: dSleeve,
        deltaChestCircCm: dChest,
        fixes,
        tradeoffs,
        recommended: false,
        inStock,
        priceDiff,
        note: gradingNote({ z, s, sku, wanted, fixes, dHem, dChest, dSleeve, sizeStep, variantChanged, inStock }),
        cost: tradeoffs.length + 0.6 * Math.abs(sizeStep) + (variantChanged ? 0.25 : 0) + (priceDiff > 0 ? 0.05 : 0),
      });
    }
  }

  // Recommended: in stock, fixes every complaint, fewest side effects (same size +
  // length variant beats sizing up). Exactly one, or none if nothing fixes it all.
  if (wanted.size > 0) {
    const viable = options.filter((o) => o.inStock && [...wanted].every((w) => o.fixes.includes(w)));
    viable.sort((a, b) => a.cost - b.cost || a.skuId.localeCompare(b.skuId) || SIZES.indexOf(a.size) - SIZES.indexOf(b.size));
    if (viable[0]) viable[0].recommended = true;
  }

  options.sort(
    (a, b) =>
      VARIANT_ORDER[a.lengthVariant] - VARIANT_ORDER[b.lengthVariant] ||
      SIZES.indexOf(a.size) - SIZES.indexOf(b.size) ||
      a.skuId.localeCompare(b.skuId),
  );
  return options.map((o) => {
    const { cost, ...option } = o;
    void cost;
    return option;
  });
}

function gradingNote(p: {
  z: SizeCode;
  s: Sku;
  sku: Sku;
  wanted: Set<FitComplaint>;
  fixes: FitComplaint[];
  dHem: number;
  dChest: number;
  dSleeve: number | null;
  sizeStep: number;
  variantChanged: boolean;
  inStock: boolean;
}): string {
  const { z, s, wanted, fixes, dHem, dChest, dSleeve, sizeStep, variantChanged, inStock } = p;
  const label = variantChanged ? `${VARIANT_LABEL[s.lengthVariant]} ${z}` : z;
  let note: string;

  if (!variantChanged && sizeStep > 0 && wanted.has("too_short") && !fixes.includes("too_short")) {
    note = `${z} adds only +${fmtCm(dHem)} cm length but +${fmtCm(dChest)} cm chest — sizing up won't fix '${COMPLAINT_LABEL.too_short}'`;
  } else if (
    !variantChanged &&
    sizeStep > 0 &&
    wanted.has("sleeves_short") &&
    !fixes.includes("sleeves_short") &&
    dSleeve !== null
  ) {
    note = `${z} adds only +${fmtCm(dSleeve)} cm to the sleeves but +${fmtCm(dChest)} cm chest — sizing up won't fix '${COMPLAINT_LABEL.sleeves_short}'`;
  } else if (!variantChanged && sizeStep < 0 && wanted.has("too_long") && !fixes.includes("too_long")) {
    note = `${z} is only ${fmtCm(dHem)} cm shorter but ${fmtCm(dChest)} cm narrower through the chest — sizing down won't fix '${COMPLAINT_LABEL.too_long}'`;
  } else if (!variantChanged && sizeStep < 0 && wanted.has("sleeves_long") && !fixes.includes("sleeves_long") && dSleeve !== null) {
    note = `${z} takes only ${fmtCm(dSleeve)} cm off the sleeves but ${fmtCm(dChest)} cm off the chest — sizing down won't fix '${COMPLAINT_LABEL.sleeves_long}'`;
  } else if (!variantChanged && sizeStep > 0 && fixes.includes("too_short")) {
    note = `${z} reaches ${signedCm(dHem)} cm length, but adds +${fmtCm(dChest)} cm through the chest`;
  } else if (!variantChanged && sizeStep < 0 && fixes.includes("too_long")) {
    note = `${z} reaches ${signedCm(dHem)} cm length, but takes ${fmtCm(dChest)} cm off the chest`;
  } else if (variantChanged) {
    const sleeve = dSleeve !== null && dSleeve !== 0 ? `, ${signedCm(dSleeve)} cm sleeves` : "";
    const chest = sizeStep === 0 ? " at the same chest" : `, ${signedCm(dChest)} cm chest`;
    const solved = fixes.length > 0 ? ` — fixes '${fixes.map((f) => COMPLAINT_LABEL[f]).join("', '")}'${sizeStep === 0 ? " without changing size" : ""}` : "";
    note = `${label}: ${signedCm(dHem)} cm length${sleeve}${chest}${solved}`;
  } else if (fixes.includes("too_tight") || fixes.includes("too_loose")) {
    note = `${z} changes the chest by ${signedCm(dChest)} cm and the length by ${signedCm(dHem)} cm`;
  } else {
    note = `${label}: ${signedCm(dHem)} cm length, ${signedCm(dChest)} cm chest`;
  }
  if (!inStock) note += ` · Out of stock in ${label}`;
  return note;
}
