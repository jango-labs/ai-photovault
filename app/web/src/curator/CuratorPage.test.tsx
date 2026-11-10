import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CuratorRun } from '../api/curator';
import { fakeCard, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const run = (o: Partial<CuratorRun> = {}): CuratorRun => ({
  id: 'r1', createdAt: '2026-10-09T10:00:00Z', request: 'best lion photos never posted', purpose: 'general', count: 12,
  understood: [{ kind: 'rating', label: '4–5 stars' }, { kind: 'species', label: 'Lion' }, { kind: 'instagram', label: 'never posted' }], words: '', assumed: [],
  pool: { matching: 143, examined: 143 }, skipped: { disliked: 1, series: 2, alreadyInPortfolio: 0 },
  picks: [
    { id: idOf(1), rank: 1, score: 0.93, baseScore: 0.93, reasons: [{ factor: 'rating', effect: 'plus', text: 'You rated it 5 stars' }, { factor: 'quality', effect: 'plus', text: 'Measured quality 0.9' }, { factor: 'series', effect: 'info', text: 'Best of 3 similar frames' }], hidden: [idOf(9), idOf(10)], seriesSize: 3 },
    { id: idOf(2), rank: 2, score: 0.71, baseScore: 0.83, reasons: [{ factor: 'rating', effect: 'plus', text: 'You rated it 4 stars' }, { factor: 'variety', effect: 'minus', text: 'Variety: 1 other Lion photograph already chosen' }], hidden: [], seriesSize: 1 },
  ],
  alternatives: [{ id: idOf(3), score: 0.6, reasons: [{ factor: 'rating', effect: 'info', text: 'You rated it 3 stars' }] }],
  cards: Object.fromEntries([1, 2, 3, 9, 10].map((n) => [idOf(n), fakeCard(n)])), ...o,
});
const base = (extra: Routes = {}): Routes => ({
  'GET /api/curator/themes': { json: { items: [{ title: 'Lion in Kenya', request: 'Lion in Kenya 4+ stars never posted', count: 14 }] } },
  'GET /api/curator/runs': { json: { items: [{ id: 'r1', request: 'best lion photos never posted', purpose: 'general', count: 12, picks: 2, createdAt: '2026-10-09T10:00:00Z' }] } },
  'GET /api/curator/feedback': { json: { liked: [], disliked: [] } }, ...extra,
});
const start = (path: string, extra: Routes = {}) => { const lib = libraryRoutes(30); const calls = mockApi(signedIn({ ...lib.routes, ...base(extra) })); renderApp(path); return calls; };

describe('AI Curator workspace', () => {
  it('says plainly that it only advises, and offers ideas drawn from the library and earlier selections', async () => {
    start('/curator');
    expect(await screen.findByText(/only advises: it never edits, publishes or schedules/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Lion in Kenya/ })).toBeTruthy(); expect(await screen.findByRole('link', { name: 'best lion photos never posted' })).toBeTruthy();
  });

  it('asking sends the request, count and purpose, then shows the selection with its reasons', async () => {
    const calls = start('/curator', { 'POST /api/curator/run': { json: run() }, 'GET /api/curator/runs/r1': { json: run() } });
    await userEvent.type(await screen.findByLabelText('What should I look for?'), 'best lion photos never posted');
    await userEvent.click(screen.getByRole('radio', { name: 'For Instagram' })); await userEvent.click(screen.getByRole('button', { name: 'Suggest a selection' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/curator/run')?.body).toEqual({ request: 'best lion photos never posted', count: 12, purpose: 'instagram' }));
    const list = await screen.findByRole('list', { name: 'Suggested photographs' });
    expect(within(list).getAllByRole('button', { name: 'Leave out' })).toHaveLength(2);
    expect(within(list).getByText('You rated it 5 stars')).toBeTruthy(); expect(within(list).getByText('Best of 3 similar frames')).toBeTruthy(); expect(within(list).getByText(/Variety: 1 other Lion/)).toBeTruthy();
    expect(screen.getByText(/Chose 2 of 143 matching photographs/)).toBeTruthy(); expect(screen.getByText(/2 near-identical frames grouped/)).toBeTruthy(); expect(screen.getByText(/1 you marked “not this” was left out/)).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Understood as' }); expect(within(group).getByText('Lion')).toBeTruthy();
  });

  it('assumptions made for a purpose are stated', async () => {
    start('/curator?run=r1', { 'GET /api/curator/runs/r1': { json: run({ purpose: 'instagram', assumed: ['Instagram selection: only photographs never posted'] }) } });
    expect(await screen.findByText(/Assumed: Instagram selection: only photographs never posted\./)).toBeTruthy();
  });

  it('“Not this” records feedback and drops the photograph; “Leave out” only changes this selection; both can be undone', async () => {
    const calls = start('/curator?run=r1', { 'GET /api/curator/runs/r1': { json: run() }, 'POST /api/curator/feedback': { json: { ok: true } } });
    const list = await screen.findByRole('list', { name: 'Suggested photographs' });
    await userEvent.click(within(list).getAllByRole('button', { name: 'Not this' })[0]!);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/curator/feedback')?.body).toEqual({ photoId: idOf(1), verdict: 'DISLIKE', runId: 'r1' }));
    await waitFor(() => expect(screen.getByText('1 in your selection')).toBeTruthy());
    await userEvent.click(within(screen.getByRole('list', { name: 'Suggested photographs' })).getByRole('button', { name: 'Leave out' }));
    expect(await screen.findByText('0 in your selection')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/curator/feedback')).toHaveLength(1);              // leaving out is local, not feedback
    await userEvent.click((await screen.findAllByRole('button', { name: /Put back/ }))[0]!); expect(await screen.findByText('1 in your selection')).toBeTruthy();
  });

  it('Like toggles; an alternative can be added to the selection', async () => {
    const calls = start('/curator?run=r1', { 'GET /api/curator/runs/r1': { json: run() }, 'POST /api/curator/feedback': { json: { ok: true } } });
    const list = await screen.findByRole('list', { name: 'Suggested photographs' });
    await userEvent.click(within(list).getAllByRole('button', { name: 'Like' })[0]!);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/curator/feedback')?.body).toMatchObject({ photoId: idOf(1), verdict: 'LIKE' }));
    const alts = await screen.findByRole('region', { name: 'Also considered' }); await userEvent.click(within(alts).getByRole('button', { name: 'Add to selection' }));
    expect(await screen.findByText('3 in your selection')).toBeTruthy();
  });

  it('a series can be expanded to see the frames behind the pick', async () => {
    start('/curator?run=r1', { 'GET /api/curator/runs/r1': { json: run() } });
    await userEvent.click(await screen.findByRole('button', { name: '2 similar frames' }));
    expect(await screen.findByLabelText('Similar frames in this series')).toBeTruthy();
  });

  it('Save as AI draft sends exactly the current selection, says nothing is published, and links to the drafts', async () => {
    const calls = start('/curator?run=r1', { 'GET /api/curator/runs/r1': { json: run() }, 'POST /api/curator/runs/r1/draft': { status: 201, json: { id: 'c9', name: 'Curator: best lion photos never posted' } } });
    const list = await screen.findByRole('list', { name: 'Suggested photographs' });
    await userEvent.click(within(list).getAllByRole('button', { name: 'Leave out' })[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Save as AI draft collection' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/curator/runs/r1/draft')?.body).toEqual({ photoIds: [idOf(1)] }));
    expect(await screen.findByText(/Nothing was published or scheduled/)).toBeTruthy();
  });

  it('no match: an honest empty state (never an invented selection)', async () => {
    start('/curator?run=r1', { 'GET /api/curator/runs/r1': { json: run({ picks: [], alternatives: [], cards: {}, pool: { matching: 0, examined: 0 } }) } });
    expect(await screen.findByText('Nothing to suggest')).toBeTruthy();
  });
  it('a run that no longer exists says so', async () => {
    start('/curator?run=gone', { 'GET /api/curator/runs/gone': { status: 404, json: { error: 'not_found', message: 'No such run.' } } });
    expect(await screen.findByText('That selection could not be loaded')).toBeTruthy();
  });
  it('has no axe violations', async () => {
    start('/curator?run=r1', { 'GET /api/curator/runs/r1': { json: run() } });
    await screen.findByRole('list', { name: 'Suggested photographs' }); expect(await axe(document.body)).toHaveNoViolations();
  });
});
