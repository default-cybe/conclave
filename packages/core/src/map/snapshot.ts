/**
 * The Map snapshot (docs/DESIGN.md 29): the hub, its devices, projects and
 * folders, and the chats, sessions, subagents and workflow runs of the last
 * 24 hours, each with its state, tools and usage.
 *
 * One builder serves both the live map and a replay. Live, a node's state
 * is the session's status and the engine's open approvals and questions,
 * and the event stream (MapLiveView) adds the tool running now and the
 * token rate. A replay at an earlier time reads only stored rows: turns say
 * when a session worked, approvals when it waited, messages which tools ran
 * and usage what it spent.
 */
import type { Db } from '../storage/db';
import type { Repos } from '../storage/repos';
import type { ApprovalRequest, Device, QuestionRequest, Session } from '../types';
import type { MapDevice, MapGroup, MapNode, MapNodeKind, MapSnapshot, MapState, MapTool, MapUsage } from '../client/map';
import { baseName, toolsFromRows, type ToolRow } from './tools';

export const MAP_WINDOW_MS = 24 * 3_600_000;
/** More than this and the oldest finished nodes are left out. */
export const MAP_MAX_NODES = 80;
export const MAP_RECENT_TOOLS = 5;
/** Messages read per session for its tools. */
const TOOL_MESSAGES = 24;
const DAY = 86_400_000;

/** What the event stream knows that the rows do not yet (map/live.ts). */
export interface MapLiveView {
  /** The tool running now. */
  current(sessionId: string): MapTool | undefined;
  /** Tools that finished since the hub started, newest first. */
  recent(sessionId: string): MapTool[];
  /** Output tokens per second now, and in the last minute. */
  rate(sessionId: string, now: number): { rate: number; perMin: number } | undefined;
}

export interface MapSource {
  repos: Repos;
  /** Whose map: one account's sessions, runs and devices (docs/design/ACCOUNTS.md). Default: the owner's. */
  accountId?: string;
  hubName: string;
  devices: Device[];
  /** Open approvals and questions (live only). */
  approvals?: ApprovalRequest[];
  questions?: QuestionRequest[];
  live?: MapLiveView;
  now?: number;
}

export interface MapBuildOptions {
  /** A replay at this time. Unset, or now or later: the live map. */
  at?: number;
  /** Date#getTimezoneOffset() of the client, for "today". */
  tz?: number;
}

type Row = Record<string, any>;

interface RunRow {
  id: string;
  name: string;
  session_id: string | null;
  host_session: number;
  device: string;
  cwd: string;
  status: string;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  resume_at: number | null;
}

