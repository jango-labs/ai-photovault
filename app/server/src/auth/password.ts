import { hash, verify } from '@node-rs/argon2';

// argon2id (Algorithm.Argon2id = 2): 64 MiB, 3 passes, 1 lane — roughly 85 ms on this computer.
const OPTS = { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export const hashPassword = (pw: string): Promise<string> => hash(pw, OPTS);

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try { return await verify(stored, pw); } catch { return false; }
}

let dummy: Promise<string> | null = null;
/** Burn the same CPU as a real check when the account does not exist, so response time doesn't reveal which emails are registered. */
export async function dummyVerify(pw: string): Promise<false> {
  dummy ??= hashPassword('not-a-real-password-' + Math.random());
  await verifyPassword(await dummy, pw);
  return false;
}

const COMMON = new Set(['password1234', 'passwordpassword', '123456789012', 'qwertyuiop12', 'letmein12345', 'iloveyou1234', 'changeme1234']);
export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 256) return 'Use at most 256 characters.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common.';
  if (email && pw.toLowerCase().includes(email.split('@')[0]!.toLowerCase()) && email.split('@')[0]!.length >= 4) return 'The password must not contain your email name.';
  if (/^(.)\1+$/.test(pw)) return 'Use a less repetitive password.';
  return null;
}
