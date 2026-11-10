import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError } from '../api/client';
import { disconnectIg, fetchIgConnection, startIgConnect } from '../api/instagram';
import { Button } from '../ui/Button';
import { Meta } from '../ui/typography';
import { useToast } from '../ui/feedback';

const REASONS: Record<string, string> = {
  bad_state: 'The connection request expired or did not start here. Start it again.', denied: 'Instagram did not grant access.', exchange_failed: 'Instagram did not accept the request. Nothing was stored.',
  ineligible: 'That is a personal Instagram account. Only Business or Creator accounts can use the API.', unavailable: 'Connecting to the real Instagram has not been approved yet.', invalid: 'The connection request was not valid.',
};

/** Whether this library is connected to Instagram, what is missing if not, and why: no pretending. */
export function ConnectionCard() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['instagram', 'connection'], queryFn: fetchIgConnection, staleTime: 15_000 });
  const connect = useMutation({ mutationFn: startIgConnect, onSuccess: (r) => { window.location.assign(r.url); }, onError: (e) => toast({ kind: 'error', title: 'Could not start the connection', body: e instanceof ApiError ? e.message : undefined }) });
  const disconnect = useMutation({ mutationFn: disconnectIg, onSuccess: () => { toast({ kind: 'ok', title: 'Disconnected', body: 'The stored token was removed.' }); void qc.invalidateQueries({ queryKey: ['instagram'] }); }, onError: () => toast({ kind: 'error', title: 'Could not disconnect' }) });
  useEffect(() => {                       // the redirect back from Instagram
    const p = new URLSearchParams(window.location.search); const c = p.get('connection'); if (!c) return;
    toast(c === 'ok' ? { kind: 'ok', title: 'Instagram connected' } : { kind: 'error', title: 'Instagram was not connected', body: REASONS[p.get('reason') ?? ''] ?? 'Something went wrong. Nothing was stored.' });
    void qc.invalidateQueries({ queryKey: ['instagram'] });
    const u = new URL(window.location.href); u.searchParams.delete('connection'); u.searchParams.delete('reason'); window.history.replaceState(null, '', u.pathname + u.search);
  }, [qc, toast]);
  const c = q.data;
  if (q.isError) return <section className="jb-ig__account" aria-label="Connection"><Meta>The connection status could not be read.</Meta></section>;
  if (!c) return null;
  const a = c.account;
  return (
    <section className="jb-ig__account" aria-label="Connection" style={{ marginBottom: 14 }}>
      <p><b>Instagram connection: {c.connected ? 'connected' : a?.status === 'EXPIRED' ? 'expired' : 'not connected'}</b>{c.mode === 'sandbox' ? ' · SANDBOX on this computer (no real account)' : c.mode === 'live' ? ' · live' : ''}</p>
      {a && a.status !== 'DISCONNECTED' && <Meta>@{a.username ?? 'account'} · {a.type?.toLowerCase().replace('_', ' ') ?? 'account'}{a.daysLeft !== null ? ` · token valid for ${Math.max(0, a.daysLeft)} more day${a.daysLeft === 1 ? '' : 's'}` : ''}</Meta>}
      {c.configured && c.publishingPermission === false && <p className="t-meta" data-testid="history-only">Access requested: <b>read-only history</b> (profile and your posts). Publishing and scheduling are not enabled and cannot be used.</p>}
      {c.warning && <p role="alert" className="t-meta" style={{ color: 'var(--warn)' }}>{c.warning}</p>}
      {!c.configured && <><p className="t-meta">Not set up. Still needed: {c.missing.join('; ')}. Nothing has been sent to Instagram, and posting is off.</p></>}
      <div className="jb-row">
        {c.connected ? <Button size="sm" variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Disconnect</Button>
          : <Button size="sm" variant="outline" onClick={() => connect.mutate()} disabled={!c.configured || connect.isPending}>{a?.status === 'EXPIRED' ? 'Connect again' : 'Connect Instagram'}</Button>}
      </div>
      <details><summary className="t-meta">What is required to connect</summary>
        <ul className="t-meta">{c.eligibility.map((e) => <li key={e}>{e}</li>)}</ul>{c.redirectUri && <Meta>Redirect address registered in the Meta app: <code>{c.redirectUri}</code></Meta>}
      </details>
    </section>
  );
}
