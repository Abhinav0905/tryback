"use client";

// /bench: transition benchmark over every successful render of a real (non-seeded) return.
// Rows per transition type: count, p50/p95 latency, gate verdict counts and photo-vs-render
// thumbnails. "Re-run gate in browser" re-scores each render with the client-side fidelity
// gate (lib/cv/gate.ts) and POSTs the result back, one render at a time. Re-runs pass
// canRetry:false, so they never trigger a new render and never spend credits.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, cx } from "@/components/ui";
import { BRAND, getSku } from "@/lib/catalog";
import { computeBenchRows, type BenchItem, type BenchRow } from "@/lib/metrics";
import type { GateResult, GateVerdict, RenderJob, ReturnCase } from "@/lib/types";
import { LatencyByTransition, VERDICT_TEXT, type LatencyRow } from "./charts";
import { TRANSITION_HINT, TRANSITION_LABEL, VERDICT_LABEL, VERDICT_ORDER, formatLatency } from "./format";
import { AlertIcon, ArrowRightIcon, RefreshIcon, VerdictIcon } from "./icons";
import { Panel } from "./Panel";

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export interface RunResult {
  jobId: string;
  label: string;
  before: GateVerdict | null;
  after: GateVerdict | null;
  computeMs: number | null;
  reasons: string[];
  error: string | null;
  skipped: boolean;
  /** Extra context, e.g. why a fresh verdict wasn't saved. */
  note?: string;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "finished"; done: number; total: number; cancelled: boolean };

// Photographed SKUs the hero demo renders after the form; `npm run doctor` prints the current pick.
const PROBE_CMD =
  "npm run probe -- --people probe/people --skus fw-shift-dress-navy,fw-shirt-dress-rust --max-credits 7 --dry-run";

function renderLabel(job: RenderJob): string {
  return job.provider === "dev" ? "Simulated preview" : "AI-generated preview";
}

/** /api/bench strips photos and renders of returns made in other browsers (privacy). */
function isPrivate(it: BenchItem): boolean {
  return it.returnId === "";
}

function itemLabel(it: BenchItem): string {
  const from = getSku(it.sourceSkuId)?.name ?? it.sourceSkuId;
  const to = getSku(it.job.skuId)?.name ?? it.job.skuId;
  return `${from} → ${to} (${it.job.size})`;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
    // not JSON
  }
  return `Request failed (${res.status})`;
}

