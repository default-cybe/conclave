/**
 * One friend (/settings/friends/:id): the notes and shares both ways with a
 * composer (a share from them with Accept and Decline, one you sent with
 * Update and Unsend), and about their hub: the safety code with Mark verified, the key, when it
 * was last seen and where it answers, Sync, the grant for notes and shares,
 * and Remove. A request or a key change shows first, with its actions.
 *
 * Desktop: inside Settings, the notes on the left and the rest at the right
 * (stacked below 1280). Phone (docs/design/MOBILE-V2.md 5): the page draws
 * its own bar like a conversation, its title opens a sheet with the details,
 * and the composer sits at the bottom.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { FriendDto, OutboxItemDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile, useNow } from '@/lib/hooks';
import { agoText, deliveryWords, friendState } from '@/lib/friends';
import { friendThread, readTargets, type FriendEntry } from '@/lib/shares';
import { upsertFriendNote, useHub } from '@/store/store';
import { markFriendRead } from '@/store/friends';
import { Button } from '@/components/ui/Button';
import { OnOff, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Overlay';
import { PageHeader, usePageHeader } from '@/components/ui/Page';
import { SectionHeading } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Docked } from '@/components/ui/Toast';
import { PhoneBar } from '@/components/PhoneFrame';
import { Fingerprint } from '@/features/connect/Fingerprint';
import { PHONE_FIELD, PhoneSend, fitField } from '@/features/conversation/PhoneBox';
import { Url } from '@/features/settings/remote';
import { acceptRequest, cancelNote, declineRequest, markVerified, retryNote, sendNote, setGrants, syncFriend } from './actions';
import { KeyChange, RemoveDialog, SafetyCode, TONE, useFriendEvents, VerifiedBadge } from './parts';
import { ReceivedShareCard, SentShareCard } from './ShareCards';
import { FriendAdded } from './moments';

const LIST = '/settings/friends';

/** A quiet button's text lines up with the text above it: its padding, pulled back (sm 12px, touch 16px). */
const EDGE = 'phone:-ml-4 -ml-3';

export function FriendPage({ id }: { id: string }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const stored = useHub((s) => s.friends[id]);
  // a removed friend is not in the store: ask the hub, for its notes
  const [fetched, setFetched] = useState<FriendDto | null>();
  useEffect(() => {
    if (stored) return;
    let alive = true;
    api()
      .friend(id)
      .then((f) => alive && setFetched(f))
      .catch(() => alive && setFetched(null));
    return () => {
      alive = false;
    };
  }, [id, stored]);
  const f = stored ?? fetched ?? undefined;
  usePageHeader(f?.name ?? 'Friend', LIST);
  const gone = () => navigate(LIST, { replace: true });

  if (!f) {
    if (fetched === null)
      return (
        <Missing phone={phone}>
          This friend is not on this hub. <Link href={LIST} className="link">All friends</Link>
        </Missing>
      );
    return phone ? <PhoneBar lead="back" back={LIST} title="" /> : <LoadingRows loading rows={4} className="pt-6" />;
  }
  return phone ? <PhoneFriend f={f} onRemoved={gone} /> : <DesktopFriend f={f} onRemoved={gone} />;
}

