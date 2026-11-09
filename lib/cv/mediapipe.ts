// MediaPipe Tasks (browser only): lazy, process-wide singletons for pose and
// segmentation. WASM is served from /mediapipe, models from /models (public/).
// The library is imported dynamically so server rendering never evaluates it.
// Photos are processed entirely on-device here; nothing is uploaded by this module.

import type { FilesetResolver, ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";

type VisionModule = typeof import("@mediapipe/tasks-vision");
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
export type Delegate = "GPU" | "CPU";
export type PoseMode = "IMAGE" | "VIDEO";

export const MEDIAPIPE_WASM_BASE = "/mediapipe";
export const POSE_MODEL_URL = "/models/pose_landmarker_full.task";
export const SEGMENTER_MODEL_URL = "/models/selfie_multiclass_256x256.tflite";

/** selfie_multiclass_256x256 category indices. */
export const SEG = {
  background: 0,
  hair: 1,
  bodySkin: 2,
  faceSkin: 3,
  clothes: 4,
  others: 5,
} as const;

interface Handle<T> {
  task: T;
  delegate: Delegate;
}

type SlotKey = "pose:IMAGE" | "pose:VIDEO" | "segmenter";

const state: {
  vision: Promise<VisionModule> | null;
  fileset: Promise<WasmFileset> | null;
  slots: Partial<Record<SlotKey, Promise<Handle<PoseLandmarker | ImageSegmenter>>>>;
  /** Set once the GPU delegate has failed; later instances go straight to CPU. */
  gpuBroken: boolean;
} = { vision: null, fileset: null, slots: {}, gpuBroken: false };

function assertBrowser(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("MediaPipe vision runs in the browser only (lib/cv/* must not be imported on the server).");
  }
}

function loadVision(): Promise<VisionModule> {
  state.vision ??= import("@mediapipe/tasks-vision").catch((err: unknown) => {
    state.vision = null;
    throw new Error(`Couldn't load the on-device vision library: ${errMessage(err)}`);
  });
  return state.vision;
}

function loadFileset(): Promise<WasmFileset> {
  state.fileset ??= loadVision()
    .then((v) => v.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE))
    .catch((err: unknown) => {
      state.fileset = null;
      throw new Error(`Couldn't load the vision runtime from ${MEDIAPIPE_WASM_BASE}: ${errMessage(err)}`);
    });
  return state.fileset;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Try the GPU delegate first, fall back to CPU (WebGL unavailable, blocklisted, Safari quirks…). */
async function createWithFallback<T>(create: (delegate: Delegate) => Promise<T>): Promise<Handle<T>> {
  if (!state.gpuBroken) {
    try {
      return { task: await create("GPU"), delegate: "GPU" };
    } catch (err) {
      state.gpuBroken = true;
      console.warn("[TryBack CV] GPU delegate unavailable, using CPU:", errMessage(err));
    }
  }
  return { task: await create("CPU"), delegate: "CPU" };
}

function slot<T extends PoseLandmarker | ImageSegmenter>(
  key: SlotKey,
  create: () => Promise<Handle<T>>,
): Promise<Handle<T>> {
  const existing = state.slots[key] as Promise<Handle<T>> | undefined;
  if (existing) return existing;
  const p = create().catch((err: unknown) => {
    delete state.slots[key];
    throw err;
  });
  state.slots[key] = p as Promise<Handle<PoseLandmarker | ImageSegmenter>>;
  return p;
}

function poseHandle(mode: PoseMode): Promise<Handle<PoseLandmarker>> {
  assertBrowser();
  return slot<PoseLandmarker>(`pose:${mode}`, async () => {
    const [vision, fileset] = await Promise.all([loadVision(), loadFileset()]);
    try {
      return await createWithFallback((delegate) =>
        vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
          runningMode: mode,
          numPoses: 2,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        }),
      );
    } catch (err) {
      throw new Error(`Couldn't start pose detection: ${errMessage(err)}`);
    }
  });
}

function segmenterHandle(): Promise<Handle<ImageSegmenter>> {
  assertBrowser();
  return slot<ImageSegmenter>("segmenter", async () => {
    const [vision, fileset] = await Promise.all([loadVision(), loadFileset()]);
    try {
      return await createWithFallback((delegate) =>
        vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: SEGMENTER_MODEL_URL, delegate },
          runningMode: "IMAGE",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        }),
      );
    } catch (err) {
      throw new Error(`Couldn't start garment segmentation: ${errMessage(err)}`);
    }
  });
}

/** Pose landmarker singleton (numPoses 2 so we can tell when someone else is in frame). */
export async function getPoseLandmarker(mode: "IMAGE" | "VIDEO"): Promise<PoseLandmarker> {
  return (await poseHandle(mode)).task;
}

/** selfie_multiclass segmenter singleton: 0 bg, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others. */
export async function getSegmenter(): Promise<ImageSegmenter> {
  return (await segmenterHandle()).task;
}

/**
 * Run `fn` with a task; if it throws on the GPU delegate (lost WebGL context, driver
 * bug), rebuild that task on CPU and try once more.
 */
export async function withPoseLandmarker<R>(mode: PoseMode, fn: (task: PoseLandmarker) => R): Promise<R> {
  const h = await poseHandle(mode);
  try {
    return fn(h.task);
  } catch (err) {
    if (h.delegate !== "GPU") throw err;
    await demote(`pose:${mode}`, h, err);
    return fn((await poseHandle(mode)).task);
  }
}

export async function withSegmenter<R>(fn: (task: ImageSegmenter) => R): Promise<R> {
  const h = await segmenterHandle();
  try {
    return fn(h.task);
  } catch (err) {
    if (h.delegate !== "GPU") throw err;
    await demote("segmenter", h, err);
    return fn((await segmenterHandle()).task);
  }
}

async function demote(key: SlotKey, h: Handle<PoseLandmarker | ImageSegmenter>, err: unknown): Promise<void> {
  console.warn(`[TryBack CV] ${key} failed on GPU, retrying on CPU:`, errMessage(err));
  state.gpuBroken = true;
  if (state.slots[key]) delete state.slots[key];
  try {
    h.task.close();
  } catch {
    /* already gone */
  }
}

/** Warm the models (e.g. when the shopper reaches the photo step) so capture feels instant. */
export async function warmUpVision(opts: { video?: boolean } = {}): Promise<void> {
  assertBrowser();
  const jobs: Promise<unknown>[] = [poseHandle("IMAGE"), segmenterHandle()];
  if (opts.video) jobs.push(poseHandle("VIDEO"));
  await Promise.all(jobs);
}

/** Which delegate an already-created task is using (null if not created yet). */
export async function activeDelegate(key: SlotKey): Promise<Delegate | null> {
  const p = state.slots[key];
  if (!p) return null;
  try {
    return (await p).delegate;
  } catch {
    return null;
  }
}

/** Release all WASM/WebGL resources (e.g. when leaving the capture flow). */
export async function disposeVision(): Promise<void> {
  const slots = Object.values(state.slots);
  state.slots = {};
  await Promise.all(
    slots.map(async (p) => {
      try {
        (await p).task.close();
      } catch {
        /* creation failed or already closed */
      }
    }),
  );
}
