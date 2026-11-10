import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { makeCalendarItems, makeHistory, makePhotos, detailFor } from '../design/fixtures';
import { emptySelection, type SelectionState } from '../lib/selection';
import { Button, IconButton } from './Button';
import { SegmentedControl, SearchField, Switch } from './controls';
import { ToastProvider, useToast, EmptyState, ErrorState, ProcessingState, Hairline } from './feedback';
import { PhotoGrid } from './PhotoGrid';
import { PhotoViewer, type ViewerSurface } from './PhotoViewer';
import { StarRating } from './StarRating';
import { ConfidenceMeter, InstagramStatus, MatchBadge, PUBLISH_STATES, StatusChip } from './status';
import { CalendarGrid } from './calendar/CalendarGrid';
import { Agenda } from './calendar/Agenda';
import { MoveDialog } from './calendar/MoveDialog';
import { HistoryGrid } from './history/HistoryGrid';
import { MatchCompare } from './history/MatchCompare';
import { DuplicateWarning } from './history/DuplicateWarning';
import { Tabs } from './Tabs';
import { Dialog } from './Dialog';

const noViolations = async (el: HTMLElement) => expect(await axe(el)).toHaveNoViolations();

describe('buttons and controls', () => {
  it('icon buttons are named; primary/secondary have no a11y violations', async () => {
    const { container } = render(<div><Button variant="primary">Schedule</Button><IconButton icon="close" label="Close" /><SearchField /><Switch checked onChange={() => {}} label="Show AI scores" /></div>);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    await noViolations(container);
  });
  it('segmented control is a radio group with arrow-key selection', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="View" value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />);
    const a = screen.getByRole('radio', { name: 'A' });
    expect(a.getAttribute('aria-checked')).toBe('true');
    a.focus(); await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('b');
  });
  it('switch toggles via keyboard', async () => {
    const onChange = vi.fn(); render(<Switch checked={false} onChange={onChange} label="Neutral background" />);
    await userEvent.tab(); await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('star rating', () => {
  it('keys 0–5 set the rating, arrows move, clicking the same star clears', async () => {
    const Harness = () => { const [v, setV] = useState(2); return <><StarRating value={v} onChange={setV} /><output>{v}</output></>; };
    const { container } = render(<Harness />);
    await userEvent.tab(); await userEvent.keyboard('4');
    expect(container.querySelector('output')!.textContent).toBe('4');
    await userEvent.keyboard('{ArrowLeft}'); expect(container.querySelector('output')!.textContent).toBe('3');
    await userEvent.click(screen.getByRole('radio', { name: '3 stars' })); expect(container.querySelector('output')!.textContent).toBe('0');
    await noViolations(container);
  });
  it('read-only rating exposes its value as text', () => {
    render(<StarRating value={4} />);
    expect(screen.getByRole('img', { name: 'Rating: 4 of 5' })).toBeTruthy();
  });
});

describe('status indicators never rely on colour alone', () => {
  it('every publishing state has a visible word', async () => {
    const { container } = render(<div>{PUBLISH_STATES.map((s) => <StatusChip key={s} state={s} />)}</div>);
    for (const s of PUBLISH_STATES) expect(within(container).getByText(s)).toBeTruthy();
    await noViolations(container);
  });
  it('Instagram status: never-posted is silent unless requested; counts shown', () => {
    const { container, rerender } = render(<InstagramStatus state="NEVER_POSTED" />);
    expect(container.textContent).toBe('');
    rerender(<InstagramStatus state="NEVER_POSTED" showNever />); expect(container.textContent).toContain('NEVER POSTED');
    rerender(<InstagramStatus state="POSTED" count={3} />); expect(container.textContent).toContain('POSTED ×3');
  });
  it('confidence exposes a numeric accessible name; match badge shows similarity', async () => {
    const { container } = render(<div><ConfidenceMeter value={0.92} label="Species" /><MatchBadge state="POSSIBLE_MATCH" similarity={0.92} /></div>);
    expect(screen.getByRole('img', { name: /Species: AI confidence 92 percent/ })).toBeTruthy();
    expect(container.textContent).toContain('92%');
    await noViolations(container);
  });
  it('processing and empty/error states are announced', async () => {
    const { container } = render(<div><ProcessingState kind="analysing" detail="2 of 9" /><Hairline value={0.5} label="Import" /><EmptyState title="Nothing here">Hint</EmptyState><ErrorState title="Drive disconnected" onRetry={() => {}}>Nothing was changed.</ErrorState></div>);
    expect(screen.getByRole('alert').textContent).toContain('Drive disconnected');
    expect(screen.getByRole('progressbar', { name: 'Import' }).getAttribute('aria-valuenow')).toBe('50');
    await noViolations(container);
  });
});

describe('PhotoGrid', () => {
  const photos = makePhotos(400);
  function Harness({ onOpen = () => {}, items = photos }: { onOpen?: (i: number) => void; items?: typeof photos }) {
    const [sel, setSel] = useState<SelectionState>(emptySelection);
    return <div style={{ height: 600 }}><PhotoGrid items={items} rowHeight={150} selection={sel} onSelectionChange={setSel} onOpen={onOpen} onRate={() => {}} /></div>;
  }
  it('renders only a window of a large library (virtualised)', () => {
    render(<Harness items={makePhotos(100_000)} />);
    const rendered = screen.getAllByRole('option').length;
    expect(rendered).toBeGreaterThan(0); expect(rendered).toBeLessThan(400);
  });
  it('is a single labelled tab stop with multiselect semantics and no a11y violations', async () => {
    const { container } = render(<Harness />);
    const lb = screen.getByRole('listbox', { name: 'Photographs' });
    expect(lb.getAttribute('aria-multiselectable')).toBe('true'); expect(lb.tabIndex).toBe(0);
    expect(screen.getAllByRole('option').every((o) => o.tabIndex < 0 || o.getAttribute('tabindex') === null)).toBe(true);
    await noViolations(container);
  });
  it('arrow keys move the virtual focus; Space selects; Shift+Arrow extends; Enter opens; Esc clears', async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const lb = screen.getByRole('listbox'); lb.focus();
    const first = () => lb.getAttribute('aria-activedescendant');
    const a0 = first();
    await userEvent.keyboard('{ArrowRight}'); expect(first()).not.toBe(a0);
    await userEvent.keyboard(' ');
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(screen.getAllByRole('option', { selected: true }).length).toBeGreaterThanOrEqual(3);
    await userEvent.keyboard('{Enter}'); expect(onOpen).toHaveBeenCalled();
    await userEvent.keyboard('{Escape}'); expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
  });
  it('Ctrl+A selects everything, click and Cmd-click select and toggle', async () => {
    render(<Harness items={photos.slice(0, 30)} />);
    const lb = screen.getByRole('listbox'); lb.focus();
    await userEvent.keyboard('{Control>}a{/Control}');
    expect(screen.getAllByRole('option', { selected: true }).length).toBe(screen.getAllByRole('option').length);
    const opts = screen.getAllByRole('option');
    fireEvent.click(opts[0]!); expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);
    fireEvent.click(opts[2]!, { metaKey: true }); expect(screen.getAllByRole('option', { selected: true })).toHaveLength(2);
  });
  it('never distorts photographs: each cell has the photograph\'s aspect ratio', () => {
    render(<Harness items={photos.slice(0, 40)} />);
    for (const o of screen.getAllByRole('option')) {
      const el = o as HTMLElement; const i = Number(el.dataset.index);
      const ratio = parseFloat(el.style.width) / parseFloat(el.style.height);
      expect(ratio).toBeCloseTo(photos[i]!.width / photos[i]!.height, 2);
    }
  });
  it('every thumbnail has an accessible name that includes rating/favourite/Instagram state', () => {
    render(<Harness items={[{ ...photos[0]!, rating: 4, favorite: true, ig: { state: 'POSTED', count: 2 } }]} />);
    expect(screen.getByRole('option').getAttribute('aria-label')).toMatch(/rated 4 of 5.*favourite.*Instagram posted/);
  });
});

