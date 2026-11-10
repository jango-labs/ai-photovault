/**
 * The bundled DEMO library: 36 procedurally generated images (app/web/public/fixtures/pNN.jpg, produced by scripts/fixtures/generate.mjs — no
 * real photograph is involved) with SYNTHETIC metadata: fictional cameras, invented capture dates, region-level GPS with a deterministic offset,
 * and authored descriptions. Nothing here describes a real person, place visit or photo shoot.
 */
export type Mood = 'savanna' | 'blue hour' | 'mountain mist' | 'ocean horizon' | 'forest light' | 'night sky' | 'golden bird' | 'dusk dunes';

export interface Look { slug: string; subject: string; scenes: string[]; environment: string; tags: string[]; description: string; title: string; style: string; lighting: string; categories: string[]; wildlife?: boolean }

export const LOOKS: Record<Mood, Look> = {
  'savanna': { slug: 'savanna', subject: 'acacia tree', scenes: ['savanna', 'grassland', 'sunset'], environment: 'open savanna at golden hour', tags: ['savanna', 'acacia', 'golden hour', 'warm light', 'landscape'], categories: ['landscape'], style: 'warm, minimal', lighting: 'low golden sun', title: 'Savanna at golden hour', description: 'A lone acacia tree stands on open grassland while a low sun glows orange over the horizon, casting a warm light across the dry grass.' },
  'blue hour': { slug: 'blue-hour', subject: 'twilight sky', scenes: ['twilight', 'calm landscape'], environment: 'quiet landscape at blue hour', tags: ['blue hour', 'twilight', 'calm', 'cool tones', 'landscape'], categories: ['landscape'], style: 'cool, moody', lighting: 'soft twilight', title: 'Blue hour calm', description: 'A calm landscape under a deep blue twilight sky, with soft cool light fading toward a dark horizon just after sunset.' },
  'mountain mist': { slug: 'mountain-mist', subject: 'misty mountain ridges', scenes: ['mountains', 'mist', 'layered ridges'], environment: 'mountain range in morning mist', tags: ['mountains', 'mist', 'fog', 'ridges', 'layers', 'landscape'], categories: ['landscape'], style: 'atmospheric, muted', lighting: 'diffused morning light', title: 'Mountain ridges in mist', description: 'Layered mountain ridges fade into pale mist, each ridge lighter than the one in front, in soft diffused morning light.' },
  'ocean horizon': { slug: 'ocean-horizon', subject: 'ocean horizon', scenes: ['sea', 'sunset over water', 'seascape'], environment: 'open sea at sunset', tags: ['ocean', 'sea', 'water', 'horizon', 'sunset', 'seascape'], categories: ['seascape'], style: 'calm, graphic', lighting: 'sun low over the water', title: 'Ocean horizon at sunset', description: 'A wide ocean horizon with the sun low over the water, a bright path of light on the sea and a clear gradient sky above.' },
  'forest light': { slug: 'forest-light', subject: 'forest', scenes: ['forest', 'light through trees', 'woodland'], environment: 'woodland with low sunlight', tags: ['forest', 'trees', 'woodland', 'green', 'sunlight', 'nature'], categories: ['landscape', 'nature'], style: 'earthy, soft', lighting: 'low sun filtering through trees', title: 'Forest light', description: 'Dark green woodland with low sunlight filtering between the trees, creating a gentle glow above the forested hills.' },
  'night sky': { slug: 'night-sky', subject: 'starry night sky', scenes: ['night', 'stars', 'astrophotography'], environment: 'dark sky at night', tags: ['night', 'stars', 'milky way', 'astrophotography', 'dark sky'], categories: ['astro', 'landscape'], style: 'dark, high contrast', lighting: 'starlight', title: 'Stars over a dark horizon', description: 'A dark night sky filled with small bright stars above a black horizon, with a faint violet glow near the ground.' },
  'golden bird': { slug: 'golden-bird', subject: 'bird in flight', scenes: ['sky', 'sunrise', 'bird in flight'], environment: 'warm sky at sunrise', tags: ['bird', 'flight', 'wildlife', 'sunrise', 'golden sky', 'silhouette'], categories: ['wildlife'], style: 'warm, silhouette', lighting: 'golden sunrise backlight', title: 'Bird in a golden sky', description: 'The silhouette of a single bird in flight against a glowing golden sky at sunrise, wings spread wide.', wildlife: true },
  'dusk dunes': { slug: 'dusk-dunes', subject: 'sand dunes', scenes: ['desert', 'dunes', 'dusk'], environment: 'desert dunes at dusk', tags: ['desert', 'dunes', 'sand', 'dusk', 'orange', 'landscape'], categories: ['landscape'], style: 'warm, sculptural', lighting: 'low dusk sun, long shadows', title: 'Dunes at dusk', description: 'Sculpted desert dunes glow orange in the dusk light, with a single acacia silhouette and long shadows across the sand.' },
};

