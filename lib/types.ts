// Shared domain types for TryBack. This file is the contract between modules:
// change it only deliberately, and keep server, client and tests in sync.

/* ───────────────────────── Catalogue ───────────────────────── */

export type SizeCode = "XS" | "S" | "M" | "L" | "XL";
export const SIZES: readonly SizeCode[] = ["XS", "S", "M", "L", "XL"] as const;

export type Category = "dress" | "top" | "outerwear";
export type Silhouette =
  | "wrap"
  | "a-line"
  | "shift"
  | "bodycon"
  | "shirt-dress"
  | "slip"
  | "boxy"
  | "fitted"
  | "relaxed"
  | "trench";
export type LengthClass =
  | "cropped"
  | "hip"
  | "thigh"
  | "above-knee"
  | "knee"
  | "midi"
  | "maxi";
export type Neckline = "v" | "crew" | "square" | "collar" | "scoop" | "boat";
export type FitIntent = "fitted" | "regular" | "relaxed" | "oversized";
export type LengthVariant = "regular" | "petite" | "tall";

/** Garment points-of-measure for one size, in centimetres (flat garment). */
export interface Pom {
  /** High-point-shoulder to hem. */
  hpsToHemCm: number;
  /** Shoulder point to sleeve end; null for sleeveless. */
  sleeveCm: number | null;
  /** Half chest (pit to pit, flat). Circumference ≈ 2×. */
  halfChestCm: number;
}

export interface Sku {
  id: string;
  /** Style family: same pattern, different colourways/length variants share a family. */
  family: string;
  name: string;
  category: Category;
  silhouette: Silhouette;
  lengthClass: LengthClass;
  neckline: Neckline;
  fit: FitIntent;
  lengthVariant: LengthVariant;
  colorName: string;
  /** sRGB hex of the dominant garment colour (used for UI and the colour gate). */
  colorHex: string;
  /** USD */
  price: number;
  /** Public path of the primary product shot, e.g. /catalog/fw-wrap-mustard.png */
  image: string;
  /** Alternate product shot used when the fidelity gate asks for a retry. */
  altImage: string | null;
  /** ≤120 chars; sent as `title` to the try-on API (helps placement/fit). */
  apiTitle: string;
  poms: Record<SizeCode, Pom>;
  inventory: Record<SizeCode, number>;
  fabric: string;
  description: string;
}

/* ───────────────────────── Orders ───────────────────────── */

export interface OrderLine {
  skuId: string;
  size: SizeCode;
  /** USD paid */
  price: number;
}

export interface Order {
  id: string;
  email: string;
  customerName: string;
  placedAt: string;
  deliveredAt: string;
  lines: OrderLine[];
}

/* ───────────────────────── Return reasons & diagnosis ───────────────────────── */

export type ReasonCode = "style_colour" | "fit_size" | "other";

export type FitComplaint =
  | "too_short"
  | "too_long"
  | "too_tight"
  | "too_loose"
  | "sleeves_long"
  | "sleeves_short";

export type IssueType =
  | "colour"
  | "too_long"
  | "too_short"
  | "too_clingy"
  | "too_boxy"
  | "neckline"
  | "print"
  | "fabric";

export type KeepAttribute =
  | "category"
  | "silhouette"
  | "length"
  | "neckline"
  | "colour"
  | "fit";

export interface DiagnosisIssue {
  type: IssueType;
  /** 0..1 */
  confidence: number;
  /** Short human-readable evidence ("chip: Too clingy at the hip", "ease ratio 1.03"). */
  evidence: string;
}

export interface Diagnosis {
  issues: DiagnosisIssue[];
  /** Attributes the shopper implicitly likes and alternatives should keep. */
  keepAttributes: KeepAttribute[];
  /** One sentence, shopper-facing, never judges the body or skin tone. */
  summary: string;
  source: "llm" | "rules";
  model?: string;
}

/* ───────────────────────── Candidates & transitions ───────────────────────── */

/** How the alternative differs from the garment the shopper is wearing. Drives gate thresholds + benchmark buckets. */
export type TransitionType =
  | "colour_only"
  | "like_silhouette"
  | "shorter"
  | "longer"
  | "slim_to_loose"
  | "loose_to_slim";

export const TRANSITIONS: readonly TransitionType[] = [
  "colour_only",
  "like_silhouette",
  "shorter",
  "longer",
  "slim_to_loose",
  "loose_to_slim",
] as const;

export interface Candidate {
  skuId: string;
  size: SizeCode;
  transition: TransitionType;
  /** Higher is better. */
  score: number;
  /** Issues this alternative addresses. */
  fixes: IssueType[];
  /** Shopper-facing one-liner: "Looser A-line through the hip, in cobalt". */
  why: string;
  /** USD, alternative price − paid price (positive = shopper pays more). */
  priceDiff: number;
}

