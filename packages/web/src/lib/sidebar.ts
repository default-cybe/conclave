/**
 * The sessions in the sidebar (desktop) and the drawer (phone), as the
 * Claude app lists them: the conversations of the mode the switch is on,
 * one row each (title, a quiet dot while it runs or waits on you, the
 * device when the list is not grouped by device), in groups.
 *
 * Code goes by project (one group per project across devices, the + of a
 * group starts a session there), by device, or by time. Chats go by time:
 * Pinned, Today, Yesterday, This week, Older. The assistant is one thread
 * (meta.home, GET /api/assistant/home), on top with no heading; its older
 * conversations are under History, newest first. Subagents, a workflow's
 * own agents, routine runs and what is archived stay out: they are not
 * places the owner went.
 *
 * Delegated work (a Delegate call's Code or Assistant session) has a group
 * of its own under the list in every mode, newest first: the title, who did
 * it and where ("Code on MadX Arch"), its dot, and the conversation it came
 * from as a quiet second line ("from Capstone chat"). Moved to the main
 * list, it is a normal session of its kind. Pure, so test/sidebar.test.ts
 * checks it.
 */
import type { Session } from '@conclave/core/types';
import { delegateMark, isDelegated, underParent } from '@conclave/core/session/delegated';
import { CHATS, deviceName, groupSessions, type GroupContext } from './grouping';
import { hrefOf, liveState } from './recents';
import { sessionRepo } from './github';

export type SideMode = 'chat' | 'assistant' | 'code';
export type SideGroupBy = 'project' | 'device' | 'time';

export const SIDE_GROUP_WORDS: Record<SideGroupBy, string> = { project: 'Project', device: 'Device', time: 'Time' };

/** How many rows the sidebar lists at most; All conversations has the rest. */
export const SIDE_LIMIT = 80;

const ASSISTANT = 'assistant';
const inWorkflow = (s: Session) => !!(s.meta as { workflow?: unknown } | undefined)?.workflow || s.tags.includes('workflow');

/** Which switch a conversation belongs to (features/home/start.ts modeOf, kept here so this file stays pure). */
export function sideModeOf(s: Pick<Session, 'kind' | 'agent'>): SideMode {
  if (s.kind === 'chat') return 'chat';
  return s.agent === ASSISTANT ? 'assistant' : 'code';
}

