import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { McpManager } from '../../src/extensions/mcp';
import { tempDir, cleanup } from './_helpers';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

const SERVER = join(import.meta.dir, 'fixtures', 'mcp-echo-server.ts');

function configWith(mcpServers: Record<string, unknown>): ConfigStore {
  const home = tempDir();
  dirs.push(home);
  const cfg = new ConfigStore(home);
  cfg.update({ mcpServers: mcpServers as never });
  return cfg;
}

describe('McpManager over stdio', () => {
  test('lists tools with readOnly from annotations and calls a tool', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER] } });
    const mgr = new McpManager(cfg);
    try {
      const tools = await mgr.tools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['mcp__echo__echo', 'mcp__echo__write_note']);
      const echo = tools.find((t) => t.name === 'mcp__echo__echo')!;
      expect(echo.readOnly).toBe(true);
      expect(tools.find((t) => t.name === 'mcp__echo__write_note')!.readOnly).toBe(false);
      expect(echo.inputSchema.properties?.text).toBeDefined();

      const result = await mgr.callTool('echo', 'echo', { text: 'hi' });
      expect(result.content).toBe('echo: hi');
      expect(result.isError).toBeFalsy();

      const status = mgr.status();
      expect(status.find((s) => s.name === 'echo')?.status).toBe('connected');
      expect(status.find((s) => s.name === 'echo')?.tools).toBe(2);
    } finally {
      await mgr.shutdown();
    }
  });

  test('restart, test and serverTools for the MCP servers page', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER] } });
    const mgr = new McpManager(cfg);
    try {
      const tools = await mgr.serverTools('echo');
      expect(tools.map((t) => t.fullName).sort()).toEqual(['mcp__echo__echo', 'mcp__echo__write_note']);
      const res = await mgr.test('echo');
      expect(res.ok).toBe(true);
      expect(res.tools).toBe(2);
      expect((await mgr.restart('echo'))?.status).toBe('connected');
    } finally {
      await mgr.shutdown();
    }
  });

  test('respects the tools allowlist', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER], tools: ['echo'] } });
    const mgr = new McpManager(cfg);
    try {
      const tools = await mgr.tools();
      expect(tools.map((t) => t.name)).toEqual(['mcp__echo__echo']);
    } finally {
      await mgr.shutdown();
    }
  });

  test('reads every page of a paged tool list', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER], env: { PAGED: '1' } } });
    const mgr = new McpManager(cfg);
    try {
      const tools = await mgr.tools();
      expect(tools.map((t) => t.name).sort()).toEqual(['mcp__echo__echo', 'mcp__echo__write_note']);
    } finally {
      await mgr.shutdown();
    }
  });

  test('a server turned back on, or with a changed command, connects again', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER] } });
    const mgr = new McpManager(cfg);
    try {
      await mgr.tools();
      expect(mgr.status().find((s) => s.name === 'echo')?.status).toBe('connected');

      cfg.update({ mcpServers: { echo: { command: 'bun', args: [SERVER], enabled: false } } as never });
      expect(mgr.status().find((s) => s.name === 'echo')?.status).toBe('disabled');

      cfg.update({ mcpServers: { echo: { command: 'bun', args: [SERVER], enabled: true } } as never });
      expect(mgr.status().find((s) => s.name === 'echo')?.status).not.toBe('disabled');
      expect((await mgr.tools()).length).toBe(2);
      expect(mgr.status().find((s) => s.name === 'echo')?.status).toBe('connected');

      cfg.update({ mcpServers: { echo: { command: 'no-such-binary-for-conclave', args: [] } } as never });
      expect(mgr.status().find((s) => s.name === 'echo')?.tools).toBe(0);
      await mgr.tools();
      const st = mgr.status().find((s) => s.name === 'echo');
      expect(st?.status).toBe('failed');
      expect(st?.error).toBeTruthy();
    } finally {
      await mgr.shutdown();
    }
  });

  test('a config change while connecting drops the old attempt', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER] } });
    const mgr = new McpManager(cfg);
    try {
      const first = mgr.ensure('echo');
      cfg.update({ mcpServers: { echo: { command: 'no-such-binary-for-conclave', args: [] } } as never });
      await first.catch(() => undefined);
      await mgr.ensure('echo').catch(() => undefined);
      const st = mgr.status().find((s) => s.name === 'echo');
      expect(st?.status).toBe('failed');
      expect(st?.error).toContain('no-such-binary-for-conclave');
    } finally {
      await mgr.shutdown();
    }
  });

  test('disabled server is reported and not connected', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER], enabled: false } });
    const mgr = new McpManager(cfg);
    try {
      const tools = await mgr.tools();
      expect(tools.length).toBe(0);
      expect(mgr.status().find((s) => s.name === 'echo')?.status).toBe('disabled');
    } finally {
      await mgr.shutdown();
    }
  });

  test('tool.run routes through the server', async () => {
    const cfg = configWith({ echo: { command: 'bun', args: [SERVER] } });
    const mgr = new McpManager(cfg);
    try {
      const tools = await mgr.tools();
      const echo = tools.find((t) => t.name === 'mcp__echo__echo')!;
      const out = await echo.run({ text: 'via run' }, {} as never);
      expect(out.content).toBe('echo: via run');
    } finally {
      await mgr.shutdown();
    }
  });
});
