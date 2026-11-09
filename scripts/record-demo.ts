// npm run record: films the demo video by driving the REAL app in headless Chrome.
//
//   npm run record                                  draft: dev mode (simulated renders), illustrated stand-ins
//   npm run record -- --mode auto --photo me.jpg --size-photo me-shirt.jpg
//                                                   live Clothsy renders (key in .env.local) on your own photos
//   npm run record -- --mode replay --photo me.jpg  re-film from the render cache at 0 credits
//   npm run record -- --only results,gate           re-film a few beats (earlier beats fast-forward unfilmed)
//   npm run record -- --help
//
// What it does: builds and starts its own production server (NEXT_DIST_DIR=.next-rec, port
// 3144, its own TRYBACK_DATA_DIR) unless --base is given; opens /demo?record=1 at 1920×1080;
// plays the beats in scripts/video/beats.ts with a fake cursor, lower-third captions and
// optional macOS `say` narration; captures frames with Page.startScreencast; resamples them
// to constant 30 fps and encodes H.264/AAC MP4 (AVFoundation on macOS, or ffmpeg).
// Outputs in out/video/: tryback-demo.mp4, captions.srt, youtube-description.md, beats.json,
// narration.wav, qa/ (one frame per beat + contact sheet) and debug/ on failure. A take with
// --only or --out writes its sidecars next to its own video, prefixed with its name.
//
// Honesty: in dev mode the title card, a corner badge and the captions say the renders are
// simulated, and the default shopper photos are illustrated stand-ins, never a real person.
// Never pass --photo with a photo of anyone who hasn't agreed to be filmed and processed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream, openSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findElementExpression, launchChrome, sleep, waitForHttp, type Browser, type Page } from "./lib/cdp";
import { snapshotNextProjectFiles } from "./lib/next-files";
import {
  BEAT_IDS,
  beatsFor,
  clockSentence,
  outroCardVars,
  renderProvenance,
  titleCardVars,
  type BeatDef,
  type Caption,
  type VideoFacts,
} from "./video/beats";
import { recordConsentProblem } from "./video/consent";
import { writeStandIns } from "./video/mannequin";
import {
  buildChapters,
  buildFrameRuns,
  chapterTime,
  cuesForClip,
  estimateSpeechSec,
  ffconcatScript,
  fillTemplate,
  mixClips,
  parseSayVoices,
  parseWav,
  pickVoice,
  segmentOffsets,
  toSrt,
  totalDuration,
  wavDurationSec,
  writeWav,
  type CapturedFrame,
  type Cue,
  type Pcm,
  type Segment,
} from "./video/timeline";

const ROOT = path.resolve(__dirname, "..");
const VIDEO_SRC = path.join(ROOT, "scripts", "video");
const W = 1920;
const H = 1080;
const FPS = 30;
const AUDIO_RATE = 44100;
const FRAME = "iframe";
/** Narration starts this long after its beat begins, and the beat holds this long after it ends. */
const LEAD_S = 0.25;
const TAIL_S = 0.55;

/* ───────────────────────── Options ───────────────────────── */

const HELP = `TryBack demo recorder — films the real app into out/video/tryback-demo.mp4

Usage: npm run record -- [options]

Server
  --mode <m>          dev | auto | live | replay (TRYON_MODE for the recorder's server)  [dev]
  --base <url>        Film an already-running server instead of building one (no reset unless --reset)
  --port <n>          Port for the recorder's own server                               [3144]
  --rebuild           Force a fresh production build (.next-rec); otherwise reused while up to date
  --skip-typecheck    Build without the TypeScript check (next build --experimental-build-mode
                      compile, then generate), e.g. while unrelated files don't typecheck
  --data-dir <dir>    TRYBACK_DATA_DIR for the recorder's server
                      [dev: out/video/data-dev, wiped each run · other modes: out/video/data, kept
                       so the render cache replays; returns are reset at the start]
  --reset             With --base: POST /api/admin/reset first (all returns if ADMIN_TOKEN is set in
                      your environment, otherwise only this recorder's own)

Shopper photos (consenting adults only; default: illustrated stand-ins, never a real person)
  --photo <file>      Photo wearing the returned wrap dress (order #1042)
  --size-photo <file> Photo wearing the returned linen shirt (order #1043). Without it, and with
                      --photo set, the size beat uses "Skip photo" (table view, 0 credits)
  --ai-people         Everyone in --photo/--size-photo is AI-generated (no real person): labels them
                      "AI-generated" on screen, on the cards and in the description; replaces --i-have-consent
  --i-have-consent    Required with --photo/--size-photo in --mode auto|live or with --base: every
                      person shown is an adult who agreed in writing to be filmed, to their photo
                      being sent to Clothsy AI, and to the video being published

Narration and captions
  --voice <name>      macOS voice for narration (see: say -v '?')         [best installed English]
  --rate <wpm>        Speaking rate                                        [188]
  --no-voice          Silent video (captions and pacing stay the same)

Output
  --out <file>        Video path                                           [out/video/tryback-demo.mp4]
  --only <a,b>        Film only these beats (earlier beats still run, fast and unfilmed):
                      ${BEAT_IDS.join(", ")}
  --encoder <e>       auto | avfoundation | ffmpeg                         [auto: AVFoundation on macOS]
  --repo-url <url>    Shown on the outro card / description                [placeholder]
  --demo-url <url>    Shown on the outro card / description                [placeholder]
  --keep-frames       Keep the captured JPEG frames
  --headful           Show the Chrome window while filming
  -h, --help`;

interface Options {
  mode: "dev" | "auto" | "live" | "replay";
  base: string | null;
  port: number;
  rebuild: boolean;
  skipTypecheck: boolean;
  dataDir: string | null;
  reset: boolean;
  photo: string | null;
  sizePhoto: string | null;
  consent: boolean;
  aiPeople: boolean;
  voice: string | null;
  rate: number;
  noVoice: boolean;
  out: string;
  only: string[] | null;
  encoder: "auto" | "avfoundation" | "ffmpeg";
  repoUrl: string;
  demoUrl: string;
  keepFrames: boolean;
  headful: boolean;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string", default: "dev" },
      base: { type: "string" },
      port: { type: "string", default: "3144" },
      rebuild: { type: "boolean", default: false },
      "skip-typecheck": { type: "boolean", default: false },
      "data-dir": { type: "string" },
      reset: { type: "boolean", default: false },
      photo: { type: "string" },
      "size-photo": { type: "string" },
      "i-have-consent": { type: "boolean", default: false },
      "ai-people": { type: "boolean", default: false },
      voice: { type: "string" },
      rate: { type: "string", default: "188" },
      "no-voice": { type: "boolean", default: false },
      out: { type: "string" },
      only: { type: "string" },
      encoder: { type: "string", default: "auto" },
      "repo-url": { type: "string", default: "[repo URL]" },
      "demo-url": { type: "string", default: "[live demo URL]" },
      "keep-frames": { type: "boolean", default: false },
      headful: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const mode = String(values.mode);
  if (!["dev", "auto", "live", "replay"].includes(mode)) throw new Error(`--mode must be dev, auto, live or replay (got ${mode})`);
  const encoder = String(values.encoder);
  if (!["auto", "avfoundation", "ffmpeg"].includes(encoder)) throw new Error(`--encoder must be auto, avfoundation or ffmpeg`);
  const only = values.only ? String(values.only).split(",").map((s) => s.trim()).filter(Boolean) : null;
  for (const id of only ?? []) {
    if (!(BEAT_IDS as readonly string[]).includes(id)) throw new Error(`Unknown beat "${id}". Beats: ${BEAT_IDS.join(", ")}`);
  }
  const abs = (p: string | undefined) => (p ? path.resolve(p) : null);
  const photo = abs(values.photo);
  const sizePhoto = abs(values["size-photo"]);
  for (const p of [photo, sizePhoto]) if (p && !existsSync(p)) throw new Error(`Photo not found: ${p}`);
  const consentProblem = recordConsentProblem({
    mode: mode as Options["mode"],
    base: values.base ? String(values.base) : null,
    photo,
    sizePhoto,
    consent: Boolean(values["i-have-consent"]),
    aiPeople: Boolean(values["ai-people"]),
  });
  if (consentProblem) throw new Error(consentProblem);
  if (values["ai-people"] && !photo) throw new Error("--ai-people labels your --photo / --size-photo as AI-generated; pass --photo too");
  const outDefault = only ? `out/video/tryback-demo-only-${only.join("-")}.mp4` : "out/video/tryback-demo.mp4";
  return {
    mode: mode as Options["mode"],
    base: values.base ? String(values.base).replace(/\/$/, "") : null,
    port: Number.parseInt(String(values.port), 10) || 3144,
    rebuild: Boolean(values.rebuild),
    skipTypecheck: Boolean(values["skip-typecheck"]),
    dataDir: abs(values["data-dir"]),
    reset: Boolean(values.reset),
    photo,
    sizePhoto,
    consent: Boolean(values["i-have-consent"]),
    aiPeople: Boolean(values["ai-people"]),
    voice: values.voice ? String(values.voice) : null,
    rate: Number.parseInt(String(values.rate), 10) || 188,
    noVoice: Boolean(values["no-voice"]),
    out: path.resolve(values.out ? String(values.out) : outDefault),
    only,
    encoder: encoder as Options["encoder"],
    repoUrl: String(values["repo-url"]),
    demoUrl: String(values["demo-url"]),
    keepFrames: Boolean(values["keep-frames"]),
    headful: Boolean(values.headful),
  };
}

