import type { Sql } from 'postgres';
import QRCode from 'qrcode';
import { withUser } from '../db/connect.js';
import { recordAudit } from '../ops/audit.js';
import { open, randomToken, seal, sha256 } from './crypto.js';
import { dummyVerify, hashPassword, passwordProblem, verifyPassword } from './password.js';
import { hashSessionToken, newSessionToken, signChallenge, verifyChallenge, type ChallengePurpose } from './tokens.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const MAX_FAILURES = 5;
export const LOCK_WINDOW = '15 minutes';
export const LOCK_SECONDS = 15 * 60;
export const SESSION_TTL = '30 days';
const ISSUER = 'AI PhotoVault';

export interface AuthDeps { sql: Sql; sessionSecret: Buffer; atRestKey: Buffer; now: () => number }
export interface ClientCtx { ip: string | null; userAgent: string | null }

export type PasswordStep =
  | { status: 'invalid' }
  | { status: 'locked'; retryAfter: number }
  | { status: 'mfa'; challenge: string }
  | { status: 'enroll'; challenge: string };

export type SecondStep =
  | { status: 'invalid' }
  | { status: 'locked'; retryAfter: number }
  | { status: 'ok'; sessionToken: string; recoveryCodes?: string[] };

export interface SessionInfo { id: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; ip: string | null; userAgent: string | null; current: boolean }
export interface Me { id: string; email: string; displayName: string | null; timezone: string; totpEnabled: boolean }
export interface Settings { viewerSurface: 'neutral' | 'teal'; thumbSize: number; aiScoresVisible: boolean }

