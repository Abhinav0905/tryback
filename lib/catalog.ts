// Fictional demo brand "Fernweave" — catalogue, size charts (points of measure),
// inventory and demo orders. Everything here is invented for the hackathon demo.
// Replace product images in /public/catalog with your own photographed garments
// (the try-on API needs real product shots) and keep the POM numbers tape-measured.

import type {
  Category,
  FitComplaint,
  FitIntent,
  IssueType,
  LengthClass,
  LengthVariant,
  Neckline,
  Order,
  Pom,
  Silhouette,
  SizeCode,
  Sku,
} from "./types";
import { SIZES } from "./types";

export const BRAND = {
  name: "Fernweave",
  tagline: "Everyday dresses & layers",
  /** Labelled everywhere as fictional. */
  fictional: true,
};

/** Store credit promised to shoppers who exchange instead of refunding (recorded on the outcome). */
export const EXCHANGE_BONUS_USD = 10;

/* ───────────── Grade rules (per size step) ───────────── */

/** Length grows slowly between sizes; width grows fast. This asymmetry is the core size-path insight. */
export const GRADE = {
  lengthCm: 1.5,
  sleeveCm: 1.0,
  halfChestCm: 2.5,
} as const;

export const VARIANT_OFFSETS: Record<LengthVariant, { lengthCm: number; sleeveCm: number }> = {
  regular: { lengthCm: 0, sleeveCm: 0 },
  petite: { lengthCm: -5, sleeveCm: -3 },
  tall: { lengthCm: 6, sleeveCm: 4 },
};

