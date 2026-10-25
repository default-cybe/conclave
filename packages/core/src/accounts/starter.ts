/**
 * The window starter (docs/DESIGN.md 50). The idea is Lamplighter's, a
 * plugin for CLIProxyAPI (github.com/PosvdM/cpa-plugin-lamplighter).
 *
 * A plan's 5 hour window starts with the first request after a reset. When
 * nobody uses the account right after a reset, no window runs, and the next
 * one resets later than it could. So, for each signed in plan the owner
 * turned it on for:
 *
 * - The reset comes from what the hub already reads: the headers CLIProxyAPI
 *   saw on the account's last real response (every 60 s), the plan's usage
 *   page where Conclave reads one (Claude and ChatGPT, every 5 to 10 min),
 *   and the starter's own response. It reads the account again 30 s before
 *   a reset, and after its request until the window shows.
 * - 3 s after the reset, between the owner's hours (07:00 to 22:30 in the
 *   owner's zone by default), it sends one request that asks for "OK", with
 *   no tools and at most 4 output tokens, on the plan's cheapest model,
 *   pinned to that account. A reset outside the hours waits for the start.
 * - It counts only once the 5 hour window shows a fixed reset in the future.
 * - Safeguards: a sign-in failure, a 429, a model the plan does not take, or
 *   a window that does not start stop it for that account until the next
 *   day's start, with one notice. Network and server errors try again after
 *   5 and then 15 minutes; the third stops it for the day. A used up weekly
 *   window pauses it until that resets. A plan with no 5 hour window never
 *   gets a request.
 *
 * The request goes through the gateway provider like any call, so its usage
 * row is the account's, with source "starter". Pinning: an account with a
 * CLIProxyAPI prefix is asked as "prefix/model", which only that credential
 * serves; one without a prefix only when no other credential serves the
 * model. Otherwise it says it cannot pin, and sends nothing. A plan paid
 * with a key (the Z.ai Coding Plan) is asked on its own provider with its
 * key, and read again through its usage reader.
 *
 * Pure parts (hours, models, pinning, decide) take the clock as an argument
 * so the tests play a day at fixed times. No token or credential passes
 * through here; errors are kept as a few words, never a response body.
 */
import type { StarterDto, StarterState } from '../client/accounts';
import type { AccountStarter } from '../config/schema';
import type { ChatRequest, ModelInfo, Provider } from '../providers/types';
import type { KvRepo } from '../storage/repos';
import type { LimitWindow, Usage } from '../types';
import type { UsageInput } from '../usage/readers/common';
import { ProviderError } from '../providers/types';
import { catalogEntries } from '../providers/catalog';
import { OWNER_ID } from '../people/context';
import { logger } from '../util/log';
import { validZone, wallAt, zonedTime } from './period';
import { bareModel } from './policy';
import { vendorOfModel } from './vendors';
import { annotateWindow, governing, windowFull, windowScope } from './windows';

const log = logger('starter');

export const STARTER_JOB = 'accounts.starter';
export const starterJobKey = (account: string) => `starter:${account}`;
/** The only text of the request. */
export const STARTER_PROMPT = 'Reply with exactly OK and nothing else.';
export const STARTER_MAX_TOKENS = 4;
/** Usage rows of its requests: source and purpose. */
export const STARTER_SOURCE = 'starter';
export const DEFAULT_START = '07:00';
export const DEFAULT_END = '22:30';
/** The request goes this long after a reset. */
export const GRACE_MS = 3_000;
/** The account is read this long before a reset the starter will act on, and a used up week is read this long after its reset. */
export const CHECK_MS = 30_000;
/** Reads after a request, counted from it (Lamplighter's 5, 10, 15, 30 and 15 s apart). */
export const CONFIRM_AT_MS = [5_000, 15_000, 30_000, 60_000, 75_000];
/** From this read on, the plan's usage page is read too, not only the last response's headers. */
const CONFIRM_USAGE_FROM = 2;
/** Waits after a network or server error: 5, then 15 minutes. */
export const RETRY_MS = [5 * 60_000, 15 * 60_000];
/** Errors in a row that stop it for the day. */
export const MAX_FAILURES = 3;
/** No request this soon after one that started a window. */
const HOLD_MS = 60_000;
/** A CLIProxyAPI cooldown this short is waited out once, without counting as an error. */
const MAX_COOLDOWN_WAIT_MS = 10 * 60_000;
/** A model the plan refused is skipped this long. */
const REFUSED_FOR_MS = 24 * 3_600_000;
const FIVE_HOURS = 5 * 3_600_000;
const KV_STATE = 'accounts.starter';
const KV_NOTED = 'accounts.starterNoted';

