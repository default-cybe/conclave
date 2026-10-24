/**
 * Refusal fallback, the owner's "safety priority" (docs/DESIGN.md 47).
 *
 * The owner keeps an ordered list of models, each with an optional account
 * (models.refusalFallback, Settings > Models > Refusal fallback). When a
 * model refuses and its provider says so (stop reason refusal: Anthropic's
 * classifier stop, OpenAI's refusal content or content_filter, Gemini's
 * SAFETY and the like or a blocked prompt, Z.ai's sensitive), the runner
 * drops the refused reply and runs the same request on the next entry: the
 * same stored messages, converted for the new model the way a switch
 * converts them (transcript.ts). Nothing is added to the conversation and
 * the owner's words are never changed. It walks down the list until one
 * answers or the list ends; if every entry refuses, the last refusal stands.
 *
 * Reply text is never read to guess a refusal. An entry with an account is
 * pinned to it (stream.ts StreamPin): an API key's provider, or a signed in
 * plan by its CLIProxyAPI prefix. A plan without a prefix cannot be pinned:
 * CLIProxyAPI picks among the plans that have the model.
 *
 * Before the list: the plans and keys the owner marked "Use when a model
 * refuses" in Settings > Models > Accounts (AccountConfig.refusal). The same
 * model runs on each of them of the refused model's vendor, in the owner's
 * account order, skipping the one that refused and any that is paused, at a
 * limit or resting (AccountsService.refusalAccounts). Then the list runs as
 * before.
 *
 * A marked ChatGPT plan approved for Daybreak (its own model list has a
 * Daybreak alias) retries with access_programs {cyber: daybreak_blue}: a
 * refused GPT turn on the same model when it takes Blue, else on GPT-6-Sol,
 * also on the plan that refused when it was not asked with Blue; a refused
 * model of another maker (Claude) on GPT-6-Sol, after that maker's marked
 * plans. A list entry on such a plan whose model takes Blue asks for it too.
 * Only the attempt carries it: the session's own Cyber access is untouched.
 *
 * This module is the list and the walk; runner.ts runs it.
 */
import type { Engine } from '../engine/engine';
import type { AgentDef } from '../extensions/types';
import type { ConclaveConfig, RefusalFallbackEntry } from '../config/schema';
import type { Message, Session } from '../types';
import { accountsOf } from '../accounts/attached';
import { bareModel } from '../accounts/policy';
import { lookupModel } from '../providers/catalog';
import { parseModelRef } from '../providers/types';
import { parseRefusalEntries } from './refusal-entries';
import { isHiddenModel } from '../config/hidden';
import type { Served, StreamPin } from './stream';
import { DAYBREAK_BLUE_MODEL, cyberChoices, cyberLabel, type CyberProgram } from '../providers/access-programs';
import { vendorOfModel } from '../accounts/vendors';
import type { AccountDto } from '../client/accounts';

/** The list that applies to a session, and how. */
export interface RefusalPlan {
  entries: RefusalFallbackEntry[];
  /** Try the next entry on its own after a refusal. Off: only the "Try the next model" button walks the list. */
  auto: boolean;
  /** Keep the model that answered for the next turns. */
  stay: boolean;
  /** Whose list: the owner's, or the agent's own. */
  source: 'config' | 'agent';
  /** Some plan or key is marked "Use when a model refuses": those go first, same model. */
  tagged: boolean;
}

/** Where a refused reply came from in a walk: a marked plan or key, or the list entry at this index. Undefined: the chat's own model. */
export type RefusalStep = 'tagged' | number;

/** Whether some account is marked "Use when a model refuses" and on. */
function hasRefusalAccounts(cfg: ConclaveConfig): boolean {
  const list = cfg.models?.accounts;
  return Array.isArray(list) && list.some((a) => !!a && a.refusal === true && a.enabled !== false);
}

/**
 * The plan for a session's agent. An agent's own list replaces the owner's
 * and turns it on; an agent with `refusalFallback: off` has none. Undefined
 * when there is no list to walk.
 */
export function refusalPlan(cfg: ConclaveConfig, agent?: Pick<AgentDef, 'refusalFallback'>): RefusalPlan | undefined {
  const own = cfg.models?.refusalFallback;
  const stay = own?.stay === true;
  if (agent?.refusalFallback === false) return undefined;
  const tagged = hasRefusalAccounts(cfg);
  if (Array.isArray(agent?.refusalFallback) && agent.refusalFallback.length) {
    const entries = parseRefusalEntries(agent.refusalFallback);
    if (entries.length) return { entries, auto: true, stay, source: 'agent', tagged };
  }
  const entries = parseRefusalEntries(own?.entries);
  if (!entries.length && !tagged) return undefined;
  return { entries, auto: own?.enabled === true, stay, source: 'config', tagged };
}

