import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PostedNotice } from '../instagram/PostedNotice';
import { Button } from '../ui/Button';
import { AddToCollection } from './AddToCollection';

/** Under the viewer's Information tab: add this photograph to a collection, or find look-alikes. */
export function ViewerActions({ photoId }: { photoId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
    <PostedNotice photoId={photoId} />
    <div className="jb-row" style={{ margin: '10px 0 0', flexWrap: 'wrap' }}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Add to collection…</Button>
      <Link className="jb-btn jb-btn--outline jb-btn--sm" to={`/search?similar=${photoId}`}>Find similar photographs</Link>
      <Link className="jb-btn jb-btn--outline jb-btn--sm" to={`/publish/compose?photo=${photoId}`}>Create Instagram draft</Link>
      <AddToCollection open={open} onOpenChange={setOpen} target={{ ids: [photoId] }} count={1} />
    </div>
    </>
  );
}
