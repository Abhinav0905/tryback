"use client";

// Measured hem lines drawn on the shopper's real photo (zero credits). Coordinates
// are pixels of the normalised photo (Calibration.imageWidth × imageHeight), so the
// SVG viewBox matches the image exactly and everything scales together.

import type { Calibration, SizeLine } from "@/lib/types";
import { layoutLabels } from "./flow";

export type LineTone = "selected" | "recommended" | "muted";

export interface OverlayLine {
  key: string;
  line: SizeLine;
  tone: LineTone;
}

function pillWidth(text: string, fs: number): number {
  return text.length * fs * 0.56 + fs * 1.3;
}

export function SizeLinesOverlay({
  photoUrl,
  alt,
  cal,
  wearingLabel,
  lines,
}: {
  photoUrl: string;
  alt: string;
  cal: Calibration;
  wearingLabel: string;
  lines: OverlayLine[];
}) {
  const W = cal.imageWidth;
  const H = cal.imageHeight;
  const fs = H * 0.022;
  const pillH = fs * 1.7;
  const margin = W * 0.03;
  const halfSpan = Math.max(cal.hemHalfWidthPx * 1.35, W * 0.14);
  const x0 = Math.max(margin, cal.centerX - halfSpan);
  const x1 = Math.min(W - margin, cal.centerX + halfSpan);

  // Labels: the "wearing" line plus each projected line, de-overlapped vertically. A hem that
  // falls outside the photo has no line, so its pill (pinned to the edge) says so explicitly
  // rather than reading as if that hem sat at the edge.
  const offFrame = (l: OverlayLine): "above" | "below" | null =>
    l.line.hemY < 0 ? "above" : l.line.hemY > H ? "below" : null;
  const lineLabel = (l: OverlayLine) => {
    const where = offFrame(l);
    return where === null ? l.line.label : `${l.line.label} · ${where} photo ${where === "below" ? "↓" : "↑"}`;
  };
  const labelTexts = [wearingLabel, ...lines.map(lineLabel)];
  const rawYs = [cal.observedHemY, ...lines.map((l) => l.line.hemY)];
  const ys = layoutLabels(rawYs, pillH + fs * 0.3, pillH / 2 + margin, H - pillH / 2 - margin);

  const describe = [
    `${wearingLabel}: solid line.`,
    ...lines.map((l) => {
      const where = offFrame(l);
      const rec = l.tone === "recommended" ? " (recommended)" : "";
      return `${l.line.label}${rec}: ${where === null ? "dashed line" : `ends ${where} the photo`}.`;
    }),
  ].join(" ");

  return (
    <figure
      className="relative w-full overflow-hidden rounded-3xl bg-surface-2"
      style={{ aspectRatio: `${W} / ${H}` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- shopper photo comes from /api/photos */}
      <img src={photoUrl} alt={alt} className="absolute inset-0 h-full w-full object-fill" draggable={false} />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label={`Measured hem lines. ${describe}`}
      >
        {lines.map(({ key, line, tone }) =>
          tone === "muted" || line.hemY < 0 || line.hemY > H ? null : (
            <rect
              key={`band-${key}`}
              x={x0}
              width={x1 - x0}
              y={line.hemY - line.bandPx}
              height={Math.max(line.bandPx * 2, 1)}
              className={tone === "selected" ? "fill-accent" : "fill-white"}
              opacity={tone === "selected" ? 0.22 : 0.14}
            />
          ),
        )}

        {lines.map(({ key, line, tone }) =>
          line.hemY < 0 || line.hemY > H ? null : (
            <g key={`line-${key}`}>
              <line x1={x0} x2={x1} y1={line.hemY} y2={line.hemY} stroke="black" strokeOpacity={0.35} strokeWidth={tone === "muted" ? 3 : 4.5} vectorEffect="non-scaling-stroke" />
              <line
                x1={x0}
                x2={x1}
                y1={line.hemY}
                y2={line.hemY}
                className={tone === "selected" ? "stroke-accent" : "stroke-white"}
                strokeOpacity={tone === "muted" ? 0.75 : 1}
                strokeWidth={tone === "muted" ? 1.5 : 2.5}
                strokeDasharray={tone === "muted" ? "4 5" : "8 6"}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ),
        )}

        {/* What you're wearing: solid */}
        <line x1={x0} x2={x1} y1={cal.observedHemY} y2={cal.observedHemY} stroke="black" strokeOpacity={0.4} strokeWidth={5} vectorEffect="non-scaling-stroke" />
        <line x1={x0} x2={x1} y1={cal.observedHemY} y2={cal.observedHemY} className="stroke-white" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />

        {labelTexts.map((text, i) => {
          const tone: LineTone | "wearing" = i === 0 ? "wearing" : lines[i - 1].tone;
          const w = pillWidth(text, fs);
          const x = W - margin - w;
          const y = ys[i];
          const anchorY = rawYs[i];
          const displaced = Math.abs(y - anchorY) > pillH * 0.4;
          return (
            <g key={`label-${i}`}>
              {displaced && anchorY >= 0 && anchorY <= H ? (
                <line x1={Math.min(x1, x)} x2={x} y1={anchorY} y2={y} className="stroke-white" strokeOpacity={0.7} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              ) : null}
              <rect
                x={x}
                y={y - pillH / 2}
                width={w}
                height={pillH}
                rx={pillH / 2}
                className={tone === "selected" ? "fill-accent" : tone === "wearing" ? "fill-ink" : "fill-surface"}
                opacity={tone === "muted" ? 0.82 : 0.94}
              />
              <text
                x={x + w / 2}
                y={y}
                dominantBaseline="central"
                textAnchor="middle"
                fontSize={fs}
                fontWeight={tone === "muted" ? 500 : 600}
                className={tone === "selected" ? "fill-accent-ink" : tone === "wearing" ? "fill-bg" : "fill-ink"}
              >
                {text}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">{describe}</figcaption>
    </figure>
  );
}
