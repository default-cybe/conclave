/**
 * Chat import (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md section 1): scan
 * devices for past Claude Code, Codex and Gemini CLI sessions (and uploaded
 * claude.ai and ChatGPT exports), import them through a ledger that never
 * inserts a conversation twice, and learn memory from them in a durable job.
 *
 * A batch is a durable scheduler job (import.run). The ledger row is written
 * before the session, items that are done are skipped, so a hub restart
 * re-runs the job and it continues where it stopped. Pause stops between
 * sessions. A 429 or quota error parks the batch until the reset.
 */
import { join } from 'node:path';
import type { Message, MemoryEntry, Session, ToolResultBlock } from '../types';
import type {
  ExternalSessionInfo,
  ImportBatch,
  ImportBatchDetail,
  ImportBatchInput,
  ImportBatchesDto,
  ImportCostOption,
  ImportEstimate,
  ImportEstimateInput,
  ImportItemState,
  ImportMode,
  ImportProjectGroup,
  ImportRetention,
  ImportScanPage,
  ImportScanQuery,
  ImportSelection,
  ImportSessionKind,
  ImportSkip,
  ImportSource,
  ImportSyncResult,
  ImportUndoResult,
  ImportUploadResult,
  MemoryReviewItem,
  SessionImportInfo,
} from '../client/import';
import type { Engine } from '../engine/engine';
import type { Machine } from '../machine/types';
import type { SqliteMemory } from '../memory/store';
import { ProviderError } from '../providers/types';
import { streamCompletion } from '../session/stream';
import { newId } from '../util/ids';
import { logger } from '../util/log';
import { oneLine, truncateMiddle } from '../util/text';
import { hashText } from '../memory/connections/util';
import { episodeNote } from '../memory/external';
import { redactSecrets } from '../memory/secrets';
import { externalId, humanText, sessionStats, type ConvertedSession, type ImportedMessage } from '../importers/types';
import { claudeDeviceCwd, stripWrappers } from '../importers/claude-code';
import { sha256Hex } from '../importers/files';
import { ImportStore, batchDto, EMPTY_COUNTS, UNDO_DAYS, type BatchRow, type ItemRow, type LedgerRow, type ScanCacheRow } from './store';
import { DEVICE_SOURCES, ReadContext, fingerprintOf, rowInfo, scanMachine, sourceName, type FoundSession, type RowInfo, type ScanResult } from './sources';
import { importedIds, planSync, prefixHash } from './ledger';
import { renderWindows, RENDER_LIMITS } from './render';
import { applyConsolidation, buildConsolidatePrompt, buildLearnPrompt, checkItems, CONSOLIDATE_SYSTEM, landItems, LEARN_SYSTEM, parseLearnReply, type LearnContext, type LearnedItem } from './learn';
import { fixRetention, readRetention } from './retention';
import { UploadError, Uploads, uploadIdOf, UPLOAD_PREFIX } from './upload';
import { importOffersOf } from './registry';
import { DEVICE_TOOL_CHARS } from './wire';
import { projectsOf } from '../projects/attached';
import { OWNER_ID, currentAccount, isMember, runAs } from '../people/context';

const log = logger('import');

export const RUN_JOB = 'import.run';
export const WATCH_JOB = 'import.watch';
const WATCH_EVERY_MS = 6 * 3_600_000;
/** A scan younger than this is served from the cache unless refresh is asked for. */
const SCAN_FRESH_MS = 60_000;
const LEARN_CONCURRENCY = 4;
const EST_PROMPT_TOKENS = 3_000;
const EST_OUT_TOKENS = 1_000;
const CONSOLIDATE_IN = 6_000;
const CONSOLIDATE_OUT = 1_000;
const MIN_PROMPTS = 2;
const MIN_HUMAN_CHARS = 300;
/** Cheap models offered next to the configured one in the estimate, best first. */
const ALTERNATIVES = ['anthropic/claude-haiku-5-5', 'openai/gpt-5-mini', 'google/gemini-3.1-flash-lite', 'zai/glm-4.7-flash'];

export class ImportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The model hit a limit: the batch waits until resetAt. */
class Parked extends Error {
  constructor(readonly resetAt: number) {
    super('limit');
  }
}

/** One chat's copies as mergeDuplicates leaves them. */
export interface MergeGroup {
  nativeId: string;
  keep: string;
  title: string;
  branches: Array<{ id: string; title: string }>;
  archived: string[];
  ledgerRows: number;
}

/** One scan row, ready for the list and for selections. */
interface Row extends ScanCacheRow {
  key: string;
  info: RowInfo;
}

export function rowKey(device: string, source: string, path: string): string {
  return 'k_' + sha256Hex(`${device}\n${source}\n${path}`).slice(0, 20);
}

function skipOf(info: RowInfo): ImportSkip | undefined {
  if (info.kind === 'automation') return 'automation';
  if (info.kind === 'subagent') return 'subagent';
  if (info.kind === 'internal') return 'internal';
  if (info.humanPrompts < MIN_PROMPTS || info.humanChars < MIN_HUMAN_CHARS) return 'too-short';
  return undefined;
}

