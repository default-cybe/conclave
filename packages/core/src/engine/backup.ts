/**
 * Hub backup and restore (GET /api/backup, POST /api/restore).
 *
 * A backup is one JSON document: the user config, user agent files,
 * routines, tasks, memory notes, and sessions with their messages. Provider
 * keys, named secrets and config fields that hold secrets (tokens, API keys,
 * passwords, Authorization headers) stay out unless the caller asks for them.
 * The owner token is never written.
 *
 * Restore adds what this hub does not have yet. Sessions, messages, notes and
 * tasks that already exist (same id) are left alone. Agent files and routines
 * from the backup replace ones with the same name or id. Settings are merged
 * into config.json, except the server block (address, port and token stay as
 * they are on this hub).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BackupCounts, BackupOptions, HubBackup, RestoreOptions, RestoreResult } from '../client';
import type { ConfigStore } from '../config';
import type { ConclaveConfig } from '../config/schema';
import { dropRetiredKeys, isRetiredPath } from '../config/retired';
import type { Repos } from '../storage/repos';
import type { RoutineService } from '../scheduler/types';
import type { EventBus } from '../util/bus';
import type { MemoryEntry, Message, Routine, Session, Task } from '../types';
import { EngineError } from './errors';
import { OWNER_ID } from '../people/context';
import { LOGIN_SECRET_PREFIX } from '../browser/logins';

export const BACKUP_FORMAT = 'conclave-backup';
export const BACKUP_VERSION = 1;

/** What backup and restore need from the engine. */
export interface BackupHost {
  readonly config: ConfigStore;
  readonly repos: Repos;
  readonly version: string;
  readonly bus?: EventBus;
  /** Re-places a routine's next run after its row changed. */
  readonly routines?: Pick<RoutineService, 'update'>;
  /** Hub name for the file header. */
  hubName?(): string;
  /** Reload agents after their files changed. */
  reload?(): Promise<void>;
}

/** Key names whose string values are secrets. Names ending in "Env" point at an environment variable and are kept. */
const SECRET_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;
/** ${secret:name}, ${env:NAME} and the ${NAME} form other CLIs use: references to a value kept elsewhere. */
const PLACEHOLDER = /\$\{(?:(?:env|secret):[^}]+|[A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * True when the value only points at a secret: one or more placeholders and at
 * most an auth scheme word around them ("Bearer ${secret:github}").
 */
export function isReference(value: string): boolean {
  const rest = value.replace(PLACEHOLDER, '');
  return rest !== value && /^\s*(?:bearer|basic|token)?\s*$/i.test(rest);
}

const AGENT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const emptyCounts = (): BackupCounts => ({ agents: 0, routines: 0, tasks: 0, memories: 0, sessions: 0, messages: 0 });

/**
 * Copy of the config with secret values removed. Returns the dotted paths it
 * removed. Placeholders like ${secret:name} or "Bearer ${env:TOKEN}" are
 * references, not secrets, and stay.
 */
export function redactConfig(config: Record<string, unknown>): { config: Record<string, unknown>; redacted: string[] } {
  const redacted: string[] = [];
  const walk = (v: unknown, path: string[]): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && SECRET_KEY.test(k) && !/Env$/.test(k) && !isReference(val)) {
        redacted.push([...path, k].join('.'));
        continue;
      }
      out[k] = walk(val, [...path, k]);
    }
    return out;
  };
  return { config: walk(config, []) as Record<string, unknown>, redacted };
}

function readSecrets(config: ConfigStore): { providers: Record<string, string>; values: Record<string, string> } {
  const file = config.paths.secrets;
  if (!existsSync(file)) return { providers: {}, values: {} };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { providers?: Record<string, string>; values?: Record<string, string> };
    // saved browser logins stay home: their list and key are not in backups, so their passwords are not either (browser/logins.ts)
    const values = Object.fromEntries(Object.entries(data.values ?? {}).filter(([k]) => !k.startsWith(LOGIN_SECRET_PREFIX)));
    return { providers: { ...(data.providers ?? {}) }, values };
  } catch {
    return { providers: {}, values: {} };
  }
}

function readAgents(dir: string): Array<{ file: string; content: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => AGENT_FILE.test(f))
    .sort()
    .map((file) => ({ file, content: readFileSync(join(dir, file), 'utf8') }));
}

function readMemories(host: BackupHost): MemoryEntry[] {
  // a backup is the owner's: members' memories are theirs (docs/design/ACCOUNTS.md)
  const rows = host.repos.db.query('SELECT * FROM memories WHERE account_id = ? ORDER BY created_at ASC').all(OWNER_ID) as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    scopeKey: r.scope_key ?? undefined,
    kind: r.kind,
    content: r.content,
    tags: safeJson<string[]>(r.tags, []),
    sourceSessionId: r.source_session_id ?? undefined,
    importance: r.importance,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at ?? undefined,
    useCount: r.use_count ?? 0,
    // review: pending and supersededBy live here; without them a restore brings stale notes back into recall
    ...(r.meta ? { meta: safeJson<Record<string, unknown>>(r.meta, {}) } : {}),
  }));
}

