/**
 * Watch cards in the chat (WatchReport, WatchCreate): the items a browser
 * search found, as tiles with a photo, the price, the title, the place and
 * a link to the listing, then "Watch this daily", which answers the
 * assistant's offer in the chat. A watch made from the chat shows as one
 * card with a link to its page on Routines. On a phone the turn's tool
 * calls fold into one line and these cards sit under it.
 */
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { WatchCardData, WatchItemsCard } from '@conclave/core/client';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { describeSchedule } from '@/lib/schedule';
import { Button, ButtonLink } from '@/components/ui/Button';
import { sendTo } from '@/features/conversation/actions';
import { Photo } from './Photo';
import { factsWords, priceWords, watchCardOf } from './words';

const BOX = 'rounded-[var(--r-2)] border border-rule-2 bg-raise';
/** Tiles shown before "Show all". */
const FIRST = 6;
export const WATCH_DAILY = 'Watch this daily.';

export function WatchCard({ card, sessionId, className }: { card: WatchCardData; sessionId: string; className?: string }) {
  if (card.kind === 'created') return <Created card={card} className={className} />;
  return <Items card={card} sessionId={sessionId} className={className} />;
}

/** The cards of a turn's watch calls, in order: what sits under a phone's folded tool line. */
export function WatchCards({ results, sessionId, className }: { results: Array<ToolResultBlock | undefined>; sessionId: string; className?: string }) {
  const cards = results.map((r) => watchCardOf(r)).filter((c): c is WatchCardData => !!c);
  if (!cards.length) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {cards.map((c, i) => (
        <WatchCard key={i} card={c} sessionId={sessionId} />
      ))}
    </div>
  );
}

/** A watch call on the Chat page: one quiet line, and its card unless a phone shows the cards under the fold. */
export function WatchLine({ tool, result, sessionId, card = true }: { tool: ToolUseBlock; result?: ToolResultBlock; sessionId: string; card?: boolean }) {
  const mobile = useIsMobile();
  const c = watchCardOf(result);
  if (result?.isError)
    return (
      <div className="py-0.5">
        <div className="flex min-h-[25px] items-center text-[12.5px] text-fault phone:text-[13.5px]">{tool.name === 'WatchCreate' ? 'Could not make the watch' : 'Could not show the items'}</div>
        <p className="mb-1 max-w-[72ch] text-[13px] leading-[1.5] text-fg-2">{typeof result.content === 'string' ? result.content : ''}</p>
      </div>
    );
  return (
    <div className="py-0.5">
      <div className="flex min-h-[25px] items-center text-[12.5px] text-fg-3 phone:text-[13.5px]">{watchLineWords(tool, c)}</div>
      {card && !mobile && c && <WatchCard card={c} sessionId={sessionId} className="mt-1 mb-1.5" />}
    </div>
  );
}

/** "Found 12 items", "Made a watch". */
export function watchLineWords(tool: Pick<ToolUseBlock, 'name' | 'input'>, c?: WatchCardData): string {
  if (tool.name === 'WatchCreate') return c?.kind === 'created' ? `Made a watch: ${c.name}` : 'Making a watch';
  const n = c?.kind === 'items' ? c.items.length : Array.isArray(tool.input?.items) ? tool.input.items.length : 0;
  return `Found ${n} ${n === 1 ? 'item' : 'items'}`;
}

function Items({ card, sessionId, className }: { card: WatchItemsCard; sessionId: string; className?: string }) {
  const [all, setAll] = useState(false);
  const session = useHub((s) => s.sessions[sessionId]);
  // the offer stands until a watch is made in this chat
  const made = useHub((s) => (s.messages[sessionId] ?? []).some((m) => m.content.some((b) => b.type === 'tool_result' && watchCardOf(b)?.kind === 'created')));
  const [sent, setSent] = useState(false);
  const shown = all ? card.items : card.items.slice(0, FIRST);
  const busy = !session || session.status === 'running' || session.status === 'waiting_approval' || session.status === 'waiting_input';
  return (
    <div className={cn(BOX, 'max-w-[640px] p-3 phone:p-3', className)} data-watch-card="items">
      <ul className="m-0 grid list-none grid-cols-3 gap-3 p-0 max-sm:grid-cols-2" aria-label="Items found">
        {shown.map((i) => (
          <li key={i.id} className="min-w-0">
            <a href={i.url} target="_blank" rel="noreferrer noopener" className="group block rounded-[var(--r-1)] outline-offset-2" aria-label={`${i.title}, ${priceWords(i.price, i.priceText, card.currency)}`}>
              <Photo source={i.image ? (card.routineId ? { routineId: card.routineId, itemId: i.id } : { sessionId, itemId: i.id }) : undefined} alt={i.title} className="rounded-[var(--r-1)]" dim={i.status === 'sold' || i.status === 'gone'} />
              <span className="mt-1.5 block t-row font-[540] text-fg">{priceWords(i.price, i.priceText, card.currency)}</span>
              <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-[1.35] text-fg-2 group-hover:text-fg phone:text-[13.5px]">{i.title}</span>
              {factsWords(i) && <span className="mt-0.5 block truncate text-[12px] text-fg-3 phone:text-[13px]">{factsWords(i)}</span>}
            </a>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {card.offer && !made && (
          <Button
            variant="solid"
            size="sm"
            disabled={busy || sent}
            onClick={() => {
              if (!session) return;
              setSent(true);
              void sendTo(session, { text: WATCH_DAILY, attachments: [] }).then((ok) => !ok && setSent(false));
            }}
          >
            Watch this daily
          </Button>
        )}
        {card.items.length > FIRST && (
          <Button variant="quiet" size="sm" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${card.items.length}`}
          </Button>
        )}
        {card.source && (
          <a href={card.source} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg phone:text-[13px]">
            Open the search <ExternalLink className="size-3" strokeWidth={1.75} />
          </a>
        )}
      </div>
    </div>
  );
}

function Created({ card, className }: { card: Extract<WatchCardData, { kind: 'created' }>; className?: string }) {
  return (
    <div className={cn(BOX, 'max-w-[560px] px-3.5 py-3 phone:px-4', className)} data-watch-card="created">
      <div className="t-row text-fg">{card.name}</div>
      <div className="mt-0.5 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
        Watching {describeSchedule(card.schedule).toLowerCase()}
        {card.count ? `, starting from ${card.count} ${card.count === 1 ? 'item' : 'items'}` : ''}. You hear from it only when something changes.
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <ButtonLink href={`/routines/${card.routineId}`} size="sm" variant="outline">
          Open the watch
        </ButtonLink>
      </div>
    </div>
  );
}
