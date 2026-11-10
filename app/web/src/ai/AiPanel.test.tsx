import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDetail, idOf, libraryRoutes } from '../test/fakeLibrary';
import { mockApi, renderApp, signedIn, type Routes } from '../test/mockApi';
import type { AiStatus, AnalysisRow, PhotoAi, SpeciesLink } from './api';

afterEach(() => vi.unstubAllGlobals());

const analysis = (o: Partial<AnalysisRow> = {}): AnalysisRow => ({ id: 'an-1', provider: 'local-image', model: 'local-image-v1', mode: 'local', promptVersion: 'local-1', stale: false, createdAt: '2026-10-09T08:00:00Z', primarySubject: 'not identified', description: 'A landscape photograph in warm tones with high contrast and crisp detail.', tags: ['sharp', 'warm tones', 'high contrast'], scores: { sharpness: 0.81, exposure: 0.7, lighting: 0.66, composition: 0.58, subjectIsolation: 0.4, impact: 0.72, storytelling: null, uniqueness: null }, overall: 0.7, colours: ['amber', 'brown'], lighting: 'balanced exposure (mean brightness 118/255)', style: 'balanced, warm', current: true, ...o });
const sp = (o: Partial<SpeciesLink> = {}): SpeciesLink => ({ id: 'sp-1', name: 'Lion', scientific: 'Panthera leo', confidence: 0.82, status: 'SUGGESTED', source: 'AI_INFERRED', behavior: 'Resting', habitat: null, count: 1, analysis_id: 'an-1', ...o });
const photoAi = (o: Partial<PhotoAi> = {}): PhotoAi => ({ currentVersionId: 'v', queued: false, analyses: [analysis()], species: [], corrections: [], ...o });
const openAi = async (ai: PhotoAi, extra: Routes = {}) => {
  const lib = libraryRoutes(300, { [`GET /api/library/photos/${idOf(1)}`]: { json: fakeDetail(1) }, [`GET /api/ai/photos/${idOf(1)}`]: { json: ai }, ...extra });
  const calls = mockApi(signedIn(lib.routes)); renderApp(`/library?photo=${idOf(1)}&tab=ai`);
  const dlg = await screen.findByRole('dialog'); await userEvent.click(within(dlg).getByRole('tab', { name: 'AI Analysis' }));
  return { calls, dlg };
};

