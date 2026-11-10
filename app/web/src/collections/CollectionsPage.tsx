import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { COLLECTIONS_KEY, KIND_LABEL, createCollection, fetchCollections, type Collection } from '../api/collections';
import { imageUrl } from '../api/library';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, SegmentedControl } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';

const count = (c: Collection) => (c.count === null ? 'live' : `${c.count.toLocaleString('en-GB')} photograph${c.count === 1 ? '' : 's'}`);

export function CollectionsPage() {
  const [status, setStatus] = useState<Collection['status']>('ACTIVE');
  const q = useQuery({ queryKey: [...COLLECTIONS_KEY, 'list', status], queryFn: () => fetchCollections(status), staleTime: 10_000 });
  const qc = useQueryClient(); const toast = useToast(); const go = useNavigate();
  const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [desc, setDesc] = useState('');
  async function create() {
    try { const r = await createCollection({ name: name.trim(), description: desc.trim() || null }); setOpen(false); setName(''); setDesc(''); void qc.invalidateQueries({ queryKey: COLLECTIONS_KEY }); go(`/collections/${r.id}`); }
    catch (e) { toast({ kind: 'error', title: e instanceof ApiError && e.status === 409 ? 'That name is already used' : 'The collection could not be created', body: e instanceof ApiError ? e.message : undefined }); }
  }
  const items = q.data?.items ?? [];
  return (
    <div className="jb-page">
      <PageHeader eyebrow="Workspace" title="Collections" lede="Manual sets you curate, smart collections that follow your filters, and your saved searches."
        actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New collection</Button>} />
      <div className="jb-row" style={{ marginBottom: 14 }}>
        <SegmentedControl<Collection['status']> label="Show" value={status} onChange={setStatus} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'DRAFT', label: 'AI drafts' }, { value: 'ARCHIVED', label: 'Archived' }]} />
      </div>
      {q.isError ? <ErrorState title="Collections could not be loaded" onRetry={() => void q.refetch()}>Nothing was changed.</ErrorState>
        : q.isLoading ? <div aria-busy="true" role="status" aria-label="Loading collections" className="jb-coll__grid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={200} />)}</div>
        : items.length === 0 ? (
          <EmptyState icon="folder" title={status === 'ACTIVE' ? 'No collections yet' : status === 'DRAFT' ? 'No AI drafts' : 'Nothing archived'}
            action={status === 'ACTIVE' ? <Button variant="outline" onClick={() => setOpen(true)}>New collection</Button> : undefined}>
            {status === 'ACTIVE' ? 'Make a manual collection here, add photographs from the Library or a search, or save the Library’s current filters as a smart collection.' : status === 'DRAFT' ? 'Collections the AI Curator proposes appear here for your review. Nothing the AI makes is active until you say so.' : 'Archived collections are kept but hidden.'}
          </EmptyState>
        ) : (
          <ul className="jb-coll__grid" aria-label="Collections">
            {items.map((c) => (
              <li key={c.id}><Link to={`/collections/${c.id}`} className="jb-coll__card">
                <span className="jb-coll__cover" aria-hidden>{c.cover ? <img src={imageUrl(c.cover, 'thumb')} alt="" loading="lazy" /> : <span className="jb-coll__empty">{c.kind === 'MANUAL' ? 'Empty' : 'No matches'}</span>}</span>
                <span className="jb-coll__name">{c.name}</span>
                <span className="jb-coll__meta t-meta">{KIND_LABEL[c.kind]} · {count(c)}{c.createdBy === 'AI' ? ' · proposed by AI' : ''}</span>
              </Link></li>))}
          </ul>)}
      <Dialog open={open} onOpenChange={setOpen} title="New collection" description="A manual collection starts empty. Add photographs from the Library, Search or a viewer."
        actions={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>Create</Button></>}>
        <Field label="Name" value={name} onChange={setName} maxLength={80} autoFocus />
        <Field label="Description (optional)" value={desc} onChange={setDesc} maxLength={500} />
      </Dialog>
    </div>
  );
}