export function BenchView() {
  const [items, setItems] = useState<BenchItem[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [results, setResults] = useState<RunResult[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const cancelRef = useRef(false);

  const fetchItems = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/bench", { cache: "no-store", signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { items: BenchItem[] };
      setItems(Array.isArray(body.items) ? body.items : []);
      setLoad({ kind: "ready" });
    } catch (err) {
      if (signal?.aborted) return;
      setLoad({ kind: "error", message: err instanceof Error ? err.message : "Could not load renders" });
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => void fetchItems(ctl.signal), 0);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [fetchItems]);

  const rows = useMemo(() => computeBenchRows(items), [items]);
  const runnable = useMemo(() => items.filter((it) => it.photoUrl && it.measurements && it.job.resultUrl), [items]);
  const latencyRows: LatencyRow[] = rows.map((r) => ({
    transition: r.transition,
    count: r.measured,
    p50: r.latency.p50,
    p95: r.latency.p95,
    gatePassRate: gatedPassRate(r),
    note: rowNote(r),
  }));

  async function rerunGate() {
    cancelRef.current = false;
    setResults([]);
    const queue = [...items];
    setRun({ kind: "running", done: 0, total: queue.length });
    let runGate: typeof import("@/lib/cv/gate").runGate;
    try {
      ({ runGate } = await import("@/lib/cv/gate"));
    } catch (err) {
      setResults([
        {
          jobId: "load",
          label: "Gate module",
          before: null,
          after: null,
          computeMs: null,
          reasons: [],
          error: err instanceof Error ? `Couldn't load the gate: ${err.message}` : "Couldn't load the gate",
          skipped: false,
        },
      ]);
      setRun({ kind: "finished", done: 0, total: queue.length, cancelled: false });
      return;
    }

    let done = 0;
    for (const it of queue) {
      if (cancelRef.current) break;
      const base = { jobId: it.job.id, label: itemLabel(it), before: it.job.gate?.verdict ?? null };
      const sourceSku = getSku(it.sourceSkuId);
      const targetSku = getSku(it.job.skuId);
      if (!it.photoUrl || !it.measurements || !it.job.resultUrl || !sourceSku || !targetSku) {
        const why = isPrivate(it)
          ? "another shopper's return (photo private)"
          : !it.photoUrl
          ? "no shopper photo (photo skipped)"
          : !it.measurements
            ? "no photo measurements"
            : !it.job.resultUrl
              ? "no render image"
              : "unknown SKU";
        setResults((prev) => [...prev, { ...base, after: null, computeMs: null, reasons: [why], error: null, skipped: true }]);
        done += 1;
        setRun({ kind: "running", done, total: queue.length });
        continue;
      }
      try {
        const gate: GateResult = await runGate({
          originalUrl: it.photoUrl,
          renderUrl: it.job.resultUrl,
          measurements: it.measurements,
          sourceSku,
          targetSku,
          targetSize: it.job.size,
          transition: it.job.transition,
          canRetry: false,
        });
        if (it.job.supersededBy !== null) {
          // This render already triggered a retry; keep its stored "retry" verdict so the record stays
          // consistent with the retry job, and only report the fresh score.
          setResults((prev) => [
            ...prev,
            {
              ...base,
              after: gate.verdict,
              computeMs: gate.computeMs,
              reasons: gate.reasons,
              error: null,
              skipped: false,
              note: "not saved: this render already has a retry",
            },
          ]);
          done += 1;
          setRun({ kind: "running", done, total: queue.length });
          continue;
        }
        const res = await fetch(
          `/api/returns/${encodeURIComponent(it.returnId)}/renders/${encodeURIComponent(it.job.id)}/gate`,
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ gate }),
          },
        );
        if (!res.ok) throw new Error(await readError(res));
        const body = (await res.json()) as { return?: ReturnCase };
        const updated = body.return?.renders?.find((j) => j.id === it.job.id) ?? { ...it.job, gate };
        setItems((prev) => prev.map((p) => (p.job.id === it.job.id ? { ...p, job: updated } : p)));
        setResults((prev) => [
          ...prev,
          {
            ...base,
            after: updated.gate?.verdict ?? gate.verdict,
            computeMs: gate.computeMs,
            reasons: updated.gate?.reasons ?? gate.reasons,
            error: null,
            skipped: false,
          },
        ]);
      } catch (err) {
        setResults((prev) => [
          ...prev,
          {
            ...base,
            after: null,
            computeMs: null,
            reasons: [],
            error: err instanceof Error ? err.message : "Gate failed",
            skipped: false,
          },
        ]);
      }
      done += 1;
      setRun({ kind: "running", done, total: queue.length });
    }
    setRun({ kind: "finished", done, total: queue.length, cancelled: cancelRef.current });
  }

  const running = run.kind === "running";
  const totalRenders = items.length;
  const changed = results.filter((r) => !r.skipped && !r.error && !r.note && r.before !== r.after).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="text-xs font-medium text-muted">TryBack · Clothsy AI by FabricVTON</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Transition benchmark</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            How the try-on API and our fidelity gate behave by transition type, measured on real returns from this
            deployment (seeded demo history is excluded). Catalogue items belong to {BRAND.name}, a fictional brand.
          </p>
        </div>
        <nav aria-label="TryBack pages" className="flex flex-wrap gap-1 text-sm">
          <Link className="rounded-lg px-3 py-2 text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" href="/merchant">
            Dashboard
          </Link>
          <Link className="rounded-lg px-3 py-2 text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" href="/demo">
            Demo
          </Link>
          <Link className="rounded-lg px-3 py-2 text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" href="/r">
            Shopper portal
          </Link>
        </nav>
      </header>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 border-y border-line py-3">
        <Button
          onClick={() => void rerunGate()}
          disabled={running || load.kind !== "ready" || runnable.length === 0}
          aria-describedby="rerun-help"
        >
          {running ? "Re-running gate…" : "Re-run gate in browser"}
        </Button>
        {running ? (
          <Button variant="secondary" onClick={() => (cancelRef.current = true)}>
            Stop after this render
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => void fetchItems()} disabled={running}>
          <RefreshIcon /> Refresh
        </Button>
        <p id="rerun-help" className="text-xs text-muted sm:max-w-md">
          Runs the client-side gate on each render one at a time and saves the verdict. Re-runs never request a new
          render, so they cost 0 credits. Photos and renders are shown only for returns made in this browser (or
          with the access code); other rows show stats only.
        </p>
        <p role="status" aria-live="polite" className="tabular ml-auto text-sm text-ink">
          {run.kind === "running" && `Gating ${Math.min(run.done + 1, run.total)} of ${run.total}…`}
          {run.kind === "finished" &&
            `${run.cancelled ? "Stopped" : "Done"} · ${run.done} of ${run.total} processed · ${changed} verdict${changed === 1 ? "" : "s"} changed`}
        </p>
      </div>

      {load.kind === "loading" ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading renders">
          <div className="tb-skeleton h-64 rounded-2xl" />
          <div className="tb-skeleton h-72 rounded-2xl" />
        </div>
      ) : load.kind === "error" ? (
        <Card className="flex flex-col items-start gap-3 p-5" role="alert">
          <div className="flex items-center gap-2 text-sm font-medium text-bad">
            <AlertIcon size={16} /> Couldn&apos;t load benchmark renders
          </div>
          <p className="text-sm text-muted">{load.message}</p>
          <Button size="sm" variant="secondary" onClick={() => void fetchItems()}>
            <RefreshIcon /> Try again
          </Button>
        </Card>
      ) : totalRenders === 0 ? (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-ink">No renders yet</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Run a style &amp; colour return with a photo at{" "}
            <Link href="/r" className="text-accent underline underline-offset-2">
              /r
            </Link>{" "}
            and its renders will appear here, grouped by transition. For a controlled matrix of people × garments, use
            the probe script below.
          </p>
        </Card>
      ) : (
        <>
          <Panel
            title="Latency by transition"
            subtitle={`${totalRenders} successful renders · latency excludes cache hits (their latency is a copy of the original render's)`}
          >
            <LatencyByTransition rows={latencyRows} minCountForEmphasis={2} />
          </Panel>

          <BenchTable
            rows={rows}
            expanded={expanded}
            onToggle={(t) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(t)) next.delete(t);
                else next.add(t);
                return next;
              })
            }
          />
        </>
      )}

      {results.length > 0 ? <RunResults results={results} /> : null}

      <ProbeInstructions />
    </div>
  );
}