interface CallRow {
  run_id: string;
  label: string | null;
  agent_type: string | null;
  model: string | null;
  state: string;
  child_session_id: string;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

const ZERO: MapUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

function hasTable(db: Db, name: string): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** Local midnight of `at` for a client whose getTimezoneOffset() is tz. */
export function dayStart(at: number, tz = 0): number {
  const shift = tz * 60_000;
  return Math.floor((at - shift) / DAY) * DAY + shift;
}

/** The state a session's status says. A finished subagent, workflow agent or routine run is done; a chat or a session between turns is idle. */
export function stateOfStatus(status: Session['status'], finishes: boolean): MapState {
  switch (status) {
    case 'running':
      return 'running';
    case 'waiting_approval':
    case 'waiting_input':
      return 'waiting';
    case 'waiting_reset':
      return 'paused';
    case 'error':
      return 'failed';
    default:
      return finishes ? 'done' : 'idle';
  }
}

/** A workflow run's state from its status. */
export function stateOfRun(status: string): MapState {
  if (status === 'running' || status === 'queued') return 'running';
  if (status === 'paused' || status === 'waiting_reset' || status === 'interrupted') return 'paused';
  if (status === 'failed' || status === 'budget') return 'failed';
  return 'done';
}

const LIMIT_OUTCOME = /limit|reset|quota|rate/i;

export function buildMapSnapshot(src: MapSource, opts: MapBuildOptions = {}): MapSnapshot {
  const now = src.now ?? Date.now();
  const from = now - MAP_WINDOW_MS;
  const live = opts.at === undefined || !Number.isFinite(opts.at) || opts.at >= now;
  const at = live ? now : Math.max(from, Math.floor(opts.at!));
  const since = at - MAP_WINDOW_MS;
  const db = src.repos.db;
  const acct = src.accountId ?? 'owner';
  const devices = new Map(src.devices.map((d) => [d.id, d]));

  // ----- workflow runs and the sessions their agents run in -------------------
  const runs: RunRow[] = hasTable(db, 'workflow_runs')
    ? (db
        .query(
          `SELECT id, name, session_id, host_session, device, cwd, status, error, input_tokens, output_tokens, cost_usd, created_at, started_at, finished_at, resume_at
           FROM workflow_runs WHERE created_at <= $at AND (finished_at IS NULL OR finished_at >= $since) AND session_id IN (SELECT id FROM sessions WHERE account_id = $acct) ORDER BY created_at DESC LIMIT 30`,
        )
        .all({ at, since, acct } as any) as RunRow[])
    : [];
  const calls: CallRow[] = runs.length
    ? (db
        .query(
          `SELECT run_id, label, agent_type, model, state, child_session_id, error, started_at, finished_at FROM workflow_calls
           WHERE kind = 'agent' AND child_session_id IS NOT NULL AND run_id IN (SELECT value FROM json_each($ids))`,
        )
        .all({ ids: JSON.stringify(runs.map((r) => r.id)) } as any) as CallRow[])
    : [];
  const callOf = new Map<string, CallRow>();
  for (const c of calls) callOf.set(c.child_session_id, c);
  const hosts = new Set(runs.filter((r) => r.host_session && r.session_id).map((r) => r.session_id!));

  // ----- sessions in the window ----------------------------------------------
  const idRows = db
    .query(`SELECT id FROM sessions WHERE account_id = $acct AND archived = 0 AND created_at <= $at AND updated_at >= $since ORDER BY updated_at DESC LIMIT 400`)
    .all({ at, since, acct } as any) as Row[];
  const all = new Map<string, Session>();
  for (const r of idRows) {
    const s = src.repos.sessions.get(r.id);
    if (s) all.set(s.id, s);
  }
  for (const c of calls) if (!all.has(c.child_session_id)) {
    const s = src.repos.sessions.get(c.child_session_id);
    if (s && s.createdAt <= at) all.set(s.id, s);
  }
  const ids = JSON.stringify([...all.keys()]);

  const activity = new Map<string, { first: number; last: number; lastAll: number }>();
  for (const r of db
    .query(
      `SELECT session_id, MIN(created_at) AS first, MAX(CASE WHEN created_at <= $at THEN created_at END) AS last, MAX(created_at) AS lastAll
       FROM messages WHERE session_id IN (SELECT value FROM json_each($ids)) GROUP BY session_id`,
    )
    .all({ at, ids } as any) as Row[])
    activity.set(r.session_id, { first: r.first, last: r.last ?? 0, lastAll: r.lastAll });

  const usage = new Map<string, MapUsage & { last: number; recent: number; recent5: number }>();
  for (const r of db
    .query(
      `SELECT session_id, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw, SUM(cost_usd) AS c, MAX(ts) AS last,
         SUM(CASE WHEN ts > $at - 60000 THEN output_tokens ELSE 0 END) AS recent,
         SUM(CASE WHEN ts > $at - 300000 THEN output_tokens ELSE 0 END) AS recent5
       FROM usage WHERE ts <= $at AND session_id IN (SELECT value FROM json_each($ids)) GROUP BY session_id`,
    )
    .all({ at, ids } as any) as Row[])
    usage.set(r.session_id, { inputTokens: r.i ?? 0, outputTokens: r.o ?? 0, cacheReadTokens: r.cr ?? 0, cacheWriteTokens: r.cw ?? 0, costUsd: r.c ?? 0, last: r.last ?? 0, recent: r.recent ?? 0, recent5: r.recent5 ?? 0 });

  const turns = new Map<string, { started: number; ended?: number; outcome?: string }>();
  for (const r of db
    .query(`SELECT session_id, started_at, ended_at, outcome FROM turns WHERE started_at <= $at AND session_id IN (SELECT value FROM json_each($ids)) ORDER BY started_at DESC`)
    .all({ at, ids } as any) as Row[])
    if (!turns.has(r.session_id)) turns.set(r.session_id, { started: r.started_at, ...(r.ended_at != null ? { ended: r.ended_at } : {}), ...(r.outcome ? { outcome: r.outcome } : {}) });

  // approvals open at `at`: from the engine when live, from the log in a replay
  const asking = new Map<string, 'approval' | 'question'>();
  if (live) {
    for (const q of src.questions ?? []) asking.set(q.sessionId, 'question');
    for (const a of src.approvals ?? []) asking.set(a.sessionId, 'approval');
  } else {
    for (const r of db
      .query(`SELECT session_id, requested_at FROM approvals WHERE requested_at <= $at AND requested_at >= $since AND (resolved_at IS NULL OR resolved_at > $at)`)
      .all({ at, since } as any) as Row[]) {
      // never answered (the hub stopped): it was open only until the session went on
      const act = activity.get(r.session_id);
      if (act && act.last > r.requested_at + 1000 && act.last <= at) continue;
      asking.set(r.session_id, 'approval');
    }
  }

  // ----- each session's node --------------------------------------------------
  const toolsQuery = db.query(
    `SELECT m.created_at AS at, json_extract(j.value, '$.type') AS type, json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.toolUseId') AS tuid,
       json_extract(j.value, '$.name') AS name, json_extract(j.value, '$.meta.durationMs') AS dur, json_extract(j.value, '$.isError') AS err,
       json_extract(j.value, '$.input.file_path') AS file_path, json_extract(j.value, '$.input.notebook_path') AS notebook_path,
       json_extract(j.value, '$.input.command') AS command, json_extract(j.value, '$.input.pattern') AS pattern, json_extract(j.value, '$.input.url') AS url,
       json_extract(j.value, '$.input.query') AS query, json_extract(j.value, '$.input.path') AS path, json_extract(j.value, '$.input.description') AS description,
       json_extract(j.value, '$.input.subagent_type') AS subagent_type, json_extract(j.value, '$.input.skill') AS skill
     FROM (SELECT created_at, seq, content FROM messages WHERE session_id = $sid AND created_at <= $at ORDER BY seq DESC LIMIT ${TOOL_MESSAGES}) m, json_each(m.content) j
     WHERE json_extract(j.value, '$.type') IN ('tool_use', 'tool_result') ORDER BY m.seq, j.key`,
  );
  const toolsOf = (sid: string) => {
    const rows = (toolsQuery.all({ sid, at } as any) as Row[]).map(
      (r): ToolRow =>
        r.type === 'tool_use'
          ? {
              at: r.at,
              type: 'tool_use',
              id: r.id,
              name: r.name,
              input: { file_path: r.file_path, notebook_path: r.notebook_path, command: r.command, pattern: r.pattern, url: r.url, query: r.query, path: r.path, description: r.description, subagent_type: r.subagent_type, skill: r.skill },
            }
          : { at: r.at, type: 'tool_result', id: r.tuid, ...(r.dur != null ? { durationMs: Number(r.dur) } : {}), ...(r.err ? { error: true } : {}) },
    );
    return toolsFromRows(rows);
  };

  const nodes = new Map<string, MapNode>();
  for (const s of all.values()) {
    if (hosts.has(s.id)) continue;
    const call = callOf.get(s.id);
    const act = activity.get(s.id);
    const turn = turns.get(s.id);
    const lastActivityAt = Math.max(act?.last ?? 0, usage.get(s.id)?.last ?? 0, turn?.started ?? 0, Math.min(s.createdAt, at), live ? Math.min(s.updatedAt, at) : 0);
    const kind: MapNodeKind = s.kind === 'chat' ? 'chat' : call ? 'agent' : s.parentId ? 'subagent' : 'session';
    const finishes = kind === 'agent' || kind === 'subagent' || !!s.routineId;
    const { done, open } = toolsOf(s.id);

    let state: MapState;
    let waitingOn = asking.get(s.id);
    let endedAt: number | undefined;
    if (live) {
      state = stateOfStatus(s.status, finishes);
      if (state === 'waiting' && !waitingOn && open?.name === 'AskUserQuestion') waitingOn = 'question';
    } else {
      let working = false;
      if (call?.started_at) working = call.started_at <= at && (call.finished_at == null || call.finished_at > at);
      else if (turn) {
        // a turn the hub never closed (it stopped) ended with the session's last word
        const open = s.status === 'running' || s.status === 'waiting_approval' || s.status === 'waiting_input';
        const end = turn.ended ?? (open ? undefined : (act?.lastAll ?? s.updatedAt));
        working = end === undefined || end > at;
      } else if (act) working = act.first <= at && act.lastAll > at;
      if (working) {
        state = 'running';
        if (!waitingOn && open?.name === 'AskUserQuestion') waitingOn = 'question';
        if (waitingOn) state = 'waiting';
      } else {
        waitingOn = undefined;
        const outcome = call ? (call.state === 'failed' ? 'error' : undefined) : turn?.outcome;
        state = outcome === 'error' ? 'failed' : outcome && LIMIT_OUTCOME.test(outcome) ? 'paused' : finishes ? 'done' : 'idle';
        endedAt = call?.finished_at ?? turn?.ended ?? (act?.last || undefined);
      }
    }
    if (state !== 'waiting') waitingOn = undefined;
    if (live && (state === 'done' || state === 'idle' || state === 'failed')) endedAt = turn?.ended ?? (act?.last || undefined);
    if (!live && lastActivityAt < since && state !== 'running' && state !== 'waiting') continue;
    if (live && lastActivityAt < since && (state === 'done' || state === 'idle')) continue;

    const busy = state === 'running' || state === 'waiting';
    let tool = busy ? open : undefined;
    let tools = done;
    const u = usage.get(s.id);
    let tokensPerMin = u ? (u.recent || Math.round(u.recent5 / 5)) : 0;
    let rate = state === 'running' ? tokensPerMin / 60 : 0;
    if (live && src.live) {
      const seen = src.live.current(s.id);
      if (busy && seen) tool = seen;
      const recent = src.live.recent(s.id);
      if (recent.length) {
        const byId = new Map<string, MapTool>();
        for (const t of [...tools, ...recent]) byId.set(t.id ?? `${t.name}@${t.startedAt}`, t);
        tools = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
      }
      const r = src.live.rate(s.id, now);
      if (r) {
        tokensPerMin = Math.max(tokensPerMin, Math.round(r.perMin));
        rate = state === 'running' ? r.rate : 0;
      }
    }
    if (tool) tools = tools.filter((t) => t.id !== tool!.id);

    nodes.set(s.id, {
      id: s.id,
      kind,
      title: (call?.label || s.title || '').trim() || (kind === 'chat' ? 'New chat' : 'Untitled'),
      state,
      ...(waitingOn ? { waitingOn } : {}),
      agent: call?.agent_type || s.agent,
      model: s.model,
      device: s.device || 'local',
      ...(kind !== 'chat' && s.cwd ? { cwd: s.cwd } : {}),
      group: '',
      ...(s.parentId ? { parentId: s.parentId } : {}),
      ...(call ? { runId: call.run_id } : {}),
      startedAt: Math.min(s.createdAt, at),
      lastActivityAt,
      ...(endedAt && !busy ? { endedAt } : {}),
      ...(tool ? { tool } : {}),
      tools: tools.slice(0, MAP_RECENT_TOOLS),
      usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: u.costUsd } : { ...ZERO },
      tokensPerMin,
      rate: Math.max(0, rate),
      ...(state === 'failed' && (s.error || call?.error) ? { error: (call?.error || s.error)! } : {}),
      ...(state === 'paused' && s.resumeAt && live ? { resumeAt: s.resumeAt } : {}),
    });
  }

