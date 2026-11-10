import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '../api/collections';
import { fakeCard, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const coll = (o: Partial<Collection> = {}): Collection => ({
  id: 'c1', name: 'Best of Kenya', description: 'A set', kind: 'MANUAL', status: 'ACTIVE', createdBy: 'USER', rationale: null, count: 5, cover: idOf(1), coverIsChosen: false, dynamic: false,
  filters: null, search: null, updatedAt: '2026-10-01T10:00:00Z', createdAt: '2026-10-01T10:00:00Z', ...o,
});
const page = (n: number) => ({ items: Array.from({ length: n }, (_, i) => fakeCard(i + 1)), total: n, nextCursor: null });
const list = (items: Collection[]): Routes => ({ 'GET /api/collections': (c) => ({ json: { items: c.query.get('status') === 'DRAFT' ? items.filter((x) => x.status === 'DRAFT') : items.filter((x) => x.status === 'ACTIVE') } }) });
const detail = (c: Collection, n = 5, extra: Routes = {}): Routes => ({ [`GET /api/collections/${c.id}`]: { json: c }, [`GET /api/collections/${c.id}/photos`]: { json: page(n) }, ...extra });
const start = (path: string, routes: Routes = {}) => { const lib = libraryRoutes(300); const calls = mockApi(signedIn({ ...lib.routes, ...routes })); renderApp(path); return calls; };
const options = () => screen.getAllByRole('option');
const ctrlClick = async (el: HTMLElement) => { const u = userEvent.setup(); await u.keyboard('{Control>}'); await u.click(el); await u.keyboard('{/Control}'); };

describe('Collections list', () => {
  it('shows each collection with its kind, count and cover; smart and saved ones say they are live', async () => {
    start('/collections', list([coll(), coll({ id: 'c2', name: 'Unposted lions', kind: 'SMART', count: 41, dynamic: true }), coll({ id: 'c3', name: 'Quetzals', kind: 'SAVED_SEARCH', count: null, cover: null, dynamic: true })]));
    expect(await screen.findByText('Best of Kenya')).toBeTruthy();
    expect(screen.getByText(/Collection · 5 photographs/)).toBeTruthy(); expect(screen.getByText(/Smart collection · 41 photographs/)).toBeTruthy(); expect(screen.getByText(/Saved search · live/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Best of Kenya/ }).getAttribute('href')).toBe('/collections/c1');
  });
  it('empty state explains how to fill one; the AI drafts tab asks the server for drafts and says nothing is active until you say so', async () => {
    const calls = start('/collections', list([]));
    expect(await screen.findByText('No collections yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'AI drafts' }));
    expect(await screen.findByText('No AI drafts')).toBeTruthy(); expect(screen.getByText(/until you say so/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/collections' && c.query.get('status') === 'DRAFT')).toBe(true);
  });
  it('New collection posts the name and opens the new collection', async () => {
    const calls = start('/collections', { ...list([]), 'POST /api/collections': { status: 201, json: { id: 'c9' } }, ...detail(coll({ id: 'c9', name: 'Fresh', count: 0 }), 0) });
    await userEvent.click(await screen.findByRole('button', { name: 'New collection' }));
    const dlg = await screen.findByRole('dialog'); await userEvent.type(within(dlg).getByLabelText('Name'), 'Fresh'); await userEvent.click(within(dlg).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ name: 'Fresh' }));
    expect(await screen.findByRole('heading', { name: 'Fresh' })).toBeTruthy();
  });
  it('a failed load shows an error with retry; no axe violations', async () => {
    start('/collections', { 'GET /api/collections': { status: 500, json: { error: 'x', message: 'x' } } });
    expect(await screen.findByText('Collections could not be loaded')).toBeTruthy();
  });
  it('has no axe violations', async () => {
    start('/collections', list([coll(), coll({ id: 'c2', name: 'Two', kind: 'SMART', dynamic: true })]));
    await screen.findByText('Best of Kenya'); expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('A manual collection', () => {
  it('lists its photographs, with count and description', async () => {
    start('/collections/c1', detail(coll()));
    expect(await screen.findByRole('heading', { name: 'Best of Kenya' })).toBeTruthy(); expect(screen.getByText('5 photographs')).toBeTruthy(); expect(screen.getByText('A set')).toBeTruthy();
    expect((await screen.findAllByRole('option')).length).toBe(5);
  });
  it('selection offers move, cover, remove; each sends exactly the selected photographs', async () => {
    const calls = start('/collections/c1', detail(coll(), 5, { 'POST /api/collections/c1/move': { json: { moved: 1 } }, 'PATCH /api/collections/c1': { json: { ok: true } }, 'DELETE /api/collections/c1/photos': { json: { removed: 1 } } }));
    await screen.findAllByRole('option'); await userEvent.click(options()[2]!);
    const bar = await screen.findByRole('toolbar', { name: 'Collection actions' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Move to end' })); await waitFor(() => expect(calls.find((c) => c.path.endsWith('/move'))?.body).toEqual({ ids: [idOf(3)], before: null }));
    await userEvent.click(within(bar).getByRole('button', { name: 'Move to start' })); await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/move')).at(-1)?.body).toEqual({ ids: [idOf(3)], before: idOf(1) }));
    await userEvent.click(within(bar).getByRole('button', { name: 'Set as cover' })); await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ coverPhotoId: idOf(3) }));
    await userEvent.click(within(bar).getByRole('button', { name: 'Remove from collection' })); await waitFor(() => expect(calls.find((c) => c.method === 'DELETE' && c.path.endsWith('/photos'))?.body).toEqual({ ids: [idOf(3)] }));
  });
  it('cover needs exactly one photograph selected', async () => {
    start('/collections/c1', detail(coll()));
    await screen.findAllByRole('option'); await userEvent.click(options()[0]!); await ctrlClick(options()[1]!);
    const bar = await screen.findByRole('toolbar', { name: 'Collection actions' });
    await waitFor(() => expect((within(bar).getByRole('button', { name: 'Set as cover' }) as HTMLButtonElement).disabled).toBe(true));
  });
  it('deleting says the photographs are untouched, and asks first', async () => {
    const calls = start('/collections/c1', detail(coll(), 5, { 'DELETE /api/collections/c1': { json: { ok: true } }, ...list([]) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dlg = await screen.findByRole('dialog'); expect(within(dlg).getByText(/photographs stay in your library/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Delete collection' })); await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/collections/c1')).toBe(true));
  });
  it('an unknown collection says so', async () => {
    start('/collections/zzz', { 'GET /api/collections/zzz': { status: 404, json: { error: 'not_found', message: 'No such collection.' } } });
    expect(await screen.findByText('Collection not found')).toBeTruthy();
  });
});

describe('A smart collection and an AI draft', () => {
  it('a smart collection is live: no remove/move/cover actions, and it explains how filters are changed', async () => {
    start('/collections/c2', detail(coll({ id: 'c2', name: 'Unposted lions', kind: 'SMART', dynamic: true, count: 5, filters: { view: 'all' } })));
    expect(await screen.findByText(/this list is live/)).toBeTruthy(); expect(screen.getByText(/follows its filters/)).toBeTruthy();
    await screen.findAllByRole('option'); await userEvent.click(options()[0]!);
    const bar = await screen.findByRole('toolbar', { name: 'Collection actions' });
    expect(within(bar).queryByRole('button', { name: 'Remove from collection' })).toBeNull(); expect(within(bar).queryByRole('button', { name: 'Move to end' })).toBeNull(); expect(within(bar).getByRole('button', { name: 'Add to another collection…' })).toBeTruthy();
  });
  it('an AI draft shows why it was proposed and waits for Activate', async () => {
    const calls = start('/collections/d1', detail(coll({ id: 'd1', name: 'Dawn light', status: 'DRAFT', kind: 'AI_DRAFT', createdBy: 'AI', rationale: 'Taken within an hour of sunrise' }), 3, { 'POST /api/collections/d1/activate': { json: { ok: true } } }));
    expect(await screen.findByText(/Taken within an hour of sunrise/)).toBeTruthy(); expect(screen.getByText(/proposed by AI/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Activate' })); await waitFor(() => expect(calls.some((c) => c.path.endsWith('/activate'))).toBe(true));
  });
});

describe('Add to collection from the Library', () => {
  it('chooses an existing collection and sends the selected photographs; reports what was already there', async () => {
    const calls = start('/library', { ...list([coll(), coll({ id: 'c2', name: 'Smart', kind: 'SMART', dynamic: true })]), 'POST /api/collections/c1/photos': { json: { added: 1, alreadyIn: 0 } } });
    await screen.findAllByRole('option'); await userEvent.click(options()[1]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Add to collection…' }));
    const dlg = await screen.findByRole('dialog'); expect(await within(dlg).findByRole('radio', { name: /Best of Kenya/ })).toBeTruthy(); expect(within(dlg).queryByRole('radio', { name: /Smart/ })).toBeNull();   // only manual collections take photographs
    await userEvent.click(within(dlg).getByRole('radio', { name: /Best of Kenya/ })); await userEvent.click(within(dlg).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/collections/c1/photos')?.body).toEqual({ target: { ids: [idOf(1)] } }));
  });
  it('creates a new collection when a name is typed instead', async () => {
    const calls = start('/library', { ...list([]), 'POST /api/collections': { status: 201, json: { id: 'c7' } }, 'POST /api/collections/c7/photos': { json: { added: 1, alreadyIn: 0 } } });
    await screen.findAllByRole('option'); await userEvent.click(options()[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Add to collection…' }));
    const dlg = await screen.findByRole('dialog'); await userEvent.type(within(dlg).getByLabelText('Or create a new collection'), 'Brand new'); await userEvent.click(within(dlg).getByRole('button', { name: 'Create and add' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/collections/c7/photos')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/collections')?.body).toMatchObject({ name: 'Brand new' });
  });
  it('select-all-matching sends the filter, not 300 ids', async () => {
    const calls = start('/library?rating=5', { ...list([coll()]), 'POST /api/collections/c1/photos': { json: { added: 300, alreadyIn: 0 } } });
    await screen.findAllByRole('option'); await userEvent.click(screen.getByRole('button', { name: /^Select all 300/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add to collection…' }));
    const dlg = await screen.findByRole('dialog'); await userEvent.click(await within(dlg).findByRole('radio', { name: /Best of Kenya/ })); await userEvent.click(within(dlg).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/photos'))?.body).toMatchObject({ target: { query: { view: 'all', rating: [5] }, exclude: [] } }));
  });
  it('saves the current filters as a smart collection', async () => {
    const calls = start('/library?rating=5&year=2025', { ...list([]), 'POST /api/collections': { status: 201, json: { id: 'c8' } }, ...detail(coll({ id: 'c8', name: 'Top 2025', kind: 'SMART', dynamic: true })) });
    await userEvent.click(await screen.findByRole('button', { name: 'Save as smart collection…' }));
    const dlg = await screen.findByRole('dialog'); await userEvent.type(within(dlg).getByLabelText('Name'), 'Top 2025'); await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/collections')?.body).toMatchObject({ name: 'Top 2025', kind: 'SMART', filters: { view: 'all', rating: [5], year: [2025] } }));
  });
});
