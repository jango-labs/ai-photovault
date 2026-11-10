import type { IconName } from '../ui/Icon';

export const PRIMARY_NAV: ReadonlyArray<{ label: string; short: string; path: string; icon: IconName }> = [
  { label: 'Library', short: 'Library', path: '/library', icon: 'library' },
  { label: 'Imports', short: 'Imports', path: '/imports', icon: 'inbox' },
  { label: 'Collections', short: 'Collect.', path: '/collections', icon: 'folder' },
  { label: 'AI Curator', short: 'Curator', path: '/curator', icon: 'curator' },
  { label: 'Map', short: 'Map', path: '/map', icon: 'map' },
  { label: 'Publish', short: 'Publish', path: '/publish', icon: 'send' },
];

export const SETTINGS_NAV: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'Account', path: '/settings/account' },
  { label: 'Display', path: '/settings/display' },
  { label: 'AI', path: '/settings/ai' },
  { label: 'System', path: '/settings/system' },
];

/** Instagram History is a first-class part of PUBLISH: its tab carries the number of matches waiting for review. */
export const PUBLISH_NAV: ReadonlyArray<{ label: string; path: string; badge?: 'review' }> = [
  { label: 'Calendar', path: '/publish/calendar' },
  { label: 'Drafts', path: '/publish/drafts' },
  { label: 'Ready', path: '/publish/ready' },
  { label: 'Scheduled', path: '/publish/scheduled' },
  { label: 'Published', path: '/publish/published' },
  { label: 'History', path: '/publish/history', badge: 'review' },
];
