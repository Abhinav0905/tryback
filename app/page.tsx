import Link from "next/link";
import type { Metadata } from "next";
import { ModePill } from "@/components/shopper/ShopperShell";
import { LinkButton } from "@/components/shopper/primitives";
import { LiveUnlock } from "@/components/shopper/LiveUnlock";

export const metadata: Metadata = {
  title: "TryBack — exchange-first returns with virtual try-on",
  description:
    "Try-on before purchase sells. TryBack keeps the sale: in-stock swaps rendered on the shopper's own photo while they fill in the return form.",
};

const STEPS = [
  {
    n: "1",
    title: "One photo, wearing the item going back",
    body: "18+ consent first. Pose, lighting and framing are checked on the device before anything uploads.",
  },
  {
    n: "2",
    title: "Swaps render while they type",
    body: "In-stock alternatives go to the Clothsy try-on API at photo upload, and every render passes a fidelity gate before it's shown.",
  },
  {
    n: "3",
    title: "The refund becomes a one-tap exchange",
    body: "Size returns cost zero credits: the returned garment is the ruler, so we draw where every other size would end.",
  },
] as const;

const LINKS = [
  { href: "/r", title: "Shopper returns", body: "Start a return as a demo customer." },
  { href: "/merchant", title: "Merchant dashboard", body: "Refunds avoided, revenue kept, credits per return." },
  { href: "/demo", title: "Side-by-side demo", body: "Phone flow and live dashboard on one screen." },
  { href: "/bench", title: "Try-on benchmark", body: "Latency and gate pass rate by transition." },
] as const;

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 py-6 sm:px-8 lg:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">TryBack</span>
          <span className="text-xs text-muted">for Fernweave, a fictional brand</span>
        </div>
        <ModePill />
      </header>

      <main className="flex flex-1 flex-col justify-center gap-10 py-10 lg:py-12">
        <section className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-14">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
              HackTheFashion Global&apos;26 · Try-On Commerce
            </p>
            <h1 className="mt-4 text-[40px] font-semibold leading-[1.04] tracking-tight text-balance sm:text-[56px]">
              Try-on before purchase sells.{" "}
              <span className="text-accent">TryBack keeps the sale.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted text-pretty">
              When a style or colour doesn&apos;t work out, the shopper takes one photo wearing the item they&apos;re
              sending back. While they fill in the return form, TryBack renders in-stock swaps on that photo — so the
              refund turns into an exchange they&apos;ve already seen on themselves.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <LinkButton href="/r" size="lg">
                Start a return
              </LinkButton>
              <LinkButton href="/demo" size="lg" variant="secondary">
                Watch the side-by-side demo
              </LinkButton>
            </div>
            <LiveUnlock className="mt-5" />
          </div>

          <ol className="space-y-3">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card">
                <span className="tabular flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                  {s.n}
                </span>
                <div>
                  <h2 className="font-medium leading-snug">{s.title}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <nav aria-label="Explore TryBack" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="group rounded-2xl border border-line bg-surface p-4 hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-safe:transition-colors"
            >
              <span className="flex items-center justify-between gap-2 font-medium">
                {l.title}
                <span aria-hidden className="text-muted motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5">
                  →
                </span>
              </span>
              <span className="mt-1 block text-sm text-muted">{l.body}</span>
              <span className="mt-2 block font-mono text-xs text-muted">{l.href}</span>
            </Link>
          ))}
        </nav>
      </main>

      <footer className="border-t border-line pt-4 text-xs leading-relaxed text-muted">
        Fernweave is a fictional brand created for this demo. Adults only, with consent before any photo. Photos are never
        sent to a language model; previews are labelled &ldquo;AI-generated preview&rdquo; (or &ldquo;Simulated
        preview&rdquo; in demo mode).
      </footer>
    </div>
  );
}
