import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

describe('agent defaults', () => {
  test('GET /api/agents/:name/default returns the shipped markdown, 404 for other names', async () => {
    const ok = await json(await hub.api('/api/agents/coder/default'));
    expect(ok.status).toBe(200);
    expect(ok.body.markdown).toContain('name: coder');
    expect(ok.body.agent.name).toBe('coder');
    expect(ok.body.overridden).toBe(false);
    const missing = await json(await hub.api('/api/agents/someone/default'));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('not a built-in agent');
  });
});

describe('extensions area', () => {
  test('overview, inventory and sources pass cwd and kind through', async () => {
    expect((await json(await hub.api('/api/extensions/overview?cwd=/repo&device=local'))).body.counts.tools).toBe(30);
    expect(hub.engine.calls.find((c) => c.method === 'extensionsOverview')?.args).toEqual(['/repo', 'local']);
    expect((await json(await hub.api('/api/extensions/inventory?kind=agent'))).body[0].kind).toBe('agent');
    expect((await hub.api('/api/extensions/inventory?kind=plugin')).status).toBe(400);
    expect((await json(await hub.api('/api/extensions/sources'))).body[0].id).toBe('builtin');
  });

  test('GET /api/tools returns the detailed list; POST /api/tools/check validates', async () => {
    const tools = await json(await hub.api('/api/tools?cwd=/repo&agent=assistant'));
    expect(tools.body[0]).toMatchObject({ name: 'Bash', kind: 'builtin', permission: { decision: 'ask' } });
    expect(hub.engine.calls.find((c) => c.method === 'toolsDetail')?.args[0]).toEqual({ cwd: '/repo', agent: 'assistant' });
    const check = await json(await hub.api('/api/tools/check', { method: 'POST', json: { tool: 'Bash', input: { command: 'ls' } } }));
    expect(check.body).toMatchObject({ decision: 'ask', dangerous: false });
    expect((await hub.api('/api/tools/check', { method: 'POST', json: { tool: 'Bash', input: [] } })).status).toBe(400);
    expect((await hub.api('/api/tools/check', { method: 'POST', json: { tool: 'Nope' } })).status).toBe(404);
  });

  test('hooks: overview, test run, save, import', async () => {
    expect((await json(await hub.api('/api/hooks?cwd=/repo'))).body.events[0].event).toBe('PreToolUse');
    const run = await json(await hub.api('/api/hooks/test', { method: 'POST', json: { event: 'PreToolUse', input: { tool_name: 'Bash' } } }));
    expect(run.body.modelWouldSee).toContain('No change');
    expect((await hub.api('/api/hooks/test', { method: 'POST', json: { event: 'Nope' } })).status).toBe(400);
    expect((await hub.api('/api/hooks', { method: 'PUT', json: { scope: 'team', hooks: {} } })).status).toBe(400);
    const saved = await hub.api('/api/hooks', { method: 'PUT', json: { scope: 'user', hooks: { Stop: [] } } });
    expect(saved.status).toBe(200);
    expect(hub.engine.calls.find((c) => c.method === 'saveHooks')?.args[0]).toEqual({ scope: 'user', cwd: undefined, hooks: { Stop: [] } });
    expect((await json(await hub.api('/api/hooks/import', { method: 'POST', json: { from: 'gemini' } }))).body.skipped).toEqual([]);
    expect((await hub.api('/api/hooks/import', { method: 'POST', json: { from: 'vim' } })).status).toBe(400);
  });

  test('project trust needs an absolute cwd and is audited', async () => {
    expect((await hub.api('/api/trust')).status).toBe(400);
    const set = await json(await hub.api('/api/trust', { method: 'POST', json: { cwd: '/home/me/ctf', trusted: true } }));
    expect(set.body.trusted).toBe(true);
    expect((await json(await hub.api('/api/trust?cwd=/home/me/ctf'))).body.trusted).toBe(true);
    expect((await hub.api('/api/trust', { method: 'POST', json: { cwd: 'relative', trusted: true } })).status).toBe(400);
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'trust.add' && a.detail === '/home/me/ctf')).toBe(true);
  });

  test('plugins and marketplace search', async () => {
    expect((await hub.api('/api/plugins/nope')).status).toBe(404);
    expect((await hub.api('/api/plugins/nope/update', { method: 'POST' })).status).toBe(404);
    const search = await json(await hub.api('/api/marketplace/search?q=hook&category=dev'));
    expect(search.body).toEqual({ marketplaces: [], results: [] });
    expect(hub.engine.calls.find((c) => c.method === 'searchMarketplace')?.args[0]).toEqual({ q: 'hook', category: 'dev', marketplace: undefined });
  });

  test('MCP servers: add, restart, tools, call, connect plan, update, remove', async () => {
    const add = await json(await hub.api('/api/mcp', { method: 'POST', json: { name: 'memory', config: { command: 'uvx', args: ['basic-memory', 'mcp'] } } }));
    expect(add.body).toMatchObject({ name: 'memory', origin: 'config' });
    expect((await hub.api('/api/mcp', { method: 'POST', json: { name: 'memory', config: { command: 'x' } } })).status).toBe(409);
    expect((await hub.api('/api/mcp', { method: 'POST', json: { name: 'p', config: { command: 'x' }, scope: 'project' } })).status).toBe(400);

    expect((await json(await hub.api('/api/mcp/memory/restart', { method: 'POST' }))).body.status).toBe('connected');
    expect((await json(await hub.api('/api/mcp/memory/test', { method: 'POST' }))).body.ok).toBe(true);
    expect((await json(await hub.api('/api/mcp/memory/tools'))).body[0].fullName).toBe('mcp__memory__echo');
    expect((await json(await hub.api('/api/mcp/memory/call', { method: 'POST', json: { tool: 'echo', args: { text: 'x' } } }))).body.content).toBe('called echo');
    expect((await hub.api('/api/mcp/memory/call', { method: 'POST', json: { tool: 'echo', args: 'x' } })).status).toBe(400);
    expect((await hub.api('/api/mcp/ghost/restart', { method: 'POST' })).status).toBe(404);

    const plan = await json(await hub.api('/api/mcp/memory/connect'));
    expect(plan.body.map((s: { cli: string }) => s.cli)).toEqual(['claude', 'codex', 'opencode', 'gemini']);
    expect(plan.body[1].command).toBe('codex mcp add memory -- uvx basic-memory mcp');
    const ran = await json(await hub.api('/api/mcp/memory/connect', { method: 'POST', json: { device: 'local', clis: ['claude'] } }));
    expect(ran.body).toEqual([{ cli: 'claude', exitCode: 0, stdout: 'ok', stderr: '' }]);
    expect((await hub.api('/api/mcp/memory/connect', { method: 'POST', json: { clis: ['vim'] } })).status).toBe(400);
    expect((await hub.api('/api/mcp/memory/connect', { method: 'POST', json: { device: 'nowhere', clis: ['claude'] } })).status).toBe(404);

    expect((await json(await hub.api('/api/mcp/memory', { method: 'PATCH', json: { enabled: false } }))).body.enabled).toBe(false);
    expect((await hub.api('/api/mcp/memory', { method: 'PATCH', json: { enabled: 'no' } })).status).toBe(400);
    expect((await hub.api('/api/mcp/memory', { method: 'DELETE' })).status).toBe(200);
    expect((await hub.api('/api/mcp/memory', { method: 'DELETE' })).status).toBe(404);
  });

  test('MCP import parses another CLI config for a preview', async () => {
    const text = JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer ${GH_TOKEN}' } } } });
    const res = await json(await hub.api('/api/mcp/import', { method: 'POST', json: { from: 'claude', text } }));
    expect(res.body.gh).toEqual({ type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer ${env:GH_TOKEN}' } });
    expect((await hub.api('/api/mcp/import', { method: 'POST', json: { from: 'emacs', text } })).status).toBe(400);
  });

  test('sync-clis takes only and dryRun', async () => {
    const res = await json(await hub.api('/api/sync-clis', { method: 'POST', json: { only: ['opencode'], dryRun: true } }));
    expect(res.body).toEqual({ ok: true, written: ['~/.claude/agents/x.md'], dryRun: true });
    expect(hub.engine.calls.filter((c) => c.method === 'syncToClis').pop()?.args).toEqual([undefined, { only: ['opencode'], dryRun: true }]);
    expect((await hub.api('/api/sync-clis', { method: 'POST', json: { only: ['vim'] } })).status).toBe(400);
  });

  test('sync-clis says a known device is offline', async () => {
    hub.engine.repos.devices.insert({ id: 'pve', name: 'pve', tokenHash: 'x' });
    const res = await hub.api('/api/sync-clis', { method: 'POST', json: { device: 'pve', dryRun: true } });
    expect(res.status).toBe(409);
    expect((await json(res)).body.error).toBe('device pve is offline');
  });
});

