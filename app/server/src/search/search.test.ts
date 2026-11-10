import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { makeJpeg } from '../ingest/testkit.js';
import { LOCAL_EMBEDDING_DIMS, TextEmbeddingNotSupported, cosine, embedFile, localEmbedding, toVectorLiteral } from './embedding.js';
import { parseQuery, type SearchContext } from './parse.js';

const ctx: SearchContext = {
  now: new Date('2026-10-09T10:00:00Z'),
  locations: ['Kenya', 'Norway', 'Masai Mara', 'South Africa', 'Sri Lanka'],
  species: [{ name: 'African elephant', scientific: 'Loxodonta africana' }, { name: 'Lion', scientific: 'Panthera leo' }, { name: 'Blue whale', scientific: 'Balaenoptera musculus' }, { name: 'Leopard', scientific: 'Panthera pardus' }],
  cameras: ['Canon EOS R5', 'NIKON Z 9', 'SONY ILCE-1', 'Canon EOS R3'], lenses: ['RF100-500mm F4.5-7.1 L IS USM', 'EF400mm f/2.8L IS III USM'],
};
const p = (q: string) => parseQuery(q, ctx);

describe('natural-language parser: deterministic, explained, local', () => {
  it('lions in Kenya in 2024 that I never posted → species, place, year, instagram; nothing left over', () => {
    const r = p('lions in Kenya in 2024 that I never posted');
    expect(r.filters).toMatchObject({ species: ['Lion'], location: ['Kenya'], year: [2024], ig: ['never'] }); expect(r.text).toBe('');
    expect(r.understood.map((u) => u.label).sort()).toEqual(['2024', 'Kenya', 'Lion', 'never posted']);
  });
  it('ratings, favourites and portfolio, in digits and words', () => {
    expect(p('5 star photos').filters.rating).toEqual([5]); expect(p('rated four stars').filters.rating).toEqual([4]); expect(p('4+ stars').filters.rating).toEqual([4, 5]); expect(p('three stars and up').filters.rating).toEqual([3, 4, 5]);
    expect(p('my best leopard photos').filters).toMatchObject({ rating: [4, 5], species: ['Leopard'] }); expect(p('unrated').filters.rating).toEqual([0]);
    expect(p('favourite portfolio shots').filters).toMatchObject({ favorite: true, portfolio: true }); expect(p('favorites').filters.favorite).toBe(true);
  });
  it('orientation words; "landscape" alone is a genre word, not an orientation', () => {
    expect(p('portrait lions').filters.orientation).toEqual(['portrait']); expect(p('horizontal elephants').filters.orientation).toEqual(['landscape']); expect(p('landscape orientation').filters.orientation).toEqual(['landscape']);
    expect(p('square crops').filters.orientation).toEqual(['square']);
    const g = p('misty landscape at dawn'); expect(g.filters.orientation).toEqual([]); expect(g.text).toBe('misty landscape dawn');
  });
  it('years, ranges, relative years and months', () => {
    expect(p('from 2021 to 2023').filters.year).toEqual([2021, 2022, 2023]); expect(p('since 2025').filters.year).toEqual([2025, 2026]); expect(p('before 1993').filters.year.at(-1)).toBe(1992);
    expect(p('last year').filters.year).toEqual([2025]); expect(p('this year').filters.year).toEqual([2026]); expect(p('in March 2024').filters).toMatchObject({ month: [3], year: [2024] });
    expect(p('between 2023 and 2021').filters.year).toEqual([2021, 2022, 2023]);
  });
  it('instagram wording: never / not yet / already posted', () => {
    for (const q of ['never posted', 'not posted yet', 'unposted', 'not been published', 'not on instagram', 'haven\'t posted']) expect(p(q).filters.ig, q).toEqual(['never']);
    for (const q of ['already posted', 'published', 'on instagram', 'shared on instagram']) expect(p(q).filters.ig, q).toEqual(['posted']);
  });
  it('species match singular, plural, multi-word and scientific names — and a species wins over a colour ("blue whale")', () => {
    expect(p('elephants').filters.species).toEqual(['African elephant']); expect(p('african elephant').filters.species).toEqual(['African elephant']); expect(p('panthera leo').filters.species).toEqual(['Lion']);
    const w = p('blue whales'); expect(w.filters.species).toEqual(['Blue whale']); expect(w.filters.colour).toEqual([]);
    expect(p('blue sky').filters.colour).toEqual(['blue']); expect(p('lions and leopards').filters.species.sort()).toEqual(['Leopard', 'Lion']);
  });
  it('places: longest name first ("South Africa" is not "Africa"), multi-word, only places that exist in the library', () => {
    expect(p('south africa sunrise').filters.location).toEqual(['South Africa']); expect(p('masai mara 2024').filters.location).toEqual(['Masai Mara']); expect(p('paris').filters.location).toEqual([]); expect(p('paris').text).toBe('paris');
  });
  it('equipment: a distinctive model token selects the camera; a lens by its focal range', () => {
    expect(p('shot on the r5').filters.camera).toEqual(['Canon EOS R5']); expect(p('Z 9 photos').filters.camera).toEqual(['NIKON Z 9']); expect(p('canon eos r3').filters.camera).toEqual(['Canon EOS R3']);
    expect(p('100-500mm').filters.lens).toEqual(['RF100-500mm F4.5-7.1 L IS USM']); expect(p('400mm').filters.lens).toEqual(['EF400mm f/2.8L IS III USM']);
    const two: SearchContext = { ...ctx, lenses: ['EF400mm f/2.8L IS III USM', 'NIKKOR Z 400mm f/2.8 TC VR S'] };
    expect(parseQuery('400mm', two).filters.lens).toEqual(two.lenses);                 // both 400 mm lenses, consumed once
  });
  it('looks: tones and colours map to the measured tags; they are reported as such', () => {
    const r = p('warm sharp high contrast amber'); expect(r.filters.tag.sort()).toEqual(['high contrast', 'sharp', 'warm tones']); expect(r.filters.colour).toEqual(['amber']);
    expect(p('dark moody').filters.tag).toEqual(['low-key exposure']); expect(p('black and white').filters.tag).toEqual(['near monochrome']);
  });
  it('whatever is not understood stays as words for full-text search; filler words are dropped', () => {
    expect(p('show me photos of lions hunting at sunset').text).toBe('hunting sunset');
    expect(p('  "golden   hour"  ').text).toBe('golden hour'); expect(p('').text).toBe(''); expect(p('the a an of').text).toBe('');
  });
  it('is stable and side-effect free: same input, same output; hostile input is just text', () => {
    expect(p('Lions in Kenya 2024')).toEqual(p('Lions in Kenya 2024'));
    const hostile = p("'; DROP TABLE photos; -- <script>alert(1)</script> %_\\"); expect(hostile.text).toContain('drop'); expect(hostile.filters.species).toEqual([]);
    expect(() => parseQuery('x'.repeat(5000) + ' lion', ctx)).not.toThrow();
  });
  it('regular-expression characters in library names cannot break matching', () => {
    const c: SearchContext = { ...ctx, locations: ['St. John (Island)', 'C++ Reef'], species: [{ name: 'Fox (red)', scientific: null }] };
    expect(parseQuery('st. john (island)', c).filters.location).toEqual(['St. John (Island)']); expect(parseQuery('fox (red)', c).filters.species).toEqual(['Fox (red)']);
  });
});

