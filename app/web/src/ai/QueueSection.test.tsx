import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';
import type { AiStatus, QueueStatus } from './api';

afterEach(() => vi.unstubAllGlobals());
const STATUS: AiStatus = { settings: { provider: 'local-image', autoAnalyze: true }, promptVersion: 'local-1', photos: 100, analysed: 40, stale: 0, jobs: { QUEUED: 60 }, providers: [{ id: 'local-image', label: 'Measured on this computer', kind: 'local', available: true, note: 'x' }], live: { enabled: false, lifetimePhotoCap: 25, spendRecords: 0, spentUsd: 0 } };
const Q = (o: Partial<QueueStatus> = {}): QueueStatus => ({ paused: false, previewsPaused: false, waiting: 60, running: 1, done24h: 40, failed24h: 2, cancelled: 0, gaveUp: 0, prioritised: 0, secondsPerItem: 11, etaSeconds: 660, oldestWaitingSeconds: 30, perKind: [{ kind: 'ai.analyze', waiting: 60, running: 1 }], ...o });
const open = (q: QueueStatus, extra: Routes = {}) => { const calls = mockApi(signedIn({ 'GET /api/ai/status': { json: STATUS }, 'GET /api/ai/queue': { json: q }, 'GET /api/ai/queue/history': { json: { items: [] } }, ...extra })); renderApp('/settings/ai'); return calls; };

describe('Settings → AI → Analysis queue', () => {
  it('shows progress, speed and a time estimate, and has no violations', async () => {
    open(Q()); const sec = (await screen.findByLabelText('Analysis queue'));
    expect(await within(sec).findByText(/60 waiting · 1 running · 40 done in the last 24 h · 2 failed · about 11 min to go \(11 s per photograph\)/)).toBeTruthy();
    expect(within(sec).getByText('Analysis')).toBeTruthy(); expect(await axe(sec)).toHaveNoViolations();
  });
  it('Pause sends the request and says what pausing means; a paused queue offers Resume', async () => {
    let paused = false; const calls = open(Q(), { 'POST /api/ai/queue/pause': () => { paused = true; return { json: Q({ paused: true }) }; } } as unknown as Routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' })); expect(calls.some((c) => c.path === '/api/ai/queue/pause')).toBe(true); expect(paused).toBe(true);
    expect(await screen.findByText(/Nothing new starts until you resume/)).toBeTruthy();
  });
  it('a paused queue says so and shows Resume', async () => {
    open(Q({ paused: true })); expect(await screen.findByText(/Paused — nothing new starts/)).toBeTruthy(); expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
  it('prioritising recent imports and cancelling both ask the server; cancel asks first', async () => {
    const calls = open(Q({ prioritised: 3 }), { 'POST /api/ai/queue/prioritize': { json: { updated: 12 } }, 'POST /api/ai/queue/cancel': { json: { cancelled: 60 } } });
    await userEvent.click(await screen.findByRole('button', { name: /last day’s imports first/ })); expect(await screen.findByText('12 jobs moved')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/ai/queue/prioritize')!.body).toEqual({ importedWithinHours: 24 });
    await userEvent.click(screen.getByRole('button', { name: 'Back to normal order' })); expect(calls.filter((c) => c.path === '/api/ai/queue/prioritize').pop()!.body).toEqual({ reset: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel what is waiting' })); expect(calls.some((c) => c.path === '/api/ai/queue/cancel')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel what is waiting' })); expect(calls.some((c) => c.path === '/api/ai/queue/cancel')).toBe(true); expect(confirm).toHaveBeenCalledTimes(2);
  });
  it('lists recent activity, including failures with their reason', async () => {
    open(Q(), { 'GET /api/ai/queue/history': { json: { items: [{ id: '1', kind: 'ai.analyze', outcome: 'OK', startedAt: '2026-10-12T10:00:00Z', seconds: 11.2, error: null, photoId: 'p', title: 'Lion at dawn' }, { id: '2', kind: 'ai.analyze', outcome: 'ERROR', startedAt: '2026-10-12T09:59:00Z', seconds: 1, error: 'model not installed', photoId: 'q', title: 'Heron' }] } } });
    await userEvent.click(await screen.findByText('Recent activity')); expect(await screen.findByText('Lion at dawn — done in 11.2 s')).toBeTruthy(); expect(screen.getByText('Heron — model not installed')).toBeTruthy();
  });
});
