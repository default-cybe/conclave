/**
 * A session on a phone (docs/design/MOBILE-V2.md 5). Your messages are
 * bubbles at the right; the agent writes plain text at full width with no
 * name or model line. The thoughts and calls between two pieces of text
 * fold into one quiet line, "Thought for 15s, ran git log" or "Ran 2
 * commands, read 3 files", as on desktop (toolGroups.ts, CHAT-AND-MOTION
 * 6.3), that opens to them in order; a single call is its own row and a
 * lone thought stays as it is; a row opens its diff or output in a sheet.
 * A workflow and a subagent are each one compact row that follows the work
 * live ("Workflow deep-research, 3 of 6 agents running", "Subagent explore:
 * Find the auth code, searching for jwt") and opens in place to the run's
 * phases and agents or to the subagent's answer. While the agent works
 * the line it works on stays closed, as on Android, and says the step it is
 * at ("Running bun test", "Thinking"); a closed line keeps any call that
 * waits on you in view. The last line is the mark and a word or two
 * ("Running bun test"); what waits on you sits at the end as a permission
 * prompt or a question, a subagent's or a workflow agent's too, with who
 * asks above it (lib/asks.ts). Under every finished turn: copy, retry and
 * more, always in view, quieter under earlier turns (ReplyIcons.tsx). A
 * long press selects text, as anywhere else on the phone; it opens nothing.
 * No tokens, costs or times: those are in the sheet.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ChevronRight } from 'lucide-react';
import type { Message, Session, ToolUseBlock } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, toolResultsFor, upsertSession, useHub, useQueue } from '@/store/store';
import { cn } from '@/lib/text';
import { fileName, hhmm } from '@/lib/format';
import { useReducedMotion } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { asksOf } from '@/lib/asks';
import { changeWords, lowerFirst, toolRowWords, workingWords, workSummary } from '@/lib/toolLine';
import { ApprovalCard } from '@/components/inbox/ApprovalCard';
import { QuestionCard } from '@/components/inbox/QuestionCard';
import { Checkbox } from '@/components/ui/Field';
import { CodeBlock, Diff } from '@/components/ui/Code';
import { ConfirmDialog, MenuList, Popover, Sheet } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';
import { ModelList } from '@/components/pickers/ModelPicker';
import { Elapsed, GapList, Knot, LiveStatus, usePresence } from '@/components/motion';
import { BubbleText } from '@/components/ui/Bubble';
import { BlockView, SecondOpinion, turnPieces } from './Turn';
import { Markdown } from './Markdown';
import { DebateGroup, JuryGroup } from './Group';
import { ErrorBody, NoticeLine, SummaryLine } from './Notices';
import { buildUnits } from './MessageList';
import { PhonePending, storedWord } from './Pending';
import { callMs, callStatus, editFiles, groupNow, Terminal, took, useSubagent, useSubagentNow, useToolState, useWaitingKey, webResults, workSteps, type ThoughtItem, type ToolItem, type WorkItem } from './ToolRows';
import { groupState, pinned, segment, troubleWords, workName } from './toolGroups';
import { FanOutCard, useFolded } from './FanOutCard';
import { TASK_TOOLS, taskToolWords } from './fanOut';
import { WorkflowRow } from '../workflows/WorkflowCard';
import { MapsCards } from '../maps/MapsCard';
import { WatchCards } from '../watches/WatchCards';
import { isContextOnly, isToolResultOnly, msgText, resultText } from './util';
import { canSend, SendToFriendDialog } from '../friends/SendToFriend';
import { ReplyIcons } from '../conversation/ReplyIcons';

export function PhoneTranscript({ session }: { session: Session }) {
  const messages = useHub((s) => s.messages[session.id]);
  const loaded = useHub((s) => s.messagesLoaded[session.id]);
  const streaming = useHub((s) => s.streaming);
  const tools = useHub((s) => s.tools);
  const approvalMap = useHub((s) => s.approvals);
  const questionMap = useHub((s) => s.questions);
  // what you sent while it works, after the turn that runs (Pending.tsx)
  const queued = useQueue(session.id);
  const list = useMemo(() => messages ?? [], [messages]);
  const units = useMemo(() => buildUnits(list, session), [list, session]);
  const results = useMemo(() => toolResultsFor(list), [list]);
  // its own, and those of its subagents and workflow agents
  const asks = useMemo(
    () => [
      ...asksOf(Object.values(questionMap), session.id).map((q) => ({ kind: 'question' as const, id: q.id, q })),
      ...asksOf(Object.values(approvalMap), session.id).map((a) => ({ kind: 'approval' as const, id: a.id, a })),
    ],
    [questionMap, approvalMap, session.id],
  );
  const lastPrompt = useMemo(() => {
    const u = [...list].reverse().find((m) => m.role === 'user' && !isToolResultOnly(m) && !isContextOnly(m));
    return u ? msgText(u) : undefined;
  }, [list]);
  const lastTurn = useMemo(() => {
    for (let i = units.length - 1; i >= 0; i--) if (units[i].kind === 'turn') return units[i].key;
    return undefined;
  }, [units]);
  const live = session.status === 'running' || session.status === 'waiting_approval' || session.status === 'waiting_input' || session.status === 'waiting_reset';
  const reduced = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const jump = usePresence(!atBottom);

  // stick to the bottom while new content streams in
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // a session opens at the bottom; #ask-<id> (from the Inbox) or a message id scrolls to it
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
    const hash = window.location.hash.slice(1);
    if (!hash || !loaded) return;
    const raf = requestAnimationFrame(() => {
      const target = document.getElementById(hash.startsWith('ask-') ? hash : `msg-${hash}`);
      if (!target) return;
      stick.current = false;
      setAtBottom(false);
      target.scrollIntoView({ block: hash.startsWith('ask-') ? 'end' : 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [session.id, loaded]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stick.current = near;
    if (near !== atBottom) setAtBottom(near);
  };

  return (
    <div className="relative min-h-0 flex-1">
      {/* log-text: the conversation at the Text size of Settings, Appearance (index.css) */}
      <div ref={scroller} onScroll={onScroll} className="log-text h-full overflow-y-auto overscroll-contain" role="log" aria-label="Transcript">
        <div className="flex flex-col gap-5 px-5 pt-2 pb-6">
          <LoadingRows loading={!loaded} rows={3} />
          {loaded && units.length === 0 && !live && <Empty session={session} />}
          {units.map((u) => {
            switch (u.kind) {
              case 'user':
                return <Bubble key={u.key} message={u.message} />;
              case 'turn':
                return <Turn key={u.key} messages={u.messages} session={session} streaming={streaming} tools={tools} results={results} last={u.key === lastTurn} done={!(u.key === lastTurn && live)} working={u.key === lastTurn && live && session.status !== 'waiting_reset'} />;
              case 'aside':
                return <SecondOpinion key={u.key} message={u.message} session={session} streaming={!!streaming[u.message.id]} pending={u.pending} />;
              case 'group':
                return u.mode === 'debate' ? <DebateGroup key={u.key} unit={u} session={session} streaming={streaming} /> : <JuryGroup key={u.key} unit={u} session={session} streaming={streaming} />;
              case 'notice':
                return <NoticeLine key={u.key} message={u.message} session={session} latest={u === units[units.length - 1]} />;
              case 'summary':
                return <SummaryLine key={u.key} message={u.message} />;
            }
          })}
          <PhonePending session={session} items={queued} />
          {/* waiting on you, the card below says so */}
          {!asks.length && <Working session={session} failure={session.status === 'error' ? <ErrorBody session={session} lastPrompt={lastPrompt} /> : undefined} />}
          {/* what waits on you, at the end like a permission prompt; it slides out once answered */}
          <GapList items={asks} keyOf={(it) => it.id} className="-mt-5" itemClassName="pt-5">
            {(it) => (it.kind === 'question' ? <QuestionCard question={it.q} inSession here={session.id} className="py-0!" /> : <ApprovalCard approval={it.a} inSession here={session.id} />)}
          </GapList>
        </div>
      </div>
      {jump.mounted && (
        <button
          type="button"
          inert={jump.leaving || undefined}
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
          }}
          className={cn('absolute bottom-3 left-1/2 h-9 -translate-x-1/2 rounded-full bg-surface-2 px-4 text-[14px] font-medium text-fg-2 light:border light:border-rule', jump.leaving ? 'anim-out' : 'anim-rise')}
          style={{ boxShadow: 'var(--shadow-pop)' }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** A new session: where the agent works, in one quiet line. */
function Empty({ session }: { session: Session }) {
  const device = useHub((s) => s.devices[session.device]?.name ?? session.device);
  const where = !session.cwd || session.cwd === '~' ? 'in your home folder' : `in ${fileName(session.cwd)}`;
  return <p className="m-0 pt-6 text-center text-[15px] leading-[1.45] text-fg-3">The {session.agent} agent works on {device} {where}. Tell it what to do.</p>;
}

// ---------------------------------------------------------------------------
// Your message
// ---------------------------------------------------------------------------

/** Your words in a bubble at the right: surface-2, radius 20, at most 85% wide, your markdown as on desktop. A long press selects the text. */
export const Bubble = memo(function Bubble({ message }: { message: Message }) {
  const text = msgText(message);
  const images = message.content.filter((b): b is Extract<Message['content'][number], { type: 'image' }> => b.type === 'image');
  // sent while it worked: "Queued" or "Steered the running turn", where the pending one said it (Pending.tsx)
  const busyWord = storedWord(message.meta?.whenBusy);
  return (
    <div id={`msg-${message.id}`} data-author="you" className="flex flex-col items-end gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((img, i) => (
            <img key={i} src={img.url ?? `data:${img.mediaType};base64,${img.data}`} alt="Attached image" className="max-h-40 max-w-[240px] rounded-[14px] object-cover" />
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[85%] rounded-[20px] bg-surface-2 px-4 py-2.5 text-fg">
          <BubbleText text={text}>
            <Markdown text={text} />
          </BubbleText>
        </div>
      )}
      {busyWord && <span className="flex items-center px-1 text-[13px] text-fg-3">{busyWord}</span>}
    </div>
  );
});

