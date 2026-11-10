import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  type GeoCandidate, type GeocodeInfo, type MetaPatch, decideDuplicate, fetchDetail, fetchHistory, fetchPhotoDuplicates, fetchVersions, geocodeSearch, imageUrl, patchMetadata, restoreVersion, undoEdit,
  type EditRow, type PhotoDetail,
} from '../api/library';
import { formatView } from '../map/geo';
import { PinPicker } from './PinPicker';
import { Button } from '../ui/Button';
import { Field, TextArea } from '../ui/controls';
import { useToast } from '../ui/feedback';
import { Label, Meta } from '../ui/typography';
import { DETAIL_KEY } from './cache';
import { fmtBytes, fmtCapture, fmtDate } from './photoMap';

const SOURCE: Record<string, string> = { FOLDER_DERIVED: 'Folder', EXIF: 'EXIF', IPTC: 'IPTC', USER_DEFINED: 'You', GEOCODED: 'Approximate · OpenStreetMap', AI_INFERRED: 'AI · unverified' };
export const Prov = ({ source }: { source: string | null | undefined }) => (source ? <span className="jb-prov" data-src={source} title="Where this value came from">{SOURCE[source] ?? source}</span> : null);

const FIELD_LABEL: Record<EditRow['field'], string> = { title: 'Title', description: 'Description', notes: 'Notes', capture_at: 'Capture date', trip_location: 'Location', gps: 'GPS', current_version: 'Current version', hidden: 'Hidden' };
const show = (v: unknown, field: EditRow['field']): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'capture_at') return fmtDate(String(v));
  if (field === 'gps') { const g = v as { lat: number; lon: number }; return `${g.lat.toFixed(4)}, ${g.lon.toFixed(4)}`; }
  if (field === 'current_version') { const x = v as { versionNo?: number }; return x.versionNo ? `version ${x.versionNo}` : 'previous version'; }
  return String(v);
};
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
/** `<input type=datetime-local>` takes/gives local-looking text; photographs are dated as stored (UTC), so the field is read and written as UTC. */
/** the form shows the camera's own wall clock; a saved time keeps the photograph's UTC offset (or UTC when it has none) */
const toInput = (local: string | null) => (local ? local.slice(0, 16) : '');
const fromInput = (v: string, offset: string | null) => (v ? `${v}:00${offset ?? 'Z'}` : null);

/** what happened to the map position when a location was saved, in plain words */
function reportGeocode(toast: ReturnType<typeof useToast>, g: GeocodeInfo | undefined) {
  if (!g) return;
  if (g.status === 'placed') toast({ kind: 'ok', title: `Placed on the map: ${g.label ?? g.query}`, body: 'This is the centre of the place, not the exact spot. Edit details → Place pin to be exact.' });
  else if (g.status === 'cleared') toast({ kind: 'info', title: 'Removed from the map', body: 'The approximate position went with the location text.' });
  else if (g.status === 'kept_exact') toast({ kind: 'info', title: 'Exact position kept', body: g.message });
  else toast({ kind: 'warn', title: g.status === 'not_found' ? 'Location not found on the map' : g.status === 'disabled' ? 'Map lookup is off' : 'Could not look the location up', body: g.message });
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="jb-section"><div className="jb-mgmt__row"><Label>{title}</Label>{action}</div>{children}</section>;
}

