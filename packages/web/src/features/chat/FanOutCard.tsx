/**
 * A fan-out as one card (fanOut.ts): the Task and Delegate calls of one
 * assistant message. A header row, "4 subagents, 2 running" with the running
 * time (or how long they took), then one line per subagent under a rule: its
 * state word (running in signal, done, failed in red, limited in amber), its
 * label, agent type, model and round, and under that what it does now or the
 * first line of its report, with its own time at the right. A tap opens the
 * full report, rendered, and Open session. A single Task call is the same
 * card with one line. The same card on desktop and on a phone (the log's
 * grid, its phone sizes).
 *
 * The hub's later news about a subagent (its result notice, TaskWait,
 * TaskResult, TaskContinue) updates its line instead of drawing rows of its
 * own; a notice that arrives after prose shows a small "updated" line where
 * it arrived (FanOutNotice).
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { Message } from '@conclave/core/types';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { durationShort } from '@/lib/format';
import { modelName } from '@/lib/models';
import { thoughtTime } from '@/lib/toolLine';
import { Elapsed } from '@/components/motion';
import { StateWord, type StateTone } from '@/components/ui/List';
import { Markdown } from './Markdown';
import { resultText } from './util';
import { AgentResultNotice } from './AgentResultRow';
import { Chevron, GROUP_BODY, RESULT, ROW, ROW_BTN, RunningTime } from './rowParts';
import { subagentOf, type Subagent } from './liveTasks';
import { callMs, useSubagentNow, type ToolItem } from './ToolRows';
import { fanOutIndex, fanOutWords, firstLine, lineState, type ChildNews, type LineState } from './fanOut';

const EMPTY: Message[] = [];

/** The session's fan-out index, from the store; shared by every row through the cache. */
function useIndex(sessionId: string) {
  const messages = useHub((s) => s.messages[sessionId]) ?? EMPTY;
  return fanOutIndex(messages);
}

/** The calls a card draws in a session, as a set that only changes when the set does (so a turn does not draw again on every chunk). */
export function useFolded(sessionId: string): ReadonlySet<string> {
  const key = useHub((s) => [...fanOutIndex(s.messages[sessionId] ?? EMPTY).folded].join(' '));
  return useMemo(() => new Set(key ? key.split(' ') : []), [key]);
}

const TONE: Record<LineState, StateTone> = { running: 'signal', done: 'neutral', failed: 'fault', limited: 'warn', pending: 'dim' };
const WORD: Record<LineState, string> = { running: 'running', done: 'done', failed: 'failed', limited: 'limited', pending: 'stopped' };

export function FanOutCard({ items, sessionId }: { items: ToolItem[]; sessionId: string }) {
  const index = useIndex(sessionId);
  // every line's subagent in one selector: one string, so other events do not draw the card again
  const key = useHub((s) => JSON.stringify(items.map((it) => subagentOf(it, { sessionId, status: s.sessions[sessionId]?.status, sessions: s.sessions }))));
  const subs = useMemo(() => JSON.parse(key) as Subagent[], [key]);
  const lines = items.map((item, i) => {
    const sub = subs[i];
    const news = index.byTool.get(item.tool.id);
    const state = lineState(sub.state, news);
    const ms = callMs(item);
    // how long it took: to the hub's notice for one in the background, else the call's own time
    const took = news?.finishedAt && sub.startedAt ? news.finishedAt - sub.startedAt : !sub.background && state !== 'running' ? ms : undefined;
    const res = item.result ?? item.run?.result;
    const report = news?.report ?? (res && !sub.background && state !== 'limited' ? resultText(res).trim() || undefined : undefined);
    return { item, sub, news, state, took, report };
  });
  const states = lines.map((l) => l.state);
  const running = states.includes('running');
  const starts = lines.flatMap((l) => (l.sub.startedAt ? [l.sub.startedAt] : []));
  const since = starts.length ? Math.min(...starts) : undefined;
  // the card's time: first start to last end, else the longest line
  const ends = lines.flatMap((l) => (l.took !== undefined && l.sub.startedAt ? [l.sub.startedAt + l.took] : []));
  const longest = Math.max(0, ...lines.map((l) => l.took ?? 0));
  let time: ReactNode = null;
  if (running) time = <RunningTime since={since} />;
  else if (since && ends.length) time = thoughtTime(Math.max(...ends) - since);
  else if (longest) time = thoughtTime(longest);

  return (
    <div data-fanout="" data-state={running ? 'running' : 'ended'}>
      <div className={ROW}>
        <span className="col-span-2 min-w-0 truncate tx-13.5 text-fg-2 phone:tx-15">{fanOutWords(states)}</span>
        <span className={RESULT}>{time}</span>
        <span aria-hidden />
      </div>
      <div className={GROUP_BODY}>
        {lines.map((l) => (
          <FanOutLine key={l.item.tool.id} item={l.item} sub={l.sub} news={l.news} state={l.state} took={l.took} report={l.report} />
        ))}
      </div>
    </div>
  );
}

