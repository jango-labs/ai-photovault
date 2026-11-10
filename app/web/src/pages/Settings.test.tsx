import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeUserAgent } from '../api/client';
import { ME, SESSIONS, mockApi, renderApp, signedIn } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());
const user = userEvent.setup();
const heading = (n: string) => screen.findByRole('heading', { level: 1, name: n });

describe('account settings', () => {
  it('lists sessions with this device marked; other devices can be signed out', async () => {
    let sessions = SESSIONS.sessions;
    const calls = mockApi(signedIn({ 'GET /api/auth/sessions': () => ({ json: { sessions } }), 'DELETE /api/auth/sessions/22222222-2222-4222-8222-222222222222': () => { sessions = sessions.filter((s) => s.current); return { json: { ok: true } }; } }));
    const { container } = renderApp('/settings/account'); await heading('Account');
    const rows = await screen.findAllByRole('listitem'); expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('This device')).toBeTruthy(); expect(within(rows[0]!).getByText('Safari on macOS')).toBeTruthy(); expect(within(rows[1]!).getByText('Safari on iPhone')).toBeTruthy();
    expect(within(rows[0]!).queryByRole('button', { name: 'Sign out' })).toBeNull();               // you cannot revoke the session you are using from the list
    expect(await axe(container)).toHaveNoViolations();
    await user.click(within(rows[1]!).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'DELETE')!.headers['x-csrf-token']).toBe(ME.csrfToken);
  });
  it('changing the password shows server errors and never echoes the password', async () => {
    const calls = mockApi(signedIn({ 'GET /api/auth/sessions': { json: SESSIONS }, 'POST /api/auth/password': { status: 403, json: { error: 'wrong_password', message: 'The current password is not correct.' } } }));
    renderApp('/settings/account'); await heading('Account');
    await user.click(screen.getByLabelText('Current password')); await user.keyboard('old-old-old-old');
    await user.click(screen.getByLabelText('New password')); await user.keyboard('another unusual passphrase 7');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The current password is not correct.');
    expect(calls.find((c) => c.path === '/api/auth/password')!.body).toEqual({ current: 'old-old-old-old', next: 'another unusual passphrase 7' });
  });
  it('describes user agents for humans', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537')).toBe('Chrome on Windows');
    expect(describeUserAgent('Mozilla/5.0 (iPad; CPU OS 17) Safari/605')).toBe('Safari on iPad');
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0')).toBe('Firefox on Linux'); expect(describeUserAgent(null)).toBe('Unknown device');
  });
});

describe('display settings', () => {
  it('defaults to the neutral grey viewer background and saves a change to teal', async () => {
    const calls = mockApi(signedIn({ 'PATCH /api/settings': (c) => ({ json: { ...ME.settings, ...(c.body as object) } }) }));
    const { container } = renderApp('/settings/display'); await heading('Display');
    const neutral = screen.getByRole('radio', { name: 'Neutral grey' }), teal = screen.getByRole('radio', { name: 'Teal' });
    expect(neutral.getAttribute('aria-checked')).toBe('true'); expect(teal.getAttribute('aria-checked')).toBe('false');
    expect(await axe(container)).toHaveNoViolations();
    await user.click(teal);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Teal' }).getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ viewerSurface: 'teal' });
  });
  it('reverts the optimistic change when saving fails', async () => {
    mockApi(signedIn({ 'PATCH /api/settings': { status: 500, json: { error: 'internal_error', message: 'x' } } }));
    renderApp('/settings/display'); await heading('Display');
    await user.click(screen.getByRole('radio', { name: 'Teal' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Neutral grey' }).getAttribute('aria-checked')).toBe('true'));
    expect(await screen.findByText('Could not save that setting')).toBeTruthy();
  });
});

describe('system page', () => {
  it('shows service status and the safety switches', async () => {
    mockApi(signedIn({ 'GET /api/system/status': { json: { api: { ok: true, version: '0.4.0', uptimeSeconds: 600, node: 'v24' }, database: { ok: true, latencyMs: 3, version: '17.11 (Homebrew)' }, time: 'x' } } }));
    const { container } = renderApp('/settings/system'); await heading('System');
    expect(await screen.findByText(/PostgreSQL 17.11/)).toBeTruthy(); expect(screen.getByText(/local analysis only; nothing leaves this computer/)).toBeTruthy(); expect(screen.getByText('Not connected')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });
});
