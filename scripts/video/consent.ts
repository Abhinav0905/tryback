// Consent gate for `npm run record` (scripts/record-demo.ts), kept pure for tests/video.test.ts.
//
// A take that may reach the live Clothsy API uploads the operator's --photo / --size-photo with
// consent:true (the recorder ticks the shopper's 18+ box itself). Like `npm run probe`, it needs
// the operator's explicit --i-have-consent first. Dev takes use the dev double and replay takes
// only replay the cache, so neither sends a photo anywhere, unless --base points at a server
// whose mode the recorder doesn't control.

export interface RecordConsentInput {
  mode: "dev" | "auto" | "live" | "replay";
  base: string | null;
  photo: string | null;
  sizePhoto: string | null;
  consent: boolean;
  /** --ai-people: every person in the photos is AI-generated (no real person's likeness). */
  aiPeople?: boolean;
}

/** Null when the take may run, else the message to print before refusing. */
export function recordConsentProblem(o: RecordConsentInput): string | null {
  if (!o.photo && !o.sizePhoto) return null; // illustrated stand-ins, never a real person
  const mayGoLive = o.base !== null || o.mode === "auto" || o.mode === "live";
  if (!mayGoLive || o.consent || o.aiPeople) return null;
  return (
    `refusing to film with your own photos ${o.base ? `on ${o.base}` : `in --mode ${o.mode}`} without --i-have-consent (or --ai-people if everyone shown is AI-generated).\n` +
    "Add it only if every person in --photo / --size-photo is an adult (18+) who agreed in writing to be filmed, to have\n" +
    "their photo sent to Clothsy AI for virtual try-on (Clothsy deletes uploads within 35 days), and to the video being published."
  );
}
