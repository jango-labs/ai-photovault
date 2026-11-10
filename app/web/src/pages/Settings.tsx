import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api, describeUserAgent, type SessionInfo, type SystemStatus } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Field, SegmentedControl, Slider, Switch } from '../ui/controls';
import { ErrorState, Hairline, useToast } from '../ui/feedback';
import { Label, Meta } from '../ui/typography';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function Block({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return <section className="jb-section" aria-label={title} style={{ borderTop: '1px solid var(--line)', padding: '24px 0' }}><div><Label>{title}</Label>{note && <Meta>{note}</Meta>}</div>{children}</section>;
}

export function AccountPage() {
  const { user, signOut } = useAuth();
  const qc = useQueryClient(); const toast = useToast();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionInfo[] }>('GET', '/api/auth/sessions').then((r) => r.sessions) });
  const revoke = useMutation({ mutationFn: (id: string) => api('DELETE', `/api/auth/sessions/${id}`), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sessions'] }); toast({ kind: 'ok', title: 'Session signed out' }); } });
  const revokeOthers = useMutation({ mutationFn: () => api<{ revoked: number }>('POST', '/api/auth/sessions/revoke-others', {}), onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['sessions'] }); toast({ kind: 'ok', title: `Signed out ${r.revoked} other device${r.revoked === 1 ? '' : 's'}` }); } });
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const changePassword = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await api('POST', '/api/auth/password', { current: cur, next }); setCur(''); setNext(''); toast({ kind: 'ok', title: 'Password changed', body: 'Your other devices were signed out.' }); void qc.invalidateQueries({ queryKey: ['sessions'] }); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Something went wrong.'); } finally { setBusy(false); } };
  return (
    <div className="jb-page" style={{ maxWidth: 880, marginInline: 0 }}>
      <PageHeader eyebrow="Settings" title="Account" lede="You are the only user of this library. Everything here is private to this installation." actions={<Button variant="outline" onClick={() => void signOut()}>Sign out</Button>} />
      <Block title="Profile"><dl className="jb-kv"><dt>Email</dt><dd>{user?.email}</dd><dt>Two-step verification</dt><dd>{user?.totpEnabled ? 'On (authenticator app)' : 'Not set up'}</dd><dt>Time zone</dt><dd>{user?.timezone}</dd></dl></Block>
      <Block title="Where you are signed in" note="Sessions end after 30 days, or 14 days without use.">
        {sessions.isLoading && <Hairline label="Loading sessions" />}
        {sessions.isError && <ErrorState level={3} title="Could not load your sessions" onRetry={() => void sessions.refetch()}>Nothing has been changed.</ErrorState>}
        {sessions.data && (
          <div className="jb-list" role="list">
            {sessions.data.map((s) => (
              <div key={s.id} className="jb-list__row" role="listitem">
                <div style={{ display: 'grid', gap: 3 }}><span style={{ color: 'var(--text)' }}>{describeUserAgent(s.userAgent)}{s.current && <span className="jb-status jb-status--ok" style={{ marginLeft: 10 }}>This device</span>}</span>
                  <span className="t-meta t-num">{s.ip ?? 'unknown address'} · last active {when(s.lastSeenAt)} · signed in {when(s.createdAt)}</span></div>
                {!s.current && <Button size="sm" variant="outline" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>Sign out</Button>}
              </div>
            ))}
          </div>
        )}
        {sessions.data && sessions.data.length > 1 && <div><Button variant="outline" onClick={() => revokeOthers.mutate()} disabled={revokeOthers.isPending}>Sign out all other devices</Button></div>}
      </Block>
      <Block title="Password" note="Changing it signs out every other device.">
        <form onSubmit={changePassword} className="jb-stack" style={{ maxWidth: 420 }} noValidate>
          <Field label="Current password" type="password" value={cur} onChange={setCur} autoComplete="current-password" />
          <Field label="New password" type="password" value={next} onChange={setNext} autoComplete="new-password" hint="At least 12 characters. A long passphrase is best." />
          {err && <p className="t-body" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
          <div><Button variant="secondary" type="submit" disabled={busy || !cur || next.length < 12}>Change password</Button></div>
        </form>
      </Block>
    </div>
  );
}

