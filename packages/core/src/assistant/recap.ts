/** Account-scoped deterministic Reflect recap. Reads hub SQLite tables only; never calls a model. */
import type { RecapDto, RecapMemory, RecapPeriod, RecapRank } from '../client/recap';
import { ACTIVE_SQL } from '../memory/store';
import { OWNER_ID } from '../people/context';
import type { Db } from '../storage/db';
import { addDays, atLocal, hubZone, localDate, localMinutes, validZone } from './time';

const STOP = new Set(['new', 'chat', 'session', 'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'your', 'about', 'what', 'when', 'where', 'have', 'just', 'make', 'work', 'test', 'tests', 'fix', 'add', 'update', 'code', 'file', 'files', 'run', 'task']);
const PERSON_TAGS = new Set(['person', 'people', 'entity:person', 'entity:people']);
const PREF_TAGS = new Set(['preference', 'preferences', 'kind:preference', 'like', 'likes', 'dislike', 'dislikes']);
type SessionRow = { id: string; title: string; cwd: string; kind: string | null; ts: number };
type MemoryRow = { id: string; content: string; tags: string; meta: string; created_at: number };

export function recapRange(period: RecapPeriod, now: number, timezone: string): { start: number; end: number; timezone: string } {
  const tz = validZone(timezone) ? timezone : hubZone();
  const today = localDate(now, tz);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const first = period === 'week' ? addDays(today, -((dow + 6) % 7))
    : period === 'month' ? `${today.slice(0, 7)}-01` : `${today.slice(0, 4)}-01-01`;
  return { start: atLocal(first, '00:00', tz), end: now + 1, timezone: tz };
}

export function buildRecap(db: Db, accountId = OWNER_ID, period: RecapPeriod = 'week', timezone = 'UTC', now = Date.now()): RecapDto {
  const { start, end, timezone: tz } = recapRange(period, now, timezone);
  const sessions = db.query<SessionRow, [number, number, string, number, number]>(
    `SELECT s.id, s.title, s.cwd, s.kind, MAX(COALESCE(m.created_at, s.created_at)) AS ts
     FROM sessions s LEFT JOIN messages m ON m.session_id = s.id AND m.created_at >= ? AND m.created_at < ?
     WHERE s.account_id = ? AND s.parent_id IS NULL
       AND ((s.created_at >= ? AND s.created_at < ?) OR m.id IS NOT NULL)
     GROUP BY s.id`,
  ).all(start, end, accountId, start, end);
  const chats = sessions.filter((s) => s.kind === 'chat').length;
  const codeSessions = sessions.length - chats;
  const workflows = hasTable(db, 'workflow_runs') ? db.query<{ c: number }, [string, string, number, number]>(
    `SELECT COUNT(*) AS c FROM workflow_runs w LEFT JOIN sessions s ON s.id = w.session_id
     WHERE (s.account_id = ? OR (w.session_id IS NULL AND ? = 'owner'))
       AND w.created_at >= ? AND w.created_at < ?`,
  ).get(accountId, accountId, start, end)?.c ?? 0 : 0;

  const models = db.query<RecapRank & { tokens: number; costUsd: number }, [string, number, number]>(
    `SELECT CASE WHEN provider != '' AND instr(model, '/') = 0 THEN provider || '/' || model ELSE model END AS name,
            COUNT(*) AS count,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
            ROUND(COALESCE(SUM(cost_usd), 0), 4) AS costUsd
     FROM usage WHERE account_id = ? AND ts >= ? AND ts < ? AND model != ''
     GROUP BY name ORDER BY tokens DESC, count DESC, name ASC LIMIT 8`,
  ).all(accountId, start, end);
  const usageTotals = db.query<{ tokens: number; costUsd: number; models: number }, [string, number, number]>(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
            ROUND(COALESCE(SUM(cost_usd), 0), 4) AS costUsd,
            COUNT(DISTINCT CASE WHEN provider != '' AND instr(model, '/') = 0 THEN provider || '/' || model ELSE model END) AS models
     FROM usage WHERE account_id = ? AND ts >= ? AND ts < ? AND model != ''`,
  ).get(accountId, start, end) ?? { tokens: 0, costUsd: 0, models: 0 };

  const projects = rank(sessions.map((s) => s.cwd.trim()).filter(Boolean), 6);
  const topics = rank(sessions.flatMap((s) => words(s.title)), 8);
  const { people, preferences } = readMemories(db, accountId, start, end);
  const rhythm = buildRhythm(db, accountId, sessions, start, end, tz);
  const totals = { chats, sessions: codeSessions, workflows, ...usageTotals };
  return { period, start, end, timezone: tz, totals, models, projects, topics, people, preferences, rhythm, facts: buildFacts(totals, models, projects, people, preferences, rhythm) };
}

function readMemories(db: Db, accountId: string, start: number, end: number): { people: RecapMemory[]; preferences: RecapMemory[] } {
  const personIds = importedPersonIds(db, accountId);
  const rows = db.query<MemoryRow, [string, number]>(
    `SELECT id, content, tags, meta, created_at FROM memories m WHERE m.account_id = ? AND m.created_at < ? AND ${ACTIVE_SQL} ORDER BY created_at ASC`,
  ).all(accountId, end);
  const firstPerson = new Map<string, RecapMemory>();
  const preferences: RecapMemory[] = [];
  for (const r of rows) {
    const tags = parseTags(r.tags);
    const meta = parseMeta(r.meta);
    if (isPerson(r, tags, meta, personIds)) {
      const key = personKey(r.content);
      if (key && !firstPerson.has(key)) firstPerson.set(key, { id: r.id, content: r.content.trim(), firstSeen: r.created_at });
    }
    if (r.created_at >= start && (tags.some((t) => PREF_TAGS.has(t)) || meta.learnedKind === 'preference')) {
      preferences.push({ id: r.id, content: r.content.trim(), firstSeen: r.created_at });
    }
  }
  const people = [...firstPerson.values()].filter((p) => p.firstSeen >= start).slice(0, 12);
  return { people, preferences: preferences.reverse().slice(0, 12) };
}

function importedPersonIds(db: Db, accountId: string): Set<string> {
  const prefix = accountId === OWNER_ID ? 'memory.import.%' : `acct.${accountId}.memory.import.%`;
  const rows = db.query<{ value: string }, [string]>(`SELECT value FROM kv WHERE key LIKE ?`).all(prefix);
  const ids = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(parseMeta(row.value))) {
      const id = (v as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && /(?:^|\/)(?:people|person)(?:\/|$)/i.test(k)) ids.add(id);
    }
  }
  return ids;
}

function isPerson(row: MemoryRow, tags: string[], meta: Record<string, unknown>, importedIds: Set<string>): boolean {
  const path = typeof meta.path === 'string' ? meta.path : typeof meta.permalink === 'string' ? meta.permalink : '';
  return importedIds.has(row.id) || tags.some((t) => PERSON_TAGS.has(t)) || meta.entity === 'person' || /(?:^|\/)(?:people|person)(?:\/|$)/i.test(path);
}

function personKey(content: string): string {
  return (content.split(/[:\n—–-]/)[0] ?? content).trim().replace(/^#+\s*/, '').toLowerCase().slice(0, 80);
}

function buildRhythm(db: Db, accountId: string, sessions: SessionRow[], start: number, end: number, tz: string): RecapDto['rhythm'] {
  const msgs = db.query<{ ts: number; sid: string }, [string, number, number]>(
    `SELECT m.created_at AS ts, m.session_id AS sid FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE s.account_id = ? AND s.parent_id IS NULL AND m.role = 'user' AND m.created_at >= ? AND m.created_at < ?`,
  ).all(accountId, start, end);
  // Sessions with no user message in range still count once, at their latest activity.
  const withMsg = new Set(msgs.map((m) => m.sid));
  const stamps = [...msgs.map((m) => m.ts), ...sessions.filter((s) => !withMsg.has(s.id)).map((s) => s.ts)];
  const days = new Map<string, number>();
  const bands = new Map<string, number>();
  for (const ts of stamps) {
    const day = localDate(ts, tz);
    days.set(day, (days.get(day) ?? 0) + 1);
    const h = Math.floor(localMinutes(ts, tz) / 60);
    const band = h < 6 ? 'Night (00–05)' : h < 12 ? 'Morning (06–11)' : h < 18 ? 'Afternoon (12–17)' : 'Evening (18–23)';
    bands.set(band, (bands.get(band) ?? 0) + 1);
  }
  const sortedDays = [...days.keys()].sort();
  let longestStreak = 0, run = 0, prev = '';
  for (const d of sortedDays) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = d;
  }
  const busiestDay = topCount(days);
  const timeOfDay = topCount(bands);
  return { activeDays: sortedDays.length, longestStreak, ...(busiestDay ? { busiestDay } : {}), ...(timeOfDay ? { timeOfDay } : {}) };
}

function buildFacts(totals: RecapDto['totals'], models: RecapDto['models'], projects: RecapRank[], people: RecapMemory[], prefs: RecapMemory[], rhythm: RecapDto['rhythm']): string[] {
  const facts: string[] = [];
  if (rhythm.longestStreak > 1) facts.push(`${rhythm.longestStreak}-day active streak across ${rhythm.activeDays} active days.`);
  if (models[0]) facts.push(`Most-used model: ${models[0].name} (${models[0].tokens.toLocaleString('en-US')} tokens).`);
  if (projects[0]) facts.push(`Top workspace: ${projects[0].name} (${projects[0].count} ${projects[0].count === 1 ? 'session' : 'sessions'}).`);
  if (rhythm.timeOfDay) facts.push(`Peak hours: ${rhythm.timeOfDay.name}.`);
  if (people.length) facts.push(`${people.length} new ${people.length === 1 ? 'person' : 'people'} noted in memory.`);
  if (prefs.length) facts.push(`${prefs.length} preference ${prefs.length === 1 ? 'note' : 'notes'} saved.`);
  if (!facts.length && (totals.chats + totals.sessions + totals.workflows > 0)) facts.push(`${totals.chats + totals.sessions + totals.workflows} runs recorded.`);
  return facts.slice(0, 4);
}

function hasTable(db: Db, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}
function words(title: string): string[] {
  return [...new Set((title.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w) && !/^\d+$/.test(w)))];
}
function rank(items: string[], limit: number): RecapRank[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}
function topCount(counts: Map<string, number>): RecapRank | undefined {
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0];
}
function parseTags(raw: string): string[] {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []; } catch { return []; }
}
function parseMeta(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