describe('PhotoViewer', () => {
  const items = makePhotos(8);
  function Harness({ start = 0 }: { start?: number }) {
    const [i, setI] = useState(start); const [s, setS] = useState<ViewerSurface>('teal'); const [p, setP] = useState(true);
    return <PhotoViewer items={items} index={i} onIndexChange={setI} onClose={() => {}} detail={detailFor} surface={s} onSurfaceChange={setS} panelOpen={p} onPanelOpenChange={setP} />;
  }
  it('is a labelled modal dialog showing the photograph uncropped with alt text and no filters', async () => {
    render(<Harness />);
    const dlg = screen.getByRole('dialog', { name: items[0]!.title });
    const img = within(dlg).getAllByRole('img', { name: items[0]!.alt })[0] as HTMLImageElement;
    expect(img.alt).toBe(items[0]!.alt);
    const stageImg = dlg.querySelector('.jb-viewer__stage img') as HTMLImageElement;
    expect(stageImg.style.filter).toBe(''); expect(stageImg.style.mixBlendMode).toBe(''); expect(stageImg.style.objectFit).toBe('');
  });
  it('arrow keys navigate, I toggles the panel, N toggles the neutral-grey surface', async () => {
    render(<Harness />);
    const dlg = screen.getByRole('dialog');
    await userEvent.keyboard('{ArrowRight}'); expect(dlg.querySelector('.jb-viewer__bar')!.textContent).toContain('2 / 8');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}'); expect(dlg.querySelector('.jb-viewer__bar')!.textContent).toContain('1 / 8');
    expect(dlg.getAttribute('data-panel')).toBe('open'); await userEvent.keyboard('i'); expect(dlg.getAttribute('data-panel')).toBe('closed');
    expect((dlg as HTMLElement).style.getPropertyValue('--viewer-surface')).toBe('var(--abyss-0)');
    await userEvent.keyboard('n'); expect((dlg as HTMLElement).style.getPropertyValue('--viewer-surface')).toBe('#2e2e2e');
  });
  it('panel has the five contextual tabs with labelled content', async () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Information', 'AI Analysis', 'EXIF', 'Collections', 'Publish']);
    await userEvent.click(screen.getByRole('tab', { name: 'AI Analysis' }));
    expect(screen.getAllByText('AI').length).toBeGreaterThan(1);
  });
  it('zooms with + / −, double-click and Z; Esc leaves zoom before it closes; zoom resets on the next photograph', async () => {
    const onClose = vi.fn();
    function H() { const [i, setI] = useState(0); return <PhotoViewer items={items} index={i} onIndexChange={setI} onClose={onClose} detail={detailFor} surface="teal" onSurfaceChange={() => {}} panelOpen onPanelOpenChange={() => {}} />; }
    render(<H />);
    const dlg = screen.getByRole('dialog'); const img = () => dlg.querySelector('.jb-viewer__stage img') as HTMLImageElement;
    expect(img().style.transform).toBe('');                                   // fitted: no transform
    await userEvent.keyboard('+'); expect(img().style.transform).toMatch(/scale\(1\.5\)/);
    await userEvent.keyboard('+'); expect(img().style.transform).toMatch(/scale\(2\.25\)/);
    expect(within(dlg).getByText('225%')).toBeTruthy();
    await userEvent.keyboard('-'); expect(img().style.transform).toMatch(/scale\(1\.5\)/);
    await userEvent.keyboard('{Escape}'); expect(img().style.transform).toBe(''); expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('z'); expect(img().style.transform).toMatch(/scale\(2\.5\)/);
    await userEvent.keyboard('{ArrowRight}');                                   // zoomed: arrows pan, they do not navigate
    expect(dlg.querySelector('.jb-viewer__bar')!.textContent).toContain('1 / 8');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next photograph' }));
    expect(dlg.querySelector('.jb-viewer__bar')!.textContent).toContain('2 / 8'); expect(img().style.transform).toBe('');
    await userEvent.dblClick(img()); expect(img().style.transform).toMatch(/scale\(2\.5\)/);
    await userEvent.dblClick(img()); expect(img().style.transform).toBe('');
    await userEvent.click(within(dlg).getByRole('button', { name: /Zoom in/ })); await userEvent.click(within(dlg).getByRole('button', { name: /Fit to screen/ })); expect(img().style.transform).toBe('');
  });
  it('F favourites, P toggles the portfolio, 0–5 rates; rate/favourite/portfolio are all reachable by keyboard', async () => {
    const onRate = vi.fn(), onFavorite = vi.fn(), onPortfolio = vi.fn();
    render(<PhotoViewer items={items} index={0} onIndexChange={() => {}} onClose={() => {}} detail={detailFor} surface="teal" onSurfaceChange={() => {}} panelOpen onPanelOpenChange={() => {}} onRate={onRate} onFavorite={onFavorite} onPortfolio={onPortfolio} />);
    await userEvent.keyboard('f'); expect(onFavorite).toHaveBeenCalledWith(items[0]!.id, !items[0]!.favorite);
    await userEvent.keyboard('p'); expect(onPortfolio).toHaveBeenCalledWith(items[0]!.id, !items[0]!.portfolio);
    await userEvent.keyboard('4'); expect(onRate).toHaveBeenCalledWith(items[0]!.id, 4);
    expect(screen.getByRole('button', { name: 'Portfolio candidate (P)' })).toBeTruthy();
  });
  it('asks for more photographs when it nears the end of what is loaded', () => {
    const onNeedMore = vi.fn();
    render(<PhotoViewer items={items} index={6} onIndexChange={() => {}} onClose={() => {}} detail={detailFor} surface="teal" onSurfaceChange={() => {}} panelOpen onPanelOpenChange={() => {}} onNeedMore={onNeedMore} />);
    expect(onNeedMore).toHaveBeenCalled();
  });
  it('has no axe violations', async () => {
    render(<Harness />);
    await noViolations(document.body);
  });
});

