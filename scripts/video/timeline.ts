// Pure helpers for scripts/record-demo.ts: frame timeline → constant-fps runs, WAV
// parse/mix/write, SRT captions, YouTube chapters, macOS voice choice, card templates.
// No I/O and no browser here, so all of it is unit-tested (tests/video.test.ts).

/* ───────────────────────── Frame timeline ───────────────────────── */

/** A captured screencast frame: file + capture time (seconds, wall clock). */
export interface CapturedFrame {
  file: string;
  t: number;
}

/** A recorded stretch of wall-clock time that becomes part of the video, in order. */
export interface Segment {
  id: string;
  /** Wall-clock start/end (seconds). */
  start: number;
  end: number;
}

/** One image held for `count` consecutive output frames. */
export interface FrameRun {
  file: string;
  count: number;
}

/** Map a video time (seconds from the start of the edit) to wall-clock time. */
export function videoToWall(segments: readonly Segment[], tau: number): number {
  let offset = 0;
  for (const s of segments) {
    const len = Math.max(0, s.end - s.start);
    if (tau < offset + len || s === segments[segments.length - 1]) return s.start + Math.min(len, Math.max(0, tau - offset));
    offset += len;
  }
  return segments.length ? segments[0]!.start : 0;
}

/** Video-time offset of each segment's start. */
export function segmentOffsets(segments: readonly Segment[]): number[] {
  const out: number[] = [];
  let offset = 0;
  for (const s of segments) {
    out.push(offset);
    offset += Math.max(0, s.end - s.start);
  }
  return out;
}

export function totalDuration(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

/**
 * Resample irregular screencast frames (sent only when something repaints) to a constant
 * frame rate: output frame k shows the newest captured frame at or before its wall time.
 * Consecutive repeats are collapsed into runs.
 */
export function buildFrameRuns(frames: readonly CapturedFrame[], segments: readonly Segment[], fps: number): FrameRun[] {
  if (!frames.length || !segments.length) return [];
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const total = totalDuration(segments);
  const n = Math.max(1, Math.round(total * fps));
  const runs: FrameRun[] = [];
  let j = 0;
  let lastWall = -Infinity;
  for (let k = 0; k < n; k++) {
    const wall = videoToWall(segments, k / fps);
    // Segments are in wall-clock order, but restart the scan if a later segment jumps back.
    if (wall < lastWall) j = 0;
    lastWall = wall;
    while (j + 1 < sorted.length && sorted[j + 1]!.t <= wall + 1e-6) j++;
    const file = sorted[j]!.file;
    const prev = runs[runs.length - 1];
    if (prev && prev.file === file) prev.count++;
    else runs.push({ file, count: 1 });
  }
  return runs;
}

/** ffmpeg concat-demuxer script for frame runs (the last entry is repeated, as the demuxer requires). */
export function ffconcatScript(runs: readonly FrameRun[], fps: number): string {
  const q = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;
  const lines = ["ffconcat version 1.0"];
  for (const r of runs) {
    lines.push(`file ${q(r.file)}`);
    lines.push(`duration ${(r.count / fps).toFixed(6)}`);
  }
  if (runs.length) lines.push(`file ${q(runs[runs.length - 1]!.file)}`);
  return lines.join("\n") + "\n";
}

/* ───────────────────────── WAV (PCM16) ───────────────────────── */

export interface Pcm {
  sampleRate: number;
  /** Mono samples in [-1, 1]. Multi-channel input is averaged to mono. */
  samples: Float32Array;
}

/** Parse a little-endian PCM16 WAV (walks chunks, so `say`'s FLLR padding chunk is fine). */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    if (id === "fmt ") {
      fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === "data") {
      data = body;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV is missing its fmt or data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`Unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit); expected PCM16`);
  const ch = Math.max(1, fmt.channels);
  const frames = Math.floor(data.length / (2 * ch));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2);
    samples[i] = s / ch / 32768;
  }
  return { sampleRate: fmt.sampleRate, samples };
}

/** Encode mono samples as a PCM16 WAV. */
export function writeWav(pcm: Pcm): Buffer {
  const n = pcm.samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(pcm.sampleRate, 24);
  buf.writeUInt32LE(pcm.sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm.samples[i]!));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return buf;
}

export function wavDurationSec(pcm: Pcm): number {
  return pcm.samples.length / pcm.sampleRate;
}

/** Linear resample (narration only, so linear is plenty). */
export function resample(pcm: Pcm, rate: number): Pcm {
  if (pcm.sampleRate === rate) return pcm;
  const ratio = pcm.sampleRate / rate;
  const n = Math.floor(pcm.samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(pcm.samples.length - 1, i0 + 1);
    const f = x - i0;
    out[i] = pcm.samples[i0]! * (1 - f) + pcm.samples[i1]! * f;
  }
  return { sampleRate: rate, samples: out };
}

/**
 * Place clips on a silent track of `durationSec` at their start times (seconds), summing
 * overlaps and soft-limiting peaks. Clips that run past the end are cut.
 */