/** One entry made concrete: what the loop runs and how the notices name it. */
export interface FallbackTarget {
  index: number;
  entry: RefusalFallbackEntry;
  /** The model ref the loop runs and stores on the reply. */
  ref: string;
  /** Kept on its provider and account (an entry with an account). */
  pin?: StreamPin;
  /** "Opus 5.5 (neu)". */
  label: string;
  /** A plan without a prefix: CLIProxyAPI picks which plan answers. */
  loose?: boolean;
  /** A plan or key marked "Use when a model refuses" (index -1), not a list entry. */
  tagged?: boolean;
  /** Sent on this attempt only (a Daybreak approved plan), in place of the session's Cyber access. */
  accessPrograms?: { cyber: CyberProgram };
}

/** Whether a plan is marked "Use when a model refuses" and approved for Daybreak Blue (its own list has the alias). */
function daybreakPlan(engine: Engine, id: string | undefined): boolean {
  if (!id) return false;
  const accounts = accountsOf(engine);
  try {
    return !!accounts?.account(id)?.refusal && !!accounts.credentialOf(id)?.daybreak?.includes('daybreak_blue');
  } catch {
    return false;
  }
}

/** "GPT-6-Sol, Daybreak Blue (Kai)": a Daybreak attempt says its program, and its model by the plan's own name. */
function withProgram(engine: Engine, provider: string, model: string, cyber: CyberProgram | undefined, acct: string): string {
  let name = modelWords(provider, model);
  if (cyber) {
    try {
      name = shortModelName(engine.providers.resolveAt(provider, model).info.name);
    } catch {
      /* no such provider: the catalog's words */
    }
  }
  return `${name}${cyber ? `, ${cyberLabel(cyber)}` : ''} (${acct})`;
}

/** "Claude Opus 5.5" -> "Opus 5.5": the name the owner reads in notices. */
export function shortModelName(name: string): string {
  return name.replace(/^Claude\s+/, '').trim() || name;
}

/** A model's short name from its provider and id, ignoring an account prefix. */
function modelWords(provider: string, model: string): string {
  return shortModelName(lookupModel(provider, bareModel(model)).name);
}

/** The words for an account id: the owner's label, else the id. */
function accountWords(engine: Engine, id: string | undefined): string | undefined {
  if (!id) return undefined;
  try {
    return accountsOf(engine)?.account(id)?.label ?? id;
  } catch {
    return id;
  }
}

/** "Opus 5.5 (neu)" for what answered or refused; a harness by its name ("Codex"). */
export function servedLabel(engine: Engine, served: Served): string {
  if (engine.config.get().providers[served.provider]?.type === 'acp') return engine.providerLabel(served.provider);
  const acct = accountWords(engine, served.account);
  const model = modelWords(served.provider, served.model);
  return acct ? `${model} (${acct})` : model;
}

/**
 * Where an entry runs. With an account: an API key's own provider, or the
 * gateway with the plan's prefix; a plan without a prefix goes to the gateway
 * by the bare id (loose). Without an account: the model ref as written, which
 * follows the owner's account order. Undefined when the account is unknown.
 */
export function targetFor(engine: Engine, entry: RefusalFallbackEntry, index: number): FallbackTarget | undefined {
  const { provider, model } = parseModelRef(entry.model);
  if (!entry.account) {
    let label = shortModelName(entry.model);
    try {
      const r = engine.providers.resolve(entry.model);
      label = modelWords(r.provider, r.model);
    } catch {
      /* an unknown model: its ref is its name */
    }
    return { index, entry, ref: entry.model, label };
  }
  const accounts = accountsOf(engine);
  let acct;
  try {
    acct = accounts?.account(entry.account);
  } catch {
    acct = undefined;
  }
  if (!acct) return undefined;
  const bare = bareModel(model || provider);
  // a marked plan approved for Daybreak asks for Blue on a model that takes it
  const cyber: CyberProgram | undefined = acct.kind === 'subscription' && daybreakPlan(engine, acct.id) && cyberChoices(bare).includes('daybreak_blue') ? 'daybreak_blue' : undefined;
  const label = withProgram(engine, acct.provider ?? provider, bare, cyber, acct.label);
  const programs = cyber ? { accessPrograms: { cyber } } : {};
  if (acct.kind === 'api') {
    const p = acct.provider ?? provider;
    return { index, entry, ref: `${p}/${bare}`, pin: { provider: p, model: bare, account: acct.id }, label };
  }
  const gw = accounts?.gateway ?? 'cliproxy';
  if (acct.prefix) {
    const wire = `${acct.prefix}/${bare}`;
    return { index, entry, ref: `${gw}/${wire}`, pin: { provider: gw, model: wire, account: acct.id }, label, ...programs };
  }
  return { index, entry, ref: `${gw}/${bare}`, pin: { provider: gw, model: bare }, label, loose: true, ...programs };
}

