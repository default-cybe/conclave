/**
 * Tool calls as log lines (spec 10.17): verb, target, result in a three
 * column grid, rows split by rules. No boxes and no icons; a diff, terminal
 * output or a subagent log opens under its row.
 *
 * The thoughts and calls between two pieces of prose fold into one summary
 * row, "Thought for 15s, ran git log" or "Ran 6 commands, read 2 files,
 * edited 1 file", that opens to them in order (toolGroups.ts, CHAT-AND-MOTION
 * 6.3). A Workflow call and a Task call are each one compact row of their
 * own that follows the work live: "Workflow deep-research, 3 of 6 agents
 * running" (WorkflowCard.tsx WorkflowRow), "Subagent explore: Find the auth
 * code, searching for jwt" (SubagentRow); a click opens the run's phases and
 * agents, or the subagent's log.
 *
 * States (CHAT-AND-MOTION 1.3): a running row has its verb in signal and the
 * still Knot with the elapsed time; when it ends the verb settles to fg-2
 * and the result fades in where the time was (done words, "failed" in red,
 * "waiting on you" in amber, still). Nothing in the row changes width.
 *
 * Color (CHAT-AND-MOTION 6.2): the answer is fg; a row is quieter. The verb
 * (the tool) is fg-2 at 500, a command or pattern mono fg-2, a path's
 * folders fg-3 and its file name fg-2, the result fg-3. Hue is for state
 * only: signal running, amber waiting, red failed, green and red for lines
 * added and removed.
 */
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'wouter';
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { cn, makeDiff, parseDiff, type DiffFile } from '@/lib/text';
import { durationShort, pathIn, shortPath } from '@/lib/format';
import { loadMessages, toolResultsFor, useHub, type HubState, type ToolRun } from '@/store/store';
import { modelName } from '@/lib/models';
import { waitsIn } from '@/lib/asks';
import { lowerFirst, subagentNow, workSummary, workingWords, type WorkStep } from '@/lib/toolLine';
import { CodeBlock, Diff } from '@/components/ui/Code';
import { Markdown } from './Markdown';
import { hostOf, resultText } from './util';
import { WorkflowRow } from '../workflows/WorkflowCard';
import { MapsCard } from '../maps/MapsCard';
import { isMapsTool, mapsCardOf, mapsDoneWords, mapsRowTarget } from '../maps/words';
import { WatchCard } from '../watches/WatchCards';
import { WATCH_TOOLS, watchCardOf, watchDoneWords } from '../watches/words';
import { groupState, pinned, segment, troubleWords, workName, type CallStatus, type WorkEntry } from './toolGroups';
import { Chevron, GROUP_BODY, RESULT, ROW, ROW_BTN, RunningTime, verbClass } from './rowParts';
import { subagentLead, subagentOf, type Subagent } from './liveTasks';

export interface ToolItem {
  tool: ToolUseBlock;
  result?: ToolResultBlock;
  run?: ToolRun;
}

/** A thought in a stretch of work, drawn by the turn (Turn.tsx BlockView). */
export interface ThoughtItem {
  block: ContentBlock;
  key: string;
  /** It is the turn's last block and still streams. */
  streaming?: boolean;
}

/** A turn's work in order: calls, and thoughts between them. */
export type WorkItem = WorkEntry<ToolItem, ThoughtItem>;

/** The calls as work entries, for a run with no thoughts. */
export function asWork(items: readonly ToolItem[]): WorkItem[] {
  return items.map((item) => ({ type: 'call', name: workName(item.tool.name, item.tool.input), item }));
}

/** A stretch of work as the steps its summary counts: each call, and each thought with its time. */
export function workSteps(entries: readonly WorkItem[]): WorkStep[] {
  return entries.map((e) => (e.type === 'call' ? { call: e.item.tool } : { thought: { ms: e.item.block.type === 'thinking' ? e.item.block.durationMs : undefined, live: e.item.streaming } }));
}

/**
 * What a group does now while the turn works on it (Android Work.now):
 * "Thinking" while the thought that ends it streams, else the last call that
 * has not finished ("Running bun test", "Reading auth.ts"). Null when the
 * turn is past it, or a call waits on you (the pinned row says so).
 */
export function groupNow(entries: readonly WorkItem[], status: (c: ToolItem) => CallStatus, live: boolean): string | null {
  if (!live) return null;
  const last = entries[entries.length - 1];
  if (last?.type === 'thought' && last.item.streaming) return 'Thinking';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'call') continue;
    const s = status(e.item);
    if (s === 'waiting') return null;
    if (s === 'running' || s === 'pending') return workingWords(e.item.tool);
  }
  return null;
}

type Kind = 'edit' | 'bash' | 'read' | 'search' | 'fetch' | 'agent' | 'plan' | 'ask' | 'generic';

