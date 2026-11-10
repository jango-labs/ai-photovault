import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { Sql } from 'postgres';
import sharp from 'sharp';

/**
 * Media delivery: Instagram fetches the image of a post from a URL, so for a few minutes a purpose-made copy of ONE photograph must be
 * reachable. The copy is a ≤ 1440 px sRGB JPEG with every piece of metadata (EXIF, GPS, IPTC) removed; it is reachable only through a random,
 * single-purpose, short-lived, hit-limited token; and it is revoked and deleted as soon as the post is verified (or fails).
 *
 * Providers:
 *  - `LocalTokenDelivery` writes the copy under DATA_ROOT/delivery and registers the token (only its hash) in `delivery_tokens`; the isolated
 *    delivery service below serves it. Reachable from the internet only if the owner adds a tunnel (approval D9) — until then, only to the mock.
 *  - `PresignedUrlDelivery` is the object-storage design (private bucket + short presigned GET). It is written against a `Signer` interface and
 *    tested with a fake; nothing in the app constructs it, so no cloud resource, account or key exists. See docs/MEDIA_DELIVERY.md.
 */
export class AspectError extends Error { constructor(public readonly ratio: number) { super(`Instagram feed photographs must be between 4:5 and 1.91:1; this one is ${ratio.toFixed(2)}:1. Choose a crop first.`); } }
export const MAX_LONG_EDGE = 1440, MAX_BYTES = 8 * 1024 * 1024, MIN_RATIO = 0.8, MAX_RATIO = 1.91;

/** Reads the source (never modifies it) and returns the bytes to publish. Metadata is dropped by default in sharp and never re-attached. */
export async function prepareDeliveryImage(source: string | Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const base = sharp(source, { failOn: 'error' }).rotate();
  const meta = await base.clone().metadata(); const rot = meta.orientation && meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  const [w0, h0] = [rot[0] ?? 0, rot[1] ?? 0]; if (!w0 || !h0) throw new Error('Not a readable image.');
  const ratio = w0 / h0; if (ratio < MIN_RATIO - 0.005 || ratio > MAX_RATIO + 0.005) throw new AspectError(ratio);
  for (const q of [90, 84, 76, 68]) {
    const { data, info } = await base.clone().resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').jpeg({ quality: q, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    if (data.length <= MAX_BYTES) return { jpeg: data, width: info.width, height: info.height };
  }
  throw new Error('The image is too large to deliver even after compression.');
}

export interface DeliveredImage { url: string; expiresAt: Date; revoke(): Promise<void> }
export interface DeliveryProvider { prepare(ctx: { userId: string; publicationId: string; jpeg: Buffer }): Promise<DeliveredImage> }

export class LocalTokenDelivery implements DeliveryProvider {
  constructor(private readonly o: { sql: Sql; dir: string; baseUrl: string; ttlSeconds?: number; maxHits?: number; now?: () => Date }) {}
  async prepare(c: { userId: string; publicationId: string; jpeg: Buffer }): Promise<DeliveredImage> {
    const now = (this.o.now ?? (() => new Date()))(); const ttl = Math.min(this.o.ttlSeconds ?? 1200, 3600 - 60);
    const token = crypto.randomBytes(32).toString('base64url'); const hash = crypto.createHash('sha256').update(token).digest(); const rel = `${crypto.randomUUID()}.jpg`;
    await fs.mkdir(this.o.dir, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(this.o.dir, rel), c.jpeg, { mode: 0o600 });
    const expires = new Date(now.getTime() + ttl * 1000);
    await this.o.sql`INSERT INTO delivery_tokens (user_id, scheduled_publication_id, token_hash, file_relpath, created_at, expires_at, max_hits) VALUES (${c.userId}::uuid, ${c.publicationId}::uuid, ${hash}, ${rel}, ${now}, ${expires}, ${this.o.maxHits ?? 5})`;
    return {
      url: `${this.o.baseUrl.replace(/\/+$/, '')}/d/${token}`, expiresAt: expires,
      revoke: async () => { await this.o.sql`UPDATE delivery_tokens SET revoked_at = now() WHERE token_hash = ${hash}`; await fs.rm(path.join(this.o.dir, rel), { force: true }); },
    };
  }
}

export interface Signer { put(key: string, body: Buffer, contentType: string): Promise<void>; presignGet(key: string, ttlSeconds: number): Promise<string>; remove(key: string): Promise<void> }
export class PresignedUrlDelivery implements DeliveryProvider {
  constructor(private readonly signer: Signer, private readonly ttlSeconds = 900) { if (ttlSeconds > 900) throw new Error('A presigned delivery URL may live at most 15 minutes.'); }
  async prepare(c: { jpeg: Buffer }): Promise<DeliveredImage> {
    const key = `delivery/${crypto.randomBytes(24).toString('base64url')}.jpg`;              // unguessable, one object per post, no user or photo id in the name
    await this.signer.put(key, c.jpeg, 'image/jpeg');
    return { url: await this.signer.presignGet(key, this.ttlSeconds), expiresAt: new Date(Date.now() + this.ttlSeconds * 1000), revoke: () => this.signer.remove(key) };
  }
}

/**
 * The isolated delivery process: it holds the `pv_delivery` database role (SELECT + UPDATE(hits) on delivery_tokens, nothing else), no session,
 * no cookies, and answers one route. Every failure — unknown, expired, revoked, exhausted, missing file — is the same 404, so a prober learns nothing.
 */
export function buildDeliveryApp(o: { sql: Sql; dir: string; now?: () => Date }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  const miss = (reply: import('fastify').FastifyReply) => reply.code(404).header('cache-control', 'no-store').type('text/plain').send('Not found');
  app.get('/d/:token', async (req, reply) => {
    const token = String((req.params as { token: string }).token ?? ''); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return miss(reply);
    const hash = crypto.createHash('sha256').update(token).digest(); const now = (o.now ?? (() => new Date()))();
    const [t] = await o.sql<{ file_relpath: string }[]>`UPDATE delivery_tokens SET hits = hits + 1 WHERE token_hash = ${hash} AND revoked_at IS NULL AND expires_at > ${now} AND hits < max_hits RETURNING file_relpath`;
    if (!t || !/^[0-9a-f-]{36}\.jpg$/.test(t.file_relpath)) return miss(reply);
    const abs = path.join(o.dir, t.file_relpath); if (!abs.startsWith(path.resolve(o.dir) + path.sep)) return miss(reply);
    let bytes: Buffer; try { bytes = await fs.readFile(abs); } catch { return miss(reply); }
    return reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').type('image/jpeg').send(bytes);
  });
  app.setNotFoundHandler((_req, reply) => miss(reply));
  return app;
}
