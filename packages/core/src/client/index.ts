/**
 * Typed HTTP + WebSocket client for the Conclave hub.
 *
 * This file IS the API contract: every route here is implemented by
 * packages/server. The web app, desktop app and TUI use this client directly;
 * the Android app mirrors it in Kotlin. Only type imports are allowed here so
 * it runs in browsers, Bun and Node.
 */
import type {
  ApprovalRequest,
  AttachmentReceipt,
  ApprovalResponse,
  AuditEntry,
  ChatSettings,
  Checkpoint,
  Device,
  EngineEventEnvelope,
  LimitState,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemoryScope,
  Message,
  ModeConfig,
  PermissionMode,
  QuestionRequest,
  QueuedMessage,
  RemoteMode,
  RemoteStatus,
  Routine,
  RoutineRun,
  Session,
  SessionKind,
  SessionMode,
  Task,
  TaskStatus,
  Todo,
  UsageRecord,
} from '../types';
import type { ModelInfo } from '../providers/types';
import type { AgentDef, CommandDef, InstalledPlugin, MarketplaceEntry, SkillDef } from '../extensions/types';
import type { RoutineInput } from '../scheduler/types';
import type { AssistantSettingsDto, DayPlan, GoalArea, GoalDetail, GoalEntry, GoalInput, GoalPatch, GoalStatus, GoalSummary, Goal, PrefsPatch, ReflectDto, ReflectNowDto, ReflectPatch, TodayDto } from './assistant';
import type { AddSuggestionRequest, AddSuggestionResult, RoutineSuggestionsDto } from '../scheduler/suggest';
import type { ConclaveConfig, HookEvent, HooksConfig, McpServerConfig } from '../config/schema';
// ----- catalog (Discover) DTOs: block "catalog", docs/design/ECOSYSTEM.md 2.1 -----
import type {
  CatalogDetail,
  CatalogInstallRequest,
  CatalogInstallResult,
  CatalogPage,
  CatalogPreviewRequest,
  CatalogQuery,
  CatalogSearchQuery,
  CatalogSearchResult,
  CatalogSetupRequest,
  CatalogSetupResult,
  CatalogStatus,
  InstallPreview,
  InstalledCatalogItem,
  TaskImportRequest,
  TaskImportResult,
  UpdatePreview,
} from '../catalog/types';
export type * from '../catalog/types';
export type { AddSuggestionRequest, AddSuggestionResult, RoutineSuggestionDto, RoutineSuggestionsDto } from '../scheduler/suggest';
export type * from './assistant';
import type { LeaveByDto, MapsSettingsDto, MapsSettingsPatch, MapsTestResult } from './maps';
export type * from './maps';
import type { WebSearchSettingsDto, WebSearchSettingsPatch, WebSearchTestResult } from './websearch';
export type * from './websearch';
export { SEARCH_PROVIDERS } from './websearch';
// ----- accounts: several people on one hub, docs/design/ACCOUNTS.md -----
import type { AccountRef, InviteDto, InviteInfo, MeDto, MePatch, PersonCreated, PersonDto, PersonInput, PersonPatch, WorkspaceCode } from './people';
export type * from './people';
export { DISPLAY_NAME_MAX, OWNER_DEFAULT_NAME, displayNameProblem, shownName, tidyDisplayName } from './people';
export type * from './pim';
import type { CaldavPreset, MailSecurity, OAuthClientKind, OAuthFlowDto, PimAccountDto, PimSettingsDto, PimWants, ProposalDto, ProposalStatus } from './pim';
import type {
  BrowserCookieImportResult,
  BrowserInputEvent,
  BrowserLoginInput,
  BrowserProfileUpdate,
  BrowserProxyUpdate,
  BrowserProxyTestDto,
  BrowserLibsResult,
  BrowserSetupResult,
  BrowserSetupTarget,
  BrowserStatusDto,
  BrowserLiveDto,
  SignInFrameDto,
  SignInViewDto,
  WatchDetailDto,
  WatchSummaryDto,
} from './watches';
export type * from './watches';
// ----- chat import DTOs: block "import", docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.13 -----
import type {
  ExternalSessionInfo,
  ImportBatch,
  ImportBatchDetail,
  ImportBatchInput,
  ImportBatchesDto,
  ImportEstimate,
  ImportEstimateInput,
  ImportOffer,
  ImportRetention,
  ImportScanPage,
  ImportScanQuery,
  ImportSyncResult,
  ImportUndoResult,
  ImportUploadResult,
  MemoryReviewItem,
} from './import';
export type * from './import';
// ----- folders across devices DTOs: block "projects", docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.12 -----
import type { DeviceFoldersDto, HubBackInput, HubBackPreview, HubCopyPreview, IdentifyResult, MoveInput, MoveResult, ProjectDto, SessionLocationDto } from './projects';
export type * from './projects';
// ----- repo sessions on GitHub, docs/DESIGN.md 30 -----
import type { CleanupInput, FolderGitDto, GithubBranchesDto, GithubRepoDto, GithubStatusDto, MergeInput, OpenPrInput, PrDraft, PushInput, PushResult, RepoSessionDto, RepoSessionInput, WorktreeSessionInput } from './github';
export type * from './github';
export { sessionRepo } from './github';
// ----- workflow engine DTOs: block "workflows", docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.17 -----
import type {
  FindingVerdict,
  StartWorkflowInput,
  WorkflowDetail,
  WorkflowFinding,
  WorkflowPreset,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunsQuery,
  WorkflowSummary,
  WorktreeAction,
  WorktreeActionResult,
} from './workflows';
export type * from './workflows';
// ----- alerts: file conflicts and stuck turns, docs/DESIGN.md 28 -----
import type { AlertAction, AlertItem } from './alerts';
export type * from './alerts';
// ----- subscription sign-in DTOs: CLIProxyAPI, docs/INSTALL.md (Subscriptions) -----
import type { SignInStartDto, SignInStatusDto, SubscriptionsSettingsInput, SubscriptionsStatus } from './subscriptions';
export type * from './subscriptions';
// ----- accounts and their order: Settings > Models > Accounts -----
import type { AccountOrderInput, AccountPatch, AccountPrefixInput, AccountsStatus } from './accounts';
export type * from './accounts';
// ----- sharing a session: the sanitized export and the signed bundle (session/share.ts) -----
import type { ConclaveBundle, RedactReport, ShareOptions } from './share';
export type * from './share';
// ----- friends: hub to hub, docs/design/FRIENDS.md -----
import type {
  ApplyShareInput,
  ApplySharePlan,
  ApplyShareResult,
  ForkShareInput,
  FriendDto,
  FriendGrants,
  FriendInvite,
  FriendInviteInput,
  FriendReachability,
  HandoffDraft,
  HandoffShareInput,
  InboxItemDto,
  OutboxItemDto,
  ReceivedShareDto,
  SendShareInput,
  SentShareDto,
  SharePreview,
  SharePreviewInput,
  ShareViewDto,
  UpdateShareInput,
  AddFriendInput,
  AddFriendResult,
  FriendSettings,
  MailInviteResult,
} from './friends';
export type * from './friends';
// ----- shared projects with friends, docs/design/FRIENDS.md -----
import type {
  CreateSharedProjectInput,
  SharedItemVersionDto,
  SharedMemoryCandidate,
  SharedNoteInput,
  SharedProjectCodeDto,
  SharedProjectDto,
  SharedProjectView,
  SharedWriteResult,
  UpdateSharedProjectInput,
} from './shared-projects';
export type * from './shared-projects';
// ----- the Map: a live view of the hub, docs/DESIGN.md 29 -----
import type { MapQuery, MapSnapshot } from './map';
export type * from './map';
// ----- the memory map: GET /api/memory/graph -----
import type { MemoryGraph } from './memory-graph';
export type * from './memory-graph';
// ----- hub logs: daily files, app lines and the export, docs/DESIGN.md 33 -----
import type { ClientLogBatch, ClientLogResult, LogErrorsReport, LogsExportQuery, LogsStatus, LogsTailQuery, LogsTailResult } from './logs';
export type * from './logs';
// ----- updates: the hub's own and its devices' daemons, docs/DESIGN.md Updates -----
import type { DeviceUpdateDto, DeviceUpdatesDto, UpdateStatusDto } from './updates';
export type * from './updates';
// ----- hook recipes DTOs: block "hook recipes", docs/design/ECOSYSTEM.md 2.2 -----
import type { HookRecipe, RecipeTarget } from '../extensions/hook-recipes';
import type { RecipeTestResult } from '../catalog/types';

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  agent?: string;
  model?: string;
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  cwd?: string;
  device?: string;
  title?: string;
  taskId?: string;
  parentId?: string;
  tags?: string[];
  modeConfig?: ModeConfig;
  /** Send this as the first message right away. */
  prompt?: string;
  /**
   * "chat" makes a plain chat for the Chat page: the agent defaults to
   * "chat", the device to the hub, and `chat` holds its switches (a missing
   * switch is on). A workbench session reads `chat.thinking`, which sets
   * its effort over the agent's, and `chat.memory`: false leaves no trace in
   * memory (no profile, recall, extraction or memory tools).
   */
  kind?: SessionKind;
  chat?: Partial<ChatSettings>;
}

export interface SessionPatch {
  title?: string;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
  agent?: string;
  model?: string;
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  cwd?: string;
  device?: string;
  taskId?: string | null;
  modeConfig?: ModeConfig;
  /** "agent" moves a chat into Sessions (Continue as a session; send agent, device and cwd with it). */
  kind?: SessionKind;
  /** Change some of a chat's switches; the others keep their value. thinking null goes back to the agent's setting. On a workbench session thinking and memory are read. */
  chat?: ChatSettingsPatch;
  /** Ultra: plan and run workflows for real tasks (docs/WORKFLOWS.md). Refused on chats. */
  ultra?: boolean;
  /** MCP servers whose tools this session leaves out (/mcp in a session). null or [] turns them all back on. */
  mcpOff?: string[] | null;
}

/** What fills a session's context now (/context), in tokens counted like a request (chars / 4). */
export interface ContextUsageDto {
  model: string;
  /** The model's context window. */
  window: number;
  /** Share of the window where auto compaction runs (config context.compactAt). */
  compactAt: number;
  /** compactAt in tokens. */
  compactTokens: number;
  parts: {
    /** The system prompt: the agent, instructions, memory profile, skills list. */
    system: number;
    /** Tool names, descriptions and schemas. */
    tools: number;
    /** Text, thinking and tool calls in the messages since the last summary. */
    messages: number;
    /** Tool results in those messages. */
    toolOutput: number;
  };
  /** False when the device is offline and its instruction files could not be read. */
  systemKnown: boolean;
  total: number;
  /** What the provider counted for the last reply (input, cache and output), when it said. */
  measured?: number;
  toolCount: number;
  mcpTools: number;
  /** MCP tools behind ToolSearch. */
  deferredTools: number;
  messageCount: number;
  /** True when a summary replaced older messages. */
  summarized: boolean;
  /** Tokens of the messages a summary replaced. */
  olderTokens: number;
}

/** One way to switch, against staying (modes/switch-cost.ts). USD. */
export interface SwitchMath {
  /** Tokens the new model reads on its first reply. */
  tokens: number;
  /** That first reply's history, plus a summary when there is one. */
  onceUsd: number;
  /** The same reply staying on the current model: its warm cache read. */
  stayUsd: number;
  /** Each later reply on the new model, and on the current one (3K new input, 2K output). */
  replyUsd: number;
  stayReplyUsd: number;
  /** Replies until the switch has paid for itself: 0 when it is cheaper at once, missing when it never is. */
  paybackReplies?: number;
}

/** GET /api/sessions/:id/switch-estimate?model=: what a switch costs before it happens. */
export interface SwitchEstimate {
  from: string;
  to: string;
  /** Tokens of active context the new model would read: system prompt, tools and messages. */
  tokens: number;
  /** config context.switchBriefAt. */
  threshold: number;
  /** The cache lifetime the session's requests use: 1h interactive, 5m headless; missing with caching off. */
  ttl?: '5m' | '1h';
  /** Switching with the whole history (the default). */
  full: SwitchMath;
  /** Switching with a short handover (a summary and the recent turns), when it is offered. */
  brief?: SwitchMath & { summaryUsd: number };
  /** One second opinion from the target instead. */
  askUsd: number;
  /** Show the price and the choices before switching: over the threshold and not a cheap switch. */
  confirm: boolean;
  /** The short handover saves enough to suggest it in a quiet line. */
  suggestBrief: boolean;
  /** Prices are known: false for a harness, an agent, or a plan with no per-token price. */
  priced: boolean;
  /** The task's effective fallback policy (its own, its ancestors' and the config's; session/limit-tree.ts). Missing when it has none. */
  fallbackPolicy?: { providers?: string[]; paid?: boolean; costUsd?: number };
}

/** What "Try the next model" started: the model ref and its words ("Opus 5.5 (personal)"). */
export interface NextModelResult {
  model: string;
  label: string;
}

/** POST /api/sessions/:id/handoff options. */
export interface SwitchInput {
  model: string;
  /** A short handover: summarize first, so the new model reads a summary and the recent turns. Default false: the full history. */
  brief?: boolean;
}

export type ChatSettingsPatch = Partial<Omit<ChatSettings, 'thinking' | 'cyber'>> & { thinking?: ChatSettings['thinking'] | null; cyber?: ChatSettings['cyber'] | null };

export interface Attachment {
  /** image/png, application/pdf, text/plain... */
  mediaType: string;
  /** base64 data */
  data?: string;
  /** Path on the session's device (read by the hub). */
  path?: string;
  name?: string;
}

export interface SendInput {
  text: string;
  attachments?: Attachment[];
  /** Override for this turn only. */
  mode?: SessionMode;
  model?: string;
  /** If the session is busy: queue (default) runs after the current turn, steer injects into the running turn. */
  whenBusy?: 'queue' | 'steer';
  /**
   * The id the message keeps while it waits, so an app can show it at once
   * and match the hub's session.queue events to it. 6 to 64 letters, digits,
   * _ or -; the hub makes one when it is missing, malformed or taken.
   */
  pendingId?: string;
  /**
   * The sender chose to go on without a file the hub could not read (the 409
   * named them): the message is sent, its receipt says omitted.
   */
  attachmentLoss?: 'drop';
  /** Filled by the hub from prepareAttachments and carried to the runner; never set by a client. */
  attachmentReceipts?: AttachmentReceipt[];
}

/** What a send did. queued: the session was busy and the message waits (session.queue lists it under pendingId). */
export interface SendResult {
  queued: boolean;
  messageId?: string;
  /** The waiting message's id, when it was queued. */
  pendingId?: string;
}

export interface SecondOpinionInput {
  /** "provider/model" or "@agent". Defaults to config.modes.reviewer. */
  reviewer?: string;
  /** Message to review. Defaults to the last assistant message. */
  messageId?: string;
  /** What to focus on. */
  instructions?: string;
  /** Include the working tree diff. Default on; false leaves it out. */
  includeDiff?: boolean;
  /** Also send the conversation that produced the answer. Off by default: the reviewer gets the brief, the answer, the diff and the project rules (modes/review.ts). */
  includeTranscript?: boolean;
}

export interface ModelGroup {
  provider: string;
  name: string;
  type: string;
  configured: boolean;
  enabled: boolean;
  models: ModelEntry[];
  error?: string;
}

/**
 * A model in a group. When the owner's order of plans and keys reaches one
 * model through several providers (a Claude plan and the API key), pickers
 * show it once: the entry of the first route, with the route in words, and
 * the others point at it (providers/merge.ts).
 */
export interface ModelEntry extends ModelInfo {
  /** The ref pickers show instead of this one: the same model on the owner's first route. */
  sameAs?: string;
  /** On the entry pickers show: the routes a call tries, in order ("your Claude plan, then API key"). */
  via?: string;
  /** On the entry pickers show: every ref that names this model, its own first. Old sessions and agents may name any of them. */
  refs?: string[];
  /** On the entry pickers show: the other refs that name a route of their own (one plan's prefix, a provider outside the owner's order), for a "via" choice. */
  choices?: string[];
  /** The vendor of a model whose id no catalog or name tells (a new model only a plan lists): the vendor of a plan that lists it. Pickers file it under that maker. */
  vendor?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
  source: 'builtin' | 'mcp';
  server?: string;
}

export interface McpStatus {
  name: string;
  status: 'connected' | 'connecting' | 'failed' | 'disabled';
  tools: number;
  error?: string;
  source: string;
  /** Where the server is defined: config.json, a plugin, or the project .mcp.json. */
  origin?: 'config' | 'plugin' | 'project';
  /** Plugin that contributed the server (origin "plugin"). */
  plugin?: string;
  transport?: 'stdio' | 'http' | 'sse';
  enabled?: boolean;
}

export interface UsageSummary {
  from: number;
  to: number;
  totals: UsageBucketDto;
  byDay: UsageBucketDto[];
  byModel: UsageBucketDto[];
  bySource: UsageBucketDto[];
  byPurpose: UsageBucketDto[];
  /** By account id (Settings > Models > Accounts); "" for calls no account served and rows from before accounts. */
  byAccount?: UsageBucketDto[];
  /** Fraction of input tokens served from cache. */
  cacheHitRate: number;
  /** USD saved by cache reads vs full price. */
  cacheSavingsUsd: number;
  /** What signed in plans saved in the range: the API value of their calls less what they billed. Hubs before it leave it out. */
  savedUsd?: number;
}

