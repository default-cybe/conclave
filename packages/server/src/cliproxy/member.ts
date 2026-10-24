/**
 * Members' own plans (docs/design/ACCOUNTS.md 12). A member who signs in a
 * Claude, ChatGPT or other plan gets a CLIProxyAPI of their own, which the
 * hub runs as it runs its own in builtin mode: in <home>/accounts/<id>/cliproxy,
 * on 127.0.0.1, with its management and client key in the member's
 * secrets.json (the part only the hub reads, people/secrets.ts). It starts on
 * the member's first sign-in and with the hub, and it stops and its folder
 * goes with their last plan or with the member.
 *
 * Each one is a CliproxyManager over a view of the engine (memberEngine
 * below): the member's folder, keys, kv entries and order, the program the
 * hub already has, and events that only the member gets. Core sees them
 * through people/plans.ts: a member's cliproxy calls go to their own one
 * first, and to the hub's only while the owner allows it (people/access.ts).
 * The owner's calls never reach a member's plan.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { ConclaveConfig, ConfigStore, ProviderConfig } from '@conclave/core/config/index.ts';
import type { SubscriptionsStatus } from '@conclave/core/client/index.ts';
import type { AccountsService } from '@conclave/core/accounts/service.ts';
import type { EngineEvent, LimitState } from '@conclave/core/types.ts';
import type { MemberPlanEntry, MemberPlans } from '@conclave/core/people/plans.ts';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import { accountKv } from '@conclave/core/people/scoped.ts';
import { limitKey } from '@conclave/core/accounts/windows.ts';
import { logger } from '@conclave/core/util/log.ts';
import { CliproxyManager, PROVIDER_ID, PROVIDER_INFO, type CliproxyOptions } from './index';
import { cliproxyEnv, cliproxyFiles, ensurePrivateDirs } from './config';
import { PINS, installRelease, installedBinary, newestPin, parseVersion } from './release';
import { defaultSpawn, runHelp } from './runner';
import { PidFile, processMatches } from '../remote/pids';

const log = logger('cliproxy');

/** Where the member's own order and names of their plans are kept (kv, under the account). */
const PLANS_CONFIG = 'plans.config';

/** One member's view of the hub's config: their folder, their keys, their order, and the provider entry their CLIProxyAPI makes. */
interface MemberConfig {
  store: ConfigStore;
  setMode(on: boolean): void;
  setBinary(path: string | undefined): void;
  /** The entry the running CLIProxyAPI made (providers.cliproxy), its key a ${secret:...}. */
  runtimeEntry(): ProviderConfig | undefined;
  onRuntime(fn: () => void): void;
}

function memberConfig(engine: EngineApi, accountId: string, dir: string): MemberConfig {
  const secrets = engine.accountSecrets;
  const kv = accountKv(engine.repos.kv, accountId);
  const listeners = new Set<() => void>();
  let runtimeListener: (() => void) | undefined;
  let user = kv.get<Partial<ConclaveConfig>>(PLANS_CONFIG, {});
  let runtime: Partial<ConclaveConfig> = {};
  let mode: 'off' | 'builtin' = 'off';
  let binary: string | undefined;
  let merged: ConclaveConfig | undefined;

  const changed = () => {
    merged = undefined;
    for (const fn of [...listeners]) fn();
  };
  // ${env:...} is the hub's environment, never a member's; ${secret:...} is the member's hub-only keys
  const expand = (v: string): string => v.replace(/\$\{env:[A-Za-z0-9_]+\}/g, '').replace(/\$\{secret:([A-Za-z0-9_.-]+)\}/g, (_, n: string) => secrets.hubValue(accountId, n) ?? '');
  const get = (): ConclaveConfig => {
    if (merged) return merged;
    // an allow-list of what CliproxyManager (models.cliproxy) and AccountsService (providers, models.accounts, models.routes) read:
    // nothing else of the hub's config (server.token, its providers, accounts or routes) reaches a member's view
    merged = {
      providers: (runtime.providers ?? {}) as ConclaveConfig['providers'],
      models: { cliproxy: { mode, ...(binary ? { binary } : {}) }, accounts: user.models?.accounts, routes: user.models?.routes },
    } as ConclaveConfig;
    return merged;
  };
  const apiKey = (provider: string) => {
    const k = get().providers[provider]?.apiKey;
    return k ? expand(k) || undefined : undefined;
  };
  // the parts of ConfigStore that CliproxyManager and AccountsService use (people/config-view.ts does the same for memory)
  const store = {
    paths: { ...engine.config.paths, home: dir },
    get,
    getUser: () => user,
    replace: (next: Partial<ConclaveConfig>) => {
      user = { models: { accounts: next.models?.accounts, routes: next.models?.routes } } as Partial<ConclaveConfig>;
      kv.set(PLANS_CONFIG, user);
      changed();
      return get();
    },
    setRuntime: (next: Partial<ConclaveConfig>) => {
      if (JSON.stringify(next) === JSON.stringify(runtime)) return;
      runtime = structuredClone(next);
      changed();
      runtimeListener?.();
    },
    onChange: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setSecret: (_kind: 'providers' | 'values', key: string, value: string | undefined) => {
      secrets.setHubValue(accountId, key, value);
      changed();
    },
    expand,
    expandRecord: (rec: Record<string, string> | undefined) => (rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expand(v)])) : rec),
    secretValue: (name: string) => secrets.hubValue(accountId, name),
    secretNames: () => ({ providers: [], values: secrets.hubNames(accountId) }),
    apiKey,
    hasProviderKey: (provider: string) => !!apiKey(provider),
    storedKey: () => undefined,
  };
  return {
    store: store as unknown as ConfigStore,
    setMode(on) {
      mode = on ? 'builtin' : 'off';
      changed();
    },
    setBinary(path) {
      binary = path;
      changed();
    },
    runtimeEntry: () => get().providers[PROVIDER_ID],
    onRuntime(fn) {
      runtimeListener = fn;
    },
  };
}

