import type { Sql } from 'postgres';
import { withUser } from '../db/connect.js';

/**
 * The security audit trail (table audit_events, append-only). Recording is best effort by design: a failure to write an audit row must never
 * lock the owner out or hide the original error, so it is swallowed — but reported through `onError` so it reaches the log.
 */
export interface AuditEvent { id: number; at: string; action: string; ip: string | null; detail: Record<string, unknown> }
const SAFE_KEYS = /^(route|method|status|id|ids|via|reason|count|kind|mode)$/;

/** Only short scalar values under known key names are kept, so a caller can never put a body, a code or a token into the trail by accident. */
export function cleanDetail(d: Record<string, unknown> = {}): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!SAFE_KEYS.test(k)) continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}

export async function recordAudit(sql: Sql, userId: string, action: string, ip: string | null, detail: Record<string, unknown> = {}, onError?: (e: unknown) => void): Promise<void> {
  try {
    await withUser(sql, userId, (tx) => tx`INSERT INTO audit_events (user_id, action, ip, detail) VALUES (${userId}, ${action.slice(0, 120)}, ${ip}::inet, ${tx.json(cleanDetail(detail))})`);
  } catch (e) { onError?.(e); }
}

export async function listAudit(sql: Sql, userId: string, limit = 50): Promise<AuditEvent[]> {
  const rows = await withUser(sql, userId, (tx) => tx<{ id: string; at: Date; action: string; ip: string | null; detail: Record<string, unknown> }[]>`
    SELECT id, at, action, host(ip) AS ip, detail FROM audit_events ORDER BY at DESC, id DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
  return rows.map((r) => ({ id: Number(r.id), at: r.at.toISOString(), action: r.action, ip: r.ip, detail: r.detail }));
}
