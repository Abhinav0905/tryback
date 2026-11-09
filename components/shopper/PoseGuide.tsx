// Ghost silhouette over the live camera: head near the top, feet near the bottom,
// arms relaxed slightly away from the body. Group opacity is applied once, so the
// overlapping shapes read as one soft figure. Purely decorative (aria-hidden).

import { cx } from "@/components/ui";

export function PoseGuide({ ready, className }: { ready: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 300 400"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      focusable="false"
      className={cx(
        "pointer-events-none motion-safe:transition-colors motion-safe:duration-300",
        ready ? "text-ok" : "text-white",
        className,
      )}
    >
      {/* frame brackets */}
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.85">
        <path d="M24 46V24h22M276 46V24h-22M24 354v22h22M276 354v22h-22" />
      </g>
      <g fill="currentColor" opacity={ready ? 0.32 : 0.24}>
        <ellipse cx="150" cy="60" rx="21" ry="26" />
        <rect x="140" y="80" width="20" height="18" rx="7" />
        <path d="M108 100 Q150 91 192 100 Q205 104 205 121 L197 222 Q150 233 103 222 L95 121 Q95 104 108 100 Z" />
        <rect x="77" y="104" width="22" height="132" rx="11" transform="rotate(9 88 104)" />
        <rect x="201" y="104" width="22" height="132" rx="11" transform="rotate(-9 212 104)" />
        <rect x="111" y="214" width="35" height="160" rx="16" />
        <rect x="154" y="214" width="35" height="160" rx="16" />
      </g>
      <g stroke="currentColor" strokeWidth="1.5" strokeDasharray="5 6" opacity="0.7">
        <line x1="60" x2="240" y1="30" y2="30" />
        <line x1="60" x2="240" y1="378" y2="378" />
      </g>
    </svg>
  );
}