/* ───────────────────────── Small process helpers ───────────────────────── */

function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
}

function runAsync(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const log = opts.log ? createWriteStream(opts.log, { flags: "a" }) : null;
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
      log?.write(d);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      log?.end();
      resolve({ code, out });
    });
  });
}

/* ───────────────────────── Tools: voice, encoder ───────────────────────── */

interface Tools {
  say: boolean;
  voice: string | null;
  encoder: "avfoundation" | "ffmpeg";
  avencode: string | null;
  notes: string[];
}

function detectTools(opts: Options, outDir: string): Tools {
  const notes: string[] = [];
  // Voice
  let say = false;
  let voice: string | null = null;
  if (!opts.noVoice) {
    const r = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
    if (r.status === 0) {
      const voices = parseSayVoices(r.stdout);
      say = true;
      if (opts.voice) {
        if (!voices.some((v) => v.name === opts.voice)) {
          throw new Error(`Voice "${opts.voice}" isn't installed. Installed English voices: ${voices.filter((v) => v.locale.startsWith("en_")).map((v) => v.name).join(", ")}`);
        }
        voice = opts.voice;
      } else {
        voice = pickVoice(voices);
        if (!/\((Premium|Enhanced)\)/.test(voice)) {
          notes.push(`Narration voice: ${voice}. For a more natural voice, install a Premium/Enhanced one (System Settings → Accessibility → Spoken Content → System voice → Manage Voices) and pass --voice "<name>".`);
        }
      }
    } else {
      notes.push("macOS `say` isn't available, so the video is silent (captions only). Pass --no-voice to silence this note.");
    }
  }
  // Encoder
  // A quarantined ffmpeg is either killed by macOS at once or hangs on the Gatekeeper check,
  // so the probe gets a timeout; both count as blocked.
  const ff = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10_000 });
  const ffmpegOk = ff.status === 0;
  const ffmpegBlocked = ff.signal === "SIGKILL" || ff.status === 137 || (ff.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const swiftc = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });
  const swiftOk = process.platform === "darwin" && swiftc.status === 0;
  let encoder: Tools["encoder"];
  if (opts.encoder === "ffmpeg") {
    if (!ffmpegOk) throw new Error(ffmpegBlocked ? ffmpegBlockedHelp() : "ffmpeg isn't installed (brew install ffmpeg), or use --encoder avfoundation on macOS.");
    encoder = "ffmpeg";
  } else if (opts.encoder === "avfoundation") {
    if (!swiftOk) throw new Error("--encoder avfoundation needs macOS with the Xcode command line tools (xcode-select --install).");
    encoder = "avfoundation";
  } else if (swiftOk) {
    encoder = "avfoundation";
  } else if (ffmpegOk) {
    encoder = "ffmpeg";
  } else {
    throw new Error(ffmpegBlocked ? ffmpegBlockedHelp() : "No video encoder: install ffmpeg (brew install ffmpeg), or run on macOS with the Xcode command line tools.");
  }
  if (encoder === "avfoundation" && ffmpegBlocked) {
    notes.push(`ffmpeg is installed but macOS blocks it (quarantine flag), so AVFoundation encoded the video. Optional fix: ${ffmpegFixCommand()}`);
  }
  const avencode = encoder === "avfoundation" ? compileAvencode(outDir) : null;
  return { say, voice, encoder, avencode, notes };
}

function ffmpegFixCommand(): string {
  return "brew reinstall ffmpeg (or: xattr -dr com.apple.quarantine \"$(brew --prefix ffmpeg)/\")";
}

function ffmpegBlockedHelp(): string {
  return `ffmpeg is installed but macOS refuses to run it (Gatekeeper quarantine). Fix it with: ${ffmpegFixCommand()}, or use --encoder avfoundation.`;
}

function compileAvencode(outDir: string): string {
  const src = path.join(VIDEO_SRC, "avencode.swift");
  const hash = createHash("sha256").update(readFileSync(src)).digest("hex").slice(0, 12);
  const binDir = path.join(outDir, ".bin");
  const bin = path.join(binDir, `avencode-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(binDir, { recursive: true });
  const r = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", "-suppress-warnings", src, "-o", bin], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Couldn't compile ${rel(src)}:\n${r.stderr || r.stdout}`);
  return bin;
}

/* ───────────────────────── Narration ───────────────────────── */

/** Spoken-text fixes for the TTS only (captions keep the real spelling). */
function ttsText(text: string): string {
  return text
    .replace(/TryBack/g, "Try-Back")
    .replace(/FabricVTON/g, "Fabric Vee-Ton")
    .replace(/Clothsy/g, "Clothsee")
    .replace(/MediaPipe/g, "Media Pipe")
    .replace(/→/g, "to")
    .replace(/#(\d{4})/g, "$1");
}

interface Clip {
  beat: string;
  text: string;
  /** Wall-clock start (seconds). */
  start: number;
  dur: number;
  pcm: Pcm | null;
}

class Narrator {
  private cache = new Map<string, { dur: number; pcm: Pcm | null }>();
  constructor(
    private voice: string | null,
    private rate: number,
    private dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  get enabled(): boolean {
    return this.voice !== null;
  }

  async clip(text: string): Promise<{ dur: number; pcm: Pcm | null }> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    if (!this.voice || !text.trim()) {
      const v = { dur: estimateSpeechSec(text), pcm: null };
      this.cache.set(text, v);
      return v;
    }
    const key = createHash("sha256").update(`${this.voice}|${this.rate}|${text}`).digest("hex").slice(0, 16);
    const file = path.join(this.dir, `${key}.wav`);
    if (!existsSync(file)) {
      const r = await runAsync("say", ["-v", this.voice, "-r", String(this.rate), "--file-format=WAVE", `--data-format=LEI16@${AUDIO_RATE}`, "-o", file, ttsText(text)]);
      if (r.code !== 0 || !existsSync(file)) throw new Error(`say failed: ${r.out.trim()}`);
    }
    const pcm = parseWav(readFileSync(file));
    const v = { dur: wavDurationSec(pcm), pcm };
    this.cache.set(text, v);
    return v;
  }
}

/* ───────────────────────── Server ───────────────────────── */

interface Server {
  base: string;
  /** Sent as a Bearer token to /api/admin/reset (full reset); null = the caller's own returns only. */
  adminToken: string | null;
  stop(): Promise<void>;
}

function newestMtime(paths: string[]): number {
  let newest = 0;
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) if (!e.startsWith(".")) walk(path.join(p, e));
    } else newest = Math.max(newest, st.mtimeMs);
  };
  for (const p of paths) walk(p);
  return newest;
}

