"use client";

// /demo?record=1: the layout `npm run record` films at 1920×1080. Same app, same phone
// iframe and the same compact dashboard as /demo, minus the controls nobody should see
// in a video (reset, reload, links). The phone is enlarged to the full height so the
// shopper UI stays legible at 1080p, and the bottom of the right column is left empty
// for the recorder's caption overlay ([data-record-caption-zone]).

import { BRAND } from "@/lib/catalog";
import { Dashboard } from "@/components/merchant/Dashboard";
import { PhoneFrame } from "@/components/merchant/PhoneFrame";

export function RecordStage() {
  return (
    <div data-record-stage className="grid h-dvh w-full grid-cols-[540px_minmax(0,1fr)] overflow-hidden bg-bg">
      <section
        aria-label="Shopper return portal on a phone"
        className="flex h-dvh min-h-0 items-center justify-center border-r border-line bg-surface-2/50 px-5 py-4"
      >
        <PhoneFrame src="/r" title="TryBack shopper return portal" maxScale={1.3} />
      </section>
      <section aria-label="Merchant dashboard" className="flex h-dvh min-w-0 flex-col">
        {/* translateZ makes this box the containing block for the dashboard's fixed toast,
            so "Refund avoided" lands above the caption zone instead of under it. */}
        <div className="relative min-h-0 flex-1 overflow-hidden" style={{ transform: "translateZ(0)" }}>
          <div data-record-scroll className="h-full overflow-hidden px-10 pt-8" style={{ zoom: 1.18 }}>
            <Dashboard compact />
          </div>
        </div>
        <div data-record-caption-zone aria-hidden className="relative h-[230px] shrink-0 border-t border-line bg-surface-2/40">
          <p className="absolute bottom-3 right-6 text-xs text-muted">
            {BRAND.name} is a fictional brand · TryBack demo
          </p>
        </div>
      </section>
    </div>
  );
}
