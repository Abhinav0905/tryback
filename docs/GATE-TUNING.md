# Tuning the fidelity gate

Every try-on render passes a fidelity gate in the shopper's browser before it is shown ([lib/cv/gate.ts](../lib/cv/gate.ts), [lib/cv/gateMath.ts](../lib/cv/gateMath.ts)). The gate's thresholds, and the photo checks that run before upload ([lib/cv/preflight.ts](../lib/cv/preflight.ts)), were set by hand and have only been tested on synthetic images. They live in **[lib/cv/thresholds.json](../lib/cv/thresholds.json)**, and `npm run tune` recalibrates them from real Clothsy renders in one command.

```
npm run tune -- --preflight-only --people probe/people   # before the probe: check your photos (0 credits)
npm run probe -- --dry-run                                # the plan: 3 people × 2 photographed SKUs
npm run probe -- --i-have-consent --max-credits 7 --check-replay   # spends ≤ 7 credits (see README)
npm run tune                                              # report: probe/tune-report.md
# label every render in probe/labels.json ("good", "bad" or "skip"), run npm run tune again, then:
npm run tune -- --apply                                   # write lib/cv/thresholds.json (≥ 6 good renders, all labelled)
```

Use 3 people, not 2: two people × two SKUs is only 4 renders, and `--apply` needs at least 6 good ones. Without `--skus` the probe picks SKUs whose product images are photos (renders of the generated drawings are no use for tuning, and a live probe refuses them unless `--allow-drawings`).

`npm run tune` spends no credits and makes no API calls. Photos are read from disk and sent only to a headless Chrome on this machine.

## How it works

