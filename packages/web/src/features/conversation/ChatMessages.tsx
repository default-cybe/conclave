/**
 * The conversation (docs/design/CHAT-AND-MOTION.md 2.6): your messages, the
 * replies, second opinions and notices in one 720px column. Sending scrolls
 * your message near the top of the view so the reply has room to grow under
 * it; after that the view sticks to the bottom while you are at the bottom,
 * and "Jump to latest" rises when you scroll away. What waits on you, the
 * chat's own and its subagents' (lib/asks.ts), sits at the end.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message, Session } from '@conclave/core/types';
import { loadMessages, toolResultsFor, useHub, useQueue } from '@/store/store';
import { pendingIdsOf } from '@/store/queue';
import { useIsMobile, useReducedMotion } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { GapList, Knot, LiveStatus, usePresence } from '@/components/motion';
import { ApprovalCard } from '@/components/inbox/ApprovalCard';
import { QuestionCard } from '@/components/inbox/QuestionCard';
import { isContextOnly, isToolResultOnly } from '@/features/chat/util';
import { asksBelow, asksOf } from '@/lib/asks';
import { AskingRow, AsideView, FailedWords, NoticeView, Reply, SwitchView, isErrorNotice } from './Reply';
import { TryNextModel } from '@/features/chat/TryNextModel';
import { PendingMessage, QueuedBubble, UserMessage } from './UserMessage';
import { asideTargets, patchPending, rememberAside, setAsking, setPending, setScrolled, useChatUi, type Pending } from './state';
import { buildUnits, livePhase, replyEnded, type Unit } from './units';

const EMPTY: Message[] = [];
/** When this tab first saw each turn start: counters use the client clock, never the hub's. */
const turnStarts = new Map<string, number>();

/** The hub's copy of what you sent: the first user message that was not there when you sent. */
function arrivedId(messages: Message[], pending: Pending | undefined): string | undefined {
  if (!pending) return undefined;
  return pending.arrived ?? messages.find((x) => x.role === 'user' && !pending.known.has(x.id) && !isToolResultOnly(x) && !isContextOnly(x))?.id;
}

/** The hub's copy of what you sent has arrived and the reply has begun: the pending message goes. */
function usePendingSync(chatId: string, messages: Message[], session: Session | undefined, pending: Pending | undefined) {
  useEffect(() => {
    if (!pending) return;
    const arrived = arrivedId(messages, pending);
    if (arrived && !pending.arrived) {
      turnStarts.set(arrived, pending.at);
      patchPending(chatId, { arrived, arrivedAt: Date.now() });
    }
    if (!arrived) return;
    const at = messages.findIndex((x) => x.id === arrived);
    const followed = at >= 0 && messages.slice(at + 1).some((x) => x.role === 'assistant');
    if (followed || (session && session.status !== 'idle')) {
      setPending(chatId, undefined);
      return;
    }
    // the hub took it but has not started: give it a moment, then stop waiting
    const t = setTimeout(() => setPending(chatId, undefined), 3000);
    return () => clearTimeout(t);
  }, [chatId, messages, session, pending]);
}

/** A second opinion was asked for; it is here once a new aside arrives. */
function useAskingSync(chatId: string, messages: Message[]) {
  const asking = useChatUi((s) => s.asking[chatId]);
  useEffect(() => {
    const aside = asking ? messages.find((m) => m.kind === 'aside' && !asking.known.has(m.id)) : undefined;
    if (!asking || !aside) return;
    rememberAside(aside.id, asking.replyId);
    setAsking(chatId, undefined);
  }, [asking, chatId, messages]);
  return asking;
}