interface Info {
  verb: string;
  target?: string;
  mono?: boolean;
  kind: Kind;
  title?: string;
  /** The target is a file or folder: shown relative to the session's folder, its name never cut. */
  path?: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function toolInfo(t: ToolUseBlock): Info {
  const i = t.input ?? {};
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  switch (t.name) {
    case 'Read':
    case 'NotebookRead':
      return { verb: 'Read', target: path, mono: true, kind: 'read', path: true };
    case 'Write':
      return { verb: 'Write', target: path, mono: true, kind: 'edit', path: true };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'Edit', target: path, mono: true, kind: 'edit', path: true };
    case 'Bash':
      return { verb: 'Bash', target: str(i.command), mono: true, kind: 'bash', title: str(i.description) };
    case 'Glob':
      return { verb: 'Search', target: str(i.pattern), mono: true, kind: 'search' };
    case 'Grep':
      return { verb: 'Search', target: `${str(i.pattern) ?? ''}${path ? `  in ${shortPath(path, 3)}` : ''}`, mono: true, kind: 'search' };
    case 'LS':
      return { verb: 'List', target: path, mono: true, kind: 'search', path: true };
    case 'WebFetch':
      return { verb: 'Fetch', target: hostOf(str(i.url)), mono: true, kind: 'fetch' };
    case 'WebSearch':
      return { verb: 'Search', target: str(i.query), kind: 'fetch' };
    case 'Task':
      return { verb: 'Agent', target: str(i.description), kind: 'agent', title: str(i.prompt) };
    case 'TodoWrite':
      return { verb: 'Plan', target: Array.isArray(i.todos) ? `${i.todos.length} steps` : 'Updated', kind: 'plan' };
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) ? (i.questions[0] as { question?: string } | undefined)?.question : undefined;
      return { verb: 'Ask', target: q, kind: 'ask' };
    }
    case 'Skill':
      return { verb: 'Skill', target: str(i.skill) ?? str(i.name), mono: true, kind: 'generic' };
    case 'Browser':
      return { verb: 'Browse', target: hostOf(str(i.url)) || str(i.action), mono: true, kind: 'fetch' };
    case 'Memory':
      return { verb: 'Memory', target: str(i.query) ?? str(i.content), kind: 'generic' };
    // maps (features/maps): the card under the row has the details
    case 'PlaceSearch':
      return { verb: 'Places', target: str(i.query) ?? str(i.type), kind: 'fetch' };
    case 'PlaceDetails':
      return { verb: 'Place', target: 'details', kind: 'fetch' };
    case 'Directions':
      return { verb: 'Route', target: [str(i.mode), str(i.to) && !/^(ChIJ|osm:)/.test(String(i.to)) ? `to ${i.to}` : 'to a place'].filter(Boolean).join(' '), kind: 'fetch' };
    case 'MapImage':
      return { verb: 'Map', target: str(i.route) ? 'of a route' : `of ${Array.isArray(i.markers) ? i.markers.length : 0} places`, kind: 'fetch' };
    // watches (features/watches): the card under the row has the items
    case 'WatchReport':
      return { verb: 'Found', target: `${Array.isArray(i.items) ? i.items.length : 0} items`, kind: 'fetch' };
    case 'WatchCreate':
      return { verb: 'Watch', target: str(i.name), kind: 'fetch' };
    case 'browser_navigate':
      return { verb: 'Browse', target: hostOf(str(i.url)) || str(i.url), mono: true, kind: 'fetch' };
    case 'browser_links':
      return { verb: 'Read', target: str(i.match) ? `links with ${i.match}` : 'links', kind: 'fetch' };
    case 'browser_snapshot':
      return { verb: 'Read', target: 'the page', kind: 'fetch' };
  }
  if (t.name.startsWith('mcp__')) {
    const [, server, ...rest] = t.name.split('__');
    return { verb: 'MCP', target: `${server} ${rest.join('__')}`, mono: true, kind: 'generic' };
  }
  const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
  return { verb: 'Tool', target: `${t.name}${first ? ` ${first}` : ''}`, mono: true, kind: 'generic' };
}

/** "0.4s", "2.8s", "41s", "3m". */
export function took(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  return durationShort(ms);
}

function isDenied(r: ToolResultBlock): boolean {
  if (r.meta && (r.meta as { denied?: boolean }).denied) return true;
  return !!r.isError && /^denied\b/i.test(resultText(r).trim());
}

function lineCount(s: string): number {
  const t = s.replace(/\n+$/, '');
  return t ? t.split('\n').length : 0;
}

type Status = CallStatus;

/** A call's state from its result, its run and whether an approval for it is open. */
export function callStatus(item: ToolItem, waiting: boolean): Status {
  const res = item.result ?? item.run?.result;
  return res ? (isDenied(res) ? 'denied' : res.isError ? 'failed' : 'done') : item.run?.status === 'running' ? 'running' : waiting ? 'waiting' : 'pending';
}

