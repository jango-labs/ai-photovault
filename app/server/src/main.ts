import { EnvSecretStore, assertPortFree } from '@photovault/shared';
import { AuthService } from './auth/service.js';
import { loadConfig } from './config.js';
import { connect, resolveTarget } from './db/connect.js';
import { buildApp } from './http/app.js';
import { pendingMessage, pendingMigrations } from './db/schema-check.js';
import { dataRootFromEnv } from './storage/dataRoot.js';
import { loadInstagramOAuthConfig } from './instagram/config.js';

async function main() {
  const config = loadConfig();
  await assertPortFree(config.host, config.apiPort); // fail fast; never fall back to another port
  const secrets = new EnvSecretStore();
  const [session, atRest] = await Promise.all([secrets.get('session_secret'), secrets.get('token_enc_key')]);
  if (!session || !atRest) throw new Error('Missing PHOTOVAULT_SESSION_SECRET / PHOTOVAULT_TOKEN_ENC_KEY. Run: npm run setup:env (or see .env.example)');
  const sql = connect(await resolveTarget('pv_app', config.database, secrets), { max: 10 });
  await sql`SELECT 1`;                                   // fail fast if the database is down or the role is wrong
  const behind = await pendingMigrations(sql);           // never serve a build on a database that does not have its schema
  if (behind.length) { console.error(pendingMessage(config.database, behind)); await sql.end({ timeout: 2 }); process.exit(78); }
  const sessionSecret = Buffer.from(session, 'hex'), atRestKey = Buffer.from(atRest, 'hex');
  const auth = new AuthService({ sql, sessionSecret, atRestKey, now: Date.now });
  const dataRoot = dataRootFromEnv();                    // the optional mounted-storage guard (external drive or network share); the API still starts when it is away and answers 503 for previews
  const instagramOAuth = await loadInstagramOAuthConfig(secrets);        // null until a Meta app, a redirect address and your approval are configured
  const app = buildApp({ config: { ...config, dataRoot, instagramOAuth, atRestKey }, sql, auth, sessionSecret });

  const stop = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await app.listen({ host: config.host, port: config.apiPort });
  app.log.info({ database: config.database, web: config.webDir ? 'served' : 'not served (use Vite)' }, 'photovault-api ready');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
