# TryBack: demo video script

The video is filmed by a script, not by hand: `npm run record` drives the real app in headless Chrome at 1920×1080, adds a cursor, lower-third captions and optional narration, and writes a YouTube-ready MP4. This file is the beat sheet it follows. The copy lives in [`scripts/video/beats.ts`](../scripts/video/beats.ts) and the actions in [`scripts/record-demo.ts`](../scripts/record-demo.ts); if you change one, change this file too.

**Rule for the whole video:** say only what the screen shows. The one sentence with a number in it (the honest clock) is generated during the take from what the results screen actually says.

---

## Three commands

| When | Command | What you get |
|---|---|---|
| Now (no keys, no photos) | `npm run record` | A **draft**: simulated renders from the dev double, labelled as such on the title card, in a corner badge, in the captions and on every card. The shopper photos are generated, **illustrated stand-ins** (labelled "not a real person" inside the image). 0 credits. |
| With your Clothsy key and the AI-generated shoppers | `npm run record -- --mode auto --ai-people --photo probe/video/hero.jpg --size-photo probe/video/shirt.jpg` | Live Clothsy renders on AI-generated people, labelled "AI-generated shoppers" (badge, captions, cards, description). Costs up to 5 credits. |
| With your Clothsy key and photos | `npm run record -- --mode auto --i-have-consent --photo me-in-dress.jpg --size-photo me-in-shirt.jpg` | Live Clothsy renders on your own photos ("AI-generated preview"). Costs up to 5 credits (2 speculative + up to 2 after the form + up to 1 gate retry); the size path is 0 credits. `--i-have-consent` is required here (and with `--base`): add it only when everyone in the photos agreed in writing to be filmed, to their photo being sent to Clothsy AI, and to the video being published. |
| Re-film without spending | `npm run record -- --mode replay --photo me-in-dress.jpg --size-photo me-in-shirt.jpg` | Same photos, renders replayed from the recorder's render cache at 0 credits. The captions and narration say the renders were replayed from cache, so their timings aren't read as render speed. |

Useful flags: `--only results,gate` (re-film a few beats; earlier beats fast-forward unfilmed), `--no-voice`, `--voice "<name>"`, `--rate 188`, `--repo-url`, `--demo-url`, `--rebuild`, `--base <url>` (film a server you already run). `npm run record -- --help` lists everything.

