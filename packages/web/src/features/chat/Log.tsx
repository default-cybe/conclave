/** Layout pieces of the transcript log: the time gutter row, author lines and quiet text actions. */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/text';
import { harnessId, harnessLabel, modelName } from '@/lib/models';
import { HarnessMark, ModelMark } from '@/components/logo';

/**
 * One line of the log: a 48px mono time gutter (micro, fg-3) and the content
 * column. Phones drop the gutter; the author line carries the time instead.
 */
export function LogRow({ time, children, className, id, gutter = true, hover }: { time?: string; children: ReactNode; className?: string; id?: string; gutter?: boolean; /** A hover group (lib/hover.ts): 'turn' for a row that is a whole turn. */ hover?: 'turn' }) {
  return (
    <div id={id} data-hover={hover} className={cn('grid grid-cols-[48px_minmax(0,1fr)] gap-x-2 phone:grid-cols-[minmax(0,1fr)]', className)}>
      <div aria-hidden={!time} className="num pt-px font-mono text-[11px] leading-[22px] font-[450] text-fg-3 phone:hidden">
        {gutter ? time : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The author line of a turn: who spoke on the left (12.5/600 fg-2, times the Text size), quiet
 * actions at the right that show on hover and focus (always on touch). The
 * time is in the log's gutter; a phone shows no times in the transcript
 * (docs/design/MOBILE-V2.md 5).
 */
export function AuthorLine({ children, actions, className }: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('group/author flex min-h-[22px] items-center gap-3', className)}>
      <div className="flex min-w-0 flex-1 items-center tx-12.5 leading-[22px] font-semibold text-fg-2 phone:tx-13.5">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

/** A quiet text action (12px fg-3, hover fg). Used for turn actions and notice actions. */
export const ActionText = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }>(function ActionText({ className, active, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'h-[22px] rounded-[var(--r-1)] px-1.5 text-[12px] font-[450] whitespace-nowrap transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg phone:h-9 phone:px-2.5 phone:text-[13px]',
        active ? 'bg-hover text-fg' : 'text-fg-3',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/**
 * Hover reveal for a turn's actions: hidden until the turn (the element with
 * data-hover="turn") is hovered or focused, always shown on touch. The hover
 * is marked by lib/hover.ts, not :hover on the turn (index.css .reveal-turn).
 */
export const REVEAL = 'reveal-turn opacity-0 transition-opacity duration-[var(--dur-1)] coarse:opacity-100';

/**
 * A meta line as one truncating line of inline parts joined by commas. Unlike
 * a flex row, parts never overlap when the line is too long; it ends in an
 * ellipsis instead.
 */
export function MetaText({ parts, className }: { parts: Array<ReactNode | false | null | undefined>; className?: string }) {
  const list = parts.filter((p) => p !== false && p !== null && p !== undefined && p !== '');
  return (
    <span className={cn('block min-w-0 truncate', className)}>
      {list.map((p, i) => (
        <span key={i}>
          {p}
          {i < list.length - 1 && ', '}
        </span>
      ))}
    </span>
  );
}

/**
 * A model or harness inside running text: the mono mark at 13px on the text
 * baseline, 5px before the name. For one line metas built with MetaText.
 */
export function InlineModel({ model, as = 'auto', className }: { model: string | undefined; as?: 'auto' | 'model'; className?: string }) {
  if (!model) return null;
  const harness = as === 'auto' && !!harnessId(model);
  return (
    <span title={model} className={className}>
      {harness ? <HarnessMark harness={model} size={13} className="mr-[5px]" /> : <ModelMark model={model} size={13} className="mr-[5px]" />}
      {harness ? harnessLabel(model) : modelName(model)}
    </span>
  );
}
