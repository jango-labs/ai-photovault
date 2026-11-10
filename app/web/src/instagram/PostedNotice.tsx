import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IG_KEY, fetchPostedCheck, igImage } from '../api/instagram';
import { formatPostDate } from '../ui/history/HistoryGrid';

/** In the viewer: tells you, in words, whether this photograph (or a look-alike) is already on Instagram. It informs; it never blocks. */
export function PostedNotice({ photoId }: { photoId: string }) {
  const q = useQuery({ queryKey: [...IG_KEY, 'posted-check', photoId], queryFn: () => fetchPostedCheck(photoId), staleTime: 30_000, retry: false });
  if (!q.data || q.data.kind === 'none' || !q.data.last) return null;
  const { kind, last, count } = q.data;
  return (
    <div className="jb-posted" role="note" aria-label="Instagram history for this photograph">
      <img src={igImage(last.mediaId)} alt="" loading="lazy" />
      <div>
        <p className="label" style={{ color: 'var(--warn)', margin: 0 }}>{kind === 'same' ? 'Already posted to Instagram' : 'A similar image was posted'}</p>
        <p className="t-meta" style={{ margin: '2px 0' }}>{kind === 'same' && count > 1 ? `${count} times, last on ` : 'Posted '}<span className="t-num">{formatPostDate(last.postedAt)}</span></p>
        <Link className="t-meta" to="/publish/history">See it in Instagram history</Link>
      </div>
    </div>
  );
}