export function DisplayPage() {
  const { settings, updateSettings } = useAuth();
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  if (!settings) return null;
  const save = async (p: Parameters<typeof updateSettings>[0]) => { setSaving(true); try { await updateSettings(p); } catch { toast({ kind: 'error', title: 'Could not save that setting', body: 'Your previous choice was kept.' }); } finally { setSaving(false); } };
  return (
    <div className="jb-page" style={{ maxWidth: 880, marginInline: 0 }}>
      <PageHeader eyebrow="Settings" title="Display" lede="How photographs are presented. These settings follow you to every device." />
      <Block title="Photo viewer background" note="Neutral grey is the default: a teal surround can bias how you judge colour in a finished edit.">
        <SegmentedControl label="Photo viewer background" value={settings.viewerSurface} onChange={(v) => void save({ viewerSurface: v })} options={[{ value: 'neutral', label: 'Neutral grey' }, { value: 'teal', label: 'Teal' }]} />
        <div className="ds__cols" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', maxWidth: 520 }}>
          {(['neutral', 'teal'] as const).map((s) => (
            <div key={s} className="jb-swatch-choice"><div className="jb-swatch" style={{ background: s === 'neutral' ? '#2e2e2e' : 'var(--abyss-0)', outline: settings.viewerSurface === s ? '2px solid var(--aqua)' : undefined }}>
              <img src="/fixtures/p05.jpg" alt={`Sample photograph on the ${s === 'neutral' ? 'neutral grey' : 'teal'} background`} style={{ maxHeight: 72, maxWidth: '100%', objectFit: 'contain' }} /></div>
              <span className="t-meta">{s === 'neutral' ? 'Neutral grey (#2E2E2E)' : 'Teal (#011D1C)'}{settings.viewerSurface === s ? ' · current' : ''}</span></div>
          ))}
        </div>
      </Block>
      <Block title="Library"><Slider label="Thumbnail size" value={settings.thumbSize} min={120} max={420} step={10} onChange={(v) => void save({ thumbSize: v })} format={(v) => `${v}px`} />
        <Switch checked={settings.aiScoresVisible} onChange={(v) => void save({ aiScoresVisible: v })} label="Show AI scores on thumbnails" /></Block>
      <span role="status" className="t-meta" style={{ minHeight: 18 }}>{saving ? 'Saving…' : ''}</span>
    </div>
  );
}