/** In place of an error or detail that names the hub's program or its config. */
const NOT_STARTED = 'CLIProxyAPI could not start on the hub. Try again, or ask the owner.';

/** What a member's page shows: not the hub's program, its version, its updates or another CLIProxyAPI. `hub` is the hub's config. */
function shown(s: SubscriptionsStatus, hub: ConfigStore): SubscriptionsStatus {
  const { version: _version, pinned: _pinned, ...rest } = s;
  const owners = ['models.cliproxy', join(hub.paths.home, 'bin'), s.binary?.path, hub.get().models?.cliproxy?.binary].filter((x): x is string => !!x);
  const leaks = (t?: string) => !!t && owners.some((o) => t.includes(o));
  const error = leaks(s.error) ? NOT_STARTED : s.error;
  const detail = leaks(s.detail) ? (error ? undefined : NOT_STARTED) : s.detail;
  // pinned is the owner's: a member's page never reads it, so it is left out despite the type
  return { ...rest, error, detail, binary: undefined, update: undefined, external: undefined, local: false } as SubscriptionsStatus;
}

/** The engine as a member's CLIProxyAPI sees it. Its limits stay in memory: the hub's limits table is the owner's. */
function memberEngine(engine: EngineApi, accountId: string, config: ConfigStore, onStatus: (s: SubscriptionsStatus) => void): EngineApi {
  const limits = new Map<string, LimitState>();
  const repos = {
    // each account reads its own audit log
    audit: { add: (e: Parameters<EngineApi['repos']['audit']['add']>[0]) => engine.repos.audit.add({ ...e, accountId }) },
    kv: accountKv(engine.repos.kv, accountId),
    usage: {
      limits: () => [...limits.values()],
      setLimit: (l: LimitState) => void limits.set(limitKey(l), l),
      deleteLimit: (key: string) => limits.delete(key),
      // budgets are for API keys, and a member's view has none
      spend: () => 0,
    },
  };
  const bus = {
    emit: (e: EngineEvent) => {
      // only the member's own Subscriptions and Accounts pages; limit.updated is the owner's Usage page
      if (e.type === 'subscriptions.updated') {
        onStatus(e.status);
        engine.bus.emit({ ...e, status: shown(e.status, engine.config), accountId });
      } else if (e.type === 'accounts.updated') engine.bus.emit({ ...e, accountId });
    },
    // AccountsService.afterUsage is not needed here: it checks budgets, which only API accounts have (a member's view has none),
    // and a plan's windows come from CLIProxyAPI's own reads (refreshAll, noteLimit on a 429), never from usage rows
    on: () => () => {},
  };
  return { config, repos, bus, people: engine.people, accountSecrets: engine.accountSecrets } as unknown as EngineApi;
}

/** Whose plans a request works on: the owner's are the hub's own CLIProxyAPI, a member's their own (member set). */
export function plansFor(ctx: { cliproxy: CliproxyManager; memberPlans: MemberPlansManager }, accountId: string): { cliproxy: CliproxyManager; accounts: AccountsService; member?: string } {
  if (accountId === OWNER_ID) return { cliproxy: ctx.cliproxy, accounts: ctx.cliproxy.accountService };
  // getters: a route that only reads `member` (GET /api/subscriptions) makes no run
  return {
    get cliproxy() {
      return ctx.memberPlans.manager(accountId);
    },
    get accounts() {
      return ctx.memberPlans.accounts(accountId);
    },
    member: accountId,
  };
}