async function startOwnServer(opts: Options, outDir: string, logsDir: string): Promise<Server> {
  const distDir = ".next-rec";
  const buildId = path.join(ROOT, distDir, "BUILD_ID");
  const sources = ["app", "components", "lib", "public", "next.config.ts", "package.json", "package-lock.json"].map((p) => path.join(ROOT, p));
  const stale = !existsSync(buildId) || newestMtime(sources) > statSync(buildId).mtimeMs;
  const env = { ...process.env, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1" };
  // next build with NEXT_DIST_DIR rewrites tsconfig.json and next-env.d.ts; put them back.
  const restoreNextFiles = snapshotNextProjectFiles(ROOT);
  if (opts.rebuild || stale) {
    const log = path.join(logsDir, "build.log");
    console.log(`Building the app (NEXT_DIST_DIR=${distDir}${opts.skipTypecheck ? ", no type check" : ""}, log: ${rel(log)})…`);
    const t0 = Date.now();
    writeFileSync(log, "");
    const steps = opts.skipTypecheck
      ? [["next", "build", "--experimental-build-mode", "compile"], ["next", "build", "--experimental-build-mode", "generate"]]
      : [["next", "build"]];
    for (const args of steps) {
      const r = await runAsync("npx", args, { env, log });
      if (r.code !== 0) {
        const hint = /Failed to type check|Type error/i.test(r.out)
          ? "\nType errors in the repo block `next build`. Fix them, or film anyway with --skip-typecheck."
          : "";
        throw new Error(`next build failed (see ${rel(log)}):\n${r.out.split("\n").slice(-25).join("\n")}${hint}`);
      }
    }
    restoreNextFiles();
    console.log(`  built in ${Math.round((Date.now() - t0) / 1000)} s`);
  } else {
    console.log(`Reusing the production build in ${distDir} (pass --rebuild to force).`);
  }

  const dataDir = opts.dataDir ?? path.join(outDir, opts.mode === "dev" ? "data-dev" : "data");
  if (opts.mode === "dev" && !opts.dataDir) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const busy = await fetch(`http://127.0.0.1:${opts.port}/`).then(() => true, () => false);
  if (busy) throw new Error(`Port ${opts.port} is already in use. Stop that server or pass --port <n> (or --base <url> to film it).`);

  const logFile = path.join(logsDir, "server.log");
  const fd = openSync(logFile, "w");
  const adminToken = randomBytes(24).toString("hex");
  // Bound to 127.0.0.1 only: nobody else on the network can reach this server or its credits.
  const child: ChildProcess = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(opts.port)], {
    cwd: ROOT,
    // LIVE_ACCESS_CODE="" turns the judge lock off for this private loopback server only, and
    // ALLOW_PUBLIC_LIVE=1 lifts the production fail-safe (lib/live.ts publicLiveAllowed), so a
    // live take isn't silently downgraded to replay; a one-off ADMIN_TOKEN allows the full reset.
    env: {
      ...env,
      TRYON_MODE: opts.mode,
      TRYBACK_DATA_DIR: dataDir,
      LIVE_ACCESS_CODE: "",
      ALLOW_PUBLIC_LIVE: "1",
      ADMIN_TOKEN: adminToken,
      NODE_ENV: "production",
    },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  const base = `http://127.0.0.1:${opts.port}`;
  const stop = async () => {
    restoreNextFiles();
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  };
  try {
    await waitForHttp(`${base}/api/status`, 90_000);
  } catch (e) {
    await stop();
    throw new Error(`The recorder's server didn't start (log: ${rel(logFile)}): ${(e as Error).message}`);
  }
  console.log(`Server: ${base} (TRYON_MODE=${opts.mode}, data ${rel(dataDir)}, log ${rel(logFile)})`);
  return { base, adminToken, stop };
}

/** POST /api/admin/reset: every non-seeded return with the admin token, else (no cookie) none. Render cache kept. */
async function resetReturns(server: Server): Promise<void> {
  const headers: Record<string, string> = server.adminToken ? { authorization: `Bearer ${server.adminToken}` } : {};
  const r = await getJson<{ scope?: string; deletedReturns?: number }>(`${server.base}/api/admin/reset`, { method: "POST", headers });
  console.log(`Reset: ${r.deletedReturns ?? 0} earlier return(s) deleted (${r.scope ?? "?"} scope); cached renders kept.`);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}`);
  return (await res.json()) as T;
}

interface AppStatus {
  mode: string;
  activeProvider: "clothsy" | "dev";
  hasClothsyKey: boolean;
  hasAnthropicKey: boolean;
}

/* ───────────────────────── Recorder (browser + capture) ───────────────────────── */

class BeatFailure extends Error {
  constructor(
    readonly beat: string,
    readonly cause: unknown,
  ) {
    super(`Beat "${beat}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

interface FlowState {
  returnId: string | null;
  clockLine: string | null;
  gradingNote: string | null;
  overrides: string[];
}

class Recorder {
  frames: CapturedFrame[] = [];
  segments: Segment[] = [];
  clips: Clip[] = [];
  beatLog: { id: string; chapter: string; caption: Caption | null; narration: string; start: number; end: number; filmed: boolean }[] = [];
  /** Fast-forward: no narration, no holds, instant cursor (unfilmed prerequisite beats). */
  fast = false;
  private frameNo = 0;
  private beat: BeatDef | null = null;
  private beatStart = 0;
  private beatNarration: string[] = [];
  private caption: Caption | null = null;
  private badge: { text: string; tone: string; pos: string } | null = null;
  private cursor = { x: W * 0.62, y: H * 0.55 };

  constructor(
    readonly page: Page,
    readonly base: string,
    readonly framesDir: string,
    readonly narrator: Narrator,
    readonly debugDir: string,
  ) {}

  async start(overlaySource: string): Promise<void> {
    mkdirSync(this.framesDir, { recursive: true });
    await this.page.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: "no-preference" },
      ],
    });
    await this.page.send("Page.addScriptToEvaluateOnNewDocument", { source: overlaySource });
    this.page.on("Page.screencastFrame", (p) => {
      const meta = p.metadata as { timestamp?: number };
      const t = typeof meta.timestamp === "number" ? meta.timestamp : Date.now() / 1000;
      const file = path.join(this.framesDir, `${String(++this.frameNo).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(String(p.data), "base64"));
      this.frames.push({ file, t });
      void this.page.send("Page.screencastFrameAck", { sessionId: p.sessionId as number }).catch(() => undefined);
    });
    await this.page.send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1, maxWidth: W, maxHeight: H });
  }

  async stopCapture(): Promise<void> {
    await this.page.send("Page.stopScreencast").catch(() => undefined);
  }

  /* ── beats ── */

  async beginBeat(def: BeatDef, filmed: boolean): Promise<void> {
    this.beat = def;
    this.fast = !filmed;
    this.beatStart = Date.now() / 1000;
    this.beatNarration = [];
    if (def.layout !== "card") await this.setCaption(def.caption);
    if (!this.fast && def.narration) await this.narrate(def.narration);
  }

  async endBeat(minSec = 1.2): Promise<void> {
    const def = this.beat;
    if (!def) return;
    if (!this.fast) {
      const clipEnd = Math.max(0, ...this.clips.filter((c) => c.beat === def.id).map((c) => c.start + c.dur));
      const until = Math.max(clipEnd + TAIL_S, this.beatStart + minSec);
      const wait = until - Date.now() / 1000;
      if (wait > 0) await sleep(wait * 1000);
    }
    const end = Date.now() / 1000;
    if (!this.fast) this.segments.push({ id: def.id, start: this.beatStart, end });
    this.beatLog.push({ id: def.id, chapter: def.chapter, caption: this.caption, narration: this.beatNarration.join(" "), start: this.beatStart, end, filmed: !this.fast });
    this.beat = null;
  }

  /** Speak `text` now (after a short lead); the beat holds until it has finished. */
  async narrate(text: string): Promise<number> {
    if (this.fast || !this.beat) return 0;
    const { dur, pcm } = await this.narrator.clip(text);
    const last = this.clips.filter((c) => c.beat === this.beat!.id).at(-1);
    const start = Math.max(Date.now() / 1000 + LEAD_S, last ? last.start + last.dur + 0.15 : 0);
    this.clips.push({ beat: this.beat.id, text, start, dur, pcm });
    this.beatNarration.push(text);
    return dur;
  }

  /** Wait until the beat's narration so far has (nearly) finished, e.g. before a reveal. */
  async waitForNarration(leftSec = 0): Promise<void> {
    if (this.fast || !this.beat) return;
    const clipEnd = Math.max(0, ...this.clips.filter((c) => c.beat === this.beat!.id).map((c) => c.start + c.dur));
    const wait = clipEnd - leftSec - Date.now() / 1000;
    if (wait > 0) await sleep(wait * 1000);
  }

  async hold(ms: number): Promise<void> {
    if (!this.fast) await sleep(ms);
  }

  /* ── overlay ── */

  private async overlay(js: string): Promise<void> {
    await this.page.evaluate(`window.__tbrec ? (${js}) : null`).catch(() => undefined);
  }

  async setCaption(c: Caption | null): Promise<void> {
    this.caption = c;
    await this.overlay(c ? `__tbrec.caption(${JSON.stringify(c)})` : "__tbrec.clearCaption()");
  }

  async updateCaption(patch: Partial<Caption>): Promise<void> {
    if (!this.caption) return;
    await this.setCaption({ ...this.caption, ...patch });
  }

  async setBadge(text: string | null, tone = "warn", pos = "top-right"): Promise<void> {
    this.badge = text ? { text, tone, pos } : null;
    await this.overlay(`__tbrec.badge(${JSON.stringify(text)}, ${JSON.stringify(tone)}, ${JSON.stringify(pos)})`);
  }

  private async reapplyOverlay(): Promise<void> {
    await this.page.waitForFunction("!!window.__tbrec && !!document.body", 10_000).catch(() => undefined);
    if (this.badge && this.beat?.layout !== "card") {
      // Full pages (merchant, bench) have their nav top-right, so the badge moves to the top centre.
      const pos = this.beat?.layout === "page" ? "top-center" : this.badge.pos;
      await this.overlay(`__tbrec.badge(${JSON.stringify(this.badge.text)}, ${JSON.stringify(this.badge.tone)}, ${JSON.stringify(pos)})`);
    }
    if (this.caption && this.beat?.layout !== "card") await this.overlay(`__tbrec.caption(${JSON.stringify(this.caption)})`);
    await this.overlay(`__tbrec.cursorShow(${this.cursor.x}, ${this.cursor.y})`);
  }

  async goto(url: string, opts: { hideCursor?: boolean } = {}): Promise<void> {
    await this.page.goto(url.startsWith("http") || url.startsWith("file:") ? url : `${this.base}${url}`, 60_000);
    await this.reapplyOverlay();
    if (opts.hideCursor) await this.overlay("__tbrec.cursorHide()");
  }

  async fadeOut(ms = 450): Promise<void> {
    if (this.fast) return;
    await this.page.evaluate(`window.__tbrec ? __tbrec.fadeOut(${ms}) : null`).catch(() => undefined);
  }

  async highlight(rect: { x: number; y: number; width: number; height: number; radius?: number } | null): Promise<void> {
    await this.overlay(`__tbrec.highlight(${JSON.stringify(rect)})`);
  }

  /* ── locating, scrolling, cursor ── */

  /**
   * Find an element (cdp selector, or a JS finder `(d) => Element` source), smooth-scroll it
   * into view inside its own document, and return its rect in top-level viewport pixels.
   */
  async locate(
    target: string | { js: string },
    o: { frame?: boolean; align?: "center" | "start"; topInset?: number; bottomInset?: number; timeoutMs?: number; scroll?: boolean } = {},
  ): Promise<{ x: number; y: number; width: number; height: number; cx: number; cy: number }> {
    const frame = o.frame === false ? undefined : FRAME;
    const finder =
      typeof target === "string"
        ? `(() => ${findElementExpression(target, frame)})()`
        : `(() => { const fr = ${frame ? `document.querySelector(${JSON.stringify(frame)})` : "null"}; const d = fr ? fr.contentDocument : document; if (!d) return null; return (${target.js})(d); })()`;
    const label = typeof target === "string" ? target : target.js.slice(0, 80);
    await this.waitFor(`!!${finder}`, o.timeoutMs ?? 30_000, `element ${label}`);
    const scrollMs = this.fast ? 0 : 650;
    const res = await this.page.evaluate<{ x: number; y: number; width: number; height: number } | null>(`(async () => {
      const el = ${finder};
      if (!el) return null;
      const win = el.ownerDocument.defaultView;
      const top = ${o.topInset ?? 24}, bottom = ${o.bottomInset ?? 70};
      const vh = win.innerHeight;
      let r = el.getBoundingClientRect();
      // "start" pins the element near the top; "center" only scrolls when it isn't fully visible.
      const fits = ${JSON.stringify(o.align ?? "center")} === "start"
        ? Math.abs(r.top - top) <= 24 || win.scrollY + vh >= win.document.documentElement.scrollHeight - 2 && r.top >= top
        : r.top >= top && r.bottom <= vh - bottom;
      if (${o.scroll !== false} && !fits) {
        const want = ${JSON.stringify(o.align ?? "center")} === "start" || r.height > vh - top - bottom
          ? win.scrollY + r.top - top
          : win.scrollY + r.top + r.height / 2 - (top + (vh - bottom)) / 2;
        const max = win.document.documentElement.scrollHeight - vh;
        const to = Math.max(0, Math.min(max, want));
        const from = win.scrollY, ms = ${scrollMs};
        if (ms > 0 && Math.abs(to - from) > 2) {
          await new Promise((done) => {
            const t0 = performance.now();
            const step = (now) => {
              const t = Math.min(1, (now - t0) / ms);
              const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
              win.scrollTo(0, from + (to - from) * k);
              if (t < 1) win.requestAnimationFrame(step); else done(null);
            };
            win.requestAnimationFrame(step);
          });
        } else win.scrollTo(0, to);
        await new Promise((d) => setTimeout(d, 60));
        r = el.getBoundingClientRect();
      }
      let x = r.left, y = r.top, w = r.width, h = r.height;
      ${frame ? `const fr = document.querySelector(${JSON.stringify(frame)}); const fb = fr.getBoundingClientRect();
      const sx = fr.offsetWidth ? fb.width / fr.offsetWidth : 1, sy = fr.offsetHeight ? fb.height / fr.offsetHeight : 1;
      x = fb.left + (fr.clientLeft + x) * sx; y = fb.top + (fr.clientTop + y) * sy; w *= sx; h *= sy;` : ""}
      return { x, y, width: w, height: h };
    })()`);
    if (!res) throw new Error(`Element not found: ${label}`);
    return { ...res, cx: res.x + res.width / 2, cy: res.y + res.height / 2 };
  }

  async moveTo(x: number, y: number): Promise<void> {
    const dist = Math.hypot(x - this.cursor.x, y - this.cursor.y);
    const ms = this.fast ? 0 : Math.round(Math.min(1100, 320 + dist * 0.55));
    this.cursor = { x, y };
    await this.page.evaluate(`window.__tbrec ? __tbrec.cursorTo(${x}, ${y}, ${ms}) : null`).catch(() => undefined);
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.moveTo(x, y);
    await this.hold(110);
    await this.overlay(`__tbrec.press(${x}, ${y})`);
    await this.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await this.hold(260);
  }

  async click(target: string | { js: string }, o: Parameters<Recorder["locate"]>[1] = {}): Promise<void> {
    const r = await this.locate(target, o);
    await this.clickAt(r.cx, r.cy);
  }

  /** Glide to an element without clicking (pointing something out). */
  async point(target: string | { js: string }, o: Parameters<Recorder["locate"]>[1] = {}): Promise<{ x: number; y: number; width: number; height: number }> {
    const r = await this.locate(target, o);
    await this.moveTo(r.cx, r.cy);
    return r;
  }

  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      await this.page.send("Input.insertText", { text: ch });
      if (!this.fast) await sleep(38 + Math.round(Math.random() * 30));
    }
  }

  async drag(from: { x: number; y: number }, stops: { x: number; y: number; ms: number }[]): Promise<void> {
    await this.moveTo(from.x, from.y);
    await this.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
    let cur = from;
    for (const s of stops) {
      const steps = this.fast ? 1 : Math.max(6, Math.round(s.ms / 16));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const x = cur.x + (s.x - cur.x) * k;
        const y = cur.y + (s.y - cur.y) * k;
        await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        await this.overlay(`__tbrec.cursorTo(${x}, ${y}, 0)`);
        if (!this.fast) await sleep(s.ms / steps);
      }
      cur = { x: s.x, y: s.y };
    }
    this.cursor = cur;
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cur.x, y: cur.y, button: "left", clickCount: 1 });
  }

  /* ── waiting / reading ── */

  async waitFor(expr: string, timeoutMs: number, what: string): Promise<unknown> {
    try {
      return await this.page.waitForFunction(expr, timeoutMs, 150);
    } catch {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    }
  }

  frameTextExpr(): string {
    return `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); const b = f && f.contentDocument && f.contentDocument.body; return b ? b.innerText : ""; })()`;
  }

  async waitFrameText(texts: string | string[], timeoutMs = 30_000): Promise<string> {
    const list = Array.isArray(texts) ? texts : [texts];
    const expr = `(() => { const t = ${this.frameTextExpr()}; const l = ${JSON.stringify(list)}; return l.find((x) => t.includes(x)) || false; })()`;
    return String(await this.waitFor(expr, timeoutMs, `phone text ${list.map((t) => JSON.stringify(t)).join(" or ")}`));
  }

  async frameText(): Promise<string> {
    return String(await this.page.evaluate(this.frameTextExpr()));
  }

  async frameUrl(): Promise<string> {
    return String(await this.page.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f && f.contentWindow ? f.contentWindow.location.href : ""; })()`));
  }

  /** Save a screenshot and DOM dumps for a failed beat. */
  async dumpDebug(beat: string): Promise<string[]> {
    mkdirSync(this.debugDir, { recursive: true });
    const files: string[] = [];
    const base = path.join(this.debugDir, beat);
    try {
      await this.page.screenshotToFile(`${base}-screen.png`);
      files.push(`${base}-screen.png`);
    } catch {
      /* page gone */
    }
    try {
      writeFileSync(`${base}-page.html`, String(await this.page.evaluate("document.documentElement.outerHTML")));
      files.push(`${base}-page.html`);
      const frameHtml = await this.page.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f && f.contentDocument ? f.contentDocument.documentElement.outerHTML : ""; })()`);
      if (frameHtml) {
        writeFileSync(`${base}-phone.html`, String(frameHtml));
        files.push(`${base}-phone.html`);
      }
    } catch {
      /* page gone */
    }
    if (this.page.consoleErrors.length) {
      writeFileSync(`${base}-console.txt`, this.page.consoleErrors.join("\n"));
      files.push(`${base}-console.txt`);
    }
    return files;
  }
}

/* ───────────────────────── The beats' actions ───────────────────────── */

interface Ctx {
  rec: Recorder;
  facts: VideoFacts;
  status: AppStatus;
  opts: Options;
  photos: { style: string; size: string | null };
  cards: { title: string; outro: string };
  state: FlowState;
  /** Generous waits for live renders; dev renders take ~6 s. */
  renderTimeoutMs: number;
}

/** JS finder: the first result card whose preview is ready (it has the compare slider). */
const READY_CARD = `(d) => [...d.querySelectorAll('article')].find((a) => a.querySelector('[role=slider]')) || null`;
const inReadyCard = (inner: string) =>
  `(d) => { const a = [...d.querySelectorAll('article')].find((x) => x.querySelector('[role=slider]')); return a ? ${inner} : null; }`;

async function preflightAndUse(ctx: Ctx, photo: string, beatLabel: string): Promise<void> {
  const { rec } = ctx;
  // "Upload photo": point at the button, then hand the file to its input (a real click would
  // open a native file chooser, which headless Chrome can't show).
  const btn = await rec.locate("text=Upload photo");
  await rec.moveTo(btn.cx, btn.cy);
  await rec.hold(150);
  await rec.page.evaluate(`__tbrec.press(${btn.cx}, ${btn.cy})`).catch(() => undefined);
  await rec.page.setFiles("input[type=file]", [photo], { frame: FRAME });
  const outcome = await rec.waitFrameText(["Great photo", "Almost — a quick retake", "That photo didn't work"], 90_000);
  await rec.hold(500);
  // Show the checklist.
  await rec
    .point({ js: `(d) => [...d.querySelectorAll('span,p,h2,h3')].find((e) => /checks passed|to fix before/.test(e.textContent || '') && e.children.length === 0) || null` }, { align: "center" })
    .catch(() => undefined);
  await rec.hold(1200);
  if (outcome === "Great photo") {
    await rec.click("text=Use this photo");
    return;
  }
  const text = await rec.frameText();
  if (outcome === "Almost — a quick retake" && text.includes("Continue anyway (dev)")) {
    ctx.state.overrides.push(beatLabel);
    await rec.updateCaption({ detail: "The on-device check flagged this photo; the draft continues with the dev-only override." });
    await rec.hold(1500);
    await rec.click("text=Continue anyway (dev)");
    return;
  }
  const failed = text
    .split("\n")
    .filter((l) => /Step back|Face the camera|can't see|Lower your arms|dark|bright|blurry|only person|couldn't/i.test(l))
    .slice(0, 5)
    .join(" · ");
  throw new Error(`The on-device preflight rejected ${rel(photo)}: ${failed || outcome}. Retake the photo (full body, facing the camera, even light) and try again.`);
}

const ACTIONS: Record<string, (ctx: Ctx) => Promise<void>> = {
  async intro(ctx) {
    await ctx.rec.goto(pathToFileUrl(ctx.cards.title), { hideCursor: true });
    await ctx.rec.waitForNarration(0.1);
    await ctx.rec.hold(700);
    await ctx.rec.fadeOut(450);
  },

  async split({ rec }) {
    await rec.goto("/demo?record=1");
    await rec.waitFrameText("Start a return", 30_000);
    await rec.waitFor(`document.body.innerText.includes("Refunds")`, 20_000, "the dashboard KPIs");
    await rec.hold(700);
    const phone = await rec.locate("iframe", { frame: false, scroll: false });
    await rec.moveTo(phone.cx, phone.y + phone.height * 0.4);
    await rec.waitForNarration(2.6);
    await rec.moveTo(1240, 360);
  },

  async order({ rec }) {
    await rec.click("text=#1042");
    await rec.waitFrameText("Hi Priya", 20_000);
    await rec.hold(900);
    await rec.click("text=Wrap Dress — Mustard");
    await rec.waitFrameText("Why is it going back?", 20_000);
  },

  async reason({ rec }) {
    await rec.hold(600);
    await rec.click("text=Style or colour didn't work");
    await rec.waitFrameText("See 3 swaps on you", 20_000);
  },

  async consent({ rec }) {
    await rec.hold(500);
    const label = await rec.locate({ js: `(d) => { const c = d.querySelector('input[type=checkbox]'); return c ? c.closest('label') : null; }` }, { align: "center" });
    const box = await rec.locate("input[type=checkbox]", { scroll: false });
    await rec.highlight({ x: label.x, y: label.y, width: label.width, height: label.height, radius: 20 });
    await rec.clickAt(box.cx, box.cy);
    await rec.waitFor(`(() => { const f = document.querySelector("iframe"); const c = f && f.contentDocument && f.contentDocument.querySelector("input[type=checkbox]"); return !!c && c.checked; })()`, 10_000, "the consent box to be ticked");
    await rec.hold(1200);
    await rec.highlight(null);
  },

  async photo(ctx) {
    await preflightAndUse(ctx, ctx.photos.style, "style photo");
    await ctx.rec.waitFrameText("What didn't work about it?", 60_000);
    const url = await ctx.rec.frameUrl();
    ctx.state.returnId = /\/r\/([^/?#]+)/.exec(url)?.[1] ?? null;
  },

  async form({ rec }) {
    await rec.point("text=Renders started at photo upload", { align: "center" });
    await rec.hold(1800);
    await rec.click("text=Colour isn't me");
    await rec.click("text=Too clingy");
    await rec.click("textarea");
    await rec.typeText("Love the wrap shape, just wanted a softer colour.");
    await rec.hold(300);
    // Back up to the clock: the previews kept rendering while she typed.
    await rec.point("text=Renders started at photo upload", { align: "center" });
    await rec.hold(1300);
    await rec.waitForNarration(1.2);
    await rec.click("text=Show my swaps");
    await rec.waitFrameText("Swaps that fix it", 60_000);
  },

  async results(ctx) {
    const { rec } = ctx;
    await rec.waitFor(`!!(${READY_CARD})(document.querySelector("iframe").contentDocument)`, ctx.renderTimeoutMs, "a checked preview card");
    const clock = await rec.page.evaluate<string>(`(() => { const d = document.querySelector("iframe").contentDocument; const p = [...d.querySelectorAll("p")].find((x) => /Renders started at photo upload/.test(x.textContent || "")); return p ? p.textContent.trim() : ""; })()`);
    ctx.state.clockLine = clock || null;
    let fromCache = false;
    if (ctx.state.returnId) {
      const r = await getJson<{ return: { renders: { status: string; fromCache?: boolean }[] } }>(`${rec.base}/api/returns/${ctx.state.returnId}`).catch(() => null);
      fromCache = Boolean(r?.return.renders.some((j) => j.status === "success" && j.fromCache));
    }
    const sentence = clockSentence(clock, ctx.facts, { fromCache });
    const warm = rec.narrator.clip(sentence); // render the TTS while the card is on screen
    await rec.updateCaption({ detail: clock || "Renders started at photo upload" });
    // 1) The swaps, on her photo.
    await rec.locate({ js: READY_CARD }, { align: "start", topInset: 92 });
    const card = await rec.locate({ js: READY_CARD }, { scroll: false });
    await rec.moveTo(card.x + card.width * 0.7, card.y + card.height * 0.25);
    await rec.waitForNarration(0.4);
    // 2) The honest clock, read back as it is.
    await rec.point("text=Renders started at photo upload", { align: "center", topInset: 90 });
    await warm;
    await rec.narrate(sentence);
    await rec.waitForNarration(0.3);
    // 3) Back to the card for the gate.
    await rec.locate({ js: READY_CARD }, { align: "start", topInset: 92 });
  },

  async gate({ rec }) {
    const summary = { js: inReadyCard(`[...a.querySelectorAll('summary')].find((s) => /How we checked/.test(s.textContent || '')) || null`) };
    await rec.click(summary, { align: "center", topInset: 92 });
    await rec.hold(500);
    const details = { js: inReadyCard(`a.querySelector('details')`) };
    const r = await rec.locate(details, { align: "center", topInset: 92 });
    await rec.highlight({ x: r.x, y: r.y, width: r.width, height: r.height, radius: 16 });
    await rec.moveTo(r.x + r.width * 0.8, r.y + r.height * 0.5);
    await rec.waitForNarration(0.5);
    await rec.highlight(null);
    // Back to the preview, closed again.
    await rec.click(summary, { align: "center", topInset: 92 });
    await rec.locate({ js: READY_CARD }, { align: "start", topInset: 92 });
  },

  async compare({ rec }) {
    const handle = await rec.locate({ js: inReadyCard(`a.querySelector('[role=slider]')`) }, { scroll: false });
    const box = await rec.locate({ js: inReadyCard(`a.querySelector('[role=slider]').closest('.touch-pan-y')`) }, { scroll: false });
    const y = handle.cy;
    await rec.drag({ x: handle.cx, y }, [
      { x: box.x + box.width * 0.15, y, ms: 900 },
      { x: box.x + box.width * 0.88, y, ms: 1300 },
      { x: box.x + box.width * 0.5, y, ms: 700 },
    ]);
  },

  async swap({ rec }) {
    await rec.click({ js: inReadyCard(`[...a.querySelectorAll('button')].find((b) => /Swap for this/.test(b.textContent || '')) || null`) }, { align: "center", topInset: 92 });
    await rec.waitFrameText("Confirm your swap", 20_000);
    await rec.hold(900);
    await rec.click("text=Confirm exchange");
    await rec.waitFrameText("Exchange confirmed", 20_000);
  },

  async toast({ rec }) {
    await rec.waitFor(`[...document.querySelectorAll('[role=status]')].some((e) => /Refund avoided/.test(e.textContent || ''))`, 15_000, "the 'Refund avoided' toast on the dashboard");
    const t = await rec.locate(
      { js: `(d) => [...d.querySelectorAll('[role=status]')].find((e) => /Refund avoided/.test(e.textContent || '')) || null` },
      { frame: false, scroll: false },
    );
    // Point at the toast from just below its right edge: the "+$79" the beat is about stays visible.
    await rec.moveTo(Math.min(W - 24, Math.round(t.x + t.width - 18)), Math.min(H - 24, Math.round(t.y + t.height + 26)));
    await rec.waitForNarration(0.4);
  },

  async "size-order"({ rec }) {
    await rec.click("text=Start another return");
    await rec.waitFrameText("Start a return", 20_000);
    await rec.click("text=#1043");
    await rec.waitFrameText("Hi Daniel", 20_000);
    await rec.click("text=Linen Shirt — White");
    await rec.waitFrameText("Why is it going back?", 20_000);
    await rec.click("text=Fit or size");
    await rec.click("text=Too short");
    await rec.click("text=Continue");
    await rec.waitFrameText("We'll measure the other sizes on the photo", 20_000);
  },

  async "size-photo"(ctx) {
    const { rec } = ctx;
    if (!ctx.photos.size) {
      await rec.click("text=Skip photo");
      await rec.waitFrameText("Where every other size would end", 20_000);
      return;
    }
    const box = await rec.locate("input[type=checkbox]");
    await rec.clickAt(box.cx, box.cy);
    await rec.hold(400);
    await preflightAndUse(ctx, ctx.photos.size, "size photo");
    await rec.waitFrameText("Where every other size would end", 60_000);
  },

  async "size-lines"(ctx) {
    const { rec } = ctx;
    if (ctx.photos.size) {
      await rec.locate({ js: `(d) => { const s = d.querySelector('figure svg[aria-label^="Measured hem lines"]'); return s ? s.closest('figure') : null; }` }, { align: "center" });
      // Point at the solid "what you're wearing" line, just left of its label.
      const label = await rec.locate({ js: `(d) => [...d.querySelectorAll('figure svg text')].find((t) => /What you're wearing/.test(t.textContent || '')) || null` }, { scroll: false });
      await rec.moveTo(label.x - 70, label.cy + 4);
      await rec.waitForNarration(4.2);
    }
    const note = await rec.page.evaluate<string>(`(() => { const d = document.querySelector("iframe").contentDocument; const a = [...d.querySelectorAll("aside")].find((x) => /Why not just size up/.test(x.textContent || "")); const p = a && a.querySelectorAll("p")[1]; return p ? p.textContent.trim() : ""; })()`);
    ctx.state.gradingNote = note || null;
    const aside = await rec.locate({ js: `(d) => [...d.querySelectorAll('aside')].find((x) => /Why not just size up/.test(x.textContent || '')) || null` }, { align: "center" });
    await rec.updateCaption({ title: "“Why not just size up?”", detail: note || "Sizing up adds width, not length." });
    await rec.highlight({ x: aside.x, y: aside.y, width: aside.width, height: aside.height, radius: 20 });
    await rec.moveTo(aside.x + aside.width * 0.85, aside.cy);
    await rec.hold(2200);
    await rec.highlight(null);
    const rec2 = await rec.locate({ js: `(d) => [...d.querySelectorAll('label')].find((l) => /Recommended/.test(l.textContent || '')) || null` }, { align: "center" });
    await rec.highlight({ x: rec2.x, y: rec2.y, width: rec2.width, height: rec2.height, radius: 20 });
    await rec.moveTo(rec2.x + rec2.width * 0.8, rec2.y + 30);
    await rec.waitForNarration(0.3);
    await rec.highlight(null);
  },

  async "size-swap"({ rec }) {
    await rec.click({ js: `(d) => [...d.querySelectorAll('button')].find((b) => /^Swap to /.test((b.textContent || '').trim())) || null` });
    await rec.waitFrameText("Confirm your swap", 20_000);
    await rec.hold(700);
    await rec.click("text=Confirm exchange");
    await rec.waitFrameText("Exchange confirmed", 20_000);
    await rec.waitFor(`[...document.querySelectorAll('[role=status]')].some((e) => /Refund avoided/.test(e.textContent || ''))`, 15_000, "the second 'Refund avoided' toast").catch(() => undefined);
    await rec.hold(1200);
  },

  async merchant({ rec }) {
    await rec.fadeOut(400);
    await rec.goto("/merchant");
    await rec.page.evaluate(`document.documentElement.style.zoom = "1.25"`);
    await rec.waitFor(`document.body.innerText.includes("Revenue retained")`, 20_000, "the dashboard");
    await rec.hold(1800);
    const kpi = await rec.locate("text=Revenue retained", { frame: false, scroll: false });
    await rec.moveTo(kpi.cx, kpi.cy + 30);
    await rec.hold(2500);
    await rec.locate({ js: `(d) => [...d.querySelectorAll('h2,h3')].find((h) => /Try-on API/.test(h.textContent || '')) || null` }, { frame: false, align: "start", topInset: 20, bottomInset: 200 });
    await rec.waitForNarration(4);
    await rec.locate({ js: `(d) => [...d.querySelectorAll('h2,h3')].find((h) => /Fidelity gate/.test(h.textContent || '')) || null` }, { frame: false, align: "start", topInset: 20, bottomInset: 200 }).catch(() => undefined);
    await rec.waitForNarration(0.2);
  },

  async bench({ rec }) {
    await rec.fadeOut(400);
    await rec.goto("/bench");
    await rec.page.evaluate(`document.documentElement.style.zoom = "1.25"`);
    await rec.waitFor(`document.body.innerText.includes("Transition benchmark")`, 20_000, "the bench");
    await rec.hold(1200);
    await rec.locate({ js: `(d) => d.querySelector('table') || [...d.querySelectorAll('h2')].find((h) => /No renders yet/.test(h.textContent || '')) || null` }, { frame: false, align: "start", topInset: 30, bottomInset: 220 }).catch(() => undefined);
    await rec.waitForNarration(0.2);
    await rec.hold(800);
  },

  async outro(ctx) {
    await ctx.rec.fadeOut(400);
    await ctx.rec.goto(pathToFileUrl(ctx.cards.outro), { hideCursor: true });
    await ctx.rec.waitForNarration(0);
    await ctx.rec.hold(3600);
  },
};

