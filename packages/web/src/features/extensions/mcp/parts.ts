/** MCP server words: what the server runs, where it is defined, and what to do when it fails. */
import type { McpStatus } from '@conclave/core/client';
import type { McpServerConfig } from '@conclave/core/config/schema';

/**
 * Send the sign-in tab (opened blank before the request, so a popup blocker
 * lets it through) to a server's authorize page. The page gets no opener, so
 * it cannot navigate this tab. Only https opens; with no tab the same tab
 * goes there. False when nothing opened.
 */
export function openAuthorize(tab: Pick<Window, 'opener' | 'close' | 'location'> | null, url: string, here: Pick<Location, 'assign'>): boolean {
  if (tab) tab.opener = null;
  if (!/^https:\/\//i.test(url)) {
    tab?.close();
    return false;
  }
  if (tab) tab.location.href = url;
  else here.assign(url);
  return true;
}

export function target(cfg?: McpServerConfig): string {
  if (!cfg) return '';
  return cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ');
}

export function transportOf(st: McpStatus, cfg?: McpServerConfig): string {
  if (st.transport) return st.transport;
  if (cfg) return cfg.url ? (cfg.type === 'sse' ? 'sse' : 'http') : 'stdio';
  return st.source;
}

/** One sentence that says what to do about a failed server. */
export function advice(error: string | undefined, cfg?: McpServerConfig): string {
  const e = error ?? '';
  const missing = /Executable not found in \$PATH: "([^"]+)"|ENOENT|command not found: (\S+)|(\S+): not found/.exec(e);
  if (missing) {
    const exe = missing[1] ?? missing[2] ?? missing[3] ?? cfg?.command ?? 'the command';
    if (exe === 'npx' || exe === 'node') return `Install Node.js on the hub (it brings ${exe}), or put the full path to ${exe} in the command.`;
    if (exe === 'uvx' || exe === 'uv') return 'Install uv on the hub (it brings uvx), or put the full path to uvx in the command.';
    return `Install ${exe} on the hub, or put its full path in the command.`;
  }
  if (cfg?.auth === 'oauth' && /401|403|unauthori[sz]ed|forbidden|sign-in|connect it/i.test(e)) return 'The sign-in lapsed. Press Connect and sign in again.';
  if (/401|403|unauthori[sz]ed|forbidden/i.test(e)) return 'The server refused the credentials. Check the token in the headers or env, and the secret it points at in Settings.';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|connect/i.test(e)) return 'The hub cannot reach the server. Check that it is running and that the URL works from the hub.';
  if (/timed? ?out|timeout/i.test(e)) return 'The server took too long to answer. Restart it, or run the command on the hub to see what it prints.';
  if (!e) return 'It has not started yet, or it stopped without saying why. Press Test to start it and see the result.';
  return 'Fix the command or URL with Edit, then press Restart.';
}

/** Split "uvx basic-memory mcp" into command and args, keeping quoted parts together. */
export function splitCommand(line: string): string[] {
  return (
    line
      .trim()
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((p) => p.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')) ?? []
  );
}

export function joinCommand(cfg: McpServerConfig): string {
  return [cfg.command ?? '', ...(cfg.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a))].filter(Boolean).join(' ');
}

export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A JSON object to start "Try" with: required string fields empty, others left out. */
export function argsTemplate(schema: Record<string, unknown> | undefined): string {
  const props = (schema?.properties ?? {}) as Record<string, { type?: string; default?: unknown }>;
  const req = (schema?.required ?? []) as string[];
  const out: Record<string, unknown> = {};
  for (const k of req) {
    const p = props[k] ?? {};
    out[k] = p.default ?? (p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : '');
  }
  return JSON.stringify(out, null, 2);
}
