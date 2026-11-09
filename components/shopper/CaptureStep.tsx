"use client";

// Capture → on-device preflight → measurements → upload.
// Everything up to "Use this photo" happens in the browser; nothing is uploaded
// before the shopper confirms. Object URLs are revoked on retake and unmount.

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button, cx } from "@/components/ui";
import type { PreflightOutput } from "@/lib/cv/preflight";
import type { AppStatus, PhotoMeasurements, PreflightResult, ReturnCase, Sku } from "@/lib/types";
import { api, errorMessage } from "./api";
import { CameraCapture } from "./CameraCapture";
import { parseHeightCm } from "./flow";
import { PreflightChecklist } from "./PreflightChecklist";
import {
  ErrorNote,
  IconArrowLeft,
  IconCamera,
  IconShield,
  IconUpload,
  PhotoFileButton,
  Spinner,
  StepHeading,
} from "./primitives";

interface NormalizedPhoto {
  blob: Blob;
  width: number;
  height: number;
  url: string;
}

type Phase =
  | { kind: "camera" }
  | { kind: "pick"; notice: string | null }
  | { kind: "analyzing" }
  | { kind: "review"; result: PreflightResult; needsHeight: boolean; error: string | null }
  | { kind: "uploading"; result: PreflightResult }
  | { kind: "failed"; message: string };

const MAX_INPUT_BYTES = 30 * 1024 * 1024;