/** The value at a dotted path ("search.apiKey"), or undefined. */
function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function safeJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Build a backup document. */
export function createBackup(host: BackupHost, opts: BackupOptions = {}): HubBackup {
  const withSecrets = opts.secrets === true;
  const withSessions = opts.sessions !== false;
  const user = structuredClone(host.config.getUser()) as Record<string, unknown>;
  // the owner token is how clients reach this hub; it is never part of a backup
  if (isObject(user.server)) delete user.server.token;
  const { config, redacted } = withSecrets ? { config: user, redacted: [] as string[] } : redactConfig(user);
  const all = host.config.secretNames();
  const names = { ...all, values: all.values.filter((k) => !k.startsWith(LOGIN_SECRET_PREFIX)) };

  // the owner's account only: a member's chats, routines and memory never land in the owner's backup file
  const routines = host.repos.routines.list(OWNER_ID).map((r) => (withSecrets ? r : { ...r, webhookSecret: undefined }));
  const tasks = host.repos.tasks.list({ accountId: OWNER_ID });
  const memories = readMemories(host);
  const sessions: Session[] = withSessions ? host.repos.sessions.list({ limit: 1_000_000, accountId: OWNER_ID }) : [];
  const messages: Message[] = [];
  for (const s of sessions) messages.push(...host.repos.messages.list(s.id));
  const agents = readAgents(host.config.paths.agents);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    hub: { name: host.hubName?.() ?? 'Conclave', version: host.version },
    includesSecrets: withSecrets,
    config,
    redacted,
    secretNames: names,
    ...(withSecrets ? { secrets: readSecrets(host.config) } : {}),
    agents,
    routines,
    tasks,
    memories,
    sessions,
    messages,
    counts: { agents: agents.length, routines: routines.length, tasks: tasks.length, memories: memories.length, sessions: sessions.length, messages: messages.length },
  };
}

/** Throws a 400 that says what is wrong with the file. */
export function parseBackup(data: unknown): HubBackup {
  if (!isObject(data) || data.format !== BACKUP_FORMAT) throw new EngineError(400, 'This is not a Conclave backup. Pick the .json file that Download a backup saved.');
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) throw new EngineError(400, `This backup is version ${String(data.version)} and this hub reads version ${BACKUP_VERSION}. Update the hub, then restore again.`);
  const lists = ['agents', 'routines', 'tasks', 'memories', 'sessions', 'messages'] as const;
  for (const k of lists) {
    if (data[k] !== undefined && !Array.isArray(data[k])) throw new EngineError(400, `The backup's ${k} is not a list. The file may be damaged.`);
  }
  if (data.config !== undefined && !isObject(data.config)) throw new EngineError(400, "The backup's settings are not an object. The file may be damaged.");
  return {
    ...(data as unknown as HubBackup),
    config: (data.config as Record<string, unknown>) ?? {},
    redacted: Array.isArray(data.redacted) ? (data.redacted as string[]) : [],
    secretNames: isObject(data.secretNames) ? (data.secretNames as HubBackup['secretNames']) : { providers: [], values: [] },
    agents: (data.agents as HubBackup['agents']) ?? [],
    routines: (data.routines as Routine[]) ?? [],
    tasks: (data.tasks as Task[]) ?? [],
    memories: (data.memories as MemoryEntry[]) ?? [],
    sessions: (data.sessions as Session[]) ?? [],
    messages: (data.messages as Message[]) ?? [],
  };
}

const LIVE: Session['status'][] = ['running', 'waiting_approval', 'waiting_input', 'waiting_reset'];