interface OpsStatus { services: Array<{ name: string; instance: string; version: string | null; lastSeenAt: string; ageSeconds: number; status: 'running' | 'late' | 'stopped' }>; backups: { lastVerifiedDump: { at: string | null; ageSeconds: number | null; bytes: number | null } | null; lastRestoreTest: { at: string | null; ageSeconds: number | null } | null; stale: boolean }; offsite?: { healthy: boolean; problems: string[]; checks: Array<{ key: string; label: string; state: 'ok' | 'stale' | 'failed' | 'never'; lastOkAgeSeconds: number | null; lastFailure: { at: string | null; message: string } | null }> } }
interface StorageInfo { database: { bytes: number; tables: Array<{ name: string; bytes: number; rows: number }> }; dirs: Array<{ key: string; label: string; path: string | null; bytes: number | null; files: number | null; freeBytes: number | null; totalBytes: number | null; truncated: boolean }> }
const mb = (n: number | null) => (n === null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const ago = (s: number | null) => (s === null ? 'never' : s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172_800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`);
const SERVICE_LABEL: Record<string, string> = { worker: 'Worker (previews, analysis, Instagram sync)', scheduler: 'Publisher (mock only)' };

interface WorkStatus {
  queues: Array<{ kind: string; queued: number; running: number; failed24h: number; dead: number; oldestQueuedSeconds: number | null }>;
  failures: Array<{ kind: string; state: string; at: string; error: string }>;
  imports: { last: { mode: string; state: string; startedAt: string; finishedAt: string | null; counters: Record<string, number>; error: string | null } | null; running: boolean };
  previews: { pending: number; failed: number };
  publishing: { scheduled: number; nextAt: string | null; publishing: number; failed7d: number; overdue: number };
  instagram: { connected: boolean; status: string | null; daysLeft: number | null; username: string | null } | null;
  problems: string[];
}
const JOB_LABEL: Record<string, string> = { 'derive.preview': 'Previews', 'ai.analyze': 'AI analysis', 'embed.image': 'Visual similarity', 'embed.text': 'Meaning search index', 'ig.sync': 'Instagram sync', 'ig.match': 'Instagram matching', 'ig.token.refresh': 'Instagram token renewal' };

interface AuditEvent { id: number; at: string; action: string; ip: string | null }
const AUDIT_LABEL: Record<string, string> = {
  'auth.signed_in': 'Signed in', 'auth.authenticator_enrolled': 'Authenticator set up', 'auth.password_failed': 'Wrong password entered', 'auth.second_factor_failed': 'Wrong code entered',
  'auth.locked_out': 'Sign-in locked after repeated failures', 'auth.password_changed': 'Password changed', 'auth.password_change_refused': 'Password change refused (wrong current password)',
  'post:auth/logout': 'Signed out', 'post:auth/password': 'Password change requested', 'post:auth/sessions/revoke-others': 'Other devices signed out', 'delete:auth/sessions/:id': 'A session was ended',
  'post:instagram/connect': 'Instagram connection started', 'get:instagram/oauth/callback': 'Instagram account connected', 'post:instagram/disconnect': 'Instagram disconnected',
  'post:ai/queue/pause': 'AI analysis paused', 'post:ai/queue/resume': 'AI analysis resumed', 'post:ai/queue/cancel': 'Waiting AI jobs cancelled', 'post:ai/queue/prioritize': 'AI queue order changed',
  'post:imports/runs': 'Import started', 'post:imports/runs/:id/cancel': 'Import cancelled', 'post:imports/review/:id': 'Import review decision', 'post:imports/jobs/retry': 'Failed import jobs retried',
  'post:publishing/drafts/:id/approve': 'Post approved', 'post:publishing/drafts/:id/schedule': 'Post scheduled', 'post:publishing/schedule/:id/cancel': 'Scheduled post cancelled',
  'post:publishing/drafts/:id/ready': 'Draft marked ready', 'post:publishing/drafts/:id/unready': 'Draft moved back to editing', 'post:publishing/drafts/:id/cancel': 'Draft cancelled', 'post:publishing/drafts/:id/reopen': 'Draft reopened',
};

function SecurityLog() {
  const a = useQuery({ queryKey: ['system', 'audit'], queryFn: () => api<{ events: AuditEvent[] }>('GET', '/api/system/audit?limit=25'), refetchInterval: 60_000 });
  return (
    <Block title="Security log" note="Who did what to this account, and when. It cannot be edited or deleted, and never records passwords, codes or the contents of posts.">
      {a.isError ? <Meta>The log could not be read.</Meta> : !a.data ? <Hairline label="Loading" /> : a.data.events.length === 0 ? <Meta>Nothing recorded yet.</Meta> : (
        <dl className="jb-kv">{a.data.events.map((e) => <><dt key={`${e.id}-k`}>{when(e.at)}</dt><dd key={`${e.id}-v`} data-status={/failed|refused|locked/.test(e.action) ? 'failed' : undefined}>{AUDIT_LABEL[e.action] ?? e.action}{e.ip ? ` · ${e.ip}` : ''}</dd></>)}</dl>)}
    </Block>
  );
}

/** Everything that needs attention, first on the page: lost background processes lead, then the work queues. */
function NeedsAttention() {
  const w = useQuery({ queryKey: ['system', 'work'], queryFn: () => api<WorkStatus>('GET', '/api/system/work'), refetchInterval: 20_000 });
  const problems = w.data?.problems ?? [];
  if (w.isError) return <section className="jb-section" aria-label="Needs attention"><Label>Needs attention</Label><Meta>Work status could not be read.</Meta></section>;
  if (!w.data) return <section className="jb-section" aria-label="Needs attention"><Label>Needs attention</Label><Hairline label="Loading" /></section>;
  if (problems.length === 0) return <section className="jb-section" aria-label="Needs attention"><Label>Needs attention</Label><p className="t-body" role="status">Nothing needs attention: the worker is reporting and no work is stuck.</p></section>;
  return (
    <section aria-label="Needs attention" role="alert" style={{ border: '1px solid var(--warn)', borderRadius: 12, padding: '16px 18px', display: 'grid', gap: 8, background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}>
      <Label>Needs attention · {problems.length}</Label>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>{problems.map((p) => <li key={p} className="t-body" style={{ color: 'var(--text)' }}>{p}</li>)}</ul>
    </section>
  );
}

function WorkBlocks() {
  const w = useQuery({ queryKey: ['system', 'work'], queryFn: () => api<WorkStatus>('GET', '/api/system/work'), refetchInterval: 20_000 });
  const d = w.data;
  return (
    <>
      <Block title="Work queues">
        {!d ? <Hairline label="Loading" /> : d.queues.length === 0 ? <Meta>No background work has been queued.</Meta> : (
          <dl className="jb-kv">{d.queues.map((x) => <><dt key={`${x.kind}-k`}>{JOB_LABEL[x.kind] ?? x.kind}</dt><dd key={`${x.kind}-v`}>{x.queued} waiting · {x.running} running{x.failed24h ? ` · ${x.failed24h} failed in 24 h` : ''}{x.dead ? ` · ${x.dead} gave up` : ''}</dd></>)}</dl>)}
        {d && d.previews.pending + d.previews.failed > 0 && <p className="t-meta">{d.previews.pending} photographs waiting for a preview{d.previews.failed ? `, ${d.previews.failed} failed` : ''}.</p>}
        {d && d.failures.length > 0 && <details><summary className="t-meta">Recent failures</summary><dl className="jb-kv">{d.failures.map((f) => <><dt key={`${f.at}-${f.kind}-k`}>{JOB_LABEL[f.kind] ?? f.kind} · {when(f.at)}</dt><dd key={`${f.at}-${f.kind}-v`}>{f.error || f.state}</dd></>)}</dl></details>}
      </Block>
      <SecurityLog />
      <Block title="Imports and publishing">
        {!d ? <Hairline label="Loading" /> : (
          <dl className="jb-kv">
            <dt>Last import</dt><dd>{d.imports.last ? `${d.imports.last.state.toLowerCase()} · ${d.imports.last.mode.toLowerCase()} · ${when(d.imports.last.startedAt)}` : 'None yet'}</dd>
            <dt>Scheduled posts</dt><dd>{d.publishing.scheduled ? `${d.publishing.scheduled}, next ${d.publishing.nextAt ? when(d.publishing.nextAt) : '—'}` : 'None'}</dd>
            <dt>Instagram</dt><dd>{d.instagram ? (d.instagram.connected ? `Connected${d.instagram.username ? ` as @${d.instagram.username}` : ''}${d.instagram.daysLeft !== null ? ` · token valid ${Math.max(0, d.instagram.daysLeft)} more days` : ''}` : `Not connected (${(d.instagram.status ?? '').toLowerCase()})`) : 'Not connected'}</dd>
          </dl>)}
      </Block>
    </>
  );
}

function Housekeeping() {
  const ops = useQuery({ queryKey: ['system', 'ops'], queryFn: () => api<OpsStatus>('GET', '/api/system/ops'), refetchInterval: 20_000 });
  const dr = useQuery({ queryKey: ['system', 'data-root'], queryFn: () => api<{ configured: boolean; ready?: boolean; reason?: string | null; mountedAt?: string | null }>('GET', '/api/system/data-root'), refetchInterval: 20_000 });
  const st = useQuery({ queryKey: ['system', 'storage'], queryFn: () => api<StorageInfo>('GET', '/api/system/storage'), staleTime: 60_000 });
  const o = ops.data; const s = st.data;
  return (
    <>
      <WorkBlocks />
      <Block title="Background processes">
        {ops.isError ? <Meta>Their status could not be read.</Meta> : !o ? <Hairline label="Loading" /> : o.services.length === 0 ? <Meta>None has reported in. Start the worker with <code>npm run worker</code>.</Meta> : (
          <dl className="jb-kv">{o.services.map((x) => <><dt key={`${x.name}-k`}>{SERVICE_LABEL[x.name] ?? x.name}</dt><dd key={`${x.name}-v`} data-status={x.status}>{x.status === 'running' ? 'Running' : x.status === 'late' ? 'Late' : 'Not running'} · last seen {ago(x.ageSeconds)}{x.version ? ` · v${x.version}` : ''}</dd></>)}</dl>)}
      </Block>
      <Block title="Backups">
        <Meta>PhotoVault does not back itself up. Make a database backup with <code>scripts/backup.sh</code> (see BACKUP and RESTORE in the documentation) and keep a copy on another disk. Your original photographs are never modified or copied by PhotoVault: back those up separately.</Meta>
      </Block>
      {dr.data?.configured && (
        <Block title="Photo drive (thumbnails and previews)">
          <dl className="jb-kv"><dt>State</dt><dd data-status={dr.data.ready ? 'ok' : 'failed'}>{dr.data.ready ? `Connected${dr.data.mountedAt ? ` · ${dr.data.mountedAt}` : ''}` : 'NOT AVAILABLE'}</dd></dl>
          {!dr.data.ready && <p role="alert" className="t-meta" style={{ color: 'var(--warn)' }}>The photo drive is not available: {dr.data.reason}. Previews are not shown and no new previews are made until it is connected; your library data is not affected, and background work resumes by itself.</p>}
        </Block>)}
      <Block title="Storage">
        {st.isError ? <Meta>Storage could not be measured.</Meta> : !s ? <Hairline label="Measuring" /> : (
          <>
            <dl className="jb-kv"><dt>Database</dt><dd>{mb(s.database.bytes)}</dd>{s.dirs.filter((d) => d.path).map((d) => <><dt key={`${d.key}-k`}>{d.label}</dt><dd key={`${d.key}-v`}>{mb(d.bytes)} · {d.files?.toLocaleString('en-GB')} files{d.truncated ? ' (partial count)' : ''} · {mb(d.freeBytes)} free on its disk</dd></>)}</dl>
            {s.dirs.filter((d) => d.freeBytes !== null && d.freeBytes < 10e9).map((d) => <p key={d.key} role="alert" className="t-meta" style={{ color: 'var(--warn)' }}>Less than 10 GB free where “{d.label}” lives.</p>)}
            <details><summary className="t-meta">Largest tables</summary><dl className="jb-kv">{s.database.tables.map((t) => <><dt key={`${t.name}-k`}>{t.name}</dt><dd key={`${t.name}-v`}>{mb(t.bytes)} · ~{t.rows.toLocaleString('en-GB')} rows</dd></>)}</dl></details>
          </>)}
      </Block>
    </>
  );
}

export function SystemPage() {
  const q = useQuery({ queryKey: ['system'], queryFn: () => api<SystemStatus>('GET', '/api/system/status'), refetchInterval: 15_000 });
  const d = q.data;
  return (
    <div className="jb-page" style={{ maxWidth: 880, marginInline: 0 }}>
      <PageHeader eyebrow="Settings" title="System" lede="What is running on this computer, whether it is healthy, and what needs your attention." />
      <NeedsAttention />
      {q.isError && <ErrorState level={2} title="The server did not answer" onRetry={() => void q.refetch()}>The page may be offline or your session may have ended.</ErrorState>}
      {q.isLoading && <Hairline label="Loading status" />}
      {d && (
        <>
          <Block title="Services"><dl className="jb-kv">
            <dt>API</dt><dd>{d.api.ok ? 'Running' : 'Down'} · v{d.api.version} · up {Math.round(d.api.uptimeSeconds / 60)} min · Node {d.api.node}</dd>
            <dt>Database</dt><dd>{d.database.ok ? `PostgreSQL ${d.database.version} · ${d.database.latencyMs} ms` : 'Unreachable'}</dd>
            <dt>Import</dt><dd>On demand (Imports page, after you approve the folder)</dd></dl></Block>
          <Housekeeping />
          <Block title="Safety switches"><dl className="jb-kv"><dt>Paid / hosted AI</dt><dd>Off — local analysis only; nothing leaves this computer</dd><dt>Instagram</dt><dd>Not connected</dd><dt>Photo library</dt><dd>Synthetic fixtures only; no real photographs are read</dd></dl></Block>
        </>
      )}
    </div>
  );
}
