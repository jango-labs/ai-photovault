import type { Sql } from 'postgres';
import { withUser } from '../db/connect.js';

/**
 * Turns a typed place name ("Washington, DC") into an APPROXIMATE position, using the free OpenStreetMap "Nominatim" search service.
 * Everything here follows Nominatim's usage policy (operations.osmfoundation.org/policies/nominatim):
 *   · at most one request per second (all lookups share one queue), never as-you-type — a lookup happens only when the person saves a location or presses "Find on map";
 *   · an identifying User-Agent (never the HTTP library's default);
 *   · results are cached (per account, in the database) so the same text is not sent twice; "not found" is cached for a day, a failed or unreachable service is never cached;
 *   · attribution ("© OpenStreetMap contributors") is shown wherever such a position appears.
 * What leaves this computer is the typed place text — never a photograph, a file name, a path or any other metadata. It is OFF by default and only runs when you set PHOTOVAULT_GEOCODER=on (explicit consent to send typed place names to the lookup service).
 * A position found this way is the centre of the place: the application stores it as GEOCODED and never presents it as where the photograph was taken.
 */
export interface Candidate { label: string; lat: number; lon: number; kind: string; /** [west, south, east, north] of the place, when known */ bbox: [number, number, number, number] | null }
export type LookupResult =
  | { status: 'ok'; candidates: Candidate[]; cached: boolean }
  | { status: 'not_found'; cached: boolean }
  | { status: 'unavailable'; reason: string }
  | { status: 'disabled' };
export interface GeocoderConfig { enabled: boolean; baseUrl: string; userAgent: string; minIntervalMs: number; timeoutMs: number; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; foundTtlDays: number; missTtlHours: number }

export function geocoderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GeocoderConfig {
  return {
    enabled: ['on', 'nominatim'].includes(env.PHOTOVAULT_GEOCODER ?? 'off'), baseUrl: env.PHOTOVAULT_GEOCODER_URL ?? 'https://nominatim.openstreetmap.org',
    userAgent: env.PHOTOVAULT_GEOCODER_USER_AGENT ?? 'AIPhotoVault/1.0 (self-hosted open-source photo library; place-name lookups only on request)',
    minIntervalMs: Number(env.PHOTOVAULT_GEOCODER_MIN_INTERVAL_MS ?? 1100), timeoutMs: Number(env.PHOTOVAULT_GEOCODER_TIMEOUT_MS ?? 8000), foundTtlDays: 90, missTtlHours: 24,
  };
}

/** What is stored and compared: lower case, collapsed spaces. */
export const normaliseQuery = (q: string): string => q.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 200);

const KIND_OK = /^(place|boundary|leisure|natural|tourism|historic|landuse|waterway|highway|building|amenity|man_made|aeroway|railway|shop|office|water|mountain_pass|craft)$/;

export class Geocoder {
  private readonly cfg: GeocoderConfig; private readonly f: typeof fetch; private readonly now: () => number; private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<unknown> = Promise.resolve(); private lastAt = 0;
  constructor(private readonly sql: Sql, cfg: GeocoderConfig = geocoderConfigFromEnv()) {
    this.cfg = cfg; this.f = cfg.fetch ?? fetch; this.now = cfg.now ?? Date.now; this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const u = new URL(cfg.baseUrl); if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('the geocoder must use HTTPS (or a service on this computer)');
  }
  get enabled(): boolean { return this.cfg.enabled; }

  /** Looks a place name up (cache first). Never throws: failures come back as a status so a location edit never fails because the lookup did. */
  async lookup(userId: string, text: string, limit = 5): Promise<LookupResult> {
    if (!this.cfg.enabled) return { status: 'disabled' };
    const q = normaliseQuery(text); if (q.length < 2) return { status: 'not_found', cached: false };
    try {
      const hit = await withUser(this.sql, userId, async (tx) => (await tx<{ found: boolean; candidates: Candidate[]; fresh: boolean }[]>`
        SELECT found, candidates, fetched_at > now() - (CASE WHEN found THEN make_interval(days => ${this.cfg.foundTtlDays}) ELSE make_interval(hours => ${this.cfg.missTtlHours}) END) AS fresh
          FROM geocode_cache WHERE query = ${q}`)[0]);
      if (hit?.fresh) return hit.found ? { status: 'ok', candidates: hit.candidates.slice(0, limit), cached: true } : { status: 'not_found', cached: true };
    } catch { /* a cache problem must not block the lookup */ }
    let candidates: Candidate[];
    try { candidates = await this.fetchOne(text.trim().slice(0, 200), 5); }
    catch (e) { return { status: 'unavailable', reason: e instanceof Error ? e.message : 'the place-name service could not be reached' }; }
    try {
      await withUser(this.sql, userId, (tx) => tx`INSERT INTO geocode_cache (user_id, query, found, candidates) VALUES (${userId}, ${q}, ${candidates.length > 0}, ${tx.json(candidates as never)})
        ON CONFLICT (user_id, query) DO UPDATE SET found = excluded.found, candidates = excluded.candidates, fetched_at = now()`);
    } catch { /* not cached this time */ }
    return candidates.length ? { status: 'ok', candidates: candidates.slice(0, limit), cached: false } : { status: 'not_found', cached: false };
  }

  /** One request at a time, at least minIntervalMs apart, for the whole process. */
  private fetchOne(text: string, limit: number): Promise<Candidate[]> {
    const run = async () => {
      const wait = this.lastAt + this.cfg.minIntervalMs - this.now(); if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();
      const url = new URL('/search', this.cfg.baseUrl); url.search = new URLSearchParams({ q: text, format: 'jsonv2', limit: String(limit), addressdetails: '0', 'accept-language': 'en' }).toString();
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
      try {
        const res = await this.f(url, { headers: { 'user-agent': this.cfg.userAgent, accept: 'application/json' }, signal: ctl.signal, redirect: 'error' });
        if (res.status === 429 || res.status === 403) throw new Error('the place-name service is asking us to slow down; try again in a few minutes');
        if (!res.ok) throw new Error(`the place-name service answered HTTP ${res.status}`);
        const body = (await res.json()) as unknown; if (!Array.isArray(body)) throw new Error('the place-name service gave an unexpected answer');
        const out: Candidate[] = [];
        for (const r of body as Array<Record<string, unknown>>) {
          const lat = Number(r.lat), lon = Number(r.lon); if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
          const bb = Array.isArray(r.boundingbox) ? (r.boundingbox as unknown[]).map(Number) : null;      // Nominatim: [south, north, west, east]
          const bbox = bb && bb.length === 4 && bb.every(Number.isFinite) ? ([bb[2]!, bb[0]!, bb[3]!, bb[1]!] as [number, number, number, number]) : null;
          const category = typeof r.category === 'string' ? r.category : typeof r.class === 'string' ? r.class : 'place'; const type = typeof r.type === 'string' ? r.type : '';
          out.push({ label: String(r.display_name ?? '').slice(0, 200) || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon, kind: KIND_OK.test(category) ? `${category}/${type}`.slice(0, 60) : `place/${type}`.slice(0, 60), bbox });
        }
        return out;
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw new Error('the place-name service did not answer in time', { cause: e });
        if (e instanceof Error && /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(`${e.message} ${(e as { cause?: Error }).cause?.message ?? ''}`)) throw new Error('the place-name service could not be reached (is the Mac online?)', { cause: e });
        throw e;
      } finally { clearTimeout(timer); }
    };
    const next = this.chain.then(run, run); this.chain = next.catch(() => undefined); return next;
  }
}
