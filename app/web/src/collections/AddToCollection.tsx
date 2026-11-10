import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { COLLECTIONS_KEY, addToCollection, createCollection, fetchCollections, type Target } from '../api/collections';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/controls';
import { useToast } from '../ui/feedback';
import { Meta } from '../ui/typography';

/** Choose a manual collection (or make one) and add the given photographs to it. Used from the Library, Search, collections and the viewer. */
export function AddToCollection({ open, onOpenChange, target, count, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; target: Target | null; count: number; onDone?: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const list = useQuery({ queryKey: [...COLLECTIONS_KEY, 'list', 'ACTIVE'], queryFn: () => fetchCollections('ACTIVE'), enabled: open, staleTime: 10_000 });
  const manual = (list.data?.items ?? []).filter((c) => c.kind === 'MANUAL');
  const [picked, setPicked] = useState<string | null>(null); const [fresh, setFresh] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPicked(null); setFresh(''); setBusy(false); } }, [open]);

  async function run() {
    if (!target) return;
    setBusy(true);
    try {
      let id = picked; let name = manual.find((c) => c.id === picked)?.name ?? '';
      if (!id) { name = fresh.trim(); id = (await createCollection({ name })).id; }
      const r = await addToCollection(id, target);
      void qc.invalidateQueries({ queryKey: COLLECTIONS_KEY }); void qc.invalidateQueries({ queryKey: ['library', 'detail'] });
      toast({ kind: 'ok', title: `${r.added.toLocaleString('en-GB')} added to “${name}”`, body: r.alreadyIn ? `${r.alreadyIn.toLocaleString('en-GB')} ${r.alreadyIn === 1 ? 'was' : 'were'} already in it.` : undefined });
      onOpenChange(false); onDone?.();
    } catch (e) {
      toast({ kind: 'error', title: e instanceof ApiError && e.status === 409 ? 'That name is already used' : 'Could not add to the collection', body: e instanceof ApiError ? e.message : undefined }); setBusy(false);
    }
  }
  const ready = !!picked || fresh.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Add ${count.toLocaleString('en-GB')} photograph${count === 1 ? '' : 's'} to a collection`}
      description="Collections only list photographs; nothing is copied or moved on disk."
      actions={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!ready || busy} onClick={() => void run()}>{picked ? 'Add' : 'Create and add'}</Button></>}>
      <div role="radiogroup" aria-label="Collections" className="jb-pick">
        {manual.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={picked === c.id} className="jb-pick__row" onClick={() => { setPicked(picked === c.id ? null : c.id); setFresh(''); }}>
            <span>{c.name}</span><span className="t-meta t-num">{c.count ?? 0}</span>
          </button>))}
        {list.isLoading && <Meta>Loading collections…</Meta>}
        {list.data && manual.length === 0 && <Meta>You have no manual collections yet — name one below.</Meta>}
      </div>
      <Field label="Or create a new collection" value={fresh} onChange={(v) => { setFresh(v); if (v) setPicked(null); }} maxLength={80} />
    </Dialog>
  );
}
