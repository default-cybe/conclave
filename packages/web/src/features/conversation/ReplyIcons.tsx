/**
 * The action row at the end of a finished reply on a phone, as Claude's
 * apps have it (docs/design/CHAT-AND-MOTION.md 2.6): Copy, Retry, then
 * `extra`, then "..." with the rest (Ask another model, Branch or Fork,
 * Rewind, Continue as a session, Send to friend). Always in view, under
 * every reply: fg-3 under the last one, quieter (fg-4) under earlier ones,
 * so a long chat does not read as a wall of icons. A long press on the
 * reply selects its text; nothing else listens to it.
 *
 * `extra` is the place for one more action, shown only when it applies: a
 * refused reply's "Try the next model" goes there, after Retry.
 *
 * Used by the Chat page (Reply.tsx) and a session on a phone
 * (features/chat/PhoneTranscript.tsx).
 */
import { forwardRef, type ReactNode } from 'react';
import { Check, Copy, MoreHorizontal, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/text';
import { useCopy } from '@/lib/hooks';
import { Swap } from '@/components/motion';

/** An icon of the row: a 44px place to tap, the glyph 18px. */
export function iconClass(quiet?: boolean): string {
  return cn('grid size-11 place-items-center rounded-full transition-colors duration-[var(--dur-1)] active:bg-hover active:text-fg', quiet ? 'text-fg-4' : 'text-fg-3');
}

export interface ReplyIconsProps {
  /** What Copy copies; nothing to copy (a reply stopped before it wrote) leaves Copy out. */
  text: string;
  /** Retry, when there is a message to send again. */
  onRetry?: () => void;
  /** Unset: no More menu (another person's reply in a shared chat). */
  onMore?: () => void;
  moreOpen: boolean;
  /** An earlier reply: the same row in fg-4. */
  quiet?: boolean;
  /** One more action after Retry, when it applies ("Try the next model" on a refused reply). */
  extra?: ReactNode;
  /** The More button's name for screen readers. */
  moreLabel?: string;
  className?: string;
}

/** Copy, Retry, `extra` and More. The ref is the More button, for the menu to open from. */
export const ReplyIcons = forwardRef<HTMLButtonElement, ReplyIconsProps>(function ReplyIcons({ text, onRetry, onMore, moreOpen, quiet, extra, moreLabel = 'More actions', className }, ref) {
  const [copied, copy] = useCopy();
  const icon = iconClass(quiet);
  return (
    <span data-reply-actions="" className={cn('-ml-3 flex items-center', className)}>
      {text.trim() && (
        <button type="button" aria-label={copied ? 'Copied' : 'Copy'} onClick={() => copy(text)} className={icon}>
          <Swap on={copied} off={<Copy className="size-[18px]" strokeWidth={1.75} aria-hidden />}>
            <Check className="size-[18px] text-ok" strokeWidth={1.75} aria-hidden />
          </Swap>
        </button>
      )}
      {onRetry && (
        <button type="button" aria-label="Retry" onClick={onRetry} className={icon}>
          <RotateCcw className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
      )}
      {extra}
      {onMore && (
        <button ref={ref} type="button" aria-label={moreLabel} aria-haspopup="menu" aria-expanded={moreOpen} onClick={onMore} className={icon}>
          <MoreHorizontal className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </span>
  );
});