function gradePoms(base: Pom, variant: LengthVariant): Record<SizeCode, Pom> {
  const mIndex = SIZES.indexOf("M");
  const off = VARIANT_OFFSETS[variant];
  const out = {} as Record<SizeCode, Pom>;
  SIZES.forEach((size, i) => {
    const step = i - mIndex;
    out[size] = {
      hpsToHemCm: round1(base.hpsToHemCm + off.lengthCm + step * GRADE.lengthCm),
      sleeveCm:
        base.sleeveCm === null ? null : round1(base.sleeveCm + off.sleeveCm + step * GRADE.sleeveCm),
      halfChestCm: round1(base.halfChestCm + step * GRADE.halfChestCm),
    };
  });
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ───────────── Families ───────────── */

interface FamilyDef {
  family: string;
  name: string;
  category: Category;
  silhouette: Silhouette;
  lengthClass: LengthClass;
  neckline: Neckline;
  fit: FitIntent;
  price: number;
  /** Size M, regular length. */
  baseM: Pom;
  fabric: string;
  description: string;
  /** Used to build the API title: "{titleStem}, {colour}". */
  titleStem: string;
  hasAlt: boolean;
  colourways: { key: string; colorName: string; colorHex: string; variant?: LengthVariant; inventory: number[] }[];
}

const FAMILIES: FamilyDef[] = [
  {
    family: "wrap-dress",
    name: "Wrap Dress",
    category: "dress",
    silhouette: "wrap",
    lengthClass: "knee",
    neckline: "v",
    fit: "fitted",
    price: 89,
    baseM: { hpsToHemCm: 98, sleeveCm: 58, halfChestCm: 46 },
    fabric: "Viscose crepe",
    description: "A close-fitting wrap with a tie waist and long sleeves.",
    titleStem: "Women's knee-length wrap dress, V-neck, long sleeves, tie waist, fitted",
    hasAlt: true,
    colourways: [
      { key: "mustard", colorName: "Mustard", colorHex: "#C9A227", inventory: [3, 6, 4, 5, 2] },
      { key: "emerald", colorName: "Emerald", colorHex: "#1F7A5A", inventory: [2, 5, 6, 4, 3] },
      { key: "navy", colorName: "Navy", colorHex: "#1F2A44", inventory: [4, 4, 5, 3, 1] },
    ],
  },
  {
    family: "aline-midi",
    name: "A-line Midi Dress",
    category: "dress",
    silhouette: "a-line",
    lengthClass: "midi",
    neckline: "square",
    fit: "relaxed",
    price: 89,
    baseM: { hpsToHemCm: 115, sleeveCm: 24, halfChestCm: 50 },
    fabric: "Cotton poplin",
    description: "Skims the hip and flares to mid-calf; square neck, short sleeves.",
    titleStem: "Women's A-line midi dress, square neckline, short sleeves, relaxed flared skirt",
    hasAlt: true,
    colourways: [
      { key: "cobalt", colorName: "Cobalt", colorHex: "#2851A3", inventory: [2, 4, 7, 5, 2] },
      { key: "sage", colorName: "Sage", colorHex: "#9CAF88", inventory: [1, 3, 5, 4, 2] },
      { key: "black", colorName: "Black", colorHex: "#1C1C1C", inventory: [3, 5, 6, 6, 4] },
    ],
  },
  {
    family: "shirt-dress",
    name: "Shirt Dress",
    category: "dress",
    silhouette: "shirt-dress",
    lengthClass: "knee",
    neckline: "collar",
    fit: "regular",
    price: 95,
    baseM: { hpsToHemCm: 100, sleeveCm: 60, halfChestCm: 49 },
    fabric: "Tencel twill",
    description: "Button-through with a soft collar and a self-tie belt.",
    titleStem: "Women's knee-length shirt dress, collar, button front, long sleeves, belted",
    hasAlt: true,
    colourways: [
      { key: "sage", colorName: "Sage", colorHex: "#9CAF88", inventory: [2, 3, 4, 3, 2] },
      { key: "ecru", colorName: "Ecru", colorHex: "#EDE6D6", inventory: [1, 4, 0, 2, 1] },
      { key: "rust", colorName: "Rust", colorHex: "#A4502C", inventory: [2, 2, 3, 3, 1] },
    ],
  },
  {
    family: "slip-dress",
    name: "Slip Dress",
    category: "dress",
    silhouette: "slip",
    lengthClass: "midi",
    neckline: "v",
    fit: "regular",
    price: 79,
    baseM: { hpsToHemCm: 118, sleeveCm: null, halfChestCm: 47 },
    fabric: "Satin-back crepe",
    description: "Bias-cut midi slip with adjustable straps.",
    titleStem: "Women's satin midi slip dress, V-neck, thin straps, bias cut, sleeveless",
    hasAlt: true,
    colourways: [
      { key: "black", colorName: "Black", colorHex: "#1C1C1C", inventory: [3, 4, 4, 3, 2] },
      { key: "champagne", colorName: "Champagne", colorHex: "#D8C3A5", inventory: [2, 3, 3, 2, 0] },
    ],
  },
  {
    family: "shift-dress",
    name: "Shift Dress",
    category: "dress",
    silhouette: "shift",
    lengthClass: "above-knee",
    neckline: "boat",
    fit: "relaxed",
    price: 85,
    // Sleeveless, matching the product photo (assets-src/catalog/manifest.json).
    baseM: { hpsToHemCm: 88, sleeveCm: null, halfChestCm: 52 },
    fabric: "Linen blend",
    description: "Straight, easy sleeveless shift that stops above the knee; boat neck and a slim tonal waist trim.",
    titleStem: "Women's above-knee shift dress, boat neckline, sleeveless, straight relaxed fit",
    hasAlt: true,
    colourways: [
      { key: "terracotta", colorName: "Terracotta", colorHex: "#C0643F", inventory: [2, 3, 4, 2, 1] },
      { key: "navy", colorName: "Navy", colorHex: "#1F2A44", inventory: [2, 4, 4, 3, 2] },
    ],
  },
  {
    family: "linen-shirt",
    name: "Linen Shirt",
    category: "top",
    silhouette: "relaxed",
    lengthClass: "hip",
    neckline: "collar",
    fit: "regular",
    price: 59,
    baseM: { hpsToHemCm: 72, sleeveCm: 62, halfChestCm: 55 },
    fabric: "Washed linen",
    description: "Relaxed button-down in washed linen.",
    titleStem: "Men's relaxed linen shirt, button-down collar, long sleeves, hip length",
    hasAlt: false,
    colourways: [
      { key: "white", colorName: "White", colorHex: "#F4F3EF", inventory: [3, 5, 6, 5, 3] },
      { key: "sky", colorName: "Sky", colorHex: "#A9C6E3", inventory: [2, 4, 5, 4, 2] },
      { key: "olive", colorName: "Olive", colorHex: "#6B6E3A", inventory: [1, 3, 4, 3, 2] },
      { key: "white", colorName: "White", colorHex: "#F4F3EF", variant: "tall", inventory: [0, 2, 3, 3, 2] },
      { key: "sky", colorName: "Sky", colorHex: "#A9C6E3", variant: "tall", inventory: [0, 1, 2, 2, 1] },
    ],
  },
  {
    family: "knit-top",
    name: "Ribbed Knit Top",
    category: "top",
    silhouette: "fitted",
    lengthClass: "hip",
    neckline: "crew",
    fit: "fitted",
    price: 49,
    baseM: { hpsToHemCm: 60, sleeveCm: 60, halfChestCm: 44 },
    fabric: "Cotton rib",
    description: "Close-fitting rib knit with a crew neck.",
    titleStem: "Women's fitted ribbed knit top, crew neck, long sleeves",
    hasAlt: false,
    colourways: [
      { key: "oat", colorName: "Oat", colorHex: "#D9CBB0", inventory: [3, 4, 5, 4, 2] },
      { key: "cocoa", colorName: "Cocoa", colorHex: "#6B4A3A", inventory: [2, 4, 4, 3, 2] },
    ],
  },
  {
    family: "trench",
    name: "Trench Coat",
    category: "outerwear",
    silhouette: "trench",
    lengthClass: "knee",
    neckline: "collar",
    fit: "regular",
    price: 189,
    baseM: { hpsToHemCm: 104, sleeveCm: 63, halfChestCm: 56 },
    fabric: "Cotton gabardine",
    // Single-breasted with a tie belt, matching the product photo (assets-src/catalog/manifest.json).
    description: "Single-breasted, tie-belted, knee-length trench.",
    titleStem: "Unisex single-breasted trench coat, notch lapels, tie belt, knee length, long sleeves",
    hasAlt: true,
    colourways: [
      { key: "stone", colorName: "Stone", colorHex: "#B9A98C", inventory: [2, 3, 4, 3, 2] },
      { key: "navy", colorName: "Navy", colorHex: "#1F2A44", inventory: [1, 2, 3, 2, 1] },
      { key: "stone", colorName: "Stone", colorHex: "#B9A98C", variant: "tall", inventory: [0, 2, 3, 2, 1] },
    ],
  },
];

function buildSkus(): Sku[] {
  const skus: Sku[] = [];
  for (const f of FAMILIES) {
    for (const c of f.colourways) {
      const variant: LengthVariant = c.variant ?? "regular";
      const id = `fw-${f.family}-${c.key}${variant === "regular" ? "" : `-${variant}`}`;
      const inventory = {} as Record<SizeCode, number>;
      SIZES.forEach((s, i) => (inventory[s] = c.inventory[i] ?? 0));
      const variantLabel = variant === "regular" ? "" : ` ${variant === "tall" ? "Tall" : "Petite"}`;
      skus.push({
        id,
        family: f.family,
        name: `${f.name}${variantLabel} — ${c.colorName}`,
        category: f.category,
        silhouette: f.silhouette,
        lengthClass: f.lengthClass,
        neckline: f.neckline,
        fit: f.fit,
        lengthVariant: variant,
        colorName: c.colorName,
        colorHex: c.colorHex,
        price: f.price + (variant === "tall" ? 5 : 0),
        image: `/catalog/${id}.png`,
        altImage: f.hasAlt ? `/catalog/${id}-alt.png` : null,
        apiTitle: `${f.titleStem}${variant === "tall" ? ", tall length" : ""}, ${c.colorName.toLowerCase()}`.slice(0, 120),
        poms: gradePoms(f.baseM, variant),
        inventory,
        fabric: f.fabric,
        description: f.description,
      });
    }
  }
  return skus;
}

export const SKUS: readonly Sku[] = buildSkus();
const SKU_INDEX = new Map(SKUS.map((s) => [s.id, s]));

export function getSku(id: string): Sku | undefined {
  return SKU_INDEX.get(id);
}

export function requireSku(id: string): Sku {
  const s = SKU_INDEX.get(id);
  if (!s) throw new Error(`Unknown SKU ${id}`);
  return s;
}

export function familyOf(sku: Sku): Sku[] {
  return SKUS.filter((s) => s.family === sku.family);
}

/* ───────────── Demo orders (fictional customers; photos only from consenting adult team members) ───────────── */

export const ORDERS: readonly Order[] = [
  {
    id: "1042",
    email: "priya@example.com",
    customerName: "Priya",
    placedAt: "2026-10-28T10:12:00.000Z",
    deliveredAt: "2026-11-01T15:40:00.000Z",
    lines: [
      { skuId: "fw-wrap-dress-mustard", size: "M", price: 89 },
      { skuId: "fw-knit-top-oat", size: "M", price: 49 },
    ],
  },
  {
    id: "1043",
    email: "daniel@example.com",
    customerName: "Daniel",
    placedAt: "2026-10-29T08:30:00.000Z",
    deliveredAt: "2026-11-02T12:05:00.000Z",
    lines: [
      { skuId: "fw-linen-shirt-white", size: "M", price: 59 },
      { skuId: "fw-trench-stone", size: "M", price: 189 },
    ],
  },
  {
    id: "1044",
    email: "mei@example.com",
    customerName: "Mei",
    placedAt: "2026-10-30T18:45:00.000Z",
    deliveredAt: "2026-11-03T09:20:00.000Z",
    lines: [
      { skuId: "fw-slip-dress-champagne", size: "S", price: 79 },
      { skuId: "fw-shift-dress-terracotta", size: "S", price: 85 },
    ],
  },
];

export function getOrder(id: string): Order | undefined {
  return ORDERS.find((o) => o.id === id.replace(/^#/, "").trim());
}

/* ───────────── Return-form chips ───────────── */

export interface StyleChip {
  id: string;
  label: string;
  issue: IssueType;
}

/** Shown after the "Style or colour didn't work" reason. Never mention skin tone or body judgements. */
export const STYLE_CHIPS: readonly StyleChip[] = [
  { id: "colour_not_me", label: "Colour isn't me", issue: "colour" },
  { id: "too_clingy", label: "Too clingy", issue: "too_clingy" },
  { id: "too_boxy", label: "Too boxy / shapeless", issue: "too_boxy" },
  { id: "too_short", label: "Shorter than I wanted", issue: "too_short" },
  { id: "too_long", label: "Longer than I wanted", issue: "too_long" },
  { id: "neckline", label: "Neckline isn't me", issue: "neckline" },
  { id: "print", label: "Print / colour too loud", issue: "print" },
  { id: "fabric", label: "Fabric feels wrong", issue: "fabric" },
];

export interface FitChip {
  id: FitComplaint;
  label: string;
}

export const FIT_CHIPS: readonly FitChip[] = [
  { id: "too_short", label: "Too short" },
  { id: "too_long", label: "Too long" },
  { id: "too_tight", label: "Too tight" },
  { id: "too_loose", label: "Too loose" },
  { id: "sleeves_long", label: "Sleeves too long" },
  { id: "sleeves_short", label: "Sleeves too short" },
];

/** Length classes ordered short → long (used to classify shorter/longer transitions). */
export const LENGTH_ORDER: readonly LengthClass[] = [
  "cropped",
  "hip",
  "thigh",
  "above-knee",
  "knee",
  "midi",
  "maxi",
];

/** Looseness rank (used to classify slim↔loose transitions). */
export const FIT_ORDER: readonly FitIntent[] = ["fitted", "regular", "relaxed", "oversized"];

export const SILHOUETTE_LOOSENESS: Record<Silhouette, number> = {
  bodycon: 0,
  fitted: 0,
  wrap: 1,
  slip: 1,
  "shirt-dress": 2,
  trench: 2,
  shift: 3,
  relaxed: 3,
  "a-line": 3,
  boxy: 4,
};
