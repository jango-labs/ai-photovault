import { Wordmark } from '../shell/Wordmark';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../ui/Button';
import { Field, Switch } from '../ui/controls';
import { Hairline } from '../ui/feedback';
import { Label } from '../ui/typography';

type Step =
  | { name: 'password' }
  | { name: 'mfa'; challenge: string; recovery: boolean }
  | { name: 'enroll'; challenge: string; secret: string; qr: string }
  | { name: 'codes'; codes: string[] };

function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'locked' || e.status === 429) return `Too many attempts. Try again in ${Math.max(1, Math.ceil((e.retryAfter ?? 900) / 60))} minutes.`;
    return e.message;
  }
  return 'Something went wrong. Please try again.';
}

/** Sign-in: password → authenticator code (or one-time recovery code). First sign-in enrols the authenticator and shows recovery codes once. */
export function LoginPage() {
  const { status, refresh } = useAuth();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/library';
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);

  if (status === 'authenticated' && step.name !== 'codes') return <Navigate to={from} replace />;

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(explain(e)); } finally { setBusy(false); } };

  const submitPassword = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const r = await api<{ step: 'mfa' | 'enroll'; challenge: string }>('POST', '/api/auth/login', { email, password });
    setPassword('');                                                 // the password is not kept in memory longer than needed
    if (r.step === 'mfa') { setStep({ name: 'mfa', challenge: r.challenge, recovery: false }); return; }
    const s = await api<{ secret: string; qr: string }>('POST', '/api/auth/totp/setup', { challenge: r.challenge });
    setStep({ name: 'enroll', challenge: r.challenge, secret: s.secret, qr: s.qr });
  }); };

  const submitCode = (e: FormEvent) => { e.preventDefault(); if (step.name !== 'mfa' && step.name !== 'enroll') return; void run(async () => {
    if (step.name === 'mfa') { await api('POST', '/api/auth/mfa', { challenge: step.challenge, code }); await refresh(); return; }
    const r = await api<{ recoveryCodes: string[] }>('POST', '/api/auth/totp/confirm', { challenge: step.challenge, code });
    setStep({ name: 'codes', codes: r.recoveryCodes }); setCode('');
  }); };

  return (
    <div className="jb-login">
      <header className="jb-login__top"><Wordmark /></header>
      <main className="jb-login__main" id="main">
        <div className="jb-login__card">
          {step.name === 'password' && (
            <form onSubmit={submitPassword} className="jb-stack" noValidate>
              <div style={{ display: 'grid', gap: 10 }}><Label>Your Intelligent Photography Library</Label><h1 className="t-display" style={{ fontSize: 'clamp(40px, 6vw, 64px)' }}>Sign in</h1></div>
              <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" inputMode="email" autoFocus name="email" />
              <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" name="password" />
              {error && <p className="t-body" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
              <Button variant="primary" type="submit" disabled={busy || !email || !password}>Continue</Button>
              {busy && <Hairline label="Signing in" />}
            </form>
          )}

          {step.name === 'mfa' && (
            <form onSubmit={submitCode} className="jb-stack" noValidate>
              <div style={{ display: 'grid', gap: 10 }}><Label>Step 2 of 2</Label><h1 className="t-display" style={{ fontSize: 'clamp(36px, 5vw, 52px)' }}>{step.recovery ? 'Recovery code' : 'Your code'}</h1>
                <p className="t-body">{step.recovery ? 'Enter one of the one-time recovery codes you saved. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}</p></div>
              <Field label={step.recovery ? 'Recovery code' : 'Authenticator code'} value={code} onChange={setCode} autoComplete="one-time-code" inputMode={step.recovery ? 'text' : 'numeric'} autoFocus maxLength={step.recovery ? 16 : 6} name="code" />
              {error && <p className="t-body" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
              <div className="jb-row"><Button variant="primary" type="submit" disabled={busy || code.length < 6}>Sign in</Button>
                <Button variant="ghost" onClick={() => { setStep({ ...step, recovery: !step.recovery }); setCode(''); setError(null); }}>{step.recovery ? 'Use authenticator' : 'Use a recovery code'}</Button>
                <Button variant="ghost" onClick={() => { setStep({ name: 'password' }); setCode(''); setError(null); }}>Back</Button></div>
            </form>
          )}

          {step.name === 'enroll' && (
            <form onSubmit={submitCode} className="jb-stack" noValidate>
              <div style={{ display: 'grid', gap: 10 }}><Label>First sign-in · set up two-step verification</Label><h1 className="t-display" style={{ fontSize: 'clamp(32px, 5vw, 44px)' }}>Add your authenticator</h1>
                <p className="t-body">Scan this code with an authenticator app (1Password, Authy, Google Authenticator, …), then enter the 6-digit code it shows.</p></div>
              <div className="jb-row" style={{ alignItems: 'flex-start', gap: 20 }}>
                <img className="jb-qr" src={step.qr} alt="QR code for your authenticator app" />
                <div style={{ display: 'grid', gap: 6, minWidth: 0 }}><span className="label-sm">Can’t scan? Enter this key</span><code className="t-num" style={{ color: 'var(--text)', wordBreak: 'break-all', fontSize: 13 }}>{step.secret.match(/.{1,4}/g)?.join(' ')}</code></div>
              </div>
              <Field label="Code from the app" value={code} onChange={setCode} autoComplete="one-time-code" inputMode="numeric" maxLength={6} autoFocus name="code" />
              {error && <p className="t-body" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
              <div className="jb-row"><Button variant="primary" type="submit" disabled={busy || code.length !== 6}>Verify and sign in</Button>
                <Button variant="ghost" onClick={() => { setStep({ name: 'password' }); setCode(''); setError(null); }}>Back</Button></div>
            </form>
          )}

          {step.name === 'codes' && (
            <div className="jb-stack">
              <div style={{ display: 'grid', gap: 10 }}><Label>Two-step verification is on</Label><h1 className="t-display" style={{ fontSize: 'clamp(32px, 5vw, 44px)' }}>Save your recovery codes</h1>
                <p className="t-body">If you lose your authenticator, each of these codes signs you in once. They are shown only now. Store them somewhere safe (a password manager).</p></div>
              <div className="jb-codes" role="list" aria-label="Recovery codes">{step.codes.map((c) => <span key={c} role="listitem">{c}</span>)}</div>
              <div className="jb-row"><Button variant="outline" icon="external" onClick={() => void navigator.clipboard?.writeText(step.codes.join('\n'))}>Copy codes</Button></div>
              <Switch checked={saved} onChange={setSaved} label="I have saved these codes" />
              <div><Button variant="primary" disabled={!saved} onClick={async () => { await refresh(); nav(from, { replace: true }); }}>Continue</Button></div>
            </div>
          )}
        </div>
      </main>
      <footer className="jb-login__foot">Self-hosted · your photographs stay on your own computer</footer>
    </div>
  );
}
