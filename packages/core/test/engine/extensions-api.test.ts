import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { describeOutcome } from '../../src/engine/extensions-api';
import { oauthSecretName } from '../../src/extensions/mcp-oauth';
import { cleanup, tempDir } from '../extensions/_helpers';
import { HOOK_SCRIPT } from './harness';

/** The Extensions area API on a real engine (no model needed). */

let engine: Engine;
let home: string;
let cwd: string;
let claude: string;
let log: string;
const saved = process.env.CLAUDE_CONFIG_DIR;
const ECHO_SERVER = join(import.meta.dir, '..', 'extensions', 'fixtures', 'mcp-echo-server.ts');

beforeAll(async () => {
  home = tempDir('conclave-extapi-');
  cwd = tempDir('conclave-extapi-cwd-');
  claude = tempDir('conclave-extapi-claude-');
  process.env.CLAUDE_CONFIG_DIR = claude;
  log = join(home, 'hooks.log');
  mkdirSync(join(claude, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'agents', 'coder.md'), '---\nname: coder\ndescription: my claude coder\n---\nWrite code.');
  writeFileSync(join(claude, 'agents', 'helper.md'), '---\nname: helper\ndescription: claude helper\n---\nHelp.');
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'agents', 'helper.md'), '---\nname: helper\ndescription: my helper\n---\nHelp more.');
  engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: `HOOK_LOG=${log} bun ${HOOK_SCRIPT} log`, timeout: 30 }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'exit 2', timeout: 5 }] },
        ],
      },
    } as never,
  });
});

afterAll(async () => {
  await engine.shutdown();
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  cleanup(home, cwd, claude);
});

describe('overview, inventory, sources', () => {
  test('a Claude agent shadowed by a user agent is a conflict; replacing a built-in is not', async () => {
    const inv = engine.extensionsInventory(undefined, 'agent');
    const helper = inv.filter((i) => i.name === 'helper');
    expect(helper.map((i) => [i.source, i.active])).toEqual([
      ['claude', false],
      ['user', true],
    ]);
    expect(helper[0].shadowedBy).toBe('user');
    const ov = await engine.extensionsOverview();
    expect(ov.problems.filter((p) => p.kind === 'conflict').map((p) => p.name)).toEqual(['helper']);
    expect(ov.counts.hookHandlers).toBe(2);
    expect(ov.counts.agents).toBe(engine.extensions.agents().length);
    expect(ov.compat.claudeCode).toBe(true);
    expect(Object.keys(ov.clis).sort()).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });

  test('sources are listed low to high precedence with counts and toggles', () => {
    const src = engine.extensionSources(cwd);
    expect(src.map((s) => s.id)).toEqual(['builtin', 'agents', 'codex', 'opencode', 'gemini', 'claude', 'plugin', 'user', 'project']);
    // 12 general agents, the 12 specialists (ROUND-IMPORT-PATHS-WORKFLOWS.md 4.3) and the email agent (Calendar and mail)
    expect(src.find((s) => s.id === 'builtin')!.counts.agents).toBe(25);
    expect(src.find((s) => s.id === 'claude')).toMatchObject({ on: true, toggle: 'claudeCode', counts: { agents: 2 } });
    expect(src.find((s) => s.id === 'codex')!.on).toBe(false);
  });
});

