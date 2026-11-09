// Pre-warm a deployed TryBack's render cache for judges (docs/DEPLOY.md §8), in headless Chrome.
//
//   LIVE_ACCESS_CODE=… npm run prewarm -- --base https://tryback-x.fly.dev --photo probe/video/hero.jpg --ai-people
//
// Unlocks live renders for this headless browser with LIVE_ACCESS_CODE (read from the
// environment, never printed), then runs the exact path the judges' instructions give:
// order #1042 → Wrap Dress — Mustard → "Style or colour didn't work" → consent → photo →
// chips "Colour isn't me" + "Too clingy" (+ --note) → "Show my swaps". It keeps the page open
// until every render has finished and the on-device gate has checked the cards (a gate retry
// renders once more), then prints the return id to pin with `npm run purge -- --pin <id>`.
//
// Credits: up to MAX_RENDERS_PER_RETURN (5), bounded by the server's DAILY_LIVE_RENDER_CAP.
// A request the API has already finished (same photo bytes, same product image, same pipeline
// version, so the same Idempotency-Key) replays for free.

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { launchChrome, sleep, type Page } from "./lib/cdp";

interface Job {
  id: string;
  skuId: string;
  phase: string;
  status: string;
  provider?: string;
  fromCache?: boolean;
  creditCharged?: boolean;
  gate?: { verdict?: string } | null;
}

const HELP = `npm run prewarm -- --base <url> --photo <file> (--ai-people | --i-have-consent) [--note <text>] [--headful]

  --base <url>        The deployed site, e.g. https://tryback-x.fly.dev
  --photo <file>      Full-body JPEG (≤1600 px, no metadata) wearing the mustard wrap dress
  --ai-people         The photo shows an AI-generated person (no real likeness)
  --i-have-consent    The person is an adult who agreed to the photo being sent to Clothsy AI and used for judging
  --note <text>       Free text for the form (judges must type the same text; default: empty)
  --headful           Show the browser

Needs LIVE_ACCESS_CODE in the environment when the site has one (it is never printed).`;

async function waitText(page: Page, text: string, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`, timeoutMs);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      photo: { type: "string" },
      note: { type: "string", default: "" },
      "ai-people": { type: "boolean", default: false },
      "i-have-consent": { type: "boolean", default: false },
      headful: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || !values.base || !values.photo) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }
  if (!values["ai-people"] && !values["i-have-consent"]) {
    console.error("prewarm: pass --ai-people (AI-generated person) or --i-have-consent (a consenting adult) before a photo is uploaded.");
    return 2;
  }
  const base = values.base.replace(/\/$/, "");
  const photo = path.resolve(values.photo);
  if (!existsSync(photo)) {
    console.error(`prewarm: photo not found: ${photo}`);
    return 2;
  }
  const code = process.env.LIVE_ACCESS_CODE?.trim() ?? "";

  const browser = await launchChrome({ width: 430, height: 932, headless: !values.headful });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/r`);
    if (code) {
      const ok = await page.evaluate<boolean>(
        `fetch("/api/live", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: ${JSON.stringify(code)} }) }).then((r) => r.ok)`,
      );
      if (!ok) throw new Error("the access code was rejected (check LIVE_ACCESS_CODE)");
      await page.goto(`${base}/r`);
    }
    const status = await page.evaluate<{ mode: string; activeProvider: string }>(`fetch("/api/status").then((r) => r.json())`);
    console.log(`Site: ${base} · mode ${status.mode} · this browser renders with: ${status.activeProvider}`);
    if (status.activeProvider !== "clothsy") {
      console.log("Note: this browser is not on the live provider, so new renders will be simulated (nothing to pre-warm).");
    }

    await page.click("text=#1042");
    await waitText(page, "Hi Priya");
    await page.click("text=Wrap Dress — Mustard");
    await waitText(page, "Why is it going back?");
    await page.click("text=Style or colour didn't work");
    await waitText(page, "See 3 swaps on you");
    await page.evaluate(`(() => { const c = document.querySelector("input[type=checkbox]"); if (c && !c.checked) c.click(); return !!c && c.checked; })()`);
    await page.waitForFunction(`!!document.querySelector("input[type=checkbox]:checked")`, 10_000);
    await page.setFiles("input[type=file]", [photo]);
    await page.waitForFunction(
      `["Great photo", "Almost — a quick retake", "That photo didn't work"].some((t) => document.body.innerText.includes(t))`,
      120_000,
    );
    const text = await page.evaluate<string>("document.body.innerText");
    if (!text.includes("Great photo")) throw new Error("the on-device photo checks did not pass; use a full-body, front-facing photo");
    await page.click("text=Use this photo");
    await waitText(page, "What didn't work about it?", 90_000);
    const returnId = /\/r\/([^/?#]+)/.exec(await page.evaluate<string>("location.pathname"))?.[1];
    if (!returnId) throw new Error("could not read the return id from the URL");
    console.log(`Return: ${returnId} (photo uploaded; speculative renders started)`);

    await page.click("text=Colour isn't me");
    await page.click("text=Too clingy");
    if (values.note) await page.type("textarea", values.note);
    await page.click("text=Show my swaps");
    await waitText(page, "Swaps that fix it", 90_000);

    // Wait for every render to settle and every shown card to be gated (a gate retry adds a job).
    const deadline = Date.now() + 6 * 60_000;
    let jobs: Job[] = [];
    let stableSince = 0;
    while (Date.now() < deadline) {
      const r = await page.evaluate<{ return: { renders: Job[] } }>(`fetch("/api/returns/${returnId}").then((r) => r.json())`);
      jobs = r.return.renders;
      const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
      const ungated = jobs.some((j) => j.status === "success" && !j.gate && j.phase !== "speculative");
      if (!busy && !ungated) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince > 8_000) break; // give the gate a moment to request a retry
      } else stableSince = 0;
      await sleep(2_000);
    }

    console.log("\nRenders:");
    for (const j of jobs) {
      console.log(
        `  ${j.skuId.padEnd(24)} ${j.phase.padEnd(15)} ${j.status.padEnd(8)} ${(j.provider ?? "").padEnd(8)} ` +
          `${j.fromCache ? "cache" : j.creditCharged ? "1 credit" : "free replay"} · gate ${j.gate?.verdict ?? "—"}`,
      );
    }
    const charged = jobs.filter((j) => j.creditCharged).length;
    console.log(`\nCredits charged by this pre-warm: ${charged}`);
    console.log(`Pin the renders: ADMIN_TOKEN=… npm run purge -- --base ${base} --pin ${returnId} --note "judges' photo"`);
    if (page.consoleErrors.length) console.log(`(browser console errors: ${page.consoleErrors.length})`);
    return jobs.some((j) => j.status === "success") ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`prewarm: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
