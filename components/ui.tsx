// Shared UI primitives (server- and client-safe: no hooks). Use these in both the
// shopper portal and the merchant dashboard so the product reads as one system.
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "h-9 px-3 text-sm",
        size === "md" && "h-11 px-4 text-[15px]",
        size === "lg" && "h-13 px-5 text-base",
        variant === "primary" && "bg-accent text-accent-ink hover:opacity-90",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "bg-bad text-white hover:opacity-90",
        className,
      )}
    />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cx("rounded-2xl border border-line bg-surface shadow-card", className)}
    />
  );
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Toggle chip for multi-select (pass aria-pressed via `selected`). */
export function Chip({
  selected,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      {...props}
      className={cx(
        "rounded-full border px-3.5 py-2 text-sm transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        selected
          ? "border-accent bg-accent-soft text-accent"
          : "border-line bg-surface text-ink hover:bg-surface-2",
        className,
      )}
    />
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div
        className={cx(
          "tabular mt-1 text-2xl font-semibold",
          tone === "ok" && "text-ok",
          tone === "accent" && "text-accent",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function Swatch({ hex, className }: { hex: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block h-3.5 w-3.5 rounded-full border border-line", className)}
      style={{ backgroundColor: hex }}
    />
  );
}

export function formatUsd(n: number, opts?: { sign?: boolean }): string {
  const s = Math.abs(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
  if (!opts?.sign) return n < 0 ? `−${s}` : s;
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}
