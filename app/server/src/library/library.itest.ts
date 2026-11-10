import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/password.js';
import { AuthService } from '../auth/service.js';
import { totpAt } from '../auth/totp.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { buildApp } from '../http/app.js';

const KEY = Buffer.alloc(32, 5), SECRET = Buffer.alloc(32, 6);
const HOST = '127.0.0.1:8480';
const PW = 'a long unusual passphrase 42';
const N = 45;                                  // user A's photographs
const NOW = Date.now();
let h: Handles | null; let app: FastifyInstance;
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); return h!; };

/** What photograph i looks like. The tests compute their expectations from this same specification. */
const spec = (i: number) => ({
  i, year: 2020 + (i % 2), location: ['Kenya', 'Norway', 'India'][i % 3]!, rating: i % 6, favorite: i % 5 === 0, portfolio: i % 7 === 0,
  undated: i % 9 === 0, orientation: (['portrait', 'landscape', 'square'] as const)[i % 3]!,
  w: [4000, 6000, 5000][i % 3]!, hgt: [6000, 4000, 5000][i % 3]!,
  camera: i === 6 ? 'NIKON Z 9' : i % 2 ? 'Canon EOS R5' : 'ILCE-1', make: i === 6 ? 'NIKON CORPORATION' : i % 2 ? 'Canon' : 'SONY', lens: i % 4 === 0 ? 'RF100-500mm F4.5-7.1 L IS USM' : 'FE 200-600mm F5.6-6.3 G OSS',
  ig: (['posted', 'possible', 'draft'] as const)[i % 8] ?? 'never', ai: (['analyzed', 'queued', 'failed', 'running'] as const)[i % 10] ?? 'none',
  capture: new Date(NOW - (i + 10) * 86_400_000), ingested: new Date(NOW - (40 + i) * 86_400_000), updated: new Date(NOW - ((i * 7) % N + 1) * 3_600_000),
  file: `img_${String(i).padStart(3, '0')}.jpg`,
  /** the CAPTURE year (null for undated photographs); `year` above is the FOLDER year */
  capYear: i % 9 === 0 ? null : new Date(NOW - (i + 10) * 86_400_000).getUTCFullYear(),
});
const specs = Array.from({ length: N }, (_, i) => spec(i));
const ids = new Map<number, string>();               // i -> photo id (user A)

async function seedPhotos(svc: Sql, userId: string, n: number, tag: string, synthetic = false) {
  const [root] = await svc<{ id: string }[]>`INSERT INTO library_roots (user_id, path) VALUES (${userId}, ${'/tmp/' + randomUUID()}) RETURNING id`;
  const [acct] = await svc<{ id: string }[]>`INSERT INTO social_accounts (user_id, platform, external_id, status) VALUES (${userId}, 'instagram', ${randomUUID()}, 'DISCONNECTED') RETURNING id`;
  for (let i = 0; i < n; i++) {
    const s = spec(i); const pid = randomUUID(), vid = randomUUID();
    await svc.begin(async (tx) => {
      await tx`INSERT INTO photos (id, user_id, current_version_id, title, title_source, capture_at, capture_at_source, year, year_source, trip_location, trip_location_source, rating, favorite, portfolio_candidate, updated_at)
               VALUES (${pid}, ${userId}, ${vid}, ${i % 4 === 0 ? `${tag} ${i}` : null}, ${i % 4 === 0 ? 'USER_DEFINED' : null}, ${s.undated ? null : s.capture}, ${s.undated ? null : 'EXIF'}, ${s.year}, 'FOLDER_DERIVED', ${s.location}, 'FOLDER_DERIVED',
                       ${s.rating}, ${s.favorite}, ${s.portfolio}, ${s.updated})`;
      await tx`INSERT INTO photo_versions (id, user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256, width, height, bytes, state, camera_make, camera_model, lens, ingested_at, exif, deriv_status)
               VALUES (${vid}, ${userId}, ${pid}, 1, ${root!.id}, ${`${s.year}/${s.location}/${tag}_${s.file}`}, ${randomBytes(32)}, ${s.w}, ${s.hgt}, 9000000, 'ACTIVE', ${s.make}, ${s.camera}, ${s.lens}, ${s.ingested},
                       ${synthetic ? tx.json({ synthetic: { fixture: 'p01', i } }) : null}, ${synthetic ? 'READY' : 'PENDING'})`;
      if (s.ig === 'posted' || s.ig === 'possible') {
        const [post] = await tx<{ id: string }[]>`INSERT INTO social_posts (user_id, social_account_id, platform_post_id, posted_at, caption) VALUES (${userId}, ${acct!.id}, ${randomUUID()}, ${new Date(NOW - 86_400_000)}, 'c') RETURNING id`;
        const [med] = await tx<{ id: string }[]>`INSERT INTO social_post_media (user_id, social_post_id, position) VALUES (${userId}, ${post!.id}, 0) RETURNING id`;
        await tx`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, state, decided_by, decided_at) VALUES (${userId}, ${med!.id}, ${pid}, ${s.ig === 'posted' ? 'USER_CONFIRMED' : 'POSSIBLE_MATCH'}, ${s.ig === 'posted' ? 'USER' : 'SYSTEM'}, ${s.ig === 'posted' ? new Date() : null})`;
      }
      if (s.ig === 'draft') await tx`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id, caption_body, state) VALUES (${userId}, ${pid}, ${vid}, 'draft', 'DRAFT')`;
      if (s.ai === 'analyzed') await tx`INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode, description) VALUES (${userId}, ${vid}, 'mock', 'mock-vision', 't', 'mock', 'synthetic')`;
      if (s.ai === 'queued') await tx`INSERT INTO jobs (user_id, kind, payload, state) VALUES (${userId}, 'ai.analyze', ${tx.json({ photoId: pid })}, 'QUEUED')`;
      if (s.ai === 'running') await tx`INSERT INTO jobs (user_id, kind, payload, state, locked_by, locked_until) VALUES (${userId}, 'ai.analyze', ${tx.json({ photoId: pid })}, 'RUNNING', 'w', ${new Date(NOW + 3_600_000)})`;
      if (s.ai === 'failed') await tx`INSERT INTO jobs (user_id, kind, payload, state, last_error) VALUES (${userId}, 'ai.analyze', ${tx.json({ photoId: pid })}, 'FAILED', 'x')`;
    });
    if (tag === 'A') ids.set(i, pid);
  }
}

