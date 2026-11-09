// Tiny JSON-file data store. Zero infrastructure so the demo runs anywhere:
//   .data/db.json          — returns, image-id cache, render index, counters
//   .data/photos/<id>.jpg  — shopper photos (deleted on reset; never sent to the LLM)
//   .data/renders/<key>.jpg— try-on results, content-addressed (re-runs cost 0 credits)
// Writes are serialised through a process-wide promise chain and written atomically.
// For multi-instance hosting swap this module for Postgres/Redis with the same API.

// Server-only module (uses node:fs). Never import from client components.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderName, ReturnCase } from "./types";

// Runtime data, not source: tell Turbopack not to trace the whole project from this dynamic path.
// turbopackIgnore on every data path: they are runtime locations, and without it the build
// tracer copies matching files (photos, renders, db.json) from anywhere in the project into
// the standalone output.
export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.TRYBACK_DATA_DIR ?? ".data");
export const PHOTOS_DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "photos");
export const RENDERS_DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "renders");
const DB_FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "db.json");

export interface RenderIndexEntry {
  provider: ProviderName;
  latencyMs: number;
  createdAt: string;
  contentType: string;
  externalId: string | null;
  /**
   * Which stored file holds the current bytes (see renderBlobName). Absent for the first
   * write of a key. A re-render of the same key (dev → live upgrade, or a lost index entry)
   * gets a new version instead of overwriting bytes behind a URL already served as immutable.
   */
  version?: string;
}

export interface Db {
  version: 1;
  returns: Record<string, ReturnCase>;
  /** Clothsy uploaded-image ids by content hash (valid 24 h). */
  imageIds: Record<string, { id: string; expiresAt: string }>;
  /** Render cache metadata by cache key (bytes live in RENDERS_DIR). */
  renderIndex: Record<string, RenderIndexEntry>;
  /** Live (credit-consuming) renders per UTC day, e.g. { "2026-11-07": 12 }. */
  liveRendersByDay: Record<string, number>;
  /**
   * Refunded, terminal try-on failures per render cache key. Drives the idempotency-key
   * suffix (the API replays a reused key's failure). Kept across demo resets, like the cache.
   */
  renderAttempts: Record<string, number>;
}

function emptyDb(): Db {
  return { version: 1, returns: {}, imageIds: {}, renderIndex: {}, liveRendersByDay: {}, renderAttempts: {} };
}

// Survive Next.js dev HMR / multiple module instances in one process.
const g = globalThis as unknown as {
  __trybackStore?: { chain: Promise<unknown>; cache: Db | null; loading?: Promise<Db> | null };
};
g.__trybackStore ??= { chain: Promise.resolve(), cache: null, loading: null };
const state = g.__trybackStore;

async function ensureDirs(): Promise<void> {
  await fs.mkdir(PHOTOS_DIR, { recursive: true });
  await fs.mkdir(RENDERS_DIR, { recursive: true });
}

async function load(): Promise<Db> {
  if (state.cache) return state.cache;
  // Memoise the first load: two concurrent first callers must share one cache object,
  // otherwise a write made through one copy is lost when the other installs its own.
  state.loading ??= (async () => {
    await ensureDirs();
    let db: Db;
    try {
      const raw = await fs.readFile(DB_FILE, "utf8");
      const parsed = JSON.parse(raw) as Db;
      db = { ...emptyDb(), ...parsed };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      db = emptyDb();
    }
    state.cache ??= db;
    return state.cache;
  })().finally(() => {
    state.loading = null;
  });
  return state.loading;
}

async function persist(db: Db): Promise<void> {
  const tmp = `${DB_FILE}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmp, DB_FILE);
}

/** Read-only snapshot (deep-cloned so callers can't mutate store state by accident). */
export async function readDb(): Promise<Db> {
  await state.chain.catch(() => undefined);
  return structuredClone(await load());
}

/**
 * Serialised read-modify-write. `fn` may mutate `db` in place; the result is persisted
 * atomically before the returned promise resolves. Never call `mutate` from inside `fn`.
 */
export function mutate<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const run = state.chain.catch(() => undefined).then(async () => {
    const db = await load();
    const snapshot = structuredClone(db);
    try {
      const result = await fn(db);
      await persist(db);
      return structuredClone(result);
    } catch (err) {
      state.cache = snapshot; // roll back in-memory changes
      throw err;
    }
  });
  state.chain = run;
  return run;
}

export async function getReturn(id: string): Promise<ReturnCase | null> {
  const db = await readDb();
  return db.returns[id] ?? null;
}

/** Mutate one return case; throws if it does not exist. Returns the updated copy. */
export function updateReturn(
  id: string,
  fn: (r: ReturnCase, db: Db) => void | Promise<void>,
): Promise<ReturnCase> {
  return mutate(async (db) => {
    const r = db.returns[id];
    if (!r) throw new Error(`Return ${id} not found`);
    await fn(r, db);
    return r;
  });
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/* ───────────── Binary blobs ───────────── */

function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error(`Unsafe blob name: ${name}`);
  return name;
}

export async function savePhoto(returnId: string, bytes: Buffer): Promise<void> {
  await ensureDirs();
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ PHOTOS_DIR, `${safeName(returnId)}.jpg`), bytes);
}

export async function readPhoto(returnId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(/*turbopackIgnore: true*/ PHOTOS_DIR, `${safeName(returnId)}.jpg`));
  } catch {
    return null;
  }
}

export async function deletePhoto(returnId: string): Promise<void> {
  await fs.rm(path.join(/*turbopackIgnore: true*/ PHOTOS_DIR, `${safeName(returnId)}.jpg`), { force: true });
}

/** Stored file name for a render: `<cacheKey>` for the first write, `<cacheKey>_<version>` after. */
export function renderBlobName(cacheKey: string, version?: string | null): string {
  return version ? `${cacheKey}_${version}` : cacheKey;
}

export async function saveRender(cacheKey: string, bytes: Buffer): Promise<void> {
  await ensureDirs();
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ RENDERS_DIR, `${safeName(cacheKey)}.img`), bytes);
}

export async function readRender(cacheKey: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(/*turbopackIgnore: true*/ RENDERS_DIR, `${safeName(cacheKey)}.img`));
  } catch {
    return null;
  }
}

export async function hasRender(cacheKey: string): Promise<boolean> {
  try {
    await fs.access(path.join(/*turbopackIgnore: true*/ RENDERS_DIR, `${safeName(cacheKey)}.img`));
    return true;
  } catch {
    return false;
  }
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
