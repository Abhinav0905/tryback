// The demo video, beat by beat: what the screen shows, the lower-third caption and the
// narration. scripts/record-demo.ts performs the actions for each id against the real app;
// docs/DEMO-SCRIPT.md mirrors this file. Copy rules (from the demo script):
//   - say only what the screen shows; no numbers we didn't measure in this take
//   - "simulated" renders are never called AI-generated; drafts say they're drafts
//   - talk about garments, never about bodies or skin

export interface VideoFacts {
  /** New renders come from the dev double (simulated, 0 credits). */
  simulated: boolean;
  /** TRYON_MODE=replay: cached Clothsy renders replay, misses are simulated. */
  replay: boolean;
  /** The shopper photos are the generated, illustrated stand-ins (not a real person). */
  standIn: boolean;
  /** The shopper photos are AI-generated people (synthetic, not real customers): --ai-people. */
  aiPeople?: boolean;
  /** The size path has a photo (otherwise it shows the zero-credit table view). */
  sizePhoto: boolean;
  /** ANTHROPIC_API_KEY is configured (diagnosis by Claude; otherwise keyword rules). */
  llm: boolean;
}

export interface Caption {
  kicker?: string;
  title: string;
  detail?: string;
}

export type BeatLayout = "card" | "demo" | "page";

export interface BeatDef {
  id: string;
  /** YouTube chapter this beat belongs to. */
  chapter: string;
  layout: BeatLayout;
  caption: Caption | null;
  /** Spoken at the start of the beat (empty = silent). Some beats add a line at runtime. */
  narration: string;
  /** Beats that only show something (no app state change) can be skipped by --only. */
  presentational: boolean;
}

export const BEAT_IDS = [
  "intro",
  "split",
  "order",
  "reason",
  "consent",
  "photo",
  "form",
  "results",
  "gate",
  "compare",
  "swap",
  "toast",
  "size-order",
  "size-photo",
  "size-lines",
  "size-swap",
  "merchant",
  "bench",
  "outro",
] as const;

export type BeatId = (typeof BEAT_IDS)[number];

/** The renders' honest provenance, for captions and the title card. */
export function renderProvenance(f: VideoFacts): string {
  if (f.replay) return "Clothsy AI renders replayed from cache · misses simulated";
  if (f.simulated) return "Draft · simulated try-on renders (0 credits)";
  return "Renders by Clothsy AI (FabricVTON)";
}

