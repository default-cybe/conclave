/**
 * Connectors off for one session (/mcp in a session): the MCP servers whose
 * tools this session leaves out. Kept in session.meta.mcpOff; the server
 * keeps running for every other session.
 */
import type { Session } from '../types';

/** Servers turned off for this session. */
export function mcpOff(s: Pick<Session, 'meta'>): string[] {
  const v = s.meta?.mcpOff;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** True when the session keeps this tool: built-in tools always, MCP tools unless their server is off here. */
export function sessionAllowsServerTool(s: Pick<Session, 'meta'>, toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return true;
  const off = mcpOff(s);
  return !off.some((srv) => toolName.startsWith(`mcp__${srv}__`));
}

/** Check a patch value; null clears it. Throws a message the API can return as a 400. */
export function checkMcpOff(v: unknown): string[] {
  if (v === null) return [];
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string' || !x || x.length > 200)) throw new Error('mcpOff must be a list of server names');
  return [...new Set(v as string[])];
}
