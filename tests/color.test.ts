import { describe, expect, it } from "vitest";
import {
  chroma,
  deltaE2000,
  deltaE76,
  hexToLab,
  hexToRgb,
  meanLabMasked,
  srgbToLab,
  type Lab,
} from "@/lib/color";

// Sharma, Wu & Dalal (2005), Table 1: all 34 published CIEDE2000 test pairs.
// [L1, a1, b1, L2, a2, b2, ΔE00]
const SHARMA: ReadonlyArray<readonly [number, number, number, number, number, number, number]> = [
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

function expectLabClose(actual: Lab, expected: Lab, tol: number) {
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tol);
}

describe("deltaE2000 (Sharma et al. 2005)", () => {
  it.each(SHARMA.map((row, i) => [i + 1, ...row] as const))(
    "pair %i matches the published value to 1e-4",
    (_pair, L1, a1, b1, L2, a2, b2, expected) => {
      const d = deltaE2000([L1, a1, b1], [L2, a2, b2]);
      expect(Math.abs(d - expected)).toBeLessThanOrEqual(1e-4);
    },
  );

  it("is symmetric for every published pair", () => {
    for (const [L1, a1, b1, L2, a2, b2] of SHARMA) {
      const ab = deltaE2000([L1, a1, b1], [L2, a2, b2]);
      const ba = deltaE2000([L2, a2, b2], [L1, a1, b1]);
      expect(Math.abs(ab - ba)).toBeLessThan(1e-9);
    }
  });

  it("is zero for identical colours (including neutrals)", () => {
    expect(deltaE2000([50, 0, 0], [50, 0, 0])).toBe(0);
    expect(deltaE2000([42.1, 13.7, -8.2], [42.1, 13.7, -8.2])).toBe(0);
  });
});

describe("sRGB → Lab (D65)", () => {
  it("maps white and black to the Lab extremes", () => {
    expectLabClose(srgbToLab(255, 255, 255), [100, 0, 0], 1e-6);
    expectLabClose(srgbToLab(0, 0, 0), [0, 0, 0], 1e-9);
  });

  it("matches reference values for the primaries", () => {
    expectLabClose(srgbToLab(255, 0, 0), [53.2408, 80.0925, 67.2032], 2e-3);
    expectLabClose(srgbToLab(0, 255, 0), [87.7347, -86.1827, 83.1793], 2e-3);
    expectLabClose(srgbToLab(0, 0, 255), [32.297, 79.1875, -107.8602], 2e-3);
  });

  it("keeps greys neutral and handles the linear toe of the sRGB curve", () => {
    const grey = srgbToLab(128, 128, 128);
    expect(grey[0]).toBeCloseTo(53.585, 2);
    expect(Math.abs(grey[1])).toBeLessThan(1e-6);
    expect(Math.abs(grey[2])).toBeLessThan(1e-6);
    // 5/255 is below the 0.04045 knee, so it uses the linear segment.
    const dark = srgbToLab(5, 5, 5);
    expect(dark[0]).toBeGreaterThan(0);
    expect(dark[0]).toBeLessThan(2);
  });

  it("accepts fractional channel values", () => {
    const a = srgbToLab(100.5, 20.25, 30);
    const lo = srgbToLab(100, 20, 30);
    const hi = srgbToLab(101, 21, 30);
    expect(a[0]).toBeGreaterThan(lo[0]);
    expect(a[0]).toBeLessThan(hi[0]);
  });
});