export function beatsFor(f: VideoFacts): BeatDef[] {
  const draftLine = [
    f.simulated && !f.replay ? "simulated renders" : null,
    f.standIn ? "an illustrated stand-in" : null,
  ].filter(Boolean);
  // A live take isn't a draft: AI-generated shoppers get their own sentence then.
  if (f.aiPeople && draftLine.length) draftLine.push("AI-generated shoppers");
  const intro =
    "Fashion returns are expensive. " +
    "Virtual try-on lives on the product page, where it helps sell. " +
    "TryBack moves it to the returns page, while the shopper is still wearing the item." +
    (draftLine.length ? ` This draft uses ${draftLine.join(" and ")}.` : "") +
    (f.aiPeople && !draftLine.length ? " The shoppers in this video are AI-generated." : "") +
    (f.replay ? " The renders in this take are replayed from cache." : "");

  const beats: BeatDef[] = [
    {
      id: "intro",
      chapter: "Intro",
      layout: "card",
      caption: null,
      narration: intro,
      presentational: true,
    },
    {
      id: "split",
      chapter: "A style return",
      layout: "demo",
      caption: {
        kicker: "Live demo",
        title: "The shopper's phone, next to the merchant's dashboard",
        detail: "Fernweave is a fictional brand. Everything on screen is the running app.",
      },
      narration: "On the left, a shopper's phone. On the right, the merchant's dashboard, updating live.",
      presentational: false,
    },
    {
      id: "order",
      chapter: "A style return",
      layout: "demo",
      caption: { kicker: "Shopper", title: "Order #1042 · Wrap Dress in mustard", detail: "Priya is a fictional demo customer." },
      narration: "Priya ordered a mustard wrap dress. The colour just isn't right. Normally, that's a refund.",
      presentational: false,
    },
    {
      id: "reason",
      chapter: "A style return",
      layout: "demo",
      caption: {
        kicker: "Shopper",
        title: "“Style or colour didn't work”",
        detail: "A refund stays one tap away on every screen.",
      },
      narration: "Priya picks style or colour. Before the refund, TryBack offers to show some swaps.",
      presentational: false,
    },
    {
      id: "consent",
      chapter: "Consent and photo",
      layout: "demo",
      caption: {
        kicker: "Consent first",
        title: "Adults only · consent before any photo",
        detail: "Taking or uploading a photo stays locked until the box is ticked.",
      },
      narration: "Adults only, and consent comes first. Nothing is captured until the shopper agrees.",
      presentational: false,
    },
    {
      id: "photo",
      chapter: "Consent and photo",
      layout: "demo",
      caption: {
        kicker: "One photo",
        title: "Wearing the item that's going back",
        detail: f.standIn
          ? "This draft uses an illustrated stand-in, not a real person. Checks run on the device."
          : f.aiPeople
            ? "The shopper shown is AI-generated, not a real person. Checks run on the device."
            : "Pose, framing and lighting checks run on the device before upload.",
      },
      narration:
        "One photo, wearing the dress that's going back. Framing, pose and lighting are checked on the device, before anything is uploaded.",
      presentational: false,
    },
    {
      id: "form",
      chapter: "Renders behind the form",
      layout: "demo",
      caption: {
        kicker: "Speculative renders",
        title: "Two renders start the moment the photo lands",
        detail: "The clock counts from the photo upload, not from the form.",
      },
      narration:
        "Two renders started the moment the photo landed. While they run, Priya tells us what didn't work. " +
        (f.llm
          ? "Those words go to the diagnosis model as text. The photo never does."
          : "Only those words are used to diagnose the problem, never the photo."),
      presentational: false,
    },
    {
      id: "results",
      chapter: "Results and exchange",
      layout: "demo",
      caption: {
        kicker: f.replay ? "Previews · replayed from cache" : f.simulated ? "Simulated previews · draft" : "AI-generated previews",
        title: "In-stock swaps, in the same size",
        detail: "",
      },
      // The clock sentence is added at runtime from what the results screen actually says.
      narration: "Here's what Priya has now, and in-stock swaps in the same size, on the same photo.",
      presentational: false,
    },
    {
      id: "gate",
      chapter: "Results and exchange",
      layout: "demo",
      caption: {
        kicker: "Fidelity gate",
        title: "Every preview is checked on the device before it's shown",
        detail: "Colour vs the target · leftovers of the old garment · shape · face · hem",
      },
      narration:
        "Every preview passes a gate on the shopper's device: colour, leftovers of the old garment, shape, face and hem. " +
        "A failure retries once with another product shot, or is hidden.",
      presentational: false,
    },
    {
      id: "compare",
      chapter: "Results and exchange",
      layout: "demo",
      caption: {
        kicker: "Compare",
        title: "Drag to compare with what's being worn now",
        detail: f.replay
          ? "Replayed from the render cache; each card says whether it's AI-generated or simulated."
          : f.simulated
            ? "Draft: the preview is simulated and labelled “Simulated preview”."
            : "Labelled “AI-generated preview”.",
      },
      narration: "A drag compares it with what Priya is wearing now.",
      presentational: false,
    },
    {
      id: "swap",
      chapter: "Results and exchange",
      layout: "demo",
      caption: { kicker: "Exchange", title: "One tap: the refund becomes an exchange", detail: "+$10 exchange bonus · ships today" },
      narration: "One tap, and the refund becomes an exchange.",
      presentational: false,
    },
    {
      id: "toast",
      chapter: "Results and exchange",
      layout: "demo",
      caption: { kicker: "Merchant", title: "Refund avoided", detail: "Revenue kept, net of the $10 exchange bonus." },
      narration: "The merchant sees it straight away: a refund avoided, net of the ten-dollar bonus.",
      presentational: false,
    },
    {
      id: "size-order",
      chapter: "Size return, zero credits",
      layout: "demo",
      caption: { kicker: "Size return", title: "Order #1043 · Linen Shirt · “Too short”", detail: "Daniel is a fictional demo customer." },
      narration: "Now a size return. Daniel's linen shirt is too short.",
      presentational: false,
    },
    {
      id: "size-photo",
      chapter: "Size return, zero credits",
      layout: "demo",
      caption: f.sizePhoto
        ? {
            kicker: "Garment as ruler",
            title: "The shirt going back becomes the ruler",
            detail: f.standIn
              ? "Its known length gives pixels per centimetre. Illustrated stand-in · no AI · 0 credits."
              : f.aiPeople
                ? "Its known length gives pixels per centimetre. AI-generated shopper · no try-on · 0 credits."
                : "Its known length gives pixels per centimetre. No AI · 0 credits.",
          }
        : { kicker: "No photo", title: "Without a photo: the same size maths as a table", detail: "0 credits" },
      narration: f.sizePhoto
        ? "Try-on can't show size, so we don't fake it. The shirt in the photo has a known length, so it becomes a ruler."
        : "Try-on can't show size, so we don't fake it. Without a photo, Daniel gets the same measurements as a table.",
      presentational: false,
    },
    {
      id: "size-lines",
      chapter: "Size return, zero credits",
      layout: "demo",
      caption: {
        kicker: "0 credits",
        title: f.sizePhoto ? "Where every other size would end" : "What every other size changes",
        detail: f.sizePhoto ? "Solid: where the M ends now. Dashed: every other size and length, with a ± band." : "Measurements from the size chart, 0 credits.",
      },
      narration: f.sizePhoto
        ? "These lines show where every other size and length would end, at zero credits. Sizing up adds width, not length. The tall version fixes it."
        : "Sizing up adds width, not length. The tall version fixes it, at zero credits.",
      presentational: false,
    },
    {
      id: "size-swap",
      chapter: "Size return, zero credits",
      layout: "demo",
      caption: { kicker: "Exchange", title: "Swap to the Tall, same size", detail: "Another refund turned into an exchange." },
      narration: "Another refund becomes an exchange.",
      presentational: false,
    },
    {
      id: "merchant",
      chapter: "Merchant dashboard and bench",
      layout: "page",
      caption: {
        kicker: "Merchant dashboard",
        title: "Refunds → exchanges, revenue kept, credits per return",
        detail: "Includes seeded demo history (its latencies are illustrative, not measured), plus this take's returns.",
      },
      narration:
        "The dashboard tracks refunds turned into exchanges, revenue kept, and what each return cost in credits, " +
        "with latency and gate pass rate per transition.",
      presentational: true,
    },
    {
      id: "bench",
      chapter: "Merchant dashboard and bench",
      layout: "page",
      caption: {
        kicker: "Transition bench",
        title: "Every render by transition type, photo next to render",
        detail: "Re-score any of them with the gate, in the browser.",
      },
      narration: "The bench lists every render by transition type, with the photo next to the render.",
      presentational: true,
    },
    {
      id: "outro",
      chapter: "Close",
      layout: "card",
      caption: null,
      narration: "Try-on before purchase sells. TryBack keeps the sale. Built on the Clothsy AI try-on API by FabricVTON.",
      presentational: true,
    },
  ];
  return beats;
}