export interface UsageBucketDto {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What was billed: $0 for calls a signed in plan served. */
  costUsd: number;
  /** The same tokens at the models' API prices (equal to costUsd for API keys). Hubs before it leave it out. */
  apiValueUsd?: number;
  /** The part of apiValueUsd priced on read from today's catalog, for rows from before values were kept. */
  estimatedUsd?: number;
  calls: number;
}

// ExternalSessionInfo and the other chat import DTOs live in ./import (block "import").

/** GET /api/notify/devices: a browser or installed web app that gets Web Push. */
export interface NotifyDeviceDto {
  /** Short stable id (a hash of the push endpoint). DELETE /api/notify/devices/:id stops it. */
  id: string;
  /** The name the browser sent when it subscribed ("Chrome on macOS"). */
  name?: string;
  kind: 'webpush';
  createdAt?: number;
}

export interface GatewayKeyDto {
  id: string;
  name: string;
  prefix: string;
  device?: string;
  agent?: string;
  createdAt: number;
  lastUsedAt?: number;
  revoked: boolean;
}

export interface HubInfo {
  name: string;
  version: string;
  startedAt: number;
  devices: number;
  publicUrl?: string;
  defaultModel: string;
  features: string[];
  /** The hub's identity fingerprint (docs/design/HUB-LOGIN-AND-IDENTITY.md), shown in Settings to compare with a phone. */
  fingerprint?: string;
}

/** The hub's Ed25519 public key (base64url, 32 raw bytes) and its fingerprint (first 16 bytes of SHA-256, hex). */
export interface HubIdentity {
  publicKey: string;
  fingerprint: string;
}

/** GET /api/identity: the key, and its signature of `conclave-hub-identity-v1\n<nonce>`. */
export interface IdentityProof extends HubIdentity {
  signature: string;
}

/** POST /api/pair and POST /api/login. */
export interface PairResult {
  token: string;
  clientId: string;
  hub: HubInfo;
  /** Every way to reach the hub, best first. */
  addresses?: string[];
  /** Keep it with the token and pass it as ClientOptions.hubKey. Absent from hubs older than this change. */
  identity?: HubIdentity;
  /** Whose token this is (docs/design/ACCOUNTS.md). Absent from hubs older than accounts: the owner's. */
  account?: AccountRef;
}

/** GET /api/health (no auth needed). */
export interface HealthDto {
  ok: boolean;
  version: string;
  uptimeMs: number;
  /** More than one person on this hub: the login asks for a name. Absent from hubs older than accounts. */
  people?: boolean;
}

/** GET /api/auth/password (owner only). */
export interface PasswordStatus {
  set: boolean;
  setAt?: number;
}

/** The address answered with another key, or a bad signature: nothing with a secret in it was sent. */
export class HubIdentityError extends Error {
  override name = 'HubIdentityError';
  constructor(
    public address: string,
    message = 'This address is not your hub. Conclave did not send your sign-in.',
  ) {
    super(message);
  }
}

export interface PairingInfo {
  code: string;
  /** The best address for this hub (see RemoteStatus.addresses). */
  url: string;
  /**
   * conclave://pair?url=...&code=...&fp=...&alt=...&alt=... for QR codes. fp
   * is the hub's key fingerprint: apps check the hub at `url` against it
   * before they send the code. Each alt is another address that reaches the
   * hub (the same network, an own URL), best first. Apps keep them and try
   * them when `url` stops answering.
   */
  deepLink: string;
  /** SVG of the QR code. */
  qrSvg: string;
  expiresAt: number;
  /** Every address in the deep link, `url` first. */
  addresses?: string[];
  /** The hub's key fingerprint, the fp in the deep link. */
  fingerprint?: string;
}

/**
 * GET /api/clients and the app.updated event: an app paired with a pairing
 * code or a password (POST /api/pair, /api/login). Phones are apps, not
 * devices: the Android app says platform android, the iPhone web app ios.
 */
export interface AppDto {
  id: string;
  /** The name the app paired as ("Pixel 8", "Safari on iOS"). */
  name: string;
  /** What the app said it runs on: android, ios, web, desktop, or the CLI's OS. */
  platform?: string;
  createdAt: number;
  lastSeenAt?: number;
  revoked: boolean;
  /** Whose app it is (docs/design/ACCOUNTS.md 4). */
  accountId: string;
  /** It has a live connection to the hub now. */
  online?: boolean;
}

// ---------------------------------------------------------------------------
// Remote access (Settings, Remote access)
// ---------------------------------------------------------------------------

/** PUT /api/remote. Fields left out keep their value. */
export interface RemoteSettingsInput {
  mode?: RemoteMode;
  /** Let devices on the same network connect. */
  lan?: boolean;
  /** Your own address for tailscale and custom modes (server.publicUrl). null clears it. */
  url?: string | null;
}

/** A Cloudflare zone the saved API token can edit. */
export interface CloudflareZoneDto {
  id: string;
  name: string;
  accountId: string;
  accountName?: string;
}

/** POST /api/remote/stable: make a named tunnel and a DNS name on a zone. */
export interface StableTunnelInput {
  zoneId: string;
  /** The name in front of the zone: "conclave" gives conclave.example.com. Default "conclave". */
  name?: string;
}

/** GET /api/remote/tailscale: what the hub found about Tailscale on its machine. */
export interface TailscaleInfo {
  installed: boolean;
  /** Logged in and connected to a tailnet. */
  running: boolean;
  /** This machine's MagicDNS name, without the trailing dot. */
  dnsName?: string;
  /** https://<dnsName>, the address `tailscale serve` gives the hub. */
  url?: string;
  /** The command that serves the hub on the tailnet. */
  command: string;
}

