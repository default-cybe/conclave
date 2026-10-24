/**
 * Accounts and their order (Settings > Models > Accounts). Each signed in
 * plan (a CLIProxyAPI credential) and each API key is an account; the owner
 * sets the order per vendor, and the hub writes it to CLIProxyAPI as
 * credential priorities. Keys and tokens never appear here.
 * Only type declarations live here (see client/index.ts).
 */
import type { AccountBudget, AccountStarter } from '../config/schema';
import type { LimitWindow } from '../types';

export type { AccountBudget, AccountStarter };

/**
 * What the window starter of a plan is doing (core/src/accounts/starter.ts).
 * off: the owner has not turned it on. waiting: no usage read yet, or the
 * account is paused or signed out. never: the plan has no 5 hour window.
 * setup: it cannot run as set (no way to pin a request to this account, or
 * no model). scheduled: the next request is planned (nextAt). checking: it
 * sent one and waits for the window to show. stopped: until the next day's
 * start after a 429, a sign-in failure, an unavailable model, a window that
 * did not start, or three errors in a row. paused: the weekly window is used
 * up, until it resets.
 */
export type StarterState = 'off' | 'waiting' | 'never' | 'setup' | 'scheduled' | 'checking' | 'stopped' | 'paused';

export interface StarterDto {
  enabled: boolean;
  /** As saved: the model when the owner chose one, and the hours. */
  model?: string;
  start: string;
  end: string;
  tz?: string;
  /** The zone the hours are in: tz, else the owner's. */
  zone: string;
  /** The model it asks when none is set. */
  autoModel?: string;
  state: StarterState;
  /** scheduled: when the next request goes. */
  nextAt?: number;
  /** When it last started a window. */
  startedAt?: number;
  /** stopped: until when. paused: when the weekly window resets. */
  until?: number;
  /** Why it waits, stopped, paused or retries, in a few words: "429", "Sign-in failed". */
  reason?: string;
  /** Errors in a row since the last start; the next try is nextAt. */
  failures?: number;
  /** The model of its last request. */
  lastModel?: string;
}

export type AccountKind = 'subscription' | 'api';

/**
 * ready: usable now. unknown: no numbers yet, usable. limited: a window is
 * full until its reset. cooldown: CLIProxyAPI rests it after an error.
 * budget: its money budget is spent. paused: the owner paused it. error:
 * signed out, refused, or its provider has no key.
 */
export type AccountState = 'ready' | 'unknown' | 'limited' | 'cooldown' | 'budget' | 'paused' | 'error';

export interface AccountDto {
  /** Stable id, kept on usage rows. */
  id: string;
  label: string;
  /** Model family: anthropic, openai, gemini... */
  vendor: string;
  /** "Claude", "ChatGPT", "Gemini". */
  vendorName: string;
  kind: AccountKind;
  /** subscription: the CLIProxyAPI credential name. */
  credential?: string;
  /** api: the provider id that holds the key. */
  provider?: string;
  /** The email or name the provider knows it by. */
  email?: string;
  /** "Max 20x", "Pro", "API key". */
  plan?: string;
  /** api: a plan paid with an API key (the Z.ai Coding Plan): the subscription it bills against, "zai-coding". */
  subscription?: string;
  enabled: boolean;
  state: AccountState;
  /** Why it is not ready, in words. */
  detail?: string;
  /** When it is usable again (limited, cooldown, budget). */
  until?: number;
  /** 5h, 7d, 7d opus, 7d sonnet, 7d fable, budget and rate windows. A window not listed is unknown, not zero. */
  windows: LimitWindow[];
  /** Models this account reaches. */
  models: Array<{ id: string; name: string }>;
  /** The plan's short name: CLIProxyAPI's prefix for its model ids (neu/claude-opus-5-5). Set with PUT /api/accounts/:id/prefix. */
  prefix?: string;
  /** "Use when a model refuses": a refused reply is tried again on this plan or key first, same model (session/refusal-fallback.ts). */
  refusal?: boolean;
  /** subscription: the priority CLIProxyAPI has for it (higher is used first). */
  priority?: number;
  /** api: its budget and the spend in the current period. */
  budget?: AccountBudget & { spentUsd: number; periodStart: number; periodEnd: number };
  /** Cooldowns CLIProxyAPI reports. Try now clears them. */
  cooldowns?: Array<{ model?: string; reason: string; until: number }>;
  /** When the numbers were read. */
  observedAt?: number;
  /** Listed in models.accounts. False: found by the hub and shown with defaults. */
  saved: boolean;
  /** subscription: the window starter, its settings and what it is doing. */
  starter?: StarterDto;
}

export interface AccountRouteDto {
  vendor: string;
  vendorName: string;
  /** "claude-opus-*" or an exact id. Without it, the vendor's default order. */
  match?: string;
  /** Account ids, first used first. */
  order: string[];
}

/** Which account a vendor's next call goes to, and why the ones before it were passed over. */
export interface AccountNowDto {
  vendor: string;
  vendorName: string;
  /** Undefined when no account can take a call. */
  account?: string;
  /** The fullest window of that account, for "resets Tue 10:00, 45% left". */
  window?: LimitWindow;
  skipped: Array<{ account: string; reason: string }>;
  /** Every account is blocked: when the first one opens again. */
  until?: number;
}

export interface AccountsStatus {
  accounts: AccountDto[];
  routes: AccountRouteDto[];
  now: AccountNowDto[];
  /** When the hub last read CLIProxyAPI's credentials. */
  refreshedAt?: number;
  /** CLIProxyAPI's management API answers: pause, Try now and the order reach it. */
  management: boolean;
  /** The owner has turned a window starter on before, so the page has shown its note. */
  starterNoted?: boolean;
}

/** PUT /api/accounts/order. */
export interface AccountOrderInput {
  vendor: string;
  match?: string;
  order: string[];
}

/** PATCH /api/accounts/:id. Fields left out keep their value; budget and starter null remove them. */
export interface AccountPatch {
  label?: string;
  enabled?: boolean;
  budget?: AccountBudget | null;
  /** A plan's window starter. Fields left out keep their value. */
  starter?: AccountStarter | null;
  /**
   * "Use when a model refuses". On a signed in plan without a short name the
   * hub gives it the suggested one first (it must be reachable alone), so it
   * needs CLIProxyAPI's management key.
   */
  refusal?: boolean;
}

/**
 * PUT /api/accounts/:id/prefix: a signed in plan's short name, written to
 * CLIProxyAPI as the credential's prefix. 1 to 24 lowercase letters, digits
 * and dashes, its own among the plans. Empty removes it.
 */
export interface AccountPrefixInput {
  prefix: string;
}