/** Editing, versions, near-duplicates and edit history for one photograph (the viewer's Information tab). */
export function PhotoManagement({ photoId }: { photoId: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const detail = useQuery({ queryKey: DETAIL_KEY(photoId), queryFn: () => fetchDetail(photoId), staleTime: 30_000 });
  const history = useQuery({ queryKey: ['library', 'history', photoId], queryFn: () => fetchHistory(photoId) });
  const versions = useQuery({ queryKey: ['library', 'versions', photoId], queryFn: () => fetchVersions(photoId) });
  const dups = useQuery({ queryKey: ['library', 'dups', photoId], queryFn: () => fetchPhotoDuplicates(photoId) });
  // a saved edit must show everywhere at once: photo details, library lists and facets, the map (markers and counts), collections and search
  const refresh = () => { for (const k of ['library', 'map', 'collections', 'search']) void qc.invalidateQueries({ queryKey: [k] }); };
  const fail = (e: unknown, what: string) => toast({ kind: 'error', title: `${what} failed`, body: e instanceof ApiError ? e.message : 'Check the connection and try again.' });

  const [editing, setEditing] = useState(false);
  const d = detail.data;
  // “Put on the map” for a photograph whose location text has no position yet
  const locate = useMutation({ mutationFn: () => patchMetadata(photoId, { locate: true }), onSuccess: (r) => { refresh(); reportGeocode(toast, r.geocode); }, onError: (e) => fail(e, 'Looking the location up') });
  return (
    <div className="jb-mgmt">
      <Section title="Details" action={d && !editing ? <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit details</Button> : undefined}>
        {d && editing
          ? <EditForm d={d} onCancel={() => setEditing(false)} onSaved={(r) => { setEditing(false); refresh(); reportGeocode(toast, r?.geocode); }} onError={(e) => fail(e, 'Saving')} />
          : d ? <Facts d={d} locating={locate.isPending} onLocate={() => locate.mutate()} /> : <Meta>Loading…</Meta>}
      </Section>

      <Section title="Versions">
        {versions.data && versions.data.length > 0 ? (
          <div className="jb-mgmt__list">
            {versions.data.map((v) => (
              <div key={v.id} className="jb-mgmt__item jb-mgmt__item--text">
                <div>
                  <span style={{ color: 'var(--text)' }}>Version {v.versionNo}</span> <span className="label-sm">{v.current ? 'Current' : v.state.toLowerCase()}</span>
                  <Meta className="t-num">{v.width && v.height ? `${v.width} × ${v.height}` : '—'} · {fmtBytes(v.bytes)} · imported {fmtDate(v.importedAt)} · {v.sha256Prefix}</Meta>
                  {!v.sourcePresent && <Meta>The source file is no longer on disk (the record is kept).</Meta>}
                </div>
                {!v.current && <RestoreButton photoId={photoId} versionId={v.id} versionNo={v.versionNo} onDone={refresh} onError={(e) => fail(e, 'Restoring')} />}
              </div>
            ))}
            {versions.data.length === 1 && <Meta>Only one version. A re-export of the same file name arrives as a new version automatically (Phase 7).</Meta>}
          </div>
        ) : <Meta>No version information.</Meta>}
      </Section>

      <Section title="Similar photographs">
        {dups.data && dups.data.length > 0 ? (
          <div className="jb-mgmt__list">
            {dups.data.map((p) => (
              <div key={p.id} className="jb-mgmt__item">
                <img src={imageUrl(p.other.id, 'thumb')} alt="" loading="lazy" />
                <div><span style={{ color: 'var(--text)' }}>{p.other.title}</span><Meta>{p.distance === 0 ? 'identical' : `${p.distance} bit${p.distance === 1 ? '' : 's'} apart`} · {p.state === 'DUPLICATE' ? 'marked duplicate' : 'to review'}</Meta></div>
                <div className="jb-row">
                  <Link className="jb-btn jb-btn--sm jb-btn--outline" to={`/library/compare?ids=${photoId},${p.other.id}`}>Compare</Link>
                  {p.state === 'OPEN' && <Button size="sm" variant="ghost" onClick={() => void decideDuplicate(p.id, 'DISTINCT').then(refresh).catch((e) => fail(e, 'Saving'))}>Not a duplicate</Button>}
                </div>
              </div>
            ))}
          </div>
        ) : <Meta>No near-duplicates found. <Link to="/library/duplicates">Scan the library</Link> to look again.</Meta>}
      </Section>

      <Section title="Edit history">
        {history.data && history.data.length > 0 ? (
          <div className="jb-mgmt__list">
            {history.data.slice(0, 30).map((e) => <HistoryItem key={e.id} photoId={photoId} e={e} onChange={refresh} onError={(x) => fail(x, 'Undo')} />)}
          </div>
        ) : <Meta>No edits yet. Everything shown comes from the file, its folder or an earlier import.</Meta>}
      </Section>
    </div>
  );
}

function Facts({ d, onLocate, locating }: { d: PhotoDetail; onLocate?: () => void; locating?: boolean }) {
  return (
    <dl className="jb-kv">
      <dt>Title</dt><dd>{d.titleSource ? d.title : <span style={{ color: 'var(--text-3)' }}>{d.title} (file name)</span>}<Prov source={d.titleSource} /></dd>
      <dt>Description</dt><dd>{d.description ?? '—'}<Prov source={d.descriptionSource} /></dd>
      <dt>Location</dt><dd>{d.location ?? '—'}<Prov source={d.locationSource} /></dd>
      <dt>Captured</dt><dd>{d.captureLocal ? `${fmtCapture(d.captureAt!, d.captureOffset)} · ${d.captureLocal.slice(11, 16)}${d.captureOffset ? ` (UTC${d.captureOffset})` : ' (zone not recorded)'}` : '—'}<Prov source={d.captureAtSource} /></dd>
      <dt>Folder year</dt><dd>{d.folderYear ?? '—'}</dd>
      {(d.place.city || d.place.state || d.place.country) && <><dt>Place names</dt><dd>{[d.place.sublocation, d.place.city, d.place.state, d.place.country].filter(Boolean).join(', ')}<Prov source={d.place.source} /></dd></>}
      {d.colorLabel && <><dt>Colour label</dt><dd>{d.colorLabel}</dd></>}
      <dt>Position</dt><dd>{d.exif.gps ? <>{`${d.exif.gps.lat.toFixed(4)}, ${d.exif.gps.lon.toFixed(4)}`}<Prov source={d.exif.gps.source} />{' '}<Link to={`/map?photo=${d.id}&c=${formatView({ lat: d.exif.gps.lat, lon: d.exif.gps.lon, zoom: d.exif.gps.approximate ? 8 : 12 })}`}>Show on map</Link></> : <>—<Meta>No position yet. Enter a location and press “Find on map”, or place a pin.</Meta>{d.location && onLocate && <Button size="sm" variant="outline" icon="map" disabled={locating} onClick={onLocate}>{locating ? 'Looking up…' : `Put “${d.location}” on the map`}</Button>}</>}</dd>
      {d.exif.gps?.approximate && <><dt /><dd><Meta>Approximate: the centre of {d.exif.gps.label ?? 'the place'}, not where the photograph was taken. Place a pin to be exact. Place names from © OpenStreetMap contributors.</Meta></dd></>}
      {d.exif.cameraGps && !d.exif.cameraGps.inUse && <><dt>Camera recorded</dt><dd>{`${d.exif.cameraGps.lat.toFixed(4)}, ${d.exif.cameraGps.lon.toFixed(4)}`}<Prov source={d.exif.cameraGps.source} /><Meta>Kept safely; the position above is used instead.</Meta></dd></>}
    </dl>
  );
}

function EditForm({ d, onCancel, onSaved, onError }: { d: PhotoDetail; onCancel: () => void; onSaved: (r?: { geocode?: GeocodeInfo }) => void; onError: (e: unknown) => void }) {
  const initial = { title: d.titleSource ? d.title : '', description: d.description ?? '', location: d.location ?? '', captureAt: toInput(d.captureLocal), lat: d.exif.gps ? String(d.exif.gps.lat) : '', lon: d.exif.gps ? String(d.exif.gps.lon) : '', notes: d.notes ?? '' };
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  // a position chosen from a place-name lookup stays "approximate" until the person types or places something else
  const [approx, setApprox] = useState<{ label: string } | null>(d.exif.gps?.approximate ? { label: d.exif.gps.label ?? '' } : null);
  const [cands, setCands] = useState<{ list: GeoCandidate[]; note: string | null } | null>(null);
  const [finding, setFinding] = useState(false); const [pinOpen, setPinOpen] = useState(false);
  useEffect(() => setErr(null), [f]);
  const save = useMutation({ mutationFn: (p: MetaPatch) => patchMetadata(d.id, p), onSuccess: (r) => onSaved(r), onError });
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const find = async () => {
    const q = f.location.trim(); if (q.length < 2) { setErr('Type a place first, for example “Washington, DC”.'); return; }
    setFinding(true); setCands(null);
    try {
      const r = await geocodeSearch(q);
      if (r.status === 'ok') setCands({ list: r.candidates, note: null });
      else setCands({ list: [], note: r.status === 'not_found' ? `“${q}” was not found. The text is kept; try a more specific name, or place a pin.` : r.status === 'disabled' ? 'Looking places up is switched off. Place a pin instead.' : `${r.reason}. You can still place a pin.` });
    } catch (e) { onError(e); } finally { setFinding(false); }
  };
  const choose = (c: GeoCandidate) => { setF((x) => ({ ...x, lat: c.lat.toFixed(5), lon: c.lon.toFixed(5) })); setApprox({ label: c.label }); setCands(null); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // only what the photographer actually changed is sent: saving never rewrites (or "claims") a value they did not touch,
    // e.g. the seconds of a capture time that the date field cannot show
    const patch: MetaPatch = {};
    if (f.title !== initial.title) patch.title = f.title.trim() || null;
    if (f.description !== initial.description) patch.description = f.description.trim() || null;
    if (f.location !== initial.location) patch.location = f.location.trim() || null;
    if (f.notes !== initial.notes) patch.notes = f.notes.trim() || null;
    if (f.captureAt !== initial.captureAt) patch.captureAt = fromInput(f.captureAt, d.captureOffset);
    if (f.lat !== initial.lat || f.lon !== initial.lon) {
      const empty = f.lat.trim() === '' && f.lon.trim() === '';
      const lat = num(f.lat), lon = num(f.lon);
      if (!empty && (f.lat.trim() === '' || f.lon.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)) { setErr('Latitude must be −90…90 and longitude −180…180 (both are needed).'); return; }
      patch.gps = empty ? null : { lat, lon, ...(approx ? { approximate: true, label: approx.label } : {}) };
    }
    // typing a location and saving looks it up automatically (only when no position was chosen or typed here)
    // nothing changed, but the text has no position yet: pressing Save puts it on the map (the text may have been typed before lookups existed)
    if (Object.keys(patch).length === 0 && d.location && d.locationSource === 'USER_DEFINED' && !d.exif.gps) patch.locate = true;
    if (Object.keys(patch).length === 0) { onCancel(); return; }
    save.mutate(patch);
  };
  const set = (k: keyof typeof f) => (v: string) => { if (k === 'lat' || k === 'lon') setApprox(null); setF((x) => ({ ...x, [k]: v })); };
  const pin = Number.isFinite(num(f.lat)) && Number.isFinite(num(f.lon)) ? { lat: num(f.lat), lon: num(f.lon) } : null;
  const cam = d.exif.cameraGps;
  return (
    <form className="jb-stack" onSubmit={submit} noValidate>
      <Field label="Title" value={f.title} onChange={set('title')} maxLength={200} hint={d.titleSource ? undefined : 'Empty = the file name is shown'} />
      <TextArea label="Description" value={f.description} onChange={set('description')} maxLength={4000} />
      <Field label="Location" value={f.location} onChange={set('location')} maxLength={120} hint={`${d.locationSource && d.locationSource !== 'USER_DEFINED' ? `Currently from the ${(SOURCE[d.locationSource] ?? '').toLowerCase()}; saving makes it yours. ` : ''}A place name, for example “Washington, DC”. Saving looks it up on the map (only this text is sent to OpenStreetMap).`} />
      <div className="jb-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant="outline" icon="map" disabled={finding || f.location.trim().length < 2} onClick={() => void find()}>{finding ? 'Looking…' : 'Find on map'}</Button>
        <Button size="sm" variant="outline" onClick={() => setPinOpen(true)}>Place pin…</Button>
        {cam && !cam.inUse && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ gpsRestore: true })}>Use the camera’s position</Button>}
      </div>
      {cands && (
        <div role="group" aria-label="Places found" className="jb-mgmt__list">
          {cands.list.map((c) => <button key={`${c.lat},${c.lon}`} type="button" className="jb-mgmt__item jb-mgmt__item--text" style={{ textAlign: 'left' }} onClick={() => choose(c)}><div><span style={{ color: 'var(--text)' }}>{c.label}</span><Meta>{c.lat.toFixed(4)}, {c.lon.toFixed(4)} · centre of the place · © OpenStreetMap contributors</Meta></div></button>)}
          {cands.note && <p className="t-meta" role="status">{cands.note}</p>}
        </div>
      )}
      <Field label="Capture date and time (as shown on the photograph)" type="datetime-local" value={f.captureAt} onChange={set('captureAt')} hint="Stored as written; no time-zone conversion" />
      <div className="jb-row" style={{ gap: 8 }}>
        <Field label="Latitude" value={f.lat} onChange={set('lat')} inputMode="decimal" />
        <Field label="Longitude" value={f.lon} onChange={set('lon')} inputMode="decimal" />
      </div>
      {approx && <p className="t-meta" role="note">Approximate: the centre of {approx.label || 'the place'} — shown on the map as an approximate position, not as where the photograph was taken.</p>}
      {cam && <p className="t-meta">The camera recorded {cam.lat.toFixed(4)}, {cam.lon.toFixed(4)}; it is kept whatever you do here.</p>}
      <TextArea label="Notes (private)" value={f.notes} onChange={set('notes')} maxLength={4000} />
      {err && <p className="t-meta" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
      <p className="t-meta">Edits change this catalogue only — never the photograph file — and every change can be undone from the history.</p>
      <div className="jb-row"><Button variant="primary" type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
      <PinPicker open={pinOpen} onOpenChange={setPinOpen} initial={pin} bbox={approx ? undefined : undefined} onPick={(p) => { setApprox(null); setF((x) => ({ ...x, lat: p.lat.toFixed(5), lon: p.lon.toFixed(5) })); }} />
    </form>
  );
}

