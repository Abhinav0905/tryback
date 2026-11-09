import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSku } from "@/lib/catalog";
import {
  BEAT_IDS,
  beatsFor,
  clockSentence,
  outroCardVars,
  renderProvenance,
  titleCardVars,
  type VideoFacts,
} from "../scripts/video/beats";
import { recordConsentProblem } from "../scripts/video/consent";
import { BODY, STAND_IN_LABEL, STAND_IN_SIZE, STAND_IN_SPECS, standInHemPx, standInSvg } from "../scripts/video/mannequin";
import {
  buildChapters,
  buildFrameRuns,
  chapterTime,
  cuesForClip,
  escapeHtml,
  estimateSpeechSec,
  ffconcatScript,
  fillTemplate,
  mixClips,
  parseSayVoices,
  parseWav,
  pickVoice,
  resample,
  segmentOffsets,
  splitSentences,
  srtTime,
  toSrt,
  totalDuration,
  videoToWall,
  wavDurationSec,
  wrapCue,
  writeWav,
  type CapturedFrame,
  type Segment,
} from "../scripts/video/timeline";

const DRAFT: VideoFacts = { simulated: true, replay: false, standIn: true, sizePhoto: true, llm: false };
const LIVE: VideoFacts = { simulated: false, replay: false, standIn: false, sizePhoto: true, llm: true };
const REPLAY: VideoFacts = { simulated: true, replay: true, standIn: false, sizePhoto: false, llm: false };

describe("frame timeline", () => {
  const seg = (id: string, start: number, end: number): Segment => ({ id, start, end });

  it("maps video time to wall time across segments", () => {
    const segs = [seg("a", 100, 102), seg("b", 110, 111)];
    expect(totalDuration(segs)).toBe(3);
    expect(segmentOffsets(segs)).toEqual([0, 2]);
    expect(videoToWall(segs, 0)).toBe(100);
    expect(videoToWall(segs, 1.5)).toBe(101.5);
    expect(videoToWall(segs, 2.5)).toBe(110.5);
    expect(videoToWall(segs, 99)).toBe(111); // clamps to the end
  });

  it("resamples irregular frames to a constant rate, newest frame at or before each tick", () => {
    const frames: CapturedFrame[] = [
      { file: "a.jpg", t: 99.9 }, // before the segment: shown until the next frame
      { file: "b.jpg", t: 100.5 },
      { file: "c.jpg", t: 101.0 },
    ];
    const runs = buildFrameRuns(frames, [seg("x", 100, 102)], 10);
    expect(runs.reduce((n, r) => n + r.count, 0)).toBe(20);
    expect(runs).toEqual([
      { file: "a.jpg", count: 5 },
      { file: "b.jpg", count: 5 },
      { file: "c.jpg", count: 10 },
    ]);
  });

  it("skips wall time that falls between filmed segments", () => {
    const frames: CapturedFrame[] = [
      { file: "a.jpg", t: 100 },
      { file: "gap.jpg", t: 105 },
      { file: "b.jpg", t: 110 },
    ];
    const runs = buildFrameRuns(frames, [seg("x", 100, 101), seg("y", 110, 111)], 4);
    expect(runs).toEqual([
      { file: "a.jpg", count: 4 },
      { file: "b.jpg", count: 4 },
    ]);
  });

  it("uses the first frame when the segment starts before any capture, and handles empty input", () => {
    expect(buildFrameRuns([{ file: "late.jpg", t: 50 }], [seg("x", 40, 41)], 2)).toEqual([{ file: "late.jpg", count: 2 }]);
    expect(buildFrameRuns([], [seg("x", 0, 1)], 30)).toEqual([]);
  });

  it("writes an ffconcat script with durations and the last file repeated", () => {
    const s = ffconcatScript([{ file: "/x/a b.jpg", count: 3 }, { file: "/x/it's.jpg", count: 30 }], 30);
    expect(s.split("\n")).toEqual([
      "ffconcat version 1.0",
      "file '/x/a b.jpg'",
      "duration 0.100000",
      "file '/x/it'\\''s.jpg'",
      "duration 1.000000",
      "file '/x/it'\\''s.jpg'",
      "",
    ]);
  });
});

