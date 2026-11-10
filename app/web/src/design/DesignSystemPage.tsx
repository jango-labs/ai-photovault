import { Wordmark } from '../shell/Wordmark';
import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '../shell/PageHeader';
import { useAuth } from '../auth/AuthProvider';
import { cx } from '../lib/cx';
import { contrastRatio } from '../lib/contrast';
import { emptySelection, type SelectionState } from '../lib/selection';
import { useMediaQuery, usePersistentState } from '../lib/hooks';
import { Body, BodyLg, Caption, Display, H1, H2, H3, Label, LabelSm, Meta, Stat } from '../ui/typography';
import { Button, IconButton } from '../ui/Button';
import { ActionMenu, FilterMenu, Select } from '../ui/Dropdown';
import { FilterChip, SearchField, SegmentedControl, Slider, Switch } from '../ui/controls';
import { Tabs } from '../ui/Tabs';
import { Dialog } from '../ui/Dialog';
import { EmptyState, ErrorState, Hairline, ProcessingState, Skeleton, useToast } from '../ui/feedback';
import { AiTag, ConfidenceMeter, InstagramStatus, MatchBadge, PortfolioMark, PUBLISH_STATES, StatusChip, type MatchState } from '../ui/status';
import { FavoriteButton, StarRating } from '../ui/StarRating';
import { PhotoGrid } from '../ui/PhotoGrid';
import { PhotoViewer, type ViewerSurface } from '../ui/PhotoViewer';
import { Icon, ICON_NAMES } from '../ui/Icon';
import { detailFor, makePhotos } from './fixtures';
import { CalendarDemo, HistoryDemo } from './demos';

const SECTIONS = [['color', 'Colour'], ['type', 'Typography'], ['controls', 'Controls'], ['nav', 'Navigation'], ['grid', 'Photo grid'], ['viewer', 'Photo viewer'],
  ['status', 'Status'], ['calendar', 'Calendar'], ['history', 'Instagram history'], ['feedback', 'Feedback'], ['responsive', 'Responsive & a11y']] as const;

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  return (
    <section id={id} className="ds__sec" aria-labelledby={`${id}-h`}>
      <header style={{ display: 'grid', gap: 8 }}><Label>{id.toUpperCase().replace('-', ' ')}</Label><H2 as="h2" id={`${id}-h`}>{title}</H2>{lede && <Body className="">{lede}</Body>}</header>
      {children}
    </section>
  );
}

const SWATCHES: Array<{ group: string; items: Array<{ name: string; token: string; hex: string; on?: string; note?: string }> }> = [
  { group: 'Surfaces', items: [
    { name: 'Abyss 0 · canvas', token: '--abyss-0', hex: '#011d1c', on: '#ffffff' }, { name: 'Abyss 1 · panel', token: '--abyss-1', hex: '#012624', on: '#ffffff' },
    { name: 'Kelp · raised', token: '--kelp', hex: '#003734', on: '#ffffff' }, { name: 'Kelp hi · hover', token: '--kelp-hi', hex: '#0a4a46', on: '#ffffff' },
    { name: 'Neutral viewer', token: '--viewer-surface (neutral)', hex: '#2e2e2e', on: '#ffffff', note: 'optional grey for judging colour' }] },
  { group: 'Text', items: [
    { name: 'Text', token: '--text', hex: '#ffffff', on: '#011d1c' }, { name: 'Text 2 · body', token: '--text-2', hex: '#bbc7c6', on: '#011d1c' },
    { name: 'Text 3 · tertiary', token: '--text-3', hex: '#8fa09e', on: '#011d1c' }, { name: 'Mist', token: '--mist', hex: '#edfffe', on: '#011d1c' }, { name: 'Phosphor · stats', token: '--phosphor', hex: '#fde9ff', on: '#011d1c' }] },
  { group: 'Accent', items: [
    { name: 'Aqua · focus/active', token: '--aqua', hex: '#cbfffc', on: '#011d1c' }, { name: 'Teal', token: '--teal', hex: '#00827c', on: '#ffffff' }, { name: 'Pink · favourite', token: '--pink', hex: '#fad1ff', on: '#011d1c' }] },
  { group: 'Semantic (added; Auros has none)', items: [
    { name: 'OK', token: '--ok', hex: '#5fd6c7', on: '#011d1c' }, { name: 'Warn', token: '--warn', hex: '#e8b84a', on: '#011d1c' }, { name: 'Danger', token: '--danger', hex: '#f2796f', on: '#011d1c' }] },
];

