// Illustrated stand-in "person" photos for the DRAFT demo video.
//
// The draft video must never show a real person, so the shopper photo is a flat
// vector illustration of a figure wearing the returned item (a mustard wrap dress for
// order #1042, a white linen shirt for #1043), drawn to the catalogue's own
// measurements so the garment-as-ruler maths has something consistent to measure.
// It is labelled "Illustrated stand-in · not a real person" inside the image, and the
// video captions say so too. Replace it with your own photo via `--photo`.
//
//   npx tsx scripts/video/mannequin.ts --out out/video/stand-ins
//
// Pure SVG (no fonts needed except the small label), rasterised with sharp.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

export type StandInKind = "dress" | "shirt";

export const STAND_IN_LABEL = "Illustrated stand-in · not a real person";

export const STAND_IN_SIZE = { width: 1200, height: 1600 } as const;

/** Body landmarks as fractions of stature, measured from the top of the head. */
export const BODY = {
  chin: 0.13,
  hps: 0.162,
  shoulder: 0.178,
  bust: 0.245,
  waist: 0.36,
  hipJoint: 0.49,
  hipWidest: 0.515,
  crotch: 0.525,
  knee: 0.725,
  ankle: 0.955,
  sole: 1.0,
  nose: 0.083,
} as const;

export interface StandInSpec {
  kind: StandInKind;
  statureCm: number;
  /** Pixels per centimetre in the output image. */
  pxPerCm: number;
  /** Top of the head, px. */
  topPx: number;
  /** Garment colour (catalogue hex). */
  garmentHex: string;
  /** Catalogue high-point-shoulder-to-hem length for the purchased size (cm). */
  hpsToHemCm: number;
}

export const STAND_IN_SPECS: Record<StandInKind, StandInSpec> = {
  // #1042 Wrap Dress — Mustard, size M: hpsToHemCm 98.
  dress: { kind: "dress", statureCm: 168, pxPerCm: 8.3, topPx: 92, garmentHex: "#C9A227", hpsToHemCm: 98 },
  // #1043 Linen Shirt — White, size M: hpsToHemCm 72 (a tall wearer, hence "too short").
  shirt: { kind: "shirt", statureCm: 184, pxPerCm: 7.7, topPx: 86, garmentHex: "#F4F3EF", hpsToHemCm: 72 },
};

/** Where the garment hem lands (px from the top of the image) for a spec. */
export function standInHemPx(spec: StandInSpec): number {
  return spec.topPx + (BODY.hps * spec.statureCm + spec.hpsToHemCm) * spec.pxPerCm;
}

