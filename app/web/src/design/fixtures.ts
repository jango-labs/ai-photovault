/** SYNTHETIC demo data for the design system and tests. No real photographs, places or posts. */
import manifest from '../../public/fixtures/manifest.json';
import type { PhotoItem } from '../ui/photo';
import type { PhotoDetail } from '../ui/PhotoViewer';
import type { CalendarItem } from '../ui/calendar/types';
import type { HistoryItem } from '../ui/history/HistoryGrid';
import type { PublishState } from '../ui/status';
import { addDays, zonedToIso, type DayKey } from '../lib/calendar';

const SPECIES = ['African elephant', 'Leopard', 'Bald eagle', 'Giraffe', 'Plains zebra', 'Lion', 'Snow leopard', 'Arctic fox', 'Cheetah', 'Humpback whale'];
const PLACES = ['Kenya', 'Tanzania', 'Botswana', 'Namibia', 'Norway', 'Iceland', 'India', 'Scotland'];

function rnd(seed: number): () => number { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

export const FIXTURE_COUNT = manifest.length;

export function makePhotos(n: number, seed = 7): PhotoItem[] {
  const r = rnd(seed);
  return Array.from({ length: n }, (_, i) => {
    const m = manifest[i % manifest.length]!;
    const species = SPECIES[Math.floor(r() * SPECIES.length)]!;
    const place = PLACES[Math.floor(r() * PLACES.length)]!;
    const x = r();
    const ig: PhotoItem['ig'] = x < 0.68 ? { state: 'NEVER_POSTED' } : x < 0.86 ? { state: 'POSTED', count: 1 + Math.floor(r() * 3) } : x < 0.92 ? { state: 'SCHEDULED' } : x < 0.98 ? { state: 'DRAFT' } : { state: 'FAILED' };
    const rating = r() < 0.35 ? 0 : 1 + Math.floor(r() * 5);
    return {
      id: `ph-${i}`, src: `/fixtures/${m.id}.jpg`, width: m.width, height: m.height,
      title: `${species} · ${place}`, alt: `Synthetic test image (${m.mood}), labelled “${species}, ${place}”`,
      rating, favorite: r() < 0.06, portfolio: r() < 0.03, hidden: r() < 0.01, ig, aiScore: Math.round(r() * 100) / 100,
      processing: r() < 0.01 ? 'analysing' : undefined, species, place,
      capturedAt: `${2021 + Math.floor(r() * 6)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
    };
  });
}

export function detailFor(p: PhotoItem): PhotoDetail {
  const r = rnd(p.id.length * 131 + p.width);
  return {
    info: { place: `${p.place} (sample)`, placeSource: p.id.endsWith('3') ? 'AI inferred' : 'Folder', capturedAt: p.capturedAt, notes: 'Synthetic note for layout testing.', version: '2 of 2 (re-export)' },
    ai: {
      species: [{ name: p.species ?? 'Subject', scientific: 'Genus species', confidence: 0.55 + r() * 0.44 }, { name: 'Second candidate', confidence: 0.2 + r() * 0.3 }],
      behavior: 'Walking', habitat: 'Open savanna', scene: 'Low sun, long shadows',
      description: 'A lone animal crosses open ground in warm late light, framed against a clean horizon.',
      scores: [{ name: 'Composition', value: r() }, { name: 'Subject isolation', value: r() }, { name: 'Lighting', value: r() }, { name: 'Impact', value: r() }],
    },
    exif: [['Camera', 'Demo Body II'], ['Lens', '100–400mm f/4.5–5.6'], ['Focal length', '400 mm'], ['Aperture', 'ƒ/5.6'], ['Shutter', '1/1600 s'], ['ISO', '800'], ['GPS', p.id.endsWith('3') ? '—' : '1.4833° S, 35.1000° E'], ['Copyright', '© Demo Photographer']],
    collections: ['Best of ' + (p.place ?? 'Africa'), 'Portfolio candidates'].slice(0, p.portfolio ? 2 : 1),
    history: p.ig.state === 'POSTED' ? [{ thumb: p.src, date: '14 Mar 2025', caption: 'Quiet light at the edge of the plain. #wildlife #nature' }] : [],
    scheduled: p.ig.state === 'SCHEDULED' ? { when: 'Fri 16 Oct, 19:30', state: 'SCHEDULED' } : p.ig.state === 'DRAFT' ? { when: 'Not scheduled', state: 'DRAFT' } : undefined,
  };
}

export function makeCalendarItems(today: DayKey, tz: string): CalendarItem[] {
  const plan: Array<[number, string, PublishState, string]> = [
    [-6, '19:30', 'PUBLISHED', 'Leopard'], [-3, '08:00', 'PUBLISHED', 'Bald eagle'], [-2, '18:30', 'FAILED', 'Giraffe'],
    [0, '19:30', 'SCHEDULED', 'African elephant'], [1, '08:00', 'READY', 'Plains zebra'], [2, '18:30', 'SCHEDULED', 'Lion'], [2, '07:30', 'SCHEDULED', 'Cheetah'],
    [4, '19:00', 'DRAFT', 'Snow leopard'], [6, '08:00', 'SCHEDULED', 'Arctic fox'], [6, '12:00', 'READY', 'Humpback whale'], [6, '19:30', 'DRAFT', 'Leopard'],
    [9, '19:30', 'SCHEDULED', 'Bald eagle'], [11, '18:00', 'DRAFT', 'Giraffe'], [13, '08:30', 'SCHEDULED', 'Lion'], [16, '19:30', 'READY', 'African elephant'],
  ];
  return plan.map(([off, t, state, label], i) => {
    const m = manifest[(i * 5 + 2) % manifest.length]!;
    return { id: `cal-${i}`, photo: { src: `/fixtures/${m.id}.jpg`, alt: `Synthetic test image (${m.mood})`, title: label }, scheduledAt: zonedToIso(addDays(today, off), t, tz), timeZone: tz, state, label,
      error: state === 'FAILED' ? 'Instagram rejected the image: aspect ratio outside the allowed range' : undefined };
  });
}

export function makeHistory(n = 64): HistoryItem[] {
  const r = rnd(99);
  const states = ['EXACT_MATCH', 'HIGH_CONFIDENCE_MATCH', 'USER_CONFIRMED', 'POSSIBLE_MATCH', undefined, undefined] as const;
  return Array.from({ length: n }, (_, i) => {
    const m = manifest[i % manifest.length]!;
    const hasIg = i % manifest.length < 12;
    const y = 2026 - Math.floor((i / n) * 5), mo = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
    const st = states[Math.floor(r() * states.length)];
    return {
      id: `ig-${i}`, src: hasIg ? `/fixtures/ig-${m.id}.jpg` : `/fixtures/${m.id}.jpg`, alt: `Synthetic Instagram-style crop (${m.mood})`,
      postedAt: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T18:30:00Z`,
      caption: 'Quiet light at the edge of the plain — a sample caption for layout testing that is long enough to wrap onto a second line of text.', hashtags: ['wildlife', 'nature', 'photography'].slice(0, 1 + (i % 3)),
      shape: hasIg && (i % 3 === 0) ? '1:1' : '4:5', permalink: undefined,
      match: st ? { state: st, similarity: st === 'POSSIBLE_MATCH' ? 0.9 + r() * 0.07 : 0.97 + r() * 0.03, photoTitle: 'Library photograph' } : undefined,
    } satisfies HistoryItem;
  });
}
