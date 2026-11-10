import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Switch } from '../ui/controls';
import { ErrorState, Hairline, Skeleton, useToast } from '../ui/feedback';
import { Label, Meta } from '../ui/typography';
import { analyseTarget, cancelQueue, fetchAiStatus, fetchQueue, fetchQueueHistory, pauseQueue, prioritizeQueue, putAiSettings, resumeQueue } from './api';

const fmt = (n: number) => n.toLocaleString('en-GB');
const KIND = { 'ai.analyze': 'Analysis', 'embed.image': 'Visual similarity', 'embed.text': 'Meaning index' } as Record<string, string>;
const dur = (sec: number) => (sec < 90 ? `${Math.round(sec)} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172_800 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 86_400)} days`);

/** The background analysis queue: how far it has got, how long it will take, and the owner's controls. Controls act only on work that has not started. */
function QueueSection() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ai', 'queue'], queryFn: fetchQueue, refetchInterval: (s) => ((s.state.data?.waiting ?? 0) + (s.state.data?.running ?? 0) > 0 ? 3000 : 15_000) });
  const h = useQuery({ queryKey: ['ai', 'queue', 'history'], queryFn: fetchQueueHistory, refetchInterval: 10_000 });
  const done = () => { void qc.invalidateQueries({ queryKey: ['ai'] }); };
  const fail = (what: string) => (e: unknown) => toast({ kind: 'error', title: `Could not ${what}`, body: e instanceof Error ? e.message : undefined });
  const pause = useMutation({ mutationFn: pauseQueue, onSuccess: () => { done(); toast({ kind: 'ok', title: 'Analysis paused', body: 'Nothing new starts until you resume. Work already running finishes.' }); }, onError: fail('pause') });
  const resume = useMutation({ mutationFn: resumeQueue, onSuccess: () => { done(); toast({ kind: 'ok', title: 'Analysis resumed' }); }, onError: fail('resume') });
  const cancel = useMutation({ mutationFn: cancelQueue, onSuccess: (r) => { done(); toast({ kind: 'ok', title: `${fmt(r.cancelled)} waiting job${r.cancelled === 1 ? '' : 's'} cancelled`, body: 'Photographs can be queued again at any time.' }); }, onError: fail('cancel') });
  const prio = useMutation({ mutationFn: prioritizeQueue, onSuccess: (r) => { done(); toast({ kind: 'ok', title: `${fmt(r.updated)} job${r.updated === 1 ? '' : 's'} moved`, body: 'Recently imported photographs go first.' }); }, onError: fail('change the order') });
  const s = q.data;
  return (
    <section className="jb-section" aria-label="Analysis queue">
      <Label>Analysis queue</Label>
      {q.isError ? <ErrorState title="The queue could not be loaded" onRetry={() => void q.refetch()} /> : !s ? <Skeleton height={80} /> : (
        <>
          <p className="t-body" role="status">
            {s.paused ? 'Paused — nothing new starts. ' : ''}{fmt(s.waiting)} waiting · {fmt(s.running)} running · {fmt(s.done24h)} done in the last 24 h{s.failed24h ? ` · ${fmt(s.failed24h)} failed` : ''}{s.gaveUp ? ` · ${fmt(s.gaveUp)} gave up` : ''}
            {s.etaSeconds !== null ? ` · about ${dur(s.etaSeconds)} to go (${s.secondsPerItem} s per photograph)` : s.waiting && s.secondsPerItem === null ? ' · no speed measured yet' : ''}
          </p>
          {s.perKind.length > 0 && <dl className="jb-kv">{s.perKind.map((k) => <><dt key={`${k.kind}-k`}>{KIND[k.kind] ?? k.kind}</dt><dd key={`${k.kind}-v`}>{fmt(k.waiting)} waiting · {fmt(k.running)} running</dd></>)}</dl>}
          <div className="jb-row">
            {s.paused ? <Button variant="primary" disabled={resume.isPending} onClick={() => resume.mutate()}>Resume</Button> : <Button variant="outline" disabled={pause.isPending} onClick={() => pause.mutate()}>Pause</Button>}
            <Button variant="outline" disabled={prio.isPending || s.waiting === 0} onClick={() => prio.mutate({ importedWithinHours: 24 })}>Do the last day’s imports first</Button>
            {s.prioritised > 0 && <Button variant="ghost" disabled={prio.isPending} onClick={() => prio.mutate({ reset: true })}>Back to normal order</Button>}
            <Button variant="ghost" disabled={cancel.isPending || s.waiting === 0} onClick={() => { if (window.confirm(`Cancel ${fmt(s.waiting)} waiting job${s.waiting === 1 ? '' : 's'}? Nothing is deleted; you can queue the photographs again.`)) cancel.mutate(); }}>Cancel what is waiting</Button>
          </div>
          <Meta>The worker runs one analysis at a time and holds back automatically when this computer is short of memory or disk space. It never delays importing: previews and metadata do not wait for analysis.</Meta>
          <details><summary className="t-meta">Recent activity</summary>
            {h.data && h.data.items.length > 0 ? (
              <dl className="jb-kv">{h.data.items.map((i) => <><dt key={`${i.id}-k`}>{new Date(i.startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · {KIND[i.kind] ?? i.kind}</dt><dd key={`${i.id}-v`} data-status={i.outcome === 'OK' ? 'ok' : 'failed'}>{i.title ?? 'a photograph'} — {i.outcome === 'OK' ? `done${i.seconds !== null ? ` in ${i.seconds} s` : ''}` : (i.error ?? i.outcome ?? 'unfinished')}</dd></>)}</dl>
            ) : <Meta>Nothing has run yet.</Meta>}
          </details>
        </>
      )}
    </section>
  );
}

/** Settings → AI: which analysis runs, what it costs (nothing), and that hosted AI is off until you approve it. */
export function AiSettingsPage() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ai', 'status'], queryFn: fetchAiStatus, refetchInterval: (s) => ((s.state.data?.jobs.QUEUED ?? 0) + (s.state.data?.jobs.RUNNING ?? 0) > 0 ? 3000 : false) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ai'] }); void qc.invalidateQueries({ queryKey: ['library'] }); };
  const save = useMutation({ mutationFn: putAiSettings, onSuccess: refresh, onError: (e) => toast({ kind: 'error', title: 'Could not save that setting', body: e instanceof Error ? e.message : undefined }) });
  const run = useMutation({
    mutationFn: (force: boolean) => analyseTarget({ query: { view: 'all' }, exclude: [] }, force),
    onSuccess: (r) => { refresh(); toast({ kind: 'ok', title: `${fmt(r.queued)} photograph${r.queued === 1 ? '' : 's'} queued`, body: `${fmt(r.alreadyAnalysed)} already analysed${r.waitingForPreviews ? `, ${fmt(r.waitingForPreviews)} still waiting for previews` : ''}.` }); },
    onError: () => toast({ kind: 'error', title: 'Could not queue the analysis' }),
  });
  const s = q.data; const pending = (s?.jobs.QUEUED ?? 0) + (s?.jobs.RUNNING ?? 0);
  return (
    <div className="jb-page" style={{ maxWidth: 880, marginInline: 0, display: 'grid', gap: 24 }}>
      <PageHeader eyebrow="Settings" title="AI" lede="What analyses your photographs, and what it is allowed to do. Everything here is advisory: nothing changes a file, and nothing is published." />
      {q.isError ? <ErrorState title="AI status could not be loaded" onRetry={() => void q.refetch()} /> : !s ? <Skeleton height={200} /> : (
        <>
          <section className="jb-section" aria-label="Analysis provider">
            <Label>Analysis</Label>
            <div role="radiogroup" aria-label="Analysis provider" className="jb-mgmt__list">
              {s.providers.map((p) => (
                <label key={p.id} className="jb-mgmt__item jb-mgmt__item--text" style={{ cursor: p.available ? 'pointer' : 'not-allowed', opacity: p.available ? 1 : 0.7 }}>
                  <div><span style={{ color: 'var(--text)' }}>{p.label}</span><Meta>{p.note}</Meta></div>
                  <input type="radio" name="provider" aria-label={p.label} checked={s.settings.provider === p.id} disabled={!p.available || save.isPending} onChange={() => save.mutate({ provider: p.id as 'local-image' | 'ollama' | 'mock' })} />
                </label>
              ))}
            </div>
            <Switch checked={s.settings.autoAnalyze} onChange={(v) => save.mutate({ autoAnalyze: v })} label="Analyse new photographs automatically once their preview exists" />
          </section>

          <section className="jb-section" aria-label="Progress">
            <Label>Progress</Label>
            <p className="t-body" role="status">{fmt(s.analysed)} of {fmt(s.photos)} photographs analysed{s.stale ? ` · ${fmt(s.stale)} with an older method` : ''}{pending ? ` · ${fmt(pending)} queued` : ''}{s.jobs.DEAD || s.jobs.FAILED ? ` · ${fmt((s.jobs.DEAD ?? 0) + (s.jobs.FAILED ?? 0))} failed` : ''}.</p>
            {s.photos > 0 && <Hairline value={s.analysed / s.photos} label="Photographs analysed" />}
            <div className="jb-row">
              <Button variant="outline" icon="refresh" disabled={run.isPending} onClick={() => run.mutate(false)}>Analyse what is missing or out of date</Button>
              <Button variant="ghost" disabled={run.isPending} onClick={() => run.mutate(true)}>Analyse everything again</Button>
            </div>
            <Meta>Analyses are never overwritten: a new analysis is added and the history is kept. The background worker does the work, one photograph at a time.</Meta>
          </section>

          <QueueSection />

          <section className="jb-section" aria-label="Hosted AI">
            <Label>Hosted AI (species, behaviour, scenes)</Label>
            <dl className="jb-kv">
              <dt>Status</dt><dd>{s.live.enabled ? 'On' : 'Off'}</dd><dt>Sent to any service</dt><dd>Nothing, ever, so far ({fmt(s.live.spendRecords)} paid calls, ${s.live.spentUsd.toFixed(2)} spent)</dd>
              <dt>Test cap when enabled</dt><dd>{fmt(s.live.lifetimePhotoCap)} photographs, with monthly and per-run spending limits</dd>
            </dl>
            <Meta>To use a hosted model later you would approve it, add an API key to your .env file and set a spending cap; a database rule refuses to turn it on without an approval stamp. Only a 1,600 px preview with no location data would be sent.</Meta>
          </section>
        </>
      )}
    </div>
  );
}
