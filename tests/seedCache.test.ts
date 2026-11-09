import { afterAll, describe, expect, it, vi } from "vitest";

// Isolated data dir so parallel suites never share a db.json.
const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = path.join(os.tmpdir(), `tryback-test-seed-${process.pid}`);
  process.env.TRYBACK_DATA_DIR = dir;
  return { dir };
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPins } from "@/lib/retention";
import { restoreSeedRenders } from "@/lib/seedCache";
import { readDb, readRender, RENDERS_DIR } from "@/lib/store";

const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);

async function makeSeed(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tryback-seed-src-"));
  const entry = (n: number) => ({
    provider: "clothsy",
    latencyMs: 18000 + n,
    createdAt: "2026-11-09T21:32:55.339Z",
    contentType: "image/jpeg",
    externalId: `ext-${n}`,
  });
  await fs.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify({ version: 1, note: "judge renders", renders: { [KEY_A]: entry(1), [KEY_B]: entry(2), "../escape": entry(3) } }),
  );
  await fs.writeFile(path.join(dir, `${KEY_A}.img`), Buffer.from("render-a"));
  // KEY_B's file is deliberately missing: that entry must be skipped, not indexed.
  return dir;
}

afterAll(async () => {
  await fs.rm(env.dir, { recursive: true, force: true });
});

describe("seed render cache (ephemeral-disk hosts)", () => {
  it("copies seed renders into the cache, indexes and pins them, and skips invalid or missing entries", async () => {
    const seed = await makeSeed();
    const first = await restoreSeedRenders(seed);
    expect(first).toEqual({ copied: 1, total: 1 });
    expect((await readRender(KEY_A))?.toString()).toBe("render-a");
    const db = await readDb();
    expect(db.renderIndex[KEY_A]).toMatchObject({ provider: "clothsy", externalId: "ext-1" });
    expect(db.renderIndex[KEY_B]).toBeUndefined();
    expect(Object.keys(db.renderIndex)).not.toContain("../escape");
    const pins = await readPins();
    expect(pins[KEY_A]).toMatchObject({ returnId: null, note: "judge renders" });

    // Idempotent: a second start copies nothing and keeps a single pin.
    const second = await restoreSeedRenders(seed);
    expect(second).toEqual({ copied: 0, total: 1 });
    expect(Object.keys(await readPins())).toEqual([KEY_A]);
  });

  it("restores a render that was wiped (spin-down) and leaves no extra files", async () => {
    const seed = await makeSeed();
    await fs.rm(path.join(RENDERS_DIR, `${KEY_A}.img`), { force: true });
    expect(await restoreSeedRenders(seed)).toEqual({ copied: 1, total: 1 });
    expect((await fs.readdir(RENDERS_DIR)).filter((f) => f.endsWith(".img"))).toEqual([`${KEY_A}.img`]);
  });

  it("is a no-op without a seed directory", async () => {
    expect(await restoreSeedRenders(path.join(os.tmpdir(), "tryback-no-such-seed"))).toEqual({ copied: 0, total: 0 });
  });
});