interface Run {
  manager: CliproxyManager;
  accounts: AccountsService;
  config: MemberConfig;
  attached: boolean;
  status?: SubscriptionsStatus;
  entryKey: string;
  lastRead: number;
}

export class MemberPlansManager implements MemberPlans {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(accountId: string) => void>();
  private installing?: Promise<string>;
  private closing = false;

  constructor(private readonly opts: CliproxyOptions) {}

  private get engine(): EngineApi {
    return this.opts.engine;
  }

  /** <home>/accounts/<id>: the member's folder (people/secrets.ts). */
  private dir(accountId: string): string {
    return join(this.engine.accountSecrets.dir, accountId);
  }

  private member(accountId: string): boolean {
    return accountId !== OWNER_ID && this.engine.people.get(accountId)?.role === 'member';
  }

  /** The run for a member, made (not started) on first use. */
  private run(accountId: string): Run {
    const have = this.runs.get(accountId);
    if (have) return have;
    if (!this.member(accountId)) throw new Error('Only a member has plans of their own here.');
    const config = memberConfig(this.engine, accountId, this.dir(accountId));
    const view = memberEngine(this.engine, accountId, config.store, (s) => {
      const cur = this.runs.get(accountId);
      if (cur) cur.status = s;
      this.check(accountId);
    });
    const manager = new CliproxyManager({ ...this.opts, engine: view });
    const r: Run = { manager, accounts: manager.accountService, config, attached: false, entryKey: '', lastRead: 0 };
    config.onRuntime(() => this.check(accountId));
    this.runs.set(accountId, r);
    return r;
  }

  /** Tell core when what a member's calls reach changed. */
  private check(accountId: string): void {
    const r = this.runs.get(accountId);
    if (!r) return;
    const e = this.entry(accountId);
    const key = e ? JSON.stringify(e.config) : '';
    if (r.entryKey === key) return;
    r.entryKey = key;
    for (const fn of this.listeners) fn(accountId);
  }

  // ----- people/plans.ts -----

  entry(accountId: string): MemberPlanEntry | undefined {
    const r = this.runs.get(accountId);
    const cfg = r?.config.runtimeEntry();
    if (!r?.attached || r.status?.state !== 'on' || !cfg?.baseUrl || !cfg.models?.length) return undefined;
    const { apiKey, ...rest } = cfg;
    const key = apiKey ? r.config.store.expand(apiKey) : '';
    return key ? { config: rest, apiKey: key } : undefined;
  }

