// Small inline SVG icons (stroke = currentColor, decorative: aria-hidden).
import type { SVGProps } from "react";
import type { GateVerdict } from "@/lib/types";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Svg>
  );
}

export function BadgeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.2v3.3M8 10.8v.01" />
    </Svg>
  );
}

export function RetryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12.8 6.2A5 5 0 1 0 13 9.5" />
      <path d="M13 3v3.4H9.6" />
    </Svg>
  );
}

export function DropIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Svg>
  );
}

export function ArrowRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Svg>
  );
}

export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </Svg>
  );
}

export function AlertIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5l6 11H2z" />
      <path d="M8 6.5v3M8 11.6v.01" />
    </Svg>
  );
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13 3v3.5H9.5" />
      <path d="M12.7 6.5A5 5 0 1 0 13 9" />
    </Svg>
  );
}

export function ExternalIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />
    </Svg>
  );
}

export function VerdictIcon({ verdict, ...p }: IconProps & { verdict: GateVerdict }) {
  if (verdict === "pass") return <CheckIcon {...p} />;
  if (verdict === "badge") return <BadgeIcon {...p} />;
  if (verdict === "retry") return <RetryIcon {...p} />;
  return <DropIcon {...p} />;
}