describe('Calendar', () => {
  const tz = 'Europe/London';
  const today = '2026-10-08';
  const items = makeCalendarItems(today, tz);
  const base = { mode: 'month' as const, year: 2026, month: 9, anchor: today, today, items, onCreate: vi.fn(), onOpen: vi.fn(), onMove: vi.fn(), onRequestMove: vi.fn() };
  it('month grid has 42 days, shows photographs, and states as text', async () => {
    const { container } = render(<CalendarGrid {...base} />);
    expect(screen.getAllByRole('cell')).toHaveLength(42); expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(container.querySelectorAll('.jb-entry img').length).toBeGreaterThan(5);
    expect(within(container).getAllByText('FAILED').length).toBeGreaterThan(0);
    await noViolations(container);
  });
  it('week view has 7 days', () => { render(<CalendarGrid {...base} mode="week" />); expect(screen.getAllByRole('cell')).toHaveLength(7); });
  it('arrow keys move between days and Enter creates a post (no mouse needed)', async () => {
    const onCreate = vi.fn(); render(<CalendarGrid {...base} onCreate={onCreate} />);
    document.querySelector<HTMLElement>(`[data-add="${today}"]`)!.focus(); await userEvent.keyboard('{ArrowRight}');
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-add')).toBe('2026-10-09'));
    await userEvent.keyboard('{Enter}'); expect(onCreate).toHaveBeenCalledWith('2026-10-09');
  });
  it('M on a movable entry requests the Move dialog; published entries cannot be moved', async () => {
    const onRequestMove = vi.fn(); render(<CalendarGrid {...base} onRequestMove={onRequestMove} />);
    const scheduled = screen.getAllByRole('button', { name: /SCHEDULED/ })[0]!; scheduled.focus();
    await userEvent.keyboard('m'); expect(onRequestMove).toHaveBeenCalledTimes(1);
    onRequestMove.mockClear();
    const published = screen.getAllByRole('button', { name: /PUBLISHED/ })[0]!; published.focus();
    await userEvent.keyboard('m'); expect(onRequestMove).not.toHaveBeenCalled();
    expect(published.getAttribute('draggable')).toBe('false');
  });
  it('dropping an entry on another day moves it, keeping its local time', () => {
    const onMove = vi.fn(); render(<CalendarGrid {...base} onMove={onMove} />);
    const entry = screen.getAllByRole('button', { name: /SCHEDULED/ })[0]!;
    const id = items.find((i) => i.state === 'SCHEDULED')!.id;
    const target = document.querySelector<HTMLElement>('[data-day="2026-10-20"]')!;
    const dt = { getData: () => id, setData: () => {}, dropEffect: '', effectAllowed: '' };
    fireEvent.dragStart(entry, { dataTransfer: dt }); fireEvent.dragOver(target, { dataTransfer: dt }); fireEvent.drop(target, { dataTransfer: dt });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [, iso] = onMove.mock.calls[0]!;
    expect(String(iso)).toMatch(/^2026-10-20T/);
  });
  it('Move dialog (non-drag alternative) reschedules to the chosen date and time', async () => {
    const onMove = vi.fn(); const it = items.find((i) => i.state === 'SCHEDULED')!;
    render(<MoveDialog item={it} onClose={() => {}} onMove={onMove} />);
    expect(screen.getByRole('dialog', { name: 'Reschedule post' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: '2026-11-02' } });
    fireEvent.change(screen.getByLabelText(/^Time/), { target: { value: '08:15' } });
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledWith(it.id, '2026-11-02T08:15:00.000Z');
  });
  it('agenda (phone) lists posts chronologically', async () => {
    const { container } = render(<Agenda items={items} onOpen={() => {}} />);
    expect(container.querySelectorAll('.jb-agenda__item').length).toBe(items.length);
    await noViolations(container);
  });
});

