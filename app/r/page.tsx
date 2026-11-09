import type { Metadata } from "next";
import { OrderLookup } from "@/components/shopper/OrderLookup";
import { ShopperShell } from "@/components/shopper/ShopperShell";

export const metadata: Metadata = {
  title: "Start a return · Fernweave (fictional) · TryBack",
  description: "Find your order and start an exchange-first return.",
};

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default async function OrderLookupPage({ searchParams }: PageProps<"/r">) {
  const q = await searchParams;
  return (
    <ShopperShell>
      <OrderLookup initialOrder={first(q.order).slice(0, 32)} initialEmail={first(q.email).slice(0, 254)} />
    </ShopperShell>
  );
}