/** How long a call took, from its result's meta or the run we watched. */
export function callMs(item: ToolItem): number | undefined {
  const res = item.result ?? item.run?.result;
  return typeof res?.meta?.durationMs === 'number' ? res.meta.durationMs : item.run?.finishedAt ? item.run.finishedAt - item.run.startedAt : undefined;
}

export function useToolState(item: ToolItem) {
  const res = item.result ?? item.run?.result;
  const waiting = useHub((s) => {
    for (const a of Object.values(s.approvals)) if (a.toolUseId === item.tool.id) return true;
    return false;
  });
  return { res, status: callStatus(item, waiting), ms: callMs(item) };
}

/** The calls among `ids` with an approval open, as one string so the store selector stays cheap. */
export function useWaitingKey(ids: readonly string[]): string {
  return useHub((s) => {
    let key = '';
    for (const a of Object.values(s.approvals)) if (a.toolUseId && ids.includes(a.toolUseId)) key += `${a.toolUseId} `;
    return key;
  });
}

export function editFiles(tool: ToolUseBlock, res?: ToolResultBlock): DiffFile[] {
  let text = '';
  if (typeof res?.meta?.diff === 'string') text = res.meta.diff;
  else {
    const i = tool.input;
    const path = String(i.file_path ?? i.path ?? 'file');
    if (tool.name === 'Write') text = makeDiff('', String(i.content ?? ''), path);
    else if (tool.name === 'Edit') text = removedFirst(makeDiff(String(i.old_string ?? ''), String(i.new_string ?? ''), path));
    else if (tool.name === 'MultiEdit' && Array.isArray(i.edits)) text = (i.edits as Array<{ old_string: string; new_string: string }>).map((e) => removedFirst(makeDiff(e.old_string, e.new_string, path))).join('\n');
  }
  return text ? parseDiff(text) : [];
}

/** Put removed lines before added ones inside each change, as git does. */
function removedFirst(diff: string): string {
  const out: string[] = [];
  let del: string[] = [];
  let add: string[] = [];
  const flush = () => {
    out.push(...del, ...add);
    del = [];
    add = [];
  };
  for (const l of diff.split('\n')) {
    if (l.startsWith('-') && !l.startsWith('---')) del.push(l);
    else if (l.startsWith('+') && !l.startsWith('+++')) add.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out.join('\n');
}

/** The result column text for a finished call. */
function doneWords(tool: ToolUseBlock, info: Info, res: ToolResultBlock, ms: number | undefined, files: DiffFile[]): ReactNode {
  if (isMapsTool(tool.name)) return mapsDoneWords(mapsCardOf(res));
  if (WATCH_TOOLS.has(tool.name) && !res.isError) return watchDoneWords(tool.name, watchCardOf(res));
  const out = resultText(res);
  switch (info.kind) {
    case 'edit': {
      const add = files.reduce((n, f) => n + f.added, 0);
      const del = files.reduce((n, f) => n + f.removed, 0);
      if (!add && !del) return 'done';
      return (
        <>
          <span className="text-ok">+{add}</span> <span className="text-fault">−{del}</span>
        </>
      );
    }
    case 'read':
      return `${lineCount(out)} lines`;
    case 'search': {
      const n = lineCount(out);
      if (tool.name === 'Grep' && tool.input.output_mode === 'files_with_matches') return n === 1 ? '1 file' : `${n} files`;
      if (tool.name === 'Glob' || tool.name === 'LS') return n === 1 ? '1 file' : `${n} files`;
      return n === 1 ? '1 match' : `${n} matches`;
    }
    case 'bash': {
      const code = typeof res.meta?.exitCode === 'number' ? res.meta.exitCode : undefined;
      if (code !== undefined && code !== 0) return <span className="text-fault">exit {code}</span>;
      return ms !== undefined ? `done in ${took(ms)}` : 'done';
    }
    case 'agent':
      return ms !== undefined ? `done in ${took(ms)}` : 'done';
    case 'plan': {
      const todos = Array.isArray(tool.input.todos) ? (tool.input.todos as Array<{ status?: string }>) : [];
      const done = todos.filter((t) => t.status === 'completed').length;
      return todos.length ? `${done} of ${todos.length} done` : 'updated';
    }
    case 'ask':
      return 'answered';
    case 'fetch': {
      if (tool.name === 'WebSearch') {
        const n = webResults(res).length || (typeof res.meta?.count === 'number' ? res.meta.count : 0);
        if (n) return n === 1 ? '1 result' : `${n} results`;
      }
      return ms !== undefined && ms > 1500 ? `done in ${took(ms)}` : 'done';
    }
    default:
      return ms !== undefined && ms > 1500 ? `done in ${took(ms)}` : 'done';
  }
}

/** Sources of a WebSearch result (meta.results), for the expanded row. */
export function webResults(res: ToolResultBlock | undefined): Array<{ title: string; url: string }> {
  const list = res?.meta?.results;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is { title: string; url: string } => !!r && typeof (r as { url?: unknown }).url === 'string').map((r) => ({ title: String(r.title || r.url), url: r.url }));
}

