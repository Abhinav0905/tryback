import type { Metadata } from "next";
import { OrderLines } from "@/components/shopper/OrderLines";

export const metadata: Metadata = {
  title: "Choose an item · Fernweave (fictional) · TryBack",
};

export default async function OrderPage({ params, searchParams }: PageProps<"/r/order/[orderId]">) {
  const [{ orderId }, q] = await Promise.all([params, searchParams]);
  const email = Array.isArray(q.email) ? (q.email[0] ?? "") : (q.email ?? "");
  return <OrderLines orderId={orderId} email={email.trim()} />;
}
