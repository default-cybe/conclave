/**
 * The transcript (spec 11.2.2): a log with a time gutter. Owner messages,
 * assistant turns, tool rows, second opinions, jury and debate runs,
 * notices, then the live line (what the model is doing now), then anything
 * waiting on the owner, its own and its subagents' and workflow agents'
 * (lib/asks.ts). Sticks to the bottom while the owner is at the bottom.
 *
 * Motion (docs/design/CHAT-AND-MOTION.md 1.3, 1.4): only what arrives after
 * the transcript loaded fades in; the live line carries the mark and keeps
 * one height in every state, so the log never jumps when a turn changes state.
 *
 * A long session opens with its latest pieces and older ones mount as you
 * scroll up and in idle time (window.ts), so it paints at once however long
 * it is.
 */
import { Component, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { Message, Session } from '@conclave/core/types';
import { toolResultsFor, useHub, useQueue, type HubState } from '@/store/store';
import { replacesPending } from '@/store/queue';
import { hhmm } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { modelName } from '@/lib/models';
import { asksBelow, asksOf } from '@/lib/asks';
import { ApprovalCard } from '@/components/inbox/ApprovalCard';
import { QuestionCard } from '@/components/inbox/QuestionCard';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { GapList, Knot, LiveStatus, Roll, Steps, arrived, useArrivals, usePresence, useReducedMotion, type LiveState, type MarkState } from '@/components/motion';
import { permissionMeta } from './modes';
import { LogRow } from './Log';
import { ErrorBody, NoticeLine, SummaryLine } from './Notices';
import { AssistantTurn, SecondOpinion, UserMessage } from './Turn';
import { PendingMessages } from './Pending';
import { DebateGroup, JuryGroup, type GroupUnit } from './Group';
import { revealOnMount, toolInfo } from './ToolRows';
import { isContextOnly, isToolResultOnly, msgText, turnStartedAt, useTps } from './util';
import { fillDirection, grow, idleDirection, mountedRange, nearEdge, openSpan, partsOf, unitIndexOf, type Direction, type Span } from './window';

export type Unit =
  | { kind: 'user'; key: string; message: Message }
  | { kind: 'turn'; key: string; messages: Message[] }
  | { kind: 'aside'; key: string; message: Message; pending: boolean }
  | GroupUnit
  | { kind: 'notice'; key: string; message: Message }
  | { kind: 'summary'; key: string; message: Message };

/** The transcript in pieces: your messages, assistant turns, asides, jury and debate groups, notices. Shared with the phone transcript. */
export function buildUnits(messages: Message[], session: Session): Unit[] {
  const units: Unit[] = [];
  const groups = new Map<string, GroupUnit>();
  let lastUser: Message | undefined;
  for (const m of messages) {
    if (isToolResultOnly(m) || isContextOnly(m)) continue;
    if (m.kind === 'notice') {
      units.push({ kind: 'notice', key: m.id, message: m });
      continue;
    }
    if (m.kind === 'summary') {
      units.push({ kind: 'summary', key: m.id, message: m });
      continue;
    }
    if (m.group) {
      let g = groups.get(m.group);
      if (!g) {
        const metaMode = (m.meta?.mode as string | undefined) ?? (session.mode === 'debate' ? 'debate' : 'jury');
        g = { kind: 'group', key: `g:${m.group}`, group: m.group, members: [], mode: metaMode === 'debate' ? 'debate' : 'jury', question: lastUser };
        groups.set(m.group, g);
        units.push(g);
      }
      if (m.kind === 'aside') g.members.push(m);
      else g.verdict = m;
      continue;
    }
    if (m.kind === 'aside') {
      units.push({ kind: 'aside', key: m.id, message: m, pending: true });
      continue;
    }
    if (m.role === 'user') {
      lastUser = m;
      units.push({ kind: 'user', key: m.id, message: m });
      continue;
    }
    const last = units[units.length - 1];
    if (last?.kind === 'turn' && last.messages[0].model === m.model) last.messages.push(m);
    else units.push({ kind: 'turn', key: m.id, messages: [m] });
  }
  // a second opinion stays open (Adopt, Dismiss) until a reply follows it
  let replied = false;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (u.kind === 'aside') u.pending = !replied;
    if (u.kind === 'user' || u.kind === 'turn') replied = true;
  }
  return units;
}

