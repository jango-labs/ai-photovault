import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Hairline } from '../ui/feedback';
import { useAuth } from './AuthProvider';

/** Everything except /login needs a valid session. The server enforces this independently; this only decides what to render. */
export function RequireAuth() {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <div className="jb-page" role="status" aria-label="Checking your session"><div style={{ maxWidth: 240, marginTop: '30vh' }}><Hairline label="Checking your session" /></div></div>;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Outlet />;
}
