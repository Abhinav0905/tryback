"use client";

// Live selfie camera with a pose-silhouette guide, on-device coaching (~4 fps via
// MediaPipe pose + liveCoach) and a 3-second timer.
//   · The preview is mirrored with CSS only; the captured frame is drawn from the raw
//     (un-mirrored) video, centre-cropped to the same 3:4 window the shopper saw.
//   · All tracks stop on capture and on unmount.
//   · Permission denied / no camera → friendly fallback to upload.

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button, cx } from "@/components/ui";
import type { BodyKeypoints } from "@/lib/types";
import { CAPTURE_ASPECT, centerCropRect, offsetKeypoints } from "./flow";
import { PoseGuide } from "./PoseGuide";
import { ErrorNote, IconCamera, IconUpload, PhotoFileButton, Spinner } from "./primitives";

type CamState = "starting" | "live" | "denied" | "unavailable" | "error";

const COACH_INTERVAL_MS = 250;
const COUNTDOWN_S = 3;

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

function classifyCameraError(e: unknown): CamState {
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : null;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "unavailable";
  }
  return "error";
}

function hasCameraApi(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

type Detect = (video: HTMLVideoElement, ts: number) => Promise<{ keypoints: BodyKeypoints | null; personCount: number }>;
type Coach = (kp: BodyKeypoints | null, personCount: number, width: number, height: number) => { ready: boolean; tip: string };

export function CameraCapture({
  onCapture,
  onFile,
}: {
  onCapture: (blob: Blob) => void;
  onFile: (file: File) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cam, setCam] = useState<CamState>(() => (hasCameraApi() ? "starting" : "unavailable"));
  const [coach, setCoach] = useState<{ ready: boolean; tip: string } | null>(null);
  const [coachMode, setCoachMode] = useState<"loading" | "on" | "off">("loading");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  /* Start the camera; stop every track on unmount. */
  useEffect(() => {
    if (!hasCameraApi()) return;
    let cancelled = false;
    const video = videoRef.current;
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) {
          stopTracks(stream);
          return;
        }
        streamRef.current = stream;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined); // muted + playsInline: autoplay is allowed
        }
        if (!cancelled) setCam("live");
      } catch (e) {
        if (!cancelled) setCam(classifyCameraError(e));
      }
    };
    void start();
    return () => {
      cancelled = true;
      stopTracks(streamRef.current);
      streamRef.current = null;
      if (video) video.srcObject = null;
    };
  }, []);

  /* Live coaching loop (~4 fps) once the camera is live. */
  useEffect(() => {
    if (cam !== "live") return;
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    let detect: Detect | null = null;
    let coachFn: Coach | null = null;

    const tick = async () => {
      if (stopped) return;
      const v = videoRef.current;
      if (detect && coachFn && v && v.readyState >= 2 && v.videoWidth > 0 && document.visibilityState === "visible") {
        try {
          const res = await detect(v, performance.now());
          const crop = centerCropRect(v.videoWidth, v.videoHeight, CAPTURE_ASPECT);
          const kp = res.keypoints ? offsetKeypoints(res.keypoints, crop.x, crop.y) : null;
          const next = coachFn(kp, res.personCount, crop.width, crop.height);
          if (!stopped) {
            setCoach((prev) => (prev && prev.ready === next.ready && prev.tip === next.tip ? prev : next));
          }
          failures = 0;
        } catch {
          failures += 1;
          if (failures >= 5) {
            if (!stopped) setCoachMode("off");
            return;
          }
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), COACH_INTERVAL_MS);
    };

    (async () => {
      try {
        const [pose, pre] = await Promise.all([import("@/lib/cv/pose"), import("@/lib/cv/preflight")]);
        if (stopped) return;
        pre.resetLiveCoach();
        detect = pose.detectPoseVideo;
        coachFn = pre.liveCoach;
        setCoachMode("on");
        void tick();
      } catch {
        if (!stopped) setCoachMode("off");
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [cam]);

  /* Grab the frame: raw (un-mirrored) video, centre-cropped to the 3:4 preview window. */
  const capture = useEffectEvent(async () => {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0) {
      setCaptureError("The camera isn't ready yet — give it a second and try again.");
      return;
    }
    const crop = centerCropRect(v.videoWidth, v.videoHeight, CAPTURE_ASPECT);
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCaptureError("Your browser couldn't capture the photo. Try uploading one instead.");
      return;
    }
    ctx.drawImage(v, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    if (!blob) {
      setCaptureError("Your browser couldn't capture the photo. Try uploading one instead.");
      return;
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    onCapture(blob);
  });

  /* 3-2-1 timer. */
  useEffect(() => {
    if (countdown === null) return;
    const t = window.setTimeout(() => {
      if (countdown > 1) {
        setCountdown(countdown - 1);
      } else {
        setCountdown(null);
        void capture();
      }
    }, 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  if (cam === "denied" || cam === "unavailable" || cam === "error") {
    const message =
      cam === "denied"
        ? "Camera access is blocked. You can allow it in your browser settings, or use a photo instead."
        : cam === "unavailable"
          ? "We couldn't find a camera on this device. You can upload a photo instead."
          : "The camera didn't start. You can upload a photo instead.";
    return (
      <div className="space-y-4">
        <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-line bg-surface-2 px-8 text-center">
          <IconCamera className="h-8 w-8 text-muted" />
          <p role="alert" className="text-sm text-ink">
            {message}
          </p>
        </div>
        <PhotoFileButton onFile={onFile} variant="primary" className="w-full">
          <IconUpload />
          Upload a photo
        </PhotoFileButton>
        <PhotoFileButton onFile={onFile} useCamera variant="secondary" className="w-full">
          <IconCamera />
          Open your camera app
        </PhotoFileButton>
      </div>
    );
  }

  const ready = coach?.ready === true;
  const tip =
    coachMode === "off"
      ? "Line yourself up with the outline — head at the top, feet at the bottom."
      : coach?.tip ?? "Getting the guide ready…";

  return (
    <div className="space-y-4">
      <div
        className={cx(
          "relative aspect-[3/4] w-full overflow-hidden rounded-3xl bg-ink ring-4 motion-safe:transition-[box-shadow] motion-safe:duration-300",
          ready ? "ring-ok" : "ring-transparent",
        )}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          aria-label="Camera preview (mirrored)"
          className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
        />
        {cam === "starting" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
            <Spinner className="h-6 w-6" />
            <p className="text-sm">Starting the camera…</p>
          </div>
        ) : (
          <PoseGuide ready={ready} className="absolute inset-0 h-full w-full" />
        )}

        {countdown !== null ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/25">
            <span
              key={countdown}
              className="text-8xl font-semibold text-white drop-shadow-lg motion-safe:transition-[opacity,scale] motion-safe:duration-500 motion-safe:starting:scale-125 motion-safe:starting:opacity-0"
            >
              {countdown}
            </span>
          </div>
        ) : null}
        <p className="sr-only" aria-live="assertive">
          {countdown !== null ? `${countdown}` : ""}
        </p>

        {cam === "live" ? (
          <div className="absolute inset-x-3 bottom-3 flex justify-center">
            <p
              aria-live="polite"
              aria-atomic="true"
              className={cx(
                "inline-flex max-w-full items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium shadow-card backdrop-blur",
                ready ? "bg-ok text-white" : "bg-black/60 text-white",
              )}
            >
              {coachMode === "loading" && !coach ? <Spinner className="h-3.5 w-3.5" /> : null}
              <span className="truncate">{ready && countdown === null ? "Looks great — hold still and tap the button" : tip}</span>
            </p>
          </div>
        ) : null}
      </div>

      {captureError ? <ErrorNote>{captureError}</ErrorNote> : null}

      <div className="flex items-center justify-center gap-4">
        {countdown === null ? (
          <button
            type="button"
            onClick={() => {
              setCaptureError(null);
              setCountdown(COUNTDOWN_S);
            }}
            disabled={cam !== "live"}
            aria-label={`Take photo in ${COUNTDOWN_S} seconds`}
            className={cx(
              "group relative flex h-[76px] w-[76px] items-center justify-center rounded-full border-4 border-ink/15 bg-surface",
              "focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-accent",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <span
              className={cx(
                "flex h-[58px] w-[58px] items-center justify-center rounded-full text-xs font-semibold motion-safe:transition-transform motion-safe:group-active:scale-95",
                ready ? "bg-accent text-accent-ink" : "bg-ink text-bg",
              )}
            >
              {COUNTDOWN_S}s
            </span>
          </button>
        ) : (
          <Button variant="secondary" size="lg" onClick={() => setCountdown(null)}>
            Cancel timer
          </Button>
        )}
      </div>
      <p className="text-center text-xs text-muted">
        Prop your phone up, step back, and tap — you&apos;ll have {COUNTDOWN_S} seconds.
      </p>
    </div>
  );
}
