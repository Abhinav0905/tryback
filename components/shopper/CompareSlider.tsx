"use client";

// Before/after compare: the shopper's real photo (left of the handle) vs the render
// (right). Pointer: drag or tap anywhere (vertical page scroll still works via
// touch-action: pan-y). Keyboard: the handle is a role="slider" with arrows,
// PageUp/PageDown, Home/End.

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "@/components/ui";

function clamp(n: number): number {
  return Math.min(100, Math.max(0, n));
}

export function CompareSlider({
  beforeSrc,
  afterSrc,
  beforeAlt,
  afterAlt,
  beforeLabel = "Now",
  afterLabel = "Preview",
  initial = 50,
  className,
}: {
  beforeSrc: string;
  afterSrc: string;
  beforeAlt: string;
  afterAlt: string;
  beforeLabel?: string;
  afterLabel?: string;
  initial?: number;
  className?: string;
}) {
  const [pos, setPos] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  const setFromClientX = useCallback((clientX: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPos(clamp(((clientX - rect.left) / rect.width) * 100));
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setFromClientX(e.clientX);
    handleRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) setFromClientX(e.clientX);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowLeft: -5,
      ArrowDown: -5,
      ArrowRight: 5,
      ArrowUp: 5,
      PageDown: -20,
      PageUp: 20,
    };
    if (e.key in step) {
      e.preventDefault();
      setPos((p) => clamp(p + step[e.key]));
    } else if (e.key === "Home") {
      e.preventDefault();
      setPos(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setPos(100);
    }
  };

  const rounded = Math.round(pos);

  return (
    <div
      ref={boxRef}
      className={cx("group/compare absolute inset-0 touch-pan-y select-none", dragging ? "cursor-grabbing" : "cursor-ew-resize", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- render bytes come from /api/renders */}
      <img src={afterSrc} alt={afterAlt} draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- shopper photo comes from /api/photos */}
        <img src={beforeSrc} alt={beforeAlt} draggable={false} className="h-full w-full object-cover" />
      </div>

      <span
        aria-hidden
        className={cx(
          // Above the bottom ~10 % of the image, where photos and renders carry their own labels
          // ("Illustrated stand-in", the dev double's "SIMULATED PREVIEW" band): never cover those.
          "pointer-events-none absolute bottom-[11%] left-3 rounded-full bg-surface/85 px-2 py-0.5 text-[11px] font-medium text-ink backdrop-blur motion-safe:transition-opacity",
          pos < 18 && "opacity-0",
        )}
      >
        {beforeLabel}
      </span>
      <span
        aria-hidden
        className={cx(
          "pointer-events-none absolute bottom-[11%] right-3 rounded-full bg-surface/85 px-2 py-0.5 text-[11px] font-medium text-ink backdrop-blur motion-safe:transition-opacity",
          pos > 82 && "opacity-0",
        )}
      >
        {afterLabel}
      </span>

      <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%` }}>
        <span aria-hidden className="absolute inset-y-0 -left-px w-0.5 bg-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.15)]" />
        <div
          ref={handleRef}
          role="slider"
          tabIndex={0}
          aria-label="Compare your photo with the preview"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={rounded}
          aria-valuetext={`${rounded}% your photo, ${100 - rounded}% preview`}
          onKeyDown={onKeyDown}
          className={cx(
            "pointer-events-auto absolute top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full",
            "bg-white text-neutral-900 shadow-card ring-1 ring-black/10",
            "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent",
            "motion-safe:transition-transform",
            dragging && "scale-110",
          )}
        >
          <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
          </svg>
        </div>
      </div>
    </div>
  );
}
