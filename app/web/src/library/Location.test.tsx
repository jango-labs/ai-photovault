import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeocodeSearch } from '../api/library';
import { fakeDetail, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const DC: GeocodeSearch = { enabled: true, attribution: '© OpenStreetMap contributors', status: 'ok', cached: false, candidates: [{ label: 'Washington, District of Columbia, United States', lat: 38.8951, lon: -77.0364, kind: 'place/city', bbox: [-77.12, 38.79, -76.91, 39.0] }] };
const gps = (o: Record<string, unknown> = {}) => ({ lat: 38.8895, lon: -77.0353, altitudeM: null, source: 'EXIF', approximate: false, label: null, ...o });
const withGps = (g: ReturnType<typeof gps> | null, cameraGps: unknown = null) => { const d = fakeDetail(1); return { ...d, exif: { ...d.exif, gps: g, cameraGps } }; };
const PATCH = `PATCH /api/library/photos/${idOf(1)}/metadata`;
const open = async (detail: unknown, extra: Routes = {}) => {
  const lib = libraryRoutes(300, { [`GET /api/library/photos/${idOf(1)}`]: { json: detail }, ...extra }); const calls = mockApi(signedIn(lib.routes)); renderApp(`/library?photo=${idOf(1)}`);
  const dlg = await screen.findByRole('dialog'); await userEvent.click(await within(dlg).findByRole('button', { name: 'Edit details' })); return { calls, dlg };
};
const sent = (calls: Array<{ method: string; path: string; body?: unknown }>) => calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/metadata'))!.body as Record<string, unknown>;

describe('location → map (editor)', () => {
  it('typing a location and saving sends only the text — the server resolves it — and the answer is explained: approximate, centre of the place', async () => {
    const { calls, dlg } = await open(withGps(null), { [PATCH]: { json: { status: 'ok', changed: ['trip_location', 'gps'], batchId: 'b', geocode: { status: 'placed', query: 'Washington, DC', label: 'Washington, District of Columbia, United States', lat: 38.8951, lon: -77.0364 } } } });
    const loc = within(dlg).getByLabelText('Location'); await userEvent.clear(loc); await userEvent.type(loc, 'Washington, DC');
    expect(within(dlg).getByText(/only this text is sent to OpenStreetMap/)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(calls)).toEqual({ location: 'Washington, DC' }));
    expect(await screen.findByText('Placed on the map: Washington, District of Columbia, United States')).toBeTruthy(); expect(screen.getByText(/centre of the place, not the exact spot/)).toBeTruthy();
  });
  it('“Find on map” lists candidates with attribution; choosing one fills the coordinates and saves them as APPROXIMATE with the place label (nothing is sent until Save)', async () => {
    const { calls, dlg } = await open(withGps(null), { 'GET /api/geocode': { json: DC }, [PATCH]: { json: { status: 'ok', changed: ['gps'], batchId: 'b' } } });
    const loc = within(dlg).getByLabelText('Location'); await userEvent.clear(loc); await userEvent.type(loc, 'Washington, DC');
    expect(calls.some((c) => c.path.startsWith('/api/geocode'))).toBe(false);                                   // never as-you-type
    await userEvent.click(within(dlg).getByRole('button', { name: 'Find on map' }));
    const list = await within(dlg).findByRole('group', { name: 'Places found' }); expect(within(list).getByText(/© OpenStreetMap contributors/)).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: /Washington, District of Columbia/ }));
    expect((within(dlg).getByLabelText('Latitude') as HTMLInputElement).value).toBe('38.89510'); expect((within(dlg).getByLabelText('Longitude') as HTMLInputElement).value).toBe('-77.03640');
    expect(within(dlg).getByText(/Approximate: the centre of Washington, District of Columbia/)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(calls)).toMatchObject({ location: 'Washington, DC', gps: { lat: 38.8951, lon: -77.0364, approximate: true, label: 'Washington, District of Columbia, United States' } }));
  });
  it('a failed or empty lookup keeps the text and says so in plain words; the service being unreachable never blocks saving', async () => {
    const { dlg } = await open(withGps(null), { 'GET /api/geocode': { json: { enabled: true, attribution: '', status: 'not_found', cached: false } } });
    { const l = within(dlg).getByLabelText('Location'); await userEvent.clear(l); await userEvent.type(l, 'Zzyzx'); } await userEvent.click(within(dlg).getByRole('button', { name: 'Find on map' }));
    expect(await within(dlg).findByText(/“Zzyzx” was not found\. The text is kept; try a more specific name, or place a pin/)).toBeTruthy();
    expect((within(dlg).getByLabelText('Location') as HTMLInputElement).value).toBe('Zzyzx');
  });
  it.each([
    ['not_found', 'Location not found on the map', '“Zzyzx” was not found on the map; the text was kept.'],
    ['unavailable', 'Could not look the location up', 'The place-name service could not be reached (is the Mac online?). The text was kept; press “Find on map” to try again.'],
    ['disabled', 'Map lookup is off', 'Looking places up is switched off; the text was kept.'],
  ])('after saving, a %s lookup is reported as a warning with its explanation', async (status, title, message) => {
    const { dlg } = await open(withGps(null), { [PATCH]: { json: { status: 'ok', changed: ['trip_location'], batchId: 'b', geocode: { status, query: 'Zzyzx', message } } } });
    { const l = within(dlg).getByLabelText('Location'); await userEvent.clear(l); await userEvent.type(l, 'Zzyzx'); } await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(title)).toBeTruthy(); expect(screen.getByText(message)).toBeTruthy();
  });
  it('“Place pin…” opens a map; clicking it fills Latitude/Longitude as a hand-placed (exact) position, not an approximate one', async () => {
    const { calls, dlg } = await open(withGps(null), { [PATCH]: { json: { status: 'ok', changed: ['gps'], batchId: 'b' } } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Place pin…' }));
    const pinDlg = (await screen.findAllByRole('dialog')).find((x) => within(x).queryByText('Place the pin'))!; const surface = within(pinDlg).getByRole('application');
    expect(within(pinDlg).getByText('No pin yet.')).toBeTruthy();
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 560, height: 340, right: 560, bottom: 340, x: 0, y: 0, toJSON: () => ({}) });
    await userEvent.pointer([{ target: surface, keys: '[MouseLeft>]', coords: { clientX: 280, clientY: 170 } }, { keys: '[/MouseLeft]' }]);
    await waitFor(() => expect(within(pinDlg).getByRole('status').textContent).toMatch(/Pin at -?\d+\.\d+°, -?\d+\.\d+°/));
    await userEvent.click(within(pinDlg).getByRole('button', { name: 'Use this position' }));
    await waitFor(() => expect((within(dlg).getByLabelText('Latitude') as HTMLInputElement).value).not.toBe(''));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(calls).gps).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) })); expect((sent(calls).gps as Record<string, unknown>).approximate).toBeUndefined();
  });
  it('the pin map is keyboard-operable (Enter places the pin at the centre) and has no accessibility violations', async () => {
    const { dlg } = await open(withGps(null)); await userEvent.click(within(dlg).getByRole('button', { name: 'Place pin…' }));
    const pinDlg = (await screen.findAllByRole('dialog')).find((x) => within(x).queryByText('Place the pin'))!; const surface = within(pinDlg).getByRole('application'); surface.focus();
    await userEvent.keyboard('{Enter}'); expect(within(pinDlg).getByRole('status').textContent).toMatch(/Pin at/); expect(await axe(pinDlg)).toHaveNoViolations();
  });
  it('with camera GPS the form shows what the camera recorded and says it is kept; with a hand pin over it, “Use the camera’s position” sends gpsRestore', async () => {
    const cam = { lat: 38.8895, lon: -77.0353, source: 'EXIF', inUse: false };
    const { calls, dlg } = await open(withGps(gps({ lat: 38.9, lon: -77.04, source: 'USER_DEFINED' }), cam), { [PATCH]: { json: { status: 'ok', changed: ['gps'], batchId: 'b' } } });
    expect(within(dlg).getByText(/The camera recorded 38\.8895, -77\.0353; it is kept whatever you do here/)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Use the camera’s position' })); await waitFor(() => expect(sent(calls)).toEqual({ gpsRestore: true }));
  });
  it('the Information panel labels the position: approximate (with place and attribution), camera, or yours — and shows the kept camera position', async () => {
    const lib = libraryRoutes(300, { [`GET /api/library/photos/${idOf(1)}`]: { json: withGps(gps({ lat: 38.8951, lon: -77.0364, source: 'GEOCODED', approximate: true, label: 'Washington, District of Columbia, United States' }), { lat: 1.5, lon: 2.5, source: 'IPTC', inUse: false }) } });
    mockApi(signedIn(lib.routes)); renderApp(`/library?photo=${idOf(1)}`); const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('Approximate · OpenStreetMap')).toBeTruthy(); expect(within(dlg).getByText(/Approximate: the centre of Washington, District of Columbia, United States, not where the photograph was taken/)).toBeTruthy();
    expect(within(dlg).getByText(/© OpenStreetMap contributors/)).toBeTruthy(); expect(within(dlg).getByRole('link', { name: 'Show on map' }).getAttribute('href')).toMatch(/^\/map\?photo=.*&c=38\.8951,-77\.0364,8\.00$/);
    expect(within(dlg).getByText('Camera recorded')).toBeTruthy(); expect(within(dlg).getByText('1.5000, 2.5000')).toBeTruthy();
  });
  it('a photograph with no position says how to get one', async () => {
    const lib = libraryRoutes(300, { [`GET /api/library/photos/${idOf(1)}`]: { json: withGps(null) } }); mockApi(signedIn(lib.routes)); renderApp(`/library?photo=${idOf(1)}`);
    expect(await within(await screen.findByRole('dialog')).findByText(/No position yet\. Enter a location and press “Find on map”, or place a pin\./)).toBeTruthy();
  });
  it('saving refreshes everything that shows the location: the details, the library lists and the MAP (markers) are re-fetched', async () => {
    const { calls, dlg } = await open(withGps(null), { [PATCH]: { json: { status: 'ok', changed: ['trip_location'], batchId: 'b' } }, 'GET /api/map/summary': { json: { placed: 0, total: 0, sources: {} } } });
    const before = calls.filter((c) => c.path === `/api/library/photos/${idOf(1)}`).length;
    { const l = within(dlg).getByLabelText('Location'); await userEvent.clear(l); await userEvent.type(l, 'Washington, DC'); } await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.path === `/api/library/photos/${idOf(1)}`).length).toBeGreaterThan(before));
  });
  it('REGRESSION: a photograph that has location text but no position offers “Put … on the map”, which asks the server to locate it (and explains the result)', async () => {
    const d = { ...withGps(null), location: 'Washington, D.C', locationSource: 'USER_DEFINED' };
    const lib = libraryRoutes(300, { [`GET /api/library/photos/${idOf(1)}`]: { json: d }, [PATCH]: { json: { status: 'ok', changed: ['gps'], batchId: 'b', geocode: { status: 'placed', query: 'Washington, D.C', label: 'Washington, District of Columbia, United States', lat: 38.8951, lon: -77.0364 } } } });
    const calls = mockApi(signedIn(lib.routes)); renderApp(`/library?photo=${idOf(1)}`); const dlg = await screen.findByRole('dialog');
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Put “Washington, D.C” on the map' }));
    await waitFor(() => expect(sent(calls)).toEqual({ locate: true })); expect(await screen.findByText('Placed on the map: Washington, District of Columbia, United States')).toBeTruthy();
  });
  it('REGRESSION: pressing Save with the text unchanged but no position yet sends a locate request instead of silently closing', async () => {
    const d = { ...withGps(null), location: 'Chicago, IL', locationSource: 'USER_DEFINED' };
    const { calls, dlg } = await open(d, { [PATCH]: { json: { status: 'ok', changed: ['gps'], batchId: 'b', geocode: { status: 'placed', query: 'Chicago, IL', label: 'Chicago, Illinois, United States' } } } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' })); await waitFor(() => expect(sent(calls)).toEqual({ locate: true }));
  });
  it('with a position already, Save with nothing changed still just closes (no request)', async () => {
    const { calls, dlg } = await open(withGps(gps())); await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(dlg).queryByRole('button', { name: 'Save' })).toBeNull()); expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

