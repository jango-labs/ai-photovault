import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { AiSettingsPage } from './ai/AiSettingsPage';
import { ComparePage } from './library/ComparePage';
import { DuplicatesPage } from './library/DuplicatesPage';
import { LibraryPage } from './library/LibraryPage';
import { CollectionPage } from './collections/CollectionPage';
import { CuratorPage } from './curator/CuratorPage';
import { CollectionsPage } from './collections/CollectionsPage';
import { SearchPage } from './search/SearchPage';
import { ImportRunPage, ImportsPage } from './imports/ImportsPage';
import { LoginPage } from './pages/LoginPage';
import { PublishCalendarPage, PublishHistoryPage } from './pages/Publish';
import { ComposerPage } from './publishing/ComposerPage';
import { PublishListPage } from './publishing/ListPage';
import { AccountPage, DisplayPage, SystemPage } from './pages/Settings';
import { AppShell } from './shell/AppShell';
import { TooltipProvider } from './ui/Dialog';
import { ToastProvider } from './ui/feedback';

// the showcase (and its fixtures) is a separate chunk: the app shell stays small
// the map carries an offline world outline (~110 kB), so it is loaded only when the Map is opened
const MapPage = lazy(() => import('./map/MapPage').then((m) => ({ default: m.MapPage })));
const DesignSystemPage = lazy(() => import('./design/DesignSystemPage').then((m) => ({ default: m.DesignSystemPage })));

export function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<Navigate to="/library" replace />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/library/compare" element={<ComparePage />} />
              <Route path="/library/duplicates" element={<DuplicatesPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/imports" element={<ImportsPage />} />
              <Route path="/imports/runs/:id" element={<ImportRunPage />} />
              <Route path="/collections" element={<CollectionsPage />} />
              <Route path="/collections/:id" element={<CollectionPage />} />
              <Route path="/curator" element={<CuratorPage />} />
              <Route path="/map" element={<Suspense fallback={<div className="jb-page" role="status"><span className="label-sm">Loading the map…</span></div>}><MapPage /></Suspense>} />
              <Route path="/publish" element={<Navigate to="/publish/calendar" replace />} />
              <Route path="/publish/calendar" element={<PublishCalendarPage />} />
              <Route path="/publish/history" element={<PublishHistoryPage />} />
              <Route path="/publish/compose" element={<ComposerPage />} />
              <Route path="/publish/drafts" element={<PublishListPage sub="Drafts" states={['DRAFT']} empty="Start a post from the calendar, or choose “Create Instagram draft” in a photograph’s Information panel." />} />
              <Route path="/publish/ready" element={<PublishListPage sub="Ready" states={['READY']} empty="Drafts you have marked ready, waiting for your approval and a time." />} />
              <Route path="/publish/scheduled" element={<PublishListPage sub="Scheduled" states={['SCHEDULED', 'PUBLISHING']} empty="Approved posts with a time appear here. Nothing is sent to Instagram yet." />} />
              <Route path="/publish/published" element={<PublishListPage sub="Published" states={['PUBLISHED', 'FAILED', 'CANCELLED']} empty="Published, failed and discarded posts are kept here." />} />
              <Route path="/settings" element={<Navigate to="/settings/account" replace />} />
              <Route path="/settings/account" element={<AccountPage />} />
              <Route path="/settings/display" element={<DisplayPage />} />
              <Route path="/settings/ai" element={<AiSettingsPage />} />
              <Route path="/settings/system" element={<SystemPage />} />
              <Route path="/design-system" element={<Suspense fallback={<div className="jb-page" role="status"><span className="label-sm">Loading design system…</span></div>}><DesignSystemPage /></Suspense>} />
              <Route path="*" element={<Navigate to="/library" replace />} />
            </Route>
          </Route>
        </Routes>
      </ToastProvider>
    </TooltipProvider>
  );
}
