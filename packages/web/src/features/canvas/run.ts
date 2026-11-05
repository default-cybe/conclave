/**
 * Canvas mode (docs/design/CANVAS-MODE.md 3 and 7): the pure parts of
 * running a file. One run per file at a time: Run becomes Queue run while one
 * goes on, and the queued runs wait on the hub (core canvas/queue.ts), which
 * starts the next one when the last ends, with or without the app open. Also
 * the Code session that "Ask the agent" continues for a file, and the context
 * its message carries. No React here, so tests import it.
 */
import type { WorkflowRunStatus } from '@conclave/core/client';
import { accountKey } from '@/lib/api';
import { isLive } from '../workflows/words';

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

/** The hub's queue key for a file (core canvas/queue.ts): a workflow by id, a program by its session and name. */
export const queueFile = (f: { workflow: string } | { sessionId: string; flow: string }) => ('workflow' in f ? `workflow:${f.workflow}` : `program:${f.sessionId}:${f.flow}`);

/** The hub started the oldest queued run (it left the queue): read the file's run again to show it. */
export function headLeft(prev: Array<{ id: string }>, next: Array<{ id: string }>): boolean {
  return !!prev[0] && !next.some((q) => q.id === prev[0].id);
}

/**
 * Run's guard: while one start is on its way a second is dropped, so a
 * double-click (both clicks arrive before React renders again) starts one run.
 */
export function startGuard() {
  let busy = false;
  return {
    busy: () => busy,
    run(fn: () => Promise<unknown>, done?: () => void): boolean {
      if (busy) return false;
      busy = true;
      void fn().finally(() => {
        busy = false;
        done?.();
      });
      return true;
    },
  };
}

/**
 * Whether a workflow's run goes on: the one this page started counts as live
 * until its detail loads (the detail keeps the old run until then), so Run
 * offers Queue run, not a second start.
 */
export function workflowLive(started: string | undefined, lastRun: string | undefined, data: { run: { id: string; status: WorkflowRunStatus } } | undefined, failed?: boolean): boolean {
  if (started && started !== data?.run.id && !failed) return true;
  return !!data && data.run.id === lastRun && isLive(data.run.status);
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

/** How often the Agent tab reads the open file's sha while the agent works. */
export const AGENT_POLL_MS = 2_000;

/** The agent is mid-turn: running, or waiting on an approval or an answer. Idle, paused, a limit or an error end the polling. */
export const agentBusy = (status: string | undefined) => status === 'running' || status === 'waiting_approval' || status === 'waiting_input';

/**
 * Read the file from the hub and take it only when its sha moved, so an
 * agent's edit shows while it works and an unchanged poll redraws nothing.
 * Resolves true when it took a new version; a failed read is false.
 */
export function reloadIfChanged<V extends { sha: string }>(read: () => Promise<V>, shaNow: () => string | undefined, take: (v: V) => void): () => Promise<boolean> {
  return () =>
    read().then(
      (v) => (v.sha !== shaNow() ? (take(v), true) : false),
      () => false,
    );
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
