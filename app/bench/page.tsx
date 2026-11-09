import type { Metadata } from "next";
import { BenchView } from "@/components/merchant/BenchView";

export const metadata: Metadata = {
  title: "Transition benchmark — TryBack",
  description:
    "Try-on latency and fidelity-gate verdicts by transition type on real returns, with an in-browser gate re-run and the probe-matrix instructions.",
};

export default function BenchPage() {
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <BenchView />
    </main>
  );
}
