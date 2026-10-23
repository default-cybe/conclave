import type { Db } from './db';
import { json } from './db';
import type {
  AuditEntry,
  Checkpoint,
  ContentBlock,
  Device,
  MachineInfo,
  LimitState,
  Message,
  Routine,
  RoutineRun,
  Session,
  SessionKind,
  SessionStats,
  Task,
  UsageRecord,
} from '../types';
import { newId } from '../util/ids';
import { limitKey } from '../accounts/windows';
import { OWNER_ID } from '../people/context';

type Row = Record<string, any>;

const EMPTY_STATS: SessionStats = { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

/** Session.projectId, kept in the meta column (projects/store.ts sets it). */
function projectIdOf(meta: string | null | undefined): { projectId?: string } {
  const id = json<Record<string, unknown>>(meta, {}).projectId;
  return typeof id === 'string' && id ? { projectId: id } : {};
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function rowToSession(r: Row): Session {
  return {
    id: r.id,
    accountId: r.account_id ?? OWNER_ID,
    title: r.title,
    agent: r.agent,
    model: r.model,
    mode: r.mode,
    permissionMode: r.permission_mode,
    cwd: r.cwd,
    device: r.device ?? 'local',
    status: r.status,
    parentId: r.parent_id ?? undefined,
    taskId: r.task_id ?? undefined,
    routineId: r.routine_id ?? undefined,
    tags: json(r.tags, []),
    pinned: !!r.pinned,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    external: json(r.external, undefined),
    modeConfig: json(r.mode_config, undefined),
    stats: { ...EMPTY_STATS, ...json(r.stats, {}) },
    resumeAt: r.resume_at ?? undefined,
    error: r.error ?? undefined,
    meta: json(r.meta, undefined),
    // a workbench session keeps its effort and memory switches in chat
    ...(r.kind === 'chat' ? { kind: 'chat' as const, chat: json(r.chat, undefined) } : r.chat ? { chat: json(r.chat, undefined) } : {}),
    // folders across devices: the project id rides in meta until it gets its own column
    ...projectIdOf(r.meta),
    // workflows: the Ultra switch (migration 5)
    ...(r.ultra ? { ultra: true } : {}),
  };
}

export interface SessionFilter {
  /** Only this account's sessions (docs/design/ACCOUNTS.md). Every list a person sees sets it. */
  accountId?: string;
  agent?: string;
  taskId?: string;
  parentId?: string | null;
  routineId?: string;
  status?: Session['status'];
  archived?: boolean;
  pinned?: boolean;
  tag?: string;
  cwd?: string;
  device?: string;
  search?: string;
  /** "chat" lists only chats; "agent" lists everything else (including sessions from before chats existed). */
  kind?: SessionKind;
  limit?: number;
  offset?: number;
}

export class SessionRepo {
  constructor(private db: Db) {}

  insert(s: Session): void {
    this.db
      .query(
        `INSERT INTO sessions (id,title,agent,model,mode,permission_mode,cwd,device,status,parent_id,task_id,routine_id,tags,pinned,archived,created_at,updated_at,external,mode_config,stats,resume_at,error,meta,kind,chat,ultra,account_id)
         VALUES ($id,$title,$agent,$model,$mode,$pm,$cwd,$device,$status,$parent,$task,$routine,$tags,$pinned,$archived,$created,$updated,$external,$modeConfig,$stats,$resumeAt,$error,$meta,$kind,$chat,$ultra,$account)`,
      )
      .run({ ...this.params(s), account: s.accountId ?? OWNER_ID });
  }

  update(s: Session): void {
    this.db
      .query(
        `UPDATE sessions SET title=$title,agent=$agent,model=$model,mode=$mode,permission_mode=$pm,cwd=$cwd,device=$device,status=$status,parent_id=$parent,task_id=$task,routine_id=$routine,tags=$tags,pinned=$pinned,archived=$archived,updated_at=$updated,external=$external,mode_config=$modeConfig,stats=$stats,resume_at=$resumeAt,error=$error,meta=$meta,kind=$kind,chat=$chat,ultra=$ultra WHERE id=$id`,
      )
      .run(this.params(s));
  }

  private params(s: Session) {
    return {
      id: s.id,
      title: s.title,
      agent: s.agent,
      model: s.model,
      mode: s.mode,
      pm: s.permissionMode,
      cwd: s.cwd,
      device: s.device ?? 'local',
      status: s.status,
      parent: s.parentId ?? null,
      task: s.taskId ?? null,
      routine: s.routineId ?? null,
      tags: JSON.stringify(s.tags ?? []),
      pinned: s.pinned ? 1 : 0,
      archived: s.archived ? 1 : 0,
      created: s.createdAt,
      updated: s.updatedAt,
      external: s.external ? JSON.stringify(s.external) : null,
      modeConfig: s.modeConfig ? JSON.stringify(s.modeConfig) : null,
      stats: JSON.stringify(s.stats ?? EMPTY_STATS),
      resumeAt: s.resumeAt ?? null,
      error: s.error ?? null,
      meta: s.meta || s.projectId ? JSON.stringify({ ...s.meta, ...(s.projectId ? { projectId: s.projectId } : {}) }) : null,
      kind: s.kind === 'chat' ? 'chat' : null,
      chat: s.kind === 'chat' && s.chat ? JSON.stringify(s.chat) : s.chat?.thinking || s.chat?.memory === false ? JSON.stringify(s.chat) : null,
      ultra: s.ultra ? 1 : null,
    };
  }

  get(id: string): Session | undefined {
    const r = this.db.query('SELECT * FROM sessions WHERE id = ?').get(id) as Row | null;
    return r ? rowToSession(r) : undefined;
  }

  list(f: SessionFilter = {}): Session[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (f.accountId) (where.push('account_id = $account'), (params.account = f.accountId));
    if (f.agent) (where.push('agent = $agent'), (params.agent = f.agent));
    if (f.taskId) (where.push('task_id = $task'), (params.task = f.taskId));
    if (f.routineId) (where.push('routine_id = $routine'), (params.routine = f.routineId));
    // top-level sessions: no parent, or moved to the main list (session/delegated.ts)
    if (f.parentId === null) where.push(`(parent_id IS NULL OR json_extract(meta, '$.movedFrom') IS NOT NULL)`);
    else if (f.parentId) (where.push('parent_id = $parent'), (params.parent = f.parentId));
    if (f.status) (where.push('status = $status'), (params.status = f.status));
    if (f.archived !== undefined) (where.push('archived = $archived'), (params.archived = f.archived ? 1 : 0));
    if (f.pinned !== undefined) (where.push('pinned = $pinned'), (params.pinned = f.pinned ? 1 : 0));
    if (f.cwd) (where.push('cwd = $cwd'), (params.cwd = f.cwd));
    if (f.device) (where.push('device = $device'), (params.device = f.device));
    if (f.kind === 'chat') where.push(`kind = 'chat'`);
    else if (f.kind === 'agent') where.push(`(kind IS NULL OR kind <> 'chat')`);
    if (f.tag) (where.push(`EXISTS (SELECT 1 FROM json_each(sessions.tags) WHERE value = $tag)`), (params.tag = f.tag));
    if (f.search) {
      where.push(
        `(title LIKE $like OR id IN (SELECT session_id FROM messages_fts WHERE messages_fts MATCH $match))`,
      );
      params.like = `%${f.search}%`;
      params.match = ftsQuery(f.search);
    }
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pinned DESC, updated_at DESC LIMIT $limit OFFSET $offset`;
    params.limit = f.limit ?? 200;
    params.offset = f.offset ?? 0;
    return (this.db.query(sql).all(params as any) as Row[]).map(rowToSession);
  }

  delete(id: string): void {
    this.db.query('DELETE FROM messages_fts WHERE session_id = ?').run(id);
    this.db.query('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** Sessions stuck in running/waiting states after a crash or restart. */
  listActive(): Session[] {
    return (
      this.db
        .query(`SELECT * FROM sessions WHERE status IN ('running','waiting_approval','waiting_input','waiting_reset')`)
        .all() as Row[]
    ).map(rowToSession);
  }
}

/** Turn free text into a safe FTS5 query: each word as a prefix term. */
export function ftsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 12);
  if (!words.length) return '""';
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function rowToMessage(r: Row): Message {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    role: r.role,
    kind: r.kind,
    content: json<ContentBlock[]>(r.content, []),
    model: r.model ?? undefined,
    agent: r.agent ?? undefined,
    author: r.author ?? undefined,
    group: r.grp ?? undefined,
    usage: json(r.usage, undefined),
    stopReason: r.stop_reason ?? undefined,
    createdAt: r.created_at,
    meta: json(r.meta, undefined),
  };
}

/** Text used for full-text search: user/assistant text only, no tool payloads and no reminders (recalled memories, hook context). */
function indexedText(kind: Message['kind'], content: ContentBlock[]): string {
  if (kind === 'notice') return '';
  return content
    .map((b) => (b.type === 'text' && !b.text.startsWith('<system-reminder>') ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, 20_000);
}

export class MessageRepo {
  constructor(private db: Db) {}

  nextSeq(sessionId: string): number {
    const r = this.db.query('SELECT MAX(seq) as m FROM messages WHERE session_id = ?').get(sessionId) as Row | null;
    return (r?.m ?? 0) + 1;
  }

  insert(m: Message): void {
    this.db
      .query(
        `INSERT INTO messages (id,session_id,seq,role,kind,content,model,agent,author,grp,usage,stop_reason,created_at,meta)
         VALUES ($id,$sid,$seq,$role,$kind,$content,$model,$agent,$author,$grp,$usage,$stop,$created,$meta)`,
      )
      .run(this.params(m));
    this.index(m);
  }

  update(m: Message): void {
    const old = this.db.query('SELECT kind, content FROM messages WHERE id = ?').get(m.id) as Row | null;
    this.db
      .query(
        `UPDATE messages SET content=$content,model=$model,agent=$agent,author=$author,grp=$grp,usage=$usage,stop_reason=$stop,meta=$meta,kind=$kind,role=$role WHERE id=$id`,
      )
      .run({ ...this.params(m) });
    // finding the old index row scans the whole index (message_id is unindexed), so only when its text changed
    const before = old ? indexedText(old.kind, json<ContentBlock[]>(old.content, [])) : '';
    const after = indexedText(m.kind, m.content);
    if (before === after) return;
    if (before) this.db.query('DELETE FROM messages_fts WHERE message_id = ?').run(m.id);
    this.index(m);
  }

  private index(m: Message) {
    const text = indexedText(m.kind, m.content);
    if (text) this.db.query('INSERT INTO messages_fts (text, session_id, message_id) VALUES (?, ?, ?)').run(text, m.sessionId, m.id);
  }

  private params(m: Message) {
    return {
      id: m.id,
      sid: m.sessionId,
      seq: m.seq,
      role: m.role,
      kind: m.kind,
      content: JSON.stringify(m.content),
      model: m.model ?? null,
      agent: m.agent ?? null,
      author: m.author ?? null,
      grp: m.group ?? null,
      usage: m.usage ? JSON.stringify(m.usage) : null,
      stop: m.stopReason ?? null,
      created: m.createdAt,
      meta: m.meta ? JSON.stringify(m.meta) : null,
    };
  }

  get(id: string): Message | undefined {
    const r = this.db.query('SELECT * FROM messages WHERE id = ?').get(id) as Row | null;
    return r ? rowToMessage(r) : undefined;
  }

  list(sessionId: string, opts: { afterSeq?: number; limit?: number } = {}): Message[] {
    const rows = this.db
      .query('SELECT * FROM messages WHERE session_id = $sid AND seq > $after ORDER BY seq ASC LIMIT $limit')
      .all({ sid: sessionId, after: opts.afterSeq ?? 0, limit: opts.limit ?? 100_000 }) as Row[];
    return rows.map(rowToMessage);
  }

  /** Most recent N messages in ascending order. */
  tail(sessionId: string, n: number): Message[] {
    const rows = this.db
      .query('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, n) as Row[];
    return rows.map(rowToMessage).reverse();
  }

  delete(id: string): void {
    this.db.query('DELETE FROM messages_fts WHERE message_id = ?').run(id);
    this.db.query('DELETE FROM messages WHERE id = ?').run(id);
  }

  /** Delete messages with seq > given (used for edit-and-resend / rewind). One pass over the index, not one per message. */
  truncateAfter(sessionId: string, seq: number): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE session_id = ? AND seq > ?)').run(sessionId, seq);
      this.db.query('DELETE FROM messages WHERE session_id = ? AND seq > ?').run(sessionId, seq);
    })();
  }

  /** Full-text search over one account's messages (the index has no account: it joins the session). */
  search(query: string, limit = 30, accountId: string = OWNER_ID): Array<{ sessionId: string; messageId: string; snippet: string }> {
    return this.db
      .query(
        `SELECT session_id as sessionId, message_id as messageId, snippet(messages_fts, 0, '[', ']', '…', 16) as snippet
         FROM messages_fts WHERE messages_fts MATCH ? AND session_id IN (SELECT id FROM sessions WHERE account_id = ?) ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery(query), accountId, limit) as Array<{ sessionId: string; messageId: string; snippet: string }>;
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function rowToTask(r: Row): Task {
  return {
    id: r.id,
    accountId: r.account_id ?? OWNER_ID,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    agent: r.agent ?? undefined,
    project: r.project ?? undefined,
    due: r.due ?? undefined,
    labels: json(r.labels, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    meta: json(r.meta, undefined),
  };
}

export class TaskRepo {
  constructor(private db: Db) {}

  upsert(t: Task): void {
    this.db
      .query(
        `INSERT INTO tasks (id,title,description,status,priority,agent,project,due,labels,created_at,updated_at,meta,account_id)
         VALUES ($id,$title,$desc,$status,$prio,$agent,$project,$due,$labels,$created,$updated,$meta,$account)
         ON CONFLICT(id) DO UPDATE SET title=$title,description=$desc,status=$status,priority=$prio,agent=$agent,project=$project,due=$due,labels=$labels,updated_at=$updated,meta=$meta`,
      )
      .run({
        id: t.id,
        title: t.title,
        desc: t.description,
        status: t.status,
        prio: t.priority,
        agent: t.agent ?? null,
        project: t.project ?? null,
        due: t.due ?? null,
        labels: JSON.stringify(t.labels ?? []),
        created: t.createdAt,
        updated: t.updatedAt,
        meta: t.meta ? JSON.stringify(t.meta) : null,
        account: t.accountId ?? OWNER_ID,
      });
  }

  get(id: string): Task | undefined {
    const r = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Row | null;
    return r ? rowToTask(r) : undefined;
  }

  list(f: { status?: string; agent?: string; project?: string; accountId?: string } = {}): Task[] {
    const where: string[] = [];
    const p: Record<string, unknown> = {};
    if (f.accountId) (where.push('account_id = $account'), (p.account = f.accountId));
    if (f.status) (where.push('status = $status'), (p.status = f.status));
    if (f.agent) (where.push('agent = $agent'), (p.agent = f.agent));
    if (f.project) (where.push('project = $project'), (p.project = f.project));
    return (
      this.db
        .query(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, updated_at DESC`)
        .all(p as any) as Row[]
    ).map(rowToTask);
  }

  delete(id: string): void {
    this.db.query('DELETE FROM tasks WHERE id = ?').run(id);
    this.db.query('UPDATE sessions SET task_id = NULL WHERE task_id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

/** Routine fields kept in the extra JSON column. */
const ROUTINE_EXTRA = ['allow', 'deny', 'onApproval', 'precheck', 'env', 'timeoutMin', 'maxCostUsd', 'suggestion', 'template', 'builtin', 'watch'] as const;
const RUN_EXTRA = ['outcome', 'denied', 'precheckOutput'] as const;

function pickExtra<T extends object>(o: T, keys: readonly string[]): string | null {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function readExtra(v: unknown, keys: readonly string[]): Record<string, unknown> {
  const data = json<Record<string, unknown>>(typeof v === 'string' ? v : null, {});
  return Object.fromEntries(keys.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => [k, data[k]]));
}

function rowToRun(r: Row): RoutineRun {
  return {
    id: r.id,
    routineId: r.routine_id,
    sessionId: r.session_id ?? undefined,
    status: r.status,
    trigger: r.trigger,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    error: r.error ?? undefined,
    summary: r.summary ?? undefined,
    ...readExtra(r.extra, RUN_EXTRA),
  };
}

function rowToRoutine(r: Row): Routine {
  return {
    ...(readExtra(r.extra, ROUTINE_EXTRA) as Partial<Routine>),
    id: r.id,
    accountId: r.account_id ?? OWNER_ID,
    name: r.name,
    schedule: r.schedule,
    timezone: r.timezone ?? undefined,
    agent: r.agent,
    model: r.model ?? undefined,
    mode: r.mode,
    prompt: r.prompt,
    cwd: r.cwd ?? undefined,
    device: r.device ?? undefined,
    enabled: !!r.enabled,
    sessionPolicy: r.session_policy,
    sessionId: r.session_id ?? undefined,
    notify: r.notify,
    webhookSecret: r.webhook_secret ?? undefined,
    lastRunAt: r.last_run_at ?? undefined,
    nextRunAt: r.next_run_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class RoutineRepo {
  constructor(private db: Db) {}

  upsert(r: Routine): void {
    this.db
      .query(
        `INSERT INTO routines (id,name,schedule,timezone,agent,model,mode,prompt,cwd,device,enabled,session_policy,session_id,notify,webhook_secret,last_run_at,next_run_at,created_at,updated_at,extra,account_id)
         VALUES ($id,$name,$schedule,$tz,$agent,$model,$mode,$prompt,$cwd,$device,$enabled,$policy,$sid,$notify,$secret,$last,$next,$created,$updated,$extra,$account)
         ON CONFLICT(id) DO UPDATE SET name=$name,schedule=$schedule,timezone=$tz,agent=$agent,model=$model,mode=$mode,prompt=$prompt,cwd=$cwd,device=$device,enabled=$enabled,session_policy=$policy,session_id=$sid,notify=$notify,webhook_secret=$secret,last_run_at=$last,next_run_at=$next,updated_at=$updated,extra=$extra`,
      )
      .run({
        id: r.id,
        name: r.name,
        schedule: r.schedule,
        tz: r.timezone ?? null,
        agent: r.agent,
        model: r.model ?? null,
        mode: r.mode,
        prompt: r.prompt,
        cwd: r.cwd ?? null,
        device: r.device ?? null,
        enabled: r.enabled ? 1 : 0,
        policy: r.sessionPolicy,
        sid: r.sessionId ?? null,
        notify: r.notify,
        secret: r.webhookSecret ?? null,
        last: r.lastRunAt ?? null,
        next: r.nextRunAt ?? null,
        created: r.createdAt,
        updated: r.updatedAt,
        extra: pickExtra(r, ROUTINE_EXTRA),
        account: r.accountId ?? OWNER_ID,
      });
  }

  get(id: string): Routine | undefined {
    const r = this.db.query('SELECT * FROM routines WHERE id = ?').get(id) as Row | null;
    return r ? rowToRoutine(r) : undefined;
  }

  /** One account's routines, or every account's for the scheduler (accountId left out). */
  list(accountId?: string): Routine[] {
    const rows = accountId ? this.db.query('SELECT * FROM routines WHERE account_id = ? ORDER BY name').all(accountId) : this.db.query('SELECT * FROM routines ORDER BY name').all();
    return (rows as Row[]).map(rowToRoutine);
  }

  delete(id: string): void {
    this.db.query('DELETE FROM routines WHERE id = ?').run(id);
  }

  insertRun(run: RoutineRun): void {
    this.db
      .query(
        `INSERT INTO routine_runs (id,routine_id,session_id,status,trigger,started_at,finished_at,error,summary,extra) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(run.id, run.routineId, run.sessionId ?? null, run.status, run.trigger, run.startedAt, run.finishedAt ?? null, run.error ?? null, run.summary ?? null, pickExtra(run, RUN_EXTRA));
  }

  updateRun(run: RoutineRun): void {
    this.db
      .query(`UPDATE routine_runs SET session_id=?, status=?, finished_at=?, error=?, summary=?, extra=? WHERE id=?`)
      .run(run.sessionId ?? null, run.status, run.finishedAt ?? null, run.error ?? null, run.summary ?? null, pickExtra(run, RUN_EXTRA), run.id);
  }

  runs(routineId: string, limit = 50): RoutineRun[] {
    return (this.db.query('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?').all(routineId, limit) as Row[]).map(rowToRun);
  }
}

// ---------------------------------------------------------------------------
// Usage and limits
// ---------------------------------------------------------------------------

export interface UsageQuery {
  /** One person's rows (docs/design/ACCOUNTS.md). Not the provider account below. */
  accountId?: string;
  from?: number;
  to?: number;
  sessionId?: string;
  source?: string;
  account?: string;
}

export interface UsageBucket {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What was billed. */
  costUsd: number;
  /** The same tokens at API prices: the values kept on the rows, plus estimates for rows without one (usage/service.ts). */
  apiValueUsd: number;
  /** The part of apiValueUsd worked out on read for rows from before values were kept. */
  estimatedUsd?: number;
  calls: number;
  /** Rows without a kept value; the service prices them and drops this. */
  unvalued?: number;
}

/** Tokens and cost of rows without a kept API value, per bucket and model, for an estimate on read. */
export interface UnvaluedGroup {
  key: string;
  provider: string;
  model: string;
  account: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export type UsageDimension = 'day' | 'hour' | 'model' | 'provider' | 'source' | 'session' | 'purpose' | 'account' | 'device';

function rowToUsage(r: Row): UsageRecord {
  return {
    id: r.id,
    ts: r.ts,
    sessionId: r.session_id ?? undefined,
    source: r.source,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    costUsd: r.cost_usd,
    ...(typeof r.api_value_usd === 'number' ? { apiValueUsd: r.api_value_usd } : {}),
    latencyMs: r.latency_ms ?? undefined,
    purpose: r.purpose ?? undefined,
    ...(r.account ? { account: r.account } : {}),
    ...(r.device ? { device: r.device } : {}),
    ...(r.cwd ? { cwd: r.cwd } : {}),
    accountId: r.account_id ?? OWNER_ID,
    ...(r.paid_by ? { paidBy: r.paid_by } : {}),
  };
}

export class UsageRepo {
  constructor(private db: Db) {}

  insert(r: UsageRecord, extKey?: string): boolean {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO usage (id,ts,session_id,source,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,latency_ms,purpose,ext_key,account,device,cwd,account_id,paid_by,api_value_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.ts,
        r.sessionId ?? null,
        r.source,
        r.provider,
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.reasoningTokens,
        r.costUsd,
        r.latencyMs ?? null,
        r.purpose ?? null,
        extKey ?? null,
        r.account ?? null,
        r.device ?? null,
        r.cwd ?? null,
        r.accountId ?? OWNER_ID,
        r.paidBy ?? null,
        typeof r.apiValueUsd === 'number' && Number.isFinite(r.apiValueUsd) ? r.apiValueUsd : null,
      );
    return res.changes > 0;
  }

  /** Aggregate by a dimension: day | hour | model | provider | source | session | purpose | account | device. */
  aggregate(by: UsageDimension, q: UsageQuery = {}, tzOffsetMin = 0): UsageBucket[] {
    const { where, params } = usageWhere(q);
    return this.db
      .query(
        `SELECT ${usageKey(by, tzOffsetMin)} as key, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens, SUM(cache_read_tokens) as cacheReadTokens,
                SUM(cache_write_tokens) as cacheWriteTokens, SUM(cost_usd) as costUsd, COALESCE(SUM(api_value_usd),0) as apiValueUsd,
                SUM(CASE WHEN api_value_usd IS NULL THEN 1 ELSE 0 END) as unvalued, COUNT(*) as calls
         FROM usage ${where} GROUP BY key ORDER BY ${by === 'day' || by === 'hour' ? 'key ASC' : 'costUsd DESC'}`,
      )
      .all(params as any) as UsageBucket[];
  }

  totals(q: UsageQuery = {}): UsageBucket {
    const { where, params } = usageWhere(q);
    const r = this.db
      .query(
        `SELECT 'total' as key, COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(output_tokens),0) as outputTokens, COALESCE(SUM(cache_read_tokens),0) as cacheReadTokens,
                COALESCE(SUM(cache_write_tokens),0) as cacheWriteTokens, COALESCE(SUM(cost_usd),0) as costUsd, COALESCE(SUM(api_value_usd),0) as apiValueUsd,
                COALESCE(SUM(CASE WHEN api_value_usd IS NULL THEN 1 ELSE 0 END),0) as unvalued, COUNT(*) as calls FROM usage ${where}`,
      )
      .get(params as any) as UsageBucket;
    return r;
  }

  /** Rows with no kept API value, summed per bucket of a dimension ('total' for one bucket) and per model, for an estimate on read. */
  unvalued(by: UsageDimension | 'total', q: UsageQuery = {}, tzOffsetMin = 0): UnvaluedGroup[] {
    const { where, params } = usageWhere(q);
    const cond = `${where ? `${where} AND` : 'WHERE'} api_value_usd IS NULL`;
    return this.db
      .query(
        `SELECT ${by === 'total' ? "'total'" : usageKey(by, tzOffsetMin)} as key, provider, model, account, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens,
                SUM(cache_read_tokens) as cacheReadTokens, SUM(cache_write_tokens) as cacheWriteTokens, SUM(reasoning_tokens) as reasoningTokens, SUM(cost_usd) as costUsd
         FROM usage ${cond} GROUP BY key, provider, model, account`,
      )
      .all(params as any) as UnvaluedGroup[];
  }

  /** USD an account spent in [from, to), from Conclave's own cost records. */
  spend(account: string, from: number, to: number): number {
    const r = this.db.query('SELECT COALESCE(SUM(cost_usd),0) as usd FROM usage WHERE account = ? AND ts >= ? AND ts < ?').get(account, from, to) as { usd: number };
    return r.usd;
  }

  /** The account of a session's latest call since a time, for the turns log. */
  lastAccount(sessionId: string, since: number): string | undefined {
    const r = this.db.query('SELECT account FROM usage WHERE session_id = ? AND ts >= ? AND account IS NOT NULL ORDER BY ts DESC LIMIT 1').get(sessionId, since) as { account: string } | null;
    return r?.account ?? undefined;
  }

  recent(limit = 100, q: UsageQuery = {}): UsageRecord[] {
    const { where, params } = usageWhere(q);
    return (this.db.query(`SELECT * FROM usage ${where} ORDER BY ts DESC LIMIT $limit`).all({ ...params, limit } as any) as Row[]).map(rowToUsage);
  }

  /** Stored under limitKey: the provider, or provider:account. */
  setLimit(l: LimitState): void {
    this.db
      .query('INSERT INTO limits (provider, data, updated_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
      .run(limitKey(l), JSON.stringify(l), l.updatedAt);
  }

  deleteLimit(key: string): boolean {
    return this.db.query('DELETE FROM limits WHERE provider = ?').run(key).changes > 0;
  }

  limits(): LimitState[] {
    return (this.db.query('SELECT data FROM limits ORDER BY provider').all() as Row[]).map((r) => json<LimitState>(r.data, null as any)).filter(Boolean);
  }
}

/** The SQL for a dimension's bucket key. */
function usageKey(by: UsageDimension, tzOffsetMin: number): string {
  const tz = Math.round(Number(tzOffsetMin) || 0) * 60;
  return {
    day: `strftime('%Y-%m-%d', (ts / 1000) + ${tz}, 'unixepoch')`,
    hour: `strftime('%Y-%m-%d %H:00', (ts / 1000) + ${tz}, 'unixepoch')`,
    model: 'model',
    provider: 'provider',
    source: 'source',
    session: `COALESCE(session_id, '-')`,
    purpose: `COALESCE(purpose, 'turn')`,
    // rows from before accounts, and calls no account served, read as ""
    account: `COALESCE(account, '')`,
    device: `COALESCE(device, '')`,
  }[by];
}

function usageWhere(q: UsageQuery) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.accountId) (where.push('account_id = $accountId'), (params.accountId = q.accountId));
  if (q.from) (where.push('ts >= $from'), (params.from = q.from));
  if (q.to) (where.push('ts < $to'), (params.to = q.to));
  if (q.sessionId) (where.push('session_id = $sid'), (params.sid = q.sessionId));
  if (q.source) (where.push('source = $source'), (params.source = q.source));
  if (q.account) (where.push('account = $account'), (params.account = q.account));
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// ---------------------------------------------------------------------------
// Turns and approvals (Recap data, docs/research/2026-10-20-next-features.md 2)
// ---------------------------------------------------------------------------

export interface TurnRecord {
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  model?: string;
  account?: string;
  /** Tool calls in the turn. */
  tools: number;
  /** done, aborted, error, or why the loop stopped (rate_limit, step_limit, refusal...). */
  outcome?: string;
  /** The harness's own session id, for a turn an ACP harness ran. */
  harnessSession?: string;
}

export class TurnRepo {
  constructor(private db: Db) {}

  start(t: { sessionId: string; model?: string; startedAt?: number }): string {
    const id = newId('turn');
    this.db.query('INSERT INTO turns (id, session_id, started_at, model) VALUES (?,?,?,?)').run(id, t.sessionId, t.startedAt ?? Date.now(), t.model ?? null);
    return id;
  }

  end(id: string, t: { endedAt?: number; tools?: number; outcome?: string; account?: string; model?: string } = {}): void {
    this.db
      .query('UPDATE turns SET ended_at = ?, tools = COALESCE(?, tools), outcome = COALESCE(?, outcome), account = COALESCE(?, account), model = COALESCE(?, model) WHERE id = ?')
      .run(t.endedAt ?? Date.now(), t.tools ?? null, t.outcome ?? null, t.account ?? null, t.model ?? null, id);
  }

  /** The harness's session id, once its first event says it. */
  setHarnessSession(id: string, harnessSession: string): void {
    this.db.query('UPDATE turns SET harness_session = ? WHERE id = ?').run(harnessSession, id);
  }

  list(q: { sessionId?: string; from?: number; to?: number; limit?: number; accountId?: string } = {}): TurnRecord[] {
    const rows = this.db
      .query(
        'SELECT * FROM turns WHERE ($sid IS NULL OR session_id = $sid) AND ($acct IS NULL OR session_id IN (SELECT id FROM sessions WHERE account_id = $acct)) AND started_at >= $from AND started_at < $to ORDER BY started_at DESC LIMIT $limit',
      )
      .all({ sid: q.sessionId ?? null, acct: q.accountId ?? null, from: q.from ?? 0, to: q.to ?? Number.MAX_SAFE_INTEGER, limit: q.limit ?? 1000 } as any) as Row[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      startedAt: r.started_at,
      ...(r.ended_at != null ? { endedAt: r.ended_at } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.account ? { account: r.account } : {}),
      tools: r.tools,
      ...(r.outcome ? { outcome: r.outcome } : {}),
      ...(r.harness_session ? { harnessSession: r.harness_session } : {}),
    }));
  }

  /**
   * Harness sessions whose turns Conclave ran over ACP and counted itself,
   * with each turn's span. The log readers skip those lines, so one call is
   * not counted twice.
   */
  harnessSpans(since: number): Map<string, Array<[number, number]>> {
    const rows = this.db.query('SELECT harness_session, started_at, ended_at FROM turns WHERE harness_session IS NOT NULL AND started_at >= ?').all(since) as Row[];
    const out = new Map<string, Array<[number, number]>>();
    for (const r of rows) {
      const list = out.get(r.harness_session) ?? [];
      list.push([r.started_at, r.ended_at ?? Number.MAX_SAFE_INTEGER]);
      out.set(r.harness_session, list);
    }
    return out;
  }
}

export interface ApprovalLogEntry {
  id: string;
  sessionId: string;
  tool: string;
  harness?: string;
  requestedAt: number;
  resolvedAt?: number;
  decision?: string;
}

/** When each approval was asked and answered (the live ones stay in the engine). */
export class ApprovalLogRepo {
  constructor(private db: Db) {}

  requested(a: { id: string; sessionId: string; tool: string; harness?: string; requestedAt: number }): void {
    this.db.query('INSERT OR IGNORE INTO approvals (id, session_id, tool, harness, requested_at) VALUES (?,?,?,?,?)').run(a.id, a.sessionId, a.tool, a.harness ?? null, a.requestedAt);
  }

  resolved(id: string, decision: string, at = Date.now()): void {
    this.db.query('UPDATE approvals SET resolved_at = ?, decision = ? WHERE id = ? AND resolved_at IS NULL').run(at, decision, id);
  }

  list(q: { from?: number; to?: number; limit?: number; accountId?: string } = {}): ApprovalLogEntry[] {
    const rows = this.db
      .query('SELECT * FROM approvals WHERE (? IS NULL OR session_id IN (SELECT id FROM sessions WHERE account_id = ?)) AND requested_at >= ? AND requested_at < ? ORDER BY requested_at DESC LIMIT ?')
      .all(q.accountId ?? null, q.accountId ?? null, q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER, q.limit ?? 1000) as Row[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      tool: r.tool,
      ...(r.harness ? { harness: r.harness } : {}),
      requestedAt: r.requested_at,
      ...(r.resolved_at != null ? { resolvedAt: r.resolved_at } : {}),
      ...(r.decision ? { decision: r.decision } : {}),
    }));
  }
}

// ---------------------------------------------------------------------------
// Jobs (durable delayed work: limit-reset resumes, routine catch-up, retries)
// ---------------------------------------------------------------------------

export interface Job {
  id: string;
  kind: string;
  runAt: number;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  lastError?: string;
  dedupeKey?: string;
  createdAt: number;
}

export class JobRepo {
  constructor(private db: Db) {}

  enqueue(kind: string, runAt: number, payload: Record<string, unknown> = {}, dedupeKey?: string): Job {
    if (dedupeKey) {
      // replace an existing pending job with the same key
      this.db.query(`UPDATE jobs SET status='cancelled' WHERE dedupe_key = ? AND status = 'pending'`).run(dedupeKey);
    }
    const job: Job = { id: newId('job'), kind, runAt, payload, status: 'pending', attempts: 0, dedupeKey, createdAt: Date.now() };
    this.db
      .query('INSERT INTO jobs (id,kind,run_at,payload,status,attempts,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(job.id, kind, runAt, JSON.stringify(payload), 'pending', 0, dedupeKey ?? null, job.createdAt);
    return job;
  }

  due(now = Date.now()): Job[] {
    return (this.db.query(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 50`).all(now) as Row[]).map(rowToJob);
  }

  pending(kind?: string): Job[] {
    const rows = kind
      ? this.db.query(`SELECT * FROM jobs WHERE status = 'pending' AND kind = ? ORDER BY run_at`).all(kind)
      : this.db.query(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY run_at`).all();
    return (rows as Row[]).map(rowToJob);
  }

  setStatus(id: string, status: Job['status'], error?: string): void {
    this.db.query('UPDATE jobs SET status = ?, last_error = ?, attempts = attempts + (CASE WHEN ? = \'running\' THEN 1 ELSE 0 END) WHERE id = ?').run(status, error ?? null, status, id);
  }

  reschedule(id: string, runAt: number, error?: string): void {
    this.db.query(`UPDATE jobs SET status = 'pending', run_at = ?, last_error = ? WHERE id = ?`).run(runAt, error ?? null, id);
  }

  cancel(dedupeKey: string): void {
    this.db.query(`UPDATE jobs SET status='cancelled' WHERE dedupe_key = ? AND status = 'pending'`).run(dedupeKey);
  }
}

function rowToJob(r: Row): Job {
  return {
    id: r.id,
    kind: r.kind,
    runAt: r.run_at,
    payload: json(r.payload, {}),
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error ?? undefined,
    dedupeKey: r.dedupe_key ?? undefined,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Tool outputs (full text of truncated tool results), kv
// ---------------------------------------------------------------------------

export class ToolOutputRepo {
  constructor(private db: Db) {}

  save(sessionId: string | undefined, tool: string, content: string): string {
    const id = newId('out');
    this.db.query('INSERT INTO tool_outputs (id, session_id, tool, content, created_at) VALUES (?,?,?,?,?)').run(id, sessionId ?? null, tool, content, Date.now());
    return id;
  }

  get(id: string): { id: string; tool: string; content: string; sessionId?: string } | undefined {
    const r = this.db.query('SELECT id, tool, content, session_id FROM tool_outputs WHERE id = ?').get(id) as Row | null;
    return r ? { id: r.id, tool: r.tool, content: r.content, ...(r.session_id ? { sessionId: r.session_id } : {}) } : undefined;
  }

  /**
   * Retention: delete outputs older than `before` unless their session is
   * pinned, and every output whose session was deleted. Returns how many rows went.
   */
  prune(before: number): number {
    return this.db
      .query(
        `DELETE FROM tool_outputs WHERE
           (session_id IS NOT NULL AND session_id NOT IN (SELECT id FROM sessions))
           OR (created_at < ? AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE pinned = 1)))`,
      )
      .run(before).changes;
  }
}

export class KvRepo {
  constructor(private db: Db) {}

  get<T>(key: string, fallback: T): T {
    const r = this.db.query('SELECT value FROM kv WHERE key = ?').get(key) as Row | null;
    return r ? json<T>(r.value, fallback) : fallback;
  }

  set(key: string, value: unknown): void {
    this.db
      .query('INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }

  delete(key: string): void {
    this.db.query('DELETE FROM kv WHERE key = ?').run(key);
  }

  /** The keys that start with a prefix. */
  keys(prefix: string): string[] {
    return (this.db.query('SELECT key FROM kv WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as Row[]).map((r) => r.key as string);
  }
}

// ---------------------------------------------------------------------------
// Devices, pairing, audit, checkpoints, gateway keys
// ---------------------------------------------------------------------------

export class DeviceRepo {
  constructor(private db: Db) {}

  insert(d: { id: string; name: string; tokenHash: string; roots?: string[]; accountId?: string }): void {
    this.db
      .query('INSERT INTO devices (id, name, token_hash, roots, created_at, account_id) VALUES (?,?,?,?,?,?)')
      .run(d.id, d.name, d.tokenHash, JSON.stringify(d.roots ?? []), Date.now(), d.accountId ?? OWNER_ID);
  }

  /** Returns devices without online state (the device hub fills that in). With an account, only its devices. */
  list(accountId?: string): Device[] {
    const rows = accountId ? this.db.query('SELECT * FROM devices WHERE account_id = ? ORDER BY name').all(accountId) : this.db.query('SELECT * FROM devices ORDER BY name').all();
    return (rows as Row[]).map(rowToDevice);
  }

  /** The account a paired device belongs to ("local", the hub, is the owner's); undefined for an unknown id. */
  accountOf(id: string): string | undefined {
    if (id === 'local' || id === '') return OWNER_ID;
    const r = this.db.query('SELECT account_id FROM devices WHERE id = ?').get(id) as Row | null;
    return r ? (r.account_id ?? OWNER_ID) : undefined;
  }

  get(id: string): Device | undefined {
    const r = this.db.query('SELECT * FROM devices WHERE id = ?').get(id) as Row | null;
    return r ? rowToDevice(r) : undefined;
  }

  tokenHash(id: string): string | undefined {
    const r = this.db.query('SELECT token_hash FROM devices WHERE id = ?').get(id) as Row | null;
    return r?.token_hash;
  }

  seen(id: string, info?: MachineInfo): void {
    if (info) this.db.query('UPDATE devices SET last_seen_at = ?, info = ? WHERE id = ?').run(Date.now(), JSON.stringify(info), id);
    else this.db.query('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  update(id: string, patch: { name?: string; roots?: string[] }): void {
    if (patch.name !== undefined) this.db.query('UPDATE devices SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.roots !== undefined) this.db.query('UPDATE devices SET roots = ? WHERE id = ?').run(JSON.stringify(patch.roots), id);
  }

  delete(id: string): void {
    this.db.query('DELETE FROM devices WHERE id = ?').run(id);
  }

  createPairingCode(kind: 'device' | 'client', ttlMs = 10 * 60_000, accountId: string = OWNER_ID): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (const b of bytes) code += alphabet[b % alphabet.length];
    code = `${code.slice(0, 4)}-${code.slice(4)}`;
    this.db.query('INSERT INTO pairing_codes (code, kind, expires_at, account_id) VALUES (?,?,?,?)').run(code, kind, Date.now() + ttlMs, accountId);
    return code;
  }

  /** A code that is unused and not expired, without using it: its kind, account and expiry. */
  peekCode(code: string): { kind: 'device' | 'client'; accountId: string; expiresAt: number } | undefined {
    const r = this.db.query('SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?').get(code.trim().toUpperCase(), Date.now()) as Row | null;
    return r ? { kind: r.kind, accountId: r.account_id ?? OWNER_ID, expiresAt: r.expires_at } : undefined;
  }

  /** Consume a pairing code. Returns its kind when valid. */
  consumePairingCode(code: string): 'device' | 'client' | undefined {
    return this.consumeCode(code)?.kind;
  }

  /** Consume a pairing code: its kind and the account that made it (an app or device paired with it is that account's). */
  consumeCode(code: string): { kind: 'device' | 'client'; accountId: string } | undefined {
    const norm = code.trim().toUpperCase();
    const r = this.db.query('SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?').get(norm, Date.now()) as Row | null;
    if (!r) return undefined;
    this.db.query('UPDATE pairing_codes SET used = 1 WHERE code = ?').run(norm);
    return { kind: r.kind, accountId: r.account_id ?? OWNER_ID };
  }
}

function rowToDevice(r: Row): Device {
  return {
    id: r.id,
    accountId: r.account_id ?? OWNER_ID,
    name: r.name,
    online: false,
    lastSeenAt: r.last_seen_at ?? undefined,
    info: json(r.info, undefined),
    roots: json(r.roots, []),
    createdAt: r.created_at,
  };
}

export class AuditRepo {
  constructor(private db: Db) {}

  /** accountId: whose action it was; left out, the session's account, else the owner's. */
  add(e: Omit<AuditEntry, 'id' | 'ts'> & { accountId?: string }): AuditEntry {
    const { accountId, ...rest } = e;
    const entry: AuditEntry = { id: newId('aud'), ts: Date.now(), ...rest };
    const acct = accountId ?? (entry.sessionId ? ((this.db.query('SELECT account_id FROM sessions WHERE id = ?').get(entry.sessionId) as Row | null)?.account_id ?? OWNER_ID) : OWNER_ID);
    this.db
      .query('INSERT INTO audit (id, ts, session_id, device, actor, action, detail, account_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(entry.id, entry.ts, entry.sessionId ?? null, entry.device ?? null, entry.actor, entry.action, entry.detail.slice(0, 4000), acct);
    return entry;
  }

  /** With accountId, only that account's entries (a member's view); without, every entry (the owner's). */
  list(opts: { sessionId?: string; limit?: number; before?: number; accountId?: string } = {}): AuditEntry[] {
    const acct = opts.accountId ?? null;
    const rows = opts.sessionId
      ? this.db.query('SELECT * FROM audit WHERE session_id = ? AND ts < ? AND (? IS NULL OR account_id = ?) ORDER BY ts DESC LIMIT ?').all(opts.sessionId, opts.before ?? Number.MAX_SAFE_INTEGER, acct, acct, opts.limit ?? 200)
      : this.db.query('SELECT * FROM audit WHERE ts < ? AND (? IS NULL OR account_id = ?) ORDER BY ts DESC LIMIT ?').all(opts.before ?? Number.MAX_SAFE_INTEGER, acct, acct, opts.limit ?? 200);
    return (rows as Row[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      sessionId: r.session_id ?? undefined,
      device: r.device ?? undefined,
      actor: r.actor,
      action: r.action,
      detail: r.detail,
    }));
  }
}

export class CheckpointRepo {
  constructor(private db: Db) {}

  add(c: Checkpoint): void {
    this.db
      .query('INSERT INTO checkpoints (id, session_id, seq, commit_sha, files, created_at, device, root) VALUES (?,?,?,?,?,?,?,?)')
      .run(c.id, c.sessionId, c.seq, c.commit, c.files, c.createdAt, c.device ?? null, c.root ?? null);
  }

  private static toCheckpoint(r: Row): Checkpoint {
    // device and root (migration 5): where the checkpoint was taken, so it is restored only there
    return { id: r.id, sessionId: r.session_id, seq: r.seq, commit: r.commit_sha, files: r.files, createdAt: r.created_at, ...(r.device ? { device: r.device } : {}), ...(r.root ? { root: r.root } : {}) };
  }

  list(sessionId: string): Checkpoint[] {
    return (this.db.query('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY seq').all(sessionId) as Row[]).map((r) => CheckpointRepo.toCheckpoint(r));
  }

  get(id: string): Checkpoint | undefined {
    const r = this.db.query('SELECT * FROM checkpoints WHERE id = ?').get(id) as Row | null;
    return r ? CheckpointRepo.toCheckpoint(r) : undefined;
  }
}

export interface GatewayKey {
  id: string;
  name: string;
  prefix: string;
  device?: string;
  agent?: string;
  createdAt: number;
  lastUsedAt?: number;
  revoked: boolean;
}

export class GatewayKeyRepo {
  constructor(private db: Db) {}

  insert(k: GatewayKey & { keyHash: string }): void {
    this.db
      .query('INSERT INTO gateway_keys (id, name, key_hash, prefix, device, agent, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(k.id, k.name, k.keyHash, k.prefix, k.device ?? null, k.agent ?? null, k.createdAt);
  }

  findByHash(hash: string): GatewayKey | undefined {
    const r = this.db.query('SELECT * FROM gateway_keys WHERE key_hash = ? AND revoked = 0').get(hash) as Row | null;
    if (!r) return undefined;
    this.db.query('UPDATE gateway_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), r.id);
    return rowToKey(r);
  }

  list(): GatewayKey[] {
    return (this.db.query('SELECT * FROM gateway_keys ORDER BY created_at DESC').all() as Row[]).map(rowToKey);
  }

  revoke(id: string): void {
    this.db.query('UPDATE gateway_keys SET revoked = 1 WHERE id = ?').run(id);
  }
}

function rowToKey(r: Row): GatewayKey {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    device: r.device ?? undefined,
    agent: r.agent ?? undefined,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
    revoked: !!r.revoked,
  };
}

export interface ClientRecord {
  id: string;
  name: string;
  platform?: string;
  createdAt: number;
  lastSeenAt?: number;
  revoked: boolean;
}

export class ClientRepo {
  constructor(private db: Db) {}

  insert(c: { id: string; name: string; platform?: string; tokenHash: string }): void {
    this.db
      .query('INSERT INTO clients (id, name, platform, token_hash, created_at) VALUES (?,?,?,?,?)')
      .run(c.id, c.name, c.platform ?? null, c.tokenHash, Date.now());
  }

  findByHash(hash: string): ClientRecord | undefined {
    const r = this.db.query('SELECT * FROM clients WHERE token_hash = ? AND revoked = 0').get(hash) as Row | null;
    if (!r) return undefined;
    this.db.query('UPDATE clients SET last_seen_at = ? WHERE id = ?').run(Date.now(), r.id);
    return rowToClient(r);
  }

  list(): ClientRecord[] {
    return (this.db.query('SELECT * FROM clients WHERE revoked = 0 ORDER BY created_at DESC').all() as Row[]).map(rowToClient);
  }

  revoke(id: string): void {
    this.db.query('UPDATE clients SET revoked = 1 WHERE id = ?').run(id);
  }
}

function rowToClient(r: Row): ClientRecord {
  return { id: r.id, name: r.name, platform: r.platform ?? undefined, createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? undefined, revoked: !!r.revoked };
}

export class Repos {
  sessions: SessionRepo;
  messages: MessageRepo;
  tasks: TaskRepo;
  routines: RoutineRepo;
  usage: UsageRepo;
  turns: TurnRepo;
  approvals: ApprovalLogRepo;
  jobs: JobRepo;
  outputs: ToolOutputRepo;
  kv: KvRepo;
  devices: DeviceRepo;
  audit: AuditRepo;
  checkpoints: CheckpointRepo;
  gatewayKeys: GatewayKeyRepo;
  clients: ClientRepo;

  constructor(readonly db: Db) {
    this.clients = new ClientRepo(db);
    this.devices = new DeviceRepo(db);
    this.audit = new AuditRepo(db);
    this.checkpoints = new CheckpointRepo(db);
    this.gatewayKeys = new GatewayKeyRepo(db);
    this.sessions = new SessionRepo(db);
    this.messages = new MessageRepo(db);
    this.tasks = new TaskRepo(db);
    this.routines = new RoutineRepo(db);
    this.usage = new UsageRepo(db);
    this.turns = new TurnRepo(db);
    this.approvals = new ApprovalLogRepo(db);
    this.jobs = new JobRepo(db);
    this.outputs = new ToolOutputRepo(db);
    this.kv = new KvRepo(db);
  }
}
