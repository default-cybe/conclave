import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import { cn } from '@/lib/text';
import { Roll } from '../motion/Roll';

/**
 * Tags are words (spec 10.6): fg-3, comma separated, in the meta line or a
 * right column. No chips, no hash signs, no colors.
 */
export function Tags({ tags, className, max }: { tags: string[] | undefined; className?: string; max?: number }) {
  if (!tags?.length) return null;
  const shown = max ? tags.slice(0, max) : tags;
  const more = max && tags.length > max ? tags.length - max : 0;
  return (
    <span className={cn('text-fg-3', className)}>
      {shown.join(', ')}
      {more ? `, ${more} more` : ''}
    </span>
  );
}

export interface LinkOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A count after the label, tabular fg-3. */
  count?: number;
  /** Route for Tabs used as navigation. */
  href?: string;
}

const LINK = 'tap whitespace-nowrap text-[13px] font-medium transition-colors duration-[var(--dur-1)] phone:text-[14px]';

/** The label carries the underline; the count after it does not. */
function LinkLabel({ on, label, count }: { on: boolean; label: ReactNode; count?: number }) {
  return (
    <>
      <span className={on ? 'underline decoration-1 underline-offset-[3px]' : undefined}>{label}</span>
      {count !== undefined && <Roll value={count} className="ml-1.5 font-[450] text-fg-3" />}
    </>
  );
}

/**
 * Filter links above a list ("All  homelab  uni  ctf"). The current one is fg
 * with a 1px underline at 3px offset; the others fg-3.
 */
export function FilterLinks<T extends string>({ value, onChange, options, className, label }: { value: T; onChange: (v: T) => void; options: LinkOption<T>[]; className?: string; label?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap items-baseline gap-x-4 gap-y-1', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} onClick={() => onChange(o.value)} className={cn(LINK, on ? 'text-fg' : 'text-fg-3 hover:text-fg')}>
            <LinkLabel on={on} label={o.label} count={o.count} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tabs as text links under a page title ("Settings  Runs"). With href on the
 * options they are links (aria-current); otherwise a tablist with arrow keys.
 */
export function Tabs<T extends string>({ value, onChange, options, className, label }: { value: T; onChange?: (v: T) => void; options: LinkOption<T>[]; className?: string; label?: string }) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const nav = options.every((o) => o.href);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange?.(options[n].value);
    refs.current[n]?.focus();
  };
  if (nav)
    return (
      <nav aria-label={label} className={cn('flex items-baseline gap-x-5', className)}>
        {options.map((o) => (
          <Link key={o.value} href={o.href!} aria-current={o.value === value ? 'page' : undefined} className={cn(LINK, o.value === value ? 'text-fg' : 'text-fg-3 hover:text-fg')}>
            <LinkLabel on={o.value === value} label={o.label} count={o.count} />
          </Link>
        ))}
      </nav>
    );
  return (
    <div role="tablist" aria-label={label} className={cn('flex items-baseline gap-x-5', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange?.(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(LINK, on ? 'text-fg' : 'text-fg-3 hover:text-fg')}
          >
            <LinkLabel on={on} label={o.label} count={o.count} />
          </button>
        );
      })}
    </div>
  );
}
