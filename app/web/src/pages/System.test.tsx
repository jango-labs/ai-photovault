import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());
const OPS = { services: [{ name: 'worker', instance: 'mini', version: '0.5.0', lastSeenAt: 'x', ageSeconds: 12, status: 'running' }, { name: 'scheduler', instance: 'mini', version: '0.5.0', lastSeenAt: 'x', ageSeconds: 900, status: 'stopped' }], backups: { lastVerifiedDump: { at: 'x', ageSeconds: 7200, bytes: 6_610_947 }, lastRestoreTest: { at: 'x', ageSeconds: 7300 }, stale: false } };
const STORAGE = { database: { bytes: 90_000_000, tables: [{ name: 'photos', bytes: 40_000_000, rows: 3000 }] }, dirs: [{ key: 'derivatives', label: 'Previews', path: '/d', bytes: 5e9, files: 12000, freeBytes: 50e9, totalBytes: 100e9, truncated: false }, { key: 'igMedia', label: 'Instagram images', path: null, bytes: null, files: null, freeBytes: null, totalBytes: null, truncated: false }, { key: 'backups', label: 'Backups', path: '/b', bytes: 1e9, files: 3, freeBytes: 4e9, totalBytes: 100e9, truncated: false }] };
const start = (extra: Routes = {}) => { mockApi(signedIn({ 'GET /api/system/status': { json: { api: { ok: true, version: '0.5.0', uptimeSeconds: 600, node: 'v24' }, database: { ok: true, latencyMs: 3, version: '17' }, time: 'x' } }, 'GET /api/system/ops': { json: OPS }, 'GET /api/system/storage': { json: STORAGE }, ...extra })); renderApp('/settings/system'); };

describe('System page: housekeeping', () => {
  it('shows each background process as running or not running, with when it last reported', async () => {
    start(); const block = (await screen.findByText('Background processes')).closest('section')!;
    expect(await within(block).findByText(/Running · last seen 12 s ago/)).toBeTruthy(); expect(within(block).getByText(/Not running · last seen 15 min ago/)).toBeTruthy(); expect(within(block).getByText('Publisher (mock only)')).toBeTruthy();
  });
  it('explains that backups are made with scripts/backup.sh and are not automatic', async () => {
    start(); expect(await screen.findByText(/does not back itself up/i)).toBeTruthy();
  });
  it('shows whether the external photo drive is connected, and says plainly when it is not', async () => {
    start({ 'GET /api/system/data-root': { json: { configured: true, ready: false, reason: 'the drive is not connected' } } });
    const block = (await screen.findByText('Photo drive (thumbnails and previews)')).closest('section')!;
    expect(await within(block).findByText('NOT AVAILABLE')).toBeTruthy(); expect(within(block).getByRole('alert').textContent).toMatch(/the drive is not connected.*resumes by itself/);
  });
  it('shows nothing about a photo drive when none is configured', async () => {
    start({ 'GET /api/system/data-root': { json: { configured: false } } }); await screen.findByText('Storage'); expect(screen.queryByText('Photo drive (thumbnails and previews)')).toBeNull();
  });
  it('shows storage by folder with free space, flags a nearly full disk, and lists the largest tables', async () => {
    start({ 'GET /api/system/storage': { json: { ...STORAGE, dirs: STORAGE.dirs.map((d) => (d.key === 'backups' ? { ...d, freeBytes: 4e9 } : d)) } } });
    const block = (await screen.findByText('Storage')).closest('section')!; expect(await within(block).findByText(/5\.0 GB · 12,000 files · 50\.0 GB free/)).toBeTruthy(); expect(within(block).getByText(/Less than 10 GB free where “Backups” lives/)).toBeTruthy();
    expect(within(block).queryByText('Instagram images')).toBeNull(); expect(within(block).getByText('photos')).toBeTruthy();
  });
  it('a failure to read is stated, not hidden', async () => {
    start({ 'GET /api/system/ops': { status: 500, json: { error: 'x', message: 'x' } }, 'GET /api/system/storage': { status: 500, json: { error: 'x', message: 'x' } } });
    expect(await screen.findByText('Their status could not be read.')).toBeTruthy(); expect(await screen.findByText('Storage could not be measured.')).toBeTruthy();
  });
  it('shows the work queues, recent failures and what needs attention', async () => {
    const WORK = { queues: [{ kind: 'ai.analyze', queued: 4, running: 1, failed24h: 2, dead: 1, oldestQueuedSeconds: 60 }], failures: [{ kind: 'ai.analyze', state: 'DEAD', at: '2026-10-10T10:00:00Z', error: 'model not installed' }],
      imports: { last: { mode: 'COMMIT', state: 'SUCCEEDED', startedAt: '2026-10-10T09:00:00Z', finishedAt: null, counters: {}, error: null }, running: false }, previews: { pending: 3, failed: 0 },
      publishing: { scheduled: 0, nextAt: null, publishing: 0, failed7d: 0, overdue: 0 }, instagram: null, problems: ['AI analysis: 1 job gave up after repeated failures'] };
    start({ 'GET /api/system/work': { json: WORK } });
    expect(await screen.findByText(/AI analysis: 1 job gave up/)).toBeTruthy();
    expect(await screen.findByText(/4 waiting · 1 running · 2 failed in 24 h · 1 gave up/)).toBeTruthy();
    expect(await screen.findByText('model not installed')).toBeTruthy(); expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0);
  });
  it('shows the security log in plain words, flags failures, and says what it never records', async () => {
    start({ 'GET /api/system/audit': { json: { events: [{ id: 2, at: '2026-10-10T10:05:00Z', action: 'auth.second_factor_failed', ip: '100.64.0.9' }, { id: 1, at: '2026-10-10T10:00:00Z', action: 'auth.signed_in', ip: '100.64.0.9' }] } } });
    const block = (await screen.findByText('Security log')).closest('section')!;
    expect(await within(block).findByText(/Wrong code entered · 100\.64\.0\.9/)).toBeTruthy(); expect(within(block).getByText(/Signed in · 100\.64\.0\.9/)).toBeTruthy();
    expect(within(block).getByText(/never records passwords/)).toBeTruthy();
  });
});
