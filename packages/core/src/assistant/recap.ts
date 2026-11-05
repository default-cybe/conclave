/**
 * Reflect's report (docs/ASSISTANT.md, Reflect): the numbers for one account
 * and range from the hub's SQLite tables, the habits and suggestions the
 * numbers alone support, and the compact material (session titles and
 * summaries, never transcripts, mail, files or tool output) that the model
 * pass in service.ts reads. Every query is scoped to the account.
 *
 * Left out everywhere: incognito sessions (session/incognito.ts),
 * sessions whose title or summary is about health, and the subagent sessions
 * under either. Routine and subagent sessions do not count as your messages.
 */
import type { ReflectHabit, ReflectNamed, ReflectRange, ReflectReport } from '../client/recap';
import { ACTIVE_SQL } from '../memory/store';
import { OWNER_ID } from '../people/context';
import { accountKey } from '../people/store';
import type { Db } from '../storage/db';
import { addDays, atLocal, hubZone, localDate, localMinutes, validZone } from './time';

const PERSON_TAGS = new Set(['person', 'people', 'entity:person', 'entity:people']);
const STOP = new Set(['new', 'chat', 'session', 'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'your', 'about', 'what', 'when', 'where', 'have', 'just', 'make', 'work', 'test', 'tests', 'fix', 'add', 'update', 'code', 'file', 'files', 'run', 'task', 'review', 'check']);
/** Health topics by title or summary. "health check" and the like are about services, not people. */
export const HEALTH = /\b(?:health(?!\s*-?(?:checks?|z|endpoints?|status|monitor\w*|probes?)\b)\w*|medical|medicine|medication\w*|doctors?|clinic\w*|hospital\w*|therap\w*|mental health|depress\w*|anxiety|prescription\w*|dentist\w*|dental|skin\s?care|skincare|acne|diet\w*|calories?|nutrition\w*|insomnia|injur\w*|allerg\w*|pregnan\w*|weight loss|workouts?|fitness)\b/i;
/** A message that corrects the agent: "no, ...", "actually ...", "don't ...", "that's wrong". */
const CORRECTION = /^\s*(?:no\b[,.!\s]|nope\b|actually\b|wrong\b|that'?s (?:not|wrong)|not what i|don'?t\b|do not\b|stop\b|instead\b|undo\b|revert\b|why did you\b|i said\b)/i;
const LATE = (h: number) => h >= 23 || h < 5;
/**
 * A message the person typed: user role, a text block first (tool results are user rows too), no reminder, not sent by the hub,
 * and not another person's words in a shared chat (sender is missing for the session owner). Needs sessions as `s`.
 */
export const TYPED = `m.role = 'user' AND m.kind = 'normal' AND json_valid(m.content) AND json_extract(m.content, '$[0].type') = 'text'
  AND substr(json_extract(m.content, '$[0].text'), 1, 17) != '<system-reminder>' AND (m.meta IS NULL OR json_extract(m.meta, '$.auto') IS NULL)
  AND (m.sender IS NULL OR m.sender = 'account:' || s.account_id)`;

type SessionRow = { id: string; title: string; agent: string; cwd: string; kind: string | null; parent: string | null; project: string | null; routine: string | null; created: number; userMsgs: number; incognito: number };
type MsgRow = { ts: number; sid: string; head: string | null; len: number | null };

export interface ReportOptions {
  /** The account's learned skills (name and created day), from its own store. */
  learnedSkills?: Array<{ name: string; created: string }>;
  /** True for an agent that reads mail or web pages: its session summaries never reach the model. */
  untrustedAgent?: (name: string, cwd?: string) => boolean;
}

/** Rolling ranges that end now and start at local midnight: 7 days, 30 days, or 3, 6 or 12 months back. */
export function reflectRange(range: ReflectRange, now: number, timezone: string): { start: number; end: number; timezone: string } {
  const tz = validZone(timezone) ? timezone : hubZone();
  const today = localDate(now, tz);
  let first: string;
  if (range === 'week') first = addDays(today, -6);
  else if (range === 'month') first = addDays(today, -29);
  else {
    const months = range === '3m' ? 3 : range === '6m' ? 6 : 12;
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const back = new Date(Date.UTC(y, m - 1 - months, 1));
    const last = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() + 1, 0)).getUTCDate();
    first = addDays(`${back.toISOString().slice(0, 7)}-${String(Math.min(d, last)).padStart(2, '0')}`, 1);
  }
  return { start: atLocal(first, '00:00', tz), end: now + 1, timezone: tz };
}

