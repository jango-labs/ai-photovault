import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeCard, fakeDetail, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const SEM = { available: false, reason: 'Only the local picture-to-picture model is installed.' };
const result = (n: number, o: Record<string, unknown> = {}) => ({
  items: Array.from({ length: n }, (_, i) => fakeCard(i + 1)), total: n, nextOffset: null, relaxed: false,
  parsed: { text: '', understood: [{ kind: 'species', label: 'Lion' }, { kind: 'location', label: 'Kenya' }, { kind: 'year', label: '2024' }, { kind: 'instagram', label: 'never posted' }], filters: {} }, semantic: SEM, ...o,
});
const home = (extra: Routes = {}): Routes => ({
  'GET /api/search/saved': { json: { items: [{ id: 's1', name: 'Unposted lions', q: 'lions never posted', exclude: [], createdAt: '2026-10-01T10:00:00Z' }] } },
  'GET /api/search/history': { json: { items: [{ id: 'h1', q: 'leopards 2023', resultCount: 41, at: '2026-10-08T10:00:00Z' }] } },
  'GET /api/search/discover': { json: { species: [{ name: 'Lion', n: 120 }], places: [{ name: 'Kenya', n: 400 }], years: [{ year: 2024, n: 900 }], tags: [{ name: 'warm tones', n: 50 }], examples: ['lion in Kenya never posted'] } },
  ...extra,
});
const start = (path: string, extra: Routes = {}) => { const lib = libraryRoutes(300, {}); const calls = mockApi(signedIn({ ...lib.routes, ...home(), ...extra })); renderApp(path); return calls; };

describe('Search workspace', () => {
  it('before a query: saved searches, recent searches, and what the library contains', async () => {
    start('/search');
    expect(await screen.findByRole('button', { name: 'Unposted lions' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'leopards 2023' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^Lion/ })).toBeTruthy(); expect(await screen.findByRole('button', { name: /^Kenya/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'lion in Kenya never posted' })).toBeTruthy();
  });

  it('a search shows what it understood, as removable phrases, and the result count', async () => {
    const calls = start('/search?q=lions%20in%20Kenya%202024', { 'GET /api/search': { json: result(7) } });
    const group = await screen.findByRole('group', { name: 'Understood as' });
    for (const t of ['Lion', 'Kenya', '2024', 'never posted']) expect(within(group).getByText(t)).toBeTruthy();
    expect(await screen.findByText(/7 photographs/)).toBeTruthy();
    const call = calls.find((c) => c.path === '/api/search')!; expect(call.query.get('q')).toBe('lions in Kenya 2024'); expect(call.query.get('record')).toBe('true');
  });

  it('removing a phrase searches again without it', async () => {
    const calls = start('/search?q=lions%20in%20Kenya', { 'GET /api/search': (c) => ({ json: result(c.query.getAll('exclude').length ? 12 : 3) }) });
    const group = await screen.findByRole('group', { name: 'Understood as' });
    await userEvent.click(within(group).getByRole('button', { name: /Remove filter YEAR/i }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/search' && c.query.getAll('exclude').includes('year:2024'))).toBe(true));
    expect(await screen.findByText(/12 photographs/)).toBeTruthy();
  });

  it('says so when the words had to be relaxed, and says that it does not search by meaning', async () => {
    start('/search?q=pangolin%20quokka', { 'GET /api/search': { json: result(2, { relaxed: true, parsed: { text: 'pangolin quokka', understood: [], filters: {} } }) } });
    expect(await screen.findByText(/matching any of them are shown/i)).toBeTruthy();
    expect(screen.getByText(/not by meaning/i)).toBeTruthy();
  });

  it('no results is explained, not blank', async () => {
    start('/search?q=zzz', { 'GET /api/search': { json: result(0, { items: [], total: 0 }) } });
    expect(await screen.findByText('No photographs match')).toBeTruthy();
  });

  it('a failed search shows an error with retry and changes nothing', async () => {
    start('/search?q=lions', { 'GET /api/search': { status: 500, json: { error: 'boom', message: 'Something went wrong.' } } });
    expect(await screen.findByText('The search could not be run')).toBeTruthy(); expect(screen.getByRole('button', { name: /retry|try again/i })).toBeTruthy();
  });

  it('Save search asks for a name and stores the query, not the results', async () => {
    const calls = start('/search?q=lions%20in%20Kenya', { 'GET /api/search': { json: result(3) }, 'POST /api/search/saved': { status: 201, json: { id: 's2' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Save search' }));
    const dlg = await screen.findByRole('dialog'); const name = within(dlg).getByLabelText('Name'); await userEvent.clear(name); await userEvent.type(name, 'Kenya lions');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/search/saved')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Kenya lions', q: 'lions in Kenya', exclude: [] });
  });

  it('similar mode explains the ordering; photographs not yet indexed offer to index', async () => {
    start(`/search?similar=${idOf(1)}`, { [`GET /api/search/similar/${idOf(1)}`]: { json: { model: 'local-visual-v1', items: [fakeCard(2), fakeCard(3)].map((c, i) => ({ ...c, similarity: 0.99 - i / 10 })) } }, [`GET /api/library/photos/${idOf(1)}`]: { json: fakeDetail(1) } });
    expect(await screen.findByText(/look most like/i)).toBeTruthy();
    expect(await screen.findAllByRole('option')).toHaveLength(2);
  });
  it('not indexed → explanation and an Index now button', async () => {
    const calls = start(`/search?similar=${idOf(1)}`, { [`GET /api/search/similar/${idOf(1)}`]: { status: 409, json: { error: 'not_embedded', message: 'not yet' } }, [`GET /api/library/photos/${idOf(1)}`]: { json: fakeDetail(1) }, 'POST /api/search/reindex': { json: { indexed: 10, embeddingsQueued: 4 } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Index now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/search/reindex')).toBe(true));
  });

  it('the top-bar search opens the search workspace with the query in the URL', async () => {
    const calls = start('/library', { 'GET /api/search': { json: result(2) } });
    const box = await screen.findByRole('searchbox', { name: 'Search the library' }); await userEvent.type(box, 'eagles{Enter}');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/search' && c.query.get('q') === 'eagles')).toBe(true));
  });

  it('has no axe violations (home and results)', async () => {
    start('/search?q=lions', { 'GET /api/search': { json: result(5) } });
    await screen.findByRole('group', { name: 'Understood as' });
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
