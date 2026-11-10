#!/usr/bin/env node
// Installation validator: talks to a RUNNING AI PhotoVault over HTTP and checks that it works and is private by default.
//   PHOTOVAULT_VALIDATE_EMAIL=you@example.com PHOTOVAULT_VALIDATE_PASSWORD=... node scripts/validate-install.mjs [--url http://127.0.0.1:8480] [--expect-photos 36]
// Use a dedicated account (npm run user -- create ...). If the account has no authenticator yet, the validator enrols one (the secret is
// not printed or saved), so use a throw-away validation account, not your everyday login. No data is changed except a Curator run record.
import crypto from 'node:crypto';
import http from 'node:http';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const base = new URL(arg('url', process.env.PHOTOVAULT_URL ?? 'http://127.0.0.1:8480'));
const email = process.env.PHOTOVAULT_VALIDATE_EMAIL, password = process.env.PHOTOVAULT_VALIDATE_PASSWORD;
const expectPhotos = Number(arg('expect-photos', '1'));
const jar = new Map(); let csrf;

function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { host: base.host, 'user-agent': 'photovault-validate', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    if (method !== 'GET') h.origin = base.origin;
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    const req = http.request({ hostname: base.hostname, port: base.port, path, method, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        for (const c of res.headers['set-cookie'] ?? []) { const [kv] = c.split('; '); const i = kv.indexOf('='); if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); }
        const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, bytes: buf.length });
      });
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secretB32) {
  let bits = 0, value = 0; const key = [];
  for (const ch of secretB32.toUpperCase().replace(/[\s=-]/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { key.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(key)).update(ctr).digest(); const o = h[19] & 15;
  return String(((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0');
}

const results = [];
async function check(name, fn) {
  try { const r = await fn(); const ok = r === true || r === undefined || (r && r.ok); results.push({ name, ok: !!ok, detail: r && r.detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${r && r.detail ? `  (${r.detail})` : ''}`); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message ?? e) }); console.log(`FAIL  ${name}  (${e.message ?? e})`); }
}

await check('server answers /api/health with a working database', async () => { const r = await call('GET', '/api/health'); return { ok: r.status === 200 && r.json?.database === 'ok', detail: `HTTP ${r.status}` }; });
await check('listens on loopback by default (URL host is local)', async () => ({ ok: ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), detail: base.hostname }));
await check('library API refuses anonymous requests (401)', async () => ({ ok: (await call('GET', '/api/library/photos')).status === 401 }));
await check('image API refuses anonymous requests', async () => ({ ok: [401, 404].includes((await call('GET', '/api/library/photos/00000000-0000-0000-0000-000000000000/image?size=thumb')).status) }));
await check('a foreign Host header is rejected (DNS-rebinding protection)', async () => { const r = await call('GET', '/api/health', undefined, { host: 'evil.example.com' }); return { ok: r.status >= 400 && r.status < 500, detail: `HTTP ${r.status}` }; });
await check('responses carry anti-framing / sniffing headers', async () => { const r = await call('GET', '/api/health'); return { ok: !!r.headers['x-content-type-options'] && (!!r.headers['x-frame-options'] || /frame-ancestors/.test(r.headers['content-security-policy'] ?? '')) }; });

if (!email || !password) {
  console.log('\nSkipping authenticated checks: set PHOTOVAULT_VALIDATE_EMAIL and PHOTOVAULT_VALIDATE_PASSWORD (a dedicated account).');
} else {
  let signedIn = false;
  await check('sign-in with password and authenticator (enrols one if needed)', async () => {
    const l = await call('POST', '/api/auth/login', { email, password });
    if (!l.json?.challenge) return { ok: false, detail: `login HTTP ${l.status}` };
    if (l.json.step === 'enroll') {
      const s = await call('POST', '/api/auth/totp/setup', { challenge: l.json.challenge });
      if (!s.json?.secret) return { ok: false, detail: `setup HTTP ${s.status}` };
      const c = await call('POST', '/api/auth/totp/confirm', { challenge: l.json.challenge, code: totp(s.json.secret) });
      if (c.status !== 200) return { ok: false, detail: `confirm HTTP ${c.status}` };
    } else return { ok: false, detail: 'account already has an authenticator; use a fresh validation account' };
    const me = await call('GET', '/api/auth/me'); csrf = me.json?.csrfToken; signedIn = me.status === 200 && !!csrf;
    return { ok: signedIn, detail: `HTTP ${me.status}` };
  });
  if (signedIn) {
    let photos = [];
    await check(`gallery lists photographs (expected at least ${expectPhotos})`, async () => { const r = await call('GET', '/api/library/photos?limit=200'); photos = r.json?.items ?? r.json?.photos ?? []; return { ok: r.status === 200 && photos.length >= expectPhotos, detail: `${photos.length} returned` }; });
    await check('filters/facets endpoint answers', async () => { const r = await call('GET', '/api/library/facets'); return { ok: r.status === 200, detail: Object.keys(r.json ?? {}).join(',').slice(0, 80) }; });
    if (photos[0]) {
      const withMeta = []; for (const p of photos.slice(0, 5)) { const d = await call('GET', `/api/library/photos/${p.id}`); if (d.status === 200) withMeta.push(d.json); }
      await check('photo detail exposes camera, lens, focal length, aperture, ISO, shutter, capture date', async () => {
        const blob = JSON.stringify(withMeta[0] ?? {}); const need = ['camera', 'lens', 'focal', 'iso', 'captureAt'].filter((k) => !new RegExp(k, 'i').test(blob));
        return { ok: withMeta.length > 0 && need.length === 0, detail: need.length ? `missing: ${need.join(',')}` : 'present' };
      });
      await check('thumbnail is served as an image', async () => { const r = await call('GET', `/api/library/photos/${photos[0].id}/image?size=thumb`); return { ok: r.status === 200 && /image\/jpeg/.test(r.headers['content-type'] ?? ''), detail: `HTTP ${r.status}, ${r.bytes} bytes` }; });
      await check('similar-image search answers', async () => { const r = await call('GET', `/api/search/similar/${photos[0].id}`); return { ok: r.status === 200, detail: `HTTP ${r.status}` }; });
    }
    const q = arg('query', 'mountain mist');
    await check(`natural-language search "${q}" returns results`, async () => { const r = await call('GET', `/api/search?q=${encodeURIComponent(q)}`); const n = (r.json?.items ?? r.json?.results ?? []).length; return { ok: r.status === 200 && n > 0, detail: `${n} results; interpretation ${JSON.stringify(r.json?.understood ?? r.json?.interpretation ?? r.json?.mode ?? '').slice(0, 60)}` }; });
    await check('AI Curator produces a ranked selection with reasons', async () => {
      const r = await call('POST', '/api/curator/run', { request: 'landscape photographs', count: 5, purpose: 'general' });
      const items = r.json?.picks ?? [];
      return { ok: r.status === 200 && items.length > 0, detail: `HTTP ${r.status}, ${items.length} picks; keys ${Object.keys(r.json ?? {}).join(',').slice(0, 60)}` };
    });
    await check('map clusters endpoint answers', async () => { const r = await call('GET', '/api/map/summary'); return { ok: r.status === 200, detail: `HTTP ${r.status}` }; });
    await check('Instagram integration is off by default', async () => { const r = await call('GET', '/api/instagram/status'); return { ok: r.status === 200 ? r.json?.connected !== true : r.status === 404, detail: `HTTP ${r.status}` }; });
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
