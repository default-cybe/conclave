/**
 * Where an approval or a question shows (docs/design/CHAT-AND-MOTION.md 1.4).
 * A subagent and a workflow agent run in child sessions the owner is not
 * looking at, so a request carries the top session of the one that asks
 * (rootSessionId): the chat the owner is in, where its card shows inline as
 * well as in the Inbox. A request from below the top also says who asks
 * (from), for the quiet line above the card.
 *
 * - A subagent's parent is its parentId (engine/subagent.ts).
 * - A workflow agent's parent is the session that started its run: its
 *   parentId, or the run's session when a row has none (workflows/agents.ts).
 *
 * The request keeps sessionId, the session that asks: answering resolves it
 * there, and who may answer is decided by that session, as before.
 */
import type { AskFrom, Session } from '../types';
import { movedToMain } from '../session/delegated';

/** How far up the walk goes (subagents nest a few levels at most). */
const MAX_DEPTH = 8;

export interface AskLookup {
  session(id: string): Session | undefined;
  /** A workflow run's session and name, when the hub has workflows. */
  run?(id: string): { sessionId?: string; name: string } | undefined;
}

/** meta.workflow of a workflow agent's session (workflows/agents.ts). */
function workflowMeta(s: Session): { runId: string; label?: string } | undefined {
  const w = s.meta?.workflow as { runId?: unknown; label?: unknown } | undefined;
  if (!w || typeof w.runId !== 'string' || !w.runId) return undefined;
  return { runId: w.runId, ...(typeof w.label === 'string' && w.label ? { label: w.label } : {}) };
}

/** The session above this one: its parent, or the session that started its workflow run. A session moved to the main list is a top session (session/delegated.ts). */
function upOf(s: Session, lookup: AskLookup): string | undefined {
  if (movedToMain(s)) return undefined;
  if (s.parentId) return s.parentId;
  const wf = workflowMeta(s);
  return wf ? lookup.run?.(wf.runId)?.sessionId : undefined;
}

/** The top session of `sessionId`, and who asks when that is not the top one. */
export function askOrigin(lookup: AskLookup, sessionId: string): { rootSessionId: string; from?: AskFrom } {
  const asker = lookup.session(sessionId);
  if (!asker) return { rootSessionId: sessionId };
  const chain: Session[] = [asker];
  const seen = new Set([asker.id]);
  for (let cur = asker, depth = 0; depth < MAX_DEPTH; depth++) {
    const upId = upOf(cur, lookup);
    if (!upId || seen.has(upId)) break;
    const up = lookup.session(upId);
    if (!up) break;
    chain.unshift(up);
    seen.add(up.id);
    cur = up;
  }
  const root = chain[0];
  if (root.id === asker.id) return { rootSessionId: asker.id };
  const wf = workflowMeta(asker);
  const run = wf ? lookup.run?.(wf.runId) : undefined;
  // a workflow agent's title is "<workflow> / <label>"
  const titled = / \/ /.test(asker.title) ? asker.title.split(' / ') : undefined;
  return {
    rootSessionId: root.id,
    from: {
      sessionId: asker.id,
      agent: asker.agent,
      label: wf?.label ?? (wf && titled ? titled.slice(1).join(' / ') : asker.title),
      ...(wf ? { workflow: { runId: wf.runId, name: run?.name ?? titled?.[0] ?? 'workflow' } } : {}),
      chain: chain.slice(1).map((s) => s.id),
    },
  };
}
