import type { ElementType, ReactNode } from 'react';
import { cx } from '../lib/cx';

type As = { as?: ElementType; className?: string; children?: ReactNode; id?: string };
const make = (cls: string, def: ElementType) => ({ as, className, children, id }: As) => {
  const C = as ?? def;
  return <C id={id} className={cx(cls, className)}>{children}</C>;
};
export const Display = make('t-display', 'h1');
export const H1 = make('t-h1', 'h1');
export const H2 = make('t-h2', 'h2');
export const H3 = make('t-h3', 'h3');
export const Body = make('t-body', 'p');
export const BodyLg = make('t-body-lg', 'p');
export const Meta = make('t-meta', 'p');
export const Caption = make('t-caption', 'p');
/** Uppercase tracked micro-label. For section names and categories only — never for sentences. */
export const Label = make('label', 'p');
export const LabelSm = make('label-sm', 'p');
/** Large luminous statistic (the only place phosphor pink is used for text). */
export const Stat = ({ value, label }: { value: ReactNode; label: string }) => (
  <div><p className="t-stat">{value}</p><p className="label-sm" style={{ marginTop: 6, color: 'var(--mist)' }}>{label}</p></div>
);
export const Num = ({ children }: { children: ReactNode }) => <span className="t-num">{children}</span>;
