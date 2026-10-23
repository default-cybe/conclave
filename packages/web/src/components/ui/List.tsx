import type { KeyboardEvent, ReactNode } from 'react';
import { Link } from 'wouter';
import { cn } from '@/lib/text';

export type StateTone = 'neutral' | 'dim' | 'warn' | 'fault' | 'ok' | 'signal';

export const STATE_TEXT: Record<StateTone, string> = {
  neutral: 'text-fg-2',
  dim: 'text-fg-3',
  warn: 'text-warn',
  fault: 'text-fault',
  ok: 'text-ok',
  signal: 'text-signal',
};

/**
 * A state as a word in a fixed place (spec 1.2): running, done, failed,
 * waiting, online, offline. No badges, pills or dots.
 */
export function StateWord({ children, tone = 'dim', live, className }: { children: ReactNode; tone?: StateTone; live?: boolean; className?: string }) {
  return (
    <span aria-live={live ? 'polite' : undefined} className={cn('state-word whitespace-nowrap', STATE_TEXT[tone], className)}>
      {children}
    </span>
  );
}

/**
 * The selected row in a list that drives a detail pane, or the current page
 * in a side nav: a 2px ink bar at the row's left edge, over its raise fill.
 * One component, so every list marks it the same way. The row is `relative`.
 */
export function SelectedMark() {
  return <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-fg" />;
}

/**
 * The two line list row (spec 10.2). Title in row-title fg, meta line in
 * meta fg-3 (comma separated words, a mono logo before a model). The right
 * column has the time on line 1 and the state word on line 2.
 * Selected: bg-raise and a 2px fg bar on the left edge (the only edge bar).
 */
export function ListRow({
  title,
  meta,
  time,
  state,
  stateTone = 'dim',
  right,
  selected,
  href,
  onClick,
  onKeyDown,
  className,
  children,
  inset = true,
  titleClassName,
  ...rest
}: {
  title: ReactNode;
  meta?: ReactNode;
  /** Line 1 of the right column (meta, tabular) */
  time?: ReactNode;
  /** Line 2 of the right column: a state word or a live elapsed */
  state?: ReactNode;
  stateTone?: StateTone;
  /** Replace the whole right column. */
  right?: ReactNode;
  selected?: boolean;
  href?: string;
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  className?: string;
  /** Extra content under the meta line (a snippet, options). */
  children?: ReactNode;
  /** Horizontal padding 12px. Set false for rows aligned with a column edge. */
  inset?: boolean;
  titleClassName?: string;
  'aria-current'?: 'page' | 'true' | boolean;
  id?: string;
}) {
  const body = (
    <>
      {selected && <SelectedMark />}
      <span className="min-w-0 flex-1">
        <span className={cn('t-row block truncate text-fg', titleClassName)}>{title}</span>
        {meta && <span className="mt-0.5 flex min-w-0 items-center truncate text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">{meta}</span>}
        {children}
      </span>
      {right ??
        ((time !== undefined || state !== undefined) && (
          <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4] phone:text-[13px]">
            {time !== undefined && <span className="num text-fg-3">{time}</span>}
            {state !== undefined && (typeof state === 'string' ? <StateWord tone={stateTone}>{state}</StateWord> : state)}
          </span>
        ))}
    </>
  );
  const cls = cn(
    'relative flex w-full items-start gap-3 text-left transition-colors duration-[var(--dur-1)]',
    inset ? 'px-3' : selected ? 'pr-0 pl-3' : 'px-0',
    'py-[var(--row-py)]',
    (href || onClick) && 'hover:bg-hover',
    selected && 'bg-raise hover:bg-raise',
    className,
  );
  if (href)
    return (
      <Link href={href} className={cls} aria-current={selected ? 'page' : undefined} onKeyDown={onKeyDown} {...rest}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} onKeyDown={onKeyDown} className={cls} aria-pressed={selected === undefined ? undefined : selected} {...rest}>
        {body}
      </button>
    );
  return (
    <div className={cls} {...rest}>
      {body}
    </div>
  );
}

/** A meta line: comma separated parts, empty parts skipped. Logos stay next to their words. */
export function MetaLine({ parts, className }: { parts: Array<ReactNode | false | null | undefined>; className?: string }) {
  const list = parts.filter((p) => p !== false && p !== null && p !== undefined && p !== '');
  return (
    <span className={cn('block min-w-0 max-w-full truncate', className)}>
      {list.map((p, i) => (
        <span key={i} className="whitespace-nowrap">
          {p}
          {i < list.length - 1 && <span>,&nbsp;</span>}
        </span>
      ))}
    </span>
  );
}
