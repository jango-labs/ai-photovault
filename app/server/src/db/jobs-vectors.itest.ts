import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedPhoto, seedUser, tryHandles, wipe, type Handles } from './testdb.js';

let h: Handles | null;
beforeAll(async () => { h = await tryHandles(); });
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); return h!; };
let U = '';
beforeEach(async () => { if (!h) return; await wipe(h.svc); U = await seedUser(h.svc); });

describe('job queue (leases, SKIP LOCKED)', () => {
  it('concurrent workers never claim the same job', async (ctx) => {
    const { svc } = need(ctx);
    await svc`INSERT INTO jobs (user_id, kind) SELECT ${U}, 'derivatives' FROM generate_series(1, 40)`;
    const claim = (w: string) => svc`SELECT id FROM claim_jobs(${w}, ARRAY['derivatives'], 15, interval '5 minutes')`;
    const results = await Promise.all(['w1', 'w2', 'w3'].map(claim));
    const ids = results.flat().map((r) => r.id as string);
    expect(ids).toHaveLength(40);   // 3 x 15 = 45 >= 40: everything claimed exactly once
    expect(new Set(ids).size).toBe(ids.length);
    expect((await svc`SELECT count(*)::int AS n FROM jobs WHERE state = 'RUNNING' AND attempts = 1`)[0]!.n).toBe(40);
  });
  it('only claims requested kinds and respects run_after and priority', async (ctx) => {
    const { svc } = need(ctx);
    await svc`INSERT INTO jobs (user_id, kind, priority) VALUES (${U}, 'analyze', 0), (${U}, 'derivatives', 5), (${U}, 'derivatives', 9)`;
    await svc`INSERT INTO jobs (user_id, kind, run_after) VALUES (${U}, 'derivatives', now() + interval '1 hour')`;
    const got = await svc`SELECT priority FROM claim_jobs('w', ARRAY['derivatives'], 10, interval '1 minute') ORDER BY priority DESC`;
    expect(got.map((g) => g.priority)).toEqual([9, 5]);
  });
  it('expired leases are re-queued, and exhausted jobs become DEAD', async (ctx) => {
    const { svc } = need(ctx);
    await svc`INSERT INTO jobs (user_id, kind, max_attempts) VALUES (${U}, 'k', 2)`;
    await svc`SELECT * FROM claim_jobs('w1', ARRAY['k'], 1, interval '1 minute')`;            // attempt 1 (worker "dies")
    await svc`UPDATE jobs SET locked_until = now() - interval '1 second'`;
    expect(await svc`SELECT * FROM claim_jobs('w2', ARRAY['k'], 1, interval '1 minute')`).toHaveLength(1);   // re-queued, attempt 2
    await svc`UPDATE jobs SET locked_until = now() - interval '1 second'`;
    expect(await svc`SELECT * FROM claim_jobs('w3', ARRAY['k'], 1, interval '1 minute')`).toHaveLength(0);   // attempts exhausted
    expect((await svc`SELECT state, finished_at IS NOT NULL AS done FROM jobs`)[0]).toEqual({ state: 'DEAD', done: true });
  });
  it('de-duplicates active jobs by key but allows a new one after completion', async (ctx) => {
    const { svc } = need(ctx);
    await svc`INSERT INTO jobs (user_id, kind, dedupe_key) VALUES (${U}, 'derivatives', 'v1')`;
    await expect(svc`INSERT INTO jobs (user_id, kind, dedupe_key) VALUES (${U}, 'derivatives', 'v1')`).rejects.toMatchObject({ code: '23505' });
    await svc`UPDATE jobs SET state = 'SUCCEEDED', finished_at = now()`;
    await svc`INSERT INTO jobs (user_id, kind, dedupe_key) VALUES (${U}, 'derivatives', 'v1')`;
  });
  it('a RUNNING job must carry a lease', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`INSERT INTO jobs (user_id, kind, state) VALUES (${U}, 'k', 'RUNNING')`).rejects.toMatchObject({ code: '23514' });
  });
});

const vec = (seed: number, dims = 1024) => {
  let s = seed || 1; const v: number[] = [];
  for (let i = 0; i < dims; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v.push(s / 0xffffffff - 0.5); }
  return `[${v.join(',')}]`;
};

describe('vector and perceptual-hash search', () => {
  it('HNSW nearest-neighbour search returns the identical image first and uses the index', async (ctx) => {
    const { svc } = need(ctx);
    const ids: string[] = [];
    for (let i = 1; i <= 40; i++) {
      const p = await seedPhoto(svc, U); ids.push(p.versionId);
      await svc`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding) VALUES (${U}, ${p.versionId}, 'mock-embedding', 'image', 1024, ${vec(i)}::halfvec)`;
    }
    const q = vec(7);
    // an approximate index over a table that other tests have inserted into and wiped can miss the true neighbour at the default search width: widen it
    const hit = await svc.begin(async (tx) => { await tx`SET LOCAL hnsw.ef_search = 400`; return tx`SELECT photo_version_id, (embedding::halfvec(1024) <=> ${q}::halfvec(1024)) AS d FROM photo_embeddings
      WHERE model = 'mock-embedding' AND kind = 'image' ORDER BY embedding::halfvec(1024) <=> ${q}::halfvec(1024) LIMIT 3`; });
    expect(hit[0]!.photo_version_id).toBe(ids[6]);
    expect(Number(hit[0]!.d)).toBeLessThan(1e-3);
    await svc.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const plan = await tx.unsafe(`EXPLAIN SELECT photo_version_id FROM photo_embeddings WHERE model = 'mock-embedding' AND kind = 'image'
        ORDER BY embedding::halfvec(1024) <=> '${q}'::halfvec(1024) LIMIT 5`);
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('photo_embeddings_mock_hnsw');
    });
  });

  it('multi-index hashing finds every near-duplicate within Hamming distance 3 (matches brute force)', async (ctx) => {
    const { svc } = need(ctx);
    const base = 0x123456789abcdef0n;
    const flip = (x: bigint, bits: number[]) => bits.reduce((a, b) => a ^ (1n << BigInt(b)), x);
    const toSigned = (x: bigint) => BigInt.asIntN(64, x);
    const near = [flip(base, [1]), flip(base, [17, 40]), flip(base, [3, 22, 63])];
    const far = [flip(base, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 0x0fedcba987654321n];
    for (const hsh of [base, ...near, ...far]) await seedPhoto(svc, U, { phash: toSigned(hsh) });
    for (let i = 0; i < 60; i++) await seedPhoto(svc, U, { phash: toSigned(BigInt(Math.floor(Math.random() * 2 ** 52)) * 4096n + BigInt(i)) });
    const q = toSigned(base).toString();
    const viaIndex = await svc`SELECT id FROM photo_versions WHERE user_id = ${U} AND phash IS NOT NULL AND hamming64(phash, ${q}::bigint) <= 3
      AND (phash_s0 = ((${q}::bigint >> 48) & 65535)::int OR phash_s1 = ((${q}::bigint >> 32) & 65535)::int
        OR phash_s2 = ((${q}::bigint >> 16) & 65535)::int OR phash_s3 = (${q}::bigint & 65535)::int)`;
    const brute = await svc`SELECT id FROM photo_versions WHERE user_id = ${U} AND phash IS NOT NULL AND hamming64(phash, ${q}::bigint) <= 3`;
    expect(viaIndex.map((r) => r.id).sort()).toEqual(brute.map((r) => r.id).sort());
    expect(brute.length).toBeGreaterThanOrEqual(4);   // base + 3 near
  });
});
void randomUUID;
