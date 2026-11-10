import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();
export const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Constant-time comparison of two strings (false on length mismatch without leaking timing of content). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** AES-256-GCM. Output = iv(12) | tag(16) | ciphertext. `aad` binds the ciphertext to its purpose/owner. */
export function seal(key: Buffer, plaintext: string, aad: string): Buffer {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): string {
  if (sealed.length < 29) throw new Error('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
}