export interface FileEntryDto {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

// ---------------------------------------------------------------------------
// Agents: shipped defaults
// ---------------------------------------------------------------------------

export interface AgentDefaultInfo {
  name: string;
  /** The shipped markdown file: frontmatter plus the prompt. */
  markdown: string;
  /** The shipped profile, parsed from that file. */
  agent: AgentDef;
  /** The profile in use now. Differs from `agent` when a copy overrides it. */
  active?: AgentDef;
  /** True when a user, project, plugin or other-CLI copy replaces the shipped one. */
  overridden: boolean;
  /** Where the copy in use comes from ("builtin" when not overridden). */
  activeSource?: string;
  /** True when DELETE /api/agents/:name would bring the shipped one back (the copy is a user file). */
  resettable: boolean;
}

// ---------------------------------------------------------------------------
// Extensions area (tools, skills, commands, hooks, plugins, MCP, sources)
// ---------------------------------------------------------------------------

export type ExtensionSourceId = 'builtin' | 'user' | 'project' | 'plugin' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'agents';
export type ComponentKindDto = 'agent' | 'skill' | 'command';
export type CliName = 'claude' | 'codex' | 'opencode' | 'gemini';

/** One agent, skill or command found on disk, including shadowed copies. */
export interface InventoryItemDto {
  kind: ComponentKindDto;
  name: string;
  description?: string;
  source: ExtensionSourceId;
  plugin?: string;
  path?: string;
  /** Scope label, e.g. "claude user", "opencode project /repo". */
  scope: string;
  /** True for the copy in use. */
  active: boolean;
  /** For a shadowed copy: the scope of the copy that wins. */
  shadowedBy?: string;
  /** A skill an agent wrote (Extensions > Skills, Learned). */
  learned?: boolean;
}

/** The daily digest switch in Settings, Memory (core/memory/digest.ts). */
export interface DigestSettingsDto {
  enabled: boolean;
  /** HH:MM local, when the schedule is a plain daily one. */
  time: string;
  timezone: string;
  /** The routine's own schedule, which the owner may have changed in Routines. */
  schedule: string;
  routineId?: string;
  nextRunAt?: number;
  lastRun?: RoutineRun;
  /** A memory connection takes the daily note (Basic Memory with grouped notes). */
  writes: boolean;
  /** The last note written. */
  lastNote?: { date: string; at: number; lines: number };
}

/** A skill an agent wrote with SkillManage (core/extensions/learned.ts). */
export interface LearnedSkillDto {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  disabledReason?: string;
  /** The session it was written in, and that session's title when it still exists. */
  sessionId?: string;
  sessionTitle?: string;
  /** The folder a project skill is for. */
  project?: string;
  /** YYYY-MM-DD */
  created: string;
  updated: string;
  lastUsedAt?: number;
  uses?: number;
  /** The Markdown, on the detail call. */
  body?: string;
}

export interface ExtensionProblem {
  kind: 'mcp' | 'hook' | 'conflict' | 'event' | 'trust';
  name?: string;
  event?: HookEvent;
  message: string;
}

/** Trust state of a project folder. Its hooks and allow rules stay off until it is trusted. */
export interface ProjectTrustInfo {
  cwd: string;
  trusted: boolean;
  /** Hook handlers in the folder's settings files. */
  hooks: number;
  /** Allow rules in the folder's settings files. */
  allow: number;
  /** Servers in the folder's .mcp.json (listed only; Conclave does not start them). */
  mcpServers: number;
  /** Files that contain them. */
  files: string[];
}

export interface ExtensionsOverview {
  counts: {
    tools: number;
    mcpTools: number;
    agents: number;
    skills: number;
    commands: number;
    hookHandlers: number;
    plugins: { installed: number; enabled: number };
    mcpServers: { enabled: number; connected: number };
  };
  compat: { claudeCode: boolean; agentsMd: boolean; codex: boolean; opencode: boolean; gemini: boolean };
  /** CLI versions found on the selected device; null when not installed. */
  clis: Record<CliName, string | null>;
  problems: ExtensionProblem[];
  /** Present when a cwd was given. */
  trust?: ProjectTrustInfo;
}

export interface ExtensionSourceInfo {
  id: ExtensionSourceId;
  label: string;
  on: boolean;
  /** Config key under `compat` that turns it on, a list of keys (any one turns it on), or null when always on. */
  toggle: string | string[] | null;
  paths: string[];
  counts: { agents: number; skills: number; commands: number };
}

export interface ToolAgentAccess {
  name: string;
  visible: boolean;
  /** Why not: "not in its tools list", "in disallowedTools", "untrusted agent" (it sees only the tools its list names), "not in its mcpServers", "opt-in tool". */
  why?: string;
}

export interface ToolPermissionInfo {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  /** The rule that decided, when one did. */
  rule?: string | null;
  /** "config", a settings file path, or null for a mode default. */
  ruleSource?: string | null;
}

/** GET /api/tools: ToolInfo plus who can use the tool and what decides a call. */
export interface ToolDetail extends ToolInfo {
  kind: 'builtin' | 'mcp';
  /** Display group: file, shell, web, agents, memory, browser, other, or the MCP server name. */
  group: string;
  agents: ToolAgentAccess[];
  /** Decision for a call with no input, in the default mode. */
  permission: ToolPermissionInfo;
  /** Hook handlers that run for this tool, per event. */
  hooks: Partial<Record<HookEvent, number>>;
  /** Hidden unless an agent names it in its tools list (browser tools). */
  optIn?: boolean;
}

export interface ToolCheckInput {
  tool: string;
  input?: Record<string, unknown>;
  agent?: string;
  mode?: PermissionMode;
  cwd?: string;
}

export interface ToolCheckResult extends ToolPermissionInfo {
  /** The dangerous-command guard's reason, or false. Dangerous commands always ask. */
  dangerous: string | false;
  /** PreToolUse handlers that would run for this call. */
  hooks: number;
}

export type HookOriginDto = 'claude-user' | 'config' | 'plugin' | 'claude-project' | 'project';

export interface HookHandlerDto {
  /** mcp_tool calls a tool on a connected MCP server (Claude Code's shape). */
  type: 'command' | 'prompt' | 'mcp_tool';
  command?: string;
  prompt?: string;
  args?: string[];
  model?: string;
  /** Seconds. */
  timeout?: number;
  /** Permission-rule filter, e.g. "Bash(git *)". */
  if?: string;
  async?: boolean;
  shell?: string;
  plugin?: string;
  /** Real path behind ${CLAUDE_PLUGIN_ROOT}. */
  pluginRoot?: string;
  /** Hook recipe this handler was added from (Conclave field). */
  recipe?: string;
  /** "block": a crash or timeout blocks like exit 2 (fail closed). */
  onFailure?: 'block' | 'ignore';
  /** Run once per session. */
  once?: boolean;
  /** Shown in the session's live strip while the hook runs. */
  statusMessage?: string;
  /** Keep stdout out of the run log. */
  suppressOutput?: boolean;
  /** mcp_tool: server, tool and input (${path.in.input} interpolates). */
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
  /** mcp_tool: allow a tool that is not marked read only (Conclave field). */
  allowWrite?: boolean;
  /** Most chars of context this handler may add (Codex additionalContextLimit). */
  additionalContextLimit?: number;
  /** From recent runs: about how many tokens this handler adds per session. */
  tokensPerSession?: number;
}

export interface HookGroupDto {
  matcher?: string;
  source: HookOriginDto;
  /** Settings file the group came from. */
  path?: string;
  plugin?: string;
  /** Position among this event's groups from the same source; use it in HookTestInput.only. */
  index: number;
  /** False for project hooks in a folder that is not trusted yet. */
  active: boolean;
  /** True when the UI may edit it in place (config.json and .conclave/settings.json). */
  editable: boolean;
  hooks: HookHandlerDto[];
}

export interface HookTraceDto {
  event: HookEvent;
  type: 'command' | 'prompt' | 'function';
  label: string;
  plugin?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  timedOut?: boolean;
  /** allow, deny, ask, block, rewrite, replace, context, stop, noop, error, timeout, async, skipped. */
  result: string;
  /** Chars this handler added to the model's context (after any budget cut). */
  contextChars?: number;
  /** Extra words about the run: a rewrite conflict, a budget cut, a fail-closed crash. */
  note?: string;
  /** Hook recipe the handler came from. */
  recipe?: string;
}

export interface HookRunDto extends HookTraceDto {
  at: number;
  sessionId: string;
}

export interface HookEventInfo {
  event: HookEvent;
  /** Plain description of when it runs. */
  gloss: string;
  /** What a matcher is compared with ("tool name", "startup, resume, clear, compact", ...), or null when matchers are ignored. */
  matcherValue: string | null;
  /** True when the engine fires this event. */
  fires: boolean;
  groups: HookGroupDto[];
  /** Recent handler runs, newest last. */
  last: HookRunDto[];
}

export interface HooksOverview {
  events: HookEventInfo[];
  trust?: ProjectTrustInfo;
  /** Problems found in the hooks that load (flat entries, bare mcp__ matchers, ms timeouts, ...). */
  lint?: HookLintIssue[];
}

// ----- hook recipes, lint and built-in hooks: block "hook recipes", ECOSYSTEM.md 2.2 -----

/** One place a recipe is installed. */
export interface RecipeInstall {
  scope: 'user' | 'project' | RecipeTarget;
  cwd?: string;
  device?: string;
  /** Tunables that differ from the defaults. */
  env: Record<string, string>;
  installedAt: number;
}

export interface HookRecipeDto extends Omit<HookRecipe, 'script' | 'tests'> {
  scriptBytes: number;
  testCount: number;
  installed: RecipeInstall[];
  /** needs checked with command -v on the hub. */
  ready: { ok: boolean; missing: string[] };
}

export interface HookRecipeDetail extends HookRecipe {
  installed: RecipeInstall[];
  ready: { ok: boolean; missing: string[] };
  /** Where the script goes on the hub. */
  scriptPath: string;
}

export interface RecipeInstallRequest {
  scope: 'user' | 'project';
  cwd?: string;
  /** Tunables that differ from the defaults. */
  env?: Record<string, string>;
  /** Install into another CLI's settings on a device instead of Conclave. */
  target?: { cli: 'claude-code' | 'codex' | 'gemini'; device: string };
  /** Skip running the bundled tests (default false). */
  skipTests?: boolean;
  /** Install even when a program the script needs is missing. */
  force?: boolean;
}

export interface RecipeInstallResult {
  ok: true;
  tests: RecipeTestResult[];
  installed: RecipeInstall;
  /** The settings file the handlers went into. */
  file: string;
  /** What is left to do in another CLI before the hooks run there (Codex asks you to trust new hooks). */
  note?: string;
}

export interface RecipeRemoveWhere {
  scope?: 'user' | 'project';
  cwd?: string;
  cli?: 'claude-code' | 'codex' | 'gemini';
  device?: string;
}

export interface HookLintIssue {
  level: 'error' | 'warn';
  event: HookEvent;
  /** Group position in the list that was linted. */
  group: number;
  handler?: number;
  text: string;
  /** The whole list with this issue fixed, when a fix is known. */
  fix?: HooksConfig;
  /** Settings file of the group, when linting what loads. */
  path?: string;
}

export type BuiltinHookId = 'memory-recall' | 'memory-extract' | 'compaction' | 'file-recall';

export interface BuiltinHookDto {
  id: BuiltinHookId;
  event: HookEvent;
  label: string;
  /** What it does, one or two sentences. */
  description: string;
  enabled: boolean;
  /** False when turning it off is not allowed (compaction keeps sessions inside the model's window). */
  canDisable: boolean;
  /** Most chars it may add per run. */
  budgetChars?: number;
  lastRun?: HookRunDto;
  tokensPerSession?: number;
  /** Config key behind the switch, for the "Equivalent" line. */
  setting?: string;
}

export interface HookTestInput {
  event: HookEvent;
  /** Sample hook input. session_id, cwd and hook_event_name are filled in. */
  input?: Record<string, unknown>;
  matcherValue?: string;
  cwd?: string;
  /** Run only some groups. Without it every active group runs. */
  only?: { source?: HookOriginDto; plugin?: string; index?: number; path?: string };
}

export interface HookTestResult {
  blocked: boolean;
  reason?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  updatedInput?: Record<string, unknown>;
  updatedToolOutput?: unknown;
  additionalContext: string[];
  systemMessages: string[];
  stop?: { reason?: string };
  trace: HookTraceDto[];
  /** The outcome in plain words, as the model or user would see it. */
  modelWouldSee: string;
}

export interface HookImportResult {
  hooks: HooksConfig;
  /** Events or handlers with no Conclave equivalent. */
  skipped: string[];
  notes: string[];
}

export interface PluginDetailDto extends InstalledPlugin {
  agents: AgentDef[];
  skills: SkillDef[];
  commands: CommandDef[];
  hooks: HooksConfig;
  mcpServers: Record<string, McpServerConfig>;
}

export interface MarketplaceSearchItem {
  name: string;
  description?: string;
  category?: string;
  version?: string;
  marketplace: string;
  /** "path" (in the marketplace repo), "github", "git", "url" or "other". */
  sourceKind: string;
  installed: boolean;
  enabled: boolean;
  /** What to pass to installPlugin, e.g. "hookify@claude-plugins-official". */
  install: string;
}

export interface MarketplaceSearchResult {
  marketplaces: Array<{ name: string; plugins: number }>;
  results: MarketplaceSearchItem[];
}

export interface McpTestResult {
  ok: boolean;
  ms: number;
  tools: number;
  error?: string;
}

export interface McpToolDto {
  name: string;
  /** mcp__<server>__<tool>, the name agents and permission rules use. */
  fullName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpCallResult {
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

export type McpImportFormat = 'claude' | 'codex' | 'opencode' | 'gemini';

/** One step to add a server to another CLI. */
export interface McpConnectStepDto {
  cli: CliName;
  /** Shell command that registers the server at user scope, when the CLI has one. */
  command?: string;
  /** Config file and the snippet to merge into it, for manual setup. */
  file: string;
  snippet: string;
  note?: string;
}

export interface McpConnectRunResult {
  cli: CliName;
  command?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the step was not run (no command for this CLI, CLI not installed). */
  skipped?: string;
}

export interface SyncClisOptions {
  device?: string;
  only?: CliName[];
  /** List the files without writing them. */
  dryRun?: boolean;
}

/** GET /api/mcp-server/snippets: how to point other tools at Conclave's own MCP endpoint. */
export interface McpServerSnippets {
  /** Streamable HTTP endpoint on the hub. */
  url: string;
  /** Tools the endpoint serves. */
  tools: Array<{ name: string; description: string; readOnly: boolean }>;
  /** Environment variable the snippets read the token from. */
  tokenEnv: string;
  http: McpConnectStepDto[];
  stdio: McpConnectStepDto[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// OAuth for /mcp: the consent screen and Settings > Connected apps
// ---------------------------------------------------------------------------

/** What a connected app (claude.ai, ChatGPT) may do through /mcp. */
export type OAuthScope = 'memory:read' | 'memory:write' | 'chats:read';

/** GET /api/oauth/requests/:id: one sign in request waiting for the owner's answer. */
export interface OAuthConsentDto {
  id: string;
  app: {
    /** The name the app gave itself. Nobody checked it. */
    name: string;
    /** Host of the redirect URI: where the answer goes. The consent headline names it. */
    host: string;
    /** For an app known by a metadata document URL: that URL's host. */
    identity?: string;
    /** Registered by itself (dcr) or known by a metadata document URL (cimd). */
    kind: 'dcr' | 'cimd';
    /** It finishes signing in on a loopback address. */
    loopback: boolean;
    /** A warning in plain words, shown in amber, when the name or the redirect looks off. */
    warning?: string;
  };
  redirectUri: string;
  scopes: Array<{ id: OAuthScope; label: string }>;
  expiresAt: number;
  /** One time value to send back with the answer. A new read makes a new one. */
  consent: string;
}

/** POST /api/oauth/requests/:id. scopes may leave some out; it may not add any. */
export interface OAuthDecisionInput {
  decision: 'allow' | 'deny';
  consent: string;
  scopes?: OAuthScope[];
}

/** GET /api/oauth/apps: an app with access through /mcp. */
export interface ConnectedAppDto {
  id: string;
  name: string;
  /** Where it sends you back, such as claude.ai. */
  host: string;
  identity?: string;
  kind: 'dcr' | 'cimd';
  scopes: Array<{ id: OAuthScope; label: string }>;
  createdAt: number;
  lastUsedAt?: number;
}

// ---------------------------------------------------------------------------
// Memory connections, file import and export
// ---------------------------------------------------------------------------

export type MemoryConnectionConfigDto = NonNullable<ConclaveConfig['memory']['connections']>[number];
export type MemoryConnectionType = MemoryConnectionConfigDto['type'];
export type MemoryConnectionMode = NonNullable<MemoryConnectionConfigDto['mode']>;

/** Body of POST /api/memory/connections. id is made from the name when left out. */
export type MemoryConnectionInputDto = Omit<MemoryConnectionConfigDto, 'id'> & { id?: string };

export interface MemoryConnectionStatus {
  state: 'ok' | 'error' | 'backoff' | 'disabled' | 'unknown';
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  latencyMs?: number;
  /** Failures in a row. */
  failures: number;
  /** Live search skips this connection until then. */
  retryAt?: number;
  lastSync?: MemorySyncResult & { at: number; error?: string };
  /** Notes from this connection in the local index. */
  imported: number;
}

/** A connection as listed: config with defaults filled in, credentials masked as ********. */
export interface MemoryConnectionInfo extends MemoryConnectionConfigDto {
  name: string;
  enabled: boolean;
  mode: MemoryConnectionMode;
  search: boolean;
  timeoutMs: number;
  options: Record<string, unknown>;
  /** True for the old memory.external setting, shown as connection "external". */
  legacy?: boolean;
  status: MemoryConnectionStatus;
  capabilities: { search: boolean; write: boolean; pull: boolean };
}

export interface MemoryConnectionPreset {
  key: string;
  type: MemoryConnectionType;
  label: string;
  description: string;
  template: Omit<MemoryConnectionConfigDto, 'id'>;
  /** Option keys the form shows, in order. A trailing ? marks optional ones. */
  fields: string[];
  docs: string;
}

export interface MemoryConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  steps: Array<{ step: string; ok: boolean; ms?: number; detail?: string }>;
  error?: string;
  hint?: string;
  hits?: number;
  tools?: string[];
}

export interface MemorySyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  total: number;
  skipped: number;
}

export interface MemoryFileImportInput {
  /** Device to read from. Default: the hub. */
  device?: string;
  /** Files to read. Default: each CLI's user memory file, plus the project's files when cwd is set. */
  paths?: string[];
  cwd?: string;
  /** Re-import files that did not change. */
  force?: boolean;
  /** Show what would be saved, save nothing. */
  dryRun?: boolean;
}

export interface MemoryFileImportResult {
  files: Array<{
    path: string;
    source: 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'file';
    scope: 'global' | 'project';
    status: 'imported' | 'unchanged' | 'missing' | 'empty' | 'error' | 'preview';
    added: number;
    updated: number;
    error?: string;
  }>;
  added: MemoryEntry[];
  updated: MemoryEntry[];
  proposed: Array<{ content: string; kind: Exclude<MemoryKind, 'episode'>; tags: string[]; scope: MemoryScope; file: string }>;
  proposedUpdates: Array<{ id: string; content: string; file: string }>;
  dropped: number;
}

export interface MemoryExportOptions {
  layout?: 'single' | 'folder';
  includeImported?: boolean;
  /** Root folder name for the folder layout. */
  root?: string;
}

export interface MemoryMarkdownExport {
  layout: 'single' | 'folder';
  files: Array<{ path: string; content: string }>;
  count: number;
  generatedAt: string;
}

export interface MemoryStatsDto {
  total: number;
  byKind: Record<string, number>;
  /** Kept for older clients: "connections" when any connection is set up. */
  external?: string;
  connections: Array<{ id: string; type: MemoryConnectionType; mode: MemoryConnectionMode; state: MemoryConnectionStatus['state'] }>;
}

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

export interface BackupOptions {
  /** Put provider keys, named secrets and secret config fields in the file. Owner token only. Default false. */
  secrets?: boolean;
  /** Include sessions and their messages. Default true. */
  sessions?: boolean;
}

export interface BackupCounts {
  agents: number;
  routines: number;
  tasks: number;
  memories: number;
  sessions: number;
  messages: number;
}

/** GET /api/backup: the hub's state as one JSON document. POST it back to /api/restore. */
export interface HubBackup {
  format: 'conclave-backup';
  version: number;
  createdAt: number;
  hub: { name: string; version: string };
  /** True when keys and secret config fields are in the file. */
  includesSecrets: boolean;
  /** The user config (config.json). server.token is never included. */
  config: Record<string, unknown>;
  /** Config fields left out because they hold secrets, as dotted paths ("search.apiKey"). */
  redacted: string[];
  /** Names of the provider keys and named secrets the hub had. */
  secretNames: { providers: string[]; values: string[] };
  /** The values, only when includesSecrets. */
  secrets?: { providers: Record<string, string>; values: Record<string, string> };
  /** User agent files from ~/.conclave/agents. */
  agents: Array<{ file: string; content: string }>;
  routines: Routine[];
  tasks: Task[];
  memories: MemoryEntry[];
  sessions: Session[];
  messages: Message[];
  counts: BackupCounts;
}

export interface RestoreOptions {
  /** Merge the backup's settings into this hub's config. Default true. */
  config?: boolean;
}

export interface RestoreResult {
  /** True when settings were merged in. The server block (address, port, token) is never changed. */
  config: boolean;
  /** Provider keys and named secrets written. */
  secrets: number;
  /** Added from the file. Agent files and routines also replace copies with the same name or id. */
  restored: BackupCounts;
  /** Already on this hub (same id) and left as they were, or unreadable. */
  skipped: BackupCounts;
  /** Providers the backup had keys for that this hub still has no key for. */
  missingKeys: string[];
  /** Config fields the backup left out because they hold secrets and that this hub has no value for. */
  redacted: string[];
}

// ---------------------------------------------------------------------------
// Hub identity and password login, docs/design/HUB-LOGIN-AND-IDENTITY.md
// ---------------------------------------------------------------------------

/** What the hub signs: this, then the nonce. */
export const IDENTITY_PREFIX = 'conclave-hub-identity-v1\n';
/** How long a passed identity check counts for an address. A socket reconnect checks again sooner. */
export const IDENTITY_TTL_MS = 10 * 60_000;

/** Shown for the hub's network refusal during the identity check: the client's own words, not the answering machine's. */
export const NETWORK_REFUSED = 'Your hub does not take connections from this network. Settings, Remote access on the hub shows the address to use.';

/** A key every WebCrypto with Ed25519 takes (RFC 8032, test 1). Tells a bad key from a platform without Ed25519. */
const PROBE_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  // browsers leave it out on plain http pages
  if (!subtle) throw new Error("This page cannot check the hub's key (no WebCrypto here). Open it over https.");
  return subtle;
}

function toBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return undefined;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** A fresh nonce for GET /api/identity: 24 random bytes, base64url. */
export function newNonce(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(24)));
}

/** The first 16 bytes of SHA-256 of the key's 32 raw bytes, as 32 lowercase hex characters. */
export async function fingerprintOf(publicKey: string): Promise<string> {
  const raw = fromBase64url(publicKey);
  if (!raw || raw.length !== 32) throw new Error('Not an Ed25519 public key.');
  const digest = new Uint8Array(await subtleCrypto().digest('SHA-256', raw));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "1a2b 3c4d ...": a fingerprint in groups of four, as the hub and the apps show it. */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint;
}

/**
 * True when `proof` answers `nonce`: its key is `publicKey` (a pinned key;
 * leave it out to take the key the proof names), its fingerprint is that
 * key's, and the signature of `conclave-hub-identity-v1\n<nonce>` checks out.
 * Throws a plain Error on a platform whose WebCrypto has no Ed25519.
 */
export async function verifyIdentity(proof: IdentityProof, nonce: string, publicKey?: string): Promise<boolean> {
  if (!proof || typeof proof !== 'object') return false;
  const key = publicKey ?? proof.publicKey;
  if (proof.publicKey !== key) return false;
  const raw = fromBase64url(key);
  const sig = fromBase64url(proof.signature);
  if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return false;
  if (proof.fingerprint !== (await fingerprintOf(key))) return false;
  const subtle = subtleCrypto();
  let k: CryptoKey;
  try {
    k = await subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    // a key WebCrypto refuses is not the hub's; no Ed25519 at all is this platform's problem
    try {
      await subtle.importKey('raw', fromBase64url(PROBE_KEY)!, { name: 'Ed25519' }, false, ['verify']);
    } catch {
      throw new Error("This browser cannot check the hub's key (no Ed25519 in WebCrypto). Update it, or open the hub's own address.");
    }
    return false;
  }
  try {
    return await subtle.verify({ name: 'Ed25519' }, k, sig, new TextEncoder().encode(IDENTITY_PREFIX + nonce));
  } catch {
    return false;
  }
}

/** The host of a URL or a bare host, lowercase, without IPv6 brackets or a final dot. */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const n = m.slice(1).map(Number);
  return n.every((x) => x <= 255) ? n : undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || ipv4(host)?.[0] === 127;
}

/**
 * True for an address on this machine or a private network: loopback,
 * 10/8, 172.16/12, 192.168/16, 100.64/10 (carrier NAT and Tailscale),
 * fd00::/8, *.local and *.ts.net. Takes a URL or a bare host.
 */
export function isPrivateAddress(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (isLoopbackHost(host) || host.endsWith('.local') || host.endsWith('.ts.net')) return true;
  const n = ipv4(host);
  if (n) return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127);
  return /^fd[0-9a-f]{2}:/.test(host);
}

/**
 * Whether the client checks the hub at this address before it sends the
 * token: not on loopback, and not for the page's own origin (the web app the
 * hub serves came from that address, so a check there proves nothing).
 */