describe('plugin hooks switch', () => {
  test('PATCH /api/plugins/:name turns one plugin\'s hooks off and on, and checks the body', async () => {
    const ext = hub.engine.extensions as unknown as Record<string, unknown>;
    const calls: Array<[string, boolean]> = [];
    const saved = { plugins: ext.plugins, setPluginHooks: ext.setPluginHooks };
    ext.plugins = () => [{ name: 'ponytail', dir: '/x', manifest: { name: 'ponytail' }, enabled: true, source: 'ponytail@ponytail', installedAt: 1 }];
    ext.setPluginHooks = async (name: string, on: boolean) => void calls.push([name, on]);
    try {
      expect((await hub.api('/api/plugins/ponytail', { method: 'PATCH', json: { hooks: false } })).status).toBe(200);
      expect((await hub.api('/api/plugins/ponytail', { method: 'PATCH', json: { hooks: true } })).status).toBe(200);
      expect(calls).toEqual([['ponytail', false], ['ponytail', true]]);
      expect((await hub.api('/api/plugins/ponytail', { method: 'PATCH', json: { hooks: 'off' } })).status).toBe(400);
      expect((await hub.api('/api/plugins/ponytail', { method: 'PATCH', json: {} })).status).toBe(400);
      expect((await hub.api('/api/plugins/nope', { method: 'PATCH', json: { hooks: false } })).status).toBe(404);
      // enabled alone still works as before
      expect((await hub.api('/api/plugins/ponytail', { method: 'PATCH', json: { enabled: false } })).status).toBe(200);
    } finally {
      ext.plugins = saved.plugins;
      ext.setPluginHooks = saved.setPluginHooks;
    }
  });
});

