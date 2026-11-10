import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { PageHeader } from '../shell/PageHeader';
import { Button, LinkButton } from '../ui/Button';
import { SegmentedControl } from '../ui/controls';
import { EmptyState, ErrorState, Hairline, Skeleton, useToast } from '../ui/feedback';
import { Label, Meta } from '../ui/typography';
import { cancelRun, decideReview, fetchReview, fetchRun, fetchRuns, fetchStatus, retryFailed, startRun, type Counters, type RunRow, type SourceInfo } from './api';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-GB');
const mb = (b: number | undefined) => `${((b ?? 0) / 1e6).toFixed(1)} MB`;
const STATE_LABEL: Record<RunRow['state'], string> = { RUNNING: 'Running', COMPLETED: 'Completed', FAILED: 'Failed', INTERRUPTED: 'Interrupted', CANCELLED: 'Cancelled' };

function summary(c: Partial<Counters>): string {
  const parts = [`${n(c.scanned)} scanned`, c.new ? `${n(c.new)} new` : '', c.newVersions ? `${n(c.newVersions)} new version${c.newVersions === 1 ? '' : 's'}` : '', c.moved ? `${n(c.moved)} moved` : '', c.duplicateFiles ? `${n(c.duplicateFiles)} duplicate file${c.duplicateFiles === 1 ? '' : 's'}` : '',
    c.versionReview ? `${n(c.versionReview)} to review` : '', c.unchanged ? `${n(c.unchanged)} unchanged` : '', c.missing ? `${n(c.missing)} missing` : '', c.errors ? `${n(c.errors)} error${c.errors === 1 ? '' : 's'}` : ''];
  return parts.filter(Boolean).join(' · ');
}

/** The permanent source: name, availability, what was found and imported, and the scan schedule. */
function SourceDetails({ info }: { info: SourceInfo }) {
  const rows: Array<[string, string]> = [
    ['Name', info.name], ['Type', `${info.type} · ${info.mode}`],
    ['Availability', info.available ? 'Available' : `Not available${info.unavailableReason ? ` — ${info.unavailableReason}` : ''}`],
    ['Photographs found', info.discovered === null ? 'Not scanned yet' : n(info.discovered)], ['Imported', n(info.imported)], ['Skipped', info.discovered === null ? '—' : n(info.skipped)],
    ['Last scan', info.lastScanAt ? when(info.lastScanAt) : 'Never'],
    ['Next scan', info.scanning ? 'Scanning now' : info.scanIntervalMinutes === 0 ? 'Scheduled scanning is off' : info.nextScanAt ? when(info.nextScanAt) : 'Waiting for the folder to be available'],
  ];
  const l = info.lastScan;
  return (
    <div style={{ display: 'grid', gap: 8 }} aria-label="Source details">
      <dl className="t-meta" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', margin: 0 }}>
        {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd style={{ margin: 0, color: 'var(--text)', overflowWrap: 'anywhere' }} className="t-num">{v}</dd></div>)}
      </dl>
      {l && <Meta className="t-num">Last scan: {n(l.new)} new · {n(l.unchanged)} unchanged · {n(l.moved)} moved or renamed · {n(l.skipped)} skipped · {n(l.failed)} failed{l.duplicates ? ` · ${n(l.duplicates)} duplicate${l.duplicates === 1 ? '' : 's'}` : ''}</Meta>}
      {!info.available && <p className="t-meta" role="status">Scans are paused while the folder is unavailable. Nothing in your library is removed.</p>}
      {info.lastError && <p className="t-meta" role="alert">The last scan did not finish: {info.lastError}</p>}
    </div>
  );
}

