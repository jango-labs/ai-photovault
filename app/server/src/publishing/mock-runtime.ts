import path from 'node:path';
import type { Sql } from 'postgres';
import { InstagramSync } from '../instagram/sync.js';
import { buildDeliveryApp, LocalTokenDelivery } from './delivery.js';
import { HttpGraphPublisher, MockGraphServer } from './graph.js';
import { Publisher } from './publisher.js';

/** Everything the publisher needs to run against the LOCAL mock: a mock Graph server, the isolated delivery service, and the publisher itself. No network beyond loopback. */
export interface MockRuntime { publisher: Publisher; graph: MockGraphServer; deliveryUrl: string; stop(): Promise<void> }
export async function startMockRuntime(o: { service: Sql; delivery: Sql; deliveryDir: string; mediaDir?: string | null; derivativesDir?: string | null; now?: () => Date; sleep?: (ms: number) => Promise<void>; instance?: string; pollsToFinish?: number }): Promise<MockRuntime> {
  const graph = new MockGraphServer({ token: 'mock-token', igUserId: 'ig-mock', pollsToFinish: o.pollsToFinish ?? 1, ...(o.now ? { now: o.now } : {}) }); await graph.start();
  const app = buildDeliveryApp({ sql: o.delivery, dir: o.deliveryDir, ...(o.now ? { now: o.now } : {}) }); await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address(); const deliveryUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const media = o.mediaDir ? new InstagramSync(o.service, o.mediaDir, o.derivativesDir ?? null) : null;
  const publisher = new Publisher({
    sql: o.service, mock: true, ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.instance ? { instance: o.instance } : {}),
    graph: new HttpGraphPublisher({ baseUrl: graph.baseUrl, igUserId: 'ig-mock', token: () => 'mock-token' }),
    delivery: new LocalTokenDelivery({ sql: o.service, dir: o.deliveryDir, baseUrl: deliveryUrl, ...(o.now ? { now: o.now } : {}) }),
    ...(media ? { storeMedia: (u: string, row: string, jpeg: Buffer) => media.storeMedia(u, row, jpeg) } : {}),
    libraryFile: async (v) => { const abs = path.resolve(v.root, v.relpath); const { access } = await import('node:fs/promises'); try { await access(abs); return abs; } catch { if (!o.derivativesDir) return null; const d = path.join(o.derivativesDir, v.versionId, 'view.jpg'); try { await access(d); return d; } catch { return null; } } },
  });
  return { publisher, graph, deliveryUrl, stop: async () => { await app.close(); await graph.stop(); } };
}