Photos: one full-length photo per path, of a consenting adult wearing a mustard/yellow wrap-style dress (`--photo`, order #1042) and a white button-down shirt (`--size-photo`, order #1043). If you pass `--photo` without `--size-photo`, the size beat uses **Skip photo** and shows the size table instead of hem lines. If the on-device check rejects a photo in a live take, the recorder stops and prints what to fix; in dev mode it uses the app's **Continue anyway (dev)** button and the caption says so.

### What the recorder does

1. Builds the app once into `.next-rec` (reused while the sources are unchanged; `tsconfig.json` and `next-env.d.ts` are restored afterwards) and starts `next start` on 127.0.0.1:3144 (loopback only, live renders allowed without an access code) with its own `TRYBACK_DATA_DIR`: `out/video/data-dev` in dev mode (wiped each take) or `out/video/data` otherwise (returns reset at the start, render cache kept so replays cost 0). That server runs the same retention sweep as production, so cached renders older than 14 days are deleted: re-film with `--mode replay` within 14 days of the live take.
2. Opens `/demo?record=1`: the same phone and compact dashboard as `/demo`, with the phone enlarged to full height, no reset/reload controls, and an empty band under the dashboard for captions.
3. Plays the beats below with a gliding cursor and click ripples, waiting on visible text for every step. Each beat lasts at least as long as its narration.
4. Captures frames with the DevTools screencast, resamples them to a constant 30 fps, and encodes H.264 + AAC with the moov atom first (AVFoundation on macOS; `--encoder ffmpeg` if you prefer ffmpeg).
5. Writes to `out/video/`: `tryback-demo.mp4`, `captions.srt`, `youtube-description.md` (title, description, chapters from the real beat times), `beats.json`, `narration.wav`, and `qa/` with one frame per beat plus `contact-sheet.jpg`. On a failure it saves a screenshot and DOM dumps to `out/video/debug/` and exits non-zero, naming the beat. A take made with `--only` or `--out` writes its own sidecars next to its video (e.g. `tryback-demo-only-results.captions.srt`), so it never overwrites the main take's files.

Narration uses macOS `say`. The recorder picks an installed Premium/Enhanced English voice if there is one, otherwise Samantha. For a better voice, install one under System Settings → Accessibility → Spoken Content → System voice → Manage Voices, then pass `--voice "<name>"`.

---

## Beat sheet

The latest draft take runs 2:36. "Draft" lines replace the live line when renders are simulated and the stand-ins are used.

### Intro (title card)

| Screen | Narration |
|---|---|
| Title card: **TryBack**, *"Virtual try-on on the returns page, not the product page."*, three lines that appear as they're spoken, and a mode pill: **"Draft · simulated try-on renders (dev double, 0 credits)"**, **"Renders by Clothsy AI (FabricVTON), live"** or **"Clothsy AI renders replayed from cache · misses simulated"**. Footer: *Fernweave is a fictional brand* (+ *illustrated stand-in, not a real person* in a draft). | "Fashion returns are expensive. Virtual try-on lives on the product page, where it helps sell. TryBack moves it to the returns page, while the shopper is still wearing the item." Draft adds: "This draft uses simulated renders and an illustrated stand-in." Replay adds: "The renders in this take are replayed from cache." |

### A style return

| Beat | Screen | Caption | Narration |
|---|---|---|---|
| `split` | `/demo?record=1`: phone left, dashboard right. Cursor visits both. | The shopper's phone, next to the merchant's dashboard | "On the left, a shopper's phone. On the right, the merchant's dashboard, updating live." |
| `order` | Tap the **#1042** quick-fill, then **Wrap Dress — Mustard**. | Order #1042 · Wrap Dress in mustard | "Priya ordered a mustard wrap dress. The colour just isn't right. Normally, that's a refund." |
| `reason` | Tap **Style or colour didn't work**. | "Style or colour didn't work" | "Priya picks style or colour. Before the refund, TryBack offers to show some swaps." |

### Consent and photo

| Beat | Screen | Caption | Narration |
|---|---|---|---|
| `consent` | The consent box is highlighted and ticked; Take/Upload unlock. | Adults only · consent before any photo | "Adults only, and consent comes first. Nothing is captured until the shopper agrees." |
| `photo` | **Upload photo** → on-device checks → **Great photo**, the checklist → **Use this photo**. | Wearing the item that's going back · *Draft: "This draft uses an illustrated stand-in, not a real person."* | "One photo, wearing the dress that's going back. Framing, pose and lighting are checked on the device, before anything is uploaded." |

### Renders behind the form

| Beat | Screen | Caption | Narration |
|---|---|---|---|
| `form` | The honest clock ticking and two skeleton cards; tap **Colour isn't me** and **Too clingy**, type *"Love the wrap shape, just wanted a softer colour."*, scroll back to the clock (the renders finished during typing), **Show my swaps**. | Two renders start the moment the photo lands · The clock counts from the photo upload, not from the form. | "Two renders started the moment the photo landed. While they run, Priya tells us what didn't work. Those words go to the diagnosis model as text. The photo never does." Without `ANTHROPIC_API_KEY`: "…Only those words are used to diagnose the problem, never the photo." |

### Results and exchange

| Beat | Screen | Caption | Narration |
|---|---|---|---|
| `results` | Waits for the first checked card and scrolls to it (gate badge + provider label), then points at the clock line. | In-stock swaps, in the same size · *the clock line exactly as shown*, e.g. "Renders started at photo upload · form done 0:14 · first card 0:07 (ready before the form was done)" | "Here's what Priya has now, and in-stock swaps in the same size, on the same photo." Then, generated from the clock line: "The first preview was ready before the form was finished, and the clock says so." **or** "The first preview arrived [n] seconds after the form, and the clock says so." Replayed renders add: "These renders were replayed from cache, so that time isn't render speed." Draft adds: "In this draft they're simulated, and labelled so." |
| `gate` | Opens **How we checked this preview** on that card (ΔE, leftover colour, IoU, face change, hem, coverage), highlighted, then closes it. | Every preview is checked on the device before it's shown | "Every preview passes a gate on the shopper's device: colour, leftovers of the old garment, shape, face and hem. A failure retries once with another product shot, or is hidden." |
| `compare` | Drags the compare slider left, right and back. | Drag to compare with what's being worn now · *Live: Labelled "AI-generated preview". Draft: the preview is simulated and labelled "Simulated preview".* | "A drag compares it with what Priya is wearing now." |
| `swap` | **Swap for this** → **Confirm exchange** → Done. | One tap: the refund becomes an exchange | "One tap, and the refund becomes an exchange." |
| `toast` | The dashboard's **Refund avoided +$79** toast and the highlighted revenue tile. | Refund avoided · Revenue kept, net of the $10 exchange bonus. | "The merchant sees it straight away: a refund avoided, net of the ten-dollar bonus." |

### Size return, zero credits

| Beat | Screen | Caption | Narration |
|---|---|---|---|
| `size-order` | **Start another return** → **#1043** → **Linen Shirt — White** → **Fit or size** → **Too short** → Continue. | Order #1043 · Linen Shirt · "Too short" | "Now a size return. Daniel's linen shirt is too short." |
| `size-photo` | Consent → **Upload photo** → checks → **Use this photo**. (No `--size-photo`: **Skip photo**.) | The shirt going back becomes the ruler | "Try-on can't show size, so we don't fake it. The shirt in the photo has a known length, so it becomes a ruler." (No photo: "…Without a photo, Daniel gets the same measurements as a table.") |
| `size-lines` | The hem lines on the photo (solid "what you're wearing", dashed for each size/length), then the **Why not just size up?** callout and the **Recommended** M Tall, each highlighted. | Where every other size would end → "Why not just size up?" · *the grading note as shown*, e.g. "L adds only +1.5 cm length but +5 cm chest — sizing up won't fix 'too short'" | "These lines show where every other size and length would end, at zero credits. Sizing up adds width, not length. The tall version fixes it." |
| `size-swap` | **Swap to M Tall** → **Confirm exchange**; the second toast. | Swap to the Tall, same size | "Another refund becomes an exchange." |

### Merchant dashboard and bench

| Beat | Screen | Caption | Narration |
|---|---|---|---|
| `merchant` | `/merchant` at 125 %: KPI tiles, then the **Try-on API** panel (latency and gate pass rate by transition) and **Fidelity gate**. Seeded history stays on and labelled. | Refunds → exchanges, revenue kept, credits per return · Includes seeded demo history (its latencies are illustrative, not measured), plus this take's returns. | "The dashboard tracks refunds turned into exchanges, revenue kept, and what each return cost in credits, with latency and gate pass rate per transition." |
| `bench` | `/bench`: the transition table with photo · render thumbnails (each tagged AI or Sim). | Every render by transition type, photo next to render | "The bench lists every render by transition type, with the photo next to the render." |

### Close (outro card)

| Screen | Narration |
|---|---|
| **TryBack** · *"Try-on before purchase sells. TryBack keeps the sale."* Credits: **Clothsy AI by FabricVTON** (draft: "renders simulated by a labelled dev double"), **MediaPipe** (on-device pose and segmentation), **Claude by Anthropic** (text only; says when the take used the rules fallback). Code and live-demo URLs (`--repo-url`, `--demo-url`), the mode pill, *Fernweave is a fictional brand*, *Built for HackTheFashion Global'26 · Try-On Commerce*. | "Try-on before purchase sells. TryBack keeps the sale. Built on the Clothsy AI try-on API by FabricVTON." |

The narration uses the demo customers' names and no gendered pronouns, so it stays accurate whoever is on camera. If you change a line, edit `scripts/video/beats.ts` and this table together (a test keeps them in sync).

---

## Never say on camera

These rules apply to every narration line and caption in `scripts/video/beats.ts` (the tests check some of them):

- Any number we didn't measure in this take (no "cuts returns by X%").
- "Instant": say how many seconds it actually took.
- "See how it fits" about the size path. Say "where the hem would land".
- Anything about skin tone or bodies ("flattering", "suits your shape"). Talk about the garment.
- "AI-generated" about a card labelled **Simulated preview**.

---

## Checklist for the final take

### Before

- [ ] **Product shots.** The hero take renders the **Wrap Dress** and **A-line Midi** families (speculative `fw-aline-midi-black` and `fw-wrap-dress-navy`, then `fw-aline-midi-cobalt`, `fw-shift-dress-navy`, `fw-shirt-dress-rust`). Shirt Dress, Shift Dress, Linen Shirt and Trench are already licensed photos; Wrap Dress, A-line Midi, Slip Dress and Knit Top are still generated drawings. Photograph one garment per drawn family and import it (README → Product photos), or accept the drawings for this take. `npm run assets -- --check` labels every file as photo or placeholder.
- [ ] **Photos.** A consenting adult, 18+, who has agreed in writing to be filmed, to have their photo processed by the try-on API, and to have the video published. Full body, facing the camera, even front light, plain background, arms relaxed, tags on. Wearing a mustard/yellow wrap-style dress (order 1042) and a white hip-length button-down (order 1043).
- [ ] **Ruler check.** Tape-measure the shirt from the high point of the shoulder to the hem. The catalogue says 72 cm for size M; if it's more than about 3 cm off, update `baseM.hpsToHemCm` for that family in `lib/catalog.ts`, or the size lines will be off by the same amount.
- [ ] **Key and credits.** `CLOTHSY_API_KEY` in `.env.local` and at least 6 credits left on the account. Leave `LIVE_ACCESS_CODE` empty for the recorder's own server.
- [ ] **Rehearse cheaply first.** `npm run record -- --mode dev --photo … --size-photo …` checks that both photos pass the on-device preflight at 0 credits.

### During

- [ ] Run `npm run record -- --mode auto --i-have-consent --photo … --size-photo …`. Every card should say **AI-generated preview**; the title card pill should say **Renders by Clothsy AI (FabricVTON), live**. If it says "Draft", the key wasn't picked up.
- [ ] If the API is slow or down, re-run with `--mode replay`: the cached renders replay at 0 credits and the video says so.

### After

- [ ] Review `out/video/qa/contact-sheet.jpg` and the frames next to it: captions readable, phone legible, honest labels visible, no spinners frozen on screen.
- [ ] Watch the MP4 once with sound: narration lines up with each beat.
- [ ] Upload with `out/video/youtube-description.md` (fill the [bracketed] links) and `out/video/captions.srt` as subtitles.
- [ ] Fill the `[brackets]` in `docs/DEVPOST.md` from this take and `/bench` (seeded history off).
- [ ] If the person on camera asks for their images to be removed: delete `out/video/data` (photos and render cache) and the photo files you passed in.

---

## Recording by hand instead

If you'd rather screen-record yourself: open `/demo?record=1` in a 1920×1080 window (or `/demo` for the version with controls), follow the beats above, and read the narration live. Press **Reset demo** on `/demo` before each take (it clears the returns this browser created; for a full wipe of a server with `ADMIN_TOKEN` set: `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/admin/reset`, or stop the server and delete `.data`). Don't reset between the style and size beats or the first exchange disappears from the dashboard. Add an on-screen note whenever renders are simulated or replayed from cache.