// ---------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------

/**
 * The agent's text in order, and each stretch of thoughts and calls between
 * two pieces of text as one line (one row for a single call, a lone thought
 * as its folded line). `done`: the session is not at work on it, so it ends
 * with copy, retry and more; `last`: the latest turn, whose row is in fg-3
 * (earlier ones are quieter). `working`: the session is at work on this turn.
 */
const Turn = memo(function Turn({
  messages,
  session,
  streaming,
  tools,
  results,
  last,
  done,
  working,
}: {
  messages: Message[];
  session: Session;
  streaming: Record<string, true>;
  tools: ReturnType<typeof useHub.getState>['tools'];
  results: ReturnType<typeof toolResultsFor>;
  last: boolean;
  done: boolean;
  working: boolean;
}) {
  const folded = useFolded(session.id);
  const pieces = turnPieces(messages, streaming, results, tools, folded);
  if (!pieces.length) return null;
  // the work the turn is still at: no prose after it yet
  let lastProse = -1;
  pieces.forEach((p, i) => {
    if (p.type === 'block' && p.block.type !== 'thinking' && p.block.type !== 'redacted_thinking') lastProse = i;
  });
  const text = messages.map(msgText).filter(Boolean).join('\n\n');
  return (
    <div className="flex flex-col gap-1">
      {pieces.map((p, i) =>
        p.type === 'work' ? (
          <PhoneWork key={p.key} entries={p.entries} sessionId={session.id} live={working && i > lastProse} />
        ) : (
          <div key={p.key} id={`msg-${p.msg.id}`} className="md-phone">
            <BlockView block={p.block} streaming={!!streaming[p.msg.id] && p.isLast} />
          </div>
        ),
      )}
      {done && <TurnIcons session={session} messages={messages} text={text} quiet={!last} />}
    </div>
  );
});

