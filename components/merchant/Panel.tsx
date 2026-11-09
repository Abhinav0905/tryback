// Card section with a heading, optional eyebrow/subtitle and header actions.
import { useId, type ReactNode } from "react";
import { Card, cx } from "@/components/ui";

export function Panel({
  title,
  eyebrow,
  subtitle,
  actions,
  children,
  className,
  dim = false,
}: {
  title: string;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Hold the previous render at reduced opacity while a refetch is pending (no skeleton flash). */
  dim?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx("@container min-w-0", className)}>
      <Card className={cx("h-full p-4 transition-opacity sm:p-5", dim && "opacity-60")}>
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {eyebrow ? <div className="mb-0.5 text-xs font-medium text-muted">{eyebrow}</div> : null}
            <h2 id={id} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
        {children}
      </Card>
    </section>
  );
}

/** Two-option segmented control ("Chart" / "Table"). */
export function ViewToggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            value === o.value ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