function friendlyPhotoError(e: unknown): string {
  const msg = e instanceof Error ? e.message : "";
  // lib/cv/image throws shopper-ready sentences ("That photo is too small — …").
  if (/^(That |We couldn't read)/.test(msg)) return msg;
  if (/on-device vision|vision runtime|pose detection|garment segmentation|fetch|import|module|wasm/i.test(msg)) {
    return "The on-device photo checker didn't load. Check your connection and try again.";
  }
  if (/load image|no pixels|decode|encode/i.test(msg)) {
    return "We couldn't read that image. Try a JPEG or PNG, or take a new photo.";
  }
  return "We couldn't check that photo. Please try again.";
}

export function CaptureStep({
  r,
  sku,
  status,
  source,
  initialFile,
  onUploaded,
  onBack,
}: {
  r: ReturnCase;
  sku: Sku;
  status: AppStatus | null;
  source: "camera" | "upload";
  initialFile: File | null;
  onUploaded: (next: ReturnCase) => void;
  onBack: () => void;
}) {
  const isFit = r.reason === "fit_size";
  const [phase, setPhase] = useState<Phase>(() =>
    initialFile ? { kind: "analyzing" } : source === "camera" ? { kind: "camera" } : { kind: "pick", notice: null },
  );
  const [photo, setPhoto] = useState<NormalizedPhoto | null>(null);
  const [heightText, setHeightText] = useState("");
  const preRef = useRef<PreflightOutput | null>(null);
  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const urlRef = useRef<string | null>(null);
  const startedFile = useRef<File | null>(null);
  const purchased = { size: r.size, pom: sku.poms[r.size], colorHex: sku.colorHex };

  const replacePhoto = (next: NormalizedPhoto | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next?.url ?? null;
    setPhoto(next);
  };

  // Revoke the preview URL on unmount. (An alive flag rather than bumping the generation,
  // so React StrictMode's dev-only unmount/remount doesn't discard an in-flight analysis.)
  useEffect(() => {
    const alive = aliveRef;
    const url = urlRef;
    alive.current = true;
    return () => {
      alive.current = false;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
    };
  }, []);

  const analyze = async (blob: Blob) => {
    const gen = ++genRef.current;
    preRef.current = null;
    try {
      if (blob.size > MAX_INPUT_BYTES) throw new Error("image too large to load");
      const { normalizePhoto, loadImage } = await import("@/lib/cv/image");
      // The camera frame is already un-mirrored (drawn from the raw video), so mirrored:false.
      const norm = await normalizePhoto(blob, { mirrored: false });
      if (gen !== genRef.current || !aliveRef.current) {
        URL.revokeObjectURL(norm.url);
        return;
      }
      replacePhoto(norm);
      const img = await loadImage(norm.url);
      const { runPreflight, buildMeasurements } = await import("@/lib/cv/preflight");
      const pre = await runPreflight(img, norm.width, norm.height);
      if (gen !== genRef.current || !aliveRef.current) return;
      preRef.current = pre;
      let needsHeight = false;
      if (isFit && pre.keypoints) {
        try {
          needsHeight = buildMeasurements(pre, purchased).calibration === null;
        } catch {
          needsHeight = false;
        }
      }
      setPhase({ kind: "review", result: pre.result, needsHeight, error: null });
    } catch (e) {
      if (gen !== genRef.current || !aliveRef.current) return;
      setPhase({ kind: "failed", message: friendlyPhotoError(e) });
    }
  };

  // A file chosen on the offer screen is analysed as soon as we mount.
  useEffect(() => {
    if (!initialFile || startedFile.current === initialFile) return;
    startedFile.current = initialFile;
    void analyze(initialFile);
    // analyze is intentionally not a dependency: it only reads refs + stable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  const begin = (blob: Blob) => {
    setPhase({ kind: "analyzing" });
    void analyze(blob);
  };

  const retake = () => {
    genRef.current += 1;
    preRef.current = null;
    replacePhoto(null);
    setPhase(source === "camera" ? { kind: "camera" } : { kind: "pick", notice: null });
  };

  const submit = async (override: boolean) => {
    const pre = preRef.current;
    if (!pre || !photo || phase.kind !== "review") return;
    const reviewPhase = phase;
    setPhase({ kind: "uploading", result: phase.result });
    try {
      const { buildMeasurements } = await import("@/lib/cv/preflight");
      const heightCm = parseHeightCm(heightText);
      // Never throws: with no person found it returns calibration:null measurements.
      const measurements: PhotoMeasurements = buildMeasurements(pre, purchased, heightCm ? { heightCm } : undefined);
      const preflight: PreflightResult = { ...pre.result, overridden: override && !pre.result.ok };
      const next = await api.photo(r.id, photo.blob, { adultAttested: true, preflight, measurements });
      preRef.current = null;
      onUploaded(next);
    } catch (e) {
      setPhase({ ...reviewPhase, error: errorMessage(e) });
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (file) begin(file);
  };

  const showDevOverride =
    status?.activeProvider === "dev" && phase.kind === "review" && !phase.result.ok;
  const heightInvalid = heightText.trim() !== "" && parseHeightCm(heightText) === null;

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 mb-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        <IconArrowLeft className="h-4 w-4" />
        Back
      </button>

      {phase.kind === "camera" ? (
        <>
          <StepHeading title="Step back so we can see all of you" sub={`Wear the ${sku.name}, arms relaxed, facing the camera.`} />
          <CameraCapture onCapture={begin} onFile={begin} />
        </>
      ) : null}

      {phase.kind === "pick" ? (
        <>
          <StepHeading title="Choose a full-length photo" sub={`One photo of you wearing the ${sku.name} — head to toe, facing the camera.`} />
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-line bg-surface px-8 text-center"
          >
            <IconUpload className="h-8 w-8 text-muted" />
            <p className="text-sm text-muted">Drop a photo here, or choose one below.</p>
          </div>
          {phase.notice ? <ErrorNote className="mt-4">{phase.notice}</ErrorNote> : null}
          <div className="mt-4 grid gap-3">
            <PhotoFileButton onFile={begin} variant="primary">
              <IconUpload />
              Choose a photo
            </PhotoFileButton>
            <PhotoFileButton onFile={begin} useCamera>
              <IconCamera />
              Open your camera app
            </PhotoFileButton>
          </div>
        </>
      ) : null}

      {phase.kind === "analyzing" || phase.kind === "review" || phase.kind === "uploading" ? (
        <>
          <StepHeading
            title={
              phase.kind === "analyzing"
                ? "Checking your photo…"
                : phase.kind === "uploading"
                  ? "Uploading…"
                  : phase.result.ok
                    ? "Great photo"
                    : "Almost — a quick retake"
            }
            sub={
              phase.kind === "analyzing"
                ? "This runs on your device. Nothing is uploaded until you say so."
                : phase.kind === "uploading"
                  ? isFit
                    ? "Saving your photo so we can draw the size lines."
                    : "Your previews start rendering the moment this finishes."
                  : undefined
            }
          />
          <div className="grid gap-5">
            <div
              className="relative mx-auto w-full max-w-[300px] overflow-hidden rounded-3xl bg-surface-2"
              style={{ aspectRatio: photo ? `${photo.width} / ${photo.height}` : "3 / 4" }}
            >
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                <img
                  src={photo.url}
                  alt="Your photo"
                  className={cx(
                    "absolute inset-0 h-full w-full object-cover motion-safe:transition-opacity",
                    phase.kind !== "review" && "opacity-70",
                  )}
                />
              ) : (
                <span className="tb-skeleton absolute inset-0" aria-hidden />
              )}
              {phase.kind !== "review" ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="inline-flex items-center gap-2 rounded-full bg-surface/90 px-3 py-1.5 text-sm font-medium backdrop-blur">
                    <Spinner />
                    {phase.kind === "analyzing" ? "Checking" : "Uploading"}
                  </span>
                </div>
              ) : null}
            </div>

            <div aria-live="polite">
              <PreflightChecklist checks={phase.kind === "analyzing" ? null : phase.result.checks} />
            </div>

            {phase.kind === "review" && phase.needsHeight ? (
              <div className="rounded-2xl border border-line bg-surface p-4">
                <label htmlFor="tb-height" className="block text-sm font-medium">
                  Your height in cm <span className="font-normal text-muted">(optional)</span>
                </label>
                <p id="tb-height-help" className="mt-1 text-xs leading-relaxed text-muted">
                  We couldn&apos;t find the item&apos;s edges clearly, so height can act as the ruler for the size lines.
                  It&apos;s used only for this measurement.
                </p>
                <input
                  id="tb-height"
                  inputMode="decimal"
                  autoComplete="off"
                  value={heightText}
                  onChange={(e) => setHeightText(e.currentTarget.value)}
                  aria-describedby="tb-height-help"
                  aria-invalid={heightInvalid || undefined}
                  placeholder="e.g. 168"
                  className="mt-3 h-11 w-full rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                />
                {heightInvalid ? <p className="mt-1.5 text-xs text-bad">Enter a height between 120 and 230 cm.</p> : null}
              </div>
            ) : null}

            {phase.kind === "review" && phase.error ? <ErrorNote>{phase.error}</ErrorNote> : null}

            {phase.kind === "review" ? (
              <div className="grid gap-3">
                {phase.result.ok ? (
                  <>
                    <Button size="lg" onClick={() => void submit(false)} disabled={heightInvalid}>
                      Use this photo
                    </Button>
                    <Button variant="secondary" size="lg" onClick={retake}>
                      Retake
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="lg" onClick={retake}>
                      <IconCamera />
                      Retake photo
                    </Button>
                    {showDevOverride ? (
                      <Button variant="ghost" size="md" onClick={() => void submit(true)} disabled={heightInvalid}>
                        Continue anyway (dev)
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {phase.kind === "failed" ? (
        <>
          <StepHeading title="That photo didn't work" />
          <ErrorNote>{phase.message}</ErrorNote>
          <div className="mt-5 grid gap-3">
            <Button size="lg" onClick={retake}>
              Try again
            </Button>
            <Button variant="ghost" size="lg" onClick={onBack}>
              Back to photo options
            </Button>
          </div>
        </>
      ) : null}

      <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-muted">
        <IconShield className="mt-px h-4 w-4 shrink-0" />
        Photo checks run on your device. Your photo is never sent to a text AI model.
      </p>
    </div>
  );
}