/** Size-path option (zero credits): what an exchange to another size / length variant would change. */
export interface SizeOption {
  skuId: string;
  size: SizeCode;
  lengthVariant: LengthVariant;
  /** Relative to the garment the shopper is wearing (purchased SKU+size). */
  deltaHemCm: number;
  deltaSleeveCm: number | null;
  /** Half-chest delta ×2, i.e. circumference delta. */
  deltaChestCircCm: number;
  fixes: FitComplaint[];
  /** Human-readable side effects, e.g. "+5 cm wider through the chest". */
  tradeoffs: string[];
  recommended: boolean;
  inStock: boolean;
  priceDiff: number;
  note: string;
}

/* ───────────────────────── Rendering ───────────────────────── */

export type RenderPhase = "speculative" | "post_diagnosis" | "retry" | "size_preview";
export type RenderStatus = "queued" | "running" | "success" | "failed" | "skipped";
export type ProviderName = "clothsy" | "dev";

export type GateVerdict = "pass" | "retry" | "badge" | "drop";

export interface GateMetrics {
  /** CIEDE2000 between expected (lighting-corrected) and rendered garment colour. */
  colourDeltaE: number | null;
  /** Fraction of rendered garment pixels still within ΔE<10 of the returned garment's observed colour. */
  residueFraction: number | null;
  /** IoU between returned-garment mask (original photo) and rendered-garment mask. High IoU on a silhouette change ⇒ leakage. */
  silhouetteIoU: number | null;
  /** Mean abs difference (0..1) in the face/head region between original and render — identity drift. */
  identityDiff: number | null;
  /** |rendered hem − projected hem| in cm (needs calibration). */
  hemErrorCm: number | null;
  /** Fraction of the torso box covered by the rendered garment mask. */
  garmentCoverage: number | null;
}

export interface GateResult {
  verdict: GateVerdict;
  metrics: GateMetrics;
  /** Machine-ish reasons, e.g. ["residue 0.31 > 0.20 (mustard leaking at hem)"] */
  reasons: string[];
  /** Short shopper-facing badge when verdict === "badge", e.g. "Colour preview · silhouette approximate". */
  badge: string | null;
  /**
   * Only on a 'retry' verdict: what the verdict becomes if the server can't retry.
   * 'drop' when a failure is severe (identity drift, garment missing), else 'badge'.
   */
  fallbackVerdict?: "badge" | "drop";
  computedAt: string;
  computeMs: number;
}

export interface RenderJob {
  id: string;
  returnId: string;
  skuId: string;
  size: SizeCode;
  phase: RenderPhase;
  transition: TransitionType;
  garmentVariant: "primary" | "alt";
  status: RenderStatus;
  /** Which provider produced the image (cache hits keep the original provider). */
  provider: ProviderName | null;
  fromCache: boolean;
  cacheKey: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Provider wall-clock latency for the render (for cache hits: the original latency). */
  latencyMs: number | null;
  /** App-relative image URL: /api/renders/<cacheKey>, plus ?v=<version> for a re-render of the same key. */
  resultUrl: string | null;
  error: { code: string; message: string } | null;
  /** True only when a real Clothsy credit was consumed by THIS job. */
  creditCharged: boolean;
  gate: GateResult | null;
  /** If this job is a gate-triggered retry, the id of the job it retries. */
  retryOf: string | null;
  /** If a retry was spawned from this job, its id. */
  supersededBy: string | null;
  /** Provider-side id (Clothsy try-on id). */
  externalId: string | null;
}

/* ───────────────────────── Capture, pose & calibration ───────────────────────── */

export type PreflightCheckId =
  | "full_body"
  | "single_person"
  | "frontal"
  | "garment_visible"
  | "torso_unobstructed"
  | "lighting"
  | "sharpness";