describe('Instagram history components', () => {
  it('archive grid has year dividers newest-first, and tiles name their date, caption and match state', async () => {
    const { container } = render(<HistoryGrid items={makeHistory(40)} onOpen={() => {}} />);
    const years = [...container.querySelectorAll('.jb-hist__year .t-h2')].map((e) => Number(e.textContent));
    expect(years.length).toBeGreaterThan(1); expect([...years].sort((a, b) => b - a)).toEqual(years);
    const tile = container.querySelector('.jb-hist__tile') as HTMLElement;
    expect(tile.textContent).toMatch(/\d{1,2} \w{3} \d{4}/);          // date
    expect(tile.textContent).toMatch(/Quiet light/);                   // caption
    expect(tile.querySelector('img')!.alt).not.toBe('');
    await noViolations(container);
  });
  it('match comparison supports Y / N / S shortcuts and buttons', async () => {
    const onDecide = vi.fn();
    const { container } = render(<MatchCompare instagram={{ src: '/a.jpg', alt: 'ig', postedAt: '2025-03-14T18:30:00Z', caption: 'c' }} library={{ src: '/b.jpg', alt: 'lib', title: 't' }} similarity={0.92} signals={[['Visual', '94']]} onDecide={onDecide} />);
    await userEvent.keyboard('y'); await userEvent.keyboard('n'); await userEvent.keyboard('s');
    expect(onDecide.mock.calls.map((c) => c[0])).toEqual(['confirm', 'reject', 'skip']);
    expect(screen.getByText('Similarity 92 percent')).toBeTruthy();
    await noViolations(container);
  });
  it('duplicate warning informs but offers Continue anyway', async () => {
    const onContinue = vi.fn();
    const { container } = render(<DuplicateWarning kind="same" last={{ src: '/a.jpg', alt: 'prev', postedAt: '2025-03-14T18:30:00Z', caption: 'cap' }} onView={() => {}} onContinue={onContinue} onCancel={() => {}} />);
    expect(container.textContent).toContain('previously posted');
    await userEvent.click(screen.getByRole('button', { name: 'Continue anyway' })); expect(onContinue).toHaveBeenCalled();
    await noViolations(container);
  });
});