function PhoneThought({ item }: { item: ThoughtItem }) {
  return (
    <div className="md-phone">
      <BlockView block={item.block} streaming={!!item.streaming} />
    </div>
  );
}

/** A stretch of work: single calls as rows, a workflow and a subagent as one live row each, the rest as one line (the same groups as desktop). */
export function PhoneWork({ entries, sessionId, live }: { entries: WorkItem[]; sessionId: string; live: boolean }) {
  const segs = useMemo(() => segment(entries), [entries]);
  const results = entries.flatMap((e) => (e.type === 'call' ? [e.item.result ?? e.item.run?.result] : []));
  return (
    <div className="-my-0.5">
      {segs.map((g, i) =>
        g.kind === 'fanout' ? (
          <FanOutCard key={`f:${g.items[0].tool.id}`} items={g.items} sessionId={sessionId} />
        ) : g.kind === 'one' ? (
          <OneCall key={g.item.tool.id} item={g.item} sessionId={sessionId} />
        ) : g.kind === 'thought' ? (
          <PhoneThought key={g.item.key} item={g.item} />
        ) : (
          <PhoneGroup key={g.entries.find((e) => e.type === 'call')?.item.tool.id ?? i} entries={g.entries} live={live && i === segs.length - 1} />
        ),
      )}
      {/* places, routes and maps sit under the calls, open or not */}
      <MapsCards results={results} className="mt-0.5 mb-1.5" />
      <WatchCards results={results} sessionId={sessionId} className="mt-0.5 mb-1.5" />
    </div>
  );
}

