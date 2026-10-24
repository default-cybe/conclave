import type {
  ApprovalRequest,
  ApprovalResponse,
  AskFrom,
  AuditEntry,
  Checkpoint,
  ContentBlock,
  Device,
  ImageBlock,
  MemoryEntry,
  Message,
  Notice,
  QuestionRequest,
  QueuedMessage,
  PermissionMode,
  Session,
  SessionStatus,
  Todo,
  Usage,
  UsageRecord,
} from '../types';
import type {
  AgentDefaultInfo,
  Attachment,
  CliName,
  ComponentKindDto,
  CreateSessionInput,
  ExtensionSourceInfo,
  ExtensionsOverview,
  ExternalSessionInfo,
  FileEntryDto,
  BuiltinHookDto,
  HookImportResult,
  HookTestInput,
  HookTestResult,
  HooksOverview,
  HubInfo,
  InventoryItemDto,
  MarketplaceSearchResult,
  McpCallResult,
  McpConnectRunResult,
  McpConnectStepDto,
  McpImportFormat,
  McpStatus,
  McpTestResult,
  McpToolDto,
  ModelGroup,
  PluginDetailDto,
  ProjectTrustInfo,
  SecondOpinionInput,
  SendInput,
  SendResult,
  SessionPatch,
  SyncClisOptions,
  ToolCheckInput,
  ToolCheckResult,
  ToolDetail,
  ToolInfo,
  UsageSummary,
} from '../client';
import type { BusyWorkDto } from '../client/updates';
import { WorkflowStore } from '../workflows/store';
import type { EngineApi, DeviceHub, MemoryAdminApi } from './api';
import type { SessionFilter } from '../storage/repos';
import { Repos } from '../storage/repos';
import type { Db } from '../storage/db';
import { ConfigStore } from '../config';
import type { ConclaveConfig, HookEvent, HooksConfig, McpServerConfig } from '../config/schema';
import { hiddenWords, isHiddenModel } from '../config/hidden';
import { EventBus } from '../util/bus';
import { newId } from '../util/ids';
import { oneLine } from '../util/text';
import { logger } from '../util/log';
import type { ChatRequest, ModelInfo, Provider } from '../providers/types';
import { ProviderRegistry } from '../providers/registry';
import { mergeModelGroups } from '../providers/merge';
import { accountsOf } from '../accounts/attached';
import type { Machine } from '../machine/types';
import type { AgentDef, InstalledPlugin } from '../extensions/types';
import type { HookInput, HookOutcome, ExtensionRegistry } from '../extensions/types';
import type { Hooks } from '../extensions/hooks';
import { HookRecipes } from '../extensions/recipes';
import { builtinHooks as builtinHooksList, setBuiltinHook as setBuiltin } from './builtin-hooks';
import type { McpManager } from '../extensions/mcp';
import type { PluginManager } from '../extensions/plugins';
import { builtinAgentDefault } from '../extensions/builtin-agents';
import type { MemoryService } from '../memory/types';
import type { RoutineService, Scheduler } from '../scheduler/types';
import type { Notifier } from '../notify/types';
import type { HarnessAdapter } from '../acp/types';
import { harnessOffWords } from '../acp/harness-off';
import type { Tool } from '../tools/types';
import { builtinTools, filterTools } from '../tools';
import { QUEUE_KEY, SessionRunner, type StoredQueued } from '../session/runner';
import { RunnerExtensions } from '../session/runner-ext';
import { OfflineMachine } from '../projects/offline';
import { checkMcpOff, mcpOff, sessionAllowsServerTool } from '../session/connectors';
import { projectsOf } from '../projects/attached';
import { workflowsOf } from '../workflows/attached';
import { askOrigin } from './ask-origin';
import { alertsOf } from '../alerts/attached';
import { buildSystemPrompt, type PromptParts } from '../session/prompt';
import { platformBlocksFor } from '../platform/facts';
import { detectTestCommand, detectWorkspaceFacts, type WorkspaceFacts } from '../session/project';
import { verifyCommandFor } from '../session/verify-gate';
import { CHAT_AGENT, chatSettings, chatUsesMemory, mergeChatSettings, sessionAllowsTool } from '../session/chat';
import { isUntrusted } from '../session/untrusted';
import { friendShareOf, narrowsTools } from '../session/friend-share';
import { takesEffort } from '../providers/anthropic';
import { clampEffort, type Effort, type EffortSetting } from '../providers/effort';
import { retiredAlias } from '../providers/access-programs';
import { activeMessages, isReminder, renderTranscript } from '../session/transcript';
import { exportSession as exportShared, type ExportResult } from '../session/share';
import { readPastSession, searchPastSessions, type PastRead, type PastSessionHit, type PastSessionQuery } from '../session/search';
import { toolSearchFor } from '../tools/tool-search';
import { TASK_TOOLS } from '../tools/background-tasks';
import { shellRegistry } from '../tools/shells';
import { BackgroundTasks } from './background';
import { delegateRefusal, moveToMainList } from './delegate';
import { delegateMark, isDelegated, movedToMain } from '../session/delegated';
import { FILE_WRITE_TOOLS } from './subagent';
import { PermissionRulesFor, routineOf } from './permissions-view';
import { EngineToolHost } from './host';
import { EngineError } from './errors';
import { handoff as handoffModel } from '../modes/handoff';
import { estimateSwitch } from '../modes/switch-cost';
import { nextSwitch } from '../modes/switch-marker';
import { ProjectTrust } from './settings-sources';
import * as ext from './extensions-api';
import type { BackupOptions, HubBackup, RestoreOptions, RestoreResult } from '../client';
import type { ShareOptions } from '../client/share';
import { createBackup, restoreBackup } from './backup';
import { agentModelRef } from '../extensions/agent-model';
import { agentHookConfig, wantsVerifyGate } from '../extensions/agent-hooks';
import { OWNER_ID, currentAccount, isMember, runAs } from '../people/context';
import { PeopleStore, type HubAccount } from '../people/store';
import { AccountSecrets } from '../people/secrets';
import { ProviderAccess } from '../people/access';
import { PLAN_PROVIDER } from '../people/plans';
import { eventAccount } from '../people/events';
import { RefusedMachine, MachineRefused, HUB_REFUSED, DEVICE_REFUSED, CODE_NEEDS_DEVICE } from '../people/guard';
import { accountConfigView } from '../people/config-view';
import { memberFetch, memberMcpClientFactory } from '../people/memory';
import { isAbsolute, join } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { checkShareable, expandHome, outputsDir, usesOutputs, SHARE_MAX_BYTES, type ShareRoot, type SharedFileMeta } from '../files/share';
import { SqliteMemory } from '../memory/store';
import { MemoryConnections, MemoryConnectionService } from '../memory/connections';
import { prepareAttachments, type ZipHost } from '../attachments/prepare';
import { mediaTypeFor } from '../attachments/limits';

const log = logger('engine');
/** The turn after which an auto title is revised once, when the topic is clearer. */
const TITLE_REVISE_TURN = 3;

type ThinkingEffort = Effort;
/** Where the Effort levels harness models offered are kept (noteHarnessEffort). */
const HARNESS_EFFORT_KEY = 'harness.effort';
/** Where the models each harness's account offered are kept (noteHarnessModels). */
const HARNESS_MODELS_KEY = 'harness.models';
/** Agents that write or review code. With no thinking level of their own they run at medium effort where the model takes one. */
export const CODING_AGENTS = new Set([
  'coder', 'general-purpose', 'explore', 'reviewer', 'planner', 'security',
  'builder', 'tester', 'debugger', 'refactorer', 'designer', 'docs-writer', 'verifier', 'code-researcher', 'workflow',
]);

export interface EngineDeps {
  db: Db;
  config: ConfigStore;
  bus: EventBus;
  repos: Repos;
  providers: ProviderRegistry;
  extensions: ExtensionRegistry;
  memory: MemoryService;
  routines: RoutineService;
  scheduler: Scheduler;
  notifier: Notifier;
  devices: DeviceHub;
  /** The hub's own machine. */
  localMachine: Machine;
  acp?: HarnessAdapter;
  /** Tools that are hidden unless an agent opts in (browser tools). */
  optInTools?: Tool[];
  /** MCP tools getter (async). */
  mcpTools?: () => Promise<Tool[]>;
  mcpStatus?: () => McpStatus[];
  /** `extra`: hooks of the session's agent profile (extensions/agent-hooks.ts), run with the configured ones. `commands: false`: only in-process hooks (a member's session). */
  runHookCommands: (event: HookEvent, input: HookInput, matcherValue?: string, extra?: HooksConfig, opts?: { commands?: boolean }) => Promise<HookOutcome>;
  version: string;
  /** The hook runner behind runHookCommands, for the Hooks view (plan, recent, test runs). */
  hooks?: Hooks;
  mcp?: McpManager;
  plugins?: PluginManager;
  /** Trusted project folders. Created from repos.kv when not given. */
  trust?: ProjectTrust;
  /** Memory connections API (memory/connections/service.ts). */
  memoryAdmin?: MemoryAdminApi;
  /** Closed on shutdown so stdio memory servers stop. */
  memoryConnections?: MemoryConnections;
  /** A model call for a chore, on an account's keys (memory extraction and summaries for a member). */
  completeFor?: (accountId: string, o: { model?: string; system?: string; prompt: string; maxTokens?: number; purpose?: string }) => Promise<string>;
}

/** Agents, skills and commands a member's session may use: the ones that ship and plugins the owner installed, never the owner's own files. */
const SHARED_SOURCES = new Set(['builtin', 'plugin']);
/** Tools a member's session never gets: the browser runs on the hub, and a learned skill would land in the owner's skills. */
/**
 * Tools a member's session never gets (docs/design/ACCOUNTS.md 5): learned
 * skills land in the owner's folder; maps spend the owner's key and the
 * hub's daily cap; watches browse with the hub's Chromium.
 */
const MEMBER_DENY = new Set(['SkillManage', 'PlaceSearch', 'PlaceDetails', 'Directions', 'MapImage', 'WatchReport', 'WatchCreate', 'Delegate']);

/** How long a turn waits for MCP servers to connect before it starts without their tools. */
const MCP_PREFETCH_WAIT_MS = 5_000;
/** MCP tool lists are refreshed in the background after this long. */
const MCP_TOOLS_TTL_MS = 30_000;
/** MCP tools above this count load through ToolSearch (config mcp.deferAbove). */
const DEFAULT_DEFER_ABOVE = 30;
/** Stored tool outputs are kept this long, except in pinned sessions (HARNESS-REVIEW item 16). */
export const OUTPUT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const OUTPUTS_PRUNE_JOB = 'outputs.prune';

function unavailableMemoryAdmin(): MemoryAdminApi {
  return new Proxy({} as MemoryAdminApi, {
    get: () => () => {
      throw new EngineError(501, 'memory connections are not available on this hub');
    },
  });
}

/**
 * The Engine owns session execution and ties every subsystem together. The
 * server and the standalone CLI both drive it through EngineApi; the session
 * runner, tools and mode runners call the wider surface here.
 */
export class Engine implements EngineApi {
  readonly bus: EventBus;
  readonly config: ConfigStore;
  readonly repos: Repos;
  readonly providers: ProviderRegistry;
  readonly extensions: ExtensionRegistry;
  readonly memory: MemoryService;
  readonly routines: RoutineService;
  readonly scheduler: Scheduler;
  readonly notifier: Notifier;
  readonly devices: DeviceHub;
  readonly usage: import('../usage/service').UsageService;
  readonly acp?: HarnessAdapter;
  readonly startedAt = Date.now();
  readonly version: string;
  /** Project folders whose hooks and allow rules may run. */
  readonly trust: ProjectTrust;
  readonly memoryAdmin: MemoryAdminApi;
  /** Extension points of the session runner (session/runner-ext.ts). */
  readonly runnerExtensions = new RunnerExtensions();
  /** Background subagents as tasks (engine/background.ts). */
  readonly backgroundTasks = new BackgroundTasks(this);
  /** Accounts on this hub (docs/design/ACCOUNTS.md). */
  readonly people: PeopleStore;
  /** Members' own keys; the owner's are the hub's. */
  readonly accountSecrets: AccountSecrets;
  /** Whose key pays for a call, and budgets on the hub's keys. */
  readonly access: ProviderAccess;
  /** A provider registry per member, on that member's keys (the owner uses `providers`). */
  private registries = new Map<string, ProviderRegistry>();
  /** A memory store per member, with that member's own connections (the owner uses `memory`). */
  private memories = new Map<string, { memory: SqliteMemory; admin: MemoryConnectionService; connections: MemoryConnections }>();
  /** Session id to account, for event routing (a session never changes account). */
  private sessionAccounts = new Map<string, string>();

  private runners = new Map<string, SessionRunner>();
  /** Sessions with a compaction in progress (one at a time per session). */
  readonly compacting = new Set<string>();
  private mcpCache: { tools: Tool[]; at: number } | null = null;
  private mcpRefresh?: Promise<Tool[]>;
  private approvals = new Map<string, { req: ApprovalRequest; resolve: (r: ApprovalResponse) => void }>();
  private questions = new Map<string, { req: QuestionRequest; resolve: (a: Record<string, string>) => void }>();
  /**
   * Sessions of scheduled and webhook routine runs (ECOSYSTEM.md 5.3 item 5).
   * Nobody is there to approve, so a call that needs approval is refused and
   * listed here, and a question gets no answer; the turn goes on.
   */
  readonly unattended = new Map<string, { denied: Array<{ tool: string; input: string; rule?: string }> }>();
  private toolCache: { tools: Tool[]; at: number } | null = null;
  /** Test command per session and folder, for the Environment block (session/project.ts). */
  private testCommands = new Map<string, Promise<string | undefined>>();
  private workspaceFacts = new Map<string, Promise<WorkspaceFacts>>();
  private deps: EngineDeps;