  count(accountId: string): number {
    const r = this.runs.get(accountId);
    if (r?.attached && r.status?.state === 'on') return r.status.accounts.length;
    try {
      return readdirSync(cliproxyFiles(this.dir(accountId)).auth).filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  onChange(fn: (accountId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  noteLimit(accountId: string): void {
    const r = this.runs.get(accountId);
    // a burst of 429s reads the plans once
    if (!r?.attached || Date.now() - r.lastRead < 30_000) return;
    r.lastRead = Date.now();
    void r.manager.refreshAll().catch(() => undefined);
  }

  readyAccounts(accountId: string, model: string) {
    // the member's own AccountsService only: never the hub's plans
    const r = this.runs.get(accountId);
    return r?.attached ? r.accounts.readyAccounts(model) : [];
  }

  // ----- for the routes (routes-subscriptions.ts, routes-accounts.ts) -----

  status(accountId: string): SubscriptionsStatus {
    const r = this.runs.get(accountId);
    if (r) return shown(r.manager.status(), this.engine.config);
    if (!this.member(accountId)) throw new Error('Only a member has plans of their own here.');
    // none runs (never started, removed, or closed): off, as CliproxyManager.status() says it, without making one
    const pin = newestPin(this.opts.pins ?? PINS);
    return shown(
      {
        mode: 'off',
        state: 'off',
        since: Date.now(),
        provider: PROVIDER_ID,
        pinned: { version: pin.version, repo: '', license: 'MIT' },
        management: false,
        providers: pin.providers.map((id) => ({ id, ...PROVIDER_INFO[id], accounts: 0 })),
        accounts: [],
        models: [],
      },
      this.engine.config,
    );
  }

  manager(accountId: string): CliproxyManager {
    return this.run(accountId).manager;
  }

  accounts(accountId: string): AccountsService {
    return this.run(accountId).accounts;
  }

  /** Start the member's CLIProxyAPI (before a first sign-in, and at hub start). Returns at once; the status says when it is on. */
  async start(accountId: string): Promise<SubscriptionsStatus> {
    let r = this.run(accountId);
    // a final error does not clear itself: start again with a new one (and the hub's program as it is now)
    if (r.attached && !this.closing && r.manager.status().state === 'error') {
      this.runs.delete(accountId);
      await r.manager.close();
      r.accounts.dispose();
      r = this.run(accountId);
    }
    if (r.attached || this.closing) return this.status(accountId);
    r.config.setBinary(await this.binary());
    if (this.closing || this.runs.get(accountId) !== r || r.attached) return this.status(accountId);
    r.config.setMode(true);
    r.attached = true;
    r.manager.attach();
    return this.status(accountId);
  }

  /** After a plan was signed out: with none left, the member's CLIProxyAPI stops and its folder goes. */
  async afterRemove(accountId: string): Promise<SubscriptionsStatus> {
    const m = this.runs.get(accountId)?.manager;
    // a sign-in for another plan is open: it needs this CLIProxyAPI
    if (m?.hasSignIns()) return this.status(accountId);
    const s = m?.status();
    if ((s?.state === 'on' && s.accounts.length === 0) || this.count(accountId) === 0) await this.remove(accountId);
    return this.status(accountId);
  }

  /** Stop the member's CLIProxyAPI and delete its folder, its keys and their order (the last plan went, or the member). */
  async remove(accountId: string): Promise<void> {
    const r = this.runs.get(accountId);
    this.runs.delete(accountId);
    if (r) {
      await r.manager.close();
      r.accounts.dispose();
    }
    const files = cliproxyFiles(this.dir(accountId));
    // a hub that was killed left this one running: stop it (only one started with this member's config), as CliproxyManager.attach() does
    if (existsSync(files.pids)) {
      const stale = new PidFile(files.pids).reap({ isOurs: (pid) => processMatches(pid, (cmd) => cmd.includes(files.config)) });
      if (stale.length) log.info(`stopped ${stale.length} member CLIProxyAPI left by an earlier run (pid ${stale.join(', ')})`);
    }
    rmSync(files.dir, { recursive: true, force: true });
    for (const name of this.engine.accountSecrets.hubNames(accountId)) this.engine.accountSecrets.setHubValue(accountId, name, undefined);
    accountKv(this.engine.repos.kv, accountId).delete(PLANS_CONFIG);
    if (r?.entryKey) for (const fn of this.listeners) fn(accountId);
  }

  /** Once the hub listens: start each member's CLIProxyAPI that has plans; a folder without any goes. */
  attach(): void {
    for (const a of this.engine.people.list()) {
      if (a.role !== 'member' || !existsSync(cliproxyFiles(this.dir(a.id)).dir)) continue;
      if (this.count(a.id) === 0) void this.remove(a.id).catch((err) => log.warn(`a member's CLIProxyAPI folder was not removed: ${(err as Error).message}`));
      else void this.start(a.id).catch((err) => log.warn(`a member's CLIProxyAPI did not start: ${(err as Error).message}`));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const runs = [...this.runs.values()];
    this.runs.clear();
    await Promise.all(
      runs.map(async (r) => {
        await r.manager.close();
        r.accounts.dispose();
      }),
    );
  }

  /** The program the hub runs for itself: models.cliproxy.binary, the copy in <home>/bin, or the pinned release downloaded there now. */
  private binary(): Promise<string> {
    const own = this.engine.config.get().models?.cliproxy?.binary;
    if (own) return Promise.resolve(own);
    const home = this.engine.config.paths.home;
    const have = installedBinary(home, this.opts.platform);
    if (have) return Promise.resolve(have.path);
    this.installing ??= (async () => {
      const files = cliproxyFiles(home);
      ensurePrivateDirs(files);
      const spawn = this.opts.spawn ?? defaultSpawn;
      const probe = (p: string) =>
        runHelp(spawn, p, cliproxyEnv(process.env, files.dir), files.dir)
          .then((r) => parseVersion(r.out))
          .catch(() => undefined);
      const info = await installRelease({ home, pin: newestPin(this.opts.pins ?? PINS), base: this.opts.releaseBase, fetch: this.opts.fetch, platform: this.opts.platform, arch: this.opts.arch, probe });
      return info.path;
    })().finally(() => (this.installing = undefined));
    return this.installing;
  }
}
