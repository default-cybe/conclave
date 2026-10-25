/**
 * A reply on the Chat page (docs/design/CHAT-AND-MOTION.md 2.6): plain prose
 * at full column width, no bubble, no author line. In order: the thinking
 * row, tool rows, the text, sources, then the action row. While it is being
 * written the mark says what the model is doing (spec 1.3): it thinks at the
 * first line before anything arrives, works at the foot while text streams,
 * and settles into the still mark when the reply is done.
 *
 * Phones (docs/design/MOBILE-V2.md 5): the reply's tool rows fold into one
 * line ("Checked memory, searched the web") that opens to them, and every
 * finished reply ends with its actions as icons, always in view: copy,
 * retry, more (ReplyIcons.tsx), quieter under earlier replies. A long press
 * selects the reply's text, as anywhere else on the phone; it opens nothing.
 */
import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import type { ContentBlock, Message, Session, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, useHub, type ToolRun } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useCopy, useIsMobile } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { toolLine, toolRowWords } from '@/lib/toolLine';
import { ModelName } from '@/components/logo';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { ConfirmDialog, MenuList, Popover } from '@/components/ui/Overlay';
import { ModelList } from '@/components/pickers/ModelPicker';
import { Fold, InkReveal, Knot, LiveStatus, Steps, Swap, type MarkState, type Step } from '@/components/motion';
import { readDismissed, resultText, writeDismissed } from '@/features/chat/util';
import { canSend, SendToFriendDialog } from '@/features/friends/SendToFriend';
import { ReplyIcons } from './ReplyIcons';
import { ChatMarkdown } from './ChatMarkdown';
import { MapsCards, MapsLine } from '@/features/maps/MapsCard';
import { FileCards, FileLine } from '@/features/files/FileCard';
import { WatchCards, WatchLine } from '@/features/watches/WatchCards';
import { mapsWorkingWords } from '@/features/maps/words';
import { DelegateCallLine } from '@/features/chat/delegated';
import { FanOutNotice } from '@/features/chat/FanOutCard';
import { noticeResult } from '@/features/chat/agentResult';
import { useModelThinks } from './ChatComposer';
import { branchChat, forgetNote, patchChat, retryFrom } from './actions';
import { openContinue, setAsking, useChatUi } from './state';
import { findNote, host, lastSeq, parseNotes, replyLast, replyResults, replySources, replyText, str, type Phase, type ReplyUnit } from './units';

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** A quiet text action under a message (12.5px fg-3, hover fg). */
export function Act({ children, onClick, active, className, btnRef, label }: { children: ReactNode; onClick: () => void; active?: boolean; className?: string; btnRef?: React.Ref<HTMLButtonElement>; label?: string }) {
  return (
    <button
      ref={btnRef}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'h-[26px] rounded-[var(--r-1)] px-1.5 text-[12.5px] font-[450] whitespace-nowrap transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg phone:h-10 phone:px-2.5 phone:text-[14px]',
        active ? 'bg-hover text-fg' : 'text-fg-3',
        className,
      )}
    >
      {children}
    </button>
  );
}

const measured = new Map<string, { start: number; end?: number }>();

/** "Thought for 12s": stored on the block; while it streams, timed here. */
function thoughtMs(key: string, block: Extract<ContentBlock, { type: 'thinking' }>, live: boolean): number | undefined {
  const rec = measured.get(key);
  if (live && !rec) measured.set(key, { start: Date.now() });
  if (!live && rec && !rec.end) rec.end = Date.now();
  if (block.durationMs) return block.durationMs;
  const r = measured.get(key);
  return r?.end ? r.end - r.start : undefined;
}

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

/** The empty thought the Fold row shows before the first words of a thought arrive. */
const NO_THOUGHT: Extract<ContentBlock, { type: 'thinking' }> = { type: 'thinking', thinking: '' };

/**
 * The thought row (Fold, spec 1.4 and 2.6). While the thought streams the
 * row reads "Thinking" in violet over it, and the new words come in with
 * Ink. In the same render the answer starts, `live` turns false: the row
 * turns into "Thought for 12s" and the thought folds closed while what
 * follows rises into its place. A click opens it again.
 */
function ThoughtFold({ block, keyId, live, late }: { block: Extract<ContentBlock, { type: 'thinking' }>; keyId: string; live: boolean; late?: boolean }) {
  const ms = keyId ? thoughtMs(keyId, block, live) : undefined;
  const text = block.thinking;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const label = ms !== undefined ? `Thought for ${seconds(ms)}` : `Thought, ${words} ${words === 1 ? 'word' : 'words'}`;
  return (
    <Fold live={live} label={label} className={cn('cv-thought py-0.5', late && 'cv-thought-late')}>
      <InkReveal active={live} className="max-w-[72ch] whitespace-pre-wrap">
        {text.trim()}
      </InkReveal>
    </Fold>
  );
}

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

