/**
 * Shared contracts for every Conclave package.
 *
 * Message content uses Anthropic-style blocks internally because they are the
 * most expressive shape (thinking with signatures, tool_use, tool_result,
 * images, documents). Providers translate to and from their own wire format.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /**
   * Reasoning signature, only valid when replayed to the same model.
   * Anthropic signatures are stored raw; other providers use a tagged form
   * "cv1|<kind>|<model>|<payload>" so each provider replays only its own blocks.
   */
  signature?: string;
  /** How long the model thought, in ms, from the request or the block's first delta to the next block. UI only; never sent to a provider. */
  durationMs?: number;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface ImageBlock {
  type: 'image';
  mediaType: string;
  /** base64 without the data: prefix */
  data?: string;
  url?: string;
}

export interface DocumentBlock {
  type: 'document';
  mediaType: string;
  data?: string;
  url?: string;
  title?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Provider reasoning signature bound to this call (Gemini). Only valid for the same model. */
  signature?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string | Array<TextBlock | ImageBlock | DocumentBlock>;
  isError?: boolean;
  /** UI metadata, never sent to the model. */
  meta?: ToolResultMeta;
}

export interface ToolResultMeta {
  /** Unified diff for edits. */
  diff?: string;
  path?: string;
  /** Id of the full output in the tool_outputs table when the content was truncated. */
  outputId?: string;
  truncated?: boolean;
  durationMs?: number;
  exitCode?: number;
  /** Set when an external harness (ACP agent) executed the tool, not Conclave. */
  external?: boolean;
  [key: string]: unknown;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock;

// ---------------------------------------------------------------------------
// Messages and sessions
// ---------------------------------------------------------------------------

export type Role = 'user' | 'assistant';

/**
 * normal  : regular turn, sent to the model as-is
 * aside   : second opinion, juror answer, debate turn. Shown in chat with its
 *           author. Sent to the main model as quoted user-side context so the
 *           main model never thinks it wrote it.
 * summary : compaction summary. Everything before it is skipped when building
 *           the provider request.
 * notice  : UI-only event line (limit hit, resumed, model switched). Never sent.
 */
export type MessageKind = 'normal' | 'aside' | 'summary' | 'notice';

export interface Message {
  id: string;
  sessionId: string;
  seq: number;
  role: Role;
  kind: MessageKind;
  content: ContentBlock[];
  /** "provider/model" that produced an assistant message. */
  model?: string;
  agent?: string;
  /** Display label for asides, e.g. "Juror 2" or "Second opinion". */
  author?: string;
  /** Groups messages that belong to one jury/debate/review run. */
  group?: string;
  usage?: Usage;
  stopReason?: StopReason;
  createdAt: number;
  meta?: Record<string, unknown>;
}

/**
 * A background task that ended and reported to its session: a Task or
 * Delegate subagent (id: its session) or a workflow run (id: the run). The
 * notice line that says so carries it as meta.agentResult with meta.kind
 * 'agent-result'; the user message that hands the report to the model
 * carries every one it holds in meta.agentResults (and meta.kind
 * 'agent-result' when it holds nothing else the owner wrote). The apps draw
 * one compact row for it ("Message from subagent ...") instead of a bubble.
 */
export interface AgentResultRef {
  type: 'subagent' | 'workflow';
  id: string;
  /** The task's description or the workflow's name. */
  label: string;
  /** The subagent's agent type. */
  agent?: string;
  state: 'completed' | 'failed' | 'stopped';
}

/**
 * A message the owner sent while the session was busy, before it joins the
 * transcript (docs/design/CHAT-AND-MOTION.md 2.11). queue: it runs as its own
 * turn after the running one. steer: it joins the running turn at its next
 * step. The hub keeps these in memory: a hub restart drops them. When one
 * joins the transcript, its user message carries the id in meta.pendingIds
 * and the next session.queue event leaves it out.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** What was attached, by name and type. The files stay on the hub. */
  attachments?: Array<{ name?: string; mediaType: string }>;
  /** When it was sent. */
  at: number;
  whenBusy: 'queue' | 'steer';
  /** Stop kept it: it waits until the owner sends it (POST /queue/:pendingId/send) or removes it. */
  held?: boolean;
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'waiting_reset'
  | 'error';

export type SessionMode = 'agent' | 'chat' | 'plan' | 'jury' | 'debate' | 'loop';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass';

export interface Session {
  /** The account this belongs to (docs/design/ACCOUNTS.md); 'owner' for the hub's owner. Rows from before accounts read as the owner's. */
  accountId?: string;
  id: string;
  title: string;
  agent: string;
  /** Current "provider/model" for normal turns. */
  model: string;
  mode: SessionMode;
  permissionMode: PermissionMode;
  cwd: string;
  /** Device that runs tools for this session. "local" is the hub itself. */
  device: string;
  status: SessionStatus;
  parentId?: string;
  taskId?: string;
  routineId?: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Resume ids for external harnesses keyed by harness id (claude-code, codex, ...). */
  external?: Record<string, string>;
  /** Mode settings that persist for the session (jury panel, debate pair...). */
  modeConfig?: ModeConfig;
  stats: SessionStats;
  /** When status is waiting_reset: epoch ms when the limit resets. */
  resumeAt?: number;
  error?: string;
  meta?: Record<string, unknown>;
  /**
   * What the session is for. "chat" is a plain conversation from the Chat
   * page (the chat agent, the web and memory, no files or devices). Absent
   * means "agent": a workbench session. Set on create; Continue as a session
   * patches it to "agent".
   */
  kind?: SessionKind;
  /** Per-chat switches, read when kind is "chat". An agent session reads chat.thinking (its effort override) and chat.memory (off leaves no trace in memory). */
  chat?: ChatSettings;
  /** Project the session's folder belongs to (projects/store.ts), set once its identity is known. */
  projectId?: string;
  /** Ultra: the agent plans and runs workflows for real tasks (docs/WORKFLOWS.md). Not offered on chats. */
  ultra?: boolean;
}

export type SessionKind = 'agent' | 'chat';

/** The switches under the chat composer. A missing switch is on (web search and memory); thinking falls back to the agent. */
export interface ChatSettings {
  /** Offer WebSearch and WebFetch. */
  webSearch: boolean;
  /** Read memory (profile and recall) and let the model save and forget notes. Off is a chat that leaves no trace in memory. */
  memory: boolean;
  /**
   * Effort for this chat or session (providers/effort.ts): off or a level. Unset
   * uses the agent's setting, then the model's default. A level the model lacks
   * is sent as the nearest one it has.
   */
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /**
   * Cyber access program for ChatGPT plan models (providers/access-programs.ts):
   * sent as access_programs.cyber. Unset sends nothing and ChatGPT picks one
   * from the account's access. A program the model does not take is not sent.
   */
  cyber?: 'standard' | 'daybreak_blue' | 'daybreak_red';
}

export interface SessionStats {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Cache writes (sessions from before this field read 0). */
  cacheWriteTokens?: number;
  costUsd: number;
  /** The same tokens at the models' API prices: more than costUsd when a plan served them (docs/DESIGN.md, Usage). */
  apiValueUsd?: number;
}

export interface ModeConfig {
  jury?: JuryConfig;
  debate?: DebateConfig;
  loop?: LoopConfig;
}

export interface JuryConfig {
  /** Model refs ("provider/model") or agent names prefixed with "@". */
  jurors: string[];
  /** Model that reads all answers and writes the verdict. Defaults to the session model. */
  judge?: string;
  /** synthesize: merge best parts. vote: pick a winner. rank: score each. */
  strategy: 'synthesize' | 'vote' | 'rank';
  /** Hide juror model names from the judge to reduce brand bias. */
  anonymize: boolean;
  /** Tools available to jurors. */
  jurorTools: 'none' | 'readonly';
}

export interface DebateConfig {
  a: string;
  b: string;
  rounds: number;
  judge?: string;
  /** Optional stances, e.g. "argue for" / "argue against". */
  stanceA?: string;
  stanceB?: string;
}

export interface LoopConfig {
  /** Keep going until this shell command exits 0 (e.g. "bun test"). */
  untilCommand?: string;
  /** Or until the model output contains this string. */
  untilText?: string;
  maxIterations: number;
}

export interface Usage {
  /** Uncached input tokens only (cache reads and writes are counted separately). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Every cache write, at either lifetime. */
  cacheWriteTokens?: number;
  /** The part of cacheWriteTokens written with the 1 hour lifetime (Anthropic usage.cache_creation). */
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** What the call is worth at the model's API prices; equal to costUsd unless a plan served it. */
  apiValueUsd?: number;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'pause_turn'
  | 'aborted'
  | 'error';

// ---------------------------------------------------------------------------
// Tasks, routines, memory
// ---------------------------------------------------------------------------

export type TaskStatus = 'inbox' | 'todo' | 'doing' | 'review' | 'done';

export interface Task {
  /** The account this belongs to (docs/design/ACCOUNTS.md); 'owner' for the hub's owner. Rows from before accounts read as the owner's. */
  accountId?: string;
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 0 | 1 | 2 | 3;
  agent?: string;
  project?: string;
  due?: number;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  meta?: Record<string, unknown>;
}

export interface Routine {
  /** The account this belongs to (docs/design/ACCOUNTS.md); 'owner' for the hub's owner. Rows from before accounts read as the owner's. */
  accountId?: string;
  id: string;
  name: string;
  /** Cron expression (5 or 6 fields) or "@every 30m" / "@once 2026-10-20T09:00". */
  schedule: string;
  timezone?: string;
  agent: string;
  model?: string;
  mode: SessionMode;
  prompt: string;
  cwd?: string;
  device?: string;
  enabled: boolean;
  /** new: fresh session each run. reuse: append to one session. home: a turn in the account's assistant home thread (never a webhook's or a watch's run: those run as new). */
  sessionPolicy: 'new' | 'reuse' | 'home';
  sessionId?: string;
  /** on_attention: when the run fails or its reply starts with STATUS: attention or problem. */
  notify: 'always' | 'on_error' | 'on_attention' | 'never';
  /** Secret for POST /api/routines/:id/trigger webhooks. */
  webhookSecret?: string;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
  /** Permission rules seeded into this routine's sessions only (Claude Code rule syntax). */
  allow?: string[];
  deny?: string[];
  /** What a scheduled or webhook run does when a call needs approval. Default "deny": the call is refused, listed on the run, and the turn goes on. Manual runs always wait. */
  onApproval?: 'deny' | 'wait';
  /** Shell command run on the device before the model. Prints nothing, or the same as last time, and the run is skipped. */
  precheck?: string;
  /** Values may be ${secret:name}. Stored now, exported to the routine's Bash calls once the hub supports it. */
  env?: Record<string, string>;
  /** Stop the run after this many minutes. */
  timeoutMin?: number;
  /** Stop the run when its cost passes this. */
  maxCostUsd?: number;
  /** Id of the suggestion this routine was made from (scheduler/suggestions.ts). */
  suggestion?: string;
  /** Id of the template this routine was made from (scheduler/templates.ts); template upgrades follow it. */
  template?: string;
  /** A routine the hub runs in code instead of an agent session (memory/digest.ts). */
  builtin?: 'daily-digest';
  /** A watch: the hub keeps the items each run reports and says what changed (watches/service.ts). */
  watch?: import('./watches/types').WatchSpec;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  sessionId?: string;
  status: 'running' | 'ok' | 'error' | 'skipped';
  trigger: 'schedule' | 'manual' | 'webhook';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  summary?: string;
  /** From the first line of the reply: "STATUS: ok", "STATUS: attention" or "STATUS: problem". */
  outcome?: 'ok' | 'attention' | 'problem';
  /** Calls refused because nobody was there to approve them. */
  denied?: Array<{ tool: string; input: string; rule?: string }>;
  /** What the precheck printed (first 2000 characters). */
  precheckOutput?: string;
}

export type MemoryScope = 'global' | 'project' | 'agent';

/**
 * profile  : always injected into the system prompt (who the user is, how they like answers).
 * fact     : retrieved by relevance.
 * episode  : auto-written summary of a past session.
 * procedure: how-to the agent learned ("deploy uses make release").
 */
export type MemoryKind = 'profile' | 'fact' | 'episode' | 'procedure';

export interface MemoryEntry {
  /** The account this belongs to (docs/design/ACCOUNTS.md); 'owner' for the hub's owner. Rows from before accounts read as the owner's. */
  accountId?: string;
  id: string;
  scope: MemoryScope;
  /** Project path or agent name when scope is not global. */
  scopeKey?: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  sourceSessionId?: string;
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
  /** Where a learned or imported memory came from (memories.meta). */
  meta?: MemoryMeta;
}

/** Provenance of a memory the import learning job wrote (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.12). */
export interface MemoryMeta {
  /** Tool the chat came from (claude-code, codex, conclave...). */
  source?: string;
  device?: string;
  /** The tool's session id, or a Conclave session id. */
  extSessionId?: string;
  /** When the chat happened, epoch ms. Newer observations supersede older ones. */
  observedAt?: number;
  /** Short exact quote from the chat that supports it. */
  evidence?: string;
  basis?: 'user_said' | 'tool_verified' | 'user_accepted';
  batchId?: string;
  /** Sessions it was seen in. */
  seenCount?: number;
  /** Id of the memory that replaced this one. Recall skips superseded rows. */
  supersededBy?: string;
  /** pending: waits on the owner in Memory, To review. Recall skips it until accepted. */
  review?: 'pending' | 'accepted';
  /** The learned kind (preference, decision, host...). */
  learnedKind?: string;
  [key: string]: unknown;
}

export interface MemoryHit extends MemoryEntry {
  score: number;
}

// ---------------------------------------------------------------------------
// Usage, limits
// ---------------------------------------------------------------------------

export interface UsageRecord {
  /** The account this belongs to (docs/design/ACCOUNTS.md); 'owner' for the hub's owner. Rows from before accounts read as the owner's. */
  accountId?: string;
  /** Whose key served the call: the hub's or the account's own (budgets count only the hub's). */
  paidBy?: 'hub' | 'own';
  id: string;
  ts: number;
  sessionId?: string;
  /** api: Conclave called the provider. chat: the same, for a chat on the Chat page. claude-code / codex / ...: read from that tool's own logs or ACP. */
  source: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** What was billed: 0 for a signed in plan, the API price for a key. */
  costUsd: number;
  /**
   * The same tokens at the model's API prices from the catalog (cache reads
   * and writes at their own rates), kept on the row when it is recorded so a
   * later price change does not move it. Equal to costUsd for an API key.
   */
  apiValueUsd?: number;
  /** apiValueUsd was worked out on read from today's catalog: the row is from before the value was kept. */
  apiValueEstimated?: boolean;
  latencyMs?: number;
  /** What the call was for: turn, title, compaction, memory, jury, review... */
  purpose?: string;
  /** The account that served it (models.accounts id). For CLIProxyAPI calls the hub infers it from the order, as CLIProxyAPI does not say. */
  account?: string;
  /** Device the session ran on, or the device whose logs it came from. */
  device?: string;
  /** Folder the session ran in. */
  cwd?: string;
}

/**
 * session: a rolling 5 hour window. weekly: 7 days (all models, or one).
 * monthly. budget: a money budget the owner set. rate: per-minute API
 * limits. extra: paid usage past the plan.
 */
export type LimitWindowKind = 'session' | 'weekly' | 'monthly' | 'budget' | 'rate' | 'extra';

export interface LimitWindow {
  /** e.g. "5h", "7d", "7d opus", "budget", "requests", "tokens". */
  name: string;
  /** 0..100. Missing means unknown, not zero. */
  usedPercent?: number;
  remaining?: number;
  limit?: number;
  resetsAt?: number;
  /** Length of the window, when known (5 hours, 7 days, the budget period). */
  windowMs?: number;
  kind?: LimitWindowKind;
  /** Where the numbers came from: the plan's usage endpoint, the last response's headers, Conclave's own cost records. */
  source?: 'oauth' | 'headers' | 'ledger' | 'logs' | 'api' | 'error';
  /** When they were read. */
  observedAt?: number;
}

export interface LimitState {
  /** Provider or subscription id: anthropic, claude-max, codex, zai, openai, cliproxy... */
  provider: string;
  /** The account (models.accounts id) these windows belong to. A provider has one state per account. */
  account?: string;
  label: string;
  windows: LimitWindow[];
  updatedAt: number;
  /** True when the provider is currently refusing requests. */
  blocked?: boolean;
  source: 'headers' | 'oauth' | 'logs' | 'api' | 'error' | 'ledger';
  /** A plan whose window starter is on: what it is doing (client/accounts.ts StarterDto), for clients that show limits only. */
  starter?: { state: string; nextAt?: number; startedAt?: number; until?: number; reason?: string };
}

// ---------------------------------------------------------------------------
// Permissions and questions
// ---------------------------------------------------------------------------

/**
 * Who asks, when a subagent or a workflow agent asks (engine/ask-origin.ts):
 * the line above its card in the chat the owner is in, "Subagent email asks"
 * or "Workflow deep-research, agent search r1 3, asks".
 */
export interface AskFrom {
  /** The session that asks: the request's sessionId. */
  sessionId: string;
  /** Its agent, "email". */
  agent: string;
  /** The subagent's description, or the workflow agent's label. */
  label: string;
  /** Set when a workflow agent asks: its run and the workflow's name. */
  workflow?: { runId: string; name: string };
  /** The sessions under the top one, down to the one that asks (the asker last). A task row is waiting on you when its session is here. */
  chain: string[];
}

export interface ApprovalRequest {
  id: string;
  /** The session that asks. Answering resolves it there, and "for this session" is its own. */
  sessionId: string;
  /** The top session of the one that asks, through subagents and workflow runs: the chat the owner is in. The same as sessionId for a top session; absent from older hubs. */
  rootSessionId?: string;
  /** Set when the one that asks is below the top session (rootSessionId). */
  from?: AskFrom;
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  /** Human readable one-liner, e.g. "Run: rm -rf build". */
  summary: string;
  /** Suggested rule for "always allow", e.g. "Bash(npm test:*)". */
  suggestedRule?: string;
  createdAt: number;
  /** Set for approvals coming from an ACP agent (Claude Code, Codex...). */
  harness?: string;
  /** The session reads untrusted input: do not offer "always allow". The hub counts such an answer as once. */
  noAlways?: boolean;
}

export type ApprovalResponse =
  | { decision: 'allow'; scope?: 'once' | 'session' | 'always'; rule?: string }
  | { decision: 'deny'; message?: string };

export interface QuestionRequest {
  id: string;
  /** The session that asks. */
  sessionId: string;
  /** As on ApprovalRequest: the top session, the chat the owner is in. */
  rootSessionId?: string;
  /** As on ApprovalRequest: set when a subagent or a workflow agent asks. */
  from?: AskFrom;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  createdAt: number;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  /** Message seq the checkpoint was taken before. */
  seq: number;
  /** Git commit in the shadow repo. */
  commit: string;
  files: number;
  createdAt: number;
  /** Device and folder the checkpoint was taken on. A restore works only there. Absent on older checkpoints. */
  device?: string;
  root?: string;
}

export interface Todo {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface Notice {
  /** The account this belongs to (docs/design/ACCOUNTS.md); 'owner' for the hub's owner. Rows from before accounts read as the owner's. */
  accountId?: string;
  id: string;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'error';
  sessionId?: string;
  /** Deep link path inside the app, e.g. "/s/<id>". */
  link?: string;
  /** Approval id so phone notifications can approve directly. */
  approvalId?: string;
  /** The question a "Question" notice is about, so an open Inbox can leave its toast out. */
  questionId?: string;
  /** The alert a notice is about (a file conflict, a stuck turn), for the same reason. */
  alertId?: string;
  /** A watch's run: what changed, with the items for the in-app card (watches/service.ts). */
  watch?: import('./watches/types').WatchNotice;
  /**
   * True when the owner's notification rules say this should reach devices
   * and no Conclave window is in use (or it is urgent). The desktop and
   * Android apps show it as a system notification while they are in the
   * background. Notices without it are for the open app only (toasts).
   */
  alert?: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Devices (machines that run tools: the hub itself plus paired daemons)
// ---------------------------------------------------------------------------

export interface MachineInfo {
  hostname: string;
  platform: string;
  arch: string;
  home: string;
  shell: string;
  /** Versions of useful CLIs found on PATH (claude, codex, opencode, gemini, git, rg, docker...). */
  clis: Record<string, string>;
  /** Free-form capabilities: browser, gpu, docker. */
  capabilities: string[];
  /** Which daemon answered, when it says: impl "rust" or "ts", and its version. */
  daemon?: DaemonSelf;
}

/** What a daemon says about itself in its hello (MachineInfo.daemon). */
export interface DaemonSelf {
  impl: string;
  version: string;
  /** Protocol 4: how it updates. self: it replaces itself when the hub asks (selfUpdate). app: the desktop app updates it. manual: by hand, updateWhy says how. */
  update?: 'self' | 'app' | 'manual';
  updateWhy?: string;
  /** The last update it ran, as the new binary saw it on start. */
  lastUpdate?: { from: string; to: string; ok: boolean; at: number; message?: string };
}

export interface Device {
  /** The account this belongs to (docs/design/ACCOUNTS.md); 'owner' for the hub's owner. Rows from before accounts read as the owner's. */
  accountId?: string;
  id: string;
  name: string;
  online: boolean;
  lastSeenAt?: number;
  info?: MachineInfo;
  /** Directories the device allows sessions to work in. Empty means home dir. */
  roots: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Remote access: how phones and paired computers reach the hub
// ---------------------------------------------------------------------------

/**
 * quick: a Cloudflare quick tunnel the hub runs itself (no account, the
 * address changes when the tunnel restarts). stable: a named Cloudflare
 * tunnel on the owner's domain. tailscale and custom: server.publicUrl, run
 * by the owner. off: no outside address (the same network still works).
 */
export type RemoteMode = 'off' | 'quick' | 'stable' | 'tailscale' | 'custom';

export type RemoteState = 'off' | 'installing' | 'starting' | 'on' | 'error';

/** One address that reaches the hub. */
export interface HubAddress {
  url: string;
  /** stable or quick: Cloudflare tunnel. own: server.publicUrl (Tailscale, a reverse proxy). lan: this network. */
  kind: 'stable' | 'quick' | 'own' | 'lan';
  /** "Wi-Fi 192.168.1.20", "Cloudflare tunnel". */
  label: string;
}

/** GET /api/remote, and the remote.updated event. */
export interface RemoteStatus {
  mode: RemoteMode;
  state: RemoteState;
  /** The outside address while it works: the tunnel URL, or the own URL for tailscale and custom. */
  url?: string;
  /** Every address that reaches the hub, best first. Pairing codes and links use the first one. */
  addresses: HubAddress[];
  /** The tunnel address before the last change. Clients still using it should move to `url`. */
  previousUrl?: string;
  /** When the state last changed. */
  since: number;
  /** What is happening now, in words ("Downloading cloudflared, 14 of 38 MB"). */
  detail?: string;
  /** What went wrong and what to do next. Set when state is "error". */
  error?: string;
  /** Same network access. */
  lan: {
    /** The owner allows devices on this network. */
    on: boolean;
    /** The hub listens on every interface, so the network can reach it. */
    listening: boolean;
    /** Set when server.host or --host pins the address the hub listens on. */
    fixedHost?: string;
  };
  /** Stable mode setup, when there is one. */
  stable?: { hostname: string; zone: string };
  /** True when a Cloudflare API token is saved on the hub. */
  cloudflareToken: boolean;
  /** The cloudflared binary in use. managed: the hub downloaded it. verified: its SHA-256 matched the digest GitHub publishes (false when GitHub's API did not answer and only size and format were checked). */
  cloudflared?: { path: string; version?: string; managed: boolean; verified?: boolean };
}

export interface AuditEntry {
  id: string;
  ts: number;
  sessionId?: string;
  device?: string;
  actor: string;
  action: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Engine events (streamed to every client over WebSocket)
// ---------------------------------------------------------------------------

export type EngineEvent =
  | { type: 'session.created'; session: Session }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.deleted'; sessionId: string; accountId?: string }
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  /** A message left the transcript: an empty reply, or a refused one the refusal fallback dropped before the next model answered. */
  | { type: 'message.deleted'; sessionId: string; messageId: string }
  | {
      type: 'message.delta';
      sessionId: string;
      messageId: string;
      index: number;
      kind: 'text' | 'thinking' | 'tool_input';
      text: string;
    }
  | { type: 'tool.started'; sessionId: string; messageId: string; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool.progress'; sessionId: string; toolUseId: string; text: string }
  | { type: 'tool.completed'; sessionId: string; toolUseId: string; result: ToolResultBlock }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; id: string; sessionId: string; response: ApprovalResponse }
  | { type: 'question.asked'; question: QuestionRequest }
  | { type: 'question.answered'; id: string; sessionId: string }
  | { type: 'todo.updated'; sessionId: string; todos: Todo[] }
  /** The messages waiting in a session changed: one was sent while it was busy, removed, started, or a Stop cleared them. The whole list, in the order they will run. */
  | { type: 'session.queue'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'usage.recorded'; record: UsageRecord }
  | { type: 'limit.updated'; limit: LimitState }
  | { type: 'notice'; notice: Notice }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string; accountId?: string }
  | { type: 'routine.updated'; routine: Routine }
  | { type: 'routine.deleted'; routineId: string; accountId?: string }
  | { type: 'routine.run'; run: RoutineRun }
  | { type: 'memory.updated'; entry: MemoryEntry }
  | { type: 'memory.deleted'; id: string; accountId?: string }
  | { type: 'device.updated'; device: Device }
  | { type: 'device.deleted'; deviceId: string; accountId?: string }
  | { type: 'checkpoint.created'; sessionId: string; checkpoint: Checkpoint }
  /** The regression gate ran a turn's changed tests on the code from before the turn (session/regression-gate.ts). */
  | {
      type: 'regression.checked';
      sessionId: string;
      /** proven: the tests fail on the old code; passes: they pass there; not_run: the run says nothing; skipped: it did not run them. */
      outcome: 'proven' | 'passes' | 'not_run' | 'skipped';
      command: string | null;
      tests: string[];
      why: string;
      /** The agent got the reminder (passes, once per user turn). */
      reminded: boolean;
    }
  | { type: 'remote.updated'; remote: RemoteStatus }
  /** An app paired, was revoked, or connected or went away (phones are apps, not devices). */
  | { type: 'app.updated'; app: import('./client').AppDto }
  // ----- subscription sign-in (server/src/cliproxy); accountId: a member's own plans (cliproxy/member.ts), the owner's have none -----
  | { type: 'subscriptions.updated'; status: import('./client/subscriptions').SubscriptionsStatus; accountId?: string }
  // ----- accounts and their order (accounts/**); accountId as above -----
  | { type: 'accounts.updated'; status: import('./client/accounts').AccountsStatus; accountId?: string }
  // ----- the model list changed (a harness said which Effort levels it offers): apps fetch it again -----
  | { type: 'models.updated' }
  // ----- chat import (import/**) -----
  | { type: 'import.batch'; batch: import('./client/import').ImportBatch }
  /** An offer to import a newly paired computer's chats opened (offer) or closed (no offer): dismissed, imported or the device removed. */
  | { type: 'import.offer'; accountId: string; device: string; offer?: import('./client/import').ImportOffer }
  // ----- folders across devices (projects/**) -----
  | { type: 'project.updated'; project: import('./client/projects').ProjectDto }
  | {
      type: 'session.moved';
      sessionId: string;
      from: { device: string; cwd: string };
      to: { device: string; cwd: string };
      via: import('./client/projects').LocationVia;
      level: import('./client/projects').MatchLevel;
    }
  // ----- workflows (workflows/**) -----
  | { type: 'workflow.run'; run: import('./client/workflows').WorkflowRun }
  | { type: 'workflow.phase'; runId: string; index: number; title: string }
  | { type: 'workflow.agent'; runId: string; call: import('./client/workflows').WorkflowCall }
  | { type: 'workflow.log'; runId: string; ts: number; text: string }
  /** High volume: kept out of the replay buffer like tool.progress. */
  // callSeq, not seq: the event envelope's own seq would overwrite it
  | { type: 'workflow.progress'; runId: string; callSeq: number; lastTool: string; waiting?: 'approval' | false }
  // ----- friends: hub to hub (server/src/peer, docs/design/FRIENDS.md) -----
  | { type: 'friend.updated'; friend: import('./client/friends').FriendDto }
  /** A message from a friend landed in the Inbox. It is data: nothing runs because of it. */
  | { type: 'friend.message'; message: import('./client/friends').InboxItemDto }
  // ----- alerts: file conflicts and stuck turns (alerts/**) -----
  /** An alert landed in the Inbox, or an open one changed. */
  | { type: 'alert.raised'; alert: import('./client/alerts').AlertItem }
  /** It left the Inbox: answered, dismissed, or it cleared itself. */
  | { type: 'alert.cleared'; id: string; sessionId: string }
  /** A share from a friend: offered (received), a new revision (updated), fetched (accepted), unsent (revoked), or expired. Nothing runs because of it. */
  | { type: 'friend.share'; change: 'received' | 'updated' | 'accepted' | 'revoked' | 'expired'; share: import('./client/friends').ReceivedShareDto }
  /** A share this hub sent: sent, updated, accepted by a friend, unsent (revoked), or failed. */
  | { type: 'friend.share.sent'; change: 'sent' | 'updated' | 'accepted' | 'revoked' | 'failed'; share: import('./client/friends').SentShareDto }
  /** A shared project changed here: an invite, its members, an item from a member. Friend content is data: nothing runs because of it. */
  | { type: 'friend.project'; change: import('./client/shared-projects').SharedProjectChange; project: import('./client/shared-projects').SharedProjectDto; item?: import('./client/shared-projects').SharedItemDto }
  // ----- the Map (map/live.ts): token and tool activity, only to clients that watch it -----
  /** High volume: kept out of the replay buffer like tool.progress. */
  | { type: 'map.delta'; delta: import('./client/map').MapDelta }
  | { type: 'config.updated' };

/** account: whose the event is (an account id, or '*' for every account); the hub sends it only there. */
export type EngineEventEnvelope = EngineEvent & { seq: number; ts: number; account?: string };

// ---------------------------------------------------------------------------
// JSON schema (subset used for tool inputs)
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  [key: string]: unknown;
}
