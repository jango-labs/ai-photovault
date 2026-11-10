/**
 * Import tool (owner's command line).
 *   npm run ingest -- --db photovault_dev --email you@example.com --source /abs/dir --mode dry-run
 *   npm run ingest -- --db photovault_dev --email you@example.com --source /abs/dir --mode apply [--derivatives /abs/previews]
 *   npm run ingest:approve -- --path /abs/dir --modes dry-run[,apply] --note "why"     (writes <state dir>/approvals/ingest.json)
 * A directory is scanned ONLY if it is listed in the approvals file for that mode. Nothing is approved by default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, resolveTarget } from '../db/connect.js';
import { ApprovalFile, NotApprovedError, approvalPath, canonical, loadPolicy, type IngestMode } from '../ingest/approval.js';
import { IngestService } from '../ingest/service.js';
import { dataRootFromEnv } from '../storage/dataRoot.js';
import { defaultStateDir } from '../paths.js';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const stateDir = process.env.PHOTOVAULT_STATE_DIR ?? defaultStateDir();

async function approve() {
  const p = arg('path'); const modes = (arg('modes', 'dry-run') ?? '').split(',').map((m) => m.trim().toUpperCase().replace('-', '_')) as IngestMode[];
  if (!p || !path.isAbsolute(p) || !modes.every((m) => m === 'DRY_RUN' || m === 'APPLY')) { console.error('usage: ingest:approve --path /absolute/dir --modes dry-run[,apply] [--note text]'); process.exit(2); }
  const file = approvalPath(stateDir); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const cur = fs.existsSync(file) ? ApprovalFile.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : { roots: [] };
  const c = canonical(p);
  const roots = [...cur.roots.filter((r) => canonical(r.path) !== c), { path: c, modes, approvedAt: new Date().toISOString(), note: arg('note') }];
  fs.writeFileSync(file, JSON.stringify({ roots }, null, 2), { mode: 0o600 });
  console.log(`approved ${c} for ${modes.join(', ')} (${file})`);
}

async function main() {
  if (process.argv[2] === 'approve') return approve();
  const db = arg('db') ?? process.env.PHOTOVAULT_DB ?? 'photovault'; const email = arg('email')?.toLowerCase(); const source = arg('source'); const mode = (arg('mode', 'dry-run') ?? '').toUpperCase().replace('-', '_') as IngestMode;
  if (!db || !email || !source || !['DRY_RUN', 'APPLY'].includes(mode)) { console.error('usage: ingest --db <database> --email <account> --source /abs/dir --mode dry-run|apply [--derivatives /abs/dir]'); process.exit(2); }
  const svc = connect(await resolveTarget('pv_service', db), { max: 1 });
  const [u] = await svc<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`; await svc.end({ timeout: 2 });
  if (!u) { console.error(`no account ${email} in ${db}`); process.exit(2); }
  const app = connect(await resolveTarget('pv_app', db), { max: 4 });
  try {
    const ing = new IngestService({ sql: app, policy: loadPolicy(stateDir), derivativesDir: arg('derivatives') ?? (dataRootFromEnv() ? await dataRootFromEnv()!.dir('derivatives') : null) ?? process.env.PHOTOVAULT_DERIVATIVES_DIR ?? null });                 // the photo drive (by volume UUID) when configured
    await ing.recover(u.id);
    const r = await ing.run(u.id, source, mode);
    const c = r.counters;
    console.log(`${mode} ${r.state}: scanned ${c.scanned} · new ${c.new} · new versions ${c.newVersions} · moved ${c.moved} · duplicate files ${c.duplicateFiles} · to review ${c.versionReview} · unchanged ${c.unchanged} · missing ${c.missing} · errors ${c.errors} · skipped ${JSON.stringify(c.skipped)}`);
    if (r.error) console.error(r.error);
    process.exitCode = r.state === 'COMPLETED' ? 0 : 1;
  } catch (e) {
    if (e instanceof NotApprovedError) { console.error(e.message); process.exitCode = 3; } else throw e;
  } finally { await app.end({ timeout: 2 }); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
