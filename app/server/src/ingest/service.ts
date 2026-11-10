import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Sql } from 'postgres';
import { assertSafeLibraryRoot, folderMetadata } from '@photovault/shared';
import { withUser } from '../db/connect.js';
import { assertApproved, canonical, type IngestMode, type Policy } from './approval.js';
import { readMeta, sha256File, type FileMeta } from './extract.js';
import { absoluteInside, walk, type SkipReason } from './scan.js';

/**
 * Import planning and application. Rules (docs/SYNC_ARCHITECTURE.md §4):
 *   same path + same bytes            → unchanged (touch only)
 *   same path + different bytes       → NEW VERSION of the same photograph (the one automatic version link); user data stays on the photograph
 *   new path + bytes already known    → MOVED if the old path is gone from the scan, otherwise DUPLICATE_FILE (review queue; not imported twice)
 *   new path + same capture identity  → new version waiting for review (VERSION_REVIEW); never auto-merged
 *   otherwise                         → NEW photograph
 * A file that disappears is only marked source_present = false (and only after a complete scan): nothing is ever deleted.
 * DRY_RUN performs the same planning and records what it WOULD do, writing no photograph rows at all.
 */
export type Action = 'NEW' | 'NEW_VERSION' | 'MOVED' | 'DUPLICATE_FILE' | 'VERSION_REVIEW' | 'UNCHANGED' | 'SOURCE_MISSING' | 'SKIPPED' | 'ERROR';
export interface Counters {
  scanned: number; bytes: number; new: number; newVersions: number; moved: number; duplicateFiles: number; versionReview: number; unchanged: number; missing: number; errors: number;
  skipped: Partial<Record<SkipReason, number>>; directories: number; complete: boolean;
}
export const emptyCounters = (): Counters => ({ scanned: 0, bytes: 0, new: 0, newVersions: 0, moved: 0, duplicateFiles: 0, versionReview: 0, unchanged: 0, missing: 0, errors: 0, skipped: {}, directories: 0, complete: false });

export interface IngestDeps {
  sql: Sql; policy: Policy;
  /** where previews will be written by the worker; only checked here so a misconfiguration is caught before any file is read */
  derivativesDir?: string | null;
  concurrency?: number; heartbeatMs?: number; itemCap?: number;
  /** test hook: called after every processed batch of files */
  onBatch?: (c: Counters) => void | Promise<void>;
}
export interface RunResult { runId: string; state: 'COMPLETED' | 'FAILED' | 'CANCELLED'; counters: Counters; error?: string }

interface Known { versionId: string; photoId: string; relpath: string; sha: string; bytes: number | null; mtimeMs: number | null; present: boolean; state: string; identityKey: string | null; /** recorded under a narrower root inside this one (an earlier, smaller scan): matched by bytes only and re-homed when found */ foreign?: true; fromRoot?: string }
const hex = (b: Buffer) => b.toString('hex');

export class IngestService {
  private readonly conc: number; private readonly hb: number; private readonly cap: number;
  constructor(private readonly d: IngestDeps) { this.conc = Math.max(1, Math.min(d.concurrency ?? 4, 8)); this.hb = d.heartbeatMs ?? 2000; this.cap = d.itemCap ?? 20_000; }

  /** Marks runs whose process died (no heartbeat for `staleSeconds`) as INTERRUPTED so that they are visible and resumable. */
  async recover(userId: string, staleSeconds = 120): Promise<number> {
    return withUser(this.d.sql, userId, async (tx) => (await tx`UPDATE import_runs SET state = 'INTERRUPTED' WHERE state = 'RUNNING' AND heartbeat_at < now() - ${`${staleSeconds} seconds`}::interval RETURNING id`).length);
  }

  /** Starts a run in the background (returns as soon as the run is recorded). */
  async start(userId: string, rootPath: string, mode: IngestMode, signal?: AbortSignal): Promise<{ runId: string; done: Promise<RunResult> }> {
    const root = this.prepare(rootPath, mode);
    const ids = await this.openRun(userId, root, mode);
    return { runId: ids.runId, done: this.execute(userId, root, mode, ids, signal) };
  }