describe('dialogs, tabs and notifications', () => {
  it('dialog traps focus semantics, has a title and closes on Escape', async () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="Remove from collection?" description="The photograph stays in your library." actions={<Button>OK</Button>} />);
    expect(screen.getByRole('dialog', { name: 'Remove from collection?' })).toBeTruthy();
    await userEvent.keyboard('{Escape}'); expect(onOpenChange).toHaveBeenCalledWith(false);
    await noViolations(document.body);
  });
  it('tabs move with arrow keys', async () => {
    render(<Tabs label="t" tabs={[{ value: 'a', label: 'A', content: 'one' }, { value: 'b', label: 'B', content: 'two' }]} />);
    screen.getByRole('tab', { name: 'A' }).focus(); await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
  });
  it('toasts: polite live region; info auto-dismisses, errors persist until dismissed', async () => {
    vi.useFakeTimers();
    function T() { const t = useToast(); return <><button onClick={() => t({ kind: 'info', title: 'Saved' })}>i</button><button onClick={() => t({ kind: 'error', title: 'Backup overdue' })}>e</button></>; }
    const { container } = render(<ToastProvider><T /></ToastProvider>);
    fireEvent.click(screen.getByText('i')); fireEvent.click(screen.getByText('e'));
    expect(screen.getByRole('status').textContent).toContain('Saved'); expect(screen.getByRole('alert').textContent).toContain('Backup overdue');
    act(() => { vi.advanceTimersByTime(6500); });
    expect(screen.queryByText('Saved')).toBeNull(); expect(screen.getByText('Backup overdue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' })); expect(screen.queryByText('Backup overdue')).toBeNull();
    vi.useRealTimers(); await noViolations(container);
  });
});

void MemoryRouter;
