// Pose detection (browser): MediaPipe BlazePose → BodyKeypoints in photo pixels.

import type { Landmark, NormalizedLandmark, PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import type { BodyKeypoints, Keypoint } from "../types";
import { withPoseLandmarker } from "./mediapipe";

/** BlazePose 33-landmark indices for the joints we use. */
const IDX: Record<keyof BodyKeypoints, number> = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

export interface PoseDetection {
  keypoints: BodyKeypoints | null;
  personCount: number;
  /**
   * Torso yaw in degrees (0 = square to the camera) from the world-space shoulder
   * depth difference, or null when world landmarks are unavailable.
   */
  shoulderYawDeg: number | null;
}

function finite(n: number | undefined, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function toKeypoints(lms: NormalizedLandmark[], width: number, height: number): BodyKeypoints | null {
  if (lms.length < 29) return null;
  const out = {} as BodyKeypoints;
  for (const key of Object.keys(IDX) as (keyof BodyKeypoints)[]) {
    const l = lms[IDX[key]];
    const kp: Keypoint = {
      x: finite(l?.x) * width,
      y: finite(l?.y) * height,
      // Some builds omit visibility; fall back to presence, then 0 (treated as missing).
      visibility: Math.min(1, Math.max(0, finite(l?.visibility, finite(l?.presence, 0)))),
    };
    out[key] = kp;
  }
  return out;
}

/** Index of the most prominent pose: largest shoulder-to-hip box, i.e. the person nearest the camera. */
function primaryIndex(all: NormalizedLandmark[][]): number {
  let best = 0;
  let bestScore = -1;
  all.forEach((lms, i) => {
    const pts = [11, 12, 23, 24, 0, 27, 28].map((j) => lms[j]).filter((p): p is NormalizedLandmark => !!p);
    if (pts.length === 0) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const score = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function yawFromWorld(world: Landmark[] | undefined): number | null {
  const l = world?.[11];
  const r = world?.[12];
  if (!l || !r) return null;
  const dx = Math.abs(l.x - r.x);
  const dz = Math.abs(l.z - r.z);
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || dx + dz === 0) return null;
  return (Math.atan2(dz, dx) * 180) / Math.PI;
}

function fromResult(result: PoseLandmarkerResult, width: number, height: number): PoseDetection {
  try {
    const all = result.landmarks ?? [];
    const personCount = all.length;
    if (personCount === 0) return { keypoints: null, personCount: 0, shoulderYawDeg: null };
    const i = primaryIndex(all);
    return {
      keypoints: toKeypoints(all[i], width, height),
      personCount,
      shoulderYawDeg: yawFromWorld(result.worldLandmarks?.[i]),
    };
  } finally {
    result.close(); // frees any mask resources attached to the result
  }
}

/** Pose on a still image/canvas, with torso yaw for the frontal check. */
export async function detectPoseDetailed(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): Promise<PoseDetection> {
  if (!(width > 0 && height > 0)) throw new Error("detectPose: width and height must be positive");
  const result = await withPoseLandmarker("IMAGE", (t) => t.detect(source));
  return fromResult(result, width, height);
}

/** Pose on a still image/canvas. Keypoints are scaled to width×height (the normalised photo). */
export async function detectPose(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): Promise<{ keypoints: BodyKeypoints | null; personCount: number }> {
  const { keypoints, personCount } = await detectPoseDetailed(source, width, height);
  return { keypoints, personCount };
}

let lastVideoTs = -1;

/**
 * Pose on a live video frame (~4 fps coaching). Keypoints are in the raw (un-mirrored)
 * video frame's pixels. Timestamps must increase; we nudge equal/backwards ones forward.
 */
export async function detectPoseVideo(
  video: HTMLVideoElement,
  timestampMs: number,
): Promise<{ keypoints: BodyKeypoints | null; personCount: number }> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  // HAVE_CURRENT_DATA = 2: no frame yet (camera warming up).
  if (video.readyState < 2 || !width || !height) return { keypoints: null, personCount: 0 };
  const ts = Math.max(Math.floor(timestampMs), lastVideoTs + 1);
  lastVideoTs = ts;
  const result = await withPoseLandmarker("VIDEO", (t) => t.detectForVideo(video, ts));
  const { keypoints, personCount } = fromResult(result, width, height);
  return { keypoints, personCount };
}
