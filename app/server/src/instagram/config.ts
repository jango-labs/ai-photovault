import type { SecretStore } from '@photovault/shared';
import { IG_DEFAULT_SCOPES, IG_SCOPES, type IgOAuthConfig, isLoopbackUrl } from './oauth.js';

/**
 * Instagram connection settings. Nothing is configured by default:
 *   Environment: PHOTOVAULT_IG_APP_ID, PHOTOVAULT_IG_APP_SECRET           — from your Meta developer app (never in files or logs)
 *   PHOTOVAULT_IG_REDIRECT_URI  — the HTTPS callback registered in that app, e.g. https://<tailnet name>:8480/api/instagram/oauth/callback
 *   PHOTOVAULT_IG_LIVE=approved — your explicit approval to talk to the real Instagram (without it only a sandbox on this computer is reachable)
 *   PHOTOVAULT_IG_SANDBOX_URL   — http://127.0.0.1:<port> of a sandbox (tests / development)
 *   PHOTOVAULT_IG_SCOPES        — comma list; default instagram_business_basic only (read profile + media history). Add instagram_business_content_publish ONLY when publishing is approved.
 */
export async function loadInstagramOAuthConfig(secrets: SecretStore, env: NodeJS.ProcessEnv = process.env): Promise<IgOAuthConfig | null> {
  const [appId, appSecret] = await Promise.all([secrets.get('ig_app_id'), secrets.get('ig_app_secret')]);
  const redirectUri = env.PHOTOVAULT_IG_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) return null;
  const sandbox = env.PHOTOVAULT_IG_SANDBOX_URL;
  if (sandbox && !isLoopbackUrl(sandbox)) throw new Error('PHOTOVAULT_IG_SANDBOX_URL must be on this computer');
  const asked = (env.PHOTOVAULT_IG_SCOPES ?? IG_DEFAULT_SCOPES.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  if (!asked.every((x) => (IG_SCOPES as readonly string[]).includes(x)) || !asked.includes('instagram_business_basic')) throw new Error(`PHOTOVAULT_IG_SCOPES may only contain ${IG_SCOPES.join(', ')} and must include instagram_business_basic`);
  return {
    appId, appSecret: () => appSecret, redirectUri, scopes: [...new Set(asked)], live: env.PHOTOVAULT_IG_LIVE === 'approved',
    ...(sandbox ? { authorizeUrl: `${sandbox}/oauth/authorize`, tokenUrl: `${sandbox}/oauth/access_token`, graphBase: `${sandbox}/v1` } : {}),
  };
}
