import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import { postedCheckIn, type PostedCheck } from '../instagram/service.js';
import type { LibraryService, PhotoCard } from '../library/service.js';
import { suggestCaptions, suggestHashtags, CAPTION_MODEL, type PhotoFacts } from './captions.js';
import { writeCaptions, type VisualSummary } from './ai-captions.js';
import { OllamaClient, OllamaUnavailable, OllamaBadAnswer } from '../ai/ollama.js';

/**
 * Drafts, approval and the schedule. This module PLANS: it never contacts Instagram, never changes a photograph, and never moves a
 * publication beyond SCHEDULED/CANCELLED (the database refuses that to the API role anyway). The publisher arrives in Phase 15, runs only
 * against a mock Graph server, and nothing is sent unattended without the owner's approval.
 */
const Uuid = z.string().uuid();
const hashtag = z.string().trim().transform((s) => s.replace(/^#+/, '')).pipe(z.string().regex(/^[\p{L}\p{N}_]{1,60}$/u, 'a hashtag may contain letters, digits and underscores only'));
export const MAX_CAPTION = 2200, MAX_TAGS = 30, MIN_LEAD_MS = 60_000, DAILY_LIMIT = 25;
const Iso = z.string().datetime({ offset: true });
export const CreateSchema = z.object({ photoId: Uuid, caption: z.string().max(MAX_CAPTION).default(''), hashtags: z.array(hashtag).max(MAX_TAGS).default([]), title: z.string().trim().max(120).nullable().optional() }).strict();
export const PatchSchema = z.object({
  caption: z.string().max(MAX_CAPTION).optional(), hashtags: z.array(hashtag).max(MAX_TAGS).optional(), title: z.string().trim().max(120).nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(),
  origin: z.enum(['USER', 'AI', 'AI_EDITED']).optional(), style: z.enum(['STORYTELLING', 'EDUCATIONAL', 'SHORT']).optional(), model: z.string().max(60).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const ApproveSchema = z.object({ acknowledgeHistory: z.boolean().default(false) }).strict();
export const ScheduleSchema = z.object({ scheduledAt: Iso, timezone: z.string().min(1).max(60) }).strict();
export const ReschedSchema = z.object({ scheduledAt: Iso, timezone: z.string().min(1).max(60).optional() }).strict();
export const ListSchema = z.object({
  state: z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(z.enum(['DRAFT', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'])).max(7).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(40), cursor: z.string().max(300).optional(),
}).strict();
export const CalendarSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

type Code = 'not_found' | 'invalid' | 'conflict' | 'history' | 'limit';
export type Out<T> = { ok: true; value: T } | { ok: false; code: Code; message: string; extra?: Record<string, unknown> };
const ok = <T>(value: T): Out<T> => ({ ok: true, value });
const no = (code: Code, message: string, extra?: Record<string, unknown>): Out<never> => ({ ok: false, code, message, ...(extra ? { extra } : {}) });

export interface ScheduleView { id: string; scheduledAt: string; timezone: string; state: string; attemptCount: number; errorCode: string | null; errorMessage: string | null; publishedAt: string | null; permalink: string | null }
export interface DraftView {
  id: string; photoId: string; photo: PhotoCard | null; title: string | null; caption: string; hashtags: string[]; notes: string | null; state: string; createdBy: string;
  approvedAt: string | null; historyCheck: PostedCheck | null; historyOverrideAt: string | null; schedule: ScheduleView | null; createdAt: string; updatedAt: string;
}
interface DRow { id: string; photo_id: string; internal_title: string | null; caption_body: string; hashtags: string[]; internal_notes: string | null; state: string; created_by: string; approved_at: Date | null; history_check: PostedCheck | null; history_override_at: Date | null; created_at: Date; updated_at: Date;
  s_id: string | null; scheduled_at: Date | null; s_tz: string | null; s_state: string | null; attempts: number | null; error_code: string | null; error_message: string | null; published_at: Date | null; permalink: string | null }
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const fullTextLength = (caption: string, tags: string[]) => caption.length + (tags.length ? 2 + tags.map((t) => `#${t}`).join(' ').length : 0);
const dedupe = (tags: string[]) => { const seen = new Set<string>(); return tags.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };

export class PublishingService {
  constructor(private readonly sql: Sql, private readonly library: LibraryService, private readonly now: () => Date = () => new Date(), private readonly ollama: OllamaClient | null = null) {}

  private select(tx: Sql, where: ReturnType<Sql>) {
    return tx<DRow[]>`
      SELECT d.id, d.photo_id, d.internal_title, d.caption_body, d.hashtags, d.internal_notes, d.state, d.created_by, d.approved_at, d.history_check, d.history_override_at, d.created_at, d.updated_at,
             s.id AS s_id, s.scheduled_at, s.timezone AS s_tz, s.state AS s_state, s.attempt_count AS attempts, s.error_code, s.error_message, s.published_at, s.permalink
        FROM publishing_drafts d LEFT JOIN scheduled_publications s ON s.draft_id = d.id WHERE ${where}`;
  }
  private async views(userId: string, rows: DRow[]): Promise<DraftView[]> {
    const cards = new Map((await this.library.cards(userId, [...new Set(rows.map((r) => r.photo_id))])).map((c) => [c.id, c]));
    return rows.map((r) => ({
      id: r.id, photoId: r.photo_id, photo: cards.get(r.photo_id) ?? null, title: r.internal_title, caption: r.caption_body, hashtags: r.hashtags, notes: r.internal_notes, state: r.state, createdBy: r.created_by,
      approvedAt: iso(r.approved_at), historyCheck: r.history_check, historyOverrideAt: iso(r.history_override_at), createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
      schedule: r.s_id ? { id: r.s_id, scheduledAt: r.scheduled_at!.toISOString(), timezone: r.s_tz!, state: r.s_state!, attemptCount: r.attempts ?? 0, errorCode: r.error_code, errorMessage: r.error_message, publishedAt: iso(r.published_at), permalink: r.permalink } : null,
    }));
  }

  async create(userId: string, c: z.infer<typeof CreateSchema>): Promise<Out<DraftView>> {
    const tags = dedupe(c.hashtags); if (fullTextLength(c.caption, tags) > MAX_CAPTION) return no('invalid', `The caption and hashtags together may not exceed ${MAX_CAPTION} characters.`);
    const id = await withUser(this.sql, userId, async (tx) => {
      const [p] = await tx<{ v: string }[]>`SELECT current_version_id AS v FROM photos WHERE id = ${c.photoId}::uuid AND deleted_at IS NULL`; if (!p) return null;
      const [d] = await tx<{ id: string }[]>`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id, internal_title, caption_body, hashtags) VALUES (${userId}, ${c.photoId}::uuid, ${p.v}::uuid, ${c.title ?? null}, ${c.caption}, ${tags}) RETURNING id`;
      if (c.caption) await tx`INSERT INTO caption_versions (user_id, photo_id, draft_id, body, origin) VALUES (${userId}, ${c.photoId}::uuid, ${d!.id}::uuid, ${c.caption}, 'USER')`;
      return d!.id;
    });
    if (!id) return no('not_found', 'No such photograph.');
    return ok((await this.get(userId, id))!);
  }

  async get(userId: string, id: string): Promise<DraftView | null> {
    const rows = await withUser(this.sql, userId, (tx) => this.select(tx, tx`d.id = ${id}::uuid`));
    return rows[0] ? (await this.views(userId, rows))[0]! : null;
  }
  /** The publisher's log for a post: every step it took, how it ended, and (for failures) why. Append-only in the database. */
  async attempts(userId: string, draftId: string) {
    const rows = await withUser(this.sql, userId, (tx) => tx<{ id: string; phase: string; outcome: string | null; error_code: string | null; started_at: Date; finished_at: Date | null; platform_error: { message?: string } | null }[]>`
      SELECT a.id, a.phase, a.outcome, a.error_code, a.started_at, a.finished_at, a.platform_error FROM publication_attempts a JOIN scheduled_publications s ON s.id = a.scheduled_publication_id WHERE s.draft_id = ${draftId}::uuid ORDER BY a.started_at, a.id LIMIT 200`);
    return rows.map((a) => ({ id: a.id, phase: a.phase, outcome: a.outcome, errorCode: a.error_code, message: a.platform_error?.message ?? null, startedAt: a.started_at.toISOString(), finishedAt: a.finished_at?.toISOString() ?? null }));
  }
  async versions(userId: string, id: string) {
    return withUser(this.sql, userId, (tx) => tx<{ id: string; body: string; style: string | null; origin: string; model: string | null; created_at: Date }[]>`SELECT id, body, style, origin, model, created_at FROM caption_versions WHERE draft_id = ${id}::uuid ORDER BY created_at DESC LIMIT 30`)
      .then((r) => r.map((v) => ({ id: v.id, body: v.body, style: v.style, origin: v.origin, model: v.model, createdAt: v.created_at.toISOString() })));
  }

  async list(userId: string, p: z.infer<typeof ListSchema>): Promise<Out<{ items: DraftView[]; nextCursor: string | null }>> {
    let cur: { t: string; id: string } | null = null;
    if (p.cursor) { try { cur = z.object({ t: z.string().max(40), id: Uuid }).parse(JSON.parse(Buffer.from(p.cursor, 'base64url').toString('utf8'))); } catch { return no('invalid', 'The page position is no longer valid.'); } }
    const rows = await withUser(this.sql, userId, (tx) => tx<(DRow & { ut: string })[]>`
      SELECT * FROM (SELECT d.id, d.photo_id, d.internal_title, d.caption_body, d.hashtags, d.internal_notes, d.state, d.created_by, d.approved_at, d.history_check, d.history_override_at, d.created_at, d.updated_at, d.updated_at::text AS ut,
             s.id AS s_id, s.scheduled_at, s.timezone AS s_tz, s.state AS s_state, s.attempt_count AS attempts, s.error_code, s.error_message, s.published_at, s.permalink
        FROM publishing_drafts d LEFT JOIN scheduled_publications s ON s.draft_id = d.id) x
       WHERE true ${p.state?.length ? tx`AND x.state = ANY(${p.state}::text[])` : tx``} ${cur ? tx`AND (x.updated_at, x.id) < (${cur.t}::text::timestamptz, ${cur.id}::uuid)` : tx``}
       ORDER BY x.updated_at DESC, x.id DESC LIMIT ${p.limit + 1}`);
    const page = rows.slice(0, p.limit); const last = page[page.length - 1];
    return ok({ items: await this.views(userId, page), nextCursor: rows.length > p.limit && last ? Buffer.from(JSON.stringify({ t: last.ut, id: last.id })).toString('base64url') : null });
  }

  async update(userId: string, id: string, p: z.infer<typeof PatchSchema>): Promise<Out<DraftView>> {
    const r = await withUser(this.sql, userId, async (tx): Promise<Out<null>> => {
      const [d] = await tx<{ photo_id: string; state: string; caption_body: string; hashtags: string[] }[]>`SELECT photo_id, state, caption_body, hashtags FROM publishing_drafts WHERE id = ${id}::uuid FOR UPDATE`;
      if (!d) return no('not_found', 'No such draft.');
      if (!['DRAFT', 'READY'].includes(d.state)) return no('conflict', d.state === 'CANCELLED' ? 'Reopen the draft to edit it.' : 'Remove it from the schedule before editing it.');
      const caption = p.caption ?? d.caption_body; const tags = p.hashtags ? dedupe(p.hashtags) : d.hashtags;
      if (fullTextLength(caption, tags) > MAX_CAPTION) return no('invalid', `The caption and hashtags together may not exceed ${MAX_CAPTION} characters.`);
      const contentChanged = caption !== d.caption_body || tags.join(' ') !== d.hashtags.join(' ');
      // approval belongs to the exact words that were approved: changing them withdraws it
      await tx`UPDATE publishing_drafts SET caption_body = ${caption}, hashtags = ${tags},
                 internal_title = CASE WHEN ${p.title !== undefined} THEN ${p.title ?? null} ELSE internal_title END, internal_notes = CASE WHEN ${p.notes !== undefined} THEN ${p.notes ?? null} ELSE internal_notes END,
                 state = CASE WHEN ${contentChanged} THEN 'DRAFT' ELSE state END, approved_at = CASE WHEN ${contentChanged} THEN NULL ELSE approved_at END, approved_by = CASE WHEN ${contentChanged} THEN NULL ELSE approved_by END,
                 history_override_at = CASE WHEN ${contentChanged} THEN NULL ELSE history_override_at END WHERE id = ${id}::uuid`;
      if (caption !== d.caption_body && caption.trim()) {
        const [prev] = await tx<{ id: string }[]>`SELECT id FROM caption_versions WHERE draft_id = ${id}::uuid ORDER BY created_at DESC LIMIT 1`;
        await tx`INSERT INTO caption_versions (user_id, photo_id, draft_id, parent_id, body, style, origin, model) VALUES (${userId}, ${d.photo_id}::uuid, ${id}::uuid, ${prev?.id ?? null}, ${caption}, ${p.style ?? null}, ${p.origin ?? 'USER'}, ${p.model ?? null})`;
      }
      return ok(null);
    });
    return r.ok ? ok((await this.get(userId, id))!) : r;
  }

  private async transition(userId: string, id: string, f: (tx: Sql, d: { photo_id: string; state: string; caption_body: string; approved_at: Date | null }) => Promise<Out<null>>): Promise<Out<DraftView>> {
    const r = await withUser(this.sql, userId, async (tx) => {
      const [d] = await tx<{ photo_id: string; state: string; caption_body: string; approved_at: Date | null }[]>`SELECT photo_id, state, caption_body, approved_at FROM publishing_drafts WHERE id = ${id}::uuid FOR UPDATE`;
      return d ? f(tx, d) : no('not_found', 'No such draft.');
    });
    return r.ok ? ok((await this.get(userId, id))!) : r;
  }

  async markReady(userId: string, id: string) {
    return this.transition(userId, id, async (tx, d) => {
      if (d.state === 'READY') return ok(null); if (d.state !== 'DRAFT') return no('conflict', `A ${d.state.toLowerCase()} draft cannot be marked ready.`);
      if (!d.caption_body.trim()) return no('invalid', 'Write a caption first — an empty caption is not published.');
      const check = await postedCheckIn(tx, d.photo_id);
      await tx`UPDATE publishing_drafts SET state = 'READY', history_check = ${tx.json((check ?? null) as never)} WHERE id = ${id}::uuid`; return ok(null);
    });
  }
  async unready(userId: string, id: string) {
    return this.transition(userId, id, async (tx, d) => {
      if (d.state === 'DRAFT') return ok(null); if (d.state !== 'READY') return no('conflict', 'Remove it from the schedule first.');
      await tx`UPDATE publishing_drafts SET state = 'DRAFT', approved_at = NULL, approved_by = NULL, history_override_at = NULL WHERE id = ${id}::uuid`; return ok(null);
    });
  }
  /** Approval is the person's explicit yes to these exact words and this photograph. If it was posted before (or something like it was), they must say so. */
  async approve(userId: string, id: string, a: z.infer<typeof ApproveSchema>) {
    return this.transition(userId, id, async (tx, d) => {
      if (d.state !== 'READY') return no('conflict', 'Mark the draft ready before approving it.');
      const check = await postedCheckIn(tx, d.photo_id);
      if (check && check.kind !== 'none' && !a.acknowledgeHistory) return no('history', check.kind === 'same' ? 'This photograph was already posted. Confirm that you want to post it again.' : 'A similar image was already posted. Confirm that you want to continue.', { history: check });
      await tx`UPDATE publishing_drafts SET approved_at = now(), approved_by = ${userId}::uuid, history_check = ${tx.json((check ?? null) as never)}, history_override_at = ${check && check.kind !== 'none' ? this.now() : null} WHERE id = ${id}::uuid`;
      return ok(null);
    });
  }

  private async checkSlot(tx: Sql, userId: string, at: Date, excludeScheduleId: string | null): Promise<Out<null>> {
    if (at.getTime() < this.now().getTime() + MIN_LEAD_MS) return no('invalid', 'Choose a time at least a minute in the future.');
    const day = 86_400_000;
    for (const [from, to] of [[new Date(at.getTime() - day), at], [at, new Date(at.getTime() + day)]] as const) {
      const [c] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM scheduled_publications WHERE user_id = ${userId}::uuid AND state IN ('SCHEDULED','PUBLISHING','PUBLISHED') AND scheduled_at BETWEEN ${from} AND ${to} AND (${excludeScheduleId}::uuid IS NULL OR id <> ${excludeScheduleId}::uuid)`;
      if (c!.n >= DAILY_LIMIT) return no('limit', `Instagram allows ${DAILY_LIMIT} posts per 24 hours through its API; that window is full.`);
    }
    return ok(null);
  }
  private async validZone(tx: Sql, tz: string): Promise<boolean> { const [r] = await tx<{ ok: boolean }[]>`SELECT is_valid_timezone(${tz}) AS ok`; return !!r?.ok; }

  async schedule(userId: string, id: string, s: z.infer<typeof ScheduleSchema>) {
    const at = new Date(s.scheduledAt);
    return this.transition(userId, id, async (tx, d) => {
      if (d.state !== 'READY') return no('conflict', d.state === 'SCHEDULED' ? 'It is already scheduled — reschedule it instead.' : 'Mark the draft ready first.');
      if (!d.approved_at) return no('conflict', 'Approve the draft before scheduling it.');
      if (!(await this.validZone(tx, s.timezone))) return no('invalid', 'Unknown time zone.');
      const slot = await this.checkSlot(tx, userId, at, null); if (!slot.ok) return slot;
      const [old] = await tx<{ id: string }[]>`SELECT id FROM scheduled_publications WHERE draft_id = ${id}::uuid`;
      if (old) await tx`UPDATE scheduled_publications SET state = 'SCHEDULED', scheduled_at = ${at}, timezone = ${s.timezone} WHERE id = ${old.id}::uuid`;
      else await tx`INSERT INTO scheduled_publications (user_id, draft_id, scheduled_at, timezone, state) VALUES (${userId}::uuid, ${id}::uuid, ${at}, ${s.timezone}, 'SCHEDULED')`;
      await tx`UPDATE publishing_drafts SET state = 'SCHEDULED' WHERE id = ${id}::uuid`; return ok(null);
    });
  }

  private async withSchedule(userId: string, scheduleId: string, f: (tx: Sql, s: { draft_id: string; state: string; timezone: string }) => Promise<Out<null>>): Promise<Out<DraftView>> {
    const r = await withUser(this.sql, userId, async (tx): Promise<Out<{ draftId: string }>> => {
      const [s] = await tx<{ draft_id: string; state: string; timezone: string }[]>`SELECT draft_id, state, timezone FROM scheduled_publications WHERE id = ${scheduleId}::uuid FOR UPDATE`;
      if (!s) return no('not_found', 'No such scheduled post.');
      const out = await f(tx, s); return out.ok ? ok({ draftId: s.draft_id }) : out;
    });
    return r.ok ? ok((await this.get(userId, r.value.draftId))!) : r;
  }
  /** Drag-to-reschedule and "retry a failed post": a FAILED post goes back to SCHEDULED with its attempts reset (done by the database guard). */
  async reschedule(userId: string, scheduleId: string, p: z.infer<typeof ReschedSchema>) {
    const at = new Date(p.scheduledAt);
    return this.withSchedule(userId, scheduleId, async (tx, s) => {
      if (!['SCHEDULED', 'FAILED', 'CANCELLED'].includes(s.state)) return no('conflict', s.state === 'PUBLISHED' ? 'It has already been published.' : 'It is being published right now.');
      const tz = p.timezone ?? s.timezone; if (!(await this.validZone(tx, tz))) return no('invalid', 'Unknown time zone.');
      const slot = await this.checkSlot(tx, userId, at, scheduleId); if (!slot.ok) return slot;
      const [d] = await tx<{ approved_at: Date | null; state: string }[]>`SELECT approved_at, state FROM publishing_drafts WHERE id = ${s.draft_id}::uuid FOR UPDATE`;
      if (!d?.approved_at) return no('conflict', 'The draft is no longer approved.');
      await tx`UPDATE scheduled_publications SET scheduled_at = ${at}, timezone = ${tz}, state = 'SCHEDULED' WHERE id = ${scheduleId}::uuid`;
      await tx`UPDATE publishing_drafts SET state = 'SCHEDULED' WHERE id = ${s.draft_id}::uuid`; return ok(null);
    });
  }
  async cancelSchedule(userId: string, scheduleId: string) {
    return this.withSchedule(userId, scheduleId, async (tx, s) => {
      if (s.state === 'CANCELLED') return ok(null); if (!['SCHEDULED', 'FAILED'].includes(s.state)) return no('conflict', s.state === 'PUBLISHED' ? 'It has already been published.' : 'It is being published right now.');
      await tx`UPDATE scheduled_publications SET state = 'CANCELLED' WHERE id = ${scheduleId}::uuid`;
      await tx`UPDATE publishing_drafts SET state = 'READY' WHERE id = ${s.draft_id}::uuid`; return ok(null);
    });
  }
  async cancelDraft(userId: string, id: string) {
    return this.transition(userId, id, async (tx, d) => {
      if (d.state === 'CANCELLED') return ok(null);
      const [sc] = await tx<{ state: string }[]>`SELECT state FROM scheduled_publications WHERE draft_id = ${id}::uuid`;
      if (['PUBLISHING', 'PUBLISHED'].includes(d.state) || (sc && ['PUBLISHING', 'PUBLISHED'].includes(sc.state))) return no('conflict', 'It is published or being published.');
      await tx`UPDATE scheduled_publications SET state = 'CANCELLED' WHERE draft_id = ${id}::uuid AND state IN ('SCHEDULED','FAILED')`;
      await tx`UPDATE publishing_drafts SET state = 'CANCELLED' WHERE id = ${id}::uuid`; return ok(null);
    });
  }
  async reopen(userId: string, id: string) {
    return this.transition(userId, id, async (tx, d) => {
      if (d.state !== 'CANCELLED') return no('conflict', 'Only a cancelled draft can be reopened.');
      await tx`UPDATE publishing_drafts SET state = 'DRAFT', approved_at = NULL, approved_by = NULL, history_override_at = NULL WHERE id = ${id}::uuid`; return ok(null);
    });
  }

  /** Everything scheduled (and already published or failed) in a window of at most 100 days. */
  async calendar(userId: string, from: string, to: string): Promise<Out<{ items: Array<{ id: string; draftId: string; photoId: string; title: string; scheduledAt: string; timezone: string; state: string; error: string | null; caption: string }> }>> {
    const a = new Date(`${from}T00:00:00Z`), b = new Date(`${to}T23:59:59Z`);
    if (!(a < b) || b.getTime() - a.getTime() > 100 * 86_400_000) return no('invalid', 'The window must be between one and 100 days.');
    const lo = new Date(a.getTime() - 86_400_000), hi = new Date(b.getTime() + 86_400_000);       // a day of slack: the calendar groups by each post's own time zone
    const rows = await withUser(this.sql, userId, (tx) => tx<{ id: string; draft_id: string; photo_id: string; title: string | null; scheduled_at: Date; timezone: string; state: string; err: string | null; caption: string; fname: string }[]>`
      SELECT s.id, s.draft_id, d.photo_id, coalesce(d.internal_title, p.title) AS title, s.scheduled_at, s.timezone, s.state, s.error_message AS err, d.caption_body AS caption, regexp_replace(v.source_relpath, '^.*/', '') AS fname
        FROM scheduled_publications s JOIN publishing_drafts d ON d.id = s.draft_id JOIN photos p ON p.id = d.photo_id JOIN photo_versions v ON v.id = d.photo_version_id
       WHERE s.scheduled_at BETWEEN ${lo} AND ${hi} AND s.state <> 'CANCELLED' ORDER BY s.scheduled_at LIMIT 1000`);
    return ok({ items: rows.map((r) => ({ id: r.id, draftId: r.draft_id, photoId: r.photo_id, title: r.title ?? r.fname, scheduledAt: r.scheduled_at.toISOString(), timezone: r.timezone, state: r.state, error: r.err, caption: r.caption })) });
  }

  private async facts(tx: Sql, photoId: string): Promise<PhotoFacts | null> {
    const [p] = await tx<{ title: string | null; place: string | null; capture_at: Date | null; description: string | null; camera: string | null; lens: string | null; focal: number | null; aperture: number | null; shutter: number | null; iso: number | null; keywords: string[]; fname: string }[]>`
      SELECT p.title, p.trip_location AS place, p.capture_at, p.description, concat_ws(' ', v.camera_make, v.camera_model) AS camera, v.lens, v.focal_length_mm AS focal, v.aperture, v.shutter_s AS shutter, v.iso, v.keywords, regexp_replace(v.source_relpath, '^.*/', '') AS fname
        FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = ${photoId}::uuid AND p.deleted_at IS NULL`;
    if (!p) return null;
    const species = await tx<{ name: string; scientific: string | null }[]>`SELECT s.common_name AS name, s.scientific_name AS scientific FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.photo_id = ${photoId}::uuid AND ps.status = 'CONFIRMED' ORDER BY ps.confidence DESC NULLS LAST`;
    return { title: p.title, place: p.place, species, capturedAt: p.capture_at, description: p.description, camera: p.camera?.trim() || null, lens: p.lens, focalLengthMm: p.focal, aperture: p.aperture, shutterS: p.shutter, iso: p.iso, keywords: p.keywords };
  }
  /** Only species a person has CONFIRMED are used: an unconfirmed AI suggestion is never turned into a public caption. */
  async suggestCaptions(userId: string, photoId: string) {
    return withUser(this.sql, userId, async (tx) => { const f = await this.facts(tx, photoId); return f ? { model: CAPTION_MODEL, note: 'Arranged from what your library records about this photograph. No AI model is used, and nothing is invented.', suggestions: suggestCaptions(f, photoId) } : null; });
  }
  /** Drafts from the LOCAL language model. `unavailable` is returned (never a silent template) when Ollama cannot answer. */
  async suggestWithModel(userId: string, photoId: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'not_found' | 'unavailable'; message: string }> {
    if (!this.ollama) return { ok: false, reason: 'unavailable', message: 'The local language model is not configured.' };
    const ctx = await withUser(this.sql, userId, async (tx) => {
      const f = await this.facts(tx, photoId); if (!f) return null;
      const [a] = await tx<{ description: string | null; scenes: string[]; environment: string | null; lighting: string | null; style: string | null }[]>`SELECT a.description, a.scenes, a.environment, a.lighting, a.style FROM ai_analyses a JOIN photos p ON p.current_version_id = a.photo_version_id WHERE p.id = ${photoId}::uuid AND a.provider = 'ollama' ORDER BY a.created_at DESC LIMIT 1`;
      const un = await tx<{ name: string }[]>`SELECT s.common_name AS name FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.photo_id = ${photoId}::uuid AND ps.status = 'SUGGESTED'`;
      return { f, visual: (a ?? null) as VisualSummary | null, unconfirmed: un.map((x) => x.name) };
    });
    if (!ctx) return { ok: false, reason: 'not_found', message: 'No such photograph.' };
    try {
      const r = await writeCaptions(this.ollama, ctx.f, ctx.visual, ctx.unconfirmed, photoId);
      return { ok: true, value: { model: r.model, note: 'Written by the language model on this computer from the facts your library holds (only species you confirmed are used). These are drafts: edit them; nothing is posted without your approval.', suggestions: r.captions, hashtags: r.hashtags } };
    } catch (e) {
      if (e instanceof OllamaUnavailable || e instanceof OllamaBadAnswer) return { ok: false, reason: 'unavailable', message: `The local language model could not write captions right now (${e.message}). Use the template suggestions instead.` };
      throw e;
    }
  }
  async suggestHashtags(userId: string, photoId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const f = await this.facts(tx, photoId); if (!f) return null;
      const hist = await tx<{ tag: string; posts: number }[]>`SELECT t AS tag, count(*)::int AS posts FROM social_posts sp, unnest(sp.hashtags) t WHERE NOT (sp.raw ->> 'synthetic' IS NOT DISTINCT FROM 'true') GROUP BY 1 ORDER BY posts DESC, 1 LIMIT 15`;
      return { suggestions: suggestHashtags(f, hist) };
    });
  }
}
