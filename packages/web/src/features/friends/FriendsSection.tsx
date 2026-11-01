/**
 * Settings, Friends (docs/design/FRIENDS.md 6): whether friends reach this
 * hub, key changes that hold a friend, requests both ways with Accept and
 * Decline, the friends (name, verified, short key, last seen), Shares, then Add a
 * friend. A friend's row opens their page: notes, the safety code, grants
 * and Remove (FriendPage.tsx).
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ChevronRight } from 'lucide-react';
import type { FriendDto, ReceivedShareDto } from '@conclave/core/client';
import { cn } from '@/lib/text';
import { useIsMobile, useNow } from '@/lib/hooks';
import { agoText, friendHref, friendOrder, friendState } from '@/lib/friends';
import { shareWaiting } from '@/lib/friendInbox';
import { useHub } from '@/store/store';
import { useFriendInbox } from '@/store/friends';
import { Button } from '@/components/ui/Button';
import { Group } from '@/features/settings/parts';
import { acceptRequest, declineRequest } from './actions';
import { AddFriend } from './AddFriend';
import { KeyChange, ReachLine, SafetyCode, ShortKey, TONE, useReachability, VerifiedBadge } from './parts';
import { FriendAdded } from './moments';
import { SharedProjectsGroup } from './SharedProjects';

export function FriendsSection() {
  const friendsMap = useHub((s) => s.friends);
  const booted = useHub((s) => s.booted);
  const reach = useReachability();
  const { items } = useFriendInbox();
  const all = useMemo(() => friendOrder(Object.values(friendsMap)), [friendsMap]);
  const blocked = all.filter((f) => f.status === 'blocked');
  const requests = all.filter((f) => f.status === 'pending');
  const friends = all.filter((f) => f.status === 'active');
  // notes not read yet and share cards not seen yet, per friend
  const fresh = useMemo(() => {
    const out: Record<string, number> = {};
    for (const i of items) if (i.kind === 'note' || i.kind === 'share') out[i.friendId] = (out[i.friendId] ?? 0) + i.count;
    return out;
  }, [items]);
  const received = useHub((s) => s.receivedShares);
  const sent = useHub((s) => s.sentShares);

  return (
    <div className="flex flex-col gap-9">
      <ReachLine r={reach} />

      {blocked.length > 0 && (
        <div className="flex flex-col gap-6">
          {blocked.map((f) => (
            <KeyChange key={f.id} f={f} />
          ))}
        </div>
      )}

      {requests.length > 0 && (
        <Group title="Requests" count={requests.length} id="requests">
          {requests.map((f) => (f.direction === 'in' ? <RequestIn key={f.id} f={f} /> : <RequestOut key={f.id} f={f} />))}
        </Group>
      )}

      <Group title="Friends" count={friends.length || undefined} id="friends">
        {friends.length ? (
          friends.map((f) => <FriendRow key={f.id} f={f} fresh={fresh[f.id] ?? 0} />)
        ) : (
          booted && <p className="m-0 max-w-[64ch] py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">No friends yet. Make an invite and send it to someone who runs Conclave, or use the link they sent you.</p>
        )}
      </Group>

      {(friends.length > 0 || Object.keys(received).length > 0 || Object.keys(sent).length > 0) && <SharesRow received={Object.values(received)} sent={Object.keys(sent).length} />}

      <SharedProjectsGroup />

      <AddFriend reach={reach} />
    </div>
  );
}

/** Shares: one row to the list of what friends sent and what you sent, with what waits. */
function SharesRow({ received, sent }: { received: ReceivedShareDto[]; sent: number }) {
  const waiting = received.filter(shareWaiting).length;
  const words = [received.length ? `${received.length} from friends` : '', sent ? `${sent} sent` : ''].filter(Boolean).join(', ');
  return (
    <Group title="Shares" id="shares">
      <Link href="/shares" className="group flex min-h-[60px] items-center gap-3 py-3">
        <div className="min-w-0 flex-1">
          <span className="t-row block truncate text-fg underline decoration-transparent underline-offset-[3px] transition-colors duration-[var(--dur-1)] group-hover:decoration-rule-2">{words ? words[0].toUpperCase() + words.slice(1) : 'None yet'}</span>
          <span className="mt-0.5 block truncate text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Chats and sessions, both ways.</span>
        </div>
        {waiting > 0 && <span className="num shrink-0 text-[12px] font-medium text-warn phone:text-[14px]">{waiting} waiting</span>}
        <ChevronRight className="size-4 shrink-0 text-fg-4 transition-colors duration-[var(--dur-1)] group-hover:text-fg-2" strokeWidth={2} aria-hidden />
      </Link>
    </Group>
  );
}