/** The results beat's extra sentence, from the honest clock line actually on screen. */
export function clockSentence(clockLine: string, f: VideoFacts, opts: { fromCache?: boolean } = {}): string {
  const before = /before the form was done/i.test(clockLine);
  const after = /\((\d+)\s*s after form\)/i.exec(clockLine);
  let s: string;
  if (before) s = "The first preview was ready before the form was finished, and the clock says so.";
  else if (after) s = `The first preview arrived ${after[1]} seconds after the form, and the clock says so.`;
  else s = "The clock shows exactly how long the previews took.";
  if (opts.fromCache) s += " These renders were replayed from cache, so that time isn't render speed.";
  if (f.simulated && !f.replay) s += " In this draft they're simulated, and labelled so.";
  return s;
}

/* ───────────────────────── Title and outro cards ───────────────────────── */

function cardMode(f: VideoFacts): { tone: "warn" | "ok" | "info"; label: string } {
  if (f.replay) return { tone: "info", label: renderProvenance(f) };
  if (f.simulated) return { tone: "warn", label: "Draft · simulated try-on renders (dev double, 0 credits)" };
  return { tone: "ok", label: "Renders by Clothsy AI (FabricVTON), live" };
}

function cardFoot(f: VideoFacts): string {
  return [
    "Fernweave is a fictional brand.",
    f.standIn ? "Shopper photos: an illustrated stand-in, not a real person." : f.aiPeople ? "Shoppers shown are AI-generated people, not real customers." : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Values for scripts/video/title.html. The three lines appear roughly as the narration reaches them. */
export function titleCardVars(f: VideoFacts, introNarrationSec: number): Record<string, string> {
  const at = (frac: number) => (0.4 + Math.max(0, introNarrationSec) * frac).toFixed(2);
  const mode = cardMode(f);
  return { D1: at(0.02), D2: at(0.2), D3: at(0.45), MODE_TONE: mode.tone, MODE_LABEL: mode.label, FOOT_NOTE: cardFoot(f) };
}

/** Values for scripts/video/outro.html: credits that say what this take actually used. */
export function outroCardVars(f: VideoFacts, links: { repoUrl: string; demoUrl: string }): Record<string, string> {
  const mode = cardMode(f);
  return {
    CLOTHSY_NOTE: f.replay
      ? "This take: cached Clothsy renders replayed; anything not cached was simulated."
      : f.simulated
        ? "This draft: renders simulated by a labelled dev double. The app calls the API when a key is set."
        : "Live renders in this take, labelled “AI-generated preview”.",
    CLAUDE_NOTE: f.llm
      ? "Structured output from the shopper's words. Text only; the photo never goes to the model."
      : "Text only. This take used the keyword-rules fallback (no API key set).",
    REPO_URL: links.repoUrl,
    DEMO_URL: links.demoUrl,
    MODE_TONE: mode.tone,
    MODE_LABEL: mode.label,
    FOOT_NOTE: `${cardFoot(f)} Built for HackTheFashion Global'26 · Try-On Commerce.`,
  };
}
