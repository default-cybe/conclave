/**
 * A member's memory connections (docs/design/ACCOUNTS.md 2). They run on
 * the hub, so they get less than the owner's:
 *
 * - no stdio server of the member's choosing (it would run as the hub's OS
 *   user); the one process allowed is Basic Memory itself, started by the
 *   hub in the member's own folder with a bare environment, so each person
 *   may keep their own Basic Memory notes on the hub, or none;
 * - an MCP server, HTTP memory API, mem0 or Cognee only at a public
 *   address, checked before each connect and each request, without
 *   following redirects.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ConfigStore } from '../config';
import { defaultMcpClientFactory } from '../memory/connections/mcp-client';
import { BASIC_MEMORY_DEFAULT_SERVER } from '../memory/connections/basic-memory';
import type { McpClientFactory } from '../memory/connections/types';
import { checkPublicUrl } from './net';

export const MEMBER_STDIO_REFUSED =
  'On this hub a memory connection of yours can be Basic Memory (the hub runs it in your own folder), or a server at a public address. It cannot start a program of its own on the hub.';

/** Basic Memory as the hub starts it for a member: the default command and nothing else. */
function isBasicMemory(command: string | undefined, args: string[] | undefined): boolean {
  return command === BASIC_MEMORY_DEFAULT_SERVER.command && JSON.stringify(args ?? []) === JSON.stringify(BASIC_MEMORY_DEFAULT_SERVER.args ?? []);
}

export function memberMcpClientFactory(view: ConfigStore, dir: string): McpClientFactory {
  return async (name, cfg) => {
    if (cfg.command) {
      if (!isBasicMemory(cfg.command, cfg.args)) throw new Error(MEMBER_STDIO_REFUSED);
      const home = join(dir, 'basic-memory');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // a bare environment: the hub's keys and tokens never reach the process
      const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, BASIC_MEMORY_HOME: home, LANG: process.env.LANG ?? 'C.UTF-8' };
      return defaultMcpClientFactory(view, { baseEnv: env })(name, { ...BASIC_MEMORY_DEFAULT_SERVER, env: {} });
    }
    if (cfg.url) await checkPublicUrl(view.expand(cfg.url));
    return defaultMcpClientFactory(view)(name, cfg);
  };
}

/** fetch for a member's HTTP memory connections: public addresses only, no redirects. */
export const memberFetch: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    await checkPublicUrl(url);
    return fetch(input, { ...init, redirect: 'error' });
  },
  { preconnect: fetch.preconnect },
);