describe('local visual embedding', () => {
  const made: string[] = []; const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-emb-')); made.push(d); return d; };
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  it('looks-alike pictures are close, different pictures are far; deterministic; unit length; right size', async () => {
    const d = tmp();
    await makeJpeg(path.join(d, 'a.jpg'), { width: 800, height: 600, pattern: 3, color: { r: 40, g: 90, b: 140 } });
    await sharp(path.join(d, 'a.jpg')).resize(400, 300).jpeg({ quality: 60 }).toFile(path.join(d, 'a-small.jpg'));
    await sharp(path.join(d, 'a.jpg')).modulate({ brightness: 1.08 }).toFile(path.join(d, 'a-bright.jpg'));
    await makeJpeg(path.join(d, 'b.jpg'), { width: 800, height: 600, pattern: 41, color: { r: 200, g: 60, b: 30 } });
    await makeJpeg(path.join(d, 'c.jpg'), { width: 800, height: 600, pattern: 17, color: { r: 30, g: 180, b: 70 } });
    const [a, small, bright, b, c] = await Promise.all(['a.jpg', 'a-small.jpg', 'a-bright.jpg', 'b.jpg', 'c.jpg'].map((f) => embedFile(path.join(d, f))));
    expect(a!.length).toBe(LOCAL_EMBEDDING_DIMS); expect(Math.hypot(...a!)).toBeCloseTo(1, 4);
    expect(cosine(a!, small!)).toBeGreaterThan(0.97); expect(cosine(a!, bright!)).toBeGreaterThan(0.95);
    expect(cosine(a!, b!)).toBeLessThan(0.8); expect(cosine(a!, c!)).toBeLessThan(0.8); expect(cosine(a!, small!)).toBeGreaterThan(cosine(a!, b!) + 0.15);
    expect(await embedFile(path.join(d, 'a.jpg'))).toEqual(a);
    expect(toVectorLiteral(a!)).toMatch(/^\[-?\d/); expect(toVectorLiteral(a!).split(',').length).toBe(256);
  });
  it('honestly refuses to embed text', async () => {
    await expect(localEmbedding.embedText('a lion')).rejects.toBeInstanceOf(TextEmbeddingNotSupported);
    expect(localEmbedding).toMatchObject({ model: 'local-visual-v1', dimensions: 256 });
  });
});

describe('release 12 acceptance regressions (found on the real library)', () => {
  const real: SearchContext = { ...ctx, species: [...ctx.species, { name: 'small speckled bird', scientific: null }, { name: 'hummingbird', scientific: null }], cameras: ['SONY ILCE-7RM5', 'SONY ILCE-1M2', 'Apple iPhone 17 Pro', 'Apple iPhone 13 Pro'] };
  it('"birds" is the class of animal, not the one-off species "small speckled bird"', () => {
    const r = parseQuery('Show me photographs of birds', real);
    expect(r.filters.species).toEqual([]); expect(r.text).toBe('birds');
    expect(parseQuery('small speckled bird', real).filters.species).toEqual(['small speckled bird']);       // naming the species itself still works
    expect(parseQuery('elephants', ctx).filters.species).toEqual(['African elephant']);                      // other head nouns are unchanged
  });
  it('a bare camera make selects every camera of that make, and only those', () => {
    const r = parseQuery('Show photographs taken with my Sony camera', real);
    expect(r.filters.camera.sort()).toEqual(['SONY ILCE-1M2', 'SONY ILCE-7RM5']); expect(r.text).toBe('');
    expect(parseQuery('apple photos', real).filters.camera.length).toBe(2);
    expect(parseQuery('canon', ctx).filters.camera.sort()).toEqual(['Canon EOS R3', 'Canon EOS R5']);
    expect(parseQuery('canon eos r3', ctx).filters.camera).toEqual(['Canon EOS R3']);                          // a model still wins over its make
    expect(parseQuery('a sonya of rain', real).filters.camera).toEqual([]);                                    // whole words only
  });
});
