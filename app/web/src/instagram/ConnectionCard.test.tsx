import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

const BASE = { configured: false, mode: 'unconfigured', connected: false, warning: null, redirectUri: null, account: null, missing: ['Meta app ID and secret', 'your approval to connect a real account'], eligibility: ['A professional Instagram account (Business or Creator).', 'The redirect URI must be HTTPS.'] };
const start = (conn: object, extra: Routes = {}) => { mockApi(signedIn({ 'GET /api/instagram/connection': { json: { ...BASE, ...conn } }, 'GET /api/instagram/account': { json: { account: null, stats: { posts: 0, matched: 0, review: 0, unmatched: 0 }, syncing: false, lastRun: null, capabilities: { synthetic: false } } }, 'GET /api/instagram/history': { json: { items: [], nextCursor: null, counts: { all: 0, matched: 0, review: 0, unmatched: 0 } } }, 'GET /api/instagram/review': { json: { items: [], total: 0 } }, ...extra })); renderApp('/publish/history'); };

describe('Instagram connection card', () => {
  it('says plainly that nothing is connected, lists what is missing and keeps Connect off', async () => {
    start({}); const card = (await screen.findByRole('region', { name: 'Connection' }));
    expect(within(card).getByText(/not connected/)).toBeTruthy(); expect(within(card).getByText(/Still needed: Meta app ID and secret; your approval/)).toBeTruthy(); expect(within(card).getByText(/posting is off/)).toBeTruthy();
    expect((within(card).getByRole('button', { name: 'Connect Instagram' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(card).getByText('What is required to connect')); expect(within(card).getByText(/professional Instagram account/)).toBeTruthy();
  });
  it('a sandbox connection is labelled as such and shows the token lifetime and a warning when close', async () => {
    start({ configured: true, mode: 'sandbox', connected: true, warning: 'The Instagram token expires in 9 days; it is refreshed automatically while the worker runs.', account: { username: 'sandbox_photographer', type: 'BUSINESS', status: 'CONNECTED', scopes: [], tokenExpiresAt: 'x', daysLeft: 9, lastError: null } });
    const card = await screen.findByRole('region', { name: 'Connection' });
    expect(within(card).getByText(/connected/)).toBeTruthy(); expect(within(card).getByText(/SANDBOX on this computer \(no real account\)/)).toBeTruthy(); expect(within(card).getByText(/@sandbox_photographer · business · token valid for 9 more days/)).toBeTruthy();
    expect(within(card).getByRole('alert').textContent).toMatch(/expires in 9 days/); expect(within(card).getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });
  it('an expired token offers to connect again', async () => {
    start({ configured: true, mode: 'sandbox', connected: false, warning: 'The Instagram token has expired or was revoked. Connect again.', account: { username: 'x', type: 'BUSINESS', status: 'EXPIRED', scopes: [], tokenExpiresAt: null, daysLeft: null, lastError: 'e' } });
    const card = await screen.findByRole('region', { name: 'Connection' }); expect(within(card).getByText(/connection: expired/)).toBeTruthy(); expect((within(card).getByRole('button', { name: 'Connect again' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