describe('hooks', () => {
  test('overview lists every event in order with the config groups', () => {
    const ov = engine.hooksOverview();
    expect(ov.events.map((e) => e.event)).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
      'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Stop', 'SessionEnd',
    ]);
    expect(ov.events.every((e) => e.fires)).toBe(true);
    const pre = ov.events.find((e) => e.event === 'PreToolUse')!;
    expect(pre.groups.map((g) => [g.matcher, g.source, g.index, g.editable])).toEqual([
      ['Bash', 'config', 0, true],
      ['Write', 'config', 1, true],
    ]);
  });

  test('a test run uses the real runner, can be limited to one group, and says what the model would see', async () => {
    const run = await engine.testHook({ event: 'PreToolUse', input: { tool_name: 'Write', tool_input: { file_path: 'a' } } });
    expect(run.blocked).toBe(true);
    expect(run.trace.map((t) => t.result)).toEqual(['block']);
    expect(run.modelWouldSee).toBe('Blocked. The model would see: Blocked by hook: hook PreToolUse blocked (exit 2)');
    const bashOnly = await engine.testHook({ event: 'PreToolUse', input: { tool_name: 'Bash', tool_input: { command: 'ls' } }, only: { source: 'config', index: 0 } });
    expect(bashOnly.blocked).toBe(false);
    expect(readFileSync(log, 'utf8')).toContain('"session_id":"test"');
    // the run shows up in the recent list of the overview
    expect(engine.hooksOverview().events.find((e) => e.event === 'PreToolUse')!.last.length).toBeGreaterThanOrEqual(2);
    await expect(engine.testHook({ event: 'Nope' as never })).rejects.toThrow('event must be one of');
  });

  test('describeOutcome for Stop and PermissionRequest', () => {
    expect(describeOutcome('Stop', { blocked: true, reason: 'run the tests', additionalContext: [], systemMessages: [] })).toBe('The agent would keep going with: Stop hook feedback:\nrun the tests');
    expect(describeOutcome('PermissionRequest', { blocked: false, permissionDecision: 'allow', additionalContext: [], systemMessages: [] })).toBe('Approved for you; no prompt is shown.');
  });

  test('save hooks at project scope writes .conclave/settings.json and keeps other keys; bad input is a 400', () => {
    const dir = join(cwd, '.conclave');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
    engine.saveHooks({ scope: 'project', cwd, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }], SessionEnd: [] } });
    const file = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(file).toEqual({ permissions: { deny: ['Bash(rm *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } });
    // untrusted folder: listed, not active
    const stop = engine.hooksOverview(cwd).events.find((e) => e.event === 'Stop')!;
    expect(stop.groups).toMatchObject([{ source: 'project', active: false, editable: true }]);
    // settings.local.json is not written by saveHooks, so its hooks are read-only here
    writeFileSync(join(dir, 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo local' }] }] } }));
    expect(engine.hooksOverview(cwd).events.find((e) => e.event === 'Stop')!.groups.map((g) => g.editable)).toEqual([true, false]);
    rmSync(join(dir, 'settings.local.json'));
    expect(() => engine.saveHooks({ scope: 'project', cwd, hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } as never })).toThrow('command is required');
    expect(() => engine.saveHooks({ scope: 'user', hooks: { Later: [] } as never })).toThrow('unknown hook event Later');
    // a relative folder would be written next to wherever the hub was started
    expect(() => engine.saveHooks({ scope: 'project', cwd: 'code/app', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } })).toThrow('must be a full path');
  });

  test('save hooks at user scope replaces config.json hooks', () => {
    const before = engine.config.getUser().hooks;
    engine.saveHooks({ scope: 'user', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }] } });
    expect(engine.config.getUser().hooks).toEqual({ SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }] });
    engine.saveHooks({ scope: 'user', hooks: before ?? {} });
  });
});

describe('trust', () => {
  test('trusting a folder covers its subfolders and is reported', () => {
    expect(engine.projectTrust(cwd)).toMatchObject({ trusted: false, hooks: 1 });
    engine.setProjectTrust(cwd, true);
    expect(engine.projectTrust(join(cwd, 'sub', 'dir')).trusted).toBe(true);
    expect(engine.hooksOverview(cwd).events.find((e) => e.event === 'Stop')!.groups[0].active).toBe(true);
    engine.setProjectTrust(cwd, false);
    expect(engine.projectTrust(cwd).trusted).toBe(false);
    expect(() => engine.setProjectTrust('relative/path', true)).toThrow('absolute path');
  });
});

describe('tool check', () => {
  test('dangerous commands always ask; read-only commands are allowed; unknown tools are 404', async () => {
    const rm = await engine.checkTool({ tool: 'Bash', input: { command: 'rm -rf /' } });
    expect(rm).toMatchObject({ decision: 'ask', dangerous: 'Potentially destructive command', hooks: 1 });
    expect((await engine.checkTool({ tool: 'Read', input: { file_path: join(cwd, 'x') } })).decision).toBe('allow');
    expect((await engine.checkTool({ tool: 'Write', input: { file_path: join(cwd, 'x'), content: '' }, mode: 'plan' })).decision).toBe('deny');
    await expect(engine.checkTool({ tool: 'Nope' })).rejects.toThrow('unknown tool Nope');
  });
});

