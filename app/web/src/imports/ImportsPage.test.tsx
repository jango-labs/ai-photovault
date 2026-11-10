import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';
import type { ImportStatus, RunRow } from './api';

afterEach(() => vi.unstubAllGlobals());

const run = (o: Partial<RunRow> = {}): RunRow => ({ id: 'run-1', mode: 'APPLY', state: 'COMPLETED', sourcePath: '/photos', startedAt: '2026-10-09T08:00:00Z', finishedAt: '2026-10-09T08:05:00Z', heartbeatAt: '2026-10-09T08:05:00Z', counters: { scanned: 120, new: 100, unchanged: 15, newVersions: 3, moved: 2, errors: 0, bytes: 5e8 }, error: null, resumedFrom: null, ...o });
const status = (o: Partial<ImportStatus['source']> = {}, q: Partial<ImportStatus['queue']> = {}, last: RunRow | null = run()): ImportStatus => ({
  source: { configured: '/Users/me/Pictures/Exports', dryRunApproved: false, applyApproved: false, previewsDirectory: true, ...o }, running: false,
  queue: { jobs: [], derivatives: { pending: 0, ready: 0, failed: 0, missing: 0 }, failed: [], workerSeenAt: null, ...q }, lastRun: last,
});
const page = (st: ImportStatus, extra: Routes = {}) => { const calls = mockApi(signedIn({ 'GET /api/imports/status': { json: st }, 'GET /api/imports/runs': { json: { runs: st.lastRun ? [st.lastRun] : [] } }, 'GET /api/imports/review': { json: { items: [] } }, ...extra })); renderApp('/imports'); return calls; };

