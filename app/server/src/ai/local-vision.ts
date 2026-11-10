import sharp from 'sharp';
import type { AiAnalysis, ImageRef, VisionAnalysisService } from '@photovault/shared';

/**
 * LOCAL image analyser: runs entirely on this computer, sends nothing anywhere, costs nothing. It reports what can actually be MEASURED
 * from the pixels — sharpness, exposure, contrast, colour, where the detail sits in the frame — and says nothing it cannot know:
 * it does not identify species, behaviour or places (those need a vision model and your approval). Scores for things that need
 * judgement (storytelling, uniqueness) are null = "not assessed".
 */
export const LOCAL_MODEL = 'local-image-v1';
export const LOCAL_PROMPT_VERSION = 'local-1';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface Measurements {
  width: number; height: number;
  sharpness: number;          // 0..1 from the variance of the Laplacian (log-scaled)
  centreSharpness: number; edgeSharpness: number; isolation: number;
  meanLuma: number; contrast: number; shadowClip: number; highlightClip: number;
  colourfulness: number; saturation: number; warmth: number;      // warmth: (R-B)/255 averaged, -1..1
  thirds: number;             // 0..1, how close the centre of detail is to a rule-of-thirds point
  detailX: number; detailY: number;
  palette: Array<{ name: string; share: number }>;
}

const PALETTE: Array<[string, [number, number, number]]> = [
  ['black', [15, 15, 15]], ['white', [240, 240, 240]], ['grey', [128, 128, 128]], ['red', [200, 40, 40]], ['orange', [230, 130, 40]], ['amber', [220, 170, 50]],
  ['yellow', [230, 220, 70]], ['green', [60, 150, 60]], ['teal', [40, 150, 150]], ['blue', [50, 90, 200]], ['purple', [130, 70, 170]], ['pink', [220, 130, 170]], ['brown', [120, 80, 50]],
];
export const nearestColourName = (r: number, g: number, b: number): string => {
  let best = PALETTE[0]![0], bd = Infinity;
  for (const [n, [pr, pg, pb]] of PALETTE) { const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2; if (d < bd) { bd = d; best = n; } }
  return best;
};

/** Pure measurement on decoded pixels (grey: w×h, rgb: rw×rh×3). */
export function measure(grey: Uint8Array, w: number, h: number, rgb: Uint8Array, rw: number, rh: number, origW = w, origH = h): Measurements {
  // Laplacian response over the whole frame, the centre half, and the surrounding ring; and a coarse map of detail for the "where is the subject" centroid
  let n = 0, sum = 0, sum2 = 0, cN = 0, cSum = 0, cSum2 = 0, eN = 0, eSum = 0, eSum2 = 0;
  const gx = 8, gy = 8; const cell = new Float64Array(gx * gy); const cellN = new Float64Array(gx * gy);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * grey[i]! - grey[i - 1]! - grey[i + 1]! - grey[i - w]! - grey[i + w]!;
    n++; sum += l; sum2 += l * l;
    const inCentre = x > w * 0.25 && x < w * 0.75 && y > h * 0.25 && y < h * 0.75;
    if (inCentre) { cN++; cSum += l; cSum2 += l * l; } else { eN++; eSum += l; eSum2 += l * l; }
    const ci = Math.min(gy - 1, Math.floor((y / h) * gy)) * gx + Math.min(gx - 1, Math.floor((x / w) * gx));
    cell[ci] = (cell[ci] ?? 0) + Math.abs(l); cellN[ci] = (cellN[ci] ?? 0) + 1;
  }
  const variance = (cnt: number, s: number, s2: number) => (cnt ? s2 / cnt - (s / cnt) ** 2 : 0);
  const vAll = variance(n, sum, sum2), vC = variance(cN, cSum, cSum2), vE = variance(eN, eSum, eSum2);
  const sharp = (v: number) => clamp01(Math.log10(1 + v) / 3);                     // ≈ 0 for a flat/blurred frame, ≈ 1 for crisp detail
  const isolation = clamp01((sharp(vC) - sharp(vE)) * 2 + 0.3 * (vC > vE ? 1 : 0));
  // luminance statistics
  let ls = 0, ls2 = 0, shadow = 0, high = 0;
  for (let i = 0; i < grey.length; i++) { const v = grey[i]!; ls += v; ls2 += v * v; if (v <= 5) shadow++; if (v >= 250) high++; }
  const mean = ls / grey.length, sd = Math.sqrt(Math.max(0, ls2 / grey.length - mean * mean));
  // colour
  let rg = 0, rg2 = 0, yb = 0, yb2 = 0, sat = 0, warm = 0; const buckets = new Map<string, number>(); const px = rw * rh;
  for (let i = 0; i < px; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    const a = r - g, c = 0.5 * (r + g) - b; rg += a; rg2 += a * a; yb += c; yb2 += c * c;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); sat += mx === 0 ? 0 : (mx - mn) / mx; warm += (r - b) / 255;
    const nm = nearestColourName(r, g, b); buckets.set(nm, (buckets.get(nm) ?? 0) + 1);
  }
  const sRG = Math.sqrt(Math.max(0, rg2 / px - (rg / px) ** 2)), sYB = Math.sqrt(Math.max(0, yb2 / px - (yb / px) ** 2));
  const colourfulness = clamp01((Math.sqrt(sRG ** 2 + sYB ** 2) + 0.3 * Math.sqrt((rg / px) ** 2 + (yb / px) ** 2)) / 110);
  // where the detail is → distance to the nearest rule-of-thirds intersection
  let tw = 0, cx = 0, cy = 0;
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) { const e = cellN[j * gx + i]! ? cell[j * gx + i]! / cellN[j * gx + i]! : 0; tw += e; cx += e * (i + 0.5) / gx; cy += e * (j + 0.5) / gy; }
  const dx = tw ? cx / tw : 0.5, dy = tw ? cy / tw : 0.5;
  const points: Array<[number, number]> = [[1 / 3, 1 / 3], [2 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 2 / 3], [0.5, 0.5]];
  const dist = Math.min(...points.map(([px2, py2]) => Math.hypot(dx - px2, dy - py2)));
  const total = [...buckets.values()].reduce((a, b) => a + b, 0) || 1;
  const palette = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, c]) => ({ name, share: r2(c / total) }));
  return {
    width: origW, height: origH, sharpness: sharp(vAll), centreSharpness: sharp(vC), edgeSharpness: sharp(vE), isolation,
    meanLuma: mean, contrast: clamp01(sd / 80), shadowClip: shadow / grey.length, highlightClip: high / grey.length, colourfulness, saturation: sat / px, warmth: warm / px,
    thirds: clamp01(1 - dist / 0.3), detailX: dx, detailY: dy, palette,
  };
}