/** Two or more thoughts and calls as one sentence with their state and a chevron; open, them in order. */
function PhoneGroup({ entries, live }: { entries: WorkItem[]; live: boolean }) {
  const calls = useMemo(() => entries.flatMap((e) => (e.type === 'call' ? [e.item] : [])), [entries]);
  const ids = useMemo(() => calls.map((c) => c.tool.id), [calls]);
  const waitingKey = useWaitingKey(ids);
  const statuses = calls.map((c) => callStatus(c, waitingKey.includes(`${c.tool.id} `)));
  const state = groupState(statuses);
  const now = groupNow(entries, (c) => statuses[calls.indexOf(c)], live);
  const sentence = now ?? workSummary(workSteps(entries));
  // null: closed, as the finished turn shows it; true or false: you chose, and it stays so as the turn goes on
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? false;
  const held = open ? [] : calls.filter((_, i) => pinned(statuses[i]));
  const stat =
    state.state === 'waiting' ? (
      <span className="text-warn">waiting</span>
    ) : state.state === 'running' || now ? (
      <span className="text-signal">running</span>
    ) : state.failed || state.denied ? (
      <span className={state.failed ? 'text-fault' : undefined}>{troubleWords(state)}</span>
    ) : null;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setChosen(!open)} className="flex min-h-11 w-full items-center gap-3 text-left tx-15 text-fg-3 active:text-fg-2">
        <span className={cn('min-w-0 flex-1 truncate', now && 'text-signal')}>{sentence}</span>
        {stat && <span className="num shrink-0 tx-14">{stat}</span>}
        <ChevronRight aria-hidden strokeWidth={2} className={cn('size-4 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)]', open && 'rotate-90')} />
      </button>
      {(open || held.length > 0) && (
        <ul className={cn('m-0 mb-1 list-none border-l border-rule p-0 pl-3', open && chosen && 'anim-fade')}>
          {open
            ? entries.map((e) =>
                e.type === 'call' ? (
                  <li key={e.item.tool.id}>
                    <CallRow item={e.item} />
                  </li>
                ) : (
                  <li key={e.item.key}>
                    <PhoneThought item={e.item} />
                  </li>
                ),
              )
            : held.map((c) => (
                <li key={c.tool.id}>
                  <CallRow item={c} />
                </li>
              ))}
        </ul>
      )}
    </div>
  );
}

/** A call on its own: a workflow's or a subagent's live row, else its row that opens a sheet. */
function OneCall({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const kind = workName(item.tool.name, item.tool.input);
  if (kind === 'Workflow') return <WorkflowRow tool={item.tool} result={item.result ?? item.run?.result} sessionId={sessionId} startedAt={item.run?.startedAt} layout="phone" />;
  if (kind === 'Task') return <FanOutCard items={[item]} sessionId={sessionId} />;
  return <CallRow item={item} />;
}

/** One call: the verb, the file name or the command, and what came of it ("+2 −0", "failed"). A tap opens what it did. */
function CallRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const { tool } = item;
  const { res, status } = useToolState(item);
  const files = useMemo(() => (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool.name) ? editFiles(tool, res) : []), [tool, res]);
  // a task tool no card holds: words, never its session ids, and no sheet of them
  const task = TASK_TOOLS.has(tool.name);
  const words = task ? { ...taskToolWords(tool.name, tool.input, res ? resultText(res) : undefined), mono: false } : toolRowWords(tool);
  let stat: ReactNode = null;
  if (status === 'running')
    stat = (
      <span className="text-signal">
        <Elapsed since={item.run?.startedAt} format="short" />
      </span>
    );
  else if (status === 'waiting') stat = <span className="text-warn">waiting</span>;
  else if (status === 'failed') stat = <span className="text-fault">failed</span>;
  else if (status === 'denied') stat = 'denied';
  else if (files.length) stat = changeWords(files.reduce((n, f) => n + f.added, 0), files.reduce((n, f) => n + f.removed, 0));
  const output = res ? resultText(res) : (item.run?.progress ?? '');
  const opens = !task && (files.length > 0 || !!output.trim());
  const row = (
    <>
      <span className="shrink-0 text-fg-2">{words.verb}</span>
      <span className={cn('min-w-0 flex-1 truncate text-fg-2', words.mono && 'font-mono tx-14')}>{words.target}</span>
      {stat && <span className="num shrink-0 tx-14 text-fg-3">{stat}</span>}
      {opens && <ChevronRight aria-hidden strokeWidth={2} className="size-4 shrink-0 text-fg-4" />}
    </>
  );
  const cls = 'flex min-h-11 w-full items-center gap-3 text-left tx-15';
  if (!opens) return <div className={cls}>{row}</div>;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn(cls, 'active:bg-hover')}>
        {row}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={<CallTitle tool={tool} />}>
        <div className="px-4 pb-4">
          <CallBody item={item} files={files} output={output} />
        </div>
      </Sheet>
    </>
  );
}

