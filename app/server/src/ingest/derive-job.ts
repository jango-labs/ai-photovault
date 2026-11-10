import fs from 'node:fs/promises';
import type { Sql } from 'postgres';
import { loadSettings, promptVersionFor } from '../ai/service.js';
import { DuplicateService } from '../library/duplicates.js';
import { PermanentJobError, type Handler, type Job } from '../jobs/worker.js';
import { DERIVATIVE_SPEC, assertDerivativesOutsideSources, generateDerivatives } from './derive.js';
import { sha256File } from './extract.js';
import { fingerprint } from './hash.js';
import { absoluteInside } from './scan.js';

/**
 * Worker job `derive.preview` {versionId, photoId}: reads the source JPEG (read-only), writes thumb/view previews under the derivatives
 * directory, computes the perceptual hashes and dominant colour, marks the version READY and looks for near-duplicates.
 * If the file changed since it was imported, nothing is derived from it (the next import will register the new bytes as a new version).
 */
export function deriveHandler(sql: Sql, derivativesDir: string): Handler {
  const dups = new DuplicateService(sql);
  return async (job: Job) => {
    const versionId = String(job.payload.versionId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new PermanentJobError('malformed job: no version id');
    const [v] = await sql<{ id: string; photo_id: string; source_relpath: string; content_sha256: Buffer; root: string }[]>`
      SELECT v.id, v.photo_id, v.source_relpath, v.content_sha256, r.path AS root FROM photo_versions v JOIN library_roots r ON r.id = v.library_root_id
       WHERE v.id = ${versionId}::uuid AND v.user_id = ${job.user_id}`;
    if (!v) throw new PermanentJobError('the version no longer exists');
    assertDerivativesOutsideSources(derivativesDir, [v.root]);
    const abs = absoluteInside(v.root, v.source_relpath);
    try { await fs.access(abs); } catch { throw new Error('the source file is not available right now'); }              // transient: the drive may be unmounted; retried with backoff
    if (!(await sha256File(abs)).equals(v.content_sha256)) throw new PermanentJobError('the source file changed after it was imported; it will be imported again as a new version');
    await generateDerivatives(abs, derivativesDir, v.id);
    const fp = await fingerprint(abs);
    await sql`UPDATE photo_versions SET deriv_status = 'READY', deriv_spec = ${DERIVATIVE_SPEC.version}, phash = ${fp.phash.toString()}::bigint, dhash = ${fp.dhash.toString()}::bigint,
                dominant_colors = ${sql.json([fp.dominant] as never)} WHERE id = ${v.id}::uuid`;
    await dups.detectFor(job.user_id, [v.photo_id]);
    // the local visual embedding (for "Find similar") is free and offline, so it always follows the preview
    await sql`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${job.user_id}, 'embed.image', ${sql.json({ versionId: v.id } as never)}, ${`embed:${v.id}:local-visual-v1`}) ON CONFLICT DO NOTHING`;
    // analysis follows previews automatically (offline and free); switch it off in Settings → AI
    const ai = await loadSettings(sql, job.user_id);
    if (ai.autoAnalyze)
      await sql`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${job.user_id}, 'ai.analyze', ${sql.json({ photoId: v.photo_id, versionId: v.id } as never)}, ${`ai:${v.id}:${promptVersionFor(ai.provider)}`}) ON CONFLICT DO NOTHING`;
  };
}

export const markDerivativeFailed = (sql: Sql) => async (job: Job): Promise<void> => {
  if (job.kind === 'derive.preview') await sql`UPDATE photo_versions SET deriv_status = 'FAILED' WHERE id = ${String(job.payload.versionId)}::uuid AND user_id = ${job.user_id}`;
};
