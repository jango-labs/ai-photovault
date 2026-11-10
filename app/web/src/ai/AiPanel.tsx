import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/controls';
import { Hairline, useToast } from '../ui/feedback';
import { AiTag, ConfidenceMeter } from '../ui/status';
import { Label, Meta } from '../ui/typography';
import { acceptDescription, addSpecies, analysePhoto, decideSpecies, fetchPhotoAi, type AnalysisRow, type SpeciesLink } from './api';

const SCORE_LABEL: Array<[string, string]> = [['sharpness', 'Sharpness'], ['exposure', 'Exposure'], ['lighting', 'Lighting'], ['composition', 'Composition'], ['subjectIsolation', 'Subject isolation'], ['impact', 'Impact'], ['storytelling', 'Storytelling'], ['uniqueness', 'Uniqueness']];
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const MODE: Record<AnalysisRow['mode'], string> = { local: 'Measured on this computer', mock: 'Mock answer (testing)', live: 'Hosted model' };

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="jb-section"><Label>{title}</Label>{children}</section>; }

/** The viewer's "AI Analysis" tab: what the analysis found, your decisions about it, and its history. AI output is advisory and always labelled. */
export function AiPanel({ photoId }: { photoId: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['library', 'ai', photoId], queryFn: () => fetchPhotoAi(photoId), refetchInterval: (s) => (s.state.data?.queued ? 3000 : false) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['library'] }); };
  const err = (what: string) => () => toast({ kind: 'error', title: `${what} failed`, body: 'Nothing was changed. Try again.' });
  const again = useMutation({ mutationFn: () => analysePhoto(photoId), onSuccess: (r) => { refresh(); toast({ kind: r.queued ? 'ok' : 'info', title: r.queued ? 'Analysis queued' : 'Nothing to queue', body: r.queued ? 'It runs when the worker is next free.' : 'The preview may not be ready yet.' }); }, onError: err('Queuing') });
  const decide = useMutation({ mutationFn: (v: { link: string; action: 'confirm' | 'reject' }) => decideSpecies(photoId, v.link, v.action), onSuccess: refresh, onError: err('Saving') });
  const accept = useMutation({ mutationFn: (analysisId: string) => acceptDescription(photoId, analysisId), onSuccess: () => { refresh(); toast({ kind: 'ok', title: 'Description saved', body: 'Marked as AI-inferred; undo it from the edit history.' }); }, onError: err('Saving') });
  const [naming, setNaming] = useState<{ replaces?: string } | null>(null); const [name, setName] = useState(''); const [sci, setSci] = useState('');
  const add = useMutation({ mutationFn: () => addSpecies(photoId, { commonName: name.trim(), scientificName: sci.trim() || null, ...(naming?.replaces ? { replaces: naming.replaces } : {}) }), onSuccess: () => { setNaming(null); setName(''); setSci(''); refresh(); }, onError: err('Saving') });

  if (q.isError) return <Meta>The analysis could not be loaded.</Meta>;
  if (!q.data) return <Meta>Loading…</Meta>;
  const { analyses, species, corrections } = q.data; const latest = analyses.find((a) => a.current) ?? analyses[0];
  const active = species.filter((s) => s.status !== 'REJECTED'), rejected = species.filter((s) => s.status === 'REJECTED');
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {q.data.queued && <div role="status" style={{ display: 'grid', gap: 6, padding: '8px 0' }}><Hairline staticOnly label="Analysis queued" /><Meta>Analysis is queued.</Meta></div>}
      {!latest ? (
        <Section title="Status"><p className="t-body">Not analysed yet.{q.data.queued ? '' : ' Analysis starts automatically once the preview exists, or run it now.'}</p>
          <div><Button size="sm" variant="outline" icon="refresh" disabled={again.isPending} onClick={() => again.mutate()}>Analyse now</Button></div></Section>
      ) : (
        <>
          <Meta>{MODE[latest.mode]} · {latest.provider} {latest.model} · {when(latest.createdAt)}{latest.stale ? ' · older method' : ''}</Meta>
          <Section title="Measurements">
            <dl className="jb-kv">
              {SCORE_LABEL.map(([k, label]) => { const v = latest.scores[k]; return v === undefined ? null : <><dt key={k}>{label}</dt><dd key={k + 'v'}>{v === null ? <span style={{ color: 'var(--text-3)' }}>Not assessed</span> : <span className="t-num">{Math.round(v * 100)}%</span>}</dd></>; })}
              {latest.lighting && <><dt>Light</dt><dd>{latest.lighting}</dd></>}{latest.colours.length > 0 && <><dt>Colours</dt><dd>{latest.colours.join(', ')}</dd></>}
            </dl>
            {latest.mode === 'local' && <Meta>Measured from the pixels. Composition is a rule-of-thirds heuristic; judgement scores need a vision model.</Meta>}
          </Section>
          {latest.tags.length > 0 && <Section title="Tags"><div className="jb-filter-opts">{latest.tags.map((t) => <span key={t} className="jb-prov" style={{ marginLeft: 0 }}>{t}</span>)}</div></Section>}
          {latest.description && <Section title="Description"><p className="t-body">{latest.description} {latest.mode !== 'local' && <AiTag />}</p><div><Button size="sm" variant="outline" disabled={accept.isPending} onClick={() => accept.mutate(latest.id)}>Use as this photograph’s description</Button></div></Section>}
        </>
      )}

      <Section title="Subject">
        {active.length === 0 && <Meta>{latest?.mode === 'local' ? 'The local analysis does not identify species. Name it yourself, or enable a vision model later (needs your approval).' : 'No species suggested.'}</Meta>}
        {active.map((s: SpeciesLink) => (
          <div key={s.id} className="jb-mgmt__item jb-mgmt__item--text">
            <div><span style={{ color: 'var(--text)' }}>{s.name}</span> {s.source === 'AI_INFERRED' && s.status === 'SUGGESTED' && <AiTag />}{s.scientific && <Meta><i>{s.scientific}</i></Meta>}{s.behavior && <Meta>{s.behavior}</Meta>}
              {s.status === 'CONFIRMED' ? <Meta>Confirmed by you</Meta> : s.confidence !== null && <ConfidenceMeter value={s.confidence} label={s.name} />}</div>
            <div className="jb-row">
              {s.status === 'SUGGESTED' && <Button size="sm" variant="outline" icon="check" onClick={() => decide.mutate({ link: s.id, action: 'confirm' })}>Confirm</Button>}
              {s.status === 'SUGGESTED' && <Button size="sm" variant="ghost" onClick={() => decide.mutate({ link: s.id, action: 'reject' })}>Not this</Button>}
              <Button size="sm" variant="ghost" onClick={() => { setNaming({ replaces: s.id }); setName(''); setSci(''); }}>Correct…</Button>
            </div>
          </div>
        ))}
        {naming ? (
          <form className="jb-stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
            <Field label="Species" value={name} onChange={setName} maxLength={120} autoFocus /><Field label="Scientific name (optional)" value={sci} onChange={setSci} maxLength={160} />
            <div className="jb-row"><Button type="submit" variant="primary" disabled={!name.trim() || add.isPending}>Save</Button><Button variant="ghost" onClick={() => setNaming(null)}>Cancel</Button></div>
          </form>
        ) : <div><Button size="sm" variant="outline" icon="plus" onClick={() => { setNaming({}); setName(''); setSci(''); }}>Name the species</Button></div>}
        {rejected.length > 0 && <Meta>Not shown again: {rejected.map((r) => r.name).join(', ')}.</Meta>}
      </Section>

      <Section title="Analysis history">
        {analyses.length ? <div className="jb-mgmt__list">{analyses.map((a) => <div key={a.id} className="jb-mgmt__item jb-mgmt__item--text"><div><span style={{ color: 'var(--text)' }}>{MODE[a.mode]}</span><Meta className="t-num">{a.provider} · {when(a.createdAt)}{a.current ? ' · current version' : ' · earlier version'}{a.stale ? ' · older method' : ''}{a.overall !== null ? ` · overall ${Math.round(a.overall * 100)}%` : ''}</Meta></div></div>)}</div> : <Meta>None yet.</Meta>}
        {latest && <div><Button size="sm" variant="ghost" icon="refresh" disabled={again.isPending} onClick={() => again.mutate()}>Analyse again</Button></div>}
      </Section>
      {corrections.length > 0 && <Section title="Your decisions about AI output">
        <div className="jb-mgmt__list">{corrections.slice(0, 10).map((c) => <div key={c.id} className="jb-mgmt__item jb-mgmt__item--text"><div><span style={{ color: 'var(--text)' }}>{c.kind.replace('SPECIES_', 'Species · ').replace('DESCRIPTION_ACCEPT', 'Description accepted').toLowerCase().replace(/^./, (x) => x.toUpperCase())}</span><Meta className="t-num">{String((c.after as { species?: string } | null)?.species ?? '')} {when(c.at)}</Meta></div></div>)}</div></Section>}
    </div>
  );
}
