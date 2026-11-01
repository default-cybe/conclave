/**
 * DTOs of the chat import routes (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.13).
 * Types only, so the web app and the CLI can import them without hub code.
 */
import type { MemoryEntry } from '../types';

/** Where a past chat comes from. claude-ai and chatgpt arrive as uploaded export files. */
export type ImportSource = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'claude-ai' | 'chatgpt';

/** chats: sessions only. chats-learn: sessions, then the learning job. learn: memory only, no session rows. */
export type ImportMode = 'chats' | 'chats-learn' | 'learn';

/** main: a chat the owner had. subagent and internal threads sit under their parent. automation: sdk or exec runs. */
export type ImportSessionKind = 'main' | 'subagent' | 'automation' | 'internal';

/** Why a row is skipped by default. Each one has a filter to include it. */
export type ImportSkip = 'automation' | 'subagent' | 'internal' | 'too-short';

/** How an imported session compares with its source now. */
export type ImportedState = 'current' | 'behind' | 'diverged';

export interface ExternalSessionInfo {
  source: ImportSource;
  /** The tool's own session id (Claude Code session, Codex thread, conversation uuid). */
  id: string;
  title: string;
  cwd?: string;
  /** Last line time, epoch ms. */
  updatedAt: number;
  /** Messages after conversion (user and assistant turns). */
  messages: number;
  device: string;
  /** Stable key of this source location on this device. Selections use it. */
  key: string;
  /** File on the device (or upload:<id>#<n> for uploaded exports). */
  path: string;
  /** Same on every device for the same conversation (a Syncthing copy matches its original). */
  fingerprint: string;
  /** First line time, epoch ms. */
  createdAt: number;
  gitBranch?: string;
  /** Git remote or repo name when the source records one. */
  repo?: string;
  kind: ImportSessionKind;
  /** Key of the parent session, for subagent and internal threads. */
  parentKey?: string;
  /** Prompts the owner typed (not task notices, peer messages or tool results). */
  humanPrompts: number;
  /** Characters the owner typed. */
  humanChars: number;
  bytes: number;
  /** Rough tokens the learning job would read, after its caps. */
  estTokens: number;
  skip?: ImportSkip;
  imported?: { sessionId?: string; state: ImportedState; batchId: string; learned: boolean; newThere?: number };
  /** Model the session used last, as "provider/model" when known. */
  model?: string;
}

export interface ImportScanQuery {
  device?: string;
  sources?: ImportSource[];
  /** Epoch ms or ISO date. Rows last active before it are left out. */
  since?: number | string;
  until?: number | string;
  /** Project group key, repo or cwd prefix. */
  project?: string;
  kinds?: ImportSessionKind[];
  /** Default true. False hides rows already imported and current. */
  includeImported?: boolean;
  /** Default true: skipped rows are listed with their reason. False leaves them out. */
  includeSkipped?: boolean;
  /** Words in the title or folder. */
  q?: string;
  cursor?: string;
  limit?: number;
  /** Read the device again instead of the cached rows. */
  refresh?: boolean;
}

/** One project in the scan: sessions grouped by repo when known, else by folder. */
export interface ImportProjectGroup {
  key: string;
  name: string;
  repo?: string;
  cwd?: string;
  sources: ImportSource[];
  sessions: number;
  imported: number;
  skipped: number;
  first: number;
  last: number;
}

export interface ImportScanPage {
  items: ExternalSessionInfo[];
  next?: string;
  /** Rows matching the query on every page. */
  total: number;
  /** When the device was last read. Older than now when it is offline and the rows are cached. */
  scannedAt?: number;
  /** True when the device is offline and the rows come from the last scan. */
  offline?: boolean;
  /** Sources that could not be read, with the reason. */
  failed: Array<{ source: ImportSource; error: string }>;
  retention: ImportRetention[];
  /** Counts over the whole query. */
  counts: { new: number; imported: number; behind: number; diverged: number; skipped: number };
  /** On the first page only: every project group of the query. */
  groups?: ImportProjectGroup[];
  /** Line or content types the readers did not know, counted, so format drift shows. */
  unknown?: Record<string, number>;
}

/** What a batch or an estimate covers. keys, or query minus exclude, or Conclave session ids (learn only). */
export interface ImportSelection {
  device: string;
  keys?: string[];
  query?: Omit<ImportScanQuery, 'cursor' | 'limit' | 'refresh' | 'device'>;
  exclude?: string[];
  /** Conclave sessions to learn from (old chats, earlier imports done without learning). Mode learn only. */
  sessionIds?: string[];
  /** Every imported session that was not learned yet. Mode learn only. */
  notLearned?: boolean;
}

export interface ImportEstimateInput extends ImportSelection {
  mode: ImportMode;
  model?: string;
  includeSkipped?: boolean;
}

export interface ImportCostOption {
  model: string;
  costUsd: number;
  /** The model memory.importModel (or smallModel) names. */
  configured?: boolean;
  /** Billed by a plan, not per token. */
  free?: boolean;
  /** The hub has a key or login for it. */
  usable: boolean;
}

export interface ImportEstimate {
  sessions: number;
  /** Sessions the selection matched that the batch skips, by reason. */
  skipped: Partial<Record<ImportSkip, number>>;
  /** Already imported and current: nothing to copy (they can still be learned). */
  alreadyImported: number;
  windows: number;
  tokensIn: number;
  tokensOut: number;
  consolidationCalls: number;
  /** The configured model first, then up to two alternatives and the free one. */
  options: ImportCostOption[];
  model: string;
}