function pathToFileUrl(p: string): string {
  return `file://${path.resolve(p).split(path.sep).map(encodeURIComponent).join("/")}`;
}

/* ───────────────────────── Cards ───────────────────────── */

function writeCards(dir: string, facts: VideoFacts, opts: Options, introNarrationSec: number): { title: string; outro: string } {
  mkdirSync(dir, { recursive: true });
  const title = fillTemplate(readFileSync(path.join(VIDEO_SRC, "title.html"), "utf8"), titleCardVars(facts, introNarrationSec));
  const outro = fillTemplate(readFileSync(path.join(VIDEO_SRC, "outro.html"), "utf8"), outroCardVars(facts, opts));
  const titleFile = path.join(dir, "title.html");
  const outroFile = path.join(dir, "outro.html");
  writeFileSync(titleFile, title);
  writeFileSync(outroFile, outro);
  return { title: titleFile, outro: outroFile };
}

/* ───────────────────────── Output: audio, video, captions, description ───────────────────────── */

function videoTime(segments: Segment[], wall: number): number | null {
  const offs = segmentOffsets(segments);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (wall >= s.start - 1e-6 && wall <= s.end + 1e-6) return offs[i]! + (wall - s.start);
  }
  return null;
}

async function encodeVideo(tools: Tools, runsFile: { runs: { file: string; count: number }[] }, audioFile: string, outFile: string, workDir: string, duration: number): Promise<void> {
  mkdirSync(path.dirname(outFile), { recursive: true });
  if (tools.encoder === "avfoundation") {
    const manifest = path.join(workDir, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ width: W, height: H, fps: FPS, runs: runsFile.runs, audio: audioFile, output: outFile, bitrate: 12_000_000 }));
    const r = await runAsync(tools.avencode!, ["encode", manifest]);
    if (r.code !== 0) throw new Error(`AVFoundation encode failed: ${r.out.trim()}`);
    return;
  }
  const list = path.join(workDir, "frames.ffconcat");
  writeFileSync(list, ffconcatScript(runsFile.runs, FPS));
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", list,
    "-i", audioFile,
    "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-fps_mode", "cfr", "-r", String(FPS),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-t", duration.toFixed(3),
    "-movflags", "+faststart",
    outFile,
  ];
  const r = await runAsync("ffmpeg", args);
  if (r.code !== 0) throw new Error(`ffmpeg encode failed: ${r.out.trim()}`);
}

interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

async function probeVideo(tools: Tools, file: string): Promise<ProbeInfo> {
  if (tools.encoder === "avfoundation") {
    const r = await runAsync(tools.avencode!, ["probe", file]);
    if (r.code !== 0) throw new Error(`probe failed: ${r.out}`);
    return JSON.parse(r.out.trim().split("\n").at(-1)!) as ProbeInfo;
  }
  const r = await runAsync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(r.out) as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[] };
  const v = j.streams.find((s) => s.codec_type === "video");
  const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return { durationSec: Number(j.format.duration), width: v?.width ?? 0, height: v?.height ?? 0, fps: den ? num! / den : 0, hasAudio: j.streams.some((s) => s.codec_type === "audio") };
}

async function extractFrames(tools: Tools, file: string, times: number[], dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  if (tools.encoder === "avfoundation") {
    const r = await runAsync(tools.avencode!, ["frames", file, dir, ...times.map((t) => t.toFixed(2))]);
    if (r.code !== 0) throw new Error(`frame extraction failed: ${r.out}`);
    return JSON.parse(r.out.trim().split("\n").at(-1)!) as string[];
  }
  const out: string[] = [];
  for (const t of times) {
    const f = path.join(dir, `f-${t.toFixed(2)}.png`);
    const r = await runAsync("ffmpeg", ["-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", f]);
    if (r.code !== 0) throw new Error(`ffmpeg frame at ${t}s failed: ${r.out}`);
    out.push(f);
  }
  return out;
}

