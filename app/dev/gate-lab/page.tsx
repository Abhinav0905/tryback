import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GateLab } from "./GateLab";

// Dev-only calibration page for the fidelity gate and photo preflight (docs/GATE-TUNING.md).
// `npm run tune` drives it in headless Chrome. 404 in production unless ENABLE_GATE_LAB=1.

export const metadata: Metadata = {
  title: "Gate lab (dev) — TryBack",
  robots: { index: false, follow: false },
};

export default async function GateLabPage() {
  // Decide per request (not at build time), so ENABLE_GATE_LAB works on a running server.
  await connection();
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_GATE_LAB !== "1") notFound();
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
      <GateLab />
    </main>
  );
}
