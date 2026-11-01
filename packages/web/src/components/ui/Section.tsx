/**
 * Rules, not boxes (spec 1, 10.3, 10.20, 10.21). A section is a heading on a
 * rule-2 line with rows under it; asides are key and value rows; quotes and
 * notices are lines of text with no box and no icon.
 */
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { cn } from '@/lib/text';
import { Roll } from '../motion/Roll';

export interface SectionAction {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
}

/**
 * h2 in 13/600 fg, the count in fg-3 tabular 8px after, an optional text
 * action at the right (12px fg-3, hover fg). 9px under it, a rule-2 line.
 * tone="warn" colors the words only (the chat list's "Waiting on you").
 */
export function SectionHeading({
  children,
  count,
  countTone,
  action,
  right,
  tone,
  as: Tag = 'h2',
  rule = true,
  className,
  id,
}: {
  children: ReactNode;
  count?: number | string;
  /** "warn" when the count needs the owner (Inbox) */
  countTone?: 'warn';
  action?: SectionAction;
  /** Anything else at the right end (a segmented control, a link). */
  right?: ReactNode;
  tone?: 'warn';
  as?: 'h2' | 'h3';
  /** Draw the rule-2 line under the heading. Default true. */
  rule?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn('flex items-baseline gap-2 pb-[9px]', rule && 'border-b border-rule-2', className)}>
      <Tag id={id} className={cn('t-section', tone === 'warn' ? 'text-warn' : 'text-fg')}>
        {children}
      </Tag>
      {count !== undefined && count !== null && count !== '' && (
        // counts roll, in the direction of change (Roll)
        <span className={cn('num text-[13px] font-[450] phone:text-[14px]', countTone === 'warn' ? 'text-warn' : 'text-fg-3')}>{typeof count === 'number' ? <Roll value={count} /> : count}</span>
      )}
      {(action || right) && (
        <span className="ml-auto flex items-baseline gap-4">
          {right}
          {action && <TextAction {...action} />}
        </span>
      )}
    </div>
  );
}

/** A quiet text link or button (12px fg-3, hover fg). Section actions, row actions. */
export function TextAction({ label, href, onClick, className }: SectionAction & { className?: string }) {
  const cls = cn('tap text-[12px] font-[450] text-fg-3 transition-colors duration-[var(--dur-1)] hover:text-fg phone:text-[13px]', className);
  if (href)
    return (
      <Link href={href} className={cls}>
        {label}
      </Link>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {label}
    </button>
  );
}

/**
 * A section in a column: heading then rows split by rules. Sections in a
 * column sit 28px apart (32 on phones); use `className="mt-7"` or a parent
 * with `space-y-7`.
 */
export function Section({
  title,
  count,
  countTone,
  action,
  right,
  tone,
  children,
  className,
  rows = true,
  id,
}: {
  title: ReactNode;
  count?: number | string;
  countTone?: 'warn';
  action?: SectionAction;
  right?: ReactNode;
  tone?: 'warn';
  children: ReactNode;
  className?: string;
  /** Split direct children with rule lines. Default true. */
  rows?: boolean;
  id?: string;
}) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section className={className} aria-labelledby={hid} id={id}>
      <SectionHeading id={hid} count={count} countTone={countTone} action={action} right={right} tone={tone}>
        {title}
      </SectionHeading>
      <div className={cn(rows && 'rows')}>{children}</div>
    </section>
  );
}

/** Key and value rows (spec 10.21): key in meta fg-3 (96px column), value in body fg. */
export function Aside({ title, count, action, children, className }: { title?: ReactNode; count?: number | string; action?: SectionAction; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      {title && (
        <SectionHeading count={count} action={action} className="mb-1.5">
          {title}
        </SectionHeading>
      )}
      <dl className="m-0">{children}</dl>
    </section>
  );
}

export function KV({ k, children, mono, className, keyWidth = 96 }: { k: ReactNode; children: ReactNode; mono?: boolean; className?: string; keyWidth?: number }) {
  return (
    <div className={cn('grid items-baseline gap-3 py-1.5', className)} style={{ gridTemplateColumns: `${keyWidth}px minmax(0,1fr)` }}>
      <dt className="text-[12px] text-fg-3 phone:text-[13px]">{k}</dt>
      <dd className={cn('m-0 min-w-0 text-[14px] text-fg phone:text-[15px]', mono && 'font-mono text-[13px] break-all')}>{children}</dd>
    </div>
  );
}

/** A quote (a dissent, a memory fact): fg-2, a 1px rule-2 left rule, 12px padding. Neutral. */
export function Quote({ children, className, cite }: { children: ReactNode; className?: string; cite?: ReactNode }) {
  return (
    <figure className={cn('m-0 border-l border-rule-2 pl-3', className)}>
      <blockquote className="m-0 text-fg-2">{children}</blockquote>
      {cite && <figcaption className="mt-1 text-[12px] text-fg-3">{cite}</figcaption>}
    </figure>
  );
}

/**
 * A system event line (spec 10.20): meta fg-3, an optional mono timestamp in
 * the gutter, an optional text action. tone="fault" colors the first word
 * ("Failed."); tone="warn" colors the whole first sentence.
 */
export function Notice({ children, time, action, tone, className }: { children: ReactNode; time?: string; action?: SectionAction; tone?: 'fault' | 'warn'; className?: string }) {
  let body = children;
  if (tone === 'fault' && typeof children === 'string') {
    const m = children.match(/^(\S+)(\s[\s\S]*)?$/);
    if (m)
      body = (
        <>
          <span className="text-fault">{m[1]}</span>
          {m[2]}
        </>
      );
  }
  return (
    <div className={cn('flex items-baseline gap-3 py-1.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]', className)}>
      {time !== undefined && <span className="w-12 shrink-0 font-mono text-[11px] font-[450] text-fg-3">{time}</span>}
      <span className={cn('min-w-0', tone === 'warn' && 'text-warn')}>{body}</span>
      {action && <TextAction {...action} className="shrink-0" />}
    </div>
  );
}