describe('MCP servers', () => {
  test('add, list with origin, tools, call, connect plan, disable, remove', async () => {
    const st = engine.addMcpServer('echo', { command: 'bun', args: [ECHO_SERVER] });
    expect(st).toMatchObject({ name: 'echo', origin: 'config', transport: 'stdio', enabled: true });
    expect(() => engine.addMcpServer('echo', { command: 'x' })).toThrow('already exists');
    expect(() => engine.addMcpServer('bad name', { command: 'x' })).toThrow('name must be');
    expect(() => engine.addMcpServer('nourl', {} as never)).toThrow('needs a command');

    const tools = await engine.mcpServerTools('echo');
    expect(tools.map((t) => [t.fullName, t.readOnly])).toEqual([
      ['mcp__echo__echo', true],
      ['mcp__echo__write_note', false],
    ]);
    expect(await engine.callMcpTool('echo', 'echo', { text: 'yo' })).toEqual({ content: 'echo: yo', isError: undefined });
    const tested = await engine.testMcp('echo');
    expect(tested).toMatchObject({ ok: true, tools: 2 });

    const plan = engine.mcpConnectPlan('echo');
    expect(plan.find((s) => s.cli === 'codex')!.command).toBe(`codex mcp add echo -- bun ${ECHO_SERVER}`);

    expect(engine.updateMcpServer('echo', { enabled: false }).status).toBe('disabled');
    expect(engine.config.getUser().mcpServers?.echo?.enabled).toBe(false);
    await expect(engine.mcpServerTools('echo')).rejects.toThrow('disabled');
    expect(engine.removeMcpServer('echo')).toBe(true);
    expect(engine.removeMcpServer('echo')).toBe(false);
    await expect(engine.restartMcp('echo')).rejects.toThrow('unknown mcp server echo');
  }, 30_000);

  test('an OAuth sign-in is forgotten when the URL or auth changes, and on remove', () => {
    const secret = oauthSecretName('notes');
    const signedIn = () => engine.config.setSecret('values', secret, 'enc:v1:stand-in');
    engine.addMcpServer('notes', { type: 'http', url: 'https://mcp.example/mcp', auth: 'oauth', enabled: false });
    signedIn();
    engine.updateMcpServer('notes', { enabled: false });
    expect(engine.config.secretValue(secret)).toBe('enc:v1:stand-in');
    engine.updateMcpServer('notes', { config: { type: 'http', url: 'https://other.example/mcp', auth: 'oauth', enabled: false } });
    expect(engine.config.secretValue(secret)).toBeUndefined();
    signedIn();
    engine.updateMcpServer('notes', { config: { type: 'http', url: 'https://other.example/mcp', enabled: false } });
    expect(engine.config.secretValue(secret)).toBeUndefined();
    signedIn();
    expect(engine.removeMcpServer('notes')).toBe(true);
    expect(engine.config.secretValue(secret)).toBeUndefined();
  });

  test('connect plans warn when a value is a Conclave secret', () => {
    engine.addMcpServer('homelab', { type: 'http', url: 'https://madx.example/mcp', headers: { Authorization: 'Bearer ${secret:homelab-token}' } });
    const plan = engine.mcpConnectPlan('homelab');
    expect(plan.every((s) => s.note?.includes('cannot read Conclave secrets'))).toBe(true);
    expect(engine.removeMcpServer('homelab')).toBe(true);
  });

  test('import from each CLI format', () => {
    expect(engine.importMcp('codex', '[mcp_servers.bm]\ncommand = "uvx"\nargs = ["basic-memory", "mcp"]\n')).toEqual({ bm: { command: 'uvx', args: ['basic-memory', 'mcp'] } });
    expect(engine.importMcp('opencode', JSON.stringify({ mcp: { bm: { type: 'local', command: ['uvx', 'basic-memory', 'mcp'] } } }))).toEqual({ bm: { command: 'uvx', args: ['basic-memory', 'mcp'] } });
    expect(engine.importMcp('gemini', JSON.stringify({ mcpServers: { r: { url: 'http://madx:8000/mcp', type: 'http' } } }))).toEqual({ r: { url: 'http://madx:8000/mcp', type: 'http' } });
    expect(() => engine.importMcp('claude', '{nope')).toThrow('could not read the claude config');
  });
});

describe('memory connections', () => {
  test('connect plan for an MCP-based store, and a clear error for others', () => {
    engine.memoryAdmin.addConnection({ type: 'basic-memory', name: 'Notes', mode: 'mirror', options: {} });
    // a Basic Memory on the hub runs as the hub's basic-memory server, and the CLIs get it under that name, as agents do
    expect(engine.config.get().mcpServers['basic-memory']).toEqual({ command: 'uvx', args: ['basic-memory', 'mcp'] });
    const plan = engine.memoryConnectPlan('notes');
    expect(plan.find((s) => s.cli === 'codex')!.command).toBe('codex mcp add basic-memory -- uvx basic-memory mcp');
    engine.memoryAdmin.addConnection({ type: 'http', name: 'Web', options: { url: 'http://127.0.0.1:9/x' } });
    expect(() => engine.memoryConnectPlan('web')).toThrow('is not an MCP server');
    expect(engine.memoryAdmin.listConnections().map((c) => c.id)).toEqual(['notes', 'web']);
    // the default knowledge graph server keeps its file, so other CLIs share the same graph
    engine.memoryAdmin.addConnection({ type: 'mcp', name: 'Graph', options: { preset: 'knowledge-graph', env: { MEMORY_FILE_PATH: '/data/graph.jsonl' } } });
    const graph = engine.memoryConnectPlan('graph');
    expect(graph.find((s) => s.cli === 'codex')!.command).toBe("codex mcp add graph --env MEMORY_FILE_PATH=/data/graph.jsonl -- npx -y @modelcontextprotocol/server-memory");
    expect(graph.find((s) => s.cli === 'claude')!.snippet).toContain('MEMORY_FILE_PATH');
  });
});

describe('sync to CLIs', () => {
  test('dry run lists files and writes nothing', async () => {
    await engine.extensions.saveAgent({ name: 'homelab', description: 'Homelab helper', prompt: 'Help with the homelab.', source: 'user' }, 'user');
    const files = await engine.syncToClis(undefined, { only: ['opencode'], dryRun: true });
    const agentFile = files.find((f) => f.endsWith('/.config/opencode/agent/homelab.md'))!;
    expect(agentFile).toBeDefined();
    expect(existsSync(agentFile)).toBe(false);
    await expect(engine.syncToClis(undefined, { only: ['vim' as never] })).rejects.toThrow('only must list');
  });
});