/**
 * The marked plans and keys a refusal of `origin` goes to first, same model,
 * in the owner's order. After the chat's own model: all but the one that
 * refused. After a marked one (Try the next model on its reply): the ones
 * after it. A plan without a short name cannot be reached alone and is left
 * out (marking one gives it a name).
 */
function taggedTargets(engine: Engine, plan: RefusalPlan, origin: Served, from: RefusalStep | undefined): FallbackTarget[] {
  if (!plan.tagged || typeof from === 'number') return [];
  const accounts = accountsOf(engine);
  if (!accounts) return [];
  const bare = bareModel(origin.model);
  // a GPT model (it has Cyber choices) moves to Blue on a Daybreak plan: the same model when it takes Blue, else GPT-6-Sol
  const gpt = cyberChoices(bare).length > 0;
  const blue = cyberChoices(bare).includes('daybreak_blue') ? bare : DAYBREAK_BLUE_MODEL;
  let list: Array<{ a: AccountDto; model: string; cyber?: CyberProgram }>;
  try {
    list = accounts.refusalAccounts(bare).map((a) => (gpt && a.kind === 'subscription' && daybreakPlan(engine, a.id) ? { a, model: blue, cyber: 'daybreak_blue' as const } : { a, model: bare }));
    // another maker's model (Claude): the Daybreak plans run GPT-6-Sol with Blue, after that maker's marked plans
    if (vendorOfModel(bare) !== 'openai') {
      for (const a of accounts.refusalAccounts(DAYBREAK_BLUE_MODEL)) if (a.kind === 'subscription' && daybreakPlan(engine, a.id)) list.push({ a, model: DAYBREAK_BLUE_MODEL, cyber: 'daybreak_blue' });
    }
  } catch {
    return [];
  }
  if (from === 'tagged') {
    const at = list.findIndex((x) => x.a.id === origin.account && x.model === bare);
    if (at >= 0) list = list.slice(at + 1);
  } else list = list.filter((x) => x.a.id !== origin.account || (x.cyber && x.cyber !== origin.cyber));
  const gw = accounts.gateway ?? 'cliproxy';
  const out: FallbackTarget[] = [];
  for (const { a, model, cyber } of list) {
    if (a.kind === 'api') {
      if (!a.provider) continue;
      const ref = `${a.provider}/${model}`;
      out.push({ index: -1, tagged: true, entry: { model: ref, account: a.id }, ref, pin: { provider: a.provider, model, account: a.id }, label: withProgram(engine, a.provider, model, undefined, a.label) });
    } else if (a.prefix) {
      const wire = `${a.prefix}/${model}`;
      const ref = `${gw}/${wire}`;
      out.push({ index: -1, tagged: true, entry: { model: ref, account: a.id }, ref, pin: { provider: gw, model: wire, account: a.id }, label: withProgram(engine, gw, model, cyber, a.label), ...(cyber ? { accessPrograms: { cyber } } : {}) });
    }
  }
  return out;
}

/** Where a stored reply refused in a walk (runner.ts writes it), for Try the next model. */
export function refusalStepOf(m: Pick<Message, 'meta'> | undefined): RefusalStep | undefined {
  const s = m?.meta?.refusalStep;
  return s === 'tagged' || (typeof s === 'number' && Number.isInteger(s) && s >= 0) ? s : undefined;
}

/** The step a running target is, for the reply it gives. */
export function stepOfTarget(t: FallbackTarget | undefined): RefusalStep | undefined {
  return t ? (t.tagged ? 'tagged' : t.index) : undefined;
}

/** Whether an entry names what just answered or refused. */
function matches(engine: Engine, t: FallbackTarget, served: Served): boolean {
  if (t.pin) {
    if (t.pin.provider !== served.provider || bareModel(t.pin.model) !== bareModel(served.model)) return false;
    // a Daybreak attempt is another try than the same model asked without Blue
    if (t.accessPrograms && t.accessPrograms.cyber !== served.cyber) return false;
    // the entry's account against the one that answered, when the hub knows it (a plan without a prefix is inferred)
    const want = t.entry.account;
    return !want || !served.account || want === served.account;
  }
  try {
    const r = engine.providers.resolve(t.ref);
    return r.provider === served.provider && bareModel(r.model) === bareModel(served.model);
  } catch {
    return false;
  }
}

