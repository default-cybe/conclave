/**
 * Side by side (/sessions/split): two to four sessions as columns, each the
 * session's own transcript with its approvals, state and composer
 * (ChatView in its column form). The sessions come from the account's saved
 * view (split.ts); every column reads the one store the live socket fills,
 * so watching four costs what watching one does.
 *
 * Phones: no columns. The picked sessions are rows that open each one.
 */
import { useRef, useState } from 'react';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { relTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { MenuList, Popover } from '@/components/ui/Overlay';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListRow } from '@/components/ui/List';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { ChatView } from './ChatView';
import { addToSplit, removeFromSplit, saveSplit, SPLIT_MAX, useSplitIds } from './split';
import { isChat } from './util';

/** The picker lists this many recent sessions. */
const PICK_RECENT = 30;

export function SplitPage() {
  const ids = useSplitIds();
  const sessions = useHub((s) => s.sessions);
  const phone = useIsMobile();
  usePageHeader('Side by side');

  if (phone)
    return (
      <Page width="column">
        <PageHeader title="Side by side" />
        {ids.length ? (
          <>
            <p className="mb-3 text-[13px] text-fg-3">The sessions you watch side by side on a computer.</p>
            <div className="-mx-3">
              {ids.map((id) => (
                <ListRow key={id} href={`/s/${id}`} title={sessions[id].title} meta={sessions[id].agent} time={relTime(sessions[id].updatedAt)} />
              ))}
            </div>
          </>
        ) : (
          <EmptyState>On a computer, pick sessions to watch side by side. They show here too.</EmptyState>
        )}
      </Page>
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-rule px-4">
        <h1 className="t-title min-w-0 flex-1 truncate text-fg">Side by side</h1>
        <span className="num text-[12px] text-fg-3">
          {ids.length} of {SPLIT_MAX}
        </span>
        <AddSession ids={ids} />
      </header>
      {ids.length ? (
        <div className="flex min-h-0 flex-1 divide-x divide-rule">
          {ids.map((id) => (
            <div key={id} className="flex min-h-0 min-w-0 flex-1 basis-0">
              <ChatView session={sessions[id]} column={{ onRemove: () => void saveSplit(removeFromSplit(ids, id)) }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[924px] px-8 pt-16">
            <EmptyState>Pick two to four sessions to watch and steer side by side. Each column keeps its own composer and approvals.</EmptyState>
          </div>
        </div>
      )}
    </div>
  );
}

/** Add session: the recent sessions not on screen yet. Full, the leftmost column makes room. */
function AddSession({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sessions = useHub((s) => s.sessions);
  const picks = Object.values(sessions)
    .filter((s) => !s.archived && !isChat(s) && !ids.includes(s.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, PICK_RECENT);
  return (
    <>
      <Button ref={ref} variant="outline" size="sm" aria-haspopup="menu" aria-expanded={open} disabled={!picks.length} onClick={() => setOpen((o) => !o)}>
        Add session
      </Button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={340} label="Add session">
        {ids.length >= SPLIT_MAX && <p className="px-3 pt-2.5 text-[12px] text-fg-3">The leftmost column makes room.</p>}
        <MenuList
          label="Add session"
          onDone={() => setOpen(false)}
          items={picks.map((s) => ({ label: s.title, detail: relTime(s.updatedAt), onSelect: () => void saveSplit(addToSplit(ids, s.id)) }))}
        />
      </Popover>
    </>
  );
}
