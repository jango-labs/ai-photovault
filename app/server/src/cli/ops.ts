/**
 * Operations helper.
 *   ops prune --dir ~/PhotoVaultBackups [--dry-run] [--require-nas]              apply the retention policy to <dir>/db (never removes the newest verified backup)
 *   ops verify-checks --db photovault_restore_test [--source photovault] [--exact] [--tolerate-missing]   checks on a RESTORED database (row counts, migrations, forced RLS, per-user isolation)
 *   ops ai --db photovault --email you@example.com --provider ollama|local-image [--analyze]   choose the AI provider (same check as Settings → AI) and queue unanalysed photographs
 *   ops storage --db photovault_dev [--derivatives d] [--ig-media d] [--backups d] [--delivery d] [--state d]
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, resolveTarget, withUser } from '../db/connect.js';
import { AiService } from '../ai/service.js';
import { OllamaClient, ollamaConfigFromEnv } from '../ai/ollama.js';
import { planRetention, type BackupFile } from '../ops/retention.js';
import { storageReport } from '../ops/storage.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n: string) => rest.includes(`--${n}`);

async function prune() {
  const dir = arg('dir'); if (!dir || !path.isAbsolute(dir)) throw new Error('--dir must be an absolute path');
  if (dir.split(path.sep).includes('originals') || fs.existsSync(path.join(dir, 'originals'))) throw new Error('refusing: original photographs are never pruned');
  const db = path.join(dir, 'db'); if (!fs.existsSync(db)) { console.log('nothing to prune'); return; }
  const files: BackupFile[] = fs.readdirSync(db).filter((f) => f.endsWith('.dump')).map((f) => {
    const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/.exec(f); if (!m) return null;
    return { name: f, at: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)), verified: fs.existsSync(path.join(db, `${f}.verified`)) && fs.existsSync(path.join(db, `${f}.sha256`)) };
  }).filter((x): x is BackupFile => !!x);
  const plan = planRetention(files, new Date());
  // --require-nas: a local dump is never removed until it is confirmed on the NAS (marker `<dump>.nas` written by nas-copy.sh)
  const held = has('require-nas') ? plan.remove.filter((f) => !fs.existsSync(path.join(db, `${f}.nas`))) : [];
  for (const f of held) console.log(`keeping ${f} (not yet confirmed on the NAS)`);
  const remove = plan.remove.filter((f) => !held.includes(f));
  for (const f of remove) { console.log(`${has('dry-run') ? 'would remove' : 'removing'} ${f}`); if (!has('dry-run')) for (const ext of ['', '.sha256', '.verified', '.nas']) fs.rmSync(path.join(db, f + ext), { force: true }); }
  console.log(`kept ${plan.keep.length + held.length}, ${has('dry-run') ? 'would remove' : 'removed'} ${remove.length}`);
}

async function verifyChecks() {
  const dbName = arg('db'); const source = arg('source'); if (!dbName) throw new Error('--db is required');
  const sql = connect(await resolveTarget('pv_service', dbName), { max: 2 }); const checks: Array<{ name: string; ok: boolean; detail?: string }> = []; const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const TABLES = ['users', 'photos', 'photo_versions', 'collections', 'collection_photos', 'publishing_drafts', 'caption_versions', 'scheduled_publications', 'social_posts', 'social_post_media', 'photo_social_matches', 'photo_species', 'ai_analyses', 'photo_embeddings', 'photo_edits', 'duplicate_pairs', 'import_runs', 'search_documents'];
  const count = async (s: typeof sql, t: string) => Number((await s.unsafe(`SELECT count(*)::text AS n FROM ${t}`))[0]!.n);
  try {
    add('migrations present', (await count(sql, 'schema_migrations')) > 0, `${await count(sql, 'schema_migrations')} applied`);
    if (source) {
      const src = connect(await resolveTarget('pv_service', source), { max: 1 });
      try {
        add('same migrations as the source', (await count(src, 'schema_migrations')) === (await count(sql, 'schema_migrations')));
        for (const t of TABLES) { let a: number, b: number; try { a = await count(src, t); b = await count(sql, t); } catch (e) { if ((e as { code?: string }).code === '42P01' && !(await src.unsafe(`SELECT to_regclass('public.${t}') AS r`))[0]!.r) continue;       // a table the source (an older schema) does not have yet is not a mismatch
 add(`rows: ${t}`, false, e instanceof Error ? e.message : 'error'); continue; } add(`rows: ${t}`, b <= a && (has('exact') ? a === b : b >= Math.floor(a * 0.5) || a === 0), `${b} restored / ${a} in source`); }
      } finally { await src.end({ timeout: 2 }); }
    } else for (const t of TABLES) { try { add(`readable: ${t}`, (await count(sql, t)) >= 0); } catch (e) { if (has('tolerate-missing') && (e as { code?: string }).code === '42P01') continue; add(`readable: ${t}`, false, e instanceof Error ? e.message : 'error'); } }
    // every table holding a user's data must have row-level security; it must be FORCED (binding the table owner too) everywhere except the three authentication
    // tables, which the SECURITY DEFINER auth functions (owned by the schema owner) must read — those are reachable only through policies and narrow grants.
    const AUTH = new Set(['sessions', 'device_tokens', 'login_attempts']);
    const rows = await sql<{ t: string; rls: boolean; forced: boolean }[]>`SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'user_id' AND NOT a.attisdropped WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    add('row-level security enabled on every table with a user_id', rows.every((r) => r.rls), rows.filter((r) => !r.rls).map((r) => r.t).join(', '));
    add('row-level security FORCED on every such table except the authentication tables', rows.every((r) => r.forced || AUTH.has(r.t)), rows.filter((r) => !r.forced && !AUTH.has(r.t)).map((r) => r.t).join(', '));
    const users = await sql<{ id: string; n: string }[]>`SELECT u.id, (SELECT count(*) FROM photos p WHERE p.user_id = u.id)::text AS n FROM users u ORDER BY u.created_at LIMIT 3`;
    const app = connect(await resolveTarget('pv_app', dbName), { max: 1 });
    try {
      for (const u of users) { const seen = await withUser(app, u.id, async (tx) => Number((await tx`SELECT count(*)::text AS n FROM photos`)[0]!.n)); add(`isolation: user ${u.id.slice(0, 8)} sees exactly their ${u.n} photographs`, seen === Number(u.n)); }
      add('a stranger sees nothing', (await withUser(app, '00000000-0000-4000-8000-000000000000', async (tx) => Number((await tx`SELECT count(*)::text AS n FROM photos`)[0]!.n))) === 0);
    } finally { await app.end({ timeout: 2 }); }
  } finally { await sql.end({ timeout: 2 }); }
  const ok = checks.every((c) => c.ok);
  console.log(JSON.stringify({ ok, checks }, null, 1)); process.exit(ok ? 0 : 1);
}

async function storage() {
  const db = arg('db'); if (!db) throw new Error('--db is required');
  const sql = connect(await resolveTarget('pv_service', db), { max: 1 });
  try {
    const r = await storageReport(sql, { derivatives: arg('derivatives') ?? null, igMedia: arg('ig-media') ?? null, delivery: arg('delivery') ?? null, backups: arg('backups') ?? null, state: arg('state') ?? null });
    const mb = (n: number | null) => (n === null ? '—' : `${(n / 1048576).toFixed(1)} MB`);
    console.log(`database ${db}: ${mb(r.database.bytes)}`); for (const t of r.database.tables) console.log(`  ${t.name.padEnd(28)} ${mb(t.bytes).padStart(10)}  ~${t.rows} rows`);
    for (const d of r.dirs) console.log(`${d.label.padEnd(36)} ${mb(d.bytes).padStart(10)}  ${d.files ?? '—'} files${d.truncated ? ' (partial)' : ''}  free ${mb(d.freeBytes)}`);
  } finally { await sql.end({ timeout: 2 }); }
}

/**
 * Same change as Settings → AI, for the owner at the command line (no sign-in needed on this computer): choose the AI provider, with the same safety check
 * (the local vision model must be installed and reachable), and optionally queue the photographs that have no analysis yet. Never overwrites edits.
 */
