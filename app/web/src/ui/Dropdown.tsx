import * as DM from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface MenuOption<T extends string = string> { value: T; label: string; disabled?: boolean }

/** Single-choice dropdown (e.g. SORT). Built on Radix: full keyboard + typeahead + focus management. */
export function Select<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: ReadonlyArray<MenuOption<T>>; onChange: (v: T) => void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button type="button" className="jb-btn jb-btn--outline">
          <span className="label-sm" style={{ color: 'var(--text-3)' }}>{label}</span>{' '}{current?.label}<Icon name="chevronDown" size={12} />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className="jb-menu" sideOffset={6} align="start">
          <DM.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {options.map((o) => (
              <DM.RadioItem key={o.value} value={o.value} disabled={o.disabled} className="jb-menu__item">
                <span style={{ width: 14 }}><DM.ItemIndicator><Icon name="check" size={12} /></DM.ItemIndicator></span>{o.label}
              </DM.RadioItem>
            ))}
          </DM.RadioGroup>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export interface ActionItem { label: string; onSelect: () => void; icon?: ReactNode; disabled?: boolean; danger?: boolean }

/** Action menu (e.g. ⋯ on a photograph). */
export function ActionMenu({ label, items, trigger }: { label: string; items: ActionItem[]; trigger?: ReactNode }) {
  return (
    <DM.Root>
      <DM.Trigger asChild>
        {trigger ?? <button type="button" className="jb-btn jb-btn--icon jb-btn--sm" aria-label={label}><Icon name="more" size={14} /></button>}
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className="jb-menu" sideOffset={6} align="end">
          {items.map((it, i) => (
            <DM.Item key={i} className="jb-menu__item" disabled={it.disabled} onSelect={it.onSelect} style={it.danger ? { color: 'var(--danger)' } : undefined}>{it.icon}{it.label}</DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/** Multi-choice filter dropdown (checkbox items). */
export function FilterMenu({ label, options, selected, onChange }: {
  label: string; options: ReadonlyArray<MenuOption>; selected: ReadonlySet<string>; onChange: (next: Set<string>) => void;
}) {
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button type="button" className="jb-btn jb-btn--outline">
          {label}{selected.size > 0 && <>{' '}<span className="t-num" style={{ color: 'var(--aqua)' }}>{selected.size}<span className="jb-sr-only"> selected</span></span></>}<Icon name="chevronDown" size={12} />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className="jb-menu" sideOffset={6} align="start">
          {options.map((o) => (
            <DM.CheckboxItem key={o.value} className="jb-menu__item" checked={selected.has(o.value)} onSelect={(e) => e.preventDefault()}
              onCheckedChange={(c) => { const n = new Set(selected); if (c) n.add(o.value); else n.delete(o.value); onChange(n); }}>
              <span style={{ width: 14 }}><DM.ItemIndicator><Icon name="check" size={12} /></DM.ItemIndicator></span>{o.label}
            </DM.CheckboxItem>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