function needsProof(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  if (!host || isLoopbackHost(host)) return false;
  const page = (globalThis as { location?: { origin?: string } }).location?.origin;
  try {
    return !page || new URL(baseUrl).origin !== page;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  /** The hub's pinned public key (PairResult.identity.publicKey). When set, the client proves the hub at baseUrl holds it before sending the token. */
  hubKey?: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** Share options as query values: 1 and 0, unset left out. */
function shareQuery(o: ShareOptions): Query {
  const bit = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);
  return { thinking: bit(o.thinking), toolOutput: bit(o.toolOutput), attachments: bit(o.attachments), code: bit(o.code) };
}

function qs(q?: Query): string {
  if (!q) return '';
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export class ConclaveClient {
  baseUrl: string;
  token?: string;
  /** The hub's pinned public key (ClientOptions.hubKey). Set it with the token after pairing. */
  hubKey?: string;
  private f: typeof fetch;
  /** Address and key pairs that passed the identity check: when, or the check still running. */
  private proven = new Map<string, { at: number; pending?: Promise<void> }>();

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.hubKey = opts.hubKey;
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const check = this.guard();
    if (check) await check;
    return this.call<T>(method, path, body, query, this.token);
  }

  /**
   * With a pinned hubKey, the hub at baseUrl signs a fresh nonce before
   * anything else goes there (docs/design/HUB-LOGIN-AND-IDENTITY.md). A pass
   * counts for IDENTITY_TTL_MS; calls made meanwhile wait for the same check.
   * Undefined when there is nothing to check.
   */
  private guard(): Promise<void> | undefined {
    const key = this.hubKey;
    if (!key || !needsProof(this.baseUrl)) return undefined;
    const id = `${this.baseUrl} ${key}`;
    const known = this.proven.get(id);
    if (known?.pending) return known.pending;
    if (known && Date.now() - known.at < IDENTITY_TTL_MS) return undefined;
    // forgetIdentity() may drop this check while it runs; then its result is not kept
    const ours = () => this.proven.get(id)?.pending === pending;
    const pending: Promise<void> = this.checkIdentity({ publicKey: key }).then(
      () => {
        if (ours()) this.proven.set(id, { at: Date.now() });
      },
      (err) => {
        if (ours()) this.proven.delete(id);
        throw err;
      },
    );
    this.proven.set(id, { at: 0, pending });
    return pending;
  }

  /**
   * Ask the hub at baseUrl to sign a fresh nonce. The call carries no token.
   * Returns its key when the signature checks out and the key is
   * `expect.publicKey` (a pinned key) or has `expect.fingerprint` (the fp of
   * a QR code); with neither, any key that signs is taken (trust on first
   * use). Throws HubIdentityError when another key or something that is not
   * a hub answers. An address that does not answer throws the network error
   * as it is, and a server error, a rate limit or the hub's network refusal
   * stays an ApiError.
   */
  async checkIdentity(expect: { publicKey?: string; fingerprint?: string } = {}): Promise<HubIdentity> {
    const nonce = newNonce();
    let proof: IdentityProof;
    try {
      proof = await this.identity(nonce);
    } catch (err) {
      // the hub's own network refusal says so; anything could send it, so the message is ours and nothing is sent either way
      if (err instanceof ApiError && err.status === 403 && (err.body as { code?: unknown } | undefined)?.code === 'network') throw new ApiError(403, NETWORK_REFUSED, err.body);
      if (err instanceof ApiError && err.status < 500 && err.status !== 429) throw new HubIdentityError(this.baseUrl);
      throw err;
    }
    const ok = await verifyIdentity(proof, nonce, expect.publicKey);
    if (!ok || (expect.fingerprint && proof.fingerprint !== expect.fingerprint.toLowerCase())) throw new HubIdentityError(this.baseUrl);
    return { publicKey: proof.publicKey, fingerprint: proof.fingerprint };
  }

  /** Check the hub again before the next call, as after a reconnect or a network change. */
  forgetIdentity(): void {
    this.proven.clear();
  }

  /** One HTTP call. The token goes only where it is passed. */
  private async call<T>(method: string, path: string, body?: unknown, query?: Query, token?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.f(`${this.baseUrl}${path}${qs(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = (data as { error?: string })?.error ?? res.statusText;
      throw new ApiError(res.status, msg, data);
    }
    return data as T;
  }

  // ----- hub -----
  info = () => this.request<HubInfo>('GET', '/api/info');
  /** Up, its version, and whether it has more than one person (no auth needed). */
  health = () => this.call<HealthDto>('GET', '/api/health');
  /** Exchange a pairing code for a client token (no auth needed). The reply's addresses list every way to reach the hub, best first. */
  pair = (code: string, name: string, platform: string) => this.request<PairResult>('POST', '/api/pair', { code, name, platform });
  /**
   * Log in with the hub's password, the backup to a pairing code (no auth
   * needed). Off until the owner sets a password. Refused before anything is
   * sent when baseUrl is plain http to an address that is not private.
   */
  login = async (password: string, name: string, platform: string, account?: string): Promise<PairResult> => {
    if (!/^https:\/\//i.test(this.baseUrl) && !isPrivateAddress(this.baseUrl)) throw new Error('Use the https address of your hub to log in with a password.');
    // account: the person's sign-in name or email on a hub with several people; left out, the owner
    return this.request<PairResult>('POST', '/api/login', { password, name, platform, ...(account ? { account } : {}) });
  };
  /** The hub's key and its signature of the nonce (no auth needed). Never carries the token: it is how the client checks the hub before it sends one. */
  identity = (nonce: string) => this.call<IdentityProof>('GET', '/api/identity', undefined, { nonce });
  passwordStatus = () => this.request<PasswordStatus>('GET', '/api/auth/password');
  setPassword = (password: string) => this.request<PasswordStatus>('PUT', '/api/auth/password', { password });
  clearPassword = () => this.request<PasswordStatus>('DELETE', '/api/auth/password');
  /**
   * A pairing code and its QR. With `code` (one this account made, still
   * unused), the same code again with the hub's current addresses, so a QR
   * made before remote access was set gets the new address.
   */
  createPairing = (kind: 'client' | 'device', code?: string) => this.request<PairingInfo>('POST', '/api/pairing', { kind, ...(code ? { code } : {}) });
  /** Apps paired with the hub (phones, the desktop app, browsers, the CLI), each account its own. app.updated keeps them current. */
  apps = () => this.request<AppDto[]>('GET', '/api/clients');
  /** Sign an app out: its token stops working at once. */
  revokeApp = (id: string) => this.request<{ ok: true }>('DELETE', `/api/clients/${encodeURIComponent(id)}`);

  // ----- accounts: you, and the people on the hub (owner), docs/design/ACCOUNTS.md -----
  me = () => this.request<MeDto>('GET', '/api/me');
  updateMe = (patch: MePatch) => this.request<{ ok: true }>('PATCH', '/api/me', patch);
  people = () => this.request<PersonDto[]>('GET', '/api/people');
  person = (id: string) => this.request<PersonDto>('GET', `/api/people/${encodeURIComponent(id)}`);
  /** Add a person with a password, or with an invite link (shown once). */
  addPerson = (input: PersonInput) => this.request<PersonCreated>('POST', '/api/people', input);
  updatePerson = (id: string, patch: PersonPatch) => this.request<PersonDto>('PATCH', `/api/people/${encodeURIComponent(id)}`, patch);
  /** Remove a person and everything that is theirs. Cannot be undone. */
  removePerson = (id: string) => this.request<{ ok: true }>('DELETE', `/api/people/${encodeURIComponent(id)}`);
  /** Set a new password for a person; their apps sign out. */
  resetPersonPassword = (id: string, password: string) => this.request<PersonDto>('POST', `/api/people/${encodeURIComponent(id)}/password`, { password });
  newInvite = (id: string) => this.request<InviteDto>('POST', `/api/people/${encodeURIComponent(id)}/invite`);
  /** A device code and the commands for a person's workspace on the hub machine. */
  workspaceCode = (id: string) => this.request<WorkspaceCode>('POST', `/api/people/${encodeURIComponent(id)}/workspace`);
  /** The apps a person is signed in with (the owner's view in People). */
  personApps = (id: string) => this.request<AppDto[]>('GET', `/api/people/${encodeURIComponent(id)}/clients`);
  /** Sign one of a person's apps out. */
  revokePersonApp = (id: string, appId: string) => this.request<{ ok: true }>('DELETE', `/api/people/${encodeURIComponent(id)}/clients/${encodeURIComponent(appId)}`);
  /** Who an invite is for (no auth needed). */
  invite = (secret: string) => this.call<InviteInfo>('GET', `/api/invite/${encodeURIComponent(secret)}`);
  /** Set a password from an invite and sign in (no auth needed). */
  acceptInvite = (secret: string, password: string, name: string, platform: string) =>
    this.call<PairResult>('POST', `/api/invite/${encodeURIComponent(secret)}`, { password, name, platform });

  // ----- remote access -----
  remote = () => this.request<RemoteStatus>('GET', '/api/remote');
  /** Change the mode, same network access or the own URL. A tunnel mode starts the tunnel; the reply comes back before it is on. */
  setRemote = (input: RemoteSettingsInput) => this.request<RemoteStatus>('PUT', '/api/remote', input);
  /** Quick mode: get a new address. Clients get remote.updated with the new url before the old one stops. */
  restartRemote = () => this.request<RemoteStatus>('POST', '/api/remote/restart');
  /** Check a Cloudflare API token, save it in the hub's secrets store and list the zones it can edit. */
  cloudflareToken = (token: string) => this.request<{ zones: CloudflareZoneDto[] }>('POST', '/api/remote/cloudflare', { token });
  /** Zones for the saved Cloudflare token. */
  cloudflareZones = () => this.request<{ zones: CloudflareZoneDto[] }>('GET', '/api/remote/cloudflare/zones');
  /** Make (or reuse) a named tunnel and its DNS name, then switch to stable mode. */
  setupStableTunnel = (input: StableTunnelInput) => this.request<RemoteStatus>('POST', '/api/remote/stable', input);
  /** Delete the named tunnel and its DNS name from Cloudflare and forget the token. Remote access turns off. */
  removeStableTunnel = () => this.request<RemoteStatus & { warning?: string }>('DELETE', '/api/remote/stable');
  tailscaleInfo = () => this.request<TailscaleInfo>('GET', '/api/remote/tailscale');

  // ----- sessions -----
  /** kind "chat" lists chats only; kind "agent" lists workbench sessions only; leave it out for both. */
  listSessions = (q?: { agent?: string; taskId?: string; archived?: boolean; search?: string; device?: string; limit?: number; parentId?: string | 'none'; kind?: SessionKind }) =>
    this.request<Session[]>('GET', '/api/sessions', undefined, q as Query);
  getSession = (id: string) => this.request<Session>('GET', `/api/sessions/${id}`);
  createSession = (input: CreateSessionInput) => this.request<Session>('POST', '/api/sessions', input);
  updateSession = (id: string, patch: SessionPatch) => this.request<Session>('PATCH', `/api/sessions/${id}`, patch);
  deleteSession = (id: string) => this.request<{ ok: true }>('DELETE', `/api/sessions/${id}`);
  forkSession = (id: string, fromSeq?: number) => this.request<Session>('POST', `/api/sessions/${id}/fork`, { fromSeq });
  /** Delegated work to the main list: a normal session of its kind from now on; parentId stays (session/delegated.ts). */
  moveToMainList = (id: string) => this.request<Session>('POST', `/api/sessions/${id}/main-list`);
  messages = (id: string, afterSeq?: number) => this.request<Message[]>('GET', `/api/sessions/${id}/messages`, undefined, { afterSeq });
  send = (id: string, input: SendInput) => this.request<SendResult>('POST', `/api/sessions/${id}/messages`, input);
  /** Messages waiting while the session is busy, in the order they will run (session.queue keeps it current). */
  queue = (id: string) => this.request<QueuedMessage[]>('GET', `/api/sessions/${id}/queue`);
  /** Take a waiting message off the queue before it runs. 409 once its turn has started, 404 when it is gone. */
  unqueue = (id: string, pendingId: string) => this.request<{ ok: true }>('DELETE', `/api/sessions/${id}/queue/${encodeURIComponent(pendingId)}`);
  /** Send a waiting message Stop held (QueuedMessage.held). 404 when it is gone. */
  sendQueued = (id: string, pendingId: string) => this.request<{ ok: true }>('POST', `/api/sessions/${id}/queue/${encodeURIComponent(pendingId)}/send`);
  /** /btw: a side question about the session, answered apart from its transcript. */
  btw = (id: string, text: string) => this.request<{ answer: string }>('POST', `/api/sessions/${id}/btw`, { text });
  abort = (id: string) => this.request<{ ok: true }>('POST', `/api/sessions/${id}/abort`);
  pauseSession = (id: string) => this.request<Session>('POST', `/api/sessions/${id}/pause`);
  resumeSession = (id: string) => this.request<Session>('POST', `/api/sessions/${id}/resume`);
  rewind = (id: string, seq: number, restoreFiles = false) => this.request<Session>('POST', `/api/sessions/${id}/rewind`, { seq, restoreFiles });
  secondOpinion = (id: string, input: SecondOpinionInput) => this.request<{ ok: true }>('POST', `/api/sessions/${id}/second-opinion`, input);
  /** Switch the session's model. brief: a short handover (the default keeps the full history). */
  handoff = (id: string, model: string, opts: { brief?: boolean } = {}) => this.request<Session>('POST', `/api/sessions/${id}/handoff`, { model, ...(opts.brief ? { brief: true } : {}) } satisfies SwitchInput);
  /** "Try the next model" on a refused reply: the turn runs again on the next model of Refusal fallback. Says which one. */
  tryNextModel = (id: string, messageId?: string) => this.request<NextModelResult>('POST', `/api/sessions/${id}/next-model`, messageId ? { messageId } : {});
  /** Resume a failed provider inference with the full stored transcript, without replaying tools. */
  retryProvider = (id: string, messageId: string, model: string) => this.request<NextModelResult>('POST', `/api/sessions/${id}/retry-provider`, { messageId, model });
  /** What switching to a model would cost, against staying, with and without a short handover. */
  switchEstimate = (id: string, model: string) => this.request<SwitchEstimate>('GET', `/api/sessions/${id}/switch-estimate?model=${encodeURIComponent(model)}`);
  /** instructions: what the summary must keep (/compact <instructions>). compacted is false when there was too little to summarize (older hubs leave it out). */
  compact = (id: string, instructions?: string) => this.request<{ ok: true; compacted?: boolean }>('POST', `/api/sessions/${id}/compact`, instructions ? { instructions } : undefined);
  command = (id: string, line: string) => this.request<{ ok: true; output?: string }>('POST', `/api/sessions/${id}/command`, { line });
  /** What fills the session's context now (/context). */
  contextUsage = (id: string) => this.request<ContextUsageDto>('GET', `/api/sessions/${id}/context`);
  todos = (id: string) => this.request<Todo[]>('GET', `/api/sessions/${id}/todos`);
  checkpoints = (id: string) => this.request<Checkpoint[]>('GET', `/api/sessions/${id}/checkpoints`);
  restoreCheckpoint = (id: string, checkpointId: string) => this.request<{ ok: true }>('POST', `/api/sessions/${id}/checkpoints/${checkpointId}/restore`);
  diff = (id: string) => this.request<{ diff: string; files: string[] }>('GET', `/api/sessions/${id}/diff`);

  // ----- folders across devices, docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.12 -----
  /** Move a session to another device or folder. Not resolved: the result lists candidates for Choose folder. */
  moveSession = (id: string, input: MoveInput) => this.request<MoveResult>('POST', `/api/sessions/${id}/move`, input);
  /** Move to hub: copy the session's whole folder to the hub, then run there. Starts it; hubcopy.progress events follow. */
  moveToHub = (id: string) => this.request<{ line: string }>('POST', `/api/sessions/${id}/move`, { device: 'local', copy: true });
  hubCopyPreview = (id: string) => this.request<HubCopyPreview>('GET', `/api/sessions/${id}/hub-copy`);
  /** Cancel a running Move to hub or Move back. */
  cancelHubCopy = (id: string) => this.request<{ cancelled: boolean }>('DELETE', `/api/sessions/${id}/hub-copy`);
  hubBackPreview = (id: string) => this.request<HubBackPreview>('GET', `/api/sessions/${id}/hub-copy/back`);
  /** Move back: copy the hub's changes to the device, then run there. */
  moveBack = (id: string, input: HubBackInput) => this.request<{ line: string }>('POST', `/api/sessions/${id}/hub-copy/back`, input);
  /** Where the session runs, and what the location banner should say. refresh checks the copy again. */
  sessionLocation = (id: string, refresh = false) => this.request<SessionLocationDto>('GET', `/api/sessions/${id}/location`, undefined, { refresh: refresh || undefined });
  identifyFolder = (input: { device: string; path: string; sessionId?: string; projectId?: string }) => this.request<IdentifyResult>('POST', '/api/projects/identify', input);
  projects = () => this.request<ProjectDto[]>('GET', '/api/projects');
  project = (id: string) => this.request<ProjectDto>('GET', `/api/projects/${id}`);
  /** Verify a folder is the project and pin it as its location on the device. */
  pinLocation = (projectId: string, device: string, path: string) => this.request<ProjectDto>('PUT', `/api/projects/${projectId}/locations`, { device, path });
  unpinLocation = (projectId: string, device: string, path: string) => this.request<ProjectDto>('DELETE', `/api/projects/${projectId}/locations`, undefined, { device, path });
  deviceFolders = (device: string) => this.request<DeviceFoldersDto>('GET', `/api/devices/${encodeURIComponent(device)}/folders`);

  // ----- repo sessions on GitHub, docs/DESIGN.md 30 -----
  /** Who the hub's GitHub token is. The token itself never comes back. */
  github = () => this.request<GithubStatusDto>('GET', '/api/github');
  /** Check a token with GitHub and keep it as the hub secret "github". */
  githubConnect = (token: string) => this.request<GithubStatusDto>('PUT', '/api/github/token', { token });
  githubDisconnect = () => this.request<GithubStatusDto>('DELETE', '/api/github/token');
  /** Repositories the token can see, most recently pushed first; q filters by name and description. */
  githubRepos = (q?: string, refresh = false) => this.request<GithubRepoDto[]>('GET', '/api/github/repos', undefined, { q: q || undefined, refresh: refresh || undefined });
  /** Branches of owner/name, the default branch first. */
  githubBranches = (repo: string) => {
    const [owner = '', name = ''] = repo.split('/');
    return this.request<GithubBranchesDto>('GET', `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`);
  };
  /** A session in a fresh worktree of a repository, on a new conclave/ branch. */
  createRepoSession = (input: RepoSessionInput) => this.request<Session>('POST', '/api/github/sessions', input);
  /** The session's repository, branch, pull request and checks. refresh reads GitHub first. */
  sessionRepo = (id: string, refresh = false) => this.request<RepoSessionDto>('GET', `/api/sessions/${id}/repo`, undefined, { refresh: refresh || undefined });
  pushSession = (id: string, input: PushInput = {}) => this.request<PushResult>('POST', `/api/sessions/${id}/repo/push`, input);
  /** A pull request title and body drafted from the session, to edit before opening it. */
  prDraft = (id: string) => this.request<PrDraft>('GET', `/api/sessions/${id}/repo/pr-draft`);
  openPullRequest = (id: string, input: OpenPrInput) => this.request<RepoSessionDto>('POST', `/api/sessions/${id}/repo/pr`, input);
  /** Remove the worktree; the branch stays on GitHub. discard drops the local branch too. */
  cleanupSession = (id: string, input: CleanupInput = {}) => this.request<RepoSessionDto>('POST', `/api/sessions/${id}/repo/cleanup`, input);
  /** Whether a folder on a device is in a git repository ("Run in a worktree" is offered then). */
  folderGit = (device: string, path: string) => this.request<FolderGitDto>('GET', '/api/worktrees/folder', undefined, { device, path });
  /** A session in a new worktree of a git folder, on a new conclave/ branch from its current branch. */
  createWorktreeSession = (input: WorktreeSessionInput) => this.request<Session>('POST', '/api/worktrees/sessions', input);
  /** Merge a folder worktree's branch into its base in the main checkout. */
  mergeSession = (id: string, input: MergeInput = {}) => this.request<RepoSessionDto>('POST', `/api/sessions/${id}/repo/merge`, input);
  deletePathPrefix = (id: string) => this.request<{ ok: true }>('DELETE', `/api/path-prefixes/${id}`);
  /** Sanitized: no reminders, memories, secrets or absolute paths. raw is the stored rows, for backups, and needs the owner token. */
  exportSession = (id: string, format: 'md' | 'json' = 'md', opts: ShareOptions & { raw?: boolean } = {}) =>
    this.request<{ content: string; filename: string; report?: RedactReport }>('GET', `/api/sessions/${id}/export`, undefined, { format, ...shareQuery(opts), raw: opts.raw ? 1 : undefined });
  /** The session and its subagents, sanitized and signed with the hub key, for another Conclave. */
  sessionBundle = (id: string, opts: ShareOptions = {}) => this.request<ConclaveBundle>('GET', `/api/sessions/${id}/bundle`, undefined, shareQuery(opts));
  search = (q: string) => this.request<Array<{ sessionId: string; messageId: string; snippet: string; title: string }>>('GET', '/api/search', undefined, { q });

  // ----- approvals and questions -----
  approvals = () => this.request<ApprovalRequest[]>('GET', '/api/approvals');
  resolveApproval = (id: string, response: ApprovalResponse) => this.request<{ ok: true }>('POST', `/api/approvals/${id}`, response);
  questions = () => this.request<QuestionRequest[]>('GET', '/api/questions');
  answerQuestion = (id: string, answers: Record<string, string>) => this.request<{ ok: true }>('POST', `/api/questions/${id}`, { answers });
  // ----- alerts: file conflicts and stuck turns -----
  alerts = () => this.request<AlertItem[]>('GET', '/api/alerts');
  /** stop or wait (Keep waiting) for a stuck turn, dismiss for a file conflict. */
  alertAction = (id: string, action: AlertAction) => this.request<{ ok: true }>('POST', `/api/alerts/${id}`, { action });

  // ----- models, agents, extensions -----
  models = () => this.request<ModelGroup[]>('GET', '/api/models');
  /** Ask each account (CLIProxyAPI) and harness for its model list again: the new list, and what could not be asked. */
  refreshModels = () => this.request<{ groups: ModelGroup[]; failed: string[] }>('POST', '/api/models/refresh');
  testProvider = (provider: string) => this.request<{ ok: boolean; detail: string; latencyMs?: number }>('POST', `/api/providers/${provider}/test`);
  /** An endpoint's model ids, probed as typed and not saved (Settings > Providers > Custom provider). */
  probeProvider = (p: { type: 'openai' | 'anthropic'; baseUrl: string; apiKey?: string }) => this.request<{ ok: boolean; models: string[]; detail?: string }>('POST', '/api/providers/probe', p);
  /** One tiny real request (1 token) to one model on that endpoint. */
  probeProviderModel = (p: { type: 'openai' | 'anthropic'; baseUrl: string; apiKey?: string; model: string }) => this.request<{ ok: boolean; detail: string; latencyMs?: number }>('POST', '/api/providers/probe-model', p);
  agents = () => this.request<AgentDef[]>('GET', '/api/agents');
  saveAgent = (def: Partial<AgentDef> & { name: string }, scope: 'user' | 'project' = 'user') => this.request<AgentDef>('PUT', `/api/agents/${encodeURIComponent(def.name)}`, { ...def, scope });
  deleteAgent = (name: string) => this.request<{ ok: true }>('DELETE', `/api/agents/${encodeURIComponent(name)}`);
  skills = () => this.request<SkillDef[]>('GET', '/api/skills');
  commands = () => this.request<CommandDef[]>('GET', '/api/commands');
  tools = () => this.request<ToolInfo[]>('GET', '/api/tools');
  mcp = () => this.request<McpStatus[]>('GET', '/api/mcp');
  plugins = () => this.request<InstalledPlugin[]>('GET', '/api/plugins');
  installPlugin = (source: string) => this.request<InstalledPlugin>('POST', '/api/plugins', { source });
  removePlugin = (name: string) => this.request<{ ok: true }>('DELETE', `/api/plugins/${encodeURIComponent(name)}`);
  setPluginEnabled = (name: string, enabled: boolean) => this.request<{ ok: true }>('PATCH', `/api/plugins/${encodeURIComponent(name)}`, { enabled });
  /** Hooks off keeps the plugin's skills, agents and commands. */
  setPluginHooks = (name: string, on: boolean) => this.request<{ ok: true }>('PATCH', `/api/plugins/${encodeURIComponent(name)}`, { hooks: on });
  marketplace = () => this.request<MarketplaceEntry[]>('GET', '/api/marketplace');
  addMarketplace = (source: string) => this.request<{ ok: true }>('POST', '/api/marketplace', { source });
  reloadExtensions = () => this.request<{ ok: true }>('POST', '/api/reload');
  syncToClis = (device?: string) => this.request<{ ok: true; written: string[] }>('POST', '/api/sync-clis', { device });

  // ----- agent defaults -----
  /** The shipped default of a built-in agent (404 for other names). Reset an edited copy with deleteAgent. */
  agentDefault = (name: string) => this.request<AgentDefaultInfo>('GET', `/api/agents/${encodeURIComponent(name)}/default`);

  // ----- extensions area -----
  extensionsOverview = (cwd?: string) => this.request<ExtensionsOverview>('GET', '/api/extensions/overview', undefined, { cwd });
  extensionsInventory = (q: { cwd?: string; kind?: ComponentKindDto } = {}) => this.request<InventoryItemDto[]>('GET', '/api/extensions/inventory', undefined, q as Query);
  /** The daily digest: on installs its routine, off disables it (notes already written stay). */
  memoryDigest = () => this.request<DigestSettingsDto>('GET', '/api/memory/digest');
  setMemoryDigest = (input: { enabled?: boolean; time?: string }) => this.request<DigestSettingsDto>('PUT', '/api/memory/digest', input);
  /** Skills agents wrote, on and off. */
  learnedSkills = () => this.request<LearnedSkillDto[]>('GET', '/api/skills/learned');
  learnedSkill = (name: string) => this.request<LearnedSkillDto>('GET', `/api/skills/learned/${encodeURIComponent(name)}`);
  /** Edit the description or the Markdown, or turn it on or off. */
  updateLearnedSkill = (name: string, patch: { description?: string; body?: string; enabled?: boolean }) => this.request<LearnedSkillDto>('PATCH', `/api/skills/learned/${encodeURIComponent(name)}`, patch);
  deleteLearnedSkill = (name: string) => this.request<{ ok: true }>('DELETE', `/api/skills/learned/${encodeURIComponent(name)}`);
  extensionSources = (cwd?: string) => this.request<ExtensionSourceInfo[]>('GET', '/api/extensions/sources', undefined, { cwd });
  /** Tools with MCP tools, per-agent access, the permission that applies and hook counts. */
  toolsDetail = (q: { cwd?: string; agent?: string } = {}) => this.request<ToolDetail[]>('GET', '/api/tools', undefined, q as Query);
  checkTool = (input: ToolCheckInput) => this.request<ToolCheckResult>('POST', '/api/tools/check', input);
  hooks = (cwd?: string) => this.request<HooksOverview>('GET', '/api/hooks', undefined, { cwd });
  testHook = (input: HookTestInput) => this.request<HookTestResult>('POST', '/api/hooks/test', input);
  /** Replace the hooks at one scope: user (config.json) or project (<cwd>/.conclave/settings.json). */
  saveHooks = (input: { scope: 'user' | 'project'; cwd?: string; hooks: HooksConfig }) => this.request<{ ok: true }>('PUT', '/api/hooks', input);
  /** Preview hooks converted from Gemini CLI or Codex settings; save them with saveHooks. */
  importHooks = (from: 'gemini' | 'codex', cwd?: string) => this.request<HookImportResult>('POST', '/api/hooks/import', { from, cwd });

  // ----- hook recipes, lint and built-in hooks, docs/design/ECOSYSTEM.md 2.2 -----
  hookRecipes = (cwd?: string) => this.request<HookRecipeDto[]>('GET', '/api/hooks/recipes', undefined, { cwd });
  hookRecipe = (id: string) => this.request<HookRecipeDetail>('GET', `/api/hooks/recipes/${encodeURIComponent(id)}`);
  /** Run the recipe's bundled tests in a temp fixture. Nothing is installed. */
  testHookRecipe = (id: string) => this.request<RecipeTestResult[]>('POST', `/api/hooks/recipes/${encodeURIComponent(id)}/test`);
  installHookRecipe = (id: string, req: RecipeInstallRequest) => this.request<RecipeInstallResult>('POST', `/api/hooks/recipes/${encodeURIComponent(id)}/install`, req);
  /** Remove the handlers tagged with the recipe, and the script when nothing else uses it. */
  removeHookRecipe = (id: string, where: RecipeRemoveWhere = {}) => this.request<{ ok: true; removed: number }>('DELETE', `/api/hooks/recipes/${encodeURIComponent(id)}`, undefined, where as Query);
  lintHooks = (hooks: unknown) => this.request<HookLintIssue[]>('POST', '/api/hooks/lint', { hooks });
  builtinHooks = () => this.request<BuiltinHookDto[]>('GET', '/api/hooks/builtin');
  setBuiltinHook = (id: BuiltinHookId, patch: { enabled?: boolean; budgetChars?: number }) => this.request<BuiltinHookDto>('PATCH', `/api/hooks/builtin/${encodeURIComponent(id)}`, patch);
  projectTrust = (cwd: string) => this.request<ProjectTrustInfo>('GET', '/api/trust', undefined, { cwd });
  setProjectTrust = (cwd: string, trusted: boolean) => this.request<ProjectTrustInfo>('POST', '/api/trust', { cwd, trusted });
  pluginDetail = (name: string) => this.request<PluginDetailDto>('GET', `/api/plugins/${encodeURIComponent(name)}`);
  updatePlugin = (name: string) => this.request<InstalledPlugin>('POST', `/api/plugins/${encodeURIComponent(name)}/update`);
  searchMarketplace = (q: { q?: string; category?: string; marketplace?: string } = {}) => this.request<MarketplaceSearchResult>('GET', '/api/marketplace/search', undefined, q as Query);
  restartMcp = (name: string) => this.request<McpStatus>('POST', `/api/mcp/${encodeURIComponent(name)}/restart`);
  testMcp = (name: string) => this.request<McpTestResult>('POST', `/api/mcp/${encodeURIComponent(name)}/test`);
  mcpTools = (name: string) => this.request<McpToolDto[]>('GET', `/api/mcp/${encodeURIComponent(name)}/tools`);
  callMcpTool = (name: string, tool: string, args: Record<string, unknown> = {}) => this.request<McpCallResult>('POST', `/api/mcp/${encodeURIComponent(name)}/call`, { tool, args });
  /** Add a server to config.json (user scope). */
  addMcpServer = (name: string, config: McpServerConfig) => this.request<McpStatus>('POST', '/api/mcp', { name, config, scope: 'user' });
  updateMcpServer = (name: string, patch: { enabled?: boolean; config?: McpServerConfig }) => this.request<McpStatus>('PATCH', `/api/mcp/${encodeURIComponent(name)}`, patch);
  removeMcpServer = (name: string) => this.request<{ ok: true }>('DELETE', `/api/mcp/${encodeURIComponent(name)}`);
  /** Parse another CLI's MCP config for a preview. Nothing is saved. */
  importMcp = (from: McpImportFormat, text: string) => this.request<Record<string, McpServerConfig>>('POST', '/api/mcp/import', { from, text });
  mcpConnectPlan = (name: string) => this.request<McpConnectStepDto[]>('GET', `/api/mcp/${encodeURIComponent(name)}/connect`);
  /** Run the connect commands on a device. Ask the user first: this changes those CLIs' config. */
  connectMcp = (name: string, device: string, clis: CliName[]) => this.request<McpConnectRunResult[]>('POST', `/api/mcp/${encodeURIComponent(name)}/connect`, { device, clis });
  syncClis = (opts: SyncClisOptions = {}) => this.request<{ ok: true; written: string[]; dryRun: boolean }>('POST', '/api/sync-clis', opts);
  mcpServerSnippets = () => this.request<McpServerSnippets>('GET', '/api/mcp-server/snippets');
  /** A sign in request from an app that wants /mcp. Each read makes a new consent value. */
  oauthRequest = (id: string) => this.request<OAuthConsentDto>('GET', `/api/oauth/requests/${encodeURIComponent(id)}`);
  /** Answer a sign in request. The reply is the URL to send the browser to. */
  oauthDecide = (id: string, input: OAuthDecisionInput) => this.request<{ redirect: string }>('POST', `/api/oauth/requests/${encodeURIComponent(id)}`, input);
  connectedApps = () => this.request<ConnectedAppDto[]>('GET', '/api/oauth/apps');
  /** End an app's access: its tokens and its registration go. */
  revokeConnectedApp = (id: string) => this.request<{ ok: true }>('DELETE', `/api/oauth/apps/${encodeURIComponent(id)}`);

  // ----- tasks -----
  tasks = (q?: { status?: TaskStatus; agent?: string; project?: string }) => this.request<Task[]>('GET', '/api/tasks', undefined, q as Query);
  createTask = (t: Partial<Task> & { title: string }) => this.request<Task>('POST', '/api/tasks', t);
  updateTask = (id: string, patch: Partial<Task>) => this.request<Task>('PATCH', `/api/tasks/${id}`, patch);
  deleteTask = (id: string) => this.request<{ ok: true }>('DELETE', `/api/tasks/${id}`);
  startTask = (id: string, opts: { agent?: string; model?: string; device?: string; cwd?: string } = {}) => this.request<Session>('POST', `/api/tasks/${id}/start`, opts);

  // ----- routines -----
  routines = () => this.request<Routine[]>('GET', '/api/routines');
  createRoutine = (input: RoutineInput) => this.request<Routine>('POST', '/api/routines', input);
  updateRoutine = (id: string, patch: Partial<RoutineInput>) => this.request<Routine>('PATCH', `/api/routines/${id}`, patch);
  deleteRoutine = (id: string) => this.request<{ ok: true }>('DELETE', `/api/routines/${id}`);
  runRoutine = (id: string) => this.request<RoutineRun>('POST', `/api/routines/${id}/run`);
  routineRuns = (id: string) => this.request<RoutineRun[]>('GET', `/api/routines/${id}/runs`);
  routineTemplates = () => this.request<Array<RoutineInput & { id: string; description: string }>>('GET', '/api/routines/templates');
  previewSchedule = (schedule: string, timezone?: string) => this.request<{ next: number[]; error?: string }>('GET', '/api/routines/preview', undefined, { schedule, timezone });
  /** Suggested routines with what is added, missing and still waiting on a hub update (ECOSYSTEM.md 2.3). */
  routineSuggestions = () => this.request<RoutineSuggestionsDto>('GET', '/api/routines/suggestions');
  /** Creates the suggested agent when it is missing, then one routine per device. */
  addRoutineSuggestion = (id: string, req: AddSuggestionRequest) => this.request<AddSuggestionResult>('POST', `/api/routines/suggestions/${encodeURIComponent(id)}/add`, req);

  /** Give a routine its template's current prompt and rules, also when its prompt was edited. */
  upgradeRoutine = (id: string) => this.request<Routine>('POST', `/api/routines/${id}/upgrade`);

  // ----- goals and the assistant, docs/design/ROUND-LIFE-ASSISTANT.md -----
  goals = (q?: { status?: GoalStatus | 'all'; area?: GoalArea }) => this.request<GoalSummary[]>('GET', '/api/goals', undefined, q as Query);
  goal = (id: string) => this.request<GoalDetail>('GET', `/api/goals/${id}`);
  createGoal = (input: GoalInput) => this.request<Goal>('POST', '/api/goals', input);
  updateGoal = (id: string, patch: GoalPatch) => this.request<Goal>('PATCH', `/api/goals/${id}`, patch);
  deleteGoal = (id: string) => this.request<{ ok: true }>('DELETE', `/api/goals/${id}`);
  addGoalEntry = (id: string, entry: { text: string; date?: string }) => this.request<GoalEntry>('POST', `/api/goals/${id}/entries`, entry);
  deleteGoalEntry = (id: string, entryId: string) => this.request<{ ok: true }>('DELETE', `/api/goals/${id}/entries/${entryId}`);
  assistantSettings = () => this.request<AssistantSettingsDto>('GET', '/api/assistant');
  /** The account's one assistant thread (meta.home), made the first time; the same session as GET /api/sessions/:id. */
  assistantHome = () => this.request<Session>('GET', '/api/assistant/home');
  setAssistantPrefs = (patch: PrefsPatch) => this.request<AssistantSettingsDto>('PATCH', '/api/assistant/prefs', patch);
  setHeartbeat = (input: { enabled?: boolean; checklist?: string }) => this.request<AssistantSettingsDto>('PUT', '/api/assistant/heartbeat', input);
  setReflection = (input: { enabled?: boolean }) => this.request<AssistantSettingsDto>('PUT', '/api/assistant/reflection', input);
  // Settings > Reflect: the same switch, plus its time, model, notes and Reflect now
  reflect = () => this.request<ReflectDto>('GET', '/api/assistant/reflect');
  setReflect = (patch: ReflectPatch) => this.request<ReflectDto>('PUT', '/api/assistant/reflect', patch);
  /** The hub's owner only. Starts one reflection with the night's rules; returns as soon as it started. */
  reflectNow = () => this.request<ReflectNowDto>('POST', '/api/assistant/reflect/run');
  today = () => this.request<TodayDto>('GET', '/api/assistant/today');
  answerToday = (option: string) => this.request<{ plan: DayPlan; sessionId?: string }>('POST', '/api/assistant/today/answer', { option });

  // ----- maps: places, directions, map images (Settings > Maps) -----
  mapsSettings = () => this.request<MapsSettingsDto>('GET', '/api/maps');
  setMapsSettings = (patch: MapsSettingsPatch) => this.request<MapsSettingsDto>('PATCH', '/api/maps', patch);
  /** Store the Google Maps key on the hub, or remove it with null. The reply only says whether one is set. */
  setMapsKey = (key: string | null) => this.request<MapsSettingsDto>('PUT', '/api/maps/key', { key });
  testMaps = () => this.request<MapsTestResult>('POST', '/api/maps/test');

  // ----- web search: the engine WebSearch uses (Settings > Web search) -----
  webSearchSettings = () => this.request<WebSearchSettingsDto>('GET', '/api/websearch');
  setWebSearchSettings = (patch: WebSearchSettingsPatch) => this.request<WebSearchSettingsDto>('PATCH', '/api/websearch', patch);
  /** Store an engine's key on the hub, or remove it with null. The reply only says whether one is set. */
  setWebSearchKey = (provider: string, key: string | null) => this.request<WebSearchSettingsDto>('PUT', '/api/websearch/key', { provider, key });
  /** One real query on the engine (the one in use when none is named). */
  testWebSearch = (provider?: string) => this.request<WebSearchTestResult>('POST', '/api/websearch/test', { provider });
  leaveBy = (date?: string) => this.request<LeaveByDto>('GET', '/api/maps/leave-by', undefined, { date });
  // ----- watches (Routines) and the hub's browser (Settings > Browser) -----
  watches = () => this.request<WatchSummaryDto[]>('GET', '/api/watches');
  watch = (id: string) => this.request<WatchDetailDto>('GET', `/api/watches/${encodeURIComponent(id)}`);
  /** An item's photo, fetched and kept by the hub. */
  watchImage = (routineId: string, itemId: string): Promise<Blob> => this.blob(`/api/watches/${encodeURIComponent(routineId)}/items/${encodeURIComponent(itemId)}/image`);
  /** The photo on a chat's item card (an item that chat reported). */
  chatItemImage = (sessionId: string, itemId: string): Promise<Blob> => this.blob(`/api/watches/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/image`);
  browserStatus = () => this.request<BrowserStatusDto>('GET', '/api/browser');
  /** Open a remote view of a profile's page to sign in to a site. */
  openSignIn = (profile: string, url: string) => this.request<SignInViewDto>('POST', '/api/browser/signin', { profile, url });
  /** The view's newest frame after `after`, or undefined when there is none newer. */
  signInFrame = (id: string, after: number) => this.request<SignInFrameDto | undefined>('GET', `/api/browser/signin/${encodeURIComponent(id)}/frame`, undefined, { after });
  signInInput = (id: string, events: BrowserInputEvent[]) => this.request<{ ok: true }>('POST', `/api/browser/signin/${encodeURIComponent(id)}/input`, { events });
  /** Signed in: the hub remembers the sites for the profile and closes the view. */
  signInDone = (id: string) => this.request<BrowserStatusDto>('POST', `/api/browser/signin/${encodeURIComponent(id)}/done`);
  closeSignIn = (id: string) => this.request<{ ok: true }>('DELETE', `/api/browser/signin/${encodeURIComponent(id)}`);
  /** A chat session's browser: whether it has a tab open and whether the owner holds it. Opens nothing. */
  browserLive = (sessionId: string) => this.request<BrowserLiveDto>('GET', `/api/browser/sessions/${encodeURIComponent(sessionId)}`);
  /** The newest frame of the session's tab after `after`, or undefined when there is none newer. */
  browserLiveFrame = (sessionId: string, after: number) => this.request<SignInFrameDto | undefined>('GET', `/api/browser/sessions/${encodeURIComponent(sessionId)}/frame`, undefined, { after });
  /** Input to the session's tab; only while the owner holds it (browserControl take). */
  browserLiveInput = (sessionId: string, events: BrowserInputEvent[]) => this.request<{ ok: true }>('POST', `/api/browser/sessions/${encodeURIComponent(sessionId)}/input`, { events });
  /** Take over (the session's browser tools wait) or give back. */
  browserControl = (sessionId: string, take: boolean) => this.request<BrowserLiveDto>('POST', `/api/browser/sessions/${encodeURIComponent(sessionId)}/control`, { take });
  /** Stop watching: the frames stop and a held browser goes back to the agent. */
  closeBrowserLive = (sessionId: string) => this.request<{ ok: true }>('DELETE', `/api/browser/sessions/${encodeURIComponent(sessionId)}/frame`);
  /** Install on the hub: run the steps the owner confirmed, exactly as shown. */
  browserSetup = (target: BrowserSetupTarget, steps: string[]) => this.request<BrowserSetupResult>('POST', '/api/browser/setup', { target, steps });
  /** Install system libraries: the root helper's browser-deps, the line the owner confirmed. */
  browserLibs = (steps: string[]) => this.request<BrowserLibsResult>('POST', '/api/browser/libs', { steps });
  /** A profile's engine. */
  updateBrowserProfile = (name: string, update: BrowserProfileUpdate) => this.request<BrowserStatusDto>('PUT', `/api/browser/profiles/${encodeURIComponent(name)}`, update);
  /** The hub's proxy. A login or password goes to the hub's secrets. */
  updateBrowserProxy = (update: BrowserProxyUpdate) => this.request<BrowserStatusDto>('PUT', '/api/browser/proxy', update);
  /** The exit IP and country through the hub's proxy, for a country or its default. */
  testBrowserProxy = (country?: string) => this.request<BrowserProxyTestDto>('POST', '/api/browser/proxy/test', country ? { country } : {});
  /** Save a login the hub fills itself (browser_login). The password and 2FA key go to the hub's secrets, encrypted, and never come back. */
  addBrowserLogin = (input: BrowserLoginInput) => this.request<BrowserStatusDto>('POST', '/api/browser/logins', input);
  /** Change a saved login. A password or 2FA key given replaces the saved one; left out keeps it. */
  updateBrowserLogin = (id: string, input: BrowserLoginInput) => this.request<BrowserStatusDto>('PUT', `/api/browser/logins/${encodeURIComponent(id)}`, input);
  deleteBrowserLogin = (id: string) => this.request<BrowserStatusDto>('DELETE', `/api/browser/logins/${encodeURIComponent(id)}`);
  /** Clear a site's cookies and storage in a profile. A saved login stays. */
  forgetBrowserSite = (profile: string, host: string) => this.request<BrowserStatusDto>('POST', `/api/browser/profiles/${encodeURIComponent(profile)}/forget`, { host });
  /** Import a cookie export's text into a profile. Answers counts per site, never a cookie. */
  importBrowserCookies = (profile: string, file: string) => this.request<BrowserCookieImportResult>('POST', `/api/browser/profiles/${encodeURIComponent(profile)}/cookies`, { file });
  /** Delete a profile with its folder and saved logins. close: close it first when a session has it open; without, that answers 409. */
  deleteBrowserProfile = (name: string, close = false) => this.request<BrowserStatusDto>('DELETE', `/api/browser/profiles/${encodeURIComponent(name)}`, undefined, close ? { close: 1 } : undefined);

  private blob = async (path: string): Promise<Blob> => {
    const check = this.guard();
    if (check) await check;
    const res = await this.f(`${this.baseUrl}${path}`, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, msg);
    }
    return res.blob();
  };

  /** A map card's picture: a PNG from Google or an SVG drawn from OpenStreetMap tiles, fetched by the hub. */
  mapImage = async (id: string): Promise<Blob> => {
    const check = this.guard();
    if (check) await check;
    const res = await this.f(`${this.baseUrl}/api/maps/image/${encodeURIComponent(id)}`, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, msg);
    }
    return res.blob();
  };

  /** A file a ShareFile call shared (GET /api/sessions/:id/files/:toolUseId), as a Blob of its bytes. */
  sessionFile = async (id: string, toolUseId: string, inline = false): Promise<Blob> => {
    const check = this.guard();
    if (check) await check;
    const res = await this.f(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/files/${encodeURIComponent(toolUseId)}${inline ? '?inline=1' : ''}`, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, msg);
    }
    return res.blob();
  };
  // ----- calendar and mail, docs/DESIGN.md "Calendar and mail" -----
  pimSettings = () => this.request<PimSettingsDto>('GET', '/api/pim');
  addCaldav = (input: { preset?: CaldavPreset; serverUrl: string; username: string; password: string; label?: string }) => this.request<PimAccountDto>('POST', '/api/pim/accounts/caldav', input);
  addImap = (input: { preset?: string; host: string; port?: number; security?: MailSecurity; username: string; password: string; address?: string; label?: string; draftsFolder?: string; smtp?: { host: string; port?: number; security?: MailSecurity }; send?: boolean }) => this.request<PimAccountDto>('POST', '/api/pim/accounts/imap', input);
  updatePimAccount = (id: string, patch: { label?: string; drafts?: boolean; send?: boolean; autoDraft?: boolean; signature?: string; password?: string; calendars?: Array<{ remoteId: string; read?: boolean; write?: boolean }> }) => this.request<PimAccountDto>('PATCH', `/api/pim/accounts/${id}`, patch);
  testPimAccount = (id: string) => this.request<PimAccountDto>('POST', `/api/pim/accounts/${id}/test`);
  removePimAccount = (id: string) => this.request<{ revoked: boolean; note?: string }>('DELETE', `/api/pim/accounts/${id}`);
  setOAuthClients = (input: { googleWebClientId?: string; googleWebSecret?: string; googleDesktopClientId?: string; googleDesktopSecret?: string; microsoftClientId?: string }) => this.request<PimSettingsDto>('PUT', '/api/pim/oauth/clients', input);
  /** origin: with client relay, the hub address this page uses, which the relay page sends the browser back to. */
  startGoogleSignIn = (input: PimWants & { client: OAuthClientKind; redirectUri?: string; origin?: string; accountId?: string; loginHint?: string }) =>this.request<OAuthFlowDto>('POST', '/api/pim/oauth/google/start', input);
  finishGoogleSignIn = (input: { state: string; code?: string; error?: string; tokens?: { refreshToken: string; accessToken?: string; expiresIn?: number; scope?: string } }) => this.request<OAuthFlowDto>('POST', '/api/pim/oauth/google/finish', input);
  startMicrosoftSignIn = (input: PimWants & { accountId?: string }) => this.request<OAuthFlowDto>('POST', '/api/pim/oauth/microsoft/start', input);
  pimSignIn = (id: string) => this.request<OAuthFlowDto>('GET', `/api/pim/oauth/flows/${id}`);
  cancelPimSignIn = (id: string) => this.request<{ ok: true }>('DELETE', `/api/pim/oauth/flows/${id}`);
  proposals = (status: ProposalStatus | 'all' = 'pending') => this.request<ProposalDto[]>('GET', '/api/proposals', undefined, { status });
  approveProposal = (id: string) => this.request<ProposalDto>('POST', `/api/proposals/${id}/approve`);
  declineProposal = (id: string, note?: string) => this.request<ProposalDto>('POST', `/api/proposals/${id}/decline`, note ? { note } : {});

  // ----- memory -----
  memories = (q?: { scope?: MemoryScope; kind?: MemoryKind; limit?: number; offset?: number }) => this.request<MemoryEntry[]>('GET', '/api/memory', undefined, q as Query);
  searchMemory = (query: string, limit = 20) => this.request<MemoryHit[]>('GET', '/api/memory/search', undefined, { q: query, limit });
  saveMemory = (m: { content: string; kind?: MemoryKind; scope?: MemoryScope; scopeKey?: string; tags?: string[] }) => this.request<MemoryEntry>('POST', '/api/memory', m);
  updateMemory = (id: string, patch: Partial<MemoryEntry>) => this.request<MemoryEntry>('PATCH', `/api/memory/${id}`, patch);
  deleteMemory = (id: string) => this.request<{ ok: true }>('DELETE', `/api/memory/${id}`);
  memoryStats = () => this.request<{ total: number; byKind: Record<string, number>; external?: string }>('GET', '/api/memory/stats');
  /** Same route as memoryStats, typed with the connection list. */
  memoryOverview = () => this.request<MemoryStatsDto>('GET', '/api/memory/stats');
  /** The memory map: Conclave memories and Basic Memory notes with their real links (owner only). */
  memoryGraph = (limit?: number) => this.request<MemoryGraph>('GET', '/api/memory/graph', undefined, limit ? { limit } : undefined);

  // ----- memory connections -----
  memoryConnections = () => this.request<MemoryConnectionInfo[]>('GET', '/api/memory/connections');
  memoryConnectionPresets = () => this.request<MemoryConnectionPreset[]>('GET', '/api/memory/connections/presets');
  memoryConnection = (id: string) => this.request<MemoryConnectionInfo>('GET', `/api/memory/connections/${encodeURIComponent(id)}`);
  addMemoryConnection = (input: MemoryConnectionInputDto) => this.request<MemoryConnectionInfo>('POST', '/api/memory/connections', input);
  /** Fields sent as ******** keep their saved value. */
  updateMemoryConnection = (id: string, patch: Partial<MemoryConnectionConfigDto>) => this.request<MemoryConnectionInfo>('PATCH', `/api/memory/connections/${encodeURIComponent(id)}`, patch);
  /** Also removes the notes it imported unless keepImported. */
  removeMemoryConnection = (id: string, keepImported = false) => this.request<{ ok: true }>('DELETE', `/api/memory/connections/${encodeURIComponent(id)}`, undefined, { keepImported: keepImported ? 1 : undefined });
  testMemoryConnection = (id: string) => this.request<MemoryConnectionTestResult>('POST', `/api/memory/connections/${encodeURIComponent(id)}/test`);
  /** Test a config from the form before saving it. */
  testMemoryConnectionConfig = (input: MemoryConnectionInputDto) => this.request<MemoryConnectionTestResult>('POST', '/api/memory/connections/test', input);
  syncMemoryConnection = (id: string) => this.request<MemorySyncResult>('POST', `/api/memory/connections/${encodeURIComponent(id)}/sync`);
  /** Basic Memory: write grouped notes instead of one note per fact; deletePerFact removes the old notes Conclave wrote. */
  groupMemoryNotes = (id: string, deletePerFact = false) =>
    this.request<{ notes: number; perFact: number; deleted: number; canDelete: boolean; errors: string[] }>('POST', `/api/memory/connections/${encodeURIComponent(id)}/group`, { deletePerFact });
  clearImportedMemory = (id: string) => this.request<{ ok: true; removed: number }>('DELETE', `/api/memory/connections/${encodeURIComponent(id)}/imported`);
  /** Commands to add this store (an MCP-based connection) to Claude Code, Codex, OpenCode and Gemini CLI. */
  memoryConnectionConnectPlan = (id: string) => this.request<McpConnectStepDto[]>('GET', `/api/memory/connections/${encodeURIComponent(id)}/connect`);
  /** Read CLAUDE.md, AGENTS.md, GEMINI.md and similar files on a device and save what is worth keeping. Can take a while. */
  importMemoryFiles = (input: MemoryFileImportInput = {}) => this.request<MemoryFileImportResult>('POST', '/api/memory/import', input);
  exportMemory = (q: MemoryExportOptions = {}) => this.request<MemoryMarkdownExport>('GET', '/api/memory/export', undefined, { layout: q.layout, includeImported: q.includeImported ? 1 : undefined, root: q.root });
  /** Write the export into a folder on a device (a git repo, a Basic Memory project). */
  exportMemoryTo = (input: MemoryExportOptions & { dir: string; device?: string }) => this.request<{ dir: string; files: string[]; count: number }>('POST', '/api/memory/export', input);

  // ----- usage -----
  usage = (q: { from?: number; to?: number; tzOffset?: number } = {}) => this.request<UsageSummary>('GET', '/api/usage', undefined, q as Query);
  usageRecent = (limit = 100) => this.request<UsageRecord[]>('GET', '/api/usage/recent', undefined, { limit });
  limits = () => this.request<LimitState[]>('GET', '/api/limits');
  refreshLimits = () => this.request<LimitState[]>('POST', '/api/limits/refresh');

  // ----- devices -----
  devices = () => this.request<Device[]>('GET', '/api/devices');
  /** The computer this app runs on, when the hub can tell (a daemon from the same address, or the hub's own computer). */
  deviceHere = () => this.request<{ device?: string }>('GET', '/api/devices/here');
  /** The hub's own device ("local") takes only a name, and only from the owner token. */
  updateDevice = (id: string, patch: { name?: string; roots?: string[] }) => this.request<Device>('PATCH', `/api/devices/${id}`, patch);
  deleteDevice = (id: string) => this.request<{ ok: true }>('DELETE', `/api/devices/${id}`);
  browse = (device: string, path: string) => this.request<FileEntryDto[]>('GET', `/api/devices/${device}/files`, undefined, { path });
  readDeviceFile = (device: string, path: string) => this.request<{ content: string; truncated: boolean }>('GET', `/api/devices/${device}/file`, undefined, { path });
  externalSessions = (device = 'local') => this.request<ExternalSessionInfo[]>('GET', '/api/import/sessions', undefined, { device });
  importSession = (source: ExternalSessionInfo['source'], id: string, device = 'local') => this.request<Session>('POST', '/api/import', { source, id, device });

  // ----- chat import: block "import", docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.13 -----
  importScan = (q: ImportScanQuery = {}) =>
    this.request<ImportScanPage>('GET', '/api/import/scan', undefined, {
      ...q,
      sources: q.sources?.join(','),
      kinds: q.kinds?.join(','),
      includeImported: q.includeImported === undefined ? undefined : q.includeImported ? 1 : 0,
      includeSkipped: q.includeSkipped === undefined ? undefined : q.includeSkipped ? 1 : 0,
      refresh: q.refresh ? 1 : undefined,
    } as Query);
  importEstimate = (input: ImportEstimateInput) => this.request<ImportEstimate>('POST', '/api/import/estimate', input);
  startImport = (input: ImportBatchInput) => this.request<ImportBatch>('POST', '/api/import/batches', input);
  importBatches = () => this.request<ImportBatchesDto>('GET', '/api/import/batches');
  importBatch = (id: string, cursor?: string) => this.request<ImportBatchDetail>('GET', `/api/import/batches/${encodeURIComponent(id)}`, undefined, { cursor });
  pauseImport = (id: string) => this.request<ImportBatch>('POST', `/api/import/batches/${encodeURIComponent(id)}/pause`);
  resumeImport = (id: string) => this.request<ImportBatch>('POST', `/api/import/batches/${encodeURIComponent(id)}/resume`);
  cancelImport = (id: string) => this.request<ImportBatch>('POST', `/api/import/batches/${encodeURIComponent(id)}/cancel`);
  undoImport = (id: string) => this.request<ImportUndoResult>('POST', `/api/import/batches/${encodeURIComponent(id)}/undo`);
  /** A claude.ai or ChatGPT export: the zip, or its conversations.json. */
  uploadImport = async (source: 'claude-ai' | 'chatgpt', file: Blob | ArrayBuffer | Uint8Array, name?: string): Promise<ImportUploadResult> => {
    const check = this.guard();
    if (check) await check;
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.f(`${this.baseUrl}/api/import/upload${qs({ source, name })}`, { method: 'POST', headers, body: file as BodyInit });
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, data);
    return data as ImportUploadResult;
  };
  syncImported = (sessionId: string) => this.request<ImportSyncResult>('POST', `/api/import/sessions/${encodeURIComponent(sessionId)}/sync`);
  importRetention = (device = 'local') => this.request<ImportRetention[]>('GET', '/api/import/retention', undefined, { device });
  fixImportRetention = (device: string, tool: ImportRetention['tool']) => this.request<ImportRetention[]>('POST', '/api/import/retention', { device, tool });
  /** Offers to import a newly paired computer's chats, open ones only (import/offers.ts). */
  importOffers = () => this.request<ImportOffer[]>('GET', '/api/import/offers');
  /** Not now: the device is not offered again. */
  dismissImportOffer = (device: string) => this.request<{ ok: true }>('POST', `/api/import/offers/${encodeURIComponent(device)}/dismiss`);
  memoryReview = () => this.request<MemoryReviewItem[]>('GET', '/api/memory/review');
  answerMemoryReview = (answer: { accept?: string[]; reject?: string[] }) => this.request<{ accepted: number; rejected: number }>('POST', '/api/memory/review', answer);

  // ----- workflows: block "workflows", docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.17 -----
  workflows = () => this.request<WorkflowSummary[]>('GET', '/api/workflows');
  workflow = (id: string) => this.request<WorkflowDetail>('GET', `/api/workflows/${encodeURIComponent(id)}`);
  /** Saved args presets for one workflow, for the launch form. */
  workflowPresets = (id: string) => this.request<WorkflowPreset[]>('GET', `/api/workflows/${encodeURIComponent(id)}/presets`);
  saveWorkflowPreset = (id: string, name: string, args: unknown) => this.request<WorkflowPreset>('POST', `/api/workflows/${encodeURIComponent(id)}/presets`, { name, args });
  deleteWorkflowPreset = (id: string, presetId: string) => this.request<{ ok: true }>('DELETE', `/api/workflows/${encodeURIComponent(id)}/presets/${encodeURIComponent(presetId)}`);
  startWorkflow = (input: StartWorkflowInput) => this.request<WorkflowRun>('POST', '/api/workflows/runs', input);
  workflowRuns = (q: WorkflowRunsQuery = {}) => this.request<WorkflowRun[]>('GET', '/api/workflows/runs', undefined, q as Query);
  workflowRun = (id: string) => this.request<WorkflowRunDetail>('GET', `/api/workflows/runs/${encodeURIComponent(id)}`);
  pauseWorkflow = (id: string) => this.request<WorkflowRun>('POST', `/api/workflows/runs/${encodeURIComponent(id)}/pause`);
  resumeWorkflow = (id: string) => this.request<WorkflowRun>('POST', `/api/workflows/runs/${encodeURIComponent(id)}/resume`);
  stopWorkflow = (id: string) => this.request<WorkflowRun>('POST', `/api/workflows/runs/${encodeURIComponent(id)}/stop`);
  /** Run again from call fromSeq: earlier calls replay from the journal. */
  rerunWorkflow = (id: string, fromSeq: number) => this.request<WorkflowRun>('POST', `/api/workflows/runs/${encodeURIComponent(id)}/rerun`, { fromSeq });
  skipWorkflowCall = (id: string, seq: number) => this.request<WorkflowRun>('POST', `/api/workflows/runs/${encodeURIComponent(id)}/calls/${seq}/skip`);
  workflowWorktree = (id: string, seq: number, action: WorktreeAction) => this.request<WorktreeActionResult>('POST', `/api/workflows/runs/${encodeURIComponent(id)}/calls/${seq}/worktree`, { action });
  judgeFinding = (id: string, findingId: string, verdict: FindingVerdict, reason?: string) =>
    this.request<WorkflowFinding>('POST', `/api/workflows/runs/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}`, { verdict, reason });

  // ----- subscriptions: CLIProxyAPI sign-in, Settings > Models > Subscriptions -----
  subscriptions = () => this.request<SubscriptionsStatus>('GET', '/api/subscriptions');
  /** Turn it off, run the built-in one, or use one you run (url and key). */
  setSubscriptions = (input: SubscriptionsSettingsInput) => this.request<SubscriptionsStatus>('PUT', '/api/subscriptions', input);
  /** builtin: install the newer CLIProxyAPI this hub pins. It goes back to the old one when the new one does not start. */
  updateSubscriptions = () => this.request<SubscriptionsStatus>('POST', '/api/subscriptions/update');
  /** Start signing in: open `url` in a new tab, then poll signInStatus. */
  startSignIn = (provider: string) => this.request<SignInStartDto>('POST', '/api/subscriptions/signin', { provider });
  signInStatus = (state: string) => this.request<SignInStatusDto>('GET', `/api/subscriptions/signin/${encodeURIComponent(state)}`);
  /** The address the browser bar shows after the provider's localhost redirect failed to load. */
  finishSignIn = (state: string, url: string) => this.request<SignInStatusDto>('POST', `/api/subscriptions/signin/${encodeURIComponent(state)}/callback`, { url });
  cancelSignIn = (state: string) => this.request<SignInStatusDto>('DELETE', `/api/subscriptions/signin/${encodeURIComponent(state)}`);
  removeSubscriptionAccount = (name: string) => this.request<SubscriptionsStatus>('DELETE', `/api/subscriptions/accounts/${encodeURIComponent(name)}`);
  refreshSubscriptionAccount = (name: string) => this.request<SubscriptionsStatus>('POST', `/api/subscriptions/accounts/${encodeURIComponent(name)}/refresh`);

  // ----- accounts and their order: Settings > Models > Accounts -----
  accounts = () => this.request<AccountsStatus>('GET', '/api/accounts');
  /** Read the plans' usage and the accounts again now. */
  refreshAccounts = () => this.request<AccountsStatus>('POST', '/api/accounts/refresh');
  /** The order for a vendor (or a model match): first used first. */
  setAccountOrder = (input: AccountOrderInput) => this.request<AccountsStatus>('PUT', '/api/accounts/order', input);
  /** Label, pause (enabled false) and the budget of an API key. */
  updateAccount = (id: string, patch: AccountPatch) => this.request<AccountsStatus>('PATCH', `/api/accounts/${encodeURIComponent(id)}`, patch);
  /** Remove a saved plan CLIProxyAPI no longer lists: its entry, its place in every order, refusal fallback entries pinned to it. */
  removeAccount = (id: string) => this.request<AccountsStatus>('DELETE', `/api/accounts/${encodeURIComponent(id)}`);
  /** Clear CLIProxyAPI's cooldown on a signed in account so the next call tries it. */
  tryAccountNow = (id: string) => this.request<AccountsStatus>('POST', `/api/accounts/${encodeURIComponent(id)}/try`);
  /** A signed in plan's short name (its CLIProxyAPI prefix: ids also as neu/claude-opus-5-5). Empty removes it. */
  setAccountPrefix = (id: string, prefix: string) => this.request<AccountsStatus>('PUT', `/api/accounts/${encodeURIComponent(id)}/prefix`, { prefix } satisfies AccountPrefixInput);

  // ----- friends: hub to hub, docs/design/FRIENDS.md -----
  friends = () => this.request<FriendDto[]>('GET', '/api/friends');
  friend = (id: string) => this.request<FriendDto>('GET', `/api/friends/${encodeURIComponent(id)}`);
  /** Can a friend's hub reach this one: the remote access mode and the address friends get. */
  friendReachability = () => this.request<FriendReachability>('GET', '/api/friends/reachability');
  /** A one time link and QR code, valid 24 hours. */
  createFriendInvite = (input: FriendInviteInput = {}) => this.request<FriendInvite>('POST', '/api/friends/invites', input);
  /** Use a friend's link: the hub checks their hub's key, then sends the request. */
  acceptFriendInvite = (link: string, name?: string) => this.request<FriendDto>('POST', '/api/friends/accept', { link, name });
  /** Accept a pending request from another hub. */
  acceptFriend = (id: string) => this.request<FriendDto>('POST', `/api/friends/${encodeURIComponent(id)}/accept`);
  declineFriend = (id: string) => this.request<{ ok: true }>('POST', `/api/friends/${encodeURIComponent(id)}/decline`);
  /** The owner compared the safety code (false takes the mark away). */
  verifyFriend = (id: string, verified = true) => this.request<FriendDto>('POST', `/api/friends/${encodeURIComponent(id)}/verify`, { verified });
  setFriendGrants = (id: string, grants: Partial<FriendGrants>) => this.request<FriendDto>('PUT', `/api/friends/${encodeURIComponent(id)}/grants`, grants);
  renameFriend = (id: string, name: string) => this.request<FriendDto>('PATCH', `/api/friends/${encodeURIComponent(id)}`, { name });
  /** Take the new key a blocked friend's hub showed. */
  confirmFriendKey = (id: string) => this.request<FriendDto>('POST', `/api/friends/${encodeURIComponent(id)}/confirm-key`);
  /** Send what waits and fetch what the friend's hub holds for this one, now. */
  syncFriend = (id: string) => this.request<FriendDto>('POST', `/api/friends/${encodeURIComponent(id)}/sync`);
  /** Stop being friends: the outbox is cancelled and the friend's hub is told, best effort. */
  removeFriend = (id: string) => this.request<{ ok: true }>('DELETE', `/api/friends/${encodeURIComponent(id)}`);
  sendFriendNote = (id: string, text: string) => this.request<OutboxItemDto>('POST', `/api/friends/${encodeURIComponent(id)}/notes`, { text });
  /** Mark a friend's notes and share cards read up to an id (a note's, or a received share's), or all of them. Every device of the owner sees it. */
  markFriendRead = (id: string, upTo?: string) => this.request<FriendDto>('POST', `/api/friends/${encodeURIComponent(id)}/read`, upTo ? { upTo } : {});
  friendOutbox = (friend?: string) => this.request<OutboxItemDto[]>('GET', '/api/friends/outbox', undefined, { friend });
  friendInbox = (friend?: string) => this.request<InboxItemDto[]>('GET', '/api/friends/inbox', undefined, { friend });
  retryFriendMessage = (id: string) => this.request<OutboxItemDto>('POST', `/api/friends/outbox/${encodeURIComponent(id)}/retry`);
  cancelFriendMessage = (id: string) => this.request<OutboxItemDto>('DELETE', `/api/friends/outbox/${encodeURIComponent(id)}`);

  // ----- shares to and from friends (phases 2 and 3) -----
  /** The review before sending: what goes, and what the sanitizer took out, item by item. */
  previewShare = (input: SharePreviewInput) => this.request<SharePreview>('POST', '/api/shares/preview', input);
  /** Send a chat or session to friends: signed, sealed for each, fetched only when they accept. */
  sendShare = (input: SendShareInput) => this.request<SentShareDto>('POST', '/api/shares', input);
  sentShares = () => this.request<SentShareDto[]>('GET', '/api/shares/sent');
  sentShare = (id: string) => this.request<SentShareDto>('GET', `/api/shares/sent/${encodeURIComponent(id)}`);
  /** A new revision of the same share, from the session as it is now. */
  updateShare = (id: string, input: UpdateShareInput = {}) => this.request<SentShareDto>('POST', `/api/shares/sent/${encodeURIComponent(id)}/update`, input);
  /** Unsend: the friends' hubs are asked to delete their copy. */
  unsendShare = (id: string) => this.request<SentShareDto>('DELETE', `/api/shares/sent/${encodeURIComponent(id)}`);
  receivedShares = () => this.request<ReceivedShareDto[]>('GET', '/api/shares/received');
  receivedShare = (id: string) => this.request<ReceivedShareDto>('GET', `/api/shares/received/${encodeURIComponent(id)}`);
  /** Fetch the share from the friend's hub and check its signature. Nothing is fetched before this. */
  acceptShare = (id: string) => this.request<ReceivedShareDto>('POST', `/api/shares/received/${encodeURIComponent(id)}/accept`);
  declineShare = (id: string) => this.request<ReceivedShareDto>('POST', `/api/shares/received/${encodeURIComponent(id)}/decline`);
  /** Read only, as quoted data from the friend's hub. */
  viewShare = (id: string) => this.request<ShareViewDto>('GET', `/api/shares/received/${encodeURIComponent(id)}/view`);
  /** Continue as a fork on this hub's models. The first turn runs guarded. */
  forkShare = (id: string, input: ForkShareInput = {}) => this.request<Session>('POST', `/api/shares/received/${encodeURIComponent(id)}/fork`, input);
  handoffDraft = (id: string) => this.request<HandoffDraft>('GET', `/api/shares/received/${encodeURIComponent(id)}/handoff`);
  /** A fresh session that starts from the brief. */
  handoffShare = (id: string, input: HandoffShareInput) => this.request<Session>('POST', `/api/shares/received/${encodeURIComponent(id)}/handoff`, input);
  /** Keep it as a read only reference this hub's agents can read like a past chat. */
  referenceShare = (id: string) => this.request<Session>('POST', `/api/shares/received/${encodeURIComponent(id)}/reference`);
  /** Check where the share's code would land. Nothing changes until applyShare with the plan's id. */
  planApplyShare = (id: string, input: ApplyShareInput) => this.request<ApplySharePlan>('POST', `/api/shares/received/${encodeURIComponent(id)}/apply-plan`, input);
  /** Approve a plan: the code lands on its new branch. No hook or script from the share runs. */
  applyShare = (id: string, planId: string) => this.request<ApplyShareResult>('POST', `/api/shares/received/${encodeURIComponent(id)}/apply`, { planId });

  // ----- add a friend by address, and requests by address -----
  /** Ask a hub to be friends by its address: the request lands in its Inbox. Not sent: the reason, and with an email an invite in a mailto: link. */
  addFriendByAddress = (input: AddFriendInput) => this.request<AddFriendResult>('POST', '/api/friends/add', input);
  /** A one time invite in a mailto: link to an email. */
  mailFriendInvite = (email: string) => this.request<MailInviteResult>('POST', '/api/friends/mail-invite', { email });
  friendSettings = () => this.request<FriendSettings>('GET', '/api/friends/settings');
  setFriendSettings = (input: { requestsByAddress?: boolean }) => this.request<FriendSettings>('PUT', '/api/friends/settings', input);
  /** Turn a request away and refuse that hub's requests from now on (an active friend is removed too). */
  blockFriend = (id: string) => this.request<FriendSettings>('POST', `/api/friends/${encodeURIComponent(id)}/block`);
  unblockFriend = (fingerprint: string) => this.request<FriendSettings>('DELETE', `/api/friends/blocked/${encodeURIComponent(fingerprint)}`);
  /** A friend's name here and the email kept for them. */
  updateFriend = (id: string, patch: { name?: string; email?: string }) => this.request<FriendDto>('PATCH', `/api/friends/${encodeURIComponent(id)}`, patch);

  // ----- shared projects with friends -----
  sharedProjects = () => this.request<SharedProjectDto[]>('GET', '/api/shared-projects');
  sharedProject = (id: string) => this.request<SharedProjectView>('GET', `/api/shared-projects/${encodeURIComponent(id)}`);
  /** Make a project shared and invite friends: they accept or decline in their Inbox. */
  createSharedProject = (input: CreateSharedProjectInput) => this.request<SharedProjectView>('POST', '/api/shared-projects', input);
  updateSharedProject = (id: string, input: UpdateSharedProjectInput) => this.request<SharedProjectView>('PATCH', `/api/shared-projects/${encodeURIComponent(id)}`, input);
  /** A member leaves; the owner ends it for everyone. With forget, a project already left goes from this hub. */
  leaveSharedProject = (id: string, opts: { forget?: boolean } = {}) => this.request<SharedProjectDto | { ok: true }>('DELETE', `/api/shared-projects/${encodeURIComponent(id)}`, undefined, { forget: opts.forget ? 1 : undefined });
  acceptSharedProject = (id: string) => this.request<SharedProjectView>('POST', `/api/shared-projects/${encodeURIComponent(id)}/accept`);
  declineSharedProject = (id: string) => this.request<SharedProjectDto>('POST', `/api/shared-projects/${encodeURIComponent(id)}/decline`);
  /** The owner invites more friends. */
  inviteToSharedProject = (id: string, friends: string[]) => this.request<SharedProjectView>('POST', `/api/shared-projects/${encodeURIComponent(id)}/members`, { friends });
  /** The owner takes a member out. */
  removeSharedMember = (id: string, fingerprint: string) => this.request<SharedProjectView>('DELETE', `/api/shared-projects/${encodeURIComponent(id)}/members/${encodeURIComponent(fingerprint)}`);
  addSharedNote = (id: string, input: SharedNoteInput) => this.request<SharedWriteResult>('POST', `/api/shared-projects/${encodeURIComponent(id)}/notes`, input);
  /** Only the author edits an item: a new version, the old one kept. */
  editSharedItem = (id: string, itemId: string, input: Partial<SharedNoteInput>) => this.request<SharedWriteResult>('PATCH', `/api/shared-projects/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, input);
  deleteSharedItem = (id: string, itemId: string) => this.request<SharedWriteResult>('DELETE', `/api/shared-projects/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`);
  sharedItemHistory = (id: string, itemId: string) => this.request<SharedItemVersionDto[]>('GET', `/api/shared-projects/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/history`);
  /** The project's memories on this hub, to pick from. */
  sharedMemoryCandidates = (id: string) => this.request<SharedMemoryCandidate[]>('GET', `/api/shared-projects/${encodeURIComponent(id)}/memory-candidates`);
  shareProjectMemories = (id: string, memoryIds: string[]) => this.request<SharedWriteResult[]>('POST', `/api/shared-projects/${encodeURIComponent(id)}/memories`, { memoryIds });
  /** Send chats or sessions to the members (a share each, fetched when they accept). */
  shareProjectChats = (id: string, sessionIds: string[]) => this.request<SharedWriteResult[]>('POST', `/api/shared-projects/${encodeURIComponent(id)}/chats`, { sessionIds });
  /** The repository on GitHub, and each member's open branches and pull requests the token can see. */
  sharedProjectCode = (id: string) => this.request<SharedProjectCodeDto>('GET', `/api/shared-projects/${encodeURIComponent(id)}/code`);
  /** Send what waits, fetch what the owner's hub holds, and ask it for the whole project again. */
  syncSharedProject = (id: string) => this.request<SharedProjectView>('POST', `/api/shared-projects/${encodeURIComponent(id)}/sync`);
  markSharedProjectRead = (id: string) => this.request<SharedProjectDto>('POST', `/api/shared-projects/${encodeURIComponent(id)}/read`);
  // ----- the Map: docs/DESIGN.md 29 -----
  /** The hub, its devices, projects and the last 24 hours of work. With at: the same, rebuilt from stored rows at that time. */
  map = (q: MapQuery = {}) => this.request<MapSnapshot>('GET', '/api/map', undefined, q as Query);

  // ----- gateway -----
  gatewayKeys = () => this.request<GatewayKeyDto[]>('GET', '/api/gateway/keys');
  createGatewayKey = (name: string, opts: { device?: string; agent?: string } = {}) => this.request<GatewayKeyDto & { key: string }>('POST', '/api/gateway/keys', { name, ...opts });
  revokeGatewayKey = (id: string) => this.request<{ ok: true }>('DELETE', `/api/gateway/keys/${id}`);

  // ----- config, secrets, notifications -----
  config = () => this.request<{ config: Record<string, unknown>; user: Record<string, unknown>; secrets: { providers: string[]; values: string[]; keyed?: string[] } }>('GET', '/api/config');
  updateConfig = (patch: Record<string, unknown>) => this.request<{ ok: true }>('PATCH', '/api/config', patch);
  setSecret = (kind: 'providers' | 'values', key: string, value: string | null) => this.request<{ ok: true }>('PUT', '/api/secrets', { kind, key, value });
  notifyChannels = () => this.request<Array<{ id: string; enabled: boolean }>>('GET', '/api/notify/channels');
  /** Send a test notification. With an endpoint, only that browser gets it. */
  testNotify = (channel = 'webpush', opts: { endpoint?: string } = {}) => this.request<{ ok: true }>('POST', '/api/notify/test', { channel, ...opts });
  vapidKey = () => this.request<{ publicKey?: string }>('GET', '/api/notify/vapid');
  pushSubscribe = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device?: string) => this.request<{ ok: true }>('POST', '/api/notify/subscribe', { ...sub, device });
  /** Stop Web Push to one browser by its endpoint. */
  pushUnsubscribe = (endpoint: string) => this.request<{ ok: true }>('POST', '/api/notify/unsubscribe', { endpoint });
  /** Browsers and installed web apps that get Web Push. */
  notifyDevices = () => this.request<NotifyDeviceDto[]>('GET', '/api/notify/devices');
  removeNotifyDevice = (id: string) => this.request<{ ok: true }>('DELETE', `/api/notify/devices/${encodeURIComponent(id)}`);
  audit = (q: { sessionId?: string; limit?: number } = {}) => this.request<AuditEntry[]>('GET', '/api/audit', undefined, q as Query);

  // ----- updates: docs/DESIGN.md, Updates (the owner's only) -----
  /** The running version, the newest release, how this hub updates and the update running now. */
  hubUpdate = () => this.request<UpdateStatusDto>('GET', '/api/update');
  /** Check the newest release now. */
  checkHubUpdate = () => this.request<UpdateStatusDto>('POST', '/api/update/check');
  /** Download, check and install `version`, then restart the hub. Returns at once; follow it with hubUpdate(). */
  applyHubUpdate = (version: string, opts: { force?: boolean; when?: 'idle' } = {}) => this.request<UpdateStatusDto>('POST', '/api/update/apply', { version, ...opts });
  /** "Install updates automatically" and when: idle or night. */
  setAutoUpdate = (patch: { auto?: boolean; window?: 'idle' | 'night' }) => this.request<UpdateStatusDto>('PUT', '/api/update/settings', patch);
  /** Each device's daemon version against the hub's, and the last update sent to it. */
  deviceUpdates = () => this.request<DeviceUpdatesDto>('GET', '/api/devices/updates');
  /** The device's daemon updates itself to the hub's version and restarts. */
  updateDeviceDaemon = (id: string) => this.request<DeviceUpdateDto>('POST', `/api/devices/${encodeURIComponent(id)}/update`);

  // ----- hub logs: docs/DESIGN.md 33 -----
  /** Size, days kept, errors today and this week, and the debug switch. */
  logs = () => this.request<LogsStatus>('GET', '/api/logs');
  /** The last lines, or with after the lines since that cursor (follow by calling again with the cursor it returned). */
  logsTail = (q: LogsTailQuery = {}) => this.request<LogsTailResult>('GET', '/api/logs/tail', undefined, q as Query);
  /** Errors and warnings of the last days, grouped by message. */
  logErrors = (days = 7) => this.request<LogErrorsReport>('GET', '/api/logs/errors', undefined, { days });
  /** Debug lines for the next hours; 0 turns them off. */
  setLogsDebug = (hours: number) => this.request<LogsStatus>('PUT', '/api/logs/debug', { hours });
  /** What this app reports about itself: connects, failed requests, render errors. Capped per client by the hub. */
  sendClientLogs = (batch: ClientLogBatch) => this.request<ClientLogResult>('POST', '/api/logs/client', batch);
  /** GET /api/logs/export as it comes, for streaming it to a file. Throws ApiError on a refusal. */
  logsExportResponse = async (q: LogsExportQuery = {}): Promise<Response> => {
    const check = this.guard();
    if (check) await check;
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.f(`${this.baseUrl}/api/logs/export${qs({ days: q.days, devices: q.devices === false ? 0 : undefined })}`, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, data);
    }
    return res;
  };
  /** The logs export: a zip with the files, summary.md and the config without secrets, and its file name. */
  exportLogs = async (q: LogsExportQuery = {}): Promise<{ name: string; data: Blob }> => {
    const res = await this.logsExportResponse(q);
    const disposition = res.headers.get('content-disposition') ?? '';
    const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'conclave-logs.zip';
    return { name, data: await res.blob() };
  };

  // ----- backup and restore -----
  /** Settings, agents, routines, tasks, memory and sessions as one JSON document. Keys stay out unless secrets is set. */
  backup = (opts: BackupOptions = {}) => this.request<HubBackup>('GET', '/api/backup', undefined, { secrets: opts.secrets ? 1 : undefined, sessions: opts.sessions === false ? 0 : undefined });
  /** Load a backup. New sessions, notes and tasks are added; agents and routines from the file replace ones with the same name or id. */
  restore = (backup: HubBackup, opts: RestoreOptions = {}) => this.request<RestoreResult>('POST', '/api/restore', backup, { config: opts.config === false ? 0 : undefined });

  // ----- catalog (Discover), docs/design/ECOSYSTEM.md 2.1 -----
  /** Local data only: shipped items, marketplaces and cached results. */
  catalog = (q: CatalogQuery = {}) => this.request<CatalogPage>('GET', '/api/catalog', undefined, { ...q, recommended: q.recommended ? 1 : undefined, installed: q.installed ? 1 : undefined } as Query);
  /** Live GitHub and MCP registry search, cached on the hub. */
  catalogSearch = (q: CatalogSearchQuery) => this.request<CatalogSearchResult>('GET', '/api/catalog/search', undefined, q as unknown as Query);
  catalogItem = (id: string) => this.request<CatalogDetail>('GET', `/api/catalog/items/${encodeURIComponent(id)}`);
  catalogPreview = (req: CatalogPreviewRequest) => this.request<InstallPreview>('POST', '/api/catalog/preview', req);
  catalogInstall = (req: CatalogInstallRequest) => this.request<CatalogInstallResult>('POST', '/api/catalog/install', req);
  /** "Install on the hub": a shipped item's hub setup step, or what a missing need takes, as the hub's own user. The owner's only. */
  catalogSetup = (id: string, req: CatalogSetupRequest = {}) => this.request<CatalogSetupResult>('POST', `/api/catalog/items/${encodeURIComponent(id)}/setup`, req);
  catalogInstalled = () => this.request<InstalledCatalogItem[]>('GET', '/api/catalog/installed');
  catalogCheckUpdates = () => this.request<InstalledCatalogItem[]>('POST', '/api/catalog/updates/check');
  catalogUpdatePreview = (id: string) => this.request<UpdatePreview>('POST', `/api/catalog/installed/${encodeURIComponent(id)}/update-preview`);
  catalogUpdate = (id: string, planId: string) => this.request<InstalledCatalogItem>('POST', `/api/catalog/installed/${encodeURIComponent(id)}/update`, { planId });
  catalogRollback = (id: string) => this.request<InstalledCatalogItem>('POST', `/api/catalog/installed/${encodeURIComponent(id)}/rollback`);
  catalogRemove = (id: string, opts: { secrets?: boolean } = {}) =>
    this.request<{ ok: true; removed: string[] }>('DELETE', `/api/catalog/installed/${encodeURIComponent(id)}`, undefined, { secrets: opts.secrets ? 1 : undefined });
  catalogStatus = () => this.request<CatalogStatus>('GET', '/api/catalog/status');
  /** At most once a minute. source: "github", "mcp-registry", "marketplaces", "feeds", or all when unset. */
  catalogRefresh = (source?: string) => this.request<CatalogStatus>('POST', '/api/catalog/refresh', { source });
  /** Bring tasks and memories in from another tool's files (agentic-tools-mcp). */
  importTasks = (req: TaskImportRequest) => this.request<TaskImportResult>('POST', '/api/tasks/import', req);

  // ----- events -----
  /**
   * Live events over WebSocket. Reconnects with backoff and replays missed
   * events using the last seen seq. Returns a function that closes it.
   *
   * Presence: pass `active` (or call setActive on the returned function) to
   * tell the hub whether this app is in use. setActive(true) counts as use
   * each time it is called, so call it again on input; the hub treats an app
   * as in use for notifications.idleSeconds after that. setActive(false)
   * ends the hold at once. Clients that never report presence count as in
   * use on every frame, pings included.
   *
   * onResync: the hub could not replay the events this client missed, so
   * refetch everything shown, transcripts included. config.updated only
   * means the config changed.
   *
   * With a pinned hubKey the hub proves its key before each socket opens,
   * again on every reconnect. onIdentityError: another key answered, so no
   * socket was opened; it keeps trying with backoff.
   */
  connect(
    onEvent: (e: EngineEventEnvelope) => void,
    opts: {
      onStatus?: (s: 'connecting' | 'open' | 'closed') => void;
      onResync?: () => void;
      WebSocketImpl?: typeof WebSocket;
      active?: boolean;
      onIdentityError?: (e: HubIdentityError) => void;
      /** Ask for map.delta events (the Map is open). */
      map?: boolean;
    } = {},
  ): (() => void) & { setActive(active: boolean): void; setMap(on: boolean): void } {
    const WS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new Error('WebSocket not available');
    let ws: WebSocket | undefined;
    let closed = false;
    let lastSeq = 0;
    let attempt = 0;
    let reconnect = false;
    let active = opts.active;
    let map = !!opts.map;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sendPresence = () => {
      if (active !== undefined && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'presence', active }));
    };
    const sendMap = () => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'map', on: map }));
    };
    const retry = () => {
      const delay = Math.min(15_000, 500 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
    const open = () => {
      if (closed) return;
      opts.onStatus?.('connecting');
      // a reconnect checks the hub again: the address may answer for another machine now
      if (reconnect) this.forgetIdentity();
      reconnect = true;
      const check = this.guard();
      if (!check) return start();
      check.then(start, (err) => {
        if (closed) return;
        opts.onStatus?.('closed');
        if (err instanceof HubIdentityError) opts.onIdentityError?.(err);
        retry();
      });
    };
    const start = () => {
      if (closed) return;
      ws = new WS(this.baseUrl.replace(/^http/, 'ws') + `/api/ws${qs({ token: this.token, active: active === false ? 0 : undefined })}`);
      ws.onopen = () => {
        attempt = 0;
        opts.onStatus?.('open');
        sendPresence();
        if (map) sendMap();
        if (lastSeq) ws!.send(JSON.stringify({ type: 'since', seq: lastSeq }));
      };
      ws.onmessage = (m: MessageEvent) => {
        try {
          const data = JSON.parse(typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data as ArrayBuffer));
          if (data.type === 'hello') {
            // a hub that restarted counts from 0 again: nothing after our seq will ever come
            if (lastSeq && typeof data.seq === 'number' && data.seq < lastSeq) {
              lastSeq = data.seq;
              opts.onResync?.();
            } else if (!lastSeq) lastSeq = data.seq;
            return;
          }
          if (data.type === 'resync') {
            lastSeq = data.seq;
            opts.onResync?.();
            return;
          }
          if (typeof data.seq === 'number' && data.seq > lastSeq) lastSeq = data.seq;
          onEvent(data as EngineEventEnvelope);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        opts.onStatus?.('closed');
        if (closed) return;
        retry();
      };
      ws.onerror = () => ws?.close();
    };
    open();
    const ping = setInterval(() => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
    const stop = () => {
      closed = true;
      clearInterval(ping);
      if (timer) clearTimeout(timer);
      const s = ws;
      if (!s) return;
      // closing a socket that is still connecting makes browsers log a warning; close it once it opens
      if (s.readyState === 0) {
        s.onmessage = null;
        s.onerror = null;
        s.onclose = null;
        s.onopen = () => s.close();
      } else s.close();
    };
    return Object.assign(stop, {
      /** true: in use now (send it again on input, as a heartbeat). false: in the background. */
      setActive(next: boolean) {
        if (next === active && !next) return;
        active = next;
        sendPresence();
      },
      /** true: send map.delta events to this socket (again after a reconnect); false: stop. */
      setMap(on: boolean) {
        if (on === map) return;
        map = on;
        sendMap();
      },
    });
  }
}