describe('Imports workspace', () => {
  it('without approval it says nothing was scanned, tells the owner how to approve, and offers no way to start', async () => {
    page(status({}, {}, null));
    const src = await screen.findByRole('region', { name: 'Source' });
    expect(within(src).getByText('/Users/me/Pictures/Exports')).toBeTruthy();
    expect(within(src).getByRole('status').textContent).toMatch(/Nothing in this folder has been opened, listed or scanned/);
    expect(within(src).getByRole('status').textContent).toMatch(/npm run ingest:approve/);
    expect((within(src).getByRole('button', { name: 'Dry run' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(src).getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByRole('heading', { name: 'No imports yet' })).toBeTruthy();
  });
  it('shows the permanent source: name, read-only, availability, counts, last and next scan, and what the last scan did', async () => {
    const info = { name: 'MyPhotos', path: '/Users/me/Pictures/Exports', type: 'Local folder', mode: 'Read only', available: true, unavailableReason: null, discovered: 195, imported: 195, skipped: 5, lastScanAt: '2026-10-16T08:00:00Z', lastScanState: 'COMPLETED', lastRunAt: '2026-10-16T08:00:00Z', lastRunState: 'COMPLETED', lastError: null, scanIntervalMinutes: 360, nextScanAt: '2026-10-16T14:00:00Z', scanning: false, lastScan: { new: 2, unchanged: 193, moved: 1, skipped: 5, failed: 0, missing: 0, duplicates: 0 } };
    page(status({ dryRunApproved: true, applyApproved: true, info }));
    const src = await screen.findByRole('region', { name: 'Source' });
    const d = within(src).getByLabelText('Source details');
    for (const t of ['MyPhotos', 'Local folder · Read only', 'Available', '195']) expect(within(d).getAllByText(t).length).toBeGreaterThan(0);
    expect(d.textContent).toMatch(/Last scan.*2026/); expect(d.textContent).toMatch(/Next scan/);
    expect(d.textContent).toMatch(/2 new · 193 unchanged · 1 moved or renamed · 5 skipped · 0 failed/);
    expect(await axe(src)).toHaveNoViolations();
  });
  it('an unavailable source says scans are paused and that nothing is removed', async () => {
    const info = { name: 'MyPhotos', path: '/x', type: 'Local folder', mode: 'Read only', available: false, unavailableReason: 'The folder is not there (is the disk that holds it connected?).', discovered: null, imported: 0, skipped: 0, lastScanAt: null, lastScanState: null, lastRunAt: null, lastRunState: null, lastError: null, scanIntervalMinutes: 360, nextScanAt: null, scanning: false, lastScan: null };
    page(status({ dryRunApproved: true, applyApproved: true, info }, {}, null));
    const src = await screen.findByRole('region', { name: 'Source' });
    expect(within(src).getByText(/Not available — The folder is not there/)).toBeTruthy();
    expect(within(src).getByText(/Scans are paused while the folder is unavailable. Nothing in your library is removed/)).toBeTruthy();
    expect(within(src).getByText('Never')).toBeTruthy(); expect(within(src).getByText('Waiting for the folder to be available')).toBeTruthy();
  });
  it('a dry-run approval enables the dry run only; starting it calls the API', async () => {
    const calls = page(status({ dryRunApproved: true }), { 'POST /api/imports/runs': { status: 202, json: { runId: 'r2' } } });
    const src = await screen.findByRole('region', { name: 'Source' });
    expect((within(src).getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(src).getByRole('button', { name: 'Dry run' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/imports/runs')?.body).toEqual({ mode: 'DRY_RUN' }));
  });
  it('a refused start (403 not_approved) is explained, not shown as a crash', async () => {
    page(status({ dryRunApproved: true, applyApproved: true }), { 'POST /api/imports/runs': { status: 403, json: { error: 'not_approved', message: 'The owner has not approved this directory yet. Nothing was scanned.' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Not approved yet')).toBeTruthy();
  });
  it('shows a running import with progress and a Cancel button', async () => {
    const calls = page(status({ dryRunApproved: true, applyApproved: true }, {}, run({ state: 'RUNNING', finishedAt: null, counters: { scanned: 40, new: 38 } })), { 'POST /api/imports/runs/run-1/cancel': { json: { ok: true } } });
    expect(await screen.findByRole('progressbar', { name: 'Import in progress' })).toBeTruthy();
    expect(screen.getAllByText(/40 scanned · 38 new/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/imports/runs/run-1/cancel')).toBe(true));
  });
  it('processing: counts, determinate progress, worker heartbeat, failed jobs with retry', async () => {
    const calls = page(status({ applyApproved: true, dryRunApproved: true }, { derivatives: { pending: 20, ready: 75, failed: 5, missing: 1 }, workerSeenAt: '2026-10-09T08:04:00Z', failed: [{ id: 'j1', kind: 'derive.preview', state: 'DEAD', error: 'the source file is not available right now', attempts: 5, relpath: '2024/Kenya/a.jpg' }] }), { 'POST /api/imports/jobs/retry': { json: { requeued: 5 } } });
    const sec = await screen.findByRole('region', { name: 'Processing' });
    expect(await within(sec).findByText('75 of 100 photographs have previews, 20 waiting, 5 failed.')).toBeTruthy();
    expect(within(sec).getByRole('progressbar', { name: 'Previews prepared' }).getAttribute('aria-valuenow')).toBe('75');
    expect(within(sec).getByText(/Worker last seen/)).toBeTruthy(); expect(within(sec).getByText(/1 source file is no longer on disk \(records kept\)/)).toBeTruthy();
    expect(within(sec).getByText('2024/Kenya/a.jpg')).toBeTruthy();
    await userEvent.click(within(sec).getByRole('button', { name: 'Try the failed ones again' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/imports/jobs/retry')).toBe(true));
    expect(await screen.findByText('5 jobs queued again')).toBeTruthy();
  });
  it('review: same / different photograph and acknowledging a second copy', async () => {
    const calls = page(status({}, {}, null), { 'GET /api/imports/review': { json: { items: [
      { id: 'q1', kind: 'VERSION_MATCH', subject: { relpath: '2024/Kenya/reexport.jpg', photoId: 'ph1', versionId: 'v1' }, createdAt: 'x' },
      { id: 'q2', kind: 'DUPLICATE_FILE', subject: { relpath: 'copy.jpg', sameAs: 'orig.jpg' }, createdAt: 'x' }] } }, '~POST /api/imports/review/[^/]+': { json: { ok: true } } });
    const sec = await screen.findByRole('region', { name: 'Needs your decision' });
    await userEvent.click(await within(sec).findByRole('button', { name: 'Same photograph' }));
    await userEvent.click(within(sec).getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(calls.filter((c) => c.path.startsWith('/api/imports/review/')).map((c) => c.body)).toEqual([{ decision: 'SAME_PHOTO' }, { decision: 'ACKNOWLEDGE' }]));
  });
  it('history lists runs with what each decided and links to the details; has no axe violations', async () => {
    page(status({ dryRunApproved: true, applyApproved: true }, { derivatives: { pending: 0, ready: 100, failed: 0, missing: 0 } }));
    const hist = await screen.findByRole('region', { name: 'History' });
    expect(await within(hist).findByText(/120 scanned · 100 new · 3 new versions · 2 moved · 15 unchanged/)).toBeTruthy();
    expect(within(hist).getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/imports/runs/run-1');
    expect(await axe(document.body)).toHaveNoViolations();
  });
  it('a run page lists what was decided, filterable by result', async () => {
    mockApi(signedIn({ '~GET /api/imports/runs/run-1': { json: { run: run(), byAction: { NEW: 2, ERROR: 1 }, nextAfter: null, items: [{ id: 1, relpath: '2024/Kenya/a.jpg', action: 'NEW', detail: null, sha: 'abc' }, { id: 2, relpath: 'broken.jpg', action: 'ERROR', detail: 'not a readable JPEG', sha: null }] } } }));
    renderApp('/imports/runs/run-1');
    const t = await screen.findByRole('table', { name: 'What this run decided' });
    expect(within(t).getByText('broken.jpg')).toBeTruthy(); expect(within(t).getByText('not a readable JPEG')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Errors 1' })).toBeTruthy();
  });
});