describe("hex helpers", () => {
  it("parses 6- and 3-digit hex with or without #", () => {
    expect(hexToRgb("#C9A227")).toEqual([201, 162, 39]);
    expect(hexToRgb("1f7a5a")).toEqual([31, 122, 90]);
    expect(hexToRgb("#abc")).toEqual([170, 187, 204]);
    expect(hexToRgb("  #FFFFFF ")).toEqual([255, 255, 255]);
  });

  it("rejects malformed hex", () => {
    expect(() => hexToRgb("#12345")).toThrow();
    expect(() => hexToRgb("blue")).toThrow();
    expect(() => hexToRgb("")).toThrow();
  });

  it("hexToLab agrees with srgbToLab", () => {
    expectLabClose(hexToLab("#2851A3"), srgbToLab(0x28, 0x51, 0xa3), 1e-12);
  });

  it("separates catalogue colours the gate must tell apart", () => {
    // Mustard → emerald is a large colour change; navy → black is subtle.
    expect(deltaE2000(hexToLab("#C9A227"), hexToLab("#1F7A5A"))).toBeGreaterThan(20);
    expect(deltaE2000(hexToLab("#1F2A44"), hexToLab("#1C1C1C"))).toBeLessThan(20);
  });
});

describe("chroma / deltaE76", () => {
  it("computes chroma as the a*b* radius", () => {
    expect(chroma([50, 3, 4])).toBeCloseTo(5, 12);
    expect(chroma([70, 0, 0])).toBe(0);
  });
  it("computes the Euclidean ΔE*ab", () => {
    expect(deltaE76([50, 0, 0], [53, 4, 0])).toBeCloseTo(5, 12);
  });
});

describe("meanLabMasked", () => {
  function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number]) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [r, g, b] = fill(x, y);
        const p = (y * width + x) * 4;
        rgba[p] = r;
        rgba[p + 1] = g;
        rgba[p + 2] = b;
        rgba[p + 3] = 255;
      }
    return rgba;
  }

  it("averages only masked pixels", () => {
    const w = 10;
    const h = 6;
    // Left half mustard, right half white; mask selects the left half.
    const rgba = image(w, h, (x) => (x < 5 ? [201, 162, 39] : [255, 255, 255]));
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 5; x++) mask[y * w + x] = 1;
    const lab = meanLabMasked(rgba, mask, w, h);
    expect(lab).not.toBeNull();
    expectLabClose(lab!, hexToLab("#C9A227"), 1e-9);
  });

  it("returns the mean in Lab space for mixed pixels", () => {
    const w = 2;
    const h = 1;
    const rgba = image(w, h, (x) => (x === 0 ? [255, 0, 0] : [0, 0, 255]));
    const mask = new Uint8Array([1, 1]);
    const lab = meanLabMasked(rgba, mask, w, h)!;
    const r = srgbToLab(255, 0, 0);
    const b = srgbToLab(0, 0, 255);
    expectLabClose(lab, [(r[0] + b[0]) / 2, (r[1] + b[1]) / 2, (r[2] + b[2]) / 2], 1e-9);
  });

  it("subsamples with step and still finds the colour", () => {
    const w = 40;
    const h = 40;
    const rgba = image(w, h, () => [31, 122, 90]);
    const mask = new Uint8Array(w * h).fill(1);
    const lab = meanLabMasked(rgba, mask, w, h, { step: 4 })!;
    expectLabClose(lab, hexToLab("#1F7A5A"), 1e-9);
  });

  it("returns null for an empty mask or too few pixels", () => {
    const rgba = image(4, 4, () => [10, 20, 30]);
    expect(meanLabMasked(rgba, new Uint8Array(16), 4, 4)).toBeNull();
    const one = new Uint8Array(16);
    one[5] = 1;
    expect(meanLabMasked(rgba, one, 4, 4, { minPixels: 2 })).toBeNull();
    expect(meanLabMasked(rgba, one, 4, 4)).not.toBeNull();
  });

  it("skips fully transparent pixels", () => {
    const rgba = image(2, 1, (x) => (x === 0 ? [255, 255, 255] : [0, 0, 0]));
    rgba[7] = 0; // second pixel transparent
    const lab = meanLabMasked(rgba, new Uint8Array([1, 1]), 2, 1)!;
    expectLabClose(lab, [100, 0, 0], 1e-6);
  });

  it("throws on mismatched buffers", () => {
    expect(() => meanLabMasked(new Uint8ClampedArray(4), new Uint8Array(4), 2, 2)).toThrow();
  });
});