function toTime(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** At most 6 lines and 1,200 characters: an episode is a short note, whatever the model sends. */
export function clipEpisode(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((l) => (l.length > 240 ? `${l.slice(0, 237)}...` : l));
  const out = lines.join('\n');
  return out.length > 1200 ? `${out.slice(0, 1197)}...` : out;
}

const ROLES = new Set(['user', 'assistant']);
const KINDS = new Set<ImportSessionKind>(['main', 'subagent', 'automation', 'internal']);
const MSG_KINDS = new Set(['normal', 'aside', 'summary', 'notice']);

/**
 * A converted session from a v2 device, checked before it is stored: the
 * source is the one the hub asked for, and anything that is not a message
 * (no role, content that is not a list of blocks, no time) is counted and
 * left out. A device with a bug, or a different version, cannot put rows in
 * the hub's database that the apps cannot draw.
 */
export function checkDeviceSession(raw: unknown, source: ImportSource): ConvertedSession {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ImportError(502, 'The device sent a session the hub cannot read.');
  const c = raw as Partial<ConvertedSession> & Record<string, unknown>;
  const unknown: Record<string, number> = c.unknown && typeof c.unknown === 'object' && !Array.isArray(c.unknown) ? { ...c.unknown } : {};
  const messages: ImportedMessage[] = [];
  for (const m of Array.isArray(c.messages) ? c.messages : []) {
    const ok =
      !!m &&
      typeof m === 'object' &&
      ROLES.has((m as ImportedMessage).role) &&
      Array.isArray((m as ImportedMessage).content) &&
      (m as ImportedMessage).content.every((b) => !!b && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string') &&
      Number.isFinite((m as ImportedMessage).createdAt);
    if (!ok) {
      unknown['message:unreadable'] = (unknown['message:unreadable'] ?? 0) + 1;
      continue;
    }
    const msg = m as ImportedMessage;
    messages.push(MSG_KINDS.has(msg.kind) ? msg : { ...msg, kind: 'normal' });
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const kind = KINDS.has(c.kind as ImportSessionKind) ? (c.kind as ImportSessionKind) : 'main';
  return {
    source,
    nativeId: str(c.nativeId),
    // the hub decides, so every device's copy of a chat gets the same fingerprint (importers/claude-code.ts)
    nativeIdUnique: source === 'claude-code' ? kind !== 'subagent' : c.nativeIdUnique !== false,
    title: str(c.title) && redactSecrets(str(c.title)!),
    cwd: str(c.cwd),
    gitBranch: str(c.gitBranch),
    repo: str(c.repo),
    model: str(c.model),
    kind,
    parentNativeId: str(c.parentNativeId),
    entrypoint: str(c.entrypoint),
    messages,
    unknown,
    learnable: c.learnable !== false,
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';

function okFound(f: unknown): f is FoundSession {
  const x = f as FoundSession;
  return !!x && typeof x === 'object' && DEVICE_SOURCES.includes(x.source) && isStr(x.path) && isNum(x.size) && isNum(x.mtime) && optStr(x.parent) && optStr(x.project);
}

function okInfo(i: unknown): i is RowInfo {
  const x = i as RowInfo;
  return (
    !!x &&
    typeof x === 'object' &&
    isStr(x.id) &&
    typeof x.title === 'string' &&
    isStr(x.fingerprint) &&
    KINDS.has(x.kind) &&
    [x.messages, x.humanPrompts, x.humanChars, x.createdAt, x.updatedAt, x.estTokens].every(isNum) &&
    [x.cwd, x.gitBranch, x.repo, x.model, x.parentId, x.entrypoint].every(optStr) &&
    (x.unknown === undefined || (typeof x.unknown === 'object' && !Array.isArray(x.unknown)))
  );
}

/** A v2 device's scan reply, checked: rows of the wrong shape are left out, an unreadable info becomes an error row. */
export function checkDeviceScan(raw: unknown): ScanResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScanResult>;
  const rows: ScanResult['rows'] = [];
  for (const row of Array.isArray(r.rows) ? r.rows : []) {
    if (!row || typeof row !== 'object' || !okFound(row.found)) continue;
    const found: FoundSession = { source: row.found.source, path: row.found.path, size: row.found.size, mtime: row.found.mtime, ...(row.found.parent ? { parent: row.found.parent } : {}), ...(row.found.project ? { project: row.found.project } : {}), ...(row.found.archived ? { archived: true } : {}) };
    if (row.info !== undefined && okInfo(row.info)) rows.push({ found, info: { ...row.info, title: redactSecrets(row.info.title), learnable: row.info.learnable !== false } });
    else rows.push({ found, error: typeof row.error === 'string' ? row.error.slice(0, 300) : 'The device sent a row the hub cannot read.' });
  }
  const present = (Array.isArray(r.present) ? r.present : []).filter(okFound);
  const failed = (Array.isArray(r.failed) ? r.failed : []).filter((f) => !!f && typeof f === 'object' && typeof f.error === 'string' && DEVICE_SOURCES.includes(f.source));
  return { rows, present, failed };
}

/** Normalized git remote, for grouping: host/owner/repo, lower case, no scheme, user or .git. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[^@\s/]+@([^:\s]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  const [host, ...rest] = u.split('/');
  return `${host.replace(/:\d+$/, '').toLowerCase()}/${rest.join('/')}`.replace(/\.git$/, '').replace(/\/+$/, '');
}

function groupOf(info: RowInfo): { key: string; name: string; repo?: string; cwd?: string } {
  if (info.repo) {
    const repo = /[/:@]/.test(info.repo) ? normalizeRemote(info.repo) : info.repo;
    return { key: `repo:${repo}`, name: repo.split('/').pop() || repo, repo, ...(info.cwd ? { cwd: info.cwd } : {}) };
  }
  if (info.cwd) return { key: `cwd:${info.cwd}`, name: info.cwd.split('/').filter(Boolean).pop() ?? info.cwd, cwd: info.cwd };
  return { key: 'none', name: 'No folder' };
}

const HARNESS: Partial<Record<ImportSource, { harness: string; model: string }>> = {
  'claude-code': { harness: 'claude-code', model: 'claude-code/default' },
  codex: { harness: 'codex', model: 'codex/default' },
  gemini: { harness: 'gemini-cli', model: 'gemini-cli/default' },
};

export class ImportService {
  readonly store: ImportStore;
  readonly uploads: Uploads;
  private emitAt = new Map<string, number>();
  private emitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();

  constructor(private engine: Engine) {
    this.store = new ImportStore(engine.repos.db);
    this.uploads = new Uploads(join(engine.config.paths.home, 'imports'));
  }

  /**
   * The account this import work is for (docs/design/ACCOUNTS.md): the
   * request's, or the batch's while a batch runs (runBatch runs it as that
   * account). Sessions, ledger rows and learned memories are its own.
   */
  private get acct(): string {
    return currentAccount() ?? OWNER_ID;
  }

  private get memory(): SqliteMemory {
    return this.engine.memoryFor(this.acct);
  }

  /** A device or upload this account may import from: its own devices, the hub for the owner, its own uploads. */
  private checkSource(device: string): void {
    const up = uploadIdOf(device);
    if (up) {
      const owner = this.engine.repos.kv.get<string | null>(`import.upload.${up}`, null) ?? OWNER_ID;
      if (owner !== this.acct) throw new ImportError(404, 'Unknown upload.');
      return;
    }
    const owner = this.engine.repos.devices.accountOf(device || 'local');
    if (owner !== this.acct) throw new ImportError(404, `Unknown device ${device}`);
  }

  /** Register the jobs and pick up batches a restart left half done. */
  start(): void {
    this.engine.scheduler.handle(RUN_JOB, (p) => this.runBatch(String(p.batchId ?? '')));
    this.engine.scheduler.handle(WATCH_JOB, () => this.watch());
    for (const b of this.store.unfinished()) {
      const at = b.status === 'waiting_reset' && b.resumeAt ? b.resumeAt : Date.now();
      this.engine.scheduler.enqueue(RUN_JOB, at, { batchId: b.id }, `${RUN_JOB}.${b.id}`);
    }
    if (this.engine.config.get().import?.watch) this.engine.scheduler.enqueue(WATCH_JOB, Date.now() + WATCH_EVERY_MS, {}, WATCH_JOB);
    this.engine.config.onChange(() => {
      if (this.engine.config.get().import?.watch && !this.engine.repos.jobs.pending(WATCH_JOB).length) this.engine.scheduler.enqueue(WATCH_JOB, Date.now() + 60_000, {}, WATCH_JOB);
    });
    try {
      this.uploads.prune();
    } catch (err) {
      log.warn(`pruning old uploads failed: ${(err as Error).message}`);
    }
    // imported sessions without a project find it once their device is there to read the folder
    const backfill = (device: string) => void this.attachProjects(device).catch((err) => log.debug(`projects of imports on ${device} skipped`, err));
    this.engine.bus.on((e) => {
      if (e.type === 'device.updated' && e.device.online && e.device.id !== 'local') backfill(e.device.id);
    });
    setTimeout(() => backfill('local'), 2_000).unref?.();
  }

  private deviceName(device: string): string {
    if (device.startsWith(UPLOAD_PREFIX)) return 'an upload';
    return this.engine.devices.list().find((d) => d.id === device)?.name ?? device;
  }

  private machine(device: string): Machine | undefined {
    return this.engine.devices.get(device);
  }

  // -------------------------------------------------------------------------
  // scan
  // -------------------------------------------------------------------------

  private scanState(device: string): { at?: number; failed?: ImportScanPage['failed'] } {
    return this.engine.repos.kv.get(`import.scan.${device}`, {});
  }

  /** Read a device (or an upload) and update the cache. Offline devices keep their last rows. */
  async refreshDevice(device: string, force = false): Promise<{ offline: boolean; scannedAt?: number; failed: ImportScanPage['failed'] }> {
    const uploadId = uploadIdOf(device);
    if (uploadId) {
      const meta = this.uploads.meta(uploadId);
      if (!meta) throw new ImportError(404, `Unknown upload ${uploadId}. Uploads are kept for 30 days.`);
      if (!this.store.scanRows(device).length || force) {
        const rows: ScanCacheRow[] = [];
        for (const { path, conv } of this.uploads.conversations(uploadId)) {
          rows.push({ device, path, source: meta.source, size: 0, mtime: meta.createdAt, info: rowInfo(conv, { path, mtime: meta.createdAt }), scannedAt: Date.now() });
        }
        this.store.putScan(rows);
      }
      return { offline: false, scannedAt: meta.createdAt, failed: [] };
    }
    const state = this.scanState(device);
    const machine = this.machine(device);
    if (!machine) return { offline: true, scannedAt: state.at, failed: state.failed ?? [] };
    if (!force && state.at && Date.now() - state.at < SCAN_FRESH_MS) return { offline: false, scannedAt: state.at, failed: state.failed ?? [] };
    const cached = this.store.scanRows(device);
    const known = new Map(cached.filter((r) => r.info || r.error).map((r) => [r.path, { size: r.size, mtime: r.mtime }]));
    // a v2 daemon reads its own disk and sends rows for changed files only; a v1 daemon is read from here, once per change
    const res = machine.importScan && device !== 'local' ? checkDeviceScan(await machine.importScan({ known: [...known].map(([p, k]) => [p, k.size, k.mtime] as [string, number, number]) })) : await scanMachine(machine, { known });
    const now = Date.now();
    this.store.putScan(res.rows.map((r) => ({ device, path: r.found.path, source: r.found.source, size: r.found.size, mtime: r.found.mtime, info: r.info, error: r.error, scannedAt: now })));
    const present = new Set(res.present.map((f) => f.path));
    this.store.dropScan(
      device,
      cached.filter((r) => !present.has(r.path)).map((r) => r.path),
    );
    const failed = res.failed;
    this.engine.repos.kv.set(`import.scan.${device}`, { at: now, failed });
    this.refreshImportedLines(device);
    return { offline: false, scannedAt: now, failed };
  }

  /**
   * Cached rows of a device with their keys. A chat without a git remote
   * (Claude Code and Gemini CLI do not record one) takes the remote another
   * chat in the same folder recorded, so one project is one group.
   */
  private rows(device: string): Row[] {
    const list = this.store
      .scanRows(device)
      .filter((r): r is ScanCacheRow & { info: RowInfo } => !!r.info && r.info.messages > 0)
      .map((r) => ({ ...r, key: rowKey(device, r.source, r.path) }));
    const repos = new Map<string, string>();
    for (const r of list) if (r.info.repo && r.info.cwd && /[/:@]/.test(r.info.repo)) repos.set(r.info.cwd.replace(/\/+$/, ''), r.info.repo);
    if (!repos.size) return list;
    const roots = [...repos.keys()].sort((a, b) => b.length - a.length);
    return list.map((r) => {
      if (r.info.repo || !r.info.cwd) return r;
      const root = roots.find((c) => r.info.cwd === c || r.info.cwd!.startsWith(c + '/'));
      return root ? { ...r, info: { ...r.info, repo: repos.get(root) } } : r;
    });
  }

  /** The imported state of a row: from its ledger row, or another location with the same fingerprint. */
  private importedOf(r: Row): ExternalSessionInfo['imported'] {
    const here = this.store.ledgerAt(r.source, r.device, r.path);
    const rows = here ? [here] : this.store.ledgerByFingerprint(r.info.fingerprint, this.acct);
    const l = rows.find((x) => x.status === 'ok');
    if (!l) return undefined;
    const session = l.sessionId ? this.engine.repos.sessions.get(l.sessionId) : undefined;
    if (l.sessionId && !session) return undefined;
    // learned only (mode learn): no session yet, so nothing is behind or diverged
    if (!l.sessionId) return { state: 'current', batchId: l.batchId ?? '', learned: l.learnState === 'learned' };
    const sameFile = here && here.size === r.size && here.mtime === r.mtime;
    const newThere = Math.max(0, r.info.messages - (l.cursor.count ?? 0) - (l.cursor.absorbed?.length ?? 0));
    let state: 'current' | 'behind' | 'diverged' = 'current';
    if (!sameFile && newThere > 0) state = session && this.hasNative(session.id) ? 'diverged' : 'behind';
    return { ...(l.sessionId ? { sessionId: l.sessionId } : {}), state, batchId: l.batchId ?? '', learned: l.learnState === 'learned', ...(state !== 'current' ? { newThere } : {}) };
  }

  /** The session has messages Conclave wrote after the import. */
  private hasNative(sessionId: string): boolean {
    const last = this.engine.repos.messages.tail(sessionId, 1)[0];
    return !!last && !externalId(last) && last.kind !== 'notice';
  }

  private toInfo(r: Row, parents: Map<string, string>): ExternalSessionInfo {
    const i = r.info;
    const skip = skipOf(i);
    const imported = this.importedOf(r);
    // subagent and internal threads sit under their parent; a fork (a main thread with a parent) stands alone
    const parentKey = i.parentId && (i.kind === 'subagent' || i.kind === 'internal') ? parents.get(`${r.source}:${i.parentId}`) : undefined;
    return {
      source: r.source,
      id: i.id,
      title: i.title,
      ...(i.cwd ? { cwd: i.cwd } : {}),
      updatedAt: i.updatedAt,
      messages: i.messages,
      device: r.device,
      key: r.key,
      path: r.path,
      fingerprint: i.fingerprint,
      createdAt: i.createdAt,
      ...(i.gitBranch ? { gitBranch: i.gitBranch } : {}),
      ...(i.repo ? { repo: i.repo } : {}),
      kind: i.kind,
      ...(parentKey ? { parentKey } : {}),
      humanPrompts: i.humanPrompts,
      humanChars: i.humanChars,
      bytes: r.size,
      estTokens: i.estTokens,
      ...(skip ? { skip } : {}),
      ...(imported ? { imported } : {}),
      ...(i.model ? { model: i.model } : {}),
    };
  }

  /** Rows of a device that match a query, newest first, with subagent rows after their parent. */
  private query(device: string, q: Omit<ImportScanQuery, 'cursor' | 'limit' | 'refresh' | 'device'>): ExternalSessionInfo[] {
    const rows = this.rows(device);
    const parents = new Map<string, string>();
    for (const r of rows) if (r.info.kind === 'main' || r.info.kind === 'automation') parents.set(`${r.source}:${r.info.id}`, r.key);
    const since = toTime(q.since);
    const until = toTime(q.until);
    const words = q.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const out: ExternalSessionInfo[] = [];
    for (const r of rows) {
      if (q.sources?.length && !q.sources.includes(r.source)) continue;
      if (since && r.info.updatedAt < since) continue;
      if (until && r.info.updatedAt > until) continue;
      if (q.kinds?.length && !q.kinds.includes(r.info.kind)) continue;
      if (q.project) {
        const g = groupOf(r.info);
        if (g.key !== q.project && g.repo !== q.project && !(r.info.cwd && (r.info.cwd === q.project || r.info.cwd.startsWith(q.project + '/')))) continue;
      }
      if (words.length) {
        const hay = `${r.info.title} ${r.info.cwd ?? ''} ${r.info.repo ?? ''}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      const info = this.toInfo(r, parents);
      if (q.includeImported === false && info.imported?.state === 'current' && info.imported.sessionId) continue;
      if (q.includeSkipped === false && info.skip) continue;
      out.push(info);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    // nest subagent and internal threads under their parent
    const kids = new Map<string, ExternalSessionInfo[]>();
    const top: ExternalSessionInfo[] = [];
    const keys = new Set(out.map((x) => x.key));
    for (const x of out) {
      if (x.parentKey && keys.has(x.parentKey)) kids.set(x.parentKey, [...(kids.get(x.parentKey) ?? []), x]);
      else top.push(x);
    }
    return top.flatMap((x) => [x, ...(kids.get(x.key) ?? [])]);
  }

  async scan(q: ImportScanQuery): Promise<ImportScanPage> {
    const device = q.device || 'local';
    this.checkSource(device);
    const first = !q.cursor;
    const state = first ? await this.refreshDevice(device, !!q.refresh) : { offline: !this.machine(device) && !uploadIdOf(device), scannedAt: this.scanState(device).at, failed: this.scanState(device).failed ?? [] };
    const all = this.query(device, q);
    const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const items = all.slice(offset, offset + limit);
    const counts = { new: 0, imported: 0, behind: 0, diverged: 0, skipped: 0 };
    for (const x of all) {
      if (x.skip) counts.skipped++;
      else if (!x.imported?.sessionId) counts.new++;
      else if (x.imported.state === 'current') counts.imported++;
      else if (x.imported.state === 'behind') counts.behind++;
      else counts.diverged++;
    }
    const page: ImportScanPage = {
      items,
      ...(offset + limit < all.length ? { next: String(offset + limit) } : {}),
      total: all.length,
      ...(state.scannedAt ? { scannedAt: state.scannedAt } : {}),
      ...(state.offline ? { offline: true } : {}),
      failed: state.failed,
      retention: first && !state.offline && !uploadIdOf(device) ? await this.retention(device).catch(() => []) : [],
      counts,
    };
    if (first) {
      page.groups = this.groups(all);
      const unknown: Record<string, number> = {};
      for (const r of this.rows(device)) for (const [k, v] of Object.entries(r.info.unknown ?? {})) unknown[k] = (unknown[k] ?? 0) + v;
      if (Object.keys(unknown).length) page.unknown = unknown;
    }
    return page;
  }

  private groups(all: ExternalSessionInfo[]): ImportProjectGroup[] {
    const map = new Map<string, ImportProjectGroup>();
    for (const x of all) {
      if (x.parentKey) continue;
      const g = groupOf({ ...(x as unknown as RowInfo), cwd: x.cwd, repo: x.repo });
      const cur = map.get(g.key) ?? { key: g.key, name: g.name, ...(g.repo ? { repo: g.repo } : {}), ...(g.cwd ? { cwd: g.cwd } : {}), sources: [], sessions: 0, imported: 0, skipped: 0, first: x.createdAt, last: x.updatedAt };
      if (!cur.sources.includes(x.source)) cur.sources.push(x.source);
      cur.sessions++;
      // learned only (no session) is not imported
      if (x.imported?.sessionId) cur.imported++;
      if (x.skip) cur.skipped++;
      cur.first = Math.min(cur.first, x.createdAt);
      cur.last = Math.max(cur.last, x.updatedAt);
      map.set(g.key, cur);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }

  // -------------------------------------------------------------------------
  // selection and estimate
  // -------------------------------------------------------------------------

  /** Rows a selection names: keys, or the whole query minus exclude. */
  private async select(sel: ImportSelection): Promise<ExternalSessionInfo[]> {
    if (!sel.device) throw new ImportError(400, 'device is required');
    const st = this.scanState(sel.device);
    if (!st.at && !uploadIdOf(sel.device)) await this.refreshDevice(sel.device);
    else if (uploadIdOf(sel.device)) await this.refreshDevice(sel.device);
    const exclude = new Set(sel.exclude ?? []);
    if (sel.keys?.length) {
      const want = new Set(sel.keys);
      return this.query(sel.device, {}).filter((x) => want.has(x.key) && !exclude.has(x.key));
    }
    if (sel.query) return this.query(sel.device, sel.query).filter((x) => !exclude.has(x.key));
    return [];
  }

  /** Conclave sessions a learn-only selection names. */
  private learnSessions(sel: ImportSelection): Session[] {
    const ids = new Set(sel.sessionIds ?? []);
    if (sel.notLearned) for (const id of this.store.notLearned(this.acct)) ids.add(id);
    // only this account's sessions
    return [...ids].map((id) => this.engine.repos.sessions.get(id)).filter((s): s is Session => !!s && (s.accountId ?? OWNER_ID) === this.acct);
  }

  private modelFor(model?: string): string {
    const cfg = this.engine.config.get();
    const want = model || cfg.memory.importModel || cfg.smallModel;
    if (this.engine.isUsable(want)) return want;
    if (this.engine.isUsable(cfg.smallModel)) return cfg.smallModel;
    if (this.engine.isUsable(cfg.defaultModel)) return cfg.defaultModel;
    return this.engine.firstUsableModel() ?? want;
  }

  private priceOf(model: string, input: number, output: number): { cost: number; free: boolean } | undefined {
    try {
      const r = this.engine.providers.resolve(model);
      if (r.acp) return undefined;
      const sub = this.engine.config.get().providers[r.provider]?.subscription;
      const cost = this.engine.providers.costOf(r.info, { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return { cost: sub ? 0 : cost, free: !!sub || cost === 0 };
    } catch {
      return undefined;
    }
  }

  async estimate(input: ImportEstimateInput): Promise<ImportEstimate> {
    const mode = checkMode(input.mode);
    this.checkSource(input.device || 'local');
    const model = this.modelFor(input.model);
    const skipped: ImportEstimate['skipped'] = {};
    let sessions = 0;
    let alreadyImported = 0;
    let tokens = 0;
    let windows = 0;
    const projects = new Set<string>();
    const learn = mode !== 'chats';
    if (input.sessionIds?.length || input.notLearned) {
      for (const s of this.learnSessions(input)) {
        const w = renderWindows(this.engine.repos.messages.list(s.id));
        if (!w.length) continue;
        sessions++;
        windows += w.length;
        tokens += w.reduce((n, x) => n + x.tokens, 0);
        projects.add(s.cwd || 'global');
      }
    } else {
      for (const x of await this.select(input)) {
        if (x.skip && !input.includeSkipped) {
          skipped[x.skip] = (skipped[x.skip] ?? 0) + 1;
          continue;
        }
        sessions++;
        if (x.imported?.state === 'current' && x.imported.sessionId) alreadyImported++;
        if (learn && !(x.imported?.learned && x.imported.state === 'current')) {
          windows += Math.max(1, Math.ceil(x.estTokens / RENDER_LIMITS.windowTokens));
          tokens += x.estTokens;
          projects.add(groupOf({ ...(x as unknown as RowInfo) }).key);
        }
      }
    }
    const tokensIn = learn ? tokens + windows * EST_PROMPT_TOKENS + projects.size * CONSOLIDATE_IN : 0;
    const tokensOut = learn ? windows * EST_OUT_TOKENS + projects.size * CONSOLIDATE_OUT : 0;
    const options: ImportCostOption[] = [];
    const add = (m: string, configured: boolean) => {
      if (options.some((o) => o.model === m)) return;
      const p = this.priceOf(m, tokensIn, tokensOut);
      if (!p) return;
      // free means billed by a plan or priced at zero, not "nothing to read"
      const free = this.priceOf(m, 1e6, 1e6)?.free ?? false;
      options.push({ model: m, costUsd: Math.round(p.cost * 1e4) / 1e4, ...(configured ? { configured: true } : {}), ...(free ? { free: true } : {}), usable: this.engine.isUsable(m) });
    };
    add(model, true);
    const usable = ALTERNATIVES.filter((m) => m !== model && this.engine.isUsable(m));
    const free = usable.find((m) => this.priceOf(m, 1e6, 1e6)?.free);
    for (const m of usable.filter((m) => m !== free).slice(0, 2)) add(m, false);
    if (free) add(free, false);
    return { sessions, skipped, alreadyImported, windows: learn ? windows : 0, tokensIn, tokensOut, consolidationCalls: learn ? projects.size : 0, options, model };
  }

  // -------------------------------------------------------------------------
  // batches
  // -------------------------------------------------------------------------

  async startBatch(input: ImportBatchInput): Promise<ImportBatch> {
    const mode = checkMode(input.mode);
    this.checkSource(input.device || 'local');
    const now = Date.now();
    const id = newId('imp');
    const items: Array<{ key: string; source?: ImportSource; path?: string; title?: string; sessionId?: string; state?: ImportItemState; reason?: string }> = [];
    let skipped = 0;
    if (input.sessionIds?.length || input.notLearned) {
      if (mode !== 'learn') throw new ImportError(400, 'sessionIds and notLearned go with mode learn');
      for (const s of this.learnSessions(input).sort((a, b) => a.createdAt - b.createdAt)) items.push({ key: `session:${s.id}`, sessionId: s.id, title: s.title });
    } else {
      const rows = (await this.select(input)).sort((a, b) => a.createdAt - b.createdAt);
      for (const x of rows) {
        const skip = x.skip && !input.includeSkipped ? x.skip : undefined;
        if (skip) skipped++;
        items.push({ key: x.key, source: x.source, path: x.path, title: x.title, ...(skip ? { state: 'skipped' as const, reason: skip } : {}) });
      }
    }
    if (!items.length) throw new ImportError(400, 'Nothing is selected. Pick sessions from the scan first.');
    const batch: BatchRow = {
      id,
      accountId: this.acct,
      device: input.device || 'local',
      mode,
      model: mode === 'chats' ? undefined : this.modelFor(input.model),
      status: mode === 'learn' ? 'learning' : 'importing',
      counts: { ...EMPTY_COUNTS, total: items.length, skipped },
      dropped: {},
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      options: { ...(input.includeSkipped ? { includeSkipped: true } : {}), ...(input.episodeNotes ? { episodeNotes: true } : {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.store.putBatch(batch);
    this.store.addItems(id, items);
    this.emit(id, true);
    this.engine.scheduler.enqueue(RUN_JOB, now, { batchId: id }, `${RUN_JOB}.${id}`);
    this.engine.scheduler.poke();
    return batchDto(batch);
  }

  batches(): ImportBatchesDto {
    return { batches: this.store.batches(20, this.acct).map(batchDto), notLearned: this.store.notLearned(this.acct).length };
  }

  batch(id: string, cursor?: string): ImportBatchDetail {
    const b = this.requireBatch(id);
    const offset = Math.max(0, Number(cursor ?? 0) || 0);
    const items = this.store.items(id, { offset, limit: 200 });
    const total = this.store.itemCount(id);
    return {
      ...batchDto(b),
      items: items.map(({ batchId: _b, ord: _o, learned: _l, created: _c, memoryIds: _m, path: _p, ...rest }) => rest),
      ...(offset + items.length < total ? { next: String(offset + items.length) } : {}),
    };
  }

  private requireBatch(id: string): BatchRow {
    const b = this.store.batch(id);
    // another account's batch reads as one that is not there
    if (!b || (b.accountId ?? OWNER_ID) !== this.acct) throw new ImportError(404, `Unknown import batch ${id}`);
    return b;
  }

  pause(id: string): ImportBatch {
    const b = this.requireBatch(id);
    if (!['scanning', 'importing', 'learning', 'consolidating', 'waiting_reset'].includes(b.status)) throw new ImportError(409, `The batch is ${b.status}; only a running batch can be paused.`);
    this.store.setBatchStatus(id, 'paused');
    this.engine.scheduler.cancel(`${RUN_JOB}.${id}`);
    this.emit(id, true);
    return batchDto(this.requireBatch(id));
  }

  resume(id: string): ImportBatch {
    const b = this.requireBatch(id);
    if (b.status !== 'paused' && b.status !== 'failed' && b.status !== 'waiting_reset') throw new ImportError(409, `The batch is ${b.status}; only a paused or failed batch can resume.`);
    const items = this.store.items(id);
    const importing = b.mode !== 'learn' && items.some((i) => i.state === 'queued');
    this.store.setBatchStatus(id, importing ? 'importing' : 'learning', { error: null, resumeAt: null });
    this.emit(id, true);
    this.engine.scheduler.enqueue(RUN_JOB, Date.now(), { batchId: id }, `${RUN_JOB}.${id}`);
    this.engine.scheduler.poke();
    return batchDto(this.requireBatch(id));
  }

  cancel(id: string): ImportBatch {
    const b = this.requireBatch(id);
    if (['done', 'cancelled', 'undone'].includes(b.status)) throw new ImportError(409, `The batch is already ${b.status}.`);
    this.store.setBatchStatus(id, 'cancelled', { finishedAt: Date.now() });
    this.engine.scheduler.cancel(`${RUN_JOB}.${id}`);
    this.emit(id, true);
    return batchDto(this.requireBatch(id));
  }

  /** Is the batch still meant to run? Pause and cancel arrive from other requests. */
  private live(id: string): boolean {
    const s = this.store.batchStatus(id);
    return s === 'scanning' || s === 'importing' || s === 'learning' || s === 'consolidating';
  }

  /** The job. Safe to call twice: a second call waits for the first. */
  runBatch(id: string): Promise<void> {
    const cur = this.running.get(id);
    if (cur) return cur;
    // the batch runs as its account, wherever the job was started from
    const acct = this.store.batch(id)?.accountId ?? OWNER_ID;
    const p = runAs(acct, () => this.run(id)).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  private async run(id: string): Promise<void> {
    const b0 = this.store.batch(id);
    if (!b0) return;
    if (b0.status === 'waiting_reset') this.store.setBatchStatus(id, b0.mode === 'learn' ? 'learning' : 'importing', { resumeAt: null });
    if (!this.live(id)) return;
    try {
      if (b0.mode !== 'learn') {
        const queued = this.store.items(id).filter((i) => i.state === 'queued');
        if (queued.length) {
          this.store.setBatchStatus(id, 'importing');
          if (!uploadIdOf(b0.device) && !this.machine(b0.device)) {
            this.store.setBatchStatus(id, 'paused', { error: `${this.deviceName(b0.device)} is offline. Resume when it is back.` });
            this.emit(id, true);
            return;
          }
          const ctx = uploadIdOf(b0.device) ? undefined : new ReadContext(this.machine(b0.device)!);
          for (const item of queued) {
            if (!this.live(id)) return this.emit(id, true);
            await this.importItem(this.requireBatch(id), item, ctx);
            this.emit(id);
          }
        }
      }
      if (b0.mode !== 'chats') {
        this.store.setBatchStatus(id, 'learning');
        this.emit(id, true);
        const todo = this.store.items(id).filter((i) => !i.learned && i.state !== 'skipped' && i.state !== 'failed' && (b0.mode === 'learn' || i.state !== 'queued'));
        for (let i = 0; i < todo.length; i += LEARN_CONCURRENCY) {
          if (!this.live(id)) return this.emit(id, true);
          // wait for every call of the chunk: one left running after a failure could learn its chat again on Resume
          const done = await Promise.allSettled(todo.slice(i, i + LEARN_CONCURRENCY).map((item) => this.learnItem(id, item)));
          const failed = done.find((r): r is PromiseRejectedResult => r.status === 'rejected');
          if (failed) throw failed.reason;
          this.emit(id);
        }
        if (!this.live(id)) return this.emit(id, true);
        this.store.setBatchStatus(id, 'consolidating');
        this.emit(id, true);
        await this.consolidate(id);
      }
      if (!this.live(id)) return this.emit(id, true);
      this.store.setBatchStatus(id, 'done', { finishedAt: Date.now(), error: null });
      this.emit(id, true);
      const b = this.requireBatch(id);
      this.engine.audit(undefined, 'import.done', `${b.counts.imported} imported, ${b.counts.updated} updated, ${b.counts.forked} forked, ${b.counts.memoriesAdded} memories`);
    } catch (err) {
      if (err instanceof Parked) {
        this.store.setBatchStatus(id, 'waiting_reset', { resumeAt: err.resetAt });
        this.engine.scheduler.enqueue(RUN_JOB, err.resetAt, { batchId: id }, `${RUN_JOB}.${id}`);
        this.emit(id, true);
        return;
      }
      log.error(`import batch ${id} failed`, err);
      this.store.setBatchStatus(id, 'failed', { error: this.failureText(id, err), finishedAt: Date.now() });
      this.emit(id, true);
    }
  }

  /**
   * What the owner reads when a batch stops. A model that does not answer
   * stops only the learning: say which model, and that the copied chats stay.
   */
  private failureText(id: string, err: unknown): string {
    const msg = oneLine((err as Error)?.message ?? String(err), 300);
    const status = this.store.batchStatus(id);
    if (status !== 'learning' && status !== 'consolidating') return msg;
    const b = this.store.batch(id);
    const model = b?.model ?? 'the model';
    const copied = b && b.mode !== 'learn' ? ' The chats copied so far stay imported.' : '';
    return `Learning stopped: ${model} did not answer (${msg}).${copied} Resume tries the rest again once it answers.`;
  }

  private bumpCounts(id: string, f: (b: BatchRow) => void): BatchRow {
    const b = this.requireBatch(id);
    f(b);
    b.updatedAt = Date.now();
    this.store.putBatch(b);
    return b;
  }

  private stateCount(state: ImportItemState): keyof BatchRow['counts'] | undefined {
    return ({ imported: 'imported', updated: 'updated', forked: 'forked', unchanged: 'unchanged', skipped: 'skipped', failed: 'failed' } as const)[state as 'imported'];
  }

  // -------------------------------------------------------------------------
  // importing one session
  // -------------------------------------------------------------------------

  /**
   * Read and convert a source for an item. A title is often the first prompt,
   * so a token in it is redacted here, once, before it reaches a session,
   * the ledger, a batch item or a prompt.
   */
  private async readSource(device: string, source: ImportSource, path: string, ctx?: ReadContext): Promise<{ conv: ConvertedSession; found: FoundSession }> {
    const r = await this.readSourceRaw(device, source, path, ctx);
    if (r.conv.title) r.conv.title = redactSecrets(r.conv.title);
    return r;
  }

  private async readSourceRaw(device: string, source: ImportSource, path: string, ctx?: ReadContext): Promise<{ conv: ConvertedSession; found: FoundSession }> {
    const uploadId = uploadIdOf(device);
    if (uploadId) {
      const conv = this.uploads.read(uploadId, path);
      if (!conv) throw new ImportError(404, 'That conversation is not in the upload any more.');
      return { conv, found: { source, path, size: 0, mtime: this.uploads.meta(uploadId)?.createdAt ?? 0 } };
    }
    const machine = this.machine(device);
    if (!machine) throw new ImportError(409, `${this.deviceName(device)} is offline.`);
    const st = await machine.stat(path);
    if (!st) throw new ImportError(404, 'The file is not on the device any more.');
    const cached = this.store.scanRow(device, path);
    const found: FoundSession = { source, path, size: st.size, mtime: Math.round(st.mtimeMs), ...(cached?.info?.kind === 'subagent' && cached.info.parentId ? { parent: cached.info.parentId } : {}) };
    // a v2 daemon converts on the device and cuts long tool results there; the source file stays on the device
    if (machine.importRead && device !== 'local') {
      const raw = await machine.importRead({ source, path, ...(found.parent ? { parent: found.parent } : {}), maxToolChars: Math.max(DEVICE_TOOL_CHARS, this.engine.config.get().context.maxToolResultChars) });
      return { conv: checkDeviceSession(raw, source), found };
    }
    const conv = await (ctx ?? new ReadContext(machine)).read(found);
    return { conv, found };
  }

  private async importItem(b: BatchRow, item: ItemRow, ctx?: ReadContext): Promise<void> {
    const finish = (state: ImportItemState, patch: { sessionId?: string; reason?: string; created?: boolean; title?: string } = {}) => {
      this.store.updateItem(b.id, item.key, { state, ...patch, ...(patch.reason === undefined ? {} : { reason: patch.reason }) });
      const k = this.stateCount(state);
      if (k) this.bumpCounts(b.id, (x) => void (x.counts[k] += 1));
    };
    if (!item.source || !item.path) return finish('failed', { reason: 'missing source' });
    try {
      const { conv, found } = await this.readSource(b.device, item.source, item.path, ctx);
      if (!conv.messages.length) return finish('skipped', { reason: 'empty' });
      const r = await this.importConverted(b.device, conv, found, b.id);
      finish(r.state, { sessionId: r.sessionId, ...(r.reason ? { reason: r.reason } : {}), created: r.created, title: conv.title });
    } catch (err) {
      finish('failed', { reason: (err as Error).message.slice(0, 300) });
    }
  }

  /**
   * The ledger at work: a known location syncs, a known fingerprint elsewhere
   * (a Syncthing copy) syncs into the same session, a new one is created.
   * Two sessions claiming one fingerprint fail closed.
   */
  async importConverted(
    device: string,
    conv: ConvertedSession,
    found: FoundSession,
    batchId: string,
  ): Promise<{ state: ImportItemState; sessionId?: string; created?: boolean; reason?: string; added?: number }> {
    const st = sessionStats(conv.messages);
    const fp = fingerprintOf(conv, st.firstIds);
    const now = Date.now();
    if (conv.source === 'claude-code') conv.cwd = await this.deviceCwd(device, found.path, conv.cwd);
    // an ambiguous row is matched again: a merge (mergeDuplicates) or the native id may settle it now
    let here = this.store.ledgerAt(conv.source, device, found.path);
    // the file at a known location now holds another conversation (a bad copy, a sync conflict): fail closed, never a fork of an unrelated chat
    if (here?.sessionId && here.nativeId && conv.nativeId && here.nativeId.toLowerCase() !== conv.nativeId.toLowerCase()) {
      return { state: 'failed', reason: 'The file now holds another conversation, so the imported session was left alone.' };
    }
    let target: Session | undefined = here?.sessionId ? this.engine.repos.sessions.get(here.sessionId) : undefined;
    if (!target) {
      const others = this.knownRows(conv, st.firstIds, fp).filter((l) => l.sessionId && l.status === 'ok' && this.engine.repos.sessions.get(l.sessionId));
      const ids = [...new Set(others.map((l) => l.sessionId!))];
      // several copies of the chat (claudesync put it in two folders, and they split): the one this source continues
      const best = ids.length > 1 ? this.closestCopy(conv.messages, ids) : ids[0];
      if (best) {
        target = this.engine.repos.sessions.get(best);
        const from = others.find((l) => l.sessionId === best)!;
        here = { ...this.baseLedger(conv, device, found, fp, st, batchId), ...(here ? { id: here.id } : {}), sessionId: best, cursor: from.cursor, status: 'ok', importedAt: from.importedAt ?? now };
        this.store.putLedger(here);
      }
    }
    if (target && here) {
      const r = await this.syncInto(target, here, conv, found, fp, batchId);
      // imported before projects were kept, or while its folder was not readable
      await this.attachProject(target.id);
      if (r.state === 'forked' && r.sessionId) await this.attachProject(r.sessionId);
      return r;
    }
    // learned before without a session (mode learn), and the file has not changed since: the new session counts as learned
    const learned = !!here && !here.sessionId && here.learnState === 'learned' && here.size === found.size && here.mtime === found.mtime;
    const created = this.createSession(device, conv, found, fp, st, batchId, here?.id, undefined, learned);
    await this.attachProject(created.id);
    return { state: 'imported', sessionId: created.id, created: true, added: conv.messages.length };
  }

  /**
   * Ledger rows of the same chat at other locations: by fingerprint, else by
   * the fingerprint older rows have (no native id in it) with the same native
   * id. A Claude Code chat copied to another device matches its own session,
   * never the copy it was resumed from.
   */
  private knownRows(conv: ConvertedSession, firstIds: string[], fp: string): LedgerRow[] {
    const rows = this.store.ledgerByFingerprint(fp, this.acct);
    const legacy = fingerprintOf({ ...conv, nativeIdUnique: false }, firstIds);
    if (rows.length || legacy === fp || !conv.nativeId) return rows;
    const id = conv.nativeId.toLowerCase();
    return this.store.ledgerByFingerprint(legacy, this.acct).filter((l) => l.nativeId?.toLowerCase() === id);
  }

  /**
   * Of several sessions holding copies of one chat, the one a source syncs
   * into: one it extends or is behind (no split: planSync appends or finds
   * nothing) before one it split from, then the longest run of the source's
   * first messages it holds, then the most messages.
   */
  private closestCopy(source: ImportedMessage[], ids: string[]): string {
    const score = (id: string) => {
      const have = new Set(importedIds(this.engine.repos.messages.list(id)));
      let k = 0;
      while (k < source.length && have.has(externalId(source[k]) ?? '')) k++;
      const inSource = new Set(source.map((m) => externalId(m)));
      const split = k < source.length && [...have].some((x) => !inSource.has(x));
      return [split ? 0 : 1, k, have.size];
    };
    const scored = ids.map((id) => ({ id, s: score(id) }));
    scored.sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || b.s[2] - a.s[2]);
    return scored[0].id;
  }

  /**
   * A Claude Code chat's folder on the device that holds the file, checked
   * there (claudeDeviceCwd). Nothing found keeps the file's own cwd: a turn
   * maps it again or asks (session/harness.ts deviceFolder).
   */
  private async deviceCwd(device: string, path: string, cwd: string | undefined): Promise<string | undefined> {
    const m = uploadIdOf(device) ? undefined : this.machine(device);
    return (m && (await claudeDeviceCwd(m, path, cwd))) || cwd;
  }

  /**
   * An imported session joins the project of its folder, as Conclave's own
   * sessions do at the end of a turn (projects/service.ts). A Claude Code
   * chat on the Mac and a session on the hub in clones of one repository
   * land in one project. Chats from claude.ai and ChatGPT have no folder.
   */
  private async attachProject(sessionId: string): Promise<void> {
    const projects = projectsOf(this.engine);
    const s = this.engine.repos.sessions.get(sessionId);
    if (!projects || !s || s.projectId || s.kind === 'chat') return;
    await projects.attach(s).catch((err) => log.debug(`project of imported ${sessionId} skipped`, err));
  }

  /**
   * Imported sessions on a device that have no project yet: imported before
   * projects were kept, or while the device was offline. Runs when the
   * device connects. Returns how many found their project.
   */
  async attachProjects(device: string): Promise<number> {
    const list = this.engine.repos.sessions.list({ device, tag: 'imported', kind: 'agent', limit: 1000 }).filter((s) => !s.projectId && s.cwd && s.cwd !== '~');
    let n = 0;
    for (const s of list) {
      await this.attachProject(s.id);
      if (this.engine.repos.sessions.get(s.id)?.projectId) n++;
    }
    return n;
  }

  private baseLedger(conv: ConvertedSession, device: string, found: FoundSession, fp: string, st: ReturnType<typeof sessionStats>, batchId: string): LedgerRow {
    return {
      id: newId('isrc'),
      accountId: this.acct,
      source: conv.source,
      device,
      path: found.path,
      nativeId: conv.nativeId,
      fingerprint: fp,
      size: found.size,
      mtime: found.mtime,
      cursor: { count: 0 },
      batchId,
      status: 'ok',
      title: conv.title,
      cwd: conv.cwd,
      gitBranch: conv.gitBranch,
      repo: conv.repo,
      firstAt: st.createdAt,
      lastAt: st.updatedAt,
      updatedAt: Date.now(),
    };
  }

  /** Messages ready to store: big tool results go to tool_outputs like live ones. */
  private toStored(msgs: ImportedMessage[], sessionId: string, startSeq: number, batchId?: string): Message[] {
    const max = this.engine.config.get().context.maxToolResultChars;
    return msgs.map((m, i) => {
      const content = m.content.map((b) => {
        if (b.type !== 'tool_result' || typeof b.content !== 'string' || b.content.length <= max) return b;
        const outputId = this.engine.repos.outputs.save(sessionId, 'import', b.content);
        const cut = truncateMiddle(b.content, max, 'omitted');
        return { ...b, content: `${cut.text}\n\n[Output was ${b.content.length} chars and was truncated. Full output id: ${outputId}.]`, meta: { ...(b.meta ?? {}), outputId, truncated: true } } as ToolResultBlock;
      });
      return { ...m, content, meta: { ...(m.meta ?? {}), ...(batchId ? { batchId } : {}) }, id: newId('msg'), sessionId, seq: startSeq + i };
    });
  }

  private insertMessages(msgs: Message[]): void {
    const repos = this.engine.repos;
    repos.db.transaction(() => {
      for (const m of msgs) repos.messages.insert(m);
    })();
  }

  private importInfo(conv: ConvertedSession, device: string, found: FoundSession, batchId: string, st: ReturnType<typeof sessionStats>): SessionImportInfo {
    return { source: conv.source, device, path: found.path, id: conv.nativeId ?? '', importedAt: Date.now(), batchId, createdAt: st.createdAt, state: 'current', ...(conv.model ? { model: conv.model } : {}) };
  }

  private createSession(device: string, conv: ConvertedSession, found: FoundSession, fp: string, st: ReturnType<typeof sessionStats>, batchId: string, ledgerId?: string, fork?: { parentId: string; title: string }, learned = false): Session {
    const cfg = this.engine.config.get();
    const id = newId('ses');
    const chatApp = conv.source === 'claude-ai' || conv.source === 'chatgpt';
    // the ledger row goes first, so a crash in between re-runs instead of importing twice
    const ledger: LedgerRow = { ...this.baseLedger(conv, device, found, fp, st, batchId), ...(ledgerId ? { id: ledgerId } : {}), sessionId: id, status: 'importing', ...(learned ? { learnState: 'learned' as const } : {}) };
    this.store.putLedger(ledger);
    const h = HARNESS[conv.source];
    // a harness that is off (the default) would refuse every turn: the chat goes on with its own model when Conclave can run it, else the owner's; external keeps the resume id
    const model = h && !this.engine.harnessOff(h.model) ? h.model : conv.model && this.engine.isUsable(conv.model) && this.engine.providers.servesModel(conv.model) ? conv.model : cfg.defaultModel;
    const realDevice = chatApp || uploadIdOf(device) ? 'local' : device;
    const session: Session = {
      id,
      accountId: this.acct,
      title: fork?.title ?? (conv.title ? redactSecrets(conv.title) : `Untitled ${sourceName(conv.source)} session`),
      // a coding tool's chat goes on with the coding agent; the default agent is the personal assistant
      agent: !chatApp && this.engine.extensions.agent('coder') ? 'coder' : cfg.defaultAgent,
      model,
      mode: 'agent',
      permissionMode: cfg.permissions.mode,
      cwd: conv.cwd ?? '~',
      device: realDevice,
      status: 'idle',
      ...(fork ? { parentId: fork.parentId } : {}),
      tags: ['imported', conv.source],
      pinned: false,
      archived: true,
      createdAt: st.createdAt || Date.now(),
      updatedAt: st.updatedAt || Date.now(),
      ...(h && conv.nativeId ? { external: { [h.harness]: conv.nativeId } } : {}),
      stats: { messages: conv.messages.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      meta: { import: { ...this.importInfo(conv, device, found, batchId, st), ...(learned ? { learned: true } : {}), ...(conv.learnable ? {} : { learnable: false }) } },
      ...(chatApp ? { kind: 'chat' as const, chat: { webSearch: false, memory: true } } : {}),
    };
    this.engine.repos.sessions.insert(session);
    const stored = this.toStored(conv.messages, id, 1);
    this.insertMessages(stored);
    // the first resumed turn should not read the whole old chat for memory
    this.engine.repos.kv.set(`memory.extract.${id}`, stored.length);
    if (learned && stored.length) this.engine.repos.kv.set(`import.learnedSeq.${id}`, stored[stored.length - 1].seq);
    const ids = importedIds(stored);
    this.store.putLedger({ ...ledger, status: 'ok', cursor: { lastId: ids[ids.length - 1], count: ids.length }, prefixHash: prefixHash(ids), importedAt: Date.now(), updatedAt: Date.now() });
    this.engine.bus.emit({ type: 'session.created', session });
    return session;
  }

  private async syncInto(target: Session, here: LedgerRow, conv: ConvertedSession, found: FoundSession, fp: string, batchId: string): Promise<{ state: ImportItemState; sessionId?: string; created?: boolean; reason?: string; added?: number }> {
    const repos = this.engine.repos;
    const existing = repos.messages.list(target.id);
    let plan = planSync(conv.messages, existing, here.cursor);
    const st = sessionStats(conv.messages);
    let branch: Session | undefined;
    // both grew and the source more (it ran on in the tool): the source stays here and Conclave's own turns move to a branch
    if (plan.state === 'diverged' && plan.both && plan.both.append.length > plan.both.native && target.status === 'idle') {
      const copy = this.engine.forkSession(target.id);
      const { import: _imp, ...meta } = copy.meta ?? {};
      branch = { ...copy, parentId: target.id, title: `${target.title} (Conclave branch)`, meta };
      repos.sessions.update(branch);
      this.engine.bus.emit({ type: 'session.updated', session: branch });
      repos.messages.truncateAfter(target.id, plan.both.afterSeq);
      plan = { state: 'append', append: plan.both.append, absorbed: here.cursor.absorbed ?? [] };
    }
    if (plan.state === 'diverged') {
      const fork = this.createSession(here.device, conv, found, fp, st, batchId, here.id, {
        parentId: target.id,
        title: `Continued in ${sourceName(conv.source)} on ${this.deviceName(here.device)}`,
      });
      return { state: 'forked', sessionId: fork.id, created: true, reason: plan.reason, added: conv.messages.length };
    }
    let added = 0;
    repos.db.transaction(() => {
      for (const c of plan.claims ?? []) {
        const m = repos.messages.get(c.messageId);
        if (m) repos.messages.update({ ...m, meta: { ...(m.meta ?? {}), external: { source: conv.source, id: c.id, absorbed: true } } });
      }
      if (plan.grownLast) {
        const m = repos.messages.get(plan.grownLast.messageId);
        if (m) repos.messages.update({ ...m, content: this.toStored([plan.grownLast.message], target.id, m.seq)[0].content, meta: { ...(m.meta ?? {}), grownBatch: batchId } });
      }
    })();
    if (plan.state === 'append' && plan.append.length) {
      const stored = this.toStored(plan.append, target.id, repos.messages.nextSeq(target.id), batchId);
      this.insertMessages(stored);
      added = stored.length;
    }
    const after = repos.messages.list(target.id);
    const ids = importedIds(after);
    const lastSeq = after[after.length - 1]?.seq ?? 0;
    this.store.putLedger({
      ...here,
      fingerprint: fp,
      size: found.size,
      mtime: found.mtime,
      cursor: { lastId: ids[ids.length - 1], count: ids.length - (plan.claims?.length ?? 0), absorbed: plan.absorbed.length ? plan.absorbed : undefined },
      prefixHash: prefixHash(ids),
      status: 'ok',
      title: conv.title ?? here.title,
      lastAt: st.updatedAt,
      batchId: added || plan.grownLast ? batchId : here.batchId,
      updatedAt: Date.now(),
    });
    const changed = added > 0 || !!plan.grownLast;
    // the ledger row says a create was cut short (a kill between the session row and its messages): this finishes that import
    const resumed = here.status === 'importing';
    const prevInfo = (target.meta?.import ?? {}) as Partial<SessionImportInfo>;
    const next: Session = {
      ...target,
      updatedAt: changed ? Math.max(target.updatedAt, st.updatedAt) : target.updatedAt,
      stats: { ...target.stats, messages: after.length },
      // chats imported before the model was kept get it here, and later syncs keep the newest
      meta: { ...(target.meta ?? {}), import: { ...prevInfo, state: 'current', newThere: 0, ...(conv.model ? { model: conv.model } : {}) } },
    };
    repos.sessions.update(next);
    this.engine.bus.emit({ type: 'session.updated', session: next });
    // appended history is the source's, not new talk: the next turn's extraction starts after it
    if (added) this.engine.repos.kv.set(`memory.extract.${target.id}`, lastSeq);
    return { state: resumed ? 'imported' : changed ? 'updated' : 'unchanged', sessionId: target.id, added, ...(resumed ? { created: true } : {}), ...(branch ? { reason: `Conclave's own turns moved to ${branch.id}` } : {}) };
  }

  /**
   * Re-sync one imported session (the Sync action under its title). Every
   * location of it on an online device is read: a copy that is behind adds
   * nothing, the one that grew appends, and one that grew past Conclave forks.
   */
  async syncSession(sessionId: string): Promise<ImportSyncResult> {
    const session = this.engine.repos.sessions.get(sessionId);
    if (!session) throw new ImportError(404, `Session ${sessionId} not found`);
    const rows = this.store.ledgerBySession(sessionId).filter((l) => l.status === 'ok');
    if (!rows.length) throw new ImportError(400, 'This session was not imported, so there is nothing to sync.');
    const reachable = rows.filter((r) => uploadIdOf(r.device) || this.machine(r.device));
    if (!reachable.length) return { state: 'failed', added: 0, error: `${this.deviceName(rows[0].device)} is offline.` };
    let added = 0;
    let forkedSessionId: string | undefined;
    let error: string | undefined;
    for (const l of reachable) {
      try {
        const { conv, found } = await this.readSource(l.device, l.source, l.path);
        // a sync is not part of a batch: undo of an earlier batch never takes away what a later sync added
        const r = await this.importConverted(l.device, conv, found, 'sync');
        if (r.state === 'forked') forkedSessionId = r.sessionId;
        else if (r.state === 'failed') error = r.reason;
        else added += r.added ?? 0;
      } catch (err) {
        error = (err as Error).message;
      }
      this.refreshImportedLines(l.device);
    }
    if (forkedSessionId) return { state: 'forked', added, forkedSessionId };
    if (added) return { state: 'updated', added };
    if (error) return { state: 'failed', added: 0, error };
    return { state: 'unchanged', added: 0 };
  }

  /**
   * One visible session per Claude Code chat. A chat a sync tool (claudesync)
   * copied to several devices, and the forks older imports made of it, are
   * sessions with the same chat id and first message. The copy with the most
   * of the chat's messages is the main one. Every other copy with messages the
   * main one lacks (its own source messages, or turns run in Conclave) becomes
   * a branch of it: parentId and meta.branchOf, titled "Branch from <device>:
   * <first own prompt>", listed in the main session's header. A copy whose
   * messages are all in a kept one is archived with meta.import.duplicateOf,
   * and its ledger rows move to the session holding its messages, so a later
   * sync appends there. Nothing is deleted. A dry run (the default) only lists
   * what would change; a second run finds nothing.
   */
  mergeDuplicates(opts: { apply?: boolean } = {}): { dryRun: boolean; groups: MergeGroup[] } {
    const repos = this.engine.repos;
    const groups = new Map<string, ReturnType<ImportStore['claudeChats']>>();
    for (const c of this.store.claudeChats(this.acct)) {
      if (!c.firstId) continue;
      const k = `${c.nativeId}\n${c.firstId}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const out: MergeGroup[] = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const copies = g.map((c) => {
        const s = repos.sessions.get(c.id)!;
        const msgs = repos.messages.list(c.id);
        const ids = importedIds(msgs);
        return { s, msgs, ids, set: new Set(ids), own: msgs.some((m) => !externalId(m) && m.kind !== 'notice') };
      });
      // the longest history of the chat leads; a tie keeps the main one it already has
      copies.sort((a, b) => b.ids.length - a.ids.length || Number(!!a.s.meta?.branchOf) - Number(!!b.s.meta?.branchOf) || b.msgs.length - a.msgs.length || b.s.updatedAt - a.s.updatedAt);
      const [main, ...rest] = copies;
      const kept = [main];
      const changed: Session[] = [];
      const moves: Array<{ row: LedgerRow; to: string; ids: string[] }> = [];
      const group: MergeGroup = { nativeId: g[0].nativeId, keep: main.s.id, title: main.s.title, branches: [], archived: [], ledgerRows: 0 };
      // the copy kept is often a fork titled "Continued in ...": it takes the chat's own title
      const named = copies.find((c) => !c.s.meta?.branchOf && !c.s.title.startsWith('Continued in '));
      if (main.s.title.startsWith('Continued in ') && named) group.title = named.s.title;
      const parentGone = !!main.s.parentId && copies.some((c) => c.s.id === main.s.parentId);
      if (group.title !== main.s.title || parentGone || main.s.meta?.branchOf) {
        const { branchOf: _b, ...meta } = main.s.meta ?? {};
        changed.push({ ...main.s, title: group.title, ...(parentGone ? { parentId: undefined } : {}), meta });
      }
      for (const c of rest) {
        const holder = c.own ? undefined : kept.find((k) => c.ids.every((id) => k.set.has(id)));
        if (holder) {
          group.archived.push(c.s.id);
          const imp = (c.s.meta?.import ?? {}) as Record<string, unknown>;
          if (!c.s.archived || imp.duplicateOf !== holder.s.id) changed.push({ ...c.s, archived: true, meta: { ...(c.s.meta ?? {}), import: { ...imp, duplicateOf: holder.s.id } } });
          for (const row of this.store.ledgerBySession(c.s.id)) moves.push({ row, to: holder.s.id, ids: holder.ids });
          continue;
        }
        kept.push(c);
        const title = c.s.meta?.branchOf === main.s.id ? c.s.title : this.branchTitle(c.s.device, c.msgs, main.set);
        group.branches.push({ id: c.s.id, title });
        if (c.s.parentId !== main.s.id || c.s.meta?.branchOf !== main.s.id || c.s.title !== title) changed.push({ ...c.s, parentId: main.s.id, title, meta: { ...(c.s.meta ?? {}), branchOf: main.s.id } });
      }
      group.ledgerRows = moves.length;
      if (!changed.length && !moves.length) continue;
      out.push(group);
      if (!opts.apply) continue;
      const now = Date.now();
      repos.db.transaction(() => {
        for (const { row, to, ids } of moves) this.store.putLedger({ ...row, sessionId: to, cursor: { lastId: ids[ids.length - 1], count: ids.length }, prefixHash: prefixHash(ids), status: 'ok', updatedAt: now });
        for (const s of changed) repos.sessions.update(s);
      })();
      for (const s of changed) this.engine.bus.emit({ type: 'session.updated', session: s });
    }
    return { dryRun: !opts.apply, groups: out };
  }

  /** "Branch from MacBook: yoo im back from mac now": the device, and the first 6 words the owner typed that the main copy does not have. */
  private branchTitle(device: string, msgs: Message[], main: Set<string>): string {
    // a prompt, not a slash command, without the reminders a Conclave turn adds
    const said = (m: Message) => (main.has(externalId(m) ?? '') ? '' : stripWrappers(humanText(m as ImportedMessage)).trim());
    const first = msgs.map(said).find((x) => x && !x.startsWith('/'));
    const words = first ? first.split(/\s+/).slice(0, 6).join(' ') : '';
    return `Branch from ${this.deviceName(device)}${words ? `: ${words}` : ''}`;
  }

  /** Keep Session.meta.import.state and newThere in line with the latest scan, so the session line can say "4 new messages there". */
  private refreshImportedLines(device: string): void {
    for (const r of this.rows(device)) {
      const l = this.store.ledgerAt(r.source, device, r.path);
      if (!l?.sessionId) continue;
      const s = this.engine.repos.sessions.get(l.sessionId);
      if (!s) continue;
      const imp = this.importedOf(r);
      const info = (s.meta?.import ?? {}) as Partial<SessionImportInfo>;
      const state = imp?.state ?? 'current';
      const newThere = imp?.newThere ?? 0;
      if (info.state === state && (info.newThere ?? 0) === newThere && info.learned === (l.learnState === 'learned')) continue;
      const next = { ...s, meta: { ...(s.meta ?? {}), import: { ...info, state, newThere, learned: l.learnState === 'learned' } } };
      this.engine.repos.sessions.update(next);
      this.engine.bus.emit({ type: 'session.updated', session: next });
    }
  }

  // -------------------------------------------------------------------------
  // learning
  // -------------------------------------------------------------------------

  private async callModel(model: string, system: string, prompt: string, maxTokens: number): Promise<{ text: string; input: number; output: number; cost: number }> {
    try {
      const res = await streamCompletion(
        this.engine,
        model,
        { system: [{ text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens },
        { purpose: 'import' },
      );
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
        .trim();
      return { text, input: res.usage.inputTokens + (res.usage.cacheReadTokens ?? 0), output: res.usage.outputTokens, cost: res.usage.costUsd ?? 0 };
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === 'rate_limit' || err.kind === 'quota')) throw new Parked(err.resetAt ?? Date.now() + (err.retryAfterMs ?? 60_000));
      throw err;
    }
  }

  /** Messages and context for an item: an imported session, a Conclave session, or (mode learn) the source itself. */
  private async learnInput(b: BatchRow, item: ItemRow): Promise<{ messages: Array<ImportedMessage | Message>; ctx: Omit<LearnContext, 'batchId' | 'today'>; ledger?: LedgerRow; skip?: string } | undefined> {
    const sessionId = item.sessionId ?? (item.key.startsWith('session:') ? item.key.slice(8) : undefined);
    if (sessionId) {
      const s = this.engine.repos.sessions.get(sessionId);
      if (!s) return undefined;
      const info = s.meta?.import as SessionImportInfo | undefined;
      // Codex's own memory and review threads are never learned from
      const messages = info?.learnable === false ? [] : this.engine.repos.messages.list(sessionId);
      const ledger = this.store.ledgerBySession(sessionId)[0];
      return {
        messages,
        ledger,
        ...(info?.learnable === false ? { skip: "the tool's own memory thread, never learned" } : {}),
        ctx: {
          sessionDate: messages[0]?.createdAt ?? s.createdAt,
          device: info?.device ?? s.device,
          deviceName: this.deviceName(info?.device ?? s.device),
          source: info?.source ?? 'conclave',
          sourceName: info ? sourceName(info.source) : 'Conclave',
          cwd: s.kind === 'chat' ? undefined : s.cwd !== '~' ? s.cwd : undefined,
          gitBranch: ledger?.gitBranch,
          title: s.title,
          extSessionId: info?.id || sessionId,
          conclaveSessionId: sessionId,
          key: `session:${sessionId}`,
        },
      };
    }
    if (!item.source || !item.path) return undefined;
    const { conv, found } = await this.readSource(b.device, item.source, item.path);
    const st = sessionStats(conv.messages);
    const fp = fingerprintOf(conv, st.firstIds);
    const empty = { sessionDate: st.createdAt, device: b.device, deviceName: '', source: conv.source, sourceName: '', extSessionId: conv.nativeId ?? fp, key: `fp:${fp}` };
    // Codex's own memory and review threads are never learned from
    if (!conv.learnable) return { messages: [], ctx: empty, skip: "the tool's own memory thread, never learned" };
    // learn only: already learned under any location means nothing to do
    if (this.knownRows(conv, st.firstIds, fp).some((l) => l.learnState === 'learned')) return { messages: [], ctx: empty };
    let ledger = this.store.ledgerAt(conv.source, b.device, found.path);
    if (!ledger) {
      ledger = { ...this.baseLedger(conv, b.device, found, fp, st, b.id), learnState: 'pending' };
      this.store.putLedger(ledger);
    }
    return {
      messages: conv.messages,
      ledger,
      ctx: {
        sessionDate: st.createdAt,
        device: b.device,
        deviceName: this.deviceName(b.device),
        source: conv.source,
        sourceName: sourceName(conv.source),
        cwd: conv.cwd,
        gitBranch: conv.gitBranch,
        title: conv.title,
        extSessionId: conv.nativeId ?? fp,
        key: `fp:${fp}`,
      },
    };
  }

  private async learnItem(batchId: string, item: ItemRow): Promise<void> {
    const b = this.requireBatch(batchId);
    let input;
    try {
      input = await this.learnInput(b, item);
    } catch (err) {
      this.store.updateItem(batchId, item.key, { learned: true, reason: `not learned: ${(err as Error).message}`.slice(0, 300), ...(b.mode === 'learn' ? { state: 'failed' as const } : {}) });
      if (b.mode === 'learn') this.bumpCounts(batchId, (x) => void (x.counts.failed += 1));
      return;
    }
    if (!input) {
      this.store.updateItem(batchId, item.key, { learned: true, reason: 'the session is gone', ...(b.mode === 'learn' ? { state: 'skipped' as const } : {}) });
      return;
    }
    const { ctx: base, ledger, skip } = input;
    let { messages } = input;
    const ctx: LearnContext = { ...base, batchId, today: Date.now() };
    if (ctx.conclaveSessionId && b.mode !== 'learn') {
      const learnedSeq = this.engine.repos.kv.get<number>(`import.learnedSeq.${ctx.conclaveSessionId}`, -1);
      if ((item.state === 'unchanged' || item.state === 'imported') && ledger?.learnState === 'learned') messages = [];
      else if (item.state === 'updated' && learnedSeq >= 0) messages = messages.filter((m) => 'seq' in m && m.seq > learnedSeq);
    }
    const learnable = !ledger || ledger.status === 'ok';
    const windows = learnable ? renderWindows(messages) : [];
    const hasHuman = messages.some((m) => humanText(m as ImportedMessage));
    const memoryIds: string[] = [];
    if (windows.length && hasHuman) {
      const model = b.model ?? this.modelFor();
      const seed = messages.map((m) => humanText(m as ImportedMessage)).filter(Boolean).join('\n').slice(0, 3000);
      const related = (await this.memory.search(seed || ctx.title || '', { ...(ctx.cwd ? { scope: 'project' as const, scopeKey: ctx.cwd } : {}), limit: 12, external: false })).filter((h) => h.kind !== 'episode');
      const relatedIds = new Set(related.map((r) => r.id));
      const found: LearnedItem[] = [];
      const seen = new Set<string>();
      const dropped: Record<string, number> = {};
      let episode = '';
      let inTok = 0;
      let outTok = 0;
      let cost = 0;
      for (let w = 0; w < windows.length; w++) {
        const prompt = buildLearnPrompt(ctx, related, found, episode, windows[w].text, { index: w, count: windows.length });
        const res = await this.callModel(model, LEARN_SYSTEM, prompt, 1500);
        inTok += res.input;
        outTok += res.output;
        cost += res.cost;
        const parsed = parseLearnReply(res.text);
        if (!parsed) {
          dropped['not-json'] = (dropped['not-json'] ?? 0) + 1;
          continue;
        }
        if (parsed.episode) episode = parsed.episode;
        found.push(...checkItems(parsed.items, windows[w], relatedIds, seen, dropped));
      }
      const landed = await landItems(this.memory, found, ctx, related);
      memoryIds.push(...landed.ids);
      if (episode && clipEpisode(episode)) {
        const ep = this.memory.saveLearnedEpisode({
          content: clipEpisode(episode),
          scope: ctx.cwd ? 'project' : 'global',
          scopeKey: ctx.cwd,
          tags: ['episode', 'learned', `source:${ctx.source}`, `batch:${batchId}`],
          sourceSessionId: ctx.conclaveSessionId,
          meta: { source: ctx.source, device: ctx.device, extSessionId: ctx.extSessionId, observedAt: ctx.sessionDate, batchId, ...(ctx.key ? { episodeKey: ctx.key } : {}) },
        });
        memoryIds.push(ep.id);
        // one note per imported session, when the batch asked for it (the monthly digest has them otherwise)
        const ext = this.memory.external;
        if (b.options.episodeNotes && ext && ext.writeMode?.()) {
          const note = episodeNote({ sessionId: ctx.conclaveSessionId ?? ctx.extSessionId, summary: ep.content, title: ctx.title, project: ctx.cwd, date: new Date(ctx.sessionDate), tags: ['imported', ctx.source] });
          ext.write({ ...note, always: true }).catch((err) => log.warn(`episode note for ${ctx.extSessionId} was not written: ${(err as Error).message}`));
        }
      }
      this.bumpCounts(batchId, (x) => {
        x.inputTokens += inTok;
        x.outputTokens += outTok;
        x.costUsd += cost;
        x.counts.memoriesAdded += landed.added;
        x.counts.memoriesMerged += landed.merged;
        x.counts.memoriesReview += landed.review;
        x.counts.memoriesInNotes += landed.inNotes;
        for (const [k, v] of Object.entries(dropped)) x.dropped[k] = (x.dropped[k] ?? 0) + v;
      });
    }
    if (skip) {
      // never learned: not marked learned either, and not offered again (notLearned leaves it out)
    } else if (ctx.conclaveSessionId) {
      const last = messages[messages.length - 1] as Message | undefined;
      if (last && 'seq' in last) {
        this.engine.repos.kv.set(`memory.extract.${ctx.conclaveSessionId}`, Math.max(last.seq, this.engine.repos.kv.get<number>(`memory.extract.${ctx.conclaveSessionId}`, -1)));
        this.engine.repos.kv.set(`import.learnedSeq.${ctx.conclaveSessionId}`, last.seq);
      }
      this.store.setLearned(ctx.conclaveSessionId, 'learned');
      const s = this.engine.repos.sessions.get(ctx.conclaveSessionId);
      if (s?.meta?.import) {
        const next = { ...s, meta: { ...s.meta, import: { ...(s.meta.import as object), learned: true } } };
        this.engine.repos.sessions.update(next);
        this.engine.bus.emit({ type: 'session.updated', session: next });
      }
    } else if (ledger) this.store.putLedger({ ...ledger, learnState: 'learned', batchId, updatedAt: Date.now() });
    this.store.updateItem(batchId, item.key, { learned: true, memoryIds, ...(b.mode === 'learn' ? { state: 'learned' as const } : {}), ...(skip ? { reason: skip } : !windows.length || !hasHuman ? { reason: 'nothing to learn' } : {}) });
    this.bumpCounts(batchId, (x) => void (x.counts.learnedSessions += 1));
  }

  /** One call per project with this batch's items and the 40 most related memories. */
  private async consolidate(batchId: string): Promise<void> {
    const b = this.requireBatch(batchId);
    const added = this.memory.withTag(`batch:${batchId}`).filter((m) => m.kind !== 'episode');
    if (added.length < 2) return;
    const byProject = new Map<string, MemoryEntry[]>();
    for (const m of added) byProject.set(m.scopeKey ?? 'global', [...(byProject.get(m.scopeKey ?? 'global') ?? []), m]);
    const model = b.model ?? this.modelFor();
    const ids = new Set(added.map((m) => m.id));
    for (const [project, list] of byProject) {
      if (!this.live(batchId)) return;
      const seed = list.map((m) => m.content).join('\n').slice(0, 4000);
      const related = (await this.memory.search(seed, { ...(project !== 'global' ? { scope: 'project' as const, scopeKey: project } : {}), limit: 40, external: false })).filter((h) => !ids.has(h.id) && h.kind !== 'episode');
      if (!related.length && list.length < 2) continue;
      const res = await this.callModel(model, CONSOLIDATE_SYSTEM, buildConsolidatePrompt(project, list, related), 1200);
      const shown = new Set([...list.map((m) => m.id), ...related.map((m) => m.id)]);
      const outcome = await applyConsolidation(this.memory, res.text, ids, batchId, shown);
      this.bumpCounts(batchId, (x) => {
        x.inputTokens += res.input;
        x.outputTokens += res.output;
        x.costUsd += res.cost;
        x.counts.memoriesMerged += outcome.merged;
        x.counts.memoriesAdded -= Math.min(x.counts.memoriesAdded, outcome.merged);
        if (outcome.ignored) x.dropped['consolidation-ignored'] = (x.dropped['consolidation-ignored'] ?? 0) + outcome.ignored;
      });
    }
  }

  // -------------------------------------------------------------------------
  // undo
  // -------------------------------------------------------------------------

  async undo(id: string): Promise<ImportUndoResult> {
    const b = this.requireBatch(id);
    if (b.status === 'undone') throw new ImportError(409, 'This import was already undone.');
    if (Date.now() - b.createdAt > UNDO_DAYS * 86_400_000) throw new ImportError(409, `Undo is kept for ${UNDO_DAYS} days, and this import is older.`);
    if (this.live(id)) this.store.setBatchStatus(id, 'cancelled');
    await this.running.get(id)?.catch(() => {});
    const repos = this.engine.repos;
    const out: ImportUndoResult = { sessionsRemoved: 0, messagesRemoved: 0, memoriesRemoved: 0, supersedesCleared: 0, kept: [], keptSessions: [] };
    const items = this.store.items(id);
    const removed = new Set<string>();
    const keptSessions = new Set<string>();
    /** Messages Conclave wrote in a session after `afterSeq` (the owner kept going there). */
    const continued = (sessionId: string, afterSeq = -1) => repos.messages.list(sessionId).some((m) => m.seq > afterSeq && !externalId(m) && m.kind !== 'notice');
    const keep = (s: Session) => {
      if (keptSessions.has(s.id)) return;
      keptSessions.add(s.id);
      out.keptSessions!.push({ id: s.id, title: s.title });
    };
    for (const it of items) {
      if (!it.created || !it.sessionId || removed.has(it.sessionId)) continue;
      const s = repos.sessions.get(it.sessionId);
      if (!s) continue;
      // the owner kept going in it: deleting it would lose their own turns, so it stays whole
      if (continued(s.id)) {
        keep(s);
        continue;
      }
      repos.sessions.delete(it.sessionId);
      this.engine.bus.emit({ type: 'session.deleted', sessionId: it.sessionId });
      removed.add(it.sessionId);
      out.sessionsRemoved++;
      for (const l of this.store.ledgerBySession(it.sessionId)) {
        // a fork's ledger row goes back to the session it forked from
        if (s.parentId && repos.sessions.get(s.parentId)) {
          const msgs = repos.messages.list(s.parentId);
          const ids = importedIds(msgs);
          this.store.putLedger({ ...l, sessionId: s.parentId, cursor: { lastId: ids[ids.length - 1], count: ids.length }, prefixHash: prefixHash(ids), size: undefined, mtime: undefined });
        } else this.store.deleteLedger(l.id);
      }
    }
    // messages appended to sessions that were already there
    const appended = repos.db.query(`SELECT id, session_id, seq FROM messages WHERE json_extract(meta, '$.batchId') = ?`).all(id) as Array<{ id: string; session_id: string; seq: number }>;
    const touched = new Set<string>();
    // a session that went on after the appended messages keeps them: taking them out would cut the history its later turns read
    const firstAppended = new Map<string, number>();
    for (const m of appended) firstAppended.set(m.session_id, Math.min(firstAppended.get(m.session_id) ?? Infinity, m.seq));
    for (const [sid, seq] of firstAppended) {
      if (removed.has(sid) || keptSessions.has(sid) || !continued(sid, seq)) continue;
      const s = repos.sessions.get(sid);
      if (s) keep(s);
    }
    for (const m of appended) {
      if (removed.has(m.session_id) || keptSessions.has(m.session_id)) continue;
      repos.messages.delete(m.id);
      touched.add(m.session_id);
      out.messagesRemoved++;
    }
    for (const sid of touched) {
      const msgs = repos.messages.list(sid);
      const ids = importedIds(msgs);
      for (const l of this.store.ledgerBySession(sid)) this.store.putLedger({ ...l, cursor: { ...l.cursor, lastId: ids[ids.length - 1], count: ids.length }, prefixHash: prefixHash(ids), size: undefined, mtime: undefined, updatedAt: Date.now() });
      const s = repos.sessions.get(sid);
      if (s) {
        const next = { ...s, stats: { ...s.stats, messages: msgs.length } };
        repos.sessions.update(next);
        this.engine.bus.emit({ type: 'session.updated', session: next });
      }
    }
    // memories the batch wrote; the owner's edits since are kept
    for (const m of this.memory.withTag(`batch:${id}`)) {
      if (m.meta?.contentHash && m.meta.contentHash !== hashText(m.content)) {
        out.kept.push({ id: m.id, content: m.content });
        continue;
      }
      if (await this.memory.remove(m.id)) out.memoriesRemoved++;
    }
    // merges into memories that were there before
    for (const m of this.memory.withTag('learned')) {
      const mb = (m.meta?.mergedBatches as string[] | undefined) ?? [];
      if (!mb.includes(id)) continue;
      this.memory.setMeta(m.id, { ...m.meta, mergedBatches: mb.filter((x) => x !== id), seenCount: Math.max(1, (m.meta?.seenCount ?? 1) - 1) });
    }
    for (const m of this.memory.withMetaValue('supersededBatch', id)) {
      const { supersededBy: _s, supersededBatch: _b, ...rest } = m.meta ?? {};
      this.memory.setMeta(m.id, rest);
      out.supersedesCleared++;
    }
    // the learned flag goes back for sessions this batch learned
    for (const it of items) {
      if (!it.learned) continue;
      let sid = it.sessionId ?? (it.key.startsWith('session:') ? it.key.slice(8) : undefined);
      // a source learned in mode learn and imported as a chat since: the session took over the learned flag
      if (!sid && it.source && it.path) {
        const l = this.store.ledgerAt(it.source, b.device, it.path);
        if (l?.learnState === 'learned') {
          if (l.sessionId) sid = l.sessionId;
          else this.store.putLedger({ ...l, learnState: undefined, updatedAt: Date.now() });
        }
      }
      if (!sid || removed.has(sid)) continue;
      this.store.setLearned(sid, null);
      repos.kv.delete(`import.learnedSeq.${sid}`);
      const s = repos.sessions.get(sid);
      if (s?.meta?.import) {
        const next = { ...s, meta: { ...s.meta, import: { ...(s.meta.import as object), learned: false } } };
        repos.sessions.update(next);
        this.engine.bus.emit({ type: 'session.updated', session: next });
      }
    }
    for (const l of this.store.ledgerByBatch(id)) if (!l.sessionId) this.store.deleteLedger(l.id);
    this.store.setBatchStatus(id, 'undone', { finishedAt: Date.now() });
    this.engine.audit(undefined, 'import.undo', `${out.sessionsRemoved} sessions, ${out.messagesRemoved} messages, ${out.memoriesRemoved} memories removed${keptSessions.size ? `, ${keptSessions.size} sessions the owner kept going in were kept` : ''}`);
    this.emit(id, true);
    return out;
  }

  // -------------------------------------------------------------------------
  // review queue
  // -------------------------------------------------------------------------

  reviewQueue(): MemoryReviewItem[] {
    return this.memory.reviewQueue().map((m) => {
      const sid = m.sourceSessionId;
      const s = sid ? this.engine.repos.sessions.get(sid) : undefined;
      return {
        memory: m,
        ...(m.meta?.evidence ? { evidence: m.meta.evidence } : {}),
        ...(m.meta?.basis ? { basis: m.meta.basis } : {}),
        ...(m.meta?.source ? { source: m.meta.source } : {}),
        ...(m.meta?.device ? { device: m.meta.device } : {}),
        ...(m.meta?.observedAt ? { observedAt: m.meta.observedAt } : {}),
        seenCount: m.meta?.seenCount ?? 1,
        ...(s ? { sessionTitle: s.title } : {}),
      };
    });
  }

  async answerReview(answer: { accept?: string[]; reject?: string[] }): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;
    for (const id of answer.accept ?? []) {
      const m = this.memory.get(id);
      if (!m || m.meta?.review !== 'pending') continue;
      this.memory.setMeta(id, { ...m.meta, review: 'accepted' });
      accepted++;
    }
    for (const id of answer.reject ?? []) {
      const m = this.memory.get(id);
      if (!m || m.meta?.review !== 'pending') continue;
      if (await this.memory.remove(id)) rejected++;
    }
    return { accepted, rejected };
  }

  // -------------------------------------------------------------------------
  // retention, uploads, the watch job, older routes
  // -------------------------------------------------------------------------

  async retention(device: string): Promise<ImportRetention[]> {
    this.checkSource(device);
    const machine = this.machine(device);
    if (!machine) throw new ImportError(409, `${this.deviceName(device)} is offline.`);
    return readRetention(machine, device);
  }

  async fixRetention(device: string, tool: ImportRetention['tool']): Promise<ImportRetention[]> {
    if (tool !== 'claude-code' && tool !== 'gemini') throw new ImportError(400, 'tool must be claude-code or gemini');
    this.checkSource(device);
    const machine = this.machine(device);
    if (!machine) throw new ImportError(409, `${this.deviceName(device)} is offline.`);
    const r = await fixRetention(machine, tool);
    // the route audits who asked; this line keeps what the file said before
    log.info(`retention fix on ${device}: ${r.file}: ${JSON.stringify(r.before ?? null)} -> ${JSON.stringify(r.after)}`);
    return readRetention(machine, device);
  }

  upload(source: string, body: Uint8Array, name?: string): ImportUploadResult {
    if (source !== 'claude-ai' && source !== 'chatgpt') throw new ImportError(400, 'source must be claude-ai or chatgpt');
    try {
      const r = this.uploads.save(source, body, name);
      // an upload is the uploader's: nobody else can scan or import it
      this.engine.repos.kv.set(`import.upload.${r.uploadId}`, this.acct);
      return r;
    } catch (err) {
      if (err instanceof UploadError) throw new ImportError(err.status, err.message);
      throw err;
    }
  }

  /**
   * Start a batch for the chats on a device that are new or grew, optionally
   * only those changed since a time and from some tools. Undefined when there
   * is nothing to import. The watch job and the daily digest use it.
   */
  async importNew(device: string, opts: { mode: ImportMode; since?: number; sources?: ImportSource[]; refreshed?: boolean }): Promise<ImportBatch | undefined> {
    if (!opts.refreshed) await this.refreshDevice(device, true);
    const keys = this.query(device, { includeSkipped: false, ...(opts.sources ? { sources: opts.sources } : {}), ...(opts.since !== undefined ? { since: opts.since } : {}) })
      .filter((x) => !x.imported?.sessionId || x.imported.state === 'behind')
      .map((x) => x.key);
    if (!keys.length) return undefined;
    const b = await this.startBatch({ device, keys, mode: opts.mode });
    // the device's chats are coming in: its pairing offer is answered
    importOffersOf(this.engine)?.imported(device);
    return b;
  }

  /**
   * Chats on a device the import would bring by default (not imported yet, not
   * skipped), per tool, from a fresh scan: the offer made when a computer
   * pairs (import/offers.ts). Runs as the device's account.
   */
  async newChats(device: string): Promise<Partial<Record<ImportSource, number>>> {
    this.checkSource(device);
    await this.refreshDevice(device, true);
    const out: Partial<Record<ImportSource, number>> = {};
    for (const x of this.query(device, { includeSkipped: false })) if (!x.imported?.sessionId) out[x.source] = (out[x.source] ?? 0) + 1;
    return out;
  }

  /** Every 6 hours: online devices, new and grown chats, in the owner's mode. */
  private async watch(): Promise<void> {
    const cfg = this.engine.config.get();
    if (!cfg.import?.watch) return;
    const mode: ImportMode = cfg.import.watchMode ?? (cfg.memory.enabled ? 'chats-learn' : 'chats');
    try {
      for (const d of this.engine.devices.list().filter((x) => x.online)) {
        if (!this.engine.devices.get(d.id)) continue;
        // each device is watched for its own account; a member's only when they turned it on
        const acct = this.engine.repos.devices.accountOf(d.id) ?? OWNER_ID;
        if (isMember(acct) && !this.engine.accountPrefs(acct).importWatch) continue;
        await runAs(acct, async () => {
          await this.refreshDevice(d.id, true).catch((err) => log.warn(`watch scan of ${d.id} failed: ${(err as Error).message}`));
          const b = await this.importNew(d.id, { mode, refreshed: true }).catch((err) => void log.warn(`watch import on ${d.id} failed: ${(err as Error).message}`));
          if (b) this.engine.audit(undefined, 'import.watch', `${mode}, ${b.total} new or grown chats on ${this.deviceName(d.id)}`);
        });
      }
    } finally {
      this.engine.scheduler.enqueue(WATCH_JOB, Date.now() + WATCH_EVERY_MS, {}, WATCH_JOB);
    }
  }

  /** GET /api/import/sessions for older clients: the device's main sessions, newest first. */
  async legacyList(device: string): Promise<ExternalSessionInfo[]> {
    this.checkSource(device);
    await this.refreshDevice(device);
    return this.query(device, { sources: ['claude-code', 'codex'], kinds: ['main'] }).slice(0, 200);
  }

  /** POST /api/import for older clients: one session by the tool's id, through the ledger. */
  async importOne(source: ImportSource, nativeId: string, device: string): Promise<Session> {
    this.checkSource(device);
    await this.refreshDevice(device);
    const find = () => this.query(device, { sources: [source] }).find((x) => x.id === nativeId || x.id === nativeId.toLowerCase());
    // a chat written since the last scan (the one made when the device paired, under a minute ago): read the device again
    let row = find();
    if (!row && this.machine(device)) {
      await this.refreshDevice(device, true);
      row = find();
    }
    if (!row) throw new ImportError(404, `${sourceName(source)} session ${nativeId} not found on ${this.deviceName(device)}`);
    const { conv, found } = await this.readSource(device, source, row.path);
    const r = await this.importConverted(device, conv, found, 'single');
    if (!r.sessionId) throw new ImportError(409, r.reason ?? 'The session could not be imported.');
    return this.engine.repos.sessions.get(r.sessionId)!;
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  /** import.batch at most once a second per batch; `now` sends at once (state changes). */
  private emit(id: string, now = false): void {
    const send = () => {
      this.emitTimers.delete(id);
      this.emitAt.set(id, Date.now());
      const b = this.store.batch(id);
      if (b) this.engine.bus.emit({ type: 'import.batch', batch: batchDto(b) });
    };
    const since = Date.now() - (this.emitAt.get(id) ?? 0);
    if (now || since >= 1000) {
      const t = this.emitTimers.get(id);
      if (t) clearTimeout(t);
      send();
      return;
    }
    if (!this.emitTimers.has(id)) this.emitTimers.set(id, setTimeout(send, 1000 - since));
  }
}

function checkMode(mode: unknown): ImportMode {
  if (mode !== 'chats' && mode !== 'chats-learn' && mode !== 'learn') throw new ImportError(400, 'mode must be chats, chats-learn or learn');
  return mode;
}

export type { ImportSessionKind };