1. `scripts/tune-gate.ts` starts a private `next dev` (`NEXT_DIST_DIR=.next-tune`, port 3199, `TRYON_MODE=dev`) or uses `--base <url>`.
2. It opens **`/dev/gate-lab`** in headless Chrome ([scripts/lib/cdp.ts](../scripts/lib/cdp.ts)). That dev-only page exposes `window.__gateLab` ([lib/cv/lab.ts](../lib/cv/lab.ts)), which runs the shopper flow's own code: `normalizePhoto`, `runPreflight` and `buildMeasurements` on the person photo, then the gate's `computeGate` on the render, with the same MediaPipe models.
3. For every good render it builds **synthetic bad variants** in the page and measures them the same way.
4. [scripts/lib/tune-math.ts](../scripts/lib/tune-math.ts) picks one threshold per metric, then writes `probe/tune-report.md` (tables) and `probe/tune-metrics.jsonl` (one line per render, with the gate's intermediate values).

`/dev/gate-lab` returns 404 in production unless the server runs with `ENABLE_GATE_LAB=1`. In development you can also open it by hand: pick a photo and a render, see the raw metrics, and make the synthetic variants.

## The metrics

| Metric | thresholds.json | Fails when | What it measures | Synthetic bad variant (`--negatives`) |
|---|---|---|---|---|
| Colour ΔE00 | `gate.colourDeltaE` (12) | value > threshold | CIEDE2000 between the target colour, corrected for the photo's lighting (`observed − source colorHex`, clamped ±25 per Lab channel), and the mean colour of the rendered garment on the torso. | **colour**: the rendered garment shifted by ΔE00 ≈ 15–20 and 20–25 in two hue directions. |
| Residue | `gate.residue` (0.20) | value > threshold | Share of rendered garment pixels within ΔE00 < 10 of the *returned* garment's colour. Only used when the colour should change (ΔE(source, target) > 20). | **residue**: 30–50 % of the original photo's garment pixels pasted back, from the hem up and as patches. |
| Silhouette IoU | `gate.silhouetteIoU` (0.92) | value > threshold | Overlap of the worn and rendered garment masks (clothes class refined by each garment's colour). High overlap on a shape change means the old shape leaked through. Only used on `shorter`, `longer`, `slim_to_loose` and `loose_to_slim`, and never for a length variant of the same garment. | **silhouette**: the original photo recoloured to the target colour, so the shape is copied exactly. Only planned when the check applies. |
| Identity diff | `gate.identityDiff` (0.15), severe `gateSevere.identityDiff` (0.30) | value > threshold | Mean absolute grey-level difference (0–1) in the face box between photo and render. Above the severe value, a render with no retry left is dropped rather than badged. | **identity**: the face box blurred, pixelated, or shifted sideways. These stand in for a regenerated face, which may look different (see Limits). |
| Hem error | `gate.hemErrorCm` (6) | value > threshold | Distance in cm between the rendered hem and where the target's length puts it, using the returned garment as the ruler. Needs calibration. When the gate can't find the rendered hem it reports a lower bound (expected hem − hip line). | **hem**: the body below the hips warped so the hem moves ±8–12 cm. Only planned when the photo is calibrated. |
| Garment coverage | `gate.minCoverage` (0.25), severe `gateSevere.minCoverage` (0.08) | value < threshold | Share of the torso box covered by the render's clothes mask. Below the severe value the garment is treated as missing. | **missing**: the rendered garment filled with the background colour. |

The tuner only counts a render for a metric when the gate would use that metric (`gateCheckApplies` in gateMath.ts). Each synthetic variant counts as a "bad" example for the metric it targets. A real render you label bad counts for every metric, or only for the ones you name.

## After the probe: step by step

### 1. Check your photos first (no credits)

```
npm run tune -- --preflight-only --people probe/people
```

This writes `probe/preflight-report.md`, which shows each check's raw value against its threshold. It also makes four synthetic copies of each photo (darkened, washed out, blurred, feet cropped) to show that each check catches its failure. A photo that fails preflight would be sent back for a retake in the app, so retake it before you spend credits on it.

### 2. Make sure the catalogue colours match your garments

If you replaced `public/catalog/*` with photos of your own clothes, every SKU's `colorHex` in `lib/catalog.ts` must match the real garment. Otherwise every render of it fails the colour check, and tuning would loosen the threshold to hide that. The report's **Catalogue product photos vs colorHex** table measures each product photo and flags ΔE00 > 8. Fix `colorHex` first and re-run.

### 3. Tell it what people are wearing

The gate compares each render with the garment the person wore in their photo (the "returned" item). By default everyone is assumed to wear `fw-wrap-dress-mustard` in size M, as in demo order #1042. If that's wrong, pass it:

```
npm run tune -- --wearing fw-linen-shirt-white:M           # everyone
npm run tune -- --wearing alex=fw-trench-stone:M,sam=fw-wrap-dress-mustard:S
```

You can also put it in the labels file.

### 4. Run it and read the report

```
npm run tune
```

Each run writes `probe/labels.template.json`, listing every render that has no label yet as `"todo"`. Open `probe/tune-report.md`. The main sections are:

- **Thresholds: current vs proposed.** For each metric: how many good renders it would flag and how many bad ones it catches, at the current and proposed values. It also gives an honest estimate of the false-flag rate on the next render: (flags + 1) / (renders + 1).
- **Distributions** (p5…p95) for good and bad renders, and **confusion matrices**.
- **Whole gate.** `decideGate` verdicts (pass, retry, badge, drop) per group, with the current and proposed thresholds.
- **Expected retry rate (credits).** Every retry re-renders with the alternate product shot, which costs one more credit.
- **Photo preflight**, **Per render** (every metric for every render) and **Skipped synthetic variants**.

### 5. Label every render

Open each render in `probe/out/`. Copy the template to `probe/labels.json` (or merge its entries into it) and replace every `"todo"`:

```json
{
  "wearing": { "*": "fw-wrap-dress-mustard:M" },
  "renders": {
    "alex__fw-wrap-dress-emerald": "good",
    "alex__fw-aline-midi-cobalt": { "label": "bad", "why": ["colour"], "note": "came out teal" },
    "sam__fw-wrap-dress-emerald": { "label": "bad", "why": ["face"] },
    "sam__fw-aline-midi-cobalt": "skip"
  }
}
```

- `"good"` means the threshold must let it through.
- `"bad"` means it should be caught. `why` limits which metrics should catch it: `colour`/`color`, `residue`, `silhouette`/`shape`, `identity`/`face`, `hem`/`length`, `missing`/`coverage`. Leave it out to mean any metric. Any other word is an error (a typo would otherwise mean "any metric" and tighten every threshold).
- `"skip"` leaves the render out, for example when the probe photo itself was the problem.
- A render with no entry, or still `"todo"`, counts as good for the proposal, so the report works before you've labelled anything. `--apply` refuses until every render is labelled: one bad render nobody looked at (say, a different-looking face) would otherwise loosen its threshold until renders like it pass.

Synthetic variants are built only from good renders.

### 6. Apply

```
npm run tune -- --apply
```

This writes `lib/cv/thresholds.json`. It first backs the file up to `probe/thresholds.backup-<time>.json`, then prints the diff and records where the numbers came from (`source`, `tunedAt`, `tuning`). It is **refused** with fewer than 6 good real renders, while any real render is unlabelled, and always in `--self-test`. Then run `npm test` (the unit tests pin verdicts to fixed thresholds in `tests/fixtures/thresholds.ts`, so they stay green whatever you apply) and commit `lib/cv/thresholds.json`. The thresholds are bundled into the browser code: restart `npm run dev`, and rebuild (`npm run build`) or redeploy (`fly deploy`) a production server; a plain restart of a built server keeps the old values. Preflight thresholds are never changed automatically. If a good photo of yours fails a check, edit `preflight.*` by hand, using the value the report shows.

Other options: `--max-false-flag 0.05`, `--negatives colour,identity`, `--limit 4`, `--save-synth` (writes the synthetic images to `probe/tune-synth/`), `--thresholds <file>` (compare against or apply to another file), `--base http://localhost:3000` (reuse a dev server you already run), and `--headful`. Run `npm run tune -- --help` for the full list.

## How a threshold is chosen

For each metric (coverage is mirrored, because it fails below its threshold):

1. With *n* good renders, at most ⌊5 % × n⌋ may be flagged. With fewer than 20 renders, that means none.
2. Catching more bad renders always means a tighter threshold. So the best value lies in the gap between the worst good render that must still pass and the first bad render above it. Every value in that gap catches the same bad renders and flags the fewest good ones.
3. If the current threshold is already in that gap, it is **kept**. Otherwise the proposal goes to the **middle of the gap**, so it doesn't sit on a data point.
4. If no bad render lies above the good ones, nothing separates them. The current value is kept if it stays within the false-flag budget, and loosened just past the worst good render if it doesn't.
5. If the good renders need a value outside a sane range (colour 2–30, residue 0.02–0.6, IoU 0.3–0.99, identity 0.01–0.4, hem 1–20 cm, coverage 0.05–0.9), the gate is mis-measuring that metric on them. The status becomes **unreliable**, the current value is kept, and the report points at the renders to look at.
6. Severe thresholds (drop instead of badge) are **never tightened**. They only move out to stay at least 1.5× beyond the identity threshold (or at most 0.5× the coverage threshold) and clear of every good render.

## Self-test (no renders needed)

```
npm run tune -- --self-test
```

The self-test proves the harness works before any real render exists. It reads `probe/fixtures-local/selftest.json` and the photos it lists. These files are local-only: never commit them, never send them to any API, and never use them in the demo video. Each figure is a CC0 full-body **mannequin** photo, recoloured in the page to several catalogue colours to make synthetic "colour-only renders". Those serve as the good renders, and the usual bad variants are built from them. Results go to `probe/fixtures-local/selftest-report.md`. `--apply` is always refused in this mode.

The fixture used here is [Tenue Dida 04](https://commons.wikimedia.org/wiki/File:Tenue_Dida_04.jpg) by Jean-Luc ADON (CC0): an adult mannequin in a patterned top and fringed skirt at a market stall, with no people in the frame. It runs once as is and once mirrored. To recreate it, download the 1280 px version to `probe/fixtures-local/tenue-dida-04.jpg` and use this `selftest.json`:

```json
{ "figures": [ { "file": "tenue-dida-04.jpg", "sourceSkuId": "fw-slip-dress-black", "size": "M", "sourceColorHex": "auto",
    "targets": ["#1F7A5A", "#2851A3", "#C0643F", "#1F2A44", "#6B6E3A", "#9CAF88"], "mirror": true } ] }
```

`"sourceColorHex": "auto"` makes the worn SKU's catalogue colour equal the colour measured in the photo, as if the catalogue were correct.

### What the self-test showed (2026-11-07)

The whole harness ran end to end in 23 s on a warm dev server. Headless Chrome used the MediaPipe GPU delegates. The run produced 12 synthetic good renders and 97 synthetic bad ones, and skipped 11 variants that didn't apply (mostly hem shifts with no hem found, or no room in the frame).

| Metric | Good (synthetic) | Bad (targeted) | Current threshold catches | What it tells us |
|---|---|---|---|---|
| Colour ΔE00 | 0.3 – 4.4 | 9.3 – 27.6 | 23/24 | Separates cleanly. |
| Residue | 0.00 – 0.01 | 0.00 – 0.36 | 12/24 | Pasting 30–50 % of the old garment back often reads below 0.20, so 0.20 may be too loose. Real renders will decide. |
| Identity diff | 0.001 | 0.071 – 0.247 | 12/36 | Blur and pixelate edits (0.07–0.09) pass at 0.15. A synthetic "render" doesn't change the face, so this can't tell where real renders sit. |
| Garment coverage | 0.42 – 1.00 | 0.00 | 12/12 | The current 0.25 is fine. |
| Hem error | 7.5 – 69 cm | 11.2 cm | — | **Unreliable on this outfit.** On renders whose hem was identical, the gate couldn't find the rendered hem in 4 of 6 recolours (it then reports a 69 cm lower bound), and was 7.5–8.7 cm off on the other 2. The mirrored photo didn't calibrate at all. The tuner marked it "unreliable" and kept 6 cm. |
| Silhouette IoU | — | — | — | Not exercised: colour-only renders don't change the silhouette. |

Two more findings:

- **The colour-refined garment mask is fragile on prints.** Comparing the original photo with itself gave IoU 0.57 (not ≈ 1) and a hem error of 7.4 cm. Both the hem check and the IoU check depend on that mask, so watch them on real renders of patterned garments. On this print, a render that copied the old shape exactly would still score well below the 0.92 leak threshold.
- **Preflight:** the photo failed `full_body` (the fringe hides the ankles: lowest landmark visibility 0.35 < 0.5), while the mirrored copy passed at 0.55. The synthetic photo failures were caught: darkened by `lighting`, blurred by `sharpness`, cropped feet by `full_body`, washed out by `lighting`.

The proposals from this run (colour 6.9, residue 0.02, identity 0.036) only reflect how clean synthetic renders are. **Don't use them.** Real renders will move the good side of every distribution.

## Files

| Path | What | Commit? |
|---|---|---|
| `lib/cv/thresholds.json` | thresholds in effect, validated at load (`lib/cv/thresholds.ts`) | yes |
| `app/dev/gate-lab/` | the dev-only lab page | yes |
| `lib/cv/lab.ts`, `lib/cv/synthMath.ts` | lab API and synthetic-image maths | yes |
| `scripts/tune-gate.ts`, `scripts/lib/tune-math.ts` | `npm run tune` and its pure maths (`tests/tune.test.ts`) | yes |
| `probe/tune-report.md`, `probe/tune-metrics.jsonl`, `probe/preflight-report.md`, `probe/labels*.json`, `probe/tune-synth/`, `probe/thresholds.backup-*.json` | outputs and labels from your photos | no (gitignored) |
| `probe/fixtures-local/` | self-test fixtures and reports | **never** |

## Limits

- Synthetic bad renders are proxies. A real regenerated face, a wrong neckline or a half-applied colour may not look like a blur, a pixelation or a pasted patch. Real renders you label bad are worth more than any synthetic variant.
- With 6–12 real renders, "≤ 5 % false flags" means "no false flags on these renders". Expect roughly 1/(n+1) on the next one, which the report shows. More renders give tighter numbers, at 1 credit each.
- Tuning measures the gate in headless Chrome. On a shopper's phone the segmentation can differ slightly, depending on the GPU and whether MediaPipe falls back to CPU.
- `next dev` adds `.next-tune/types/**` entries to `tsconfig.json` when the tuner starts its server. Commit them, or discard them after a run.

## Real-render tuning, 2026-11-09

First calibration on live Clothsy renders: 3 AI-generated people wearing the mustard wrap dress × `fw-wrap-dress-emerald` and `fw-aline-midi-cobalt` = 6 renders, all reviewed by eye and labelled `good`, plus 63 synthetic failures built from them.

| Metric | Hand-set | Tuned | Why |
| --- | --- | --- | --- |
| Colour ΔE00 | 12.0 | 15.45 | Clothsy rendered the emerald 12.5–15.4 ΔE brighter than its colorHex; 3 of 6 good renders would have retried |
| Residue share | 0.20 | 0.20 | Good renders 0.00; synthetic residue ≥ 0.23 |
| Silhouette IoU | 0.92 | 0.92 | Good A-line renders ≈ 0.57; copied silhouettes ≈ 0.97 |
| Identity diff | 0.150 | 0.051 | Good renders ≤ 0.009; synthetic face edits ≥ 0.094 (the old value missed 12 of 18) |
| Hem error (cm) | 6.0 | 9.6 | One good A-line render measured 9.3 cm |
| Garment coverage | 0.25 | 0.72 | Good renders ≥ 0.87; synthetic missing-garment ≤ 0.58 |

Expected retry rate on good renders: 67 % → 0 %. Colour and hem sit right at the edge of six samples; re-run `npm run tune` as more renders arrive (`/bench` keeps them).