/** Imports workspace: where the source stands, what the last runs did, what is still being processed, and what needs a decision. */
export function ImportsPage() {
  const qc = useQueryClient(); const toast = useToast();
  const status = useQuery({ queryKey: ['imports', 'status'], queryFn: fetchStatus, refetchInterval: (q) => (q.state.data?.lastRun?.state === 'RUNNING' || (q.state.data?.queue.derivatives.pending ?? 0) > 0 ? 2000 : 15_000) });
  const runs = useQuery({ queryKey: ['imports', 'runs'], queryFn: fetchRuns, refetchInterval: status.data?.lastRun?.state === 'RUNNING' ? 2000 : false });
  const review = useQuery({ queryKey: ['imports', 'review'], queryFn: fetchReview });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['imports'] }); void qc.invalidateQueries({ queryKey: ['library'] }); };
  const start = useMutation({
    mutationFn: startRun, onSuccess: () => refresh(),
    onError: (e) => toast({ kind: e instanceof ApiError && e.code === 'not_approved' ? 'warn' : 'error', title: e instanceof ApiError && e.code === 'not_approved' ? 'Not approved yet' : 'The import did not start', body: e instanceof ApiError ? e.message : 'Try again.' }),
  });
  const cancel = useMutation({ mutationFn: cancelRun, onSuccess: refresh });
  const retry = useMutation({ mutationFn: retryFailed, onSuccess: (r) => { refresh(); toast({ kind: 'ok', title: `${r.requeued} job${r.requeued === 1 ? '' : 's'} queued again` }); } });
  const decide = useMutation({ mutationFn: (v: { id: string; d: Parameters<typeof decideReview>[1] }) => decideReview(v.id, v.d), onSuccess: refresh, onError: () => toast({ kind: 'error', title: 'That decision could not be saved' }) });

  const s = status.data; const last = s?.lastRun; const running = last?.state === 'RUNNING';
  const q = s?.queue; const total = (q?.derivatives.pending ?? 0) + (q?.derivatives.ready ?? 0) + (q?.derivatives.failed ?? 0);
  return (
    <div className="jb-page" style={{ display: 'grid', gap: 28 }}>
      <PageHeader eyebrow="Workspace" title="Imports" lede="What has been found in your export folder, what is being prepared, and what needs your decision. Importing never changes a photograph file." />
      {status.isError ? <ErrorState title="Import status could not be loaded" onRetry={() => void status.refetch()} /> : !s ? <Skeleton height={140} /> : (
        <section className="jb-section" aria-label="Source">
          <Label>Source folder</Label>
          <p className="t-body" style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>{s.source.configured ?? 'Not configured'}</p>
          {!s.source.configured ? <Meta>Set <code>PHOTOVAULT_INGEST_DIR</code> for the server to choose the folder that holds your finished JPEG exports (<code>YYYY/Location/photo.jpg</code>).</Meta>
            : !s.source.dryRunApproved && !s.source.applyApproved ? <p className="t-meta" role="status">Waiting for your approval. Nothing in this folder has been opened, listed or scanned. To approve it, run <code>npm run ingest:approve -- --path "{s.source.configured}" --modes dry-run</code> on this computer (a dry run only reports what it would do).</p>
            : <Meta>Approved for: {[s.source.dryRunApproved && 'dry run', s.source.applyApproved && 'import'].filter(Boolean).join(' and ')}.{!s.source.previewsDirectory && ' Previews cannot be generated until a previews directory is configured.'}</Meta>}
          {s.source.info && <SourceDetails info={s.source.info} />}
          <div className="jb-row">
            <Button variant="outline" disabled={!s.source.dryRunApproved || running || start.isPending} onClick={() => start.mutate('DRY_RUN')}>Dry run</Button>
            <Button variant="primary" disabled={!s.source.applyApproved || running || start.isPending} onClick={() => start.mutate('APPLY')}>Import</Button>
            {running && last && <Button variant="ghost" onClick={() => cancel.mutate(last.id)}>Cancel</Button>}
          </div>
          {running && last && (
            <div role="status" aria-live="polite" style={{ display: 'grid', gap: 6 }}>
              <Hairline label="Import in progress" />
              <Meta className="t-num">{last.mode === 'DRY_RUN' ? 'Dry run' : 'Import'} running · {summary(last.counters)}</Meta>
            </div>
          )}
        </section>
      )}

      <section className="jb-section" aria-label="Processing">
        <Label>Processing</Label>
        {!q ? <Skeleton height={60} /> : (
          <>
            <p className="t-body" role="status">{total === 0 ? 'No photographs are waiting for previews.' : `${n(q.derivatives.ready)} of ${n(total)} photographs have previews${q.derivatives.pending ? `, ${n(q.derivatives.pending)} waiting` : ''}${q.derivatives.failed ? `, ${n(q.derivatives.failed)} failed` : ''}.`}</p>
            {total > 0 && <Hairline value={q.derivatives.ready / total} label="Previews prepared" />}
            <Meta>{q.workerSeenAt ? `Worker last seen ${when(q.workerSeenAt)}.` : 'No worker has reported in. Start one with `npm run worker` to prepare previews.'}{q.derivatives.missing ? ` ${n(q.derivatives.missing)} source file${q.derivatives.missing === 1 ? ' is' : 's are'} no longer on disk (records kept).` : ''}</Meta>
            {q.failed.length > 0 && (
              <div className="jb-mgmt__list" aria-label="Failed jobs">
                {q.failed.map((f) => <div key={f.id} className="jb-mgmt__item jb-mgmt__item--text"><div><span style={{ color: 'var(--text)' }}>{f.relpath ?? f.kind}</span><Meta>{f.error ?? 'Failed'} · {f.attempts} attempt{f.attempts === 1 ? '' : 's'}</Meta></div></div>)}
                <div><Button variant="outline" icon="refresh" disabled={retry.isPending} onClick={() => retry.mutate()}>Try the failed ones again</Button></div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="jb-section" aria-label="Needs your decision">
        <Label>Needs your decision</Label>
        {review.data && review.data.length > 0 ? (
          <div className="jb-mgmt__list">
            {review.data.map((r) => (
              <div key={r.id} className="jb-mgmt__item jb-mgmt__item--text">
                {r.kind === 'VERSION_MATCH'
                  ? <><div><span style={{ color: 'var(--text)' }}>{r.subject.relpath}</span><Meta>Taken at the same moment as an existing photograph. Is it the same photograph, re-exported?</Meta></div>
                    <div className="jb-row"><Link className="jb-btn jb-btn--sm jb-btn--ghost" to={`/library?photo=${r.subject.photoId}`}>Look</Link><Button size="sm" variant="outline" onClick={() => decide.mutate({ id: r.id, d: 'SAME_PHOTO' })}>Same photograph</Button><Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: r.id, d: 'DIFFERENT_PHOTO' })}>Different photograph</Button></div></>
                  : <><div><span style={{ color: 'var(--text)' }}>{r.subject.relpath}</span><Meta>A second copy of {r.subject.sameAs}. It was not imported again.</Meta></div>
                    <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: r.id, d: 'ACKNOWLEDGE' })}>Got it</Button></>}
              </div>
            ))}
          </div>
        ) : <Meta>Nothing needs a decision.</Meta>}
      </section>

      <section className="jb-section" aria-label="History">
        <Label>Import history</Label>
        {runs.isError ? <ErrorState title="History could not be loaded" onRetry={() => void runs.refetch()} />
          : !runs.data ? <Skeleton height={80} />
          : runs.data.length === 0 ? <EmptyState icon="inbox" title="No imports yet">When you approve the source folder, every dry run and import is recorded here, with what each one decided.</EmptyState>
          : (
            <div className="jb-mgmt__list">
              {runs.data.map((r) => (
                <div key={r.id} className="jb-mgmt__item jb-mgmt__item--text">
                  <div><span style={{ color: 'var(--text)' }}>{r.mode === 'DRY_RUN' ? 'Dry run' : 'Import'}</span> <span className="label-sm">{STATE_LABEL[r.state]}{r.resumedFrom ? ' · resumed' : ''}</span><Meta className="t-num">{when(r.startedAt)} · {summary(r.counters)}{r.counters.bytes ? ` · ${mb(r.counters.bytes)}` : ''}</Meta>{r.error && <p className="t-meta" style={{ color: 'var(--danger)' }}>{r.error}</p>}</div>
                  <LinkButton size="sm" variant="ghost" to={`/imports/runs/${r.id}`}>Details</LinkButton>
                </div>
              ))}
            </div>
          )}
      </section>
    </div>
  );
}