  constructor(deps: EngineDeps, usage: import('../usage/service').UsageService) {
    this.deps = deps;
    this.bus = deps.bus;
    this.config = deps.config;
    this.repos = deps.repos;
    this.providers = deps.providers;
    this.providers.setHarnessEffort?.((ref) => this.harnessEffort(ref));
    this.providers.setHarnessModels?.((harness) => this.harnessModels(harness));
    this.extensions = deps.extensions;
    this.memory = deps.memory;
    this.routines = deps.routines;
    this.scheduler = deps.scheduler;
    this.notifier = deps.notifier;
    this.devices = deps.devices;
    this.acp = deps.acp;
    this.version = deps.version;
    this.usage = usage;
    this.trust = deps.trust ?? new ProjectTrust(deps.repos.kv);
    this.memoryAdmin = deps.memoryAdmin ?? unavailableMemoryAdmin();
    this.people = new PeopleStore(deps.repos.db);
    this.accountSecrets = new AccountSecrets(deps.config);
    this.access = new ProviderAccess({ db: deps.repos.db, config: deps.config, people: this.people, secrets: this.accountSecrets });
    // a member's new key takes effect on the next call
    this.accountSecrets.onChange((id) => this.registries.get(id)?.invalidate());
    // so does a plan they signed in or out (people/plans.ts)
    this.access.onPlansChange((id) => this.registries.get(id)?.invalidate());
    // every event goes only to the account it belongs to (people/events.ts)
    this.bus.setAccountResolver((e) =>
      eventAccount(e, {
        session: (id) => this.sessionAccount(id),
        // a workflow run is its host session's
        workflowRun: (id) => (this.repos.db.query('SELECT s.account_id FROM workflow_runs w JOIN sessions s ON s.id = w.session_id WHERE w.id = ?').get(id) as { account_id: string } | null)?.account_id,
        routine: (id) => this.repos.routines.get(id)?.accountId,
      }),
    );

    this.scheduler.handle('session.resume', (p) => import('../session/limits').then((m) => m.resumeAfterReset(this, p)));
    // retention: a daily job deletes old stored tool outputs
    this.scheduler.handle(OUTPUTS_PRUNE_JOB, async () => void this.pruneOutputs());
    if (!this.repos.jobs.pending(OUTPUTS_PRUNE_JOB).length) this.scheduler.enqueue(OUTPUTS_PRUNE_JOB, Date.now() + 10 * 60_000, {}, OUTPUTS_PRUNE_JOB);
    this.config.onChange(() => {
      this.toolCache = null;
      this.mcpCache = null;
    });
    // recover sessions left running by a crash; a background subagent among them is lost, and its parent hears so
    const active = this.repos.sessions.listActive();
    for (const s of active) {
      if (s.status === 'running' || s.status === 'waiting_approval' || s.status === 'waiting_input') {
        this.repos.sessions.update({ ...s, status: 'idle', updatedAt: Date.now() });
      }
    }
    // Failed-inference boundaries live only in runners; never advertise replay after a restart.
    const retryNotices = this.repos.db.query("SELECT id FROM messages WHERE kind = 'notice' AND json_extract(meta, '$.type') = 'provider_error' AND json_extract(meta, '$.canRetry') = 1").all() as { id: string }[];
    for (const { id } of retryNotices) {
      const notice = this.repos.messages.get(id)!;
      this.repos.messages.update({ ...notice, meta: { ...notice.meta, canRetry: false, retryExpired: true }, content: [...notice.content, { type: 'text', text: 'Alternate-model retry expired when the hub restarted. Nothing was rerun. Send a new instruction without repeating completed operations.' }] });
    }
    this.backgroundTasks.markLost(active);
  }

  /**
   * Delete stored tool outputs older than OUTPUT_RETENTION_MS (pinned
   * sessions keep theirs) and those of deleted sessions, then plan the next
   * run a day later. Returns how many went.
   */
  pruneOutputs(now = Date.now()): number {
    const n = this.repos.outputs.prune(now - OUTPUT_RETENTION_MS);
    if (n) log.info(`deleted ${n} stored tool outputs past retention`);
    this.scheduler.enqueue(OUTPUTS_PRUNE_JOB, now + 24 * 60 * 60_000, {}, OUTPUTS_PRUNE_JOB);
    return n;
  }

  // -------------------------------------------------------------------------
  // Accounts (docs/design/ACCOUNTS.md)
  // -------------------------------------------------------------------------

  /** The account a session belongs to; undefined for an unknown id. Cached: a session never changes account. */
  sessionAccount(id: string): string | undefined {
    const hit = this.sessionAccounts.get(id);
    if (hit) return hit;
    const r = this.repos.db.query('SELECT account_id FROM sessions WHERE id = ?').get(id) as { account_id: string | null } | null;
    if (!r) return undefined;
    if (this.sessionAccounts.size > 20_000) this.sessionAccounts.clear();
    const acct = r.account_id ?? OWNER_ID;
    this.sessionAccounts.set(id, acct);
    return acct;
  }

  /** The account of a session ('owner' for one from before accounts). */
  accountOf(session: Pick<Session, 'accountId'> | undefined): string {
    return session?.accountId ?? OWNER_ID;
  }

  /** A member's session: no hub machine, no hub MCP servers, hooks or owner files (docs/design/ACCOUNTS.md 5). */
  isMemberSession(session: Pick<Session, 'accountId'> | undefined): boolean {
    return isMember(this.accountOf(session));
  }

  /** An account's own preferences (default model and agent). */
  accountPrefs(accountId: string): HubAccount['settings'] {
    return this.people.get(accountId)?.settings ?? {};
  }

  /** The provider registry for an account's calls: the hub's for the owner; for a member, their own keys and plans, and the hub keys the owner allowed. */
  providersFor(accountId: string | undefined): ProviderRegistry {
    if (!isMember(accountId)) return this.providers;
    let r = this.registries.get(accountId!);
    if (!r) {
      r = this.providers.withKeys(this.access.registryKeys(accountId!));
      this.registries.set(accountId!, r);
    }
    return r;
  }

  /** The registry for a session's calls. */
  registryFor(session: Pick<Session, 'accountId'> | undefined): ProviderRegistry {
    return this.providersFor(this.accountOf(session));
  }

  /** An account's memory: profile, facts, episodes and its own connections. The owner's is `memory`. */
  memoryFor(accountId: string | undefined): SqliteMemory {
    if (!isMember(accountId)) return this.memory as SqliteMemory;
    return this.memberMemory(accountId!).memory;
  }

  /** An account's memory connections, file import and export (the owner's is `memoryAdmin`). */
  memoryAdminFor(accountId: string | undefined): MemoryAdminApi {
    if (!isMember(accountId)) return this.memoryAdmin;
    return this.memberMemory(accountId!).admin;
  }

  private memberMemory(accountId: string): { memory: SqliteMemory; admin: MemoryConnectionService; connections: MemoryConnections } {
    const hit = this.memories.get(accountId);
    if (hit) return hit;
    const view = accountConfigView(this.config, { accountId, kv: this.repos.kv, secrets: this.accountSecrets });
    const dir = join(this.accountSecrets.dir, accountId);
    const connections = new MemoryConnections({
      config: view,
      // never the hub's MCP servers: they are the owner's
      callTool: async () => {
        throw new Error("A member's memory connection cannot use the hub's MCP servers.");
      },
      listTools: async () => [],
      mcpClientFactory: memberMcpClientFactory(view, dir),
      fetch: memberFetch,
    });
    const complete = (o: { model?: string; system?: string; prompt: string; maxTokens?: number; purpose?: string }) =>
      this.deps.completeFor ? this.deps.completeFor(accountId, { ...o, purpose: 'memory' }) : Promise.reject(new Error('no model for chores on this hub'));
    const memory = new SqliteMemory({ db: this.repos.db, bus: this.bus, config: view, complete, external: connections, accountId });
    const admin = new MemoryConnectionService({ config: view, connections, memory, db: this.repos.db, bus: this.bus });
    const bundle = { memory, admin, connections };
    this.memories.set(accountId, bundle);
    return bundle;
  }

  /** Forget a removed member: their memory connections close, their registry goes. */
  async forgetAccount(accountId: string): Promise<void> {
    const b = this.memories.get(accountId);
    this.memories.delete(accountId);
    this.registries.get(accountId)?.dispose();
    this.registries.delete(accountId);
    for (const [sid, acct] of this.sessionAccounts) if (acct === accountId) this.sessionAccounts.delete(sid);
    for (const [id, r] of this.runners) {
      if (this.sessionAccount(id) === accountId || !this.repos.sessions.get(id)) {
        r.abort();
        this.runners.delete(id);
      }
    }
    b?.admin.grouped.stop();
    await b?.connections.close().catch(() => {});
  }