function CallTitle({ tool }: { tool: ToolUseBlock }) {
  const w = toolRowWords(tool);
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0">{w.verb}</span>
      <span className={cn('min-w-0 truncate', w.mono ? 'font-mono text-[15px] font-normal' : 'font-normal')}>{w.target}</span>
    </span>
  );
}

function CallBody({ item, files, output }: { item: ToolItem; files: ReturnType<typeof editFiles>; output: string }) {
  const { tool } = item;
  const res = item.result ?? item.run?.result;
  if (files.length)
    return (
      <div className="space-y-3">
        {files.map((f, i) => (
          <Diff key={`${f.path}${i}`} file={f} header={files.length > 1} />
        ))}
      </div>
    );
  if (tool.name === 'Bash') return <Terminal output={output || ' '} tone={res?.isError ? 'fault' : undefined} exitCode={typeof res?.meta?.exitCode === 'number' ? res.meta.exitCode : undefined} />;
  const sources = tool.name === 'WebSearch' ? webResults(res) : [];
  if (sources.length)
    return (
      <ol className="m-0 list-none space-y-1 p-0">
        {sources.map((r, i) => (
          <li key={`${r.url}${i}`}>
            <a href={r.url} target="_blank" rel="noreferrer noopener" className="flex min-h-11 flex-col justify-center text-[15px] text-fg">
              <span className="truncate">{r.title}</span>
            </a>
          </li>
        ))}
      </ol>
    );
  return <CodeBlock code={output} copy maxLines={40} wrap={tool.name !== 'Read'} />;
}

// ---------------------------------------------------------------------------
// The working line
// ---------------------------------------------------------------------------

/** The call running now, if any, among the last messages. */
function useRunningCall(sessionId: string, on: boolean): ToolUseBlock | undefined {
  return useHub((s) => {
    if (!on) return undefined;
    const list = s.messages[sessionId] ?? [];
    for (let i = list.length - 1; i >= Math.max(0, list.length - 6); i--) {
      const m = list[i];
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (b.type === 'tool_use' && s.tools[b.id]?.status === 'running') return b;
      }
    }
    return undefined;
  });
}

/**
 * The last line while the agent works: the mark, moving, and a word or two.
 * "Running bun test" while a call runs, "Writing" while text streams, else
 * "Working". Waiting on you, the mark holds in amber; a limit counts down to
 * when it resumes; a failure says why with Retry.
 */
