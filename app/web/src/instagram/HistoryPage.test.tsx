import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IgAccount, IgPost, ReviewItem } from '../api/instagram';
import { fakeCard, fakeDetail, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';

afterEach(() => vi.unstubAllGlobals());

const post = (n: number, o: Partial<IgPost> = {}): IgPost => ({
  id: `post-${n}`, postedAt: `2025-0${1 + (n % 9)}-1${n % 9}T10:00:00.000Z`, caption: `Caption ${n} #wildlife`, hashtags: ['wildlife'], permalink: null, synthetic: true, mediaId: `media-${n}`, mediaCount: 1,
  match: { id: `m-${n}`, state: 'HIGH_CONFIDENCE_MATCH', score: 0.97, photoId: idOf(n), photoTitle: `Photograph ${n}` }, ...o,
});
const POSTS = [post(1), post(2, { match: { id: 'm-2', state: 'POSSIBLE_MATCH', score: 0.71, photoId: idOf(2), photoTitle: 'Photograph 2' } }), post(3, { match: null }), post(4, { match: { id: 'm-4', state: 'USER_CONFIRMED', score: 1, photoId: idOf(4), photoTitle: 'Photograph 4' } })];
const ACCOUNT: IgAccount = { account: { id: 'a1', username: 'synthetic_archive', type: 'SYNTHETIC', status: 'DISCONNECTED', synthetic: true, lastSyncAt: '2026-10-09T10:00:00Z', lastError: null }, stats: { posts: 4, matched: 2, review: 1, unmatched: 1 }, syncing: false,
  lastRun: { startedAt: '2026-10-09T09:59:00Z', finishedAt: '2026-10-09T10:00:00Z', status: 'OK', postsSeen: 4, postsNew: 4, mediaFailed: 0, matched: 3, error: null }, capabilities: { synthetic: true, live: false } };
const review = (n = 2): ReviewItem[] => Array.from({ length: n }, (_, i) => ({
  matchId: `r-${i + 1}`, score: 0.8 - i * 0.1, signals: { embedding: 0.95, dateConsistent: true, captionOverlap: 0.5 }, phashDistance: 9, embeddingSimilarity: 0.95, alternatives: i === 0 ? 1 : 0,
  post: { id: `post-${i + 2}`, mediaId: `media-${i + 2}`, postedAt: '2025-03-14T18:30:00.000Z', caption: `Quiet light ${i}`, permalink: null }, photo: fakeCard(i + 5),
}));
const counts = { all: 4, matched: 2, review: 1, unmatched: 1 };
const start = (path = '/publish/history', extra: Routes = {}) => {
  const lib = libraryRoutes(30);
  const calls = mockApi(signedIn({ ...lib.routes, 'GET /api/instagram/account': { json: ACCOUNT }, 'GET /api/instagram/history': { json: { items: POSTS, nextCursor: null, counts } }, 'GET /api/instagram/review': { json: { total: 2, items: review() } }, ...extra }));
  renderApp(path); return calls;
};

describe('Instagram history (real data)', () => {
  it('shows the archive, labelled as synthetic and not connected, with the last sync', async () => {
    start();
    expect(await screen.findByRole('heading', { name: 'Instagram history' })).toBeTruthy();
    expect(await screen.findByText(/made-up posts for development; this app is not connected to Instagram/)).toBeTruthy(); expect(screen.getByText(/4 posts seen, 4 new, 3 matched/)).toBeTruthy();
    expect((await screen.findAllByRole('button', { name: /Instagram post from/ })).length).toBe(4);
    expect(document.querySelector('img[src="/api/instagram/media/media-1/image"]')).toBeTruthy();
  });
  it('the filter tabs carry counts and ask the server for that slice', async () => {
    const calls = start();
    await userEvent.click(await screen.findByRole('radio', { name: /Needs review 1/ }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/instagram/history' && c.query.get('filter') === 'review')).toBe(true));
    expect(screen.getByRole('radio', { name: /Matched 2/ })).toBeTruthy(); expect(screen.getByRole('radio', { name: /Not in my library 1/ })).toBeTruthy();
  });
  it('no account: says so plainly and offers a synthetic archive only where the server allows it', async () => {
    start('/publish/history', { 'GET /api/instagram/account': { json: { ...ACCOUNT, account: null, stats: { posts: 0, matched: 0, review: 0, unmatched: 0 } } }, 'GET /api/instagram/history': { json: { items: [], nextCursor: null, counts: { all: 0, matched: 0, review: 0, unmatched: 0 } } }, 'GET /api/instagram/review': { json: { total: 0, items: [] } } });
    expect(await screen.findByText(/No Instagram account is connected/)).toBeTruthy(); expect(screen.getByText(/needs a Meta app and your approval/)).toBeTruthy(); expect(await screen.findByRole('button', { name: 'Create a synthetic archive from my library' })).toBeTruthy();
    expect(await screen.findByText('No posts yet')).toBeTruthy();
  });
  it('production-style: no synthetic option is offered', async () => {
    start('/publish/history', { 'GET /api/instagram/account': { json: { ...ACCOUNT, account: null, capabilities: { synthetic: false, live: false } } } });
    await screen.findByText(/No Instagram account is connected/); expect(screen.queryByRole('button', { name: /synthetic archive/i })).toBeNull();
  });
  it('creating the synthetic archive posts once and says what it did', async () => {
    const calls = start('/publish/history', { 'GET /api/instagram/account': { json: { ...ACCOUNT, account: null } }, 'POST /api/instagram/synthetic': { status: 201, json: { archive: { posts: 40 }, queued: true } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Create a synthetic archive from my library' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/instagram/synthetic')?.body).toEqual({ count: 40 }));
    expect(await screen.findByText(/40 made-up posts built from your own library pictures/)).toBeTruthy();
  });
  it('a post opens with its caption, its match, and decisions that are sent as the person’s own', async () => {
    const calls = start('/publish/history', { 'POST /api/instagram/matches/m-2': { json: { ok: true } } });
    await userEvent.click(await screen.findByRole('button', { name: /Caption 2/ }));
    const dlg = await screen.findByRole('dialog'); expect(within(dlg).getByText(/Caption 2/)).toBeTruthy(); expect(within(dlg).getByRole('link', { name: 'Photograph 2' }).getAttribute('href')).toBe(`/library?photo=${idOf(2)}`);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Yes, it is this photograph' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/instagram/matches/m-2')?.body).toEqual({ decision: 'confirm' }));
  });
  it('unlinking a confirmed match is a rejection; an unmatched post can be linked by search', async () => {
    const calls = start('/publish/history', { 'POST /api/instagram/matches/m-4': { json: { ok: true } }, 'POST /api/instagram/media/media-3/link': { json: { ok: true } } });
    await userEvent.click(await screen.findByRole('button', { name: /Caption 4/ })); let dlg = await screen.findByRole('dialog'); await userEvent.click(within(dlg).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/instagram/matches/m-4')?.body).toEqual({ decision: 'reject' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(await screen.findByRole('button', { name: /Caption 3/ })); dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/Not matched to any photograph/)).toBeTruthy(); await userEvent.click(within(dlg).getByRole('button', { name: 'Link to a photograph…' }));
    const picker = (await screen.findAllByRole('dialog')).at(-1)!; await userEvent.click(await within(picker).findByRole('button', { name: `Link to Photograph 3` }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/instagram/media/media-3/link')?.body).toEqual({ photoId: idOf(3) }));
  });
  it('failed load: an error with retry', async () => {
    start('/publish/history', { 'GET /api/instagram/history': { status: 500, json: { error: 'x', message: 'x' } } });
    expect(await screen.findByText('The history could not be loaded')).toBeTruthy();
  });
});

describe('review queue', () => {
  it('shows the Instagram image beside the library photograph, with the reasons; Y confirms and moves on', async () => {
    const calls = start('/publish/history', { 'POST /api/instagram/matches/r-1': { json: { ok: true } } });
    expect(await screen.findByText(/2 of 2 to review · 1 other candidate for this post/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Review 2 possible matches/ })).toBeTruthy();
    expect(screen.getByText(/Photograph 5/, { selector: 'p' })).toBeTruthy(); expect(screen.getByText('pHash distance')).toBeTruthy(); expect(screen.getByText('consistent')).toBeTruthy(); expect(screen.getByText('50% words')).toBeTruthy();
    await userEvent.keyboard('y');
    await waitFor(() => expect(calls.find((c) => c.path === '/api/instagram/matches/r-1')?.body).toEqual({ decision: 'confirm' }));
  });
  it('N rejects; S only skips (nothing is sent) and the next one appears', async () => {
    const calls = start('/publish/history', { 'POST /api/instagram/matches/r-2': { json: { ok: true } } });
    await screen.findByText(/2 of 2 to review/);
    await userEvent.keyboard('s'); expect(await screen.findByText(/1 of 2 to review/)).toBeTruthy(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.keyboard('n'); await waitFor(() => expect(calls.find((c) => c.path === '/api/instagram/matches/r-2')?.body).toEqual({ decision: 'reject' }));
  });
  it('skipping everything says so; nothing to review says decisions are remembered', async () => {
    start('/publish/history', { 'GET /api/instagram/review': { json: { total: 1, items: review(1) } } });
    await screen.findByText(/1 of 1 to review/); await userEvent.keyboard('s'); expect(await screen.findByText('You have skipped everything for now')).toBeTruthy();
  });
  it('empty queue', async () => {
    start('/publish/history', { 'GET /api/instagram/review': { json: { total: 0, items: [] } } });
    expect(await screen.findByText('Nothing to review')).toBeTruthy(); expect(screen.getByText(/remembered and never asked twice/)).toBeTruthy();
  });
  it('has no axe violations', async () => {
    start(); await screen.findByText(/2 of 2 to review/); await screen.findAllByRole('button', { name: /Instagram post from/ }); expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('duplicate-post notice in the viewer', () => {
  it('a photograph already on Instagram says so, with the date; a look-alike says similar; otherwise nothing', async () => {
    const same = { kind: 'same', count: 2, last: { postId: 'p', mediaId: 'media-9', postedAt: '2025-03-14T18:30:00.000Z', caption: 'c', permalink: null } };
    start(`/library?photo=${idOf(1)}`, { [`GET /api/library/photos/${idOf(1)}`]: { json: fakeDetail(1) }, 'GET /api/instagram/posted-check': { json: same } });
    const note = await screen.findByRole('note', { name: 'Instagram history for this photograph' }); expect(within(note).getByText('Already posted to Instagram')).toBeTruthy(); expect(within(note).getByText(/2 times, last on/)).toBeTruthy(); expect(note.querySelector('img')!.getAttribute('src')).toBe('/api/instagram/media/media-9/image');
  });
  it('a similar image is described as similar, not as the same', async () => {
    start(`/library?photo=${idOf(1)}`, { [`GET /api/library/photos/${idOf(1)}`]: { json: fakeDetail(1) }, 'GET /api/instagram/posted-check': { json: { kind: 'similar', count: 1, last: { postId: 'p', mediaId: 'media-9', postedAt: '2025-03-14T18:30:00.000Z', caption: null, permalink: null } } } });
    expect(await screen.findByText('A similar image was posted')).toBeTruthy();
  });
  it('nothing is shown for a photograph that has not been posted', async () => {
    start(`/library?photo=${idOf(1)}`, { [`GET /api/library/photos/${idOf(1)}`]: { json: fakeDetail(1) } });
    await screen.findByRole('button', { name: 'Add to collection…' }); expect(screen.queryByRole('note', { name: 'Instagram history for this photograph' })).toBeNull();
  });
});