  info(): HubInfo {
    return {
      // the hub's own device name (its host name unless renamed), so clients say "Hub madx"
      name: this.devices.list().find((d) => d.id === 'local')?.name ?? 'Conclave',
      version: this.version,
      startedAt: this.startedAt,
      devices: this.devices.list().length,
      publicUrl: this.config.get().server.publicUrl,
      defaultModel: this.config.get().defaultModel,
      features: ['sessions', 'agents', 'routines', 'memory', 'usage', 'devices', 'jury', 'debate', 'gateway', 'acp', 'extensions', 'memory-connections', 'mcp-server', 'project-trust', 'subscriptions'],
    };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  listSessions(filter: SessionFilter): Session[] {
    return this.repos.sessions.list(filter);
  }

  getSession(id: string): Session | undefined {
    return this.repos.sessions.get(id);
  }

  /**
   * A new session for an account. The account never comes from the request
   * body: the server passes the caller's, a subagent gets its parent's, a
   * routine its routine's. Left out, it is the parent's, then the account the
   * work runs for, then the owner's. The parent, task and device must be the
   * account's own. `byPerson`: someone starts it from an app, so a member's
   * code session on the hub's own computer is refused now (400), not at
   * every tool; work the hub starts (routines, workflows) meets the machine
   * guard as before.
   */
  async createSession(input: CreateSessionInput, accountId?: string, opts: { byPerson?: boolean } = {}): Promise<Session> {
    const parentAccount = input.parentId ? this.sessionAccount(input.parentId) : undefined;
    if (input.parentId && !parentAccount) throw new EngineError(404, `Session ${input.parentId} not found`);
    const acct = accountId ?? parentAccount ?? currentAccount() ?? OWNER_ID;
    if (parentAccount && parentAccount !== acct) throw new EngineError(404, `Session ${input.parentId} not found`);
    if (input.taskId && (this.repos.tasks.get(input.taskId)?.accountId ?? OWNER_ID) !== acct) throw new EngineError(404, 'Task not found');
    if (input.device && input.device !== 'local' && this.repos.devices.accountOf(input.device) !== acct) throw new EngineError(404, `Device ${input.device} not found`);
    const prefs = isMember(acct) ? this.accountPrefs(acct) : {};
    const cfg = this.config.get();
    if (input.kind !== undefined && input.kind !== 'chat' && input.kind !== 'agent') throw new EngineError(400, 'kind must be chat or agent');
    const isChat = input.kind === 'chat';
    let chat;
    try {
      // an agent session may carry chat.thinking (its effort switch) and chat.memory (off leaves no trace); web search is a chat switch
      if (isChat) chat = mergeChatSettings(undefined, input.chat);
      else if (input.chat !== undefined) {
        const merged = mergeChatSettings(undefined, input.chat);
        chat = merged.thinking || merged.cyber || !merged.memory ? merged : undefined;
      }
    } catch (err) {
      throw new EngineError(400, (err as Error).message);
    }
    // a chat uses the chat agent (when it is installed) and runs on the hub: it has no files or devices
    const agent = input.agent ?? (isChat && this.extensions.agent(CHAT_AGENT) ? CHAT_AGENT : (prefs.defaultAgent ?? cfg.defaultAgent));
    const def = this.agentNamed(agent, undefined, acct) ?? this.extensions.agents()[0];
    if (isMember(acct) && input.agent && !this.agentNamed(input.agent, undefined, acct)) throw new EngineError(404, `Agent ${input.agent} not found`);
    // an agent's tier word (fast, smart, deep) resolves against the default model (extensions/agent-model.ts)
    const defaultModel = prefs.defaultModel ?? cfg.defaultModel;
    const model = input.model ?? (def?.model ? agentModelRef(this, def.model, defaultModel).model : defaultModel);
    // the hub's default device applies only while it is connected; otherwise the session runs on the hub (a member's never uses the owner's)
    const fallback = !isMember(acct) && cfg.defaultDevice && this.devices.get(cfg.defaultDevice) ? cfg.defaultDevice : 'local';
    const device = input.device || (isChat ? 'local' : def?.device || fallback);
    if (opts.byPerson && isMember(acct) && device === 'local' && !isChat && this.needsMachine(agent, model)) throw new EngineError(400, CODE_NEEDS_DEVICE);
    // a harness that is off (the default since v0.4.2) starts nothing: say where to turn it on
    const off = this.harnessOff(model);
    if (off) throw new EngineError(400, off);
    const machine = this.devices.get(device) ?? this.deps.localMachine;
    // a member's session on the hub has no folder there: a placeholder, never the hub's home
    const cwd = input.cwd ?? (isMember(acct) && device === 'local' ? '~' : await this.safeHome(machine));
    const now = Date.now();
    const session: Session = {
      id: newId('ses'),
      accountId: acct,
      title: input.title ?? 'New chat',
      agent,
      model,
      mode: input.mode ?? def?.mode ?? 'agent',
      permissionMode: input.permissionMode ?? def?.permissionMode ?? cfg.permissions.mode,
      cwd,
      device,
      status: 'idle',
      parentId: input.parentId,
      taskId: input.taskId,
      tags: input.tags ?? [],
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      modeConfig: input.modeConfig,
      stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      ...(isChat ? { kind: 'chat' as const, chat } : chat ? { chat } : {}),
      // an agent profile with ultra: true starts its sessions with Ultra on (never chats)
      ...(def?.ultra && !isChat ? { ultra: true } : {}),
    };
    this.repos.sessions.insert(session);
    this.bus.emit({ type: 'session.created', session });
    this.audit(session.id, 'session.create', `${agent} / ${model} in ${cwd}`);
    if (input.prompt) await this.send(session.id, { text: input.prompt });
    return session;
  }

  /** Words for a model on a harness that is off (acp/harness-off.ts), or one the owner hid (models.hidden), else undefined. */
  harnessOff(model: string): string | undefined {
    if (isHiddenModel(this.config.get(), model)) return hiddenWords(model);
    const i = model.indexOf('/');
    if (i < 0) return undefined;
    const provider = model.slice(0, i);
    return harnessOffWords(provider, this.config.get().providers[provider]);
  }

  /**
   * A session with nothing to do without a machine: a coding agent works in a
   * folder, and a harness runs its CLI there. Chats and the assistant need
   * none (docs/design/ACCOUNTS.md 5); other agents start too, and a file or
   * shell call of theirs says why it cannot run.
   */
  private needsMachine(agent: string, model: string): boolean {
    if (CODING_AGENTS.has(agent)) return true;
    try {
      return !!this.providers.resolve(model).acp;
    } catch {
      return false;
    }
  }

  updateSession(id: string, patch: SessionPatch, opts: { quiet?: boolean } = {}): Session {
    const s = this.requireSession(id);
    if (patch.device && patch.device !== s.device && patch.device !== 'local' && this.repos.devices.accountOf(patch.device) !== this.accountOf(s)) throw new EngineError(404, `Device ${patch.device} not found`);
    if (patch.taskId && (this.repos.tasks.get(patch.taskId)?.accountId ?? OWNER_ID) !== this.accountOf(s)) throw new EngineError(404, 'Task not found');
    if (patch.kind !== undefined && patch.kind !== 'chat' && patch.kind !== 'agent') throw new EngineError(400, 'kind must be chat or agent');
    const off = patch.model && patch.model !== s.model ? this.harnessOff(patch.model) : undefined;
    if (off) throw new EngineError(400, off);
    const kind = patch.kind ?? s.kind;
    // a chat runs on the hub with no folder: it never moves (Continue as a session turns it into one first)
    if (kind === 'chat' && ((patch.device && patch.device !== s.device) || (patch.cwd && patch.cwd !== s.cwd))) throw new EngineError(400, 'A chat runs on the hub and has no device or folder. Continue it as a session to work in a folder.');
    let chat = s.chat;
    if ((kind === 'chat' && (patch.chat !== undefined || !chat)) || (kind !== 'chat' && patch.chat !== undefined)) {
      try {
        chat = mergeChatSettings(s.chat, patch.chat);
      } catch (err) {
        throw new EngineError(400, (err as Error).message);
      }
    }
    const next: Session = {
      ...s,
      ...('title' in patch ? { title: patch.title! } : {}),
      ...('tags' in patch ? { tags: patch.tags! } : {}),
      ...('pinned' in patch ? { pinned: patch.pinned! } : {}),
      ...('archived' in patch ? { archived: patch.archived! } : {}),
      ...('agent' in patch ? { agent: patch.agent! } : {}),
      ...('model' in patch ? { model: patch.model! } : {}),
      ...('mode' in patch ? { mode: patch.mode! } : {}),
      ...('permissionMode' in patch ? { permissionMode: patch.permissionMode! } : {}),
      ...('cwd' in patch ? { cwd: patch.cwd! } : {}),
      ...('device' in patch ? { device: patch.device! } : {}),
      ...('taskId' in patch ? { taskId: patch.taskId ?? undefined } : {}),
      ...('modeConfig' in patch ? { modeConfig: patch.modeConfig } : {}),
      // workflows: the Ultra switch (docs/WORKFLOWS.md); never on a chat
      ...('ultra' in patch ? { ultra: !!patch.ultra && kind !== 'chat' } : {}),
      updatedAt: Date.now(),
    };
    // connectors off for this session only (session/connectors.ts)
    if ('mcpOff' in patch) {
      let off: string[];
      try {
        off = checkMcpOff(patch.mcpOff);
      } catch (err) {
        throw new EngineError(400, (err as Error).message);
      }
      const meta: Record<string, unknown> = { ...(s.meta ?? {}) };
      if (off.length) meta.mcpOff = off;
      else delete meta.mcpOff;
      next.meta = Object.keys(meta).length ? meta : undefined;
    }
    // a new model on a session with history: its next request says it took over (modes/switch-marker.ts)
    if (patch.model && patch.model !== s.model && s.stats.messages > 0) {
      const meta: Record<string, unknown> = { ...(next.meta ?? {}) };
      const switched = nextSwitch(meta.switched, s.model, patch.model);
      if (switched) meta.switched = switched;
      else delete meta.switched;
      next.meta = Object.keys(meta).length ? meta : undefined;
    }
    // Continue as a session: the chat leaves the Chat page and keeps its transcript
    if (kind === 'chat') Object.assign(next, { kind: 'chat', chat });
    else {
      delete next.kind;
      // a workbench session keeps its effort, Cyber access and memory switches; Continue as a session drops the chat's switches
      const keep = (patch.chat !== undefined || s.kind !== 'chat') && (!!chat?.thinking || !!chat?.cyber || chat?.memory === false);
      if (keep) next.chat = chat;
      else delete next.chat;
    }
    this.repos.sessions.update(next);
    this.bus.emit({ type: 'session.updated', session: next });
    // a new folder or device: the shell, read state and path allow rules start over (2.1 bug 2)
    if (next.cwd !== s.cwd || next.device !== s.device) {
      this.runners.get(id)?.resetPathState();
      this.runnerExtensions.pathChanged({ sessionId: id, from: { device: s.device, cwd: s.cwd }, to: { device: next.device, cwd: next.cwd } });
      if (!opts.quiet) {
        const where = next.device !== s.device ? ` on ${this.devices.list().find((d) => d.id === next.device)?.name ?? next.device}` : '';
        this.notice(id, `Working folder is now ${next.cwd}${where}. The shell starts there, and files are read again before an edit.`, 'info');
      }
    }
    return next;
  }

  /**
   * Move a session to another device or folder, resolving where its project
   * lives there (projects/move.ts). Throws 501 when the hub has no projects service.
   */
  async moveSession(id: string, input: import('../client/projects').MoveInput): Promise<import('../client/projects').MoveResult> {
    this.requireSession(id);
    const svc = projectsOf(this);
    if (!svc) throw new EngineError(501, 'folders across devices are not available on this hub');
    return svc.move(id, input);
  }

  /**
   * Memory keys for a session's project notes: its folder, plus every known
   * location of its project, so notes follow a session that moved to another
   * device (projects/service.ts memoryKeys).
   */
  memoryProject(session: Session): string | string[] {
    return projectsOf(this)?.memoryKeys(session) ?? session.cwd;
  }

  async deleteSession(id: string): Promise<void> {
    const runner = this.runners.get(id);
    const session = this.repos.sessions.get(id);
    runner?.abort();
    // its subagents stop too: a background one would run on, and spend, for a parent that is gone (one moved to the main list is the owner's own now)
    const stopChildren = (parentId: string, depth: number) => {
      if (depth > 8) return;
      for (const child of this.repos.sessions.list({ parentId, limit: 1000 })) {
        if (movedToMain(child)) continue;
        this.runners.get(child.id)?.abort();
        stopChildren(child.id, depth + 1);
      }
    };
    stopChildren(id, 0);
    // a dev server it left running in the background would hold its port until the hub restarts
    void shellRegistry.disposeSession(id).catch((err) => log.warn(`could not stop the background shells of ${id}`, err));
    if (runner?.started && session) await this.runHook(session, 'SessionEnd', { reason: 'other' }, 'other');
    this.runners.delete(id);
    this.repos.sessions.delete(id);
    this.bus.emit({ type: 'session.deleted', sessionId: id, accountId: this.accountOf(session) });
  }

  /** Move to main list: delegated work becomes a normal session of its kind; parentId stays (engine/delegate.ts). */
  moveToMainList(id: string): Session {
    return moveToMainList(this, id);
  }

  forkSession(id: string, fromSeq?: number): Session {
    const s = this.requireSession(id);
    const now = Date.now();
    const fork: Session = { ...s, id: newId('ses'), title: `${s.title} (fork)`, parentId: s.parentId, createdAt: now, updatedAt: now, status: 'idle', external: undefined };
    const msgs = this.repos.messages.list(id).filter((m) => fromSeq === undefined || m.seq <= fromSeq);
    // new ids in the fork; a second opinion keeps pointing at its reply's copy
    const ids = new Map(msgs.map((m) => [m.id, newId('msg')]));
    const stats = { ...fork.stats, messages: msgs.length };
    // one transaction: a failure part way leaves no half-copied fork
    this.repos.db.transaction(() => {
      this.repos.sessions.insert({ ...fork, stats });
      for (const m of msgs) {
        const about = typeof m.meta?.messageId === 'string' ? ids.get(m.meta.messageId) : undefined;
        this.repos.messages.insert({ ...m, id: ids.get(m.id)!, sessionId: fork.id, ...(about ? { meta: { ...m.meta, messageId: about } } : {}) });
      }
    })();
    this.bus.emit({ type: 'session.created', session: { ...fork, stats } });
    return { ...fork, stats };
  }

  getMessages(id: string, afterSeq?: number): Message[] {
    return this.repos.messages.list(id, { afterSeq });
  }

  async send(id: string, input: SendInput): Promise<SendResult> {
    const s = this.requireSession(id);
    // a reference from a friend's hub is read only (session/friend-share.ts)
    const fs = friendShareOf(s);
    if (fs?.role === 'reference') throw new EngineError(409, `This is a reference from ${fs.name}'s hub. It is read only; fork the share to continue it.`);
    // 15 files at most, and a zip turned into what the session can use (attachments/prepare.ts)
    const attachments = await prepareAttachments(input.attachments, this.zipHost(s));
    return this.runnerFor(id).enqueue(attachments === input.attachments ? input : { ...input, attachments });
  }

  /**
   * Where a zip goes for this session: into its folder when it can unzip with
   * its own tools (a shell, or a harness with its own), else the hub reads it.
   */
  private zipHost(s: Session): ZipHost {
    return {
      fileTools: () => {
        if (s.kind === 'chat') return false;
        try {
          if (this.providers.resolve(s.model).acp) return true;
        } catch {
          /* not a model this hub knows: its tools decide */
        }
        try {
          return this.toolsFor(s, this.agentFor(s), s.mode, 0).some((t) => t.name === 'Bash');
        } catch {
          return false;
        }
      },
      save: async (name, bytes) => {
        const m = this.machineFor(s);
        const dot = name.toLowerCase().lastIndexOf('.zip');
        for (let n = 1; n < 100; n++) {
          const file = n === 1 ? name : `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
          const path = m.resolve(`uploads/${file}`, s.cwd || '~');
          if (await m.stat(path)) continue;
          await m.writeFile(path, bytes);
          return path;
        }
        throw new Error('no free name');
      },
      read: (path) => {
        const m = this.machineFor(s);
        return m.readFile(m.resolve(path, s.cwd || '~'));
      },
    };
  }

  queue(id: string): QueuedMessage[] {
    this.requireSession(id);
    return this.runners.get(id)?.pending ?? [];
  }

  /**
   * Work an update's restart would cut (server update/service.ts): sessions
   * running or waiting for the owner, background tasks, messages waiting to
   * be sent, workflow runs and routine runs. With a device, only work there.
   * A session parked for a usage limit (waiting_reset) does not count: boot
   * keeps its status and its session.resume job is in the jobs table.
   */
  busyWork(device?: string): BusyWorkDto[] {
    const on = (d: string | undefined) => !device || (d || 'local') === device;
    const out: BusyWorkDto[] = [];
    const seen = new Set<string>();
    const add = (s: Session, kind: BusyWorkDto['kind']) => {
      if (seen.has(s.id) || s.status === 'waiting_reset' || !on(s.device)) return;
      seen.add(s.id);
      out.push({ kind, id: s.id, name: s.title, device: s.device, status: s.status });
    };
    for (const s of this.repos.sessions.listActive()) add(s, (s.meta?.background as { state?: string } | undefined)?.state === 'running' ? 'task' : 'session');
    // a background task between turns is not 'running' as a session, but is still work
    const tasks = this.repos.db.query(`SELECT id FROM sessions WHERE json_extract(meta, '$.background.state') = 'running'`).all() as Array<{ id: string }>;
    for (const { id } of tasks) {
      const s = this.repos.sessions.get(id);
      if (s) add(s, 'task');
    }
    for (const [id, r] of this.runners) {
      const s = r.pending.some((p) => !p.held) ? this.repos.sessions.get(id) : undefined;
      if (s) add(s, 'queued');
    }
    this.workflowRuns ??= new WorkflowStore(this.repos.db);
    for (const w of this.workflowRuns.listRuns({ statuses: ['running', 'queued'], limit: 100 })) if (on(w.device)) out.push({ kind: 'workflow', id: w.id, name: w.name, device: w.device, status: w.status });
    for (const r of this.routines.running?.() ?? []) if (on(r.device)) out.push({ kind: 'routine', id: r.id, name: r.name, ...(r.device ? { device: r.device } : {}) });
    return out;
  }
  private workflowRuns?: WorkflowStore;

  /** Nothing an update's restart would cut is going (busyWork). */
  isIdle(device?: string): boolean {
    return !this.busyWork(device).length;
  }

  unqueue(id: string, pendingId: string): void {
    this.requireSession(id);
    const r = this.runners.get(id)?.unqueue(pendingId) ?? 'missing';
    if (r === 'started') throw new EngineError(409, 'That message has started. It is in the transcript now.');
    if (r === 'missing') throw new EngineError(404, 'That message is not waiting any more.');
  }

  /**
   * /btw: a side question about the session, answered by one call on the
   * session's model with no tools, from the transcript's tail. Nothing joins
   * the transcript or the queue, so the running turn never sees it.
   */
  async btw(id: string, text: string): Promise<{ answer: string }> {
    const s = this.requireSession(id);
    const question = text.trim();
    if (!question) throw new EngineError(400, 'Ask a question after /btw.');
    const { completeText } = await import('../session/stream');
    // shortcut: the last 60 messages, capped at 20k chars; a long session's start is left out
    const context = renderTranscript(this.repos.messages.list(id).slice(-60), { maxChars: 20_000 });
    const answer = await completeText(this, {
      model: s.model,
      system: 'You answer a quick side question about a conversation between the user and an assistant that may still be working. Answer briefly from the conversation; say so when it does not tell. You cannot use tools or act.',
      prompt: `<conversation>\n${context || '(nothing yet)'}\n</conversation>\n\nSide question: ${question}`,
      maxTokens: 1500,
      purpose: 'btw',
      sessionId: id,
    });
    return { answer };
  }

  sendQueued(id: string, pendingId: string): void {
    this.requireSession(id);
    if (!this.runners.get(id)?.release(pendingId)) throw new EngineError(404, 'That message is not waiting any more.');
  }

  /** At boot: the messages that waited when the hub stopped wait again (runner.ts storeQueue). */
  restoreQueues(): void {
    for (const key of this.repos.kv.keys(QUEUE_KEY)) {
      const id = key.slice(QUEUE_KEY.length);
      const items = this.repos.kv.get<StoredQueued[]>(key, []);
      if (!this.repos.sessions.get(id) || !Array.isArray(items) || !items.length) this.repos.kv.delete(key);
      else this.runnerFor(id).restore(items);
    }
  }

  abort(id: string): void {
    this.runners.get(id)?.abort();
  }

  async rewind(id: string, seq: number, restoreFiles = false): Promise<Session> {
    const s = this.requireSession(id);
    this.runners.get(id)?.abort();
    // Keeps messages up to and including `seq`. Files go back to how they were right
    // after that message: the first checkpoint taken at or after it (a checkpoint at
    // seq N is taken when prompt N arrives, before its tools run).
    if (restoreFiles) {
      const ckpt = this.repos.checkpoints.list(id).find((c) => c.seq >= seq);
      if (ckpt) {
        const { restoreCheckpoint } = await import('../session/checkpoints');
        await restoreCheckpoint(this, s, this.machineFor(s), ckpt.id);
      }
    }
    this.repos.messages.truncateAfter(id, seq);
    const count = this.repos.messages.list(id).length;
    const next = { ...this.requireSession(id), stats: { ...s.stats, messages: count }, status: 'idle' as SessionStatus, updatedAt: Date.now() };
    this.repos.sessions.update(next);
    this.bus.emit({ type: 'session.updated', session: next });
    return next;
  }

  async secondOpinion(id: string, input: SecondOpinionInput): Promise<void> {
    const s = this.requireSession(id);
    const controller = new AbortController();
    const { runSecondOpinion } = await import('../modes/review');
    await runSecondOpinion(this, s, input, controller.signal);
  }

  /** Switch the session's model. brief: a short handover, when the chat is big enough and the target is not cheap (modes/handoff.ts). */
  async handoff(id: string, model: string, opts: { brief?: boolean } = {}): Promise<Session> {
    const s = this.requireSession(id);
    return handoffModel(this, s, model, opts);
  }

  /**
   * "Try the next model" on a refused reply (session/refusal-fallback.ts):
   * the last reply must have ended in a refusal. It is dropped, with the "Not
   * run" results of its calls, and the turn runs again on the refusal
   * fallback entry after the model and account that refused, with the same
   * stored messages. Works whether or not the automatic fallback is on, as
   * long as the list has an entry to go to. Says which model is tried.
   */
  async tryNextModel(id: string, messageId?: string): Promise<{ model: string; label: string }> {
    const s = this.requireSession(id);
    const runner = this.runnerFor(id);
    if (runner.busy) throw new EngineError(409, 'Wait for the reply to finish, then try the next model.');
    const msgs = this.repos.messages.list(id);
    const at = msgs.findLastIndex((m) => m.role === 'assistant' && m.kind === 'normal');
    const reply = at >= 0 ? msgs[at] : undefined;
    if (!reply || reply.stopReason !== 'refusal') throw new EngineError(409, 'The last reply was not refused.');
    if (messageId && reply.id !== messageId) throw new EngineError(409, 'Only the last reply can go to the next model.');
    // only notices and the "Not run" answers to its calls may follow it
    const after = msgs.slice(at + 1);
    const notRun = (m: Message) => m.role === 'user' && m.kind === 'normal' && m.content.length > 0 && m.content.every((b) => b.type === 'tool_result' && b.meta?.notRun === 'refusal');
    if (after.some((m) => m.kind !== 'notice' && !notRun(m))) throw new EngineError(409, 'Only the last reply can go to the next model.');
    const { refusalPlan, refusalStepOf, RefusalWalk, servedOf } = await import('../session/refusal-fallback');
    // the list names the owner's accounts: a member's session has none to walk
    const plan = isMember(s.accountId) ? undefined : refusalPlan(this.config.get(), this.agentFor(s));
    if (!plan) throw new EngineError(409, 'Refusal fallback has no models, and no plan is marked to use when a model refuses. Add them in Settings, Models.');
    const served = servedOf(reply);
    if (!served) throw new EngineError(409, 'Conclave does not know which model refused this reply.');
    const next = new RefusalWalk(this, s, plan, refusalStepOf(reply)).next(served);
    if (!next) throw new EngineError(409, 'No model is left in Refusal fallback.');
    // the refused partial output goes; the turn starts again from the same messages
    this.removeMessage(reply.id);
    for (const m of after) if (notRun(m)) this.removeMessage(m.id);
    runner.retryRefusal(served, reply);
    return { model: next.ref, label: next.label };
  }

  /** Retry a failed native inference in place; never rewind or resubmit its user message. */
  async retryProvider(id: string, messageId: string, model: string): Promise<{ model: string; label: string }> {
    const s = this.requireSession(id);
    if (!this.isUsable(model, s.accountId)) throw new EngineError(400, this.harnessOff(model) ?? `Model ${model} is not available`);
    const resolved = this.registryFor(s).resolve(model);
    if (!this.registryFor(s).isEnabled(resolved.provider)) throw new EngineError(400, `Provider ${resolved.provider} is disabled`);
    if (resolved.acp || this.isAgentRef(model)) throw new EngineError(400, 'Retry needs a model API, not an agent harness.');
    if (isMember(s.accountId)) this.access.check(s.accountId!, resolved.provider, resolved.model);
    try {
      this.runnerFor(id).retryProvider(messageId, model);
    } catch (err) {
      throw new EngineError(409, (err as Error).message);
    }
    return { model, label: this.displayModel(model) };
  }

  /** What switching the session to a model would cost, against staying (modes/switch-cost.ts). */
  switchEstimate(id: string, model: string): import('../modes/switch-cost').SwitchEstimate {
    const s = this.requireSession(id);
    if (!this.isUsableRef(model)) throw new EngineError(400, this.harnessOff(model) ?? `Model ${model} is not available`);
    return estimateSwitch(this, s, model);
  }

  /** Summarize older messages now. instructions: what the summary must keep (/compact <instructions>). False when there was nothing to compact. */
  async compact(id: string, instructions?: string): Promise<boolean> {
    const s = this.requireSession(id);
    const { maybeCompact } = await import('../session/compaction');
    const done = await maybeCompact(this, id, s.model, new AbortController().signal, 'manual', instructions);
    if (done) this.runnerFor(id).markSessionStart('compact');
    return done;
  }

  /** What fills the session's context now (/context): system, tools, messages, tool output, and where compaction starts. */
  async contextUsage(id: string): Promise<import('../client').ContextUsageDto> {
    const { contextUsage } = await import('../session/context-usage');
    return contextUsage(this, id);
  }

  async command(id: string, line: string): Promise<{ output?: string }> {
    const { runCommand } = await import('./commands');
    return runCommand(this, id, line);
  }

  todos(id: string): Todo[] {
    return this.runners.get(id)?.todos ?? [];
  }

  checkpoints(id: string): Checkpoint[] {
    return this.repos.checkpoints.list(id);
  }

  async restoreCheckpoint(id: string, checkpointId: string): Promise<void> {
    const s = this.requireSession(id);
    const { restoreCheckpoint } = await import('../session/checkpoints');
    await restoreCheckpoint(this, s, this.machineFor(s), checkpointId);
  }

  async diff(id: string): Promise<{ diff: string; files: string[] }> {
    const s = this.requireSession(id);
    const machine = this.machineFor(s);
    // a member's session on the hub's own computer: its tools never ran there, so it changed nothing (docs/design/ACCOUNTS.md 5)
    const res = await machine.exec('git diff --no-color HEAD 2>/dev/null || git diff --no-color 2>/dev/null || true', { cwd: s.cwd, timeoutMs: 20_000 }).catch((err: unknown) => {
      if (err instanceof MachineRefused) return { stdout: '' };
      throw err;
    });
    const diff = res.stdout;
    const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
    return { diff, files };
  }

  /** Sanitized by default (session/share.ts); raw is the stored rows, for the owner's backups. */
  exportSession(id: string, format: 'md' | 'json', opts: ShareOptions & { raw?: boolean } = {}): ExportResult {
    this.requireSession(id);
    return exportShared(this, id, format, opts);
  }

  /** Full-text search over one account's messages (the owner's when left out). */
  search(q: string, accountId: string = OWNER_ID) {
    return this.repos.messages.search(q, 30, accountId).map((r) => ({ ...r, title: this.repos.sessions.get(r.sessionId)?.title ?? 'Session' }));
  }

  /**
   * The owner's past chats and sessions (session/search.ts), for SessionSearch,
   * the MCP chat_search and the daily digest. Sessions of untrusted agents,
   * sessions marked untrusted and sessions with memory off are never searched,
   * and a device can be named by its id or its name.
   */
  searchPast(q: PastSessionQuery): PastSessionHit[] {
    const devices = this.devices.list(q.accountId ?? OWNER_ID);
    const device = q.device ? (devices.find((d) => d.id === q.device) ?? devices.find((d) => d.name.toLowerCase() === q.device!.toLowerCase()))?.id ?? q.device : undefined;
    const hits = searchPastSessions(this.repos.db, { ...q, accountId: q.accountId ?? OWNER_ID, device, skipAgent: (a, cwd) => !!this.extensions.agent(a, cwd)?.untrusted });
    return hits.map((h) => ({ ...h, deviceName: devices.find((d) => d.id === h.device)?.name }));
  }

  /** A window of one past session, with the same rules as searchPast. */
  readPast(id: string, opts: { around?: number; count?: number; exclude?: string[]; accountId?: string } = {}): PastRead | undefined {
    // another account's session reads as one that is not there
    if ((this.sessionAccount(id) ?? '') !== (opts.accountId ?? OWNER_ID)) return undefined;
    const r = readPastSession(this.repos.db, id, { ...opts, accountId: opts.accountId ?? OWNER_ID, skipAgent: (a, cwd) => !!this.extensions.agent(a, cwd)?.untrusted });
    if (!r) return undefined;
    return { ...r, hit: { ...r.hit, deviceName: this.devices.list().find((d) => d.id === r.hit.device)?.name } };
  }

  // -------------------------------------------------------------------------
  // Approvals and questions
  // -------------------------------------------------------------------------

  /** Open approvals; with an account, only those of its sessions. */
  pendingApprovals(accountId?: string): ApprovalRequest[] {
    const all = [...this.approvals.values()].map((a) => a.req);
    return accountId === undefined ? all : all.filter((r) => this.sessionAccount(r.sessionId) === accountId);
  }

  /** The account an open approval or question belongs to (its session's). */
  pendingAccount(id: string): string | undefined {
    const sid = this.approvals.get(id)?.req.sessionId ?? this.questions.get(id)?.req.sessionId;
    return sid ? this.sessionAccount(sid) : undefined;
  }

  /**
   * The top session of the one that asks, through subagents and workflow
   * runs, and who asks when it is below the top (engine/ask-origin.ts).
   */
  askOrigin(sessionId: string): { rootSessionId: string; from?: AskFrom } {
    return askOrigin(
      {
        session: (id) => this.repos.sessions.get(id),
        run: (id) => {
          const r = workflowsOf(this)?.store.getRun(id);
          return r ? { sessionId: r.sessionId, name: r.name } : undefined;
        },
      },
      sessionId,
    );
  }

  /** The unattended routine run a session belongs to, also for subagents it started. */
  private unattendedFor(sessionId: string): { denied: Array<{ tool: string; input: string; rule?: string }> } | undefined {
    if (!this.unattended.size) return undefined;
    let id: string | undefined = sessionId;
    for (let depth = 0; id && depth < 6; depth++) {
      const hit = this.unattended.get(id);
      if (hit) return hit;
      id = this.repos.sessions.get(id)?.parentId;
    }
    return undefined;
  }

  requestApproval(sessionId: string, partial: Omit<ApprovalRequest, 'id' | 'createdAt' | 'sessionId'>, signal: AbortSignal): Promise<ApprovalResponse> {
    const away = this.unattendedFor(sessionId);
    if (away) {
      if (away.denied.length < 50) away.denied.push({ tool: partial.tool, input: oneLine(partial.summary ?? '', 300), ...(partial.suggestedRule ? { rule: partial.suggestedRule } : {}) });
      this.audit(sessionId, 'approval', `deny ${partial.tool} (routine run, nobody to approve): ${oneLine(partial.summary ?? '', 80)}`);
      return Promise.resolve({ decision: 'deny', message: 'Nobody is there to approve this. Do not retry it; ask the owner in your reply.' });
    }
    // an untrusted session never gets a standing rule from one answer
    const session = this.repos.sessions.get(sessionId);
    // a subagent's or a workflow agent's request shows in the chat the owner is in, too (engine/ask-origin.ts)
    const origin = this.askOrigin(sessionId);
    const req: ApprovalRequest = { ...partial, id: newId('appr'), sessionId, ...origin, createdAt: Date.now(), ...(session && this.isUntrusted(session) ? { noAlways: true } : {}) };
    this.logApproval(() => this.repos.approvals.requested({ id: req.id, sessionId, tool: req.tool, harness: req.harness, requestedAt: req.createdAt }));
    this.setStatus(sessionId, 'waiting_approval');
    this.bus.emit({ type: 'approval.requested', approval: req });
    this.notifyEvent('approvalNeeded', { title: 'Approval needed', body: req.summary, level: 'warning', sessionId, link: `/s/${origin.rootSessionId}`, approvalId: req.id });
    return new Promise<ApprovalResponse>((resolve) => {
      const entry = { req, resolve };
      this.approvals.set(req.id, entry);
      const onAbort = () => {
        if (this.approvals.delete(req.id)) {
          this.logApproval(() => this.repos.approvals.resolved(req.id, 'aborted'));
          this.bus.emit({ type: 'approval.resolved', id: req.id, sessionId, response: { decision: 'deny', message: 'aborted' } });
          resolve({ decision: 'deny', message: 'aborted' });
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }).then((r) => {
      if (this.repos.sessions.get(sessionId)?.status === 'waiting_approval') this.setStatus(sessionId, 'running');
      return r;
    });
  }

  resolveApproval(id: string, response: ApprovalResponse): boolean {
    const entry = this.approvals.get(id);
    if (!entry) return false;
    this.approvals.delete(id);
    // "always allow" is not offered for an untrusted session, and an answer that says it anyway counts once
    if (response.decision === 'allow' && response.scope === 'always' && (entry.req.noAlways || this.sessionUntrusted(entry.req.sessionId))) response = { decision: 'allow', scope: 'once' };
    // nothing approves ahead in a fork of a friend's share until the owner wrote their own message (session/friend-share.ts)
    if (response.decision === 'allow' && response.scope === 'session' && friendShareOf(this.repos.sessions.get(entry.req.sessionId))?.guard) response = { decision: 'allow', scope: 'once' };
    // "always" writes the hub's config, which is the owner's: a member's always counts for the session
    if (response.decision === 'allow' && response.scope === 'always' && this.isMemberSession(this.repos.sessions.get(entry.req.sessionId))) response = { decision: 'allow', scope: 'session', rule: response.rule };
    if (response.decision === 'allow' && response.scope === 'always') {
      const rule = response.rule ?? entry.req.suggestedRule ?? entry.req.tool;
      this.config.update({ permissions: { ...this.config.get().permissions, allow: [...this.config.get().permissions.allow, rule] } });
    }
    this.logApproval(() => this.repos.approvals.resolved(id, response.decision));
    this.bus.emit({ type: 'approval.resolved', id, sessionId: entry.req.sessionId, response });
    this.audit(entry.req.sessionId, 'approval', `${response.decision} ${entry.req.tool}: ${oneLine(entry.req.summary, 80)}`);
    entry.resolve(response);
    return true;
  }

  private sessionUntrusted(id: string): boolean {
    const s = this.repos.sessions.get(id);
    return !!s && this.isUntrusted(s);
  }

  /** The approvals table (when asked, when answered) is Recap data: it must never break an approval. */
  private logApproval(write: () => void): void {
    try {
      write();
    } catch (err) {
      log.debug('approval log not written', err);
    }
  }

  /** Open questions; with an account, only those of its sessions. */
  pendingQuestions(accountId?: string): QuestionRequest[] {
    const all = [...this.questions.values()].map((q) => q.req);
    return accountId === undefined ? all : all.filter((q) => this.sessionAccount(q.sessionId) === accountId);
  }

  askUser(sessionId: string, questions: QuestionRequest['questions'], signal: AbortSignal): Promise<Record<string, string>> {
    // a scheduled routine run: nobody can answer, so the question gets no answer and the turn goes on
    if (this.unattendedFor(sessionId)) return Promise.resolve({});
    const origin = this.askOrigin(sessionId);
    const req: QuestionRequest = { id: newId('q'), sessionId, ...origin, questions, createdAt: Date.now() };
    this.setStatus(sessionId, 'waiting_input');
    this.bus.emit({ type: 'question.asked', question: req });
    this.notifyEvent('approvalNeeded', { title: 'Question', body: questions[0]?.question ?? 'A session needs your input', level: 'info', sessionId, link: `/s/${origin.rootSessionId}`, questionId: req.id });
    return new Promise<Record<string, string>>((resolve) => {
      this.questions.set(req.id, { req, resolve });
      signal.addEventListener('abort', () => {
        if (this.questions.delete(req.id)) resolve({});
      }, { once: true });
    }).then((a) => {
      if (this.repos.sessions.get(sessionId)?.status === 'waiting_input') this.setStatus(sessionId, 'running');
      return a;
    });
  }

  answerQuestion(id: string, answers: Record<string, string>): boolean {
    const entry = this.questions.get(id);
    if (!entry) return false;
    this.questions.delete(id);
    this.bus.emit({ type: 'question.answered', id, sessionId: entry.req.sessionId });
    entry.resolve(answers);
    return true;
  }

  cancelPendingFor(sessionId: string): void {
    for (const [id, a] of this.approvals) if (a.req.sessionId === sessionId) this.resolveApproval(id, { decision: 'deny', message: 'aborted' });
    for (const [id] of this.questions) if (this.questions.get(id)?.req.sessionId === sessionId) this.answerQuestion(id, {});
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /**
   * Every provider with its models, for pickers and Settings. A model the
   * account order reaches through several providers is marked so pickers
   * show it once, with its route in words (providers/merge.ts); a member's
   * list has their own providers and the routes they may use.
   */
  async listModels(accountId?: string): Promise<ModelGroup[]> {
    const cfg = this.config.get();
    const groups = (await this.providersFor(accountId).groups()).map((g) => ({ ...g, models: g.models.filter((m) => !isHiddenModel(cfg, m.ref)) }));
    const accounts = accountsOf(this);
    // a model a member's own plan lists goes to that plan: the owner's order does not speak for it
    const routeOf = (m: string) => (accountId && this.access.ownPlan(accountId, PLAN_PROVIDER, m) ? undefined : accounts?.routeOf(m));
    return mergeModelGroups(groups, routeOf, { member: isMember(accountId), vendorOf: (m) => accounts?.listedVendor(m) });
  }

  testProvider(id: string): Promise<{ ok: boolean; detail: string; latencyMs?: number }> {
    return this.providers.test(id);
  }

  listTools(): ToolInfo[] {
    const builtin: ToolInfo[] = this.allBuiltinTools().map((t) => ({ name: t.name, description: oneLine(t.description, 160), readOnly: typeof t.readOnly === 'boolean' ? t.readOnly : false, source: 'builtin' as const }));
    // MCP tools from the last listing; servers connect lazily, so this fills in after the first turn or listing
    const mcp: ToolInfo[] = this.cachedMcpTools().map((t) => ({
      name: t.name,
      description: oneLine(t.description, 160),
      readOnly: typeof t.readOnly === 'boolean' ? t.readOnly : false,
      source: 'mcp' as const,
      server: /^mcp__(.+?)__/.exec(t.name)?.[1],
    }));
    if (!this.mcpCache) void this.mcpToolList().catch(() => {});
    return [...builtin, ...mcp];
  }

  mcpStatus(): McpStatus[] {
    // like listTools: servers nobody used yet start now, so the list says "connecting" instead of a bare "failed"
    if (!this.mcpCache) void this.mcpToolList().catch(() => {});
    return ext.enrichStatus(this, this.deps.mcpStatus?.() ?? []);
  }

  async reload(): Promise<void> {
    await this.extensions.reload();
    this.toolCache = null;
    this.bus.emit({ type: 'config.updated' });
  }

  async syncToClis(device?: string, opts: Omit<SyncClisOptions, 'device'> = {}): Promise<string[]> {
    const { syncToClis } = await import('../extensions/cli-sync');
    const machine = device ? this.devices.get(device) : this.deps.localMachine;
    if (!machine) throw new EngineError(404, 'Device not found');
    const only = opts.only?.length ? opts.only : undefined;
    if (only?.some((c) => !['claude', 'codex', 'opencode', 'gemini'].includes(c))) throw new EngineError(400, 'only must list claude, codex, opencode or gemini');
    const written = await syncToClis(machine, {
      // skills agents wrote stay in Conclave; the owner copies one to ~/.conclave/skills to share it
      skills: this.extensions.skills().filter((s) => s.source === 'user' && !s.learned),
      agents: this.extensions.agents().filter((a) => a.source === 'user'),
      only,
      dryRun: !!opts.dryRun,
    });
    // the route writes the audit entry, with who asked
    return written;
  }

  // agent defaults ---------------------------------------------------------
  agentDefault(name: string): AgentDefaultInfo | undefined {
    const shipped = builtinAgentDefault(name);
    if (!shipped) return undefined;
    const active = this.extensions.agent(name);
    const overridden = !!active && active.source !== 'builtin';
    return {
      name,
      markdown: shipped.markdown,
      agent: shipped.agent,
      active,
      overridden,
      activeSource: active?.source,
      resettable: overridden && active!.source === 'user' && !!active!.path,
    };
  }

  // extensions area ----------------------------------------------------------
  extensionsOverview(cwd?: string, device?: string): Promise<ExtensionsOverview> {
    return ext.overview(this, cwd, device);
  }
  extensionsInventory(cwd?: string, kind?: ComponentKindDto): InventoryItemDto[] {
    return ext.inventory(this, cwd, kind);
  }
  extensionSources(cwd?: string): ExtensionSourceInfo[] {
    return ext.sources(this, cwd);
  }
  toolsDetail(q: { cwd?: string; agent?: string }): Promise<ToolDetail[]> {
    return ext.toolsDetail(this, q);
  }
  checkTool(input: ToolCheckInput): Promise<ToolCheckResult> {
    return ext.checkTool(this, input);
  }
  hooksOverview(cwd?: string): HooksOverview {
    return ext.hooksOverview(this, cwd);
  }
  testHook(input: HookTestInput): Promise<HookTestResult> {
    return ext.testHook(this, input);
  }
  /** Save one scope's hooks; returns lint warnings for what was saved. */
  saveHooks(input: { scope: 'user' | 'project'; cwd?: string; hooks: HooksConfig }): ReturnType<typeof ext.saveHooks> {
    const lint = ext.saveHooks(this, input);
    this.audit(undefined, 'hooks.save', `${input.scope}${input.cwd ? ` ${input.cwd}` : ''}`);
    return lint;
  }
  importHooks(from: 'gemini' | 'codex', cwd?: string): HookImportResult {
    return ext.importHooks(from, cwd);
  }
  readScopeHooks(scope: 'user' | 'project', cwd?: string): HooksConfig {
    return ext.readScopeHooks(this, scope, cwd);
  }
  private recipeService?: HookRecipes;
  /** Hook recipes: list, test, install into a scope or another CLI on a device, remove. */
  hookRecipes(): HookRecipes {
    return (this.recipeService ??= new HookRecipes({
      hooksDir: this.config.paths.hooks,
      configPath: this.config.paths.config,
      readScope: (scope, cwd) => ext.readScopeHooks(this, scope, cwd),
      saveScope: (scope, cwd, hooks) => {
        this.saveHooks({ scope, cwd, hooks });
        this.bus.emit({ type: 'config.updated' });
      },
      machine: (id) => this.devices.get(id),
      store: this.repos.kv,
      trusted: (cwd) => this.trust.isTrusted(cwd),
    }));
  }
  builtinHooks(): BuiltinHookDto[] {
    return builtinHooksList(this);
  }
  setBuiltinHook(id: string, patch: { enabled?: unknown; budgetChars?: unknown }): BuiltinHookDto {
    return setBuiltin(this, id, patch);
  }
  projectTrust(cwd: string): ProjectTrustInfo {
    if (!cwd) throw new EngineError(400, 'cwd is required');
    return ext.trustInfo(this, cwd);
  }
  setProjectTrust(cwd: string, trusted: boolean): ProjectTrustInfo {
    if (!cwd || !cwd.startsWith('/')) throw new EngineError(400, 'cwd must be an absolute path');
    this.trust.set(cwd, trusted);
    this.audit(undefined, trusted ? 'trust.add' : 'trust.remove', cwd);
    return ext.trustInfo(this, cwd);
  }
  pluginDetail(name: string): PluginDetailDto | undefined {
    return ext.pluginDetail(this, name);
  }
  async updatePlugin(name: string): Promise<InstalledPlugin> {
    const p = await ext.updatePlugin(this, name);
    this.invalidateMcpTools();
    return p;
  }
  searchMarketplace(q: { q?: string; category?: string; marketplace?: string }): Promise<MarketplaceSearchResult> {
    return ext.searchMarketplace(this, q);
  }
  restartMcp(name: string): Promise<McpStatus> {
    return ext.restartMcp(this, name);
  }
  testMcp(name: string): Promise<McpTestResult> {
    return ext.testMcp(this, name);
  }
  mcpServerTools(name: string): Promise<McpToolDto[]> {
    return ext.mcpServerTools(this, name);
  }
  callMcpTool(name: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return ext.callMcpTool(this, name, tool, args);
  }
  addMcpServer(name: string, config: McpServerConfig): McpStatus {
    return ext.addMcpServer(this, name, config);
  }
  updateMcpServer(name: string, patch: { enabled?: boolean; config?: McpServerConfig }): McpStatus {
    return ext.updateMcpServer(this, name, patch);
  }
  removeMcpServer(name: string): boolean {
    return ext.removeMcpServer(this, name);
  }
  importMcp(from: McpImportFormat, text: string): Record<string, McpServerConfig> {
    return ext.importMcp(from, text);
  }
  mcpConnectPlan(name: string): McpConnectStepDto[] {
    const found = ext.mcpServerConfig(this, name);
    if (!found) throw new EngineError(404, `unknown mcp server ${name}`);
    return ext.mcpConnectPlanFor(name, found.config);
  }
  connectMcp(name: string, device: string, clis: CliName[]): Promise<McpConnectRunResult[]> {
    return ext.connectMcp(this, name, this.mcpConnectPlan(name), device, clis);
  }
  memoryConnectPlan(id: string, accountId?: string): McpConnectStepDto[] {
    const conn = this.memoryAdminFor(accountId).getConnection(id);
    // a member's connection never names one of the hub's MCP servers: their settings are the owner's
    if (isMember(accountId) && typeof conn.options?.server === 'string' && conn.options.server) throw new EngineError(400, `connection ${conn.id} has no server command or url`);
    return ext.mcpConnectPlanFor(...memoryServerFor(this, conn));
  }

  /** Tell the user once per session start when the folder's hooks or allow rules are off because it is not trusted. */
  warnUntrustedProject(session: Session): void {
    try {
      if (this.trust.isTrusted(session.cwd)) return;
      const t = ext.trustInfo(this, session.cwd);
      if (!t.hooks && !t.allow) return;
      const what = [t.hooks ? `${t.hooks} hook${t.hooks === 1 ? '' : 's'}` : '', t.allow ? `${t.allow} allow rule${t.allow === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
      this.notice(session.id, `This folder's settings have ${what} that stay off until you trust the folder (Extensions > Hooks, or POST /api/trust). Files: ${t.files.join(', ')}`, 'warning');
    } catch (err) {
      log.debug('trust check failed', err);
    }
  }

  /** The hook runner, for plan(), recent() and test runs. */
  get hookRunner(): Hooks | undefined {
    return this.deps.hooks;
  }
  get mcpManager(): McpManager | undefined {
    return this.deps.mcp;
  }

  /** Built-in tools plus opt-in tools (browser). */
  allTools(): Tool[] {
    return [...this.allBuiltinTools()];
  }

  /** Connect enabled MCP servers and list their tools. Concurrent calls share one refresh. */
  async mcpToolList(): Promise<Tool[]> {
    if (!this.deps.mcpTools) return [];
    if (!this.mcpRefresh) {
      this.mcpRefresh = this.deps
        .mcpTools()
        .then((tools) => {
          this.mcpCache = { tools, at: Date.now() };
          return tools;
        })
        .catch(() => this.mcpCache?.tools ?? [])
        .finally(() => {
          this.mcpRefresh = undefined;
        });
    }
    return this.mcpRefresh;
  }

  /** MCP tools from the last listing (may be empty before the first one). */
  cachedMcpTools(): Tool[] {
    return this.mcpCache?.tools ?? [];
  }

  invalidateMcpTools(): void {
    this.mcpCache = null;
  }

  /**
   * Make sure MCP tools are listed before a turn builds its tool set. Waits up
   * to a few seconds; slow servers keep connecting in the background and join
   * a later turn.
   */
  async prefetchMcpTools(maxWaitMs = MCP_PREFETCH_WAIT_MS): Promise<void> {
    if (!this.deps.mcpTools || !(this.deps.mcpStatus?.() ?? []).some((s) => s.status !== 'disabled')) return;
    if (this.mcpCache && Date.now() - this.mcpCache.at < MCP_TOOLS_TTL_MS) return;
    const refresh = this.mcpToolList();
    if (this.mcpCache) return; // stale but usable: refresh in the background
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refresh, new Promise((r) => (timer = setTimeout(r, maxWaitMs)))]);
    clearTimeout(timer);
  }

  // tasks ------------------------------------------------------------------
  listTasks(filter?: { status?: string; agent?: string; project?: string; accountId?: string }) {
    return this.repos.tasks.list(filter);
  }
  createTask(input: Parameters<EngineApi['createTask']>[0], accountId?: string) {
    const now = Date.now();
    const task = { id: newId('task'), accountId: accountId ?? currentAccount() ?? OWNER_ID, title: input.title, description: input.description ?? '', status: input.status ?? ('todo' as const), priority: input.priority ?? 1, agent: input.agent, project: input.project, due: input.due, labels: input.labels ?? [], createdAt: now, updatedAt: now, meta: input.meta };
    this.repos.tasks.upsert(task);
    this.bus.emit({ type: 'task.updated', task });
    return task;
  }
  updateTask(id: string, patch: Parameters<EngineApi['updateTask']>[1]) {
    const t = this.repos.tasks.get(id);
    if (!t) throw new EngineError(404, 'Task not found');
    // the id and the account are the row's, whatever the patch says
    const next = { ...t, ...patch, id: t.id, accountId: t.accountId, updatedAt: Date.now() };
    this.repos.tasks.upsert(next);
    this.bus.emit({ type: 'task.updated', task: next });
    return next;
  }
  deleteTask(id: string) {
    const t = this.repos.tasks.get(id);
    this.repos.tasks.delete(id);
    this.bus.emit({ type: 'task.deleted', taskId: id, accountId: t?.accountId ?? OWNER_ID });
  }
  async startTask(id: string, opts: { agent?: string; model?: string; device?: string; cwd?: string }) {
    const t = this.repos.tasks.get(id);
    if (!t) throw new EngineError(404, 'Task not found');
    // started from an app (POST /api/tasks/:id/start): a member's code session on the hub is refused up front
    const session = await this.createSession({ agent: opts.agent ?? t.agent, model: opts.model, device: opts.device, cwd: opts.cwd, title: t.title, taskId: id, prompt: `Task: ${t.title}\n\n${t.description}` }, t.accountId ?? OWNER_ID, { byPerson: true });
    this.updateTask(id, { status: 'doing' });
    return session;
  }

  // usage ------------------------------------------------------------------
  usageSummary(q: { from?: number; to?: number; tzOffset?: number; accountId?: string }): UsageSummary {
    return this.usage.summary(q);
  }
  usageRecent(limit: number, accountId?: string): UsageRecord[] {
    return this.usage.recent(limit, accountId);
  }
  limits() {
    return this.usage.limits();
  }
  async refreshLimits() {
    // the hub's limits come from the owner's machines: a member's CLI logs and plans are theirs
    const machines = this.devices.list(OWNER_ID).map((d) => this.devices.get(d.id)).filter((m): m is Machine => !!m);
    return this.usage.refreshLimits(machines.length ? machines : [this.deps.localMachine]);
  }
  recordUsage(record: Omit<UsageRecord, 'id' | 'ts' | 'costUsd'> & { costUsd?: number; ts?: number }): void {
    this.usage.record(record);
  }

  // devices and files ------------------------------------------------------
  async browse(device: string, path: string): Promise<FileEntryDto[]> {
    const machine = this.machineById(device);
    const entries = await machine.readdir(path);
    return entries.map((e) => ({ name: e.name, path: path.replace(/\/$/, '') + '/' + e.name, type: e.type, size: e.size }));
  }
  async readDeviceFile(device: string, path: string): Promise<{ content: string; truncated: boolean }> {
    const machine = this.machineById(device);
    const text = await machine.readText(path);
    return text.length > 200_000 ? { content: text.slice(0, 200_000), truncated: true } : { content: text, truncated: false };
  }

  /** Where a session may share files from (files/share.ts): its outputs folder on the hub, its folder, and the folders of the sessions it started. */
  shareRoots(session: Session): ShareRoot[] {
    // the hub's disk through the session's guard: a member gets a RefusedMachine (people/guard.ts)
    const hub = this.machineFor({ ...session, device: 'local' });
    const roots: ShareRoot[] = [{ device: 'local', dir: outputsDir(this.config.paths.home, session.id), machine: hub, outputs: true }];
    const add = (s: Session) => {
      // a chat, or a session in the hub user's home, has no folder of its own: its outputs folder stands in (never the whole home)
      if (usesOutputs(s)) {
        if (s.id !== session.id) roots.push({ device: 'local', dir: outputsDir(this.config.paths.home, s.id), machine: hub, outputs: true });
        return;
      }
      const device = s.device || 'local';
      const dir = device === 'local' && s.cwd ? expandHome(s.cwd) : s.cwd;
      if (dir && isAbsolute(dir)) roots.push({ device, dir, machine: this.machineFor(s) });
    };
    add(session);
    const walk = (id: string, depth: number) => {
      if (depth > 8) return;
      for (const child of this.repos.sessions.list({ parentId: id, limit: 1000 })) {
        add(child);
        walk(child.id, depth + 1);
      }
    };
    walk(session.id, 0);
    return roots;
  }

  /** The bytes of a file a ShareFile call in this session shared, checked again now (GET /api/sessions/:id/files/:toolUseId). */
  async sharedFile(sessionId: string, toolUseId: string): Promise<{ bytes: Uint8Array; name: string; mediaType: string; size: number }> {
    const s = this.requireSession(sessionId);
    const gone = () => new EngineError(404, `unknown session ${sessionId}`);
    let shareCall = false;
    let meta: SharedFileMeta | undefined;
    for (const m of this.repos.messages.list(sessionId)) {
      for (const b of m.content) {
        if (b.type === 'tool_use' && b.id === toolUseId) shareCall = b.name === 'ShareFile';
        if (b.type === 'tool_result' && b.toolUseId === toolUseId && !b.isError) meta = b.meta?.file as SharedFileMeta | undefined;
      }
    }
    if (!shareCall || !meta || typeof meta.path !== 'string' || typeof meta.device !== 'string') throw gone();
    const check = await checkShareable(meta.path, this.shareRoots(s).filter((r) => r.device === meta!.device), this.config.paths.home);
    if (!check.ok) throw check.code === 'missing' ? gone() : new EngineError(check.code === 'too_big' ? 413 : 403, check.message);
    const tooBig = () => new EngineError(413, 'That file is now over 30 MB.');
    let bytes: Uint8Array;
    if (check.file.device === 'local') {
      // read the file that was checked: no symlink swapped in, same dev and ino, one link, the cap on the handle
      if (check.machine !== this.deps.localMachine || !check.ident) throw gone();
      const fh = await fsOpen(check.file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
      if (!fh) throw gone();
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.dev !== check.ident.dev || st.ino !== check.ident.ino || st.nlink > 1) throw new EngineError(403, 'Refused: the file changed after it was checked.');
        if (st.size > SHARE_MAX_BYTES) throw tooBig();
        const buf = new Uint8Array(st.size + 1);
        let n = 0;
        while (n < buf.byteLength) {
          const { bytesRead } = await fh.read(buf, n, buf.byteLength - n, n);
          if (!bytesRead) break;
          n += bytesRead;
        }
        // one byte past the stat size means it grew while read
        if (n > st.size) throw tooBig();
        bytes = buf.subarray(0, n);
      } finally {
        await fh.close();
      }
    } else {
      try {
        bytes = await check.machine.readFile(check.file.path);
      } catch {
        throw gone();
      }
      if (bytes.byteLength > SHARE_MAX_BYTES) throw tooBig();
    }
    return { bytes, name: meta.name || check.file.name, mediaType: check.file.mediaType, size: bytes.byteLength };
  }
  // chat import: the import service (import/service.ts) owns the ledger, so a session is never imported twice
  async externalSessions(device: string): Promise<ExternalSessionInfo[]> {
    this.machineById(device);
    const { importOf } = await import('../import/registry');
    const svc = importOf(this);
    if (!svc) throw new EngineError(501, 'chat import is not available on this hub');
    return svc.legacyList(device);
  }
  async importSession(source: ExternalSessionInfo['source'], id: string, device: string): Promise<Session> {
    this.machineById(device);
    const { importOf } = await import('../import/registry');
    const svc = importOf(this);
    if (!svc) throw new EngineError(501, 'chat import is not available on this hub');
    try {
      return await svc.importOne(source, id, device);
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw typeof status === 'number' ? new EngineError(status, (err as Error).message) : err;
    }
  }

  audit(sessionId: string | undefined, action: string, detail: string): void {
    const session = sessionId ? this.repos.sessions.get(sessionId) : undefined;
    this.repos.audit.add({ sessionId, device: session?.device, actor: 'conclave', action, detail, accountId: session ? this.accountOf(session) : (currentAccount() ?? OWNER_ID) });
  }
  /** With accountId, only that account's entries; without, all of them (the owner's view). */
  listAudit(q: { sessionId?: string; limit?: number; accountId?: string }): AuditEntry[] {
    return this.repos.audit.list(q);
  }

  // backup and restore -------------------------------------------------------
  backup(opts: BackupOptions = {}): HubBackup {
    return createBackup({ config: this.config, repos: this.repos, version: this.version, hubName: () => this.devices.list().find((d) => d.id === 'local')?.name ?? this.info().name }, opts);
  }

  restore(backup: unknown, opts: RestoreOptions = {}): Promise<RestoreResult> {
    this.toolCache = null;
    return restoreBackup({ config: this.config, repos: this.repos, version: this.version, bus: this.bus, routines: this.routines, reload: () => this.reload() }, backup, opts);
  }

  async shutdown(): Promise<void> {
    // workflow runs first: they are marked interrupted and resume at the next boot
    await workflowsOf(this)?.shutdown().catch(() => {});
    alertsOf(this)?.stop();
    const ending = [...this.runners.entries()].filter(([, r]) => r.started).map(([id]) => this.repos.sessions.get(id)).filter((s): s is Session => !!s);
    // what waits stays stored and runs after the next boot
    for (const r of this.runners.values()) r.abort('shutdown');
    // SessionEnd hooks have a short default timeout (1.5 s) so they cannot hold up a stop
    await Promise.allSettled(ending.map((s) => this.runHook(s, 'SessionEnd', { reason: 'other' }, 'other')));
    this.scheduler.stop();
    await this.acp?.shutdown().catch(() => {});
    await this.deps.memoryConnections?.close().catch(() => {});
    await this.deps.mcp?.shutdown().catch(() => {});
    this.providers.dispose?.();
  }

  // -------------------------------------------------------------------------
  // Internal surface used by the runner, modes and tools
  // -------------------------------------------------------------------------

  runnerFor(id: string): SessionRunner {
    let r = this.runners.get(id);
    if (!r) {
      r = new SessionRunner(this, id);
      this.runners.set(id, r);
    }
    return r;
  }

  requireSession(id: string): Session {
    const s = this.repos.sessions.get(id);
    if (!s) throw new EngineError(404, `Session ${id} not found`);
    return s;
  }

  agentFor(session: Session): AgentDef {
    const acct = this.accountOf(session);
    return (
      this.agentNamed(session.agent, session.cwd, acct) ??
      (isMember(acct) ? this.extensions.agents().find((a) => SHARED_SOURCES.has(a.source)) : this.extensions.agents()[0]) ?? { name: session.agent, description: '', prompt: '', source: 'builtin' }
    );
  }

  /**
   * An agent by name as an account sees it. A member gets only the agents
   * that ship and plugin agents: the owner's own files (~/.claude, the hub's
   * agents folder) and project files read on the hub are not theirs.
   */
  agentNamed(name: string, cwd: string | undefined, accountId: string): AgentDef | undefined {
    if (!isMember(accountId)) return this.extensions.agent(name, cwd);
    const a = this.extensions.agent(name);
    if (a && SHARED_SOURCES.has(a.source)) return a;
    return this.extensions.agents().find((x) => x.name === name && SHARED_SOURCES.has(x.source));
  }

  /** The agents an account may pick from. */
  agentsFor(accountId: string, cwd?: string): AgentDef[] {
    const all = this.extensions.agents(isMember(accountId) ? undefined : cwd);
    return isMember(accountId) ? all.filter((a) => SHARED_SOURCES.has(a.source)) : all;
  }

  /** The session reads untrusted input: its own mark (webhook runs, subagents of one) or its agent's (session/untrusted.ts). */
  isUntrusted(session: Session): boolean {
    return isUntrusted(session, this.agentFor(session).untrusted);
  }

  /**
   * Memory for this session: profile, recall and extraction. Off when the
   * owner turned the memory switch off (chats and agent sessions alike), and
   * always off for an untrusted session.
   */
  usesMemory(session: Session): boolean {
    // a reference from a friend's hub is read like a past chat, never learned from
    return chatUsesMemory(session) && !this.isUntrusted(session) && friendShareOf(session)?.role !== 'reference';
  }

  subagents(session: Session): AgentDef[] {
    return this.agentsFor(this.accountOf(session), session.cwd).filter((a) => a.subagent);
  }

  /**
   * The machine a session's tools run on. Only device "local" is the hub: a
   * paired device that is offline gets an OfflineMachine whose calls fail, so
   * tools never run on the hub's disk by mistake (2.1 bug 1). The runner parks
   * such a turn before it starts (projects/service.ts).
   */
  machineFor(session: Session): Machine {
    const acct = this.accountOf(session);
    // a member never gets the hub, and nobody gets another account's device (people/guard.ts guards the call too)
    if (isMember(acct) && (!session.device || session.device === 'local')) return new RefusedMachine('local', HUB_REFUSED);
    if (session.device && session.device !== 'local' && this.repos.devices.accountOf(session.device) !== acct) return new RefusedMachine(session.device, DEVICE_REFUSED);
    const m = this.devices.get(session.device);
    if (m) return m;
    if (!session.device || session.device === 'local') return this.deps.localMachine;
    const d = this.devices.list().find((x) => x.id === session.device);
    return new OfflineMachine(session.device, d?.name ?? session.device, d?.info);
  }
  machineById(id: string): Machine {
    const m = this.devices.get(id);
    if (!m) throw new EngineError(404, `Device ${id} not available`);
    return m;
  }
  private homeCache = new Map<string, string>();
  async machineHome(machine: Machine): Promise<string | undefined> {
    if (this.homeCache.has(machine.id)) return this.homeCache.get(machine.id);
    try {
      const info = await machine.info();
      this.homeCache.set(machine.id, info.home);
      return info.home;
    } catch {
      return undefined;
    }
  }
  private async safeHome(machine: Machine): Promise<string> {
    return (await this.machineHome(machine)) ?? process.cwd();
  }

  // messages ---------------------------------------------------------------
  addMessage(sessionId: string, m: Partial<Message> & Pick<Message, 'role' | 'kind' | 'content'>): Message {
    const seq = this.repos.messages.nextSeq(sessionId);
    const msg: Message = { id: newId('msg'), sessionId, seq, createdAt: Date.now(), ...m };
    this.repos.messages.insert(msg);
    const s = this.repos.sessions.get(sessionId);
    if (s) this.repos.sessions.update({ ...s, stats: { ...s.stats, messages: s.stats.messages + 1 }, updatedAt: Date.now() });
    this.bus.emit({ type: 'message.created', message: msg });
    return msg;
  }
  updateMessage(id: string, patch: Partial<Message>): Message {
    const m = this.repos.messages.get(id);
    if (!m) throw new EngineError(404, 'Message not found');
    const next = { ...m, ...patch };
    this.repos.messages.update(next);
    this.bus.emit({ type: 'message.updated', message: next });
    return next;
  }
  removeMessage(id: string): void {
    const m = this.repos.messages.get(id);
    this.repos.messages.delete(id);
    // keep the session's message count true (a failed turn removes its empty reply)
    const s = m ? this.repos.sessions.get(m.sessionId) : undefined;
    if (s && s.stats.messages > 0) this.repos.sessions.update({ ...s, stats: { ...s.stats, messages: s.stats.messages - 1 } });
    // apps drop it too (a refused reply the refusal fallback replaced had streamed its text)
    if (m) this.bus.emit({ type: 'message.deleted', sessionId: m.sessionId, messageId: id });
  }

  setStatus(id: string, status: SessionStatus, error?: string): void {
    const s = this.repos.sessions.get(id);
    if (!s || (s.status === status && !error)) return;
    const next = { ...s, status, error: status === 'error' ? error : undefined, resumeAt: status === 'waiting_reset' ? s.resumeAt : undefined, updatedAt: Date.now(), meta: this.clock(s, status) };
    this.repos.sessions.update(next);
    this.bus.emit({ type: 'session.updated', session: next });
  }
  parkForReset(id: string, resumeAt: number): void {
    const s = this.repos.sessions.get(id);
    if (!s) return;
    const next = { ...s, status: 'waiting_reset' as SessionStatus, resumeAt, updatedAt: Date.now(), meta: this.clock(s, 'waiting_reset') };
    this.repos.sessions.update(next);
    this.bus.emit({ type: 'session.updated', session: next });
  }

  /** When each running session started running, for its working time (session/limit-tree.ts). */
  private runningSince = new Map<string, number>();

  /**
   * The working-time clock: it runs while a session is running and stops in
   * every other status (waiting for a reset, an approval or an answer, idle).
   * Returns the meta with meta.workMs grown by the run that just ended.
   */
  private clock(s: Session, status: SessionStatus): Session['meta'] {
    const now = Date.now();
    if (status === 'running') {
      this.runningSince.set(s.id, now);
      return s.meta;
    }
    const since = this.runningSince.get(s.id);
    if (since === undefined) return s.meta;
    this.runningSince.delete(s.id);
    return { ...s.meta, workMs: ((s.meta?.workMs as number | undefined) ?? 0) + (now - since) };
  }

  /** Milliseconds of the run in progress, 0 when the session is not running. */
  runningFor(id: string): number {
    const since = this.runningSince.get(id);
    return since === undefined ? 0 : Date.now() - since;
  }
  setPermissionMode(id: string, mode: PermissionMode): void {
    const s = this.repos.sessions.get(id);
    if (!s) return;
    this.repos.sessions.update({ ...s, permissionMode: mode, updatedAt: Date.now() });
    this.bus.emit({ type: 'session.updated', session: { ...s, permissionMode: mode } });
  }
  patchMeta(id: string, meta: Record<string, unknown>): void {
    const s = this.repos.sessions.get(id);
    if (!s) return;
    this.repos.sessions.update({ ...s, meta: { ...s.meta, ...meta }, updatedAt: Date.now() });
  }
  setExternalId(id: string, harness: string, extId: string): void {
    const s = this.repos.sessions.get(id);
    if (!s) return;
    this.repos.sessions.update({ ...s, external: { ...s.external, [harness]: extId }, updatedAt: Date.now() });
  }
  /** What plans saved on a session's calls, from its usage rows. */
  private sessionSaved(id: string): number {
    try {
      return this.usage.sessionSaved(id);
    } catch {
      return 0;
    }
  }
  addStats(id: string, usage: Partial<Usage>): void {
    const s = this.repos.sessions.get(id);
    if (!s) return;
    const stats = {
      ...s.stats,
      inputTokens: s.stats.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: s.stats.outputTokens + (usage.outputTokens ?? 0),
      cacheReadTokens: s.stats.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (s.stats.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      costUsd: s.stats.costUsd + (usage.costUsd ?? 0),
      // what the session's calls are worth at API prices: a session from before it starts from its bill and what its usage rows say plans saved (this call's row is in them)
      apiValueUsd:
        s.stats.apiValueUsd !== undefined || s.stats.inputTokens + s.stats.outputTokens + s.stats.cacheReadTokens === 0
          ? (s.stats.apiValueUsd ?? 0) + (usage.apiValueUsd ?? usage.costUsd ?? 0)
          : s.stats.costUsd + (usage.costUsd ?? 0) + this.sessionSaved(id),
    };
    this.repos.sessions.update({ ...s, stats, updatedAt: Date.now() });
    this.bus.emit({ type: 'session.updated', session: { ...s, stats } });
  }

  /** meta: more for apps to read on the notice message (a switch's type, models and summary size). Returns the notice's message in the session. */
  notice(sessionId: string | undefined, body: string, level: Notice['level'], title = 'Conclave', meta?: Record<string, unknown>): Message | undefined {
    const accountId = (sessionId ? this.sessionAccount(sessionId) : undefined) ?? currentAccount() ?? OWNER_ID;
    const notice: Notice = { id: newId('ntc'), accountId, title, body, level, sessionId, createdAt: Date.now() };
    const msg = sessionId ? this.addMessage(sessionId, { role: 'assistant', kind: 'notice', content: [{ type: 'text', text: body }], meta: { ...meta, level } }) : undefined;
    this.bus.emit({ type: 'notice', notice });
    return msg;
  }
  notifyEvent(kind: keyof ConclaveConfig['notifications']['on'], notice: Omit<Notice, 'id' | 'createdAt'>): void {
    // Notification hooks run whether or not a notification channel is on, like Claude Code's
    const session = notice.sessionId ? this.repos.sessions.get(notice.sessionId) : undefined;
    if (session) {
      const type = kind === 'approvalNeeded' ? 'permission_prompt' : kind === 'sessionDone' ? 'idle_prompt' : kind;
      void this.runHook(session, 'Notification', { message: notice.body, title: notice.title, notification_type: type }, type);
    }
    if (!this.config.get().notifications.on[kind]) return;
    // the notice goes to its account's apps and browsers only
    const accountId = notice.accountId ?? (session ? this.accountOf(session) : (currentAccount() ?? OWNER_ID));
    // a question blocks the session like an approval does, so it is never held
    void this.notifier.send({ ...notice, accountId }, { force: kind === 'approvalNeeded' || kind === 'errors' }).catch((err) => log.warn('notify failed', err));
  }

  setTodos(id: string, todos: Todo[]): void {
    this.runnerFor(id).todos = todos;
    this.bus.emit({ type: 'todo.updated', sessionId: id, todos });
  }
  getTodos(id: string): Todo[] {
    return this.runnerFor(id).todos;
  }

  afterTurn(id: string, _durationMs: number): void {
    const cfg = this.config.get();
    const s = this.repos.sessions.get(id);
    if (!s) return;
    if (cfg.memory.enabled && cfg.memory.autoExtract && this.agentFor(s).memory !== 'none' && s.mode !== 'jury' && this.usesMemory(s)) {
      void this.memoryFor(this.accountOf(s))
        .extract(id, this.repos.messages.list(id), { project: s.cwd, agent: s.agent })
        .catch((err) => log.debug('memory extract failed', err));
    }
    this.notifyEvent('sessionDone', { title: s.title, body: 'Session finished a turn', level: 'success', sessionId: id, link: `/s/${id}` });
    this.retitle(s);
  }

  /**
   * After a turn: a session still called New chat is named from its first
   * exchange; at turn TITLE_REVISE_TURN its title is revised once. Only a title
   * this hub wrote (meta.titleAuto) is revised, never one the owner gave.
   */
  private retitle(s: Session): void {
    const fresh = s.title === 'New chat';
    if (!fresh && (s.meta?.titleAuto !== s.title || s.meta?.titleRevised)) return;
    const turns = (Number(s.meta?.titleTurns) || 0) + 1;
    this.patchMeta(s.id, { titleTurns: turns });
    if (fresh ? turns <= TITLE_REVISE_TURN : turns >= TITLE_REVISE_TURN) void this.generateTitle(s.id, { afterTurn: true, revise: turns >= TITLE_REVISE_TURN });
  }

  /** At a turn start only headless runs are named; others wait for the first answer (afterTurn). */
  async generateTitle(id: string, opts: { afterTurn?: boolean; revise?: boolean } = {}): Promise<void> {
    const s = this.repos.sessions.get(id);
    if (!s) return;
    // the title this call may replace: New chat, or for a revision the hub's own title
    const was = s.title === 'New chat' ? s.title : opts.revise && s.meta?.titleAuto === s.title ? s.title : undefined;
    if (!was) return;
    try {
      const { completeText } = await import('../session/stream');
      const { TITLE_SYSTEM, cleanTitle, promptTitle, titleRequest } = await import('../session/prompt');
      const textOf = (m: Message) =>
        m.content
          .filter((b) => b.type === 'text' && !isReminder(b))
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim();
      const headless = !!s.routineId || s.tags.includes('cli-run') || s.tags.includes('routine');
      // nobody reads a headless run's title while it runs: name it after its prompt, without a model call
      if (headless) {
        const first = this.repos.messages.list(id, { limit: 3 }).find((m) => m.role === 'user');
        const t = first ? promptTitle(textOf(first)) : '';
        if (t) this.updateSession(id, { title: t });
        return;
      }
      if (!opts.afterTurn) return;
      const msgs = this.repos.messages.list(id);
      const users = msgs.filter((m) => m.role === 'user' && m.kind === 'normal').map(textOf).filter(Boolean);
      const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && textOf(m));
      if (!users[0]) return;
      const prompt = titleRequest(users[0], answer ? textOf(answer) : '', opts.revise ? users.slice(1).slice(-3) : [], was === 'New chat' ? undefined : was);
      // no stop sequence: the API rejects one that is only whitespace, and cleanTitle keeps the first line
      const ask = { system: TITLE_SYSTEM, prompt, maxTokens: 60, purpose: 'title', sessionId: id };
      let title = await completeText(this, ask).catch((err) => {
        log.debug('title generation failed', err);
        return '';
      });
      // the small model may have no working key on this hub; the session's own model does
      if (!title && s.model) title = await completeText(this, { ...ask, model: s.model }).catch(() => '');
      const clean = cleanTitle(title);
      // the owner may have renamed it while the model ran
      if (clean && this.repos.sessions.get(id)?.title === was) {
        if (clean !== was) this.updateSession(id, { title: clean });
        this.patchMeta(id, { titleAuto: clean });
      }
      if (opts.revise) this.patchMeta(id, { titleRevised: true });
    } catch (err) {
      log.debug('title generation failed', err);
    }
  }

  // tools and prompt -------------------------------------------------------
  private allBuiltinTools(): Tool[] {
    if (!this.toolCache || Date.now() - this.toolCache.at > 60_000) {
      this.toolCache = { tools: [...builtinTools(), ...(this.deps.optInTools ?? [])], at: Date.now() };
    }
    return this.toolCache.tools;
  }

  toolsFor(session: Session, agent: AgentDef, mode: string, depth: number): Tool[] {
    if (mode === 'chat') return [];
    // MCP tools come from the cache the runner fills with prefetchMcpTools() before each turn
    // servers the agent may use, less those turned off for this session (/mcp in a session)
    // the hub's MCP servers, the browser (Chromium on the hub) and learned skills are the owner's: a member's session gets none
    const member = this.isMemberSession(session);
    const mcp = member ? [] : this.cachedMcpTools().filter((t) => (!agent.mcpServers || agent.mcpServers.some((srv) => t.name.startsWith(`mcp__${srv}__`))) && sessionAllowsServerTool(session, t.name));
    const hubOnly = member ? new Set([...MEMBER_DENY, ...(this.deps.optInTools ?? []).map((t) => t.name)]) : undefined;
    const all = [...this.allBuiltinTools().filter((t) => !hubOnly?.has(t.name)), ...mcp];
    // a subagent started by an untrusted agent, and a webhook run, carry meta.untrusted (session/untrusted.ts)
    // a guarded fork of a friend's share keeps its tools and asks for each call (session/friend-share.ts)
    const untrusted = narrowsTools(session, agent.untrusted);
    const filtered = filterTools(all, {
      allow: agent.tools,
      deny: agent.disallowedTools,
      // opt-in tools the agent turns on without a tools list (the assistant's browser)
      optIn: agent.optInTools,
      untrusted,
      ...(untrusted ? { grants: routineOf(this, session)?.allow ?? [] } : {}),
      planMode: mode === 'plan',
      depth,
    });
    // the session's switches can take the web and memory tools away (a chat's both, an agent session's memory)
    let narrowed = filtered.filter((t) => sessionAllowsTool(session, t.name));
    // a read-only Delegate job keeps the caller's permission mode but gets no file-editing tools (engine/delegate.ts)
    if (isDelegated(session) && delegateMark(session)?.readOnly) narrowed = narrowed.filter((t) => !FILE_WRITE_TOOLS.includes(t.name));
    // Delegate is for primary sessions only: never a subagent, a workflow step, an untrusted or a member's session (engine/delegate.ts)
    if (narrowed.some((t) => t.name === 'Delegate') && delegateRefusal(this, session, depth, agent.untrusted)) narrowed = narrowed.filter((t) => t.name !== 'Delegate');
    // background task tools once the session has started a background subagent, appended so the list before them holds
    if (session.meta?.backgroundTasks && narrowed.some((t) => t.name === 'Task' || t.name === 'Delegate')) {
      narrowed = [...narrowed, ...filterTools(TASK_TOOLS, { deny: agent.disallowedTools, planMode: mode === 'plan' })];
    }
    // runner extensions add per-session tools (a workflow step's StructuredOutput) or take some away
    const listed = this.runnerExtensions.size ? this.runnerExtensions.toolList(session, narrowed, depth) : narrowed;
    return this.deferMcp(session, listed);
  }

  /** MCP tools each session has behind ToolSearch, as of its last toolsFor. */
  private deferred = new Map<string, Tool[]>();
  /** Promoted tool names per session, cached until the session gets a new message. */
  private promoted = new Map<string, { seq: number; names: string[] }>();

  /**
   * Past mcp.deferAbove MCP tools, a request carries the built-in tools,
   * ToolSearch and only the MCP tools a ToolSearch result in context named,
   * in the order they were loaded (HARNESS-REVIEW item 18).
   */
  private deferMcp(session: Session, tools: Tool[]): Tool[] {
    const mcp = tools.filter((t) => t.name.startsWith('mcp__'));
    const limit = this.config.get().mcp?.deferAbove ?? DEFAULT_DEFER_ABOVE;
    if (mcp.length <= limit) {
      this.deferred.delete(session.id);
      return tools;
    }
    const byName = new Map(mcp.map((t) => [t.name, t]));
    const loaded = this.promotedTools(session.id).map((n) => byName.get(n)).filter((t): t is Tool => !!t);
    const shown = new Set(loaded.map((t) => t.name));
    const rest = mcp.filter((t) => !shown.has(t.name));
    this.deferred.set(session.id, rest);
    // ToolSearch lists every MCP tool, so its description stays the same as tools load
    return [...tools.filter((t) => !t.name.startsWith('mcp__')), toolSearchFor(mcp) as Tool, ...loaded];
  }

  /** The session's MCP tools that are not in its tool list now (empty when nothing is deferred). */
  deferredToolsFor(sessionId: string): Tool[] {
    return this.deferred.get(sessionId) ?? [];
  }

  /** Tool names ToolSearch results in the session's active messages loaded, first loaded first. */
  private promotedTools(sessionId: string): string[] {
    const seq = this.repos.messages.nextSeq(sessionId);
    const hit = this.promoted.get(sessionId);
    if (hit?.seq === seq) return hit.names;
    const names: string[] = [];
    for (const m of activeMessages(this.repos.messages.list(sessionId))) {
      for (const b of m.content) {
        if (b.type !== 'tool_result' || !Array.isArray(b.meta?.promoted)) continue;
        for (const n of b.meta.promoted) if (typeof n === 'string' && !names.includes(n)) names.push(n);
      }
    }
    this.promoted.set(sessionId, { seq, names });
    return names;
  }

  /** Tools including MCP (async). The runner uses the sync toolsFor for speed; this is for listings. */
  async toolsWithMcp(session: Session, agent: AgentDef, mode: string, depth: number): Promise<Tool[]> {
    const base = this.toolsFor(session, agent, mode, depth);
    if (mode === 'chat' || !this.deps.mcpTools) return base;
    const mcp = await this.deps.mcpTools().catch(() => []);
    const allowed = mcp.filter((t) => (!agent.mcpServers || agent.mcpServers.some((srv) => t.name.startsWith(`mcp__${srv}`))) && sessionAllowsServerTool(session, t.name));
    // base went through the same rules in toolsFor; an untrusted session sees only the MCP tools its routine or agent names
    const untrusted = narrowsTools(session, agent.untrusted);
    const extra = filterTools(allowed, { planMode: mode === 'plan', untrusted, ...(untrusted ? { allow: agent.tools, grants: routineOf(this, session)?.allow ?? [] } : {}) }).filter((t) => sessionAllowsTool(session, t.name));
    const have = new Set(base.map((t) => t.name));
    return [...base, ...extra.filter((t) => !have.has(t.name))];
  }

  async systemPromptFor(session: Session, agent: AgentDef, modelRef: string, mode: Session['mode'], toolNames: string[], depth = 0) {
    return buildSystemPrompt(await this.systemPromptParts(session, agent, modelRef, mode, toolNames, depth));
  }

  /** The memory profile a session's system prompt shows. */
  profileFor(session: Session, agent: AgentDef): MemoryEntry[] {
    return this.config.get().memory.enabled && chatUsesMemory(session) && !isUntrusted(session, agent.untrusted)
      ? this.memoryFor(this.accountOf(session)).profile({ project: this.memoryProject(session), agent: agent.name })
      : [];
  }

  /**
   * What a system prompt is built from, read fresh: instruction files from
   * the device, the profile, skills. The runner keeps a snapshot of the built
   * prompt and calls this only to check it (session/runner.ts systemFor).
   */
  async systemPromptParts(session: Session, agent: AgentDef, modelRef: string, mode: Session['mode'], toolNames: string[], depth = 0): Promise<PromptParts> {
    const machine = this.machineFor(session);
    const cwd = machine.resolve(session.cwd, '');
    const [{ loadProjectInstructions }, info] = await Promise.all([import('../extensions/instructions'), machine.info().catch(() => undefined)]);
    const projectInstructions = await loadProjectInstructions(machine, cwd, this.config.get()).catch(() => []);
    const isGit = !!(await machine.stat(`${cwd}/.git`).catch(() => null));
    // read once per session and folder, so the system prompt (and its cache) stays the same through the session
    const testKey = `${session.id}\n${cwd}`;
    let testCommand = this.testCommands.get(testKey);
    if (!testCommand) {
      testCommand = toolNames.includes('Bash') ? detectTestCommand(machine, cwd).catch(() => undefined) : Promise.resolve(undefined);
      this.testCommands.set(testKey, testCommand);
    }
    // python3 without python, and what the verify gate checks at stop: once per session, folder and agent
    const factsKey = `${testKey}\n${agent.name}`;
    let workspace = this.workspaceFacts.get(factsKey);
    if (!workspace) {
      const gate = session.kind !== 'chat' && wantsVerifyGate(agent);
      workspace = toolNames.includes('Bash')
        ? testCommand.then((tc) => detectWorkspaceFacts(machine, cwd, { testCommand: tc, stopCheck: gate ? () => verifyCommandFor(this, session, []) : undefined })).catch(() => ({}))
        : Promise.resolve({});
      this.workspaceFacts.set(factsKey, workspace);
    }
    const profile = this.profileFor(session, agent);
    // what Conclave is and what this session can do now (platform/card.ts), off with agents.platformCard or the agent's switch
    const conclave = await platformBlocksFor(this, session, agent, toolNames, depth).catch((err) => {
      log.debug('platform card failed', err);
      return undefined;
    });
    // a member's session sees the skills that ship and plugin skills, not the owner's own
    const skills = this.isMemberSession(session) ? this.extensions.skills().filter((s) => SHARED_SOURCES.has(s.source)) : this.extensions.skills(session.cwd);
    return {
      session, agent, modelRef, mode, toolNames,
      platform: info?.platform ?? process.platform,
      hostname: info?.hostname,
      isGitRepo: isGit,
      deviceName: this.devices.list().find((d) => d.id === session.device)?.name ?? session.device,
      projectInstructions, profile, skills,
      testCommand: await testCommand,
      workspace: await workspace,
      subagents: this.subagents(session),
      date: new Date().toISOString().slice(0, 10),
      ...(conclave ? { conclave } : {}),
      // a session on the hub without a project folder saves the owner's files here (files/share.ts)
      ...(toolNames.includes('ShareFile') && (toolNames.includes('Write') || toolNames.includes('Bash')) && usesOutputs(session) ? { outputsDir: outputsDir(this.config.paths.home, session.id) } : {}),
    };
  }

  /**
   * Thinking for a request. A workflow agent() call's effort wins for its child
   * (workflows/agents.ts), then the session's effort switch (a chat's switches,
   * or chat.thinking on an agent session), then the agent's `thinking`. With
   * none of these, coding agents get medium on models that take an effort
   * level, as Claude Code sends; other models and agents get the provider default.
   * A model with Effort levels (ModelInfo.effort) gets the nearest one it has,
   * and Off where it can stop thinking (providers/effort.ts).
   */
  thinkingFor(agent: AgentDef, info: ModelInfo, session?: Session): ChatRequest['thinking'] {
    const step = (session?.meta?.workflow as { effort?: string } | undefined)?.effort as ThinkingEffort | undefined;
    const switched = session ? (chatSettings(session)?.thinking ?? session.chat?.thinking) : undefined;
    const wanted = step ?? switched ?? agent.thinking ?? (CODING_AGENTS.has(agent.name) && takesEffort(info.id) ? 'medium' : undefined);
    const level = info.effort ? clampEffort(wanted, info.effort) : wanted;
    if (!info.thinking || !level) return undefined;
    if (level === 'off') return info.effort?.off ? { off: true } : undefined;
    return { effort: level };
  }

  /**
   * The Cyber access program a turn sends (providers/access-programs.ts): the
   * one a Daybreak alias in its model ref stands for (the picker's Daybreak
   * row), else the session's choice. Only on a model that takes it
   * (ModelInfo.cyber); none else.
   */
  accessProgramsFor(info: ModelInfo, session?: Session): ChatRequest['accessPrograms'] {
    const asked = (session?.model ? retiredAlias(session.model)?.cyber : undefined) ?? session?.chat?.cyber;
    return asked && info.cyber?.includes(asked) ? { cyber: asked } : undefined;
  }

  /**
   * The Effort a harness turn asks for: the session's switch, else the agent's
   * own `thinking`. The harness keeps its own default otherwise, and gets the
   * nearest level it offers (acp/adapter.ts).
   */
  harnessEffortFor(session: Session): EffortSetting | undefined {
    return session.chat?.thinking ?? this.agentFor(session).thinking;
  }

  /** Levels each harness model offered, learned from its own Effort option (kept in kv). */
  private harnessLevels?: Record<string, Effort[]>;

  harnessEffort(ref: string): Effort[] | undefined {
    this.harnessLevels ??= this.repos.kv.get<Record<string, Effort[]>>(HARNESS_EFFORT_KEY, {});
    return this.harnessLevels[ref];
  }

  /**
   * A harness said which Effort levels it offers for a model: keep them, so the
   * model list (and so the session start and the /model sheet) offers the same.
   * Apps reload the model list on models.updated when they change.
   */
  noteHarnessEffort(ref: string, levels: Effort[]): void {
    const cur = this.harnessEffort(ref);
    if (cur && cur.length === levels.length && cur.every((l, i) => l === levels[i])) return;
    const next = { ...this.harnessLevels };
    if (levels.length) next[ref] = levels;
    else delete next[ref];
    this.harnessLevels = next;
    this.repos.kv.set(HARNESS_EFFORT_KEY, next);
    this.bus.emit({ type: 'models.updated' });
  }

  /** The models each harness's account offered, by harness id (kept in kv). */
  private harnessModelLists?: Record<string, { at: number; models: Array<{ id: string; name?: string }> }>;

  harnessModels(harness: string): Array<{ id: string; name?: string }> | undefined {
    this.harnessModelLists ??= this.repos.kv.get<Record<string, { at: number; models: Array<{ id: string; name?: string }> }>>(HARNESS_MODELS_KEY, {});
    return this.harnessModelLists[harness]?.models;
  }

  /**
   * A harness said which models its account offers (its ACP model option):
   * keep them, so the model list shows models no release knows yet, such as
   * a new Codex model. The configured list stays as the fallback.
   */
  noteHarnessModels(harness: string, models: Array<{ id: string; name?: string }>): void {
    const clean = models.filter((m) => m && typeof m.id === 'string' && m.id.trim()).map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
    if (!clean.length) return;
    const cur = this.harnessModels(harness);
    if (cur && cur.length === clean.length && cur.every((m, i) => m.id === clean[i].id && m.name === clean[i].name)) return;
    this.harnessModelLists = { ...this.harnessModelLists, [harness]: { at: Date.now(), models: clean } };
    this.repos.kv.set(HARNESS_MODELS_KEY, this.harnessModelLists);
    this.bus.emit({ type: 'models.updated' });
  }

  /** Readers of an account's own model list, run on Refresh models (the server adds CLIProxyAPI's). */
  private modelRefreshers = new Set<() => Promise<void>>();

  onRefreshModels(fn: () => Promise<void>): () => void {
    this.modelRefreshers.add(fn);
    return () => this.modelRefreshers.delete(fn);
  }

  /**
   * Refresh models: ask the accounts again for their model lists (CLIProxyAPI's
   * per-account lists, each harness that is on, through its ACP model option),
   * drop the cached listings, and return the new model list. What could not be
   * asked keeps its last list, then the built-in one. Says what failed.
   */
  async refreshModels(accountId?: string): Promise<{ groups: ModelGroup[]; failed: string[] }> {
    const failed: string[] = [];
    const cfg = this.config.get();
    const runs: Array<Promise<void>> = [...this.modelRefreshers].map((fn) => fn().catch((err) => void failed.push(`CLIProxyAPI: ${(err as Error)?.message ?? String(err)}`)));
    const acp = this.acp;
    if (acp?.listModels) {
      for (const [id, p] of Object.entries(cfg.providers)) {
        if (p.type !== 'acp' || p.enabled === false || !this.providers.isConfigured(id)) continue;
        runs.push(
          Promise.race([acp.listModels(id, this.deps.localMachine), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer within 60 seconds')), 60_000).unref?.())])
            .then((models) => this.noteHarnessModels(id, models))
            .catch((err) => void failed.push(`${this.providerLabel(id)}: ${oneLine((err as Error)?.message ?? String(err), 200)}`)),
        );
      }
    }
    await Promise.all(runs);
    this.providers.invalidate();
    this.bus.emit({ type: 'models.updated' });
    return { groups: await this.listModels(accountId), failed };
  }

  permissionRulesFor(session: Session) {
    return PermissionRulesFor(this, session);
  }

  toolHost(runner: SessionRunner) {
    return new EngineToolHost(this, runner);
  }

  async runHook(session: Session, event: HookEvent, extra: Partial<HookInput>, matcherValue?: string): Promise<HookOutcome> {
    // inside a subagent, hooks also get agent_id and agent_type (as in Claude Code)
    const sub = session.parentId && session.meta?.subagent ? { agent_id: session.id, agent_type: session.agent } : {};
    const input: HookInput = {
      session_id: session.id,
      cwd: session.cwd,
      hook_event_name: event,
      permission_mode: session.permissionMode,
      ...sub,
      conclave: { model: session.model, agent: session.agent, device: session.device },
      ...extra,
    };
    try {
      // hook commands run on the hub as its OS user: a member's session runs only the hub's in-process hooks
      if (this.isMemberSession(session)) return await this.deps.runHookCommands(event, input, matcherValue, undefined, { commands: false });
      return await this.deps.runHookCommands(event, input, matcherValue, this.agentHooks(session, event, input));
    } catch (err) {
      log.warn(`hook ${event} failed`, err);
      return { blocked: false, additionalContext: [], systemMessages: [] };
    }
  }

  /**
   * Hooks of the agent profiles involved in an event (4.2 item 3): the
   * session's own agent, and on SubagentStart and SubagentStop (which fire
   * with the parent session) the child's agent, whose Stop hooks run there.
   */
  private agentHooks(session: Session, event: HookEvent, input: HookInput): HooksConfig | undefined {
    try {
      const opts = {
        hooksDir: this.config.paths.hooks,
        cwd: session.cwd,
        trusted: (cwd: string) => this.trust.isTrusted(cwd),
        pluginHooksOn: (name: string) => this.extensions.plugins().find((p) => p.name === name)?.hooksEnabled !== false,
      };
      const own = agentHookConfig(this.extensions.agent(session.agent, session.cwd), event, false, opts);
      const childEvent = (event === 'SubagentStart' || event === 'SubagentStop') && input.agent_type && input.agent_id !== session.id;
      if (!childEvent) return own;
      const child = agentHookConfig(this.extensions.agent(input.agent_type!, session.cwd), event, true, opts);
      if (!own) return child;
      if (!child) return own;
      return { [event]: [...(own[event] ?? []), ...(child[event] ?? [])] };
    } catch (err) {
      log.warn('agent hooks failed', err);
      return undefined;
    }
  }

  // providers helpers ------------------------------------------------------
  /** A model the account can call now (the owner's when left out). */
  isUsable(ref: string, accountId?: string): boolean {
    if (isHiddenModel(this.config.get(), ref)) return false;
    try {
      const reg = this.providersFor(accountId);
      const r = reg.resolve(ref);
      // a harness counts once it is on (off by default, acp/harness-off.ts)
      return r.acp ? !!this.acp && reg.isEnabled(r.provider) : reg.isConfigured(r.provider);
    } catch {
      return false;
    }
  }
  isUsableRef(ref: string): boolean {
    if (this.isAgentRef(ref)) return !!this.extensions.agent(ref.slice(1));
    return this.isUsable(ref);
  }
  isAgentRef(ref: string): boolean {
    return ref.startsWith('@');
  }
  firstUsableModel(accountId?: string): string | undefined {
    const reg = this.providersFor(accountId);
    for (const id of Object.keys(this.config.get().providers)) {
      if (this.config.get().providers[id].type === 'acp') continue;
      if (reg.isConfigured(id)) {
        const models = this.config.get().providers[id].models;
        if (models?.length) return `${id}/${models[0]}`;
      }
    }
    return undefined;
  }
  displayModel(ref: string): string {
    if (this.isAgentRef(ref)) return ref;
    try {
      const r = this.providers.resolve(ref);
      return `${r.provider}/${r.model}`;
    } catch {
      return ref;
    }
  }
  providerLabel(id: string): string {
    return this.config.get().providers[id]?.name ?? id;
  }

  // attachments ------------------------------------------------------------
  async attachmentBlock(session: Session, a: Attachment): Promise<ContentBlock | undefined> {
    let data = a.data;
    if (!data && a.path) {
      try {
        const bytes = await this.machineFor(session).readFile(a.path);
        data = Buffer.from(bytes).toString('base64');
      } catch {
        return undefined;
      }
    }
    if (!data) return undefined;
    // a client that gave no type (or octet-stream): the name says what it is
    const mediaType = mediaTypeFor(a.mediaType, a.name ?? a.path);
    if (mediaType.startsWith('image/')) return { type: 'image', mediaType, data } as ImageBlock;
    return { type: 'document', mediaType, data, title: a.name };
  }

  // harness helpers --------------------------------------------------------
  async harnessEnv(session: Session, harness: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const cfg = this.config.get().providers[harness];
    // a member's harness runs on their own device: ${secret:...} is theirs and ${env:...} is nothing, never the hub's (docs/design/ACCOUNTS.md 2)
    const acct = this.accountOf(session);
    const expander = isMember(acct) ? accountConfigView(this.config, { accountId: acct, kv: this.repos.kv, secrets: this.accountSecrets }) : this.config;
    if (cfg?.env) Object.assign(env, expander.expandRecord(cfg.env));
    return env;
  }
  mcpServersForHarness(session: Session) {
    const agent = this.agentFor(session);
    const all = this.config.get().mcpServers;
    const out: typeof all = {};
    // the hub's MCP servers are the owner's: a member's harness gets none, with their commands, addresses and keys
    if (this.isMemberSession(session)) return out;
    for (const [name, s] of Object.entries(all)) {
      if (s.enabled === false) continue;
      if (agent.mcpServers && !agent.mcpServers.includes(name)) continue;
      if (mcpOff(session).includes(name)) continue;
      out[name] = s;
    }
    return out;
  }

  // subagent + review wiring ----------------------------------------------
  async runSubagent(opts: Parameters<import('../tools/types').ToolHost['runSubagent']>[0]): Promise<{ sessionId: string; text: string; structured?: unknown; error?: string }> {
    // Task with a schema: the child returns a validated object through StructuredOutput
    if (opts.schema !== undefined) {
      const { runStructuredTask } = await import('./structured-task');
      return runStructuredTask(this, { ...opts, schema: opts.schema });
    }
    const { runSubagent } = await import('./subagent');
    return runSubagent(this, opts);
  }
  async runReviewAgent(session: Session, agentName: string, target: Message, instructions: string | undefined, diff: string, signal: AbortSignal): Promise<void> {
    const { runReviewAgent } = await import('./subagent');
    return runReviewAgent(this, session, agentName, target, instructions, diff, signal);
  }

  // config-derived helpers for server
  async createRoutineFromChat(input: { name: string; schedule: string; prompt: string; agent?: string; cwd?: string; device?: string }, accountId?: string) {
    const r = this.routines.create({ ...input }, accountId ?? currentAccount() ?? OWNER_ID);
    return { id: r.id, nextRunAt: r.nextRunAt };
  }

  get localMachine(): Machine {
    return this.deps.localMachine;
  }
  get optInToolList(): Tool[] {
    return this.deps.optInTools ?? [];
  }
}

/** The MCP server behind a memory connection, as a name and config other CLIs can use. */
function memoryServerFor(engine: Engine, conn: ReturnType<MemoryAdminApi['getConnection']>): [string, McpServerConfig] {
  if (conn.type !== 'basic-memory' && conn.type !== 'mcp') {
    throw new EngineError(400, `${conn.name} (${conn.type}) is not an MCP server, so other CLIs cannot add it directly. Share Conclave's own MCP endpoint instead (GET /api/mcp-server/snippets).`);
  }
  const o = conn.options ?? {};
  const ref = typeof o.server === 'string' && o.server ? o.server : undefined;
  if (ref) {
    const cfg = engine.config.get().mcpServers[ref];
    if (!cfg) throw new EngineError(400, `connection ${conn.id} points at mcpServers.${ref}, which does not exist`);
    return [ref, cfg];
  }
  const str = (k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : undefined);
  const rec = (k: string) => (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? (o[k] as Record<string, string>) : undefined);
  const command = str('command');
  const url = str('url');
  let cfg: McpServerConfig | undefined;
  if (command) cfg = { type: 'stdio', command, args: Array.isArray(o.args) ? (o.args as unknown[]).map(String) : [], env: rec('env') };
  else if (url) cfg = { type: str('transport') === 'sse' ? 'sse' : 'http', url, headers: rec('headers') };
  else {
    // the default servers keep options.env, so other CLIs share the same file (MEMORY_FILE_PATH, BASIC_MEMORY_HOME)
    const env = Object.fromEntries(Object.entries(rec('env') ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''));
    const withEnv = Object.keys(env).length ? { env } : {};
    if (conn.type === 'basic-memory') cfg = { type: 'stdio', command: 'uvx', args: ['basic-memory', 'mcp'], ...withEnv };
    else if (str('preset') !== 'custom') cfg = { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], ...withEnv };
  }
  if (!cfg) throw new EngineError(400, `connection ${conn.id} has no server command or url`);
  return [conn.id, cfg];
}