  // ----- workflow runs ---------------------------------------------------------
  for (const run of runs) {
    const id = `wf:${run.id}`;
    const agents = [...nodes.values()].filter((n) => n.runId === run.id);
    let state: MapState;
    if (live) state = stateOfRun(run.status);
    else {
      const start = run.started_at ?? run.created_at;
      if (start > at) state = 'idle';
      else if (run.finished_at == null || run.finished_at > at) state = run.finished_at == null && stateOfRun(run.status) === 'paused' ? 'paused' : 'running';
      else state = stateOfRun(run.status);
    }
    if (state === 'running' && agents.some((a) => a.state === 'waiting')) state = 'running';
    const sum = agents.reduce<MapUsage>(
      (acc, a) => ({
        inputTokens: acc.inputTokens + a.usage.inputTokens,
        outputTokens: acc.outputTokens + a.usage.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + a.usage.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + a.usage.cacheWriteTokens,
        costUsd: acc.costUsd + a.usage.costUsd,
      }),
      { ...ZERO },
    );
    const usageOf: MapUsage = live ? { ...sum, inputTokens: Math.max(sum.inputTokens, run.input_tokens), outputTokens: Math.max(sum.outputTokens, run.output_tokens), costUsd: Math.max(sum.costUsd, run.cost_usd) } : sum;
    const parent = !run.host_session && run.session_id && nodes.has(run.session_id) ? run.session_id : undefined;
    const ended = run.finished_at != null && run.finished_at <= at ? run.finished_at : undefined;
    nodes.set(id, {
      id,
      kind: 'workflow',
      title: run.name,
      state,
      agent: 'workflow',
      device: run.device || 'local',
      cwd: run.cwd,
      group: '',
      ...(parent ? { parentId: parent } : {}),
      runId: run.id,
      startedAt: run.started_at ?? run.created_at,
      lastActivityAt: Math.max(run.started_at ?? run.created_at, ended ?? 0, ...agents.map((a) => a.lastActivityAt)),
      ...(ended && state !== 'running' ? { endedAt: ended } : {}),
      tools: [],
      usage: usageOf,
      tokensPerMin: agents.reduce((n, a) => n + a.tokensPerMin, 0),
      rate: 0,
      ...(state === 'failed' && run.error ? { error: run.error } : {}),
      ...(state === 'paused' && run.resume_at && live ? { resumeAt: run.resume_at } : {}),
    });
    // a run's agents hang off the run, not the session that started it
    for (const a of agents) a.parentId = id;
  }

