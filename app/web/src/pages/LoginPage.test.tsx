import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME, mockApi, renderApp, signedOut } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());
const user = userEvent.setup();
const fill = async (label: string | RegExp, v: string) => { await user.click(screen.getByLabelText(label)); await user.keyboard(v); };
const heading = (n: string | RegExp) => screen.findByRole('heading', { level: 1, name: n });

describe('sign-in', () => {
  it('password → authenticator code → signed in, and the password is not retained', async () => {
    let signed = false;
    const calls = mockApi({
      'GET /api/auth/me': () => (signed ? { json: ME } : { status: 401, json: { error: 'unauthenticated' } }),
      'POST /api/auth/login': { json: { step: 'mfa', challenge: 'challenge-abc-12345678901234567890' } },
      'POST /api/auth/mfa': () => { signed = true; return { json: { step: 'done' } }; },
    });
    renderApp('/library'); await heading('Sign in');
    await fill('Email', 'owner@example.test'); await fill('Password', 'a long unusual passphrase 42');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Your code');
    expect((calls.find((c) => c.path === '/api/auth/login')!.body)).toEqual({ email: 'owner@example.test', password: 'a long unusual passphrase 42' });
    await fill('Authenticator code', '123456'); await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await heading('Library')).toBeTruthy();                               // returned to the page they asked for
    expect(JSON.stringify(calls.find((c) => c.path === '/api/auth/mfa')!.body)).not.toContain('passphrase');
  });

  it('first sign-in: shows the QR + key, verifies, then shows recovery codes once before continuing', async () => {
    let signed = false;
    const codes = Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}`);
    const calls = mockApi({
      'GET /api/auth/me': () => (signed ? { json: ME } : { status: 401, json: {} }),
      'POST /api/auth/login': { json: { step: 'enroll', challenge: 'challenge-abc-12345678901234567890' } },
      'POST /api/auth/totp/setup': { json: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x', qr: 'data:image/svg+xml;base64,PHN2Zy8+' } },
      'POST /api/auth/totp/confirm': () => { signed = true; return { json: { step: 'done', recoveryCodes: codes } }; },
    });
    renderApp('/login'); await heading('Sign in');
    await fill('Email', 'owner@example.test'); await fill('Password', 'a long unusual passphrase 42'); await user.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Add your authenticator');
    expect(screen.getByRole('img', { name: /QR code/ }).getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    await fill('Code from the app', '654321'); await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await heading('Save your recovery codes');
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(codes);
    const go = screen.getByRole('button', { name: 'Continue' }); expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'I have saved these codes' }));
    expect((go as HTMLButtonElement).disabled).toBe(false); await user.click(go);
    expect(await heading('Library')).toBeTruthy();
    expect(calls.map((c) => c.path)).toContain('/api/auth/totp/setup');
  });

  it('uses a recovery code when asked', async () => {
    const calls = mockApi(signedOut({ 'POST /api/auth/login': { json: { step: 'mfa', challenge: 'challenge-abc-12345678901234567890' } }, 'POST /api/auth/mfa': { status: 401, json: { error: 'invalid_code', message: 'That code is not valid.' } } }));
    renderApp('/login'); await heading('Sign in');
    await fill('Email', 'o@example.test'); await fill('Password', 'x'.repeat(14)); await user.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Your code'); await user.click(screen.getByRole('button', { name: 'Use a recovery code' })); await heading('Recovery code');
    await fill('Recovery code', 'abcde-fghij'); await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'That code is not valid.');
    expect(calls.find((c) => c.path === '/api/auth/mfa')!.body).toMatchObject({ code: 'abcde-fghij' });
  });

  it('shows clear, safe errors: wrong credentials, lockout with a time, offline', async () => {
    mockApi(signedOut({ 'POST /api/auth/login': { status: 401, json: { error: 'invalid_credentials', message: 'Email or password is incorrect.' } } }));
    renderApp('/login'); await heading('Sign in');
    await fill('Email', 'o@example.test'); await fill('Password', 'x'.repeat(14)); await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is incorrect.');
    vi.unstubAllGlobals(); mockApi(signedOut({ 'POST /api/auth/login': { status: 429, json: { error: 'locked', message: 'x', retryAfter: 900 } } }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Too many attempts. Try again in 15 minutes.'));
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Cannot reach the server/));
  });

  it('the password field can be revealed and is never autofilled as plain text by default', async () => {
    mockApi(signedOut()); renderApp('/login'); await heading('Sign in');
    const pw = screen.getByLabelText('Password') as HTMLInputElement; expect(pw.type).toBe('password'); expect(pw.autocomplete).toBe('current-password');
    await user.click(screen.getByRole('button', { name: 'Show password' })); expect(pw.type).toBe('text');
  });

  it('every step is accessible (axe)', async () => {
    mockApi(signedOut({ 'POST /api/auth/login': { json: { step: 'enroll', challenge: 'challenge-abc-12345678901234567890' } }, 'POST /api/auth/totp/setup': { json: { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://x', qr: 'data:image/svg+xml;base64,PHN2Zy8+' } } }));
    const { container } = renderApp('/login'); await heading('Sign in'); expect(await axe(container)).toHaveNoViolations();
    await fill('Email', 'o@example.test'); await fill('Password', 'x'.repeat(14)); await user.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Add your authenticator'); expect(await axe(container)).toHaveNoViolations();
  }, 30_000);
});