function gatedPassRate(r: BenchRow): number | null {
  const gated = r.verdicts.pass + r.verdicts.badge + r.verdicts.retry + r.verdicts.drop;
  return gated > 0 ? r.verdicts.pass / gated : null;
}

/** Qualifies "n = <measured>": how many of those are simulated, and the cache replays left out of n. */
export function rowNote(r: Pick<BenchRow, "measured" | "measuredSimulated" | "cached">): string | undefined {
  const parts: string[] = [];
  if (r.measured > 0 && r.measuredSimulated === r.measured) parts.push(r.measured === 1 ? "simulated" : "all simulated");
  else if (r.measuredSimulated > 0) parts.push(`${r.measuredSimulated} simulated`);
  if (r.cached) parts.push(`${r.cached} cache ${r.cached === 1 ? "replay" : "replays"} not counted`);
  return parts.length ? parts.join(" · ") : undefined;
}

/* ───────────── Table ───────────── */

export function BenchTable({
  rows,
  expanded,
  onToggle,
}: {
  rows: BenchRow[];
  expanded: ReadonlySet<string>;
  onToggle: (transition: string) => void;
}) {
  return (
    <section aria-labelledby="bench-table-title">
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 id="bench-table-title" className="text-base font-semibold text-ink">
            Benchmark by transition
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Gate verdicts per transition with photo-vs-render samples. Expand a row to see every render.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="tabular w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">Transition benchmark: renders, latency and gate verdicts</caption>
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">Transition</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Renders</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">p50</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">p95</th>
                {VERDICT_ORDER.map((v) => (
                  <th key={v} scope="col" className="px-3 py-2.5 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      <VerdictIcon verdict={v} size={12} className={VERDICT_TEXT[v]} />
                      {v === "pass" ? "Pass" : v === "badge" ? "Badge" : v === "retry" ? "Retry" : "Drop"}
                    </span>
                  </th>
                ))}
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Ungated</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Samples (photo · render)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = expanded.has(r.transition);
                return (
                  <BenchRowView key={r.transition} row={r} open={isOpen} onToggle={() => onToggle(r.transition)} />
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

function BenchRowView({ row, open, onToggle }: { row: BenchRow; open: boolean; onToggle: () => void }) {
  const detailId = `bench-detail-${row.transition}`;
  const empty = row.count === 0;
  return (
    <>
      <tr className={cx("border-t border-line align-middle", empty && "text-muted")}>
        <th scope="row" className="px-5 py-3 font-medium">
          <div className="text-ink">{TRANSITION_LABEL[row.transition]}</div>
          <div className="text-xs font-normal text-muted">{TRANSITION_HINT[row.transition]}</div>
        </th>
        <td className="px-3 py-3 text-right">
          {row.count}
          {row.cached ? <div className="text-xs text-muted">{row.cached} cached</div> : null}
        </td>
        <td className="px-3 py-3 text-right">{formatLatency(row.latency.p50)}</td>
        <td className="px-3 py-3 text-right">{formatLatency(row.latency.p95)}</td>
        {VERDICT_ORDER.map((v) => (
          <td key={v} className="px-3 py-3 text-right">
            {row.verdicts[v]}
          </td>
        ))}
        <td className="px-3 py-3 text-right">{row.verdicts.ungated}</td>
        <td className="px-5 py-3">
          {empty ? (
            <span className="text-xs">No renders</span>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                {row.items.slice(0, 2).map((it) => (
                  <ThumbPair key={it.job.id} item={it} size="sm" />
                ))}
              </div>
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-controls={detailId}
                className="whitespace-nowrap rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
              >
                {open ? "Hide" : `All ${row.count}`}
              </button>
            </div>
          )}
        </td>
      </tr>
      {open && !empty ? (
        <tr id={detailId} className="border-t border-line bg-surface-2/40">
          <td colSpan={10} className="px-5 py-4">
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {row.items.map((it) => (
                <li key={it.job.id}>
                  <SampleCard item={it} />
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Thumb({
  src,
  alt,
  size,
  tag,
  empty = "none",
}: {
  src: string | null;
  alt: string;
  size: "sm" | "md";
  /** Visible label over the image (every render is labelled, even as a thumbnail). */
  tag?: string;
  empty?: string;
}) {
  const dims = size === "sm" ? "h-12 w-9" : "h-40 w-30";
  if (!src) {
    return (
      <div className={cx(dims, "flex items-center justify-center rounded-md bg-surface-2 text-[10px] text-muted")}>
        {empty}
      </div>
    );
  }
  return (
    <div className={cx(dims, "relative overflow-hidden rounded-md bg-surface-2")}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" decoding="async" className="h-full w-full object-cover" />
      {tag ? (
        <span
          aria-hidden
          className={cx(
            "absolute inset-x-0 bottom-0 bg-ink/75 text-center font-semibold uppercase tracking-wide text-bg",
            size === "sm" ? "text-[7px] leading-[11px]" : "text-[10px] leading-4",
          )}
        >
          {tag}
        </span>
      ) : null}
    </div>
  );
}

/** Short visible tag for a render thumbnail. */
function renderTag(job: RenderJob, size: "sm" | "md"): string {
  if (size === "md") return job.provider === "dev" ? "Simulated" : "AI-generated";
  return job.provider === "dev" ? "Sim" : "AI";
}

function ThumbPair({ item, size }: { item: BenchItem; size: "sm" | "md" }) {
  const v = item.job.gate?.verdict ?? null;
  return (
    <div className="relative flex gap-0.5" title={itemLabel(item)}>
      <Thumb src={item.photoUrl} alt="Shopper photo" size={size} empty={isPrivate(item) ? "private" : "none"} />
      <Thumb
        src={item.job.resultUrl}
        alt={`${renderLabel(item.job)}: ${getSku(item.job.skuId)?.name ?? item.job.skuId}`}
        size={size}
        tag={renderTag(item.job, size)}
        empty={isPrivate(item) ? "private" : "none"}
      />
      {v ? (
        <span
          className={cx(
            "absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-surface bg-surface",
            VERDICT_TEXT[v],
          )}
          aria-label={VERDICT_LABEL[v]}
          role="img"
        >
          <VerdictIcon verdict={v} size={10} />
        </span>
      ) : null}
    </div>
  );
}

function SampleCard({ item }: { item: BenchItem }) {
  const j = item.job;
  const v = j.gate?.verdict ?? null;
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex gap-2">
        <figure className="min-w-0">
          <Thumb src={item.photoUrl} alt="Shopper photo" size="md" empty={isPrivate(item) ? "private" : "none"} />
          <figcaption className="mt-1 text-[11px] text-muted">Shopper photo</figcaption>
        </figure>
        <figure className="min-w-0">
          <Thumb
            src={j.resultUrl}
            alt={`${renderLabel(j)}: ${getSku(j.skuId)?.name ?? j.skuId}`}
            size="md"
            empty={isPrivate(item) ? "private" : "none"}
          />
          <figcaption className="mt-1 text-[11px] text-muted">{renderLabel(j)}</figcaption>
        </figure>
      </div>
      <div className="mt-2 text-sm text-ink">{itemLabel(item)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {v ? (
          <Badge tone={v === "pass" ? "ok" : v === "badge" ? "warn" : v === "retry" ? "info" : "bad"}>
            <VerdictIcon verdict={v} size={11} />
            {VERDICT_LABEL[v]}
          </Badge>
        ) : (
          <Badge tone="neutral">Not gated</Badge>
        )}
        <span>{j.fromCache ? "cache hit" : formatLatency(j.latencyMs)}</span>
        <span aria-hidden>·</span>
        <span>{j.phase.replace("_", " ")}</span>
        {j.garmentVariant === "alt" ? (
          <>
            <span aria-hidden>·</span>
            <span>alt shot</span>
          </>
        ) : null}
      </div>
      {j.gate?.reasons.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {j.gate.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ───────────── Re-run results ───────────── */

export function RunResults({ results }: { results: RunResult[] }) {
  return (
    <Panel title="Gate re-run" subtitle="Verdict before → after for each render, in the order they ran.">
      <ul className="divide-y divide-line">
        {results.map((r) => (
          <li key={r.jobId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-ink">{r.label}</span>
            {r.error ? (
              <span className="inline-flex items-center gap-1 text-bad">
                <AlertIcon size={12} /> {r.error}
              </span>
            ) : r.skipped ? (
              <span className="text-muted">Skipped · {r.reasons[0]}</span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <VerdictChip verdict={r.before} />
                <ArrowRightIcon size={12} className="text-muted" />
                <VerdictChip verdict={r.after} />
                {r.computeMs !== null ? (
                  <span className="tabular text-xs text-muted">{Math.round(r.computeMs)} ms</span>
                ) : null}
                {r.note ? <span className="text-xs text-muted">· {r.note}</span> : null}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function VerdictChip({ verdict }: { verdict: GateVerdict | null }) {
  if (!verdict) return <span className="text-xs text-muted">not gated</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink">
      <VerdictIcon verdict={verdict} size={12} className={VERDICT_TEXT[verdict]} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

/* ───────────── Probe instructions ───────────── */

export function ProbeInstructions() {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(PROBE_CMD);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied("idle"), 2500);
  }
  return (
    <Panel
      title="Run the probe matrix"
      subtitle="A controlled people × garments matrix against the live Clothsy API, with a hard credit ceiling."
      actions={
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy command"}
        </Button>
      }
    >
      <pre className="overflow-x-auto rounded-xl bg-surface-2 px-4 py-3 font-mono text-xs leading-relaxed text-ink">
        <code>{PROBE_CMD}</code>
      </pre>
      <span role="status" aria-live="polite" className="sr-only">
        {copied === "ok" ? "Command copied" : copied === "fail" ? "Copy failed" : ""}
      </span>
      <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
        <li>
          Put full-body JPEGs of <span className="text-ink">consenting adult team members</span> in{" "}
          <code className="font-mono text-ink">probe/people/</code>, each wearing a garment like the one being returned.
        </li>
        <li>
          Run with <code className="font-mono text-ink">--dry-run</code> first: it prints the plan (people × SKUs) and
          the credits it would spend, without calling the API.
        </li>
        <li>
          To render, once every person has agreed to their photo being sent to Clothsy AI, replace{" "}
          <code className="font-mono text-ink">--dry-run</code> with{" "}
          <code className="font-mono text-ink">--i-have-consent --check-replay</code>. The script checks the account&apos;s
          credits first, stops at <code className="font-mono text-ink">--max-credits</code>, respects the 10 starts/min rate
          limit, and needs <code className="font-mono text-ink">CLOTHSY_API_KEY</code> in{" "}
          <code className="font-mono text-ink">.env.local</code>.
        </li>
        <li>
          Outputs land in <code className="font-mono text-ink">probe/out/&lt;person&gt;__&lt;sku&gt;.jpg</code>, with one
          JSON line per render (latency, status, error code) in{" "}
          <code className="font-mono text-ink">probe/results.jsonl</code> and a summary in{" "}
          <code className="font-mono text-ink">probe/REPORT.md</code>.
        </li>
        <li>
          Use SKUs whose product images are photos: without <code className="font-mono text-ink">--skus</code> the probe
          picks them itself (the same pick <code className="font-mono text-ink">npm run doctor</code> prints) and refuses
          drawings. Cover a hard transition (wrap → shift or shirt dress is slim → loose) before spending credits on the
          demo.
        </li>
      </ol>
    </Panel>
  );
}
