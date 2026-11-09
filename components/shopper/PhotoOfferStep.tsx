"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui";
import type { ReturnCase, Sku } from "@/lib/types";
import { api, errorMessage } from "./api";
import {
  ErrorNote,
  IconArms,
  IconArrowLeft,
  IconCamera,
  IconPerson,
  IconShield,
  IconShirt,
  IconTag,
  IconUpload,
  PhotoFileButton,
  Spinner,
  StepHeading,
} from "./primitives";

// Retention is stated as it actually works: lib/retention.ts deletes photos within
// PHOTO_RETENTION_HOURS (≤ 24) of upload and previews within RENDER_RETENTION_DAYS (≤ 14), and
// live previews send the photo to the try-on provider, which deletes uploads within 35 days
// (docs/CLOTHSY-NOTES.md).
export const CONSENT_COPY =
  "I'm 18 or older, I'm the person in the photo, and TryBack may send it to its try-on provider (Clothsy AI) to create previews. TryBack deletes its copy within 24 hours of upload and the previews within 14 days; Clothsy deletes uploads within 35 days.";

const TIPS = [
  { icon: IconShirt, text: "Wear the item" },
  { icon: IconPerson, text: "Full body" },
  { icon: IconArms, text: "Arms relaxed" },
  { icon: IconTag, text: "Keep tags on" },
] as const;

export function PhotoOfferStep({
  r,
  sku,
  consented,
  onConsentChange,
  onTakePhoto,
  onFile,
  onSkipped,
  onBack,
  backLabel,
}: {
  r: ReturnCase;
  sku: Sku;
  consented: boolean;
  onConsentChange: (v: boolean) => void;
  onTakePhoto: () => void;
  onFile: (file: File) => void;
  onSkipped: (next: ReturnCase) => void;
  onBack: (() => void) | null;
  backLabel: string;
}) {
  const isFit = r.reason === "fit_size";
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consentId = useId();
  const hintId = useId();
  const alreadySkipped = r.photoSkipped;

  // Once the shopper opts in, warm the on-device models so capture + checks feel instant.
  useEffect(() => {
    if (!consented) return;
    let cancelled = false;
    void import("@/lib/cv/mediapipe")
      .then((m) => (cancelled ? undefined : m.warmUpVision({ video: true })))
      .catch(() => undefined); // best effort: capture still works, just slower to start
    return () => {
      cancelled = true;
    };
  }, [consented]);

  const skip = async () => {
    if (alreadySkipped && onBack) {
      onBack();
      return;
    }
    setSkipping(true);
    setError(null);
    try {
      onSkipped(await api.skipPhoto(r.id));
    } catch (e) {
      setError(errorMessage(e));
      setSkipping(false);
    }
  };

  return (
    <div>
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 mb-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <IconArrowLeft className="h-4 w-4" />
          {backLabel}
        </button>
      ) : null}

      {isFit ? (
        <StepHeading
          eyebrow="Measured, not guessed · 0 credits"
          title="We'll measure the other sizes on the photo"
          sub="No AI needed — the item you're wearing is the ruler, so we can draw where every other size would end."
        />
      ) : (
        <StepHeading
          eyebrow="Optional · one photo"
          title="See 3 swaps on you"
          sub="About 20 seconds · +$10 exchange bonus. Previews render while you tell us what didn't work."
        />
      )}

      <p className="mb-3 text-sm text-ink">
        Take one photo wearing the <span className="font-medium">{sku.name}</span>.
      </p>
      <ul className="mb-6 grid grid-cols-2 gap-2" aria-label="Photo tips">
        {TIPS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
            <Icon className="h-[18px] w-[18px] shrink-0 text-muted" />
            {text}
          </li>
        ))}
      </ul>

      <label
        htmlFor={consentId}
        className="mb-5 flex cursor-pointer gap-3 rounded-2xl border border-line bg-surface p-4 has-[:checked]:border-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
      >
        <input
          id={consentId}
          type="checkbox"
          checked={consented}
          onChange={(e) => onConsentChange(e.currentTarget.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-accent outline-none"
        />
        <span className="text-sm leading-relaxed text-ink">{CONSENT_COPY}</span>
      </label>

      <div className="grid gap-3">
        <Button size="lg" disabled={!consented} aria-describedby={consented ? undefined : hintId} onClick={onTakePhoto}>
          <IconCamera />
          Take photo
        </Button>
        <PhotoFileButton onFile={onFile} disabled={!consented} describedBy={consented ? undefined : hintId}>
          <IconUpload />
          Upload photo
        </PhotoFileButton>
        {!consented ? (
          <p id={hintId} className="text-center text-xs text-muted">
            Tick the box above to take or upload a photo.
          </p>
        ) : null}
        <Button variant="ghost" size="lg" onClick={() => void skip()} disabled={skipping}>
          {skipping ? <Spinner /> : null}
          {alreadySkipped ? "Not now" : "Skip photo"}
        </Button>
      </div>
      {error ? <ErrorNote className="mt-4">{error}</ErrorNote> : null}

      <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-muted">
        <IconShield className="mt-px h-4 w-4 shrink-0" />
        {isFit
          ? "Measuring happens on your device. TryBack deletes the photo within 24 hours of upload, and it only goes to our try-on provider (Clothsy AI) if you ask for a preview — never to a text AI model."
          : "Your photo goes only to our try-on provider to make the previews — never to a text AI model. Skipping shows the same swaps on product photos."}
      </p>
    </div>
  );
}