/** Load a backup into this hub. See the file header for what wins. */
export async function restoreBackup(host: BackupHost, data: unknown, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const b = parseBackup(data);
  const restored = emptyCounts();
  const skipped = emptyCounts();
  const { repos, config } = host;
  const db = repos.db;

  // settings: merged in, the server block stays as it is here
  let configDone = false;
  if (opts.config !== false && Object.keys(b.config).length) {
    const patch = structuredClone(b.config) as Partial<ConclaveConfig> & Record<string, unknown>;
    delete patch.server;
    config.update(patch);
    configDone = true;
  }

  // keys and named secrets, when the file has them; not ones only a retired key used
  let secrets = 0;
  const retiredSecrets = new Set(dropRetiredKeys(structuredClone(b.config)).secrets);
  if (isObject(b.secrets)) {
    for (const kind of ['providers', 'values'] as const) {
      const rec = (b.secrets as Record<string, unknown>)[kind];
      if (!isObject(rec)) continue;
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v !== 'string' || !v || (kind === 'values' && retiredSecrets.has(k))) continue;
        config.setSecret(kind, k, v);
        secrets++;
      }
    }
  }

  // agent files: the backup's copy wins
  for (const a of b.agents) {
    if (!a || typeof a.file !== 'string' || typeof a.content !== 'string' || !AGENT_FILE.test(a.file)) {
      skipped.agents++;
      continue;
    }
    writeFileSync(join(config.paths.agents, a.file), a.content);
    restored.agents++;
  }

  const routineIds: Array<{ id: string; enabled: boolean }> = [];
  db.transaction(() => {
    // routines: the backup's copy wins; keep this hub's webhook secret when the file has none
    for (const r of b.routines) {
      if (!r?.id || !r.name || !r.schedule || !r.prompt) {
        skipped.routines++;
        continue;
      }
      const cur = repos.routines.get(r.id);
      const webhookSecret = r.webhookSecret || cur?.webhookSecret || randomBytes(24).toString('base64url');
      if (cur && (cur.accountId ?? OWNER_ID) !== OWNER_ID) {
        skipped.routines++;
        continue;
      }
      // whatever the file says, a restored row is the owner's
      repos.routines.upsert({ ...r, accountId: OWNER_ID, webhookSecret, sessionId: r.sessionId, nextRunAt: undefined });
      routineIds.push({ id: r.id, enabled: !!r.enabled });
      restored.routines++;
    }

    for (const t of b.tasks) {
      if (!t?.id || !t.title) {
        skipped.tasks++;
        continue;
      }
      if (repos.tasks.get(t.id)) {
        skipped.tasks++;
        continue;
      }
      repos.tasks.upsert({ ...t, accountId: OWNER_ID, description: t.description ?? '', labels: t.labels ?? [], priority: t.priority ?? 1, status: t.status ?? 'todo' });
      restored.tasks++;
    }

    const hasMemory = db.query('SELECT 1 FROM memories WHERE id = ?');
    const addMemory = db.query(
      `INSERT INTO memories (id,scope,scope_key,kind,content,tags,source_session_id,importance,created_at,updated_at,last_used_at,use_count,meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const addMemoryFts = db.query('INSERT INTO memories_fts (content, tags, memory_id) VALUES (?,?,?)');
    for (const m of b.memories) {
      if (!m?.id || typeof m.content !== 'string') {
        skipped.memories++;
        continue;
      }
      if (hasMemory.get(m.id)) {
        skipped.memories++;
        continue;
      }
      const tags = Array.isArray(m.tags) ? m.tags : [];
      const now = Date.now();
      addMemory.run(m.id, m.scope ?? 'global', m.scopeKey ?? null, m.kind ?? 'fact', m.content, JSON.stringify(tags), m.sourceSessionId ?? null, m.importance ?? 0.5, m.createdAt ?? now, m.updatedAt ?? now, m.lastUsedAt ?? null, m.useCount ?? 0, isObject(m.meta) ? JSON.stringify(m.meta) : null);
      addMemoryFts.run(m.content, tags.join(' '), m.id);
      restored.memories++;
    }

    // sessions: only new ones, and nothing comes back as running
    const added = new Set<string>();
    for (const s of b.sessions) {
      if (!s?.id || !s.title) {
        skipped.sessions++;
        continue;
      }
      if (repos.sessions.get(s.id)) {
        skipped.sessions++;
        continue;
      }
      const status = LIVE.includes(s.status) ? 'idle' : s.status;
      repos.sessions.insert({ ...s, accountId: OWNER_ID, status, resumeAt: status === 'idle' ? undefined : s.resumeAt, tags: s.tags ?? [], stats: s.stats ?? { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
      added.add(s.id);
      restored.sessions++;
    }
    const hasMessage = db.query('SELECT 1 FROM messages WHERE id = ?');
    for (const m of b.messages) {
      if (!m?.id || !added.has(m.sessionId) || hasMessage.get(m.id)) {
        skipped.messages++;
        continue;
      }
      repos.messages.insert({ ...m, content: Array.isArray(m.content) ? m.content : [] });
      restored.messages++;
    }
  })();

  // put each routine's next run back on the schedule
  for (const { id, enabled } of routineIds) {
    try {
      host.routines?.update(id, { enabled });
    } catch {
      /* a schedule this hub cannot parse; the row is there to fix by hand */
    }
  }
  if (restored.agents) await host.reload?.().catch(() => {});

  const have = new Set(config.secretNames().providers);
  const missingKeys = (b.secretNames.providers ?? []).filter((p) => !have.has(p) && !config.hasProviderKey(p));
  host.bus?.emit({ type: 'config.updated' });
  // a field the file left out is only worth a mention when this hub has no value for it either
  const user = config.getUser() as Record<string, unknown>;
  // keys this hub no longer reads (an old Telegram bot token) are not worth entering again
  const redacted = b.includesSecrets ? [] : b.redacted.filter((path) => typeof path === 'string' && !isRetiredPath(path) && valueAt(user, path) === undefined);
  return { config: configDone, secrets, restored, skipped, missingKeys, redacted };
}
