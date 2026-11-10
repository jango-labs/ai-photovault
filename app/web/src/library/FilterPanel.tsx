import { useQuery } from '@tanstack/react-query';
import { GPS_FILTERS, GPS_LABEL, fetchFacets, type AiFilter, type IgFilter, type LibraryFilters, type Orientation } from '../api/library';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/controls';
import { SidePanel } from '../ui/SidePanel';
import { Skeleton } from '../ui/feedback';
import { Label, Meta } from '../ui/typography';
import { fmtCount } from './photoMap';

const toggle = <T,>(xs: readonly T[], v: T): T[] => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]);

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="jb-filter-group" aria-label={title}><Label>{title}</Label>{children}</section>;
}
function Opt({ on, onClick, children, n }: { on: boolean; onClick: () => void; children: React.ReactNode; n?: number }) {
  return <button type="button" className="jb-opt" aria-pressed={on} onClick={onClick}>{children}{n !== undefined && <span className="n">{fmtCount(n)}</span>}</button>;
}
type Tri = 'any' | 'yes' | 'no';
const tri = (v: boolean | undefined): Tri => (v === undefined ? 'any' : v ? 'yes' : 'no');
const untri = (t: Tri): boolean | undefined => (t === 'any' ? undefined : t === 'yes');

const IG: Array<[IgFilter, string]> = [['posted', 'Published'], ['never', 'Never published'], ['possible', 'Possible duplicate'], ['draft', 'Draft'], ['scheduled', 'Scheduled']];
const AI: Array<[AiFilter, string]> = [['analyzed', 'Analysed'], ['queued', 'Queued'], ['failed', 'Failed'], ['none', 'Not analysed']];
const ORI: Array<[Orientation, string]> = [['landscape', 'Landscape'], ['portrait', 'Portrait'], ['square', 'Square']];

