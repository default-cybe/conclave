/**
 * Turns in the log (spec 11.2.2): your messages in a bubble at the right
 * (the same bubble as the Chat page), the assistant's prose, thinking, tool
 * rows and second opinions. An assistant turn has an author line with quiet
 * text actions on hover; the thoughts and calls between two pieces of prose
 * fold into one summary row (ToolRows.tsx, toolGroups.ts, CHAT-AND-MOTION
 * 6.3).
 *
 * Motion (CHAT-AND-MOTION 1.4): your message rises 4px as it lands, a reply's
 * pieces fade in as they arrive, streamed text comes up from dim per chunk
 * (InkReveal), Copy turns into Copied in place. What was already there
 * when the transcript opened does not move.
 */
import { memo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { ContentBlock, Message, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, toolResultsFor, upsertSession, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useCoarsePointer, useCopy, useIsMobile } from '@/lib/hooks';
import { harnessId, modelName } from '@/lib/models';
import { ModelName } from '@/components/logo';
import { Button, IconButton } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { ConfirmDialog, MenuList, Popover } from '@/components/ui/Overlay';
import { ModelList } from '@/components/pickers/ModelPicker';
import { Fold, InkReveal, Swap, arrived } from '@/components/motion';
import { BUBBLE, BubbleText } from '@/components/ui/Bubble';
import { ImageThumb } from '@/components/ui/ImageViewer';
import { ActionText, AuthorLine, LogRow, REVEAL } from './Log';
import { Markdown, StreamedMarkdown } from './Markdown';
import { ToolGroup, type ThoughtItem, type WorkItem } from './ToolRows';
import { workName } from './toolGroups';
import { useFolded } from './FanOutCard';
import { thoughtTime } from '@/lib/toolLine';
import { COMPOSE_EVENT, SHAPED_CALL, msgText, readDismissed, writeDismissed, type ComposeDetail } from './util';
import { storedWord } from './Pending';
import { senderName } from './shared';

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

/** Copy, then Copied for 1.5s, in one cell so the row never shifts. */
export function CopyWord({ copied }: { copied: boolean }) {
  return (
    <Swap on={copied} off="Copy">
      Copied
    </Swap>
  );
}

type UserMessageProps = { message: Message; session: Session; /** It arrived after the transcript loaded: rise in. */ enter?: boolean };

export const UserMessage = memo(function UserMessage({ message, session, enter }: UserMessageProps) {
  const [copied, copy] = useCopy();
  const [confirm, setConfirm] = useState(false);
  const text = msgText(message);
  const images = message.content.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image');
  const docs = message.content.filter((b): b is Extract<ContentBlock, { type: 'document' }> => b.type === 'document');
  // sent while it worked: "Queued" or "Steered the running turn", next to the bubble where the pending one said it (Pending.tsx)
  const busyWord = storedWord(message.meta?.whenBusy);
  const time = hhmm(message.createdAt);

  const edit = async () => {
    // the hub keeps messages up to the seq it is given: drop this message and what follows
    const s = await attempt(() => api().rewind(session.id, message.seq - 1));
    if (s) {
      upsertSession(s);
      window.dispatchEvent(new CustomEvent<ComposeDetail>(COMPOSE_EVENT, { detail: { text, sessionId: session.id } }));
    }
  };

  return (
    <LogRow time={time} id={`msg-${message.id}`} hover="turn" className={cn(enter && 'anim-rise')}>
      {/* your words in the Chat page's bubble, at the right; Copy and Edit wait at its left on hover (always on touch) */}
      <div data-author="you" className="flex flex-col items-end">
        {(images.length > 0 || docs.length > 0) && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-2">
            {images.map((img, i) => (
              <ImageThumb key={i} src={img.url ?? `data:${img.mediaType};base64,${img.data}`} className="max-h-40 max-w-[240px] rounded-[var(--r-2)] border border-rule object-cover" />
            ))}
            {docs.map((d, i) => (
              <span key={i} className="flex h-10 items-center rounded-[var(--r-2)] border border-rule px-3 text-[13px] text-fg-2">
                {d.title ?? 'Attached document'}
              </span>
            ))}
          </div>
        )}
        <div className="flex w-full items-end justify-end gap-2">
          <div className="flex shrink-0 items-center pb-1">
            {text && (
              <span className={cn('flex items-center', REVEAL)}>
                <ActionText onClick={() => copy(text)} aria-label={copied ? 'Copied' : 'Copy'}>
                  <CopyWord copied={copied} />
                </ActionText>
                <ActionText onClick={() => setConfirm(true)}>Edit</ActionText>
              </span>
            )}
            {busyWord && <span className="ml-1 text-[12px] text-fg-3">{busyWord}</span>}
          </div>
          {text && (
            <div className={cn(BUBBLE, 'min-w-0 max-w-[min(85%,520px)]')}>
              <BubbleText text={text}>
                <Markdown text={text} />
              </BubbleText>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={edit}
        tone="neutral"
        title="Edit this message?"
        body="Everything after it leaves the session, and the text goes back into the composer."
        confirm="Edit"
        busy="Rewinding"
      />
    </LogRow>
  );
}, (a: UserMessageProps, b: UserMessageProps) => a.message === b.message && a.enter === b.enter && sameSessionFor(a.session, b.session));

// ---------------------------------------------------------------------------
// Assistant turn
// ---------------------------------------------------------------------------

type Piece =
  /** A stretch of work: the thoughts and calls between two pieces of prose (two or more, or one call). */
  | { type: 'work'; entries: WorkItem[]; msg: Message; key: string }
  | { type: 'block'; block: ContentBlock; msg: Message; isLast: boolean; key: string };

const isThought = (b: ContentBlock) => b.type === 'thinking' || b.type === 'redacted_thinking';

/**
 * A turn's content as pieces in order: prose and other blocks one each, and
 * each stretch of thoughts and calls with no prose between them as one piece
 * of work. A lone thought (no call next to it) stays a block of its own.
 * Calls in `folded` are drawn by a fan-out card (fanOut.ts) and left out;
 * a Task call carries its message's id, the key of its card.
 */
export function turnPieces(messages: Message[], streaming: Record<string, true>, results: TurnProps['results'], tools: TurnProps['tools'], folded?: ReadonlySet<string>): Piece[] {
  const pieces: Piece[] = [];
  type Held = { entry: WorkItem; msg: Message; isLast: boolean; key: string };
  let run: Held[] = [];
  const flush = () => {
    const [first] = run;
    if (!first) return;
    if (run.length === 1 && first.entry.type === 'thought') pieces.push({ type: 'block', block: first.entry.item.block, msg: first.msg, isLast: first.isLast, key: first.key });
    else pieces.push({ type: 'work', entries: run.map((h) => h.entry), msg: first.msg, key: first.key });
    run = [];
  };
  messages.forEach((m, mi) => {
    m.content.forEach((b, bi) => {
      const key = `${m.id}:${bi}`;
      const isLast = mi === messages.length - 1 && bi === m.content.length - 1;
      if (b.type === 'tool_use') {
        if (!folded?.has(b.id)) run.push({ entry: { type: 'call', name: workName(b.name, b.input), item: { tool: b, result: results[b.id], run: tools[b.id] }, card: m.id }, msg: m, isLast, key });
      }
      // a thought in a group may be the block that streams: the turn's last, in a message still being written
      else if (isThought(b)) run.push({ entry: { type: 'thought', item: { block: b, key, ...(streaming[m.id] && isLast ? { streaming: true } : {}) } }, msg: m, isLast, key });
      else if (b.type !== 'tool_result') {
        // an empty text block of a finished message is nothing; it does not split the calls around it
        if (b.type === 'text' && !b.text.trim() && !streaming[m.id]) return;
        flush();
        pieces.push({ type: 'block', block: b, msg: m, isLast, key });
      }
    });
  });
  flush();
  return pieces;
}

/** Who wrote it: "coder, [claude] Sonnet 5.5" or "sysadmin, [cc] Claude Code, Opus". */
export function Speaker({ agent, model, children }: { agent?: string; model?: string; children?: ReactNode }) {
  const harness = harnessId(model);
  return (
    <span className="flex min-w-0 items-center truncate">
      {agent && <span className="shrink-0">{agent}</span>}
      {model && (
        <span className="ml-0 inline-flex min-w-0 items-center truncate font-normal text-fg-3">
          {agent && <span>,&nbsp;</span>}
          <ModelName model={model} size={13} />
          {harness && !model.endsWith('/default') && <span>, {modelName(model)}</span>}
        </span>
      )}
      {children}
    </span>
  );
}

export interface TurnProps {
  messages: Message[];
  session: Session;
  streaming: Record<string, true>;
  tools: ReturnType<typeof useHub.getState>['tools'];
  results: ReturnType<typeof toolResultsFor>;
  /** Message ids on screen when the transcript loaded (useArrivals); others fade in. */
  known?: ReadonlySet<string> | null;
  /** The session is still at work on this turn (the latest turn while it runs or waits on you). */
  live?: boolean;
}

/**
 * What a turn shows and acts on from its session: who speaks, and which session its actions go to.
 * The session changes on every status and stats update; in a long session, drawing every turn
 * again for those took seconds.
 */
export function sameSessionFor(a: Session, b: Session): boolean {
  return a === b || (a.id === b.id && a.agent === b.agent && a.model === b.model);
}

/** The log rebuilds its lists on every chunk; a turn whose own messages, tool runs and results are the same objects does not draw again. */
export function sameTurn(a: TurnProps, b: TurnProps): boolean {
  if (!sameSessionFor(a.session, b.session) || a.known !== b.known || !a.live !== !b.live || a.messages.length !== b.messages.length) return false;
  for (let i = 0; i < a.messages.length; i++) {
    const m = a.messages[i];
    if (m !== b.messages[i] || !a.streaming[m.id] !== !b.streaming[m.id]) return false;
    for (const blk of m.content) if (blk.type === 'tool_use' && (a.tools[blk.id] !== b.tools[blk.id] || a.results[blk.id] !== b.results[blk.id])) return false;
  }
  return true;
}

export const AssistantTurn = memo(function AssistantTurn({ messages, session, streaming, tools, results, known, live }: TurnProps) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const isStreaming = messages.some((m) => streaming[m.id]);
  const text = messages.map(msgText).filter(Boolean).join('\n\n');

  const folded = useFolded(session.id);
  const pieces = turnPieces(messages, streaming, results, tools, folded);
  // the work the turn is still at: no prose (or other block that is not a thought) after it yet
  let lastProse = -1;
  pieces.forEach((p, i) => {
    if (p.type === 'block' && !isThought(p.block)) lastProse = i;
  });

  // a run that failed before writing anything leaves an empty message; a notice explains it
  if (pieces.length === 0 && !isStreaming) return null;

  let shown = hhmm(first.createdAt);
  const firstTime = shown;
  const seen = new Set<string>();
  const starter = senderName(first, useHub.getState().me?.id ?? 'owner');

  return (
    <div data-hover="turn">
      <LogRow time={firstTime} className={cn(arrived(known, first.id) && 'anim-fade')}>
        <AuthorLine actions={!isStreaming && <TurnActions session={session} last={last} text={text} />}>
          {/* a shared chat: the turn's starter, with their model (SHARED-WITH-MEMBERS.md 6) */}
          {starter ? (
            <span className="flex min-w-0 items-center truncate">
              <span className="shrink-0">{starter}</span>
              <span className="inline-flex min-w-0 items-center truncate font-normal text-fg-3">
                &nbsp;via <ModelName model={first.model ?? session.model} size={13} />
              </span>
            </span>
          ) : (
            <Speaker agent={first.agent ?? session.agent} model={first.model ?? session.model} />
          )}
        </AuthorLine>
      </LogRow>
      {pieces.map((p, pi) => {
        const t = hhmm(p.msg.createdAt);
        const showTime = t !== shown ? t : undefined;
        if (showTime) shown = t;
        const id = seen.has(p.msg.id) ? undefined : `msg-${p.msg.id}`;
        seen.add(p.msg.id);
        return (
          <LogRow key={p.key} time={showTime} id={id} className={cn(arrived(known, p.msg.id) && 'anim-fade')}>
            {p.type === 'work' ? (
              <ToolGroup entries={p.entries} sessionId={session.id} live={!!live && pi > lastProse} thought={drawThought} />
            ) : (
              <BlockView block={p.block} streaming={!!streaming[p.msg.id] && p.isLast} />
            )}
          </LogRow>
        );
      })}
      {isStreaming && pieces.length === 0 && (
        <LogRow>
          <span className="stream-caret inline-block h-5" />
        </LogRow>
      )}
    </div>
  );
}, sameTurn);

/** A thought inside a stretch of work; the last one may still stream while the group is open. */
function drawThought(t: ThoughtItem) {
  return <BlockView block={t.block} streaming={!!t.streaming} />;
}

export function BlockView({ block, streaming }: { block: ContentBlock; streaming: boolean }) {
  switch (block.type) {
    case 'text': {
      // another person's tool call in a shared chat: one quiet line, like a tool row, never their output
      const call = !streaming && SHAPED_CALL.exec(block.text);
      if (call) return <p className="py-0.5 tx-12 leading-[22px] text-fg-3 phone:tx-13">Used {workName(call[1])}</p>;
      return block.text ? <StreamedMarkdown text={block.text} streaming={streaming} className="my-1" /> : streaming ? <span className="stream-caret inline-block h-5" /> : null;
    }
    case 'thinking':
      return <Thinking text={block.thinking} streaming={streaming} durationMs={block.durationMs} />;
    case 'redacted_thinking':
      return <p className="py-0.5 tx-12 leading-[22px] text-fg-3">The provider hid this reasoning.</p>;
    case 'image':
      return <img src={block.url ?? `data:${block.mediaType};base64,${block.data}`} alt="Image from the model" className="my-2 max-h-80 rounded-[var(--r-2)] border border-rule" />;
    case 'document':
      return <p className="py-0.5 tx-12 text-fg-3">{block.title ?? 'Document'}</p>;
    default:
      return null;
  }
}

/**
 * "Thought for 12s" from the hub's stored time (it survives a reload), else
 * the time we watched it stream, else the word count. Expands to the
 * reasoning in fg-2, which keeps streaming in while it is open.
 */
function Thinking({ text, streaming, durationMs }: { text: string; streaming: boolean; durationMs?: number }) {
  // the time we watched it stream, taken in the render it ends, so the row goes from "Reasoning"
  // straight to "Thought for 3s" (an effect would show the word count for a frame in between)
  const started = useRef<number | null>(null);
  const ended = useRef<number | null>(null);
  if (streaming && started.current === null) started.current = Date.now();
  if (!streaming && started.current !== null && ended.current === null) ended.current = Date.now();
  const ms = started.current !== null && ended.current !== null ? ended.current - started.current : null;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const took = durationMs ?? ms;
  // while it streams, the live line under the turn says "Thinking" with the Knot; this row stays one word
  // (a count that changed with every chunk would trade letters all the time)
  const label = streaming ? 'Reasoning' : took != null ? `Thought for ${thoughtTime(took)}` : `Reasoning, ${words} ${words === 1 ? 'word' : 'words'}`;
  // the Fold: a click opens it, the rule draws down and the reasoning comes in (spec 1.4)
  return (
    <Fold live={false} label={label} className="py-0.5 [&_.cv-fold-row]:min-h-[22px] [&_.cv-fold-row]:tx-12 phone:[&_.cv-fold-row]:tx-13">
      <InkReveal active={streaming} className="max-w-[var(--read-measure)] tx-13.5 leading-[1.6] whitespace-pre-wrap phone:tx-14.5">
        {text}
      </InkReveal>
    </Fold>
  );
}

// ---------------------------------------------------------------------------
// Turn actions: copy, ask another model, fork, rewind, hand off
// ---------------------------------------------------------------------------

function TurnActions({ session, last, text }: { session: Session; last: Message; text: string }) {
  const [copied, copy] = useCopy();
  const coarse = useCoarsePointer();
  const mobile = useIsMobile();
  const moreRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const [pick, setPick] = useState<'ask' | null>(null);
  const [menu, setMenu] = useState(false);
  const [rewind, setRewind] = useState(false);
  const [files, setFiles] = useState(true);
  const [, navigate] = useLocation();

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

  const target = coarse || mobile ? moreRef : askRef;

  return (
    <>
      {coarse || mobile ? (
        <IconButton ref={moreRef} label="Turn actions" size={mobile ? 'lg' : 'sm'} onClick={() => setMenu(true)} aria-haspopup="menu" aria-expanded={menu}>
          <MoreHorizontal />
        </IconButton>
      ) : (
        <span className={cn('flex items-center', REVEAL, (pick || menu) && 'opacity-100')}>
          <ActionText onClick={() => copy(text)} aria-label={copied ? 'Copied' : 'Copy'}>
            <CopyWord copied={copied} />
          </ActionText>
          <ActionText ref={askRef} active={pick === 'ask'} onClick={() => setPick('ask')}>
            Ask another model
          </ActionText>
          <ActionText onClick={fork}>Fork</ActionText>
          <ActionText onClick={() => setRewind(true)}>Rewind</ActionText>
        </span>
      )}
      <Popover anchor={moreRef} open={menu} onClose={() => setMenu(false)} placement="bottom-end" width={220} label="Turn actions">
        <MenuList
          onDone={() => setMenu(false)}
          items={[
            { label: copied ? 'Copied' : 'Copy', onSelect: () => copy(text) },
            { label: 'Ask another model', onSelect: () => setTimeout(() => setPick('ask'), 0) },
            { label: 'Fork from here', onSelect: fork },
            { label: 'Rewind to here', onSelect: () => setRewind(true) },
          ]}
        />
      </Popover>
      <Popover anchor={target} open={!!pick} onClose={() => setPick(null)} placement="bottom-end" width={380} label="Ask another model" sheetTitle="Second opinion from">
        <p className="shrink-0 px-3 pt-2.5 text-[12px] text-fg-3 phone:hidden">A second opinion on this reply from</p>
        <ModelList onChange={onPick} />
      </Popover>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Second opinion (a single aside)
// ---------------------------------------------------------------------------

export const SecondOpinion = memo(function SecondOpinion({
  message,
  session,
  streaming,
  pending,
  enter,
}: {
  message: Message;
  session: Session;
  streaming: boolean;
  /** No reply has followed it yet: offer Adopt and Dismiss. */
  pending: boolean;
  /** It arrived after the transcript loaded: fade in. */
  enter?: boolean;
}) {
  const [copied, copy] = useCopy();
  const [dismissed, setDismissed] = useState(() => readDismissed().has(message.id));
  const [adopted, setAdopted] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const text = msgText(message);
  const model = message.model ?? (message.meta?.reviewer as string | undefined);
  const time = hhmm(message.createdAt);
  const author = message.author && message.author !== 'Second opinion' ? message.author : 'Second opinion';

  const setDismiss = (v: boolean) => {
    setDismissed(v);
    writeDismissed(message.id, v);
  };

  if (dismissed)
    return (
      <LogRow time={time} id={`msg-${message.id}`}>
        <p className="py-0.5 text-[12px] leading-[22px] text-fg-3 phone:text-[13px]">
          {author} from {model ? modelName(model) : 'another model'}, dismissed.{' '}
          <button type="button" className="link text-[12px] phone:text-[13px]" onClick={() => setDismiss(false)}>
            Show
          </button>
        </p>
      </LogRow>
    );

  return (
    <div data-hover="turn" className={cn(enter && 'anim-fade')}>
      <LogRow time={time} id={`msg-${message.id}`}>
        <AuthorLine
          actions={
            !streaming && (
              <span className={REVEAL}>
                <ActionText onClick={() => copy(text)} aria-label={copied ? 'Copied' : 'Copy'}>
                  <CopyWord copied={copied} />
                </ActionText>
              </span>
            )
          }
        >
          <span className="flex min-w-0 items-center truncate">
            {author} from&nbsp;
            {model ? <ModelName model={model} size={13} /> : 'another model'}
          </span>
        </AuthorLine>
      </LogRow>
      <LogRow>
        <StreamedMarkdown text={text} streaming={streaming} className="my-1" />
        {streaming && !text && <span className="stream-caret inline-block h-5" />}
        {!streaming && (adopted !== null || pending) && (
          <div className="mt-2.5 mb-1 flex items-center gap-2">
            {adopted !== null ? (
              <span className="text-[12px] text-fg-3">
                Adopted, <span className="num">{hhmm(adopted)}</span>
              </span>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  busy={busy ? 'Adopting' : false}
                  onClick={async () => {
                    setBusy(true);
                    const r = await attempt(() => api().send(session.id, { text: `Adopt the second opinion from ${model ? modelName(model) : 'the reviewer'} and apply its points.`, whenBusy: 'queue' }));
                    setBusy(false);
                    if (r) setAdopted(Date.now());
                  }}
                >
                  Adopt
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setDismiss(true)}>
                  Dismiss
                </Button>
              </>
            )}
          </div>
        )}
      </LogRow>
    </div>
  );
});