export const RANGE_WORDS: Record<ReflectRange, string> = { week: 'The last 7 days', month: 'The last 30 days', '3m': 'The last 3 months', '6m': 'The last 6 months', '12m': 'The last 12 months' };

/** The report from the numbers alone, plus the material the model pass reads. */
export function buildReport(db: Db, accountId = OWNER_ID, range: ReflectRange = 'week', timezone = 'UTC', now = Date.now(), opts: ReportOptions = {}): { report: ReflectReport; material: string } {
  const { start, end, timezone: tz } = reflectRange(range, now, timezone);
  const all = db.query<SessionRow, [number, number, string, number, number, number, number]>(
    `SELECT s.id, s.title, s.agent, s.cwd, s.kind, s.parent_id AS parent, COALESCE(s.project_id, json_extract(s.meta, '$.projectId')) AS project, s.routine_id AS routine, s.created_at AS created,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND ${TYPED} AND m.created_at >= ? AND m.created_at < ?) AS userMsgs,
            COALESCE(s.incognito, 0) AS incognito
     FROM sessions s
     WHERE s.account_id = ?
       AND ((s.created_at >= ? AND s.created_at < ?) OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ?))`,
  ).all(start, end, accountId, start, end, start, end);
  const summaries = episodeSummaries(db, accountId, all.map((s) => s.id));

  // what is left out: incognito, health by topic, and the subagents under either
  const incognito = new Set(all.filter((s) => s.incognito).map((s) => s.id));
  const health = new Set(all.filter((s) => !s.parent && !incognito.has(s.id) && HEALTH.test(`${s.title}\n${summaries.get(s.id) ?? ''}`)).map((s) => s.id));
  const out = new Set([...incognito, ...health]);
  for (const s of all) if (s.parent && out.has(s.parent)) out.add(s.id);
  const outJson = JSON.stringify([...out]);
  const sessions = all.filter((s) => !out.has(s.id));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const roots = sessions.filter((s) => !s.parent);
  const human = roots.filter((s) => !s.routine);
  const children = sessions.filter((s) => s.parent);

  // your messages: root sessions you typed in, not routines or subagents
  const humanIds = new Set(human.map((s) => s.id));
  const msgs = db.query<MsgRow, [string, number, number]>(
    `SELECT m.created_at AS ts, m.session_id AS sid,
            substr(json_extract(m.content, '$[0].text'), 1, 160) AS head, length(json_extract(m.content, '$[0].text')) AS len
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE s.account_id = ? AND ${TYPED} AND m.created_at >= ? AND m.created_at < ?
     ORDER BY m.created_at ASC`,
  ).all(accountId, start, end).filter((m) => humanIds.has(m.sid));
  const rhythm = buildRhythm(msgs, tz);

  // usage, models, cost
  const notOut = `(session_id IS NULL OR session_id NOT IN (SELECT value FROM json_each(?)))`;
  const models = db.query<{ name: string; calls: number; tokens: number; costUsd: number }, [string, number, number, string]>(
    `SELECT CASE WHEN provider != '' AND instr(model, '/') = 0 THEN provider || '/' || model ELSE model END AS name, COUNT(*) AS calls,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens, ROUND(COALESCE(SUM(cost_usd), 0), 4) AS costUsd
     FROM usage WHERE account_id = ? AND ts >= ? AND ts < ? AND model != '' AND ${notOut}
     GROUP BY name ORDER BY tokens DESC, calls DESC, name ASC`,
  ).all(accountId, start, end, outJson);
  const tokens = models.reduce((a, m) => a + m.tokens, 0);
  const costUsd = Math.round(models.reduce((a, m) => a + m.costUsd, 0) * 100) / 100;

  // workflows
  const workflows = hasTable(db, 'workflow_runs')
    ? db
        .query<{ id: string; name: string; agents: number; costUsd: number; sid: string | null }, [string, string, number, number]>(
          `SELECT w.id, w.name, COALESCE(w.agent_count, 0) AS agents, COALESCE(w.cost_usd, 0) AS costUsd, w.session_id AS sid FROM workflow_runs w LEFT JOIN sessions s ON s.id = w.session_id
           WHERE (s.account_id = ? OR (w.session_id IS NULL AND ? = 'owner')) AND w.created_at >= ? AND w.created_at < ?`,
        )
        .all(accountId, accountId, start, end)
        .filter((w) => !w.sid || !out.has(w.sid))
    : [];

  // projects: the project's name, else the folder
  const projectNames = new Map(hasTable(db, 'projects') ? db.query<{ id: string; name: string }, [string]>(`SELECT id, name FROM projects WHERE account_id = ?`).all(accountId).map((p) => [p.id, p.name]) : []);
  const projectOf = (s: SessionRow) => (s.project && projectNames.get(s.project)) || folder(s.cwd);
  const projGroups = new Map<string, SessionRow[]>();
  for (const s of human) {
    const p = projectOf(s);
    if (p) projGroups.set(p, [...(projGroups.get(p) ?? []), s]);
  }
  const projects = [...projGroups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const firstSeen = (s: SessionRow) =>
    (s.project
      ? db.query<{ t: number | null }, [string, string]>(`SELECT MIN(created_at) AS t FROM sessions WHERE account_id = ? AND project_id = ?`).get(accountId, s.project)?.t
      : db.query<{ t: number | null }, [string, string]>(`SELECT MIN(created_at) AS t FROM sessions WHERE account_id = ? AND cwd = ?`).get(accountId, s.cwd)?.t) ?? 0;
  const newThisPeriod = projects.filter(([, l]) => firstSeen(l[0]!) >= start).map(([name]) => name).slice(0, 6);

  // signals for the four habits
  const corrections = new Map<string, number>();
  for (const m of msgs) if (m.head && CORRECTION.test(m.head)) corrections.set(m.sid, (corrections.get(m.sid) ?? 0) + 1);
  const correctionCount = [...corrections.values()].reduce((a, b) => a + b, 0);
  const firsts = new Map<string, MsgRow>();
  for (const m of msgs) if (!firsts.has(m.sid)) firsts.set(m.sid, m);
  const approvals = countBy(
    db
      .query<{ k: string; c: number }, [string, number, number, string]>(
        `SELECT a.decision AS k, COUNT(*) AS c FROM approvals a JOIN sessions s ON s.id = a.session_id WHERE s.account_id = ? AND a.requested_at >= ? AND a.requested_at < ? AND a.session_id NOT IN (SELECT value FROM json_each(?)) GROUP BY a.decision`,
      )
      .all(accountId, start, end, outJson),
  );
  const drafts = hasTable(db, 'pim_proposals')
    ? countBy(db.query<{ k: string; c: number }, [string, number, number]>(`SELECT status AS k, COUNT(*) AS c FROM pim_proposals WHERE account_id = ? AND decided_at >= ? AND decided_at < ? GROUP BY status`).all(accountId, start, end))
    : {};
  const turns = countBy(
    db
      .query<{ k: string; c: number }, [string, number, number, string]>(
        `SELECT COALESCE(t.outcome, '') AS k, COUNT(*) AS c FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.account_id = ? AND t.started_at >= ? AND t.started_at < ? AND t.session_id NOT IN (SELECT value FROM json_each(?)) GROUP BY k`,
      )
      .all(accountId, start, end, outJson),
  );
  const notices = db
    .query<{ text: string | null }, [string, number, number, string]>(
      `SELECT substr(CASE WHEN json_valid(m.content) THEN json_extract(m.content, '$[0].text') ELSE m.content END, 1, 200) AS text
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.account_id = ? AND m.kind = 'notice' AND m.created_at >= ? AND m.created_at < ? AND m.session_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .all(accountId, start, end, outJson);
  const fallbackPairs = new Map<string, number>();
  let fallbacks = 0;
  let switches = 0;
  let checkFails = 0;
  for (const { text } of notices) {
    if (!text) continue;
    const fb = /^(\S+).*? hit its limit\. (?:Falling back to|Continuing on) (\S+?)(?: for this turn)?\.?(?:\s|$)/.exec(text);
    if (fb) {
      fallbacks++;
      const pair = `${fb[1]} to ${fb[2]}`;
      fallbackPairs.set(pair, (fallbackPairs.get(pair) ?? 0) + 1);
    } else if (/declined\. Answered by/.test(text)) fallbacks++;
    else if (/^Switched from /.test(text)) switches++;
    else if (/^The check `.*` still fails/.test(text)) checkFails++;
  }
  const reviewSessions = sessions.filter((s) => /review|verif|audit/i.test(s.agent));
  const reviewRuns = workflows.filter((w) => /review|verif|audit/i.test(w.name));

  // fun
  const tools = db
    .query<{ name: string; count: number }, [string, number, number, string]>(
      `SELECT json_extract(j.value, '$.name') AS name, COUNT(*) AS count
       FROM messages m JOIN sessions s ON s.id = m.session_id, json_each(m.content) j
       WHERE s.account_id = ? AND m.role = 'assistant' AND m.created_at >= ? AND m.created_at < ? AND m.content LIKE '%tool_use%' AND json_valid(m.content)
         AND json_extract(j.value, '$.type') = 'tool_use' AND m.session_id NOT IN (SELECT value FROM json_each(?))
       GROUP BY name ORDER BY count DESC LIMIT 1`,
    )
    .all(accountId, start, end, outJson);
  const longest = [...human].sort((a, b) => b.userMsgs - a.userMsgs)[0];
  const biggest = [...workflows].sort((a, b) => b.agents - a.agents || b.costUsd - a.costUsd)[0];
  const memRows = db
    .query<{ id: string; content: string; tags: string; meta: string | null; created_at: number; src: string | null; kind: string }, [string, number]>(
      `SELECT id, content, tags, meta, created_at, source_session_id AS src, kind FROM memories m WHERE m.account_id = ? AND m.created_at < ? AND ${ACTIVE_SQL} ORDER BY created_at ASC`,
    )
    .all(accountId, end)
    .filter((m) => !m.src || !out.has(m.src));
  const newPeople = readPeople(db, accountId, memRows, start);
  const memoriesAdded = memRows.filter((m) => m.created_at >= start && m.kind !== 'episode').length;
  const firstDay = localDate(start, tz);
  const skillsLearned = (opts.learnedSkills ?? []).filter((s) => s.created >= firstDay).map((s) => s.name).slice(0, 8);
  const goalsMoved = hasTable(db, 'goal_entries')
    ? (db.query<{ c: number }, [string, number, number]>(`SELECT COUNT(*) AS c FROM goal_entries e JOIN goals g ON g.id = e.goal_id WHERE g.account_id = ? AND e.created_at >= ? AND e.created_at < ?`).get(accountId, start, end)?.c ?? 0)
    : 0;
  const goalsDone = hasTable(db, 'goals') ? (db.query<{ c: number }, [string, number, number]>(`SELECT COUNT(*) AS c FROM goals WHERE account_id = ? AND completed_at >= ? AND completed_at < ?`).get(accountId, start, end)?.c ?? 0) : 0;

  const agents = rank(sessions.map((s) => s.agent), 6);
  const finishedTurns = turns.done ?? 0;
  const topFallback = topOf(fallbackPairs);
  const chats = roots.filter((s) => s.kind === 'chat').length;
  const totals = { chats, sessions: roots.length - chats, workflows: workflows.length, hoursActive: rhythm.hoursActive, tokens, costUsd, projects: projGroups.size };

  // repeated openers: the same first six words in 3 or more sessions
  const openers = new Map<string, SessionRow[]>();
  for (const s of human) {
    const f = firsts.get(s.id)?.head;
    const key = f ? f.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ') : '';
    if (key.split(' ').length >= 3) openers.set(key, [...(openers.get(key) ?? []), s]);
  }
  const repeat = [...openers.values()].filter((l) => l.length >= 3).sort((a, b) => b.length - a.length)[0];
  const unprojected = human.filter((s) => s.kind === 'chat' && !s.project).length;

  const habits = buildHabits({ children, workflows, human, firsts, corrections, correctionCount, byId, denied: approvals.deny ?? 0, declined: drafts.declined ?? 0, aborted: turns.aborted ?? 0, checkFails, reviewSessions, reviewRuns: reviewRuns.length });

  const report: ReflectReport = {
    range,
    start,
    end,
    timezone: tz,
    generatedAt: now,
    insights: 'basic',
    headline: basicHeadline(range, totals, rhythm.activeDays, projects[0]?.[0]),
    totals,
    work: {
      topics: rank(human.flatMap((s) => words(s.title)), 6)
        .filter((t) => t.count > 1)
        .map((t) => ({ name: t.name, example: human.find((s) => words(s.title).includes(t.name))?.title ?? '' })),
      projects: projects.slice(0, 6).map(([name, l]) => ({ name, sessions: l.length, example: [...l].sort((a, b) => b.created - a.created)[0]!.title })),
      newThisPeriod,
    },
    rhythm: { heatmap: rhythm.heatmap, messages: msgs.length, activeDays: rhythm.activeDays, longestStreak: rhythm.longestStreak, ...(rhythm.busiestDay ? { busiestDay: rhythm.busiestDay } : {}), lateNightShare: rhythm.lateNightShare },
    habits,
    models: {
      models: models.slice(0, 6),
      agents,
      fallbacks,
      ...(topFallback ? { topFallback: topFallback.name } : {}),
      switches,
      finishedTurns,
      ...(costUsd > 0 && finishedTurns > 0 ? { costPerResult: Math.round((costUsd / finishedTurns) * 1000) / 1000 } : {}),
    },
    fun: {
      ...(tools[0]?.name ? { topTool: tools[0] } : {}),
      ...(longest && longest.userMsgs > 1 ? { longestChat: { title: longest.title, messages: longest.userMsgs, sessionId: longest.id } } : {}),
      ...(biggest ? { biggestWorkflow: { name: biggest.name, agents: biggest.agents, costUsd: Math.round(biggest.costUsd * 100) / 100 } } : {}),
      newPeople,
      memoriesAdded,
      skillsLearned,
      goalsMoved,
      goalsDone,
    },
    suggestions: basicSuggestions({ repeat, unprojected, lateNightShare: rhythm.lateNightShare, messages: msgs.length, fallbacks, corrections: correctionCount }),
    question: basicQuestion(children.length + workflows.length, roots.length, rhythm.lateNightShare),
    excluded: { health: health.size, incognito: all.filter((s) => s.incognito && !s.parent).length },
  };

  const signals = {
    corrections: correctionCount,
    mostCorrected: topSession(corrections, byId),
    deniedToolRequests: approvals.deny ?? 0,
    allowedToolRequests: approvals.allow ?? 0,
    draftsApplied: drafts.applied ?? 0,
    draftsDeclined: drafts.declined ?? 0,
    turnsStopped: turns.aborted ?? 0,
    turnsFinished: finishedTurns,
    codeCheckStillFailing: checkFails,
    reviewSessions: reviewSessions.length,
    reviewWorkflows: reviewRuns.length,
    subagentTasks: children.length,
    workflows: workflows.length,
    modelFallbacks: fallbacks,
    modelSwitches: switches,
    repeatedOpener: repeat ? { times: repeat.length, example: repeat[0]!.title } : undefined,
    chatsWithoutProject: unprojected,
    lateNightShare: rhythm.lateNightShare,
  };
  return { report, material: material(range, report, signals, human, summaries, opts.untrustedAgent) };
}

/** The text the model reads: numbers and signals, then one line per session with its title and summary. */
function material(range: ReflectRange, r: ReflectReport, signals: object, human: SessionRow[], summaries: Map<string, string>, untrusted?: ReportOptions['untrustedAgent']): string {
  const head = [
    `Period: ${RANGE_WORDS[range].toLowerCase()}, ${new Date(r.start).toISOString().slice(0, 10)} to ${new Date(r.end).toISOString().slice(0, 10)}.`,
    `Numbers: ${JSON.stringify({ totals: r.totals, projects: r.work.projects.map((p) => ({ name: p.name, sessions: p.sessions })), newProjects: r.work.newThisPeriod, activeDays: r.rhythm.activeDays, longestStreak: r.rhythm.longestStreak, models: r.models.models.slice(0, 4).map((m) => m.name), agents: r.models.agents })}`,
    `Signals: ${JSON.stringify(signals)}`,
    'Sessions (title | agent | folder | day | summary):',
  ].join('\n');
  const lines: string[] = [];
  let size = head.length;
  for (const s of [...human].sort((a, b) => b.userMsgs - a.userMsgs).slice(0, 80)) {
    // a mail or web reading agent's summary can carry what it read: its title only
    const sum = untrusted?.(s.agent, s.cwd) ? '' : (summaries.get(s.id) ?? '').replace(/\s+/g, ' ').slice(0, 220);
    const line = `- ${s.title.slice(0, 100)} | ${s.agent} | ${folder(s.cwd)} | ${new Date(s.created).toISOString().slice(0, 10)}${sum ? ` | ${sum}` : ''}`;
    if (size + line.length > 14_000) break;
    size += line.length + 1;
    lines.push(line);
  }
  return `${head}\n${lines.join('\n')}`;
}

function buildRhythm(msgs: MsgRow[], tz: string) {
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const days = new Map<string, number>();
  const slots = new Set<number>();
  let late = 0;
  for (const m of msgs) {
    const day = localDate(m.ts, tz);
    const h = Math.floor(localMinutes(m.ts, tz) / 60);
    const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    heatmap[dow]![h]!++;
    days.set(day, (days.get(day) ?? 0) + 1);
    slots.add(Math.floor(m.ts / 900_000));
    if (LATE(h)) late++;
  }
  const sorted = [...days.keys()].sort();
  let longestStreak = 0;
  let run = 0;
  let prev = '';
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prev = d;
  }
  const top = topOf(days);
  return {
    heatmap,
    activeDays: sorted.length,
    longestStreak,
    ...(top ? { busiestDay: { date: top.name, count: top.count } } : {}),
    lateNightShare: msgs.length ? Math.round((late / msgs.length) * 100) / 100 : 0,
    // quarter hours with at least one message from you
    hoursActive: Math.round((slots.size / 4) * 10) / 10,
  };
}

function buildHabits(d: {
  children: SessionRow[];
  workflows: Array<{ name: string; agents: number }>;
  human: SessionRow[];
  firsts: Map<string, MsgRow>;
  corrections: Map<string, number>;
  correctionCount: number;
  byId: Map<string, SessionRow>;
  denied: number;
  declined: number;
  aborted: number;
  checkFails: number;
  reviewSessions: SessionRow[];
  reviewRuns: number;
}): ReflectHabit[] {
  const out: ReflectHabit[] = [];
  if (d.children.length || d.workflows.length) {
    const top = rank(d.children.map((s) => s.agent), 1)[0];
    const big = [...d.workflows].sort((a, b) => b.agents - a.agents)[0];
    out.push({
      key: 'delegation',
      observation: `You handed ${n(d.children.length, 'task', 'tasks')} to other agents and ran ${n(d.workflows.length, 'workflow', 'workflows')}.`,
      ...(top ? { example: `Most went to ${top.name} (${top.count}).` } : big ? { example: `Your biggest workflow, ${big.name}, used ${n(big.agents, 'agent', 'agents')}.` } : {}),
    });
  }
  const openers = d.human.map((s) => d.firsts.get(s.id)).filter((m): m is MsgRow => !!m?.len);
  if (openers.length >= 3) {
    // median, not mean: one pasted log would swamp the mean
    const lens = openers.map((m) => m.len ?? 0).sort((a, b) => a - b);
    const avgWords = Math.round((lens[Math.floor(lens.length / 2)] ?? 0) / 6);
    const inProject = Math.round((d.human.filter((s) => s.project).length / d.human.length) * 100);
    const longest = [...openers].sort((a, b) => (b.len ?? 0) - (a.len ?? 0))[0]!;
    out.push({
      key: 'description',
      observation: `A typical opening message from you runs about ${n(avgWords, 'word', 'words')}, and ${inProject}% of your sessions ran inside a project.`,
      example: `Your most detailed opener started "${d.byId.get(longest.sid)?.title ?? ''}" (about ${Math.round((longest.len ?? 0) / 6)} words).`,
    });
  }
  if (d.correctionCount || d.denied || d.declined || d.aborted) {
    const parts = [d.correctionCount && `corrected course ${n(d.correctionCount, 'time', 'times')}`, d.aborted && `stopped ${n(d.aborted, 'turn', 'turns')}`, d.declined && `declined ${n(d.declined, 'draft', 'drafts')}`, d.denied && `denied ${n(d.denied, 'tool request', 'tool requests')}`].filter(Boolean) as string[];
    const top = topSession(d.corrections, d.byId);
    out.push({ key: 'discernment', observation: `You ${list(parts)}.`, ...(top ? { example: `${n(top.count, 'correction', 'corrections')} in "${top.title}".` } : {}) });
  }
  if (d.reviewSessions.length || d.reviewRuns || d.checkFails) {
    const parts = [d.reviewSessions.length && `ran ${n(d.reviewSessions.length, 'review session', 'review sessions')}`, d.reviewRuns && `ran ${n(d.reviewRuns, 'review workflow', 'review workflows')}`, d.checkFails && `ended ${n(d.checkFails, 'turn', 'turns')} with the code check still failing`].filter(Boolean) as string[];
    const ex = d.reviewSessions[0];
    out.push({ key: 'diligence', observation: `You ${list(parts)}.`, ...(ex ? { example: `For example "${ex.title}".` } : {}) });
  }
  return out;
}

function basicHeadline(range: ReflectRange, t: ReflectReport['totals'], activeDays: number, topProject?: string): string {
  if (!t.chats && !t.sessions) return `${RANGE_WORDS[range]}: nothing yet. Chats and sessions show up here as you go.`;
  const parts = [t.chats && n(t.chats, 'chat', 'chats'), t.sessions && n(t.sessions, 'session', 'sessions')].filter(Boolean) as string[];
  return `${RANGE_WORDS[range]}: ${list(parts)} over ${n(activeDays, 'day', 'days')}${topProject ? `, mostly on ${topProject}` : ''}.`;
}

function basicSuggestions(d: { repeat?: SessionRow[]; unprojected: number; lateNightShare: number; messages: number; fallbacks: number; corrections: number }): ReflectReport['suggestions'] {
  const out: ReflectReport['suggestions'] = [];
  if (d.repeat) out.push({ text: 'Turn this repeated request into a routine or a skill.', why: `You opened ${d.repeat.length} sessions the same way, like "${d.repeat[0]!.title}".` });
  if (d.unprojected >= 6) out.push({ text: 'Start a project for the topic you keep coming back to, so the context carries over.', why: `${d.unprojected} chats had no project.` });
  if (d.corrections >= 5) out.push({ text: 'Save the corrections you repeat as notes, so you stop giving them.', why: `You corrected the agent ${d.corrections} times.` });
  if (d.fallbacks >= 10) out.push({ text: 'Add a second account or change the model order in Settings, Accounts.', why: `${d.fallbacks} turns fell back to another model when a plan hit its limit.` });
  if (d.lateNightShare >= 0.2 && d.messages >= 20) out.push({ text: 'Set quiet hours so nothing pulls you back late.', why: `${Math.round(d.lateNightShare * 100)}% of your messages came between 23:00 and 05:00.` });
  return out.slice(0, 4);
}

function basicQuestion(delegated: number, roots: number, lateNightShare: number): string {
  if (lateNightShare >= 0.2) return 'What would make it easier to stop for the night?';
  if (delegated > roots) return "What's one thing you want to keep doing yourself, even if an agent could do it faster?";
  return 'What did you get better at this period, and what do you want to try next?';
}

function episodeSummaries(db: Db, accountId: string, ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const rows = db
    .query<{ sid: string; content: string }, [string, string]>(`SELECT source_session_id AS sid, content FROM memories WHERE account_id = ? AND kind = 'episode' AND source_session_id IN (SELECT value FROM json_each(?)) ORDER BY updated_at ASC`)
    .all(accountId, JSON.stringify(ids));
  return new Map(rows.map((r) => [r.sid, r.content]));
}

function readPeople(db: Db, accountId: string, rows: Array<{ id: string; content: string; tags: string; meta: string | null; created_at: number }>, start: number): string[] {
  const imported = importedPersonIds(db, accountId);
  const first = new Map<string, { name: string; at: number }>();
  for (const r of rows) {
    const tags = parseTags(r.tags);
    const meta = parseMeta(r.meta ?? '');
    const path = typeof meta.path === 'string' ? meta.path : typeof meta.permalink === 'string' ? meta.permalink : '';
    if (!(imported.has(r.id) || tags.some((t) => PERSON_TAGS.has(t)) || meta.entity === 'person' || /(?:^|\/)(?:people|person)(?:\/|$)/i.test(path))) continue;
    const name = (r.content.split(/[:\n—–]/)[0] ?? r.content).trim().replace(/^#+\s*/, '').slice(0, 60);
    const key = name.toLowerCase();
    if (key && !first.has(key)) first.set(key, { name, at: r.created_at });
  }
  return [...first.values()].filter((p) => p.at >= start).map((p) => p.name).slice(0, 12);
}

function importedPersonIds(db: Db, accountId: string): Set<string> {
  // same key MemoryStore writes (memory/store.ts); rows are matched to this account's memories anyway
  const rows = db.query<{ value: string }, [string]>(`SELECT value FROM kv WHERE key LIKE ?`).all(`${accountKey(accountId, 'memory.import.')}%`);
  const ids = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(parseMeta(row.value))) {
      const id = (v as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && /(?:^|\/)(?:people|person)(?:\/|$)/i.test(k)) ids.add(id);
    }
  }
  return ids;
}

function topSession(counts: Map<string, number>, byId: Map<string, SessionRow>): { title: string; count: number } | undefined {
  const top = topOf(counts);
  return top ? { title: byId.get(top.name)?.title ?? '', count: top.count } : undefined;
}
function n(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
function list(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}
function folder(cwd: string): string {
  return cwd.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}
function countBy(rows: Array<{ k: string; c: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.k, r.c]));
}
function hasTable(db: Db, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}
function words(title: string): string[] {
  return [...new Set((title.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w) && !/^\d+$/.test(w)))];
}
function rank(items: string[], limit: number): ReflectNamed[] {
  const counts = new Map<string, number>();
  for (const item of items) if (item) counts.set(item, (counts.get(item) ?? 0) + 1);
  return sorted(counts).slice(0, limit);
}
function sorted(counts: Map<string, number>): ReflectNamed[] {
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function topOf(counts: Map<string, number>): ReflectNamed | undefined {
  return sorted(counts)[0];
}
function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
}
function parseMeta(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
