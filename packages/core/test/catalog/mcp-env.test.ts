/**
 * McpManager changes the catalog needs (docs/design/ECOSYSTEM.md 1.8): a
 * stdio server gets only the env allowlist plus its own env, placeholders
 * expand in args, and cwd is honoured. Errors never quote a secret.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { ConfigStore } from '../../src/config';
import { McpManager } from '../../src/extensions/mcp';
import { cleanupAll, tmp } from './helpers';

afterEach(cleanupAll);

const SERVER = join(import.meta.dir, 'fixtures', 'servers', 'env-server.ts');

describe('stdio MCP servers', () => {
  test('provider keys stay on the hub; secrets expand in args; cwd is used', async () => {
    const home = tmp('conclave-catalog-');
    const work = tmp('conclave-catalog-');
    const cfg = new ConfigStore(home);
    cfg.setSecret('values', 'demo-dsn', 'postgres://u:pw@db/x');
    cfg.update({ mcpServers: { envs: { command: process.execPath, args: [SERVER, '--dsn', '${secret:demo-dsn}'], env: { OWN_VALUE: 'mine' }, cwd: work } } as never });
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-should-not-pass';
    const mgr = new McpManager(cfg);
    try {
      const out = await mgr.callTool('envs', 'env', {});
      const r = JSON.parse(String(out.content));
      expect(r.argv).toEqual(['--dsn', 'postgres://u:pw@db/x']);
      expect(realpathSync(r.cwd)).toBe(realpathSync(work));
      expect(r.own).toBe('mine');
      expect(r.env).not.toContain('ANTHROPIC_API_KEY');
      expect(r.env).toContain('PATH');
    } finally {
      await mgr.shutdown();
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test('a failed connect does not quote the secret from the url', async () => {
    const home = tmp('conclave-catalog-');
    const cfg = new ConfigStore(home);
    cfg.setSecret('values', 'tok', 'supersecret-token-123');
    cfg.update({ mcpServers: { remote: { type: 'http', url: 'http://127.0.0.1:9/mcp?key=${secret:tok}' } } as never });
    const mgr = new McpManager(cfg);
    const res = await mgr.test('remote');
    expect(res.ok).toBe(false);
    expect(res.error ?? '').not.toContain('supersecret-token-123');
    await mgr.shutdown();
  });
});
