import * as T from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

export interface TabDef { value: string; label: string; content: ReactNode }

/** Underlined tab strip with tracked uppercase labels (INFO · AI · EXIF …). Arrow keys move between tabs (Radix). */
export function Tabs({ label, tabs, value, onValueChange, defaultValue }: {
  label: string; tabs: TabDef[]; value?: string; onValueChange?: (v: string) => void; defaultValue?: string;
}) {
  return (
    <T.Root value={value} onValueChange={onValueChange} defaultValue={defaultValue ?? tabs[0]?.value}>
      <T.List className="jb-tabs__list" aria-label={label}>
        {tabs.map((t) => <T.Trigger key={t.value} value={t.value} className="jb-tabs__trigger">{t.label}</T.Trigger>)}
      </T.List>
      {tabs.map((t) => <T.Content key={t.value} value={t.value} className="jb-tabs__content">{t.content}</T.Content>)}
    </T.Root>
  );
}
