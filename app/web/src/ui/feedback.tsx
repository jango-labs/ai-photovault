import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { IconButton } from './Button';

export function EmptyState({ icon = 'image', title, children, action, level = 2 }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; level?: 2 | 3 | 4 }) {
  const H = `h${level}` as 'h2';
  return (
    <div className="jb-empty" role="status">
      <span className="jb-empty__art"><Icon name={icon} size={32} /></span>
      <H className="t-h3">{title}</H>
      {children && <p className="t-body">{children}</p>}
      {action}
    </div>
  );
}

/** Understandable errors: what happened, what it means for the user's data, what to do. */
export function ErrorState({ title, children, onRetry, detail, level = 2 }: { title: string; children?: ReactNode; onRetry?: () => void; detail?: string; level?: 2 | 3 | 4 }) {
  const H = `h${level}` as 'h2';
  return (
    <div className="jb-error" role="alert">
      <p className="label">Error</p>
      <H className="t-h3">{title}</H>
      {children && <p className="t-body">{children}</p>}
      {detail && <p className="t-meta t-num">{detail}</p>}
      {onRetry && <div><Button variant="outline" icon="refresh" onClick={onRetry}>Try again</Button></div>}
    </div>
  );
}

export function Skeleton({ width, height, style, className }: { width?: number | string; height?: number | string; style?: CSSProperties; className?: string }) {
  return <div className={cx('jb-skel', className)} style={{ width, height, ...style }} aria-hidden />;
}

/** 2px activity hairline. Indeterminate (AI working) or determinate (`value` 0–1). Motion is removed under prefers-reduced-motion. */
export function Hairline({ value, label = 'Working', staticOnly }: { value?: number; label?: string; staticOnly?: boolean }) {
  const det = typeof value === 'number';
  return (
    <div className={cx('jb-hairline', staticOnly && 'jb-hairline--static')} role="progressbar" aria-label={label}
      aria-valuemin={det ? 0 : undefined} aria-valuemax={det ? 100 : undefined} aria-valuenow={det ? Math.round(value * 100) : undefined}
      data-value={det ? '' : undefined} style={det ? ({ ['--v' as string]: `${Math.round(value * 100)}%` } as CSSProperties) : undefined} />
  );
}

export type ProcessingKind = 'queued' | 'analysing' | 'embedding' | 'failed' | 'done';
const PROC_LABEL: Record<ProcessingKind, string> = { queued: 'Queued', analysing: 'Analysing', embedding: 'Embedding', failed: 'Failed', done: 'Analysed' };

/** Understated AI processing indicator: text + hairline (no sparkles, no spinners). */
export function ProcessingState({ kind, detail }: { kind: ProcessingKind; detail?: string }) {
  const working = kind === 'analysing' || kind === 'embedding';
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 140 }} role="status">
      <span className="label-sm" style={{ color: kind === 'failed' ? 'var(--danger)' : working ? 'var(--aqua)' : 'var(--text-3)' }}>
        {PROC_LABEL[kind]}{detail ? ` · ${detail}` : ''}
      </span>
      {working ? <Hairline label={PROC_LABEL[kind]} /> : kind === 'queued' ? <Hairline staticOnly label="Queued" /> : null}
    </div>
  );
}

/* ---------------- notifications ---------------- */
export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
interface ToastItem { id: number; kind: ToastKind; title: string; body?: string; action?: { label: string; onClick: () => void } }
const ToastCtx = createContext<{ push: (t: Omit<ToastItem, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());
  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id); if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    if (t.kind !== 'error') timers.current.set(id, window.setTimeout(() => dismiss(id), 6000));   // errors persist until dismissed
  }, [dismiss]);
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="jb-toasts" aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <div key={t.id} className="jb-toast" data-kind={t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
            <p className="t-h3" style={{ fontSize: 13 }}>{t.title}</p>
            <IconButton icon="close" label="Dismiss notification" size="sm" onClick={() => dismiss(t.id)} style={{ gridRow: '1 / span 2', gridColumn: 2 }} />
            {t.body && <p className="t-meta" style={{ color: 'var(--text-2)' }}>{t.body}</p>}
            {t.action && <div style={{ gridColumn: 1 }}><Button size="sm" variant="ghost" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</Button></div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast must be used inside <ToastProvider>');
  return c.push;
}
