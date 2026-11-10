// Generates SYNTHETIC "photographs" (procedural landscapes with grain) for the design system and tests.
// No real photography is read or used. Output is small (~30 KB each) and committed under app/web/public/fixtures.
// Usage: node scripts/fixtures/generate.mjs
import sharp from 'sharp';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.env.FIXTURE_OUT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/web/public/fixtures');
mkdirSync(OUT, { recursive: true });

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;

const MOODS = [
  { name: 'dusk dunes',   sky: [[24, 85, 62], [14, 70, 42], [350, 45, 22]], sun: true,  ground: [18, 55, 18], acacia: true },
  { name: 'savanna',      sky: [[38, 95, 70], [22, 80, 52], [8, 55, 28]],  sun: true,  ground: [28, 40, 10], acacia: true },
  { name: 'blue hour',    sky: [[205, 50, 62], [222, 48, 38], [240, 40, 18]], sun: false, ground: [220, 35, 9] },
  { name: 'mountain mist',sky: [[190, 18, 82], [200, 22, 62], [210, 28, 42]], sun: false, ground: [205, 25, 22], ridges: 5 },
  { name: 'ocean horizon',sky: [[198, 70, 78], [205, 65, 55], [215, 60, 34]], sun: true,  ground: [212, 60, 20], sea: true },
  { name: 'forest light', sky: [[60, 55, 72], [95, 40, 42], [150, 35, 20]],  sun: true,  ground: [140, 40, 8], ridges: 4 },
  { name: 'night sky',    sky: [[255, 40, 30], [262, 48, 16], [270, 55, 8]], sun: false, ground: [250, 30, 4], stars: true },
  { name: 'golden bird',  sky: [[45, 90, 78], [32, 85, 58], [14, 60, 36]], sun: true,  ground: [20, 40, 12], bird: true },
];

function scene(seed, w, h) {
  const r = rng(seed * 7919 + 13);
  const m = MOODS[seed % MOODS.length];
  const hueShift = (r() - 0.5) * 18;
  const stops = m.sky.map(([a, b, c], i) => `<stop offset="${[0, 0.55, 1][i]}" stop-color="${hsl(a + hueShift, b, c)}"/>`).join('');
  const horizon = h * (0.5 + r() * 0.22);
  const sunX = w * (0.2 + r() * 0.6), sunR = Math.min(w, h) * (0.05 + r() * 0.07), sunY = horizon - h * (0.08 + r() * 0.18);
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>`;
  if (m.stars) for (let i = 0; i < 90; i++) body += `<circle cx="${(r() * w).toFixed(1)}" cy="${(r() * horizon).toFixed(1)}" r="${(0.4 + r() * 1.1).toFixed(2)}" fill="#fff" opacity="${(0.25 + r() * 0.7).toFixed(2)}"/>`;
  if (m.sun) body += `<circle cx="${sunX}" cy="${sunY}" r="${sunR * 3.2}" fill="url(#glow)"/><circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="hsl(46 100% 90%)" opacity=".95"/>`;
  const layers = m.ridges ?? 3;
  for (let L = 0; L < layers; L++) {
    const t = L / Math.max(1, layers - 1);
    const base = horizon - (1 - t) * h * 0.12 + t * h * 0.02;
    let d = `M0 ${h} L0 ${base}`;
    const steps = 14;
    for (let i = 1; i <= steps; i++) { const y = base + (r() - 0.5) * h * (0.10 - t * 0.05); d += ` L${((i / steps) * w).toFixed(1)} ${y.toFixed(1)}`; }
    d += ` L${w} ${h} Z`;
    const [gh, gs, gl] = m.ground;
    body += `<path d="${d}" fill="${hsl(gh + hueShift, gs, gl * (0.55 + 0.9 * t))}" opacity="${(0.55 + 0.45 * t).toFixed(2)}"/>`;
  }
  if (m.sea) body += `<rect y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#sea)"/>`;
  if (m.acacia) { const ax = w * (0.15 + r() * 0.7), ay = horizon + h * 0.04, s = h * (0.07 + r() * 0.06);
    body += `<g fill="#0a0907"><rect x="${ax - s * 0.04}" y="${ay - s}" width="${s * 0.08}" height="${s}"/><ellipse cx="${ax}" cy="${ay - s}" rx="${s * 0.75}" ry="${s * 0.16}"/></g>`; }
  if (m.bird) for (let i = 0; i < 3; i++) { const bx = w * (0.2 + r() * 0.6), by = h * (0.15 + r() * 0.25), s = w * (0.03 + r() * 0.03);
    body += `<path d="M${bx - s} ${by} Q${bx - s / 2} ${by - s / 1.6} ${bx} ${by} Q${bx + s / 2} ${by - s / 1.6} ${bx + s} ${by}" stroke="#14110d" stroke-width="${Math.max(1.5, s / 5)}" fill="none" stroke-linecap="round"/>`; }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="hsl(40 100% 80%)" stop-opacity=".75"/><stop offset="1" stop-color="hsl(30 100% 60%)" stop-opacity="0"/></radialGradient>
      <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(205 + hueShift, 55, 38)}"/><stop offset="1" stop-color="${hsl(215, 60, 14)}"/></linearGradient>
      <radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
      <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="${seed}"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .22 0"/></filter>
    </defs>
    ${body}
    <rect width="${w}" height="${h}" fill="url(#vig)"/>
    <rect width="${w}" height="${h}" filter="url(#grain)"/>
  </svg>`;
}

// 36 images, mixed aspect ratios (landscape-heavy, like real wildlife work)
const RATIOS = [[3, 2], [3, 2], [2, 3], [3, 2], [4, 5], [3, 2], [16, 9], [3, 2], [1, 1], [3, 2], [5, 4], [2, 3]];
const LONG = 640;
const manifest = [];
for (let i = 0; i < 36; i++) {
  const [rw, rh] = RATIOS[i % RATIOS.length];
  const w = rw >= rh ? LONG : Math.round((LONG * rw) / rh), h = rw >= rh ? Math.round((LONG * rh) / rw) : LONG;
  const id = `p${String(i + 1).padStart(2, '0')}`;
  await sharp(Buffer.from(scene(i + 1, w, h))).jpeg({ quality: 58, mozjpeg: true, chromaSubsampling: '4:2:0' }).toFile(path.join(OUT, `${id}.jpg`));
  manifest.push({ id, width: w, height: h, mood: MOODS[(i + 1) % MOODS.length].name });
  // "Instagram" rendition: 4:5 or 1:1 centre crop, smaller and more compressed (what Instagram would keep)
  if (i < 12) {
    const crop = i % 3 === 0 ? { w: 480, h: 480 } : { w: 480, h: 600 };
    await sharp(path.join(OUT, `${id}.jpg`)).resize(crop.w, crop.h, { fit: 'cover' }).jpeg({ quality: 45, mozjpeg: true }).toFile(path.join(OUT, `ig-${id}.jpg`));
  }
}
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
let total = 0; for (const f of [...manifest.map((m) => `${m.id}.jpg`)]) total += statSync(path.join(OUT, f)).size;
console.log(`generated ${manifest.length} synthetic photographs (+12 Instagram-style crops); ${(total / 1024).toFixed(0)} KB for the base set`);