describe("WAV and mixing", () => {
  function pcm16Wav(samples: number[], rate: number, channels = 1, extraChunk = false): Buffer {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0);
    fmt.writeUInt16LE(channels, 2);
    fmt.writeUInt32LE(rate, 4);
    fmt.writeUInt32LE(rate * 2 * channels, 8);
    fmt.writeUInt16LE(2 * channels, 12);
    fmt.writeUInt16LE(16, 14);
    const chunk = (id: string, body: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(id, 0, "ascii");
      h.writeUInt32LE(body.length, 4);
      return Buffer.concat([h, body]);
    };
    const parts = [chunk("fmt ", fmt), ...(extraChunk ? [chunk("FLLR", Buffer.alloc(13))] : []), chunk("data", data)];
    const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...parts.map((p) => (p.length % 2 ? Buffer.concat([p, Buffer.alloc(1)]) : p))]);
    const riff = Buffer.alloc(8);
    riff.write("RIFF", 0, "ascii");
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
  }

  it("parses PCM16 WAV, skipping padding chunks like the one `say` writes", () => {
    const pcm = parseWav(pcm16Wav([0, 16384, -16384, 32767], 8000, 1, true));
    expect(pcm.sampleRate).toBe(8000);
    expect(Array.from(pcm.samples)).toEqual([0, 0.5, -0.5, 32767 / 32768]);
    expect(wavDurationSec(pcm)).toBeCloseTo(4 / 8000);
  });

  it("averages stereo to mono and rejects non-WAV input", () => {
    const pcm = parseWav(pcm16Wav([16384, 0, -16384, -16384], 8000, 2));
    expect(Array.from(pcm.samples)).toEqual([0.25, -0.5]);
    expect(() => parseWav(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
  });

  it("round-trips through writeWav", () => {
    const src = { sampleRate: 22050, samples: Float32Array.from([0, 0.25, -0.25, 0.999, -1]) };
    const back = parseWav(writeWav(src));
    expect(back.sampleRate).toBe(22050);
    back.samples.forEach((v, i) => expect(v).toBeCloseTo(src.samples[i]!, 3));
  });

  it("resamples by the rate ratio", () => {
    const r = resample({ sampleRate: 22050, samples: new Float32Array(22050).fill(0.5) }, 44100);
    expect(r.sampleRate).toBe(44100);
    expect(r.samples.length).toBe(44100);
    expect(r.samples[1000]).toBeCloseTo(0.5);
  });

  it("places clips at their start times on a track of the requested length", () => {
    const tone = { sampleRate: 1000, samples: new Float32Array(1000).fill(0.4) };
    const mix = mixClips([{ start: 1, pcm: tone }, { start: 1.5, pcm: tone }], 3, 1000);
    expect(mix.samples.length).toBe(3000);
    expect(mix.samples[500]).toBe(0); // silence before the first clip
    expect(mix.samples[1200]).toBeCloseTo(0.4); // first clip only
    expect(mix.samples[1700]).toBeCloseTo(0.8); // overlap sums
    expect(mix.samples[2900]).toBe(0); // both ended
    // Peaks are soft-limited, never past full scale.
    const loud = mixClips([{ start: 0, pcm: tone, gain: 3 }], 1, 1000);
    expect(Math.max(...loud.samples)).toBeLessThanOrEqual(1);
  });
});

describe("captions", () => {
  it("formats SRT timestamps", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(61.2345)).toBe("00:01:01,235");
    expect(srtTime(3723.5)).toBe("01:02:03,500");
  });

  it("splits narration into sentences and times them proportionally", () => {
    expect(splitSentences("One tap.  Two taps! Really? Yes")).toEqual(["One tap.", "Two taps!", "Really?", "Yes"]);
    const cues = cuesForClip("Short one. A much longer second sentence here.", 10, 6);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBe(10);
    expect(cues[1]!.end).toBeCloseTo(16);
    expect(cues[0]!.end).toBe(cues[1]!.start);
    expect(cues[1]!.end - cues[1]!.start).toBeGreaterThan(cues[0]!.end - cues[0]!.start);
  });

  it("wraps long cues onto two balanced lines and numbers the SRT", () => {
    expect(wrapCue("Short")).toBe("Short");
    const wrapped = wrapCue("TryBack moves it to the returns page, while the shopper is still wearing the item.");
    expect(wrapped.split("\n")).toHaveLength(2);
    const srt = toSrt([
      { start: 0, end: 1.5, text: "Hello." },
      { start: 1.5, end: 1.5, text: "dropped (zero length)" },
      { start: 2, end: 3, text: "World." },
    ]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,500\nHello.\n\n2\n00:00:02,000 --> 00:00:03,000\nWorld.\n");
  });
});

