// Restores the team's pre-warmed judge renders at boot from seed/render-cache/ (committed and
// baked into the Docker image) into the data dir, and pins them so retention keeps them.
//
// Why: on hosts with an ephemeral disk (Render's free plan) the JSON store and render cache are
// wiped whenever the instance spins down or redeploys. Restoring the seed on every start means a
// judge who uploads public/judge-photo.jpg and follows the documented click path still replays
// the real Clothsy renders (content-addressed cache keys) instead of new renders or simulations.
// On a persistent disk it is a no-op after the first start.
//
// Server-only (node:fs).

import { promises as fs } from "node:fs";
import path from "node:path";
import { pinRenderKeys } from "./retention";
import { mutate, RENDERS_DIR, renderBlobName, type RenderIndexEntry } from "./store";

export const SEED_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.TRYBACK_SEED_DIR ?? "seed/render-cache");

const CACHE_KEY = /^[a-f0-9]{40}$/;

interface SeedIndex {
  version: 1;
  note?: string;
  renders: Record<string, RenderIndexEntry>;
}

export interface SeedResult {
  /** Render files copied into the data dir on this call. */
  copied: number;
  /** Seed entries now present in the render index. */
  total: number;
}

/** Copy missing seed renders into the cache, add their index entries and pin them. Idempotent. */
export async function restoreSeedRenders(dir: string = SEED_DIR): Promise<SeedResult> {
  let index: SeedIndex;
  try {
    index = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8")) as SeedIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { copied: 0, total: 0 };
    throw err;
  }
  const entries = Object.entries(index.renders ?? {}).filter(([key, e]) => CACHE_KEY.test(key) && e && typeof e === "object");
  if (entries.length === 0) return { copied: 0, total: 0 };

  await fs.mkdir(RENDERS_DIR, { recursive: true });
  let copied = 0;
  const present: [string, RenderIndexEntry][] = [];
  for (const [key, entry] of entries) {
    const src = path.join(dir, `${key}.img`);
    const dst = path.join(RENDERS_DIR, `${renderBlobName(key, entry.version)}.img`);
    try {
      await fs.access(dst);
    } catch {
      try {
        await fs.copyFile(src, dst);
        copied += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // seed file missing: skip that entry
        throw err;
      }
    }
    present.push([key, entry]);
  }

  await mutate((db) => {
    for (const [key, entry] of present) db.renderIndex[key] ??= entry;
  });
  await pinRenderKeys(
    present.map(([key]) => key),
    index.note ?? "seeded judge renders",
  );
  return { copied, total: present.length };
}