export function MessageList({ session }: { session: Session }) {
  const messages = useHub((s) => s.messages[session.id]);
  const loaded = useHub((s) => s.messagesLoaded[session.id]);
  const streaming = useHub((s) => s.streaming);
  const tools = useHub((s) => s.tools);
  const approvalMap = useHub((s) => s.approvals);
  const questionMap = useHub((s) => s.questions);
  // what you sent while it works, after the turn that runs (Pending.tsx)
  const queued = useQueue(session.id);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [openApproval, setOpenApproval] = useState<string | null>(null);
  const list = useMemo(() => messages ?? [], [messages]);
  const units = useMemo(() => buildUnits(list, session), [list, session]);
  const results = useMemo(() => toolResultsFor(list), [list]);
  // its own, and those of its subagents and workflow agents: they wait on you here, as well as in the Inbox
  const approvals = useMemo(() => asksOf(Object.values(approvalMap), session.id), [approvalMap, session.id]);
  const questions = useMemo(() => asksOf(Object.values(questionMap), session.id), [questionMap, session.id]);
  const waitingItems = useMemo(() => [...questions.map((q) => ({ kind: 'question' as const, id: q.id, q })), ...approvals.map((a) => ({ kind: 'approval' as const, id: a.id, a }))], [questions, approvals]);
  // one approval open at a time: the one you opened, else the oldest
  const expandedId = approvals.some((x) => x.id === openApproval) ? openApproval : approvals[0]?.id;
  // a card that is sliding out keeps the shape it had, even though it is no longer the open one
  const shape = useRef(new Map<string, boolean>());
  const lastNoticeId = useMemo(() => [...list].reverse().find((m) => m.kind === 'notice')?.id, [list]);
  const lastPrompt = useMemo(() => {
    const u = [...list].reverse().find((m) => m.role === 'user' && !isToolResultOnly(m) && !isContextOnly(m));
    return u ? msgText(u) : undefined;
  }, [list]);
  const running = session.status === 'running';
  // the latest turn while the session is at work on it: its calls in progress stay open (CHAT-AND-MOTION 6.3)
  const working = running || session.status === 'waiting_approval' || session.status === 'waiting_input';
  const lastTurn = useMemo(() => {
    for (let i = units.length - 1; i >= 0; i--) if (units[i].kind === 'turn') return units[i].key;
    return undefined;
  }, [units]);
  const reduced = useReducedMotion();
  // what was on screen when the transcript loaded never animates; what arrives after it does
  const errorKey = session.status === 'error' ? `error:${session.error ?? ''}` : '';
  const seen = useArrivals(() => [...list.map((m) => m.id), errorKey], !!loaded, session.id);
  const jump = usePresence(!atBottom);
  const column = useRef<HTMLDivElement>(null);

  // which pieces are mounted (window.ts): opened once the transcript is loaded, for each session
  const [win, setWin] = useState<Win | null>(null);
  let w = win;
  if (loaded && w?.session !== session.id) {
    w = openWin(session.id, units, list, typeof location === 'undefined' ? '' : location.hash.slice(1));
    setWin(w);
  }
  const mine = w?.session === session.id ? w : null;
  const [from, to] = mine ? mountedRange(mine.span, units.length) : [0, units.length];
  const pieceParts = useMemo(() => partsOf(mine?.core ?? null, from, to, units.length), [mine?.core, from, to, units.length]);
  // the newest pieces are mounted: the live line and what waits on you follow them, and the log may stick to the bottom
  const tail = to === units.length;
  const view = useRef({ mine, count: units.length, tail });
  useLayoutEffect(() => {
    view.current = { mine, count: units.length, tail };
  });

  // a fresh session opens at the bottom (or at its #message, below)
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [session.id]);

  // stick to the bottom while new content streams in
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // opening, before the first paint: mount more until the latest pieces fill two screens (or the linked one has a
  // screen each side), then each piece keeps the height it has now while it is skipped off screen, so turning
  // skipping on moves nothing, and the log goes to the bottom or lands on the #message
  useLayoutEffect(() => {
    const el = scroller.current;
    const col = column.current;
    if (!mine || mine.core || !el || !col) return;
    const pieces = [...col.querySelectorAll<HTMLElement>(':scope > .log-part > .log-unit')];
    // a link to a call's result lands on the call's row (its group opened as it mounted), else on the message, else its piece
    const target = mine.target ? ((mine.tool && document.getElementById(`tool-${mine.tool}`)) || (mine.hash && document.getElementById(`msg-${mine.hash}`)) || pieces.find((p) => p.dataset.unit === mine.target) || null) : null;
    const box = col.getBoundingClientRect();
    const at = target?.getBoundingClientRect();
    const dir = fillDirection(mine.span, units.length, { height: el.scrollHeight, viewport: el.clientHeight, ...(at && { above: at.top - box.top, below: box.bottom - at.bottom }) });
    if (dir) {
      setWin({ ...mine, span: grow(mine.span, dir, units.length) });
      return;
    }
    const guess = keepHeights(pieces);
    if (target) {
      stick.current = false;
      setAtBottom(false);
      target.scrollIntoView({ block: 'center' });
      target.style.transition = 'background-color 240ms var(--ease)';
      target.style.backgroundColor = 'var(--bg-hover)';
      setTimeout(() => (target.style.backgroundColor = ''), 1600);
    } else {
      stick.current = true;
      el.scrollTop = el.scrollHeight;
    }
    setWin({ ...mine, core: mine.span, guess });
  });

  useAnchoring(scroller, column, !!mine?.core, stick);

  // older (or, after a link, newer) pieces mount a chunk at a time, in a transition so scrolling stays smooth
  const growing = useRef(false);
  useLayoutEffect(() => {
    growing.current = false;
  }, [mine]);
  const growOne = (dir: Direction) => {
    const { mine: m, count } = view.current;
    if (growing.current || !m?.core || grow(m.span, dir, count) === m.span) return;
    growing.current = true;
    startTransition(() => setWin((x) => (x?.session === m.session ? { ...x, span: grow(x.span, dir, count) } : x)));
  };
  // and in idle time, until the whole transcript is mounted and find in page covers all of it
  // (not after every streamed chunk: that would put the next step off for as long as a reply streams)
  useEffect(() => {
    const dir = mine?.core ? idleDirection(mine.span, units.length) : null;
    if (!dir) return;
    return whenIdle(() => growOne(dir));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, units.length]);

  const unitView = (u: Unit): ReactNode => {
    switch (u.kind) {
      case 'user':
        // one that took a waiting message's place is on screen already: it does not rise again
        return <UserMessage message={u.message} session={session} enter={arrived(seen, u.message.id) && !replacesPending(u.message)} />;
      case 'turn':
        return <AssistantTurn messages={u.messages} session={session} streaming={streaming} tools={tools} results={results} known={seen} live={working && u.key === lastTurn} />;
      case 'aside':
        return <SecondOpinion message={u.message} session={session} streaming={!!streaming[u.message.id]} pending={u.pending} enter={arrived(seen, u.message.id)} />;
      case 'group':
        return u.mode === 'debate' ? <DebateGroup unit={u} session={session} streaming={streaming} known={seen} /> : <JuryGroup unit={u} session={session} streaming={streaming} enter={arrived(seen, u.members[0]?.id ?? u.key)} />;
      case 'notice':
        return <NoticeLine message={u.message} session={session} latest={u.message.id === lastNoticeId} enter={arrived(seen, u.message.id)} />;
      case 'summary':
        return <SummaryLine message={u.message} />;
    }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const { mine: m, count, tail: end } = view.current;
    const edge = m && nearEdge(m.span, count, { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight });
    if (edge) growOne(edge);
    // the bottom of what is mounted is the bottom of the log only when the newest pieces are there
    const near = end && el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stick.current = near;
    if (near !== atBottom) setAtBottom(near);
  };

  return (
    <div className="relative min-h-0 flex-1">
      {/* log-text: the conversation at the Text size of Settings, Appearance (index.css) */}
      <div ref={scroller} onScroll={onScroll} className="log-text h-full overflow-y-auto overscroll-contain" role="log" aria-label="Transcript">
        <div ref={column} data-skip-offscreen={!!mine?.core || undefined} className="mx-auto flex w-full max-w-[924px] flex-col gap-[18px] px-8 pt-5 pb-8 phone:gap-5 phone:px-4 phone:pt-4">
          <KeepPlace session={session.id} start={from} scroller={scroller} />
          <LoadingRows loading={!loaded} rows={3} />
          {loaded && units.length === 0 && !running && <EmptyChat session={session} />}
          {/* each chunk mounts into a part of its own, there before it (display: contents, so the layout is one
              column): putting an element into a parent restyles all of that parent (window.ts partsOf) */}
          {pieceParts.map(({ key, from: a, to: b }) => (
            // a chunk that mounts later, never drawn yet, starts at the average height of the first pieces (an
            // inherited property, so it is set on the chunk's part while that is still empty)
            <div key={key} className="log-part contents" style={key !== 'mid' && mine?.guess ? ({ '--log-unit-h': `${mine.guess}px` } as CSSProperties) : undefined}>
              {units.slice(a, b).map((u, j) => (
                // the last piece may still grow (a turn streams): it is never skipped
                <div key={u.key} data-unit={u.key} className={cn('log-unit', a + j === units.length - 1 && 'log-unit-last')}>
                  {unitView(u)}
                </div>
              ))}
            </div>
          ))}
          {/* what you sent while it works waits here, after the turn, in the order it will run; its message takes its place */}
          {tail && <PendingMessages session={session} items={queued} />}
          {/* the live line carries a failure too: its Knot stops and turns the fault color in place */}
          {tail && <LiveLine session={session} failure={session.status === 'error' ? <ErrorBody key={errorKey} session={session} lastPrompt={lastPrompt} enter={arrived(seen, errorKey)} /> : undefined} />}
          {/* what waits on you: approve and close the gap (spec 1.4), a card confirms in place and slides out.
              Always mounted under the newest piece, so the last card can leave too; each row carries the log's gap
              above it and the list takes the column's gap back, so an empty list adds no space and the gap leaves
              with its card */}
          {tail && (
            <GapList items={waitingItems} keyOf={(it) => it.id} className="-mt-[18px] phone:-mt-5" itemClassName="pt-[18px] phone:pt-5">
              {(it, { leaving }) =>
                it.kind === 'question' ? (
                  <LogRow time={hhmm(it.q.createdAt)}>
                    <QuestionCard question={it.q} inSession here={session.id} className="pt-0" />
                  </LogRow>
                ) : (
                  <LogRow time={hhmm(it.a.createdAt)}>
                    <ApprovalCard approval={it.a} inSession here={session.id} collapsed={collapsedOf(shape.current, it.id, leaving, it.id !== expandedId)} onExpand={() => setOpenApproval(it.id)} />
                  </LogRow>
                )
              }
            </GapList>
          )}
        </div>
      </div>
      {/* always there, so the transcript is never the last child: the button coming and going restyles nothing in it
          (a :last-child change on the scroller restyled every row of a long session, seconds of work) */}
      <div className="contents">
        {jump.mounted && (
          <button
            type="button"
            inert={jump.leaving || undefined}
            onClick={() => {
              stick.current = true;
              setAtBottom(true);
              // after a link to an early message the newest pieces may not be mounted yet: open at the end again
              if (!tail) setWin(openWin(session.id, units, list, ''));
              else scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
            }}
            className={cn(
              'absolute bottom-3 left-1/2 h-[26px] -translate-x-1/2 rounded-[var(--r-1)] border border-rule-2 bg-raise px-3 text-[12.5px] font-medium text-fg-2 hov:text-fg phone:h-9 phone:text-[14px]',
              jump.leaving ? 'anim-out' : 'anim-rise',
            )}
            style={{ boxShadow: 'var(--shadow-pop)' }}
          >
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

/** The mounted pieces of one session's transcript (window.ts). */
interface Win {
  session: string;
  span: Span;
  /** The piece a #message link lands on, and the message. */
  target: string | null;
  hash: string | null;
  /** The call a link to a tool result (or to a message of calls only) lands on. */
  tool: string | null;
  /**
   * Once filled and measured, the span the session opened with: pieces off screen may be skipped from
   * then on, and more mount in idle time. Null while it opens.
   */
  core: Span | null;
  /** The average height of the pieces it opened with, px. */
  guess?: number | null;
}

function openWin(session: string, units: Unit[], messages: Message[], hash: string): Win {
  const t = hash ? unitIndexOf(units, messages, hash) : -1;
  const tool = t >= 0 ? linkedCall(messages, hash) : null;
  // its group opens as it mounts, so the row is there to land on
  if (tool) revealOnMount(tool);
  return { session, span: openSpan(units.length, t), target: t >= 0 ? units[t].key : null, hash: t >= 0 ? hash : null, tool, core: null };
}

/**
 * The call a link to message `id` is about: the first call a tool result
 * answers, or the first call of an assistant message that has nothing but
 * calls (its piece of the turn may sit inside a group). Null otherwise.
 */
export function linkedCall(messages: readonly Message[], id: string): string | null {
  const m = messages.find((x) => x.id === id);
  if (!m) return null;
  if (isToolResultOnly(m)) {
    const r = m.content.find((b) => b.type === 'tool_result');
    return r?.type === 'tool_result' ? r.toolUseId : null;
  }
  if (m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use') && m.content.every((b) => b.type === 'tool_use' || (b.type === 'text' && !b.text.trim()))) {
    const c = m.content.find((b) => b.type === 'tool_use');
    return c?.type === 'tool_use' ? c.id : null;
  }
  return null;
}

/**
 * Each piece keeps the height it has now while it is skipped off screen
 * (.log-unit in index.css). Returns their average height, for pieces that
 * mount later.
 */
function keepHeights(pieces: HTMLElement[]): number | null {
  const cs = pieces.length ? getComputedStyle(pieces[0]) : null;
  const pad = cs ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 0;
  let sum = 0;
  let n = 0;
  for (const u of pieces) {
    const h = u.getBoundingClientRect().height - pad;
    if (h <= 0) continue;
    u.style.containIntrinsicHeight = `auto ${h}px`;
    sum += h;
    n++;
  }
  return n ? Math.round(sum / n) : null;
}

/** Run `fn` when the browser is idle (soon, at the latest; Safari has no requestIdleCallback). */
function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(fn, 120);
  return () => clearTimeout(t);
}

/**
 * Scroll anchoring where the browser has none (Safari, and the desktop app's
 * WebKit). A piece that mounted later starts at a guessed height and takes
 * its own when it first draws, as you scroll up to it; above the view, that
 * would move what is on screen, so the scroll offset takes the difference
 * back. Chromium and Firefox do this themselves (overflow-anchor).
 */
function useAnchoring(scroller: RefObject<HTMLDivElement | null>, column: RefObject<HTMLDivElement | null>, on: boolean, stick: RefObject<boolean>) {
  const observer = useRef<{ ro: ResizeObserver; watched: WeakSet<Element> } | null>(null);
  // each piece once, as it mounts (the first report only records its height: mounting above is KeepPlace's)
  const watch = () => {
    const o = observer.current;
    if (!o || !column.current) return;
    for (const u of column.current.querySelectorAll('.log-unit')) {
      if (o.watched.has(u)) continue;
      o.watched.add(u);
      o.ro.observe(u);
    }
  };
  useLayoutEffect(watch);
  useEffect(() => {
    const el = scroller.current;
    if (!on || !el || typeof ResizeObserver === 'undefined' || typeof CSS === 'undefined' || CSS.supports('overflow-anchor', 'auto')) return;
    const seen = new WeakMap<Element, number>();
    const ro = new ResizeObserver((entries) => {
      const top = el.getBoundingClientRect().top;
      let shift = 0;
      for (const e of entries) {
        const h = e.target.getBoundingClientRect().height;
        const was = seen.get(e.target);
        seen.set(e.target, h);
        if (was !== undefined && was !== h && e.target.getBoundingClientRect().top < top) shift += h - was;
      }
      if (stick.current) el.scrollTop = el.scrollHeight;
      else if (shift) el.scrollTop += shift;
    });
    observer.current = { ro, watched: new WeakSet() };
    watch();
    return () => {
      ro.disconnect();
      observer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, scroller, stick]);
}

type Place = { top: number; height: number };

/**
 * Older pieces mounting above keep what is on screen where it was: the
 * scroll offset grows by the height that came in, read just before and
 * after the commit. Where the browser's scroll anchoring already did that,
 * the offset is right and is left alone.
 */
class KeepPlace extends Component<{ session: string; start: number; scroller: RefObject<HTMLDivElement | null> }, object, Place | null> {
  override getSnapshotBeforeUpdate(prev: Readonly<{ session: string; start: number }>): Place | null {
    const el = this.props.scroller.current;
    return el && prev.session === this.props.session && this.props.start < prev.start ? { top: el.scrollTop, height: el.scrollHeight } : null;
  }
  override componentDidUpdate(_p: unknown, _s: unknown, snap: Place | null) {
    const el = this.props.scroller.current;
    if (!el || !snap) return;
    const top = snap.top + el.scrollHeight - snap.height;
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
  }
  override render() {
    return null;
  }
}

/** A new session: what it will do and where, built from the session. */
function EmptyChat({ session }: { session: Session }) {
  const device = useHub((s) => s.devices[session.device]?.name ?? session.device);
  const agent = useHub((s) => s.agents.find((a) => a.name === session.agent)?.description);
  const perm = permissionMeta(session.permissionMode).label.toLowerCase();
  const mode = session.mode;
  let line: string;
  if (mode === 'jury') line = `Ask a question. ${session.modeConfig?.jury?.jurors.length ?? 'Several'} models answer on their own, then a judge writes the verdict.`;
  else if (mode === 'debate') line = `Pose the question. ${session.modeConfig?.debate ? `${modelName(session.modeConfig.debate.a)} and ${modelName(session.modeConfig.debate.b)}` : 'Two models'} argue it out, then a judge concludes.`;
  else if (mode === 'chat') line = `Talk to ${session.agent} on ${modelName(session.model)}. No tools run in chat mode.`;
  else {
    const where = !session.cwd || session.cwd === '~' ? `on ${device} in your home folder` : `on ${device} in ${session.cwd}`;
    const how = perm === 'bypass' ? 'runs everything without asking' : perm === 'plan only' ? 'only plans, nothing runs' : perm === 'accept edits' ? 'edits files and asks before commands' : 'asks before edits and commands';
    line = `The ${session.agent} agent works ${where} and ${how}.`;
  }
  return (
    <div className="pt-6">
      <EmptyState>
        {line} Type <span className="mono text-fg">/</span> for commands or <span className="mono text-fg">@</span> for files.
        {agent && mode !== 'jury' && mode !== 'debate' && <span className="mt-1 block text-[13px] text-fg-3">{session.agent}: {agent}</span>}
      </EmptyState>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The live line: what the model is doing right now
// ---------------------------------------------------------------------------

/** `streaming` is true while a thinking block streams in (tokens flow), false while the request waits. */
type Activity = { kind: 'thinking'; streaming: boolean } | { kind: 'writing' } | { kind: 'tool'; verb: string; target: string };

const SEP = '\u0001';

/** What the running turn does now, as one string so the store selector stays cheap. */
function activityKey(s: HubState, sessionId: string): string {
  const list = s.messages[sessionId] ?? [];
  for (let i = list.length - 1; i >= Math.max(0, list.length - 6); i--) {
    const m = list[i];
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b.type === 'tool_use' && s.tools[b.id]?.status === 'running') {
        const { verb, target } = liveVerb(b);
        return ['tool', verb, target].join(SEP);
      }
    }
    if (s.streaming[m.id]) return m.content[m.content.length - 1]?.type === 'thinking' ? 'reasoning' : 'writing';
  }
  // running and nothing streams yet: the request is out, or a tool result just went back
  return 'thinking';
}

function parseActivity(key: string): Activity {
  const [kind, verb = '', target = ''] = key.split(SEP);
  if (kind === 'tool') return { kind: 'tool', verb, target };
  if (kind === 'writing') return { kind: 'writing' };
  return { kind: 'thinking', streaming: kind === 'reasoning' };
}

/** "Running bun test", "Reading src/auth.ts", "Searching the web caddy tailscale", "Checking memory". */
function liveVerb(b: Extract<Message['content'][number], { type: 'tool_use' }>): { verb: string; target: string } {
  const info = toolInfo(b);
  const target = info.target ?? '';
  if (b.name === 'WebSearch') return { verb: 'Searching the web', target };
  if (b.name === 'WebFetch') return { verb: 'Reading', target };
  if (b.name === 'Memory' || b.name.startsWith('Memory')) return { verb: 'Checking memory', target: '' };
  if (b.name === 'TodoWrite') return { verb: 'Planning', target: '' };
  if (b.name === 'Bash') return { verb: 'Running', target };
  if (info.kind === 'read') return { verb: 'Reading', target };
  if (info.kind === 'edit') return { verb: 'Editing', target };
  if (info.kind === 'search') return { verb: 'Searching', target };
  if (info.kind === 'agent') return { verb: 'Subagent working on', target };
  if (info.kind === 'fetch') return { verb: 'Fetching', target };
  return { verb: 'Running', target: target || b.name };
}

/** The word "Thinking" waits this long, so a fast first token goes straight to Writing (spec 1.3). */
const THINK_WORD_MS = 400;

/**
 * Under the last event (spec 9.3, 11.2.2, CHAT-AND-MOTION 1.3): the Knot, the
 * state in words, and tokens per second at the right while tokens flow.
 * Each state has one look:
 *
 * thinking   the Knot writes, "Thinking 4s" after 400ms
 * tool       the Knot holds and a light runs along it; Steps: "Running bun test", "Reading src/auth.ts"
 * writing    as tool; Steps: "Writing"
 * waiting    the Knot freezes in amber, "Waiting on you"
 * resuming   a grey stub, "Resumes in 1:22:03" rolling down
 * done       the Knot settles into the grey knot, "Done in 3m" in fg-3, after a turn ran here
 *
 * The line keeps one height in every state, and after a turn it holds its
 * place, so nothing in the log moves when the state changes or the turn ends.
 * The composer's Rim says the same on its edge.
 */
function LiveLine({ session, failure }: { session: Session; /** The reason and Retry when the session failed. */ failure?: ReactNode }) {
  const status = session.status;
  const failed = status === 'error' && !!failure;
  // a subagent or a workflow agent under this session waits on you: so does the turn that started it
  const below = useHub((s) => status === 'running' && (asksBelow(Object.values(s.approvals), session.id) || asksBelow(Object.values(s.questions), session.id)));
  const running = status === 'running' && !below;
  const waiting = status === 'waiting_approval' || status === 'waiting_input' || below;
  const resuming = status === 'waiting_reset';
  const live = running || waiting || resuming;
  const key = useHub((s) => (running ? activityKey(s, session.id) : ''));
  // an approval comes with the tool call it is for: the Knot freezes in the tool pose
  const toolWaits = useHub((s) => waiting && activityKey(s, session.id).startsWith('tool'));
  const lastIsNotice = useHub((s) => {
    const list = s.messages[session.id];
    return list?.[list.length - 1]?.kind === 'notice';
  });
  const startedAt = useHub((s) => turnStartedAt(s.messages[session.id], session));
  const tps = useTps(session.id, running);
  const now = useNow(1000);

  // a turn that ended while we watched: say how long it took, or keep quiet after a stop or an error.
  // Worked out in the same render as the change, so the line never drops out for a frame.
  const endRef = useRef<{ id: string; live: boolean; done: null | { startedAt: number; endedAt: number } }>({ id: session.id, live, done: null });
  if (endRef.current.id !== session.id) endRef.current = { id: session.id, live, done: null };
  else if (endRef.current.live !== live) endRef.current = { id: session.id, live, done: live ? null : { startedAt, endedAt: session.updatedAt } };

  // when the current phase started, for "Thinking 4s" and the 400ms rule; it resets in the
  // same render as the change, so a new phase never shows the last one's word or time
  // waiting for the first token and streaming a thought are one phase to the owner: "Thinking"
  const phase = `${session.id}:${running ? (key === 'reasoning' ? 'thinking' : key) : status}`;
  const phaseRef = useRef({ phase, id: 0, since: Date.now() });
  if (phaseRef.current.phase !== phase) phaseRef.current = { phase, id: phaseRef.current.id + 1, since: Date.now() };
  const { id: phaseId, since } = phaseRef.current;
  const [readyId, setReadyId] = useState(-1);
  useEffect(() => {
    const t = setTimeout(() => setReadyId(phaseId), THINK_WORD_MS);
    return () => clearTimeout(t);
  }, [phaseId]);
  const wordReady = readyId === phaseId;

  const done = live ? null : endRef.current.done;
  if (!failed && ((!live && !done) || status === 'error')) return null;

  const act = parseActivity(key);
  let state: LiveState;
  let mark: MarkState;
  let label: string | undefined;
  let liveSince: number | undefined;
  let endedAt: number | undefined;
  let resumeAt: number | undefined;
  if (running) {
    state = act.kind;
    mark = act.kind === 'thinking' ? 'thinking' : 'working';
    if (act.kind === 'tool') {
      label = act.verb;
    }
    if (act.kind === 'thinking' && now - since >= 1000) liveSince = since;
  } else if (waiting) {
    state = 'waiting';
    mark = 'waiting';
    label = status === 'waiting_input' ? 'Waiting on your answer' : 'Waiting on you';
  } else if (resuming) {
    state = 'resuming';
    mark = 'paused';
    resumeAt = session.resumeAt;
    if (!resumeAt) label = 'Resumes when the limit resets';
  } else if (failed) {
    state = 'failed';
    mark = 'failed';
  } else {
    state = 'done';
    mark = 'idle';
    liveSince = done!.startedAt;
    endedAt = done!.endedAt;
  }
  // after a stop the notice says it; the line keeps its place, empty
  const quiet = !live && !failed && lastIsNotice;
  const words = !(running && act.kind === 'thinking' && !wordReady);
  // tokens per second only while tokens flow, never left over from the last burst
  const flowing = running && (act.kind === 'writing' || (act.kind === 'thinking' && act.streaming));

  // tools and writing are steps: the old one leaves before the new one arrives
  const step = running && (act.kind === 'tool' || act.kind === 'writing') ? (act.kind === 'tool' ? { verb: act.verb, target: act.target || undefined } : { id: 'writing', verb: 'Writing' }) : undefined;

  return (
    // the Knot keeps its place in the tree in every state, so it is one element from thinking to done or failed
    <LogRow className="anim-fade" time={failed ? hhmm(session.updatedAt) : undefined}>
      <div className={cn(failed ? 'py-1' : 'pt-1', quiet && 'invisible')} aria-hidden={quiet || undefined}>
        <div className={cn('flex gap-3 text-[12px] leading-[1.4] phone:text-[13px]', failed ? 'items-start' : 'min-h-[20px] items-center')}>
          <span className={cn('flex min-w-0 gap-2', failed ? 'items-start' : 'items-center')}>
            <Knot state={mark} via={toolWaits ? 'tool' : undefined} size={14} className={failed ? 'mt-[3px] shrink-0 phone:mt-[4px]' : undefined} />
            {failed && failure}
            {!failed &&
              words &&
              (step ? (
                <Steps step={step} className="min-w-0" />
              ) : state === 'resuming' && resumeAt ? (
                <LiveStatus state="resuming" resumeAt={resumeAt} countdown mark={false} />
              ) : (
                <LiveStatus state={state} label={label} startedAt={liveSince} endedAt={endedAt} mark={false} className={cn('min-w-0', running && act.kind === 'thinking' && 'anim-fade')} />
              ))}
          </span>
          <span className="num ml-auto shrink-0 text-fg-3" aria-hidden>
            {flowing && tps > 0 ? (
              <>
                <Roll value={tps} /> tokens per second
              </>
            ) : (
              ''
            )}
          </span>
        </div>
      </div>
    </LogRow>
  );
}

/** Whether an approval card shows collapsed: what it is now, or, while it slides out, what it was. */
function collapsedOf(memo: Map<string, boolean>, id: string, leaving: boolean, now: boolean): boolean {
  if (leaving) return memo.get(id) ?? now;
  memo.set(id, now);
  return now;
}