// ---------------------------------------------------------------------------
// Groups: a stretch of thoughts and calls folds into one summary row (toolGroups.ts)
// ---------------------------------------------------------------------------

const REVEAL_EVENT = 'conclave:reveal-tool';
/** Calls whose group opens as it mounts: a #message link to their result (MessageList). */
const revealed = new Set<string>();

/** Open the group that holds this call when it mounts, so a link to its result lands on its row. */
export function revealOnMount(toolUseId: string) {
  revealed.add(toolUseId);
}

/**
 * The row of a call on the page, opening the closed group that holds it
 * first (a closed group keeps a hidden marker per call). Null when the call
 * is not mounted.
 */
export function revealToolRow(toolUseId: string): HTMLElement | null {
  const row = document.getElementById(`tool-${toolUseId}`);
  if (row) return row;
  const marker = document.querySelector(`[data-tool-ref="${CSS.escape(toolUseId)}"]`);
  const group = marker?.closest('[data-tool-group]');
  if (!group) return null;
  group.dispatchEvent(new Event(REVEAL_EVENT));
  return document.getElementById(`tool-${toolUseId}`);
}

export const ToolGroup = memo(function ToolGroup({
  entries,
  sessionId,
  depth = 0,
  live = false,
  thought,
}: {
  entries: WorkItem[];
  sessionId: string;
  depth?: number;
  /** The turn is still at work on this stretch (no answer after it yet): the last group says the step it is at now. */
  live?: boolean;
  /** Draws a thought of the stretch (Turn.tsx BlockView). */
  thought?: (t: ThoughtItem) => ReactNode;
}) {
  const segs = useMemo(() => segment(entries), [entries]);
  return (
    <div className="my-2 border-y border-rule [&>*+*]:border-t [&>*+*]:border-rule">
      {segs.map((p, i) =>
        p.kind === 'one' ? (
          <ToolRow key={p.item.tool.id} item={p.item} sessionId={sessionId} depth={depth} />
        ) : p.kind === 'thought' ? (
          <ThoughtRow key={p.item.key} item={p.item} thought={thought} />
        ) : (
          <CallGroup key={`g:${firstCall(p.entries)?.tool.id ?? i}`} entries={p.entries} sessionId={sessionId} depth={depth} live={live && i === segs.length - 1} thought={thought} />
        ),
      )}
    </div>
  );
});

function firstCall(entries: readonly WorkItem[]): ToolItem | undefined {
  for (const e of entries) if (e.type === 'call') return e.item;
  return undefined;
}

function ThoughtRow({ item, thought }: { item: ThoughtItem; thought?: (t: ThoughtItem) => ReactNode }) {
  if (!thought) return null;
  return <div className="py-[5px] phone:py-2">{thought(item)}</div>;
}

/**
 * Two or more thoughts and calls as one row: what they did ("Thought for
 * 15s, ran git log", "Ran 6 commands, read 2 files"), their state at the
 * right, a chevron. Closed until you open it, while the turn works too (as on
 * Android); then the row says the step it is at now in signal ("Running bun
 * test", "Thinking", groupNow). Open, the thoughts and calls in order.
 * Closed, any call that waits on you stays in view under it.
 */