export interface ImportBatchInput extends ImportSelection {
  mode: ImportMode;
  model?: string;
  includeSkipped?: boolean;
  /** One Basic Memory note per imported session instead of the monthly digest. */
  episodeNotes?: boolean;
}

export type ImportBatchStatus = 'scanning' | 'importing' | 'learning' | 'consolidating' | 'paused' | 'waiting_reset' | 'done' | 'failed' | 'cancelled' | 'undone';
export type ImportItemState = 'queued' | 'imported' | 'updated' | 'forked' | 'unchanged' | 'skipped' | 'failed' | 'learned';

export interface ImportBatch {
  id: string;
  /** Whose batch (docs/design/ACCOUNTS.md). */
  accountId?: string;
  device: string;
  mode: ImportMode;
  model?: string;
  status: ImportBatchStatus;
  total: number;
  imported: number;
  updated: number;
  forked: number;
  unchanged: number;
  skipped: number;
  failed: number;
  learnedSessions: number;
  memoriesAdded: number;
  memoriesMerged: number;
  memoriesReview: number;
  /** Learned facts not saved because the owner's own notes (Basic Memory) already state them. Older hubs leave it out. */
  memoriesInNotes?: number;
  /** Learned items the checks dropped, by reason (evidence, basis, kind, length, secret, duplicate, supersedes, profile). */
  dropped: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** waiting_reset: when the model's limit resets and the job goes on. */
  resumeAt?: number;
  error?: string;
  /** Undo is offered until then (30 days). */
  undoUntil?: number;
}

export interface ImportBatchItem {
  key: string;
  state: ImportItemState;
  sessionId?: string;
  title?: string;
  source?: ImportSource;
  /** Memories this item added or merged. */
  memories: number;
  reason?: string;
  updatedAt: number;
}

export interface ImportBatchDetail extends ImportBatch {
  items: ImportBatchItem[];
  next?: string;
}

export interface ImportBatchesDto {
  batches: ImportBatch[];
  /** Imported sessions not learned yet ("Learn from 212 imported chats not learned yet"). */
  notLearned: number;
}

export interface ImportUndoResult {
  sessionsRemoved: number;
  messagesRemoved: number;
  memoriesRemoved: number;
  supersedesCleared: number;
  /** Memories the owner edited since the batch, kept. */
  kept: Array<{ id: string; content: string }>;
  /** Sessions the owner kept going in after the import, kept whole with the messages the batch added. */
  keptSessions?: Array<{ id: string; title: string }>;
}

export interface ImportUploadResult {
  uploadId: string;
  source: 'claude-ai' | 'chatgpt';
  /** Conversations found. Start a batch with device "upload:<uploadId>". */
  items: number;
  unknownContentTypes: Record<string, number>;
}

export interface ImportSyncResult {
  state: 'unchanged' | 'updated' | 'forked' | 'failed';
  added: number;
  forkedSessionId?: string;
  error?: string;
}

/** A vendor setting that deletes old chats, read on a device. */
export interface ImportRetention {
  device: string;
  tool: 'claude-code' | 'gemini';
  /** The settings file, as a path on the device. */
  file: string;
  /** cleanupPeriodDays or general.sessionRetention. */
  setting: string;
  /** What the file says now (days, or the retention object). Undefined when unset. */
  value?: unknown;
  /** high: chats older than about a month are deleted. none: kept for years. */
  risk: 'high' | 'low' | 'none';
  /** One plain sentence for the warning. */
  text: string;
  fixable: boolean;
}

/** Shown on an imported session (Session.meta.import). */
export interface SessionImportInfo {
  source: ImportSource;
  device: string;
  path: string;
  /** The tool's session id. */
  id: string;
  importedAt: number;
  batchId?: string;
  /** First message time in the source. */
  createdAt?: number;
  /** The model the chat ran on in the source (anthropic/claude-opus-4-6). */
  model?: string;
  state?: ImportedState;
  /** Messages in the source that are not here yet. */
  newThere?: number;
  learned?: boolean;
  /** False for a tool's own memory or review thread (Codex memory_consolidation, guardian_review): never learned from. */
  learnable?: boolean;
  /** When the owner first wrote in it here: it left the Imported place (session/imported.ts). */
  continuedAt?: number;
}

/**
 * An offer to import a computer's past chats, made once when it pairs for the
 * first time and the scan finds some (import/offers.ts). It waits in the Inbox
 * and on the device's row in Devices until the owner imports or dismisses it.
 */
export interface ImportOffer {
  device: string;
  deviceName: string;
  /** Chats the import would bring by default: not imported yet, not too short, not automation. */
  chats: number;
  /** The same chats per tool. */
  sources: Partial<Record<ImportSource, number>>;
  /** "Found 12 chats from Claude Code and Codex on studio. Import them?" */
  text: string;
  createdAt: number;
}

export interface MemoryReviewItem {
  memory: MemoryEntry;
  evidence?: string;
  basis?: string;
  source?: string;
  device?: string;
  observedAt?: number;
  seenCount: number;
  /** Title of the session it came from, when that session is in Conclave. */
  sessionTitle?: string;
}
