import type { Sql } from 'postgres';
import { withUser } from '../db/connect.js';

/**
 * What the background machinery is doing for ONE person, for the System page: queues by kind, recent failures (with the reason, never a secret), the
 * latest import, what is scheduled to publish, and the state of the Instagram connection. Read-only.
 */
export interface WorkStatus {
  queues: Array<{ kind: string; queued: number; running: number; failed24h: number; dead: number; oldestQueuedSeconds: number | null }>;
  failures: Array<{ kind: string; state: string; at: string; error: string }>;
  imports: { last: { mode: string; state: string; startedAt: string; finishedAt: string | null; counters: Record<string, number>; error: string | null } | null; running: boolean };
  previews: { pending: number; failed: number };
  publishing: { scheduled: number; nextAt: string | null; publishing: number; failed7d: number; overdue: number };
  instagram: { connected: boolean; status: string | null; daysLeft: number | null; username: string | null } | null;
  problems: string[];
}
const KIND_LABEL: Record<string, string> = { 'derive.preview': 'Previews', 'ai.analyze': 'AI analysis', 'embed.image': 'Visual similarity', 'embed.text': 'Meaning search index', 'ig.sync': 'Instagram sync', 'ig.match': 'Instagram matching', 'ig.token.refresh': 'Instagram token renewal' };
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

export async function workStatus(sql: Sql, userId: string, now = new Date()): Promise<WorkStatus> {
  return withUser(sql, userId, async (tx) => {
    const q = await tx<{ kind: string; queued: number; running: number; failed24h: number; dead: number; oldest: number | null }[]>`
      SELECT kind, count(*) FILTER (WHERE state = 'QUEUED')::int AS queued, count(*) FILTER (WHERE state = 'RUNNING')::int AS running,
             count(*) FILTER (WHERE state IN ('FAILED','DEAD') AND coalesce(finished_at, created_at) > now() - interval '24 hours')::int AS failed24h, count(*) FILTER (WHERE state = 'DEAD')::int AS dead,
             extract(epoch FROM now() - min(created_at) FILTER (WHERE state = 'QUEUED'))::int AS oldest
        FROM jobs WHERE created_at > now() - interval '30 days' OR state IN ('QUEUED','RUNNING','DEAD') GROUP BY kind ORDER BY kind`;
    const f = await tx<{ kind: string; state: string; at: Date; error: string | null }[]>`SELECT kind, state, coalesce(finished_at, created_at) AS at, last_error AS error FROM jobs WHERE state IN ('FAILED','DEAD') ORDER BY coalesce(finished_at, created_at) DESC LIMIT 8`;
    const [imp] = await tx<{ mode: string; state: string; started_at: Date; finished_at: Date | null; counters: Record<string, number>; error: string | null }[]>`SELECT mode, state, started_at, finished_at, counters, error FROM import_runs ORDER BY started_at DESC LIMIT 1`;
    const [pv] = await tx<{ pending: number; failed: number }[]>`SELECT count(*) FILTER (WHERE v.deriv_status IN ('PENDING','RUNNING'))::int AS pending, count(*) FILTER (WHERE v.deriv_status = 'FAILED')::int AS failed FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.deleted_at IS NULL`;
    const [pub] = await tx<{ scheduled: number; next_at: Date | null; publishing: number; failed7d: number; overdue: number }[]>`
      SELECT count(*) FILTER (WHERE state = 'SCHEDULED')::int AS scheduled, min(scheduled_at) FILTER (WHERE state = 'SCHEDULED') AS next_at, count(*) FILTER (WHERE state = 'PUBLISHING')::int AS publishing,
             count(*) FILTER (WHERE state = 'FAILED' AND last_attempt_at > now() - interval '7 days')::int AS failed7d, count(*) FILTER (WHERE state = 'SCHEDULED' AND scheduled_at < now() - interval '15 minutes')::int AS overdue FROM scheduled_publications`;
    const [ig] = await tx<{ status: string; token_expires_at: Date | null; username: string | null }[]>`SELECT status, token_expires_at, username FROM social_accounts WHERE platform = 'instagram' AND external_id NOT LIKE 'synthetic-%' ORDER BY (status = 'CONNECTED') DESC, created_at LIMIT 1`;
    const [ctl] = await tx<{ paused: boolean }[]>`SELECT coalesce(bool_or(paused) FILTER (WHERE queue = 'ai'), false) AS paused FROM queue_controls`;
    const aiWaiting = q.filter((r) => ['ai.analyze', 'embed.image', 'embed.text'].includes(r.kind)).reduce((n, r) => n + r.queued, 0);
    const queues = q.map((r) => ({ kind: r.kind, queued: r.queued, running: r.running, failed24h: r.failed24h, dead: r.dead, oldestQueuedSeconds: r.oldest }));
    const daysLeft = ig?.token_expires_at ? Math.floor((ig.token_expires_at.getTime() - now.getTime()) / 86_400_000) : null;
    const problems: string[] = [];
    if (ctl?.paused && aiWaiting > 0) problems.push(`AI analysis is paused with ${aiWaiting} job${aiWaiting === 1 ? '' : 's'} waiting — resume it in Settings → AI`);
    for (const r of queues) {
      if (r.dead > 0) problems.push(`${kindLabel(r.kind)}: ${r.dead} job${r.dead === 1 ? '' : 's'} gave up after repeated failures`);
      if (r.oldestQueuedSeconds !== null && r.oldestQueuedSeconds > 3600 && r.running === 0) problems.push(`${kindLabel(r.kind)}: waiting for ${Math.round(r.oldestQueuedSeconds / 3600)} h with nothing running — is the worker running?`);
    }
    if (pv && pv.failed > 0) problems.push(`${pv.failed} photograph${pv.failed === 1 ? '' : 's'} could not get a preview`);
    if (pub && pub.overdue > 0) problems.push(`${pub.overdue} scheduled post${pub.overdue === 1 ? ' is' : 's are'} overdue — the publisher is not running`);
    if (pub && pub.failed7d > 0) problems.push(`${pub.failed7d} scheduled post${pub.failed7d === 1 ? '' : 's'} failed in the last 7 days`);
    if (ig && ig.status === 'EXPIRED') problems.push('The Instagram token expired or was revoked — connect the account again');
    else if (ig && ig.status === 'CONNECTED' && daysLeft !== null && daysLeft <= 14) problems.push(`The Instagram token expires in ${Math.max(0, daysLeft)} days`);
    return {
      queues, failures: f.map((r) => ({ kind: r.kind, state: r.state, at: r.at.toISOString(), error: (r.error ?? '').slice(0, 200) })),
      imports: { last: imp ? { mode: imp.mode, state: imp.state, startedAt: imp.started_at.toISOString(), finishedAt: imp.finished_at?.toISOString() ?? null, counters: imp.counters, error: imp.error } : null, running: imp?.state === 'RUNNING' },
      previews: { pending: pv?.pending ?? 0, failed: pv?.failed ?? 0 },
      publishing: { scheduled: pub?.scheduled ?? 0, nextAt: pub?.next_at?.toISOString() ?? null, publishing: pub?.publishing ?? 0, failed7d: pub?.failed7d ?? 0, overdue: pub?.overdue ?? 0 },
      instagram: ig ? { connected: ig.status === 'CONNECTED', status: ig.status, daysLeft, username: ig.username } : null, problems,
    };
  });
}
