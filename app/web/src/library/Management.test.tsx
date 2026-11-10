import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditRow, PairView, VersionRow } from '../api/library';
import { fakeCard, fakeDetail, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const edit = (o: Partial<EditRow>): EditRow => ({ id: 'e1', photoId: idOf(1), batchId: 'b', field: 'title', oldValue: 'IMG_0001', newValue: 'Lion at dawn', oldSource: 'FOLDER_DERIVED', newSource: 'USER_DEFINED', kind: 'EDIT', revertsId: null, editedAt: '2026-10-08T10:00:00.000Z', undone: false, ...o });
const version = (n: number, o: Partial<VersionRow> = {}): VersionRow => ({ id: `ver-${n}`, versionNo: n, state: n === 2 ? 'ACTIVE' : 'SUPERSEDED', relativePath: `2025/Kenya/img_${n}.jpg`, sourcePresent: true, width: 6000, height: 4000, bytes: 9_000_000, importedAt: '2026-09-01T10:00:00.000Z', exportedAt: null, sha256Prefix: 'abcdef012345', derivStatus: 'READY', current: n === 2, ...o });
const pair = (state: PairView['state'] = 'OPEN', distance = 2): PairView => ({ id: 'pair-1', distance, state, detectedAt: '2026-10-08T10:00:00.000Z', a: fakeCard(1), b: fakeCard(2) });
const viewer = (extra: Routes = {}) => ({ ...Object.fromEntries([1, 2].map((n) => [`GET /api/library/photos/${idOf(n)}`, { json: fakeDetail(n) }])), ...extra });
const open = async (extra: Routes = {}) => {
  const lib = libraryRoutes(300, viewer(extra)); const calls = mockApi(signedIn(lib.routes)); renderApp(`/library?photo=${idOf(1)}`);
  return { calls, dlg: await screen.findByRole('dialog') };
};

describe('editing a photograph’s details (viewer → Information)', () => {
  it('shows each value with where it came from', async () => {
    const { dlg } = await open({ [`GET /api/library/photos/${idOf(1)}`]: { json: { ...fakeDetail(1), description: 'A pride at rest.', descriptionSource: 'USER_DEFINED', titleSource: 'USER_DEFINED' } } });
    const details = (await within(dlg).findByText('Details')).closest('section')!;
    expect(await within(details).findByText('A pride at rest.')).toBeTruthy();
    expect(within(details).getAllByText('You').length).toBeGreaterThanOrEqual(2);
    expect(within(details).getByText('Folder')).toBeTruthy();                         // the location is folder-derived
    expect(within(details).getByText('EXIF')).toBeTruthy();                           // the capture date
  });
  it('Edit details → change → Save sends only a patch of what the form says, then reloads', async () => {
    const { calls, dlg } = await open({ [`PATCH /api/library/photos/${idOf(1)}/metadata`]: { json: { status: 'ok', changed: ['title', 'trip_location'], batchId: 'b' } } });
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Edit details' }));
    const title = within(dlg).getByLabelText('Title'); await userEvent.clear(title); await userEvent.type(title, 'Lion at dawn');
    const loc = within(dlg).getByLabelText('Location'); await userEvent.clear(loc); await userEvent.type(loc, 'Masai Mara');
    await userEvent.type(within(dlg).getByLabelText('Description'), 'Soft light.');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/metadata'))).toBeTruthy());
    const body = calls.find((c) => c.path.endsWith('/metadata'))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Lion at dawn', location: 'Masai Mara', description: 'Soft light.', });
    expect(body).not.toHaveProperty('gps');                                             // nothing typed, nothing sent
    expect(body).not.toHaveProperty('notes');                                           // untouched fields are not sent
    expect(body).not.toHaveProperty('captureAt');                                       // (so a capture time's seconds cannot be rewritten by accident)
    await waitFor(() => expect(within(dlg).queryByRole('button', { name: 'Save' })).toBeNull());
  });
  it('saving without changing anything sends nothing', async () => {
    const { calls, dlg } = await open();
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Edit details' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(dlg).queryByRole('button', { name: 'Save' })).toBeNull());
    expect(calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/metadata'))).toBe(false);
  });
  it('refuses impossible coordinates before sending anything', async () => {
    const { calls, dlg } = await open();
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Edit details' }));
    await userEvent.type(within(dlg).getByLabelText('Latitude'), '95'); await userEvent.type(within(dlg).getByLabelText('Longitude'), '10');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(await within(dlg).findByRole('alert')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/metadata'))).toBe(false);
  });
  it('cancel discards; the form is reachable by keyboard and has no axe violations', async () => {
    const { dlg } = await open();
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Edit details' }));
    expect(await axe(dlg)).toHaveNoViolations();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(within(dlg).getByRole('button', { name: 'Edit details' })).toBeTruthy();
  });
});

describe('history, versions and similar photographs', () => {
  it('lists edits with old → new and provenance and undoes one', async () => {
    const { calls, dlg } = await open({
      [`GET /api/library/photos/${idOf(1)}/history`]: { json: { edits: [edit({}), edit({ id: 'e0', field: 'trip_location', oldValue: null, newValue: 'Kenya', oldSource: null, kind: 'BULK' }), edit({ id: 'eu', kind: 'UNDO', revertsId: 'e9' }), edit({ id: 'e8', undone: true })] } },
      [`POST /api/library/photos/${idOf(1)}/history/e1/undo`]: { json: { ok: true } },
    });
    const hist = (await within(dlg).findByText('Edit history')).closest('section')!;
    expect((await within(hist).findAllByText('Lion at dawn')).length).toBeGreaterThan(0); expect(within(hist).getAllByText('IMG_0001').length).toBeGreaterThan(0);
    expect(within(hist).getByText('bulk edit')).toBeTruthy(); expect(within(hist).getAllByText('undone').length).toBe(1);
    const undos = within(hist).getAllByRole('button', { name: /Undo the/ });
    expect(undos).toHaveLength(2);                                                      // not on the undo row, not on the already-undone row
    await userEvent.click(undos[0]!);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/undo'))).toBeTruthy());
  });
  it('an undo that conflicts with newer work is explained, not forced', async () => {
    const { dlg } = await open({
      [`GET /api/library/photos/${idOf(1)}/history`]: { json: { edits: [edit({})] } },
      [`POST /api/library/photos/${idOf(1)}/history/e1/undo`]: { status: 409, json: { error: 'conflict', message: 'This value has changed since that edit, so it cannot be undone safely.' } },
    });
    await userEvent.click(await within(dlg).findByRole('button', { name: /Undo the title change/ }));
    expect(await screen.findByText(/cannot be undone safely/)).toBeTruthy();
  });
  it('shows versions and makes an earlier one current', async () => {
    const { calls, dlg } = await open({
      [`GET /api/library/photos/${idOf(1)}/versions`]: { json: { versions: [version(2), version(1)] } },
      [`POST /api/library/photos/${idOf(1)}/versions/ver-1/restore`]: { json: { ok: true, changed: true } },
    });
    const sec = (await within(dlg).findByText('Versions')).closest('section')!;
    expect(await within(sec).findByText('Version 2')).toBeTruthy(); expect(within(sec).getByText('Current')).toBeTruthy();
    expect(within(sec).getAllByRole('button', { name: /Make version/ })).toHaveLength(1);
    await userEvent.click(within(sec).getByRole('button', { name: 'Make version 1 current' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/versions/ver-1/restore'))).toBeTruthy());
  });
  it('lists near-duplicates with a Compare link and "Not a duplicate"', async () => {
    const { calls, dlg } = await open({
      [`GET /api/library/photos/${idOf(1)}/duplicates`]: { json: { pairs: [{ ...pair(), other: fakeCard(2) }] } },
      'POST /api/library/duplicates/pair-1': { json: { ok: true } },
    });
    const sec = (await within(dlg).findByText('Similar photographs')).closest('section')!;
    expect(await within(sec).findByText('2 bits apart · to review')).toBeTruthy();
    expect(within(sec).getByRole('link', { name: 'Compare' }).getAttribute('href')).toBe(`/library/compare?ids=${idOf(1)},${idOf(2)}`);
    await userEvent.click(within(sec).getByRole('button', { name: 'Not a duplicate' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/library/duplicates/pair-1')?.body).toEqual({ state: 'DISTINCT' }));
  });
});

describe('Compare page', () => {
  it('shows 2–4 photographs side by side and highlights the facts that differ', async () => {
    const a = fakeDetail(1), b = { ...fakeDetail(2), width: 4000, height: 6000, orientation: 'portrait' as const, bytes: 5_000_000, id: idOf(2), title: 'Photograph 2' };
    mockApi(signedIn({ 'GET /api/library/compare': { json: { photos: [a, b], cards: [] } } })); renderApp(`/library/compare?ids=${idOf(1)},${idOf(2)}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Compare' })).toBeTruthy();
    expect(await screen.findAllByRole('img')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Differences' });
    const row = (label: string) => within(table).getByRole('row', { name: new RegExp(label) });
    expect(within(row('Dimensions')).getAllByRole('cell').every((c) => c.getAttribute('data-diff') === 'true')).toBe(true);
    expect(within(row('Camera')).getAllByRole('cell').every((c) => c.getAttribute('data-diff') === null)).toBe(true);     // same camera: not highlighted
    expect(screen.getAllByRole('img').some((i) => i.getAttribute('src') === `/api/library/photos/${idOf(2)}/image?size=view`)).toBe(true);
  });
  it('needs at least two photographs', async () => {
    mockApi(signedIn()); renderApp(`/library/compare?ids=${idOf(1)}`);
    expect(await screen.findByRole('heading', { name: 'Choose two to four photographs' })).toBeTruthy();
  });
  it('compare is offered from the bulk bar only for 2–4 selected photographs', async () => {
    const lib = libraryRoutes(300); mockApi(signedIn(lib.routes)); renderApp('/library');
    const grid = await screen.findByRole('listbox'); const opts = await screen.findAllByRole('option');
    await userEvent.click(opts[0]!);
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    expect((within(bar).getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled).toBe(true);
    const u = userEvent.setup(); await u.keyboard('{Control>}'); await u.click(opts[1]!); await u.keyboard('{/Control}');
    await waitFor(() => expect((within(bar).getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled).toBe(false));
    void grid;
  });
});

describe('Duplicates page', () => {
  const list = (items: PairView[], total = items.length) => ({ json: { items, total, nextCursor: null } });
  it('lists pairs most-similar first with the decision buttons and sends the decision', async () => {
    const calls = mockApi(signedIn({ 'GET /api/library/duplicates': list([pair('OPEN', 0), { ...pair('OPEN', 5), id: 'pair-2' }]), 'POST /api/library/duplicates/pair-1': { json: { ok: true } } }));
    renderApp('/library/duplicates');
    expect(await screen.findByRole('heading', { level: 1, name: 'Duplicates' })).toBeTruthy();
    const pairs = await screen.findAllByRole('article');
    expect(pairs).toHaveLength(2); expect(within(pairs[0]!).getByText('identical image')).toBeTruthy(); expect(within(pairs[1]!).getByText('similar (5 bits apart)')).toBeTruthy();
    expect(screen.getByText('2 pairs')).toBeTruthy();
    await userEvent.click(within(pairs[0]!).getByRole('button', { name: 'Mark as duplicate' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/library/duplicates/pair-1')?.body).toEqual({ state: 'DUPLICATE' }));
    expect(await axe(pairs[0]!)).toHaveNoViolations();
  });
  it('scan runs on request and reports; switching tabs asks for that state', async () => {
    const calls = mockApi(signedIn({ 'GET /api/library/duplicates': list([]), 'POST /api/library/duplicates/scan': { json: { found: 3, open: 3 } } }));
    renderApp('/library/duplicates');
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scan the library' }));
    expect(await screen.findByText('3 new similar pairs found')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Not duplicates' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/library/duplicates').some((c) => c.query.get('state') === 'DISTINCT')).toBe(true));
  });
  it('an unreachable server shows an understandable error', async () => {
    mockApi(signedIn({ 'GET /api/library/duplicates': { status: 500, json: { error: 'internal_error', message: 'x' } } })); renderApp('/library/duplicates');
    expect(await screen.findByRole('heading', { name: 'Pairs could not be loaded' })).toBeTruthy();
  });
});

describe('hidden photographs, near-duplicate filter and bulk location', () => {
  it('Filters → Other offers “Hidden photographs only” and “Possible near-duplicates” as server filters', async () => {
    const lib = libraryRoutes(300); const calls = mockApi(signedIn(lib.routes)); renderApp('/library');
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByRole('button', { name: /Filters/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    await userEvent.click(await within(panel).findByRole('button', { name: /^Possible near-duplicates/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Hidden photographs only' }));
    await waitFor(() => { const q = [...calls].reverse().find((c) => c.path === '/api/library/photos')!.query; expect(q.getAll('dup')).toEqual(['open']); expect(q.get('hidden')).toBe('true'); });
  });
  it('Hide and Set location… are bulk actions: hide by id, location through its own endpoint with a confirmation dialog', async () => {
    const lib = libraryRoutes(300, { 'POST /api/library/photos/bulk': { json: { updated: 1 } }, 'POST /api/library/photos/bulk-location': { json: { updated: 1 } } });
    const calls = mockApi(signedIn(lib.routes)); renderApp('/library');
    await screen.findByRole('listbox'); await userEvent.click((await screen.findAllByRole('option'))[0]!);
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/library/photos/bulk')?.body).toMatchObject({ target: { ids: [idOf(0)] }, set: { hidden: true } }));
    await userEvent.click(within(bar).getByRole('button', { name: 'Set location…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Set the location of 1 photograph' });
    await userEvent.type(within(dlg).getByLabelText('Location'), 'Okavango');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Set location' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/library/photos/bulk-location')?.body).toEqual({ target: { ids: [idOf(0)] }, location: 'Okavango' }));
    expect(await screen.findByText('Location set on 1 photograph')).toBeTruthy();
  });
});
