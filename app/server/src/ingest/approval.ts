import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Nothing is scanned unless YOU have approved that exact directory, in a local file only you create (privacy by default):
 *   <state dir>/approvals/ingest.json   {"roots":[{"path":"/abs/dir","modes":["DRY_RUN"],"approvedAt":"…","note":"…"}]}
 * (`npm run ingest:approve` writes it on the owner's explicit instruction.) Without an entry — and no entry exists by default —
 * every scan of every directory is refused, including a dry run. Tests approve temporary directories programmatically.
 */
export const ApprovalFile = z.object({
  roots: z.array(z.object({ path: z.string().min(2), modes: z.array(z.enum(['DRY_RUN', 'APPLY'])).min(1), approvedAt: z.string(), note: z.string().optional() })).max(20),
}).strict();
export type ApprovedRoot = z.infer<typeof ApprovalFile>['roots'][number];
export type IngestMode = 'DRY_RUN' | 'APPLY';

export class NotApprovedError extends Error {
  constructor(public readonly root: string, public readonly mode: IngestMode) { super(`Importing from ${root} (${mode}) has not been approved. The owner must approve this directory first.`); }
}

export const approvalPath = (stateDir: string) => path.join(stateDir, 'approvals', 'ingest.json');

export interface Policy { approved: ApprovedRoot[] }

export function loadPolicy(stateDir: string): Policy {
  try { return { approved: ApprovalFile.parse(JSON.parse(fs.readFileSync(approvalPath(stateDir), 'utf8'))).roots }; }
  catch { return { approved: [] }; }                                         // missing or malformed file = nothing approved
}

/** Canonical form used for comparisons: absolute, symlinks resolved when the path exists. */
export const canonical = (p: string): string => { const r = path.resolve(p); try { return fs.realpathSync(r); } catch { return r; } };

export const isInside = (root: string, p: string): boolean => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** Throws NotApprovedError unless `root` (canonicalised) is exactly an approved directory for this mode. */
export function assertApproved(policy: Policy, root: string, mode: IngestMode): string {
  const c = canonical(root);
  const hit = policy.approved.find((a) => canonical(a.path) === c && a.modes.includes(mode));
  if (!hit) throw new NotApprovedError(c, mode);
  return c;
}
