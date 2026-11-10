import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Icon } from './Icon';

/** Segmented control: a radio group (arrow keys move + select). */
export function SegmentedControl<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n]!.value);
    refs.current[n]?.focus();
  };
  return (
    <div className="jb-seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)} onKeyDown={(e) => onKey(e, i)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const id = useId();
  return (
    <span className="jb-toggle-row">
      <button id={id} type="button" role="switch" aria-checked={checked} className="jb-switch" onClick={() => onChange(!checked)} />
      <label htmlFor={id}>{label}</label>
    </span>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string;
}) {
  const id = useId();
  return (
    <span className="jb-toggle-row">
      <label htmlFor={id} className="label-sm">{label}</label>
      <input id={id} className="jb-slider" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={format ? format(value) : undefined} />
      <span className="t-meta t-num" aria-hidden>{format ? format(value) : value}</span>
    </span>
  );
}

export function SearchField({ label = 'Search', placeholder = 'Search photographs…', hint = '⌘K', value, onChange, onSubmit, className }: {
  label?: string; placeholder?: string; hint?: string | null; value?: string; onChange?: (v: string) => void; onSubmit?: (v: string) => void; className?: string;
}) {
  return (
    <form className={cx('jb-field', 'jb-field--search', className)} role="search" aria-label={label} onSubmit={(e) => { e.preventDefault(); onSubmit?.(value ?? ''); }}>
      <Icon name="search" size={14} />
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange?.(e.target.value)} />
      {hint && <kbd aria-hidden>{hint}</kbd>}
    </form>
  );
}

/** A removable filter, e.g. PLACE · Kenya ✕. */
export function FilterChip({ name, value, onRemove }: { name: string; value: ReactNode; onRemove?: () => void }) {
  return (
    <span className="jb-chip"><b>{name}</b>{value}
      {onRemove && <button type="button" aria-label={`Remove filter ${name}`} onClick={onRemove}><Icon name="close" size={11} /></button>}
    </span>
  );
}

/** Labelled text input for forms. Errors are announced; the label is always visible. */
export function Field({ label, value, onChange, type = 'text', autoComplete, error, hint, inputMode, name, autoFocus, maxLength, disabled, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: 'text' | 'email' | 'password' | 'datetime-local' | 'number'; autoComplete?: string; error?: string | null; hint?: string;
  inputMode?: 'text' | 'numeric' | 'email' | 'decimal'; name?: string; autoFocus?: boolean; maxLength?: number; disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const isPw = type === 'password';
  return (
    <div className="jb-formfield">
      <label htmlFor={id} className="label-sm">{label}</label>
      <span className={cx('jb-field', 'jb-field--block')} data-invalid={error ? 'true' : undefined}>
        <input id={id} name={name} type={isPw && shown ? 'text' : type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} inputMode={inputMode}
          autoFocus={autoFocus} maxLength={maxLength} disabled={disabled} placeholder={placeholder} aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        {isPw && <button type="button" className="jb-field__toggle" onClick={() => setShown(!shown)} aria-pressed={shown} aria-label={shown ? 'Hide password' : 'Show password'}><Icon name="eye" size={14} /></button>}
      </span>
      {error ? <p id={`${id}-e`} className="t-meta" style={{ color: 'var(--danger)' }} role="alert">{error}</p> : hint ? <p id={`${id}-h`} className="t-meta">{hint}</p> : null}
    </div>
  );
}

/** Labelled multi-line input (descriptions, notes). Same visual language as Field. */
export function TextArea({ label, value, onChange, rows = 3, maxLength, hint, disabled }: { label: string; value: string; onChange: (v: string) => void; rows?: number; maxLength?: number; hint?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="jb-formfield">
      <label htmlFor={id} className="label-sm">{label}</label>
      <span className={cx('jb-field', 'jb-field--block', 'jb-field--area')}>
        <textarea id={id} value={value} rows={rows} maxLength={maxLength} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-h` : undefined} />
      </span>
      {hint && <p id={`${id}-h`} className="t-meta">{hint}</p>}
    </div>
  );
}
