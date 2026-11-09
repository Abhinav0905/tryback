// Retention: what the consent copy promises, enforced.
//   · Shopper photos are deleted within PHOTO_RETENTION_HOURS (default 24) of upload, and the
//     return's photo reference is cleared (the flow then falls back to catalogue images).
//   · Cached renders are deleted within RENDER_RETENTION_DAYS (default 14) of being made,
//     together with their render-index entries.
//   · "Within": the sweep runs hourly, so it deletes anything that would pass its limit before
//     the next sweep (sweepLeadMs), i.e. between one sweep interval early and the limit itself.
//   · Pinned renders are kept: the team pins the renders of a consenting team member's photo
//     so judges can replay them (docs/DEPLOY.md). Pins live in <data>/retention-pins.json.
//   · Seeded demo history is never touched (it isn't stored, and seeded returns are skipped).
//
// Runs hourly from instrumentation.ts (server boot), on GET /api/status when a sweep is
// overdue, from POST /api/admin/retention, and offline via scripts/purge.ts. Server-only.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { DATA_DIR, PHOTOS_DIR, RENDERS_DIR, mutate, readDb } from "./store";

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PHOTO_FILE = /^([A-Za-z0-9_-]{1,128})\.jpg$/;
const RENDER_FILE = /^([A-Za-z0-9_-]{1,128})\.img$/;

export interface RetentionPolicy {
  photoMaxAgeMs: number;
  renderMaxAgeMs: number;
}

/**
 * How early a sweep deletes, so a file is gone by its limit even though sweeps are an interval
 * apart: one sweep interval, but never more than a quarter of the limit (a shortened retention,
 * e.g. 1 h, must not delete a photo minutes after upload while its return is in progress).
 */
export function sweepLeadMs(maxAgeMs: number, intervalMs = SWEEP_INTERVAL_MS): number {
  return Math.max(0, Math.min(intervalMs, maxAgeMs / 4));
}

export function currentPolicy(): RetentionPolicy {
  return {
    photoMaxAgeMs: config.photoRetentionHours * HOUR_MS,
    renderMaxAgeMs: config.renderRetentionDays * DAY_MS,
  };
}

export interface SweepReport {
  at: string;
  dryRun: boolean;
  durationMs: number;
  policy: { photoRetentionHours: number; renderRetentionDays: number };
  photos: {
    /** Returns whose photo was deleted and whose `photo` reference was cleared. */
    refsCleared: number;
    /** Photo files deleted (referenced + orphaned). */
    filesDeleted: number;
    /** Of those, files no return referenced (e.g. a failed delete during a reset). */
    orphansDeleted: number;
    errors: number;
  };
  renders: {
    indexEntriesDeleted: number;
    filesDeleted: number;
    /** Expired render keys kept because they are pinned. */
    pinnedKept: number;
    errors: number;
  };
}

export interface RenderPin {
  pinnedAt: string;
  returnId: string | null;
  note?: string;
}

interface PinsFile {
  version: 1;
  renders: Record<string, RenderPin>;
}

interface RetentionState {
  chain: Promise<unknown>;
  running: boolean;
  lastStartedAt: number | null;
  lastReport: SweepReport | null;
  lastError: string | null;
  timer: ReturnType<typeof setInterval> | null;
  kickoff: ReturnType<typeof setTimeout> | null;
}

// Process-wide (instrumentation and route bundles share it).
const g = globalThis as unknown as { __trybackRetention?: RetentionState };
g.__trybackRetention ??= {
  chain: Promise.resolve(),
  running: false,
  lastStartedAt: null,
  lastReport: null,
  lastError: null,
  timer: null,
  kickoff: null,
};
const state = g.__trybackRetention;

/** Sweeps and pin edits run one at a time, so a pin can't race a sweep that is deleting. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = state.chain.catch(() => undefined).then(fn);
  state.chain = run;
  return run;
}

/* ───────────── Pins ───────────── */

export const PINS_FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "retention-pins.json");

