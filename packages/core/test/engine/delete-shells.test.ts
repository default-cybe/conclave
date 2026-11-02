import { describe, expect, test } from 'bun:test';
import { shellRegistry } from '../../src/tools/shells';
import type { Tool } from '../../src/tools/types';
import { startTestEngine, until } from './harness';

describe('deleting a session', () => {
  test('stops the background shells it started', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'Bash', input: { command: 'sleep 60', run_in_background: true, description: 'Wait a minute' } }], [{ text: 'started' }]],
      approve: 'allow',
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd });
      await t.run(s.id, 'start a server');
      const [shell] = shellRegistry.list(s.id);
      expect(shell?.status).toBe('running');
      await t.engine.deleteSession(s.id);
      expect(await until(() => shellRegistry.list(s.id).length === 0)).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('clears per-session tool and workspace caches', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'ok' }]],
      overrides: { mcp: { deferAbove: 1 } } as never,
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose' });
      const engine = t.engine as unknown as {
        mcpCache: { tools: Tool[]; at: number } | null;
        deferred: Map<string, Tool[]>;
        promoted: Map<string, { seq: number; names: string[] }>;
        testCommands: Map<string, Promise<string | undefined>>;
        workspaceFacts: Map<string, Promise<unknown>>;
      };
      engine.mcpCache = {
        at: Date.now(),
        tools: [1, 2].map((n) => ({ name: `mcp__gh__t${n}`, description: `t${n}`, inputSchema: { type: 'object', properties: {} }, readOnly: true, run: async () => ({ content: '' }) })),
      };
      await t.run(s.id, 'hello');
      expect(t.engine.deferredToolsFor(s.id).length).toBe(2);
      expect(engine.promoted.has(s.id)).toBe(true);
      expect([...engine.testCommands.keys()].some((k) => k.startsWith(`${s.id}\n`))).toBe(true);
      expect([...engine.workspaceFacts.keys()].some((k) => k.startsWith(`${s.id}\n`))).toBe(true);

      await t.engine.deleteSession(s.id);

      expect(t.engine.deferredToolsFor(s.id)).toEqual([]);
      expect(engine.promoted.has(s.id)).toBe(false);
      expect([...engine.testCommands.keys()].some((k) => k.startsWith(`${s.id}\n`))).toBe(false);
      expect([...engine.workspaceFacts.keys()].some((k) => k.startsWith(`${s.id}\n`))).toBe(false);
    } finally {
      await t.close();
    }
  });
});