/** Whether `t` would run what already refused or failed this turn. */
function alreadyTried(engine: Engine, t: FallbackTarget, tried: Served[]): boolean {
  return tried.some((s) => matches(engine, t, s));
}

/** Whether the hub can call an entry at all now: its provider on and set up, its account on. */
export function usable(engine: Engine, session: Pick<Session, 'accountId'>, t: FallbackTarget): boolean {
  if (isHiddenModel(engine.config.get(), t.ref) || isHiddenModel(engine.config.get(), t.entry.model)) return false;
  try {
    const reg = engine.registryFor(session);
    if (t.pin) {
      if (!reg.isEnabled(t.pin.provider) || !reg.isConfigured(t.pin.provider)) return false;
      const acct = t.pin.account ? accountsOf(engine)?.account(t.pin.account) : undefined;
      return !acct || acct.enabled;
    }
    const r = reg.resolve(t.ref);
    return !r.acp && reg.isEnabled(r.provider) && reg.isConfigured(r.provider);
  } catch {
    return false;
  }
}

/**
 * One turn's walk down the list. next() is asked after each refusal (or a
 * failed entry) and gives the entry to run, or undefined when none is left.
 */
export class RefusalWalk {
  /** The entry running now; undefined while the session's own model runs. */
  current?: FallbackTarget;
  /** What refused, in order, for the notices. */
  readonly refused: Served[] = [];
  private tried: Served[] = [];
  private pos = -1;
  /** What refused first: the marked plans run its model, and the list starts after the entry that matches it. */
  private origin?: Served;
  private marked: FallbackTarget[] = [];
  private markedPos = -1;

  constructor(
    private readonly engine: Engine,
    private readonly session: Pick<Session, 'accountId'>,
    readonly plan: RefusalPlan,
    /** Where the first refusal came from (refusalStepOf its reply); undefined for the chat's own model. */
    private readonly from?: RefusalStep,
  ) {}

  /**
   * The marked plans and keys first (same model), then the list entry after
   * the one that matches what refused first (or the running one), skipping
   * what was tried and what cannot be called.
   */
  next(failed: Served): FallbackTarget | undefined {
    this.tried.push(failed);
    if (!this.origin) {
      this.origin = failed;
      this.marked = taggedTargets(this.engine, this.plan, failed, this.from);
    }
    while (this.markedPos + 1 < this.marked.length) {
      const t = this.marked[++this.markedPos];
      const pin = t.pin!;
      if (this.tried.some((s) => s.account === pin.account && bareModel(s.model) === bareModel(pin.model) && (!t.accessPrograms || s.cyber === t.accessPrograms.cyber))) continue;
      if (!usable(this.engine, this.session, t)) continue;
      this.current = t;
      return t;
    }
    const entries = this.plan.entries;
    let from = this.current && !this.current.tagged ? this.current.index : !this.current && typeof this.from === 'number' ? this.from : -1;
    if (from < 0) {
      for (let i = 0; i < entries.length; i++) {
        const t = targetFor(this.engine, entries[i], i);
        if (t && matches(this.engine, t, this.origin)) {
          from = i;
          break;
        }
      }
    }
    for (let i = Math.max(from + 1, this.pos + 1); i < entries.length; i++) {
      const t = targetFor(this.engine, entries[i], i);
      if (!t || alreadyTried(this.engine, t, this.tried)) continue;
      if (!usable(this.engine, this.session, t)) continue;
      this.pos = i;
      this.current = t;
      return t;
    }
    return undefined;
  }

  /** A refusal: remember it, then the next entry. */
  onRefusal(served: Served): FallbackTarget | undefined {
    this.refused.push(served);
    return this.next(served);
  }
}

/** What refused, from a stored reply: its meta (runner.ts writes it), else its model ref. */
export function servedOf(m: Pick<Message, 'model' | 'meta'>): Served | undefined {
  const s = m.meta?.served as Served | undefined;
  if (s && typeof s.provider === 'string' && typeof s.model === 'string') return s;
  if (!m.model) return undefined;
  const { provider, model } = parseModelRef(m.model);
  return provider ? { provider, model } : undefined;
}

/** Notice words. Short and plain (house style). */
export const refusalWords = {
  trying: (from: string, to: string) => `${from} declined. Trying ${to}.`,
  answered: (from: string, to: string, stay: boolean) => `${from} declined. Answered by ${to}.${stay ? ` This chat now uses ${to}.` : ''}`,
  failed: (to: string, why: string) => `${to} could not answer: ${why.replace(/\.$/, '')}.`,
  exhausted: (from: string) => `${from} declined. No model is left in Refusal fallback.`,
  refused: 'The model refused to continue.',
  refusedCalls: 'The model refused, so the tool calls in its reply were not run.',
};
