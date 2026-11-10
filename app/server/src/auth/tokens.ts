import { hmac, randomToken, safeEqual, sha256 } from './crypto.js';

export interface SessionToken { token: string; hash: Buffer }
export function newSessionToken(): SessionToken {
  const token = randomToken(32);
  return { token, hash: sha256(token) };
}
export const hashSessionToken = (token: string): Buffer => sha256(token);

/** CSRF token bound to the session: only code that has seen the session token's server secret can compute it. */
export const csrfFor = (secret: Buffer, sessionToken: string): string => hmac(secret, `csrf:${sessionToken}`).toString('base64url');
export const csrfValid = (secret: Buffer, sessionToken: string, presented: string | undefined): boolean =>
  typeof presented === 'string' && presented.length > 0 && safeEqual(csrfFor(secret, sessionToken), presented);

export type ChallengePurpose = 'mfa' | 'enroll';
interface ChallengePayload { u: string; p: ChallengePurpose; exp: number }

/** Short-lived, signed proof that the password step succeeded (so the second factor can be submitted). Not a session. */
export function signChallenge(secret: Buffer, userId: string, purpose: ChallengePurpose, nowMs: number, ttlMs = 5 * 60_000): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, p: purpose, exp: nowMs + ttlMs } satisfies ChallengePayload)).toString('base64url');
  return `${payload}.${hmac(secret, `challenge:${payload}`).toString('base64url')}`;
}

export function verifyChallenge(secret: Buffer, challenge: string, purpose: ChallengePurpose, nowMs: number): string | null {
  const [payload, sig] = challenge.split('.');
  if (!payload || !sig || !safeEqual(hmac(secret, `challenge:${payload}`).toString('base64url'), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ChallengePayload;
    return p.p === purpose && p.exp > nowMs && typeof p.u === 'string' ? p.u : null;
  } catch { return null; }
}
