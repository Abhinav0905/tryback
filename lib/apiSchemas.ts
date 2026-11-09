// Zod schemas for API request bodies. Each schema is checked against the shared
// domain type with `satisfies`, so a drift in lib/types.ts fails the typecheck.

import { z } from "zod";
import { STYLE_CHIPS } from "./catalog";
import type {
  BodyKeypoints,
  Calibration,
  FitComplaint,
  GateMetrics,
  GateResult,
  Keypoint,
  PhotoMeasurements,
  Point,
  Pom,
  PreflightCheck,
  PreflightResult,
  ReasonCode,
  SizeCode,
} from "./types";

const finite = () => z.number().refine(Number.isFinite, "must be a finite number");

export const SizeSchema = z.enum(["XS", "S", "M", "L", "XL"]) satisfies z.ZodType<SizeCode>;

export const ReasonSchema = z.enum(["style_colour", "fit_size", "other"]) satisfies z.ZodType<ReasonCode>;

export const FitComplaintSchema = z.enum([
  "too_short",
  "too_long",
  "too_tight",
  "too_loose",
  "sleeves_long",
  "sleeves_short",
]) satisfies z.ZodType<FitComplaint>;

const STYLE_CHIP_IDS = STYLE_CHIPS.map((c) => c.id) as [string, ...string[]];
export const StyleChipIdSchema = z.enum(STYLE_CHIP_IDS);

/* ───────────── Capture & measurements ───────────── */

const PointSchema = z.object({ x: finite(), y: finite() }) satisfies z.ZodType<Point>;

const KeypointSchema = z.object({
  x: finite(),
  y: finite(),
  visibility: finite(),
}) satisfies z.ZodType<Keypoint>;

export const BodyKeypointsSchema = z.object({
  nose: KeypointSchema,
  leftEye: KeypointSchema,
  rightEye: KeypointSchema,
  leftShoulder: KeypointSchema,
  rightShoulder: KeypointSchema,
  leftElbow: KeypointSchema,
  rightElbow: KeypointSchema,
  leftWrist: KeypointSchema,
  rightWrist: KeypointSchema,
  leftHip: KeypointSchema,
  rightHip: KeypointSchema,
  leftKnee: KeypointSchema,
  rightKnee: KeypointSchema,
  leftAnkle: KeypointSchema,
  rightAnkle: KeypointSchema,
}) satisfies z.ZodType<BodyKeypoints>;

const PomSchema = z.object({
  hpsToHemCm: finite(),
  sleeveCm: finite().nullable(),
  halfChestCm: finite(),
}) satisfies z.ZodType<Pom>;

export const CalibrationSchema = z.object({
  method: z.enum(["garment", "height"]),
  pxPerCm: finite().refine((n) => n > 0, "must be positive"),
  uncertaintyCm: finite().refine((n) => n >= 0, "must be ≥ 0"),
  hpsY: finite(),
  observedHemY: finite(),
  observedSleeveEnd: PointSchema.nullable(),
  centerX: finite(),
  hemHalfWidthPx: finite(),
  purchasedSize: SizeSchema,
  purchasedPom: PomSchema,
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
}) satisfies z.ZodType<Calibration>;

export const PhotoMeasurementsSchema = z.object({
  keypoints: BodyKeypointsSchema,
  calibration: CalibrationSchema.nullable(),
  easeRatio: finite().nullable(),
  hemCm: finite().nullable(),
  garmentMaskArea: finite(),
  observedGarmentLab: z.tuple([finite(), finite(), finite()]).nullable(),
}) satisfies z.ZodType<PhotoMeasurements>;

const PreflightCheckSchema = z.object({
  id: z.enum(["full_body", "single_person", "frontal", "garment_visible", "torso_unobstructed", "lighting", "sharpness"]),
  ok: z.boolean(),
  message: z.string().max(300),
  value: finite().optional(),
}) satisfies z.ZodType<PreflightCheck>;

export const PreflightResultSchema = z.object({
  ok: z.boolean(),
  checks: z.array(PreflightCheckSchema).max(20),
  overridden: z.boolean(),
}) satisfies z.ZodType<PreflightResult>;

/* ───────────── Gate ───────────── */

export const GateMetricsSchema = z.object({
  colourDeltaE: finite().nullable(),
  residueFraction: finite().nullable(),
  silhouetteIoU: finite().nullable(),
  identityDiff: finite().nullable(),
  hemErrorCm: finite().nullable(),
  garmentCoverage: finite().nullable(),
}) satisfies z.ZodType<GateMetrics>;

export const GateResultSchema = z.object({
  verdict: z.enum(["pass", "retry", "badge", "drop"]),
  metrics: GateMetricsSchema,
  reasons: z.array(z.string().max(300)).max(30),
  badge: z.string().max(120).nullable(),
  fallbackVerdict: z.enum(["badge", "drop"]).optional(),
  computedAt: z.string().max(64),
  computeMs: finite().refine((n) => n >= 0, "must be ≥ 0"),
}) satisfies z.ZodType<GateResult>;

/* ───────────── Request bodies ───────────── */

export const CreateReturnBody = z.object({
  orderId: z.string().trim().min(1).max(32),
  email: z.string().trim().min(1).max(254),
  lineIndex: z.number().int().min(0).max(100),
});

export const ReasonBody = z.object({
  reason: ReasonSchema,
  fitComplaints: z.array(FitComplaintSchema).max(12).optional(),
});

/** `adultAttested` is checked separately first so a missing attestation gets its own error code. */
export const PhotoPayload = z.object({
  adultAttested: z.literal(true),
  preflight: PreflightResultSchema,
  measurements: PhotoMeasurementsSchema.nullable().optional(),
});

export const FormBody = z.object({
  chips: z.array(StyleChipIdSchema).max(STYLE_CHIPS.length * 2),
  freeText: z.string().max(500).default(""),
});

export const GateBody = z.object({ gate: GateResultSchema });

export const SizePreviewBody = z.object({
  skuId: z.string().min(1).max(128),
  size: SizeSchema,
});

export const ResolveBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exchange"), skuId: z.string().min(1).max(128), size: SizeSchema }),
  z.object({ type: z.literal("refund") }),
]);

export const LiveBody = z.object({ code: z.string().min(1).max(200) });

export const OrderQuery = z.object({ email: z.string().trim().min(1).max(254) });
