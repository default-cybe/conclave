/**
 * Tool calls as the Map shows them: the tool's name and what it works on
 * (a file name, a command, a pattern, a host), with how long it ran.
 */
import type { MapTool } from '../client/map';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** The last part of a path ("redirect.ts"), from either slash. */
export function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

function host(url: string): string {
  try {
    const u = new URL(url);
    return clip(u.host + (u.pathname === '/' ? '' : u.pathname), 40);
  } catch {
    return clip(url, 40);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * What a call works on, in a few words. Files by name, commands by their
 * first line, searches by pattern, fetches by host, subagents by their
 * description. Undefined when the input says nothing short.
 */
export function toolTarget(input: Record<string, unknown> | undefined): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const file = str(input.file_path) ?? str(input.notebook_path);
  if (file) return clip(baseName(file), 48);
  const command = str(input.command);
  if (command) return clip(command.split('\n')[0].replace(/\s+/g, ' '), 48);
  const pattern = str(input.pattern);
  if (pattern) return clip(pattern, 40);
  const url = str(input.url);
  if (url) return host(url);
  const query = str(input.query);
  if (query) return clip(query, 40);
  const path = str(input.path);
  if (path) return clip(baseName(path), 48);
  const what = str(input.description) ?? str(input.subagent_type) ?? str(input.skill) ?? str(input.name);
  if (what) return clip(what, 40);
  return undefined;
}

/** One tool_use or tool_result block as the snapshot query reads it. */
export interface ToolRow {
  at: number;
  type: 'tool_use' | 'tool_result';
  /** tool_use id, or the toolUseId a result answers. */
  id: string;
  name?: string;
  input?: Record<string, unknown>;
  durationMs?: number;
  error?: boolean;
}

/**
 * Tools from a session's blocks, oldest row first: the finished ones newest
 * first, and the one still open (no result yet), if any. A result's
 * duration is the one its meta records, else the time between the two
 * messages.
 */
export function toolsFromRows(rows: ToolRow[]): { done: MapTool[]; open?: MapTool } {
  const uses = new Map<string, MapTool>();
  const order: string[] = [];
  const results = new Map<string, ToolRow>();
  for (const r of rows) {
    if (r.type === 'tool_use') {
      if (!uses.has(r.id)) order.push(r.id);
      const target = toolTarget(r.input);
      uses.set(r.id, { id: r.id, name: r.name || 'tool', ...(target ? { target } : {}), startedAt: r.at });
    } else results.set(r.id, r);
  }
  const done: MapTool[] = [];
  let open: MapTool | undefined;
  for (const id of order) {
    const use = uses.get(id)!;
    const res = results.get(id);
    if (!res) {
      open = use;
      continue;
    }
    const durationMs = typeof res.durationMs === 'number' && res.durationMs >= 0 ? res.durationMs : Math.max(0, res.at - use.startedAt);
    // the result knows when it ended; its own duration says when it started
    const startedAt = typeof res.durationMs === 'number' ? Math.max(use.startedAt, res.at - res.durationMs) : use.startedAt;
    done.push({ ...use, startedAt, durationMs, ...(res.error ? { error: true } : {}) });
  }
  done.sort((a, b) => b.startedAt - a.startedAt);
  return { done, ...(open ? { open } : {}) };
}