// ---------------------------------------------------------------------------
// What the starter sees and keeps
// ---------------------------------------------------------------------------

/** One signed in plan as the starter sees it (AccountsService.starterFacts). No tokens. */
export interface StarterFacts {
  id: string;
  label: string;
  vendor: string;
  /** The gateway provider id that serves it. */
  provider: string;
  /** On in the owner's order and in CLIProxyAPI. */
  enabled: boolean;
  /** CLIProxyAPI does not serve it: paused there, or not signed in. */
  disabled: boolean;
  /** Signed out or failing, in words. */
  error?: string;
  /** Its windows as last read, also the ones whose reset passed. */
  windows: LimitWindow[];
  cooldowns: Array<{ model?: string; reason: string; until: number }>;
  /** Model ids it reaches. Undefined until read. */
  models?: string[];
  /** CLIProxyAPI's prefix for its model ids. */
  prefix?: string;
  starter?: AccountStarter;
}

/** What the starter keeps per account (kv accounts.starter), across restarts. */
export interface StarterMemory {
  /** Network and server errors in a row. */
  failures: number;
  retryAt?: number;
  lastAttempt?: number;
  /** When it last started a window. */
  lastSuccess?: number;
  lastModel?: string;
  /** A few words, never a response body. */
  lastError?: string;
  stoppedUntil?: number;
  stopReason?: string;
  /** The stop a notice went out for: one notice per stop. */
  notifiedUntil?: number;
  /** A request went out; its window is not confirmed yet. */
  sending?: { at: number; model: string; step: number };
  /** The 5 hour window from the request's own response (a gateway that passes headers on). */
  own?: LimitWindow;
  /** The last reading of the 5 hour window, to tell a running window from a placeholder. */
  seen?: { at: number; reset?: number };
  /** The usage page shows a placeholder reset that moves with each reading: no window runs. */
  rolling?: boolean;
  /** The last reading's reset is fixed: it came from a response's headers, or two usage readings agree on it. */
  fixed?: boolean;
  /** A used up weekly window held it until then; the account is read once that passed. */
  pausedUntil?: number;
  /** The reset the read before it was for. */
  checkedFor?: number;
  /** When a CLIProxyAPI cooldown last put a request off. */
  cooldownAt?: number;
  /** Models the plan refused, by when. */
  refused?: Record<string, number>;
}

const fresh = (): StarterMemory => ({ failures: 0 });

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