describe("chapters", () => {
  it("formats chapter times", () => {
    expect(chapterTime(0)).toBe("0:00");
    expect(chapterTime(75.9)).toBe("1:15");
    expect(chapterTime(3661)).toBe("1:01:01");
  });

  it("starts at 0:00, merges consecutive beats and chapters shorter than 10 s", () => {
    const ch = buildChapters(
      [
        { title: "Intro", start: 0.3 },
        { title: "Style", start: 15 },
        { title: "Style", start: 20 },
        { title: "Blink", start: 40 },
        { title: "Size", start: 44 },
        { title: "Close", start: 80 },
      ],
      100,
    );
    expect(ch).toEqual([
      { title: "Intro", start: 0 },
      { title: "Style", start: 15 },
      { title: "Size", start: 44 },
      { title: "Close", start: 80 },
    ]);
  });

  it("returns no chapters when fewer than three survive (YouTube ignores them)", () => {
    expect(buildChapters([{ title: "A", start: 0 }, { title: "B", start: 30 }], 60)).toEqual([]);
  });
});

describe("voice", () => {
  const SAY = [
    "Albert              en_US    # Hello! My name is Albert.",
    "Daniel              en_GB    # Hello! My name is Daniel.",
    "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
    "Samantha            en_US    # Hello! My name is Samantha.",
    "Amélie              fr_CA    # Bonjour, je m’appelle Amélie.",
  ].join("\n");

  it("parses `say -v ?` and falls back to Samantha among the stock voices", () => {
    const voices = parseSayVoices(SAY);
    expect(voices).toContainEqual({ name: "Eddy (English (UK))", locale: "en_GB" });
    expect(pickVoice(voices)).toBe("Samantha");
  });

  it("prefers an installed Premium/Enhanced English voice, US first", () => {
    const voices = parseSayVoices(`${SAY}\nSerena (Premium)    en_GB    # Hello\nAva (Enhanced)      en_US    # Hello`);
    expect(pickVoice(voices)).toBe("Ava (Enhanced)");
    expect(pickVoice([])).toBe("Samantha");
  });

  it("estimates speech time from word count", () => {
    expect(estimateSpeechSec("")).toBe(0);
    expect(estimateSpeechSec("one two three four five six seven eight nine ten eleven twelve thirteen")).toBeCloseTo(5.4, 1);
  });
});

