import * as D from '@radix-ui/react-dialog';
import * as TT from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { IconButton } from './Button';

/** Modal dialog (focus trapped, Esc closes, returns focus). Use for confirmations and short forms only. */
export function Dialog({ open, onOpenChange, title, description, children, actions }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children?: ReactNode; actions?: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="jb-scrim" />
        <D.Content className="jb-dialog" aria-describedby={description ? undefined : undefined}>
          <D.Title className="t-h2 jb-dialog__title">{title}</D.Title>
          {description ? <D.Description className="t-body">{description}</D.Description> : <D.Description className="jb-sr-only">{title}</D.Description>}
          <div style={{ marginTop: 16 }}>{children}</div>
          {actions && <div className="jb-dialog__actions">{actions}</div>}
          <D.Close asChild><IconButton icon="close" label="Close" size="sm" className="" style={{ position: 'absolute', top: 14, right: 14 }} /></D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const TooltipProvider = TT.Provider;
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <TT.Root delayDuration={400}>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal><TT.Content className="jb-tooltip" sideOffset={6}>{text}</TT.Content></TT.Portal>
    </TT.Root>
  );
}
