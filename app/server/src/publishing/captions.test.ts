import { describe, expect, it } from 'vitest';
import { CAPTION_MODEL, suggestCaptions, suggestHashtags, type PhotoFacts } from './captions.js';

const facts = (o: Partial<PhotoFacts> = {}): PhotoFacts => ({ title: 'Pride at dusk', place: 'Masai Mara', species: [{ name: 'Lion', scientific: 'Panthera leo' }], capturedAt: new Date('2024-06-14T17:00:00Z'), description: null, camera: 'Canon EOS R5', lens: 'RF100-500mm', focalLengthMm: 400, aperture: 7.1, shutterS: 1 / 1000, iso: 800, keywords: ['wildlife', 'dusk'], ...o });
const by = (xs: ReturnType<typeof suggestCaptions>, s: string) => xs.find((x) => x.style === s)!;

describe('caption suggestions (templates, not a model)', () => {
  it('offers the three styles, labelled with the local template model', () => {
    const r = suggestCaptions(facts(), 'p1'); expect(r.map((x) => x.style).sort()).toEqual(['EDUCATIONAL', 'SHORT', 'STORYTELLING']); for (const x of r) expect(x.model).toBe(CAPTION_MODEL);
  });
  it('uses only recorded facts: species, place, month, equipment — and says which', () => {
    const r = suggestCaptions(facts(), 'p1'); expect(by(r, 'SHORT').body).toBe('Lion in Masai Mara, June 2024.');
    const edu = by(r, 'EDUCATIONAL').body; expect(edu).toContain('Lion (Panthera leo) in Masai Mara, June 2024.'); expect(edu).toContain('Canon EOS R5 · RF100-500mm · 400 mm · f/7.1 · 1/1000 s · ISO 800');
    expect(by(r, 'SHORT').basedOn).toEqual(['title', 'place', 'species', 'date', 'equipment']);
  });
  it('never invents: without species/place/date the captions say less and the gaps are listed', () => {
    const r = suggestCaptions(facts({ species: [], place: null, capturedAt: null, title: null, camera: null, lens: null, focalLengthMm: null, aperture: null, shutterS: null, iso: null }), 'p2');
    expect(by(r, 'SHORT').body).toBe('A photograph.'); expect(by(r, 'SHORT').missing).toHaveLength(3); expect(by(r, 'EDUCATIONAL').missing).toContain('No equipment data in the file');
    for (const x of r) expect(x.body).not.toMatch(/hunt|sunset|golden|rare|majestic|stalk/i);
  });
  it('your own description is used as written', () => {
    const body = by(suggestCaptions(facts({ description: 'A lioness watches the plain.' }), 'p3'), 'STORYTELLING').body; expect(body).toContain('A lioness watches the plain.'); expect(body).toContain('June 2024');
  });
  it('is deterministic for a photograph, and several species are listed naturally', () => {
    expect(suggestCaptions(facts(), 'same')).toEqual(suggestCaptions(facts(), 'same'));
    expect(by(suggestCaptions(facts({ species: [{ name: 'Lion', scientific: null }, { name: 'Zebra', scientific: null }, { name: 'Giraffe', scientific: null }] }), 'x'), 'SHORT').body).toContain('Lion, Zebra and Giraffe');
  });
});

describe('hashtag suggestions', () => {
  it('derives tags from the species, place, keywords and month, then your own habits, with the reason for each', () => {
    const r = suggestHashtags(facts(), [{ tag: 'safari', posts: 12 }, { tag: 'Wildlife', posts: 30 }]);
    expect(r.map((x) => x.tag)).toEqual(expect.arrayContaining(['lion', 'masaimara', 'wildlife', 'dusk', 'june', 'safari']));
    expect(r.find((x) => x.tag === 'lion')!.reason).toBe('the species'); expect(r.find((x) => x.tag === 'safari')!.reason).toBe('you have used it on 12 posts');
    expect(r.find((x) => x.tag === 'wildlife')!.reason).toBe('a keyword of the photograph');                   // first reason wins; no duplicates
  });
  it('normalises (no spaces, accents or symbols), de-duplicates and caps at 30', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ tag: `tag${i}`, posts: 1 })); const r = suggestHashtags(facts({ place: 'São Tomé & Príncipe', species: [{ name: 'African elephant', scientific: null }] }), many);
    expect(r).toHaveLength(30); expect(new Set(r.map((x) => x.tag)).size).toBe(30); expect(r.map((x) => x.tag)).toEqual(expect.arrayContaining(['saotomeprincipe', 'africanelephant', 'elephant']));
    for (const x of r) expect(x.tag).toMatch(/^[\p{L}\p{N}]+$/u);
  });
});