/** What a closed line says under its label: what it does now, else the first line of its report, else why there is none. */
function lineDetail(state: LineState, report: string | undefined, now: { text: string; waiting: boolean } | undefined): { text: string; tone?: 'warn' | 'fault' } {
  if (state === 'running') return { text: now?.text ?? 'Starting', tone: now?.waiting ? 'warn' : undefined };
  const first = firstLine(report);
  if (state === 'limited') return { text: first || 'Stopped at a usage limit before it answered.', tone: first ? undefined : 'warn' };
  if (state === 'failed') return { text: first || 'Failed before it answered.', tone: 'fault' };
  if (state === 'pending') return { text: 'Stopped with the turn.' };
  return { text: first || 'Finished. The report is in its session.' };
}

function FanOutLine({ item, sub, news, state, took, report }: { item: ToolItem; sub: Subagent; news?: ChildNews; state: LineState; took?: number; report?: string }) {
  const [open, setOpen] = useState(false);
  const running = state === 'running';
  const now = useSubagentNow(running, sub.childId);
  const model = useHub((s) => (sub.childId ? s.sessions[sub.childId]?.model : undefined));
  const detail = lineDetail(state, report, now);
  const meta = [sub.handedTo ?? sub.agent, model && modelName(model), news && news.round > 1 ? `round ${news.round}` : ''].filter(Boolean).join(', ');
  const label = news?.label ?? sub.description;
  return (
    <div id={`tool-${item.tool.id}`} data-fanout-line="" data-state={state}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={ROW_BTN}>
        <StateWord tone={TONE[state]} className="tx-12.5 phone:tx-14">
          {WORD[state]}
        </StateWord>
        <span className="min-w-0">
          <span title={typeof item.tool.input?.prompt === 'string' ? item.tool.input.prompt : label} className="block truncate tx-13.5 text-fg-2 phone:tx-15">
            {label}
            {meta && <span className="text-fg-3">{`, ${meta}`}</span>}
          </span>
          <span data-fanout-detail="" className={cn('block truncate tx-12.5 phone:tx-14', detail.tone === 'warn' ? 'text-warn' : detail.tone === 'fault' ? 'text-fault' : 'text-fg-3')}>
            {detail.text}
          </span>
        </span>
        <span className={RESULT}>{running ? <Elapsed since={sub.startedAt} format="short" className="text-signal" /> : took !== undefined ? durationShort(took) : ''}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="pb-2.5 anim-fade">
          {report ? (
            <div className="max-h-[320px] overflow-y-auto overscroll-contain">
              <Markdown text={report} className="tx-13.5 text-fg-2 phone:tx-15" />
            </div>
          ) : (
            <p className="m-0 tx-12.5 text-fg-3 phone:tx-14">{running ? 'No report yet.' : 'The report is not in this view.'}</p>
          )}
          {sub.childId && (
            <Link href={`/s/${sub.childId}`} className="link mt-1 inline-block tx-12 phone:flex phone:min-h-11 phone:items-center phone:tx-14">
              Open session
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

const ENDED: Record<string, string> = { completed: 'finished', failed: 'failed', limited: 'stopped at a usage limit', stopped: 'was stopped' };

/**
 * A result notice: drawn by its card (nothing here), a small "updated" line
 * when prose came between them, or the plain result row when no card has it.
 */
export const FanOutNotice = memo(function FanOutNotice({ message, wrap = (row) => row }: { message: Message; /** The place around the row; not drawn when the card has it. */ wrap?: (row: ReactNode) => ReactNode }) {
  const index = useIndex(message.sessionId);
  const fold = index.notices.get(message.id);
  if (!fold) return wrap(<AgentResultNotice message={message} />);
  if (fold.mode === 'hide') return null;
  return wrap(
    <p data-fanout-update="" className="m-0 py-0.5 text-[12px] leading-[22px] text-fg-3 phone:text-[13px]">
      Updated: {fold.label} {ENDED[fold.state] ?? fold.state}.{' '}
      <button type="button" className="link text-[12px] phone:text-[13px]" onClick={() => document.getElementById(`tool-${fold.toolId}`)?.scrollIntoView({ block: 'center' })}>
        Show
      </button>
    </p>
  );
});