function CallGroup({ entries, sessionId, depth, live, thought }: { entries: WorkItem[]; sessionId: string; depth: number; live: boolean; thought?: (t: ThoughtItem) => ReactNode }) {
  const calls = useMemo(() => entries.flatMap((e) => (e.type === 'call' ? [e.item] : [])), [entries]);
  const ids = useMemo(() => calls.map((c) => c.tool.id), [calls]);
  const waitingKey = useWaitingKey(ids);
  const statuses = calls.map((c) => callStatus(c, waitingKey.includes(`${c.tool.id} `)));
  const state = groupState(statuses);
  const summary = workSummary(workSteps(entries));
  const now = groupNow(entries, (c) => statuses[calls.indexOf(c)], live);
  const words = now ?? summary;
  // what the edits changed, in lines, for the summary once they are done
  const lines = useMemo(() => {
    let add = 0;
    let del = 0;
    let edits = 0;
    for (const c of calls) {
      if (toolInfo(c.tool).kind !== 'edit') continue;
      const res = c.result ?? c.run?.result;
      if (res?.isError) continue;
      edits++;
      for (const f of editFiles(c.tool, res)) {
        add += f.added;
        del += f.removed;
      }
    }
    return edits ? { add, del } : null;
  }, [calls]);
  const total = calls.reduce((n, c) => n + (callMs(c) ?? 0), 0);
  let runningSince: number | undefined;
  calls.forEach((c, i) => {
    const t = c.run?.startedAt;
    if (statuses[i] === 'running' && t !== undefined && (runningSince === undefined || t < runningSince)) runningSince = t;
  });

  // null: closed, as the finished turn shows it; true or false: you chose, and it stays so as the turn goes on
  const [chosen, setChosen] = useState<boolean | null>(() => (calls.some((c) => revealed.has(c.tool.id)) ? true : null));
  const open = chosen ?? false;
  const clicked = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => flushSync(() => setChosen(true));
    el.addEventListener(REVEAL_EVENT, on);
    return () => el.removeEventListener(REVEAL_EVENT, on);
  }, []);

  let result: ReactNode;
  if (state.state === 'waiting') result = <span className="text-warn">waiting on you</span>;
  else if (state.state === 'running' || now) result = <RunningTime since={runningSince} />;
  else if (state.failed || state.denied) result = <span className={state.failed ? 'text-fault' : undefined}>{troubleWords(state)}</span>;
  else if (lines && (lines.add || lines.del))
    result = (
      <>
        <span className="text-ok">+{lines.add}</span> <span className="text-fault">−{lines.del}</span>
      </>
    );
  else result = total ? took(total) : calls.length ? 'done' : '';

  const row = (e: WorkItem) => (e.type === 'call' ? <ToolRow key={e.item.tool.id} item={e.item} sessionId={sessionId} depth={depth} /> : <ThoughtRow key={e.item.key} item={e.item} thought={thought} />);
  const held = open ? [] : calls.filter((_, i) => pinned(statuses[i]));

  return (
    <div ref={root} data-tool-group="">
      <button
        type="button"
        data-group-toggle=""
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => {
          clicked.current = true;
          setChosen(!open);
        }}
        className={ROW_BTN}
      >
        <span title={summary} className={cn('col-span-2 min-w-0 truncate tx-13.5 phone:tx-15', now ? 'text-signal' : 'text-fg-2')}>
          {words}
        </span>
        <span className={RESULT}>{result}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        // opened by a click it fades in; opened as the turn works, its rows were in view already and nothing fades
        <div id={bodyId} className={cn(GROUP_BODY, clicked.current && 'anim-fade')}>
          {entries.map(row)}
        </div>
      ) : (
        <>
          {held.length > 0 && <div className={GROUP_BODY}>{held.map((c) => row({ type: 'call', name: c.tool.name, item: c }))}</div>}
          {/* a marker per call, so the session's file list and links find a call in a closed group (revealToolRow) */}
          {calls.map((c) => {
            const info = toolInfo(c.tool);
            return <span key={c.tool.id} hidden data-tool-ref={c.tool.id} data-tool-path={info.kind === 'edit' ? info.target : undefined} />;
          })}
        </>
      )}
    </div>
  );
}

