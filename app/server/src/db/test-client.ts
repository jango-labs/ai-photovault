import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { expect } from 'vitest';
import { hashPassword } from '../auth/password.js';
import { AuthService } from '../auth/service.js';
import { totpAt } from '../auth/totp.js';
import { Geocoder, geocoderConfigFromEnv } from '../geo/geocoder.js';
import { buildApp } from '../http/app.js';
import type { Handles } from './testdb.js';

/** Shared helpers for API-level integration tests: an app on the test database, signed-in cookie-jar clients, and photograph seeding. */
export const TEST_PW = 'a long unusual passphrase 42';
const KEY = Buffer.alloc(32, 5), SECRET = Buffer.alloc(32, 6);
export const TEST_HOST = '127.0.0.1:8480';
let ip = 0;

export function makeApp(h: Handles, config: Partial<{ webDir: string | null; derivativesDir: string | null; syntheticMedia: boolean; stateDir: string; ingestDir: string | null; igMediaDir: string | null; instagramOAuth: import('../instagram/oauth.js').IgOAuthConfig | null; dataRoot: import('../storage/dataRoot.js').DataRoot | null }> = {}, extra: { routeSink?: (r: { method: string; url: string }) => void; geocoder?: Geocoder } = {}): FastifyInstance {
  const auth = new AuthService({ sql: h.app, sessionSecret: SECRET, atRestKey: KEY, now: () => Date.now() });
  return buildApp({ config: { logLevel: process.env.DEBUG_API ? 'error' : 'silent', allowedHosts: ['127.0.0.1', 'localhost'], cookieSecure: 'auto', webDir: null, derivativesDir: null, syntheticMedia: true, atRestKey: KEY, ...config }, sql: h.app, auth, sessionSecret: SECRET, ...extra, geocoder: extra.geocoder ?? new Geocoder(h.app, { ...geocoderConfigFromEnv(), enabled: false }) });   // tests never reach the real service unless they inject a fake transport
}

export async function makeUser(svc: Sql, email: string): Promise<string> {
  const [u] = await svc<{ id: string }[]>`INSERT INTO users (email, password_hash) VALUES (${email}, ${await hashPassword(TEST_PW)}) RETURNING id`;
  return u!.id;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export class ApiClient {
  jar = new Map<string, string>(); csrf: string | undefined; readonly ip = `10.70.${(++ip) >> 8}.${ip & 255}`;
  constructor(private readonly app: FastifyInstance) {}
  async req(method: Method, url: string, payload?: unknown, o: { csrf?: string | false; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { host: TEST_HOST, 'user-agent': 'vitest' };
    if (method !== 'GET') { headers.origin = `http://${TEST_HOST}`; if (payload !== undefined) headers['content-type'] = 'application/json'; }
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = o.csrf === undefined ? this.csrf : o.csrf;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    Object.assign(headers, o.headers);
    const res = await this.app.inject({ method, url, headers, payload: payload as object, remoteAddress: this.ip });
    for (const c of [].concat((res.headers['set-cookie'] ?? []) as never) as string[]) { const [kv] = c.split('; '); const [k, v] = kv!.split('='); if (v) this.jar.set(k!, v); }
    return res;
  }
  async json<T = any>(method: Method, url: string, payload?: unknown): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await this.req(method, url, payload); let body: unknown = null; try { body = r.json(); } catch { /* binary */ }
    return { status: r.statusCode, body: body as T };
  }
  /** password → enrol authenticator → session (the real flow). */
  async signIn(email: string): Promise<this> {
    const l = (await this.req('POST', '/api/auth/login', { email, password: TEST_PW })).json();
    if (!l.challenge) throw new Error('login failed: ' + JSON.stringify(l));
    const s = (await this.req('POST', '/api/auth/totp/setup', { challenge: l.challenge })).json();
    if (!s.secret) throw new Error('setup failed: ' + JSON.stringify(s) + ' step=' + l.step);
    const c = await this.req('POST', '/api/auth/totp/confirm', { challenge: l.challenge, code: totpAt(s.secret, Date.now()) });
    expect(c.statusCode).toBe(200);
    this.csrf = (await this.req('GET', '/api/auth/me')).json().csrfToken;
    return this;
  }
}

export interface SeedOpts { title?: string | null; relpath?: string; phash?: bigint | null; width?: number; height?: number; rating?: number; location?: string | null; year?: number | null; captureAt?: Date | null; rootId?: string; ingestedAt?: Date }
/** One photograph with one ACTIVE version, created in a transaction (the current-version FK is deferred). */
export async function seedOne(svc: Sql, userId: string, o: SeedOpts = {}): Promise<{ photoId: string; versionId: string; rootId: string }> {
  const rootId = o.rootId ?? (await svc<{ id: string }[]>`INSERT INTO library_roots (user_id, path) VALUES (${userId}, ${'/tmp/pv-test/' + randomUUID()}) RETURNING id`)[0]!.id;
  const photoId = randomUUID(), versionId = randomUUID();
  await svc.begin(async (tx) => {
    await tx`INSERT INTO photos (id, user_id, current_version_id, title, title_source, rating, trip_location, trip_location_source, year, year_source, capture_at, capture_at_source)
             VALUES (${photoId}, ${userId}, ${versionId}, ${o.title ?? null}, ${o.title ? 'FOLDER_DERIVED' : null}, ${o.rating ?? 0}, ${o.location ?? null}, ${o.location ? 'FOLDER_DERIVED' : null},
                     ${o.year ?? null}, ${o.year ? 'FOLDER_DERIVED' : null}, ${o.captureAt ?? null}, ${o.captureAt ? 'EXIF' : null})`;
    await tx`INSERT INTO photo_versions (id, user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256, phash, width, height, bytes, state, ingested_at)
             VALUES (${versionId}, ${userId}, ${photoId}, 1, ${rootId}, ${o.relpath ?? `2026/Kenya/${randomBytes(4).toString('hex')}.jpg`}, ${randomBytes(32)}, ${o.phash == null ? null : o.phash.toString()}::bigint,
                     ${o.width ?? 6000}, ${o.height ?? 4000}, 9000000, 'ACTIVE', ${o.ingestedAt ?? new Date()})`;
  });
  return { photoId, versionId, rootId };
}