/** All combinable filters. Choices come from the database (facets), so only values that exist are offered. Every toggle applies immediately. */
export function FilterPanel({ open, onOpenChange, filters, onChange, onClear }: {
  open: boolean; onOpenChange: (o: boolean) => void; filters: LibraryFilters; onChange: (f: LibraryFilters) => void; onClear: () => void;
}) {
  const facets = useQuery({ queryKey: ['library', 'facets'], queryFn: fetchFacets, enabled: open, staleTime: 60_000 });
  const f = filters; const set = (patch: Partial<LibraryFilters>) => onChange({ ...f, ...patch });
  const fx = facets.data;
  return (
    <SidePanel open={open} onOpenChange={onOpenChange} title="Filters">
      <p className="t-meta" style={{ marginBottom: 6 }}>Filters combine: a photograph must match every group, and any option within a group.</p>
      <Group title="Rating">
        <div className="jb-filter-opts">
          {[5, 4, 3, 2, 1, 0].map((r) => <Opt key={r} on={f.rating.includes(r)} onClick={() => set({ rating: toggle(f.rating, r) })}>{r === 0 ? 'Unrated' : `${r} ${r === 1 ? 'star' : 'stars'}`}</Opt>)}
        </div>
      </Group>
      <Group title="Favourites">
        <SegmentedControl label="Favourites" value={tri(f.favorite)} onChange={(v) => set({ favorite: untri(v) })} options={[{ value: 'any', label: 'Any' }, { value: 'yes', label: 'Favourites' }, { value: 'no', label: 'Not' }]} />
      </Group>
      <Group title="Portfolio">
        <SegmentedControl label="Portfolio" value={tri(f.portfolio)} onChange={(v) => set({ portfolio: untri(v) })} options={[{ value: 'any', label: 'Any' }, { value: 'yes', label: 'In portfolio' }, { value: 'no', label: 'Not' }]} />
      </Group>
      <Group title="Orientation">
        <div className="jb-filter-opts">{ORI.map(([v, l]) => <Opt key={v} on={f.orientation.includes(v)} onClick={() => set({ orientation: toggle(f.orientation, v) })}>{l}</Opt>)}</div>
      </Group>
      <Group title="Other">
        <div className="jb-filter-opts">
          <Opt on={f.dup.includes('open')} onClick={() => set({ dup: f.dup.includes('open') ? [] : ['open'] })} n={fx?.openDuplicatePairs}>Possible near-duplicates</Opt>
          <Opt on={!!f.hidden} onClick={() => set({ hidden: f.hidden ? undefined : true })}>Hidden photographs only</Opt>
        </div>
      </Group>
      <Group title="Instagram">
        <div className="jb-filter-opts">{IG.map(([v, l]) => <Opt key={v} on={f.ig.includes(v)} onClick={() => set({ ig: toggle(f.ig, v) })} n={v === 'possible' ? fx?.possibleDuplicates : undefined}>{l}</Opt>)}</div>
      </Group>
      <Group title="Coordinates">
        <div className="jb-filter-opts">{GPS_FILTERS.map((g) => <Opt key={g} on={f.gps.includes(g)} onClick={() => set({ gps: toggle(f.gps, g) })}>{GPS_LABEL[g]}</Opt>)}</div>
      </Group>
      <Group title="AI processing">
        <div className="jb-filter-opts">{AI.map(([v, l]) => <Opt key={v} on={f.ai.includes(v)} onClick={() => set({ ai: toggle(f.ai, v) })}>{l}</Opt>)}</div>
      </Group>
      {facets.isLoading && <div aria-busy="true"><Skeleton height={14} width="60%" /><Skeleton height={28} style={{ marginTop: 8 }} /></div>}
      {facets.isError && <Meta>The year, place and equipment lists could not be loaded.</Meta>}
      {fx && <>
        <Group title="Year taken"><div className="jb-filter-opts">{fx.years.map((y) => <Opt key={y.value} on={f.year.includes(y.value)} onClick={() => set({ year: toggle(f.year, y.value) })} n={y.n}>{y.value}</Opt>)}{fx.years.length === 0 && <Meta>No photographs with a capture date.</Meta>}</div></Group>
        <Group title="Month taken"><div className="jb-filter-opts">{fx.months.map((m) => <Opt key={m.value} on={f.month.includes(m.value)} onClick={() => set({ month: toggle(f.month, m.value) })} n={m.n}>{MONTHS[m.value - 1]}</Opt>)}{fx.months.length === 0 && <Meta>No photographs with a capture date.</Meta>}</div></Group>
        <Group title="Folders"><FolderTree folders={fx.folders} selected={f.folder} onToggle={(d) => set({ folder: toggle(f.folder, d) })} /></Group>
        <Group title="Folder year"><div className="jb-filter-opts">{fx.folderYears.map((y) => <Opt key={y.value} on={f.folderYear.includes(y.value)} onClick={() => set({ folderYear: toggle(f.folderYear, y.value) })} n={y.n}>{y.value}</Opt>)}{fx.folderYears.length === 0 && <Meta>No year folders.</Meta>}</div></Group>
        {fx.countries.length > 0 && <Group title="Country"><div className="jb-filter-opts">{fx.countries.map((c) => <Opt key={c.value} on={f.country.includes(c.value)} onClick={() => set({ country: toggle(f.country, c.value) })} n={c.n}>{c.value}</Opt>)}</div></Group>}
        {fx.cities.length > 0 && <Group title="City"><div className="jb-filter-opts">{fx.cities.map((c) => <Opt key={c.value} on={f.city.includes(c.value)} onClick={() => set({ city: toggle(f.city, c.value) })} n={c.n}>{c.value}</Opt>)}</div></Group>}
        <Group title="Folder location"><div className="jb-filter-opts">{fx.locations.map((l) => <Opt key={l.value} on={f.location.includes(l.value)} onClick={() => set({ location: toggle(f.location, l.value) })} n={l.n}>{l.value}</Opt>)}{fx.locations.length === 0 && <Meta>No locations recorded.</Meta>}</div></Group>
        <Group title="Camera"><div className="jb-filter-opts">{fx.cameras.map((c) => <Opt key={c.value} on={f.camera.includes(c.value)} onClick={() => set({ camera: toggle(f.camera, c.value) })} n={c.n}>{c.value}</Opt>)}{fx.cameras.length === 0 && <Meta>No camera data.</Meta>}</div></Group>
        <Group title="Lens"><div className="jb-filter-opts">{fx.lenses.map((l) => <Opt key={l.value} on={f.lens.includes(l.value)} onClick={() => set({ lens: toggle(f.lens, l.value) })} n={l.n}>{l.value}</Opt>)}{fx.lenses.length === 0 && <Meta>No lens data.</Meta>}</div></Group>
      </>}
      <div className="jb-row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
        <Button variant="ghost" onClick={onClear}>Clear all filters</Button>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
      </div>
    </SidePanel>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The original folder structure (year / place / sub-folder) with counts; choosing a folder shows everything inside it. */
function FolderTree({ folders, selected, onToggle }: { folders: Array<{ value: string; n: number }>; selected: string[]; onToggle: (dir: string) => void }) {
  if (folders.length === 0) return <Meta>No folders recorded.</Meta>;
  const total = (dir: string) => folders.filter((x) => x.value === dir || x.value.startsWith(`${dir}/`)).reduce((a, x) => a + x.n, 0);
  const dirs = new Set<string>(); for (const { value } of folders) { const parts = value.split('/'); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  const top = [...dirs].filter((d) => !d.includes('/')).sort().reverse();
  const children = (dir: string) => [...dirs].filter((d) => d.startsWith(`${dir}/`) && d.split('/').length === dir.split('/').length + 1).sort();
  const node = (dir: string, depth: number): React.ReactElement => {
    const kids = children(dir); const label = dir.split('/').pop()!;
    const row = <span style={{ marginLeft: depth * 12, display: 'inline-block' }}><Opt on={selected.includes(dir)} onClick={() => onToggle(dir)} n={total(dir)}>{label}</Opt></span>;
    return kids.length === 0 ? <div key={dir}>{row}</div> : <details key={dir} open={depth === 0 && selected.some((s) => s === dir || s.startsWith(`${dir}/`))}><summary style={{ cursor: 'pointer' }}>{row}</summary>{kids.map((k) => node(k, depth + 1))}</details>;
  };
  return <div className="jb-filter-opts" style={{ display: 'grid', gap: 2 }} aria-label="Folder tree">{top.map((d) => node(d, 0))}</div>;
}
