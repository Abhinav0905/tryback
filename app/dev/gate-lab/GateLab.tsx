"use client";

// Dev-only gate lab UI. Installs window.__gateLab (lib/cv/lab.ts) for `npm run tune`,
// and lets a developer try the gate by hand: pick a person photo and a render, see the
// raw metrics, and make synthetic broken variants. Everything runs in this tab; nothing
// is uploaded. Synthetic images are labelled as such and are never shown to shoppers.

import { useEffect, useState, type ChangeEvent } from "react";
import { Badge, Button, Card, Swatch } from "@/components/ui";
import { SKUS } from "@/lib/catalog";
import type { GateLabApi } from "@/lib/cv/lab";
import type { SynthKind } from "@/lib/cv/synthMath";
import { SIZES, type SizeCode } from "@/lib/types";

declare global {
  interface Window {
    __gateLab?: GateLabApi & { ready: true };
    __gateLabError?: string;
  }
}

type Status = { kind: "loading" } | { kind: "ready"; thresholdsSource: string } | { kind: "error"; message: string };

const SYNTH_KINDS: { kind: SynthKind; label: string; needsRender: boolean }[] = [
  { kind: "recolour", label: "Colour-only render (recolour the photo)", needsRender: false },
  { kind: "colour", label: "Colour shift (ΔE ≈ 18)", needsRender: true },
  { kind: "residue", label: "Residue (paste back 40 % of the old garment)", needsRender: true },
  { kind: "identity", label: "Identity drift (blur the face)", needsRender: true },
  { kind: "missing", label: "Missing garment", needsRender: true },
  { kind: "hem", label: "Hem +10 cm", needsRender: true },
  { kind: "pf-dark", label: "Preflight: too dark", needsRender: false },
  { kind: "pf-blur", label: "Preflight: blurry", needsRender: false },
];

function readFile(e: ChangeEvent<HTMLInputElement>): Promise<string | null> {
  const f = e.target.files?.[0];
  if (!f) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(f);
  });
}

export function GateLab() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [person, setPerson] = useState<string | null>(null);
  const [render, setRender] = useState<string | null>(null);
  const [synthUrl, setSynthUrl] = useState<string | null>(null);
  const [sourceSkuId, setSourceSkuId] = useState("fw-wrap-dress-mustard");
  const [targetSkuId, setTargetSkuId] = useState("fw-wrap-dress-emerald");
  const [size, setSize] = useState<SizeCode>("M");
  const [synthKind, setSynthKind] = useState<SynthKind>("recolour");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string>("");

  useEffect(() => {
    let alive = true;
    import("@/lib/cv/lab")
      .then(async ({ gateLabApi }) => {
        window.__gateLab = { ...gateLabApi, ready: true };
        document.documentElement.dataset.gateLab = "ready";
        const info = await gateLabApi.info();
        if (alive) setStatus({ kind: "ready", thresholdsSource: info.thresholds.source });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        window.__gateLabError = message;
        document.documentElement.dataset.gateLab = "error";
        if (alive) setStatus({ kind: "error", message });
      });
    return () => {
      alive = false;
    };
  }, []);

  const lab = typeof window !== "undefined" ? window.__gateLab : undefined;
  const target = SKUS.find((s) => s.id === targetSkuId);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setOutput("Working… (the first run loads the on-device models)");
    try {
      const res = await fn();
      setOutput(JSON.stringify(res, (k, v) => (k === "dataUrl" ? "(image shown below)" : v), 2));
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const ctx = { sourceSkuId, size, targetSkuId };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">Gate lab</h1>
          <Badge tone="warn">Dev only</Badge>
          {status.kind === "loading" ? <Badge>Loading…</Badge> : null}
          {status.kind === "ready" ? <Badge tone="ok">Ready</Badge> : null}
          {status.kind === "error" ? <Badge tone="bad">Error</Badge> : null}
        </div>
        <p className="max-w-3xl text-sm text-muted">
          Calibrates the fidelity gate and the photo checks on real renders. <code>npm run tune</code> drives this page
          in headless Chrome (see <code>docs/GATE-TUNING.md</code>). It uses the same on-device models and code as the
          returns flow. Photos stay in this browser tab.
        </p>
        {status.kind === "ready" ? <p className="text-xs text-muted">Thresholds: {status.thresholdsSource}</p> : null}
        {status.kind === "error" ? <p className="text-sm text-bad">{status.message}</p> : null}
      </header>

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-lg font-semibold">Try it by hand</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Person photo (wearing the source item)</span>
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                setPerson(await readFile(e));
                setSynthUrl(null);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Render (optional)</span>
            <input type="file" accept="image/*" onChange={async (e) => setRender(await readFile(e))} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Source item (worn in the photo)</span>
            <select className="h-10 rounded-xl border border-line bg-surface px-3" value={sourceSkuId} onChange={(e) => setSourceSkuId(e.target.value)}>
              {SKUS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Purchased size</span>
            <select className="h-10 rounded-xl border border-line bg-surface px-3" value={size} onChange={(e) => setSize(e.target.value as SizeCode)}>
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-2 font-medium">
              Target item (shown in the render) {target ? <Swatch hex={target.colorHex} /> : null}
            </span>
            <select className="h-10 rounded-xl border border-line bg-surface px-3" value={targetSkuId} onChange={(e) => setTargetSkuId(e.target.value)}>
              {SKUS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Synthetic variant</span>
            <select className="h-10 rounded-xl border border-line bg-surface px-3" value={synthKind} onChange={(e) => setSynthKind(e.target.value as SynthKind)}>
              {SYNTH_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!lab || !person || busy} onClick={() => person && lab && run(() => lab.preflight(person))}>
            Photo checks
          </Button>
          <Button
            size="sm"
            disabled={!lab || !person || !(render || synthUrl) || busy}
            onClick={() => person && lab && run(() => lab.metrics(person, (synthUrl ?? render)!, target?.image ?? null, ctx))}
          >
            Gate metrics{synthUrl ? " (synthetic image)" : ""}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!lab || !person || busy || (SYNTH_KINDS.find((k) => k.kind === synthKind)?.needsRender && !render)}
            onClick={() =>
              person &&
              lab &&
              run(async () => {
                const res = await lab.synth(person, render, synthKind, { ...ctx, seed: "manual" });
                setSynthUrl(res.dataUrl ?? null);
                return res;
              })
            }
          >
            Make synthetic image
          </Button>
          {synthUrl ? (
            <Button size="sm" variant="ghost" onClick={() => setSynthUrl(null)}>
              Clear synthetic image
            </Button>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { url: person, label: "Person photo" },
            { url: render, label: "Render" },
            { url: synthUrl, label: "Synthetic test image (not a real render)" },
          ].map((p) =>
            p.url ? (
              <figure key={p.label} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- local data URL, dev page */}
                <img src={p.url} alt={p.label} className="max-h-96 w-full rounded-xl border border-line object-contain" />
                <figcaption className="text-xs text-muted">{p.label}</figcaption>
              </figure>
            ) : (
              <div key={p.label} className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-line text-xs text-muted">
                {p.label}
              </div>
            ),
          )}
        </div>
        {output ? <pre className="max-h-[32rem] overflow-auto rounded-xl bg-surface-2 p-3 text-xs">{output}</pre> : null}
      </Card>
    </div>
  );
}