/** A path whose folders give way first: "src/features/conv…/Reply.tsx" on a narrow row, never "src/features/conversation/Re…". */
function PathText({ path, title }: { path: string; title: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <span title={title} className="t-code flex min-w-0 text-fg-2">
      {cut > 0 && <span className="min-w-0 truncate text-fg-3">{path.slice(0, cut)}</span>}
      <span className="max-w-full shrink-0 truncate">{path.slice(cut)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

export function ToolRow({ item, sessionId, depth = 0 }: { item: ToolItem; sessionId: string; depth?: number }) {
  // a Workflow and a Task call are each one row that follows the work; a row's tool never changes, so the hooks below keep their order
  const kind = workName(item.tool.name, item.tool.input);
  if (kind === 'Workflow') return <WorkflowRow tool={item.tool} result={item.result ?? item.run?.result} sessionId={sessionId} startedAt={item.run?.startedAt} />;
  if (kind === 'Task') return <SubagentRow item={item} sessionId={sessionId} depth={depth} />;
  const { tool } = item;
  const info = toolInfo(tool);
  const { res, status, ms } = useToolState(item);
  const files = useMemo(() => (info.kind === 'edit' ? editFiles(tool, res) : []), [info.kind, tool, res]);
  const output = res ? resultText(res) : (item.run?.progress ?? '');
  const lines = lineCount(output);

  const cwd = useHub((s) => s.sessions[sessionId]?.cwd);

  const expandable =
    (info.kind === 'edit' && files.length > 0) ||
    (status !== 'running' && lines > 0 && info.kind !== 'plan' && info.kind !== 'ask') ||
    (info.kind === 'generic' && Object.keys(tool.input ?? {}).length > 0);
  const defaultOpen = (info.kind === 'edit' && files.length > 0 && status !== 'failed') || ((info.kind === 'bash' || status === 'failed') && lines > 0 && lines <= 12);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = expandable && (open ?? defaultOpen);
  const longBash = info.kind === 'bash' && status !== 'running' && lines > 12 && !expanded;
  const sources = tool.name === 'WebSearch' ? webResults(res) : [];
  const mapsCard = isMapsTool(tool.name) ? mapsCardOf(res) : undefined;
  const watchCard = WATCH_TOOLS.has(tool.name) ? watchCardOf(res) : undefined;
  // a done maps row names what it found, not the ids it was given
  if (mapsCard) info.target = mapsRowTarget(mapsCard, tool.input) ?? info.target;

  // a call we watched run settles in place: its result fades in where the strip was
  const ranHere = useRef(status === 'running' || status === 'pending' || status === 'waiting');
  if (status === 'running' || status === 'waiting') ranHere.current = true;
  const settle = ranHere.current && status !== 'running' && status !== 'pending';

  let result: ReactNode;
  // a row in the log never animates a Knot (spec 1.9): the still tool knot, and the time rolls
  if (status === 'running') result = <RunningTime since={item.run?.startedAt} />;
  else if (status === 'waiting') result = <span className="text-warn">waiting on you</span>;
  else if (status === 'denied') result = 'denied';
  else if (status === 'failed') result = <span className="text-fault">failed</span>;
  else if (status === 'done' && res) result = doneWords(tool, info, res, ms, files);
  else result = '';

  const target =
    info.path && info.target ? (
      <PathText path={pathIn(info.target, cwd)} title={info.target} />
    ) : (
      <span title={info.title ?? info.target} className={cn('min-w-0 truncate text-fg-2', info.mono ? 't-code' : 'tx-13.5 phone:tx-15')}>
        {info.target ?? ''}
      </span>
    );

  const head = (
    <>
      <span className={verbClass(status === 'running')}>{info.verb}</span>
      {target}
      <span className={RESULT}>
        <span key={status} className={cn('inline-block', settle && 'anim-fade')}>
          {result}
        </span>
      </span>
      <Chevron open={!!expanded} hidden={!expandable} />
    </>
  );

  return (
    <div id={`tool-${tool.id}`} data-tool-path={info.kind === 'edit' ? info.target : undefined}>
      {expandable ? (
        <button type="button" aria-expanded={!!expanded} onClick={() => setOpen(!expanded)} className={ROW_BTN}>
          {head}
        </button>
      ) : (
        <div className={ROW}>{head}</div>
      )}

      {status === 'running' && info.kind === 'bash' && output && <Terminal output={tail(output, 8)} className="mb-2" />}

      {longBash && (
        <button type="button" onClick={() => setOpen(true)} className="mb-2 ml-[76px] tx-12 text-fg-3 hover:text-fg phone:ml-16 phone:tx-13">
          Show {lines} lines
        </button>
      )}

      {expanded && (
        <div className="pb-2.5 anim-fade">
          {info.kind === 'edit' && files.length > 0 ? (
            <div className="space-y-2">
              {files.map((f, i) => (
                <div key={`${f.path}${i}`}>
                  {files.length > 1 && <div className="mono mb-1 tx-12 text-fg-3">{f.path}</div>}
                  <Diff file={f} header={false} maxLines={20} />
                </div>
              ))}
            </div>
          ) : sources.length > 0 ? (
            <ol className="ml-[76px] space-y-1 pb-0.5 tx-13 phone:ml-16 phone:tx-14">
              {sources.map((r, i) => (
                <li key={`${r.url}${i}`} className="flex min-w-0 items-baseline gap-2">
                  <span className="num w-4 shrink-0 text-right tx-12 text-fg-3">{i + 1}</span>
                  <a href={r.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-fg hov:underline">
                    {r.title}
                  </a>
                  <span className="shrink-0 tx-12 text-fg-3">{hostOf(r.url).split('/')[0]}</span>
                </li>
              ))}
            </ol>
          ) : info.kind === 'bash' || status === 'failed' ? (
            <Terminal output={output} tone={status === 'failed' ? 'fault' : undefined} exitCode={typeof res?.meta?.exitCode === 'number' ? res.meta.exitCode : undefined} />
          ) : info.kind === 'generic' ? (
            <div className="space-y-2">
              <CodeBlock code={JSON.stringify(tool.input, null, 2)} lang="json" title="Input" maxLines={16} />
              {output && <CodeBlock code={output} title="Output" maxLines={20} wrap />}
            </div>
          ) : (
            <CodeBlock code={output} copy maxLines={20} wrap={info.kind !== 'read'} />
          )}
        </div>
      )}

      {mapsCard && <MapsCard card={mapsCard} className="mb-2.5 ml-[76px]" />}
      {watchCard && <WatchCard card={watchCard} sessionId={sessionId} className="mb-2.5 ml-[76px] phone:ml-0" />}
    </div>
  );
}

function tail(s: string, n: number): string {
  const l = s.replace(/\n+$/, '').split('\n');
  return l.slice(-n).join('\n');
}

/** Terminal output: a code box, pass and fail markers colored, the rest fg-2. */
export function Terminal({ output, tone, exitCode, className }: { output: string; tone?: 'fault'; exitCode?: number; className?: string }) {
  const [all, setAll] = useState(false);
  const lines = output.replace(/\n+$/, '').split('\n');
  const long = lines.length > 40 && !all;
  const shown = long ? [...lines.slice(0, 16), null, ...lines.slice(-16)] : lines;
  return (
    <div className={cn('t-code max-h-[420px] overflow-auto rounded-[var(--r-2)] border border-rule bg-sunk px-3 py-2', tone === 'fault' ? 'text-fault' : 'text-fg-2', className)}>
      {shown.map((l, i) =>
        l === null ? (
          <button key={i} type="button" onClick={() => setAll(true)} className="block py-0.5 font-sans tx-12 text-fg-3 hover:text-fg">
            Show {lines.length - 32} more lines
          </button>
        ) : (
          <div key={i} className="whitespace-pre">
            {colorLine(l)}
          </div>
        ),
      )}
      {exitCode !== undefined && exitCode !== 0 && <div className="mt-1 font-sans tx-12 text-fault">Exited with {exitCode}.</div>}
    </div>
  );
}

function colorLine(l: string): ReactNode {
  let m = /^(\s*)(✓|✔|PASS|pass|ok)(\b|\s)(.*)$/.exec(l);
  if (m)
    return (
      <>
        {m[1]}
        <span className="text-ok">{m[2]}</span>
        {m[3]}
        {m[4]}
      </>
    );
  m = /^(\s*)(✗|✕|×|FAIL|fail|error|Error|ERROR)(\b|:|\s)(.*)$/.exec(l);
  if (m)
    return (
      <>
        {m[1]}
        <span className="text-fault">{m[2]}</span>
        {m[3]}
        {m[4]}
      </>
    );
  m = /^(\s*)([1-9]\d*)( fail.*)$/.exec(l);
  if (m)
    return (
      <>
        {m[1]}
        <span className="text-fault">
          {m[2]}
          {m[3]}
        </span>
      </>
    );
  return l || ' ';
}

// ---------------------------------------------------------------------------
// Subagent log: the child session, indented under a rule
// ---------------------------------------------------------------------------

/**
 * What a subagent is doing now, from the store: waiting on you (an approval
 * or a question of its own, or of a subagent under it: lib/asks.ts), writing,
 * thinking, or its latest call.
 */
export function subagentNowOf(s: Pick<HubState, 'sessions' | 'messages' | 'tools' | 'streaming'> & Partial<Pick<HubState, 'approvals' | 'questions'>>, childId: string | undefined): { text: string; waiting: boolean } {
  if (!childId) return { text: 'Starting', waiting: false };
  const status = s.sessions[childId]?.status;
  if (status === 'waiting_approval' || status === 'waiting_input' || waitsIn(Object.values(s.approvals ?? {}), childId) || waitsIn(Object.values(s.questions ?? {}), childId)) return { text: 'Waiting on you', waiting: true };
  const list = s.messages[childId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'assistant') continue;
    const lastBlock = m.content[m.content.length - 1];
    if (s.streaming[m.id] && lastBlock?.type === 'text' && lastBlock.text.trim()) return { text: 'Writing', waiting: false };
    if (s.streaming[m.id] && lastBlock?.type === 'thinking') return { text: 'Thinking', waiting: false };
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b.type === 'tool_use') return { text: subagentNow(b, s.tools[b.id]?.status === 'running'), waiting: false };
    }
  }
  return { text: 'Starting', waiting: false };
}

/**
 * What a running subagent is doing now (subagentNowOf), from its session's
 * transcript, kept live by the hub's events and loaded once here. "Starting"
 * until its session shows up. Undefined while `on` is false.
 */
export function useSubagentNow(on: boolean, childId: string | undefined): { text: string; waiting: boolean } | undefined {
  useEffect(() => {
    if (on && childId) void loadMessages(childId);
  }, [on, childId]);
  // one string, so the selector stays cheap and the row draws again only when the words change
  const key = useHub((s) => {
    if (!on) return undefined;
    const now = subagentNowOf(s, childId);
    return `${now.waiting ? '!' : ' '}${now.text}`;
  });
  return key ? { text: key.slice(1), waiting: key[0] === '!' } : undefined;
}

/**
 * A Task call as one row of its own (toolGroups.ts ALONE): "Subagent
 * explore: Find the auth code, searching for jwt" (a Delegate call: "Code
 * on MadX Arch: Find names in the capstone PDFs") with the running time,
 * what it does now read from its own transcript (amber when it waits on
 * you); "done in 41s" once it answered. One started in the background runs
 * on after its call returned: the row follows its session. A click opens
 * its log.
 */
function SubagentRow({ item, sessionId, depth }: { item: ToolItem; sessionId: string; depth: number }) {
  const { tool } = item;
  const sub = useSubagent(item, sessionId);
  const running = sub.state === 'running';
  const now = useSubagentNow(running, sub.childId);
  const res = item.result ?? item.run?.result;
  const output = res && !sub.background ? resultText(res) : '';
  const ms = callMs(item);
  const expandable = (!!sub.childId && depth < 1) || !!output.trim();
  const [open, setOpen] = useState(false);
  const shown = open && expandable;
  // a subagent we watched run settles in place, as other rows do
  const ranHere = useRef(running);
  if (running) ranHere.current = true;
  const settle = ranHere.current && !running;

  let result: ReactNode = '';
  if (running) result = <RunningTime since={sub.startedAt} />;
  else if (sub.state === 'failed') result = <span className="text-fault">failed</span>;
  else if (sub.state === 'done') result = ms !== undefined && !sub.background ? `done in ${took(ms)}` : 'done';

  const lead = subagentLead(sub);
  const head = (
    <>
      <span className={verbClass(running)}>{lead.verb}</span>
      <span title={str(tool.input?.prompt) ?? sub.description} className="min-w-0 truncate tx-13.5 text-fg-2 phone:tx-15">
        {lead.who && `${lead.who}: `}
        {sub.description}
        {now && (
          <span data-subagent-now="" className={now.waiting ? 'text-warn' : 'text-fg-3'}>
            {`, ${lowerFirst(now.text)}`}
          </span>
        )}
      </span>
      <span className={RESULT}>
        <span key={sub.state} className={cn('inline-block', settle && 'anim-fade')}>
          {result}
        </span>
      </span>
      <Chevron open={shown} hidden={!expandable} />
    </>
  );
  return (
    <div id={`tool-${tool.id}`} data-subagent-row="" data-state={sub.state}>
      {expandable ? (
        <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className={ROW_BTN}>
          {head}
        </button>
      ) : (
        <div className={ROW}>{head}</div>
      )}
      {shown && <div className="pb-2.5 anim-fade">{sub.childId && depth < 1 ? <SubagentLog childId={sub.childId} agent={sub.agent} handed={!!sub.handedTo} /> : <CodeBlock code={output} copy maxLines={20} wrap />}</div>}
    </div>
  );
}

/** A Task call's subagent (liveTasks.ts subagentOf), live from the store: one string in the selector, so other events do not draw the row again. */
export function useSubagent(item: ToolItem, sessionId: string): Subagent {
  const key = useHub((s) => JSON.stringify(subagentOf(item, { sessionId, status: s.sessions[sessionId]?.status, sessions: s.sessions })));
  return useMemo(() => JSON.parse(key) as Subagent, [key]);
}

/** A subagent's own session under its row: who runs it, its calls and words, and a way to it (a Delegate call's: "Open the session", a session of its own). */
function SubagentLog({ childId, agent, handed }: { childId: string; agent?: string; handed?: boolean }) {
  const model = useHub((s) => s.sessions[childId]?.model);
  const messages = useHub((s) => s.messages[childId]);
  const loaded = useHub((s) => s.messagesLoaded[childId]);
  const tools = useHub((s) => s.tools);
  useEffect(() => {
    void loadMessages(childId);
  }, [childId]);
  const results = useMemo(() => toolResultsFor(messages ?? []), [messages]);
  const blocks = useMemo(() => {
    const out: Array<{ type: 'text'; text: string; key: string } | { type: 'tools'; items: ToolItem[]; key: string }> = [];
    for (const m of (messages ?? []) as Message[]) {
      if (m.role !== 'assistant') continue;
      m.content.forEach((b, i) => {
        if (b.type === 'text' && b.text.trim()) out.push({ type: 'text', text: b.text, key: `${m.id}:${i}` });
        if (b.type === 'tool_use') {
          const prev = out[out.length - 1];
          const item = { tool: b, result: results[b.id], run: tools[b.id] };
          if (prev?.type === 'tools') prev.items.push(item);
          else out.push({ type: 'tools', items: [item], key: `${m.id}:${i}` });
        }
      });
    }
    return out;
  }, [messages, results, tools]);

  return (
    <div className="ml-4 border-l border-rule pl-4">
      {(agent || model) && <p className="m-0 pt-1 tx-12 text-fg-3">{[agent, model && modelName(model)].filter(Boolean).join(', ')}</p>}
      {!loaded && <p className="py-1 tx-12 text-fg-3">Loading the subagent's log.</p>}
      {blocks.map((b) => (b.type === 'text' ? <Markdown key={b.key} text={b.text} className="my-2 text-fg-2" /> : <ToolGroup key={b.key} entries={asWork(b.items)} sessionId={childId} depth={1} />))}
      <Link href={`/s/${childId}`} className="link mt-1 inline-block tx-12">
        {handed ? 'Open the session' : 'Open the subagent session'}
      </Link>
    </div>
  );
}