function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const out = f < 0 ? v * (1 + f) : v + (255 - v) * f;
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Build the SVG for one illustrated stand-in. Pure (exported for tests). */
export function standInSvg(spec: StandInSpec): string {
  const { width: W, height: H } = STAND_IN_SIZE;
  const s = spec.pxPerCm;
  const S = spec.statureCm;
  const cx = W / 2;
  const male = spec.kind === "shirt";
  // Body point → px. x in cm from the body's centre line, f as a fraction of stature.
  const X = (xcm: number) => +(cx + xcm * s).toFixed(1);
  const Ycm = (cm: number) => +(spec.topPx + cm * s).toFixed(1);
  const ptc = (xcm: number, ycm: number) => `${X(xcm)},${Ycm(ycm)}`;

  const skin = "#C99A78";
  const skinShade = "#A97B5C";
  const line = "#3A2C26";
  const hair = male ? "#2E2420" : "#3B2A22";
  const garment = spec.garmentHex;
  const garmentDark = shade(garment, male ? -0.16 : -0.22);
  const garmentLight = shade(garment, 0.18);
  const trousers = "#2B3445";
  const shoe = "#2A2522";

  const shoulderX = male ? 19.5 : 16.5;
  const hipX = male ? 9 : 9.5;
  const waistX = male ? 14.5 : 12;
  const hipOuter = male ? 16.5 : 17.5;
  const hpsCm = BODY.hps * S;
  const hemCm = hpsCm + spec.hpsToHemCm;
  const headCy = 0.065 * S;
  const headRy = 0.066 * S;
  const headRx = male ? 8.2 : 7.6;

  const defs: string[] = [];
  let gradSeq = 0;
  // Limbs as tapered quads between joints.
  const limb = (a: [number, number], b: [number, number], wa: number, wb: number, fill: string, extra = "") => {
    const [ax, ay] = a;
    const [bx, by] = b;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const p = [
      [ax + nx * wa, ay + ny * wa],
      [bx + nx * wb, by + ny * wb],
      [bx - nx * wb, by - ny * wb],
      [ax - nx * wa, ay - ny * wa],
    ];
    const id = `g${++gradSeq}`;
    // Cylindrical shading across the limb: dark edges, a highlight just off-centre.
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${X(ax + nx * wa)}" y1="${Ycm(ay + ny * wa)}" x2="${X(ax - nx * wa)}" y2="${Ycm(ay - ny * wa)}">` +
        `<stop offset="0" stop-color="${shade(fill, -0.3)}"/><stop offset="0.3" stop-color="${fill}"/>` +
        `<stop offset="0.55" stop-color="${shade(fill, 0.14)}"/><stop offset="0.8" stop-color="${fill}"/>` +
        `<stop offset="1" stop-color="${shade(fill, -0.35)}"/></linearGradient>`,
    );
    return `<path d="M${p.map(([x, y]) => ptc(x, y)).join(" L")} Z" fill="url(#${id})" stroke="${line}" stroke-width="3" stroke-linejoin="round" ${extra}/>`;
  };
  const cmY = (f: number) => f * S;

  // Arm joints (A-pose, wrists clear of the torso).
  const armSide = (side: 1 | -1) => {
    const sh: [number, number] = [side * shoulderX, cmY(BODY.shoulder) + 1];
    const el: [number, number] = [side * (shoulderX + 6.5), cmY(0.345)];
    const wr: [number, number] = [side * (shoulderX + 10), cmY(0.485)];
    const hand: [number, number] = [side * (shoulderX + 11.2), cmY(0.585)];
    return { sh, el, wr, hand };
  };
  const legSide = (side: 1 | -1) => {
    const hip: [number, number] = [side * hipX, cmY(BODY.hipJoint)];
    const knee: [number, number] = [side * 8, cmY(BODY.knee)];
    const ankle: [number, number] = [side * 7.2, cmY(BODY.ankle)];
    return { hip, knee, ankle };
  };

  const parts: string[] = [];

  // ── Background: wall + floor + soft shadow ──
  parts.push(`<defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7A848D"/><stop offset="1" stop-color="#959DA4"/>
    </linearGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7C7368"/><stop offset="1" stop-color="#6A6157"/>
    </linearGradient>
    <linearGradient id="cloth" gradientUnits="userSpaceOnUse" x1="${X(-24)}" y1="0" x2="${X(24)}" y2="0">
      <stop offset="0" stop-color="${shade(garment, -0.42)}"/><stop offset="0.16" stop-color="${shade(garment, -0.12)}"/>
      <stop offset="0.42" stop-color="${garmentLight}"/><stop offset="0.62" stop-color="${garment}"/>
      <stop offset="0.86" stop-color="${shade(garment, -0.18)}"/><stop offset="1" stop-color="${shade(garment, -0.45)}"/>
    </linearGradient>
    <radialGradient id="headShade" cx="0.42" cy="0.4" r="0.65">
      <stop offset="0" stop-color="${shade(skin, 0.12)}"/><stop offset="0.6" stop-color="${skin}"/><stop offset="1" stop-color="${shade(skin, -0.3)}"/>
    </radialGradient>
    <linearGradient id="hairShade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${shade(hair, -0.3)}"/><stop offset="0.45" stop-color="${shade(hair, 0.25)}"/><stop offset="1" stop-color="${shade(hair, -0.35)}"/>
    </linearGradient>
    <filter id="blur6" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="blur14" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="soft"><feGaussianBlur stdDeviation="0.9"/></filter>
    <radialGradient id="shadow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#000" stop-opacity="0.35"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
  </defs>`);
  const floorY = Ycm(cmY(BODY.sole) - 2);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#wall)"/>`);
  parts.push(`<rect y="${floorY - 70}" width="${W}" height="${H - floorY + 70}" fill="url(#floor)"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${Ycm(S)}" rx="${(26 * s).toFixed(1)}" ry="${(4 * s).toFixed(1)}" fill="url(#shadow)"/>`);

  parts.push(`<g filter="url(#soft)">`);
  // ── Legs (behind the garment) ──
  for (const side of [-1, 1] as const) {
    const L = legSide(side);
    const legFill = male ? trousers : skin;
    parts.push(limb(L.hip, [L.knee[0], L.knee[1] + 2], 8, 5.3, legFill));
    parts.push(limb(L.knee, L.ankle, 5.4, 3.4, legFill));
    // Shoe
    const ax = L.ankle[0];
    const ay = L.ankle[1];
    const sole = cmY(BODY.sole);
    parts.push(
      `<path d="M${ptc(ax - side * 3.8, ay - 1.5)} L${ptc(ax + side * 3.6, ay - 1.5)} Q${ptc(ax + side * 4.5, ay + 4)} ${ptc(ax + side * 7.5, sole - 3.2)} Q${ptc(ax + side * 10.5, sole - 2)} ${ptc(ax + side * 9.8, sole)} L${ptc(ax - side * 4.4, sole)} Q${ptc(ax - side * 5, sole - 4)} ${ptc(ax - side * 3.8, ay - 1.5)} Z" fill="${shoe}" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`,
    );
  }
  if (male) {
    // Trouser seat/top joining the legs.
    parts.push(
      `<path d="M${ptc(-hipOuter + 0.5, cmY(BODY.waist) + 8)} L${ptc(hipOuter - 0.5, cmY(BODY.waist) + 8)} L${ptc(hipX + 8, cmY(BODY.crotch) + 6)} L${ptc(0, cmY(BODY.crotch) + 2)} L${ptc(-hipX - 8, cmY(BODY.crotch) + 6)} Z" fill="${trousers}" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`,
    );
  }

  // ── Arms: skin first (hands), sleeves over them ──
  for (const side of [-1, 1] as const) {
    const A = armSide(side);
    parts.push(limb(A.wr, A.hand, 2.6, 2.2, skin));
    parts.push(`<ellipse cx="${X(A.hand[0])}" cy="${Ycm(A.hand[1])}" rx="${(3 * s).toFixed(1)}" ry="${(4.2 * s).toFixed(1)}" fill="${skin}" stroke="${line}" stroke-width="3"/>`);
    parts.push(limb(A.sh, [A.el[0], A.el[1] + 1.5], 5.2, 4.1, garment));
    parts.push(limb(A.el, [A.wr[0], A.wr[1] + 1.5], 4.2, 3.4, garment));
    // Cuff
    const cuffA: [number, number] = [A.wr[0] - side * 0.2, A.wr[1] - 1.5];
    parts.push(limb(cuffA, [A.wr[0], A.wr[1] + 1.5], 3.5, 3.5, garmentDark));
    parts.push(limb([A.el[0] + side * 0.4, A.el[1] + 3], [A.wr[0] - side * 0.2, A.wr[1] - 4], 0.6, 0.4, garmentDark, 'opacity="0.5"'));
  }

  // ── Long hair falls behind the shoulders (drawn before the neck and garment) ──
  if (!male) {
    parts.push(`<path d="M${ptc(-headRx - 2.2, headCy - 2)} Q${ptc(-headRx - 3.5, hpsCm + 4)} ${ptc(-headRx + 0.5, hpsCm + 5)} L${ptc(headRx - 0.5, hpsCm + 5)} Q${ptc(headRx + 3.5, hpsCm + 4)} ${ptc(headRx + 2.2, headCy - 2)} Z" fill="url(#hairShade)" stroke="${line}" stroke-width="3"/>`);
  }

  // ── Neck + head ──
  parts.push(`<rect x="${X(-3.4)}" y="${Ycm(cmY(BODY.chin) - 2)}" width="${(6.8 * s).toFixed(1)}" height="${(hpsCm - cmY(BODY.chin) + 5) * s}" fill="${shade(skin, -0.08)}" stroke="${line}" stroke-width="3"/>`);
  parts.push(`<path d="M${ptc(-3.4, cmY(BODY.chin) + 1)} Q${ptc(0, cmY(BODY.chin) + 4)} ${ptc(3.4, cmY(BODY.chin) + 1)}" fill="none" stroke="${skinShade}" stroke-width="5" opacity="0.6"/>`);

  // ── Torso garment ──
  if (male) {
    const top = hpsCm;
    const shY = cmY(BODY.shoulder);
    const shirt = [
      ptc(-5.5, top),
      ptc(-shoulderX - 1.5, shY + 0.5),
      ptc(-shoulderX - 1.8, shY + 9),
      ptc(-waistX - 1.5, cmY(BODY.waist)),
      ptc(-hipOuter - 0.5, hemCm - 6),
      ptc(-hipOuter, hemCm),
      ptc(hipOuter, hemCm),
      ptc(hipOuter + 0.5, hemCm - 6),
      ptc(waistX + 1.5, cmY(BODY.waist)),
      ptc(shoulderX + 1.8, shY + 9),
      ptc(shoulderX + 1.5, shY + 0.5),
      ptc(5.5, top),
    ];
    parts.push(`<path d="M${shirt.join(" L")} Z" fill="url(#cloth)" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`);
    // Collar + placket + buttons + pocket
    parts.push(`<path d="M${ptc(-5.5, top)} L${ptc(0, top + 7)} L${ptc(5.5, top)} L${ptc(4, top - 2.5)} L${ptc(0, top + 3)} L${ptc(-4, top - 2.5)} Z" fill="${garmentLight}" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`);
    parts.push(`<path d="M${ptc(-5.5, top)} L${ptc(-7.8, top + 6.5)} L${ptc(-1.2, top + 7.5)} Z M${ptc(5.5, top)} L${ptc(7.8, top + 6.5)} L${ptc(1.2, top + 7.5)} Z" fill="${garmentLight}" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`);
    parts.push(`<line x1="${X(0)}" y1="${Ycm(top + 7)}" x2="${X(0)}" y2="${Ycm(hemCm)}" stroke="${garmentDark}" stroke-width="4"/>`);
    for (let y = top + 11; y < hemCm - 3; y += 9.5) parts.push(`<circle cx="${X(1.3)}" cy="${Ycm(y)}" r="${(0.55 * s).toFixed(1)}" fill="${shade(garment, -0.35)}"/>`);
    parts.push(`<path d="M${ptc(-12.5, top + 13)} L${ptc(-6.5, top + 13)} L${ptc(-6.5, top + 20)} L${ptc(-12.5, top + 20)} Z" fill="none" stroke="${garmentDark}" stroke-width="3"/>`);
    // Soft folds and occlusion (blurred), clipped to the shirt.
    defs.push(`<clipPath id="torsoClip"><path d="M${shirt.join(" L")} Z"/></clipPath>`);
    parts.push(
      `<g clip-path="url(#torsoClip)" opacity="0.55">` +
        `<path d="M${ptc(-8, cmY(BODY.waist) + 4)} Q${ptc(-6, hemCm - 12)} ${ptc(-9, hemCm - 2)} M${ptc(9, cmY(BODY.waist) + 2)} Q${ptc(7, hemCm - 10)} ${ptc(10, hemCm - 2)} M${ptc(-13, shY + 10)} Q${ptc(-9, cmY(BODY.waist) - 6)} ${ptc(-12, cmY(BODY.waist) + 4)} M${ptc(13, shY + 10)} Q${ptc(9, cmY(BODY.waist) - 6)} ${ptc(12, cmY(BODY.waist) + 4)}" fill="none" stroke="${shade(garment, -0.4)}" stroke-width="16" filter="url(#blur6)"/>` +
        `<path d="M${ptc(-shoulderX - 3, shY + 4)} L${ptc(-waistX - 3, cmY(BODY.waist))} L${ptc(-hipOuter - 3, hemCm)} M${ptc(shoulderX + 3, shY + 4)} L${ptc(waistX + 3, cmY(BODY.waist))} L${ptc(hipOuter + 3, hemCm)}" fill="none" stroke="${shade(garment, -0.55)}" stroke-width="40" filter="url(#blur14)"/>` +
        `<path d="M${ptc(-12, top + 10)} L${ptc(-3, cmY(BODY.waist))} M${ptc(5, top + 12)} L${ptc(11, cmY(BODY.waist) - 4)}" fill="none" stroke="#FFFFFF" stroke-width="18" opacity="0.35" filter="url(#blur6)"/>` +
        `</g>`,
    );
  } else {
    const top = hpsCm;
    const shY = cmY(BODY.shoulder);
    const waistY = cmY(BODY.waist);
    const dress = [
      ptc(-5, top),
      ptc(-shoulderX - 1.5, shY + 0.5),
      ptc(-shoulderX - 1.6, shY + 8),
      ptc(-15.5, cmY(BODY.bust) + 2),
      ptc(-waistX - 0.5, waistY),
      ptc(-hipOuter - 0.5, cmY(BODY.hipWidest)),
      ptc(-23, hemCm - 2),
      ptc(-22, hemCm + 1),
      ptc(-8, hemCm + 2.5),
      ptc(8, hemCm),
      ptc(22.5, hemCm - 1),
      ptc(23, hemCm - 3),
      ptc(hipOuter + 0.5, cmY(BODY.hipWidest)),
      ptc(waistX + 0.5, waistY),
      ptc(15.5, cmY(BODY.bust) + 2),
      ptc(shoulderX + 1.6, shY + 8),
      ptc(shoulderX + 1.5, shY + 0.5),
      ptc(5, top),
    ];
    parts.push(`<path d="M${dress.join(" L")} Z" fill="url(#cloth)" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`);
    // V-neck (skin) + wrap overlap
    parts.push(`<path d="M${ptc(-5, top)} L${ptc(1.5, cmY(BODY.bust) + 1)} L${ptc(5, top)} Z" fill="${skin}" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>`);
    parts.push(`<path d="M${ptc(5, top)} L${ptc(1.5, cmY(BODY.bust) + 1)} L${ptc(-waistX + 1, waistY - 1)}" fill="none" stroke="${garmentDark}" stroke-width="5"/>`);
    parts.push(`<path d="M${ptc(-waistX - 0.2, waistY - 2.4)} L${ptc(waistX + 0.2, waistY - 2.4)} L${ptc(waistX + 0.4, waistY + 2.4)} L${ptc(-waistX - 0.4, waistY + 2.4)} Z" fill="${garmentDark}" stroke="${line}" stroke-width="2.5"/>`);
    // Tie bow + sash ends at the side
    parts.push(`<path d="M${ptc(7, waistY)} q${(3 * s).toFixed(1)},${(-4 * s).toFixed(1)} ${(6 * s).toFixed(1)},${(-1 * s).toFixed(1)} q${(-1 * s).toFixed(1)},${(3 * s).toFixed(1)} ${(-6 * s).toFixed(1)},${(1 * s).toFixed(1)} Z" fill="${garmentDark}" stroke="${line}" stroke-width="2.5"/>`);
    parts.push(`<path d="M${ptc(8, waistY + 1.5)} L${ptc(10.5, waistY + 22)} L${ptc(12.8, waistY + 21)} L${ptc(9.5, waistY + 1.5)} Z M${ptc(9, waistY + 1.5)} L${ptc(14.5, waistY + 17)} L${ptc(16.4, waistY + 15.5)} L${ptc(10.5, waistY + 1)} Z" fill="${garment}" stroke="${line}" stroke-width="2.5" stroke-linejoin="round"/>`);
    // Skirt folds, bust/waist occlusion and side shadows (blurred), clipped to the dress.
    defs.push(`<clipPath id="torsoClip"><path d="M${dress.join(" L")} Z"/></clipPath>`);
    parts.push(
      `<g clip-path="url(#torsoClip)" opacity="0.6">` +
        `<path d="M${ptc(-6, waistY + 6)} Q${ptc(-9, hemCm - 20)} ${ptc(-13, hemCm)} M${ptc(3, waistY + 8)} Q${ptc(4, hemCm - 18)} ${ptc(2, hemCm + 1)} M${ptc(12, waistY + 8)} Q${ptc(15, hemCm - 18)} ${ptc(18, hemCm - 1)}" fill="none" stroke="${shade(garment, -0.5)}" stroke-width="18" filter="url(#blur6)"/>` +
        `<path d="M${ptc(-1.5, waistY + 8)} Q${ptc(-2.5, hemCm - 18)} ${ptc(-5, hemCm)} M${ptc(8, waistY + 8)} Q${ptc(10, hemCm - 18)} ${ptc(11, hemCm)}" fill="none" stroke="#FFFFFF" stroke-width="16" opacity="0.45" filter="url(#blur6)"/>` +
        `<path d="M${ptc(-14, cmY(BODY.bust) + 4)} Q${ptc(0, cmY(BODY.bust) + 9)} ${ptc(14, cmY(BODY.bust) + 4)}" fill="none" stroke="${shade(garment, -0.5)}" stroke-width="22" filter="url(#blur6)"/>` +
        `<path d="M${ptc(-shoulderX - 3, shY + 4)} L${ptc(-waistX - 3, waistY)} L${ptc(-24, hemCm)} M${ptc(shoulderX + 3, shY + 4)} L${ptc(waistX + 3, waistY)} L${ptc(24, hemCm)}" fill="none" stroke="${shade(garment, -0.6)}" stroke-width="40" filter="url(#blur14)"/>` +
        `</g>`,
    );
  }

  // ── Head: hair back, face, features, hair front ──
  const hy = Ycm(headCy);
  parts.push(`<ellipse cx="${X(-headRx)}" cy="${Ycm(headCy + 1)}" rx="${(1.5 * s).toFixed(1)}" ry="${(2.6 * s).toFixed(1)}" fill="${skin}" stroke="${line}" stroke-width="3"/>`);
  parts.push(`<ellipse cx="${X(headRx)}" cy="${Ycm(headCy + 1)}" rx="${(1.5 * s).toFixed(1)}" ry="${(2.6 * s).toFixed(1)}" fill="${skin}" stroke="${line}" stroke-width="3"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${hy}" rx="${(headRx * s).toFixed(1)}" ry="${(headRy * s).toFixed(1)}" fill="url(#headShade)" stroke="${line}" stroke-width="3"/>`);
  const eyeY = headCy - 0.2;
  for (const side of [-1, 1] as const) {
    parts.push(`<ellipse cx="${X(side * 3.1)}" cy="${Ycm(eyeY)}" rx="${(1.25 * s).toFixed(1)}" ry="${(0.75 * s).toFixed(1)}" fill="#FBF7F2" stroke="${line}" stroke-width="2"/>`);
    parts.push(`<circle cx="${X(side * 3.1)}" cy="${Ycm(eyeY)}" r="${(0.55 * s).toFixed(1)}" fill="#2B211C"/>`);
    parts.push(`<path d="M${ptc(side * 1.7, eyeY - 2)} Q${ptc(side * 3.1, eyeY - 2.9)} ${ptc(side * 4.6, eyeY - 1.9)}" fill="none" stroke="${hair}" stroke-width="${male ? 6 : 4.5}" stroke-linecap="round"/>`);
  }
  parts.push(`<path d="M${ptc(-0.2, eyeY + 0.8)} Q${ptc(-1.1, eyeY + 4)} ${ptc(0, eyeY + 4.4)} Q${ptc(0.9, eyeY + 4.6)} ${ptc(1.2, eyeY + 4)}" fill="none" stroke="${skinShade}" stroke-width="3.5" stroke-linecap="round"/>`);
  parts.push(`<path d="M${ptc(-2.4, eyeY + 7)} Q${ptc(0, eyeY + 8.4)} ${ptc(2.4, eyeY + 7)}" fill="${male ? "none" : "#B5655A"}" stroke="#7A3F37" stroke-width="3" stroke-linecap="round"/>`);
  if (male) {
    parts.push(`<path d="M${ptc(-headRx - 0.6, headCy - 1)} Q${ptc(-headRx - 1.2, headCy - headRy * 0.9)} ${ptc(0, headCy - headRy - 1)} Q${ptc(headRx + 1.2, headCy - headRy * 0.9)} ${ptc(headRx + 0.6, headCy - 1)} Q${ptc(headRx - 1, headCy - 6)} ${ptc(2, headCy - 7.5)} Q${ptc(-4, headCy - 6)} ${ptc(-headRx - 0.6, headCy - 1)} Z" fill="url(#hairShade)" stroke="${line}" stroke-width="3"/>`);
  } else {
    parts.push(`<path d="M${ptc(-headRx - 1.6, headCy + 3)} Q${ptc(-headRx - 1.5, headCy - headRy - 1)} ${ptc(0, headCy - headRy - 1.4)} Q${ptc(headRx + 1.5, headCy - headRy - 1)} ${ptc(headRx + 1.6, headCy + 3)} Q${ptc(headRx - 0.5, headCy - 5)} ${ptc(-1, headCy - 7.4)} Q${ptc(-5, headCy - 4)} ${ptc(-headRx - 1.6, headCy + 3)} Z" fill="url(#hairShade)" stroke="${line}" stroke-width="3"/>`);
  }

  parts.push(`</g>`);

  // ── Honesty label ──
  parts.push(
    `<g font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600">
      <rect x="28" y="${H - 78}" width="${STAND_IN_LABEL.length * 15.4 + 36}" height="50" rx="25" fill="#1E1B18" fill-opacity="0.78"/>
      <text x="46" y="${H - 43}" fill="#FFFFFF">${STAND_IN_LABEL}</text>
    </g>`,
  );

  const body = parts.join("\n").replaceAll(`stroke="${line}" stroke-width="3"`, `stroke="${line}" stroke-width="1.6" stroke-opacity="0.45"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join("")}</defs>${body}</svg>`;
}