function youtubeDescription(facts: VideoFacts, chapters: { title: string; start: number }[], opts: Options, durationSec: number, srtPath: string): string {
  const lines = [
    "# YouTube upload",
    "",
    "## Title",
    "",
    "TryBack: virtual try-on on the returns page | HackTheFashion Global'26 (Try-On Commerce)",
    "",
    "## Description",
    "",
    "Every virtual try-on today lives on the product page. TryBack moves it to the returns page. A shopper returning an item because the style or colour didn't work takes one photo wearing it, and in-stock swaps are rendered on that photo with the Clothsy AI try-on API by FabricVTON while they fill in the return form. A fidelity gate checks every preview on the device before it's shown, size returns use the returned garment as a ruler at zero credits, and the merchant dashboard shows refunds turned into exchanges.",
    "",
  ];
  if (facts.simulated || facts.standIn) {
    const bits = [
      facts.simulated ? (facts.replay ? "renders not in the cache are simulated by a labelled dev double" : "the try-on renders are simulated by a labelled dev double (0 credits)") : null,
      facts.standIn ? "the shopper photos are an illustrated stand-in, not a real person" : null,
      facts.aiPeople ? "the shoppers shown are AI-generated people, not real customers" : null,
    ].filter(Boolean);
    lines.push(`This cut is a draft: ${bits.join(", and ")}. Everything else is the running app.`, "");
  } else if (facts.replay) {
    lines.push("The try-on renders in this cut were produced by the Clothsy AI API and replayed from TryBack's render cache, so the timings shown are not live render speed.", "");
  }
  if (facts.aiPeople && !facts.simulated) lines.push("The shoppers shown are AI-generated people, not real customers.", "");
  lines.push(
    "Fernweave is a fictional brand created for this demo; its products, customers and orders are made up.",
    "",
  );
  if (chapters.length) {
    lines.push("Chapters", ...chapters.map((c) => `${chapterTime(c.start)} ${c.title}`), "");
  }
  lines.push(
    "Built with: Clothsy AI try-on API (FabricVTON) · MediaPipe · Claude by Anthropic (text-only diagnosis" + (facts.llm ? ")" : "; this take used the rules fallback)") + " · Next.js · React · TypeScript · sharp",
    "",
    `Code: ${opts.repoUrl}`,
    `Live demo: ${opts.demoUrl}`,
    "Devpost: [Devpost URL]",
    "",
    "#HackTheFashion #VirtualTryOn #FashionTech",
    "",
    "## Notes for the uploader",
    "",
    `- Length: ${chapterTime(durationSec)}. Captions file: ${srtPath} (upload under Subtitles).`,
    "- Replace the [bracketed] placeholders before publishing.",
  );
  return lines.join("\n") + "\n";
}