  async run(userId: string, rootPath: string, mode: IngestMode, signal?: AbortSignal): Promise<RunResult> { return (await this.start(userId, rootPath, mode, signal)).done; }

  // ------------------------------------------------------------------------------------------------ setup
  private prepare(rootPath: string, mode: IngestMode): string {
    const root = assertApproved(this.d.policy, rootPath, mode);            // 1. the owner approved exactly this directory, for this mode
    assertSafeLibraryRoot(root);                                           // 2. a plain folder of JPEG exports: no RAW files, no Lightroom catalogue, not a home/volume root
    if (this.d.derivativesDir) {
      const dd = canonical(this.d.derivativesDir);
      if (dd === root || dd.startsWith(root + '/') || root.startsWith(dd + '/')) throw new Error('the derivatives directory must be separate from the photograph source directory');
    }
    return root;
  }

  private async openRun(userId: string, root: string, mode: IngestMode): Promise<{ runId: string; rootId: string }> {
    return withUser(this.d.sql, userId, async (tx) => {
      const [r] = await tx<{ id: string }[]>`INSERT INTO library_roots (user_id, path, verified_at) VALUES (${userId}, ${root}, now())
        ON CONFLICT (user_id, path) DO UPDATE SET verified_at = now() RETURNING id`;
      const [prev] = await tx<{ id: string }[]>`SELECT id FROM import_runs WHERE library_root_id = ${r!.id} AND state IN ('INTERRUPTED','FAILED') AND mode = ${mode} ORDER BY started_at DESC LIMIT 1`;
      const [run] = await tx<{ id: string }[]>`INSERT INTO import_runs (user_id, library_root_id, mode, source_path, resumed_from) VALUES (${userId}, ${r!.id}, ${mode}, ${root}, ${prev?.id ?? null}) RETURNING id`;
      return { runId: run!.id, rootId: r!.id };
    });
  }