function RestoreButton({ photoId, versionId, versionNo, onDone, onError }: { photoId: string; versionId: string; versionNo: number; onDone: () => void; onError: (e: unknown) => void }) {
  const m = useMutation({ mutationFn: () => restoreVersion(photoId, versionId), onSuccess: onDone, onError });
  return <Button size="sm" variant="outline" disabled={m.isPending} onClick={() => m.mutate()} aria-label={`Make version ${versionNo} current`}>Make current</Button>;
}

function HistoryItem({ photoId, e, onChange, onError }: { photoId: string; e: EditRow; onChange: () => void; onError: (e: unknown) => void }) {
  const m = useMutation({ mutationFn: () => undoEdit(photoId, e.id), onSuccess: onChange, onError });
  const undoable = e.kind !== 'UNDO' && !e.undone && e.field !== 'current_version';
  return (
    <div className="jb-mgmt__item jb-mgmt__item--text">
      <div>
        <span style={{ color: 'var(--text)' }}>{FIELD_LABEL[e.field]}</span> <span className="label-sm">{e.kind === 'UNDO' ? 'undo' : e.kind === 'BULK' ? 'bulk edit' : e.undone ? 'undone' : ''}</span>
        <Meta><span className="jb-edit-old">{show(e.oldValue, e.field)}</span> → <span>{show(e.newValue, e.field)}</span><Prov source={e.newSource} /></Meta>
        <Meta className="t-num">{when(e.editedAt)}</Meta>
      </div>
      {undoable && <Button size="sm" variant="ghost" disabled={m.isPending} onClick={() => m.mutate()} aria-label={`Undo the ${FIELD_LABEL[e.field].toLowerCase()} change`}>Undo</Button>}
    </div>
  );
}
