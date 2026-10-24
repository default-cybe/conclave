/**
 * Background subagents as tasks the parent can list, wait for, read and
 * continue (HARNESS-REVIEW item 21). The state lives where engine/subagent.ts
 * keeps it, on the child's meta.background { parentId, state, startedAt,
 * finishedAt }, so there is no second record. Workflow runs keep their own
 * journal and report through the Workflow tool; they are not listed here.
 */
import type { Session } from '../types';
import type { Engine } from './engine';
import { continueSubagent, deliverSubagentResult, SUBAGENT_RESULT_MAX_CHARS } from './subagent';
import { lastAssistantText, reminder } from '../session/transcript';
import { truncateMiddle } from '../util/text';
import { logger } from '../util/log';

const log = logger('background');

export type TaskState = 'running' | 'completed' | 'failed' | 'lost';

export interface TaskInfo {
  id: string;
  agent: string;
  description: string;
  state: TaskState;
  startedAt?: number;
  finishedAt?: number;
}

/** Longest TaskWait wait, in seconds. */
export const TASK_WAIT_MAX_SEC = 300;
const POLL_MS = 250;

interface BackgroundMeta {
  parentId?: string;
  state?: string;
  startedAt?: number;
  finishedAt?: number;
  waitingReset?: boolean;
}

function bg(s: Session): BackgroundMeta | undefined {
  const b = s.meta?.background as BackgroundMeta | undefined;
  return b && typeof b === 'object' ? b : undefined;
}

function info(s: Session): TaskInfo {
  const b = bg(s) ?? {};
  const state: TaskState = b.state === 'running' ? 'running' : b.state === 'lost' ? 'lost' : b.state === 'error' ? 'failed' : 'completed';
  return { id: s.id, agent: s.agent, description: s.title, state, ...(b.startedAt ? { startedAt: b.startedAt } : {}), ...(b.finishedAt ? { finishedAt: b.finishedAt } : {}) };
}

export class BackgroundTasks {
  constructor(private engine: Engine) {}

  /** The background children of a session, oldest first. */
  list(parentId: string): TaskInfo[] {
    return this.engine.repos.sessions
      .list({ parentId, limit: 500 })
      .filter((s) => bg(s)?.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(info);
  }

  /** One child of this parent, or undefined. */
  get(parentId: string, id: string): TaskInfo | undefined {
    const s = this.engine.getSession(id);
    return s && bg(s)?.parentId === parentId ? info(s) : undefined;
  }

  /**
   * Wait until one of the tasks that are running now finishes (ids, or all of
   * the parent's), up to timeoutSec; 0 returns a snapshot. Returns every
   * listed task with its state and the ids that finished while waiting.
   */
  async wait(parentId: string, ids: string[] | undefined, timeoutSec: number, signal?: AbortSignal): Promise<{ tasks: TaskInfo[]; finished: string[] }> {
    const pick = () => {
      const all = this.list(parentId);
      return ids?.length ? all.filter((t) => ids.includes(t.id)) : all;
    };
    const first = pick();
    const running = new Set(first.filter((t) => t.state === 'running').map((t) => t.id));
    const end = Date.now() + Math.min(TASK_WAIT_MAX_SEC, Math.max(0, timeoutSec)) * 1000;
    for (;;) {
      const now = pick();
      const finished = now.filter((t) => running.has(t.id) && t.state !== 'running').map((t) => t.id);
      if (finished.length || !running.size || Date.now() >= end || signal?.aborted) return { tasks: now, finished };
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /** A child's final report, cut like a background result. */
  result(parentId: string, id: string): { task: TaskInfo; text: string } | undefined {
    const task = this.get(parentId, id);
    if (!task) return undefined;
    const text = lastAssistantText(this.engine.repos.messages.list(id));
    const cut = truncateMiddle(text, SUBAGENT_RESULT_MAX_CHARS, 'omitted');
    return { task, text: cut.truncated ? `${cut.text}\n\n[The report was ${text.length} chars and was cut; the full text is in session ${id}.]` : cut.text };
  }

  /** Send a finished child another message; it runs in the background and reports like before. */
  continue(parentId: string, id: string, text: string): TaskInfo | string {
    const task = this.get(parentId, id);
    if (!task) return `No background task ${id} in this session. TaskList shows yours.`;
    if (task.state === 'running') return `Task ${id} is still running. Wait for it with TaskWait, then continue it.`;
    const child = this.engine.getSession(id)!;
    this.engine.patchMeta(id, { background: { ...bg(child), parentId, state: 'running', startedAt: Date.now(), finishedAt: undefined } });
    void continueSubagent(this.engine, id, text)
      .then((r) => deliverSubagentResult(this.engine, parentId, id, r.error ? 'error' : 'completed', r.error ? `${r.text}\n\nError: ${r.error}` : r.text))
      .catch((err) => {
        log.warn('background task continue failed', err);
        deliverSubagentResult(this.engine, parentId, id, 'error', `Error: ${(err as Error)?.message ?? String(err)}`);
      });
    return { ...task, state: 'running' };
  }

  /**
   * At boot: a child that was running when the hub stopped is lost (its loop
   * died with the process). Each parent gets a note on its next turn, without
   * waking it, and a notice in its transcript.
   */
  markLost(sessions: Session[]): number {
    let n = 0;
    for (const s of sessions) {
      const b = bg(s);
      if (b?.state !== 'running' || !b.parentId) continue;
      // parked for a usage limit: the durable session.resume job continues it and reports (engine/subagent.ts waitForReset)
      if (s.status === 'waiting_reset' && b.waitingReset === true) continue;
      n++;
      this.engine.patchMeta(s.id, { background: { ...b, state: 'lost', finishedAt: Date.now() } });
      const parent = this.engine.getSession(b.parentId);
      if (!parent || parent.archived) continue;
      this.engine.runnerFor(parent.id).deliver({
        block: reminder(`Background task ${s.id} (${s.agent}: ${s.title}) was lost: the hub restarted while it ran. Its messages so far are in that session. Start it again with Task if you still need it.`),
        source: s.id,
        wake: false,
      });
      this.engine.notice(parent.id, `Background task lost in a hub restart: ${s.title}`, 'warning');
    }
    return n;
  }
}