const normEmail = (e: string) => e.trim().toLowerCase();
const normRecovery = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';   // no look-alikes
  return Array.from({ length: n }, () => {
    const bytes = Buffer.from(randomToken(16), 'base64url');
    const chars = Array.from({ length: 10 }, (_, i) => alphabet[bytes[i]! % alphabet.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export class AuthService {
  constructor(private readonly d: AuthDeps) {}
  private get sql() { return this.d.sql; }
  private audit(userId: string, action: string, ctx: { ip: string | null }, detail: Record<string, unknown> = {}) { return recordAudit(this.sql, userId, action, ctx.ip, detail); }

  // ---------------------------------------------------------------- throttling
  private async failures(userId: string | null, ip: string | null): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`SELECT auth_recent_failures(${userId}::uuid, ${ip}::inet, ${LOCK_WINDOW}::interval) AS n`;
    return r!.n;
  }
  private async recordFailure(userId: string | null, ip: string | null): Promise<void> {
    await this.sql`SELECT auth_record_login(${userId}::uuid, ${ip}::inet, false)`;
  }
  private async isLocked(userId: string | null, ip: string | null): Promise<boolean> {
    return (await this.failures(userId, ip)) >= MAX_FAILURES;
  }

  // ---------------------------------------------------------------- step 1: password
  async loginPassword(email: string, password: string, ctx: ClientCtx): Promise<PasswordStep> {
    const [u] = await this.sql<{ id: string; password_hash: string; totp_enabled: boolean; disabled: boolean }[]>`SELECT id, password_hash, totp_enabled, disabled FROM auth_find_user(${normEmail(email)})`;
    const userId = u?.id ?? null;
    if (await this.isLocked(userId, ctx.ip)) { if (!u) await dummyVerify(password); else await this.audit(u.id, 'auth.locked_out', ctx, { via: 'password' }); return { status: 'locked', retryAfter: LOCK_SECONDS }; }
    const ok = u && !u.disabled ? await verifyPassword(u.password_hash, password) : await dummyVerify(password);
    if (!u || !ok) { await this.recordFailure(userId, ctx.ip); if (userId) await this.audit(userId, 'auth.password_failed', ctx); return { status: 'invalid' }; }
    const purpose: ChallengePurpose = u.totp_enabled ? 'mfa' : 'enroll';
    return { status: purpose, challenge: signChallenge(this.d.sessionSecret, u.id, purpose, this.d.now()) };
  }

  // ---------------------------------------------------------------- step 2a: first-time authenticator enrolment
  async totpSetup(challenge: string): Promise<{ secret: string; uri: string; qr: string } | null> {
    const userId = verifyChallenge(this.d.sessionSecret, challenge, 'enroll', this.d.now());
    if (!userId) return null;
    return withUser(this.sql, userId, async (tx) => {
      const [u] = await tx<{ email: string; totp_enabled: boolean }[]>`SELECT email, totp_enabled FROM users WHERE id = ${userId}`;
      if (!u || u.totp_enabled) return null;
      const secret = newTotpSecret();
      const sealed = seal(this.d.atRestKey, secret, `totp:${userId}`);
      await tx`UPDATE users SET totp_secret_ciphertext = ${sealed}, totp_last_step = NULL WHERE id = ${userId}`;
      const uri = otpauthUri(ISSUER, u.email, secret);
      const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, color: { dark: '#011d1c', light: '#ffffff' } });
      return { secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    });
  }

  async totpConfirm(challenge: string, code: string, ctx: ClientCtx): Promise<SecondStep> {
    const userId = verifyChallenge(this.d.sessionSecret, challenge, 'enroll', this.d.now());
    if (!userId) return { status: 'invalid' };
    if (await this.isLocked(userId, ctx.ip)) return { status: 'locked', retryAfter: LOCK_SECONDS };
    const step = await withUser(this.sql, userId, async (tx) => {
      const [u] = await tx<{ totp_secret_ciphertext: Buffer | null; totp_enabled: boolean }[]>`SELECT totp_secret_ciphertext, totp_enabled FROM users WHERE id = ${userId}`;
      if (!u?.totp_secret_ciphertext || u.totp_enabled) return null;
      const secret = open(this.d.atRestKey, u.totp_secret_ciphertext, `totp:${userId}`);
      const matched = verifyTotp(secret, code.trim(), this.d.now(), null);
      if (matched === null) return null;
      await tx`UPDATE users SET totp_enabled = true, totp_last_step = ${matched} WHERE id = ${userId}`;
      return matched;
    });
    if (step === null) { await this.recordFailure(userId, ctx.ip); return { status: 'invalid' }; }
    const codes = newRecoveryCodes();
    await withUser(this.sql, userId, async (tx) => {
      await tx`DELETE FROM recovery_codes WHERE user_id = ${userId}`;
      for (const c of codes) await tx`INSERT INTO recovery_codes (user_id, code_hash) VALUES (${userId}, ${sha256(normRecovery(c))})`;
    });
    await this.audit(userId, 'auth.authenticator_enrolled', ctx);
    return { status: 'ok', sessionToken: await this.startSession(userId, ctx), recoveryCodes: codes };
  }

  // ---------------------------------------------------------------- step 2b: returning user, authenticator code or recovery code
  async loginSecondFactor(challenge: string, code: string, ctx: ClientCtx): Promise<SecondStep> {
    const userId = verifyChallenge(this.d.sessionSecret, challenge, 'mfa', this.d.now());
    if (!userId) return { status: 'invalid' };
    if (await this.isLocked(userId, ctx.ip)) return { status: 'locked', retryAfter: LOCK_SECONDS };
    const trimmed = code.trim();
    const ok = await withUser(this.sql, userId, async (tx) => {
      if (/^\d{6}$/.test(trimmed)) {
        const [u] = await tx<{ totp_secret_ciphertext: Buffer | null; totp_last_step: string | null }[]>`SELECT totp_secret_ciphertext, totp_last_step FROM users WHERE id = ${userId} AND totp_enabled`;
        if (!u?.totp_secret_ciphertext) return false;
        const secret = open(this.d.atRestKey, u.totp_secret_ciphertext, `totp:${userId}`);
        const matched = verifyTotp(secret, trimmed, this.d.now(), u.totp_last_step === null ? null : Number(u.totp_last_step));
        if (matched === null) return false;
        const r = await tx`UPDATE users SET totp_last_step = ${matched} WHERE id = ${userId} AND (totp_last_step IS NULL OR totp_last_step < ${matched})`;
        return r.count === 1;                     // a concurrent use of the same code loses the race
      }
      const r = await tx`UPDATE recovery_codes SET used_at = now() WHERE user_id = ${userId} AND code_hash = ${sha256(normRecovery(trimmed))} AND used_at IS NULL`;
      return r.count === 1;
    });
    if (!ok) { await this.recordFailure(userId, ctx.ip); await this.audit(userId, 'auth.second_factor_failed', ctx); return { status: 'invalid' }; }
    await this.audit(userId, 'auth.signed_in', ctx, { via: /^\d{6}$/.test(trimmed) ? 'authenticator' : 'recovery_code' });
    return { status: 'ok', sessionToken: await this.startSession(userId, ctx) };
  }

  // ---------------------------------------------------------------- sessions
  private async startSession(userId: string, ctx: ClientCtx): Promise<string> {
    const t = newSessionToken();
    await this.sql`SELECT auth_record_login(${userId}::uuid, ${ctx.ip}::inet, true)`;
    const [r] = await this.sql<{ id: string | null }[]>`SELECT auth_create_session(${userId}::uuid, ${t.hash}, ${SESSION_TTL}::interval, ${ctx.ip}::inet, ${ctx.userAgent?.slice(0, 300) ?? null}) AS id`;
    if (!r?.id) throw new Error('session could not be created');
    return t.token;
  }

  async resolve(token: string | undefined): Promise<{ userId: string; sessionId: string } | null> {
    if (!token || token.length > 128) return null;
    const hash = hashSessionToken(token);
    const [r] = await this.sql<{ u: string | null }[]>`SELECT auth_resolve_session(${hash}) AS u`;
    if (!r?.u) return null;
    const [s] = await this.sql<{ id: string | null }[]>`SELECT auth_session_id(${hash}) AS id`;
    return s?.id ? { userId: r.u, sessionId: s.id } : null;
  }

  async listSessions(userId: string, currentId: string): Promise<SessionInfo[]> {
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx<{ id: string; created_at: Date; last_seen_at: Date; expires_at: Date; ip: string | null; user_agent: string | null }[]>`
        SELECT id, created_at, last_seen_at, expires_at, host(ip) AS ip, user_agent FROM sessions
         WHERE revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`;
      return rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent, current: r.id === currentId }));
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => (await tx`UPDATE sessions SET revoked_at = now() WHERE id = ${sessionId} AND revoked_at IS NULL`).count === 1);
  }

  async revokeOthers(userId: string, keepSessionId: string): Promise<number> {
    return withUser(this.sql, userId, async (tx) => (await tx`UPDATE sessions SET revoked_at = now() WHERE id <> ${keepSessionId} AND revoked_at IS NULL`).count);
  }

  // ---------------------------------------------------------------- account
  async me(userId: string): Promise<Me | null> {
    return withUser(this.sql, userId, async (tx) => {
      const [u] = await tx<{ id: string; email: string; display_name: string | null; timezone: string; totp_enabled: boolean }[]>`SELECT id, email, display_name, timezone, totp_enabled FROM users WHERE id = ${userId}`;
      return u ? { id: u.id, email: u.email, displayName: u.display_name, timezone: u.timezone, totpEnabled: u.totp_enabled } : null;
    });
  }

  async changePassword(userId: string, current: string, next: string, keepSessionId: string, ctx: ClientCtx): Promise<'ok' | 'wrong_password' | 'weak' | 'locked'> {
    if (await this.isLocked(userId, ctx.ip)) return 'locked';
    const me = await this.me(userId);
    if (!me) return 'wrong_password';
    const [u] = await this.sql<{ password_hash: string }[]>`SELECT password_hash FROM auth_find_user(${me.email})`;
    if (!u || !(await verifyPassword(u.password_hash, current))) { await this.recordFailure(userId, ctx.ip); await this.audit(userId, 'auth.password_change_refused', ctx); return 'wrong_password'; }
    if (passwordProblem(next, me.email)) return 'weak';
    const hash = await hashPassword(next);
    await withUser(this.sql, userId, async (tx) => {
      await tx`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
      await tx`UPDATE sessions SET revoked_at = now() WHERE id <> ${keepSessionId} AND revoked_at IS NULL`;   // everyone else is signed out
    });
    await this.audit(userId, 'auth.password_changed', ctx);
    return 'ok';
  }

  // ---------------------------------------------------------------- settings
  async getSettings(userId: string): Promise<Settings> {
    return withUser(this.sql, userId, async (tx) => {
      await tx`INSERT INTO user_settings (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
      const [s] = await tx<{ viewer_surface: 'neutral' | 'teal'; thumb_size: number; ai_scores_visible: boolean }[]>`SELECT viewer_surface, thumb_size, ai_scores_visible FROM user_settings WHERE user_id = ${userId}`;
      return { viewerSurface: s!.viewer_surface, thumbSize: s!.thumb_size, aiScoresVisible: s!.ai_scores_visible };
    });
  }

  async patchSettings(userId: string, p: Partial<Settings>): Promise<Settings> {
    await withUser(this.sql, userId, async (tx) => {
      await tx`INSERT INTO user_settings (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
      await tx`UPDATE user_settings SET viewer_surface = coalesce(${p.viewerSurface ?? null}, viewer_surface), thumb_size = coalesce(${p.thumbSize ?? null}::int, thumb_size),
               ai_scores_visible = coalesce(${p.aiScoresVisible ?? null}::boolean, ai_scores_visible) WHERE user_id = ${userId}`;
    });
    return this.getSettings(userId);
  }
}
