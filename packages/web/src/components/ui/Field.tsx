/**
 * Form controls (spec 10.5, 10.11). Inputs sit in bg-sunk with an --edge
 * border; focus turns the border signal with a 1px ring. Invalid fields say
 * why in a sentence under the field, never only with a red border.
 */
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/text';
import { Kbd } from './Kbd';

const FIELD =
  'w-full rounded-[var(--r-1)] border bg-sunk text-fg transition-[border-color,box-shadow] duration-[var(--dur-1)] placeholder:text-fg-3 focus:outline-none disabled:text-fg-3 disabled:cursor-default';

export type InputSize = 'sm' | 'md' | 'lg';
const INPUT_H: Record<InputSize, string> = {
  sm: 'h-[30px] phone:h-11',
  md: 'h-[34px] phone:h-11',
  lg: 'h-[38px] phone:h-11',
};

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  /** Keys, URLs, paths, cron and ids are mono. */
  mono?: boolean;
  /** sm 30px (list filters), md 34px (default), lg 38px (page search). 44px on phones. */
  size?: InputSize;
  /** true for a fault border; pass the reason to <Field error> so it shows as a sentence. */
  invalid?: boolean;
  /** Text inside the box before the value ("$", "https://"). */
  prefix?: ReactNode;
  /** Text or a control inside the box after the value. */
  suffix?: ReactNode;
  /** A key hint at the right edge ("/"). */
  kbd?: string;
  /** Classes for the outer box when prefix, suffix or kbd are used. */
  boxClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, boxClassName, mono, size = 'md', invalid, prefix, suffix, kbd, ...rest },
  ref,
) {
  const textCls = cn('text-[13px]', mono && 'font-mono text-[12.5px] tracking-[-0.01em] [font-feature-settings:"zero"_1]');
  if (prefix || suffix || kbd) {
    return (
      <div
        className={cn(
          FIELD,
          INPUT_H[size],
          'flex items-center gap-2 px-2.5',
          invalid ? 'border-fault focus-within:shadow-[0_0_0_1px_var(--fault)]' : 'border-edge focus-within:border-signal focus-within:shadow-[0_0_0_1px_var(--signal)]',
          boxClassName,
          className,
        )}
      >
        {prefix && <span className="shrink-0 text-[13px] text-fg-3">{prefix}</span>}
        <input ref={ref} aria-invalid={invalid || undefined} className={cn('h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-3', textCls)} {...rest} />
        {suffix && <span className="shrink-0 text-[13px] text-fg-3">{suffix}</span>}
        {kbd && <Kbd>{kbd}</Kbd>}
      </div>
    );
  }
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn(FIELD, INPUT_H[size], 'px-2.5', textCls, invalid ? 'border-fault focus:shadow-[0_0_0_1px_var(--fault)]' : 'border-edge focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)]', className)} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  invalid?: boolean;
  /** Grow with the content up to this many lines, then scroll. Default 12. 0 disables. */
  maxRows?: number;
  /** Minimum visible lines. Default 3. */
  minRows?: number;
  /** Prose size (14.5/1.6) for prompts and notes. */
  prose?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono, invalid, maxRows = 12, minRows = 3, prose, onChange, value, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const fit = useCallback(() => {
    const el = inner.current;
    if (!el || !maxRows) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), lh * maxRows + pad);
    el.style.height = `${Math.max(h, lh * minRows + pad)}px`;
    el.style.overflowY = el.scrollHeight > h ? 'auto' : 'hidden';
  }, [maxRows, minRows]);
  useLayoutEffect(fit, [value, fit]);
  return (
    <textarea
      ref={setRef}
      value={value}
      rows={minRows}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        onChange?.(e);
        if (value === undefined) fit();
      }}
      className={cn(
        FIELD,
        'block resize-none px-2.5 py-2 leading-[1.6]',
        prose ? 'text-[14.5px] phone:text-[16px]' : 'text-[13px]',
        mono && 'font-mono text-[12.5px] tracking-[-0.01em]',
        invalid ? 'border-fault focus:shadow-[0_0_0_1px_var(--fault)]' : 'border-edge focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)]',
        className,
      )}
      {...rest}
    />
  );
});

/**
 * Native select. Fine on phones; on desktop prefer SelectMenu (ui/Select).
 * Kept with the legacy API (children <option>, onChange event).
 */
