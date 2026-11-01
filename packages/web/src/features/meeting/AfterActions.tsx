/**
 * What a meeting can go on to (docs/design/MEETING-MODE.md 11.8): "Save to
 * memory" once its notes are written, "Open in chat" (a new Chat-mode chat,
 * or Code in the meeting's folder) and "Add to chat..." (one of the recent
 * chats). The hub builds the context and checks the account
 * (POST /api/meetings/:id/memory and /chat).
 */
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { Session } from '@conclave/core/types';
import { Button, type ButtonSize } from '@/components/ui/Button';
import { Dialog, Menu } from '@/components/ui/Overlay';
import { relTime } from '@/lib/format';
import { toast, upsertSession, useHub } from '@/store/store';
import type { Meeting } from '@/overlay/wire';
import { meetings } from './api';

const RECENT = 12;

/** Where a chat opens: Chat-mode chats on /chat, sessions on /s. */
export const chatHref = (s: Pick<Session, 'id' | 'kind'>) => (s.kind === 'chat' ? `/chat/${s.id}` : `/s/${s.id}`);

/** The account's recent chats a meeting can be added to, newest first. */
export function recentChats(sessions: Record<string, Session>, limit = RECENT): Session[] {
  return Object.values(sessions)
    .filter((s) => (s.kind === 'chat' || s.kind === 'agent' || s.kind === undefined) && !s.archived && !s.parentId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function AfterActions({ meeting: m, size, wrapped }: { meeting: Meeting; size: ButtonSize; wrapped: boolean }) {
  const [, go] = useLocation();
  const [busy, setBusy] = useState<'memory' | 'chat'>();
  const [memoryId, setMemoryId] = useState(m.memoryId);
  const [pick, setPick] = useState(false);
  const saved = memoryId ?? m.memoryId;
  const fail = (e: unknown) => toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });

  const save = async () => {
    setBusy('memory');
    try {
      setMemoryId((await meetings().saveMemory(m.id)).memoryId);
    } catch (e) {
      fail(e);
    }
    setBusy(undefined);
  };

  const chat = async (input: { to?: 'chat' | 'code'; sessionId?: string }) => {
    setBusy('chat');
    setPick(false);
    try {
      const s = (await meetings().toChat(m.id, input)) as Session;
      upsertSession(s);
      go(chatHref(s));
    } catch (e) {
      fail(e);
      setBusy(undefined);
    }
  };

  return (
    <>
      {wrapped &&
        (saved ? (
          <Link href={`/memory?focus=${encodeURIComponent(saved)}`} className="link inline-flex items-center text-[13px] phone:text-[15px]">
            Saved to memory
          </Link>
        ) : (
          <Button variant="outline" size={size} busy={busy === 'memory' ? 'Saving' : false} onClick={() => void save()}>
            Save to memory
          </Button>
        ))}
      <Menu
        label="Open in chat"
        width={240}
        items={[
          { label: 'New chat', detail: 'Chat mode', onSelect: () => void chat({ to: 'chat' }) },
          { label: 'New code session', detail: m.cwd, onSelect: () => void chat({ to: 'code' }) },
          { label: '', separator: true },
          { label: 'Add to chat...', onSelect: () => setPick(true) },
        ]}
        trigger={({ ref, props }) => (
          <Button ref={ref} variant="outline" size={size} busy={busy === 'chat' ? 'Opening' : false} {...props}>
            Open in chat
          </Button>
        )}
      />
      <ChatPicker open={pick} onClose={() => setPick(false)} onPick={(id) => void chat({ sessionId: id })} />
    </>
  );
}

function ChatPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const sessions = useHub((s) => s.sessions);
  const list = useMemo(() => recentChats(sessions), [sessions]);
  return (
    <Dialog open={open} onClose={onClose} title="Add to chat" description="The meeting's prep, notes and transcript go into the chat as a message. Nothing runs until you ask.">
      {list.length ? (
        <ul className="-mx-2 flex flex-col">
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" className="flex min-h-11 w-full items-baseline gap-3 rounded-[var(--r-1)] px-2 py-2 text-left hov:bg-hover focus-visible:bg-hover focus-visible:outline-none" onClick={() => onPick(s.id)}>
                <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{s.title || 'Untitled'}</span>
                <span className="num shrink-0 text-[12px] text-fg-3">{relTime(s.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2">No chats yet. Use Open in chat to start one.</p>
      )}
    </Dialog>
  );
}