/** Rasterise one stand-in to a JPEG (≤1600 px, no metadata) — the format the app uploads as-is. */
export async function renderStandIn(kind: StandInKind): Promise<Buffer> {
  const svg = standInSvg(STAND_IN_SPECS[kind]);
  const { width, height } = STAND_IN_SIZE;
  // Fine, deterministic sensor-like grain so the flat vector fills read as a photographed scene.
  const grain = Buffer.alloc(width * height);
  let seed = kind === "dress" ? 1042 : 1043;
  for (let i = 0; i < grain.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    grain[i] = 128 + (((seed >>> 24) - 128) >> 3);
  }
  const grainPng = await sharp(grain, { raw: { width, height, channels: 1 } }).toColourspace("srgb").png().toBuffer();
  return sharp(Buffer.from(svg))
    .composite([{ input: grainPng, blend: "overlay" }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/** Write both stand-ins into `dir` and return their paths. */
export async function writeStandIns(dir: string): Promise<Record<StandInKind, string>> {
  mkdirSync(dir, { recursive: true });
  const out = {} as Record<StandInKind, string>;
  for (const kind of ["dress", "shirt"] as const) {
    const file = path.join(dir, `stand-in-${kind}.jpg`);
    writeFileSync(file, await renderStandIn(kind));
    out[kind] = file;
  }
  return out;
}

if (require.main === module) {
  const i = process.argv.indexOf("--out");
  const dir = path.resolve(i > 0 ? (process.argv[i + 1] ?? "out/video/stand-ins") : "out/video/stand-ins");
  writeStandIns(dir).then(
    (files) => console.log(`Wrote ${Object.values(files).join(", ")}`),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
