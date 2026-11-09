import type { Metadata } from "next";
import { Dashboard } from "@/components/merchant/Dashboard";

export const metadata: Metadata = {
  title: "Fernweave · Returns — TryBack merchant dashboard",
  description:
    "Refunds turned into exchanges, revenue retained, credits per return, per-SKU diagnoses and try-on API latency for the fictional brand Fernweave.",
};

export default async function MerchantPage({ searchParams }: PageProps<"/merchant">) {
  const sp = await searchParams;
  const seeded = Array.isArray(sp.seeded) ? sp.seeded[0] : sp.seeded;
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <Dashboard initialIncludeSeeded={seeded !== "0"} syncUrl />
    </main>
  );
}
