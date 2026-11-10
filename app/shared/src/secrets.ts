import fs from 'node:fs';

/**
 * Secrets AI PhotoVault can use. Values come from the environment (or from a file named by a `<VAR>_FILE` variable, which is how
 * Docker/Kubernetes secrets are delivered). They are never logged, never stored in the database in clear text and never sent anywhere.
 */
export type SecretName =
  | 'db_app' | 'db_owner' | 'db_service' | 'db_delivery' | 'db_backup' | 'session_secret' | 'token_enc_key' | 'anthropic_api_key'
  | 'embedding_api_key' | 'ig_app_id' | 'ig_app_secret' | 'meta_app_secret' | 'backup_passphrase' | 'agent_token';

/** Environment variable that carries each secret. */
export const SECRET_ENV: Record<SecretName, string> = {
  db_app: 'PHOTOVAULT_DB_APP_PASSWORD',
  db_owner: 'PHOTOVAULT_DB_OWNER_PASSWORD',
  db_service: 'PHOTOVAULT_DB_SERVICE_PASSWORD',
  db_delivery: 'PHOTOVAULT_DB_DELIVERY_PASSWORD',
  db_backup: 'PHOTOVAULT_DB_BACKUP_PASSWORD',
  session_secret: 'PHOTOVAULT_SESSION_SECRET',
  token_enc_key: 'PHOTOVAULT_TOKEN_ENC_KEY',
  anthropic_api_key: 'PHOTOVAULT_ANTHROPIC_API_KEY',
  embedding_api_key: 'PHOTOVAULT_EMBEDDING_API_KEY',
  ig_app_id: 'PHOTOVAULT_IG_APP_ID',
  ig_app_secret: 'PHOTOVAULT_IG_APP_SECRET',
  meta_app_secret: 'PHOTOVAULT_META_APP_SECRET',
  backup_passphrase: 'PHOTOVAULT_BACKUP_PASSPHRASE',
  agent_token: 'PHOTOVAULT_AGENT_TOKEN',
};

export interface SecretStore {
  /** Returns null when the secret is not set. Never logs values. */
  get(name: SecretName): Promise<string | null>;
}

/** Reads secrets from environment variables, or from the file named by `<VAR>_FILE`. */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(name: SecretName): Promise<string | null> {
    const key = SECRET_ENV[name];
    const file = this.env[`${key}_FILE`];
    let v: string | undefined = this.env[key];
    if (!v && file) { try { v = fs.readFileSync(file, 'utf8'); } catch { return null; } }
    v = v?.replace(/\r?\n$/, '');
    return v && v.length ? v : null;
  }
}

/** For tests only. */
export class MemorySecretStore implements SecretStore {
  constructor(private readonly values: Partial<Record<SecretName, string>> = {}) {}
  async get(name: SecretName): Promise<string | null> {
    return this.values[name] ?? null;
  }
}