describe('viewer → AI Analysis', () => {
  it('shows what was measured, honestly labelled, with unassessed scores left unassessed', async () => {
    const { dlg } = await openAi(photoAi());
    expect(await within(dlg).findByText(/Measured on this computer · local-image local-image-v1/)).toBeTruthy();
    const m = (await within(dlg).findByText('Measurements')).closest('section')!;
    expect(within(m).getByText('Sharpness').nextElementSibling!.textContent).toBe('81%'); expect(within(m).getAllByText('Not assessed')).toHaveLength(2);
    expect(within(m).getByText(/judgement scores need a vision model/)).toBeTruthy(); expect(within(dlg).getByText('warm tones')).toBeTruthy();
    expect(within(dlg).getByText(/does not identify species/)).toBeTruthy();                                       // the subject section says what it cannot do
    expect(await axe(dlg)).toHaveNoViolations();
  });
  it('not analysed yet: says so, offers to analyse now', async () => {
    const { calls, dlg } = await openAi(photoAi({ analyses: [] }), { [`POST /api/ai/photos/${idOf(1)}/analyze`]: { json: { queued: 1 } } });
    expect(await within(dlg).findByText(/Not analysed yet/)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Analyse now' }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/ai/photos/${idOf(1)}/analyze`)).toBe(true));
    expect(await screen.findByText('Analysis queued')).toBeTruthy();
  });
  it('a queued analysis shows as queued', async () => {
    const { dlg } = await openAi(photoAi({ queued: true }));
    expect(await within(dlg).findByRole('progressbar', { name: 'Analysis queued' })).toBeTruthy();
  });
  it('species suggestions can be confirmed, rejected or corrected; suggestions are labelled AI with their confidence', async () => {
    const { calls, dlg } = await openAi(photoAi({ species: [sp(), sp({ id: 'sp-2', name: 'Leopard', scientific: null, confidence: 0.4 }), sp({ id: 'sp-3', name: 'Cheetah', status: 'REJECTED' })] }), {
      [`POST /api/ai/photos/${idOf(1)}/species/sp-1`]: { json: { ok: true } }, [`POST /api/ai/photos/${idOf(1)}/species/sp-2`]: { json: { ok: true } }, [`POST /api/ai/photos/${idOf(1)}/species`]: { json: { ok: true } } });
    const subject = (await within(dlg).findByText('Subject')).closest('section')!;
    expect(within(subject).getAllByText('AI').length).toBe(2); expect(within(subject).getByRole('img', { name: /Lion: AI confidence 82 percent/ })).toBeTruthy();
    expect(within(subject).getByText(/Not shown again: Cheetah/)).toBeTruthy(); expect(within(subject).queryByText('Cheetah')).toBeNull();
    await userEvent.click(within(subject).getAllByRole('button', { name: 'Confirm' })[0]!);
    await userEvent.click(within(subject).getAllByRole('button', { name: 'Not this' })[1]!);
    await waitFor(() => expect(calls.filter((c) => c.path.includes('/species/sp-')).map((c) => [c.path.split('/').pop(), c.body])).toEqual([['sp-1', { action: 'confirm' }], ['sp-2', { action: 'reject' }]]));
    await userEvent.click(within(subject).getAllByRole('button', { name: 'Correct…' })[0]!);
    await userEvent.type(within(subject).getByLabelText('Species'), 'African wild dog'); await userEvent.type(within(subject).getByLabelText('Scientific name (optional)'), 'Lycaon pictus');
    await userEvent.click(within(subject).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === `/api/ai/photos/${idOf(1)}/species`)?.body).toEqual({ commonName: 'African wild dog', scientificName: 'Lycaon pictus', replaces: 'sp-1' }));
  });
  it('a confirmed species is yours, not AI: no AI tag, no confidence', async () => {
    const { dlg } = await openAi(photoAi({ species: [sp({ status: 'CONFIRMED', source: 'USER_DEFINED', confidence: null })] }));
    const subject = (await within(dlg).findByText('Subject')).closest('section')!;
    expect(within(subject).getByText('Confirmed by you')).toBeTruthy(); expect(within(subject).queryByText('AI')).toBeNull(); expect(within(subject).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });
  it('accepting the description, analysing again, history and your decisions', async () => {
    const { calls, dlg } = await openAi(photoAi({ analyses: [analysis(), analysis({ id: 'an-0', provider: 'mock', mode: 'mock', current: false, stale: true, createdAt: '2026-10-01T08:00:00Z', overall: null })],
      corrections: [{ id: 'c1', kind: 'SPECIES_CONFIRM', before: null, after: { species: 'Lion' }, at: '2026-10-09T09:00:00Z' }] }), {
      [`POST /api/ai/photos/${idOf(1)}/accept-description`]: { json: { ok: true } }, [`POST /api/ai/photos/${idOf(1)}/analyze`]: { json: { queued: 1 } } });
    await userEvent.click(await within(dlg).findByRole('button', { name: /Use as this photograph’s description/ }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/accept-description'))?.body).toEqual({ analysisId: 'an-1' }));
    expect(await screen.findByText('Description saved')).toBeTruthy();
    const hist = (await within(dlg).findByText('Analysis history')).closest('section')!;
    expect(within(hist).getByText('Mock answer (testing)')).toBeTruthy(); expect(within(hist).getByText(/earlier version · older method/)).toBeTruthy();
    expect(within(dlg).getByText('Your decisions about AI output')).toBeTruthy();
    await userEvent.click(within(hist).getByRole('button', { name: 'Analyse again' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/analyze'))).toBe(true));
  });
});

describe('Settings → AI', () => {
  const status = (o: Partial<AiStatus> = {}): AiStatus => ({ settings: { provider: 'local-image', autoAnalyze: true }, promptVersion: 'local-1', photos: 100, analysed: 60, stale: 5, jobs: { QUEUED: 3 }, live: { enabled: false, lifetimePhotoCap: 200, spendRecords: 0, spentUsd: 0 },
    providers: [{ id: 'local-image', label: 'Local image analysis', kind: 'local', available: true, note: 'Runs on this computer.' }, { id: 'mock', label: 'Mock (for testing)', kind: 'mock', available: true, note: 'Fake answers.' }, { id: 'hosted', label: 'Hosted vision model (species, behaviour, scenes)', kind: 'live', available: false, note: 'Off. Needs your approval.' }], ...o });
  it('shows the provider choices (hosted disabled), progress and the "nothing sent" statement; changes are saved', async () => {
    const calls = mockApi(signedIn({ 'GET /api/ai/status': { json: status() }, 'PUT /api/ai/settings': (c) => ({ json: { provider: 'local-image', autoAnalyze: true, ...(c.body as object) } }), 'POST /api/ai/analyze': { json: { queued: 40, alreadyAnalysed: 60, waitingForPreviews: 0 } } }));
    renderApp('/settings/ai');
    expect(await screen.findByRole('heading', { level: 1, name: 'AI' })).toBeTruthy();
    const provs = await screen.findByRole('radiogroup', { name: 'Analysis provider' });
    expect((within(provs).getByRole('radio', { name: /Local image analysis/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(provs).getByRole('radio', { name: /Hosted vision model/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('60 of 100 photographs analysed · 5 with an older method · 3 queued');
    const hosted = screen.getByRole('region', { name: 'Hosted AI' }); expect(within(hosted).getByText('Off')).toBeTruthy(); expect(within(hosted).getByText(/Nothing, ever, so far \(0 paid calls, \$0.00 spent\)/)).toBeTruthy();
    await userEvent.click(within(provs).getByRole('radio', { name: /Mock/ }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ provider: 'mock' }));
    await userEvent.click(screen.getByRole('switch', { name: /Analyse new photographs automatically/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toContainEqual({ autoAnalyze: false }));
    await userEvent.click(screen.getByRole('button', { name: /Analyse what is missing or out of date/ }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/ai/analyze')?.body).toEqual({ target: { query: { view: 'all' }, exclude: [] }, force: false }));
    expect(await screen.findByText('40 photographs queued')).toBeTruthy();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('Library bulk action', () => {
  it('Analyse sends the selection (by id) to the queue', async () => {
    const lib = libraryRoutes(300, { 'POST /api/ai/analyze': { json: { queued: 1, alreadyAnalysed: 0, waitingForPreviews: 0 } } }); const calls = mockApi(signedIn(lib.routes)); renderApp('/library');
    await screen.findByRole('listbox'); await userEvent.click((await screen.findAllByRole('option'))[0]!);
    await userEvent.click(within(await screen.findByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Analyse' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/ai/analyze')?.body).toEqual({ target: { ids: [idOf(0)] }, force: false }));
    expect(await screen.findByText('1 queued for analysis')).toBeTruthy();
  });
});
