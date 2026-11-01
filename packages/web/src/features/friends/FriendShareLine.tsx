/**
 * The line under a session made from a friend's share (a fork, a handoff or
 * a reference; docs/design/FRIENDS.md, phase 3): whose turns are quoted
 * here, and while the guard holds, that the first turn asks before any tool
 * runs. A link opens the share.
 */
import type { Session } from '@conclave/core/types';
import { cn } from '@/lib/text';
import { shareHref } from '@/lib/friendInbox';
import { useHub } from '@/store/store';
import { TextAction } from '@/components/ui/Section';

interface FriendShareMeta {
  name: string;
  role: 'fork' | 'handoff' | 'reference';
  guard?: boolean;
  importedThrough?: number;
}

function friendShareOf(s: Session): FriendShareMeta | undefined {
  const v = s.meta?.friendShare as FriendShareMeta | undefined;
  return v && typeof v === 'object' && typeof v.name === 'string' ? v : undefined;
}

/** The line in words: "Quoted from Alice's hub up to message 8. Its first turn asks before any tool runs." */
export function friendShareWords(m: FriendShareMeta): string {
  const hub = `${m.name}'s hub`;
  const asks = m.guard ? ' Its first turn asks before any tool runs, until you write a message of your own.' : '';
  if (m.role === 'reference') return `A reference from ${hub}: read only, quoted data. Your agents find it in past chats.`;
  if (m.role === 'handoff') return `A handoff from ${hub}: its brief quotes ${m.name}.${asks}`;
  return `A fork of ${m.name}'s share: ${m.importedThrough ? `the first ${m.importedThrough === 1 ? 'message is' : `${m.importedThrough} messages are`}` : 'what came before is'} quoted from ${hub}.${asks}`;
}

export function FriendShareLine({ session, className }: { session: Session; className?: string }) {
  const meta = friendShareOf(session);
  const share = useHub((s) => (meta ? Object.values(s.receivedShares).find((r) => r.sessions.some((x) => x.id === session.id)) : undefined));
  if (!meta) return null;
  return (
    <p className={cn('m-0 flex flex-wrap items-baseline gap-x-3 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]', className)}>
      <span className="min-w-0">{friendShareWords(meta)}</span>
      {share && <TextAction href={shareHref(share.id)} label="Open the share" />}
    </p>
  );
}
