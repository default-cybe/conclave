/**
 * Canvas mode, PR 3 (docs/design/CANVAS-MODE.md 3 and 7): the pure parts of
 * running a file. One run per file at a time: Run becomes Queue run while one
 * goes on, and the queued runs wait here (per account, per file, kept across
 * reloads) until the canvas starts the next one. Also the Code session that
 * "Ask the agent" continues for a file, and the context its message carries.
 * No React here, so tests import it.
 */
import { accountKey } from '@/lib/api';

export interface QueuedRun {
  id: string;
  at: number;
  /** The args it was queued with (a workflow that declares them). */
  args?: Record<string, unknown>;
}

const QUEUE_KEY = 'conclave.canvas.queue';
const AGENT_KEY = 'conclave.canvas.agent';

function readMap<T>(key: string): Record<string, T> {
  try {
    const v = JSON.parse(localStorage.getItem(accountKey(key)) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>): void {
  try {
    localStorage.setItem(accountKey(key), JSON.stringify(map));
  } catch {
    /* private mode: this page only */
  }
}

/** The runs queued for a file, oldest first. */
export function queuedRuns(file: string): QueuedRun[] {
  const list = readMap<QueuedRun[]>(QUEUE_KEY)[file];
  return Array.isArray(list) ? list.filter((q) => q && typeof q.id === 'string') : [];
}

function setQueue(file: string, list: QueuedRun[]): QueuedRun[] {
  const all = readMap<QueuedRun[]>(QUEUE_KEY);
  if (list.length) all[file] = list;
  else delete all[file];
  writeMap(QUEUE_KEY, all);
  return list;
}

let seq = 0;

/** Queue run: one more after the rest. At most 10 wait per file. */
export function queueRun(file: string, args?: Record<string, unknown>): QueuedRun[] {
  const list = queuedRuns(file);
  if (list.length >= 10) return list;
  return setQueue(file, [...list, { id: `q${Date.now().toString(36)}${++seq}`, at: Date.now(), ...(args ? { args } : {}) }]);
}

/** Cancel one queued run. */
export function dropQueued(file: string, id: string): QueuedRun[] {
  return setQueue(
    file,
    queuedRuns(file).filter((q) => q.id !== id),
  );
}

/** The next run to start, taken off the queue. */
export function takeQueued(file: string): QueuedRun | undefined {
  const [next, ...rest] = queuedRuns(file);
  if (next) setQueue(file, rest);
  return next;
}

/**
 * A program's blocks while it runs: the trace reports a block when it ends,
 * so the first block with no value yet is running and the rest are queued.
 */
export function programStates(nodes: Array<{ id: string }>, run: { status: string; nodes: Record<string, unknown> } | undefined): Record<string, 'running' | 'queued'> {
  const out: Record<string, 'running' | 'queued'> = {};
  if (!run || (run.status !== 'running' && run.status !== 'approval')) return out;
  let first = run.status === 'running';
  for (const n of nodes) {
    if (run.nodes[n.id]) continue;
    out[n.id] = first ? 'running' : 'queued';
    first = false;
  }
  return out;
}

/** The Code session "Ask the agent" continues for a file. */
export function agentSessionOf(file: string): string | undefined {
  const v = readMap<string>(AGENT_KEY)[file];
  return typeof v === 'string' ? v : undefined;
}

export function rememberAgentSession(file: string, sessionId: string): void {
  writeMap(AGENT_KEY, { ...readMap<string>(AGENT_KEY), [file]: sessionId });
}

/** The folder a workflow script lives in, for its agent session; undefined for a built-in. */
export function folderOf(path: string | undefined): string | undefined {
  if (!path || path.startsWith('builtin:')) return undefined;
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : undefined;
}

/**
 * What the agent gets with the owner's words: the file, the blocks selected,
 * and the last run's error, so "add a step that summarises the results" or
 * "fix this" needs no more. The canvas reloads when the agent's turn ends.
 */
export function agentMessage(text: string, ctx: { file: string; selection: Array<{ label: string; lines: string }>; error?: string }): string {
  const lines = [`Canvas: I am editing ${ctx.file}. Edit that file to do what I ask; keep it a valid ${ctx.file.endsWith('.flow.ts') ? 'flow' : 'workflow script'}.`];
  if (ctx.selection.length) lines.push(`Selected: ${ctx.selection.map((s) => `${s.label} (${s.lines})`).join(', ')}.`);
  if (ctx.error) lines.push(`The last run failed: ${ctx.error.split('\n').slice(0, 6).join('\n')}`);
  return `${lines.join('\n')}\n\n${text.trim()}`;
}
