import { describe, expect, it } from 'vitest';
import type { Clock } from '@photovault/shared';
import { AiGateway, BudgetError, DEFAULT_POLICY, MemoryLedger, type BudgetPolicy, type ProviderSet } from './gateway.js';
import { mockProvider } from '../providers/mock.js';

const img = (id: string) => ({ photoVersionId: id, previewPath: '/tmp/x.jpg' });

function liveSet(calls: string[]): ProviderSet {
  return {
    name: 'live', model: 'm', estimate: { visionUsd: 0.01, embeddingUsd: 0.001 },
    vision: { analyze: async (i) => { calls.push(`vision:${i.photoVersionId}`); return mockProvider.vision.analyze(i, {}); } },
    embedding: { ...mockProvider.embedding, embedImage: async (i) => { calls.push(`embed:${i.photoVersionId}`); return mockProvider.embedding.embedImage(i); } },
  };
}
const clock: Clock = { now: () => new Date('2026-10-15T12:00:00Z') };

describe('AiGateway', () => {
  it('uses only the mock and never records spend by default', async () => {
    const calls: string[] = [];
    const ledger = new MemoryLedger();
    const gw = new AiGateway({ mock: mockProvider, live: liveSet(calls), policy: () => DEFAULT_POLICY, ledger, clock });
    const a = await gw.analyze(img('v1'), {}, { purpose: 'test' });
    expect(a.description).toContain('[MOCK]');
    expect(calls).toEqual([]);
    expect(ledger.entries).toHaveLength(0);
  });

  it('is deterministic in mock mode', async () => {
    const gw = new AiGateway({ mock: mockProvider, policy: () => DEFAULT_POLICY, ledger: new MemoryLedger(), clock });
    const a = await gw.analyze(img('v1'), {}, { purpose: 't' });
    const b = await gw.analyze(img('v1'), {}, { purpose: 't' });
    expect(a).toEqual(b);
  });

  const on: BudgetPolicy = { liveEnabled: true, monthlyCapUsd: 0.05, perRunCapUsd: 0.03, lifetimePhotoCap: 2 };

  it('calls live when enabled and records the ledger before the call', async () => {
    const calls: string[] = [];
    const ledger = new MemoryLedger();
    const gw = new AiGateway({ mock: mockProvider, live: liveSet(calls), policy: () => on, ledger, clock });
    await gw.analyze(img('v1'), {}, { purpose: 'analyze' });
    expect(calls).toEqual(['vision:v1']);
    expect(ledger.entries[0]).toMatchObject({ provider: 'live', estCostUsd: 0.01, photoVersionId: 'v1' });
  });

  it('enforces the lifetime photo cap but allows re-use of an already-counted photo', async () => {
    const gw = new AiGateway({ mock: mockProvider, live: liveSet([]), policy: () => ({ ...on, monthlyCapUsd: 10, perRunCapUsd: 10 }), ledger: new MemoryLedger(), clock });
    await gw.analyze(img('a'), {}, { purpose: 'x' });
    await gw.analyze(img('b'), {}, { purpose: 'x' });
    await gw.embedImage(img('a'), { purpose: 'x' }); // already counted
    await expect(gw.analyze(img('c'), {}, { purpose: 'x' })).rejects.toMatchObject({ reason: 'PHOTO_CAP' });
  });

  it('enforces the monthly cap and refuses instead of degrading silently', async () => {
    const gw = new AiGateway({ mock: mockProvider, live: liveSet([]), policy: () => ({ ...on, lifetimePhotoCap: 100 }), ledger: new MemoryLedger(), clock });
    for (const id of ['1', '2', '3', '4', '5']) await gw.analyze(img(id), {}, { purpose: 'x' }); // 0.05
    await expect(gw.analyze(img('6'), {}, { purpose: 'x' })).rejects.toBeInstanceOf(BudgetError);
  });

  it('enforces the per-run cap', async () => {
    const gw = new AiGateway({ mock: mockProvider, live: liveSet([]), policy: () => ({ ...on, lifetimePhotoCap: 100, monthlyCapUsd: 10 }), ledger: new MemoryLedger(), clock });
    for (const id of ['1', '2', '3']) await gw.analyze(img(id), {}, { purpose: 'x', runId: 'r' }); // 0.03
    await expect(gw.analyze(img('4'), {}, { purpose: 'x', runId: 'r' })).rejects.toMatchObject({ reason: 'RUN_CAP' });
  });

  it('falls back to mock if live is enabled but no live provider is configured', async () => {
    const gw = new AiGateway({ mock: mockProvider, policy: () => on, ledger: new MemoryLedger(), clock });
    expect((await gw.analyze(img('v'), {}, { purpose: 'x' })).description).toContain('[MOCK]');
  });
});