  // ------------------------------------------------------------------------------------------------ the run
  private async execute(userId: string, root: string, mode: IngestMode, ids: { runId: string; rootId: string }, signal?: AbortSignal): Promise<RunResult> {
    const c = emptyCounters(); const sql = this.d.sql;
    let itemsWritten = 0; let lastBeat = Date.now();
    const items: Array<{ relpath: string; action: Action; detail: string | null; sha: Buffer | null }> = [];
    const flush = async () => {
      if (!items.length) return;
      const batch = items.splice(0, items.length);
      await withUser(sql, userId, async (tx) => {
        for (let i = 0; i < batch.length; i += 500) {
          const part = batch.slice(i, i + 500);
          await tx`INSERT INTO import_items (user_id, run_id, relpath, action, detail, sha256) SELECT ${userId}::uuid, ${ids.runId}::uuid, r, a, d, CASE WHEN s IS NULL THEN NULL ELSE decode(s, 'hex') END FROM unnest(${part.map((x) => x.relpath)}::text[], ${part.map((x) => x.action)}::text[], ${part.map((x) => x.detail)}::text[], ${part.map((x) => (x.sha ? hex(x.sha) : null))}::text[]) AS t(r, a, d, s)`;
        }
      });
    };
    const note = (relpath: string, action: Action, detail: string | null = null, sha: Buffer | null = null) => {
      if (action === 'UNCHANGED') return;                                              // the common case is counted, not listed
      if (itemsWritten < this.cap) { items.push({ relpath, action, detail, sha }); itemsWritten++; }
    };
    const beat = async (force = false) => {
      if (!force && Date.now() - lastBeat < this.hb) return;
      lastBeat = Date.now();
      await flush();
      await withUser(sql, userId, (tx) => tx`UPDATE import_runs SET heartbeat_at = now(), counters = ${tx.json(c as never)} WHERE id = ${ids.runId}`);
    };

    try {
      // what the database already knows about this directory (one query; this is what makes the sync incremental)
      const known = await withUser(sql, userId, (tx) => tx<Array<{ id: string; photo_id: string; source_relpath: string; sha: Buffer; bytes: string | null; source_mtime: Date | null; source_present: boolean; state: string; identity_key: string | null }>>`
        SELECT v.id, v.photo_id, v.source_relpath, v.content_sha256 AS sha, v.bytes, v.source_mtime, v.source_present, v.state, p.identity_key
          FROM photo_versions v JOIN photos p ON p.id = v.photo_id WHERE v.library_root_id = ${ids.rootId} ORDER BY (v.state = 'ACTIVE'), v.version_no`);
      const byPath = new Map<string, Known>(); const bySha = new Map<string, Known[]>(); const photoByIdentity = new Map<string, string>();
      // superseded versions keep their hash (a re-export that returns to earlier bytes is a revert, not a new version) but do not own a path
      const add = (k: Known) => { if (k.state !== 'SUPERSEDED') byPath.set(k.relpath, k); const a = bySha.get(k.sha) ?? []; a.push(k); bySha.set(k.sha, a); if (k.identityKey) photoByIdentity.set(k.identityKey, k.photoId); };
      for (const r of known) add({ versionId: r.id, photoId: r.photo_id, relpath: r.source_relpath, sha: hex(r.sha), bytes: r.bytes === null ? null : Number(r.bytes), mtimeMs: r.source_mtime?.getTime() ?? null, present: r.source_present, state: r.state, identityKey: r.identity_key });
      // photographs an earlier, narrower scan recorded under a root INSIDE this one (e.g. …/MyPhotos/2026/DC before …/MyPhotos): offered by bytes only, so
      // finding the same file here re-homes the existing record (same photograph id, edits, previews) instead of importing a duplicate
      const inner = await withUser(sql, userId, (tx) => tx<Array<{ id: string; photo_id: string; source_relpath: string; sha: Buffer; bytes: string | null; source_mtime: Date | null; source_present: boolean; state: string; identity_key: string | null; root_id: string }>>`
        SELECT v.id, v.photo_id, v.source_relpath, v.content_sha256 AS sha, v.bytes, v.source_mtime, v.source_present, v.state, p.identity_key, v.library_root_id AS root_id
          FROM photo_versions v JOIN photos p ON p.id = v.photo_id JOIN library_roots r ON r.id = v.library_root_id
         WHERE r.id <> ${ids.rootId} AND starts_with(r.path, ${root.endsWith('/') ? root : root + '/'}) AND v.state <> 'SUPERSEDED'`);
      for (const r of inner) {
        const k: Known = { versionId: r.id, photoId: r.photo_id, relpath: r.source_relpath, sha: hex(r.sha), bytes: r.bytes === null ? null : Number(r.bytes), mtimeMs: r.source_mtime?.getTime() ?? null, present: r.source_present, state: r.state, identityKey: r.identity_key, foreign: true, fromRoot: r.root_id };
        const a = bySha.get(k.sha) ?? []; a.push(k); bySha.set(k.sha, a); if (k.identityKey) photoByIdentity.set(k.identityKey, k.photoId);
      }
      const seen = new Set<string>();
      const deferred: Array<{ relpath: string; sha: Buffer; meta: FileMeta; size: number; mtimeMs: number; existing: Known[] }> = [];

      // ---- 1. walk + read (bounded concurrency), classify + apply in order
      const queue: Array<{ relpath: string; size: number; mtimeMs: number }> = [];
      const flushQueue = async () => {
        const work = queue.splice(0, queue.length);
        for (let i = 0; i < work.length; i += this.conc) {
          if (signal?.aborted) return;
          const slice = work.slice(i, i + this.conc);
          const read = await Promise.all(slice.map(async (e) => {
            const k = byPath.get(e.relpath);
            // incremental: same size and modification time as last time → nothing to read
            if (k && k.present && k.bytes === e.size && k.mtimeMs !== null && Math.abs(k.mtimeMs - e.mtimeMs) < 1) return { e, skip: true as const };
            try { const abs = absoluteInside(root, e.relpath); const [sha, meta] = await Promise.all([sha256File(abs), readMeta(abs)]); return { e, sha, meta, skip: false as const }; }
            catch (err) { return { e, err: err instanceof Error ? err.message : String(err), skip: false as const }; }
          }));
          for (const r of read) {
            if ('err' in r && r.err) { c.errors++; note(r.e.relpath, 'ERROR', r.err.slice(0, 300)); continue; }
            if (r.skip) { c.unchanged++; continue; }
            if (!('sha' in r) || !r.sha) continue;
            const action = await this.classify(userId, ids.rootId, mode, r.e, r.sha, r.meta!, byPath, bySha, photoByIdentity, deferred, c, note);
            void action;
          }
          await beat();
          await this.d.onBatch?.(c);
        }
      };
      for await (const ev of walk(root, { signal })) {
        if (signal?.aborted) break;
        if (ev.type === 'dir') { c.directories++; continue; }
        if (ev.type === 'skip') { c.skipped[ev.skip.reason] = (c.skipped[ev.skip.reason] ?? 0) + 1; if (ev.skip.reason === 'raw_file' || ev.skip.reason === 'catalog' || ev.skip.reason === 'symlink' || ev.skip.reason === 'unreadable') note(ev.skip.relpath, 'SKIPPED', ev.skip.reason); continue; }
        c.scanned++; c.bytes += ev.entry.size; seen.add(ev.entry.relpath);
        queue.push(ev.entry);
        if (queue.length >= 200) await flushQueue();
      }
      await flushQueue();
      if (signal?.aborted) { await flush(); await this.finish(userId, ids.runId, 'CANCELLED', c, null); return { runId: ids.runId, state: 'CANCELLED', counters: c }; }

      // ---- 2. same bytes at a new path: moved (old path gone) or a second copy (old path still there)
      for (const d of deferred) {
        const stillThere = d.existing.filter((k) => !k.foreign && seen.has(k.relpath) && k.relpath !== d.relpath);
        if (stillThere.length === 0) {
          const target = d.existing[0]!;
          if (mode === 'APPLY') await this.applyMove(userId, ids.rootId, target, d.relpath, d.meta, d.mtimeMs, d.size);
          c.moved++; note(d.relpath, 'MOVED', target.foreign ? `re-homed from an earlier narrower scan (was ${target.relpath})` : `was ${target.relpath}`, d.sha);
          if (!target.foreign) byPath.delete(target.relpath);
          target.relpath = d.relpath; delete target.foreign; byPath.set(d.relpath, target); seen.add(d.relpath);
        } else {
          c.duplicateFiles++; note(d.relpath, 'DUPLICATE_FILE', `same bytes as ${stillThere[0]!.relpath}`, d.sha);
          if (mode === 'APPLY') await withUser(sql, userId, (tx) => tx`INSERT INTO review_queue (user_id, kind, subject)
            SELECT ${userId}, 'DUPLICATE_FILE', ${tx.json({ relpath: d.relpath, sameAs: stillThere[0]!.relpath, photoId: stillThere[0]!.photoId, sha256: hex(d.sha) } as never)}
             WHERE NOT EXISTS (SELECT 1 FROM review_queue q WHERE q.kind = 'DUPLICATE_FILE' AND q.subject ->> 'relpath' = ${d.relpath} AND q.subject ->> 'sha256' = ${hex(d.sha)})`);   // asked once; the answer is remembered
        }
      }

      // ---- 3. files that vanished: flagged, never deleted — and only after a COMPLETE walk
      c.complete = true;
      for (const k of byPath.values()) {
        if (!seen.has(k.relpath) && k.present && k.state !== 'SUPERSEDED') {
          c.missing++; note(k.relpath, 'SOURCE_MISSING', 'not found in the source directory; the record and all your edits are kept');
          if (mode === 'APPLY') await withUser(sql, userId, async (tx) => {
            await tx`UPDATE photo_versions SET source_present = false WHERE id = ${k.versionId}::uuid`;
            await tx`INSERT INTO sync_events (user_id, type, relpath, photo_version_id, detail) VALUES (${userId}, 'SOURCE_MISSING', ${k.relpath}, ${k.versionId}::uuid, ${tx.json({ run: ids.runId } as never)})`;
          });
        }
      }
      await flush();
      await this.finish(userId, ids.runId, 'COMPLETED', c, null);
      return { runId: ids.runId, state: 'COMPLETED', counters: c };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await flush().catch(() => undefined);
      await this.finish(userId, ids.runId, 'FAILED', c, msg.slice(0, 500)).catch(() => undefined);
      return { runId: ids.runId, state: 'FAILED', counters: c, error: msg };
    }
  }

