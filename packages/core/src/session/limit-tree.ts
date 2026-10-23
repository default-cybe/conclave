/**
 * Spend and work limits per session and per subagent tree (HARNESS-REVIEW
 * item 24). Each session is a node; a subagent's node sits under its
 * parent's, and a workflow agent's under its run's, whose budget is a node
 * too, so one check covers sessions, subagents and workflow runs. A node
 * counts its whole subtree:
 *
 * - tokens: output tokens, as workflow budgets count them
 * - costUsd: list cost from the session stats
 * - turns: model calls (assistant replies)
 * - minutes: working time, which leaves out waiting_reset, waiting_approval
 *   and waiting_input (engine.setStatus keeps the clock)
 *
 * The check runs before each model step as a runner extension, outermost
 * node first, so a subagent cannot loop on an inner limit while an outer one
 * is spent (inspect_ai). Past 80 percent of a limit an interactive session
 * asks once through the approval card; at the limit the step stops with a
 * notice. A cost limit on a model with no price asks once per tree.
 */
import type { Session } from '../types';
import type { Engine } from '../engine/engine';
import type { LimitSpec } from '../config/schema';
import { workflowsOf } from '../workflows/attached';
import { isUnattended } from './runner';
import { underParent } from './delegated';

export type { LimitSpec };
export type LimitKind = 'tokens' | 'costUsd' | 'turns' | 'minutes';

export interface LimitUse {
  tokens: number;
  costUsd: number;
  turns: number;
  minutes: number;
}

export interface LimitNode {
  /** session:<id> or workflow:<run id>. */
  key: string;
  label: string;
  limits: LimitSpec;
  used(): LimitUse;
}

/** Share of a limit past which an interactive session is asked once. */
export const SOFT_AT = 0.8;

const KINDS: LimitKind[] = ['tokens', 'costUsd', 'turns', 'minutes'];

/** Output tokens, cost, model calls and working time of a session and every session below it. */
export function subtreeUse(engine: Engine, rootId: string): LimitUse {
  const db = engine.repos.db;
  // a session moved to the main list (session/delegated.ts) is a tree of its own
  const tree = `WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_id = t.id WHERE json_extract(s.meta, '$.movedFrom') IS NULL)`;
  const rows = db
    .query(`${tree} SELECT id, json_extract(stats, '$.outputTokens') AS out, json_extract(stats, '$.costUsd') AS cost, json_extract(meta, '$.workMs') AS work FROM sessions WHERE id IN tree`)
    .all(rootId) as Array<{ id: string; out: number | null; cost: number | null; work: number | null }>;
  const turns = (db.query(`${tree} SELECT COUNT(*) AS n FROM messages WHERE session_id IN tree AND role = 'assistant' AND kind = 'normal'`).get(rootId) as { n: number }).n;
  let tokens = 0;
  let costUsd = 0;
  let workMs = 0;
  for (const r of rows) {
    tokens += r.out ?? 0;
    costUsd += r.cost ?? 0;
    workMs += (r.work ?? 0) + engine.runningFor(r.id);
  }
  return { tokens, costUsd, turns, minutes: workMs / 60_000 };
}

function has(l: LimitSpec | undefined): l is LimitSpec {
  return !!l && KINDS.some((k) => typeof l[k] === 'number' && l[k]! > 0);
}

/** The limits of one session's node: its own (meta.limits), else the config for its place in the tree. */
function sessionLimits(engine: Engine, s: Session): LimitSpec | undefined {
  const own = s.meta?.limits as LimitSpec | undefined;
  if (has(own)) return own;
  const lim = engine.config.get().limits;
  if (underParent(s)) return lim.subagent;
  return s.routineId || (s.tags ?? []).includes('routine') ? lim.routine : lim.session;
}

/** The nodes over a session, outermost first: its root, the sessions between, workflow runs, then itself. */
export function chainFor(engine: Engine, session: Session): LimitNode[] {
  const sessions: Session[] = [];
  for (let s: Session | undefined = session; s && sessions.length < 8; s = underParent(s) ? engine.getSession(s.parentId!) : undefined) sessions.unshift(s);
  const out: LimitNode[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    const runId = (s.meta?.workflow as { runId?: string } | undefined)?.runId;
    const run = runId ? workflowsOf(engine)?.budgetNode(runId) : undefined;
    if (run && !seen.has(`workflow:${runId}`)) {
      seen.add(`workflow:${runId}`);
      out.push({ key: `workflow:${runId}`, label: 'the workflow budget', limits: run.limits, used: run.used });
    }
    const limits = sessionLimits(engine, s);
    if (has(limits)) out.push({ key: `session:${s.id}`, label: s.id === session.id ? 'this session' : underParent(s) ? `subagent ${s.id}` : `session ${s.id}`, limits, used: () => subtreeUse(engine, s.id) });
  }
  return out;
}

export interface LimitHit {
  level: 'soft' | 'hard';
  node: LimitNode;
  kind: LimitKind;
  used: number;
  limit: number;
}

