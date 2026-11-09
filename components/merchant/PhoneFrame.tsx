"use client";

// A 390×844 phone viewport (rounded, subtle shadow) that iframes a page of this app.
// On short or narrow screens it scales down uniformly so the whole phone stays visible
// (the framed page still lays out at 390 CSS px, i.e. its real mobile layout).
// `maxScale` > 1 lets it grow to fill a tall host (the /demo?record=1 video layout).

import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";

const SCREEN_W = 390;
const SCREEN_H = 844;
const BEZEL = 10;
const OUTER_W = SCREEN_W + BEZEL * 2;
const OUTER_H = SCREEN_H + BEZEL * 2;

export function PhoneFrame({
  src,
  title,
  reloadKey = 0,
  fitHeight = true,
  maxScale = 1,
  className,
}: {
  src: string;
  title: string;
  /** Change to remount the iframe (e.g. after a demo reset). */
  reloadKey?: number;
  /** Also scale to the host's height (desktop split view); otherwise width only. */
  fitHeight?: boolean;
  /** Upper bound for the scale (default 1: never larger than a real phone). */
  maxScale?: number;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const byWidth = rect.width > 0 ? rect.width / OUTER_W : 1;
      const useHeight = fitHeight && window.matchMedia("(min-width: 1024px)").matches && rect.height > 0;
      const byHeight = useHeight ? rect.height / OUTER_H : 1;
      setScale(Math.max(0.45, Math.min(maxScale, byWidth, byHeight)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitHeight, maxScale]);

  return (
    <div ref={hostRef} className={cx("flex h-full w-full items-start justify-center", className)}>
      <div style={{ width: OUTER_W * scale, height: OUTER_H * scale }} className="shrink-0">
        <div
          className="origin-top-left rounded-[52px] border border-line bg-surface p-[10px] shadow-card"
          style={{ width: OUTER_W, height: OUTER_H, transform: scale === 1 ? undefined : `scale(${scale})` }}
        >
          <div className="relative h-full w-full overflow-hidden rounded-[42px] bg-bg ring-1 ring-line">
            <iframe
              key={reloadKey}
              src={src}
              title={title}
              width={SCREEN_W}
              height={SCREEN_H}
              allow="camera; fullscreen"
              className="block h-full w-full border-0 bg-bg"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