describe("templates and cards", () => {
  it("escapes values unless the key ends in _HTML, and refuses unknown placeholders", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(fillTemplate("{{A}} {{B_HTML}}", { A: "<b>", B_HTML: "<i>ok</i>" })).toBe("&lt;b&gt; <i>ok</i>");
    expect(() => fillTemplate("{{MISSING}}", {})).toThrow(/MISSING/);
  });

  const read = (f: string) => readFileSync(path.join(__dirname, "..", "scripts", "video", f), "utf8");

  it("fills every placeholder on the title and outro cards", () => {
    for (const facts of [DRAFT, LIVE, REPLAY]) {
      const title = fillTemplate(read("title.html"), titleCardVars(facts, 14));
      const outro = fillTemplate(read("outro.html"), outroCardVars(facts, { repoUrl: "https://x/repo", demoUrl: "https://x/demo" }));
      expect(title).not.toMatch(/\{\{/);
      expect(outro).not.toMatch(/\{\{/);
      expect(title).toContain("Fernweave is a fictional brand.");
      expect(outro).toContain("https://x/repo");
    }
  });

  it("labels drafts as simulated and live takes as Clothsy renders", () => {
    expect(titleCardVars(DRAFT, 10).MODE_LABEL).toMatch(/Draft · simulated/);
    expect(titleCardVars(DRAFT, 10).FOOT_NOTE).toMatch(/illustrated stand-in, not a real person/);
    expect(titleCardVars(LIVE, 10).MODE_LABEL).toMatch(/Clothsy AI/);
    expect(titleCardVars(LIVE, 10).FOOT_NOTE).not.toMatch(/stand-in/);
    expect(titleCardVars(REPLAY, 10).MODE_LABEL).toMatch(/replayed from cache/);
    expect(outroCardVars(DRAFT, { repoUrl: "", demoUrl: "" }).CLAUDE_NOTE).toMatch(/rules fallback/);
    expect(outroCardVars(LIVE, { repoUrl: "", demoUrl: "" }).CLOTHSY_NOTE).toMatch(/AI-generated preview/);
    const d = titleCardVars(DRAFT, 10);
    expect(Number(d.D1)).toBeLessThan(Number(d.D2));
    expect(Number(d.D2)).toBeLessThan(Number(d.D3));
  });
});

describe("beats", () => {
  const all = [DRAFT, LIVE, REPLAY];

  it("covers every beat id once, in order", () => {
    for (const f of all) expect(beatsFor(f).map((b) => b.id)).toEqual([...BEAT_IDS]);
  });

  it("keeps the narration within the 2:00–2:45 target", () => {
    for (const f of all) {
      const sec = beatsFor(f).reduce((n, b) => n + estimateSpeechSec(b.narration), 0);
      expect(sec).toBeGreaterThan(95);
      expect(sec).toBeLessThan(165);
    }
  });

  it("is honest about simulated renders and the illustrated stand-in", () => {
    const draft = beatsFor(DRAFT);
    const text = (bs: ReturnType<typeof beatsFor>) =>
      bs.map((b) => [b.narration, b.caption?.kicker, b.caption?.title, b.caption?.detail].join(" ")).join(" ");
    expect(draft.find((b) => b.id === "intro")!.narration).toMatch(/simulated renders and an illustrated stand-in/);
    expect(draft.find((b) => b.id === "photo")!.caption!.detail).toMatch(/illustrated stand-in, not a real person/);
    expect(text(draft)).not.toMatch(/AI-generated/);
    expect(text(beatsFor(LIVE))).not.toMatch(/simulated|stand-in/i);
    expect(beatsFor(REPLAY).find((b) => b.id === "intro")!.narration).toMatch(/replayed from cache/);
    expect(renderProvenance(DRAFT)).toMatch(/simulated/);
    expect(renderProvenance(LIVE)).toMatch(/Clothsy AI/);
  });

  it("never comments on bodies or skin, and never claims instant renders", () => {
    for (const f of all) {
      for (const b of beatsFor(f)) {
        const t = `${b.narration} ${b.caption?.title ?? ""} ${b.caption?.detail ?? ""}`;
        expect(t).not.toMatch(/\b(skin|flatter\w*|figure|body shape|curves|slimming|instant(ly)?)\b/i);
      }
    }
  });

  it("describes the size beat without a photo as the table view", () => {
    const noPhoto = beatsFor({ ...LIVE, sizePhoto: false });
    expect(noPhoto.find((b) => b.id === "size-photo")!.narration).toMatch(/table/);
  });

  it("is mirrored word for word in docs/DEMO-SCRIPT.md", () => {
    const doc = readFileSync(path.join(__dirname, "..", "docs", "DEMO-SCRIPT.md"), "utf8").replace(/[“”]/g, '"');
    for (const f of [LIVE, DRAFT]) {
      for (const b of beatsFor(f)) {
        for (const sentence of splitSentences(b.narration)) expect(doc, `${b.id}: ${sentence}`).toContain(sentence.replace(/[“”]/g, '"'));
        if (b.caption?.title) expect(doc, `${b.id} caption`).toContain(b.caption.title.replace(/[“”]/g, '"'));
      }
    }
  });

  it("reads the honest clock line back in the narration", () => {
    expect(clockSentence("Renders started at photo upload · form done 0:14 · first card 0:07 (ready before the form was done)", LIVE)).toMatch(
      /before the form was finished/,
    );
    expect(clockSentence("… first card 0:27 (3 s after form)", LIVE)).toMatch(/arrived 3 seconds after the form/);
    expect(clockSentence("", LIVE)).toMatch(/clock shows/);
    expect(clockSentence("(ready before the form was done)", DRAFT)).toMatch(/simulated/);
    expect(clockSentence("(ready before the form was done)", LIVE, { fromCache: true })).toMatch(/replayed from cache/);
  });
});

describe("illustrated stand-ins", () => {
  it("are drawn to the catalogue's measurements for the purchased size", () => {
    expect(STAND_IN_SPECS.dress.hpsToHemCm).toBe(getSku("fw-wrap-dress-mustard")!.poms.M.hpsToHemCm);
    expect(STAND_IN_SPECS.shirt.hpsToHemCm).toBe(getSku("fw-linen-shirt-white")!.poms.M.hpsToHemCm);
    expect(STAND_IN_SPECS.dress.garmentHex.toLowerCase()).toBe(getSku("fw-wrap-dress-mustard")!.colorHex.toLowerCase());
    expect(STAND_IN_SPECS.shirt.garmentHex.toLowerCase()).toBe(getSku("fw-linen-shirt-white")!.colorHex.toLowerCase());
  });

  it("put the hem where the garment says (dress below the knee, shirt below the hips) and keep feet in frame", () => {
    for (const spec of Object.values(STAND_IN_SPECS)) {
      const at = (f: number) => spec.topPx + f * spec.statureCm * spec.pxPerCm;
      const hem = standInHemPx(spec);
      expect(at(BODY.sole)).toBeLessThan(STAND_IN_SIZE.height * 0.97);
      expect(at(BODY.nose)).toBeGreaterThan(STAND_IN_SIZE.height * 0.04);
      if (spec.kind === "dress") expect(hem).toBeGreaterThan(at(BODY.knee));
      else expect(hem).toBeGreaterThan(at(BODY.crotch));
      expect(hem).toBeLessThan(at(BODY.ankle));
    }
  });

  it("carry the 'not a real person' label in the image", () => {
    for (const spec of Object.values(STAND_IN_SPECS)) {
      const svg = standInSvg(spec);
      expect(svg).toContain(STAND_IN_LABEL);
      expect(svg).toMatch(/^<svg [^>]*width="1200" height="1600"/);
    }
  });
});

describe("recorder consent gate", () => {
  const base = { mode: "dev" as const, base: null, photo: null, sizePhoto: null, consent: false };
  it("needs --i-have-consent before a take can send the operator's own photos to the live API", () => {
    expect(recordConsentProblem(base)).toBeNull(); // illustrated stand-ins
    expect(recordConsentProblem({ ...base, mode: "auto" })).toBeNull();
    expect(recordConsentProblem({ ...base, photo: "/me.jpg" })).toBeNull(); // dev double: nothing leaves the machine
    expect(recordConsentProblem({ ...base, photo: "/me.jpg", mode: "replay" })).toBeNull();
    expect(recordConsentProblem({ ...base, photo: "/me.jpg", mode: "auto" })).toMatch(/--i-have-consent/);
    expect(recordConsentProblem({ ...base, sizePhoto: "/me.jpg", mode: "live" })).toMatch(/Clothsy AI/);
    expect(recordConsentProblem({ ...base, photo: "/me.jpg", base: "https://x.fly.dev" })).toMatch(/on https:\/\/x\.fly\.dev/);
    expect(recordConsentProblem({ ...base, photo: "/me.jpg", mode: "auto", consent: true })).toBeNull();
  });
  it("accepts --ai-people (AI-generated people, no real likeness) in place of --i-have-consent", () => {
    expect(recordConsentProblem({ ...base, photo: "/ai.jpg", mode: "auto", aiPeople: true })).toBeNull();
    expect(recordConsentProblem({ ...base, photo: "/ai.jpg", mode: "auto" })).toMatch(/--ai-people/);
  });
});

describe("AI-generated shoppers are labelled", () => {
  const facts = { simulated: false, replay: false, standIn: false, aiPeople: true, sizePhoto: true, llm: false };
  it("says so in the photo and size captions and on the intro", () => {
    const beats = beatsFor(facts);
    const text = JSON.stringify(beats);
    expect(beats.find((b) => b.id === "photo")!.caption!.detail).toMatch(/AI-generated, not a real person/);
    expect(beats.find((b) => b.id === "size-photo")!.caption!.detail).toMatch(/AI-generated shopper/);
    expect(beats[0]!.narration).toMatch(/shoppers in this video are AI-generated/); // live take: not called a draft
    expect(beatsFor({ ...facts, simulated: true })[0]!.narration).toMatch(/This draft uses simulated renders and AI-generated shoppers/);
    expect(text).not.toMatch(/illustrated stand-in/);
  });
});
