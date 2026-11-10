import type { ReactNode } from 'react';
import { Label } from '../ui/typography';

/** Consistent page head: tracked eyebrow, medium-weight title, optional lede, actions on the right. */
export function PageHeader({ eyebrow, title, lede, actions }: { eyebrow?: string; title: string; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="jb-pageheader">
      <div className="jb-pageheader__text">
        {eyebrow && <Label>{eyebrow}</Label>}
        <h1 className="t-display" style={{ fontSize: 'clamp(36px, 4.4vw, 72px)' }}>{title}</h1>
        {lede && <p className="t-body-lg" style={{ maxWidth: 640 }}>{lede}</p>}
      </div>
      {actions && <div className="jb-pageheader__actions">{actions}</div>}
    </header>
  );
}
