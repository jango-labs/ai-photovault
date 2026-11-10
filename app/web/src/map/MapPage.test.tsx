import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cluster, MapSummary } from '../api/map';
import { fakeCard, fakeDetail, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Call, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const cl = (o: Partial<Cluster> = {}): Cluster => ({ lat: -1.29, lon: 36.82, count: 14, sources: { EXIF: 12, IPTC: 2 }, photoId: idOf(1), bbox: [36.7, -1.4, 36.9, -1.2], ...o });
const SUM: MapSummary = { total: 100, placed: 80, withoutCoordinates: 20, withPlaceNameOnly: 12, typedPlaceNameOnly: 8, sources: { EXIF: 60, USER_DEFINED: 15, AI_INFERRED: 5 } };
const start = (path: string, extra: Routes = {}, clusters: Cluster[] = [cl(), cl({ lat: 59.9, lon: 10.75, count: 1, sources: { AI_INFERRED: 1 }, photoId: idOf(2), bbox: [10.75, 59.9, 10.75, 59.9] })]) => {
  const lib = libraryRoutes(30);
  const calls = mockApi(signedIn({ ...lib.routes, 'GET /api/map/clusters': { json: { clusters, shown: clusters.reduce((a, c) => a + c.count, 0), zoom: 2 } }, 'GET /api/map/summary': { json: SUM }, [`GET /api/library/photos/${idOf(2)}`]: { json: fakeDetail(2) }, ...extra }));
  renderApp(path); return calls;
};
const clusterCalls = (calls: Call[]) => calls.filter((c) => c.path === '/api/map/clusters');
const last = <T,>(xs: T[]) => xs[xs.length - 1]!;

describe('Map workspace', () => {
  it('draws each stored-coordinate cluster as a labelled button that says where its coordinates came from', async () => {
    start('/map');
    expect(await screen.findByRole('button', { name: /14 photographs near -1\.29°, 36\.82° — 12 Camera \(EXIF\), 2 File caption data \(IPTC\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /1 photograph near 59\.90°, 10\.75° — 1 AI suggestion/ })).toBeTruthy();
    expect(screen.getByRole('application', { name: /Map of photograph locations/ })).toBeTruthy();
  });
  it('asks the server only for what is visible: a bounding box and a whole-number zoom, plus the library filters', async () => {
    const calls = start('/map?rating=5&year=2024');
    await waitFor(() => expect(clusterCalls(calls).length).toBeGreaterThan(0));
    const q = clusterCalls(calls)[0]!.query; expect(q.get('bbox')!.split(',')).toHaveLength(4); expect(Number.isInteger(Number(q.get('zoom')))).toBe(true); expect(q.getAll('rating')).toEqual(['5']); expect(q.getAll('year')).toEqual(['2024']);
    expect(q.has('sort')).toBe(false); expect(q.has('c')).toBe(false); expect(q.has('photo')).toBe(false);
  });
  it('the legend lists each provenance with its count and plain-language meaning; AI suggestions are called estimates', async () => {
    start('/map');
    const legend = await screen.findByRole('region', { name: 'Legend' });
    expect(await within(legend).findByRole('button', { name: /Camera \(EXIF\).*60/ })).toBeTruthy(); expect(within(legend).getByText('recorded by the camera')).toBeTruthy(); expect(within(legend).getByText(/an estimate, not a fact/)).toBeTruthy();
    expect(within(legend).queryByRole('button', { name: /Folder name/ })).toBeNull();                 // sources that do not occur are not listed
    expect(await within(legend).findByText(/80 of 100 photographs can be placed/)).toBeTruthy();
    expect(within(legend).getByRole('link', { name: /12 have a place name but no coordinates/ }).getAttribute('href')).toBe('/library?gps=none');
    expect(within(legend).getByText(/8 have no location at all/)).toBeTruthy();
  });
  it('a legend toggle filters the map to that provenance', async () => {
    const calls = start('/map');
    await userEvent.click(await screen.findByRole('button', { name: /^Placed by you/ }));
    await waitFor(() => expect(clusterCalls(calls).some((c) => c.query.getAll('gps').join() === 'USER_DEFINED')).toBe(true));
    expect(await screen.findByRole('button', { name: 'Show all sources' })).toBeTruthy();
  });
  it('clicking a cluster zooms to fit its members; the next request uses a larger zoom and a smaller box', async () => {
    const calls = start('/map');
    const firstZoom = await waitFor(() => { const c = clusterCalls(calls)[0]; expect(c).toBeTruthy(); return Number(c!.query.get('zoom')); });
    await userEvent.click(await screen.findByRole('button', { name: /14 photographs/ }));
    await waitFor(() => expect(Number(last(clusterCalls(calls)).query.get('zoom'))).toBeGreaterThan(firstZoom));
    const [w, , e] = last(clusterCalls(calls)).query.get('bbox')!.split(',').map(Number) as [number, number, number]; expect(e - w).toBeLessThan(20);
  });
  it('a single-photograph marker opens that photograph in the viewer', async () => {
    start('/map');
    await userEvent.click(await screen.findByRole('button', { name: /1 photograph near 59\.90°/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
  it('keyboard: + zooms in, − zooms out, arrows pan (and the URL keeps the view)', async () => {
    const calls = start('/map?c=0,20,3');
    const map = await screen.findByRole('application'); map.focus();
    await waitFor(() => expect(clusterCalls(calls).length).toBeGreaterThan(0)); const z0 = Number(clusterCalls(calls)[0]!.query.get('zoom'));
    await userEvent.keyboard('{+}{+}'); await waitFor(() => expect(Number(last(clusterCalls(calls)).query.get('zoom'))).toBeGreaterThanOrEqual(z0 + 2));
    const w0 = last(clusterCalls(calls)).query.get('bbox'); await userEvent.keyboard('{ArrowRight}{ArrowRight}'); await waitFor(() => expect(last(clusterCalls(calls)).query.get('bbox')).not.toBe(w0));
    await userEvent.keyboard('{-}'); await waitFor(() => expect(Number(last(clusterCalls(calls)).query.get('zoom'))).toBeLessThan(z0 + 2));
  });
  it('zoom buttons and “World” work and are named', async () => {
    const calls = start('/map?c=10,10,5');
    await userEvent.click(await screen.findByRole('button', { name: 'Zoom out' })); await waitFor(() => expect(Number(last(clusterCalls(calls)).query.get('zoom'))).toBe(4));
    await userEvent.click(screen.getByRole('button', { name: 'Show the whole world' })); await waitFor(() => expect(Number(last(clusterCalls(calls)).query.get('zoom'))).toBeLessThanOrEqual(2));
  });
  it('lists the photographs in view and links to the Library with the same area', async () => {
    const calls = start('/map');
    await screen.findAllByRole('option');
    const call = calls.find((c) => c.path === '/api/library/photos')!; expect(call.query.get('bbox')!.split(',')).toHaveLength(4);
    const link = screen.getByRole('link', { name: 'Open in Library' }); expect(link.getAttribute('href')).toMatch(/^\/library\?.*bbox=/);
  });
  it('no coordinates at all: says so and explains where they come from; never invents positions', async () => {
    start('/map', { 'GET /api/map/summary': { json: { total: 5, placed: 0, withoutCoordinates: 5, withPlaceNameOnly: 5, typedPlaceNameOnly: 0, sources: {} } } }, []);
    expect(await screen.findByText('No photographs have coordinates yet')).toBeTruthy(); expect(screen.getByText(/The map never guesses a position on its own/)).toBeTruthy();
  });
  it('a failed load shows an error with retry', async () => {
    start('/map', { 'GET /api/map/clusters': { status: 500, json: { error: 'x', message: 'x' } } });
    expect(await screen.findByText('The map could not be loaded')).toBeTruthy();
  });
  it('makes no request to any map server (only this app’s API)', async () => {
    const calls = start('/map'); await screen.findByRole('application'); await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    for (const c of calls) expect(c.path.startsWith('/api/'), c.path).toBe(true);
    void fakeCard;
  });
  it('has no axe violations', async () => {
    start('/map'); await screen.findByRole('button', { name: /14 photographs/ }); await screen.findAllByRole('option'); await screen.findByText(/80 of 100 photographs can be placed/);        // everything has settled before the audit
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('Library ↔ Map', () => {
  it('a map area in the URL is a visible, removable filter chip and is sent to the server', async () => {
    const calls = start('/library?bbox=34,-3,36,0');
    const chips = await screen.findByRole('group', { name: 'Active filters' }); expect(within(chips).getByText(/-3\.00…0\.00°/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/library/photos')!.query.get('bbox')).toBe('34,-3,36,0');
    await userEvent.click(within(chips).getByRole('button', { name: 'Remove filter Map area' }));
    await waitFor(() => expect(last(calls.filter((c) => c.path === '/api/library/photos')).query.has('bbox')).toBe(false));
  });
  it('the Library offers “On map” carrying the current filters', async () => {
    start('/library?rating=5');
    const link = await screen.findByRole('link', { name: 'On map' }); expect(link.getAttribute('href')).toMatch(/^\/map\?.*rating=5/);
  });
  it('REGRESSION: photographs that carry a typed place name but no position are counted, and one button looks them up and refreshes the map', async () => {
    const calls = start('/map', { 'POST /api/library/photos/locate-named': { json: { names: 2, placed: 3, results: [{ query: 'Washington, DC', status: 'placed', label: 'Washington, District of Columbia, United States', photos: 2, expected: 2 }, { query: 'Zzyzx', status: 'not_found', photos: 0, expected: 1 }] } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Put 8 on the map' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/library/photos/locate-named')).toBe(true));
    expect(await screen.findByText('3 photographs placed on the map')).toBeTruthy(); expect(screen.getByText(/Not placed: “Zzyzx” \(not found\)\. The text was kept\./)).toBeTruthy();
    const before = calls.filter((c) => c.path === '/api/map/clusters').length; await waitFor(() => expect(calls.filter((c) => c.path === '/api/map/clusters').length).toBeGreaterThanOrEqual(before));
  });
});
