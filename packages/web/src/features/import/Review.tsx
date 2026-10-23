/**
 * To review (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.7, 1.14): what the
 * learning job found in one chat only, mostly preferences. Each shows the
 * quote it came from, the chat and the date; Accept puts it in memory,
 * Reject deletes it. A preference seen in a second chat skips this queue.
 */
import { useEffect, useState } from 'react';
import type { MemoryReviewItem } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/text';
import { removeKey, toast, upsertMemory } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Quote, SectionHeading, TextAction } from '@/components/ui/Section';
import { useDeviceNames } from './PastChats';
import { SOURCE_NAME } from './words';

const BASIS: Record<string, string> = { user_said: 'you said it', tool_verified: 'a tool result showed it', user_accepted: 'you accepted it' };

export function useReviewQueue(): { items: MemoryReviewItem[] | undefined; drop: (ids: string[]) => void } {
  const [items, setItems] = useState<MemoryReviewItem[]>();
  useEffect(() => {
    void api()
      .memoryReview()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  return { items, drop: (ids) => setItems((list) => list?.filter((x) => !ids.includes(x.memory.id))) };
}

export function ReviewQueue({ queue }: { queue: ReturnType<typeof useReviewQueue> }) {
  const { items, drop } = queue;
  const mobile = useIsMobile();
  const names = useDeviceNames();
  const [busy, setBusy] = useState<string>();
  if (!items) return null;

  const answer = async (accept: string[], reject: string[]) => {
    setBusy([...accept, ...reject].join(','));
    try {
      const r = await api().answerMemoryReview({ accept, reject });
      drop([...accept, ...reject]);
      for (const it of items.filter((x) => accept.includes(x.memory.id))) upsertMemory({ ...it.memory, meta: { ...it.memory.meta, review: 'accepted' } });
      for (const id of reject) removeKey('memories', id);
      toast({ title: [r.accepted ? `${r.accepted} accepted` : '', r.rejected ? `${r.rejected} rejected` : ''].filter(Boolean).join(', ') + '.', level: 'success' });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-labelledby="mem-review">
      <SectionHeading id="mem-review" count={items.length} right={items.length > 1 ? <TextAction label="Accept all" onClick={() => void answer(items.map((x) => x.memory.id), [])} /> : undefined}>
        To review
      </SectionHeading>
      <p className="mt-2.5 mb-1 max-w-[64ch] text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Learned from one past chat only. Agents do not see them until you accept. One that shows up in a second chat is accepted on its own.</p>
      <div className="rows">
        {items.map((it) => {
          const from = [it.source ? SOURCE_NAME[it.source as keyof typeof SOURCE_NAME] ?? it.source : '', it.device && !it.device.startsWith('upload:') ? (names[it.device] ?? it.device) : '', it.observedAt ? shortDate(it.observedAt) : ''].filter(Boolean).join(', ');
          const cite = [it.sessionTitle ? `From ${it.sessionTitle}` : 'From an imported chat', from].filter(Boolean).join(', ');
          const working = busy?.includes(it.memory.id);
          return (
            <article key={it.memory.id} className="py-3.5">
              <p className="m-0 text-[14px] leading-[1.55] text-fg phone:text-[15px]">{it.memory.content}</p>
              {it.evidence && (
                <Quote className="mt-2 text-[13px]" cite={cite}>
                  {it.evidence}
                </Quote>
              )}
              <div className={cn('mt-2.5 flex gap-x-3 gap-y-2', mobile ? 'flex-col items-stretch' : 'flex-wrap items-center')}>
                <Button variant="outline" size={mobile ? 'touch' : 'sm'} onClick={() => void answer([it.memory.id], [])} disabled={!!working} full={mobile}>
                  Accept
                </Button>
                <Button variant="quiet" size={mobile ? 'touch' : 'sm'} onClick={() => void answer([], [it.memory.id])} disabled={!!working} full={mobile}>
                  Reject
                </Button>
                <span className="text-[12px] text-fg-3 phone:text-[13px]">{[it.basis ? BASIS[it.basis] ?? it.basis : '', it.seenCount > 1 ? `seen in ${it.seenCount} chats` : 'seen in one chat'].filter(Boolean).join(', ')}</span>
              </div>
            </article>
          );
        })}
        {!items.length && <p className="py-4 text-[14px] text-fg-2">Nothing to review.</p>}
      </div>
    </section>
  );
}
