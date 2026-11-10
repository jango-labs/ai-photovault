/** Background worker: npm run worker -- --db photovault_dev [--derivatives /abs/dir] [--once]. Derives previews and fingerprints; retries with backoff. */
import path from 'node:path';
import os from 'node:os';
import { connect, resolveTarget } from '../db/connect.js';
import { analyzeHandler, embedTextHandler } from '../ai/service.js';
import { deriveHandler, markDerivativeFailed } from '../ingest/derive-job.js';
import { embedHandler } from '../search/index.js';
import { instagramHandlers } from '../instagram/sync.js';
import { JobWorker } from '../jobs/worker.js';
import { scheduledScan, sourceConfigFromEnv } from '../ingest/source.js';
import { dataRootFromEnv } from '../storage/dataRoot.js';
import { resourcePressure } from '../ops/pressure.js';
import { AI_KINDS } from '../ai/queue.js';
import { EnvSecretStore } from '@photovault/shared';
import { loadInstagramOAuthConfig } from '../instagram/config.js';
import { TokenVault } from '../instagram/oauth.js';
import { defaultStateDir } from '../paths.js';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const db = arg('db') ?? process.env.PHOTOVAULT_DB ?? 'photovault';
// With PHOTOVAULT_STORAGE_ID the previews live on the mounted storage guard (external drive / NAS); without it the plain path settings apply.
const dr = dataRootFromEnv();
let deriv = arg('derivatives') ?? process.env.PHOTOVAULT_DERIVATIVES_DIR ?? (process.env.PHOTOVAULT_DATA_ROOT ? path.join(process.env.PHOTOVAULT_DATA_ROOT, 'derivatives') : undefined);
let startRoot: string | null = null;
if (dr) {
  let told = false;
  for (;;) {
    const why = await dr.gate(); if (!why) break;
    if (process.argv.includes('--once')) { console.error(`the photo storage is not available: ${why}`); process.exit(75); }
    if (!told) { console.log(`waiting for the photo drive: ${why}`); told = true; }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  startRoot = await dr.require(); deriv = await dr.dir('derivatives');
}
const driveIgMedia = dr ? await dr.dir('ig-media') : undefined;
if (!db || !deriv || !path.isAbsolute(deriv)) { console.error('usage: worker --db <database> --derivatives /abs/dir [--once]  (or set PHOTOVAULT_DERIVATIVES_DIR / DATA_ROOT / DATA_VOLUME_UUID)'); process.exit(2); }
const igMedia = driveIgMedia ?? arg('ig-media') ?? process.env.PHOTOVAULT_IG_MEDIA_DIR ?? (process.env.PHOTOVAULT_DATA_ROOT ? path.join(process.env.PHOTOVAULT_DATA_ROOT, 'ig-media') : undefined);
const sql = connect(await resolveTarget('pv_service', db), { max: 4 });
let restartNeeded = false; let pausedNote = '';
const gate = dr ? async () => { const st = await dr.status(); if (!st.ready) return st.reason; if (st.root !== startRoot) { restartNeeded = true; return 'the drive is now mounted at a different path; restarting'; } return null; } : undefined;
// Instagram (optional): the worker reads a connected account's sealed token only for syncing and renewing it
const secrets = new EnvSecretStore(); const atRest = await secrets.get('token_enc_key'); const igCfg = await loadInstagramOAuthConfig(secrets).catch(() => null);
const vault = atRest ? new TokenVault({ sql, atRestKey: Buffer.from(atRest, 'hex'), cfg: igCfg }) : null;
let holdNote = '';
const minFree = Number(process.env.PHOTOVAULT_MIN_FREE_GB) || 20;
const pressure = resourcePressure({ dirs: [{ label: 'the photo drive', path: deriv, minFreeGb: minFree }, { label: 'the disk that holds the database', path: os.homedir(), minFreeGb: Math.min(minFree, 10) }] });
const w = new JobWorker(sql, { 'derive.preview': deriveHandler(sql, deriv), 'ai.analyze': analyzeHandler(sql, deriv), 'embed.image': embedHandler(sql, deriv), 'embed.text': embedTextHandler(sql), ...(igMedia ? instagramHandlers(sql, igMedia, deriv, vault ? { vault, cfg: igCfg } : undefined) : {}) }, { ...(gate ? { gate, onPause: (r: string | null) => { pausedNote = r ? ` (paused: ${r})` : ''; console.log(r ? `paused: ${r}` : 'photo drive is back: resuming'); if (restartNeeded) w.stop(); } } : {}), onDead: markDerivativeFailed(sql), heavyKinds: [...AI_KINDS], heavyConcurrency: 1, pressure, onPressure: (r: string | null) => { holdNote = r ? ` (AI held: ${r})` : ''; console.log(r ? `holding AI work: ${r}` : 'resources are fine again: AI work continues'); }, concurrency: Number(arg('concurrency', '2')), workerId: `worker-${os.hostname()}-${process.pid}` });
const beat = () => sql`INSERT INTO service_heartbeats (service, instance, pid, version) VALUES ('worker', ${os.hostname()}, ${process.pid}, ${'0.5.0' + pausedNote + holdNote}) ON CONFLICT (service) DO UPDATE SET at = now(), pid = excluded.pid, instance = excluded.instance, version = excluded.version`;
process.on('SIGTERM', () => w.stop()); process.on('SIGINT', () => w.stop());
if (process.argv.includes('--once')) { const n = await w.drain(); await beat(); console.log(`processed ${n} job(s)`); await sql.end({ timeout: 2 }); }
else {
  // once a few hours: ask for a renewal job for every connected Instagram account (one per account per day; the job itself only renews tokens that expire soon)
  const enqueueRefresh = () => sql`INSERT INTO jobs (user_id, kind, payload, dedupe_key) SELECT DISTINCT user_id, 'ig.token.refresh', '{}'::jsonb, 'igrefresh:' || user_id::text || ':' || to_char(now(), 'YYYY-MM-DD') FROM social_accounts WHERE platform = 'instagram' AND status = 'CONNECTED' AND external_id NOT LIKE 'synthetic-%' ON CONFLICT DO NOTHING`.catch(() => undefined);
  // postgres.js queries are LAZY: they run only when awaited or given .then(), so `void query()` would silently do nothing — always attach a handler
  const fire = (q: PromiseLike<unknown>) => { q.then(() => undefined, (e: unknown) => console.error(`background query failed: ${e instanceof Error ? e.message : String(e)}`)); };
  if (igMedia && vault) { fire(enqueueRefresh()); setInterval(() => { fire(enqueueRefresh()); }, 6 * 3600_000).unref(); }
  // scheduled source scan (lightweight, incremental, read-only): only while the photo drive is usable, never overlapping itself, skipped when the source is unavailable
  const source = sourceConfigFromEnv();
  if (source && source.intervalMin > 0) {
    let scanning = false;
    const tick = () => {
      if (scanning || pausedNote) return;
      scanning = true;
      void scheduledScan({ sql, cfg: source, stateDir: process.env.PHOTOVAULT_STATE_DIR ?? defaultStateDir(), derivativesDir: deriv, log: (m) => console.log(m) }).finally(() => { scanning = false; });
    };
    setTimeout(tick, 45_000).unref(); setInterval(tick, 5 * 60_000).unref();                 // checked every 5 minutes; a scan runs only when one is due
    console.log(`scheduled scan of ${source.name}: every ${source.intervalMin} min`);
  }
  setInterval(() => { fire(beat()); }, 15_000).unref(); await beat(); console.log(`worker running (derivatives → ${deriv})`); await w.run(); await beat().catch(() => undefined); await sql.end({ timeout: 2 }); if (restartNeeded) process.exit(75); }
