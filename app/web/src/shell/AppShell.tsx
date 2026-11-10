import { useState } from 'react';
import { Wordmark } from './Wordmark';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useQuery } from '@tanstack/react-query';
import { IG_KEY, fetchReview } from '../api/instagram';
import { ActionMenu } from '../ui/Dropdown';
import { Icon } from '../ui/Icon';
import { SearchField } from '../ui/controls';
import { IconButton } from '../ui/Button';
import { Tooltip } from '../ui/Dialog';
import { PRIMARY_NAV, PUBLISH_NAV, SETTINGS_NAV } from './nav';

/**
 * Application shell. Navigation is deliberately quiet: tracked micro-labels, one aqua underline for the current workspace,
 * no icons or fills on desktop. Phones get a bottom tab bar. PUBLISH shows its own second row.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const inPublish = pathname.startsWith('/publish');
  const inSettings = pathname.startsWith('/settings');
  const { user, signOut } = useAuth();
  const go = useNavigate();
  const [search, setSearch] = useState('');
  const reviewQ = useQuery({ queryKey: [...IG_KEY, 'review-count'], queryFn: () => fetchReview(1), staleTime: 30_000, retry: false });
  const review = reviewQ.data?.total ?? 0;
  return (
    <>
      <a className="jb-skip" href="#main">Skip to content</a>
      <header className="jb-topbar">
        <div className="jb-topbar__inner">
          <Wordmark to="/library" />
          <nav className="jb-nav" aria-label="Primary">
            {PRIMARY_NAV.map((n) => <NavLink key={n.path} to={n.path}>{n.label}</NavLink>)}
          </nav>
          <span className="jb-topbar__spacer" />
          <SearchField className="" label="Search the library" placeholder="Search photographs…" value={search} onChange={setSearch} hint={null}
            onSubmit={(v) => { const p = new URLSearchParams(); if (v.trim()) p.set('q', v.trim()); go(`/search${p.size ? `?${p}` : ''}`); }} />
          <Tooltip text="Sync agent: online (demo)"><span className="jb-dot" role="img" aria-label="Sync agent online" tabIndex={0} /></Tooltip>
          <ActionMenu label="Account menu" trigger={<IconButton icon="user" label="Account menu" size="sm" />} items={[
            { label: user?.email ?? 'Signed in', onSelect: () => go('/settings/account'), disabled: false },
            { label: 'Display settings', onSelect: () => go('/settings/display') },
            { label: 'System status', onSelect: () => go('/settings/system') },
            { label: 'Sign out', onSelect: () => void signOut().then(() => go('/login', { replace: true })) },
          ]} />
        </div>
        {inPublish && (
          <nav className="jb-subnav" aria-label="Publish">
            {PUBLISH_NAV.map((n) => <NavLink key={n.path} to={n.path}>{n.label}{n.badge === 'review' && review > 0 && <span className="jb-badge" title={`${review} possible matches to review`}>{review}<span className="jb-sr-only"> possible matches to review</span></span>}</NavLink>)}
          </nav>
        )}
        {inSettings && (
          <nav className="jb-subnav" aria-label="Settings">
            {SETTINGS_NAV.map((n) => <NavLink key={n.path} to={n.path}>{n.label}</NavLink>)}
          </nav>
        )}
      </header>
      <main id="main" tabIndex={-1} style={{ outline: 0 }}><Outlet /></main>
      <nav className="jb-tabbar" aria-label="Primary (mobile)">
        {PRIMARY_NAV.map((n) => (
          <NavLink key={n.path} to={n.path}><Icon name={n.icon} size={18} />{n.short}</NavLink>
        ))}
      </nav>
    </>
  );
}
