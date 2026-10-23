/**
 * Group by Project or Device for the session lists (SessionList, the phone
 * Code list and the side panel's Recents). A project is one identity across
 * devices (packages/core/src/projects): a session on the Mac, one on the
 * hub and an imported Claude Code chat in clones of one repository share a
 * group. A session without a project goes under its folder's name; chats
 * and sessions with no folder go under Chats, last. Groups and the rows in
 * them are newest first.
 */
import type { Device, Session } from '@conclave/core/types';
import type { ProjectDto } from '@conclave/core/client';

/** The Group by choices. date is Recent: time only (and, on the desktop list, the state groups). */
export type GroupBy = 'date' | 'project' | 'device' | 'agent' | 'task';

export const GROUP_WORDS: Record<GroupBy, string> = { date: 'Recent', project: 'Project', device: 'Device', agent: 'Agent', task: 'Task' };

/** The key of the group for sessions with no project and no folder, and for chats. */
export const CHATS = 'chats';

export interface GroupContext {
  projects: Record<string, Pick<ProjectDto, 'id' | 'name' | 'locations'>>;
  devices: Record<string, Pick<Device, 'id' | 'name' | 'info'>>;
}

type Groupable = Pick<Session, 'id' | 'kind' | 'cwd' | 'device' | 'updatedAt'> & Partial<Pick<Session, 'projectId'>>;

export interface SessionGroup<T> {
  key: string;
  label: string;
  items: T[];
  /** The newest activity in the group. */
  last: number;
}

function trim(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** ~ and ~/x on a device, as an absolute path when its home is known. */
export function expandHome(cwd: string, home: string | undefined): string {
  if (!home) return trim(cwd);
  if (cwd === '~') return trim(home);
  if (cwd.startsWith('~/')) return trim(`${trim(home)}/${cwd.slice(2)}`);
  return trim(cwd);
}

function inside(path: string, root: string): boolean {
  const r = trim(root);
  return path === r || path.startsWith(`${r}/`);
}

/** True when the folder says nothing about the work: no folder, the home folder or the root. */
function noFolder(cwd: string | undefined, home: string | undefined): boolean {
  if (!cwd || cwd === '~' || cwd === '/' || cwd === '.') return true;
  return !!home && trim(cwd) === trim(home);
}

/** The group a session goes in by project: its project, else a project with a location holding its folder, else its folder, else Chats. */
export function projectGroupOf(s: Groupable, ctx: GroupContext): { key: string; label: string } {
  if (s.kind === 'chat') return { key: CHATS, label: 'Chats' };
  const home = ctx.devices[s.device]?.info?.home;
  const cwd = s.cwd ? expandHome(s.cwd, home) : '';
  if (s.projectId) {
    const p = ctx.projects[s.projectId];
    if (p) return { key: `p:${p.id}`, label: p.name };
  }
  // learned before this session had a turn: a location of a project on this device holds the folder
  if (cwd && !noFolder(s.cwd, home)) {
    let best: { id: string; name: string; len: number } | undefined;
    for (const p of Object.values(ctx.projects)) {
      for (const l of p.locations) {
        if (l.device !== s.device || !inside(cwd, l.path)) continue;
        if (!best || l.path.length > best.len) best = { id: p.id, name: p.name, len: l.path.length };
      }
    }
    if (best) return { key: `p:${best.id}`, label: best.name };
  }
  if (noFolder(s.cwd, home)) return { key: CHATS, label: 'Chats' };
  const name = cwd.split('/').filter(Boolean).pop() ?? cwd;
  // a project the list has not loaded yet still keeps its sessions together
  if (s.projectId) return { key: `p:${s.projectId}`, label: name };
  return { key: `f:${name.toLowerCase()}`, label: name };
}

export function deviceGroupOf(s: Groupable, ctx: GroupContext): { key: string; label: string } {
  return { key: `d:${s.device || 'local'}`, label: ctx.devices[s.device || 'local']?.name ?? s.device ?? 'Hub' };
}

/**
 * Sessions in groups by project or device, newest group first, newest row
 * first in each. Chats go last.
 */
export function groupSessions<T extends Groupable>(list: T[], by: 'project' | 'device', ctx: GroupContext): Array<SessionGroup<T>> {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const out = new Map<string, SessionGroup<T>>();
  for (const s of sorted) {
    const g = by === 'project' ? projectGroupOf(s, ctx) : deviceGroupOf(s, ctx);
    let group = out.get(g.key);
    if (!group) out.set(g.key, (group = { key: g.key, label: g.label, items: [], last: s.updatedAt }));
    group.items.push(s);
  }
  const groups = [...out.values()];
  return [...groups.filter((g) => g.key !== CHATS), ...groups.filter((g) => g.key === CHATS)];
}

/** The device name a row shows when the list is grouped by project. */
export function deviceName(s: Pick<Session, 'device'>, ctx: Pick<GroupContext, 'devices'>): string {
  return ctx.devices[s.device || 'local']?.name ?? s.device ?? 'Hub';
}