/** The first limit reached, outermost node first; a hard hit anywhere wins over a soft one. */
export function checkChain(chain: LimitNode[]): LimitHit | undefined {
  let soft: LimitHit | undefined;
  for (const node of chain) {
    const used = node.used();
    for (const kind of KINDS) {
      const limit = node.limits[kind];
      if (typeof limit !== 'number' || limit <= 0) continue;
      if (used[kind] >= limit) return { level: 'hard', node, kind, used: used[kind], limit };
      if (!soft && used[kind] >= limit * SOFT_AT) soft = { level: 'soft', node, kind, used: used[kind], limit };
    }
  }
  return soft;
}

function amount(kind: LimitKind, n: number): string {
  if (kind === 'costUsd') return `$${n.toFixed(2)}`;
  if (kind === 'minutes') return `${Math.round(n)} min of working time`;
  if (kind === 'turns') return `${Math.round(n)} model calls`;
  return `${Math.round(n).toLocaleString('en-US')} output tokens`;
}

/** A used figure next to its limit: "10", "$0.21", "130 min". */
function figure(kind: LimitKind, n: number): string {
  if (kind === 'costUsd') return `$${n.toFixed(2)}`;
  if (kind === 'minutes') return `${Math.round(n)} min`;
  return Math.round(n).toLocaleString('en-US');
}

/** The notice when a limit stops a step. */
export function limitText(hit: LimitHit): string {
  if (hit.node.key.startsWith('workflow:')) return 'The workflow budget is spent; this step stops here.';
  return `Stopped: ${hit.node.label} reached its limit of ${amount(hit.kind, hit.limit)} (${figure(hit.kind, hit.used)} used).`;
}

/** The root session of a tree, which keeps the answers to limit questions for the whole tree. */
function rootOf(engine: Engine, s: Session): Session {
  let cur = s;
  for (let i = 0; i < 8 && underParent(cur); i++) cur = engine.getSession(cur.parentId!) ?? cur;
  return cur;
}

/** Ask once per tree; the answer is kept on the root's meta.limitAnswers. */
async function askOnce(engine: Engine, session: Session, key: string, summary: string, signal: AbortSignal): Promise<boolean> {
  const root = rootOf(engine, session);
  const answers = (root.meta?.limitAnswers as Record<string, string> | undefined) ?? {};
  if (answers[key]) return answers[key] === 'allow';
  const res = await engine.requestApproval(session.id, { toolUseId: `limit:${key}`, tool: 'Limits', input: { key }, summary }, signal);
  const fresh = (engine.getSession(root.id)?.meta?.limitAnswers as Record<string, string> | undefined) ?? {};
  engine.patchMeta(root.id, { limitAnswers: { ...fresh, [key]: res.decision === 'allow' ? 'allow' : 'deny' } });
  return res.decision === 'allow';
}

/** Register the check as a runner extension (session/runner-ext.ts). */
export function attachLimits(engine: Engine): () => void {
  return engine.runnerExtensions.register({
    name: 'limits',
    async beforeStep(ctx) {
      const chain = chainFor(engine, ctx.session);
      if (!chain.length) return undefined;
      const unattended = isUnattended(ctx.session, ctx.mode, ctx.depth);
      // a cost limit cannot count a model with no price: ask once per tree (unattended runs go on, and say so once)
      if (chain.some((n) => (n.limits.costUsd ?? 0) > 0)) {
        let info;
        try {
          info = engine.providers.resolve(ctx.session.model).info;
        } catch {
          info = undefined;
        }
        if (info && !info.inputPrice && !info.outputPrice) {
          const key = `noprice:${ctx.session.model}`;
          if (unattended) {
            const root = rootOf(engine, ctx.session);
            if (!(root.meta?.limitAnswers as Record<string, string> | undefined)?.[key]) {
              engine.patchMeta(root.id, { limitAnswers: { ...((root.meta?.limitAnswers as Record<string, string>) ?? {}), [key]: 'allow' } });
              engine.notice(ctx.sessionId, `${ctx.session.model} has no price, so the cost limit does not count it. The other limits still apply.`, 'warning');
            }
          } else if (!(await askOnce(engine, ctx.session, key, `${ctx.session.model} has no price, so the cost limit cannot count it. Continue on it anyway?`, ctx.signal))) {
            return { stop: `Stopped: ${ctx.session.model} has no price, and a cost limit applies.` };
          }
        }
      }
      const hit = checkChain(chain);
      if (!hit) return undefined;
      if (hit.level === 'hard') {
        engine.audit(ctx.sessionId, 'limit', `${hit.node.key} ${hit.kind}: ${hit.used} of ${hit.limit}`);
        return { stop: limitText(hit) };
      }
      // soft: an interactive session is asked once per limit; nobody is there to ask in an unattended run
      if (unattended) return undefined;
      const key = `${hit.node.key}:${hit.kind}`;
      const who = hit.node.label[0].toUpperCase() + hit.node.label.slice(1);
      const ok = await askOnce(engine, ctx.session, key, `${who} used ${figure(hit.kind, hit.used)} of its limit of ${amount(hit.kind, hit.limit)}. Keep going?`, ctx.signal);
      return ok ? undefined : { stop: `Stopped at the owner's request: ${hit.node.label} is near its limit of ${amount(hit.kind, hit.limit)}.` };
    },
  });
}
