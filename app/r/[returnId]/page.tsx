import type { Metadata } from "next";
import { ReturnFlow } from "@/components/shopper/ReturnFlow";

export const metadata: Metadata = {
  title: "Your return · Fernweave (fictional) · TryBack",
};

export default async function ReturnPage({ params }: PageProps<"/r/[returnId]">) {
  const { returnId } = await params;
  // Keyed so navigating between two returns never carries client state across.
  return <ReturnFlow key={returnId} returnId={returnId} />;
}
