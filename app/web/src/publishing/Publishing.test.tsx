import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../api/publishing';
import { fakeCard, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Call, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const draft = (o: Partial<Draft> = {}): Draft => ({
  id: 'd1', photoId: idOf(1), photo: fakeCard(1), title: null, caption: 'Lion in Masai Mara, June 2024.', hashtags: ['lion', 'wildlife'], notes: null, state: 'DRAFT', createdBy: 'USER', approvedAt: null, historyCheck: null, historyOverrideAt: null,
  schedule: null, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z', captionVersions: [], ...o,
});
const SCHED = { id: 's1', scheduledAt: '2026-12-01T18:00:00.000Z', timezone: 'Europe/London', state: 'SCHEDULED', attemptCount: 0, errorCode: null, errorMessage: null, publishedAt: null, permalink: null };
const start = (path: string, extra: Routes = {}) => { const lib = libraryRoutes(30); const calls = mockApi(signedIn({ ...lib.routes, ...extra })); renderApp(path); return calls; };
const post = (calls: Call[], p: string) => calls.find((c) => c.method !== 'GET' && c.path === p);

describe('Calendar', () => {
  const entry = (o: Record<string, unknown> = {}) => ({ id: 's1', draftId: 'd1', photoId: idOf(1), title: 'Lion at dusk', scheduledAt: new Date().toISOString(), timezone: 'UTC', state: 'SCHEDULED', error: null, caption: 'Words', ...o });
  it('asks the server for the visible weeks, shows real entries, and says that scheduling is only a plan', async () => {
    const calls = start('/publish/calendar', { 'GET /api/publishing/calendar': { json: { items: [entry()] } } });
    expect(await screen.findByText(/Scheduling is a plan/)).toBeTruthy(); expect((await screen.findAllByRole('cell')).length).toBe(42);
    await waitFor(() => expect(calls.some((c) => c.path === '/api/publishing/calendar' && /^\d{4}-\d{2}-\d{2}$/.test(c.query.get('from') ?? ''))).toBe(true));
    expect(await screen.findByRole('button', { name: /Lion at dusk/ })).toBeTruthy();
  });
  it('opening an entry offers the composer, reschedule and removal; removal is sent and explained', async () => {
    const calls = start('/publish/calendar', { 'GET /api/publishing/calendar': { json: { items: [entry()] } }, 'POST /api/publishing/schedule/s1/cancel': { json: draft({ state: 'READY' }) } });
    await userEvent.click(await screen.findByRole('button', { name: /Lion at dusk/ }));
    const panel = await screen.findByRole('dialog'); expect(within(panel).getByRole('link', { name: 'Open composer' }).getAttribute('href')).toBe('/publish/compose?draft=d1');
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove from schedule' })); await waitFor(() => expect(post(calls, '/api/publishing/schedule/s1/cancel')).toBeTruthy());
    expect(await screen.findByText(/The draft is kept/)).toBeTruthy();
  });
  it('a failed post is flagged at the top, with its reason in the panel', async () => {
    start('/publish/calendar', { 'GET /api/publishing/calendar': { json: { items: [entry({ state: 'FAILED', error: 'The image could not be fetched' })] } } });
    expect(await screen.findByText('1 post failed')).toBeTruthy(); await userEvent.click(await screen.findByRole('button', { name: /Lion at dusk/ })); expect((await screen.findAllByText(/The image could not be fetched/)).length).toBeGreaterThan(0);
  });
  it('a failed load shows an error with retry', async () => {
    start('/publish/calendar', { 'GET /api/publishing/calendar': { status: 500, json: { error: 'x', message: 'x' } } });
    expect(await screen.findByText('The calendar could not be loaded')).toBeTruthy();
  });
});

describe('Lists', () => {
  it('Drafts lists drafts newest first with their state, and links each to the composer', async () => {
    const calls = start('/publish/drafts', { 'GET /api/publishing/drafts': { json: { items: [draft(), draft({ id: 'd2', caption: '' })], nextCursor: null } } });
    const list = await screen.findByRole('list', { name: 'Drafts' }); expect(within(list).getAllByRole('link')).toHaveLength(2); expect(within(list).getAllByRole('link')[0]!.getAttribute('href')).toBe('/publish/compose?draft=d1'); expect(within(list).getByText(/no caption yet/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/publishing/drafts')!.query.getAll('state')).toEqual(['DRAFT']);
  });
  it('empty lists say what to do', async () => {
    start('/publish/ready', { 'GET /api/publishing/drafts': { json: { items: [], nextCursor: null } } });
    expect(await screen.findByText('No ready')).toBeTruthy();
  });
});

describe('Composer', () => {
  it('without a photograph it asks you to choose one (never-posted first), then starts a draft for it', async () => {
    const calls = start('/publish/compose?day=2026-12-01', { 'POST /api/publishing/drafts': { status: 201, json: draft({ id: 'dn' }) }, 'GET /api/publishing/drafts/dn': { json: draft({ id: 'dn' }) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Write a post for Photograph 1' }));
    await waitFor(() => expect(post(calls, '/api/publishing/drafts')?.body).toMatchObject({ photoId: idOf(1) })); expect(calls.find((c) => c.path === '/api/library/photos')!.query.get('view')).toBe('never');
    expect(await screen.findByLabelText('Caption')).toBeTruthy();
  });
  it('saves edits (only when changed), counts characters including hashtags, and refuses to save too long a caption', async () => {
    const calls = start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft() }, 'PATCH /api/publishing/drafts/d1': (c) => ({ json: draft({ caption: (c.body as { caption: string }).caption }) }) });
    const box = await screen.findByLabelText('Caption'); const save = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement; expect(save.disabled).toBe(true);
    expect(screen.getByText(/of 2,200 characters including hashtags/)).toBeTruthy();
    await userEvent.clear(box); await userEvent.type(box, 'New words'); expect(save.disabled).toBe(false); await userEvent.click(save);
    await waitFor(() => expect(post(calls, '/api/publishing/drafts/d1')?.body).toMatchObject({ caption: 'New words', hashtags: ['lion', 'wildlife'] }));
    await userEvent.click(box); await userEvent.paste('x'.repeat(2300)); expect(await screen.findByRole('alert')).toBeTruthy(); expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('hashtags: add, de-duplicate, remove, invalid refused, suggestions carry reasons', async () => {
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft() }, 'GET /api/publishing/hashtags/suggest': { json: { suggestions: [{ tag: 'lion', reason: 'the species' }, { tag: 'kenya', reason: 'the place' }] } } });
    const input = await screen.findByLabelText('Add a hashtag');
    await userEvent.type(input, '#Safari{Enter}'); expect(await screen.findByText('#safari'.replace('s', 'S'))).toBeTruthy(); await userEvent.type(input, 'safari{Enter}'); expect(screen.getAllByText('#Safari')).toHaveLength(1);
    await userEvent.type(input, 'has space{Enter}'); expect(await screen.findByText('Not a valid hashtag')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove #Safari' })); expect(screen.queryByText('#Safari')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' })); const sug = await screen.findByLabelText('Hashtag suggestions'); expect(within(sug).queryByRole('button', { name: '#lion' })).toBeNull(); expect(within(sug).getByRole('button', { name: '#kenya' }).getAttribute('title')).toBe('the place');
  });
  it('caption suggestions say what they were based on and what is missing; using one fills the box and is saved as a suggestion', async () => {
    const calls = start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ caption: '' }) },
      'POST /api/publishing/captions/suggest': { json: { model: 'local-template-v1', note: 'n', suggestions: [{ style: 'SHORT', body: 'Lion in Masai Mara, June 2024.', model: 'local-template-v1', basedOn: ['place', 'species'], missing: ['No equipment data in the file'] }] } }, 'PATCH /api/publishing/drafts/d1': { json: draft() } });
    await userEvent.click(await screen.findByRole('button', { name: 'Suggest captions' }));
    const list = await screen.findByRole('list', { name: 'Caption suggestions' }); expect(within(list).getByText(/Based on: place, species/)).toBeTruthy(); expect(within(list).getByText(/No equipment data/)).toBeTruthy(); expect(screen.getByText('n')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Use this' })); expect((screen.getByLabelText('Caption') as HTMLTextAreaElement).value).toBe('Lion in Masai Mara, June 2024.');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' })); await waitFor(() => expect(post(calls, '/api/publishing/drafts/d1')?.body).toMatchObject({ origin: 'AI', style: 'SHORT', model: 'local-template-v1' }));
  });
  it('“Write with the local AI model” shows who wrote it, warns about an unconfirmed species, fills the hashtag suggestions, and says plainly when the model is unavailable', async () => {
    let up = true;
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ caption: '' }) },
      'POST /api/publishing/captions/suggest': (c) => ((c.body as { engine?: string }).engine === 'ollama' ? (up ? { json: { model: 'ollama:gemma4:e4b', note: 'Written by the language model on this computer.', suggestions: [{ style: 'SHORT', body: 'Lion and leopard at dawn.', model: 'ollama:gemma4:e4b', basedOn: ['place'], missing: [], warnings: ['Mentions “Leopard”, which you have not confirmed for this photograph — check it before posting'] }], hashtags: [{ tag: 'bigcats', reason: 'suggested by the local model' }] } } : { status: 503, json: { error: 'model_unavailable', message: 'The local language model could not write captions right now (Ollama is not running on this computer). Use the template suggestions instead.' } }) : { json: { model: 'local-template-v1', note: 'n', suggestions: [] } }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Write with the local AI model' }));
    const list = await screen.findByRole('list', { name: 'Caption suggestions' }); expect(within(list).getByText(/Written by gemma4:e4b on this computer/)).toBeTruthy(); expect(within(list).getByRole('alert').textContent).toMatch(/which you have not confirmed/);
    expect(await screen.findByRole('button', { name: '#bigcats' })).toBeTruthy(); expect(screen.getByText('Written by the language model on this computer.')).toBeTruthy();
    up = false; await userEvent.click(screen.getByRole('button', { name: 'Write with the local AI model' })); expect(await screen.findByText(/Writing captions with the local AI model failed/)).toBeTruthy();
  });
  it('the workflow: Mark ready → Approve… (explicit dialog showing the exact words) → Schedule with a time and zone', async () => {
    let cur = draft();
    const calls = start('/publish/compose?draft=d1&day=2030-01-15', {
      'GET /api/publishing/drafts/d1': () => ({ json: cur }), 'POST /api/publishing/drafts/d1/ready': () => ({ json: (cur = draft({ state: 'READY' })) }),
      'POST /api/publishing/drafts/d1/approve': () => ({ json: (cur = draft({ state: 'READY', approvedAt: '2026-10-09T11:00:00Z' })) }),
      'POST /api/publishing/drafts/d1/schedule': () => ({ json: (cur = draft({ state: 'SCHEDULED', approvedAt: '2026-10-09T11:00:00Z', schedule: SCHED })) }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Mark ready' })); expect(await screen.findByText(/Nothing can be scheduled until you approve/)).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve…' })); const dlg = await screen.findByRole('dialog'); expect(within(dlg).getByText(/Lion in Masai Mara, June 2024\./)).toBeTruthy(); expect(within(dlg).getByText(/#lion #wildlife/)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Approve' })); await waitFor(() => expect(post(calls, '/api/publishing/drafts/d1/approve')?.body).toEqual({ acknowledgeHistory: false }));
    expect((await screen.findByLabelText('Date') as HTMLInputElement).value).toBe('2030-01-15'); expect((screen.getByLabelText(/^Time \(/) as HTMLInputElement).value).toBe('18:00');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule' })); await waitFor(() => expect(post(calls, '/api/publishing/drafts/d1/schedule')).toBeTruthy());
    const body = post(calls, '/api/publishing/drafts/d1/schedule')!.body as { scheduledAt: string; timezone: string }; expect(new Date(body.scheduledAt).getUTCFullYear()).toBe(2030); expect(body.timezone).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Remove from schedule' })).toBeTruthy(); expect((screen.getByLabelText('Caption') as HTMLTextAreaElement).disabled).toBe(true); expect(screen.getByText(/Remove it from the schedule to edit/)).toBeTruthy();
  });
  it('a photograph already on Instagram shows the earlier post and cannot be approved until you say you mean it', async () => {
    const last = { postId: 'p', mediaId: 'media-1', postedAt: '2025-03-14T18:30:00.000Z', caption: 'Quiet light', permalink: null };
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ state: 'READY' }) }, 'GET /api/instagram/posted-check': { json: { kind: 'same', count: 1, last } } });
    expect(await screen.findByText('This photograph was previously posted')).toBeTruthy(); expect(document.querySelector('img[src="/api/instagram/media/media-1/image"]')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve…' })); const dlg = await screen.findByRole('dialog'); const ok = within(dlg).getByRole('button', { name: 'Approve' }) as HTMLButtonElement; expect(ok.disabled).toBe(true);
    await userEvent.click(within(dlg).getByRole('switch')); await waitFor(() => expect(ok.disabled).toBe(false));
  });
  it('a server refusal (for example the daily limit) is shown, not swallowed', async () => {
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ state: 'READY', approvedAt: '2026-10-09T11:00:00Z' }) }, 'POST /api/publishing/drafts/d1/schedule': { status: 409, json: { error: 'limit', message: 'Instagram allows 25 posts per 24 hours through its API; that window is full.' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule' })); expect(await screen.findByText(/that window is full/)).toBeTruthy();
  });
  it('a failed post explains itself and offers a retry time; a cancelled draft can be reopened', async () => {
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ state: 'SCHEDULED', approvedAt: 'x', schedule: { ...SCHED, state: 'FAILED', errorMessage: 'The container was rejected' } }) } });
    expect(await screen.findByText('Publishing failed')).toBeTruthy(); expect(screen.getByText(/The container was rejected/)).toBeTruthy();
  });
  it('a published mock post is labelled as a mock; the publisher’s log is shown; an unknown outcome says what to check', async () => {
    const sch = { ...SCHED, state: 'PUBLISHED', permalink: 'https://mock.instagram.invalid/p/m_1/', publishedAt: '2026-12-01T18:00:30.000Z' };
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ state: 'PUBLISHED', approvedAt: 'x', schedule: sch }) }, 'GET /api/publishing/drafts/d1/attempts': { json: { items: [{ id: 'a1', phase: 'CREATE_CONTAINER', outcome: 'OK', errorCode: null, message: null, startedAt: '2026-12-01T18:00:01Z', finishedAt: null }, { id: 'a2', phase: 'VERIFY', outcome: 'OK', errorCode: null, message: null, startedAt: '2026-12-01T18:00:20Z', finishedAt: null }] } } });
    expect(await screen.findByText(/MOCK publication to the local test server/)).toBeTruthy(); expect(screen.queryByRole('link', { name: 'View on Instagram' })).toBeNull();
    const log = await screen.findByRole('list', { name: 'Publishing log' }); expect(within(log).getByText(/create container/)).toBeTruthy(); expect(within(log).getByText(/verify/)).toBeTruthy();
  });
  it('after an unknown outcome the page tells you what to check before trying again', async () => {
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ state: 'SCHEDULED', approvedAt: 'x', schedule: { ...SCHED, state: 'FAILED', errorCode: 'UNKNOWN_OUTCOME', errorMessage: 'It is not known whether this post was published' } }) }, 'GET /api/publishing/drafts/d1/attempts': { json: { items: [] } } });
    expect(await screen.findByText(/will not post a second copy if it finds it/)).toBeTruthy();
  });
  it('cancelled → Reopen; unknown draft → not found', async () => {
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ state: 'CANCELLED' }) } }); expect(await screen.findByRole('button', { name: 'Reopen' })).toBeTruthy();
  });
  it('unknown draft', async () => {
    start('/publish/compose?draft=zz', { 'GET /api/publishing/drafts/zz': { status: 404, json: { error: 'not_found', message: 'No such draft.' } } }); expect(await screen.findByText('Draft not found')).toBeTruthy();
  });
  it('has no axe violations', async () => {
    start('/publish/compose?draft=d1', { 'GET /api/publishing/drafts/d1': { json: draft({ state: 'READY' }) } }); await screen.findByLabelText('Caption'); await screen.findByRole('button', { name: 'Approve…' }); expect(await axe(document.body)).toHaveNoViolations();
  });
  it('the viewer offers “Create Instagram draft” for a photograph', async () => {
    start(`/library?photo=${idOf(1)}`, { [`GET /api/library/photos/${idOf(1)}`]: { json: (await import('../test/fakeLibrary')).fakeDetail(1) } });
    expect((await screen.findByRole('link', { name: 'Create Instagram draft' })).getAttribute('href')).toBe(`/publish/compose?photo=${idOf(1)}`);
  });
});