export interface Hours {
  /** Minutes after midnight. */
  start: number;
  end: number;
  tz: string;
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "07:00" -> 420. Undefined when it is not a time of day. */
export function parseClock(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = HM.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

export function clockText(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function hoursOf(cfg: AccountStarter | undefined, zone: string): Hours {
  const start = parseClock(cfg?.start) ?? parseClock(DEFAULT_START)!;
  let end = parseClock(cfg?.end) ?? parseClock(DEFAULT_END)!;
  if (end === start) end = parseClock(DEFAULT_END)!;
  return { start, end, tz: validZone(cfg?.tz) ?? validZone(zone) ?? 'UTC' };
}

/** The allowed span that begins on the wall date of `day` (y, mo, d): it ends the next day when end is not after start. */
function span(h: Hours, y: number, mo: number, d: number): { start: number; end: number } {
  return {
    start: zonedTime(h.tz, y, mo, d, Math.floor(h.start / 60), h.start % 60),
    end: zonedTime(h.tz, y, mo, d + (h.end <= h.start ? 1 : 0), Math.floor(h.end / 60), h.end % 60),
  };
}

function spansAround(t: number, h: Hours): Array<{ start: number; end: number }> {
  const w = wallAt(t, h.tz);
  return [-1, 0, 1, 2].map((k) => span(h, w.y, w.mo, w.d + k));
}

/** Within the hours, ends included. */
export function inHours(t: number, h: Hours): boolean {
  return spansAround(t, h).some((s) => s.start <= t && t <= s.end);
}

/** The first start of the hours after t. */
export function nextStart(t: number, h: Hours): number {
  return Math.min(...spansAround(t, h).map((s) => s.start).filter((s) => s > t));
}

// ---------------------------------------------------------------------------
// Models and pinning
// ---------------------------------------------------------------------------

function versionOf(id: string): number[] {
  return (bareModel(id).match(/\d+/g) ?? []).map(Number);
}

/** Newer first: the higher number at the first place they differ; more numbers is newer when one runs out. */
function newerFirst(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}

/**
 * The models to ask, cheapest kind first and the newest of each kind first:
 * Claude the newest Haiku, then Sonnet; ChatGPT the newest Luna, then nano,
 * mini and the rest of GPT; Gemini Flash, then Flash-Lite; GLM (the Z.ai
 * Coding Plan) Flash, then Air. From the plan's own list when it was read,
 * else the catalog. Other plans: none.
 */
export function starterCandidates(vendor: string, models?: string[]): string[] {
  const list = [...new Set((models ?? catalogEntries(vendor as never).map((e) => e.id)).map(bareModel))];
  const pick = (test: (m: string) => boolean) => list.filter((m) => test(m.toLowerCase())).sort(newerFirst);
  const plain = (m: string) => !/thinking|image|audio|realtime|tts|search|oss/.test(m);
  let out: string[] = [];
  if (vendor === 'anthropic') {
    out = [...pick((m) => m.startsWith('claude-') && m.includes('haiku') && plain(m)), ...pick((m) => m.startsWith('claude-') && m.includes('sonnet') && plain(m))];
  } else if (vendor === 'openai') {
    const gpt = (m: string) => m.startsWith('gpt-') && plain(m) && !/codex|-pro\b/.test(m);
    out = [...pick((m) => gpt(m) && m.includes('luna')), ...pick((m) => gpt(m) && m.includes('nano')), ...pick((m) => gpt(m) && m.includes('mini')), ...pick(gpt)];
  } else if (vendor === 'gemini') {
    out = [...pick((m) => m.startsWith('gemini-') && m.includes('flash') && !m.includes('lite') && plain(m)), ...pick((m) => m.startsWith('gemini-') && m.includes('flash-lite') && plain(m))];
  } else if (vendor === 'zai') {
    out = [...pick((m) => m.startsWith('glm-') && m.includes('flash') && plain(m)), ...pick((m) => m.startsWith('glm-') && m.includes('air') && plain(m))];
  }
  return [...new Set(out)];
}

/** The models to try now: the owner's, else the candidates without the ones the plan refused lately (all of them when that leaves none). */
export function modelsToTry(f: StarterFacts, mem: StarterMemory, now: number): string[] {
  const own = f.starter?.model?.trim();
  if (own) return [own];
  const all = starterCandidates(f.vendor, f.models);
  const ok = all.filter((m) => !(mem.refused?.[m] && now - mem.refused[m] < REFUSED_FOR_MS));
  return (ok.length ? ok : all).slice(0, 2);
}

const sameModel = (a: string, b: string) => bareModel(a).toLowerCase() === bareModel(b).toLowerCase();

/**
 * The model id that reaches this account and no other: "prefix/model" when
 * no other served credential has its prefix, the bare id when no other
 * served credential offers it. Undefined when neither holds.
 */
export function pinFor(f: StarterFacts, all: StarterFacts[], model: string): string | undefined {
  const bare = bareModel(model);
  // only accounts on the same provider can take the id (a key plan has its own provider)
  const others = all.filter((o) => o.id !== f.id && !o.disabled && o.provider === f.provider);
  if (f.prefix) return others.some((o) => o.prefix === f.prefix) ? undefined : `${f.prefix}/${bare}`;
  // a credential with a prefix serves bare ids too (CLIProxyAPI's force-model-prefix is off); an unread list serves its vendor's
  const serves = (o: StarterFacts) => (o.models ? o.models.some((m) => sameModel(m, bare)) : o.vendor === (vendorOfModel(bare) ?? f.vendor));
  return others.some(serves) ? undefined : bare;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const annotated = (w: LimitWindow) => (w.kind ? w : annotateWindow(w));

/** The plan's 5 hour window, the newest reading: a session window for every model. */
export function fiveHour(windows: LimitWindow[]): LimitWindow | undefined {
  return windows
    .map(annotated)
    .filter((w) => w.kind === 'session' && !windowScope(w.name))
    .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0];
}

/** A weekly or longer window used up for this model: every request fails until it resets. */
export function usedUp(windows: LimitWindow[], model: string, now: number): LimitWindow | undefined {
  return governing(windows.map(annotated), model)
    .filter((w) => (w.kind === 'weekly' || w.kind === 'monthly') && windowFull(w, now))
    .sort((a, b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0];
}

/**
 * Take a new reading of the 5 hour window. A plan usage page can show an
 * unstarted window as a reset about 5 hours ahead that moves with every
 * reading; two readings tell it from a running window, whose reset stays
 * put. A reading from a response's headers is never one: a request starts
 * the window. Returns true when the memory changed.
 */
export function observe(mem: StarterMemory, w: LimitWindow | undefined): boolean {
  if (!w?.observedAt || (mem.seen && w.observedAt <= mem.seen.at)) return false;
  let rolling = false;
  let fixed = !!w.resetsAt && w.source !== 'oauth';
  if (w.source === 'oauth' && w.resetsAt && mem.seen?.reset !== undefined) {
    const elapsed = w.observedAt - mem.seen.at;
    const shift = w.resetsAt - mem.seen.reset;
    if (elapsed >= 2_000) {
      const tolerance = Math.min(10_000, Math.max(3_000, elapsed * 0.02));
      rolling = Math.abs(w.resetsAt - w.observedAt - (w.windowMs ?? FIVE_HOURS)) <= 120_000 && Math.abs(shift - elapsed) <= tolerance;
      fixed = Math.abs(shift) <= 3_000;
    }
  }
  mem.rolling = rolling;
  mem.fixed = fixed;
  mem.seen = { at: w.observedAt, ...(w.resetsAt ? { reset: w.resetsAt } : {}) };
  return true;
}

/**
 * The window runs: a 5 hour reset still ahead, read at or after `since`,
 * and fixed. One usage page reading is not enough, since a placeholder
 * looks the same; headers are, since a request starts the window.
 */
export function windowStarted(mem: StarterMemory, w: LimitWindow | undefined, since: number, now: number): boolean {
  if (!w?.resetsAt || w.resetsAt <= now || (w.observedAt ?? 0) < since - 5_000) return false;
  return w.source !== 'oauth' || (!!mem.fixed && !mem.rolling);
}

/** Its windows and the one from its own last response, which counts until a newer reading comes. */
const windowsWith = (f: StarterFacts, mem: StarterMemory): LimitWindow[] => (mem.own ? [...f.windows, mem.own] : f.windows);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type FailureKind = 'stop' | 'retry' | 'model' | 'cooldown';

/** What an error means for the starter, in a few words. Never the body. */
export function classifyError(e: ProviderError): { kind: FailureKind; words: string; waitMs?: number } {
  const text = `${e.message} ${e.body ?? ''}`;
  // CLIProxyAPI cools a credential down until just after the provider's reset: wait it out once
  if (/cooling down|model_cooldown/i.test(text)) {
    const m = /"?reset_seconds"?\s*[:=]\s*(\d+)/i.exec(text);
    return { kind: 'cooldown', words: 'CLIProxyAPI cooldown', waitMs: m ? Number(m[1]) * 1000 : e.retryAfterMs };
  }
  switch (e.kind) {
    case 'auth':
      return { kind: 'stop', words: 'Sign-in failed' };
    case 'rate_limit':
    case 'quota':
      return { kind: 'stop', words: !e.status || e.status === 429 ? '429' : `HTTP ${e.status}` };
    case 'bad_request':
    case 'context_length':
      return { kind: 'model', words: 'Model not available' };
    case 'overloaded':
      return { kind: 'retry', words: 'Provider busy' };
    case 'server':
      return { kind: 'retry', words: 'Server error' };
    case 'network':
      return { kind: 'retry', words: 'Network error' };
    default:
      return { kind: 'retry', words: 'Error' };
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type WakeAction = 'fire' | 'check' | 'confirm' | 'replan';

export interface Decision {
  state: StarterState;
  /** When to look at this account again, and what to do then. */
  wake?: { at: number; action: WakeAction };
  nextAt?: number;
  until?: number;
  reason?: string;
  /** The model it would ask, and the id that pins it to the account. */
  model?: string;
  pinned?: string;
}

/** What the starter does for one account now. Pure: the memory is read, not changed. */
export function decide(f: StarterFacts, all: StarterFacts[], mem: StarterMemory, now: number, zone: string): Decision {
  if (!f.starter?.enabled) return { state: 'off' };
  if (mem.sending) {
    return { state: 'checking', wake: { at: mem.sending.at + CONFIRM_AT_MS[Math.min(mem.sending.step, CONFIRM_AT_MS.length - 1)], action: 'confirm' }, model: mem.sending.model };
  }
  if (!f.enabled) return { state: 'waiting', reason: 'Account paused' };
  if (f.error) return { state: 'waiting', reason: f.error };
  if (!f.windows.length) return { state: 'waiting', reason: 'No usage read yet' };
  const w5 = fiveHour(windowsWith(f, mem));
  if (!w5) return { state: 'never', reason: 'No 5 hour window' };
  const model = modelsToTry(f, mem, now)[0];
  if (!model) return { state: 'setup', reason: 'Pick a model' };
  if (f.models && !f.models.some((m) => sameModel(m, model))) return { state: 'setup', reason: `Does not offer ${bareModel(model)}`, model };
  const pinned = pinFor(f, all, model);
  if (!pinned) return { state: 'setup', reason: 'Cannot pin a request to it', model };
  const hours = hoursOf(f.starter, zone);
  const base = { model, pinned };
  if (mem.stoppedUntil && mem.stoppedUntil > now) return { ...base, state: 'stopped', until: mem.stoppedUntil, reason: mem.stopReason, wake: { at: mem.stoppedUntil, action: 'replan' } };
  const week = usedUp(f.windows, model, now);
  if (week) return { ...base, state: 'paused', reason: 'Weekly limit used up', ...(week.resetsAt ? { until: week.resetsAt, wake: { at: week.resetsAt + CHECK_MS, action: 'check' as const } } : {}) };
  const running = !!w5.resetsAt && w5.resetsAt > now && !mem.rolling;
  // no window runs: due since the reset passed, or since the reading that showed none. Not "now",
  // so the time stays put while the clock moves and the page is not told of a change each second
  const since = w5.resetsAt && w5.resetsAt <= now && !mem.rolling ? w5.resetsAt + GRACE_MS : Math.min(now, w5.observedAt ?? now);
  let at = running ? w5.resetsAt! + GRACE_MS : since;
  if (mem.retryAt && mem.retryAt > at) at = mem.retryAt;
  if (mem.lastSuccess && mem.lastSuccess + HOLD_MS > at) at = mem.lastSuccess + HOLD_MS;
  const cooling = f.cooldowns.filter((c) => c.until > now && (!c.model || sameModel(c.model, model))).map((c) => c.until + GRACE_MS);
  if (cooling.length) at = Math.max(at, ...cooling);
  // a time already past goes now, so now must be inside the hours
  const goes = Math.max(at, now);
  if (!inHours(goes, hours)) at = nextStart(goes, hours);
  // read the account 30 s before the reset it acts on, so the time is the latest; too close to the reset, it just goes
  const check = running && at === w5.resetsAt! + GRACE_MS && mem.checkedFor !== w5.resetsAt && now < w5.resetsAt! - 5_000;
  const wake = check ? { at: Math.max(now, w5.resetsAt! - CHECK_MS), action: 'check' as const } : { at, action: 'fire' as const };
  return { ...base, state: 'scheduled', nextAt: at, wake, ...(mem.failures && mem.lastError ? { reason: mem.lastError } : {}) };
}

/** The request: "OK" only, no tools, no thinking, at most 4 tokens out. */
export function starterRequest(model: string): ChatRequest {
  return {
    model,
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: STARTER_PROMPT }] }],
    maxTokens: STARTER_MAX_TOKENS,
    thinking: { off: true },
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface StarterSendResult {
  usage: Usage;
  /** Windows from the response's own headers, when the gateway passed them on. */
  windows: LimitWindow[];
  latencyMs: number;
  costUsd?: number;
}

export interface WindowStarterDeps {
  /** Each signed in plan, with its windows (AccountsService.starterFacts). */
  facts: () => StarterFacts[];
  kv: Pick<KvRepo, 'get' | 'set'>;
  /** The owner's zone, for the hours when an account sets none. */
  zone: () => string;
  /** Wake this account's job at a time, or cancel it (undefined). */
  plan: (account: string, at: number | undefined) => void;
  /** Send the request on the gateway provider. Throws ProviderError. */
  send: (provider: string, req: ChatRequest) => Promise<StarterSendResult>;
  /** Read the account again now: the last response's headers, and its plan usage when asked. */
  read: (account: string, opts: { usage?: boolean }) => Promise<void>;
  /** Write a usage row. */
  record: (row: UsageInput) => void;
  /** Tell the owner once per stop. */
  notify: (title: string, body: string) => void;
  /** The views changed: the accounts page should show them. */
  changed?: () => void;
  now?: () => number;
}

export class WindowStarter {
  private memory: Record<string, StarterMemory>;
  private planned = new Map<string, number>();
  private busy = new Set<string>();
  private lastViews = '';
  private disposed = false;

  constructor(private readonly deps: WindowStarterDeps) {
    const saved = deps.kv.get<Record<string, StarterMemory>>(KV_STATE, {});
    this.memory = saved && typeof saved === 'object' ? saved : {};
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private mem(id: string): StarterMemory {
    return (this.memory[id] ??= fresh());
  }

  private save(): void {
    this.deps.kv.set(KV_STATE, this.memory);
  }

  private zone(): string {
    try {
      return this.deps.zone();
    } catch {
      return 'UTC';
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  /** The owner turned one on: the page has shown the note. */
  noteShown(): void {
    this.deps.kv.set(KV_NOTED, true);
  }

  noted(): boolean {
    return this.deps.kv.get<boolean>(KV_NOTED, false) === true;
  }

  /** What one account's starter is doing, for the accounts page. */
  view(f: StarterFacts, all: StarterFacts[]): StarterDto {
    const now = this.now();
    const cfg = f.starter ?? {};
    const mem = this.memory[f.id] ?? fresh();
    const zone = validZone(cfg.tz) ?? validZone(this.zone()) ?? 'UTC';
    const d = decide(f, all, mem, now, zone);
    const auto = starterCandidates(f.vendor, f.models)[0];
    return {
      enabled: !!cfg.enabled,
      ...(cfg.model ? { model: cfg.model } : {}),
      start: clockText(parseClock(cfg.start) ?? parseClock(DEFAULT_START)!),
      end: clockText(parseClock(cfg.end) ?? parseClock(DEFAULT_END)!),
      ...(cfg.tz ? { tz: cfg.tz } : {}),
      zone,
      ...(auto ? { autoModel: auto } : {}),
      state: d.state,
      ...(d.nextAt !== undefined ? { nextAt: d.nextAt } : {}),
      ...(mem.lastSuccess ? { startedAt: mem.lastSuccess } : {}),
      ...(d.until !== undefined ? { until: d.until } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
      ...(mem.failures && d.state === 'scheduled' ? { failures: mem.failures } : {}),
      ...(mem.lastModel ? { lastModel: mem.lastModel } : {}),
    };
  }

  /** Look at every account and set when each is woken next. Called on start and whenever the accounts change. */
  plan(): void {
    if (this.disposed) return;
    const all = this.deps.facts();
    const now = this.now();
    let dirty = false;
    const on = new Set<string>();
    for (const f of all) {
      if (!f.starter?.enabled) continue;
      on.add(f.id);
      if (this.busy.has(f.id)) continue;
      const mem = this.mem(f.id);
      if (observe(mem, fiveHour(windowsWith(f, mem)))) dirty = true;
      if (mem.stoppedUntil && mem.stoppedUntil <= now) {
        delete mem.stoppedUntil;
        delete mem.stopReason;
        dirty = true;
      }
      const d = decide(f, all, mem, now, this.zone());
      if (d.state === 'paused' && d.until !== undefined && mem.pausedUntil !== d.until) {
        mem.pausedUntil = d.until;
        dirty = true;
      }
      // the week reset: read the account before the next request
      this.schedule(f.id, mem.pausedUntil !== undefined && d.state !== 'paused' ? Math.max(now, mem.pausedUntil + CHECK_MS) : d.wake?.at);
    }
    for (const id of [...this.planned.keys()]) if (!on.has(id)) this.schedule(id, undefined);
    // the memory of an account that is gone or off goes with it
    for (const id of Object.keys(this.memory)) {
      if (!on.has(id) && !this.busy.has(id)) {
        delete this.memory[id];
        dirty = true;
      }
    }
    if (dirty) this.save();
    const views = JSON.stringify(all.filter((f) => on.has(f.id)).map((f) => this.view(f, all)));
    if (views !== this.lastViews) {
      this.lastViews = views;
      this.deps.changed?.();
    }
  }

  private schedule(id: string, at: number | undefined): void {
    if (this.planned.get(id) === at) return;
    if (at === undefined) this.planned.delete(id);
    else this.planned.set(id, at);
    this.deps.plan(id, at);
  }

  /** When an account is woken next (tests and diagnostics). */
  plannedAt(id: string): number | undefined {
    return this.planned.get(id);
  }

  /** The job: do what is due for one account, then plan it again. */
  async run(id: string): Promise<void> {
    if (this.disposed || this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const all = this.deps.facts();
      const f = all.find((x) => x.id === id);
      if (!f?.starter?.enabled) return;
      const mem = this.mem(id);
      const now = this.now();
      observe(mem, fiveHour(windowsWith(f, mem)));
      if (mem.stoppedUntil && mem.stoppedUntil <= now) {
        delete mem.stoppedUntil;
        delete mem.stopReason;
      }
      const d = decide(f, all, mem, now, this.zone());
      // a used up week that reset: read the account once, then plan the request on what it says
      if (mem.pausedUntil !== undefined && d.state !== 'paused') {
        if (now + 250 < mem.pausedUntil + CHECK_MS) return;
        delete mem.pausedUntil;
        await this.deps.read(id, { usage: true }).catch((err) => log.debug(`read after a weekly reset: ${(err as Error).message}`));
        return;
      }
      if (!d.wake || d.wake.at > now + 250) return;
      if (d.wake.action === 'confirm') await this.confirm(f, mem);
      else if (d.wake.action === 'check') {
        const reset = fiveHour(windowsWith(f, mem))?.resetsAt;
        await this.deps.read(id, { usage: true }).catch((err) => log.debug(`read before a reset: ${(err as Error).message}`));
        mem.checkedFor = reset;
      } else if (d.wake.action === 'fire') await this.fire(f, all, mem);
    } catch (err) {
      log.warn(`window starter for ${id}: ${(err as Error).message}`);
    } finally {
      this.busy.delete(id);
      this.save();
      this.planned.delete(id);
      this.plan();
    }
  }

  private async fire(f: StarterFacts, all: StarterFacts[], mem: StarterMemory): Promise<void> {
    const start = this.now();
    const tries = modelsToTry(f, mem, start);
    const own = !!f.starter?.model?.trim();
    mem.lastAttempt = start;
    for (let i = 0; i < tries.length; i++) {
      const pinned = pinFor(f, all, tries[i]);
      if (!pinned) continue;
      const req = starterRequest(pinned);
      let res: StarterSendResult;
      try {
        res = await this.deps.send(f.provider, req);
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError('network', (err as Error)?.message ?? String(err));
        const c = classifyError(e);
        // the plan refused the model: the next candidate once, and the refused one rests a day
        if (c.kind === 'model' && !own && i < tries.length - 1) {
          (mem.refused ??= {})[tries[i]] = this.now();
          continue;
        }
        this.failed(f, mem, c.kind === 'model' ? 'stop' : c.kind, c.words, c.waitMs);
        return;
      }
      if (i > 0) log.info(`window starter for ${f.id}: the plan refused ${tries[0]}, ${tries[i]} worked`);
      this.deps.record({
        source: STARTER_SOURCE,
        purpose: STARTER_SOURCE,
        provider: f.provider,
        model: pinned,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        cacheReadTokens: res.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: res.usage.cacheWriteTokens ?? 0,
        reasoningTokens: res.usage.reasoningTokens ?? 0,
        ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
        latencyMs: res.latencyMs,
        account: f.id,
        // the hub's plan, so the owner's row
        accountId: OWNER_ID,
        paidBy: 'hub',
      });
      mem.lastModel = pinned;
      const at = this.now();
      const w = fiveHour(res.windows.map((x) => annotateWindow(x, { source: 'headers', observedAt: at })));
      if (w) mem.own = w;
      else delete mem.own;
      mem.sending = { at: start, model: pinned, step: 0 };
      if (mem.own) observe(mem, mem.own);
      if (windowStarted(mem, mem.own, start, at)) this.succeeded(f, mem);
      return;
    }
    this.failed(f, mem, 'stop', 'Cannot pin a request to it');
  }

  private async confirm(f: StarterFacts, mem: StarterMemory): Promise<void> {
    const s = mem.sending!;
    await this.deps.read(f.id, { usage: s.step >= CONFIRM_USAGE_FROM }).catch((err) => log.debug(`read after a start: ${(err as Error).message}`));
    const now = this.now();
    const after = this.deps.facts().find((x) => x.id === f.id) ?? f;
    const w = fiveHour(windowsWith(after, mem));
    observe(mem, w);
    if (windowStarted(mem, w, s.at, now)) {
      this.succeeded(after, mem);
      return;
    }
    s.step++;
    if (s.step < CONFIRM_AT_MS.length) return;
    delete mem.sending;
    delete mem.own;
    this.failed(f, mem, 'stop', 'No window started');
  }

  private succeeded(f: StarterFacts, mem: StarterMemory): void {
    const now = this.now();
    const reset = fiveHour(windowsWith(f, mem))?.resetsAt;
    delete mem.sending;
    // the window from its own response stays until a newer reading of the account comes
    const read = fiveHour(f.windows)?.observedAt;
    if (mem.own && read !== undefined && read >= (mem.own.observedAt ?? 0)) delete mem.own;
    mem.lastSuccess = now;
    mem.failures = 0;
    delete mem.retryAt;
    delete mem.lastError;
    delete mem.cooldownAt;
    log.info(`window starter for ${f.id}: started a window${reset ? `, it resets ${new Date(reset).toISOString()}` : ''}`);
  }

  private failed(f: StarterFacts, mem: StarterMemory, kind: FailureKind, words: string, waitMs?: number): void {
    const now = this.now();
    delete mem.sending;
    delete mem.own;
    // a short CLIProxyAPI cooldown right after a reset: try when it ends, once, without counting it
    if (kind === 'cooldown') {
      const recent = mem.cooldownAt !== undefined && now - mem.cooldownAt < 2 * MAX_COOLDOWN_WAIT_MS;
      if (waitMs !== undefined && waitMs <= MAX_COOLDOWN_WAIT_MS && !recent) {
        mem.cooldownAt = now;
        mem.retryAt = now + waitMs + GRACE_MS;
        mem.lastError = words;
        log.info(`window starter for ${f.id}: CLIProxyAPI cools the account down, trying again in ${Math.round((waitMs + GRACE_MS) / 1000)} s`);
        return;
      }
      kind = 'retry';
    }
    mem.failures++;
    mem.lastError = words;
    if (kind === 'retry' && mem.failures < MAX_FAILURES) {
      mem.retryAt = now + RETRY_MS[Math.min(mem.failures - 1, RETRY_MS.length - 1)];
      log.info(`window starter for ${f.id}: ${words}, trying again in ${Math.round((mem.retryAt - now) / 60_000)} min`);
      return;
    }
    const zone = this.zone();
    const until = nextStart(now, hoursOf(f.starter, zone));
    mem.stoppedUntil = until;
    mem.stopReason = words;
    mem.failures = 0;
    delete mem.retryAt;
    log.warn(`window starter for ${f.id}: ${words}, stopped until ${new Date(until).toISOString()}`);
    if (mem.notifiedUntil !== until) {
      mem.notifiedUntil = until;
      const tz = hoursOf(f.starter, zone).tz;
      this.deps.notify(`Window starter stopped: ${f.label}`, `${words}. It tries again ${dayWords(until, now, tz)}.`);
    }
  }
}

/** "at 07:00", "tomorrow at 07:00", "Sat at 07:00", in the zone. */
export function dayWords(t: number, now: number, tz: string): string {
  const w = wallAt(t, tz);
  const n = wallAt(now, tz);
  const hm = `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
  const days = Math.round((Date.UTC(w.y, w.mo - 1, w.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 86_400_000);
  if (days <= 0) return `at ${hm}`;
  if (days === 1) return `tomorrow at ${hm}`;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]} at ${hm}`;
}

// ---------------------------------------------------------------------------
// Sending through the provider registry
// ---------------------------------------------------------------------------

/** What sendStarter needs of the registry. */
export interface StarterRegistry {
  get(provider: string): Provider | undefined;
  resolveAt(provider: string, model: string): { info: ModelInfo };
  costOf(info: ModelInfo, usage: Usage): number;
}

/** One request on the gateway provider, as any call goes: its wire, its headers, no account fallback and no retries. */
export async function sendStarter(registry: StarterRegistry, provider: string, req: ChatRequest): Promise<StarterSendResult> {
  const p = registry.get(provider);
  if (!p) throw new ProviderError('auth', 'Subscriptions are off');
  const started = Date.now();
  const windows: LimitWindow[] = [];
  let usage: Usage | undefined;
  for await (const ev of p.stream(req)) {
    if (ev.type === 'rate_limit') windows.push(...ev.windows);
    else if (ev.type === 'done') usage = ev.usage;
  }
  if (!usage) throw new ProviderError('network', 'Stream ended without a final event');
  return { usage, windows, latencyMs: Date.now() - started, costUsd: registry.costOf(registry.resolveAt(provider, req.model).info, usage) };
}
