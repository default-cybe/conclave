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
import type { FallbackPolicy, LimitSpec } from '../config/schema';
import type { ResolvedModel } from '../providers/registry';
import { ProviderError } from '../providers/types';
import { workflowsOf } from '../workflows/attached';
import { isUnattended } from './runner';
import { underParent } from './delegated';
import { accountsOf } from '../accounts/attached';

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

/*
 * Fallback policy (ideas item 8): where a task's automatic fallbacks may go,
 * and what they may cost. The guard runs at each automatic switch
 * (session/limits.ts handleLimit, session/stream.ts fallback, the refusal
 * walk, engine/subagent.ts), never for a switch the owner picks by hand.
 */

/** A session as the fallback policy reads it: itself, and its ancestors by parentId. */
export type PolicySession = Pick<Session, 'accountId'> & Partial<Pick<Session, 'id' | 'parentId' | 'meta' | 'routineId' | 'tags'>>;

/** The fallback policy of one node: its own (meta.limits.fallback), else the config for its place in the tree. */
function nodePolicy(engine: Engine, s: PolicySession): FallbackPolicy | undefined {
  const own = (s.meta?.limits as LimitSpec | undefined)?.fallback;
  if (own) return own;
  const lim = engine.config.get().limits;
  if (underParent(s)) return lim.subagent?.fallback;
  return s.routineId || (s.tags ?? []).includes('routine') ? lim.routine?.fallback : lim.session?.fallback;
}

/** Every ancestor remains binding; descendants may narrow, never relax, its policy. */
export function fallbackPolicyFor(engine: Engine, session: PolicySession): FallbackPolicy | undefined {
  let out: FallbackPolicy | undefined;
  const seen = new Set<string>();
  for (let s: PolicySession | undefined = session; s; s = underParent(s) ? engine.getSession(s.parentId!) : undefined) {
    if (s.id && seen.has(s.id)) break;
    if (s.id) seen.add(s.id);
    const p = nodePolicy(engine, s);
    if (!p) continue;
    out ??= {};
    if (p.providers?.length) out.providers = out.providers ? out.providers.filter((id) => p.providers!.includes(id)) : [...p.providers];
    if (p.paid === false) out.paid = false;
    if (p.costUsd !== undefined) {
      if (!Number.isFinite(p.costUsd) || p.costUsd < 0) out.costUsd = NaN;
      else out.costUsd = Math.min(out.costUsd ?? Infinity, p.costUsd);
    }
  }
  return out;
}

/** Whether a provider bills per token from the hub's own keys: a provider with signed in plans, or marked a subscription, does not. */
function paidProvider(engine: Engine, provider: string): boolean {
  if (engine.config.get().providers[provider]?.subscription) return false;
  try {
    return !accountsOf(engine)?.hasAccounts(provider);
  } catch {
    return true;
  }
}

/** The root of a task's tree for the cost ceiling: itself when it has no parent above. */
function policyRoot(engine: Engine, s: PolicySession): PolicySession {
  let cur = s;
  const seen = new Set<string>();
  while (underParent(cur) && !seen.has(cur.parentId!)) {
    seen.add(cur.parentId!);
    const up = engine.getSession(cur.parentId!);
    if (!up) break;
    cur = up;
  }
  return cur;
}

export interface FallbackCheck {
  ok: boolean;
  /** Why not, in the notices' words. */
  why?: string;
  /** The request's estimated billed cost, independent of whether a ceiling exists. */
  estimateUsd?: number;
  /** The destination runs on a pay-per-token key. */
  paid?: boolean;
  /** The destination is an external harness: the hub never moves a task onto one, so nothing is enforced. */
  harness?: boolean;
  /** No prepared input or reliable price was available. */
  costUnknown?: boolean;
}