  private async finish(userId: string, runId: string, state: 'COMPLETED' | 'FAILED' | 'CANCELLED', c: Counters, error: string | null): Promise<void> {
    await withUser(this.d.sql, userId, (tx) => tx`UPDATE import_runs SET state = ${state}, finished_at = now(), heartbeat_at = now(), counters = ${tx.json(c as never)}, error = ${error} WHERE id = ${runId}`);
  }

  // ------------------------------------------------------------------------------------------------ classification
  private async classify(
    userId: string, rootId: string, mode: IngestMode, e: { relpath: string; size: number; mtimeMs: number }, sha: Buffer, meta: FileMeta,
    byPath: Map<string, Known>, bySha: Map<string, Known[]>, photoByIdentity: Map<string, string>, deferred: Array<{ relpath: string; sha: Buffer; meta: FileMeta; size: number; mtimeMs: number; existing: Known[] }>,
    c: Counters, note: (relpath: string, action: Action, detail?: string | null, sha?: Buffer | null) => void,
  ): Promise<Action> {
    const here = byPath.get(e.relpath); const shaHex = hex(sha);
    if (here) {
      if (here.sha === shaHex) {                                                       // touched but identical bytes
        if (mode === 'APPLY') await withUser(this.d.sql, userId, (tx) => tx`UPDATE photo_versions SET source_mtime = ${new Date(e.mtimeMs)}, bytes = ${e.size}, source_present = true WHERE id = ${here.versionId}::uuid`);
        here.mtimeMs = e.mtimeMs; here.bytes = e.size; here.present = true; c.unchanged++; return 'UNCHANGED';
      }
      const earlier = bySha.get(shaHex)?.find((k) => k.photoId === here.photoId && k.versionId !== here.versionId);
      if (earlier) {                                                                   // the file went back to bytes an earlier version already had: restore that version
        c.newVersions++; note(e.relpath, 'NEW_VERSION', `back to an earlier version (${shaHex.slice(0, 8)})`, sha);
        if (mode === 'APPLY') {
          await this.applyRevert(userId, here, earlier, e);
          const prev = here.versionId; here.versionId = earlier.versionId; here.sha = shaHex; here.bytes = e.size; here.mtimeMs = e.mtimeMs; here.state = 'ACTIVE'; earlier.state = 'ACTIVE'; void prev;
        }
        return 'NEW_VERSION';
      }
      // re-export over the same file name: a new version of the same photograph
      c.newVersions++; note(e.relpath, 'NEW_VERSION', `replaces ${here.sha.slice(0, 8)}`, sha);
      if (mode === 'APPLY') {
        const v = await this.applyNewVersion(userId, rootId, here, e, sha, meta);
        const prevSha = here.sha; const list = bySha.get(prevSha); if (list) bySha.set(prevSha, list.filter((x) => x !== here));
        here.versionId = v; here.sha = shaHex; here.bytes = e.size; here.mtimeMs = e.mtimeMs; here.state = 'ACTIVE'; const l2 = bySha.get(shaHex) ?? []; l2.push(here); bySha.set(shaHex, l2);
      }
      return 'NEW_VERSION';
    }
    const sameBytes = bySha.get(shaHex);
    if (sameBytes?.length) { deferred.push({ relpath: e.relpath, sha, meta, size: e.size, mtimeMs: e.mtimeMs, existing: sameBytes }); return 'MOVED'; }
    const samePhoto = meta.identityKey ? photoByIdentity.get(meta.identityKey) : undefined;
    if (samePhoto) {
      c.versionReview++; note(e.relpath, 'VERSION_REVIEW', 'same capture time as an existing photograph: is this a re-export?', sha);
      if (mode === 'APPLY') {
        const k = await this.applyReviewVersion(userId, rootId, samePhoto, e, sha, meta);
        const known: Known = { versionId: k, photoId: samePhoto, relpath: e.relpath, sha: shaHex, bytes: e.size, mtimeMs: e.mtimeMs, present: true, state: 'PENDING_REVIEW', identityKey: meta.identityKey };
        byPath.set(e.relpath, known); bySha.set(shaHex, [known]);
      }
      return 'VERSION_REVIEW';
    }
    c.new++; note(e.relpath, 'NEW', null, sha);
    if (mode === 'APPLY') {
      const { photoId, versionId } = await this.applyNew(userId, rootId, e, sha, meta);
      const known: Known = { versionId, photoId, relpath: e.relpath, sha: shaHex, bytes: e.size, mtimeMs: e.mtimeMs, present: true, state: 'ACTIVE', identityKey: meta.identityKey };
      byPath.set(e.relpath, known); bySha.set(shaHex, [known]); if (meta.identityKey) photoByIdentity.set(meta.identityKey, photoId);
    } else {                                                                          // dry run: remember it so a second copy in the same scan is recognised
      const known: Known = { versionId: randomUUID(), photoId: randomUUID(), relpath: e.relpath, sha: shaHex, bytes: e.size, mtimeMs: e.mtimeMs, present: true, state: 'ACTIVE', identityKey: meta.identityKey };
      byPath.set(e.relpath, known); bySha.set(shaHex, [known]); if (meta.identityKey) photoByIdentity.set(meta.identityKey, known.photoId);
    }
    return 'NEW';
  }