const nowMs = Date.now();
let ipCounter = 0;
class Client {
  jar = new Map<string, string>(); csrf: string | undefined; ip = `10.60.0.${++ipCounter}`;
  async req(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, o: { csrf?: string | false; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { host: HOST, 'user-agent': 'vitest' };
    if (method !== 'GET') { headers.origin = `http://${HOST}`; if (payload !== undefined) headers['content-type'] = 'application/json'; }
    Object.assign(headers, o.headers);
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = o.csrf === undefined ? this.csrf : o.csrf;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    const res = await app.inject({ method, url, headers, payload: payload as object, remoteAddress: this.ip });
    for (const c of [].concat((res.headers['set-cookie'] ?? []) as never) as string[]) { const [kv] = c.split('; '); const [k, v] = kv!.split('='); if (v) this.jar.set(k!, v); }
    return res;
  }
  async signIn(email: string) {
    const l = (await this.req('POST', '/api/auth/login', { email, password: PW })).json();
    const s = (await this.req('POST', '/api/auth/totp/setup', { challenge: l.challenge })).json();
    const c = await this.req('POST', '/api/auth/totp/confirm', { challenge: l.challenge, code: totpAt(s.secret, nowMs) });
    expect(c.statusCode).toBe(200);
    this.csrf = (await this.req('GET', '/api/auth/me')).json().csrfToken;
    return this;
  }
  async list(qs = '') { const r = await this.req('GET', `/api/library/photos${qs ? '?' + qs : ''}`); expect(r.statusCode).toBe(200); return r.json() as { items: Array<Record<string, any>>; nextCursor: string | null; total?: number }; } // eslint-disable-line @typescript-eslint/no-explicit-any
  /** follow cursors to the end */
  async all(qs: string, limit = 7) {
    const out: Array<Record<string, any>> = []; let cursor: string | null = null; let pages = 0; let total: number | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    do {
      const r = await this.list(`${qs}${qs ? '&' : ''}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      if (pages === 0) total = r.total; else expect(r.total).toBeUndefined();
      out.push(...r.items); cursor = r.nextCursor; pages++;
    } while (cursor && pages < 100);
    return { items: out, pages, total };
  }
}

let A: Client, B: Client, idsB: string[] = [];
beforeAll(async () => {
  h = await tryHandles();
  if (!h) return;
  await wipe(h.svc);
  const auth = new AuthService({ sql: h.app, sessionSecret: SECRET, atRestKey: KEY, now: () => nowMs });
  app = buildApp({ config: { logLevel: 'silent', allowedHosts: ['127.0.0.1', 'localhost'], cookieSecure: 'auto', webDir: null, derivativesDir: null, syntheticMedia: true }, sql: h.app, auth, sessionSecret: SECRET, now: () => nowMs });
  const mk = async (email: string) => { const [u] = await h!.svc<{ id: string }[]>`INSERT INTO users (email, password_hash) VALUES (${email}, ${await hashPassword(PW)}) RETURNING id`; return u!.id; };
  const [ua, ub] = [await mk('a@example.test'), await mk('b@example.test')];
  await seedPhotos(h.svc, ua, N, 'A');
  await seedPhotos(h.svc, ub, 12, 'B');
  idsB = (await h.svc<{ id: string }[]>`SELECT id FROM photos WHERE user_id = ${ub}`).map((r) => r.id);
  A = await new Client().signIn('a@example.test'); B = await new Client().signIn('b@example.test');
}, 120_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });

const idsOf = (items: Array<{ id?: unknown }>) => items.map((x) => x.id as string);
const expectIds = (is: number[]) => is.map((i) => ids.get(i)!);

describe('authentication and authorisation', () => {
  it('every Library endpoint refuses an anonymous caller', async (ctx) => {
    need(ctx);
    const anon = new Client();
    const pid = ids.get(0)!;
    for (const [m, u, body] of [
      ['GET', '/api/library/photos'], ['GET', '/api/library/facets'], ['GET', `/api/library/photos/${pid}`], ['GET', `/api/library/photos/${pid}/image`],
      ['PATCH', `/api/library/photos/${pid}`, { rating: 1 }], ['POST', '/api/library/photos/bulk', { target: { ids: [pid] }, set: { rating: 1 } }],
      ['GET', '/api/library/preferences'], ['PUT', '/api/library/preferences', {}],
    ] as Array<['GET' | 'PATCH' | 'POST' | 'PUT', string, unknown?]>) {
      const r = await anon.req(m, u, body);
      expect(r.statusCode, `${m} ${u}`).toBe(401);
    }
  });

  it('state-changing calls need the CSRF header', async (ctx) => {
    need(ctx);
    const pid = ids.get(1)!;
    expect((await A.req('PATCH', `/api/library/photos/${pid}`, { rating: 5 }, { csrf: false })).statusCode).toBe(403);
    expect((await A.req('POST', '/api/library/photos/bulk', { target: { ids: [pid] }, set: { rating: 5 } }, { csrf: false })).statusCode).toBe(403);
    expect((await A.req('PATCH', `/api/library/photos/${pid}`, { rating: 5 }, { headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await A.list('limit=300')).items.find((x) => x.id === pid)!.rating).toBe(spec(1).rating);   // nothing changed
  });

  it('a user never sees, reads, edits or serves another user’s photographs', async (ctx) => {
    need(ctx);
    const mine = (await A.all('')).items; const theirs = (await B.all('')).items;
    expect(mine.length).toBe(N); expect(theirs.length).toBe(12);
    expect(new Set([...idsOf(mine), ...idsOf(theirs)]).size).toBe(N + 12);          // disjoint
    const foreign = idsB[0]!;
    const foreignBefore = (await h!.svc<{ favorite: boolean }[]>`SELECT favorite FROM photos WHERE id = ${foreign}`)[0]!.favorite;
    expect((await A.req('GET', `/api/library/photos/${foreign}`)).statusCode).toBe(404);
    expect((await A.req('GET', `/api/library/photos/${foreign}/image`)).statusCode).toBe(404);
    expect((await A.req('PATCH', `/api/library/photos/${foreign}`, { rating: 5 })).statusCode).toBe(404);
    const bulk = await A.req('POST', '/api/library/photos/bulk', { target: { ids: [foreign, ids.get(2)!] }, set: { favorite: true } });
    expect(bulk.json().updated).toBe(1);                                              // only my own id was touched
    const after = await h!.svc<{ favorite: boolean }[]>`SELECT favorite FROM photos WHERE id = ${foreign}`;
    expect(after[0]!.favorite).toBe(foreignBefore);                                   // unchanged
    // "everything matching this filter" cannot reach another user's rows either
    const q = await A.req('POST', '/api/library/photos/bulk', { target: { query: { view: 'all' }, exclude: [] }, set: { portfolio: true } });
    expect(q.json().updated).toBe(N);
    const bPort = await h!.svc<{ n: string }[]>`SELECT count(*) AS n FROM photos WHERE id = ANY(${idsB}::uuid[]) AND portfolio_candidate`;
    expect(Number(bPort[0]!.n)).toBe(specs.slice(0, 12).filter((s) => s.portfolio).length);
    // restore user A
    for (const s of specs) await h!.svc`UPDATE photos SET favorite = ${s.favorite}, portfolio_candidate = ${s.portfolio} WHERE id = ${ids.get(s.i)!}`;
  });

  it('the API role cannot see another user’s rows even without the application query (row-level security)', async (ctx) => {
    const hh = need(ctx);
    const [ua] = await hh.svc<{ id: string }[]>`SELECT id FROM users WHERE email = 'a@example.test'`;
    const { withUser } = await import('../db/connect.js');
    const n = await withUser(hh.app, ua!.id, async (tx) => Number((await tx`SELECT count(*) AS n FROM photos`)[0]!.n));
    expect(n).toBe(N);
  });
});

describe('pagination', () => {
  it('walks the whole library with keyset cursors: no gaps, no duplicates, total only on the first page', async (ctx) => {
    need(ctx);
    const r = await A.all('', 7);
    expect(r.items.length).toBe(N); expect(new Set(idsOf(r.items)).size).toBe(N);
    expect(r.pages).toBe(Math.ceil(N / 7)); expect(r.total).toBe(N);
  });
  it('a page is at most the requested size and the last page has no cursor', async (ctx) => {
    need(ctx);
    const p1 = await A.list('limit=20');
    expect(p1.items.length).toBe(20); expect(p1.nextCursor).toBeTruthy(); expect(p1.total).toBe(N);
    const last = await A.list('limit=300'); expect(last.items.length).toBe(N); expect(last.nextCursor).toBeNull();
  });
  it('rejects bad cursors, unknown parameters and oversize pages', async (ctx) => {
    need(ctx);
    expect((await A.req('GET', '/api/library/photos?cursor=not-a-cursor')).statusCode).toBe(400);
    expect((await A.req('GET', '/api/library/photos?limit=301')).statusCode).toBe(400);
    expect((await A.req('GET', '/api/library/photos?limit=0')).statusCode).toBe(400);
    expect((await A.req('GET', '/api/library/photos?drop=table')).statusCode).toBe(400);
    expect((await A.req('GET', '/api/library/photos?sort=password')).statusCode).toBe(400);
    expect((await A.req('GET', '/api/library/photos?year=abc')).statusCode).toBe(400);
  });
  it('stays consistent when photographs change while paging (keyset, not offset)', async (ctx) => {
    need(ctx);
    const first = await A.list('sort=captured&dir=desc&limit=10');
    const everything = idsOf((await A.list('sort=captured&dir=desc&limit=300')).items);
    const laterRow = everything[20]!;                               // currently on a later page (a dated photograph)
    await h!.svc`UPDATE photos SET capture_at = now() WHERE id = ${laterRow}`;     // it now sorts BEFORE the cursor, like a newly imported photograph would
    const rest = idsOf((await A.list(`sort=captured&dir=desc&limit=300&cursor=${first.nextCursor}`)).items);
    expect(rest.some((id) => idsOf(first.items).includes(id))).toBe(false);          // an OFFSET query would now repeat a row from page 1
    expect(rest).not.toContain(laterRow);
    expect(rest.length).toBe(N - 10 - 1);
    const spec40 = specs.find((s) => ids.get(s.i) === laterRow)!;
    await h!.svc`UPDATE photos SET capture_at = ${spec40.undated ? null : spec40.capture} WHERE id = ${laterRow}`;
  });
});

describe('sorting', () => {
  const cmp = <T,>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);
  /** expected order for a sort key (ties broken by id, undated last) */
  const expected = (sort: string, dir: 'asc' | 'desc') => {
    if (sort === 'modified') return null;
    const sign = dir === 'asc' ? 1 : -1;
    const keyOf = (s: ReturnType<typeof spec>): number | string | null =>
      sort === 'captured' ? (s.undated ? null : s.capture.getTime()) : sort === 'imported' ? s.ingested.getTime() : sort === 'filename' ? `a_${s.file}` : sort === 'rating' ? s.rating : s.updated.getTime();
    return [...specs].sort((x, y) => {
      const kx = keyOf(x), ky = keyOf(y);
      if (kx === null || ky === null) return kx === ky ? sign * cmp(ids.get(x.i)!, ids.get(y.i)!) : kx === null ? 1 : -1;     // nulls last either way
      const c = cmp(kx, ky); return c !== 0 ? sign * c : sign * cmp(ids.get(x.i)!, ids.get(y.i)!);
    }).map((s) => ids.get(s.i)!);
  };
  for (const sort of ['captured', 'imported', 'filename', 'rating', 'modified']) {
    for (const dir of ['asc', 'desc'] as const) {
      it(`${sort} ${dir}: whole-library order is exact across pages`, async (ctx) => {
        need(ctx);
        const r = await A.all(`sort=${sort}&dir=${dir}`, 8);
        if (sort === 'modified') {      // earlier tests legitimately touched updated_at: PostgreSQL itself is the reference
          const ref = dir === 'asc' ? await h!.svc<{ id: string }[]>`SELECT id FROM photos WHERE user_id = (SELECT user_id FROM photos WHERE id = ${ids.get(0)!}) AND NOT hidden AND deleted_at IS NULL ORDER BY updated_at ASC, id ASC`
                                    : await h!.svc<{ id: string }[]>`SELECT id FROM photos WHERE user_id = (SELECT user_id FROM photos WHERE id = ${ids.get(0)!}) AND NOT hidden AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`;
          expect(idsOf(r.items)).toEqual(ref.map((x) => x.id));
        } else expect(idsOf(r.items)).toEqual(expected(sort, dir));
      });
    }
  }
  it('undated photographs sort last in both directions', async (ctx) => {
    need(ctx);
    for (const dir of ['asc', 'desc']) {
      const r = (await A.all(`sort=captured&dir=${dir}`, 9)).items;
      const undatedCount = specs.filter((s) => s.undated).length;
      expect(r.slice(-undatedCount).every((x) => x.captureAt === null)).toBe(true);
      expect(r.slice(0, N - undatedCount).every((x) => x.captureAt !== null)).toBe(true);
    }
  });
});

describe('filtering and views', () => {
  const idx = (f: (s: ReturnType<typeof spec>) => boolean) => specs.filter(f).map((s) => s.i);
  const check = async (qs: string, want: number[]) => {
    const r = await A.all(qs, 6);
    expect(new Set(idsOf(r.items))).toEqual(new Set(expectIds(want)));
    expect(r.total).toBe(want.length);
  };
  it('predefined views', async (ctx) => {
    need(ctx);
    await check('view=favorites', idx((s) => s.favorite));
    await check('view=rated', idx((s) => s.rating > 0));
    await check('view=portfolio', idx((s) => s.portfolio));
    await check('view=published', idx((s) => s.ig === 'posted'));
    await check('view=never', idx((s) => s.ig !== 'posted'));
    await check('view=unreviewed', idx((s) => s.rating === 0 && !s.favorite && !s.portfolio));
    await check('view=recent', []);                                                // everything was imported 40+ days ago
  });
  it('year, location, rating, favourite and portfolio filters, singly and combined', async (ctx) => {
    need(ctx);
    const years = [...new Set(specs.map((s) => s.capYear).filter((y): y is number => y !== null))];
    for (const y of years) await check(`year=${y}`, idx((s) => s.capYear === y));                 // CAPTURE year; undated photographs never match
    await check(`year=${years.join('&year=')}`, idx((s) => s.capYear !== null));
    await check('folderYear=2021', idx((s) => s.year === 2021));                                   // the folder year is a separate filter
    await check('folderYear=2020&folderYear=2021', idx(() => true));
    await check('location=Norway', idx((s) => s.location === 'Norway'));
    await check('location=Norway&location=India', idx((s) => s.location !== 'Kenya'));
    await check('rating=0', idx((s) => s.rating === 0));
    await check('rating=4&rating=5', idx((s) => s.rating >= 4));
    await check('favorite=true', idx((s) => s.favorite));
    await check('favorite=false', idx((s) => !s.favorite));
    await check('portfolio=true&folderYear=2020', idx((s) => s.portfolio && s.year === 2020));
    await check('folderYear=2021&location=Kenya&rating=3&rating=4&favorite=false', idx((s) => s.year === 2021 && s.location === 'Kenya' && [3, 4].includes(s.rating) && !s.favorite));
  });
  it('orientation, camera and lens filters', async (ctx) => {
    need(ctx);
    await check('orientation=portrait', idx((s) => s.orientation === 'portrait'));
    await check('orientation=landscape&orientation=square', idx((s) => s.orientation !== 'portrait'));
    await check('camera=Canon%20EOS%20R5', idx((s) => s.camera === 'Canon EOS R5'));
    await check('camera=NIKON%20Z%209', [6]);                                             // “NIKON CORPORATION” + “NIKON Z 9” is labelled “NIKON Z 9”
    await check('camera=SONY%20ILCE-1', idx((s) => s.camera === 'ILCE-1'));                // label = make + model unless the model already starts with the make
    await check('lens=RF100-500mm%20F4.5-7.1%20L%20IS%20USM', idx((s) => s.lens.startsWith('RF100')));
    await check('camera=Canon%20EOS%20R5&orientation=square&folderYear=2021', idx((s) => s.camera === 'Canon EOS R5' && s.orientation === 'square' && s.year === 2021));
  });
  it('Instagram filters (posted / never / possible duplicate / draft)', async (ctx) => {
    need(ctx);
    await check('ig=posted', idx((s) => s.ig === 'posted'));
    await check('ig=never', idx((s) => s.ig !== 'posted'));
    await check('ig=possible', idx((s) => s.ig === 'possible'));
    await check('ig=draft', idx((s) => s.ig === 'draft'));
    await check('ig=posted&ig=possible', idx((s) => s.ig === 'posted' || s.ig === 'possible'));
    const dup = (await A.list('ig=possible&limit=50')).items;
    expect(dup.every((x) => x.ig.possibleDuplicate && x.ig.state === 'NEVER_POSTED')).toBe(true);
    const posted = (await A.list('ig=posted&limit=50')).items;
    expect(posted.every((x) => x.ig.state === 'POSTED' && x.ig.count === 1)).toBe(true);
  });
  it('AI processing filters', async (ctx) => {
    need(ctx);
    await check('ai=analyzed', idx((s) => s.ai === 'analyzed'));
    await check('ai=queued', idx((s) => s.ai === 'queued' || s.ai === 'running'));
    await check('ai=failed', idx((s) => s.ai === 'failed'));
    await check('ai=none', idx((s) => s.ai === 'none'));
    const items = (await A.list('limit=300')).items;
    for (const s of specs) expect(items.find((x) => x.id === ids.get(s.i))!.ai).toBe(s.ai === 'running' ? 'queued' : s.ai);
  });
  it('text search matches title, file path and location', async (ctx) => {
    need(ctx);
    await check('q=A%208', [8]);                                                           // the user-defined title “A 8”
    await check('q=img_01', idx((s) => s.file.startsWith('img_01')));
    await check('q=norway', idx((s) => s.location === 'Norway'));
    await check('q=%25', idx(() => false));                                                // % is literal, not a wildcard
  });
  it('hidden and deleted photographs are not part of the library', async (ctx) => {
    need(ctx);
    const pid = ids.get(3)!;
    await h!.svc`UPDATE photos SET hidden = true WHERE id = ${pid}`;
    expect((await A.all('')).items.length).toBe(N - 1);
    await h!.svc`UPDATE photos SET hidden = false, deleted_at = now() WHERE id = ${pid}`;
    expect((await A.all('')).items.length).toBe(N - 1);
    expect((await A.req('GET', `/api/library/photos/${pid}`)).statusCode).toBe(404);
    await h!.svc`UPDATE photos SET deleted_at = NULL WHERE id = ${pid}`;
    expect((await A.all('')).items.length).toBe(N);
  });
  it('the recent view shows what was imported in the last 30 days', async (ctx) => {
    need(ctx);
    const pid = ids.get(4)!;
    await h!.svc`UPDATE photo_versions SET ingested_at = now() - interval '2 days' WHERE photo_id = ${pid}`;
    const r = await A.all('view=recent');
    expect(idsOf(r.items)).toEqual([pid]);
    await h!.svc`UPDATE photo_versions SET ingested_at = ${specs[4]!.ingested} WHERE photo_id = ${pid}`;
  });
  it('facets list what exists, with counts, from the database', async (ctx) => {
    need(ctx);
    const f = (await A.req('GET', '/api/library/facets')).json();
    expect(f.total).toBe(N);
    const capYears = [...new Set(specs.map((s) => s.capYear).filter((y): y is number => y !== null))].sort((a, b) => b - a);
    expect(f.years.map((y: { value: number; n: number }) => [y.value, y.n])).toEqual(capYears.map((y) => [y, idx((s) => s.capYear === y).length]));        // capture years: undated photographs are in no year
    expect(f.folderYears.map((y: { value: number; n: number }) => [y.value, y.n])).toEqual([[2021, idx((s) => s.year === 2021).length], [2020, idx((s) => s.year === 2020).length]]);
    expect(f.locations.map((l: { value: string }) => l.value).sort()).toEqual(['India', 'Kenya', 'Norway']);
    expect(f.cameras.map((c: { value: string }) => c.value).sort()).toEqual(['Canon EOS R5', 'NIKON Z 9', 'SONY ILCE-1']);
    expect(f.lenses.length).toBe(2); expect(f.possibleDuplicates).toBe(idx((s) => s.ig === 'possible').length);
  });
  it('facets are cached between changes but never stale: hiding or restoring a photograph is visible at once', async (ctx) => {
    need(ctx);
    const pid = ids.get(4)!;
    const first = (await A.req('GET', '/api/library/facets')).json(); const again = (await A.req('GET', '/api/library/facets')).json();
    expect(again).toEqual(first);
    await h!.svc`UPDATE photos SET hidden = true WHERE id = ${pid}`;
    try { expect((await A.req('GET', '/api/library/facets')).json().total).toBe(first.total - 1); }
    finally { await h!.svc`UPDATE photos SET hidden = false WHERE id = ${pid}`; }
    expect((await A.req('GET', '/api/library/facets')).json().total).toBe(first.total);
  });
});

describe('photograph data', () => {
  it('list items carry what the grid needs and nothing invented', async (ctx) => {
    need(ctx);
    const it0 = (await A.list('limit=300')).items.find((x) => x.id === ids.get(8)!)!;
    const s = spec(8);
    expect(it0).toMatchObject({ width: s.w, height: s.hgt, orientation: s.orientation, rating: s.rating, favorite: s.favorite, portfolio: s.portfolio, year: s.capYear, folderYear: s.year, location: s.location, synthetic: false, filename: `A_${s.file}` });
    expect(it0.title).toBe(`A ${8}`);                                  // user-defined title wins; otherwise the file name
    expect((await A.list('limit=300')).items.find((x) => x.id === ids.get(1)!)!.title).toBe(`A_${spec(1).file}`);
  });
  it('detail returns EXIF, path, import date, provenance and the Instagram/AI blocks', async (ctx) => {
    need(ctx);
    const d = (await A.req('GET', `/api/library/photos/${ids.get(12)!}`)).json();
    const s = spec(12);
    expect(d).toMatchObject({ relativePath: `${s.year}/${s.location}/A_${s.file}`, width: s.w, height: s.hgt, orientation: s.orientation, bytes: 9000000, location: s.location, captureAtSource: s.undated ? null : 'EXIF' });
    expect(d.exif).toMatchObject({ camera: s.camera === 'ILCE-1' ? 'SONY ILCE-1' : 'Canon EOS R5', lens: s.lens, iso: null, gps: null });
    expect(d.importedAt).toBe(s.ingested.toISOString());
    expect(d.title).toBe('A 12');
    expect(d.ig.state).toBe('NEVER_POSTED'); expect(d.collections).toEqual([]); expect(d.ai.status).toBe('failed');
    const posted = (await A.req('GET', `/api/library/photos/${ids.get(0)!}`)).json();
    expect(posted.ig).toMatchObject({ state: 'POSTED', count: 1 }); expect(posted.history.length).toBe(1);
    expect(posted.ai.status).toBe('analyzed'); expect(posted.ai.analysis.mode).toBe('mock');
    expect((await A.req('GET', `/api/library/photos/not-a-uuid`)).statusCode).toBe(400);
  });
});

describe('rating, favourite and portfolio updates', () => {
  it('updates one photograph and bumps “modified”', async (ctx) => {
    need(ctx);
    const pid = ids.get(10)!;
    const before = (await A.req('GET', `/api/library/photos/${pid}`)).json();
    expect((await A.req('PATCH', `/api/library/photos/${pid}`, { rating: 5, favorite: true, portfolio: true })).statusCode).toBe(200);
    const after = (await A.req('GET', `/api/library/photos/${pid}`)).json();
    expect(after).toMatchObject({ rating: 5, favorite: true, portfolio: true });
    expect(new Date(after.modifiedAt).getTime()).toBeGreaterThan(new Date(before.modifiedAt).getTime());
    await A.req('PATCH', `/api/library/photos/${pid}`, { rating: before.rating, favorite: before.favorite, portfolio: before.portfolio });
  });
  it('validates input', async (ctx) => {
    need(ctx);
    const pid = ids.get(10)!;
    for (const bad of [{ rating: 6 }, { rating: -1 }, { rating: 2.5 }, { rating: '3' }, { favorite: 'yes' }, {}, { title: 'x' }, { rating: 3, deleted: true }])
      expect((await A.req('PATCH', `/api/library/photos/${pid}`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
  });
  it('bulk: explicit ids', async (ctx) => {
    need(ctx);
    const pick = [11, 12, 13].map((i) => ids.get(i)!);
    const r = await A.req('POST', '/api/library/photos/bulk', { target: { ids: pick }, set: { rating: 4, favorite: true } });
    expect(r.json().updated).toBe(3);
    const rows = await h!.svc<{ rating: number; favorite: boolean }[]>`SELECT rating, favorite FROM photos WHERE id = ANY(${pick}::uuid[])`;
    expect(rows.every((x) => x.rating === 4 && x.favorite)).toBe(true);
    for (const i of [11, 12, 13]) await h!.svc`UPDATE photos SET rating = ${spec(i).rating}, favorite = ${spec(i).favorite} WHERE id = ${ids.get(i)!}`;
  });
  it('bulk: “select all in results” applies to the filtered set minus the exclusions, server-side', async (ctx) => {
    need(ctx);
    const want = specs.filter((s) => s.location === 'India').map((s) => s.i);
    const exclude = [want[0]!, want[1]!].map((i) => ids.get(i)!);
    const r = await A.req('POST', '/api/library/photos/bulk', { target: { query: { view: 'all', location: ['India'] }, exclude }, set: { rating: 5 } });
    expect(r.json().updated).toBe(want.length - 2);
    const rows = await h!.svc<{ id: string; rating: number }[]>`SELECT id, rating FROM photos WHERE id = ANY(${want.map((i) => ids.get(i)!)}::uuid[])`;
    for (const row of rows) expect(row.rating).toBe(exclude.includes(row.id) ? spec(want.find((i) => ids.get(i) === row.id)!).rating : 5);
    const others = await h!.svc<{ n: string }[]>`SELECT count(*) AS n FROM photos p WHERE p.user_id = (SELECT user_id FROM photos WHERE id = ${exclude[0]!}) AND p.trip_location <> 'India' AND p.rating = 5`;
    expect(Number(others[0]!.n)).toBe(specs.filter((s) => s.location !== 'India' && s.rating === 5).length);   // other locations untouched
    for (const i of want) await h!.svc`UPDATE photos SET rating = ${spec(i).rating} WHERE id = ${ids.get(i)!}`;
  });
  it('bulk validation: empty set, too many ids, malformed targets', async (ctx) => {
    need(ctx);
    const pid = ids.get(5)!;
    const bad = [
      { target: { ids: [pid] }, set: {} }, { target: { ids: [] }, set: { rating: 1 } }, { target: { ids: Array(501).fill(pid) }, set: { rating: 1 } },
      { target: { ids: ['x'] }, set: { rating: 1 } }, { target: { query: { year: ['x'] }, exclude: [] }, set: { rating: 1 } }, { target: { ids: [pid], query: {} }, set: { rating: 1 } }, { set: { rating: 1 } },
    ];
    for (const b of bad) expect((await A.req('POST', '/api/library/photos/bulk', b)).statusCode, JSON.stringify(b).slice(0, 60)).toBe(400);
  });
});

describe('preferences', () => {
  it('persist view, sort and filters per user', async (ctx) => {
    need(ctx);
    const prefs = { view: 'favorites', sort: 'rating', dir: 'asc', filters: { year: [2021], orientation: ['portrait'] } };
    expect((await A.req('PUT', '/api/library/preferences', prefs)).statusCode).toBe(200);
    expect((await A.req('GET', '/api/library/preferences')).json()).toMatchObject(prefs);
    expect((await B.req('GET', '/api/library/preferences')).json()).toMatchObject({ view: 'all', sort: 'captured', dir: 'desc' });     // not shared
    expect((await A.req('PUT', '/api/library/preferences', { view: 'bogus' })).statusCode).toBe(400);
    expect((await A.req('PUT', '/api/library/preferences', { ...prefs, extra: 1 })).statusCode).toBe(400);
  });
});

describe('image delivery', () => {
  it('serves a synthetic photograph to its owner only, with private caching and ETag', async (ctx) => {
    const hh = need(ctx);
    const [ua] = await hh.svc<{ id: string }[]>`SELECT id FROM users WHERE email = 'a@example.test'`;
    // a synthetic photograph for A (fixture p01) and a "real" one without a preview
    const [syn] = await hh.svc<{ id: string }[]>`SELECT photo_id AS id FROM photo_versions WHERE user_id = ${ua!.id} LIMIT 1`;
    await hh.svc`UPDATE photo_versions SET exif = ${hh.svc.json({ synthetic: { fixture: 'p01', i: 0 } })}, deriv_status = 'READY' WHERE photo_id = ${syn!.id}`;
    const r = await A.req('GET', `/api/library/photos/${syn!.id}/image?size=thumb`);
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(r.headers['cache-control']).toBe('private, max-age=3600'); expect(r.headers.etag).toBeTruthy();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await A.req('GET', `/api/library/photos/${syn!.id}/image`, undefined, { headers: { 'if-none-match': String(r.headers.etag) } })).statusCode).toBe(304);
    expect((await B.req('GET', `/api/library/photos/${syn!.id}/image`)).statusCode).toBe(404);
    expect((await A.req('GET', `/api/library/photos/${syn!.id}/image?size=huge`)).statusCode).toBe(400);
    const real = ids.get(20)!;
    const nr = await A.req('GET', `/api/library/photos/${real}/image`);
    expect(nr.statusCode).toBe(404); expect(nr.json().error).toBe('no_preview');
    await hh.svc`UPDATE photo_versions SET exif = ${hh.svc.json({ synthetic: { fixture: '../../etc/passwd', i: 0 } })} WHERE photo_id = ${real}`;
    expect((await A.req('GET', `/api/library/photos/${real}/image`)).statusCode).toBe(404);   // fixture ids are validated; no path comes from data or request
    await hh.svc`UPDATE photo_versions SET exif = NULL WHERE photo_id IN (${syn!.id}, ${real})`;
  });
  it('production configuration never serves synthetic fixtures', async (ctx) => {
    const hh = need(ctx);
    const auth = new AuthService({ sql: hh.app, sessionSecret: SECRET, atRestKey: KEY, now: () => nowMs });
    const prod = buildApp({ config: { logLevel: 'silent', allowedHosts: ['127.0.0.1'], cookieSecure: 'auto', webDir: null, derivativesDir: null, syntheticMedia: false }, sql: hh.app, auth, sessionSecret: SECRET });
    const [ua] = await hh.svc<{ id: string }[]>`SELECT id FROM users WHERE email = 'a@example.test'`;
    const [v] = await hh.svc<{ photo_id: string }[]>`SELECT photo_id FROM photo_versions WHERE user_id = ${ua!.id} LIMIT 1`;
    await hh.svc`UPDATE photo_versions SET exif = ${hh.svc.json({ synthetic: { fixture: 'p01', i: 0 } })} WHERE photo_id = ${v!.photo_id}`;
    const cookie = [...A.jar].map(([k, x]) => `${k}=${x}`).join('; ');
    const res = await prod.inject({ method: 'GET', url: `/api/library/photos/${v!.photo_id}/image`, headers: { host: HOST, cookie }, remoteAddress: '10.60.9.9' });
    expect(res.statusCode).toBe(404);
    await hh.svc`UPDATE photo_versions SET exif = NULL WHERE photo_id = ${v!.photo_id}`;
    await prod.close();
  });
});