async function contactSheet(files: { file: string; label: string }[], out: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  const cols = 4;
  const tw = 480;
  const th = 270;
  const pad = 36;
  const rows = Math.ceil(files.length / cols);
  const composites = [];
  for (let i = 0; i < files.length; i++) {
    const { file, label } = files[i]!;
    const x = (i % cols) * tw;
    const y = Math.floor(i / cols) * (th + pad);
    composites.push({ input: await sharp(file).resize(tw, th).toBuffer(), left: x, top: y + pad });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${pad}"><text x="8" y="25" font-family="Helvetica" font-size="20" fill="#111">${label.replace(/[<&>]/g, "")}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: x, top: y });
  }
  await sharp({ create: { width: cols * tw, height: rows * (th + pad), channels: 3, background: "#ffffff" } })
    .composite(composites)
    .jpeg({ quality: 85 })
    .toFile(out);
}

/* ───────────────────────── main ───────────────────────── */

async function main(): Promise<number> {
  const opts = parseOptions(process.argv.slice(2));
  const outDir = path.join(ROOT, "out", "video");
  const logsDir = path.join(outDir, "logs");
  const debugDir = path.join(outDir, "debug");
  mkdirSync(logsDir, { recursive: true });
  rmSync(debugDir, { recursive: true, force: true });

  const tools = detectTools(opts, outDir);
  console.log(`Encoder: ${tools.encoder} · narration: ${tools.voice ?? "off (captions only)"}`);

  // Shopper photos: the user's own, or illustrated stand-ins (never a real person).
  let standIns: Record<"dress" | "shirt", string> | null = null;
  if (!opts.photo) standIns = await writeStandIns(path.join(outDir, "stand-ins"));
  const photos = {
    style: opts.photo ?? standIns!.dress,
    size: opts.sizePhoto ?? (opts.photo ? null : standIns!.shirt),
  };
  if (opts.photo && !opts.sizePhoto) console.log("Note: no --size-photo, so the size beat uses \"Skip photo\" (table view). Pass --size-photo to show hem lines.");

  let server: Server | null = null;
  let browser: Browser | null = null;
  const cleanup = async () => {
    await browser?.close().catch(() => undefined);
    browser = null;
    await server?.stop().catch(() => undefined);
    server = null;
  };
  process.once("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });

  const framesDir = path.join(outDir, `.frames-${Date.now().toString(36)}`);
  let rec: Recorder | null = null;
  let status: AppStatus;
  let facts: VideoFacts;
  let plan: { def: BeatDef; filmed: boolean }[];
  try {
    if (opts.base) {
      server = { base: opts.base, adminToken: process.env.ADMIN_TOKEN?.trim() || null, stop: async () => undefined };
      if (opts.reset) await resetReturns(server);
    } else {
      server = await startOwnServer(opts, outDir, logsDir);
      if (opts.mode !== "dev") await resetReturns(server); // keeps the render cache, so replays stay free
    }
    status = await getJson<AppStatus>(`${server.base}/api/status`);
    facts = {
      simulated: status.activeProvider === "dev",
      replay: status.mode === "replay",
      standIn: !opts.photo,
      aiPeople: Boolean(opts.photo) && opts.aiPeople,
      sizePhoto: photos.size !== null,
      llm: status.hasAnthropicKey,
    };
    console.log(`App status: mode ${status.mode}, provider ${status.activeProvider} → ${renderProvenance(facts)}`);
    if (opts.mode !== "dev" && status.activeProvider === "dev" && !facts.replay) {
      console.log("Note: no live provider (no CLOTHSY_API_KEY in .env.local?), so renders will be simulated and labelled as such.");
    }

    const beats = beatsFor(facts);
    const lastSelected = opts.only ? Math.max(...opts.only.map((id) => beats.findIndex((b) => b.id === id))) : beats.length - 1;
    plan = beats
      .slice(0, lastSelected + 1)
      .map((def) => ({ def, filmed: !opts.only || opts.only.includes(def.id) }))
      .filter((p) => p.filmed || !p.def.presentational);

    const narrator = new Narrator(tools.voice, opts.rate, path.join(outDir, ".voice"));
    // Pre-render the static narration so filming isn't paced by the TTS.
    for (const p of plan) if (p.filmed && p.def.narration) await narrator.clip(p.def.narration);
    const introSec = (await narrator.clip(beats[0]!.narration)).dur;
    const cards = writeCards(path.join(outDir, "cards"), facts, opts, introSec);

    browser = await launchChrome({ width: W, height: H, deviceScaleFactor: 1, headless: !opts.headful });
    const page = await browser.newPage();
    rec = new Recorder(page, server.base, framesDir, narrator, debugDir);
    await rec.start(readFileSync(path.join(VIDEO_SRC, "overlay.js"), "utf8"));
    {
      const renderBadge = facts.replay ? "Replay · cached Clothsy renders" : facts.simulated ? "Draft · simulated try-on renders" : null;
      const badge = [renderBadge, facts.aiPeople ? "AI-generated shoppers" : null].filter(Boolean).join(" · ");
      if (badge) await rec.setBadge(badge, facts.simulated && !facts.replay ? "warn" : "info");
    }

    const ctx: Ctx = {
      rec,
      facts,
      status,
      opts,
      photos,
      cards,
      state: { returnId: null, clockLine: null, gradingNote: null, overrides: [] },
      renderTimeoutMs: facts.simulated ? 60_000 : 200_000,
    };
    for (const { def, filmed } of plan) {
      const t0 = Date.now();
      process.stdout.write(`${filmed ? "●" : "○"} ${def.id.padEnd(11)}`);
      try {
        await rec.beginBeat(def, filmed);
        await ACTIONS[def.id]!(ctx);
        await rec.endBeat();
      } catch (err) {
        process.stdout.write("\n");
        const files = await rec.dumpDebug(def.id);
        throw Object.assign(new BeatFailure(def.id, err), { debugFiles: files });
      }
      console.log(` ${((Date.now() - t0) / 1000).toFixed(1)} s${filmed ? "" : " (fast-forward)"}`);
    }
    await rec.stopCapture();
    if (ctx.state.overrides.length) console.log(`Note: the preflight flagged the ${ctx.state.overrides.join(" and ")}; the take used the dev override (caption says so).`);
  } catch (err) {
    await cleanup();
    if (err instanceof BeatFailure) {
      console.error(`\n✗ ${err.message}`);
      const files = (err as BeatFailure & { debugFiles?: string[] }).debugFiles ?? [];
      if (files.length) console.error(`  Debug: ${files.map(rel).join(", ")}`);
      if (!opts.keepFrames) rmSync(framesDir, { recursive: true, force: true });
      return 1;
    }
    throw err;
  }
  await cleanup();

  // ── Assemble ──
  const segments = rec.segments;
  const duration = totalDuration(segments);
  const runs = buildFrameRuns(rec.frames, segments, FPS);
  if (!runs.length) throw new Error("No frames were captured.");

  // Narration track (silence when there's no voice), placed by each clip's video time.
  const placed = rec.clips
    .map((c) => ({ c, at: videoTime(segments, c.start) }))
    .filter((x): x is { c: Clip; at: number } => x.at !== null);
  const audio = mixClips(placed.filter((x) => x.c.pcm).map((x) => ({ start: x.at, pcm: x.c.pcm! })), duration, AUDIO_RATE);
  // Sidecars sit next to the video: the default take uses plain names (captions.srt, qa/…);
  // any other --out / --only take prefixes them with the video's name so it never clobbers them.
  const defaultTake = path.resolve(opts.out) === path.join(outDir, "tryback-demo.mp4");
  const stem = path.basename(opts.out, path.extname(opts.out));
  const sidecar = (name: string) => path.join(path.dirname(opts.out), defaultTake ? name : `${stem}.${name}`);
  const audioFile = sidecar("narration.wav");
  writeFileSync(audioFile, writeWav(audio));

  console.log(`Encoding ${duration.toFixed(1)} s at ${FPS} fps (${runs.length} distinct frames)…`);
  await encodeVideo(tools, { runs }, audioFile, opts.out, framesDir, duration);
  // AVFoundation's faststart pass can leave its pre-optimisation copy (<name>.sb-…) behind
  // when it isn't allowed to delete it (e.g. under a sandbox).
  for (const f of readdirSync(path.dirname(opts.out))) {
    if (f.startsWith(`${path.basename(opts.out)}.sb-`)) rmSync(path.join(path.dirname(opts.out), f), { force: true });
  }
  const info = await probeVideo(tools, opts.out);

  // Captions: narration sentences; captions-only takes fall back to the on-screen captions.
  const offs = segmentOffsets(segments);
  const cues: Cue[] = [];
  if (tools.voice) {
    for (const { c, at } of placed) cues.push(...cuesForClip(c.text, at, c.dur));
  } else {
    segments.forEach((s, i) => {
      const b = rec!.beatLog.find((x) => x.id === s.id && x.filmed);
      const text = b?.narration || [b?.caption?.title, b?.caption?.detail].filter(Boolean).join(" — ");
      if (text) cues.push(...cuesForClip(text, offs[i]!, s.end - s.start));
    });
  }
  const srtFile = sidecar("captions.srt");
  writeFileSync(srtFile, toSrt(cues));

  const chapters = buildChapters(
    segments.map((s, i) => ({ title: rec!.beatLog.find((b) => b.id === s.id)!.chapter, start: offs[i]! })),
    duration,
  );
  const descFile = sidecar("youtube-description.md");
  writeFileSync(descFile, youtubeDescription(facts, chapters, opts, duration, rel(srtFile)));
  writeFileSync(
    sidecar("beats.json"),
    JSON.stringify(
      {
        video: rel(opts.out),
        durationSec: +duration.toFixed(2),
        facts,
        voice: tools.voice,
        encoder: tools.encoder,
        beats: segments.map((s, i) => {
          const b = rec!.beatLog.find((x) => x.id === s.id)!;
          return { id: s.id, chapter: b.chapter, start: +offs[i]!.toFixed(2), duration: +(s.end - s.start).toFixed(2), caption: b.caption, narration: b.narration };
        }),
      },
      null,
      2,
    ),
  );

  // QA: one frame per beat at its midpoint, plus a contact sheet.
  const qaDir = defaultTake ? path.join(outDir, "qa") : path.join(path.dirname(opts.out), `${stem}-qa`);
  rmSync(qaDir, { recursive: true, force: true });
  const mids = segments.map((s, i) => Math.min(info.durationSec - 0.05, offs[i]! + (s.end - s.start) / 2));
  const shots = await extractFrames(tools, opts.out, mids, qaDir);
  const named: { file: string; label: string }[] = [];
  const { renameSync } = await import("node:fs");
  shots.forEach((f, i) => {
    const to = path.join(qaDir, `${String(i + 1).padStart(2, "0")}-${segments[i]!.id}.png`);
    renameSync(f, to);
    named.push({ file: to, label: `${i + 1}. ${segments[i]!.id} @ ${chapterTime(mids[i]!)}` });
  });
  await contactSheet(named, path.join(qaDir, "contact-sheet.jpg"));
  if (!opts.keepFrames) rmSync(framesDir, { recursive: true, force: true });

  const size = statSync(opts.out).size;
  console.log(`\n✓ ${rel(opts.out)} · ${chapterTime(info.durationSec)} (${info.durationSec.toFixed(1)} s) · ${info.width}×${info.height} @ ${Math.round(info.fps)} fps · ${(size / 1e6).toFixed(1)} MB · audio ${info.hasAudio ? "yes" : "no"}`);
  console.log(`  ${renderProvenance(facts)}${facts.standIn ? " · illustrated stand-in photos" : facts.aiPeople ? " · AI-generated shoppers" : ""}`);
  console.log(`  Captions: ${rel(srtFile)} · description: ${rel(descFile)} · QA frames: ${rel(qaDir)}`);
  if (!opts.only && (info.durationSec < 120 || info.durationSec > 180)) console.log(`  ! Duration is outside the 2:00–3:00 target.`);
  for (const n of tools.notes) console.log(`  Note: ${n}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`\n✗ record: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
