/**
 * The parts of a row in a session's log (ToolRows.tsx, CHAT-AND-MOTION
 * 6.2 and 6.3): the verb, target, result and chevron grid, a group's body,
 * the chevron and the running time. Shared by tool rows, the Workflow row
 * (features/workflows/WorkflowCard.tsx) and the subagent row.
 */
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/text';
import { Elapsed, Knot } from '@/components/motion';

/** A group's rows: indented under a rule, split by rules. */
export const GROUP_BODY = 'mb-2 ml-4 border-l border-rule pl-4 [&>*+*]:border-t [&>*+*]:border-rule';

/** A row: verb, target, result and chevron. The verb's column grows with the Text size (index.css .log-text). */
export const ROW =
  'grid w-full grid-cols-[calc(64px*var(--log-scale,1))_minmax(0,1fr)_auto_12px] items-baseline gap-x-3 py-[7px] text-left phone:grid-cols-[calc(52px*var(--log-scale,1))_minmax(0,1fr)_auto_12px] phone:py-2.5';
/** Clickable rows: the verb and chevron brighten on hover; no fill, the rules stay clean. */
export const ROW_BTN = cn(ROW, 'group/tr [&>span:first-child]:transition-colors hov:[&>span:first-child]:text-fg hov:[&>svg]:text-fg-2');

/** The verb column: fg-2 at 500, signal while the call runs. */
export function verbClass(running: boolean): string {
  return cn('state-word truncate tx-13.5 font-medium phone:tx-15', running ? 'text-signal' : 'text-fg-2');
}

/** The result column: fg-3, tabular, never wraps. */
export const RESULT = 'num text-right tx-12 whitespace-nowrap text-fg-3 phone:tx-13';

export function Chevron({ open, hidden }: { open: boolean; hidden?: boolean }) {
  if (hidden) return <span aria-hidden />;
  return <ChevronRight aria-hidden strokeWidth={1.75} className={cn('size-3 self-center text-fg-4 transition-transform duration-[var(--dur-1)]', open && 'rotate-90')} />;
}

/** A running call's result column: the still Knot (a row never animates one, spec 1.9) and the time, in signal. */
export function RunningTime({ since }: { since: number | undefined }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-signal">
      <Knot state="tool" size={12} still />
      <Elapsed since={since} format="short" />
    </span>
  );
}