  // ------------------------------------------------------------------------------------------------ database writes (APPLY only)
  private versionCols(meta: FileMeta, e: { size: number; mtimeMs: number }) {
    return {
      bytes: e.size, source_mtime: new Date(e.mtimeMs), exported_at: new Date(e.mtimeMs),
      camera_make: meta.cameraMake, camera_model: meta.cameraModel, lens: meta.lens, focal: meta.focalLengthMm, aperture: meta.aperture, shutter: meta.shutterSeconds, iso: meta.iso ? Math.round(meta.iso) : null,
      copyright: meta.copyright, photographer: meta.photographer, keywords: meta.keywords, keywords_hier: meta.keywordsHier, gps_lat: meta.gps?.lat ?? null, gps_lon: meta.gps?.lon ?? null, gps_alt: meta.gps?.altitudeM ?? null,
    };
  }

  private async insertVersion(tx: Sql, userId: string, photoId: string, rootId: string, versionId: string, versionNo: number, state: string, e: { relpath: string; size: number; mtimeMs: number }, sha: Buffer, meta: FileMeta): Promise<void> {
    const v = this.versionCols(meta, e);
    await tx`INSERT INTO photo_versions (id, user_id, photo_id, version_no, library_root_id, source_relpath, source_mtime, content_sha256, width, height, bytes, exif,
               camera_make, camera_model, lens, focal_length_mm, aperture, shutter_s, iso, copyright, photographer, keywords, keywords_hier, gps_lat, gps_lon, gps_altitude_m, gps_source, state, exported_at, deriv_status)
             VALUES (${versionId}::uuid, ${userId}, ${photoId}::uuid, ${versionNo}, ${rootId}::uuid, ${e.relpath}, ${v.source_mtime}, ${sha}, ${meta.width}, ${meta.height}, ${v.bytes}, ${tx.json(meta.exif as never)},
               ${v.camera_make}, ${v.camera_model}, ${v.lens}, ${v.focal}, ${v.aperture}, ${v.shutter}, ${v.iso}, ${v.copyright}, ${v.photographer}, ${v.keywords}::text[], ${v.keywords_hier}::text[], ${v.gps_lat}, ${v.gps_lon}, ${v.gps_alt}, ${v.gps_lat === null ? null : 'EXIF'}::meta_source,
               ${state}, ${v.exported_at}, 'PENDING')`;
    await tx`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${userId}, 'derive.preview', ${tx.json({ versionId, photoId } as never)}, ${`derive:${versionId}`}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO sync_events (user_id, type, relpath, content_sha256, photo_version_id, detail) VALUES (${userId}, ${state === 'PENDING_REVIEW' ? 'VERSION_REVIEW' : versionNo > 1 ? 'NEW_VERSION' : 'NEW_PHOTO'}, ${e.relpath}, ${sha}, ${versionId}::uuid, ${tx.json({ bytes: e.size } as never)})`;
  }

