import { describe, expect, it } from 'vitest';
import type { SecretStore } from '@photovault/shared';
import { loadInstagramOAuthConfig } from './config.js';
import { IG_DEFAULT_SCOPES, InstagramConnection, PUBLISH_SCOPE } from './oauth.js';

const secrets = (m: Record<string, string>): SecretStore => ({ get: async (k: string) => m[k] ?? null } as unknown as SecretStore);
const S = secrets({ ig_app_id: '123', ig_app_secret: 'shh' });
const ENV = { PHOTOVAULT_IG_REDIRECT_URI: 'https://example.ts.net:8480/api/instagram/oauth/callback' } as NodeJS.ProcessEnv;

describe('Instagram permissions requested', () => {
  it('default to READ-ONLY history: only instagram_business_basic — publishing is never asked for unless deliberately enabled', async () => {
    const c = await loadInstagramOAuthConfig(S, { ...ENV, PHOTOVAULT_IG_LIVE: 'approved' }); expect(c!.scopes).toEqual(['instagram_business_basic']); expect(IG_DEFAULT_SCOPES).toEqual(['instagram_business_basic']);
    const conn = new InstagramConnection({ sql: undefined as never, cfg: c, atRestKey: Buffer.alloc(32), stateKey: Buffer.alloc(32, 1) });
    const u = new URL(conn.begin('00000000-0000-4000-8000-000000000000').url); expect(u.origin + u.pathname).toBe('https://www.instagram.com/oauth/authorize'); expect(u.searchParams.get('scope')).toBe('instagram_business_basic'); expect(u.searchParams.get('redirect_uri')).toBe('https://example.ts.net:8480/api/instagram/oauth/callback'); expect(u.searchParams.get('response_type')).toBe('code');
  });
  it('widening to publishing needs the explicit setting, accepts nothing else, and always keeps the basic permission', async () => {
    expect((await loadInstagramOAuthConfig(S, { ...ENV, PHOTOVAULT_IG_SCOPES: `instagram_business_basic,${PUBLISH_SCOPE}` }))!.scopes).toEqual(['instagram_business_basic', PUBLISH_SCOPE]);
    await expect(loadInstagramOAuthConfig(S, { ...ENV, PHOTOVAULT_IG_SCOPES: 'instagram_business_basic,instagram_business_manage_messages' })).rejects.toThrow(/may only contain/);
    await expect(loadInstagramOAuthConfig(S, { ...ENV, PHOTOVAULT_IG_SCOPES: PUBLISH_SCOPE })).rejects.toThrow(/must include instagram_business_basic/);
  });
  it('is not configured without the app id, secret and redirect address', async () => {
    expect(await loadInstagramOAuthConfig(secrets({}), ENV)).toBeNull(); expect(await loadInstagramOAuthConfig(S, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});
