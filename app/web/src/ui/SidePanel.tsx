import * as D from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { IconButton } from './Button';

/** Contextual drawer (right on desktop, bottom sheet on phones). Modal: focus is trapped and Esc closes. */
export function SidePanel({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="jb-scrim" />
        <D.Content className="jb-drawer" aria-describedby={undefined}>
          <div className="jb-row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            <D.Title className="t-h2">{title}</D.Title>
            <D.Close asChild><IconButton icon="close" label="Close panel" size="sm" /></D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