export interface PreflightCheck {
  id: PreflightCheckId;
  ok: boolean;
  /** Shopper-facing fix prompt when !ok, short confirmation when ok. */
  message: string;
  value?: number;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  /** Dev/demo only: the shopper (or developer) continued despite failing checks. */
  overridden: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Keypoint extends Point {
  /** 0..1 */
  visibility: number;
}

/** Pixel coordinates in the normalised uploaded photo (the exact JPEG sent to the server). */
export interface BodyKeypoints {
  nose: Keypoint;
  leftEye: Keypoint;
  rightEye: Keypoint;
  leftShoulder: Keypoint;
  rightShoulder: Keypoint;
  leftElbow: Keypoint;
  rightElbow: Keypoint;
  leftWrist: Keypoint;
  rightWrist: Keypoint;
  leftHip: Keypoint;
  rightHip: Keypoint;
  leftKnee: Keypoint;
  rightKnee: Keypoint;
  leftAnkle: Keypoint;
  rightAnkle: Keypoint;
}

export interface Calibration {
  /** "garment": returned garment's known HPS→hem length is the ruler. "height": fallback from stated height. */
  method: "garment" | "height";
  pxPerCm: number;
  /** ± cm, one sigma-ish; drawn as a band. */
  uncertaintyCm: number;
  /** y (px) of the high-point-shoulder line. */
  hpsY: number;
  /** y (px) of the observed hem of the worn garment. */
  observedHemY: number;
  /** Observed sleeve end (px), if detectable. */
  observedSleeveEnd: Point | null;
  /** x (px) centre line of the torso, for drawing. */
  centerX: number;
  /** Half width (px) of the garment at hem level, for drawing line extents. */
  hemHalfWidthPx: number;
  purchasedSize: SizeCode;
  purchasedPom: Pom;
  imageWidth: number;
  imageHeight: number;
}

export interface PhotoMeasurements {
  keypoints: BodyKeypoints;
  calibration: Calibration | null;
  /** Garment mask width at hip level ÷ hip landmark distance. ~1.0 = clingy, >1.3 = loose. */
  easeRatio: number | null;
  /** Observed HPS→hem length in cm (needs calibration from height; with garment calibration it equals the POM by construction). */
  hemCm: number | null;
  /** Fraction of the image covered by the clothes mask. */
  garmentMaskArea: number;
  /** Mean CIELAB of the worn garment in the original photo (lighting reference for the gate). */
  observedGarmentLab: [number, number, number] | null;
}

/** A projected size/variant line drawn on the real photo (client-side, zero credits). */
export interface SizeLine {
  skuId: string;
  size: SizeCode;
  lengthVariant: LengthVariant;
  hemY: number;
  /** Half-height of the uncertainty band in px. */
  bandPx: number;
  deltaHemCm: number;
  label: string;
}

/* ───────────────────────── Return case ───────────────────────── */

export type ReturnStatus =
  | "started"
  | "reason_selected"
  | "photo_uploaded"
  | "form_submitted"
  | "resolved";

export interface ReturnOutcome {
  type: "exchange" | "refund";
  skuId: string | null;
  size: SizeCode | null;
  /** USD, positive = shopper paid more. */
  priceDiff: number;
  /** USD of the original order line kept by the merchant (0 for refunds). */
  retainedRevenue: number;
  /** USD store credit given as the exchange bonus (a cost netted out of revenue retained). */
  bonusCredit?: number;
  at: string;
}

export interface ReturnCase {
  id: string;
  orderId: string;
  lineIndex: number;
  skuId: string;
  size: SizeCode;
  /** USD paid for the line. */
  price: number;
  status: ReturnStatus;
  reason: ReasonCode | null;
  fitComplaints: FitComplaint[];
  chips: string[];
  freeText: string;
  consent: { adultAttested: true; at: string } | null;
  photo: { url: string; hash: string; width: number; height: number; uploadedAt: string } | null;
  photoSkipped: boolean;
  preflight: PreflightResult | null;
  measurements: PhotoMeasurements | null;
  diagnosis: Diagnosis | null;
  candidates: Candidate[];
  renders: RenderJob[];
  timeline: {
    createdAt: string;
    reasonAt: string | null;
    /** Speculative renders start here — the "honest clock" zero. */
    photoAt: string | null;
    formSubmittedAt: string | null;
    /** First successful render that the shopper can see. */
    firstCardAt: string | null;
    resolvedAt: string | null;
  };
  outcome: ReturnOutcome | null;
  /** Real Clothsy credits consumed. */
  creditsSpent: number;
  /** Renders produced by the dev double (no credits). */
  simulatedRenders: number;
  /** Seeded demo history (clearly labelled in the dashboard). */
  seeded?: boolean;
  /**
   * sha256 of the browser token (cookie tb_viewer) that created this return. Lets /bench show
   * a shopper's photo and renders to that browser only (plus code holders), never to everyone.
   */
  viewerHash?: string | null;
}

/* ───────────────────────── Merchant metrics ───────────────────────── */

export interface LatencyStats {
  count: number;
  p50: number | null;
  p95: number | null;
}

export interface MerchantMetrics {
  generatedAt: string;
  includesSeeded: boolean;
  totals: {
    returnsStarted: number;
    photoOptIns: number;
    /** 0..1 among returns that reached the photo step */
    photoOptInRate: number | null;
    exchanges: number;
    refunds: number;
    revenueRetained: number;
    creditsSpent: number;
    simulatedRenders: number;
    creditsPerReturn: number | null;
    costPerReturnUsd: number | null;
  };
  latency: {
    overall: LatencyStats;
    byTransition: Record<TransitionType, LatencyStats & { gatePassRate: number | null }>;
    /** form submitted → first card visible (the shopper-perceived wait). */
    timeToFirstCardAfterFormMs: LatencyStats;
    /**
     * How many of the samples above come from the seeded demo history. Seeded latencies are
     * generated, not measured: the dashboard labels them "illustrative" whenever this is > 0.
     */
    seededSamples: { renders: number; firstCards: number };
  };
  gate: { total: number; pass: number; retry: number; badge: number; drop: number };
  skuDiagnoses: { skuId: string; name: string; returns: number; issues: Partial<Record<IssueType, number>> }[];
  recent: { id: string; skuName: string; outcome: "exchange" | "refund" | "open"; at: string; retained: number; seeded: boolean }[];
}

/* ───────────────────────── App status ───────────────────────── */

export type TryOnMode = "auto" | "live" | "dev" | "replay";

export interface AppStatus {
  mode: TryOnMode;
  /** Which provider a new render would use right now. */
  activeProvider: ProviderName;
  hasClothsyKey: boolean;
  hasAnthropicKey: boolean;
  liveRendersToday: number;
  dailyLiveCap: number;
  maxRendersPerReturn: number;
}