const ACTIONS = [['', 'All'], ['NEW', 'New'], ['NEW_VERSION', 'Versions'], ['MOVED', 'Moved'], ['DUPLICATE_FILE', 'Duplicates'], ['VERSION_REVIEW', 'To review'], ['SOURCE_MISSING', 'Missing'], ['SKIPPED', 'Skipped'], ['ERROR', 'Errors']] as const;

export function ImportRunPage() {
  const { id = '' } = useParams(); const [action, setAction] = useState<string>('');
  const q = useQuery({ queryKey: ['imports', 'run', id, action], queryFn: () => fetchRun(id, action || undefined), enabled: !!id });
  const r = q.data;
  return (
    <div className="jb-page" style={{ display: 'grid', gap: 20 }}>
      <PageHeader eyebrow="Imports" title={r ? (r.run.mode === 'DRY_RUN' ? 'Dry run' : 'Import') : 'Import run'} lede={r ? `${STATE_LABEL[r.run.state]} · ${when(r.run.startedAt)} · ${summary(r.run.counters)}` : undefined} actions={<LinkButton variant="outline" to="/imports">Back to imports</LinkButton>} />
      {q.isError ? <ErrorState title="This run could not be loaded" onRetry={() => void q.refetch()} /> : !r ? <Skeleton height={160} /> : (
        <>
          <SegmentedControl label="Show" value={action} onChange={setAction} options={ACTIONS.filter(([v]) => v === '' || (r.byAction[v] ?? 0) > 0 || v === action).map(([value, label]) => ({ value, label: value ? `${label} ${n(r.byAction[value])}` : label }))} />
          {r.items.length === 0 ? <EmptyState icon="inbox" title="Nothing to list">Unchanged files are counted but not listed.</EmptyState> : (
            <table className="jb-table" aria-label="What this run decided">
              <thead><tr><th scope="col">Result</th><th scope="col">File</th><th scope="col">Detail</th></tr></thead>
              <tbody>{r.items.map((i) => <tr key={i.id}><td><span className="label-sm">{i.action.replace(/_/g, ' ')}</span></td><td style={{ overflowWrap: 'anywhere' }}>{i.relpath}</td><td className="t-meta">{i.detail ?? ''}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
