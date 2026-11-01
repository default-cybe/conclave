/**
 * The Inbox on a phone (docs/design/MOBILE-V2.md 6): what waits on you, one
 * row each, newest first. A row is the conversation's title, then one line:
 * "Wants to run git push", "Asks: Keep the old API route?". An approval has
 * Deny and Allow at its right; a tap on the row opens the conversation at
 * its card. A subagent's or a workflow agent's request is its chat's: the
 * row has that chat's title, says who asks ("Subagent email wants to use
 * mail read") and opens the chat at the card (lib/asks.ts). Under
 * "Earlier", in fg-3: what finished today and what was
 * decided here (Earlier.tsx). An alert has its answers at its right: Stop
 * and Keep waiting for a stuck turn, Dismiss for a file conflict.
 *
 * Friends add rows too (features/friends/InboxFriends.tsx): a request, a
 * key change, notes not read yet, a share with Decline and Accept. Each
 * opens the friend, or the share. A computer paired for the first time with
 * past chats on it has one row: Not now, or a tap to import them
 * (features/import/OfferCard.tsx).
 */
import { useCallback, useMemo, useRef } from 'react';
import { Link } from 'wouter';
import type { ApprovalRequest, QuestionRequest } from '@conclave/core/types';
import type { AlertItem, ImportOffer } from '@conclave/core/client';
import { useHub, useOnPage } from '@/store/store';
import { useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { hrefOf } from '@/lib/recents';
import { askHome, askerLine } from '@/lib/asks';
import { approvalLine, useApprovalDecision, type Decision } from '@/components/inbox/ApprovalCard';
import { useAlertAction } from '@/components/inbox/AlertCard';
import { alertActions, alertLine } from '@/components/inbox/alertWords';
import { GAP_OUT_MS, GapList, Swap } from '@/components/motion';
import { DECISION_WORDS, logResolved, useRetained } from '@/features/home/inbox';
import { useEarlierToday, type Result } from './Earlier';
import { useFriendInbox } from '@/store/friends';
import type { FriendInboxItem } from '@/lib/friendInbox';
import { PhoneFriendRow } from '@/features/friends/InboxFriends';
import { PhoneOfferRow, useImportOffers } from '@/features/import/OfferCard';

type Item =
  | { kind: 'approval'; id: string; createdAt: number; a: ApprovalRequest }
  | { kind: 'question'; id: string; createdAt: number; q: QuestionRequest }
  | { kind: 'alert'; id: string; createdAt: number; al: AlertItem }
  | { kind: 'friend'; id: string; createdAt: number; f: FriendInboxItem }
  | { kind: 'offer'; id: string; createdAt: number; o: ImportOffer };

export function PhoneInbox() {
  const approvalMap = useHub((s) => s.approvals);
  const questionMap = useHub((s) => s.questions);
  const alertMap = useHub((s) => s.alerts);
  const booted = useHub((s) => s.booted);
  const A = useRetained(useMemo(() => Object.values(approvalMap).sort((a, b) => a.createdAt - b.createdAt), [approvalMap]));
  const { results } = useEarlierToday();
  const friends = useFriendInbox().items;
  const offers = useImportOffers();

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const a of A.list) out.push({ kind: 'approval', id: a.id, createdAt: a.createdAt, a });
    for (const q of Object.values(questionMap)) out.push({ kind: 'question', id: q.id, createdAt: q.createdAt, q });
    for (const al of Object.values(alertMap)) out.push({ kind: 'alert', id: al.id, createdAt: al.createdAt, al });
    for (const f of friends) out.push({ kind: 'friend', id: f.id, createdAt: f.at, f });
    for (const o of offers) out.push({ kind: 'offer', id: `offer:${o.device}`, createdAt: o.createdAt, o });
    return out.sort((x, y) => y.createdAt - x.createdAt);
  }, [A.list, questionMap, alertMap, friends, offers]);

  // the row slides out first; its line under Earlier arrives once it has gone, so it never shows twice
  const onResolved = useCallback(
    (a: ApprovalRequest, d: Decision, at: number) => {
      A.release(a.id);
      setTimeout(() => logResolved({ kind: 'approval', id: a.id, at, decision: d, approval: a }), GAP_OUT_MS);
    },
    [A],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="pt-1 pb-8">
        {items.length === 0 ? (
          booted && <p className="m-0 px-5 py-3 text-[15px] leading-[1.45] text-pretty text-fg-3">Nothing is waiting on you. Approvals and questions from running sessions, and notes and shares from friends, land here.</p>
        ) : (
          <GapList items={items} keyOf={(it) => it.id}>
            {(it) =>
              it.kind === 'approval' ? (
                <div onPointerDownCapture={() => A.touch(it.id)} onKeyDownCapture={() => A.touch(it.id)}>
                  <ApprovalRow a={it.a} onResolved={onResolved} />
                </div>
              ) : it.kind === 'alert' ? (
                <AlertRow al={it.al} />
              ) : it.kind === 'friend' ? (
                <PhoneFriendRow item={it.f} />
              ) : it.kind === 'offer' ? (
                <PhoneOfferRow offer={it.o} />
              ) : (
                <QuestionRow q={it.q} />
              )
            }
          </GapList>
        )}
        {results.length > 0 && (
          <section aria-labelledby="inbox-earlier" className="mt-5">
            <h2 id="inbox-earlier" className="m-0 px-5 pb-1 text-[13px] font-medium text-fg-3">
              Earlier
            </h2>
            <GapList items={results} keyOf={(r) => r.id} exit="fade">
              {(r) => <DoneRow r={r} />}
            </GapList>
          </section>
        )}
      </div>
    </div>
  );
}

