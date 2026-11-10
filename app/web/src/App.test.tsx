import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp, signedIn, signedOut } from './test/mockApi';

afterEach(() => vi.unstubAllGlobals());
const ready = async (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

describe('application shell (signed in)', () => {
  it('shows the six primary workspaces in order (desktop + mobile bars)', async () => {
    mockApi(signedIn()); renderApp('/library'); await ready('Library');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['Library', 'Imports', 'Collections', 'AI Curator', 'Map', 'Publish']);
    expect(screen.getByRole('navigation', { name: 'Primary (mobile)' }).querySelectorAll('a')).toHaveLength(6);
  });
  it('marks the current workspace and exposes a skip link and a main landmark', async () => {
    mockApi(signedIn()); renderApp('/imports'); await ready('Imports');
    expect(screen.getAllByRole('link', { name: 'Imports', current: 'page' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main');
    expect(screen.getByRole('main').id).toBe('main');
  });
  it('PUBLISH reveals Calendar · Drafts · Ready · Scheduled · Published · History, with a review badge on History', async () => {
    mockApi(signedIn({ 'GET /api/instagram/review': { json: { total: 4, items: [] } } })); renderApp('/publish/scheduled'); await ready('Scheduled');
    const sub = screen.getByRole('navigation', { name: 'Publish' });
    expect(Array.from(sub.querySelectorAll('a')).map((a) => a.firstChild?.textContent)).toEqual(['Calendar', 'Drafts', 'Ready', 'Scheduled', 'Published', 'History']);
    expect(within(sub).getByRole('link', { name: 'Scheduled', current: 'page' })).toBeTruthy();
    const history = within(sub).getByRole('link', { name: /History/ });
    await waitFor(() => expect(history.querySelector('.jb-badge')?.textContent).toMatch(/^4/));
    expect(history.textContent).toMatch(/possible matches to review/);
  });
  it('/publish goes to the calendar, which says that scheduling is only a plan', async () => {
    mockApi(signedIn({ 'GET /api/publishing/calendar': { json: { items: [] } } })); renderApp('/publish');
    await ready('Calendar'); expect(await screen.findAllByRole('cell')).toHaveLength(42);
    expect(screen.getByText(/Nothing is sent to Instagram/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Instagram history' }); expect(link.getAttribute('href')).toBe('/publish/history');
  });
  it('the History page leads with the archive and a primary “review matches” action (real data; see instagram/HistoryPage.test.tsx)', async () => {
    mockApi(signedIn({ 'GET /api/instagram/review': { json: { total: 3, items: [] } } })); renderApp('/publish/history');
    await ready('Instagram history');
    expect((await screen.findByRole('link', { name: /Review 3 possible matches/ })).className).toContain('jb-btn--primary');
  });
  it('has no axe violations on workspace, calendar and history pages', async () => {
    for (const [path, h] of [['/map', 'Map'], ['/publish/calendar', 'Calendar'], ['/publish/history', 'Instagram history']] as const) {
      mockApi(signedIn({ 'GET /api/publishing/calendar': { json: { items: [] } } })); const { container, unmount } = renderApp(path); await ready(h);
      expect(await axe(container)).toHaveNoViolations(); unmount();
    }
  }, 60_000);
  it('the design-system page has no axe violations', async () => {
    mockApi(signedIn()); const { container } = renderApp('/design-system');
    expect(await screen.findByRole('heading', { level: 1, name: 'AI PhotoVault' }, { timeout: 30_000 })).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  }, 60_000);
});

describe('route protection', () => {
  it('signed-out visitors are sent to the sign-in page from every workspace', async () => {
    for (const path of ['/library', '/publish/calendar', '/settings/account', '/design-system']) {
      mockApi(signedOut()); const { unmount } = renderApp(path);
      expect(await ready('Sign in')).toBeTruthy(); expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull(); unmount();
    }
  });
  it('signing out calls the server and returns to sign-in', async () => {
    const calls = mockApi(signedIn({ 'POST /api/auth/logout': { json: { ok: true } } })); renderApp('/library'); await ready('Library');
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(await ready('Sign in')).toBeTruthy();
    const out = calls.find((c) => c.path === '/api/auth/logout')!; expect(out.method).toBe('POST'); expect(out.headers['x-csrf-token']).toBe('csrf-token-for-tests');
  });
});