export function Select({ className, children, mono, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { mono?: boolean }) {
  return (
    <div className={cn('relative', className)}>
      <select className={cn(FIELD, 'h-[34px] appearance-none border-edge pr-8 pl-2.5 focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)] text-[13px] phone:h-11', mono && 'font-mono text-[12.5px]')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 text-fg-4" strokeWidth={1.75} />
    </div>
  );
}

/**
 * Label above, help or error below. The first child control gets the id, and
 * aria-describedby pointing at the help or error.
 */
export function Field({
  label,
  help,
  error,
  children,
  className,
  htmlFor,
  optional,
}: {
  label: ReactNode;
  help?: ReactNode;
  /** A sentence that says what is wrong and how to fix it, in fault. */
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
  optional?: boolean;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const helpId = `${id}-help`;
  const note = error ?? help;
  let wired = false;
  const kids = Children.map(children, (c) => {
    if (wired || !isValidElement(c)) return c;
    const native = typeof c.type === 'string';
    if (native && !['input', 'textarea', 'select'].includes(c.type as string)) return c;
    wired = true;
    const el = c as ReactElement<Record<string, unknown>>;
    return cloneElement(el, {
      id: (el.props.id as string | undefined) ?? id,
      'aria-describedby': note ? helpId : undefined,
      ...(error ? (native ? { 'aria-invalid': true } : { invalid: true }) : {}),
    });
  });
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[12px] font-medium text-fg-2 phone:text-[13px]">
        {label}
        {optional && <span className="ml-1.5 font-normal text-fg-3">optional</span>}
      </label>
      {kids}
      {note && (
        <p id={helpId} className={cn('text-[12px] leading-[1.4] phone:text-[13px]', error ? 'text-fault' : 'text-fg-3')}>
          {note}
        </p>
      )}
    </div>
  );
}

/** Help or error text under a control, when Field is not used. */
export function Help({ children, error, id, className }: { children: ReactNode; error?: boolean; id?: string; className?: string }) {
  return (
    <p id={id} className={cn('text-[12px] leading-[1.4] phone:text-[13px]', error ? 'text-fault' : 'text-fg-3', className)}>
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Checkbox and radio: 14px, 1px edge, checked fill fg with a bg check
// ---------------------------------------------------------------------------

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  mono,
  disabled,
  indeterminate,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  mono?: boolean;
  disabled?: boolean;
  indeterminate?: boolean;
  className?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  const box = (
    <span className="relative mt-[2px] inline-grid size-3.5 shrink-0 place-items-center">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : typeof description === 'string' ? description : undefined}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 m-0 cursor-default appearance-none rounded-[2px] border border-edge bg-sunk checked:border-fg checked:bg-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:border-rule"
      />
      <svg viewBox="0 0 12 12" className="pointer-events-none relative size-2.5 text-bg opacity-0 peer-checked:opacity-100" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {indeterminate ? <path d="M3 6h6" /> : <path d="M2.5 6.2l2.3 2.3 4.7-5" />}
      </svg>
    </span>
  );
  if (!label && !description) return <span className={className}>{box}</span>;
  return (
    <label htmlFor={id} className={cn('flex items-start gap-2.5 py-1', disabled ? 'text-fg-3' : 'text-fg', className)}>
      {box}
      <span className="min-w-0">
        {label && <span className={cn('block text-[13px] leading-[1.35]', mono && 'font-mono text-[12.5px]')}>{label}</span>}
        {description && <span className="mt-0.5 block text-[12px] leading-[1.4] text-fg-3">{description}</span>}
      </span>
    </label>
  );
}

export function Radio({
  checked,
  onChange,
  name,
  label,
  description,
  disabled,
  className,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  name: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Extra controls shown under the label when this option is chosen. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn('py-1', className)}>
      <label htmlFor={id} className={cn('flex items-start gap-2.5', disabled ? 'text-fg-3' : 'text-fg')}>
        <span className="relative mt-[2px] inline-grid size-3.5 shrink-0 place-items-center">
          <input
            id={id}
            type="radio"
            name={name}
            checked={checked}
            disabled={disabled}
            onChange={() => onChange()}
            className="peer absolute inset-0 m-0 appearance-none rounded-full border border-edge bg-sunk checked:border-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          />
          <span className="pointer-events-none relative size-1.5 rounded-full bg-fg opacity-0 peer-checked:opacity-100" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] leading-[1.35] font-medium">{label}</span>
          {description && <span className="mt-0.5 block text-[12px] leading-[1.4] text-fg-3">{description}</span>}
        </span>
      </label>
      {checked && children && <div className="mt-3 pl-6">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control and On / Off (booleans live in detail views, spec 10.11)
// ---------------------------------------------------------------------------

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

/**
 * Text segments in a rule-2 outline. The current segment is bg-raise with fg,
 * the others fg-3. Neutral ink, never accent. Arrow keys move the choice.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  label,
  disabled,
  full,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  /** sm 26px, md 30px. xs is a legacy alias of sm. */
  size?: 'xs' | 'sm' | 'md' | 'touch';
  className?: string;
  /** aria-label for the group */
  label?: string;
  disabled?: boolean;
  /** Stretch segments to fill the width. */
  full?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const idx = options.findIndex((o) => o.value === value);
  const move = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    let n = i;
    for (let k = 0; k < options.length; k++) {
      n = (n + dir + options.length) % options.length;
      if (!options[n].disabled) break;
    }
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  const h = size === 'touch' ? 'h-11 text-[15px]' : size === 'md' ? 'h-[30px] text-[13px]' : 'h-[26px] text-[12.5px]';
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn('inline-flex shrink-0 items-stretch gap-[2px] rounded-[var(--r-1)] border border-rule-2 p-[2px]', h, full && 'flex w-full', className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            tabIndex={on || (idx < 0 && i === 0) ? 0 : -1}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            className={cn(
              'inline-flex items-center justify-center rounded-[2px] px-2.5 leading-none font-medium whitespace-nowrap transition-[color,background-color] duration-[var(--dur-1)]',
              // phones: a 44px tall place to tap, over the rim of the control
              'phone:relative phone:after:absolute phone:after:top-1/2 phone:after:left-1/2 phone:after:h-11 phone:after:w-full phone:after:min-w-11 phone:after:-translate-x-1/2 phone:after:-translate-y-1/2',
              full && 'flex-1',
              on ? 'bg-raise text-fg shadow-[0_0_0_1px_var(--rule-2)]' : 'text-fg-3 hov:text-fg',
              // the one word in fg-4: the segments that can be picked are fg-3 already, and a disabled one must read as different
              (disabled || o.disabled) && 'text-fg-4',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A boolean as a neutral "On / Off" segmented control (spec 10.11). */
export function OnOff({
  checked,
  onChange,
  label,
  disabled,
  size = 'sm',
  onLabel = 'On',
  offLabel = 'Off',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** aria-label: what this turns on */
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'touch';
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <Segmented
      label={label}
      disabled={disabled}
      size={size}
      value={checked ? 'on' : 'off'}
      onChange={(v) => onChange(v === 'on')}
      options={[
        { value: 'on', label: onLabel },
        { value: 'off', label: offLabel },
      ]}
    />
  );
}