  private async applyNew(userId: string, rootId: string, e: { relpath: string; size: number; mtimeMs: number }, sha: Buffer, meta: FileMeta): Promise<{ photoId: string; versionId: string }> {
    const photoId = randomUUID(), versionId = randomUUID();
    const f = folderMetadata(e.relpath);
    // `year` is the FOLDER year only; the capture year is derived from the capture time by the database (never inherited from the folder, and vice versa)
    const hasPlace = Object.values(meta.place).some((x) => x !== null);
    await withUser(this.d.sql, userId, async (tx) => {
      await tx`INSERT INTO photos (id, user_id, current_version_id, title, title_source, description, description_source, capture_at, capture_at_source, capture_offset_min, capture_offset_source, year, year_source, trip_location, trip_location_source, subpath, identity_key,
                                   place_city, place_state, place_country, place_country_code, place_sublocation, place_source, rating, color_label)
               VALUES (${photoId}::uuid, ${userId}, ${versionId}::uuid, ${meta.title}, ${meta.title ? 'IPTC' : null}::meta_source, ${meta.description}, ${meta.description ? 'IPTC' : null}::meta_source,
                       ${meta.captureInstant}, ${meta.captureInstant ? 'EXIF' : null}::meta_source, ${meta.captureOffsetMin}, ${meta.captureOffsetSource},
                       ${f.year}, ${f.year === null ? null : 'FOLDER_DERIVED'}::meta_source,
                       ${f.location}, ${f.location ? 'FOLDER_DERIVED' : null}::meta_source, ${f.subpath}, ${meta.identityKey},
                       ${meta.place.city}, ${meta.place.state}, ${meta.place.country}, ${meta.place.countryCode}, ${meta.place.sublocation}, ${hasPlace ? 'IPTC' : null}::meta_source, ${meta.rating ?? 0}, ${meta.colourLabel})`;
      await this.insertVersion(tx, userId, photoId, rootId, versionId, 1, 'ACTIVE', e, sha, meta);
    });
    return { photoId, versionId };
  }

