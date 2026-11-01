import { forwardRef, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/text';
import { MenuList, Popover, type MenuItem } from './Overlay';

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Text used by typeahead and the closed button when label is a node. */
  text?: string;
  /** A logo before the label (models, providers). */
  lead?: ReactNode;
  /** Quiet second line in the menu. */
  detail?: ReactNode;
  /** Right aligned hint in the menu ("200K", "plan"). */
  hint?: ReactNode;
  disabled?: boolean;
  /** Start a new group with this label. */
  group?: string;
}

/**
 * Select (spec 10.5): a button showing the value plus a 12px chevron in fg-4
 * that opens a menu. Never the native select on desktop (the native one in
 * ui/Field is fine on phones).
 * - look="field": a 34px input-like box (forms)
 * - look="text": a text button for toolbars and composer bars
 */
export function SelectMenu<T extends string>({
  value,
  onChange,
  options,
  placeholder = 'Choose',
  look = 'field',
  label,
  prefix,
  className,
  width,
  disabled,
  id,
  invalid,
}: {
  value: T | undefined;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  look?: 'field' | 'text';
  /** aria-label of the button when there is no visible label */
  label?: string;
  /** Quiet word before the value in look="text" ("Agent", "On"). */
  prefix?: ReactNode;
  className?: string;
  /** Menu width. Defaults to the button width (at least 200). */
  width?: number;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  const items: MenuItem[] = [];
  let group: string | undefined;
  for (const o of options) {
    if (o.group && o.group !== group) {
      if (items.length) items.push({ separator: true, label: '' });
      items.push({ group: true, label: o.group });
      group = o.group;
    }
    items.push({ label: o.label, lead: o.lead, detail: o.detail, hint: o.hint, disabled: o.disabled, checked: o.value === value, onSelect: () => onChange(o.value) });
  }
  const menuWidth = width ?? Math.max(200, ref.current?.offsetWidth ?? 0);
  return (
    <>
      <PickerButton
        ref={ref}
        id={id}
        look={look}
        prefix={prefix}
        lead={cur?.lead}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        invalid={invalid}
        className={className}
        onClick={() => setOpen((o) => !o)}
      >
        {cur ? (cur.text ?? cur.label) : <span data-placeholder className="text-fg-3">{placeholder}</span>}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={menuWidth} label={label}>
        <MenuList items={items} onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}

export interface PickerButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'prefix'> {
  look?: 'field' | 'text';
  /** Quiet word before the value ("Agent", "On"). */
  prefix?: ReactNode;
  /** Logo before the value. */
  lead?: ReactNode;
  invalid?: boolean;
  /** Hide the chevron (rare). */
  noChevron?: boolean;
}

/**
 * The closed state of a picker. look="text" is the composer picker: optional
 * prefix in fg-3, value in fg-2, logo before the model, chevron after.
 */
export const PickerButton = forwardRef<HTMLButtonElement, PickerButtonProps>(function PickerButton(
  { look = 'field', prefix, lead, invalid, noChevron, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-left whitespace-nowrap transition-[color,background-color,border-color] duration-[var(--dur-1)]',
        look === 'field'
          ? cn(
              'h-[34px] w-full rounded-[var(--r-1)] border bg-sunk px-2.5 text-[13px] text-fg phone:h-11 phone:text-[16px] aria-expanded:border-signal aria-expanded:shadow-[0_0_0_1px_var(--signal)]',
              invalid ? 'border-fault' : 'border-edge',
            )
          : 'h-[26px] rounded-[var(--r-1)] px-1.5 text-[13px] text-fg-2 hov:bg-hover hov:text-fg aria-expanded:bg-hover aria-expanded:text-fg',
        disabled && 'text-fg-3',
        className,
      )}
      {...rest}
    >
      {prefix && <span className="text-fg-3">{prefix}</span>}
      {lead && <span className="flex shrink-0 items-center">{lead}</span>}
      <span className={cn('min-w-0 truncate', look === 'field' && 'flex-1')}>{children}</span>
      {!noChevron && <ChevronDown className="size-3 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden />}
    </button>
  );
});
