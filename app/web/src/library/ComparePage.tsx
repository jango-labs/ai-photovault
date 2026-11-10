import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchCompare, imageUrl, type PhotoDetail } from '../api/library';
import { PageHeader } from '../shell/PageHeader';
import { LinkButton } from '../ui/Button';
import { ErrorState, Skeleton } from '../ui/feedback';
import { fmtBytes, fmtCapture, fmtDate } from './photoMap';

type Row = [string, (d: PhotoDetail) => string];
const exp = (d: PhotoDetail) => [d.exif.focalLengthMm ? `${Math.round(d.exif.focalLengthMm)} mm` : null, d.exif.aperture ? `f/${d.exif.aperture}` : null, d.exif.shutterSeconds ? (d.exif.shutterSeconds >= 1 ? `${d.exif.shutterSeconds} s` : `1/${Math.round(1 / d.exif.shutterSeconds)} s`) : null, d.exif.iso ? `ISO ${d.exif.iso}` : null].filter(Boolean).join(' · ') || '—';
const ROWS: Row[] = [
  ['Filename', (d) => d.filename], ['Dimensions', (d) => `${d.width} × ${d.height} px (${((d.width * d.height) / 1e6).toFixed(1)} MP)`], ['File size', (d) => fmtBytes(d.bytes)],
  ['Orientation', (d) => d.orientation], ['Captured', (d) => (d.captureAt ? fmtCapture(d.captureAt, d.captureOffset) : '—')], ['Imported', (d) => fmtDate(d.importedAt)],
  ['Location', (d) => d.location ?? '—'], ['Camera', (d) => d.exif.camera ?? '—'], ['Lens', (d) => d.exif.lens ?? '—'], ['Exposure', exp],
  ['Rating', (d) => (d.rating ? `${d.rating} of 5` : 'Unrated')], ['Favourite', (d) => (d.favorite ? 'Yes' : 'No')], ['Portfolio', (d) => (d.portfolio ? 'Yes' : 'No')],
  ['Instagram', (d) => (d.ig.state === 'POSTED' ? `Published ×${d.ig.count}` : d.ig.state === 'NEVER_POSTED' ? 'Never published' : d.ig.state.toLowerCase())],
  ['Version', (d) => `${d.versionNo} of ${d.versionCount}`],
];

/** Side-by-side comparison of 2–4 photographs: images at their own aspect ratio, facts in rows, differences highlighted. */
export function ComparePage() {
  const [sp] = useSearchParams();
  const ids = (sp.get('ids') ?? '').split(',').filter(Boolean).slice(0, 4);
  const q = useQuery({ queryKey: ['library', 'compare', ids.join(',')], queryFn: () => fetchCompare(ids), enabled: ids.length >= 2 });
  const photos = q.data?.photos ?? [];
  return (
    <div className="jb-page jb-cmp">
      <PageHeader eyebrow="Library" title="Compare" lede="Look at similar photographs side by side. Differences are highlighted; nothing here changes a photograph."
        actions={<LinkButton variant="outline" to="/library" icon="library">Back to the library</LinkButton>} />
      {ids.length < 2 ? <ErrorState title="Choose two to four photographs">Select them in the library and use Compare.</ErrorState>
        : q.isError ? <ErrorState title="These photographs could not be loaded" onRetry={() => void q.refetch()}>They may not exist or not be yours.</ErrorState>
        : q.isLoading ? <div aria-busy="true"><Skeleton height={320} /></div>
        : (
          <>
            <div className="jb-cmp__cols" style={{ ['--cols' as string]: photos.length }}>
              {photos.map((p) => (
                <figure key={p.id} style={{ margin: 0, display: 'grid', gap: 8 }}>
                  <div className="jb-cmp__img"><img src={imageUrl(p.id, 'view')} alt={`${p.title}${p.location ? `, ${p.location}` : ''}`} /></div>
                  <figcaption className="t-meta"><Link to={`/library?photo=${p.id}`}>{p.title}</Link></figcaption>
                </figure>
              ))}
            </div>
            <table aria-label="Differences">
              <tbody>
                {ROWS.map(([label, get]) => {
                  const vals = photos.map(get); const diff = new Set(vals).size > 1;
                  return <tr key={label}><th scope="row">{label}</th>{vals.map((v, i) => <td key={i} data-diff={diff || undefined}>{v}</td>)}</tr>;
                })}
              </tbody>
            </table>
          </>
        )}
    </div>
  );
}