export function ChatMessages({ chatId, session }: { chatId: string; session?: Session }) {
  const messages = useHub((s) => s.messages[chatId]) ?? EMPTY;
  const loaded = useHub((s) => !!s.messagesLoaded[chatId]);
  const streamingAll = useHub((s) => s.streaming);
  const tools = useHub((s) => s.tools);
  const pending = useChatUi((s) => s.pending[chatId]);
  // what you sent while a reply runs, at the end until its turn takes it (store/queue.ts)
  const queued = useQueue(chatId);
  const reduced = useReducedMotion();
  const mobile = useIsMobile();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // "Jump to latest" rises when you scroll away and fades out when you are back
  const jumpShown = usePresence(!atBottom);
  const [anchored, setAnchored] = useState(() => !!useChatUi.getState().pending[chatId]);

  usePendingSync(chatId, messages, session, pending);
  const asking = useAskingSync(chatId, messages);

  const visible = useMemo(() => (pending?.hide.size ? messages.filter((m) => !pending.hide.has(m.id)) : messages), [messages, pending]);
  const failed = session?.status === 'error';
  // a limit stopped the reply; the hub picks it up again when the limit resets
  const resuming = session?.status === 'waiting_reset';
  // a second opinion that just arrived answers the reply it was asked about, from its first frame
  const targets = useMemo(() => {
    const t = { ...asideTargets() };
    if (asking) for (const m of messages) if (m.kind === 'aside' && !asking.known.has(m.id)) t[m.id] ??= asking.replyId;
    return t;
  }, [messages, asking]);
  const units = useMemo(() => {
    const list = buildUnits(visible, undefined, targets);
    // the hub writes the reason of a failed reply as an error notice too; the error line under it says it once, with Retry
    const last = list[list.length - 1];
    if (failed && last?.kind === 'notice' && isErrorNotice(last.message)) list.pop();
    return list;
  }, [visible, failed, targets]);
  // the same objects while nothing in them changed, so replies that are done skip each streamed chunk
  const results = useSame(useMemo(() => toolResultsFor(messages), [messages]));
  const streaming = useSame(streamingAll);
  // an approval or a question holds the reply (a hook can ask even in a chat, and so can a subagent): it stays live, its Knot amber
  const below = useHub((s) => !!session && session.status === 'running' && (asksBelow(Object.values(s.approvals), session.id) || asksBelow(Object.values(s.questions), session.id)));
  const onYou = session?.status === 'waiting_approval' || session?.status === 'waiting_input' || below;
  const running = session?.status === 'running' || onYou;
  // the hub has messages for this chat but none came back (the store treats a failed load as empty)
  const unloaded = loaded && !messages.length && !pending && !!session && session.stats.messages > 0 && !running;

  // a message still queued behind the running reply is not the turn being answered
  const lastUserIdx = findLastIndex(units, (u) => u.kind === 'user' && !u.queued);
  const lastUser = lastUserIdx >= 0 ? (units[lastUserIdx] as Extract<Unit, { kind: 'user' }>).message : undefined;
  // an edit shows its new text in the old bubble until the replies after it have faded out
  const inPlace = !!pending?.key && visible.some((m) => m.id === pending.key);
  // read in render, not after it: for one frame the message would show twice and the reply's mark restart
  const showPending = !!pending && !arrivedId(messages, pending) && !inPlace;
  const replyAfterUser = units.slice(lastUserIdx + 1).some((u) => u.kind === 'reply');
  const queuedAtEnd = units.some((u) => u.kind === 'user' && u.queued);
  // a reply is on its way but nothing of it has arrived yet
  const waiting = showPending || ((!!pending || running) && !inPlace && lastUserIdx >= 0 && !replyAfterUser);
  // the reply is over and the hub is starting the turn of the first message that waited (its hooks and recall run
  // before it stores the message): that turn's reply is coming, under the waiting bubble, as for a send
  const lastReplyUnit = findLast(units, (u) => u.kind === 'reply');
  const startingId = running && queued.length > 0 && !!lastReplyUnit && units.indexOf(lastReplyUnit) > lastUserIdx && lastReplyUnit.kind === 'reply' && replyEnded(lastReplyUnit.messages) ? queued[0].id : undefined;
  if (startingId && !turnStarts.has(`p:${startingId}`)) turnStarts.set(`p:${startingId}`, Date.now());
  // a stored message that took a waiting one's place counts from when its turn started here
  const took = lastUser ? pendingIdsOf(lastUser)[0] : undefined;
  const startedAt =
    pending?.at ?? (startingId ? turnStarts.get(`p:${startingId}`)! : lastUser ? (turnStarts.get(lastUser.id) ?? (took ? turnStarts.get(`p:${took}`) : undefined) ?? Math.min(lastUser.createdAt, Date.now())) : Date.now());

  // Rows: replies are keyed by their turn, so the reply that is coming (from the
  // moment you send) and the reply that arrives are one element: its mark never restarts.
  const rowsNext = useMemo(() => {
    const out: Unit[] = [];
    let turn = 0;
    let inTurn = 0;
    for (const u of units) {
      if (u.kind === 'user') {
        turn++;
        inTurn = 0;
        // one that took a waiting message's place keeps its row: the same bubble in the same spot
        const took = pendingIdsOf(u.message)[0];
        out.push(took ? { ...u, key: `p:${took}` } : u);
      } else if (u.kind === 'reply') out.push({ ...u, key: `t${turn}.${inTurn++}` });
      else out.push(u);
    }
    if (showPending) {
      turn++;
      inTurn = 0;
      out.push({ kind: 'pending', key: pending?.key ?? 'pending' });
    }
    // the reply that is coming keeps its row when the turn fails or meets a limit before anything
    // arrived: its Knot turns in place (fault, or the grey stub) and the reason sits next to it
    const held = (failed || resuming) && !!lastUser && !units.slice(lastUserIdx + 1).some((u) => u.kind === 'reply');
    if ((waiting || held) && !queuedAtEnd) out.push({ kind: 'reply', key: `t${turn}.${inTurn}`, messages: [], user: lastUser });
    const keys = new Set(out.map((u) => u.key));
    for (const item of queued) {
      if (keys.has(`p:${item.id}`)) continue;
      out.push({ kind: 'queued', key: `p:${item.id}`, item });
      // its turn is starting: the reply that is coming sits under it with the key it keeps once the message is stored
      if (item.id === startingId) out.push({ kind: 'reply', key: `t${turn + 1}.0`, messages: [] });
    }
    return out;
  }, [units, showPending, waiting, pending?.key, lastUser, failed, resuming, lastUserIdx, queuedAtEnd, queued, startingId]);
  const rows = useStableRows(rowsNext);

  const lastReplyIdx = findLastIndex(rows, (u) => u.kind === 'reply');
  const lastTurnIdx = findLastIndex(rows, (u) => (u.kind === 'user' && !u.queued) || u.kind === 'pending');
  const carried = lastReplyIdx >= 0 && lastReplyIdx > lastTurnIdx;
  const liveIdx = (running || waiting) && lastReplyIdx > lastTurnIdx ? lastReplyIdx : -1;

  // replies after each row (Edit and Retry say how many go away)
  const repliesAfter = useMemo(() => {
    const out: number[] = new Array(rows.length).fill(0);
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      out[i] = n;
      if (rows[i].kind === 'reply') n++;
    }
    return out;
  }, [rows]);

  // another chat opens at the bottom; one you just sent in keeps its message near the top
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
    setAnchored(!!useChatUi.getState().pending[chatId]);
  }, [chatId]);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash || !loaded) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`cm-${hash}`) ?? document.querySelector<HTMLElement>(`[data-ids~="${CSS.escape(hash)}"]`);
      if (!el) return;
      stick.current = false;
      setAtBottom(false);
      el.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [chatId, loaded]);

  // sending: your message rises to near the top of the view, and the reply grows under it
  const pendingKey = pending && !pending.arrived ? pending.at : undefined;
  useLayoutEffect(() => {
    if (!pendingKey) return;
    setAnchored(true);
    stick.current = true;
  }, [pendingKey]);

  // The spacer under the last exchange keeps your message near the top while the reply is
  // shorter than the view; then it is 0 and the view sticks to the bottom as text arrives.
  const fit = useCallback(() => {
    const el = scroller.current;
    const sp = spacer.current;
    const box = content.current;
    if (!el || !sp || !box) return;
    let h = 0;
    if (anchored) {
      const anchor = box.querySelector<HTMLElement>('[data-anchor]');
      if (anchor) h = Math.max(0, el.clientHeight - TOP_GAP - BOTTOM_PAD - (box.offsetHeight - anchor.offsetTop));
    }
    sp.style.height = `${h}px`;
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [anchored]);
  useLayoutEffect(fit);
  useEffect(() => {
    const el = scroller.current;
    const box = content.current;
    if (!el || !box) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    ro.observe(box);
    return () => ro.disconnect();
  }, [fit]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stick.current = near;
    if (near !== atBottom) setAtBottom(near);
    setScrolled(el.scrollTop > 2);
  };
  useEffect(() => () => setScrolled(false), []);

  const jump = () => {
    stick.current = true;
    setAtBottom(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  };

  // a message that took a waiting one's place was on screen already: the view stays where it is (no anchor of its own)
  const anchorIdx = showPending ? rows.findIndex((u) => u.kind === 'pending') : findLastIndex(rows, (u) => (u.kind === 'user' && !u.queued && !pendingIdsOf(u.message).length) || u.kind === 'pending');
  const askAfter = asking ? rows.findIndex((u) => u.kind === 'reply' && u.messages.some((m) => m.id === asking.replyId)) : -1;

  const render = (u: Unit, i: number): ReactNode => {
    if (u.kind === 'pending') return pending ? <PendingMessage pending={pending} /> : null;
    if (u.kind === 'queued') return <QueuedBubble item={u.item} chatId={chatId} />;
    if (!session && u.kind !== 'reply') return null;
    switch (u.kind) {
      case 'user':
        return <UserMessage message={u.message} session={session!} after={repliesAfter[i]} queued={u.queued} />;
      case 'reply':
        return (
          <Reply
            reply={u}
            session={session ?? PLACEHOLDER}
            isLast={i === lastReplyIdx}
            live={i === liveIdx}
            phase={i === liveIdx ? livePhase(u.messages, streaming, tools, results) : 'between'}
            startedAt={i === liveIdx ? startedAt : 0}
            streaming={streaming}
            tools={tools}
            results={results}
            failed={failed && i === lastReplyIdx}
            resuming={resuming && i === lastReplyIdx}
            onYou={onYou && i === liveIdx}
            after={repliesAfter[i]}
          />
        );
      case 'aside':
        return <AsideView message={u.message} session={session!} pending={u.pending} streaming={!!streaming[u.message.id]} />;
      case 'notice':
        return (
          <>
            <NoticeView message={u.message} />
            {session && <TryNextModel message={u.message} session={session} className="mt-2" />}
          </>
        );
      case 'switch':
        return <SwitchView model={u.model} />;
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* log-text: the conversation at the Text size of Settings, Appearance (index.css) */}
      <div ref={scroller} onScroll={onScroll} className="log-text min-h-0 flex-1 overflow-y-auto overscroll-contain" role="log" aria-label="Conversation" aria-busy={running || undefined}>
        <div className="@container mx-auto w-full max-w-[784px] px-8 pt-4 pb-10 phone:px-5 phone:pt-2 phone:pb-6">
          <div ref={content} className="relative">
            <LoadingRows loading={!loaded && !pending && !!session} rows={3} />
            {rows.map((u, i) => (
              <div
                key={u.key}
                data-anchor={i === anchorIdx ? '' : undefined}
                data-ids={u.kind === 'reply' ? u.messages.map((m) => m.id).join(' ') : undefined}
                className={gapClass(rows[i - 1], u)}
              >
                {render(u, i)}
                {i === askAfter && asking && (
                  <div className="mt-6">
                    <AskingRow model={asking.model} at={asking.at} still={running} />
                  </div>
                )}
              </div>
            ))}
            {unloaded && <LoadFailed chatId={chatId} />}
            {/* the last reply carries a failure or a limit next to its Knot; these are for a chat with no reply to carry it */}
            {failed && session && !carried && <ErrorLine session={session} user={lastUser} />}
            {resuming && session && !carried && <ResumeLine session={session} />}
            {/* what waits on you sits at the end, like a permission prompt (a hook can ask, even in a chat, and so can a subagent) */}
            {session && <Asks sessionId={session.id} />}
          </div>
          <div ref={spacer} aria-hidden />
        </div>
      </div>
      {jumpShown.mounted && (
        <button
          type="button"
          onClick={jump}
          tabIndex={jumpShown.leaving ? -1 : undefined}
          className={cn(
            'absolute bottom-3 left-1/2 h-[26px] -translate-x-1/2 rounded-[var(--r-1)] border border-rule-2 bg-raise px-3 text-[12.5px] font-medium text-fg-2 hov:text-fg phone:h-9 phone:text-[14px]',
            jumpShown.leaving ? 'anim-out' : 'anim-rise',
          )}
          style={{ boxShadow: 'var(--shadow-pop)' }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** Approvals and questions of this chat and of its subagents and workflow agents, at the end of the conversation. */
function Asks({ sessionId }: { sessionId: string }) {
  const approvals = useHub((s) => s.approvals);
  const questions = useHub((s) => s.questions);
  const items = useMemo(
    () => [
      ...asksOf(Object.values(questions), sessionId).map((q) => ({ kind: 'question' as const, id: q.id, q })),
      ...asksOf(Object.values(approvals), sessionId).map((a) => ({ kind: 'approval' as const, id: a.id, a })),
    ],
    [approvals, questions, sessionId],
  );
  return (
    <GapList items={items} keyOf={(it) => it.id} itemClassName="pt-5">
      {(it) => (it.kind === 'question' ? <QuestionCard question={it.q} inSession here={sessionId} className="py-0" /> : <ApprovalCard approval={it.a} inSession here={sessionId} />)}
    </GapList>
  );
}

/** The previous object while its keys hold the same values (a streamed chunk rebuilds the store's records). */
function useSame<T extends object>(next: T): T {
  const ref = useRef(next);
  if (ref.current !== next) {
    const a = ref.current as Record<string, unknown>;
    const b = next as Record<string, unknown>;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length || ka.some((k) => a[k] !== b[k])) ref.current = next;
  }
  return ref.current;
}

function sameUnit(a: Unit, b: Unit): boolean {
  if (a.kind !== b.kind) return false;
  switch (b.kind) {
    case 'reply': {
      const p = a as typeof b;
      return p.user === b.user && p.model === b.model && p.messages.length === b.messages.length && p.messages.every((m, i) => m === b.messages[i]);
    }
    case 'user':
      return (a as typeof b).message === b.message && (a as typeof b).queued === b.queued;
    case 'aside':
      return (a as typeof b).message === b.message && (a as typeof b).pending === b.pending;
    case 'notice':
      return (a as typeof b).message === b.message;
    case 'switch':
      return (a as typeof b).model === b.model;
    case 'pending':
      return true;
    case 'queued':
      return (a as typeof b).item === b.item;
  }
}

/** Rows keep their objects while their messages are the same ones, so memoized rows do not draw again. */
function useStableRows(next: Unit[]): Unit[] {
  const prev = useRef(new Map<string, Unit>());
  return useMemo(() => {
    const seen = new Map<string, Unit>();
    const out = next.map((u) => {
      const p = prev.current.get(u.key);
      const keep = p && sameUnit(p, u) ? p : u;
      seen.set(u.key, keep);
      return keep;
    });
    prev.current = seen;
    return out;
  }, [next]);
}

/** Space above your message after a send, and the scroller's bottom padding (pt-4, pb-10). */
const TOP_GAP = 16;
const BOTTOM_PAD = 40;

/** A stand in while a new chat is being made: the reply placeholder needs a session shape. */
const PLACEHOLDER = { id: 'new', title: 'New chat', model: '', status: 'running', stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } } as unknown as Session;

function findLast<T>(list: T[], fn: (t: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return list[i];
  return undefined;
}

function findLastIndex<T>(list: T[], fn: (t: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return i;
  return -1;
}

/** Space between pieces: 16px from your message to its reply, 28px before your next message. */
function gapClass(prev: Unit | undefined, u: Unit): string | undefined {
  if (!prev) return undefined;
  if (u.kind === 'user') return 'mt-7';
  if (u.kind === 'pending' || u.kind === 'queued') return 'mt-7';
  if (prev.kind === 'user' || prev.kind === 'pending' || prev.kind === 'queued') return 'mt-7 coarse:mt-3';
  if (u.kind === 'aside' || prev.kind === 'aside') return 'mt-6';
  if (u.kind === 'switch' || u.kind === 'notice') return 'mt-4';
  return 'mt-5';
}

/** The transcript did not load: say so, and load it again on request. */
function LoadFailed({ chatId }: { chatId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="pt-6 anim-fade" role="alert">
      <p className="max-w-[72ch] text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">The messages of this chat did not load. Check that the hub is reachable, then try again.</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        busy={busy ? 'Loading' : false}
        onClick={async () => {
          setBusy(true);
          await loadMessages(chatId, true);
          setBusy(false);
        }}
      >
        Try again
      </Button>
    </div>
  );
}

/** The run failed with no reply to carry it: the failed Knot, the reason, Retry and Switch model (spec 1.3 Failed). */
function ErrorLine({ session, user }: { session: Session; user?: Message }) {
  return (
    <div className="mt-5 flex items-start gap-1">
      <span className="mr-2 flex h-7 shrink-0 items-center phone:h-10">
        <Knot state="failed" size={16} />
      </span>
      <FailedWords session={session} user={user} />
    </div>
  );
}

/**
 * Waiting for a limit to reset (spec 1.3 Resuming): the Knot draws back to a
 * grey stub and rests, and "Resumes in 4:59" counts down with rolling digits.
 * At zero the hub starts the reply again and the reply's Knot writes.
 */
function ResumeLine({ session }: { session: Session }) {
  return (
    <div className="mt-5 flex items-center gap-2 text-[12.5px] text-fg-3 phone:text-[13.5px]">
      <LiveStatus state="resuming" resumeAt={session.resumeAt} countdown={!!session.resumeAt} label={session.resumeAt ? undefined : 'Resumes when the limit resets'} />
    </div>
  );
}