  private async applyNewVersion(userId: string, rootId: string, here: Known, e: { relpath: string; size: number; mtimeMs: number }, sha: Buffer, meta: FileMeta): Promise<string> {
    const versionId = randomUUID();
    await withUser(this.d.sql, userId, async (tx) => {
      const [m] = await tx<{ n: number }[]>`SELECT coalesce(max(version_no), 0) + 1 AS n FROM photo_versions WHERE photo_id = ${here.photoId}::uuid`;
      await tx`SELECT 1 FROM photos WHERE id = ${here.photoId}::uuid FOR UPDATE`;
      // the new file takes over this path; the superseded version keeps its record (and its derivatives) as history
      await tx`UPDATE photo_versions SET state = 'SUPERSEDED', source_present = true WHERE id = ${here.versionId}::uuid`;
      await this.insertVersion(tx, userId, here.photoId, rootId, versionId, m!.n, 'ACTIVE', e, sha, meta);
      await tx`UPDATE photos SET current_version_id = ${versionId}::uuid, identity_key = coalesce(identity_key, ${meta.identityKey}) WHERE id = ${here.photoId}::uuid`;
    });
    return versionId;
  }

  private async applyRevert(userId: string, here: Known, earlier: Known, e: { relpath: string; size: number; mtimeMs: number }): Promise<void> {
    await withUser(this.d.sql, userId, async (tx) => {
      await tx`SELECT 1 FROM photos WHERE id = ${here.photoId}::uuid FOR UPDATE`;
      await tx`UPDATE photo_versions SET state = 'SUPERSEDED' WHERE id = ${here.versionId}::uuid`;
      await tx`UPDATE photo_versions SET state = 'ACTIVE', source_present = true, source_mtime = ${new Date(e.mtimeMs)}, bytes = ${e.size}, source_relpath = ${e.relpath} WHERE id = ${earlier.versionId}::uuid`;
      await tx`UPDATE photos SET current_version_id = ${earlier.versionId}::uuid WHERE id = ${here.photoId}::uuid`;
      await tx`INSERT INTO sync_events (user_id, type, relpath, photo_version_id, detail) VALUES (${userId}, 'VERSION_REVERTED', ${e.relpath}, ${earlier.versionId}::uuid, '{}')`;
    });
  }

