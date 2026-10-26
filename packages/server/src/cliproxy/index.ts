/**
 * Subscription sign-in through CLIProxyAPI (github.com/router-for-me/CLIProxyAPI,
 * MIT, a separate project). Hub config models.cliproxy.mode:
 *
 *   off       Nothing runs. providers.cliproxy stays as the owner set it.
 *   builtin   The hub downloads the pinned release into <home>/bin, writes
 *             its config under <home>/cliproxy (auth folder 0700), runs it on
 *             127.0.0.1 on a free port with a random management key and
 *             client key from the secrets store, restarts it with backoff
 *             when it dies, stops it with the hub, and stops one a killed
 *             hub left behind.
 *   external  One the owner already runs: its url and a client key, and
 *             optionally its management key for sign-in and accounts.
 *
 * Either way, while it answers, the runtime config layer "cliproxy" holds
 * providers.cliproxy: Claude models over /v1/messages, the rest over
 * /v1/chat/completions, the model list from /v1/models (ids like
 * neu/claude-opus-5-5 are a second account). Ids such as
 * cliproxy/claude-opus-5-5 work the same in both modes.
 *
 * Sign-in goes through its management API, which only the hub reaches: the
 * hub asks for the provider's sign-in address, the browser opens it, the
 * hub polls the status. The provider ends by sending the browser to
 * localhost. On the hub's own computer the hub catches that (catcher.ts);
 * anywhere else the page asks for the address from the browser bar and the
 * hub posts it as redirect_url.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { CliproxyConfig, ConclaveConfig, ProviderConfig } from '@conclave/core/config/index.ts';
import type {
  SignInStartDto,
  SignInStatusDto,
  SubscriptionAccountDto,
  SubscriptionAccountState,
  SubscriptionModelGroupDto,
  SubscriptionProviderDto,
  SubscriptionsMode,
  SubscriptionsSettingsInput,
  SubscriptionsState,
  SubscriptionsStatus,
} from '@conclave/core/client/index.ts';
import { lookupModel } from '@conclave/core/providers/catalog.ts';
import { splitAccount, wirePattern } from '@conclave/core/providers/split.ts';
import { parseRateLimitHeaders } from '@conclave/core/providers/errors.ts';
import { ensureAccounts } from '@conclave/core/accounts/attached.ts';
import { AccountsError, type AccountsService, type CliproxyCredentialFacts } from '@conclave/core/accounts/service.ts';
import { prefixProblem } from '@conclave/core/accounts/prefix.ts';
import { annotateWindow, mergeWindows } from '@conclave/core/accounts/windows.ts';
import { mapClaudeOAuthUsage, mapClaudeProfile } from '@conclave/core/usage/readers/claude-oauth.ts';
import { mapWhamUsage } from '@conclave/core/usage/readers/codex-usage.ts';
import { antigravityProject, mapAntigravityQuota, mapAntigravityUsage } from '@conclave/core/usage/readers/antigravity.ts';
import type { LimitWindow } from '@conclave/core/types.ts';
import { markHubPrivate } from '@conclave/core/machine/private.ts';
import { logger } from '@conclave/core/util/log.ts';
import { HttpError } from '../http';
import { isLoopbackHost } from '../oauth/checks';
import { PidFile, processMatches } from '../remote/pids';
import { catchRedirect, type Catcher, type CatchOptions } from './catcher';
import { cliproxyEnv, cliproxyFiles, ensurePrivateDirs, writeConfig, type CliproxyFiles } from './config';
import { Management, ManagementError, SUBSCRIPTION_PLUGINS, codexModels, listModels, splitPrefixed, type CodexModel, type RawCredential } from './management';
import { RETIRED_ALIASES, type CyberProgram } from '@conclave/core/providers/access-programs.ts';
import { CATALOG_MS, codexSection, dropCatalogs, fetchCatalog, withExtras, writeCatalog, type Catalog, type CatalogExtra } from './catalog';
import {
  CLIPROXY_REPO,
  PINS,
  ReleaseError,
  compareVersions,
  dropPrevious,
  installRelease,
  ensureManagedBinary,
  pluginHostProblem,
  type PluginHost,
  newestPin,
  parseVersion,
  pinFor,
  rollback,
  type BinaryInfo,
  type Pin,
} from './release';
import { CliRunner, RunnerError, defaultSpawn, runHelp, type CliSpawner } from './runner';

const log = logger('cliproxy');

export const MODES: SubscriptionsMode[] = ['off', 'builtin', 'external'];
/** Secrets store names (values). */
export const MGMT_SECRET = 'cliproxy.managementKey';
export const CLIENT_SECRET = 'cliproxy.clientKey';
export const EXT_KEY_SECRET = 'cliproxy.external.key';
export const EXT_MGMT_SECRET = 'cliproxy.external.managementKey';
const KV_PORT = 'cliproxy.port';
export const PROVIDER_ID = 'cliproxy';
/** Models that go over the Anthropic Messages wire. */
export const ANTHROPIC_MODELS = ['claude-*', '*/claude-*'];
/** Models that go over the Responses wire (Codex speaks it natively, tool-result images stay inside function_call_output). */
export const RESPONSES_MODELS = ['gpt-*', '*/gpt-*'];
/** Models that go over the native Gemini wire (functionResponse by name, thought signatures kept). Bare ids only. */
export const GEMINI_MODELS = ['gemini-*'];
const DEFAULT_BASE = 'http://127.0.0.1:8317/v1';

/** What each sign-in gives, in words. Anything else the running version or a plugin offers gets its own id as the name. */
export const PROVIDER_INFO: Record<string, { name: string; plan: string; flow: 'redirect' | 'device'; more?: boolean }> = {
  claude: { name: 'Claude', plan: 'Claude Pro or Max', flow: 'redirect' },
  codex: { name: 'ChatGPT', plan: 'ChatGPT Plus or Pro, through Codex', flow: 'redirect' },
  antigravity: { name: 'Google', plan: 'Google AI Pro or Ultra, through Antigravity', flow: 'redirect' },
  xai: { name: 'Grok', plan: 'SuperGrok, through Grok Build', flow: 'device' },
  kimi: { name: 'Kimi', plan: 'Kimi Code plan on kimi.com', flow: 'device' },
  meta: { name: 'Muse', plan: 'Muse Code, with a Meta login', flow: 'device' },
  'kimi-ai': { name: 'Kimi', plan: 'Kimi Code plan on kimi.ai', flow: 'device', more: true },
  devin: { name: 'Devin', plan: 'A Devin account', flow: 'redirect', more: true },
  copilot: { name: 'GitHub Copilot', plan: 'GitHub Copilot subscription, through a CLIProxyAPI plugin', flow: 'device', more: true },
  kiro4cpa: { name: 'Kiro', plan: 'Kiro with AWS Builder ID, through a CLIProxyAPI plugin', flow: 'device', more: true },
  'kiro4cpa-social': { name: 'Kiro', plan: 'Kiro with a Google or GitHub login, through a CLIProxyAPI plugin', flow: 'redirect', more: true },
};

/** Cards that sign in through another provider's plugin; their accounts are listed under that provider. */
export const SIGN_IN_VIA: Record<string, string> = { 'kiro4cpa-social': 'kiro4cpa' };
const withVia = (ids: string[]) => ids.flatMap((id) => [id, ...Object.keys(SIGN_IN_VIA).filter((k) => SIGN_IN_VIA[k] === id)]);

/** Cards for a runtime not started yet; capability comes from the managed host. */
export function subscriptionCards(pin: Pin, installable: boolean): SubscriptionProviderDto[] {
  const ids = [...pin.providers, ...(installable ? Object.keys(SUBSCRIPTION_PLUGINS) : [])];
  return [...new Set(withVia(ids))].map((id) => ({ id, ...PROVIDER_INFO[id], accounts: 0 }));
}

/** Account types CLIProxyAPI lists under another name than the sign-in that made them. */
const ACCOUNT_PROVIDER: Record<string, string> = { anthropic: 'claude', 'gemini-cli': 'antigravity' };

export interface CliproxyOptions extends PluginHost {
  engine: EngineApi;
  fetch?: typeof fetch;
  /** Starts CLIProxyAPI and runs its -h (tests pass a fake). */
  spawn?: CliSpawner;
  /** Pinned releases (tests pin a fake one). */
  pins?: Pin[];
  /** Release download base (tests serve a fake release). */
  releaseBase?: string;
  platform?: string;
  arch?: string;
  /** Members share only this managed binary home, not its config or secrets. */
  binaryHome?: string;
  /** Waits before starting it again after it stopped or failed. */
  backoffMs?: number[];
  readyTimeoutMs?: number;
  /** How often models and accounts are read again while it runs. Default 5 minutes. */
  syncMs?: number;
  /** How often the credentials (quota signals, cooldowns, priorities) are read. Default 60 seconds. */
  credentialsMs?: number;
  /** Each account's plan usage is read every this many ms, picked at random in the range. Default 5 to 10 minutes. */
  usageMs?: [number, number];
  /** How often each account's model list is read. Default 10 minutes. */
  modelsMs?: number;
  /** How often a ChatGPT plan's own model list is read (with its entity tag). Default 1 hour; Refresh models reads it now. */
  ownModelsMs?: number;
  /** Jitter source (tests pin it). */
  random?: () => number;
  /** Listens for the provider's localhost redirect (tests pass their own). */
  catcher?: (opts: CatchOptions) => Catcher | undefined;
  /** Where the official model catalog is read (catalog.ts; tests serve their own). */
  catalogUrls?: string[];
}

interface SignIn {
  state: string;
  provider: string;
  flow: 'redirect' | 'device';
  url: string;
  userCode?: string;
  expiresAt: number;
  status: SignInStatusDto['status'];
  error?: string;
  account?: SubscriptionAccountDto;
  before: Set<string>;
  catcher?: Catcher;
  callbackHost?: string;
  caught: boolean;
  mgmt: Management;
  /** Who started it, for the audit log. */
  actor: string;
  done?: number;
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);