function ColourSection() {
  return (
    <Section id="color" title="Colour" lede="A rationed teal surface stack, silver text, and a solid Ice accent for the one primary action, and the aurora gradient reserved for thin AI/progress hairlines. Photographs are never tinted or overlaid.">
      {SWATCHES.map((g) => (
        <div key={g.group} style={{ display: 'grid', gap: 10 }}>
          <LabelSm>{g.group}</LabelSm>
          <div className="ds__swatches">
            {g.items.map((s) => {
              const bg = g.group === 'Text' || g.group === 'Accent' || g.group.startsWith('Semantic') ? '#011d1c' : s.hex;
              const ratio = g.group === 'Surfaces' ? contrastRatio('#ffffff', s.hex) : contrastRatio(s.hex, bg);
              return (
                <div key={s.token} className="ds__sw">
                  <div className="c" style={{ background: g.group === 'Surfaces' ? s.hex : '#011d1c', display: 'grid', placeItems: 'center' }}>
                    {g.group !== 'Surfaces' && <span style={{ color: s.hex, fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>Aa</span>}
                  </div>
                  <div className="i"><span style={{ color: 'var(--text)', fontSize: 13 }}>{s.name}</span><span className="t-meta t-num">{s.hex.toUpperCase()}</span>
                    <span className="t-caption">{s.token}</span><span className="t-caption t-num">{g.group === 'Surfaces' ? 'white text' : 'on canvas'} {ratio.toFixed(1)}:1 {ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'large only' : 'fail'}</span></div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="ds__cols">
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>Primary action (solid Ice accent)</LabelSm><div><Button variant="primary">Schedule post</Button></div><Caption>One per view. Dark text on Ice (11.3:1). The gradient is only for 2 px AI hairlines.</Caption></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>AI activity hairline</LabelSm><Hairline label="AI activity" /><Hairline value={0.62} label="Progress" /><Caption>2px, indeterminate or determinate. Static under reduced motion.</Caption></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>Stat (phosphor, the only luminous text)</LabelSm><Stat value="48,212" label="Photographs" /></div>
      </div>
    </Section>
  );
}

function TypeSection() {
  return (
    <Section id="type" title="Typography" lede="Inter (open) stands in for Matter. Weights 400/500 only. Display and headings are medium with tight tracking; micro-labels are uppercase and tracked; numerals are tabular.">
      <div className="ds__panel" style={{ display: 'grid', gap: 22 }}>
        {[
          ['Display · clamp 40–96 / 1.0 / −0.04em', <Display as="p">Leopards in dust</Display>],
          ['H1 · 36 / 1.05 / −0.02em', <H1 as="p">Best of Kenya</H1>],
          ['H2 · 24 / 1.2', <H2 as="p">African elephant</H2>],
          ['H3 · 16 / 1.3', <H3 as="p">Walking toward the light</H3>],
          ['Body large · 16 / 1.4', <BodyLg>A lone animal crosses open ground in warm late light.</BodyLg>],
          ['Body · 14 / 1.4 — silver, never pure white', <Body>Quiet light at the edge of the plain; the sky holds its colour for another few minutes.</Body>],
          ['Meta · 12 / tertiary', <Meta>Maasai Mara · 14 Mar 2026 · Folder-derived</Meta>],
          ['Caption · 11', <Caption>Synthetic fixture 014</Caption>],
          ['Label · 12 uppercase +0.12em', <Label>Instagram history</Label>],
          ['Label small · 10 uppercase +0.15em', <LabelSm>EXIF</LabelSm>],
          ['Numeric · tabular', <p className="t-body t-num" style={{ color: 'var(--text)' }}>ƒ/5.6 · 1/1600 s · ISO 800 · 400 mm · 1,184 / 48,212</p>],
        ].map(([k, v], i) => <div key={i} style={{ display: 'grid', gap: 6 }}><LabelSm>{k as string}</LabelSm>{v as ReactNode}</div>)}
      </div>
    </Section>
  );
}

function ControlsSection() {
  const [seg, setSeg] = useState('grid'); const [sw, setSw] = useState(true); const [size, setSize] = useState(240);
  const [sort, setSort] = useState('newest'); const [filters, setFilters] = useState<Set<string>>(new Set(['Kenya']));
  const [q, setQ] = useState(''); const [pressed, setPressed] = useState(false);
  const toast = useToast();
  return (
    <Section id="controls" title="Controls" lede="Compact (32px) on desktop, 44px on touch. 6px radii. One primary button per view.">
      <div className="ds__cols">
        <div className="ds__panel" style={{ display: 'grid', gap: 14 }}>
          <LabelSm>Buttons</LabelSm>
          <div className="jb-row"><Button variant="primary">Approve & schedule</Button><Button variant="secondary">Secondary</Button><Button variant="outline">Outline</Button><Button variant="ghost">Ghost</Button><Button variant="danger" icon="trash">Delete</Button><Button disabled>Disabled</Button></div>
          <div className="jb-row"><Button size="sm" icon="plus">Small</Button><IconButton icon="search" label="Search" /><IconButton icon="panel" label="Toggle panel" pressed={pressed} onClick={() => setPressed(!pressed)} /><IconButton icon="close" label="Close" size="sm" /></div>
        </div>
        <div className="ds__panel" style={{ display: 'grid', gap: 14 }}>
          <LabelSm>Search · filters · dropdowns</LabelSm>
          <SearchField label="Example search" value={q} onChange={setQ} placeholder="Elephants in dust at sunset" />
          <div className="jb-row">
            <FilterChip name="Place" value="Kenya" onRemove={() => {}} /><FilterChip name="Year" value="2024–2026" onRemove={() => {}} /><FilterChip name="Rating" value="★ 4+" onRemove={() => {}} />
          </div>
          <div className="jb-row">
            <Select label="Sort" value={sort} onChange={setSort} options={[{ value: 'newest', label: 'Newest' }, { value: 'rating', label: 'Rating' }, { value: 'score', label: 'AI score' }]} />
            <FilterMenu label="Place" options={['Kenya', 'Tanzania', 'Botswana', 'Norway'].map((v) => ({ value: v, label: v }))} selected={filters} onChange={setFilters} />
            <ActionMenu label="More actions" items={[{ label: 'Add to collection', onSelect: () => toast({ kind: 'info', title: 'Added to collection' }) }, { label: 'Hide photograph', onSelect: () => {} }, { label: 'Delete from library', danger: true, onSelect: () => {} }]} />
          </div>
        </div>
        <div className="ds__panel" style={{ display: 'grid', gap: 14 }}>
          <LabelSm>Segmented · switch · slider</LabelSm>
          <SegmentedControl label="View" value={seg} onChange={setSeg} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }, { value: 'map', label: 'Map' }]} />
          <Switch checked={sw} onChange={setSw} label="Show AI scores" />
          <Slider label="Size" value={size} min={120} max={420} step={10} onChange={setSize} format={(v) => `${v}px`} />
        </div>
        <div className="ds__panel" style={{ display: 'grid', gap: 14 }}>
          <LabelSm>Tabs</LabelSm>
          <Tabs label="Example" tabs={[{ value: 'a', label: 'Info', content: <Body>Panel one</Body> }, { value: 'b', label: 'AI', content: <Body>Panel two</Body> }, { value: 'c', label: 'EXIF', content: <Body>Panel three</Body> }]} />
          <LabelSm>Icons (decorative unless titled)</LabelSm>
          <div className="jb-row" style={{ gap: 14, color: 'var(--text-2)' }}>{ICON_NAMES.map((n) => <span key={n} title={n}><Icon name={n} /></span>)}</div>
        </div>
      </div>
    </Section>
  );
}

function NavSection() {
  return (
    <Section id="nav" title="Navigation" lede="Quiet by design: tracked micro-labels, one aqua underline for the current place. The live bar is at the top of this page; PUBLISH reveals its own second row. Phones get a bottom tab bar.">
      <div className="ds__panel" style={{ display: 'grid', gap: 16, padding: 0, overflow: 'hidden' }}>
        <div className="jb-topbar" style={{ position: 'static' }}>
          <div className="jb-topbar__inner" style={{ maxWidth: 'none' }}>
            <Wordmark />
            <div className="jb-nav" style={{ display: 'flex' }}>{['Library', 'Imports', 'Collections', 'AI Curator', 'Map', 'Publish'].map((l, i) => <a key={l} href="#nav" aria-current={i === 5 ? 'page' : undefined} onClick={(e) => e.preventDefault()}>{l}</a>)}</div>
            <span className="jb-topbar__spacer" /><span className="jb-dot" /></div>
          <div className="jb-subnav">{['Calendar', 'Drafts', 'Ready', 'Scheduled', 'Published', 'History'].map((l, i) => <a key={l} href="#nav" aria-current={i === 0 ? 'page' : undefined} onClick={(e) => e.preventDefault()}>{l}</a>)}</div>
        </div>
      </div>
      <PageHeader eyebrow="Page header" title="Library" lede="Tracked eyebrow, medium-weight display title, optional lede; actions align right." actions={<><Button variant="outline" icon="plus">New collection</Button><Button variant="primary">Import</Button></>} />
    </Section>
  );
}

function GridSection({ onOpen, photos, count, setCount }: { onOpen: (i: number) => void; photos: ReturnType<typeof makePhotos>; count: number; setCount: (n: number) => void }) {
  const [size, setSize] = usePersistentState('ds.thumb', 220);
  const [gap, setGap] = usePersistentState('ds.gap', 3);
  const [overlay, setOverlay] = useState<'hover' | 'always' | 'none'>(new URLSearchParams(window.location.search).get('overlay') === 'always' ? 'always' : 'hover');
  const [score, setScore] = useState(false);
  const [sel, setSel] = useState<SelectionState>(() => (new URLSearchParams(window.location.search).get('select') ? { selected: new Set(['ph-1', 'ph-2', 'ph-6', 'ph-7']), anchor: 1 } : emptySelection));
  const [local, setLocal] = useState(photos);
  if (local.length !== photos.length) setLocal(photos);
  const rate = (i: number, r: number) => setLocal((xs) => xs.map((p, k) => (k === i ? { ...p, rating: r } : p)));
  const fav = (i: number) => setLocal((xs) => xs.map((p, k) => (k === i ? { ...p, favorite: !p.favorite } : p)));
  return (
    <Section id="grid" title="Photo grid" lede="A contact sheet, not a card gallery: justified rows at each photograph's true aspect ratio, virtualised so only visible rows exist. Click selects, ⌘/Ctrl toggles, Shift ranges; arrows move, Space toggles, Enter opens, 0–5 rates, F favourites, ⌘A selects all.">
      <div className="jb-row" style={{ justifyContent: 'space-between' }}>
        <div className="jb-row" style={{ gap: 20 }}>
          <Slider label="Size" value={size} min={90} max={420} step={10} onChange={setSize} format={(v) => `${v}px`} />
          <Slider label="Gap" value={gap} min={0} max={12} onChange={setGap} format={(v) => `${v}px`} />
          <SegmentedControl label="Overlay" value={overlay} onChange={setOverlay} options={[{ value: 'hover', label: 'Hover' }, { value: 'always', label: 'Always' }, { value: 'none', label: 'None' }]} />
          <Switch checked={score} onChange={setScore} label="AI score" />
        </div>
        <div className="jb-row" style={{ gap: 12 }}>
          <SegmentedControl label="Library size" value={String(count)} onChange={(v) => setCount(Number(v))} options={[{ value: '36', label: '36' }, { value: '5000', label: '5,000' }, { value: '100000', label: '100,000' }]} />
          <span className="t-meta t-num" role="status">{sel.selected.size ? `${sel.selected.size} selected` : `${local.length.toLocaleString()} photographs`}</span>
        </div>
      </div>
      <div style={{ height: 'min(70vh, 760px)', background: 'var(--abyss-0)', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
        <PhotoGrid items={local} rowHeight={size} gap={gap} overlay={overlay} showScore={score} selection={sel} onSelectionChange={setSel} onOpen={onOpen} onRate={rate} onToggleFavorite={fav} label="Synthetic photographs" />
      </div>
      <Caption>DOM stays small at any count: rows are virtualised (see the 100,000 option). Persistent signals are limited to a 6px Instagram dot and a bar for scheduled posts; everything else appears on hover, focus or selection.</Caption>
    </Section>
  );
}

function StatusSection() {
  const [rating, setRating] = useState(3); const [fav, setFav] = useState(true);
  const matches: MatchState[] = ['EXACT_MATCH', 'HIGH_CONFIDENCE_MATCH', 'POSSIBLE_MATCH', 'NO_MATCH', 'USER_CONFIRMED', 'USER_REJECTED'];
  return (
    <Section id="status" title="Status & indicators" lede="Colour is never the only signal: every state has a word and a glyph.">
      <div className="ds__cols">
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>Publishing states</LabelSm><div className="jb-row">{PUBLISH_STATES.map((s) => <StatusChip key={s} state={s} />)}</div></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>Instagram status (library)</LabelSm>
          <div className="jb-row" style={{ gap: 16 }}><InstagramStatus state="NEVER_POSTED" showNever /><InstagramStatus state="POSTED" count={1} /><InstagramStatus state="POSTED" count={3} /><InstagramStatus state="DRAFT" /><InstagramStatus state="SCHEDULED" /><InstagramStatus state="FAILED" /></div>
          <Caption>“Never posted” is silent in dense views; it appears only when asked for.</Caption></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>Match states</LabelSm><div className="jb-row">{matches.map((m) => <MatchBadge key={m} state={m} similarity={m === 'POSSIBLE_MATCH' ? 0.92 : undefined} />)}</div></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>AI confidence</LabelSm>
          <div className="jb-row" style={{ gap: 20 }}><span><ConfidenceMeter value={0.94} label="Species" /></span><span><ConfidenceMeter value={0.72} /></span><span><ConfidenceMeter value={0.41} /></span><AiTag /></div>
          <Caption>AI-inferred values carry the AI tag and a numeric confidence. User-set values carry no tag.</Caption></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>Rating · favourite · portfolio</LabelSm>
          <div className="jb-row"><StarRating value={rating} onChange={setRating} large /><FavoriteButton pressed={fav} onChange={setFav} /><PortfolioMark /></div>
          <Caption>Keys: 0–5 sets, ←/→ moves, same star again clears.</Caption></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><LabelSm>Processing states</LabelSm>
          <div className="jb-row" style={{ gap: 24, alignItems: 'start' }}><ProcessingState kind="queued" /><ProcessingState kind="analysing" detail="2 of 14" /><ProcessingState kind="embedding" /><ProcessingState kind="failed" detail="retry 2/3" /><ProcessingState kind="done" /></div></div>
      </div>
    </Section>
  );
}

function CalendarSection() {
  return (
    <Section id="calendar" title="Publishing calendar" lede="Photographs dominate the cells; time, status and species sit in a small strip beneath each image. A month row has a fixed height: several posts on one day become a 2×2 mosaic, and more than four collapse into a “+N” tile that opens the day’s list. Drag a post to another day, or press M on a focused post for the accessible Move dialog. Arrow keys move between days, Enter creates a post. On phones and portrait tablets the grid becomes an agenda.">
      <CalendarDemo level={3} />
    </Section>
  );
}

function HistorySection() {
  return (
    <Section id="history" title="Instagram history" lede="A photographic archive of the account, not a spreadsheet: image first, with date, caption, hashtags, match and confidence revealed on hover or focus.">
      <HistoryDemo level={3} />
    </Section>
  );
}

function FeedbackSection() {
  const toast = useToast(); const [dlg, setDlg] = useState(false);
  return (
    <Section id="feedback" title="Feedback: dialogs, notifications, empty, loading, error" lede="Toasts are announced politely; errors persist until dismissed and say what happened and what is safe.">
      <div className="jb-row">
        <Button variant="outline" onClick={() => toast({ kind: 'info', title: 'Analysis queued', body: '14 photographs will be analysed.' })}>Info toast</Button>
        <Button variant="outline" onClick={() => toast({ kind: 'ok', title: 'Collection saved' })}>Success toast</Button>
        <Button variant="outline" onClick={() => toast({ kind: 'warn', title: 'Instagram token expires in 6 days', action: { label: 'Reconnect', onClick: () => {} } })}>Warning toast</Button>
        <Button variant="outline" onClick={() => toast({ kind: 'error', title: 'Backup is overdue', body: 'The last verified backup is 31 hours old.' })}>Error toast</Button>
        <Button variant="secondary" onClick={() => setDlg(true)}>Open dialog</Button>
      </div>
      <Dialog open={dlg} onOpenChange={setDlg} title="Remove from collection?" description="The photograph stays in your library. This only removes it from “Best of Kenya”."
        actions={<><Button variant="ghost" onClick={() => setDlg(false)}>Cancel</Button><Button variant="danger" onClick={() => setDlg(false)}>Remove</Button></>} />
      <div className="ds__cols">
        <EmptyState level={3} icon="library" title="No photographs match" action={<Button variant="outline">Clear filters</Button>}>Try fewer filters, or search by subject, place or year.</EmptyState>
        <EmptyState level={3} icon="inbox" title="Nothing waiting to import">New exports from Lightroom appear here automatically.</EmptyState>
        <ErrorState level={3} title="The photo drive is disconnected" onRetry={() => {}} detail="Volume marker not found">Browsing still works from the database, but thumbnails can't load until the drive is back. Nothing has been changed or deleted.</ErrorState>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 3 }} aria-label="Loading photographs" role="status">
        {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} height={[120, 160, 140][i % 3]} />)}
      </div>
    </Section>
  );
}

function ResponsiveSection() {
  const tiers = [['≥ 1920', 'Workstation (27–32″): full density, panels pinned, grid up to 12+ columns'], ['1280–1919', 'Laptop: same layout, side panels overlay below 1100'], ['768–1279', 'Tablet: 44px touch targets, panels as drawers, bottom tab bar hidden'], ['< 768', 'Phone: bottom tab bar, agenda calendar, viewer panel as bottom sheet, no bulk toolbars']];
  const w = useMediaQuery('(min-width: 1920px)') ? 'workstation' : useMediaQuery('(min-width: 1280px)') ? 'laptop' : useMediaQuery('(min-width: 768px)') ? 'tablet' : 'phone';
  const touch = useMediaQuery('(pointer: coarse)'); const rm = useMediaQuery('(prefers-reduced-motion: reduce)');
  return (
    <Section id="responsive" title="Responsive & accessibility" lede="Desktop-first; other devices get purpose-built layouts rather than a shrunken desktop.">
      <div className="ds__cols">
        <div className="ds__panel" style={{ display: 'grid', gap: 10 }}><LabelSm>Breakpoints</LabelSm>{tiers.map(([k, v]) => <div key={k} className="jb-row" style={{ flexWrap: 'nowrap', alignItems: 'baseline' }}><span className="t-num" style={{ color: 'var(--text)', width: 90, flex: 'none' }}>{k}</span><Body>{v}</Body></div>)}</div>
        <div className="ds__panel" style={{ display: 'grid', gap: 10 }}><LabelSm>This browser right now</LabelSm><dl className="jb-kv"><dt>Tier</dt><dd>{w}</dd><dt>Pointer</dt><dd>{touch ? 'coarse (touch)' : 'fine'}</dd><dt>Motion</dt><dd>{rm ? 'reduced' : 'normal'}</dd></dl></div>
        <div className="ds__panel" style={{ display: 'grid', gap: 8 }}><LabelSm>Accessibility commitments</LabelSm>
          {['WCAG AA text contrast on every surface (tested)', 'Visible 2px aqua focus ring everywhere', 'Single tab stop for the grid; full keyboard model', 'Radio-group/tab/menu semantics via Radix or ARIA', 'Calendar: keyboard day navigation + Move dialog (no drag required)', 'Reduced motion removes all animation', 'Alt text on every shown photograph', 'Status never conveyed by colour alone'].map((t) => <div key={t} className="jb-row" style={{ flexWrap: 'nowrap', gap: 8 }}><Icon name="check" size={12} style={{ color: 'var(--ok)', flex: 'none' }} /><Body>{t}</Body></div>)}</div>
      </div>
    </Section>
  );
}

export function DesignSystemPage() {
  const [count, setCount] = useState(5000);
  const photos = useMemo(() => makePhotos(count), [count]);
  // deep links for review/screenshots: ?viewer=3 &surface=neutral &tab=ai
  const q = useMemo(() => new URLSearchParams(window.location.search), []);
  const [viewerIndex, setViewerIndex] = useState<number | null>(q.get('viewer') ? Number(q.get('viewer')) : null);
  const { settings, updateSettings } = useAuth();
  const [override, setOverride] = useState<ViewerSurface | null>(q.get('surface') === 'neutral' || q.get('surface') === 'teal' ? (q.get('surface') as ViewerSurface) : null);
  const surface: ViewerSurface = override ?? settings?.viewerSurface ?? 'neutral';          // neutral grey unless the user chose teal
  const setSurface = (s: ViewerSurface) => { setOverride(s); void updateSettings({ viewerSurface: s }).catch(() => {}); };
  const [panel, setPanel] = usePersistentState('ds.panel', true);
  const demo = photos.length > 300 ? photos.slice(0, 300) : photos;
  return (
    <div className="jb-page">
      <PageHeader eyebrow="Design system · phase 3" title="AI PhotoVault" lede="An Auros-derived visual language for a private photography environment: dark, sparse, image-first. Everything on this page uses synthetic data and synthetic images." />
      <div className="ds">
        <nav className="ds__toc" aria-label="Sections">{SECTIONS.map(([id, t]) => <a key={id} href={`#${id}`}>{t}</a>)}</nav>
        <div>
          <ColourSection /><TypeSection /><ControlsSection /><NavSection />
          <GridSection photos={photos} count={count} setCount={setCount} onOpen={(i) => setViewerIndex(i)} />
          <Section id="viewer" title="Photo viewer" lede="Immersive: the photograph fills the stage uncropped and unfiltered, with a contextual panel (Info · AI · EXIF · Collections · Publish). ← → navigate, I toggles the panel, N switches to a neutral-grey background for judging colour. On narrow screens the panel is a bottom sheet.">
            <div className="jb-row"><Button variant="secondary" icon="eye" onClick={() => setViewerIndex(0)}>Open viewer</Button>
              <SegmentedControl label="Viewer background" value={surface} onChange={setSurface} options={[{ value: 'teal', label: 'Teal' }, { value: 'neutral', label: 'Neutral grey' }]} /></div>
            <div className={cx('ds__panel')} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {(['teal', 'neutral'] as const).map((s) => <div key={s} style={{ background: s === 'teal' ? 'var(--abyss-0)' : '#2e2e2e', borderRadius: 6, padding: 16, display: 'grid', placeItems: 'center' }}>
                <img src="/fixtures/p05.jpg" alt={`Synthetic photograph on the ${s} viewer background`} style={{ maxWidth: '100%', maxHeight: 220, objectFit: 'contain' }} /></div>)}
            </div>
          </Section>
          <StatusSection /><CalendarSection /><HistorySection /><FeedbackSection /><ResponsiveSection />
        </div>
      </div>
      {viewerIndex !== null && (
        <PhotoViewer items={demo} index={Math.min(viewerIndex, demo.length - 1)} onIndexChange={setViewerIndex} onClose={() => setViewerIndex(null)} detail={detailFor}
          surface={surface} onSurfaceChange={setSurface} panelOpen={panel} onPanelOpenChange={setPanel} />
      )}
    </div>
  );
}
void H3;
