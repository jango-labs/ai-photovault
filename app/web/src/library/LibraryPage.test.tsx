import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDetail, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Call } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

/** the grid, once its first tiles are really on screen (the listbox appears a moment before the virtualised tiles do) */
const grid = async () => { const g = await screen.findByRole('listbox', { name: /Photographs/ }); await screen.findAllByRole('option'); return g; };
const options = () => screen.getAllByRole('option');
const start = async (total = 300, extra: Parameters<typeof libraryRoutes>[1] = {}, path = '/library') => {
  const lib = libraryRoutes(total, extra);
  const calls = mockApi(signedIn(lib.routes));
  renderApp(path);
  return { lib, calls };
};
/** ⌘/Ctrl-click (user-event v14 takes modifiers through the keyboard) */
const ctrlClick = async (el: HTMLElement) => { const u = userEvent.setup(); await u.keyboard('{Control>}'); await u.click(el); await u.keyboard('{/Control}'); };
const lastPhotosQuery = (calls: Call[]) => [...calls].reverse().find((c) => c.path === '/api/library/photos')!.query;

describe('Library: loading and layout', () => {
  it('shows the eight views, the first page from the server and the total', async () => {
    const { lib } = await start();
    await grid();
    const nav = screen.getByRole('navigation', { name: 'Library views' });
    expect(Array.from(nav.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['All photos', 'Recently added', 'Favorites', 'Rated', 'Portfolio', 'Instagram published', 'Never published', 'Unreviewed']);
    expect(await screen.findByText('300 photographs')).toBeTruthy();
    expect(options().length).toBeGreaterThan(0); expect(options().length).toBeLessThan(121);        // a window of the first page, not the catalogue
    expect(lib.photoCalls).toHaveLength(1);
    expect(lib.photoCalls[0]!.query.get('limit')).toBe('120'); expect(lib.photoCalls[0]!.query.get('cursor')).toBeNull();
  });
  it('renders thumbnails from owner-only API URLs (no public photo URLs), lazy and at their own aspect ratio', async () => {
    await start(); await grid();
    const img = options()[0]!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(`/api/library/photos/${idOf(0)}/image?size=thumb`);
    expect(img.getAttribute('loading')).toBe('lazy'); expect(img.getAttribute('width')).toBe('6000'); expect(img.getAttribute('height')).toBe('4000');
  });
  it('loads the next page by cursor when the end of the loaded rows comes into view (and never the whole catalogue)', async () => {
    const { lib } = await start(5_000);
    const g = await grid();
    expect(lib.photoCalls).toHaveLength(1);                                                            // the first screenful does not fetch more
    const scroller = g.parentElement as HTMLElement;
    scroller.scrollTop = 20_000; fireEvent.scroll(scroller);                                          // scroll to the end of the loaded rows
    await waitFor(() => expect(lib.photoCalls.length).toBeGreaterThan(1));
    const second = lib.photoCalls[1]!.query;
    expect(second.get('cursor')).toBeTruthy(); expect(second.get('limit')).toBe('120');
    expect(lib.photoCalls.every((c) => Number(c.query.get('limit')) <= 120)).toBe(true);
    expect(lib.photoCalls.length).toBeLessThan(60);                                                   // 5,000 photographs are not fetched up-front
  });
  it('has no axe violations (once the page has settled)', async () => {
    await start(); await grid();
    await screen.findByText('300 photographs');                                                       // header settled
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    expect(await axe(document.body)).toHaveNoViolations();
  }, 30_000);
});

describe('Library: sorting, views and filters are server queries', () => {
  it('a view sends view=…, resets to that view’s default order and marks itself current', async () => {
    const { calls } = await start(); await grid();
    await userEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    await waitFor(() => expect(lastPhotosQuery(calls).get('view')).toBe('favorites'));
    expect(screen.getByRole('button', { name: 'Favorites' }).getAttribute('aria-current')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Recently added' }));
    await waitFor(() => { const q = lastPhotosQuery(calls); expect(q.get('view')).toBe('recent'); expect(q.get('sort')).toBe('imported'); expect(q.get('dir')).toBe('desc'); });
    await userEvent.click(screen.getByRole('button', { name: 'All photos' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All photos' }).getAttribute('aria-current')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Recently added' }).getAttribute('aria-current')).toBe('false');
  });
  it('direction and sort key reach the server; ascending/descending labels fit the key', async () => {
    const { calls } = await start(); await grid();
    await userEvent.click(screen.getByRole('radio', { name: 'Oldest' }));
    await waitFor(() => expect(lastPhotosQuery(calls).get('dir')).toBe('asc'));
    await userEvent.click(screen.getByRole('button', { name: /Sort/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Filename' }));
    await waitFor(() => { const q = lastPhotosQuery(calls); expect(q.get('sort')).toBe('filename'); expect(q.get('dir')).toBe('asc'); });
    expect(screen.getByRole('radio', { name: 'A–Z' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: /Sort/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Rating' }));
    await waitFor(() => expect(lastPhotosQuery(calls).get('sort')).toBe('rating'));
    expect(screen.getByRole('radio', { name: 'Highest' })).toBeTruthy();
  });
  it('the folder tree shows the original structure with counts and filters by the chosen folder (a chip says so)', async () => {
    const { calls } = await start(300, {}, '/library'); await userEvent.click(await screen.findByRole('button', { name: /Filters/ }));
    const panel = await screen.findByRole('dialog'); const tree = await within(panel).findByLabelText('Folder tree');
    expect(within(tree).getByRole('button', { name: /^2025/ })).toBeTruthy(); await userEvent.click(within(tree).getByText('2025'));                                                    // selects and opens the year folder
    await userEvent.click(await within(tree).findByRole('button', { name: /^Day 2/ }));
    await waitFor(() => expect(lastPhotosQuery(calls).getAll('folder')).toEqual(['2025', '2025/Kenya/Day 2']));             // choosing a folder row selects it; the nested one narrows further
    await userEvent.click(within(panel).getByRole('button', { name: 'Done' })); expect(within(screen.getByRole('group', { name: 'Active filters' })).getByText('2025/Kenya/Day 2')).toBeTruthy();
  });
  it('filters combine and are sent to PostgreSQL as repeated parameters; each shows as a removable chip', async () => {
    const { calls } = await start(); await grid();
    await userEvent.click(screen.getByRole('button', { name: /Filters/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    await userEvent.click(within(panel).getByRole('button', { name: '4 stars' }));
    await userEvent.click(within(panel).getByRole('button', { name: '5 stars' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Portrait' }));
    await userEvent.click(within(panel).getByRole('button', { name: /^Possible duplicate/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Not analysed' }));
    await userEvent.click((await within(panel).findAllByRole('button', { name: /^2025/ }))[0]!);                // the first group is “Year taken” (capture year); “Folder year” is the second
    await userEvent.click(within(panel).getAllByRole('button', { name: /^Kenya/ }).at(-1)!);                      // the last “Kenya” is the folder LOCATION (the folder tree above it also has one)
    await userEvent.click(within(panel).getByRole('button', { name: /^Canon EOS R5/ }));
    await userEvent.click(within(panel).getByRole('radio', { name: 'Favourites' }));
    await waitFor(() => {
      const q = lastPhotosQuery(calls);
      expect(q.getAll('rating')).toEqual(['4', '5']); expect(q.getAll('orientation')).toEqual(['portrait']); expect(q.getAll('ig')).toEqual(['possible']); expect(q.getAll('ai')).toEqual(['none']);
      expect(q.getAll('year')).toEqual(['2025']); expect(q.getAll('location')).toEqual(['Kenya']); expect(q.getAll('camera')).toEqual(['Canon EOS R5']); expect(q.get('favorite')).toBe('true');
    });
    await userEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    const chips = screen.getByRole('group', { name: 'Active filters' });
    expect(within(chips).getAllByText(/Rating|Orientation|Instagram|AI|Year|Folder location|Camera|Favourites/).length).toBeGreaterThanOrEqual(9);
    await userEvent.click(within(chips).getByRole('button', { name: 'Remove filter Orientation' }));
    await waitFor(() => expect(lastPhotosQuery(calls).getAll('orientation')).toEqual([]));
    await userEvent.click(within(chips).getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull());
  }, 30_000);
  it('the topbar search and ?q= become a server-side text search', async () => {
    const { calls } = await start(300, {}, '/library?q=lion'); await grid();
    expect(lastPhotosQuery(calls).get('q')).toBe('lion');
    expect(within(screen.getByRole('group', { name: 'Active filters' })).getByText('lion')).toBeTruthy();
  });
  it('the URL is the state: a shared link restores view, sort and filters', async () => {
    const { calls } = await start(300, {}, '/library?view=portfolio&sort=rating&dir=asc&year=2024&rating=5&orientation=portrait');
    await grid();
    const q = lastPhotosQuery(calls);
    expect(q.get('view')).toBe('portfolio'); expect(q.get('sort')).toBe('rating'); expect(q.get('dir')).toBe('asc'); expect(q.getAll('year')).toEqual(['2024']); expect(q.getAll('rating')).toEqual(['5']);
    expect(screen.getByRole('button', { name: 'Portfolio' }).getAttribute('aria-current')).toBe('true');
  });
  it('saved preferences apply when the URL has none, and changes are saved back', async () => {
    const lib = libraryRoutes(300, { 'GET /api/library/preferences': { json: { view: 'rated', sort: 'rating', dir: 'desc', filters: { year: [2024], orientation: ['portrait'] } } } });
    const calls = mockApi(signedIn(lib.routes)); renderApp('/library'); await grid();
    const q = lastPhotosQuery(calls);
    expect(q.get('view')).toBe('rated'); expect(q.get('sort')).toBe('rating'); expect(q.getAll('year')).toEqual(['2024']);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);                                         // not saved merely because it loaded
    await userEvent.click(screen.getByRole('button', { name: 'Portfolio' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT' && c.path === '/api/library/preferences')).toBeTruthy(), { timeout: 4000 });
    const put = calls.find((c) => c.method === 'PUT')!.body as { view: string; filters: Record<string, unknown> };
    expect(put.view).toBe('portfolio'); expect(put.filters).toMatchObject({ year: [2024], orientation: ['portrait'] }); expect(put.filters).not.toHaveProperty('q');
  }, 15_000);
});

describe('Library: empty, error and filtered-out states', () => {
  it('an empty library explains what happens next and starts nothing', async () => {
    await start(0); await grid().catch(() => null);
    expect(await screen.findByRole('heading', { name: 'Your library is empty' })).toBeTruthy();
    expect(screen.getByText(/nothing on this computer has been scanned/i)).toBeTruthy();
  });
  it('filters that match nothing offer to clear them', async () => {
    const lib = libraryRoutes(0); const calls = mockApi(signedIn(lib.routes)); renderApp('/library?rating=5'); void calls;
    expect(await screen.findByRole('heading', { name: 'No photographs match' })).toBeTruthy();
    const empty = screen.getByRole('heading', { name: 'No photographs match' }).closest('.jb-empty') as HTMLElement;
    await userEvent.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastPhotosQuery(calls).getAll('rating')).toEqual([]));
  });
  it('a failed load is an understandable error with a retry that works', async () => {
    let fail = true;
    const lib = libraryRoutes(30, { 'GET /api/library/photos': (c) => (fail ? { status: 503, json: { error: 'x', message: 'x' } } : libraryRoutes(30).routes['GET /api/library/photos'] instanceof Function ? (libraryRoutes(30).routes['GET /api/library/photos'] as (c: Call) => { json: unknown })(c) : { json: {} }) });
    mockApi(signedIn(lib.routes)); renderApp('/library');
    expect(await screen.findByRole('heading', { name: 'The library could not be loaded' })).toBeTruthy();
    expect(screen.getByText(/Nothing was changed/)).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await grid();
    expect(options().length).toBeGreaterThan(0);
  });
});

describe('Library: selection and bulk actions', () => {
  it('click selects, Ctrl+A selects what is loaded and offers “select all N matching”; Esc clears', async () => {
    await start(300); const g = await grid();
    await userEvent.click(options()[1]!);
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    g.focus(); await userEvent.keyboard('{Control>}a{/Control}');
    expect(await within(bar).findByText('120 selected')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Select all 300 matching' })).toBeTruthy();
    await userEvent.click(within(bar).getByRole('button', { name: 'Select all 300 matching' }));
    expect(await within(bar).findByText('300 selected')).toBeTruthy();
    await userEvent.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();
  });
  it('“Select all” in the toolbar selects the whole filtered result set, and excluding one photograph is remembered', async () => {
    await start(300); await grid();
    await userEvent.click(screen.getByRole('button', { name: /^Select all 300/ }));
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('300 selected')).toBeTruthy();
    await ctrlClick(options()[0]!);                                                                   // ⌘/Ctrl-click deselects one
    expect(await within(bar).findByText('299 selected')).toBeTruthy();
  });
  it('applying an action to all matching photographs asks first, then sends the FILTER (not 300 ids) with the exclusions', async () => {
    const { calls } = await start(300, { 'POST /api/library/photos/bulk': { json: { updated: 299 } } }, '/library?year=2025&orientation=landscape');
    await grid();
    await userEvent.click(screen.getByRole('button', { name: /^Select all 300/ }));
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    await ctrlClick(options()[0]!);
    await userEvent.click(within(bar).getByRole('button', { name: 'Favourite' }));
    const dlg = await screen.findByRole('dialog', { name: 'Apply to 299 photographs?' });
    expect(within(dlg).getByText(/photograph files are never touched/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/library/photos/bulk')).toBe(false);                      // nothing happens before confirmation
    await userEvent.click(within(dlg).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/library/photos/bulk')).toBe(true));
    const body = calls.find((c) => c.path === '/api/library/photos/bulk')!.body as { target: { query: Record<string, unknown>; exclude: string[] }; set: Record<string, unknown> };
    expect(body.set).toEqual({ favorite: true });
    expect(body.target.query).toMatchObject({ view: 'all', year: [2025], orientation: ['landscape'] });
    expect(body.target.exclude).toEqual([idOf(0)]);
    expect('ids' in body.target).toBe(false);
    expect(await screen.findByText('299 photographs updated')).toBeTruthy();
  });
  it('a small explicit selection applies at once by id, with no confirmation', async () => {
    const { calls } = await start(300, { 'POST /api/library/photos/bulk': { json: { updated: 2 } } }); await grid();
    await userEvent.click(options()[0]!); await ctrlClick(options()[1]!);
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Add to portfolio' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/library/photos/bulk')).toBeTruthy());
    const body = calls.find((c) => c.path === '/api/library/photos/bulk')!.body as { target: { ids: string[] }; set: unknown };
    expect(body.target.ids).toEqual([idOf(0), idOf(1)]); expect(body.set).toEqual({ portfolio: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('bulk rating from the Rate menu', async () => {
    const { calls } = await start(300, { 'POST /api/library/photos/bulk': { json: { updated: 1 } } }); await grid();
    await userEvent.click(options()[2]!);
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Rate' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '3 stars' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/library/photos/bulk')).toBeTruthy());
    expect((calls.find((c) => c.path === '/api/library/photos/bulk')!.body as { set: unknown }).set).toEqual({ rating: 3 });
  });
  it('a failed bulk change is reported and the optimistic change is rolled back by reloading', async () => {
    const { calls } = await start(300, { 'POST /api/library/photos/bulk': { status: 500, json: { error: 'internal_error', message: 'x' } } }); await grid();
    await userEvent.click(options()[0]!);
    await userEvent.click(within(await screen.findByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Favourite' }));
    expect(await screen.findByText('The bulk change could not be saved')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/library/photos').length).toBeGreaterThan(1));
  });
});

describe('Library: rating, favourite and portfolio from the keyboard', () => {
  it('0–5, F and P edit the active photograph and PATCH it', async () => {
    const { calls } = await start(300, { [`PATCH /api/library/photos/${idOf(0)}`]: { json: { ok: true } } });
    const g = await grid(); g.focus();
    await userEvent.keyboard('4'); await userEvent.keyboard('f'); await userEvent.keyboard('p');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ rating: 4 }, { favorite: false }, { portfolio: false }]);       // card 0: favourite and portfolio start true
    expect(options()[0]!.getAttribute('aria-label')).toMatch(/rated 4 of 5/);                          // optimistic: the UI already shows it
  });
  it('a failed save reverts and says so', async () => {
    const { calls } = await start(300, { [`PATCH /api/library/photos/${idOf(0)}`]: { status: 500, json: { error: 'internal_error', message: 'x' } } });
    const g = await grid(); g.focus(); await userEvent.keyboard('5');
    expect(await screen.findByText('That change could not be saved')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/library/photos').length).toBeGreaterThan(1));
  });
});

describe('Library: viewer', () => {
  const detailRoutes = () => Object.fromEntries([0, 1, 2, 3].map((n) => [`GET /api/library/photos/${idOf(n)}`, { json: fakeDetail(n) }]));
  it('opens on Enter / double-click as a deep-linkable dialog, navigates with the arrows, loads detail per photograph and closes with Esc', async () => {
    const { calls } = await start(300, detailRoutes());
    const g = await grid(); g.focus();
    await userEvent.keyboard('{Enter}');
    const dlg = await screen.findByRole('dialog', { name: 'Photograph 0' });
    const stageImg = dlg.querySelector('.jb-viewer__stage img') as HTMLImageElement;
    expect(stageImg.getAttribute('src')).toBe(`/api/library/photos/${idOf(0)}/image?size=view`);
    expect(await within(dlg).findByText('img_0.jpg')).toBeTruthy();                                  // Information tab: filename from the detail endpoint
    expect(dlg.querySelector('.jb-viewer__bar')!.textContent).toContain('1 / 120');
    await userEvent.keyboard('{ArrowRight}');
    expect(dlg.querySelector('.jb-viewer__bar')!.textContent).toContain('2 / 120');
    await waitFor(() => expect(calls.some((c) => c.path === `/api/library/photos/${idOf(1)}`)).toBe(true));
    expect((dlg.querySelector('.jb-viewer__stage img') as HTMLImageElement).getAttribute('src')).toContain(idOf(1));
    await userEvent.keyboard('{ArrowLeft}');
    expect(dlg.querySelector('.jb-viewer__bar')!.textContent).toContain('1 / 120');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Photograph 0' })).toBeNull());
  });
  it('a deep link opens the photograph straight away, even before it is in the grid', async () => {
    const id = idOf(2);
    await start(300, detailRoutes(), `/library?photo=${id}`);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getAllByText('Photograph 2').length).toBeGreaterThan(0);
  });
  it('sidebar: Information, AI Analysis, EXIF, Collections and Publish; AI and Publish are honest placeholders', async () => {
    await start(300, detailRoutes(), `/library?photo=${idOf(1)}`);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Information', 'AI Analysis', 'EXIF', 'Collections', 'Publish']);
    await userEvent.click(within(dlg).getByRole('tab', { name: 'AI Analysis' }));
    expect(await within(dlg).findByText(/Not analysed yet/)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'EXIF' }));
    expect(within(dlg).getByText('Canon EOS R5')).toBeTruthy(); expect(within(dlg).getByText('f/7.1')).toBeTruthy(); expect(within(dlg).getByText('1/1000 s')).toBeTruthy();
    expect(within(dlg).queryByText('GPS')).toBeNull();                                                // nothing is invented when GPS is not recorded
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Publish' }));
    expect(within(dlg).getByText(/not connected to Instagram/)).toBeTruthy();
    expect((within(dlg).getByRole('button', { name: 'Create post' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('rates, favourites and toggles the portfolio from inside the viewer', async () => {
    const { calls } = await start(300, { ...detailRoutes(), [`PATCH /api/library/photos/${idOf(1)}`]: { json: { ok: true } } }, `/library?photo=${idOf(1)}`);
    await screen.findByRole('dialog');
    await userEvent.keyboard('3'); await userEvent.keyboard('f'); await userEvent.keyboard('p');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ rating: 3 }, { favorite: true }, { portfolio: true }]);
  });
  it('the viewer background follows the saved setting (neutral grey #2e2e2e by default) and N flips it', async () => {
    const { calls } = await start(300, { ...detailRoutes(), 'PATCH /api/settings': (c) => ({ json: { viewerSurface: (c.body as { viewerSurface: string }).viewerSurface, thumbSize: 240, aiScoresVisible: false } }) }, `/library?photo=${idOf(1)}`);
    const dlg = await screen.findByRole('dialog');
    expect((dlg as HTMLElement).style.getPropertyValue('--viewer-surface')).toBe('#2e2e2e');
    await userEvent.keyboard('n');
    await waitFor(() => expect((dlg as HTMLElement).style.getPropertyValue('--viewer-surface')).toBe('var(--abyss-0)'));
    expect(calls.find((c) => c.path === '/api/settings')!.body).toEqual({ viewerSurface: 'teal' });
  });
  it('a photograph that is not yours (or no longer exists) says so', async () => {
    await start(300, { [`GET /api/library/photos/${idOf(9)}`]: { status: 404, json: { error: 'not_found', message: 'No such photograph.' } } }, `/library?photo=${idOf(9)}`);
    expect(await screen.findByRole('dialog', { name: 'Photograph not found' })).toBeTruthy();
  });
});