/**
 * May an automatic fallback move this task to `dest` (already resolved when
 * the wire destination is known)? Its policy's allowed destinations, paid rule
 * and cost ceiling (FallbackPolicy). The ceiling counts the whole tree's list
 * cost plus the request's bound, so descendants and retries are inside it.
 * `selection` true only picks a destination (no request at hand): hard
 * restrictions still apply, but spend is authorized at execution. Without
 * `inputTokens`, or on a model with no price, the cost cannot be bounded:
 * not allowed at execution, so the caller parks or stops instead. No policy:
 * allowed.
 */
export function checkFallback(
  engine: Engine, session: PolicySession | undefined, dest: string | ResolvedModel, inputTokens?: number,
  outputTokens?: number, selection = false,
): FallbackCheck {
  const policy = session ? fallbackPolicyFor(engine, session) : undefined;
  let resolved: ResolvedModel;
  try {
    resolved = typeof dest === 'string' ? engine.providersFor(session?.accountId).resolve(dest) : dest;
  } catch {
    // No policy: nothing to enforce, and the switch itself reports a bad ref.
    return policy ? { ok: false, why: `${dest} cannot be resolved`, costUnknown: true } : { ok: true, costUnknown: true };
  }
  const paid = paidProvider(engine, resolved.provider);
  if (resolved.acp) return { ok: true, harness: true, paid, costUnknown: true };
  const priced = [resolved.info.inputPrice, resolved.info.outputPrice].every((p) => Number.isFinite(p) && p >= 0)
    && (resolved.info.inputPrice > 0 || resolved.info.outputPrice > 0);
  const out = outputTokens ?? Math.min(resolved.info.maxOutput, 32_000);
  const known = !paid || (priced && inputTokens !== undefined && Number.isFinite(inputTokens) && inputTokens >= 0 && Number.isFinite(out) && out >= 0);
  const estimateUsd = !paid ? 0 : known ? engine.providers.costOf(resolved.info, { inputTokens: inputTokens!, outputTokens: out, cacheReadTokens: 0, cacheWriteTokens: 0 }) : undefined;
  const extra = { paid, estimateUsd, costUnknown: !known };
  if (policy?.providers && !policy.providers.includes(resolved.provider)) {
    return { ok: false, why: `${engine.providerLabel(resolved.provider)} is not one of this task's allowed fallback destinations`, ...extra };
  }
  if (policy?.paid === false && paid) {
    return { ok: false, why: `${engine.providerLabel(resolved.provider)} is a paid key, and this task does not allow paid fallback`, ...extra };
  }
  const cap = policy?.costUsd;
  if (cap !== undefined) {
    if (!Number.isFinite(cap) || cap < 0) return { ok: false, why: 'the fallback ceiling must be finite and nonnegative', ...extra };
    // Availability probes lack a prepared request. Only execution may authorize spending.
    if (selection) return { ok: true, ...extra };
    if (!known) return { ok: false, why: priced ? 'the switch\'s cost cannot be estimated, and this task has a cost ceiling' : 'the destination has no price, so its cost cannot be bounded under this task\'s ceiling', ...extra };
    const rootId = policyRoot(engine, session!).id;
    const spent = rootId ? budgetUsed(engine, rootId) : 0;
    if (spent + estimateUsd! > cap) {
      return { ok: false, why: `this task has spent or reserved $${spent.toFixed(2)} of its $${cap.toFixed(2)} fallback ceiling, and the request would cost up to $${estimateUsd!.toFixed(2)}`, ...extra };
    }
  }
  return { ok: true, ...extra };
}

interface FallbackBudget { spent: number; held: number }

