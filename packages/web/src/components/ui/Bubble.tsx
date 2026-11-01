/**
 * Your message as a bubble: the one look for Chat, Assistant and Code
 * (docs/design/CHAT-AND-MOTION.md 2.6 and 6.4). On desktop r-2 and a quiet
 * fill: in dark bg-raise with a hairline (rule), in light surface-2 with no
 * line (white on the near white ground hardly showed); on phones surface-2,
 * radius 20 and no border (docs/design/MOBILE-V2.md 5). The words are at
 * the reading size: plain text with its line breaks on the Chat page, your
 * markdown in a session. A very long message (a paste) shows its first
 * lines and "Show all N lines".
 */
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/text';

export const BUBBLE = 'rounded-[var(--r-2)] border border-rule bg-raise px-3.5 py-[9px] text-fg light:border-transparent light:bg-surface-2 phone:rounded-[20px] phone:border-0 phone:bg-surface-2 phone:px-4 phone:py-2.5';

/** Lines a long message shows until you ask for all of it. */
export const BUBBLE_LINES = 14;

/** A message is long past this many lines, or this many characters (about 20 lines of a bubble). */
export function isLongText(text: string): boolean {
  return text.split('\n').length > BUBBLE_LINES + 4 || text.length > 1600;
}

/**
 * The words in a bubble: plain text with its line breaks, or what you pass
 * as children (a session renders your markdown). A long one is cut to
 * BUBBLE_LINES lines with a quiet "Show all" under it.
 */
export function BubbleText({ text, className, children }: { text: string; className?: string; children?: ReactNode }) {
  const [all, setAll] = useState(false);
  const long = isLongText(text);
  const lines = text.split('\n').length;
  return (
    <>
      <div className={cn('t-chat break-words', !children && 'whitespace-pre-wrap', long && !all && 'max-h-[calc(var(--read-leading)*14em)] overflow-hidden', className)}>{children ?? text}</div>
      {long && (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="tap mt-1 text-[12.5px] text-fg-3 transition-colors duration-[var(--dur-1)] hov:text-fg phone:text-[13.5px]">
          {all ? 'Show less' : lines > BUBBLE_LINES ? `Show all ${lines} lines` : 'Show all'}
        </button>
      )}
    </>
  );
}
