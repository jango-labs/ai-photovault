import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSecretStore, MemorySecretStore } from './secrets.js';

describe('EnvSecretStore', () => {
  it('reads a secret from its environment variable', async () => {
    expect(await new EnvSecretStore({ PHOTOVAULT_ANTHROPIC_API_KEY: 'k\n' }).get('anthropic_api_key')).toBe('k');
  });
  it('reads a secret from the file named by <VAR>_FILE (Docker secrets)', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-sec-')), 's'); fs.writeFileSync(f, 'from-file\n');
    expect(await new EnvSecretStore({ PHOTOVAULT_DB_APP_PASSWORD_FILE: f }).get('db_app')).toBe('from-file');
  });
  it('returns null when missing, empty, or the file is unreadable', async () => {
    expect(await new EnvSecretStore({}).get('db_app')).toBeNull();
    expect(await new EnvSecretStore({ PHOTOVAULT_DB_APP_PASSWORD: '' }).get('db_app')).toBeNull();
    expect(await new EnvSecretStore({ PHOTOVAULT_DB_APP_PASSWORD_FILE: '/nonexistent/x' }).get('db_app')).toBeNull();
    expect(await new MemorySecretStore().get('db_app')).toBeNull();
  });
});
