/**
 * Account administration (the owner account is created here; there is no public sign-up).
 *   npm run user -- create --email you@example.com [--db photovault]           (prompts for the password, no echo)
 *   PHOTOVAULT_USER_PASSWORD='…' npm run user -- create --email dev@example.test --password-env PHOTOVAULT_USER_PASSWORD   (non-interactive)
 *   npm run user -- reset-mfa --email you@example.com [--db photovault]       (forget authenticator + recovery codes, sign out everywhere)
 *   npm run user -- disable|enable --email ...
 *   npm run user -- list [--db photovault]
 * Passwords are never printed or logged.
 */
import { createInterface } from 'node:readline';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { connect, resolveTarget } from '../db/connect.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

function promptHidden(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = (rl as unknown as { _writeToOutput: (s: string) => void });
    w._writeToOutput = (s: string) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const db = flag('db') ?? process.env.PHOTOVAULT_DB ?? 'photovault';
  const email = flag('email')?.trim().toLowerCase();
  const sql = connect(await resolveTarget('pv_service', db), { max: 2 });
  try {
    if (cmd === 'list') {
      const rows = await sql`SELECT email, totp_enabled, disabled_at IS NOT NULL AS disabled, created_at FROM users ORDER BY created_at`;
      for (const r of rows) console.log(`${r.email}  mfa=${r.totp_enabled ? 'on' : 'not enrolled'}  ${r.disabled ? 'DISABLED' : 'active'}`);
      return;
    }
    if (!email) throw new Error('--email is required');
    if (cmd === 'create') {
      let password: string;
      const envName = flag('password-env');
      if (envName) {
        password = process.env[envName] ?? '';
        if (!password) throw new Error(`environment variable ${envName} is empty`);
      } else {
        password = await promptHidden('Password (min 12 characters): ');
        if (password !== (await promptHidden('Repeat password: '))) throw new Error('passwords do not match');
      }
      const problem = passwordProblem(password, email);
      if (problem) throw new Error(problem);
      const hash = await hashPassword(password);
      const tz = flag('timezone') ?? 'UTC';
      await sql.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`INSERT INTO users (email, password_hash, timezone) VALUES (${email}, ${hash}, ${tz}) RETURNING id`;
        await tx`INSERT INTO user_settings (user_id) VALUES (${u!.id})`;
        await tx`INSERT INTO ai_budget (user_id) VALUES (${u!.id})`;      // live AI stays OFF (live_enabled=false, 200-photo test cap)
      });
      console.log(`created ${email} in ${db}. The first sign-in will ask you to set up an authenticator app.`);
    } else if (cmd === 'reset-mfa') {
      await sql.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`UPDATE users SET totp_enabled = false, totp_secret_ciphertext = NULL, totp_last_step = NULL WHERE email = ${email} RETURNING id`;
        if (!u) throw new Error('no such user');
        await tx`DELETE FROM recovery_codes WHERE user_id = ${u.id}`;
        await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${u.id} AND revoked_at IS NULL`;
      });
      console.log('authenticator and recovery codes cleared; all sessions revoked');
    } else if (cmd === 'disable' || cmd === 'enable') {
      const r = cmd === 'disable'
        ? await sql`UPDATE users SET disabled_at = now() WHERE email = ${email}`
        : await sql`UPDATE users SET disabled_at = NULL WHERE email = ${email}`;
      if (!r.count) throw new Error('no such user');
      if (cmd === 'disable') await sql`UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = ${email})`;
      console.log(`${cmd}d ${email}`);
    } else throw new Error('usage: user create|reset-mfa|disable|enable|list --email ... [--db photovault]');
  } finally { await sql.end({ timeout: 2 }); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