function Missing({ phone, children }: { phone: boolean; children: React.ReactNode }) {
  return (
    <>
      {phone && <PhoneBar lead="back" back={LIST} title="Friend" />}
      <p className="px-[var(--gutter)] pt-6 text-[14px] text-fg-2 phone:px-5 phone:text-[15px]">{children}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

function DesktopFriend({ f, onRemoved }: { f: FriendDto; onRemoved: () => void }) {
  const notes = useNotes(f);
  const now = useNow(60_000);
  const st = friendState(f, now);
  return (
    <>
      <div className="pt-6">
        <Link href={LIST} className="link text-[13px]">
          Friends
        </Link>
      </div>
      <PageHeader
        className="pt-2"
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{f.name}</span>
            {f.verified && f.status === 'active' && <VerifiedBadge className="text-[13px]" />}
            <FriendAdded id={f.id} size={22} />
          </span>
        }
      >
        <p className={cn('-mt-3 text-[13px]', st.tone === 'dim' ? 'text-fg-3' : TONE[st.tone])}>{st.word}</p>
      </PageHeader>
      <StatusBlock f={f} onRemoved={onRemoved} className="mb-8" />
      <div className="grid gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,1fr)_264px]">
        <section aria-labelledby="notes-h" className="min-w-0">
          <SectionHeading id="notes-h">Notes and shares</SectionHeading>
          <Thread f={f} notes={notes} className="max-h-[min(58vh,620px)] overflow-y-auto overscroll-contain pt-3 pr-1" />
          <Composer f={f} onSent={notes.add} />
        </section>
        <aside aria-label={`About ${f.name}'s hub`} className="min-w-0">
          <SectionHeading>About their hub</SectionHeading>
          <FriendDetails f={f} onRemoved={onRemoved} className="pt-4" />
        </aside>
      </div>
    </>
  );
}

function PhoneFriend({ f, onRemoved }: { f: FriendDto; onRemoved: () => void }) {
  const notes = useNotes(f);
  const [sheet, setSheet] = useState(false);
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PhoneBar lead="back" back={LIST} title={f.name} onTitle={() => setSheet(true)} titleLabel={`${f.name}, details`} />
      <Thread
        f={f}
        notes={notes}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3"
        head={
          <>
            <FriendAdded id={f.id} size={28} className="mx-auto mt-2 mb-1 block" />
            <StatusBlock f={f} onRemoved={onRemoved} className="pt-2 pb-4" />
            {f.status === 'active' && !f.verified && (
              <p className="m-0 pt-1 pb-2 text-center text-[14px] leading-[1.45] text-fg-3">
                Not verified yet.{' '}
                <button type="button" onClick={() => setSheet(true)} className="link">
                  Compare the safety code
                </button>
              </p>
            )}
          </>
        }
      />
      <Docked>
        <Composer f={f} onSent={notes.add} phone />
      </Docked>
      <Sheet open={sheet} onClose={() => setSheet(false)} title={f.name}>
        <FriendDetails f={f} phone onRemoved={onRemoved} className="px-4 pt-1 pb-4" />
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A request, a key change, a removed friend
// ---------------------------------------------------------------------------

function StatusBlock({ f, onRemoved, className }: { f: FriendDto; onRemoved: () => void; className?: string }) {
  const phone = useIsMobile();
  const now = useNow(60_000);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const size = phone ? 'touch' : 'sm';
  if (f.status === 'blocked') return <KeyChange f={f} onRemoved={onRemoved} className={className} />;
  if (f.status === 'removed')
    return <p className={cn('m-0 text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]', className)}>You are not friends with {f.name} any more. Nothing goes either way. Their notes stay here.</p>;
  if (f.status !== 'pending') return null;
  if (f.direction === 'out')
    return (
      <div className={className}>
        <p className="m-0 text-[14px] leading-[1.5] text-fg phone:text-[15px]">Waiting for them to accept. You asked {agoText(f.createdAt, now)}.</p>
        <p className="m-0 mt-1 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">Compare the safety code with them meanwhile.</p>
        <SafetyCode code={f.safetyCode} className="mt-1.5" />
        <Button
          variant="quiet"
          size={size}
          className={cn('mt-3', EDGE)}
          busy={busy === 'decline' ? 'Withdrawing' : false}
          onClick={async () => {
            setBusy('decline');
            if (await declineRequest(f)) onRemoved();
            setBusy(null);
          }}
        >
          Withdraw the request
        </Button>
      </div>
    );
  return (
    <div className={className}>
      <p className="m-0 text-[15px] leading-[1.45] text-fg phone:text-[16px]">
        <span className="font-medium">{f.name}</span> wants to be friends.
      </p>
      <p className="m-0 mt-1 max-w-[60ch] text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">Compare the safety code with {f.name} in person or on a call before you accept. You both see the same code.</p>
      <SafetyCode code={f.safetyCode} className="mt-1.5" />
      <div className="mt-3 flex gap-2 phone:w-full">
        <Button
          variant="quiet"
          size={size}
          disabled={!!busy}
          busy={busy === 'decline' ? 'Declining' : false}
          className="phone:flex-1"
          onClick={async () => {
            setBusy('decline');
            if (await declineRequest(f)) onRemoved();
            setBusy(null);
          }}
        >
          Decline
        </Button>
        <Button
          variant="solid"
          size={size}
          disabled={!!busy}
          busy={busy === 'accept' ? 'Accepting' : false}
          className="phone:flex-1"
          onClick={async () => {
            setBusy('accept');
            await acceptRequest(f);
            setBusy(null);
          }}
        >
          Accept
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// About their hub
// ---------------------------------------------------------------------------

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="m-0 text-[12px] font-normal text-fg-3 phone:text-[13px]">{label}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

export function FriendDetails({ f, phone, onRemoved, className }: { f: FriendDto; phone?: boolean; onRemoved: () => void; className?: string }) {
  const now = useNow(60_000);
  const st = friendState(f, now);
  const [busy, setBusy] = useState<'verify' | 'sync' | null>(null);
  const [remove, setRemove] = useState(false);
  const size = phone ? 'touch' : 'sm';
  const help = 'm-0 mt-1.5 text-[12px] leading-[1.5] text-fg-3 phone:text-[14px]';
  const run = async (what: 'verify' | 'sync', fn: () => Promise<unknown>) => {
    setBusy(what);
    await fn();
    setBusy(null);
  };
  return (
    <div className={cn('space-y-6', className)}>
      <Block label="Safety code">
        <SafetyCode code={f.safetyCode} size="lg" />
        <p className={help}>Compare it with {f.name} in person or on a call. You both see the same code.</p>
        {/* the mark is for a friend's current key: a request or a key change has none to give */}
        {f.status !== 'active' ? null : f.verified ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <VerifiedBadge />
            <Button variant="quiet" size={size} className="-ml-1" busy={busy === 'verify' ? 'Saving' : false} onClick={() => void run('verify', () => markVerified(f, false))}>
              Take the mark off
            </Button>
          </div>
        ) : (
          <Button variant="outline" size={size} className="mt-2.5" busy={busy === 'verify' ? 'Saving' : false} onClick={() => void run('verify', () => markVerified(f, true))}>
            Mark verified
          </Button>
        )}
      </Block>

      <Block label="Key">
        <Fingerprint value={f.fingerprint} size="sm" />
      </Block>

      {f.status === 'active' && (
        <Block label="Their hub">
          <p className={cn('m-0 text-[13.5px] phone:text-[15px]', st.tone === 'dim' ? 'text-fg' : TONE[st.tone])}>{st.word}</p>
          {f.addresses[0] && (
            <p className="m-0 mt-0.5 text-[12.5px] leading-[1.5] text-fg-2 phone:text-[14px]">
              <Url url={f.addresses[0].url} />
            </p>
          )}
          {st.line && <p className={cn('m-0 mt-1 text-[12px] leading-[1.5] phone:text-[13px]', TONE[st.tone])}>{st.line}</p>}
          <Button variant="quiet" size={size} className={cn('mt-1.5', EDGE)} busy={busy === 'sync' ? 'Syncing' : false} onClick={() => void run('sync', () => syncFriend(f))}>
            Sync now
          </Button>
        </Block>
      )}

      {f.status === 'active' && (
        <Block label={`Notes and shares from ${f.name}`}>
          <OnOff label={`Notes and shares from ${f.name}`} size={phone ? 'touch' : 'sm'} checked={f.grants.receiveShares} onChange={(v) => void setGrants(f, { receiveShares: v })} />
          <p className={help}>{f.grants.receiveShares ? 'They land in your Inbox. Nothing runs because of them.' : `Your hub turns them away. ${f.name}'s hub keeps trying for 7 days.`}</p>
        </Block>
      )}

      {f.status !== 'removed' && f.status !== 'blocked' && (
        <div>
          <Button variant="danger" size={size} className={EDGE} onClick={() => setRemove(true)}>
            Remove {f.name}
          </Button>
          <RemoveDialog f={f} open={remove} onClose={() => setRemove(false)} onRemoved={onRemoved} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes and shares
// ---------------------------------------------------------------------------

interface Notes {
  entries: FriendEntry[];
  loaded: boolean;
  /** A note sent from here: shown at once, then kept current with the outbox. */
  add: (o: OutboxItemDto) => void;
  reload: () => void;
}

/**
 * This friend's notes and shares both ways, current with the hub's events
 * and, while a note is on its way, every few seconds. What is on screen is
 * read: the hub's mark for this friend moves, on every device.
 */
function useNotes(f: FriendDto): Notes {
  const id = f.id;
  const all = useHub((s) => s.friendNotes);
  const receivedAll = useHub((s) => s.receivedShares);
  const sentAll = useHub((s) => s.sentShares);
  const inbox = useMemo(() => all.filter((n) => n.friendId === id), [all, id]);
  const received = useMemo(() => Object.values(receivedAll).filter((s) => s.friendId === id), [receivedAll, id]);
  const sent = useMemo(() => Object.values(sentAll), [sentAll]);
  const [outbox, setOutbox] = useState<OutboxItemDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const now = useNow(60_000);

  const reload = useCallback(() => {
    api()
      .friendOutbox(id)
      .then(setOutbox)
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [id]);

  // the store holds the newest notes of every friend; this one's may go further back
  useEffect(() => {
    api()
      .friendInbox(id)
      .then((list) => list.forEach(upsertFriendNote))
      .catch(() => undefined);
    reload();
  }, [id, reload]);
  useFriendEvents(id, reload);

  const waiting = outbox.some((o) => o.type === 'note' && o.state === 'queued');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [waiting, reload]);

  // what is on screen is read, here and on the owner's other devices
  const unread = readTargets(f, inbox, received).join(',');
  useEffect(() => {
    if (unread) void markFriendRead(id, unread.split(','));
  }, [id, unread]);

  const entries = useMemo(() => friendThread(id, inbox, outbox, received, sent, now), [id, inbox, outbox, received, sent, now]);
  const add = useCallback((o: OutboxItemDto) => setOutbox((list) => [...list.filter((x) => x.id !== o.id), o]), []);
  return { entries, loaded, add, reload };
}

function Thread({ f, notes, className, head }: { f: FriendDto; notes: Notes; className?: string; head?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { entries, loaded } = notes;
  const lastOut = [...entries].reverse().find((e) => e.kind === 'out')?.id;
  const count = entries.length;
  // open at the newest note, and follow new ones
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, loaded]);
  return (
    <div ref={ref} className={className}>
      {head}
      {loaded && count === 0 && (
        <p className="m-0 py-4 text-[13px] leading-[1.5] text-fg-3 phone:text-center phone:text-[15px]">
          {f.status === 'active' ? `No notes yet. A note is plain text, signed by your hub and sealed for ${f.name}'s hub. Send a chat or a session from its menu, Send to friend.` : 'No notes.'}
        </p>
      )}
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={`Notes and shares with ${f.name}`}>
        {entries.map((e) => (
          <li key={`${e.kind}:${e.id}`} className="flex flex-col">
            {e.stamp && <div className="num pt-3 pb-1.5 text-center text-[12px] text-fg-3 phone:text-[13px]">{e.stamp}</div>}
            {e.kind === 'in' ? (
              <InNote e={e} name={f.name} />
            ) : e.kind === 'out' ? (
              <OutNote e={e} name={f.name} last={e.id === lastOut} onChanged={notes.reload} />
            ) : e.kind === 'share-in' ? (
              <ReceivedShareCard s={e.share} className="w-[min(100%,420px)] max-w-[88%] self-start" />
            ) : (
              <SentShareCard s={e.share} friendId={f.id} className="w-[min(100%,420px)] max-w-[88%] self-end" />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

const BUBBLE = 't-chat max-w-[82%] rounded-[18px] px-3.5 py-2 break-words whitespace-pre-wrap phone:rounded-[20px] phone:px-4 phone:py-2.5';

function InNote({ e, name }: { e: Extract<FriendEntry, { kind: 'in' }>; name: string }) {
  if (e.state === 'fetching') return <p className={cn(BUBBLE, 'm-0 self-start border border-rule text-fg-3')}>A note from {name} is on its way.</p>;
  if (e.state === 'failed') return <p className={cn(BUBBLE, 'm-0 self-start border border-rule text-fault')}>A note from {name} did not open.</p>;
  return (
    <p className={cn(BUBBLE, 'm-0 self-start border border-rule-2 text-fg')}>
      <span className="sr-only">{name}: </span>
      {e.text}
    </p>
  );
}

function OutNote({ e, name, last, onChanged }: { e: Extract<FriendEntry, { kind: 'out' }>; name: string; last: boolean; onChanged: () => void }) {
  const phone = useIsMobile();
  const now = useNow(30_000);
  const d = deliveryWords(e.item, name, now);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
    onChanged();
  };
  // a delivered note says so only under the last one
  const show = e.item.state !== 'delivered' || last;
  return (
    <>
      <p className={cn(BUBBLE, 'm-0 self-end bg-raise text-fg light:border light:border-rule phone:bg-surface-2')}>
        <span className="sr-only">You: </span>
        {e.text}
      </p>
      {show && (
        <div className="mt-0.5 flex max-w-[82%] flex-col items-end self-end text-right">
          <span className={cn('text-[12px] phone:text-[13px]', d.tone === 'dim' ? 'text-fg-3' : TONE[d.tone])}>{d.word}</span>
          {d.line && <span className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{d.line}</span>}
          {(d.retry || (d.cancel && e.item.attempts > 0)) && (
            <span className="mt-0.5 -mr-3 flex gap-1 phone:-mr-4">
              {d.retry && (
                <Button variant="quiet" size={phone ? 'touch' : 'sm'} disabled={busy} onClick={() => void act(() => retryNote(e.id))}>
                  Retry
                </Button>
              )}
              <Button variant="quiet" size={phone ? 'touch' : 'sm'} disabled={busy} onClick={() => void act(() => cancelNote(e.id))}>
                Cancel
              </Button>
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** Why there is no composer, or undefined when notes can go. */
function cannotWrite(f: FriendDto): string | undefined {
  if (f.status === 'pending') return f.direction === 'in' ? `Accept ${f.name}'s request to write to them.` : `You can write once ${f.name} accepts.`;
  if (f.status === 'blocked') return `Confirm ${f.name}'s new key to write again.`;
  if (f.status === 'removed') return `You are not friends with ${f.name} any more.`;
  return undefined;
}

function Composer({ f, onSent, phone }: { f: FriendDto; onSent: (o: OutboxItemDto) => void; phone?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const why = cannotWrite(f);
  const ready = !!text.trim() && !busy;

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const item = await sendNote(f, t);
    setBusy(false);
    if (!item) return;
    setText('');
    onSent(item);
    if (field.current && phone) {
      field.current.value = '';
      fitField(field.current);
    }
  };

  if (why) return <p className={cn('m-0 text-[13px] leading-[1.5] text-fg-3', phone ? 'px-5 pt-2 pb-3 text-center text-[15px]' : 'mt-4')}>{why}</p>;

  if (phone)
    return (
      <div className="px-3 pt-1.5 pb-2">
        <div className="flex items-end rounded-[24px] bg-surface-2 pr-1.5 pb-1 light:border light:border-rule">
          <textarea
            ref={field}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              fitField(e.target);
            }}
            placeholder={`Note to ${f.name}`}
            aria-label={`Note to ${f.name}`}
            className={cn(PHONE_FIELD, 'min-w-0 flex-1 pb-3')}
          />
          <PhoneSend running={false} ready={ready} label="Send note" onSend={() => void send()} onStop={() => undefined} keepFocus={() => true} />
        </div>
      </div>
    );

  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Textarea
        ref={field}
        prose
        minRows={2}
        maxRows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={`Write a note to ${f.name}`}
        aria-label={`Note to ${f.name}`}
      />
      <div className="mt-2 flex items-center justify-between gap-4">
        <span className="text-[12px] text-fg-3">Enter sends. Shift Enter starts a new line.</span>
        <Button type="submit" variant="solid" disabled={!ready} busy={busy ? 'Sending' : false}>
          Send
        </Button>
      </div>
    </form>
  );
}
