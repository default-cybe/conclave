/**
 * Messages you sent while the session works, before their turn takes them
 * (docs/design/CHAT-AND-MOTION.md 2.11). Each is your bubble as it will be
 * in the transcript, at the same place, with a quiet "Queued" (or "Sending
 * to the running turn") and an x before it that takes it off. They sit
 * after the turn that runs, in the order they will run. When the hub stores
 * one, the message takes the bubble's place in the same frame: the same
 * bubble at the same spot, no rise. Its label stays where it was ("Queued",
 * or "Steered the running turn" for one that joined the running turn) and
 * the x goes (Copy and Edit wait there on hover), so nothing moves.
 */
import { useRef } from 'react';
import { X } from 'lucide-react';
import type { QueuedMessage, Session } from '@conclave/core/types';
import type { Attachment } from '@conclave/core/client';
import { pendingPreview, removeQueued } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { BUBBLE, BubbleText } from '@/components/ui/Bubble';
import { ActionText, LogRow } from './Log';
import { Markdown } from './Markdown';

/** The label a waiting message wears. */
export function pendingWord(item: Pick<QueuedMessage, 'whenBusy'>): string {
  return item.whenBusy === 'steer' ? 'Sending to the running turn' : 'Queued';
}

/** The label a stored message keeps when it was sent while the session worked (meta.whenBusy). */
export function storedWord(whenBusy: unknown): string | undefined {
  return whenBusy === 'steer' ? 'Steered the running turn' : whenBusy === 'queue' ? 'Queued' : undefined;
}

/** Ids on screen when the list first drew: those do not rise in, the ones that come after do. */
function useFirstSeen(items: QueuedMessage[]): (id: string) => boolean {
  const seen = useRef<Set<string> | null>(null);
  if (!seen.current) seen.current = new Set(items.map((q) => q.id));
  return (id) => !seen.current!.has(id);
}

/**
 * What was attached, as the stored message will show it: this app's
 * pictures when it sent them, and on desktop the names of the rest (a phone's
 * bubble shows pictures only).
 */
function Attached({ item, phone }: { item: QueuedMessage; phone?: boolean }) {
  const local: Attachment[] = pendingPreview(item.id) ?? [];
  const images = local.filter((a) => a.mediaType.startsWith('image/') && a.data);
  const files = phone ? [] : (item.attachments ?? []).filter((a) => !(a.mediaType.startsWith('image/') && images.length));
  if (!images.length && !files.length) return null;
  return (
    <div className={cn('flex flex-wrap justify-end gap-2', !phone && 'mb-1.5')}>
      {images.map((img, i) => (
        <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt="Attached image" className={cn('max-h-40 max-w-[240px] object-cover', phone ? 'rounded-[14px]' : 'rounded-[var(--r-2)] border border-rule')} />
      ))}
      {files.map((f, i) => (
        <span key={i} className={cn('flex h-10 items-center border border-rule px-3 text-fg-2', phone ? 'rounded-[14px] text-[14px]' : 'rounded-[var(--r-2)] text-[13px]')}>
          {f.name ?? (f.mediaType.startsWith('image/') ? 'Attached image' : 'Attached document')}
        </span>
      ))}
    </div>
  );
}

/** One waiting message on desktop: the shape of UserMessage (Turn.tsx), with the label and the x where Copy and Edit will be. */
function PendingMessage({ item, session, enter }: { item: QueuedMessage; session: Session; enter: boolean }) {
  return (
    <LogRow time={hhmm(item.at)} className={cn(enter && 'anim-rise')}>
      <div data-author="you" data-pending={item.whenBusy} className="flex flex-col items-end">
        <Attached item={item} />
        <div className="flex w-full items-end justify-end gap-2">
          <div className="flex shrink-0 items-center pb-1">
            <ActionText aria-label="Remove" title="Remove" onClick={() => void removeQueued(session.id, item.id)} className="flex items-center px-1">
              <X aria-hidden strokeWidth={1.75} className="size-3.5" />
            </ActionText>
            <span className="ml-1 text-[12px] text-fg-3">{pendingWord(item)}</span>
          </div>
          {item.text && (
            <div className={cn(BUBBLE, 'min-w-0 max-w-[min(85%,520px)]')}>
              <BubbleText text={item.text}>
                <Markdown text={item.text} />
              </BubbleText>
            </div>
          )}
        </div>
      </div>
    </LogRow>
  );
}

/** Desktop: the waiting messages (useQueue) after the turn that runs, each a piece of the log (MessageList). */
export function PendingMessages({ session, items }: { session: Session; items: QueuedMessage[] }) {
  const fresh = useFirstSeen(items);
  return items.map((item) => (
    <div key={item.id} data-unit={`pending:${item.id}`} className="log-unit">
      <PendingMessage item={item} session={session} enter={fresh(item.id)} />
    </div>
  ));
}

/** Phones: the shape of PhoneTranscript's Bubble, the x and the label on the quiet line under it. */
export function PhonePending({ session, items }: { session: Session; items: QueuedMessage[] }) {
  const fresh = useFirstSeen(items);
  return items.map((item) => (
    <div key={item.id} data-pending={item.whenBusy} className={cn('flex flex-col items-end gap-1.5', fresh(item.id) && 'anim-rise')}>
      <Attached item={item} phone />
      {item.text && (
        <div className="max-w-[85%] rounded-[20px] bg-surface-2 px-4 py-2.5 text-fg">
          <BubbleText text={item.text}>
            <Markdown text={item.text} />
          </BubbleText>
        </div>
      )}
      <span className="flex items-center gap-2 px-1 text-[13px] text-fg-3">
        <button type="button" aria-label="Remove" onClick={() => void removeQueued(session.id, item.id)} className="tap grid size-4 place-items-center rounded-full text-fg-3 active:text-fg">
          <X aria-hidden strokeWidth={2} className="size-3.5" />
        </button>
        {pendingWord(item)}
      </span>
    </div>
  ));
}
