import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PORTS, assertAllowedBind } from '@photovault/shared';
import { defaultStateDir } from './paths.js';

const Env = z.object({
  PHOTOVAULT_HOST: z.string().default('127.0.0.1'),
  /** '1' = the database holds the bundled synthetic demo library; its placeholder images are then served from the web app's /fixtures */
  PHOTOVAULT_DEMO_MODE: z.enum(['0', '1']).default('0'),
  PHOTOVAULT_API_PORT: z.coerce.number().int().default(PORTS.api),
  PHOTOVAULT_STATE_DIR: z.string().optional(),
  PHOTOVAULT_DATA_ROOT: z.string().optional(),
  PHOTOVAULT_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PHOTOVAULT_DB: z.string().regex(/^photovault[a-z0-9_]*$/).default('photovault'),
  /** comma-separated extra host names (no port) that may be used to reach the app (only needed behind a reverse proxy you set up yourself) */
  PHOTOVAULT_ALLOWED_HOSTS: z.string().default(''),
  /** 'auto' = Secure cookies whenever the request arrived over HTTPS (behind your own TLS proxy), 'always', or 'never' */
  PHOTOVAULT_COOKIE_SECURE: z.enum(['auto', 'always', 'never']).default('auto'),
  PHOTOVAULT_WEB_DIR: z.string().optional(),
  /** generated previews (default DATA_ROOT/derivatives). The import pipeline (Phase 7) writes here. */
  PHOTOVAULT_DERIVATIVES_DIR: z.string().optional(),
  /** your photo folder; NEVER read unless you approved it (<state dir>/approvals/ingest.json, written by `npm run ingest:approve`) */
  PHOTOVAULT_INGEST_DIR: z.string().optional(),
  /** downloaded Instagram images and the synthetic archive (default DATA_ROOT/ig-media) */
  PHOTOVAULT_IG_MEDIA_DIR: z.string().optional(),
  /** database dumps (outside the data directory; the scripts default to ~/PhotoVaultBackups) */
  PHOTOVAULT_BACKUP_DIR: z.string().optional(),
  /** temporary publish copies (default DATA_ROOT/delivery) */
  PHOTOVAULT_DELIVERY_DIR: z.string().optional(),
});

export interface AppConfig {
  host: string;
  apiPort: number;
  /** Small, always-present state on the internal disk (Postgres cluster, logs, run files). */
  stateDir: string;
  /** Large rebuildable data on the external SSD (derivatives, ig-media, delivery, backups). May be unset in dev. */
  dataRoot: string | null;
  logLevel: string;
  database: string;
  /** Host names (without port) accepted in the Host header: DNS-rebinding protection. */
  allowedHosts: string[];
  cookieSecure: 'auto' | 'always' | 'never';
  /** Built web app to serve (null = API only; Vite serves the UI in development). */
  webDir: string | null;
  /** Where generated previews live; null until the import pipeline exists. */
  derivativesDir: string | null;
  /** Synthetic fixture images may be served only when the database is not the production one. */
  syntheticMedia: boolean;
  /** configured import source (not scanned, not even checked for existence, until the owner approves it) */
  ingestDir: string | null;
  /** where Instagram media for the history are stored; null = Instagram history unavailable */
  igMediaDir: string | null;
  backupDir: string | null;
  deliveryDir: string | null;
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** Parses env into config. Throws on non-loopback hosts or ports owned by other apps. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = Env.parse(env);
  assertAllowedBind(e.PHOTOVAULT_HOST, e.PHOTOVAULT_API_PORT, env);
  const defaultWeb = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const web = e.PHOTOVAULT_WEB_DIR ?? defaultWeb;
  return {
    host: e.PHOTOVAULT_HOST,
    apiPort: e.PHOTOVAULT_API_PORT,
    stateDir: e.PHOTOVAULT_STATE_DIR ?? defaultStateDir(),
    dataRoot: e.PHOTOVAULT_DATA_ROOT ?? null,
    logLevel: e.PHOTOVAULT_LOG_LEVEL,
    database: e.PHOTOVAULT_DB,
    allowedHosts: [...LOOPBACK_NAMES, ...e.PHOTOVAULT_ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)],
    cookieSecure: e.PHOTOVAULT_COOKIE_SECURE,
    webDir: fs.existsSync(path.join(web, 'index.html')) ? web : null,
    derivativesDir: e.PHOTOVAULT_DERIVATIVES_DIR ?? (e.PHOTOVAULT_DATA_ROOT ? path.join(e.PHOTOVAULT_DATA_ROOT, 'derivatives') : null),
    syntheticMedia: e.PHOTOVAULT_DEMO_MODE === '1',
    ingestDir: e.PHOTOVAULT_INGEST_DIR ?? null,
    igMediaDir: e.PHOTOVAULT_IG_MEDIA_DIR ?? (e.PHOTOVAULT_DATA_ROOT ? path.join(e.PHOTOVAULT_DATA_ROOT, 'ig-media') : null),
    backupDir: e.PHOTOVAULT_BACKUP_DIR ?? path.join(os.homedir(), '.photovault', 'backups'),
    deliveryDir: e.PHOTOVAULT_DELIVERY_DIR ?? (e.PHOTOVAULT_DATA_ROOT ? path.join(e.PHOTOVAULT_DATA_ROOT, 'delivery') : null),
  };
}
