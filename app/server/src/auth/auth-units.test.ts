import { describe, expect, it } from 'vitest';
import { open, randomToken, safeEqual, seal, sha256 } from './crypto.js';
import { RateLimiter } from './limiter.js';
import { dummyVerify, hashPassword, passwordProblem, verifyPassword } from './password.js';
import { csrfFor, csrfValid, hashSessionToken, newSessionToken, signChallenge, verifyChallenge } from './tokens.js';
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUri, timeStep, totpAt, verifyTotp } from './totp.js';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const secret = Buffer.from('12345678901234567890');
  it('matches the RFC 4226 HOTP test vectors', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    want.forEach((w, i) => expect(hotp(secret, i)).toBe(w));
  });
  it('matches the RFC 6238 TOTP test vectors (SHA-1, last 6 digits)', () => {
    const vec: Array<[number, string]> = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
    for (const [t, code] of vec) expect(hotp(secret, timeStep(t * 1000))).toBe(code);
  });
  it('base32 round-trips and rejects junk', () => {
    const b = Buffer.from('hello world, this is a secret');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(() => base32Decode('not*base32')).toThrow();
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
  it('accepts ±1 step of clock drift but not more, and only digits', () => {
    const s = newTotpSecret(); const t = 1_700_000_000_000;
    expect(verifyTotp(s, totpAt(s, t), t)).toBe(timeStep(t));
    expect(verifyTotp(s, totpAt(s, t - 30_000), t)).toBe(timeStep(t) - 1);
    expect(verifyTotp(s, totpAt(s, t + 30_000), t)).toBe(timeStep(t) + 1);
    expect(verifyTotp(s, totpAt(s, t - 90_000), t)).toBeNull();
    expect(verifyTotp(s, '12345', t)).toBeNull(); expect(verifyTotp(s, 'abcdef', t)).toBeNull(); expect(verifyTotp(s, '', t)).toBeNull();
  });
  it('refuses to accept the same time step twice (replay protection)', () => {
    const s = newTotpSecret(); const t = 1_700_000_000_000; const step = timeStep(t);
    expect(verifyTotp(s, totpAt(s, t), t, step - 1)).toBe(step);
    expect(verifyTotp(s, totpAt(s, t), t, step)).toBeNull();
    expect(verifyTotp(s, totpAt(s, t - 30_000), t, step)).toBeNull();    // an earlier step is also refused
  });
  it('builds an otpauth URI authenticator apps understand', () => {
    const u = otpauthUri('AI PhotoVault', 'me@example.com', 'ABCDEFGHIJKLMNOP');
    expect(u).toBe('otpauth://totp/AI%20PhotoVault:me%40example.com?secret=ABCDEFGHIJKLMNOP&issuer=AI%20PhotoVault&algorithm=SHA1&digits=6&period=30');
  });
});

describe('passwords (argon2id)', () => {
  it('hashes with argon2id, salts, and verifies', async () => {
    const h1 = await hashPassword('correct horse battery'), h2 = await hashPassword('correct horse battery');
    expect(h1).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/); expect(h1).not.toBe(h2);
    expect(await verifyPassword(h1, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h1, 'wrong horse battery')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
    expect(await dummyVerify('x')).toBe(false);
  });
  it('enforces a sane policy', () => {
    expect(passwordProblem('short')).toMatch(/12/);
    expect(passwordProblem('a'.repeat(300))).toMatch(/at most/);
    expect(passwordProblem('aaaaaaaaaaaaaa')).toMatch(/repetitive/);
    expect(passwordProblem('Password1234')).toMatch(/common/);
    expect(passwordProblem('janet-and-friends-2026', 'janet@example.com')).toMatch(/email/);
    expect(passwordProblem('a long unusual passphrase')).toBeNull();
  });
});

describe('at-rest encryption (AES-256-GCM)', () => {
  const key = Buffer.alloc(32, 7);
  it('round-trips, is randomised, and binds to its context', () => {
    const a = seal(key, 'JBSWY3DPEHPK3PXP', 'totp:u1'), b = seal(key, 'JBSWY3DPEHPK3PXP', 'totp:u1');
    expect(a.equals(b)).toBe(false); expect(open(key, a, 'totp:u1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => open(key, a, 'totp:u2')).toThrow();                         // moved to another user: refused
    expect(() => open(Buffer.alloc(32, 8), a, 'totp:u1')).toThrow();         // wrong key
    const tampered = Buffer.from(a); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => open(key, tampered, 'totp:u1')).toThrow();                  // modified: refused
    expect(() => seal(Buffer.alloc(16), 'x', 'a')).toThrow();
  });
  it('safeEqual and randomToken behave', () => {
    expect(safeEqual('abc', 'abc')).toBe(true); expect(safeEqual('abc', 'abd')).toBe(false); expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(new Set(Array.from({ length: 50 }, () => randomToken())).size).toBe(50); expect(randomToken(32)).toHaveLength(43);
  });
});

describe('session, CSRF and challenge tokens', () => {
  const secret = Buffer.alloc(32, 3);
  it('session tokens are 256-bit random and only their hash is derivable server-side', () => {
    const a = newSessionToken(), b = newSessionToken();
    expect(a.token).not.toBe(b.token); expect(a.hash).toHaveLength(32);
    expect(hashSessionToken(a.token).equals(a.hash)).toBe(true); expect(a.hash.equals(sha256(a.token))).toBe(true);
    expect(a.token).not.toContain(a.hash.toString('base64url'));
  });
  it('CSRF tokens are bound to the session and the server secret', () => {
    const t = newSessionToken().token, c = csrfFor(secret, t);
    expect(csrfValid(secret, t, c)).toBe(true);
    expect(csrfValid(secret, newSessionToken().token, c)).toBe(false);       // another session's token
    expect(csrfValid(Buffer.alloc(32, 4), t, c)).toBe(false);                // different server secret
    expect(csrfValid(secret, t, undefined)).toBe(false); expect(csrfValid(secret, t, '')).toBe(false);
  });
  it('challenges are signed, purpose-bound and expire', () => {
    const now = 1_000_000;
    const ch = signChallenge(secret, 'user-1', 'mfa', now);
    expect(verifyChallenge(secret, ch, 'mfa', now + 1000)).toBe('user-1');
    expect(verifyChallenge(secret, ch, 'enroll', now + 1000)).toBeNull();    // wrong purpose
    expect(verifyChallenge(secret, ch, 'mfa', now + 6 * 60_000)).toBeNull(); // expired
    expect(verifyChallenge(Buffer.alloc(32, 9), ch, 'mfa', now)).toBeNull(); // other secret
    const [p, s] = ch.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'user-2', p: 'mfa', exp: now + 1e9 })).toString('base64url');
    expect(verifyChallenge(secret, `${forged}.${s}`, 'mfa', now)).toBeNull(); expect(verifyChallenge(secret, `${p}.AAAA`, 'mfa', now)).toBeNull();
    expect(verifyChallenge(secret, 'garbage', 'mfa', now)).toBeNull();
  });
});

describe('rate limiter', () => {
  it('allows N per window, then reports a wait, then recovers', () => {
    let t = 0; const l = new RateLimiter(3, 60_000, () => t);
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([0, 0, 0]);
    expect(l.take('a')).toBeGreaterThan(0); expect(l.take('b')).toBe(0);     // per key
    t = 61_000; expect(l.take('a')).toBe(0);
  });
});