/** What the hub knows of one credential besides /credentials: its plan usage, plan and models. */
interface CredState {
  /** From the usage endpoint, with observedAt. */
  windows: LimitWindow[];
  plan?: string;
  planAt?: number;
  /** Its models, each once (credentials/models lists a plan with a prefix twice). */
  models?: Array<{ id: string; name?: string }>;
  modelsAt?: number;
  /**
   * Its prefix (the plan's short name), from its model list, or as the hub
   * just wrote it. "" when it has none. CLIProxyAPI's credentials list never
   * says (8.0.32 keeps it in the auth file only).
   */
  prefix?: string;
  /** The prefix the hub last wrote, and when: it stands until the model list shows it (CLIProxyAPI lists the old ids for a while) or PREFIX_SETTLE_MS pass. */
  wrote?: { prefix: string; at: number };
  /** A ChatGPT plan's own model list (the Codex app's, catalog.ts), hidden ones marked. */
  own?: CodexModel[];
  /** When the plan's own list was last read, and its entity tag (a 304 keeps the list). */
  ownAt?: number;
  ownEtag?: string;
  /** Next usage read. */
  usageNext: number;
  /** Wait after the last 429 from the usage endpoint; doubles up to an hour. */
  backoff: number;
  usageError?: string;
}

/**
 * An account's models as the Accounts page and the routing read them:
 * CLIProxyAPI's list (its catalog's names, "GPT 6.0 Astra") with the plan's
 * own names ("GPT-6-Astra"), without what the plan hides (codex-auto-review)
 * or a retiring Daybreak alias.
 */
function planModels(s: CredState): Array<{ id: string; name?: string }> | undefined {
  const own = new Map((s.own ?? []).map((m) => [m.id, m]));
  return s.models
    ?.filter((m) => !own.get(m.id)?.hidden && !RETIRED_ALIASES[m.id])
    .map((m) => (own.get(m.id)?.name ? { ...m, name: own.get(m.id)!.name } : m));
}

/** The Daybreak programs a plan is approved for: its own list has their alias. */
function daybreakOf(s: CredState | undefined): CyberProgram[] {
  return [...new Set((s?.own ?? []).filter((m) => !m.hidden && RETIRED_ALIASES[m.id]).map((m) => RETIRED_ALIASES[m.id].cyber))];
}

/** The plan's usage endpoint per credential type. */
const USAGE_KIND: Record<string, 'claude-usage' | 'codex-usage' | 'antigravity-usage'> = { claude: 'claude-usage', anthropic: 'claude-usage', codex: 'codex-usage', antigravity: 'antigravity-usage' };
const DAY_MS = 86_400_000;
/** How long a short name the hub wrote outlasts a model list that does not show it yet. */
const PREFIX_SETTLE_MS = 5 * 60_000;
const STATUS_WORDS: Record<string, string> = { error: 'Failing', refreshing: 'Refreshing its sign-in', pending: 'Waiting to sign in' };

/** "http://host:8317/v1/" -> "http://host:8317". Undefined for anything that is not a plain http(s) base. */
export function cleanRoot(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  let u = v.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = `http://${u}`;
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return undefined;
    if (p.search || p.hash || p.username || p.password) return undefined;
    const path = p.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${p.protocol}//${p.host}${path}`;
  } catch {
    return undefined;
  }
}

/** The redirect_uri inside a provider's sign-in address. */
function redirectOf(authUrl: string): URL | undefined {
  try {
    const r = new URL(authUrl).searchParams.get('redirect_uri');
    if (!r) return undefined;
    const u = new URL(r);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The address pasted from the browser bar after the provider's localhost
 * redirect did not load. Browsers hide the http:// part, so it may be
 * missing. It must point at localhost and carry code or error.
 */
export function pastedCallback(raw: unknown, state: string | undefined): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'Paste the address from the browser bar.');
  const text = raw.trim();
  if (text.length > 8192) throw new HttpError(400, 'That is longer than any sign-in address. Copy the address from the browser bar again.');
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new HttpError(400, 'That is not an address. Copy the whole address from the browser bar, starting with localhost.');
  }
  if (!isLoopbackHost(u.hostname)) throw new HttpError(400, `That address goes to ${u.hostname}. Paste the one that starts with localhost, from the tab that did not load.`);
  const code = u.searchParams.get('code');
  const error = u.searchParams.get('error') ?? u.searchParams.get('error_description');
  if (!code && !error) throw new HttpError(400, 'That address has no sign-in code in it. Paste the address of the page that did not load, after the provider sent you back.');
  const s = u.searchParams.get('state');
  if (s && state && s !== state) throw new HttpError(400, 'That address belongs to another sign-in. Start again and paste the address from that tab.');
  return u.toString();
}

function freePort(want?: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      const l = Bun.listen({ hostname: '127.0.0.1', port: want ?? 0, socket: { data() {} } });
      const port = l.port;
      l.stop(true);
      resolve(port);
    } catch {
      resolve(undefined);
    }
  });
}

export class CliproxyManager {
  private attached = false;
  private closing = false;
  private state: SubscriptionsState = 'off';
  private since = Date.now();
  private detail?: string;
  private error?: string;
  private applied?: string;
  private appliedMode?: SubscriptionsMode;
  private gen = 0;
  private runner?: CliRunner;
  /** The start in progress. A restart waits for it to give up first. */
  private startRun?: Promise<void>;
  private port?: number;
  private binary?: BinaryInfo;
  private version?: string;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartAttempt = 0;
  private startedAt = 0;
  private syncTimer?: ReturnType<typeof setInterval>;
  private mgmt?: Management;
  private mgmtNote?: string;
  private root?: string;
  private accounts: SubscriptionAccountDto[] = [];
  private modelIds: Array<{ id: string; ownedBy?: string }> = [];
  private plugins: Array<{ id: string; name: string }> = [];
  private signIns = new Map<string, SignIn>();
  private pids?: PidFile;
  private offConfig?: () => void;
  private configQueued = false;
  private lastEvent = '';
  private lastFailure?: string;
  private updating = false;
  private lastProgress = 0;
  /** The credentials as last read, with their signals and cooldowns. */
  private raw: RawCredential[] = [];
  private credAt?: number;
  private creds = new Map<string, CredState>();
  private credTimer?: ReturnType<typeof setInterval>;
  private hitTimer?: ReturnType<typeof setTimeout>;
  private usageRun?: Promise<void>;
  private priorityRun?: Promise<void>;
  /** The model catalog the hub gave its own CLIProxyAPI (catalog.ts): the official one it read, the file, what it added. */
  private catalog: { base?: Catalog; baseAt?: number; path?: string; added: Set<string>; failedAt?: number } = { added: new Set() };
  private catalogRun?: Promise<void>;
  private offAccounts: Array<() => void> = [];
  readonly files: CliproxyFiles;
  /** Accounts and their order (core/src/accounts): this manager feeds it the credentials. */
  readonly accountService: AccountsService;

  /** Unhooks Refresh models (engine.onRefreshModels). */
  private offRefresh?: () => void;

  constructor(private readonly opts: CliproxyOptions) {
    this.files = cliproxyFiles(opts.engine.config.paths.home);
    this.accountService = ensureAccounts(opts.engine);
    // Refresh models (Settings, Subscriptions): the shared list and each account's own list, now
    this.offRefresh = opts.engine.onRefreshModels?.(() => this.readModels());
  }

  /**
   * Read the models again now: /v1/models, then each signed in account's own
   * list (credentials/models), so a model an account offers before
   * CLIProxyAPI's shared list has it (a new model on a ChatGPT plan) shows in
   * the picker. Nothing when CLIProxyAPI is off or not answering: the last
   * lists stay.
   */
  async readModels(): Promise<void> {
    if (this.mode() === 'off' || !this.root || this.state !== 'on') return;
    await this.syncModels();
    if (this.mgmt) await this.refreshModels(true);
    this.applyProvider();
    this.publish();
  }

  private get engine(): EngineApi {
    return this.opts.engine;
  }

  private get pins(): Pin[] {
    return this.opts.pins ?? PINS;
  }

