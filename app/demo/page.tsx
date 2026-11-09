import type { Metadata } from "next";
import { DemoStage } from "@/components/merchant/DemoStage";
import { RecordStage } from "./RecordStage";

export const metadata: Metadata = {
  title: "TryBack live demo — shopper + merchant",
  description:
    "Split-screen demo: the shopper return flow in a phone frame next to the live merchant dashboard for the fictional brand Fernweave.",
};

// ?record=1 is the 1920×1080 layout used by `npm run record` (enlarged phone, no controls,
// room for captions). Without it, /demo is the normal interactive split screen.
export default async function DemoPage({ searchParams }: PageProps<"/demo">) {
  const sp = await searchParams;
  const record = Array.isArray(sp.record) ? sp.record[0] : sp.record;
  return record === "1" ? <RecordStage /> : <DemoStage />;
}
