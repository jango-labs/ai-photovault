import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { IG_KEY, fetchPostedCheck, igImage, type PostedCheck } from '../api/instagram';
import { defaultQuery, fetchPhotos, imageUrl } from '../api/library';
import {
  MAX_CAPTION, MAX_TAGS, PUB_KEY, createDraft, fetchAttempts, draftAction, fetchDraft, fullLength, patchDraft, cancelSchedule, reschedule, suggestCaptions, suggestHashtags, type CaptionSuggestion, type SuggestedCaptions, type Draft,
} from '../api/publishing';
import { zonedToIso, dayKeyInZone, formatTime } from '../lib/calendar';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, SegmentedControl, Switch, TextArea } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';
import { DuplicateWarning } from '../ui/history/DuplicateWarning';
import { StatusChip } from '../ui/status';
import { Label, Meta } from '../ui/typography';

type Crop = '4:5' | '1:1' | 'original';
const ASPECT: Record<Crop, string | undefined> = { '4:5': '4 / 5', '1:1': '1 / 1', original: undefined };
const norm = (s: string) => s.trim().replace(/^#+/, '');

export function ComposerPage() {
  const [sp, setSp] = useSearchParams(); const go = useNavigate(); const qc = useQueryClient(); const toast = useToast();
  const draftId = sp.get('draft'); const photoParam = sp.get('photo'); const day = sp.get('day');
  const dq = useQuery({ queryKey: [...PUB_KEY, 'draft', draftId], enabled: !!draftId, queryFn: () => fetchDraft(draftId!), retry: false, staleTime: 5_000 });
  const draft = dq.data;
  const fail = (what: string, e: unknown) => toast({ kind: 'error', title: `${what} failed`, body: e instanceof ApiError ? e.message : 'Nothing was changed.' });
  const refresh = () => { void qc.invalidateQueries({ queryKey: PUB_KEY }); };

  // a photograph chosen but no draft yet: create it, then work on the draft
  const make = useMutation({ mutationFn: (photoId: string) => createDraft(photoId), onSuccess: (d) => { setSp({ draft: d.id, ...(day ? { day } : {}) }, { replace: true }); refresh(); }, onError: (e) => fail('Starting the draft', e) });
  useEffect(() => { if (!draftId && photoParam && !make.isPending && !make.isSuccess && !make.isError) make.mutate(photoParam); }, [draftId, photoParam]);

  if (!draftId && !photoParam) return <PhotoStep day={day} onPick={(id) => setSp({ photo: id, ...(day ? { day } : {}) }, { replace: true })} />;
  if (dq.isError) return <div className="jb-page"><EmptyState icon="post" title="Draft not found" action={<Link className="jb-btn jb-btn--outline" to="/publish/drafts">All drafts</Link>}>It no longer exists or is not yours to see.</EmptyState></div>;
  if (!draft) return <div className="jb-page" aria-busy="true" role="status" aria-label="Loading"><Skeleton height={400} /></div>;
  return <Editor key={draft.id} draft={draft} day={day} refresh={refresh} fail={fail} done={() => go('/publish/calendar')} />;
}

function PhotoStep({ day, onPick }: { day: string | null; onPick: (id: string) => void }) {
  const [q, setQ] = useState(''); const [term, setTerm] = useState('');
  useEffect(() => { const t = window.setTimeout(() => setTerm(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const res = useQuery({ queryKey: [...PUB_KEY, 'pick', term], queryFn: () => fetchPhotos({ ...defaultQuery(), view: 'never', q: term }, undefined, 36), staleTime: 15_000 });
  return (
    <div className="jb-page">
      <PageHeader eyebrow="Publish · New post" title="Choose a photograph" lede={`${day ? `For ${day}. ` : ''}Photographs never posted are listed first; search to find another.`} />
      <Field label="Search your library" value={q} onChange={setQ} autoFocus />
      <ul className="jb-ig__pick" aria-label="Photographs" style={{ maxHeight: 'none' }}>{(res.data?.items ?? []).map((p) => <li key={p.id}><button type="button" onClick={() => onPick(p.id)} aria-label={`Write a post for ${p.title}`}><img src={imageUrl(p.id, 'thumb')} alt="" loading="lazy" /><span>{p.title}</span></button></li>)}</ul>
      {res.isSuccess && res.data.items.length === 0 && <Meta>No photograph matches.</Meta>}
    </div>
  );
}

function Editor({ draft, day, refresh, fail, done }: { draft: Draft; day: string | null; refresh: () => void; fail: (what: string, e: unknown) => void; done: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const go = useNavigate();
  const editable = draft.state === 'DRAFT' || draft.state === 'READY';
  const [caption, setCaption] = useState(draft.caption); const [tags, setTags] = useState(draft.hashtags); const [tagIn, setTagIn] = useState('');
  const [origin, setOrigin] = useState<{ origin: 'AI' | 'AI_EDITED'; style: CaptionSuggestion['style']; model: string; body: string } | null>(null);
  const [crop, setCrop] = useState<Crop>('4:5');
  useEffect(() => { setCaption(draft.caption); setTags(draft.hashtags); }, [draft.updatedAt]);
  const dirty = caption !== draft.caption || tags.join(' ') !== draft.hashtags.join(' ');
  const length = fullLength(caption, tags); const over = length > MAX_CAPTION;
  const put = (d: Draft) => { qc.setQueryData([...PUB_KEY, 'draft', draft.id], d); refresh(); };

  const history = useQuery({ queryKey: [...IG_KEY, 'posted-check', draft.photoId], queryFn: () => fetchPostedCheck(draft.photoId), staleTime: 15_000, retry: false });
  const check: PostedCheck | undefined = history.data; const flagged = !!check && check.kind !== 'none' && !!check.last;

  const save = useMutation({
    mutationFn: () => patchDraft(draft.id, { caption, hashtags: tags, ...(origin && caption !== origin.body ? { origin: 'AI_EDITED' as const, style: origin.style, model: origin.model } : origin ? { origin: origin.origin, style: origin.style, model: origin.model } : {}) }),
    onSuccess: (d) => { put(d); setOrigin(null); toast({ kind: 'ok', title: 'Draft saved' }); }, onError: (e) => fail('Saving', e),
  });
  const step = useMutation({ mutationFn: (a: { action: 'ready' | 'unready' | 'cancel' | 'reopen'; body?: unknown }) => draftAction(draft.id, a.action, a.body), onSuccess: put, onError: (e) => fail('That step', e) });

  const [approveOpen, setApproveOpen] = useState(false); const [ack, setAck] = useState(false);
  const approve = useMutation({ mutationFn: () => draftAction(draft.id, 'approve', { acknowledgeHistory: ack }), onSuccess: (d) => { put(d); setApproveOpen(false); toast({ kind: 'ok', title: 'Approved', body: 'You approved these exact words. Editing them withdraws the approval.' }); }, onError: (e) => fail('Approving', e) });

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const initial = draft.schedule && draft.schedule.state !== 'CANCELLED' ? draft.schedule : null;
  const [date, setDate] = useState(initial ? dayKeyInZone(initial.scheduledAt, initial.timezone) : day ?? dayKeyInZone(new Date(Date.now() + 86_400_000).toISOString(), tz));
  const [time, setTime] = useState(initial ? formatTime(initial.scheduledAt, initial.timezone) : '18:00'); const [zone, setZone] = useState(initial?.timezone ?? tz);
  const when = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? zonedToIso(date, time, zone) : null;
  const sched = useMutation({
    mutationFn: () => (draft.schedule && draft.schedule.state !== 'CANCELLED' ? reschedule(draft.schedule.id, when!, zone) : draftAction(draft.id, 'schedule', { scheduledAt: when, timezone: zone })),
    onSuccess: (d) => { put(d); toast({ kind: 'ok', title: 'Scheduled', body: 'It is on the calendar. Nothing is sent to Instagram until publishing is enabled and you approve it.' }); }, onError: (e) => fail('Scheduling', e),
  });
  const unsched = useMutation({ mutationFn: () => cancelSchedule(draft.schedule!.id), onSuccess: put, onError: (e) => fail('Removing from the schedule', e) });

  const [sug, setSug] = useState<SuggestedCaptions | null>(null); const [tagSug, setTagSug] = useState<Array<{ tag: string; reason: string }> | null>(null);
  const hasRun = !!draft.schedule && ['PUBLISHING', 'PUBLISHED', 'FAILED'].includes(draft.schedule.state);
  const attempts = useQuery({ queryKey: [...PUB_KEY, 'attempts', draft.id, draft.updatedAt, draft.schedule?.state], queryFn: () => fetchAttempts(draft.id), enabled: hasRun || (draft.schedule?.attemptCount ?? 0) > 0, staleTime: 5_000, retry: false });
  const mock = !!draft.schedule?.permalink?.includes('mock.instagram.invalid');
  const askCaptions = useMutation({ mutationFn: () => suggestCaptions(draft.photoId), onSuccess: setSug, onError: (e) => fail('Suggesting captions', e) });
  const askModel = useMutation({ mutationFn: () => suggestCaptions(draft.photoId, 'ollama'), onSuccess: (r) => { setSug(r); if (r.hashtags?.length) setTagSug(r.hashtags); }, onError: (e) => fail('Writing captions with the local AI model', e) });
  const askTags = useMutation({ mutationFn: () => suggestHashtags(draft.photoId), onSuccess: (r) => setTagSug(r.suggestions), onError: (e) => fail('Suggesting hashtags', e) });
  const addTag = (t: string) => { const c = norm(t); if (!c || tags.some((x) => x.toLowerCase() === c.toLowerCase())) return; if (!/^[\p{L}\p{N}_]{1,60}$/u.test(c)) { toast({ kind: 'warn', title: 'Not a valid hashtag', body: 'Use letters, digits and underscores only.' }); return; } if (tags.length >= MAX_TAGS) { toast({ kind: 'warn', title: `At most ${MAX_TAGS} hashtags` }); return; } setTags([...tags, c]); };

  const approvedLabel = draft.approvedAt ? `Approved ${new Date(draft.approvedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : null;
  return (
    <div className="jb-page jb-compose">
      <PageHeader eyebrow="Publish · Composer" title={draft.title ?? draft.photo?.title ?? 'New post'} actions={<StatusChip state={draft.state} />} />
      <div className="jb-compose__grid">
        <section aria-label="Photograph">
          <SegmentedControl<Crop> label="Preview crop" value={crop} onChange={setCrop} options={[{ value: '4:5', label: '4:5' }, { value: '1:1', label: '1:1' }, { value: 'original', label: 'Original' }]} />
          <div className="jb-compose__frame"><img src={imageUrl(draft.photoId, 'view')} alt={draft.photo?.title ?? 'Photograph'} style={ASPECT[crop] ? { aspectRatio: ASPECT[crop], objectFit: 'cover' } : undefined} /></div>
          <Meta>The preview shows how Instagram will crop the feed. The photograph itself is never changed. <Link to={`/library?photo=${draft.photoId}`}>Open in the Library</Link></Meta>
          {flagged && editable && check!.last && (
            <DuplicateWarning kind={check!.kind === 'same' ? 'same' : 'similar'} last={{ src: igImage(check!.last.mediaId), alt: 'The earlier post', postedAt: check!.last.postedAt, caption: check!.last.caption ?? '' }}
              onView={() => go('/publish/history')} onContinue={() => setAck(true)} onCancel={() => step.mutate({ action: 'cancel' })} />)}
        </section>
        <section aria-label="Caption and hashtags">
          <TextArea label="Caption" value={caption} onChange={setCaption} rows={9} disabled={!editable} hint={`${length.toLocaleString('en-GB')} of ${MAX_CAPTION.toLocaleString('en-GB')} characters including hashtags`} />
          {over && <p role="alert" className="t-meta" style={{ color: 'var(--danger)' }}>Too long for Instagram by {(length - MAX_CAPTION).toLocaleString('en-GB')} characters.</p>}
          <div className="jb-row" style={{ flexWrap: 'wrap' }}>
            <Button variant="outline" onClick={() => askCaptions.mutate()} disabled={!editable || askCaptions.isPending}>Suggest captions</Button>
            <Button variant="outline" onClick={() => askModel.mutate()} disabled={!editable || askModel.isPending}>{askModel.isPending ? 'Writing…' : 'Write with the local AI model'}</Button>
            <Meta>{sug ? sug.note : 'The first button arranges what your library records (no AI). The second asks the language model on this computer; it takes about half a minute and uses only facts you have confirmed.'}</Meta>
          </div>
          {sug && (
            <ul className="jb-compose__sug" aria-label="Caption suggestions">{sug.suggestions.map((s) => (
              <li key={s.style}><Label>{s.style === 'STORYTELLING' ? 'Story' : s.style === 'EDUCATIONAL' ? 'Facts' : 'Short'}</Label><p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{s.body}</p>
                <Meta>{s.model.startsWith('ollama:') ? `Written by ${s.model.slice(7)} on this computer. ` : ''}Based on: {s.basedOn.join(', ') || 'nothing recorded'}.{s.missing.length > 0 && ` ${s.missing.join('. ')}.`}</Meta>
                {(s.warnings ?? []).map((w) => <p key={w} role="alert" className="t-meta" style={{ color: 'var(--warn)' }}>{w}</p>)}
                <Button size="sm" variant="outline" disabled={!editable} onClick={() => { setCaption(s.body); setOrigin({ origin: 'AI', style: s.style, model: s.model, body: s.body }); }}>Use this</Button></li>))}</ul>)}
          <div className="jb-compose__tags">
            <Label>Hashtags ({tags.length}/{MAX_TAGS})</Label>
            <div className="jb-lib__chips">{tags.map((t) => <span key={t} className="jb-chip">#{t}{editable && <button type="button" aria-label={`Remove #${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>×</button>}</span>)}{tags.length === 0 && <Meta>None yet.</Meta>}</div>
            <form className="jb-row" onSubmit={(e) => { e.preventDefault(); addTag(tagIn); setTagIn(''); }}><Field label="Add a hashtag" value={tagIn} onChange={setTagIn} maxLength={61} disabled={!editable} /><Button type="submit" variant="outline" disabled={!editable || !tagIn.trim()}>Add</Button><Button variant="ghost" onClick={() => askTags.mutate()} disabled={!editable || askTags.isPending}>Suggest</Button></form>
            {tagSug && <div className="jb-filter-opts" aria-label="Hashtag suggestions">{tagSug.filter((s) => !tags.some((t) => t.toLowerCase() === s.tag)).map((s) => <button key={s.tag} type="button" className="jb-opt" title={s.reason} onClick={() => addTag(s.tag)}>#{s.tag}</button>)}</div>}
          </div>
          <div className="jb-row" style={{ flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={() => save.mutate()} disabled={!editable || !dirty || over || save.isPending}>Save draft</Button>
            {draft.state === 'DRAFT' && <Button variant="outline" onClick={() => step.mutate({ action: 'ready' })} disabled={dirty || !draft.caption.trim() || step.isPending}>Mark ready</Button>}
            {draft.state === 'READY' && <Button variant="ghost" onClick={() => step.mutate({ action: 'unready' })}>Back to draft</Button>}
            {draft.state === 'CANCELLED' ? <Button variant="outline" onClick={() => step.mutate({ action: 'reopen' })}>Reopen</Button> : !['PUBLISHING', 'PUBLISHED'].includes(draft.state) && <Button variant="ghost" onClick={() => step.mutate({ action: 'cancel' })}>Discard</Button>}
          </div>
          {dirty && editable && <Meta>You have unsaved changes. Save the draft before the next step.</Meta>}
          {!editable && draft.state === 'SCHEDULED' && <Meta>Remove it from the schedule to edit the words.</Meta>}

          {(draft.state === 'READY' || draft.state === 'SCHEDULED') && (
            <div className="jb-compose__plan" aria-label="Approval and schedule">
              <Label>Approve and schedule</Label>
              {approvedLabel ? <p className="t-meta">{approvedLabel}{draft.historyOverrideAt ? ' — you chose to post it again' : ''}.</p> : <Meta>Nothing can be scheduled until you approve these exact words and this photograph.</Meta>}
              {!draft.approvedAt && <Button variant="primary" onClick={() => { setAck(false); setApproveOpen(true); }} disabled={dirty}>Approve…</Button>}
              {draft.approvedAt && (
                <>
                  <div className="jb-compose__when">
                    <Field label="Date" type="text" value={date} onChange={setDate} placeholder="YYYY-MM-DD" /><Field label={`Time (${zone})`} value={time} onChange={setTime} placeholder="HH:MM" /><Field label="Time zone" value={zone} onChange={setZone} />
                  </div>
                  <div className="jb-row">
                    <Button variant="primary" onClick={() => sched.mutate()} disabled={!when || sched.isPending || dirty}>{draft.schedule && draft.schedule.state !== 'CANCELLED' ? 'Reschedule' : 'Schedule'}</Button>
                    {draft.state === 'SCHEDULED' && draft.schedule && <Button variant="ghost" onClick={() => unsched.mutate()}>Remove from schedule</Button>}
                    <Button variant="ghost" onClick={done}>Calendar</Button>
                  </div>
                  <Meta>Scheduling is a plan: nothing is sent to Instagram, no account is connected, and live publishing needs your approval.</Meta>
                </>)}
              {draft.schedule?.state === 'FAILED' && <ErrorState level={3} title="Publishing failed">{draft.schedule.errorMessage ?? 'Unknown error'}. The draft is preserved; choose a time and reschedule to try again.</ErrorState>}
              {draft.schedule?.state === 'FAILED' && draft.schedule.errorCode === 'UNKNOWN_OUTCOME' && <Meta>Before trying again: open your Instagram account (or run a sync in Instagram history) and look for the post. If it is there, remove this from the schedule. If it is not, reschedule. The app will look for it once more and will not post a second copy if it finds it.</Meta>}
              {draft.schedule?.state === 'PUBLISHING' && <Meta>Being published now{draft.schedule.errorCode === 'UNKNOWN_OUTCOME' ? ' — Instagram has not confirmed it yet; the app is checking and will not send it twice' : ''}.</Meta>}
            </div>)}
          {draft.state === 'PUBLISHED' && draft.schedule && (
            <div className="jb-compose__plan" aria-label="Published">
              <Label>Published</Label>
              <p className="t-meta">Verified on {new Date(draft.schedule.publishedAt ?? draft.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.{mock ? ' This was a MOCK publication to the local test server — nothing was posted to Instagram.' : ''}</p>
              {draft.schedule.permalink && !mock && <a href={draft.schedule.permalink} target="_blank" rel="noreferrer noopener">View on Instagram</a>}
            </div>)}
          {attempts.data && attempts.data.items.length > 0 && (
            <details><summary className="t-meta">Publishing log ({attempts.data.items.length} steps)</summary>
              <ul className="jb-compose__sug" aria-label="Publishing log">{attempts.data.items.map((a) => <li key={a.id}><Meta><span className="t-num">{new Date(a.startedAt).toLocaleTimeString('en-GB')}</span> · {a.phase.replace('_', ' ').toLowerCase()} · {a.outcome ?? 'running'}{a.errorCode ? ` (${a.errorCode})` : ''}{a.message ? ` — ${a.message}` : ''}</Meta></li>)}</ul></details>)}
          {draft.captionVersions && draft.captionVersions.length > 1 && (
            <details><summary className="t-meta">Caption history ({draft.captionVersions.length})</summary>
              <ul className="jb-compose__sug">{draft.captionVersions.map((v) => <li key={v.id}><Meta>{new Date(v.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {v.origin === 'USER' ? 'you' : v.origin === 'AI' ? `suggested (${v.model ?? 'template'})` : 'suggested, then edited'}</Meta><p style={{ whiteSpace: 'pre-wrap', margin: '2px 0' }}>{v.body}</p>{editable && <Button size="sm" variant="ghost" onClick={() => setCaption(v.body)}>Restore</Button>}</li>)}</ul></details>)}
        </section>
      </div>
      <Dialog open={approveOpen} onOpenChange={setApproveOpen} title="Approve this post?" description="You are approving these exact words and this photograph. Changing the caption or hashtags later withdraws the approval."
        actions={<><Button variant="ghost" onClick={() => setApproveOpen(false)}>Cancel</Button><Button variant="primary" disabled={approve.isPending || (flagged && !ack)} onClick={() => approve.mutate()}>Approve</Button></>}>
        <p style={{ whiteSpace: 'pre-wrap' }}>{draft.caption}{draft.hashtags.length ? `\n\n${draft.hashtags.map((t) => `#${t}`).join(' ')}` : ''}</p>
        {flagged && check!.last && <Switch checked={ack} onChange={setAck} label={check!.kind === 'same' ? `This photograph was already posted on ${new Date(check!.last.postedAt).toLocaleDateString('en-GB')}. Post it again.` : `A similar image was posted on ${new Date(check!.last.postedAt).toLocaleDateString('en-GB')}. Continue anyway.`} />}
      </Dialog>
    </div>
  );
}