function Working({ session, failure }: { session: Session; failure?: ReactNode }) {
  const status = session.status;
  const running = status === 'running';
  const call = useRunningCall(session.id, running);
  const writing = useHub((s) => {
    if (!running) return false;
    const list = s.messages[session.id] ?? [];
    const m = list[list.length - 1];
    return !!m && !!s.streaming[m.id] && m.content[m.content.length - 1]?.type === 'text';
  });
  if (status === 'error' && failure)
    return (
      <div className="flex items-start gap-2.5">
        <Knot state="failed" size={16} className="mt-[3px] shrink-0" />
        {failure}
      </div>
    );
  if (status === 'waiting_reset')
    return (
      <div className="flex min-h-6 items-center tx-15 text-fg-3">
        <LiveStatus state="resuming" resumeAt={session.resumeAt} countdown={!!session.resumeAt} label={session.resumeAt ? undefined : 'Resumes when the limit resets'} size={16} />
      </div>
    );
  if (!running && status !== 'waiting_approval' && status !== 'waiting_input') return null;
  const waiting = !running;
  const words = waiting ? 'Waiting for you' : call ? workingWords(call) : writing ? 'Writing' : 'Working';
  return (
    <div role="status" className="flex min-h-6 items-center gap-2.5 tx-15">
      <Knot state={waiting ? 'waiting' : call || writing ? 'tool' : 'thinking'} via={waiting ? 'tool' : undefined} size={16} />
      <span className={cn('min-w-0 truncate', waiting ? 'text-warn' : 'text-fg-2')}>{words}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy, retry, more
// ---------------------------------------------------------------------------

/**
 * Under each finished turn: copy its text, run the message it answers again,
 * `extra` (one more action when it applies, "Try the next model" on a
 * refused turn) and the rest in a menu. `quiet`: an earlier turn.
 */
export function TurnIcons({ session, messages, text, quiet, extra }: { session: Session; messages: Message[]; text: string; quiet?: boolean; extra?: ReactNode }) {
  const [, navigate] = useLocation();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [pick, setPick] = useState<'ask' | null>(null);
  const [retry, setRetry] = useState(false);
  const [rewind, setRewind] = useState(false);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState(true);
  const last = messages[messages.length - 1];
  const all = useHub((s) => s.messages[session.id]);
  // the message this turn answers
  const user = useMemo(() => {
    const list = all ?? [];
    const at = list.findIndex((m) => m.id === messages[0]?.id);
    for (let i = at - 1; i >= 0; i--) if (list[i].role === 'user' && !isToolResultOnly(list[i]) && !isContextOnly(list[i])) return list[i];
    return undefined;
  }, [all, messages]);
  const later = (fn: () => void) => () => setTimeout(fn, 0);

  const fork = async () => {
    const s = await attempt(() => api().forkSession(session.id, last.seq));
    if (s) {
      upsertSession(s);
      navigate(`/s/${s.id}`);
    }
  };
  const onPick = async (m: string) => {
    setPick(null);
    await attempt(() => api().secondOpinion(session.id, { reviewer: m, messageId: last.id }), `Asked ${modelName(m)} for a second opinion.`);
  };

  return (
    <div className="flex items-center">
      <ReplyIcons ref={more} text={text} onRetry={user ? () => setRetry(true) : undefined} onMore={() => setMenu(true)} moreOpen={menu} quiet={quiet} extra={extra} moreLabel="More" />
      <Popover anchor={more} open={menu} onClose={() => setMenu(false)} label="Turn actions" sheetTitle={hhmm(last.createdAt)}>
        <MenuList
          onDone={() => setMenu(false)}
          label="Turn actions"
          items={[
            { label: 'Ask another model', onSelect: later(() => setPick('ask')) },
            { label: 'Fork from here', onSelect: fork },
            { label: 'Rewind to here', onSelect: later(() => setRewind(true)) },
            ...(canSend(session) ? [{ label: 'Send to friend…', onSelect: later(() => setSending(true)) }] : []),
          ]}
        />
      </Popover>
      <SendToFriendDialog session={session} open={sending} onClose={() => setSending(false)} />
      <Popover anchor={more} open={!!pick} onClose={() => setPick(null)} label="Ask another model" sheetTitle="Second opinion from">
        <ModelList onChange={onPick} onDone={() => setPick(null)} />
      </Popover>
      <ConfirmDialog
        open={retry}
        onClose={() => setRetry(false)}
        tone="neutral"
        title="Run your message again?"
        body="This turn and what came after it leave the session, then your message goes again."
        confirm="Retry"
        busy="Retrying"
        onConfirm={async () => {
          if (!user) return;
          const s = await attempt(() => api().rewind(session.id, user.seq - 1, files));
          if (!s) return;
          upsertSession(s);
          await attempt(() => api().send(session.id, { text: msgText(user) }));
        }}
      >
        <Checkbox className="mt-3" checked={files} onChange={setFiles} label="Restore files too" description="Undo file changes made in this turn." />
      </ConfirmDialog>
      <ConfirmDialog
        open={rewind}
        onClose={() => setRewind(false)}
        tone="danger"
        title={`Rewind to ${hhmm(last.createdAt)}?`}
        body="Messages after this turn leave the session. A fork keeps them if you want both."
        confirm="Rewind"
        busy="Rewinding"
        onConfirm={async () => {
          const s = await attempt(() => api().rewind(session.id, last.seq, files));
          if (s) upsertSession(s);
        }}
      >
        <Checkbox className="mt-3" checked={files} onChange={setFiles} label="Restore files too" description="Undo file changes made after this turn." />
      </ConfirmDialog>
    </div>
  );
}