function budgetFor(engine: Engine, rootId: string): FallbackBudget {
  const saved = engine.getSession(rootId)?.meta?.fallbackBudget as FallbackBudget | undefined;
  // Usage rows include chores and failed attempts, unlike session stats.
  const row = engine.repos.db.query(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_id = t.id WHERE json_extract(s.meta, '$.movedFrom') IS NULL)
    SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE session_id IN tree`).get(rootId) as { cost: number };
  return { spent: Math.max(saved?.spent ?? 0, row.cost, subtreeUse(engine, rootId).costUsd), held: saved?.held ?? 0 };
}

function budgetUsed(engine: Engine, rootId: string): number {
  const b = budgetFor(engine, rootId);
  return b.spent + b.held;
}

/**
 * Reserve synchronously before every paid attempt of a task under a ceiling,
 * on its own model too: the ceiling counts the whole tree's billed spend, not
 * only the fallbacks'. A crash retains the hold rather than freeing unknown spend.
 */
export function reserveFallback(engine: Engine, session: PolicySession | undefined, resolved: ResolvedModel, inputTokens: number, maxOutput: number): ((costUsd?: number) => void) | undefined {
  const policy = session ? fallbackPolicyFor(engine, session) : undefined;
  if (policy?.costUsd === undefined || !paidProvider(engine, resolved.provider)) return undefined;
  // No provider tokenizer is available: twice the 4-characters-a-token estimate plus framing, never above the context window.
  const input = Math.min(resolved.info.contextWindow, Math.ceil(inputTokens * 2) + 1024);
  const prices = [resolved.info.inputPrice, resolved.info.cacheWritePrice, resolved.info.cacheWrite1hPrice ?? 0, resolved.info.cacheReadPrice];
  if (!Number.isFinite(input) || input <= 0 || !prices.every((p) => Number.isFinite(p) && p >= 0)) {
    throw new ProviderError('bad_request', 'The request cost cannot be bounded under this task\'s ceiling.', { code: 'fallback_policy' });
  }
  const bound = { ...resolved, info: { ...resolved.info, inputPrice: Math.max(...prices) } };
  const check = checkFallback(engine, session, bound, input, maxOutput);
  if (!check.ok) throw new ProviderError('bad_request', check.why!, { code: 'fallback_policy' });
  const rootId = policyRoot(engine, session!).id;
  if (!rootId) throw new ProviderError('bad_request', 'The task has no shared budget root.', { code: 'fallback_policy' });
  const usd = check.estimateUsd!;
  const b = budgetFor(engine, rootId);
  engine.patchMeta(rootId, { fallbackBudget: { spent: b.spent, held: b.held + usd } });
  let settled = false;
  return (costUsd = usd) => {
    if (settled) return;
    settled = true;
    const fresh = engine.getSession(rootId)?.meta?.fallbackBudget as FallbackBudget;
    engine.patchMeta(rootId, { fallbackBudget: { spent: fresh.spent + costUsd, held: Math.max(0, fresh.held - usd) } });
  };
}

/** One recorded automatic switch: where the task moved, and about what it costs. */
export interface AutoSwitch {
  at: number;
  from: string;
  to: string;
  /** Estimated billed cost of the first call after the switch, when a price was known. */
  estimateUsd?: number;
  /** The destination runs on a pay-per-token key. */
  paid?: boolean;
  /** An external harness (Claude Code, Codex): the hub does not manage its requests. */
  harness?: boolean;
  /** The request estimate was unavailable. */
  costUnknown?: boolean;
}

/**
 * Record an automatic switch on the session's meta (autoSwitches) and the
 * audit log, for the Usage page. Keeps the last 50 of a session.
 */
export function recordAutoSwitch(engine: Engine, sessionId: string | undefined, from: string, to: string, extra: Pick<AutoSwitch, 'estimateUsd' | 'paid' | 'harness' | 'costUnknown'> = {}): void {
  if (!sessionId) return;
  const prev = (engine.getSession(sessionId)?.meta?.autoSwitches as AutoSwitch[] | undefined) ?? [];
  engine.patchMeta(sessionId, { autoSwitches: [...prev, { at: Date.now(), from, to, ...extra }].slice(-50) });
  engine.audit(sessionId, 'switch', `${from} -> ${to}${extra.estimateUsd !== undefined ? ` (about $${extra.estimateUsd.toFixed(2)})` : ' (cost unknown)'}`);
}
