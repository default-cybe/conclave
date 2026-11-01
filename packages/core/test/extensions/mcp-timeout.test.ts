import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { McpManager } from '../../src/extensions/mcp';
import { runBounded } from '../../src/session/runner';
import type { Tool } from '../../src/tools/types';
import { fakeHost, makeCtx } from '../tools/helpers';
import { cleanup, tempDir } from './_helpers';

/** HARNESS-REVIEW item 9: MCP calls stop on a user stop and on a time limit. */

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));
const SERVER = join(import.meta.dir, '..', 'engine', 'fixtures', 'mcp-catalog-server.ts');

function manager(timeoutMs?: number): McpManager {
  const home = tempDir();
  dirs.push(home);
  const cfg = new ConfigStore(home);
  cfg.update({ mcpServers: { gh: { command: 'bun', args: [SERVER], ...(timeoutMs ? { timeoutMs } : {}) } } as never });
  return new McpManager(cfg);
}

describe('MCP call limits', () => {
  test('a stop returns within 200 ms; the per-server timeout gives TOOL_TIMEOUT', async () => {
    const mgr = manager(300);
    try {
      const tools = await mgr.tools();
      const sleep = tools.find((t) => t.name === 'mcp__gh__sleep')!;
      expect(sleep.timeoutMs).toBe(300);

      const ctl = new AbortController();
      const started = Date.now();
      setTimeout(() => ctl.abort(), 50);
      const stopped = await mgr.callTool('gh', 'sleep', { ms: 5_000 }, { signal: ctl.signal, timeoutMs: 10_000 });
      expect(Date.now() - started).toBeLessThan(250);
      expect(stopped).toMatchObject({ isError: true, content: 'mcp tool sleep was stopped' });

      const t0 = Date.now();
      const timedOut = await mgr.callTool('gh', 'sleep', { ms: 5_000 });
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(timedOut).toEqual({ content: 'Error: tool call timed out after 0.3 s', isError: true, meta: { code: 'TOOL_TIMEOUT' } });
    } finally {
      await mgr.shutdown();
    }
  }, 20_000);

  test('the runner stops waiting on a tool that ignores its signal, at the limit or on a stop', async () => {
    const hung: Tool = { name: 'mcp__x__hang', description: '', inputSchema: { type: 'object' }, readOnly: true, timeoutMs: 150, run: () => new Promise(() => undefined) };
    const ctx = makeCtx({ cwd: '/', host: fakeHost() });
    const t0 = Date.now();
    expect(await runBounded(hung, {}, ctx, 150)).toMatchObject({ isError: true, meta: { code: 'TOOL_TIMEOUT' } });
    expect(Date.now() - t0).toBeLessThan(600);

    const ctl = new AbortController();
    const t1 = Date.now();
    setTimeout(() => ctl.abort(), 30);
    await expect(runBounded(hung, {}, makeCtx({ cwd: '/', host: fakeHost(), signal: ctl.signal }), 60_000)).rejects.toThrow('aborted');
    expect(Date.now() - t1).toBeLessThan(200);
  });
});