  // a parent that is not on the map: the node stands on its own
  for (const n of nodes.values()) if (n.parentId && !nodes.has(n.parentId)) delete n.parentId;

  // ----- keep it readable: every live node and what it hangs off, then the most recent ----
  let kept = [...nodes.values()];
  if (kept.length > MAP_MAX_NODES) {
    const keep = new Set<string>();
    const add = (n: MapNode | undefined) => {
      for (let x = n; x && !keep.has(x.id); x = x.parentId ? nodes.get(x.parentId) : undefined) keep.add(x.id);
    };
    const busy = (n: MapNode) => n.state === 'running' || n.state === 'waiting' || n.state === 'paused';
    for (const n of kept) if (busy(n)) add(n);
    for (const n of [...kept].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
      if (keep.size >= MAP_MAX_NODES) break;
      add(n);
    }
    kept = kept.filter((n) => keep.has(n.id));
  }

  // ----- groups: projects, folders and the chats ------------------------------------
  const projectNames = new Map<string, string>();
  const projectIds = [...new Set([...all.values()].map((s) => s.projectId).filter((x): x is string => !!x))];
  if (projectIds.length && hasTable(db, 'projects'))
    for (const r of db.query(`SELECT id, name FROM projects WHERE id IN (SELECT value FROM json_each($ids))`).all({ ids: JSON.stringify(projectIds) } as any) as Row[]) projectNames.set(r.id, r.name);