function FriendRow({ f, fresh }: { f: FriendDto; fresh: number }) {
  const now = useNow(60_000);
  const st = friendState(f, now);
  return (
    <Link href={friendHref(f.id)} className="group flex min-h-[60px] items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="t-row min-w-0 truncate text-fg underline decoration-transparent underline-offset-[3px] transition-colors duration-[var(--dur-1)] group-hover:decoration-rule-2">{f.name}</span>
          {f.verified && <VerifiedBadge />}
          <FriendAdded id={f.id} size={16} />
          {fresh > 0 && (
            <span className="num shrink-0 text-[12px] font-medium text-warn phone:text-[13px]">
              {fresh} new
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
          Key <ShortKey fp={f.fingerprint} />
        </div>
        {st.line && <div className={cn('mt-0.5 line-clamp-2 max-w-[64ch] text-[12px] leading-[1.45] phone:text-[13px]', TONE[st.tone])}>{st.line}</div>}
      </div>
      <span className={cn('shrink-0 text-[12px] phone:text-[14px]', st.tone === 'dim' ? 'text-fg-3' : TONE[st.tone])}>{st.word}</span>
      <ChevronRight className="size-4 shrink-0 text-fg-4 transition-colors duration-[var(--dur-1)] group-hover:text-fg-2" strokeWidth={2} aria-hidden />
    </Link>
  );
}

function RequestIn({ f }: { f: FriendDto }) {
  const mobile = useIsMobile();
  const now = useNow(60_000);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const size = mobile ? 'touch' : 'sm';
  const run = async (what: 'accept' | 'decline') => {
    setBusy(what);
    await (what === 'accept' ? acceptRequest(f) : declineRequest(f));
    setBusy(null);
  };
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3 py-3.5">
      <div className="min-w-0 flex-1 phone:basis-full">
        <div className="t-row text-fg">
          {f.name} <span className="font-normal text-fg-2">wants to be friends</span>
        </div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
          Key <ShortKey fp={f.fingerprint} />. Asked {agoText(f.createdAt, now)}.
        </div>
        <div className="mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">Safety code, to compare with {f.name}</div>
        <SafetyCode code={f.safetyCode} className="mt-0.5" />
      </div>
      <div className="flex shrink-0 gap-2 phone:w-full">
        <Button variant="quiet" size={size} busy={busy === 'decline' ? 'Declining' : false} disabled={!!busy} onClick={() => void run('decline')} className="phone:flex-1">
          Decline
        </Button>
        <Button variant="solid" size={size} busy={busy === 'accept' ? 'Accepting' : false} disabled={!!busy} onClick={() => void run('accept')} className="phone:flex-1">
          Accept
        </Button>
      </div>
    </div>
  );
}

function RequestOut({ f }: { f: FriendDto }) {
  const mobile = useIsMobile();
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="t-row text-fg">{f.name}</div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
          Waiting for them to accept. You asked {agoText(f.createdAt, now)}. Key <ShortKey fp={f.fingerprint} />.
        </div>
      </div>
      <Button
        variant="quiet"
        size={mobile ? 'touch' : 'sm'}
        busy={busy ? 'Withdrawing' : false}
        onClick={async () => {
          setBusy(true);
          await declineRequest(f);
          setBusy(false);
        }}
      >
        Withdraw
      </Button>
    </div>
  );
}