export function mixClips(clips: readonly { start: number; pcm: Pcm; gain?: number }[], durationSec: number, rate = 44100): Pcm {
  const out = new Float32Array(Math.max(1, Math.round(durationSec * rate)));
  for (const c of clips) {
    const pcm = resample(c.pcm, rate);
    const g = c.gain ?? 1;
    const at = Math.round(Math.max(0, c.start) * rate);
    // 8 ms fades so clip edges never click.
    const fade = Math.min(Math.round(0.008 * rate), Math.floor(pcm.samples.length / 2));
    for (let i = 0; i < pcm.samples.length && at + i < out.length; i++) {
      let s = pcm.samples[i]! * g;
      if (i < fade) s *= i / fade;
      else if (i >= pcm.samples.length - fade) s *= (pcm.samples.length - 1 - i) / fade;
      out[at + i]! += s;
    }
  }
  for (let i = 0; i < out.length; i++) {
    const v = out[i]!;
    if (v > 0.98 || v < -0.98) out[i] = Math.tanh(v);
  }
  return { sampleRate: rate, samples: out };
}

/* ───────────────────────── Captions (SRT) ───────────────────────── */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+(?:[.!?]+["”’)]*|$)/g);
  return (parts ?? []).map((s) => s.trim()).filter(Boolean);
}

/** Split one narration clip into sentence cues, timed in proportion to their length. */
export function cuesForClip(text: string, start: number, duration: number): Cue[] {
  const sentences = splitSentences(text);
  const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
  const cues: Cue[] = [];
  let t = start;
  for (const s of sentences) {
    const d = (duration * s.length) / total;
    cues.push({ start: t, end: t + d, text: s });
    t += d;
  }
  return cues;
}

/** Wrap a cue to at most two lines of ~`width` characters (YouTube-friendly). */
export function wrapCue(text: string, width = 42): string {
  if (text.length <= width) return text;
  const words = text.split(" ");
  let best = text;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const score = Math.abs(a.length - b.length) + (Math.max(a.length, b.length) > width ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

export function toSrt(cues: readonly Cue[]): string {
  return cues
    .filter((c) => c.end > c.start && c.text.trim())
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${wrapCue(c.text.trim())}\n`)
    .join("\n");
}

/* ───────────────────────── Chapters ───────────────────────── */

export function chapterTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * YouTube chapters from (title, start) pairs: first at 0:00, each at least `minLen` seconds
 * (shorter ones merge into the previous chapter), and at least three or none at all.
 */
export function buildChapters(marks: readonly { title: string; start: number }[], totalSec: number, minLen = 10): { title: string; start: number }[] {
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  const out: { title: string; start: number }[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && last.title === m.title) continue;
    out.push({ title: m.title, start: out.length === 0 ? 0 : m.start });
  }
  // Merge chapters that are too short into their predecessor (or successor for the first).
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const end = i + 1 < out.length ? out[i + 1]!.start : totalSec;
      if (end - out[i]!.start < minLen) {
        if (i === 0) out.splice(1, 1);
        else out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (out.length) out[0]!.start = 0;
  return out.length >= 3 ? out : [];
}

/* ───────────────────────── Voice ───────────────────────── */

export interface VoiceInfo {
  name: string;
  locale: string;
}

/** Parse `say -v '?'` output ("Name (Variant)   en_US    # sample"). */
export function parseSayVoices(out: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line);
    if (m) voices.push({ name: m[1]!.trim(), locale: m[2]! });
  }
  return voices;
}

const NATURAL_VOICES = ["Ava", "Zoe", "Allison", "Evan", "Nathan", "Samantha", "Serena", "Daniel", "Karen", "Moira", "Tessa"];

/** Prefer an installed Premium/Enhanced English voice, then known natural ones, else Samantha. */
export function pickVoice(voices: readonly VoiceInfo[]): string {
  const english = voices.filter((v) => v.locale.startsWith("en_"));
  const rank = (v: VoiceInfo) => (v.locale === "en_US" ? 0 : v.locale === "en_GB" ? 1 : 2);
  const premium = english.filter((v) => /\((Premium|Enhanced)\)/i.test(v.name)).sort((a, b) => rank(a) - rank(b));
  if (premium.length) return premium[0]!.name;
  for (const base of NATURAL_VOICES) {
    const hit = english.find((v) => v.name === base || v.name.startsWith(`${base} (`));
    if (hit) return hit.name;
  }
  return english[0]?.name ?? "Samantha";
}

/** Rough narration length when no TTS is available (≈2.6 words/s plus a breath). */
export function estimateSpeechSec(text: string, wordsPerSec = 2.6): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words === 0 ? 0 : words / wordsPerSec + 0.4;
}

/* ───────────────────────── Templates ───────────────────────── */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Fill {{KEY}} placeholders. Values are HTML-escaped unless the key ends in _HTML. Unknown keys throw. */
export function fillTemplate(html: string, vars: Record<string, string>): string {
  return html.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`Template placeholder {{${key}}} has no value`);
    const v = vars[key]!;
    return key.endsWith("_HTML") ? v : escapeHtml(v);
  });
}