  const groups = new Map<string, MapGroup>();
  const groupFor = (device: string, cwd: string | undefined, projectId: string | undefined, chat: boolean): string => {
    if (chat) {
      if (!groups.has('chats')) groups.set('chats', { id: 'chats', kind: 'chats', name: 'Chats', device: 'local' });
      return 'chats';
    }
    if (projectId) {
      const id = `p:${projectId}@${device}`;
      if (!groups.has(id)) groups.set(id, { id, kind: 'project', name: projectNames.get(projectId) ?? baseName(cwd ?? projectId), device, projectId, ...(cwd ? { path: cwd } : {}) });
      return id;
    }
    const path = (cwd || '~').replace(/[\\/]+$/, '') || '/';
    const id = `f:${device}:${path}`;
    if (!groups.has(id)) {
      const home = devices.get(device)?.info?.home?.replace(/[\\/]+$/, '');
      const name = path === '~' || (home && path === home) ? 'Home folder' : baseName(path);
      groups.set(id, { id, kind: 'folder', name, device, path });
    }
    return id;
  };
  const byId = new Map(kept.map((n) => [n.id, n]));
  const top = (n: MapNode): MapNode => {
    let x = n;
    for (let i = 0; x.parentId && byId.has(x.parentId) && i < 32; i++) x = byId.get(x.parentId)!;
    return x;
  };
  for (const n of kept) {
    const t = top(n);
    const s = all.get(t.id) ?? (t.runId ? all.get(runs.find((r) => r.id === t.runId)?.session_id ?? '') : undefined);
    n.group = groupFor(t.device, t.cwd, s?.projectId, t.kind === 'chat');
  }

  // ----- devices, totals, the hub ---------------------------------------------------
  const mapDevices: MapDevice[] = src.devices.map((d) => ({ id: d.id, name: d.name, ...(live ? { online: d.online } : {}) }));
  for (const g of groups.values()) if (!mapDevices.some((d) => d.id === g.device)) mapDevices.push({ id: g.device, name: g.device });

  const counted = kept.filter((n) => n.kind !== 'workflow');
  const running = counted.filter((n) => n.state === 'running').length;
  const waiting = counted.filter((n) => n.state === 'waiting').length;
  const start = dayStart(at, opts.tz ?? 0);
  // the account's own usage only: a member's Map never adds up the owner's tokens and cost (docs/design/ACCOUNTS.md 2)
  const today = db.query(`SELECT SUM(input_tokens + output_tokens) AS t, SUM(cost_usd) AS c FROM usage WHERE ts >= ? AND ts <= ? AND account_id = ?`).get(start, at, acct) as Row | null;

  kept.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  return {
    at,
    live,
    from,
    hub: { name: src.hubName, state: waiting ? 'waiting' : running ? 'running' : 'idle' },
    devices: mapDevices,
    groups: [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    nodes: kept,
    totals: { running, waiting, today: { from: start, tokens: today?.t ?? 0, costUsd: today?.c ?? 0 } },
  };
}

