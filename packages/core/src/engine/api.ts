/**
 * The in-process API the server (and the standalone TUI) call. Each method
 * maps 1:1 to a route in client/index.ts. Keep the two in sync.
 */
import type {
  ApprovalRequest,
  ApprovalResponse,
  AuditEntry,
  Checkpoint,
  Device,
  LimitState,
  Message,
  QuestionRequest,
  QueuedMessage,
  Session,
  Task,
  Todo,
  UsageRecord,
} from '../types';
import type {
  AgentDefaultInfo,
  BackupOptions,
  CliName,
  ComponentKindDto,
  CreateSessionInput,
  ExtensionSourceInfo,
  ExtensionsOverview,
  ExternalSessionInfo,
  FileEntryDto,
  BuiltinHookDto,
  HookImportResult,
  HookLintIssue,
  HookTestInput,
  HookTestResult,
  HooksOverview,
  HubBackup,
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
  RestoreOptions,
  RestoreResult,
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
import type { HooksConfig, McpServerConfig } from '../config/schema';
import type { HookRecipes } from '../extensions/recipes';
import type { InstalledPlugin } from '../extensions/types';
import type { MemoryConnectionService } from '../memory/connections/service';
import type { SessionFilter } from '../storage/repos';
import type { EventBus } from '../util/bus';
import type { ConfigStore } from '../config';
import type { Repos } from '../storage/repos';
import type { ExtensionRegistry } from '../extensions/types';
import type { MemoryService } from '../memory/types';
import type { RoutineService, Scheduler } from '../scheduler/types';
import type { Notifier } from '../notify/types';
import type { Machine } from '../machine/types';

/**
 * Memory connections, file import and export (memory/connections/service.ts).
 * Machines for import and export come from DeviceHub.get(device ?? 'local').
 */
export type MemoryAdminApi = Pick<
  MemoryConnectionService,
  | 'presets'
  | 'listConnections'
  | 'getConnection'
  | 'addConnection'
  | 'updateConnection'
  | 'removeConnection'
  | 'testConnection'
  | 'syncConnection'
  | 'clearImported'
  | 'importFromFiles'
  | 'exportMarkdown'
  | 'exportMarkdownTo'
  | 'groupNotes'
  | 'graph'
>;

/** Device registry: the hub machine plus connected daemons. Implemented in machine/registry.ts. */
export interface DeviceHub {
  /** "local" always exists. */
  get(id: string): Machine | undefined;
  /** With an account, the hub and that account's devices only (docs/design/ACCOUNTS.md). */
  list(accountId?: string): Device[];
  /** Called by the server when a daemon connects/disconnects. */
  attach(device: Device, machine: Machine): void;
  detach(deviceId: string): void;
  isOnline(id: string): boolean;
  /** The owner's name for the hub's own device ("local"), kept in the database. Returns the hub device. */
  renameHub(name: string): Device;
}

export interface EngineApi {
  readonly bus: EventBus;
  readonly config: ConfigStore;
  readonly repos: Repos;
  readonly extensions: ExtensionRegistry;
  readonly memory: MemoryService;
  readonly routines: RoutineService;
  readonly scheduler: Scheduler;
  readonly notifier: Notifier;
  readonly devices: DeviceHub;
  readonly startedAt: number;
  readonly version: string;
  readonly memoryAdmin: MemoryAdminApi;

  // ----- accounts (docs/design/ACCOUNTS.md) -----
  /** The hub's accounts: the owner and members. */
  readonly people: import('../people/store').PeopleStore;
  /** Members' own keys (the owner's are the hub's). */
  readonly accountSecrets: import('../people/secrets').AccountSecrets;
  /** Whose key pays for a call; budgets on the hub's keys. */
  readonly access: import('../people/access').ProviderAccess;
  /** The account a session belongs to; undefined for an unknown session. */
  sessionAccount(id: string): string | undefined;
  /** An account's memory (the owner's is `memory`). */
  memoryFor(accountId: string | undefined): import('../memory/store').SqliteMemory;
  /** An account's memory connections, import and export (the owner's is `memoryAdmin`). */
  memoryAdminFor(accountId: string | undefined): MemoryAdminApi;
  /** The provider registry an account's calls use. */
  providersFor(accountId: string | undefined): import('../providers/registry').ProviderRegistry;
  /** A model the account can call now. */
  isUsable(ref: string, accountId?: string): boolean;
  /** A member's own fallback lists from PATCH /api/me, cleaned; throws PeopleError 400 for a model they cannot call (session/member-fallbacks.ts). */
  checkMemberFallbacks(
    accountId: string,
    patch: { usageFallback?: unknown; refusalFallback?: unknown },
  ): { usageFallback?: import('../config/schema').LimitFallbackConfig | null; refusalFallback?: import('../config/schema').RefusalFallbackConfig | null };
  /** The agents an account may pick: a member's are the ones that ship and plugin agents. */
  agentsFor(accountId: string, cwd?: string): import('../extensions/types').AgentDef[];
  /** The skills an account sees: a member's are the shared ones and their own (<home>/accounts/<id>/skills, learned-skills). */
  skillsFor(accountId: string, cwd?: string): import('../extensions/types').SkillDef[];
  /** The slash commands an account sees. */
  commandsFor(accountId: string, cwd?: string): import('../extensions/types').CommandDef[];
  /** The learned skills store an account writes: a member's lives under <home>/accounts/<id>/learned-skills. */
  learnedSkillsFor(accountId: string): import('../extensions/learned').LearnedSkills;
  /** Why a member's write of `more` bytes on the hub is refused (disk cap), or undefined. */
  diskRefusal(accountId: string | undefined, more?: number): string | undefined;
  diskUse(accountId: string): { usedBytes: number; limitBytes: number };
  /** The account an open approval or question belongs to. */
  pendingAccount(id: string): string | undefined;
  /** Stop a removed member's work and forget their stores. */
  forgetAccount(accountId: string): Promise<void>;

  info(): HubInfo;

  // sessions
  listSessions(filter: SessionFilter): Session[];
  getSession(id: string): Session | undefined;
  /** accountId: whose session; never taken from the request body. byPerson: started from an app, so a member's code session on the hub is refused up front. */
  createSession(input: CreateSessionInput, accountId?: string, opts?: { byPerson?: boolean }): Promise<Session>;
  /** The account's one assistant thread (meta.home), made the first time; two calls at once get the same one. */
  assistantHome(accountId: string): Promise<Session>;
  updateSession(id: string, patch: SessionPatch): Session;
  deleteSession(id: string): Promise<void>;
  forkSession(id: string, fromSeq?: number): Session;
  /** Delegated work to the main list: the subagent and delegated marks go, parentId stays, meta.delegate becomes meta.movedFrom. */
  moveToMainList(id: string): Session;
  /** The owner opened it: meta.seenAt now, so it no longer reads unread (session/unread.ts). updatedAt stays. */
  markSeen(id: string): Session;
  getMessages(id: string, afterSeq?: number): Message[];
  send(id: string, input: SendInput): Promise<SendResult>;
  /** Messages waiting while the session is busy, in the order they will run. Stored: a hub restart keeps them, Stop holds them (held). */
  queue(id: string): QueuedMessage[];
  /** Send a message Stop held: it runs in its place in the queue. 404 when it is not there. */
  sendQueued(id: string, pendingId: string): void;
  /** /btw: a side question answered from the transcript's tail, with no tools; nothing joins the transcript or the queue. */
  btw(id: string, text: string): Promise<{ answer: string }>;
  /** Take a waiting message off before it runs: 409 once its turn started, 404 when it is not there. */
  unqueue(id: string, pendingId: string): void;
  /** Work an update's restart would cut, on one device or anywhere (engine.ts). waiting_reset sessions do not count. */
  busyWork(device?: string): import('../client/updates').BusyWorkDto[];
  /** busyWork() is empty. */
  isIdle(device?: string): boolean;
  /** Tell the owner, if that kind of event notifies (config notifications.on). */
  notifyEvent(kind: keyof import('../config/schema').ConclaveConfig['notifications']['on'], notice: Omit<import('../types').Notice, 'id' | 'createdAt'>): void;
  abort(id: string): void;
  pauseSession(id: string): Session;
  resumeSession(id: string): Promise<Session>;
  rewind(id: string, seq: number, restoreFiles?: boolean): Promise<Session>;
  secondOpinion(id: string, input: SecondOpinionInput): Promise<void>;
  /** Switch the session's model; brief asks for a short handover (modes/handoff.ts). */
  handoff(id: string, model: string, opts?: { brief?: boolean }): Promise<Session>;
  /** "Try the next model" on a refused reply (session/refusal-fallback.ts). */
  tryNextModel(id: string, messageId?: string): Promise<{ model: string; label: string }>;
  retryProvider(id: string, messageId: string, model: string): Promise<{ model: string; label: string }>;
  /** What a switch would cost, against staying (modes/switch-cost.ts). */
  switchEstimate(id: string, model: string): import('../client').SwitchEstimate;
  compact(id: string, instructions?: string): Promise<boolean>;
  /** What fills the session's context now (/context). */
  contextUsage(id: string): Promise<import('../client').ContextUsageDto>;
  command(id: string, line: string): Promise<{ output?: string }>;
  todos(id: string): Todo[];
  checkpoints(id: string): Checkpoint[];
  restoreCheckpoint(id: string, checkpointId: string): Promise<void>;
  diff(id: string): Promise<{ diff: string; files: string[] }>;
  /** Sanitized by default (session/share.ts); raw is the stored rows, for owner backups. */
  exportSession(id: string, format: 'md' | 'json', opts?: import('../client/share').ShareOptions & { raw?: boolean }): import('../session/share').ExportResult;
  /** One account's messages (the owner's when left out). */
  search(q: string, accountId?: string): Array<{ sessionId: string; messageId: string; snippet: string; title: string }>;
  /** Past chats and sessions with filters, summaries and snippets (session/search.ts). */
  searchPast(q: import('../session/search').PastSessionQuery): import('../session/search').PastSessionHit[];

  // approvals
  /** With an account, only its sessions' approvals. */
  pendingApprovals(accountId?: string): ApprovalRequest[];
  resolveApproval(id: string, response: ApprovalResponse): boolean;
  pendingQuestions(accountId?: string): QuestionRequest[];
  answerQuestion(id: string, answers: Record<string, string>): boolean;

  // registry
  /** For pickers and Settings: an account's providers, with models the order reaches twice marked (providers/merge.ts). */
  listModels(accountId?: string): Promise<ModelGroup[]>;
  /** Refresh models: ask the accounts and harnesses for their model lists again, then the new list and what could not be asked. */
  refreshModels(accountId?: string): Promise<{ groups: ModelGroup[]; failed: string[] }>;
  /** Add a reader that Refresh models runs (the server's CLIProxyAPI). Returns the unhook. */
  onRefreshModels?(fn: () => Promise<void>): () => void;
  testProvider(id: string): Promise<{ ok: boolean; detail: string; latencyMs?: number }>;
  listTools(): ToolInfo[];
  mcpStatus(): McpStatus[];
  reload(): Promise<void>;
  syncToClis(device?: string, opts?: Omit<SyncClisOptions, 'device'>): Promise<string[]>;

  // agent defaults
  agentDefault(name: string): AgentDefaultInfo | undefined;

  // extensions area (docs/extensions/IA.md)
  extensionsOverview(cwd?: string, device?: string): Promise<ExtensionsOverview>;
  extensionsInventory(cwd?: string, kind?: ComponentKindDto): InventoryItemDto[];
  extensionSources(cwd?: string): ExtensionSourceInfo[];
  toolsDetail(q: { cwd?: string; agent?: string }): Promise<ToolDetail[]>;
  checkTool(input: ToolCheckInput): Promise<ToolCheckResult>;
  hooksOverview(cwd?: string): HooksOverview;
  testHook(input: HookTestInput): Promise<HookTestResult>;
  /** Returns lint warnings for what was saved (flat entries are wrapped before the save). */
  saveHooks(input: { scope: 'user' | 'project'; cwd?: string; hooks: HooksConfig }): HookLintIssue[];
  importHooks(from: 'gemini' | 'codex', cwd?: string): HookImportResult;
  /** One scope's hooks as stored. */
  readScopeHooks(scope: 'user' | 'project', cwd?: string): HooksConfig;
  /** Hook recipes: list, test, install, remove (ECOSYSTEM.md 4.2). */
  hookRecipes(): HookRecipes;
  builtinHooks(): BuiltinHookDto[];
  setBuiltinHook(id: string, patch: { enabled?: unknown; budgetChars?: unknown }): BuiltinHookDto;
  projectTrust(cwd: string): ProjectTrustInfo;
  setProjectTrust(cwd: string, trusted: boolean): ProjectTrustInfo;
  pluginDetail(name: string): PluginDetailDto | undefined;
  updatePlugin(name: string): Promise<InstalledPlugin>;
  searchMarketplace(q: { q?: string; category?: string; marketplace?: string }): Promise<MarketplaceSearchResult>;
  restartMcp(name: string): Promise<McpStatus>;
  testMcp(name: string): Promise<McpTestResult>;
  mcpServerTools(name: string): Promise<McpToolDto[]>;
  callMcpTool(name: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  addMcpServer(name: string, config: McpServerConfig): McpStatus;
  updateMcpServer(name: string, patch: { enabled?: boolean; config?: McpServerConfig }): McpStatus;
  removeMcpServer(name: string): boolean;
  /** OAuth for servers with auth "oauth" (extensions/mcp-oauth.ts). */
  startMcpOAuth(name: string, redirectUrl: string): Promise<{ authorizeUrl: string }>;
  finishMcpOAuth(input: { state: string; code?: string; error?: string }): Promise<McpStatus>;
  disconnectMcpOAuth(name: string): Promise<McpStatus>;
  importMcp(from: McpImportFormat, text: string): Record<string, McpServerConfig>;
  mcpConnectPlan(name: string): McpConnectStepDto[];
  connectMcp(name: string, device: string, clis: CliName[]): Promise<McpConnectRunResult[]>;
  /** Steps to add an MCP-based memory connection's server to the other CLIs. */
  memoryConnectPlan(id: string, accountId?: string): McpConnectStepDto[];

  // tasks
  listTasks(filter?: { status?: string; agent?: string; project?: string; accountId?: string }): Task[];
  createTask(input: Partial<Task> & { title: string }, accountId?: string): Task;
  updateTask(id: string, patch: Partial<Task>): Task;
  deleteTask(id: string): void;
  startTask(id: string, opts: { agent?: string; model?: string; device?: string; cwd?: string }): Promise<Session>;

  // usage
  usageSummary(q: { from?: number; to?: number; tzOffset?: number; accountId?: string }): UsageSummary;
  usageRecent(limit: number, accountId?: string): UsageRecord[];
  limits(): LimitState[];
  refreshLimits(): Promise<LimitState[]>;

  // devices and files
  browse(device: string, path: string): Promise<FileEntryDto[]>;
  readDeviceFile(device: string, path: string): Promise<{ content: string; truncated: boolean }>;
  /** A file a ShareFile call in the session shared, checked again (files/share.ts); 404 when there is none. */
  sharedFile(sessionId: string, toolUseId: string): Promise<{ bytes: Uint8Array; name: string; mediaType: string; size: number }>;
  externalSessions(device: string): Promise<ExternalSessionInfo[]>;
  importSession(source: ExternalSessionInfo['source'], id: string, device: string): Promise<Session>;

  listAudit(q: { sessionId?: string; limit?: number; accountId?: string }): AuditEntry[];

  // backup and restore (engine/backup.ts)
  backup(opts?: BackupOptions): HubBackup;
  /** Validates the document; throws EngineError 400 with a reason when it is not a backup. */
  restore(backup: unknown, opts?: RestoreOptions): Promise<RestoreResult>;

  shutdown(): Promise<void>;
}