  private get f(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private get spawn(): CliSpawner {
    return this.opts.spawn ?? defaultSpawn;
  }

  private cfg(): CliproxyConfig {
    return this.engine.config.get().models?.cliproxy ?? {};
  }

  mode(): SubscriptionsMode {
    const m = this.cfg().mode;
    return m && MODES.includes(m) ? m : 'off';
  }

  private secret(name: string): string | undefined {
    return this.engine.config.expand(`\${secret:${name}}`) || undefined;
  }

  private audit(action: string, detail: string, actor = 'hub'): void {
    try {
      this.engine.repos.audit.add({ actor, action, detail });
    } catch {
      /* auditing must not break sign-in */
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Called once the hub listens: stop what a killed hub left behind, then start what the config asks for. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    markHubPrivate(this.files.dir);
    this.pids = new PidFile(this.files.pids);
    // a hub that was killed leaves its CLIProxyAPI running; stop it (only one started with this hub's config)
    if (existsSync(this.files.pids)) {
      const config = this.files.config;
      const stale = this.pids.reap({ isOurs: (pid) => processMatches(pid, (cmd) => cmd.includes(config)) });
      if (stale.length) log.info(`stopped ${stale.length} CLIProxyAPI left by an earlier run (pid ${stale.join(', ')})`);
    }
    this.offConfig = this.engine.config.onChange(() => this.onConfig());
    this.syncTimer = setInterval(() => void this.tick(), this.opts.syncMs ?? 300_000);
    (this.syncTimer as { unref?: () => void }).unref?.();
    // the credentials every minute: last seen limit headers, cooldowns, priorities; plan usage when due
    this.credTimer = setInterval(() => void this.credTick(), this.opts.credentialsMs ?? 60_000);
    (this.credTimer as { unref?: () => void }).unref?.();
    // a 429 on the gateway: read again now, so the next call goes to an account that has room
    this.offAccounts.push(this.accountService.onLimitHit(() => this.soon()));
    // the owner changed the order: write the priorities
    this.offAccounts.push(this.accountService.onChange(() => void this.syncPriorities()));
    // the window starter reads an account around a reset (core/src/accounts/starter.ts)
    this.accountService.setReader((id, o) => this.readAccount(id, o));
    this.offAccounts.push(() => this.accountService.setReader(undefined));
    this.reconcile();
  }

  /** True while a sign-in is still waiting; ended ones stay in signIns two minutes for polling only. */
  hasSignIns(): boolean {
    for (const s of this.signIns.values()) if (s.status === 'wait') return true;
    return false;
  }

  /** The hub is shutting down: stop CLIProxyAPI and every sign-in listener. */
  async close(): Promise<void> {
    this.offRefresh?.();
    this.offRefresh = undefined;
    this.closing = true;
    this.gen++;
    this.offConfig?.();
    for (const off of this.offAccounts) off();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.credTimer) clearInterval(this.credTimer);
    if (this.hitTimer) clearTimeout(this.hitTimer);
    for (const s of this.signIns.values()) s.catcher?.stop();
    this.signIns.clear();
    await this.stopRunner();
  }

  private onConfig(): void {
    if (this.configQueued || this.closing) return;
    this.configQueued = true;
    queueMicrotask(() => {
      this.configQueued = false;
      if (JSON.stringify(this.cfg()) !== this.applied) this.reconcile();
    });
  }

  /** Make what runs match models.cliproxy. A mode change from the config file is audited here; the route audits its own. */
  private reconcile(fromRoute = false): Promise<void> | undefined {
    if (!this.attached || this.closing) return;
    const cfg = this.cfg();
    const key = JSON.stringify(cfg);
    const before = this.applied ? (JSON.parse(this.applied) as CliproxyConfig) : undefined;
    const mode = this.mode();
    const changed = this.appliedMode !== undefined && this.appliedMode !== mode;
    this.applied = key;
    this.appliedMode = mode;
    if (changed && !fromRoute) this.audit('subscriptions.mode', mode);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.restartAttempt = 0;
    if (mode !== 'builtin') {
      this.gen++;
      void this.stopRunner();
    }
    if (mode === 'off') {
      this.root = undefined;
      this.mgmt = undefined;
      this.mgmtNote = undefined;
      this.accounts = [];
      this.modelIds = [];
      this.plugins = [];
      this.version = undefined;
      this.raw = [];
      this.creds.clear();
      this.accountService.setCliproxy(undefined);
      this.endSignIns();
      this.engine.config.setRuntime({}, PROVIDER_ID);
      this.setState('off');
      return;
    }
    if (mode === 'builtin') {
      const busy = !!this.runner || !!this.startRun;
      const restart = busy && (before?.binary !== cfg.binary || before?.port !== cfg.port || before?.mode !== 'builtin');
      if (restart) {
        this.gen++;
        // a start in progress gives up on the old gen; starting before it has would find it busy and do nothing
        void Promise.all([this.stopRunner(), this.startRun]).then(() => (this.runner ? undefined : this.start()));
      } else if (!busy) void this.start();
      else this.publish();
      return;
    }
    // external
    this.endSignIns();
    this.binary = undefined;
    return this.connectExternal(++this.gen);
  }

  private setState(state: SubscriptionsState, detail?: string, error?: string): void {
    if (state !== this.state) this.since = Date.now();
    this.state = state;
    this.detail = detail;
    this.error = error;
    this.publish();
  }

  private publish(): void {
    if (this.closing) return;
    const st = this.status();
    const { since: _since, ...rest } = st;
    const key = JSON.stringify(rest);
    if (key === this.lastEvent) return;
    this.lastEvent = key;
    this.engine.bus.emit({ type: 'subscriptions.updated', status: st });
  }

  private nextBackoff(): number {
    const steps = this.opts.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
    const ms = steps[Math.min(this.restartAttempt, steps.length - 1)];
    this.restartAttempt++;
    return ms;
  }

  private schedule(fn: () => void, ms: number): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.closing) fn();
    }, ms);
    (this.restartTimer as { unref?: () => void }).unref?.();
  }

  // -------------------------------------------------------------------------
  // builtin
  // -------------------------------------------------------------------------

  /** The two keys, made on first use and kept in the secrets store. */
  private keys(): { mgmt: string; client: string } {
    let mgmt = this.secret(MGMT_SECRET);
    if (!mgmt) {
      mgmt = randomBytes(32).toString('base64url');
      this.engine.config.setSecret('values', MGMT_SECRET, mgmt);
    }
    let client = this.secret(CLIENT_SECRET);
    if (!client) {
      client = `cpk-${randomBytes(24).toString('base64url')}`;
      this.engine.config.setSecret('values', CLIENT_SECRET, client);
    }
    return { mgmt, client };
  }

  private env(): Record<string, string> {
    return cliproxyEnv(process.env, this.files.dir);
  }

  /** `<bin> -h` prints the version line first. */
  private async probe(path: string): Promise<string | undefined> {
    ensurePrivateDirs(this.files);
    const r = await runHelp(this.spawn, path, this.env(), this.files.dir).catch(() => undefined);
    return r ? parseVersion(r.out) : undefined;
  }

  /** models.cliproxy.binary, else the copy in <home>/bin, else download the pinned release. */
  private async ensureBinary(gen: number): Promise<BinaryInfo> {
    const override = this.cfg().binary;
    if (override) {
      if (!existsSync(override)) throw new ReleaseError(`models.cliproxy.binary points at ${override}, which does not exist. Fix the path or remove the setting to let the hub download CLIProxyAPI.`);
      const version = await this.probe(override);
      if (!version) throw new ReleaseError(`${override} does not start as CLIProxyAPI (\`-h\` printed no version). Fix models.cliproxy.binary.`);
      return { path: override, version, managed: false, verified: false };
    }
    const home = this.opts.binaryHome ?? this.engine.config.paths.home;
    const pin = newestPin(this.pins);
    return ensureManagedBinary({
      home,
      pin,
      base: this.opts.releaseBase,
      fetch: this.opts.fetch,
      platform: this.opts.platform,
      arch: this.opts.arch,
      glibcVersion: this.opts.glibcVersion,
      probe: (p) => this.probe(p),
      onProgress: (done, total) => {
        const now = Date.now();
        if (gen !== this.gen || (now - this.lastProgress < 400 && done !== total)) return;
        this.lastProgress = now;
        this.setState('installing', total ? `Downloading CLIProxyAPI ${pin.version}, ${mb(done)} of ${mb(total)} MB` : `Downloading CLIProxyAPI ${pin.version}, ${mb(done)} MB`);
      },
    });
  }

  private async pickPort(): Promise<number> {
    const fixed = this.cfg().port;
    if (fixed) return fixed;
    let last: number | undefined;
    try {
      last = this.engine.repos.kv.get<number | null>(KV_PORT, null) ?? undefined;
    } catch {
      /* no kv */
    }
    if (last && (await freePort(last))) return last;
    const any = await freePort();
    if (!any) throw new RunnerError('No free port on 127.0.0.1 for CLIProxyAPI.');
    return any;
  }

  /** Install if needed, write the config, start it, wait until it answers. Throws; no retries. */
  private async launch(gen: number): Promise<void> {
    const keys = this.keys();
    if (this.state !== 'installing') this.setState('starting', this.binary ? 'Starting CLIProxyAPI' : 'Getting CLIProxyAPI ready');
    const bin = await this.ensureBinary(gen);
    if (gen !== this.gen || this.closing) return;
    this.binary = bin;
    this.setState('starting', `Starting CLIProxyAPI ${bin.version ?? ''}`.trim());
    const port = await this.pickPort();
    if (gen !== this.gen || this.closing) return;
    // the management key never sits in a file: CLIProxyAPI reads its bcrypt hash
    const managementHash = await Bun.password.hash(keys.mgmt, { algorithm: 'bcrypt', cost: 10 });
    // close() may have run (and its folder been removed) during the awaits: write nothing, start nothing
    if (gen !== this.gen || this.closing) return;
    writeConfig(this.files, { port, managementHash, clientKey: keys.client, authDir: this.files.auth, pluginsEnabled: !bin.receipt?.asset.includes('_no-plugin') });
    // the config starts on CLIProxyAPI's own catalog; the plans' own models go in again once they are read
    this.catalog.path = undefined;
    this.catalog.added.clear();
    dropCatalogs(this.files.dir);
    const runner = new CliRunner({
      bin: bin.path,
      args: ['-config', this.files.config],
      env: this.env(),
      cwd: this.files.dir,
      port,
      spawn: this.opts.spawn,
      readyTimeoutMs: this.opts.readyTimeoutMs,
      secrets: () => [keys.mgmt, keys.client],
      pids: this.pids,
    });
    this.runner = runner;
    try {
      await runner.start();
    } catch (err) {
      if (this.runner === runner) this.runner = undefined;
      throw err;
    }
    if (gen !== this.gen || this.closing) {
      if (this.runner === runner) this.runner = undefined;
      await runner.stop();
      return;
    }
    runner.events.onExit = (_code, why) => this.onExit(runner, why);
    this.port = port;
    try {
      this.engine.repos.kv.set(KV_PORT, port);
    } catch {
      /* no kv */
    }
    this.root = `http://127.0.0.1:${port}`;
    this.mgmt = new Management(this.root, keys.mgmt, this.f);
    this.mgmtNote = undefined;
    this.startedAt = Date.now();
    this.version = bin.version;
    this.applyProvider();
    await this.sync();
    if (gen !== this.gen) return;
    this.lastFailure = undefined;
    log.info(`CLIProxyAPI ${bin.version ?? ''} on 127.0.0.1:${port}`);
    this.setState('on');
  }

  /** Start with retries: a failed start waits (backoff) and tries again. One at a time. */
  private start(): Promise<void> {
    if (this.startRun || this.closing || this.mode() !== 'builtin') return Promise.resolve();
    const run = this.startOnce(++this.gen).finally(() => {
      if (this.startRun === run) this.startRun = undefined;
    });
    this.startRun = run;
    return run;
  }

  private async startOnce(gen: number): Promise<void> {
    try {
      await this.launch(gen);
    } catch (err) {
      if (gen !== this.gen || this.closing) return;
      const msg = (err as Error).message || String(err);
      if (msg !== this.lastFailure) {
        this.lastFailure = msg;
        log.warn(`CLIProxyAPI did not start: ${msg}`);
        this.audit('subscriptions.error', msg);
      }
      // a bad download or a wrong path will not fix itself by waiting a few seconds, but GitHub and ports can
      const permanent = err instanceof ReleaseError && !/download|GitHub|Try again|checksums file/i.test(msg);
      if (permanent) this.setState('error', undefined, msg);
      else {
        const wait = this.nextBackoff();
        this.setState('error', `Trying again in ${Math.max(1, Math.round(wait / 1000))} seconds.`, msg);
        this.schedule(() => {
          if (this.mode() === 'builtin' && !this.runner) void this.start();
        }, wait);
      }
    }
  }

  /** It died: say so and start it again after a backoff. */
  private onExit(runner: CliRunner, why: string): void {
    if (this.runner !== runner || this.closing || this.updating) return;
    this.runner = undefined;
    if (Date.now() - this.startedAt > 120_000) this.restartAttempt = 0;
    const wait = this.nextBackoff();
    log.warn(`CLIProxyAPI stopped (${why}); starting it again in ${Math.round(wait / 1000)}s`);
    this.audit('subscriptions.stopped', `CLIProxyAPI stopped (${why})`);
    this.setState('starting', `CLIProxyAPI stopped (${why}). Starting it again.`);
    this.schedule(() => {
      if (this.mode() === 'builtin' && !this.runner) void this.start();
    }, wait);
  }

  private async stopRunner(): Promise<void> {
    const r = this.runner;
    this.runner = undefined;
    if (r) await r.stop().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // external
  // -------------------------------------------------------------------------

  /** The client key for external mode: models.cliproxy.key, else the key providers.cliproxy already had. */
  private externalKey(): string | undefined {
    const k = this.cfg().key;
    if (k) return this.engine.config.expand(k) || undefined;
    const user = this.engine.config.getUser().providers?.[PROVIDER_ID];
    if (user?.apiKey) return this.engine.config.expand(user.apiKey) || undefined;
    return this.engine.config.secretNames().providers.includes(PROVIDER_ID) || process.env.CLIPROXY_API_KEY ? this.engine.config.apiKey(PROVIDER_ID) : undefined;
  }

  private async connectExternal(gen: number): Promise<void> {
    const cfg = this.cfg();
    const root = cleanRoot(cfg.url);
    if (!root) {
      this.root = undefined;
      this.engine.config.setRuntime({}, PROVIDER_ID);
      this.setState('error', undefined, 'Add the address of your CLIProxyAPI, for example http://192.168.1.10:8317.');
      return;
    }
    const key = this.externalKey();
    if (!key) {
      this.setState('error', undefined, 'Add a client key: one of access.api-keys in its config.yaml.');
      return;
    }
    this.root = root;
    if (this.state !== 'on') this.setState('starting', `Reaching ${root}`);
    try {
      const models = await listModels(root, key, this.f);
      if (gen !== this.gen) return;
      this.modelIds = models;
      const mk = cfg.managementKey ? this.engine.config.expand(cfg.managementKey) : '';
      this.mgmt = mk ? new Management(root, mk, this.f) : undefined;
      this.mgmtNote = mk ? undefined : 'Add its management key to sign in and see the accounts from here. Models work without it.';
      if (this.mgmt) {
        try {
          await this.mgmt.detect();
        } catch (err) {
          this.mgmtNote = (err as Error).message;
          this.mgmt = undefined;
        }
      }
      if (gen !== this.gen) return;
      this.applyProvider();
      await this.syncAccounts();
      await this.refreshModels();
      await this.refreshUsage();
      await this.syncPriorities();
      this.version = this.mgmt?.version ?? this.version;
      this.restartAttempt = 0;
      this.lastFailure = undefined;
      this.setState('on');
    } catch (err) {
      if (gen !== this.gen || this.closing) return;
      const msg = (err as Error).message;
      if (msg !== this.lastFailure) {
        this.lastFailure = msg;
        log.warn(`CLIProxyAPI at ${root}: ${msg}`);
        this.audit('subscriptions.error', `${root}: ${msg}`);
      }
      // keep the provider with the models it had, so refs resolve and say what failed
      this.applyProvider();
      const wait = this.nextBackoff();
      this.setState('error', `Trying again in ${Math.max(1, Math.round(wait / 1000))} seconds.`, msg);
      this.schedule(() => {
        if (this.mode() === 'external' && gen === this.gen) void this.connectExternal(gen);
      }, wait);
    }
  }

  // -------------------------------------------------------------------------
  // Provider entry, models, accounts
  // -------------------------------------------------------------------------

  /** providers.cliproxy in the runtime layer, pointing at what runs now. */
  private applyProvider(): void {
    const mode = this.mode();
    if (mode === 'off' || !this.root) {
      this.engine.config.setRuntime({}, PROVIDER_ID);
      return;
    }
    const entry: ProviderConfig = {
      type: 'openai',
      baseUrl: `${this.root}/v1`,
      enabled: true,
      models: this.allModels().map((m) => m.id),
      ...(Object.keys(this.planMeta()).length ? { modelMeta: this.planMeta() } : {}),
      anthropicWire: { baseUrl: this.root, models: ANTHROPIC_MODELS },
      geminiWire: { baseUrl: this.root, models: GEMINI_MODELS },
      responsesWire: { models: RESPONSES_MODELS },
      responsesApi: false,
      // signed in plans: no per-token price, limits grouped under one id
      subscription: PROVIDER_ID,
      // one id per Conclave session: CLIProxyAPI's session affinity keeps it on one account, so its prompt cache holds
      sessionHeader: 'X-Session-ID',
    };
    if (mode === 'builtin') entry.apiKey = `\${secret:${CLIENT_SECRET}}`;
    else if (this.cfg().key) entry.apiKey = this.cfg().key;
    this.engine.config.setRuntime({ providers: { [PROVIDER_ID]: entry } } as Partial<ConclaveConfig>, PROVIDER_ID);
  }

  /**
   * The models to offer: /v1/models, then what each account's own list adds
   * (with the account's prefix when it has one), each id once. An account can
   * offer a model before CLIProxyAPI's shared list knows it.
   */
  private allModels(): Array<{ id: string; ownedBy?: string }> {
    // what a ChatGPT plan hides from the Codex app (gpt-reserve, codex-auto-review) and the retiring Daybreak aliases are not offered
    const hidden = new Set<string>(Object.keys(RETIRED_ALIASES));
    for (const s of this.creds.values()) for (const m of s.own ?? []) if (m.hidden) hidden.add(m.id);
    const out = this.modelIds.filter((m) => !hidden.has(splitAccount(m.id).model));
    const seen = new Set(out.map((m) => m.id));
    for (const c of this.raw) {
      if (c.disabled) continue;
      const prefix = this.prefixOf(c);
      for (const m of this.creds.get(c.name)?.models ?? []) {
        if (hidden.has(splitAccount(m.id).model)) continue;
        const id = prefix && !m.id.includes('/') ? `${prefix}/${m.id}` : m.id;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id });
      }
      // a plan approved for Daybreak lists its alias: a "Daybreak Blue" row on that plan, which runs a named model with the program (registry.resolve)
      // shortcut: a plan without a prefix gets the bare alias, so CLIProxyAPI may pick another plan; marking it "Use when a model refuses" names it
      for (const m of this.creds.get(c.name)?.own ?? []) {
        if (m.hidden || !RETIRED_ALIASES[m.id]) continue;
        const id = prefix ? `${prefix}/${m.id}` : m.id;
        if (!seen.has(id)) (seen.add(id), out.push({ id }));
      }
    }
    return out;
  }

  /** What the ChatGPT plans say of their models (ProviderConfig.modelMeta): name, Effort levels, default. The first plan that lists one speaks for it. */
  private planMeta(): NonNullable<ProviderConfig['modelMeta']> {
    const out: NonNullable<ProviderConfig['modelMeta']> = {};
    for (const c of this.raw) {
      if (c.disabled) continue;
      for (const m of this.creds.get(c.name)?.own ?? []) {
        if (m.hidden || out[m.id]) continue;
        const meta = { ...(m.name ? { name: m.name } : {}), ...(m.efforts ? { efforts: m.efforts } : {}), ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}) };
        if (Object.keys(meta).length) out[m.id] = meta;
      }
    }
    return out;
  }

  /** A credential's prefix: what its list says, when a CLIProxyAPI lists it, else what its models say. */
  private prefixOf(c: RawCredential): string | undefined {
    if (c.prefix !== undefined) return c.prefix || undefined;
    return this.creds.get(c.name)?.prefix || undefined;
  }

  private clientKey(): string | undefined {
    return this.mode() === 'builtin' ? this.secret(CLIENT_SECRET) : this.externalKey();
  }

  private async syncModels(): Promise<void> {
    const key = this.clientKey();
    if (!this.root || !key) return;
    const models = await listModels(this.root, key, this.f);
    const changed = JSON.stringify(models) !== JSON.stringify(this.modelIds);
    this.modelIds = models;
    if (changed) this.applyProvider();
  }

  private toAccount(c: RawCredential): SubscriptionAccountDto {
    const provider = ACCOUNT_PROVIDER[c.provider] ?? c.provider;
    const st = (c.status ?? '').toLowerCase();
    const state: SubscriptionAccountState = c.disabled || st === 'disabled' ? 'disabled' : st === 'error' ? 'error' : c.unavailable ? 'unavailable' : st === 'refreshing' || st === 'pending' ? 'refreshing' : st === 'active' || st === '' ? 'active' : 'unknown';
    const label = c.email ?? c.account ?? (c.label && !/ user$/i.test(c.label) ? c.label : undefined);
    return {
      name: c.name,
      provider,
      providerName: PROVIDER_INFO[provider]?.name ?? c.provider,
      label,
      state,
      detail: state === 'active' ? undefined : c.statusMessage,
      canRefresh: !c.runtimeOnly,
      updatedAt: c.updatedAt,
    };
  }

  private async syncAccounts(): Promise<void> {
    if (!this.mgmt) {
      this.accounts = [];
      this.raw = [];
      this.feedAccounts();
      return;
    }
    try {
      await this.readCredentials();
      this.plugins = await this.mgmt.oauthPlugins();
      if (this.mgmt.version) this.version = this.mgmt.version;
      if (this.mode() === 'external') this.mgmtNote = undefined;
    } catch (err) {
      this.mgmtNote = (err as Error).message;
    }
  }

  /** GET /credentials: the accounts list, each one's signals, cooldowns and priority. */
  private async readCredentials(): Promise<void> {
    if (!this.mgmt) return;
    const list = await this.mgmt.credentials();
    const before = this.allModels().map((m) => m.id).join('\n');
    this.raw = list;
    this.credAt = Date.now();
    this.accounts = list.map((c) => this.toAccount(c));
    for (const name of [...this.creds.keys()]) if (!list.some((c) => c.name === name)) this.creds.delete(name);
    this.feedAccounts();
    // an account that left (or was paused) takes the models only its own list had
    if (this.allModels().map((m) => m.id).join('\n') !== before) this.applyProvider();
  }

  // -------------------------------------------------------------------------
  // Accounts: usage, models, priorities (core/src/accounts)
  // -------------------------------------------------------------------------

  private cred(name: string): CredState {
    let s = this.creds.get(name);
    if (!s) {
      // a new account: its usage and models are read on the next pass
      s = { windows: [], usageNext: 0, backoff: 0 };
      this.creds.set(name, s);
    }
    return s;
  }

  private jitter(): number {
    const [lo, hi] = this.opts.usageMs ?? [5 * 60_000, 10 * 60_000];
    return lo + Math.floor((this.opts.random ?? Math.random)() * Math.max(0, hi - lo));
  }

  /** Windows from the signals CLIProxyAPI saw on the account's last response, through the same parser as live headers. */
  private signalWindows(c: RawCredential): LimitWindow[] {
    if (!c.signals) return [];
    const at = c.signalsAt ?? this.credAt ?? Date.now();
    return parseRateLimitHeaders(c.provider, c.signals, at).map((w) => annotateWindow(w, { source: 'headers', observedAt: at }));
  }

  /** The credentials, merged with what the hub read itself, to the accounts service. */
  private feedAccounts(): void {
    if (this.mode() === 'off' || !this.root) {
      this.accountService.setCliproxy(undefined);
      return;
    }
    const now = Date.now();
    const credentials: CliproxyCredentialFacts[] = this.raw.map((c) => {
      const s = this.creds.get(c.name);
      const cooldowns = (c.cooldowns ?? []).filter((x) => x.retryAt && x.retryAt > now).map((x) => ({ ...(x.scope === 'model' && x.model ? { model: x.model } : {}), reason: x.reason, until: x.retryAt! }));
      if (!cooldowns.length && c.unavailable && c.nextRetryAfter && c.nextRetryAfter > now) cooldowns.push({ reason: 'unknown', until: c.nextRetryAfter });
      const st = (c.status ?? '').toLowerCase();
      const error = st === 'error' ? (c.statusMessage ?? STATUS_WORDS.error) : undefined;
      const a = this.toAccount(c);
      return {
        name: c.name,
        ...(c.authIndex ? { authIndex: c.authIndex } : {}),
        provider: a.provider,
        ...(c.email ? { email: c.email } : {}),
        ...(a.label ? { label: a.label } : {}),
        ...(s?.plan ? { plan: s.plan } : {}),
        ...(this.prefixOf(c) ? { prefix: this.prefixOf(c) } : {}),
        ...(c.priority !== undefined ? { priority: c.priority } : {}),
        disabled: !!c.disabled || st === 'disabled',
        ...(error ? { error } : {}),
        windows: mergeWindows(this.signalWindows(c), s?.windows ?? []),
        cooldowns,
        ...(s?.models ? { models: planModels(s) } : {}),
        ...(daybreakOf(s).length ? { daybreak: daybreakOf(s) } : {}),
        ...(c.signalsAt || s?.windows.length ? { observedAt: Math.max(c.signalsAt ?? 0, ...(s?.windows ?? []).map((w) => w.observedAt ?? 0)) } : {}),
      };
    });
    this.accountService.setCliproxy({ provider: PROVIDER_ID, credentials, management: !!this.mgmt && this.state !== 'error', ...(this.credAt ? { refreshedAt: this.credAt } : {}) });
  }

  /** The minute timer: credentials, then plan usage and models that are due. */
  private async credTick(): Promise<void> {
    if (this.state !== 'on' || this.updating || !this.mgmt) return;
    try {
      await this.readCredentials();
    } catch (err) {
      log.debug(`credentials: ${(err as Error).message}`);
      return;
    }
    await this.refreshUsage();
    await this.refreshModels();
  }

  /** Soon after a 429: the credentials and the usage of the accounts that may be blocked. Debounced. */
  private soon(): void {
    if (this.hitTimer || this.closing) return;
    this.hitTimer = setTimeout(() => {
      this.hitTimer = undefined;
      if (this.state !== 'on' || !this.mgmt) return;
      void this.readCredentials()
        .then(() => this.refreshUsage({ due: true }))
        .catch((err) => log.debug(`after a limit: ${(err as Error).message}`));
    }, 2_000);
    (this.hitTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Read each Claude, ChatGPT and Google (Antigravity) account's plan usage through api-call (the
   * allowlisted addresses only), when it is due: every 5 to 10 minutes per
   * account with jitter, longer after a 429 from the usage endpoint. `due`
   * (after a 429 on a call) and `force` (Refresh) read now; a backoff still holds.
   */
  refreshUsage(opts: { force?: boolean; due?: boolean; only?: string } = {}): Promise<void> {
    this.usageRun ??= this.doRefreshUsage(opts).finally(() => (this.usageRun = undefined));
    return this.usageRun;
  }

  /**
   * Read one account again now, for the window starter: the credentials
   * (the headers of its last response, the starter's own included), and its
   * plan usage when asked. A usage backoff still holds.
   */
  async readAccount(id: string, opts: { usage?: boolean } = {}): Promise<void> {
    if (this.state !== 'on' || !this.mgmt || this.closing) return;
    try {
      await this.readCredentials();
    } catch (err) {
      log.debug(`credentials for one account: ${(err as Error).message}`);
      return;
    }
    if (!opts.usage) return;
    const name = this.accountService.credentialOf(id)?.name;
    if (!name) return;
    // a read of every account may be running: this one comes after it
    if (this.usageRun) await this.usageRun;
    await this.refreshUsage({ due: true, only: name });
  }

  private async doRefreshUsage(opts: { force?: boolean; due?: boolean; only?: string }): Promise<void> {
    const mgmt = this.mgmt;
    if (!mgmt || mgmt.apiVersion !== 'v8') return;
    const now = Date.now();
    let changed = false;
    for (const c of this.raw) {
      if (opts.only && c.name !== opts.only) continue;
      const kind = USAGE_KIND[c.provider];
      if (!kind || !c.authIndex || c.disabled) continue;
      const s = this.cred(c.name);
      const held = s.backoff > 0 && now < s.usageNext;
      if (held || (!opts.force && !opts.due && now < s.usageNext)) continue;
      try {
        const r = await mgmt.usageCall(kind, c.authIndex, { chatgptAccountId: c.chatgptAccountId });
        if (r.status === 429) {
          s.backoff = Math.min(60 * 60_000, Math.max(10 * 60_000, s.backoff * 2));
          s.usageNext = Date.now() + Math.max(s.backoff, r.retryAfterMs ?? 0);
          s.usageError = 'The plan\'s usage page asked to wait';
          continue;
        }
        if (r.status < 200 || r.status >= 300 || !r.json || typeof r.json !== 'object') {
          s.usageNext = Date.now() + this.jitter();
          s.usageError = `The plan's usage page answered ${r.status}`;
          continue;
        }
        const at = Date.now();
        // Antigravity credits are informational paid-spending balances, not subscription quota windows.
        const mapped =
          kind === 'claude-usage'
            ? mapClaudeOAuthUsage(r.json as Record<string, any>, at)
            : kind === 'antigravity-usage'
              ? mapAntigravityUsage(r.json as Record<string, any>)
              : mapWhamUsage(r.json as Record<string, any>, at);
        const windows = [...mapped.windows];
        if (kind === 'antigravity-usage') {
          // the quota buckets; a failed read leaves the credits and plan as they are
          const projectId = c.projectId ?? antigravityProject(r.json as Record<string, any>);
          const answers = await Promise.all(
            (['antigravity-quota-daily', 'antigravity-quota'] as const).map((q) =>
              mgmt.usageCall(q, c.authIndex!, { projectId }).then((a) => (a.status >= 200 && a.status < 300 && a.json && typeof a.json === 'object' ? (a.json as Record<string, any>) : undefined), () => undefined),
            ),
          );
          windows.push(...mapAntigravityQuota(answers));
        }
        s.windows = windows.map((w) => annotateWindow(w, { source: 'oauth', observedAt: at }));
        if (kind !== 'claude-usage') s.plan = (mapped as { plan?: string }).plan ?? s.plan;
        s.backoff = 0;
        s.usageError = undefined;
        s.usageNext = at + this.jitter();
        changed = true;
        // the plan from the profile, once a day
        if (kind === 'claude-usage' && (!s.planAt || at - s.planAt > DAY_MS)) {
          s.planAt = at;
          const p = await mgmt.usageCall('claude-profile', c.authIndex).catch(() => undefined);
          if (p && p.status === 200 && p.json && typeof p.json === 'object') s.plan = mapClaudeProfile(p.json as Record<string, any>) ?? s.plan;
        }
      } catch (err) {
        // never the request or its headers: only that it failed
        s.usageNext = Date.now() + this.jitter();
        s.usageError = (err as Error).message;
        log.debug(`plan usage for one ${c.provider} account: ${(err as Error).message}`);
      }
    }
    if (changed) this.feedAccounts();
  }

  /** Each account's models, on sign-in and every 10 minutes. */
  private async refreshModels(force = false, catalog = true): Promise<void> {
    const mgmt = this.mgmt;
    if (!mgmt || mgmt.apiVersion !== 'v8') return;
    const every = this.opts.modelsMs ?? 10 * 60_000;
    let changed = false;
    let own = false;
    for (const c of this.raw) {
      const s = this.cred(c.name);
      if (!force && s.modelsAt && Date.now() - s.modelsAt < every) continue;
      s.modelsAt = Date.now();
      try {
        // a plan with a short name has each model twice ("gpt-6-astra", "work/gpt-6-astra"): that is how the hub learns the name
        // the name the hub wrote or last saw wins while CLIProxyAPI lists the old one next to it
        const split = splitPrefixed(await mgmt.credentialModels(c.name), s.wrote?.prefix ?? s.prefix);
        const models = split.models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
        const listed = split.prefix ?? '';
        if (s.wrote && (listed === s.wrote.prefix || Date.now() - s.wrote.at >= PREFIX_SETTLE_MS)) s.wrote = undefined;
        const prefix = s.wrote?.prefix ?? listed;
        if (JSON.stringify(models) !== JSON.stringify(s.models) || prefix !== s.prefix) {
          s.models = models;
          s.prefix = prefix;
          changed = true;
        }
      } catch (err) {
        log.debug(`models of one account: ${(err as Error).message}`);
      }
      // a ChatGPT plan's own list, as the Codex app reads it: CLIProxyAPI lists only what its catalog has for the plan
      // read once an hour (Refresh models reads it now), with its entity tag: a 304 keeps the list
      if (USAGE_KIND[c.provider] === 'codex-usage' && c.authIndex && !c.disabled && (force || !s.ownAt || Date.now() - s.ownAt >= (this.opts.ownModelsMs ?? 60 * 60_000))) {
        s.ownAt = Date.now();
        try {
          const r = await mgmt.usageCall('codex-models', c.authIndex, { chatgptAccountId: c.chatgptAccountId, ...(s.own && s.ownEtag ? { etag: s.ownEtag } : {}) });
          if (r.status >= 200 && r.status < 300) {
            const list = codexModels(r.json);
            s.ownEtag = r.etag;
            if (JSON.stringify(list) !== JSON.stringify(s.own)) {
              s.own = list;
              own = true;
            }
          } else if (r.status !== 304) log.warn(`a ChatGPT plan's own model list answered ${r.status}; its names and hidden models stay unapplied`);
        } catch (err) {
          // once an hour per plan at most: a failed read leaves the Accounts page on CLIProxyAPI's names
          log.warn(`a ChatGPT plan's own models: ${(err as Error).message}`);
        }
      }
    }
    if (changed || own) {
      this.feedAccounts();
      // a model only an account's own list has joins the provider's list (allModels); a plan's names and levels go with it
      this.applyProvider();
    }
    if (catalog && (own || changed)) await this.syncCatalog();
  }

  /**
   * The models ChatGPT plans offer that CLIProxyAPI's catalog lacks (catalog.ts):
   * in the plan's section, by the plan's own list. Models only the hub's
   * catalog gives CLIProxyAPI still count as missing, so the list stays put.
   */
  private catalogExtras(): CatalogExtra[] {
    const out: CatalogExtra[] = [];
    for (const c of this.raw) {
      const s = this.creds.get(c.name);
      if (!s?.own?.length || c.disabled) continue;
      const section = codexSection(c.planType);
      const listed = new Set((s.models ?? []).map((m) => m.id).filter((id) => !this.catalog.added.has(`${section} ${id}`)));
      for (const m of s.own) {
        // a hidden model and a retiring Daybreak alias (a saved ref runs on its named model) are not added
        if (m.hidden || RETIRED_ALIASES[m.id]) continue;
        if (!listed.has(m.id) && !out.some((e) => e.section === section && e.id === m.id)) out.push({ section, id: m.id, ...(m.name ? { name: m.name } : {}) });
      }
    }
    return out.sort((a, b) => a.section.localeCompare(b.section) || a.id.localeCompare(b.id));
  }

  /** builtin: give CLIProxyAPI the official catalog plus the plans' own models, or its own sources when there are none. One run at a time. */
  syncCatalog(force = false): Promise<void> {
    this.catalogRun ??= this.doSyncCatalog(force).finally(() => (this.catalogRun = undefined));
    return this.catalogRun;
  }

  private async doSyncCatalog(force: boolean): Promise<void> {
    const mgmt = this.mgmt;
    if (this.mode() !== 'builtin' || !mgmt || mgmt.apiVersion !== 'v8' || this.closing) return;
    const extras = this.catalogExtras();
    const before = this.catalog.path;
    if (!extras.length) {
      if (!before) return;
      try {
        await mgmt.setCatalog(undefined);
        this.catalog.path = undefined;
        this.catalog.added.clear();
        dropCatalogs(this.files.dir);
      } catch (err) {
        log.warn(`could not give CLIProxyAPI its own model catalog back: ${(err as Error).message}`);
        return;
      }
      await this.afterCatalog();
      return;
    }
    const now = Date.now();
    if (force || !this.catalog.base || now - (this.catalog.baseAt ?? 0) > CATALOG_MS) {
      // a failed read waits 10 minutes; the last good one stays
      if (!force && this.catalog.failedAt && now - this.catalog.failedAt < 10 * 60_000) {
        if (!this.catalog.base) return;
      } else {
        try {
          this.catalog.base = await fetchCatalog(this.f, this.opts.catalogUrls);
          this.catalog.baseAt = now;
          this.catalog.failedAt = undefined;
        } catch (err) {
          this.catalog.failedAt = now;
          log.warn(`${(err as Error).message}; a plan's own models stay out of CLIProxyAPI until it can be read`);
          if (!this.catalog.base) return;
        }
      }
    }
    const { catalog, added } = withExtras(this.catalog.base!, extras);
    const path = writeCatalog(this.files.dir, catalog);
    if (path === before) return;
    try {
      await mgmt.setCatalog(path);
      this.catalog.path = path;
      this.catalog.added = new Set(added.map((e) => `${e.section} ${e.id}`));
      log.info(`CLIProxyAPI now knows ${added.map((e) => e.id).join(', ') || 'no new model'} from the plans' own model lists`);
    } catch (err) {
      log.warn(`could not give CLIProxyAPI the plans' own models: ${(err as Error).message}`);
      return;
    }
    await this.afterCatalog();
  }

  /** CLIProxyAPI registers the accounts' models again at once: read its lists, so the picker has what it now serves. */
  private async afterCatalog(): Promise<void> {
    await this.syncModels().catch((err) => log.debug(`model list after a catalog change: ${(err as Error).message}`));
    for (const c of this.raw) {
      const s = this.creds.get(c.name);
      if (s) s.modelsAt = 0;
    }
    await this.refreshModels(false, false);
    this.applyProvider();
    this.publish();
  }

  /** Write each credential's priority from the owner's order, where it differs. One run at a time. */
  syncPriorities(): Promise<void> {
    this.priorityRun ??= this.doSyncPriorities().finally(() => (this.priorityRun = undefined));
    return this.priorityRun;
  }

  private async doSyncPriorities(): Promise<void> {
    const mgmt = this.mgmt;
    if (!mgmt || this.closing || mgmt.apiVersion !== 'v8') return;
    // the owner's own CLIProxyAPI serves other tools too: change its priorities only once the owner set an order here
    if (this.mode() === 'external' && !this.accountService.ownerOrdered()) return;
    const want = this.accountService.credentialPriorities();
    let wrote = 0;
    for (const c of this.raw) {
      const p = want.get(c.name);
      if (p === undefined || p === c.priority) continue;
      try {
        await mgmt.setFields(c.name, { priority: p });
        c.priority = p;
        wrote++;
      } catch (err) {
        log.warn(`could not set the order of one account: ${(err as Error).message}`);
      }
    }
    if (wrote) this.feedAccounts();
  }

  /** Read everything now: credentials, every account's plan usage and models. For the Refresh button. */
  async refreshAll(): Promise<void> {
    if (this.state !== 'on' || !this.mgmt) return;
    try {
      await this.readCredentials();
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
    await this.refreshUsage({ force: true });
    await this.refreshModels(true);
    await this.syncPriorities();
  }

  private credentialOrThrow(id: string): CliproxyCredentialFacts {
    const f = this.accountService.credentialOf(id);
    if (!f) throw new HttpError(404, 'That account is not signed in here any more. Reload the list.');
    return f;
  }

  /** Pause or resume a signed in account: CLIProxyAPI stops or starts using it. */
  async setPaused(id: string, paused: boolean): Promise<void> {
    const mgmt = this.requireMgmt();
    const f = this.credentialOrThrow(id);
    try {
      await mgmt.setFields(f.name, { disabled: paused });
    } catch (err) {
      this.wrap(err);
    }
    await this.readCredentials().catch(() => undefined);
  }

  /**
   * A signed in plan's short name: its CLIProxyAPI prefix, so its models also
   * read neu/claude-opus-5-5 and Conclave can keep a request on it. Empty
   * removes it. Then the accounts and models are read again, as Refresh
   * models does. Returns the name as saved.
   */
  async setPrefix(id: string, raw: unknown): Promise<string> {
    if (typeof raw !== 'string') throw new HttpError(400, 'prefix must be text. Empty removes the short name.');
    const prefix = raw.trim();
    const format = prefixProblem(prefix);
    if (format) throw new HttpError(400, format.message);
    if (this.accountService.account(id)?.kind === 'api') throw new HttpError(400, 'A short name is for a signed in plan. An API key is picked by its own provider.');
    const mgmt = this.requireMgmt();
    const f = this.credentialOrThrow(id);
    const taken = this.raw.filter((c) => c.name !== f.name && this.prefixOf(c)).map((c) => this.prefixOf(c)!);
    const clash = prefixProblem(prefix, taken);
    if (clash) throw new HttpError(409, clash.message);
    if (prefix !== (f.prefix ?? '')) {
      try {
        await mgmt.setFields(f.name, { prefix });
      } catch (err) {
        this.wrap(err);
      }
    }
    // the credentials list does not carry it: the hub knows it now, and the models read below confirms it
    this.cred(f.name).prefix = prefix;
    this.cred(f.name).wrote = { prefix, at: Date.now() };
    await this.readCredentials().catch((err) => log.debug(`credentials after a short name: ${(err as Error).message}`));
    await this.readModels().catch((err) => log.warn(`model list after a short name: ${(err as Error).message}`));
    return prefix;
  }

  /** "Try now": clear CLIProxyAPI's cooldown on the account and read it again. */
  async tryNow(id: string): Promise<void> {
    const mgmt = this.requireMgmt();
    const f = this.credentialOrThrow(id);
    if (!f.authIndex) throw new HttpError(409, 'CLIProxyAPI has not given this account an index yet. Try again in a minute.');
    try {
      await mgmt.resetCooldown(f.authIndex);
    } catch (err) {
      this.wrap(err);
    }
    this.accountService.clearBlock(id);
    await this.readCredentials().catch(() => undefined);
    const s = this.creds.get(f.name);
    if (s) s.backoff = 0;
    await this.refreshUsage({ due: true });
  }

  /** An AccountsError from the service as an HttpError. */
  static http(err: unknown): never {
    if (err instanceof AccountsError) throw new HttpError(err.status, err.message);
    throw err;
  }

  private async sync(): Promise<void> {
    await this.syncModels().catch((err) => log.warn(`model list: ${(err as Error).message}`));
    await this.syncAccounts();
    // new accounts: their models and plan usage now, and their place in the order
    await this.refreshModels();
    await this.refreshUsage();
    await this.syncPriorities();
    this.publish();
  }

  /** The sync timer: models and accounts again, finished sign-ins forgotten, an external one checked. */
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [k, s] of this.signIns) {
      if ((s.done && now - s.done > 120_000) || now > s.expiresAt + 120_000) {
        s.catcher?.stop();
        this.signIns.delete(k);
      }
    }
    if (this.state !== 'on' || this.updating) return;
    try {
      await this.syncModels();
      await this.syncAccounts();
      // the official catalog under the plans' own models, read again as often as CLIProxyAPI reads its own
      if (this.catalog.path) await this.syncCatalog();
      this.publish();
    } catch (err) {
      if (this.mode() === 'external') {
        const gen = this.gen;
        const wait = this.nextBackoff();
        this.setState('error', `Trying again in ${Math.max(1, Math.round(wait / 1000))} seconds.`, (err as Error).message);
        this.schedule(() => {
          if (this.mode() === 'external' && gen === this.gen) void this.connectExternal(gen);
        }, wait);
      }
    }
  }

  private pluginInstallProblem(): string | undefined {
    return this.cfg().binary
      ? 'This CLIProxyAPI is an explicit binary override. Enable the plugins in that runtime yourself, or remove the override to use the managed plugin-capable release.'
      : pluginHostProblem(this.opts);
  }

  private providerCards(): SubscriptionProviderDto[] {
    const pin = pinFor(this.version ?? this.binary?.version, this.pins);
    const installable = this.mode() === 'builtin' && !this.pluginInstallProblem() ? Object.keys(SUBSCRIPTION_PLUGINS) : [];
    const ids = [...new Set(withVia([...pin.providers, ...this.plugins.map((p) => p.id), ...installable]))];
    return ids.map((id) => {
      const info = PROVIDER_INFO[id];
      const plugin = this.plugins.find((p) => p.id === id);
      return {
        id,
        name: info?.name ?? plugin?.name ?? id,
        plan: info?.plan ?? 'Added by a CLIProxyAPI plugin',
        flow: info?.flow ?? 'redirect',
        accounts: this.accounts.filter((a) => a.provider === id).length,
        ...(info?.more || !info ? { more: true } : {}),
      };
    });
  }

  private modelGroups(): SubscriptionModelGroupDto[] {
    const anthropic = ANTHROPIC_MODELS.map(wirePattern);
    const order = (id: string) => {
      const m = splitAccount(id).model.toLowerCase();
      const i = ['claude', 'gpt', 'o', 'gemini', 'grok', 'kimi', 'muse'].findIndex((p) => m.startsWith(p));
      return i < 0 ? 9 : i;
    };
    const groups = new Map<string, SubscriptionModelGroupDto>();
    for (const m of [...this.allModels()].sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id))) {
      const { account } = splitAccount(m.id);
      const g = groups.get(account) ?? { account, label: account || 'Main accounts', models: [] };
      groups.set(account, g);
      // the same name the model picker shows (SplitWireProvider.model): "Claude Opus 5.5, neu"
      const name = lookupModel(PROVIDER_ID, m.id).name;
      g.models.push({ id: m.id, ref: `${PROVIDER_ID}/${m.id}`, name: account && name !== m.id ? `${name}, ${account}` : name, wire: anthropic.some((re) => re.test(m.id)) ? 'anthropic' : 'openai', ...(m.ownedBy ? { ownedBy: m.ownedBy } : {}) });
    }
    return [...groups.values()].sort((a, b) => (a.account ? 1 : 0) - (b.account ? 1 : 0) || a.account.localeCompare(b.account));
  }

  /** A providers.cliproxy the owner set up by hand: the external form starts from it. */
  private suggested(): SubscriptionsStatus['suggested'] {
    if (this.mode() === 'external') return undefined;
    const user = this.engine.config.getUser().providers?.[PROVIDER_ID];
    if (!user?.baseUrl && user?.enabled !== true) return undefined;
    const url = cleanRoot(user.baseUrl ?? DEFAULT_BASE);
    if (!url) return undefined;
    const key = !!user.apiKey || this.engine.config.secretNames().providers.includes(PROVIDER_ID) || !!process.env.CLIPROXY_API_KEY;
    return { url, key };
  }

  status(): SubscriptionsStatus {
    const mode = this.mode();
    const cfg = this.cfg();
    const newest = newestPin(this.pins);
    const b = this.binary;
    return {
      mode,
      state: this.state,
      since: this.since,
      detail: this.detail,
      error: this.error,
      provider: PROVIDER_ID,
      version: mode === 'off' ? undefined : (this.version ?? b?.version),
      binary: mode === 'builtin' && b ? { path: b.path, version: b.version, managed: b.managed, verified: b.verified, sha256: b.sha256 } : undefined,
      pinned: { version: newest.version, repo: `github.com/${CLIPROXY_REPO}`, license: 'MIT' },
      update: mode === 'builtin' && b?.managed && b.version && compareVersions(b.version, newest.version) < 0 ? { version: newest.version } : undefined,
      external: mode === 'external' ? { url: cleanRoot(cfg.url) ?? cfg.url ?? '', key: !!this.externalKey(), managementKey: !!(cfg.managementKey && this.engine.config.expand(cfg.managementKey)) } : undefined,
      management: !!this.mgmt && this.state === 'on',
      managementNote: mode === 'off' ? undefined : this.mgmtNote,
      providers: mode === 'off' ? this.offCards() : this.providerCards(),
      accounts: this.accounts,
      models: this.modelGroups(),
      suggested: this.suggested(),
    };
  }

  /** Off: the cards of the version this hub would install, so the page can say what turning it on gives. */
  private offCards(): SubscriptionProviderDto[] {
    return subscriptionCards(newestPin(this.pins), !this.pluginInstallProblem());
  }

  // -------------------------------------------------------------------------
  // Owner actions (routes)
  // -------------------------------------------------------------------------

  async set(input: SubscriptionsSettingsInput): Promise<SubscriptionsStatus> {
    if (input.mode !== undefined && !MODES.includes(input.mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
    for (const k of ['url', 'key'] as const) if (input[k] !== undefined && typeof input[k] !== 'string') throw new HttpError(400, `${k} must be a string`);
    if (input.managementKey !== undefined && input.managementKey !== null && typeof input.managementKey !== 'string') throw new HttpError(400, 'managementKey must be a string or null');
    const cur = this.cfg();
    const mode = input.mode ?? cur.mode ?? 'off';
    let url = cur.url;
    if (input.url !== undefined) {
      if (!input.url.trim()) url = undefined;
      else {
        url = cleanRoot(input.url);
        if (!url) throw new HttpError(400, 'Use an address like http://192.168.1.10:8317, with no ? or # part.');
      }
    }
    const next: CliproxyConfig = { ...cur, mode };
    if (url) next.url = url;
    else delete next.url;
    if (mode === 'external') {
      if (!url) throw new HttpError(400, 'Type the address of your CLIProxyAPI, for example http://192.168.1.10:8317.');
      const key = input.key?.trim();
      if (key) {
        this.engine.config.setSecret('values', EXT_KEY_SECRET, key);
        next.key = `\${secret:${EXT_KEY_SECRET}}`;
      }
      const hasKey = !!key || !!(next.key && this.engine.config.expand(next.key)) || !!this.externalKey();
      if (!hasKey) throw new HttpError(400, 'Paste a client key: one of access.api-keys in its config.yaml.');
    }
    if (input.managementKey === null) {
      this.engine.config.setSecret('values', EXT_MGMT_SECRET, undefined);
      delete next.managementKey;
    } else if (input.managementKey?.trim()) {
      this.engine.config.setSecret('values', EXT_MGMT_SECRET, input.managementKey.trim());
      next.managementKey = `\${secret:${EXT_MGMT_SECRET}}`;
    }
    const user = structuredClone(this.engine.config.getUser()) as Record<string, any>;
    user.models = { ...(user.models ?? {}), cliproxy: next };
    this.engine.config.replace(user);
    // external: answer once the hub reached it (or could not), so the form shows the result
    await this.reconcile(true);
    return this.status();
  }

  /** builtin: install the newest pinned release, start it, and go back to the old one when it does not start. */
  async update(actor: string): Promise<SubscriptionsStatus> {
    if (this.mode() !== 'builtin') throw new HttpError(409, 'Update is for the CLIProxyAPI the hub runs. Pick "Run it on the hub" first.');
    if (this.cfg().binary) throw new HttpError(409, 'The hub runs your own copy (models.cliproxy.binary). Update that copy yourself.');
    if (this.updating || this.startRun) throw new HttpError(409, 'CLIProxyAPI is starting. Try again in a moment.');
    const target = newestPin(this.pins);
    const from = this.binary?.version;
    if (from && compareVersions(from, target.version) >= 0) throw new HttpError(409, `CLIProxyAPI ${from} is the newest version this hub knows. A Conclave update brings newer ones.`);
    this.updating = true;
    const home = this.engine.config.paths.home;
    const gen = ++this.gen;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    try {
      this.setState('installing', `Downloading CLIProxyAPI ${target.version}`);
      try {
        await installRelease({
          home,
          pin: target,
          base: this.opts.releaseBase,
          fetch: this.opts.fetch,
          platform: this.opts.platform,
          arch: this.opts.arch,
          glibcVersion: this.opts.glibcVersion,
          probe: (p) => this.probe(p),
          onProgress: (done, total) => {
            const now = Date.now();
            if (now - this.lastProgress < 400 && done !== total) return;
            this.lastProgress = now;
            this.setState('installing', total ? `Downloading CLIProxyAPI ${target.version}, ${mb(done)} of ${mb(total)} MB` : `Downloading CLIProxyAPI ${target.version}`);
          },
        });
      } catch (err) {
        // nothing changed: the old one keeps running
        this.setState(this.runner ? 'on' : 'error', undefined, this.runner ? undefined : this.error);
        throw new HttpError(502, (err as Error).message);
      }
      await this.stopRunner();
      try {
        this.binary = undefined;
        await this.launch(gen);
        dropPrevious(home, this.opts.platform);
        this.audit('subscriptions.update', `${from ?? 'none'} -> ${target.version}`, actor);
        return this.status();
      } catch (err) {
        const why = (err as Error).message;
        await this.stopRunner();
        const back = rollback(home, this.opts.platform);
        this.audit('subscriptions.update', `${target.version} did not start (${why})${back ? `; back on ${from}` : ''}`, actor);
        if (!back) throw new HttpError(502, `CLIProxyAPI ${target.version} did not start: ${why}`);
        this.binary = undefined;
        await this.launch(++this.gen).catch((e) => this.setState('error', undefined, (e as Error).message));
        throw new HttpError(502, `CLIProxyAPI ${target.version} did not start (${why}). The hub went back to ${from}.`);
      }
    } finally {
      this.updating = false;
    }
  }

  private requireMgmt(): Management {
    if (this.mode() === 'off') throw new HttpError(409, 'Subscriptions are off. Run CLIProxyAPI on the hub, or connect the one you run, first.');
    if (!this.mgmt || this.state !== 'on') throw new HttpError(409, this.mgmtNote ?? (this.state === 'on' ? 'Sign-in is not available here.' : 'CLIProxyAPI is not running yet. Wait until it is on.'));
    return this.mgmt;
  }

  private wrap(err: unknown): never {
    if (err instanceof HttpError) throw err;
    if (err instanceof ManagementError) throw new HttpError(err.status === 400 ? 400 : err.status === 409 ? 409 : err.status === 0 ? 502 : err.status >= 500 ? 502 : 409, err.message);
    throw err;
  }

  private dto(s: SignIn): SignInStatusDto {
    return { state: s.state, status: s.status, ...(s.error ? { error: s.error } : {}), ...(s.account ? { account: s.account } : {}) };
  }

  private endSignIns(): void {
    for (const s of this.signIns.values()) {
      s.catcher?.stop();
      if (s.status === 'wait') {
        s.status = 'cancelled';
        s.done = Date.now();
      }
    }
  }

  /**
   * Start a sign-in. `local`: the request came from the hub's own computer,
   * so the hub may catch the provider's localhost redirect itself.
   */
  async startSignIn(provider: unknown, local: boolean, actor: string): Promise<SignInStartDto> {
    if (typeof provider !== 'string' || !provider.trim()) throw new HttpError(400, 'provider is required');
    const id = provider.trim().toLowerCase();
    const via = SIGN_IN_VIA[id] ?? id;
    const mgmt = this.requireMgmt();
    const plugin = Object.hasOwn(SUBSCRIPTION_PLUGINS, via);
    if (plugin && this.mode() === 'builtin' && !this.plugins.some((p) => p.id === via)) {
      const problem = this.pluginInstallProblem();
      if (problem) throw new HttpError(400, problem);
    }
    if (!this.providerCards().some((p) => p.id === id)) throw new HttpError(400, `This CLIProxyAPI does not sign in to ${id}. Pick one of the cards.`);
    await this.syncAccounts();
    let start;
    try {
      if (this.mode() === 'builtin' && plugin) await mgmt.ensureSubscriptionPlugin(via);
      start = await mgmt.authUrl(id);
    } catch (err) {
      this.wrap(err);
    }
    const ttl = start.expiresIn ? start.expiresIn * 1000 : 10 * 60_000;
    const s: SignIn = { state: start.state, provider: id, flow: start.flow, url: start.url, userCode: start.userCode, expiresAt: Date.now() + ttl, status: 'wait', before: new Set(this.accounts.map((a) => a.name)), caught: false, mgmt, actor };
    if (start.flow === 'redirect') {
      const r = redirectOf(start.url);
      if (r) {
        s.callbackHost = r.host;
        const port = Number(r.port || (r.protocol === 'https:' ? 443 : 80));
        // Kiro's social redirect carries the plugin's own state on another path: always pasted
        if (local && isLoopbackHost(r.hostname) && via === id) {
          if (this.mode() === 'builtin' && port === this.port) s.caught = true; // CLIProxyAPI itself answers there
          else if (r.protocol === 'http:') {
            const catcher = (this.opts.catcher ?? catchRedirect)({
              port,
              path: r.pathname,
              state: start.state,
              onHit: async (url) => {
                try {
                  await this.finishSignIn(start.state, url);
                  const done = await this.waitFor(start.state, 15_000);
                  return done.status === 'ok' ? { ok: true, message: 'You can close this tab and go back to Conclave.' } : done.status === 'wait' ? { ok: true, message: 'The hub has it. Go back to Conclave; the account shows up in a moment.' } : { ok: false, message: done.error ?? 'Go back to Conclave and start the sign-in again.' };
                } catch (err) {
                  return { ok: false, message: (err as Error).message };
                }
              },
            });
            if (catcher) {
              s.catcher = catcher;
              s.caught = true;
            }
          }
        }
      }
    }
    this.signIns.set(s.state, s);
    return { state: s.state, provider: id, url: s.url, flow: s.flow, ...(s.userCode ? { userCode: s.userCode } : {}), expiresAt: s.expiresAt, caught: s.caught, ...(s.callbackHost ? { callbackHost: s.callbackHost } : {}) };
  }

  private session(state: string): SignIn {
    const s = this.signIns.get(state);
    if (!s) throw new HttpError(404, 'That sign-in ended or was not started here. Start it again.');
    return s;
  }

  private finish(s: SignIn, status: 'ok' | 'error' | 'cancelled', error?: string): void {
    s.status = status;
    s.error = error;
    s.done = Date.now();
    s.catcher?.stop();
    s.catcher = undefined;
  }

  /** Poll once: wait, ok (the account is saved), error. */
  async signIn(state: string): Promise<SignInStatusDto> {
    const s = this.session(state);
    if (s.status !== 'wait') return this.dto(s);
    if (Date.now() > s.expiresAt) {
      await s.mgmt.cancel(state);
      this.finish(s, 'error', 'The sign-in timed out. Start it again.');
      return this.dto(s);
    }
    let st;
    try {
      st = await s.mgmt.status(state);
    } catch (err) {
      // CLIProxyAPI restarting: keep waiting, the next poll may answer
      if (err instanceof ManagementError && err.status === 0) return this.dto(s);
      this.wrap(err);
    }
    if (s.status !== 'wait') return this.dto(s);
    if (st.status === 'wait') return this.dto(s);
    if (st.status === 'error') {
      this.finish(s, 'error', st.error);
      return this.dto(s);
    }
    await this.syncModels().catch(() => undefined);
    await this.syncAccounts();
    const added = this.accounts.filter((a) => !s.before.has(a.name));
    s.account = added.find((a) => a.provider === (SIGN_IN_VIA[s.provider] ?? s.provider)) ?? added[0];
    // the new account's models, plan usage and place in the order
    void this.refreshModels()
      .then(() => this.refreshUsage())
      .then(() => this.syncPriorities())
      .catch(() => undefined);
    this.finish(s, 'ok');
    const name = PROVIDER_INFO[s.provider]?.name ?? s.provider;
    this.audit('subscriptions.signin', `${name}${s.account?.label ? ` ${s.account.label}` : ''}`, s.actor);
    this.publish();
    return this.dto(s);
  }

  /** Poll until it is no longer waiting, or ms pass. */
  private async waitFor(state: string, ms: number): Promise<SignInStatusDto> {
    const end = Date.now() + ms;
    let last = await this.signIn(state);
    while (last.status === 'wait' && Date.now() < end) {
      await Bun.sleep(250);
      last = await this.signIn(state);
    }
    return last;
  }

  /** The address from the browser bar (or the catcher): give it to CLIProxyAPI as redirect_url. */
  async finishSignIn(state: string, pasted: unknown): Promise<SignInStatusDto> {
    const s = this.session(state);
    if (s.status !== 'wait') return this.dto(s);
    if (s.flow !== 'redirect') throw new HttpError(400, 'This sign-in finishes on the provider\'s page with the code. There is no address to paste.');
    // a Kiro social address carries the plugin's own state; the plugin checks it
    const url = pastedCallback(pasted, SIGN_IN_VIA[s.provider] ? undefined : state);
    try {
      await s.mgmt.callback(s.provider, state, url);
    } catch (err) {
      this.wrap(err);
    }
    // the code exchange runs in CLIProxyAPI; it usually finishes within a second or two
    return this.waitFor(state, 3_000);
  }

  async cancelSignIn(state: string): Promise<SignInStatusDto> {
    const s = this.session(state);
    if (s.status === 'wait') {
      await s.mgmt.cancel(state);
      this.finish(s, 'cancelled');
    }
    return this.dto(s);
  }

  private account(name: string): SubscriptionAccountDto {
    const a = this.accounts.find((x) => x.name === name);
    if (!a) throw new HttpError(404, 'That account is not signed in here any more. Reload the list.');
    return a;
  }

  async removeAccount(name: string, actor: string): Promise<SubscriptionsStatus> {
    const mgmt = this.requireMgmt();
    await this.syncAccounts();
    const a = this.account(name);
    try {
      await mgmt.remove(name);
    } catch (err) {
      this.wrap(err);
    }
    // the saved account, its place in every order and refusal fallback entries pinned to it go too
    const id = this.accountService.status().accounts.find((x) => x.credential === name)?.id;
    if (id) this.accountService.forget(id);
    this.audit('subscriptions.remove', `${a.providerName}${a.label ? ` ${a.label}` : ''}`, actor);
    await this.sync();
    return this.status();
  }

  async refreshAccount(name: string, actor: string): Promise<SubscriptionsStatus> {
    const mgmt = this.requireMgmt();
    const a = this.account(name);
    if (!a.canRefresh) throw new HttpError(409, 'This account cannot be refreshed. Remove it and sign in again.');
    try {
      await mgmt.refresh(name);
    } catch (err) {
      this.wrap(err);
    }
    this.audit('subscriptions.refresh', `${a.providerName}${a.label ? ` ${a.label}` : ''}`, actor);
    await this.sync();
    return this.status();
  }
}
