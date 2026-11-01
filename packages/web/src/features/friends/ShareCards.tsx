/**
 * Shares as cards (docs/design/FRIENDS.md, phases 2 and 3). From a friend:
 * "Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files)"
 * with Accept and Decline while it waits, then Open; in the Inbox (a row on
 * a phone, a card on a desktop) and in the friend's thread. Sent by you:
 * the title, how each friend has it, Update (a new revision) and Unsend.
 */
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { ReceivedShareDto, SentShareDto } from '@conclave/core/client';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { shareHref } from '@/lib/friendInbox';
import { receivedWords, recipientWords, sentActive, shareWaiting, summaryText } from '@/lib/shares';
import { useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { Swap } from '@/components/motion';
import { acceptShare, declineShare, unsendShare } from './actions';
import { TONE } from './parts';
import { SendToFriendDialog, sourceOf } from './SendToFriend';
import { ShareArrived } from './moments';

/** Accept and Decline with their busy words, for any card of a share that waits. */
export function useShareAnswer(s: ReceivedShareDto) {
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [, navigate] = useLocation();
  const run = async (what: 'accept' | 'decline') => {
    setBusy(what);
    if (what === 'accept') await acceptShare(s, { open: () => navigate(shareHref(s.id)) });
    else await declineShare(s);
    setBusy(null);
  };
  return { busy, run, fetching: s.state === 'fetching' };
}

// ---------------------------------------------------------------------------
// From a friend
// ---------------------------------------------------------------------------

/**
 * A share from a friend as a card: its title (opens it), what it holds, the
 * note, how it stands, and Accept and Decline while it waits. `inbox`: the
 * desktop Inbox, which names the friend first.
 */
export function ReceivedShareCard({ s, inbox, className }: { s: ReceivedShareDto; inbox?: boolean; className?: string }) {
  const phone = useIsMobile();
  const now = useNow(60_000);
  const w = receivedWords(s, now);
  const { busy, run, fetching } = useShareAnswer(s);
  const size = phone ? 'touch' : 'sm';
  const waits = shareWaiting(s) || s.state === 'declined';
  return (
    <article aria-label={`${s.friendName} sent ${s.title}`} className={cn('rounded-[14px] border border-rule-2 px-3.5 py-3 phone:rounded-[18px] phone:px-4', className)}>
      <p className="m-0 flex items-center gap-2 text-[12px] text-fg-3 phone:text-[13px]">
        {inbox ? `${s.friendName} sent ${s.kind === 'chat' ? 'a chat' : 'a session'}` : `Shared ${s.kind === 'chat' ? 'a chat' : 'a session'}`}
        <ShareArrived id={s.id} size={12} className="ml-auto" />
      </p>
      <Link href={shareHref(s.id)} className="mt-0.5 block text-[14px] leading-[1.4] font-medium text-fg underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2 phone:-my-[11px] phone:py-[11px] phone:text-[16px]">
        {s.title}
      </Link>
      <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-2 phone:text-[14px]">{summaryText(s.kind, s.summary)}</p>
      {s.note && <p className="m-0 mt-1.5 text-[13px] leading-[1.5] whitespace-pre-wrap text-fg phone:text-[15px]">{s.note}</p>}
      <p className={cn('m-0 mt-1.5 text-[12px] leading-[1.45] phone:text-[13px]', TONE[w.tone])}>
        {w.word}
        {w.line && <span className="text-fg-3">. {w.line}</span>}
      </p>
      {waits ? (
        <div className="mt-2 flex gap-2 phone:w-full">
          {s.state === 'offered' && (
            <Button variant="quiet" size={size} disabled={!!busy || fetching} busy={busy === 'decline' ? 'Declining' : false} onClick={() => void run('decline')} className="phone:flex-1">
              Decline
            </Button>
          )}
          <Button variant="solid" size={size} disabled={!!busy || fetching} busy={busy === 'accept' || fetching ? 'Fetching' : false} onClick={() => void run('accept')} className="phone:flex-1">
            {s.updateWaiting ? `Accept revision ${s.revision}` : 'Accept'}
          </Button>
        </div>
      ) : s.state === 'accepted' ? (
        <Link href={shareHref(s.id)} className={cn('link mt-1.5 inline-block', phone ? 'py-3 text-[15px]' : 'text-[13px]')}>
          Open
        </Link>
      ) : null}
    </article>
  );
}

/**
 * A share card on the phone Inbox: "Alice sent 'title'" and what it holds,
 * whole, with Decline and Accept under it at the right, where an approval's
 * Deny and Allow sit. A tap on the words opens the share.
 */
export function PhoneShareRow({ s }: { s: ReceivedShareDto }) {
  const { busy, run, fetching } = useShareAnswer(s);
  return (
    <div className="pt-2.5 pb-1 active:bg-hover">
      <Link href={shareHref(s.id)} className="flex min-h-11 min-w-0 flex-col px-5">
        <span className="line-clamp-2 text-[16px] leading-[1.35] text-fg">
          {s.friendName} sent '{s.title}'
        </span>
        <span className="mt-0.5 block text-[14px] leading-[1.35] text-fg-2">{s.updateWaiting ? `Revision ${s.revision}. ${summaryText(s.kind, s.summary)}` : summaryText(s.kind, s.summary)}</span>
      </Link>
      <div className="flex items-center justify-end gap-1 pr-2.5">
        <ShareArrived id={s.id} size={14} className="mr-auto ml-5" />
      {s.state === 'offered' && (
        <button type="button" disabled={!!busy || fetching} onClick={() => void run('decline')} className="h-11 shrink-0 rounded-full px-2.5 text-[15px] text-fg-2 active:bg-hover disabled:text-fg-3">
          <Swap on={busy === 'decline'} off="Decline">
            Declining
          </Swap>
        </button>
      )}
      <button type="button" disabled={!!busy || fetching} onClick={() => void run('accept')} className="h-11 shrink-0 rounded-full px-2.5 text-[15px] font-semibold text-fg active:bg-hover disabled:text-fg-3">
        <Swap on={busy === 'accept' || fetching} off={s.updateWaiting ? 'Accept revision' : 'Accept'}>
          Fetching
        </Swap>
      </button>
      </div>
    </div>
  );
}

/** A share card in the desktop Inbox's From friends: the line, what it holds, the time, Accept and Decline. */
export function InboxShareRow({ s, inset }: { s: ReceivedShareDto; inset?: boolean }) {
  const now = useNow(60_000);
  const { busy, run, fetching } = useShareAnswer(s);
  return (
    <div className={cn('flex items-start gap-3 py-[10px] pr-3', inset ? 'pl-9' : 'pl-3')}>
      <div className="min-w-0 flex-1">
        <Link href={shareHref(s.id)} className="t-row block text-fg underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2">
          {s.friendName} sent '{s.title}'
        </Link>
        <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-2">{s.updateWaiting ? `Revision ${s.revision}. ${summaryText(s.kind, s.summary)}` : summaryText(s.kind, s.summary)}</p>
        {s.note && <p className="m-0 mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-fg-3">{s.note}</p>}
        <div className="mt-1.5 -ml-2 flex gap-1">
          {s.state === 'offered' && (
            <Button variant="quiet" size="sm" disabled={!!busy || fetching} busy={busy === 'decline' ? 'Declining' : false} onClick={() => void run('decline')}>
              Decline
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={!!busy || fetching} busy={busy === 'accept' || fetching ? 'Fetching' : false} onClick={() => void run('accept')}>
            {s.updateWaiting ? `Accept revision ${s.revision}` : 'Accept'}
          </Button>
        </div>
      </div>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4]">
        <span className="num text-fg-3">{relTime(s.receivedAt, now)}</span>
        <span className="text-warn">Share</span>
        <ShareArrived id={s.id} size={14} className="mt-1" />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sent by you
// ---------------------------------------------------------------------------

/**
 * A share this hub sent: its title, what it held, the revision, how each
 * friend has it (or only `friendId`), and Update and Unsend while it is out.
 */
export function SentShareCard({ s, friendId, className }: { s: SentShareDto; friendId?: string; className?: string }) {
  const phone = useIsMobile();
  const sessions = useHub((st) => st.sessions);
  const [ask, setAsk] = useState<'update' | 'unsend' | null>(null);
  const size = phone ? 'touch' : 'sm';
  const people = friendId ? s.recipients.filter((r) => r.friendId === friendId) : s.recipients;
  const own = sessions[s.sessionId];
  return (
    <article aria-label={`You sent ${s.title}`} className={cn('rounded-[14px] bg-raise px-3.5 py-3 light:border light:border-rule phone:rounded-[18px] phone:bg-surface-2 phone:px-4', className)}>
      <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">
        You shared {s.kind === 'chat' ? 'a chat' : 'a session'}
        {s.revision > 1 ? `, revision ${s.revision}` : ''}
      </p>
      {own ? (
        <Link href={own.kind === 'chat' ? `/chat/${own.id}` : `/s/${own.id}`} className="mt-0.5 block text-[14px] leading-[1.4] font-medium text-fg underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2 phone:-my-[11px] phone:py-[11px] phone:text-[16px]">
          {s.title}
        </Link>
      ) : (
        <p className="m-0 mt-0.5 text-[14px] leading-[1.4] font-medium text-fg phone:text-[16px]">{s.title}</p>
      )}
      <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-2 phone:text-[14px]">{summaryText(s.kind, s.summary)}</p>
      {s.note && <p className="m-0 mt-1.5 text-[13px] leading-[1.5] whitespace-pre-wrap text-fg phone:text-[15px]">{s.note}</p>}
      <ul className="m-0 mt-1.5 list-none p-0">
        {people.map((r) => {
          const w = recipientWords(r, s);
          return (
            <li key={r.friendId} className={cn('text-[12px] leading-[1.45] phone:text-[13px]', TONE[w.tone])}>
              {!friendId && <span className="text-fg-2">{r.friendName}: </span>}
              {w.word}
              {w.line && <span className="text-fg-3">. {w.line}</span>}
            </li>
          );
        })}
      </ul>
      {sentActive(s) && (
        <div className="mt-2 -ml-3 flex gap-1 phone:-ml-4">
          <Button variant="quiet" size={size} onClick={() => setAsk('update')}>
            Update
          </Button>
          <Button variant="danger" size={size} onClick={() => setAsk('unsend')}>
            Unsend
          </Button>
        </div>
      )}
      <SendToFriendDialog session={sourceOf(s, sessions)} update={s} open={ask === 'update'} onClose={() => setAsk(null)} />
      <UnsendDialog s={s} open={ask === 'unsend'} onClose={() => setAsk(null)} />
    </article>
  );
}

/** Unsend, after asking. The words say "asked to delete": a copy on another hub is theirs to delete. */
export function UnsendDialog({ s, open, onClose }: { s: SentShareDto; open: boolean; onClose: () => void }) {
  const names = s.recipients.filter((r) => r.state !== 'revoked').map((r) => r.friendName);
  const who = names.length === 1 ? `${names[0]}'s hub is` : names.length ? 'Their hubs are' : 'Their hub is';
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Unsend '${s.title}'?`}
      body={`${who} asked to delete the copy and any reference made from it. A fork or handoff they made stays theirs. Nothing more of it goes.`}
      confirm="Unsend"
      busy="Unsending"
      onConfirm={() => unsendShare(s.id)}
    />
  );
}