function Expand({ label, tone, children, defaultOpen = false }: { label: ReactNode; tone?: 'fault'; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="py-0.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn('group/tool inline-flex min-h-[25px] max-w-full items-center gap-1 rounded-[var(--r-1)] text-left tx-12.5 hov:text-fg phone:tx-13.5', tone === 'fault' ? 'text-fault' : 'text-fg-3')}>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight aria-hidden strokeWidth={1.75} className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)] group-hover/tool:text-fg-3', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-1 mb-1.5 anim-fade">{children}</div>}
    </div>
  );
}

/** Phones: a reply's tool rows as one quiet line that opens to them. */
function ToolFold({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-11 max-w-full items-center gap-1.5 text-left tx-15 text-fg-3 active:text-fg-2">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight aria-hidden strokeWidth={2} className={cn('size-4 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)]', open && 'rotate-90')} />
      </button>
      {open && <div className="mb-2 anim-fade">{children}</div>}
    </div>
  );
}

function Line({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-h-[25px] items-center py-0.5 tx-12.5 text-fg-3 phone:tx-13.5', className)}>{children}</div>;
}

/** What a running tool is doing, for the status line at the reply's foot (Steps). */
function toolStep(tool: ToolUseBlock): Step {
  const i = tool.input ?? {};
  switch (tool.name) {
    case 'WebSearch':
      return { id: tool.id, verb: 'Searching the web', target: str(i.query) };
    case 'WebFetch':
      return { id: tool.id, verb: 'Reading', target: host(str(i.url) ?? '') || undefined };
    case 'MemorySearch':
      return { id: tool.id, verb: 'Checking memory' };
    case 'MemorySave':
      return { id: tool.id, verb: 'Saving to memory' };
    case 'MemoryForget':
      return { id: tool.id, verb: 'Retiring a note' };
    case 'PlaceSearch':
    case 'PlaceDetails':
    case 'Directions':
    case 'MapImage':
      return { id: tool.id, verb: mapsWorkingWords(tool.name)! };
    case 'WatchReport':
      return { id: tool.id, verb: 'Showing what it found' };
    case 'WatchCreate':
      return { id: tool.id, verb: 'Making the watch' };
    default:
      // the browser: "Opening facebook.com", "Reading the page"
      if (tool.name.startsWith('browser_')) return { id: tool.id, verb: tool.name === 'browser_navigate' ? 'Opening' : 'Reading the page', target: tool.name === 'browser_navigate' ? host(str(i.url) ?? '') || undefined : undefined };
      return { id: tool.id, verb: `Using ${tool.name.replace(/^mcp__/, '').replace(/__/g, ' ')}` };
  }
}

/** The step for every tool still running in the reply: several pages read at once are one step, "Reading 3 pages". */
export function runningStep(tools: ToolUseBlock[]): Step | undefined {
  if (!tools.length) return undefined;
  if (tools.length > 1 && tools.every((t) => t.name === 'WebFetch')) {
    const hosts = [...new Set(tools.map((t) => host(str(t.input?.url) ?? '')).filter(Boolean))];
    return { id: tools.map((t) => t.id).join(' '), verb: `Reading ${tools.length} pages`, target: hosts.join(', ') || undefined };
  }
  return toolStep(tools[tools.length - 1]);
}

/** A tool's row once it has a result. While it runs the status line at the foot says what it does. */
function ToolLine({ tool, result, run, live, messages, results, folded }: { tool: ToolUseBlock; result?: ToolResultBlock; run?: ToolRun; live: boolean; messages: Message[]; results: Record<string, ToolResultBlock>; folded?: boolean }) {
  const [undone, setUndone] = useState(false);
  const res = result ?? run?.result;
  const running = !res && live;
  const failed = !!res?.isError;
  const i = tool.input ?? {};

  switch (tool.name) {
    case 'WebSearch': {
      const q = str(i.query);
      if (running) return null;
      if (!res) return <Line>Search did not finish.</Line>;
      if (failed)
        return (
          <Expand label="Search failed" tone="fault">
            <p className="max-w-[72ch] tx-13 leading-[1.5] text-fg-2">{resultText(res)}</p>
          </Expand>
        );
      const list = (Array.isArray(res.meta?.results) ? res.meta.results : []) as Array<{ title: string; url: string }>;
      const n = typeof res.meta?.count === 'number' ? res.meta.count : list.length;
      if (!list.length) return <Line>Searched the web{q ? ` for ${q}` : ''}, nothing found</Line>;
      return (
        <Expand label={`Searched the web, ${n} ${n === 1 ? 'result' : 'results'}`}>
          <ul className="space-y-1 border-l border-rule-2 pl-3">
            {list.map((r) => (
              <li key={r.url} className="min-w-0 tx-13 leading-[1.45] phone:tx-14">
                <a href={r.url} target="_blank" rel="noreferrer noopener" className="group/src flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-fg group-hover/src:underline group-hover/src:decoration-rule-2 group-hover/src:underline-offset-3">{r.title || host(r.url)}</span>
                  <span className="shrink-0 tx-12 text-fg-3">{host(r.url)}</span>
                </a>
              </li>
            ))}
          </ul>
        </Expand>
      );
    }
    case 'WebFetch': {
      const url = str(res?.meta?.url) ?? str(i.url) ?? '';
      const h = host(url);
      if (running) return null;
      if (failed)
        return (
          <Expand label={`Could not read ${h}`} tone="fault">
            <p className="max-w-[72ch] tx-13 leading-[1.5] text-fg-2">{res ? resultText(res) : ''}</p>
          </Expand>
        );
      return (
        <Line>
          {res ? 'Read' : 'Reading stopped,'}&nbsp;
          <a href={url} target="_blank" rel="noreferrer noopener" className="link min-w-0 truncate tx-12.5 phone:tx-13.5">
            {h}
          </a>
        </Line>
      );
    }
    case 'MemorySearch': {
      if (running) return null;
      if (!res) return <Line>Memory check did not finish.</Line>;
      if (failed) return <Expand label="Memory check failed" tone="fault"><p className="tx-13 text-fg-2">{resultText(res)}</p></Expand>;
      const notes = parseNotes(res);
      if (!notes.length) return <Line>Checked memory, nothing found</Line>;
      return (
        <Expand label={`Checked memory, ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}>
          <ul className="space-y-1.5 border-l border-rule-2 pl-3">
            {notes.map((n) => (
              <li key={n.id} className="max-w-[72ch] tx-13 leading-[1.5] text-fg-2 phone:tx-14">
                {n.text}
              </li>
            ))}
          </ul>
        </Expand>
      );
    }
    case 'MemorySave': {
      const fact = str(i.content) ?? '';
      const id = str(res?.meta?.memoryId);
      if (running) return null;
      if (failed) return <Expand label="Could not save to memory" tone="fault"><p className="tx-13 text-fg-2">{res ? resultText(res) : ''}</p></Expand>;
      return (
        <div className="py-0.5">
          <Line>{undone ? 'Saved to memory, then removed' : 'Saved to memory'}</Line>
          <div className="mt-0.5 mb-1 border-l border-rule-2 pl-3">
            <p className={cn('max-w-[72ch] tx-14 leading-[1.55] phone:tx-15', undone ? 'text-fg-3 line-through' : 'text-fg-2')}>{fact}</p>
            {id && !undone && (
              <div className="mt-1 -ml-1.5 flex items-center">
                <Act onClick={async () => (await forgetNote(id)) && setUndone(true)}>Undo</Act>
                <Link href={`/memory?focus=${id}`} className="flex h-[26px] items-center rounded-[var(--r-1)] px-1.5 text-[12.5px] text-fg-3 hov:bg-hover hov:text-fg phone:h-10 phone:px-2.5 phone:text-[14px]">
                  Edit
                </Link>
              </div>
            )}
          </div>
        </div>
      );
    }
    case 'MemoryForget': {
      const old = findNote(messages, results, str(i.id));
      if (running) return null;
      if (failed) return <Expand label="Could not retire a note" tone="fault"><p className="tx-13 text-fg-2">{res ? resultText(res) : ''}</p></Expand>;
      return (
        <div className="py-0.5">
          <Line>Retired a note</Line>
          {old && <p className="mt-0.5 mb-1 max-w-[72ch] border-l border-rule-2 pl-3 tx-14 leading-[1.55] text-fg-3 line-through phone:tx-15">{old}</p>}
        </div>
      );
    }
    case 'PlaceSearch':
    case 'PlaceDetails':
    case 'Directions':
    case 'MapImage':
      if (running) return null;
      // folded on a phone, the cards go under the fold's line instead
      return <MapsLine tool={tool} result={res} card={!folded} />;
    case 'ShareFile':
      if (running) return null;
      return <FileLine tool={tool} result={res} sessionId={messages[0]?.sessionId ?? ''} card={!folded} />;
    // calendar and mail (docs/DESIGN.md 32): what was read, and what was proposed for the owner to approve
    case 'DayPlan':
    case 'CalendarList':
    case 'CalendarFreeBusy':
    case 'CalendarEvent':
    case 'MailDraft': {
      if (running) return null;
      const w = toolRowWords({ name: tool.name, input: i });
      if (failed) return <Expand label={`${w.verb}: failed`} tone="fault"><p className="tx-13 text-fg-2">{res ? resultText(res) : ''}</p></Expand>;
      return <Line>{w.target ? `${w.verb}: ${w.target}` : w.verb}</Line>;
    }
    case 'WatchReport':
    case 'WatchCreate':
      if (running) return null;
      return <WatchLine tool={tool} result={res} sessionId={messages[0]?.sessionId ?? ''} card={!folded} />;
    // a job handed to Code or the Assistant: who and where, and its session, while it works too
    case 'Delegate':
      return <DelegateCallLine tool={tool} result={result} run={run} sessionId={messages[0]?.sessionId ?? ''} />;
    default: {
      const label = tool.name.replace(/^mcp__/, '').replace(/__/g, ' ');
      if (running) return null;
      if (failed) return <Expand label={`${label} failed`} tone="fault"><p className="tx-13 text-fg-2">{res ? resultText(res) : ''}</p></Expand>;
      return <Line>Used {label}</Line>;
    }
  }
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

type Piece = { kind: 'thinking'; block: Extract<ContentBlock, { type: 'thinking' }>; msg: Message; key: string; last: boolean } | { kind: 'redacted'; key: string } | { kind: 'tool'; tool: ToolUseBlock; key: string } | { kind: 'text'; text: string; msg: Message; key: string; last: boolean } | { kind: 'image'; src: string; key: string };

function piecesOf(messages: Message[]): Piece[] {
  const out: Piece[] = [];
  const assistant = messages.filter((m) => m.role === 'assistant');
  assistant.forEach((m, mi) => {
    m.content.forEach((b, bi) => {
      const key = `${m.id}:${bi}`;
      const last = mi === assistant.length - 1 && bi === m.content.length - 1;
      if (b.type === 'thinking') out.push({ kind: 'thinking', block: b, msg: m, key, last });
      else if (b.type === 'redacted_thinking') out.push({ kind: 'redacted', key });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', tool: b, key });
      else if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text, msg: m, key, last });
      else if (b.type === 'image') out.push({ kind: 'image', src: b.url ?? `data:${b.mediaType};base64,${b.data}`, key });
    });
  });
  return out;
}

export interface ReplyProps {
  reply: ReplyUnit;
  session: Session;
  /** The newest reply: its actions always show and it keeps the still mark. */
  isLast: boolean;
  /** It is being written now. */
  live: boolean;
  phase: Phase;
  /** When the turn started (client time), for "Thinking 4s". */
  startedAt: number;
  streaming: Record<string, true>;
  tools: Record<string, ToolRun>;
  results: Record<string, ToolResultBlock>;
  failed?: boolean;
  /** The chat waits for a provider limit to reset: the reply's Knot rests as a grey stub and the countdown runs next to it. */
  resuming?: boolean;
  /** The reply is held on an approval or a question (a hook can ask, even in a chat): its Knot freezes amber. */
  onYou?: boolean;
  /** How many replies a retry of this one would remove after it. */
  after: number;
  /**
   * One more action in the reply's row, after Retry, shown only when it
   * applies: the place for "Try the next model" on a refused reply.
   */
  extraAction?: ReactNode;
}

export const Reply = memo(function Reply({ reply, session, isLast, live, phase, startedAt, streaming, tools, results, failed, resuming, onYou, after, extraAction }: ReplyProps) {
  const pieces = useMemo(() => piecesOf(reply.messages), [reply.messages]);
  const text = useMemo(() => replyText(reply), [reply]);
  // a reply stopped before it wrote anything has nothing to cite
  const sources = useMemo(() => (live || !text.trim() ? [] : replySources(text, replyResults(reply.messages, results))), [live, text, reply.messages, results]);
  const leaving = useChatUi((s) => reply.messages.some((m) => s.leaving.has(m.id)));
  const last = replyLast(reply);
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const lastStep = useRef<Step | undefined>(undefined);
  // sent just now: the word "Thinking" waits 400ms, so a fast first token never shows it
  const [lateStart] = useState(() => Date.now() - startedAt < 400);
  const thinks = useModelThinks(session.model) && !!session.chat?.thinking && session.chat.thinking !== 'off';
  // the reply ended without finishing: it failed, or it waits for a limit to reset; its Knot says so in place
  const held: 'failed' | 'paused' | null = isLast && !live ? (failed ? 'failed' : resuming ? 'paused' : null) : null;

  if (!pieces.length && !live && !held) return null;

  // One Knot per reply, at its foot, from the moment you send until it is done (spec 1.9): it
  // thinks while nothing has arrived and while a thought streams, works while a tool runs or
  // text streams, and settles into the still grey knot when the reply ends. The status line
  // next to it says the step (Steps); the error line carries its own mark.
  const running = live ? pieces.filter((p): p is Extract<Piece, { kind: 'tool' }> => p.kind === 'tool' && !results[p.tool.id] && tools[p.tool.id]?.status !== 'ok' && tools[p.tool.id]?.status !== 'error').map((p) => p.tool) : [];
  // waiting on you freezes the Knot at its current frame, amber; it goes on from that frame after
  const foot: MarkState | null = isLast ? (live ? (onYou ? 'waiting' : phase === 'writing' || phase === 'tool' ? 'tool' : 'thinking') : (held ?? 'done')) : null;
  // With thinking on, a thought is on its way: the Fold's row holds the first line from the start
  // ("Thinking" after 400ms) and the Knot sits under it, so when the thought arrives it streams in
  // under the same word and nothing jumps. The first thought takes over this very row (same key).
  const placeholder = live && thinks && !pieces.length && phase === 'waiting';
  const firstThought = pieces[0]?.kind === 'thinking' ? pieces[0] : undefined;
  // phones: every tool row of the reply folds into one line, where the first one was
  const toolPieces = mobile ? pieces.filter((p): p is Extract<Piece, { kind: 'tool' }> => p.kind === 'tool') : [];
  const step: Step | undefined = !live ? undefined : phase === 'tool' ? runningStep(running) : phase === 'writing' ? WRITING : undefined;
  if (step) lastStep.current = step;
  // between two steps the last one stays on the line, so a quick gap never flashes a new word
  const shownStep = step ?? (live && phase === 'between' ? lastStep.current : undefined);

  return (
    <div id={last ? `cm-${last.id}` : undefined} className={cn('group/reply relative', leaving && 'cv-leave')}>
      {placeholder && <ThoughtFold key="thought-0" keyId="" block={NO_THOUGHT} live late={lateStart} />}
      {pieces.map((p) => {
        switch (p.kind) {
          case 'thinking':
            return <ThoughtFold key={p === firstThought ? 'thought-0' : p.key} keyId={p.key} block={p.block} live={live && phase === 'thinking' && p.last} />;
          case 'redacted':
            return <Line key={p.key}>The provider hid this reasoning.</Line>;
          case 'tool':
            if (toolPieces.length) {
              if (p !== toolPieces[0]) return null;
              return (
                <div key={p.key}>
                  <ToolFold label={toolLine(toolPieces.map((t) => t.tool))}>
                    {toolPieces.map((t) => (
                      <ToolLine key={t.key} tool={t.tool} result={results[t.tool.id]} run={tools[t.tool.id]} live={live} messages={reply.messages} results={results} folded />
                    ))}
                  </ToolFold>
                  <MapsCards results={toolPieces.map((t) => results[t.tool.id] ?? tools[t.tool.id]?.result)} className="mb-2" />
                  <WatchCards results={toolPieces.map((t) => results[t.tool.id] ?? tools[t.tool.id]?.result)} sessionId={session.id} className="mb-2" />
                  <FileCards calls={toolPieces.map((t) => ({ name: t.tool.name, result: results[t.tool.id] ?? tools[t.tool.id]?.result }))} sessionId={session.id} className="mb-2" />
                </div>
              );
            }
            return <ToolLine key={p.key} tool={p.tool} result={results[p.tool.id]} run={tools[p.tool.id]} live={live} messages={reply.messages} results={results} />;
          case 'image':
            return <img key={p.key} src={p.src} alt="Image from the model" className="my-2 max-h-80 rounded-[var(--r-2)] border border-rule" />;
          case 'text': {
            const on = live && phase === 'writing' && p.last && !!streaming[p.msg.id];
            return (
              <InkReveal key={p.key} active={on} className="my-1 first:mt-0">
                <ChatMarkdown text={p.text} streaming={on} id={p.key} />
              </InkReveal>
            );
          }
        }
      })}
      {sources.length > 0 && <Sources list={sources} />}
      {/* every finished reply ends with its actions: on hover on a desktop (always on the last), always on a phone */}
      {(live ? isLast : !!last || !!held) && (
        <ReplyFoot reply={reply} session={session} text={text} mark={foot} via={onYou && phase === 'tool' ? 'tool' : undefined} live={live} held={held} isLast={isLast} after={after} menuOpen={menuOpen} setMenuOpen={setMenuOpen} extra={extraAction}>
          {live && <FootStatus waiting={phase === 'waiting' && !placeholder} onYou={!!onYou} startedAt={startedAt} step={shownStep} />}
        </ReplyFoot>
      )}
    </div>
  );
});

const WRITING: Step = { id: 'writing', verb: 'Writing' };

/**
 * The words next to the Knot while the reply runs. Before anything arrives:
 * "Thinking 4s", the word only after 400ms so a fast first token never
 * shows it. Then the step: "Searching the web  caddy tailscale", "Reading
 * 3 pages", "Writing"; the old step leaves before the new one arrives.
 * While a thought streams the Fold above says "Thinking", so this is empty.
 */
function FootStatus({ waiting, onYou, startedAt, step }: { waiting: boolean; onYou: boolean; startedAt: number; step?: Step }) {
  const [late] = useState(() => Date.now() - startedAt < 400);
  // the card that waits on you sits at the end of the chat (ChatMessages.tsx Asks), a subagent's too
  if (onYou)
    return (
      <span role="status" className="flex min-w-0 items-center">
        <LiveStatus state="waiting" mark={false} />
      </span>
    );
  if (waiting)
    return (
      <span role="status" className={cn('flex min-w-0 items-center', late && 'cv-late')}>
        <LiveStatus state="thinking" mark={false} startedAt={startedAt} />
      </span>
    );
  if (!step) return null;
  return <Steps step={step} className="min-w-0 tx-12.5 phone:tx-13.5" />;
}

function Sources({ list }: { list: Array<{ n: number; url: string; host: string; title?: string }> }) {
  return (
    <p className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 tx-12.5 leading-[1.5] phone:tx-13.5">
      <span className="text-fg-3">Sources</span>
      {list.map((s) => (
        <a key={s.url} href={s.url} title={s.title} target="_blank" rel="noreferrer noopener" className="group/src inline-flex items-baseline gap-1.5 text-fg-2 hov:text-fg">
          <span className="num text-fg-3">{s.n}</span>
          <span className="underline decoration-rule-2 underline-offset-3 group-hover/src:decoration-fg-3">{s.host}</span>
        </a>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Action row
// ---------------------------------------------------------------------------

const REVEAL = 'opacity-0 transition-opacity duration-[var(--dur-1)] group-hover/reply:opacity-100 group-focus-within/reply:opacity-100 coarse:opacity-100';

function ReplyFoot({
  reply,
  session,
  text,
  mark,
  via,
  live,
  held,
  isLast,
  after,
  menuOpen,
  setMenuOpen,
  extra,
  children,
}: {
  reply: ReplyUnit;
  session: Session;
  text: string;
  mark: MarkState | null;
  /** The working state a waiting Knot freezes (a tool that asked for approval as it started). */
  via?: 'thinking' | 'tool';
  live: boolean;
  /** The reply stopped short: it failed (the reason and Retry), or waits for a limit (the countdown). */
  held: 'failed' | 'paused' | null;
  isLast: boolean;
  after: number;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  /** One more action after Retry (ReplyProps.extraAction). */
  extra?: ReactNode;
  /** The status line while the reply runs. */
  children?: ReactNode;
}) {
  const [copied, copy] = useCopy();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const askRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [pick, setPick] = useState<'ask' | 'retry' | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // nothing of the reply has arrived yet while it first thinks
  const last = replyLast(reply);
  const model = reply.model ?? last?.model ?? session.model;
  const suggestsSession = /continue as a session/i.test(text);
  const user = reply.user;

  const retry = async (withModel?: string) => {
    if (!user) return;
    if (withModel && withModel !== session.model) await patchChat(session.id, { model: withModel });
    await retryFrom(session, user);
  };
  const askRetry = (withModel?: string) => {
    if (after > 2) setConfirm(withModel ?? '');
    else void retry(withModel);
  };
  const ask = async (m: string) => {
    setPick(null);
    const known = new Set((useHub.getState().messages[session.id] ?? []).map((x) => x.id));
    const at = Date.now();
    if (!last) return;
    setAsking(session.id, { model: m, replyId: last.id, known, at });
    const r = await attempt(() => api().secondOpinion(session.id, { reviewer: m, messageId: last.id }));
    if (!r) {
      setAsking(session.id, undefined);
      return;
    }
    // the hub answers once the aside is written; if none came (nothing to review), stop waiting
    setTimeout(() => {
      if (useChatUi.getState().asking[session.id]?.at === at) setAsking(session.id, undefined);
    }, 2_000);
  };

  const items = [
    ...(user ? [{ label: 'Retry', onSelect: () => askRetry() }, { label: 'Retry with…', onSelect: () => setTimeout(() => setPick('retry'), 0) }] : []),
    { label: 'Branch', onSelect: () => branchChat(session, lastSeq(reply), navigate) },
    { label: 'Ask another model', onSelect: () => setTimeout(() => setPick('ask'), 0) },
    { separator: true, label: '' },
    { label: 'Continue as a session…', onSelect: () => openContinue(session.id) },
    ...(canSend(session) ? [{ label: 'Send to friend…', onSelect: () => setTimeout(() => setSending(true), 0) }] : []),
  ];

  // desktop shows Retry, Branch and Ask another model in the row, a phone Copy and Retry; the menu keeps the rest
  const menuItems = items.filter((it) => (mobile ? it.label !== 'Retry' : it.label !== 'Branch' && it.label !== 'Ask another model' && it.label !== 'Retry'));
  while (menuItems[0]?.separator) menuItems.shift();

  return (
    // the Knot is the first child in every state, so it is one element from send to done, failed or a limit
    <div className={cn('mt-2 flex gap-1 first:mt-0', held === 'failed' ? 'items-start' : 'h-7 items-center phone:h-10')}>
      {mark && (!mobile || live || held) && (
        <span className="mr-2 flex h-7 shrink-0 items-center phone:h-10">
          <Knot state={mark} via={via} size={16} />
        </span>
      )}
      {held === 'failed' && <FailedWords session={session} user={user} />}
      {held === 'paused' && <LiveStatus state="resuming" resumeAt={session.resumeAt} countdown={!!session.resumeAt} label={session.resumeAt ? undefined : 'Resumes when the limit resets'} mark={false} />}
      {live && children}
      {!live && !held && last && mobile && <ReplyIcons ref={moreRef} text={text} onRetry={user ? () => askRetry() : undefined} onMore={() => setMenuOpen(!menuOpen)} moreOpen={menuOpen} quiet={!isLast} extra={extra} />}
      {!live && !held && last && !mobile && (
        <>
          <span className={cn('flex min-w-0 items-center', !mark && '-ml-1.5', !isLast && REVEAL, (pick || menuOpen) && 'opacity-100')}>
            {/* a reply stopped before it wrote anything has nothing to copy */}
            {text.trim() && (
              <Act onClick={() => copy(text)} label={copied ? 'Copied' : 'Copy'}>
                <Swap on={copied} off="Copy">
                  Copied
                </Swap>
              </Act>
            )}
            {!mobile && (
              <>
                {user && <Act onClick={() => askRetry()}>Retry</Act>}
                {extra}
                <Act onClick={() => branchChat(session, lastSeq(reply), navigate)}>Branch</Act>
                <Act btnRef={askRef} active={pick === 'ask'} onClick={() => setPick('ask')}>
                  Ask another model
                </Act>
                {suggestsSession && <Act onClick={() => openContinue(session.id)}>Continue as a session</Act>}
              </>
            )}
            <IconButton ref={moreRef} label="More actions" size={mobile ? 'lg' : 'sm'} aria-haspopup="menu" aria-expanded={menuOpen} active={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
              <MoreHorizontal />
            </IconButton>
          </span>
          {/* a narrow column (a preview open beside it) keeps the actions and drops the model and time */}
          <span className={cn('ml-auto flex shrink-0 items-center gap-2 pl-3 text-[12px] text-fg-3 @max-[640px]:hidden phone:text-[13px]', !isLast && REVEAL, mobile && 'hidden')}>
            <ModelName model={model} size={13} />
            <span className="num">{hhmm(last.createdAt)}</span>
          </span>
        </>
      )}
      <Popover anchor={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} placement="bottom-start" width={230} label="Reply actions" sheetTitle={mobile && last ? `${modelName(model)}, ${hhmm(last.createdAt)}` : undefined}>
        <MenuList items={menuItems} onDone={() => setMenuOpen(false)} label="Reply actions" />
      </Popover>
      <Popover anchor={pick === 'ask' && !mobile ? askRef : moreRef} open={!!pick} onClose={() => setPick(null)} placement="bottom-start" width={380} label={pick === 'ask' ? 'Ask another model' : 'Retry with'} sheetTitle={pick === 'ask' ? 'Ask another model' : 'Retry with'}>
        <p className="shrink-0 px-3 pt-2.5 text-[12px] text-fg-3 phone:hidden">{pick === 'ask' ? 'A second opinion on this reply from' : 'Write this reply again with'}</p>
        <ModelList value={pick === 'retry' ? session.model : undefined} harnesses={false} onChange={(m) => (pick === 'ask' ? void ask(m) : (setPick(null), askRetry(m)))} onDone={() => setPick(null)} />
      </Popover>
      <SendToFriendDialog session={session} open={sending} onClose={() => setSending(false)} />
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        tone="neutral"
        title="Retry this reply?"
        body={`The ${after} replies after it go away. Branch first to keep them.`}
        confirm="Retry"
        busy="Retrying"
        onConfirm={() => retry(confirm || undefined)}
      />
    </div>
  );
}

/**
 * Next to the reply's Knot when it failed (spec 1.3 Failed): the stroke
 * stopped and turned the fault color in place; here the reason, then Retry
 * and Switch model.
 */
export function FailedWords({ session, user }: { session: Session; user?: Message }) {
  const pickRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const reason = (session.error ?? 'The reply stopped with an error.').replace(/\.?$/, '.');
  const retry = async (model?: string) => {
    if (!user) return;
    setBusy(true);
    if (model && model !== session.model) await patchChat(session.id, { model });
    await retryFrom(session, user);
    setBusy(false);
  };
  return (
    <div className="min-w-0 anim-fade" role="alert">
      <p className="max-w-[72ch] pt-[3.5px] text-[14px] leading-[1.5] text-fg-2 phone:pt-[8.75px] phone:text-[15px]">
        <span className="font-medium text-fault">Failed.</span> {reason}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {user && (
          <Button variant="outline" size="sm" busy={busy ? 'Retrying' : false} onClick={() => retry()}>
            Retry
          </Button>
        )}
        <Button ref={pickRef} variant="quiet" size="sm" aria-expanded={picking} onClick={() => setPicking(true)}>
          Switch model
        </Button>
        {/* the hub names Settings, Providers when a key is missing or refused */}
        {/Settings, Providers/.test(reason) && (
          <ButtonLink href="/settings/providers" variant="quiet" size="sm">
            Open Providers
          </ButtonLink>
        )}
      </div>
      <Popover anchor={pickRef} open={picking} onClose={() => setPicking(false)} width={380} label="Switch model" sheetTitle="Switch model">
        <ModelList value={session.model} harnesses={false} onChange={(m) => void retry(m)} onDone={() => setPicking(false)} />
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Second opinion, notices
// ---------------------------------------------------------------------------

export const AsideView = memo(function AsideView({ message, session, pending, streaming }: { message: Message; session: Session; pending: boolean; streaming: boolean }) {
  const [dismissed, setDismissed] = useState(() => readDismissed().has(message.id));
  const model = message.model ?? str(message.meta?.reviewer);
  const text = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  const name = model ? modelName(model) : 'another model';
  const dismiss = (v: boolean) => {
    setDismissed(v);
    writeDismissed(message.id, v);
  };
  if (dismissed)
    return (
      <p id={`cm-${message.id}`} className="text-[12.5px] text-fg-3 phone:text-[13.5px]">
        Second opinion from {name}, dismissed.{' '}
        <button type="button" className="link text-[12.5px] phone:text-[13.5px]" onClick={() => dismiss(false)}>
          Show
        </button>
      </p>
    );
  return (
    <section id={`cm-${message.id}`} aria-label={`Second opinion from ${name}`} className="anim-fade">
      <h3 className="flex min-w-0 items-center gap-1.5 tx-12.5 leading-[25px] font-semibold text-fg-2 phone:tx-13.5">
        Second opinion from {model ? <ModelName model={model} size={13} /> : 'another model'}
      </h3>
      <div className="cv-aside mt-1 border-l border-rule-2 pl-3">
        {text ? (
          <InkReveal active={streaming}>
            <ChatMarkdown text={text} streaming={streaming} id={message.id} />
          </InkReveal>
        ) : (
          <div className="flex h-[25px] items-center">
            <LiveStatus state="thinking" label="Reading the reply" startedAt={Math.min(message.createdAt, Date.now())} />
          </div>
        )}
      </div>
      {pending && !streaming && text && (
        <div className="mt-2 -ml-1.5 flex items-center gap-1">
          {model && model !== session.model && (
            <Button variant="quiet" size="sm" onClick={() => patchChat(session.id, { model })}>
              Continue with {name}
            </Button>
          )}
          <Button variant="quiet" size="sm" onClick={() => dismiss(true)}>
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
});

/**
 * A second opinion on its way (the hub writes it in one go). While a reply
 * also runs, its mark is the one that moves (one moving mark per chat), so
 * this row keeps its words and drops the mark.
 */
export function AskingRow({ model, at, still }: { model: string; at: number; still?: boolean }) {
  return (
    <section aria-label={`Second opinion from ${modelName(model)}`} className="anim-fade">
      <h3 className="flex min-w-0 items-center gap-1.5 tx-12.5 leading-[25px] font-semibold text-fg-2 phone:tx-13.5">
        Second opinion from <ModelName model={model} size={13} />
      </h3>
      <div className="mt-1 flex h-[25px] items-center border-l border-rule-2 pl-3">
        <LiveStatus state="thinking" label="Reading the reply" startedAt={at} mark={!still} />
      </div>
    </section>
  );
}

/** "Switched to openai/gpt-5.5" reads "Switched to GPT-5.5." */
function noticeWords(text: string): string {
  // the hub says "Stopped" when the owner stops a reply (Stop, esc)
  if (/^stopped\.?$/i.test(text.trim())) return 'Stopped by you.';
  let t = text.trim().replace(/\b(?:anthropic|openai|google|zai|zhipu|openrouter|ollama|lmstudio|deepseek|moonshot|mistral|groq|xai)\/[\w.:/-]*\w/g, (ref) => modelName(ref));
  if (t && !/[.!?)]$/.test(t)) t += '.';
  return t;
}

function noticeText(message: Message): string {
  return message.kind === 'summary' ? 'Earlier messages were compacted into a summary.' : message.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
}

/** A notice that says a reply failed ("Error: ..." at level error). */
export function isErrorNotice(message: Message): boolean {
  return message.kind === 'notice' && ((message.meta as { level?: string } | undefined)?.level === 'error' || /^(error|failed)\b/i.test(noticeText(message).trim()));
}

export const NoticeView = memo(function NoticeView({ message }: { message: Message }) {
  // a background task that reported back: one row that opens to its report
  if (noticeResult(message))
    return (
      <FanOutNotice
        message={message}
        wrap={(row) => (
          <div id={`cm-${message.id}`} className="anim-fade">
            {row}
          </div>
        )}
      />
    );
  const words = noticeWords(noticeText(message));
  const error = isErrorNotice(message);
  const shown = error && !/^failed\b/i.test(words) ? `Failed. ${words.replace(/^error:?\s*/i, '')}` : words;
  const [first, ...rest] = shown.split(' ');
  return (
    <p id={`cm-${message.id}`} className="text-[12.5px] leading-[1.5] text-fg-3 anim-fade phone:text-[13.5px]">
      {error ? (
        <>
          <span className="text-fault">{first}</span> {rest.join(' ')}
        </>
      ) : (
        shown
      )}
    </p>
  );
});

export function SwitchView({ model }: { model: string }) {
  return <p className="text-[12.5px] leading-[1.5] text-fg-3 phone:text-[13.5px]">Switched to {modelName(model)}.</p>;
}
