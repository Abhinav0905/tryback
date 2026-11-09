import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Isolated data dir so parallel suites never share a db.json.
const env = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = path.join(os.tmpdir(), `tryback-test-store-${process.pid}`);
  process.env.TRYBACK_DATA_DIR = dir;
  return { dir };
});

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  deletePhoto,
  getReturn,
  hasRender,
  mutate,
  newId,
  PHOTOS_DIR,
  readDb,
  readPhoto,
  readRender,
  RENDERS_DIR,
  saveRender,
  savePhoto,
  updateReturn,
  utcDay,
  type Db,
} from "@/lib/store";
import type { ReturnCase } from "@/lib/types";

function makeReturn(id: string): ReturnCase {
  const now = new Date().toISOString();
  return {
    id,
    orderId: "1042",
    lineIndex: 0,
    skuId: "fw-wrap-dress-mustard",
    size: "M",
    price: 89,
    status: "started",
    reason: null,
    fitComplaints: [],
    chips: [],
    freeText: "",
    consent: null,
    photo: null,
    photoSkipped: false,
    preflight: null,
    measurements: null,
    diagnosis: null,
    candidates: [],
    renders: [],
    timeline: { createdAt: now, reasonAt: null, photoAt: null, formSubmittedAt: null, firstCardAt: null, resolvedAt: null },
    outcome: null,
    creditsSpent: 0,
    simulatedRenders: 0,
  };
}

const storeState = () => (globalThis as unknown as { __trybackStore: { cache: Db | null } }).__trybackStore;

beforeAll(async () => {
  await fs.rm(env.dir, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(env.dir, { recursive: true, force: true });
});

describe("store paths", () => {
  it("resolves DATA_DIR from TRYBACK_DATA_DIR", () => {
    expect(DATA_DIR).toBe(env.dir);
    expect(PHOTOS_DIR).toBe(path.join(env.dir, "photos"));
    expect(RENDERS_DIR).toBe(path.join(env.dir, "renders"));
  });
});

describe("readDb / mutate", () => {
  it("starts empty", async () => {
    const db = await readDb();
    expect(db).toEqual({ version: 1, returns: {}, imageIds: {}, renderIndex: {}, liveRendersByDay: {}, renderAttempts: {} });
  });

  it("persists atomically to db.json and returns a clone of the result", async () => {
    const r = makeReturn("ret_persist");
    const result = await mutate((db) => {
      db.returns[r.id] = r;
      return db.returns[r.id];
    });
    result.price = 1; // mutating the returned copy must not touch the store
    expect((await getReturn(r.id))?.price).toBe(89);

    const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, "db.json"), "utf8")) as Db;
    expect(raw.returns[r.id].skuId).toBe("fw-wrap-dress-mustard");
    const leftovers = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("readDb returns a deep clone", async () => {
    const snap = await readDb();
    snap.liveRendersByDay["2000-01-01"] = 999;
    expect((await readDb()).liveRendersByDay["2000-01-01"]).toBeUndefined();
  });

  it("rolls back in-memory changes when fn throws, and keeps working afterwards", async () => {
    await expect(
      mutate((db) => {
        db.liveRendersByDay["rollback"] = 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await readDb()).liveRendersByDay["rollback"]).toBeUndefined();
    await mutate((db) => {
      db.liveRendersByDay["after"] = 2;
    });
    expect((await readDb()).liveRendersByDay["after"]).toBe(2);
  });

  it("serialises concurrent read-modify-write (no lost updates)", async () => {
    await Promise.all(
      Array.from({ length: 60 }, () =>
        mutate(async (db) => {
          const cur = db.liveRendersByDay["counter"] ?? 0;
          await new Promise((r) => setTimeout(r, Math.random() * 2));
          db.liveRendersByDay["counter"] = cur + 1;
        }),
      ),
    );
    expect((await readDb()).liveRendersByDay["counter"]).toBe(60);
  });

  it("reloads from disk after the in-memory cache is dropped", async () => {
    await mutate((db) => {
      db.imageIds["sha"] = { id: "img_1", expiresAt: "2030-01-01T00:00:00.000Z" };
    });
    storeState().cache = null;
    expect((await readDb()).imageIds["sha"]).toEqual({ id: "img_1", expiresAt: "2030-01-01T00:00:00.000Z" });
  });
});

describe("returns", () => {
  it("getReturn returns null for unknown ids", async () => {
    expect(await getReturn("ret_nope")).toBeNull();
  });

  it("updateReturn mutates one return and returns the updated copy", async () => {
    const r = makeReturn("ret_update");
    await mutate((db) => {
      db.returns[r.id] = r;
    });
    const updated = await updateReturn(r.id, (x) => {
      x.status = "reason_selected";
      x.reason = "style_colour";
    });
    expect(updated.status).toBe("reason_selected");
    expect((await getReturn(r.id))?.reason).toBe("style_colour");
  });

  it("updateReturn rejects for a missing return without writing", async () => {
    await expect(updateReturn("ret_missing", () => undefined)).rejects.toThrow(/not found/);
  });

  it("newId produces prefixed, unique, safe ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("ret")));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^ret_[0-9a-f]{16}$/);
  });
});

describe("blobs", () => {
  it("saves, reads and deletes photos", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    await savePhoto("ret_photo", bytes);
    expect(await readPhoto("ret_photo")).toEqual(bytes);
    await deletePhoto("ret_photo");
    expect(await readPhoto("ret_photo")).toBeNull();
    await expect(deletePhoto("ret_photo")).resolves.toBeUndefined(); // idempotent
  });

  it("saves and reads renders by cache key", async () => {
    const key = "a".repeat(40);
    expect(await hasRender(key)).toBe(false);
    expect(await readRender(key)).toBeNull();
    await saveRender(key, Buffer.from("img"));
    expect(await hasRender(key)).toBe(true);
    expect((await readRender(key))?.toString()).toBe("img");
  });

  it("refuses unsafe blob names (path traversal)", async () => {
    await expect(savePhoto("../escape", Buffer.from("x"))).rejects.toThrow(/Unsafe/);
    await expect(saveRender("a/b", Buffer.from("x"))).rejects.toThrow(/Unsafe/);
    expect(await readPhoto("../../etc/passwd")).toBeNull();
    expect(await readRender("..")).toBeNull();
    expect(await hasRender("x".repeat(200))).toBe(false);
    await expect(fs.access(path.join(env.dir, "..", "escape.jpg"))).rejects.toThrow();
  });
});

describe("utcDay", () => {
  it("formats the UTC calendar day", () => {
    expect(utcDay(new Date("2026-11-06T23:59:59.999Z"))).toBe("2026-11-06");
    expect(utcDay(new Date("2026-11-07T00:00:00.000Z"))).toBe("2026-11-07");
    expect(utcDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
