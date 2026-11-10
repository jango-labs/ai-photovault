import path from 'node:path';
import type { Sql } from 'postgres';
import { PermanentJobError, type Handler } from '../jobs/worker.js';
import { LOCAL_EMBEDDING_DIMS, LOCAL_EMBEDDING_MODEL, embedFile, toVectorLiteral } from './embedding.js';

/** Rebuilds the searchable text of the given photographs (all of the user's when omitted). Call inside the transaction that changed something searchable. */
export async function refreshSearch(tx: Sql, userId: string, photoIds?: string[]): Promise<number> {
  if (photoIds && photoIds.length === 0) return 0;
  const [r] = await tx<{ n: number }[]>`SELECT refresh_search(${userId}::uuid, ${photoIds ?? null}::uuid[]) AS n`;
  return r!.n;
}

/** Worker job `embed.image` {versionId}: stores the local visual embedding of a photograph's preview (idempotent). */
export function embedHandler(sql: Sql, derivativesDir: string): Handler {
  return async (job) => {
    const versionId = String(job.payload.versionId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new PermanentJobError('malformed job: no version id');
    const [v] = await sql<{ id: string; deriv_status: string }[]>`SELECT id, deriv_status FROM photo_versions WHERE id = ${versionId}::uuid AND user_id = ${job.user_id}`;
    if (!v) throw new PermanentJobError('the version no longer exists');
    if (v.deriv_status === 'FAILED') throw new PermanentJobError('no preview could be made for this photograph');
    if (v.deriv_status !== 'READY') throw new Error('the preview is not ready yet');
    const vec = await embedFile(path.join(derivativesDir, versionId, 'thumb.jpg'));
    await sql`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding)
              VALUES (${job.user_id}, ${versionId}::uuid, ${LOCAL_EMBEDDING_MODEL}, 'image', ${LOCAL_EMBEDDING_DIMS}, ${toVectorLiteral(vec)}::halfvec)
              ON CONFLICT (photo_version_id, model, kind) DO NOTHING`;
  };
}