/** The conversations of a mode the owner went to, newest first: their own, not archived, not a subagent's, a workflow's or a routine's. */
export function modeSessions(sessions: Iterable<Session>, mode: SideMode): Session[] {
  const out: Session[] = [];
  for (const s of sessions) {
    if (s.archived || underParent(s) || s.routineId || inWorkflow(s)) continue;
    if (sideModeOf(s) !== mode) continue;
    out.push(s);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface SideRow {
  id: string;
  title: string;
  href: string;
  /** running: a small dot in signal. waiting: amber, an approval or a question waits on the owner. */
  state?: 'running' | 'waiting';
  /** The device, only when the list is not grouped by device, and only for Code. */
  device?: string;
}

/** Where the + of a project group starts a session: the newest session's folder on its device, or its repository. */
export interface SideTarget {
  device: string;
  cwd?: string;
  repo?: string;
}

export interface SideGroupOut {
  key: string;
  label: string;
  rows: SideRow[];
  /** Project groups: where a new session in it starts. */
  target?: SideTarget;
  /** A project of this hub (key "p:<id>"), which can be shared with friends. */
  projectId?: string;
}

const DAY = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today, Yesterday, This week (the five days before yesterday) or Older, on the local clock. */
export function timeBucket(t: number, now: number): { key: 'today' | 'yesterday' | 'week' | 'older'; label: string } {
  const today = startOfDay(now);
  if (t >= today) return { key: 'today', label: 'Today' };
  // the day before, by the calendar (a 23 or 25 hour day around a clock change stays one day)
  const yesterday = startOfDay(today - 1);
  if (t >= yesterday) return { key: 'yesterday', label: 'Yesterday' };
  if (t >= startOfDay(today - 6 * DAY)) return { key: 'week', label: 'This week' };
  return { key: 'older', label: 'Older' };
}

/** A group of repo sessions of one repository says the repository: their folders are worktrees named after the task. */
function repoOf(items: Session[]): string | undefined {
  const repo = sessionRepo(items[0])?.repo;
  return repo && items.every((s) => sessionRepo(s)?.repo === repo) ? repo : undefined;
}

function rowOf(s: Session, waiting: ReadonlySet<string>, device?: string): SideRow {
  return { id: s.id, title: s.title || (s.kind === 'chat' ? 'New chat' : 'New session'), href: hrefOf(s), state: liveState(s, waiting), ...(device ? { device } : {}) };
}

/** The + of a project group: its newest session's place. */
function targetOf(items: Session[]): SideTarget | undefined {
  const s = items[0];
  if (!s) return undefined;
  const repo = sessionRepo(s)?.repo;
  if (repo) return { device: s.device, repo };
  if (!s.cwd || s.cwd === '~') return undefined;
  return { device: s.device, cwd: s.cwd };
}

export interface SideInput {
  sessions: Session[];
  mode: SideMode;
  /** Code only; chats and the assistant's go by time. */
  by: SideGroupBy;
  ctx: GroupContext;
  /** Ids of sessions with an approval or a question open. */
  waiting?: ReadonlySet<string>;
  now: number;
  limit?: number;
}

/** The sidebar's groups for a mode. */
export function sideGroups(i: SideInput): SideGroupOut[] {
  const waiting = i.waiting ?? new Set<string>();
  const list = modeSessions(i.sessions, i.mode).slice(0, i.limit ?? SIDE_LIMIT);
  const by: SideGroupBy = i.mode === 'code' ? i.by : 'time';
  const code = i.mode === 'code';
  if (i.mode === 'assistant') {
    const home = list.filter((s) => s.meta?.home);
    const history = list.filter((s) => !s.meta?.home);
    return [
      ...(home.length ? [{ key: 'home', label: 'Assistant', rows: home.map((s) => rowOf(s, waiting)) }] : []),
      ...(history.length ? [{ key: 'history', label: 'History', rows: history.map((s) => rowOf(s, waiting)) }] : []),
    ];
  }
  if (by === 'time') {
    const out: SideGroupOut[] = [];
    const push = (key: string, label: string, s: Session) => {
      let g = out.find((x) => x.key === key);
      if (!g) out.push((g = { key, label, rows: [] }));
      g.rows.push(rowOf(s, waiting, code ? deviceName(s, i.ctx) : undefined));
    };
    for (const s of list) {
      if (s.pinned) push('pinned', 'Pinned', s);
      else {
        const b = timeBucket(s.updatedAt, i.now);
        push(b.key, b.label, s);
      }
    }
    const order = ['pinned', 'today', 'yesterday', 'week', 'older'];
    return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return groupSessions(list, by, i.ctx).map((g) => {
    const project = by === 'project';
    const label = project ? (g.key === CHATS ? 'No folder' : (repoOf(g.items) ?? g.label)) : g.label;
    const target = project && g.key !== CHATS ? targetOf(g.items) : undefined;
    return {
      key: g.key,
      label,
      rows: g.items.map((s) => rowOf(s, waiting, project ? deviceName(s, i.ctx) : undefined)),
      ...(target ? { target } : {}),
      ...(g.key.startsWith('p:') ? { projectId: g.key.slice(2) } : {}),
    };
  });
}

/** What the sidebar calls the list: "Chats", "Assistant" or "Sessions". */
export function sideListWord(mode: SideMode): string {
  return mode === 'chat' ? 'Chats' : mode === 'assistant' ? 'Assistant' : 'Sessions';
}

/** The words of the New row for a mode. */
export const NEW_WORDS: Record<SideMode, string> = { chat: 'New chat', assistant: 'Message assistant', code: 'New session' };

// ---------------------------------------------------------------------------
// Delegated work
// ---------------------------------------------------------------------------

/** The group's name, and its key in the folded groups (one for every mode). */
export const DELEGATED_WORDS = 'Delegated work';
export const DELEGATED_KEY = 'delegated';

/** How many rows Delegated work lists at most. */
export const DELEGATED_LIMIT = 30;

export interface DelegatedRow extends SideRow {
  /** Who did it and where: "Code on MadX Arch", "Assistant on madx". */
  who: string;
  /** The conversation it came from: "from Capstone chat". Undefined when that is gone. */
  from?: string;
}

/** Who did a delegated job and where: "Code on MadX Arch". The device by its name now, else the name it had. */
export function delegateWho(s: Session, ctx: Pick<GroupContext, 'devices'>): string {
  const mark = delegateMark(s);
  const who = mark?.to === 'assistant' || (!mark?.to && s.agent === ASSISTANT) ? 'Assistant' : 'Code';
  const where = ctx.devices[s.device]?.name || mark?.deviceName || s.device;
  return where ? `${who} on ${where}` : who;
}

/** The second line: "from Capstone chat", "from Plan my week in Assistant", "from Fix auth in Code". */
export function fromWords(parent: Pick<Session, 'title' | 'kind' | 'agent'> | undefined): string | undefined {
  if (!parent) return undefined;
  const mode = sideModeOf(parent);
  const title = parent.title?.trim() || (mode === 'chat' ? 'a chat' : 'a session');
  if (mode === 'chat') return /\bchat$/i.test(title) ? `from ${title}` : `from ${title} chat`;
  return `from ${title} in ${mode === 'assistant' ? 'Assistant' : 'Code'}`;
}

/** Delegated work that is not archived, newest first, as rows. */
export function delegatedRows(i: { sessions: Session[]; ctx: GroupContext; waiting?: ReadonlySet<string>; limit?: number }): DelegatedRow[] {
  const waiting = i.waiting ?? new Set<string>();
  const byId = new Map(i.sessions.map((s) => [s.id, s]));
  return i.sessions
    .filter((s) => !s.archived && isDelegated(s))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, i.limit ?? DELEGATED_LIMIT)
    .map((s) => {
      const from = fromWords(s.parentId ? byId.get(s.parentId) : undefined);
      return { ...rowOf(s, waiting), who: delegateWho(s, i.ctx), ...(from ? { from } : {}) };
    });
}