describe('skills agents wrote', () => {
  test('list, read, edit within the rules, turn off and on, delete', async () => {
    const { LearnedSkills } = await import('@conclave/core/extensions/learned.ts');
    const s = await hub.engine.createSession({ title: 'Restore drill' });
    new LearnedSkills(hub.engine.config.paths.home).create({ name: 'pbs-restore-test', description: 'Test that a PBS backup restores.', body: '1. Restore into a throwaway LXC.\n', sessionId: s.id });

    const list = await json(await hub.api('/api/skills/learned'));
    expect(list.body).toEqual([expect.objectContaining({ name: 'pbs-restore-test', enabled: true, sessionId: s.id, sessionTitle: 'Restore drill' })]);
    expect(list.body[0].body).toBeUndefined();
    expect((await json(await hub.api('/api/skills/learned/pbs-restore-test'))).body.body).toContain('throwaway LXC');
    expect((await hub.api('/api/skills/learned/nope-skill')).status).toBe(404);

    const edited = await json(await hub.api('/api/skills/learned/pbs-restore-test', { method: 'PATCH', json: { body: '1. Restore into LXC 999.\n2. Check the service.\n' } }));
    expect(edited.body.body).toContain('LXC 999');
    const bad = await json(await hub.api('/api/skills/learned/pbs-restore-test', { method: 'PATCH', json: { body: 'Run !`rm -rf ~`' } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('Markdown only');

    expect((await json(await hub.api('/api/skills/learned/pbs-restore-test', { method: 'PATCH', json: { enabled: false } }))).body.enabled).toBe(false);
    expect((await json(await hub.api('/api/skills/learned/pbs-restore-test', { method: 'PATCH', json: { enabled: true } }))).body.enabled).toBe(true);
    expect((await hub.api('/api/skills/learned/pbs-restore-test', { method: 'PATCH', json: { enabled: 'yes' } })).status).toBe(400);
    expect(hub.engine.calls.some((c) => c.method === 'extensions.reload')).toBe(true);

    expect((await json(await hub.api('/api/skills/learned/pbs-restore-test', { method: 'DELETE' }))).body).toEqual({ ok: true });
    expect((await json(await hub.api('/api/skills/learned'))).body).toEqual([]);
    expect((await hub.api('/api/skills/learned/pbs-restore-test', { method: 'DELETE' })).status).toBe(404);
  });
});