async function ai() {
  const db = arg('db'); const email = arg('email')?.toLowerCase(); const provider = arg('provider');
  if (!db || !email || (provider !== 'ollama' && provider !== 'local-image')) throw new Error('usage: ops ai --db <database> --email <account> --provider ollama|local-image [--analyze]');
  const svc = connect(await resolveTarget('pv_service', db), { max: 1 });
  const [u] = await svc<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`; await svc.end({ timeout: 2 });
  if (!u) throw new Error(`no account ${email} in ${db}`);
  const app = connect(await resolveTarget('pv_app', db), { max: 2 });
  try {
    const service = new AiService(app, new OllamaClient(ollamaConfigFromEnv()));
    if (provider === 'ollama') { const why = await service.ollamaBlocker(); if (why) throw new Error(`The local vision model cannot be selected: ${why}.`); }
    const s = await service.setSettings(u.id, { provider });
    console.log(`AI provider is now ${s.provider} (automatic analysis of new photographs: ${s.autoAnalyze ? 'on' : 'off'})`);
    if (has('analyze')) { const r = await service.enqueue(u.id, { query: { view: 'all' }, exclude: [] }, false); console.log(`queued ${r.queued} · already analysed ${r.alreadyAnalysed} · waiting for previews ${r.waitingForPreviews}`); }
  } finally { await app.end({ timeout: 2 }); }
}

const run = { prune, 'verify-checks': verifyChecks, storage, ai }[cmd ?? ''];
if (!run) { console.error('usage: ops prune|verify-checks|storage|ai …'); process.exit(2); }
run().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