export const PLACES: Array<{ name: string; country: string; cc: string; lat: number; lon: number }> = [
  { name: 'Rift Valley', country: 'Kenya', cc: 'KE', lat: -1.4, lon: 35.1 },
  { name: 'Lofoten', country: 'Norway', cc: 'NO', lat: 68.2, lon: 14.5 },
  { name: 'Highlands', country: 'Iceland', cc: 'IS', lat: 64.9, lon: -18.6 },
  { name: 'Thar Desert', country: 'India', cc: 'IN', lat: 27.0, lon: 71.0 },
  { name: 'Namib Coast', country: 'Namibia', cc: 'NA', lat: -24.7, lon: 15.1 },
  { name: 'Hokkaido', country: 'Japan', cc: 'JP', lat: 43.2, lon: 144.4 },
  { name: 'Rocky Mountains', country: 'Canada', cc: 'CA', lat: 52.9, lon: -118.1 },
  { name: 'Isle of Skye', country: 'Scotland', cc: 'GB', lat: 57.3, lon: -6.2 },
];

/** Fictional camera bodies and lenses (no real manufacturer is implied). */
export const BODIES: Array<[string, string]> = [['Examplon', 'EX-1 Mark II'], ['Demotek', 'DT-7 Pro'], ['Samplecam', 'SC-50']];
export const LENSES: Array<[string, number, number, number]> = [['Demo 24-70mm f/2.8', 24, 70, 2.8], ['Demo 70-200mm f/2.8', 70, 200, 2.8], ['Demo 100-400mm f/5.6', 100, 400, 5.6], ['Demo 16-35mm f/4', 16, 35, 4]];

export interface DemoPhoto { fixture: string; mood: Mood; relpath: string; title: string; description: string; keywords: string[]; place: (typeof PLACES)[number]; year: number; captureAt: string; make: string; model: string; lens: string; focal: number; fnumber: number; exposure: string; iso: number; gps: { lat: number; lon: number } | null; rating: number }

/** deterministic: the same demo library every time */
export function demoPhotos(manifest: Array<{ id: string; mood: Mood }>): DemoPhoto[] {
  return manifest.map((f, i) => {
    const look = LOOKS[f.mood]; const place = PLACES[(i * 3 + (i >> 3)) % PLACES.length]!; const year = 2022 + (i % 4);
    const [make, model] = BODIES[i % BODIES.length]!; const [lens, fmin, fmax, fn] = LENSES[(i + (i >> 2)) % LENSES.length]!;
    const focal = Math.round(fmin + ((i * 37) % 100) / 100 * (fmax - fmin));
    const month = 1 + ((i * 5) % 12), day = 1 + ((i * 11) % 27), hour = 5 + ((i * 7) % 15), minute = (i * 13) % 60;
    const p2 = (n: number) => String(n).padStart(2, '0');
    const jitter = (k: number) => (((i * 2654435761 + k * 40503) >>> 0) % 2000) / 1000 - 1;   // ±1 degree, deterministic
    return {
      fixture: f.id, mood: f.mood, relpath: `${year}/${place.name.replace(/ /g, '_')}/${look.slug}_${f.id}.jpg`, title: look.title, description: look.description,
      keywords: [...look.tags, 'demo'], place, year, captureAt: `${year}:${p2(month)}:${p2(day)} ${p2(hour)}:${p2(minute)}:00`, make, model, lens, focal, fnumber: fn + (i % 3) * 1.4,
      exposure: `1/${[125, 250, 500, 1000, 60][i % 5]}`, iso: [100, 200, 400, 800, 1600][i % 5]!, gps: i % 3 === 2 ? null : { lat: Math.round((place.lat + jitter(1)) * 1e4) / 1e4, lon: Math.round((place.lon + jitter(2)) * 1e4) / 1e4 },
      rating: 1 + (i % 5),
    };
  });
}