  private async applyReviewVersion(userId: string, rootId: string, photoId: string, e: { relpath: string; size: number; mtimeMs: number }, sha: Buffer, meta: FileMeta): Promise<string> {
    const versionId = randomUUID();
    await withUser(this.d.sql, userId, async (tx) => {
      const [m] = await tx<{ n: number }[]>`SELECT coalesce(max(version_no), 0) + 1 AS n FROM photo_versions WHERE photo_id = ${photoId}::uuid`;
      await this.insertVersion(tx, userId, photoId, rootId, versionId, m!.n, 'PENDING_REVIEW', e, sha, meta);
      await tx`INSERT INTO review_queue (user_id, kind, subject) VALUES (${userId}, 'VERSION_MATCH', ${tx.json({ photoId, versionId, relpath: e.relpath } as never)})`;
    });
    return versionId;
  }

  private async applyMove(userId: string, rootId: string, k: Known, newRel: string, meta: FileMeta, mtimeMs: number, size: number): Promise<void> {
    const f = folderMetadata(newRel);
    await withUser(this.d.sql, userId, async (tx) => {
      await tx`UPDATE photo_versions SET library_root_id = ${rootId}::uuid, source_relpath = ${newRel}, source_present = true, source_mtime = ${new Date(mtimeMs)}, bytes = ${size} WHERE id = ${k.versionId}::uuid`;
      // the folder position always follows the file; folder-derived year and location follow it only where the photographer has not set or confirmed them
      await tx`UPDATE photos SET subpath = ${f.subpath} WHERE id = ${k.photoId}::uuid`;
      await tx`UPDATE photos SET year = coalesce(${f.year}, year), year_source = CASE WHEN ${f.year}::int IS NULL THEN year_source ELSE 'FOLDER_DERIVED' END
               WHERE id = ${k.photoId}::uuid AND (year_source IS NULL OR year_source = 'FOLDER_DERIVED')`;
      await tx`UPDATE photos SET trip_location = ${f.location}, trip_location_source = ${f.location ? 'FOLDER_DERIVED' : null}::meta_source
               WHERE id = ${k.photoId}::uuid AND (trip_location_source IS NULL OR trip_location_source = 'FOLDER_DERIVED')`;
      await tx`INSERT INTO sync_events (user_id, type, relpath, photo_version_id, detail) VALUES (${userId}, 'MOVED', ${newRel}, ${k.versionId}::uuid, ${tx.json({ from: k.relpath, fromRoot: k.fromRoot ?? null, exifCamera: meta.cameraModel } as never)})`;
    });
  }
}

export const sourceExists = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