/** Where a row opens: the conversation, at the card. */
function useConversationHref(sessionId: string, askId: string): string {
  const session = useHub((s) => s.sessions[sessionId]);
  return `${hrefOf(session ?? { id: sessionId })}#ask-${askId}`;
}

function Title({ sessionId }: { sessionId: string }) {
  const title = useHub((s) => s.sessions[sessionId]?.title);
  return <span className="block truncate text-[16px] leading-[1.35] text-fg">{title ?? 'A session'}</span>;
}

function ApprovalRow({ a, onResolved }: { a: ApprovalRequest; onResolved: (a: ApprovalRequest, d: Decision, at: number) => void }) {
  const href = useConversationHref(askHome(a), a.id);
  const latest = useRef(onResolved);
  latest.current = onResolved;
  const resolved = useCallback((d: Decision, at: number) => latest.current(a, d, at), [a]);
  const { busy, done, decide } = useApprovalDecision(a, resolved);
  return (
    <div className="flex min-h-[60px] items-center gap-1 pr-2.5 active:bg-hover">
      <Link href={href} className="flex min-w-0 flex-1 flex-col justify-center self-stretch py-2.5 pl-5">
        <Title sessionId={askHome(a)} />
        <span className="mt-0.5 block truncate text-[14px] leading-[1.35] text-fg-2">{askerLine(a, approvalLine(a))}</span>
      </Link>
      {done ? (
        <span role="status" className={cn('shrink-0 px-2.5 text-[15px]', done.d === 'deny' ? 'text-fg-2' : 'text-ok')}>
          {done.d === 'once' ? 'Allowed' : DECISION_WORDS[done.d]}
        </span>
      ) : (
        <>
          <button type="button" disabled={!!busy} onClick={() => decide('deny')} className="h-11 shrink-0 rounded-full px-2.5 text-[15px] text-fg-2 active:bg-hover disabled:text-fg-3">
            <Swap on={busy === 'deny'} off="Deny">
              Denying
            </Swap>
          </button>
          <button type="button" disabled={!!busy} onClick={() => decide('once')} className="h-11 shrink-0 rounded-full px-2.5 text-[15px] font-semibold text-fg active:bg-hover disabled:text-fg-3">
            <Swap on={busy === 'once'} off="Allow">
              Allowing
            </Swap>
          </button>
        </>
      )}
    </div>
  );
}

/** An alert: the session's title, one line, and its answers at the right. */
function AlertRow({ al }: { al: AlertItem }) {
  const now = useNow(15_000);
  const session = useHub((s) => s.sessions[al.sessionId]);
  const { busy, act } = useAlertAction(al);
  return (
    <div className="flex min-h-[60px] items-center gap-1 pr-2.5 active:bg-hover">
      <Link href={hrefOf(session ?? { id: al.sessionId })} className="flex min-w-0 flex-1 flex-col justify-center self-stretch py-2.5 pl-5">
        <Title sessionId={al.sessionId} />
        <span className="mt-0.5 block truncate text-[14px] leading-[1.35] text-warn">{alertLine(al, now)}</span>
      </Link>
      {alertActions(al).map((x, i, all) => (
        <button
          key={x.action}
          type="button"
          disabled={!!busy}
          onClick={() => void act(x.action)}
          className={cn('h-11 shrink-0 rounded-full px-2.5 text-[15px] active:bg-hover disabled:text-fg-3', i === all.length - 1 ? 'font-semibold text-fg' : 'text-fg-2')}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

function QuestionRow({ q }: { q: QuestionRequest }) {
  const href = useConversationHref(askHome(q), q.id);
  useOnPage(q.id);
  return (
    <Link href={href} className="flex min-h-[60px] flex-col justify-center px-5 py-2.5 active:bg-hover">
      <Title sessionId={askHome(q)} />
      <span className="mt-0.5 block truncate text-[14px] leading-[1.35] text-fg-2">{askerLine(q, `Asks: ${q.questions[0]?.question ?? 'a question'}`)}</span>
    </Link>
  );
}

/** Done: the subject and how it ended, quiet. */
function DoneRow({ r }: { r: Result }) {
  return (
    <Link href={r.href} className="flex min-h-[56px] flex-col justify-center px-5 py-2 active:bg-hover">
      <span className="block truncate text-[16px] leading-[1.35] text-fg-3">{r.title}</span>
      <span className={cn('mt-0.5 block truncate text-[14px] leading-[1.35] text-fg-3', r.tone === 'fault' && 'text-fault')}>{r.word}</span>
    </Link>
  );
}