export async function readPins(): Promise<Record<string, RenderPin>> {
  try {
    const parsed = JSON.parse(await fs.readFile(PINS_FILE, "utf8")) as Partial<PinsFile>;
    return parsed && typeof parsed.renders === "object" && parsed.renders ? { ...parsed.renders } : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writePins(renders: Record<string, RenderPin>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PINS_FILE}.${randomUUID()}.tmp`;
  const body: PinsFile = { version: 1, renders };
  await fs.writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
  await fs.rename(tmp, PINS_FILE);
}

export class RetentionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RetentionError";
  }
}

/** Keep every finished render of this return past RENDER_RETENTION_DAYS (its photo still goes after 24 h). */
export function pinReturnRenders(returnId: string, note?: string): Promise<{ pinned: string[]; totalPins: number }> {
  return serialize(async () => {
    const r = (await readDb()).returns[returnId];
    if (!r) throw new RetentionError(404, "RETURN_NOT_FOUND", "We couldn't find that return.");
    const keys = [...new Set(r.renders.filter((j) => j.status === "success" && j.cacheKey).map((j) => j.cacheKey))];
    if (keys.length === 0) throw new RetentionError(409, "NO_RENDERS", "That return has no finished renders to pin.");
    const pins = await readPins();
    const at = new Date().toISOString();
    for (const k of keys) pins[k] = { pinnedAt: at, returnId, ...(note ? { note: note.slice(0, 200) } : {}) };
    await writePins(pins);
    return { pinned: keys, totalPins: Object.keys(pins).length };
  });
}

/** Remove the pins made for a return (or every pin with `all`); the next sweep applies the normal rule. */
export function unpinRenders(opts: { returnId: string } | { all: true }): Promise<{ unpinned: number; totalPins: number }> {
  return serialize(async () => {
    const pins = await readPins();
    let unpinned = 0;
    if ("all" in opts) {
      unpinned = Object.keys(pins).length;
      for (const k of Object.keys(pins)) delete pins[k];
    } else {
      const r = (await readDb()).returns[opts.returnId];
      const keys = new Set(r ? r.renders.map((j) => j.cacheKey) : []);
      for (const [k, p] of Object.entries(pins)) {
        if (p.returnId === opts.returnId || keys.has(k)) {
          delete pins[k];
          unpinned += 1;
        }
      }
    }
    await writePins(pins);
    return { unpinned, totalPins: Object.keys(pins).length };
  });
}

/* ───────────── Sweep ───────────── */

interface FileInfo {
  name: string;
  file: string;
  mtimeMs: number;
}

async function listFiles(dir: string, re: RegExp): Promise<FileInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: FileInfo[] = [];
  for (const entry of names) {
    const m = re.exec(entry);
    if (!m) continue;
    const file = path.join(/*turbopackIgnore: true*/ dir, entry);
    const st = await fs.stat(file).catch(() => null);
    if (st?.isFile()) out.push({ name: m[1]!, file, mtimeMs: st.mtimeMs });
  }
  return out;
}

async function mtimeOf(file: string): Promise<number | null> {
  const st = await fs.stat(file).catch(() => null);
  return st ? st.mtimeMs : null;
}

/** Render blob `<key>` or `<key>_<version>` → the index key it belongs to (or its own name if unknown). */
function ownerKey(blob: string, keys: Set<string>): string {
  if (keys.has(blob)) return blob;
  for (let i = blob.indexOf("_"); i > 0; i = blob.indexOf("_", i + 1)) {
    const k = blob.slice(0, i);
    if (keys.has(k)) return k;
  }
  const us = blob.indexOf("_");
  return us > 0 ? blob.slice(0, us) : blob;
}

function emptyReport(dryRun: boolean, policy: RetentionPolicy): SweepReport {
  return {
    at: new Date().toISOString(),
    dryRun,
    durationMs: 0,
    policy: {
      photoRetentionHours: policy.photoMaxAgeMs / HOUR_MS,
      renderRetentionDays: policy.renderMaxAgeMs / DAY_MS,
    },
    photos: { refsCleared: 0, filesDeleted: 0, orphansDeleted: 0, errors: 0 },
    renders: { indexEntriesDeleted: 0, filesDeleted: 0, pinnedKept: 0, errors: 0 },
  };
}

/**
 * Delete what is past retention. Candidates are found from a snapshot, then re-checked under
 * the store lock (photos, render index) or by a fresh stat (render files), so a photo uploaded
 * or a render written meanwhile is never deleted.
 */
export function sweepRetention(
  opts: { now?: number; dryRun?: boolean; policy?: RetentionPolicy } = {},
): Promise<SweepReport> {
  return serialize(() => sweepNow(opts));
}

async function sweepNow(opts: { now?: number; dryRun?: boolean; policy?: RetentionPolicy }): Promise<SweepReport> {
  const started = Date.now();
  const now = opts.now ?? started;
  const dryRun = opts.dryRun ?? false;
  const policy = opts.policy ?? currentPolicy();
  const photoCutoff = now - (policy.photoMaxAgeMs - sweepLeadMs(policy.photoMaxAgeMs));
  const renderCutoff = now - (policy.renderMaxAgeMs - sweepLeadMs(policy.renderMaxAgeMs));
  const report = emptyReport(dryRun, policy);
  report.at = new Date(now).toISOString();

  const [db, pins, photoFiles, renderFiles] = await Promise.all([
    readDb(),
    readPins(),
    listFiles(PHOTOS_DIR, PHOTO_FILE),
    listFiles(RENDERS_DIR, RENDER_FILE),
  ]);
  const photoMtime = new Map(photoFiles.map((f) => [f.name, f.mtimeMs]));

  const photoUploadedMs = (id: string, uploadedAt: string): number => {
    const t = Date.parse(uploadedAt);
    return Number.isFinite(t) ? t : (photoMtime.get(id) ?? now);
  };

  // Photos referenced by a return.
  const expiredReturns = Object.values(db.returns)
    .filter((r) => !r.seeded && r.photo && photoUploadedMs(r.id, r.photo.uploadedAt) <= photoCutoff)
    .map((r) => r.id);
  // Photo files no return points at (nothing new: guarded by mtime).
  const referenced = new Set(Object.values(db.returns).filter((r) => r.photo).map((r) => r.id));
  const orphanPhotos = photoFiles.filter((f) => !referenced.has(f.name) && f.mtimeMs <= photoCutoff);

  // Render index entries and blobs.
  const indexKeys = new Set(Object.keys(db.renderIndex));
  const expiredIndex: string[] = [];
  for (const [key, entry] of Object.entries(db.renderIndex)) {
    const t = Date.parse(entry.createdAt);
    // An unreadable timestamp keeps the entry; its blob still expires by file age below.
    if (!Number.isFinite(t) || t > renderCutoff) continue;
    if (pins[key]) report.renders.pinnedKept += 1;
    else expiredIndex.push(key);
  }
  const expiredBlobs = renderFiles.filter((f) => f.mtimeMs <= renderCutoff && !pins[ownerKey(f.name, indexKeys)]);

  if (dryRun) {
    report.photos.refsCleared = expiredReturns.length;
    report.photos.orphansDeleted = orphanPhotos.length;
    report.photos.filesDeleted = expiredReturns.filter((id) => photoMtime.has(id)).length + orphanPhotos.length;
    report.renders.indexEntriesDeleted = expiredIndex.length;
    report.renders.filesDeleted = expiredBlobs.length;
    report.durationMs = Date.now() - started;
    return report;
  }

  if (expiredReturns.length > 0 || orphanPhotos.length > 0 || expiredIndex.length > 0) {
    // Under the store lock: the photo route saves files inside its own mutate, so a photo can't
    // be replaced between our re-check and the delete.
    const changes = await mutate(async (d) => {
      const c = { refsCleared: 0, filesDeleted: 0, orphansDeleted: 0, photoErrors: 0, indexDeleted: 0 };
      for (const id of expiredReturns) {
        const r = d.returns[id];
        if (!r || r.seeded || !r.photo || photoUploadedMs(id, r.photo.uploadedAt) > photoCutoff) continue;
        // turbopackIgnore: a runtime data path; without it the tracer copies every project .jpg
        // (probe photos included) into the standalone build.
        const file = path.join(/*turbopackIgnore: true*/ PHOTOS_DIR, `${id}.jpg`);
        const existed = (await mtimeOf(file)) !== null;
        try {
          await fs.rm(file, { force: true });
        } catch {
          c.photoErrors += 1;
          continue; // keep the reference: we'll try again next sweep
        }
        r.photo = null;
        c.refsCleared += 1;
        if (existed) c.filesDeleted += 1;
      }
      const stillReferenced = new Set(Object.values(d.returns).filter((r) => r.photo).map((r) => r.id));
      for (const f of orphanPhotos) {
        if (stillReferenced.has(f.name)) continue;
        const m = await mtimeOf(f.file);
        if (m === null || m > photoCutoff) continue;
        try {
          await fs.rm(f.file, { force: true });
          c.filesDeleted += 1;
          c.orphansDeleted += 1;
        } catch {
          c.photoErrors += 1;
        }
      }
      for (const key of expiredIndex) {
        const entry = d.renderIndex[key];
        if (!entry) continue;
        const t = Date.parse(entry.createdAt);
        if (!Number.isFinite(t) || t > renderCutoff) continue; // re-rendered meanwhile
        delete d.renderIndex[key];
        c.indexDeleted += 1;
      }
      return c;
    });
    report.photos.refsCleared = changes.refsCleared;
    report.photos.filesDeleted = changes.filesDeleted;
    report.photos.orphansDeleted = changes.orphansDeleted;
    report.photos.errors = changes.photoErrors;
    report.renders.indexEntriesDeleted = changes.indexDeleted;
  }

  // Render blobs: written outside the store lock, so a fresh stat (not the lock) protects a new write.
  for (const f of expiredBlobs) {
    const m = await mtimeOf(f.file);
    if (m === null || m > renderCutoff) continue;
    try {
      await fs.rm(f.file, { force: true });
      report.renders.filesDeleted += 1;
    } catch {
      report.renders.errors += 1;
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}

/* ───────────── Scheduling ───────────── */

export interface RetentionStatus {
  policy: SweepReport["policy"];
  intervalMs: number;
  running: boolean;
  lastStartedAt: string | null;
  lastReport: SweepReport | null;
  lastError: string | null;
  pins: number;
  onDisk: { photos: number; renders: number };
}

export async function retentionStatus(): Promise<RetentionStatus> {
  const policy = currentPolicy();
  const [pins, photos, renders] = await Promise.all([
    readPins().catch(() => ({})),
    listFiles(PHOTOS_DIR, PHOTO_FILE).catch(() => []),
    listFiles(RENDERS_DIR, RENDER_FILE).catch(() => []),
  ]);
  return {
    policy: emptyReport(false, policy).policy,
    intervalMs: SWEEP_INTERVAL_MS,
    running: state.running,
    lastStartedAt: state.lastStartedAt === null ? null : new Date(state.lastStartedAt).toISOString(),
    lastReport: state.lastReport,
    lastError: state.lastError,
    pins: Object.keys(pins).length,
    onDisk: { photos: photos.length, renders: renders.length },
  };
}

/** Run a sweep now and remember its outcome for the status endpoint. Errors are logged, not thrown. */
export async function runScheduledSweep(): Promise<SweepReport | null> {
  if (state.running) return null;
  state.running = true;
  state.lastStartedAt = Date.now();
  try {
    const report = await sweepRetention();
    state.lastReport = report;
    state.lastError = null;
    const { photos: p, renders: r } = report;
    if (p.filesDeleted || p.refsCleared || r.indexEntriesDeleted || r.filesDeleted || p.errors || r.errors) {
      console.log(
        `[retention] deleted ${p.filesDeleted} photo file(s) (${p.refsCleared} return(s) cleared, ${p.orphansDeleted} orphaned), ` +
          `${r.indexEntriesDeleted} render index entr${r.indexEntriesDeleted === 1 ? "y" : "ies"}, ${r.filesDeleted} render file(s); ` +
          `${r.pinnedKept} pinned kept; ${p.errors + r.errors} error(s)`,
      );
    }
    return report;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error("[retention] sweep failed", err);
    return null;
  } finally {
    state.running = false;
  }
}

/** True when no sweep has started in the last interval (cheap; for GET /api/status). */
export function retentionSweepDue(now = Date.now()): boolean {
  return !state.running && (state.lastStartedAt === null || now - state.lastStartedAt >= SWEEP_INTERVAL_MS);
}

/**
 * Start the hourly sweeper (idempotent). The first sweep runs after `initialDelayMs`, so boot
 * isn't slowed. Timers are unref'd: they never keep the process alive on shutdown.
 */
export function startRetentionSweeper(opts: { intervalMs?: number; initialDelayMs?: number } = {}): () => void {
  const intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
  if (!state.timer) {
    state.kickoff = setTimeout(() => void runScheduledSweep(), opts.initialDelayMs ?? 30_000);
    state.kickoff.unref?.();
    state.timer = setInterval(() => void runScheduledSweep(), intervalMs);
    state.timer.unref?.();
  }
  return stopRetentionSweeper;
}

export function stopRetentionSweeper(): void {
  if (state.kickoff) clearTimeout(state.kickoff);
  if (state.timer) clearInterval(state.timer);
  state.kickoff = null;
  state.timer = null;
}