/** Turns measurements into the shared AiAnalysis shape — descriptive, never speculative. */
export function toAnalysis(m: Measurements): AiAnalysis {
  const orientation = m.width > m.height * 1.03 ? 'landscape' : m.height > m.width * 1.03 ? 'portrait' : 'square';
  const exposure = clamp01(1 - Math.abs(m.meanLuma - 118) / 118 * 0.9 - Math.min(0.5, (m.shadowClip + m.highlightClip) * 4));
  const lighting = clamp01(0.55 * exposure + 0.45 * Math.min(1, m.contrast * 1.4));
  const composition = clamp01(0.6 * m.thirds + 0.4 * (m.isolation > 0.4 ? 1 : 0.5 + m.isolation));
  const impact = clamp01(0.5 * m.contrast + 0.3 * m.colourfulness + 0.2 * m.sharpness);
  const overall = clamp01(0.3 * m.sharpness + 0.25 * lighting + 0.25 * composition + 0.2 * impact);
  const tone = m.warmth > 0.08 ? 'warm' : m.warmth < -0.08 ? 'cool' : 'neutral';
  const light = m.meanLuma < 70 ? 'low-key' : m.meanLuma > 170 ? 'high-key' : 'balanced';
  const detail = m.sharpness > 0.62 ? 'crisp' : m.sharpness > 0.38 ? 'moderate' : 'soft';
  const contrast = m.contrast > 0.6 ? 'high' : m.contrast < 0.3 ? 'low' : 'moderate';
  const where = m.isolation > 0.45 ? 'the sharpest area sits in the centre, with softer surroundings' : m.edgeSharpness > m.centreSharpness + 0.08 ? 'the sharpest detail is toward the edges' : 'detail is spread across the frame';
  const tags = [detail === 'crisp' ? 'sharp' : detail === 'soft' ? 'soft focus' : '', `${tone} tones`, `${light} exposure`, `${contrast} contrast`, m.saturation < 0.12 ? 'near monochrome' : m.colourfulness > 0.6 ? 'colourful' : '', `${orientation} orientation`,
    m.shadowClip > 0.05 ? 'clipped shadows' : '', m.highlightClip > 0.05 ? 'clipped highlights' : '', m.isolation > 0.45 ? 'isolated detail' : ''].filter(Boolean);
  const colours = m.palette.map((p) => p.name);
  return {
    primarySubject: 'not identified', secondarySubjects: [], objects: [], scenes: [], environment: null, categories: ['photograph'], tags,
    description: `A ${orientation} photograph in ${tone} tones with ${contrast} contrast and ${detail} detail; ${where}. Measured automatically — the subject is not identified.`,
    suggestedTitle: '', style: `${light}, ${tone}`, lighting: `${light} exposure (mean brightness ${Math.round(m.meanLuma)}/255)`, locationClues: null, dominantColorNames: colours, wildlife: [],
    scores: { composition: r2(composition), subjectIsolation: r2(m.isolation), lighting: r2(lighting), impact: r2(impact), storytelling: null, uniqueness: null, overall: r2(overall), sharpness: r2(m.sharpness), exposure: r2(exposure) },
    confidence: { measurements: 1, composition: 0.5, subject: 0 },                       // measurements are exact; "composition" is a heuristic; the subject is unknown
  };
}

export async function analyseFile(path: string): Promise<AiAnalysis> {
  const base = () => sharp(path, { failOn: 'error' }).rotate();
  const meta = await base().metadata();
  const [g, c] = await Promise.all([
    base().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true }),
    base().resize({ width: 96, height: 96, fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const swap = (meta.orientation ?? 1) >= 5;
  const m = measure(new Uint8Array(g.data), g.info.width, g.info.height, new Uint8Array(c.data), c.info.width, c.info.height, swap ? meta.height : meta.width, swap ? meta.width : meta.height);
  return toAnalysis(m);
}

export const localVision: VisionAnalysisService = { async analyze(image: ImageRef) { return analyseFile(image.previewPath); } };
