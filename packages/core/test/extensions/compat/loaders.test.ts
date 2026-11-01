import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ConfigStore } from '../../../src/config';
import { Extensions } from '../../../src/extensions/registry';
import { PluginManager } from '../../../src/extensions/plugins';
import { defaultModelMapper } from '../../../src/extensions/loader';
import { expandCommand } from '../../../src/extensions/commands';
import {
  hooksFromCodex,
  hooksFromGemini,
  loadCodexAgents,
  loadCodexPrompts,
  loadGeminiAgents,
  loadGeminiCommands,
  loadOpenCodeAgents,
  loadOpenCodeCommands,
  mcpFromClaude,
  mcpFromCodexToml,
  mcpFromGemini,
  mcpFromOpenCode,
  mcpToClaude,
  mcpToCodexToml,
  mcpToGemini,
  mcpToOpenCode,
  opencodePermissionToTools,
} from '../../../src/extensions/compat';
import { FakeMachine, tempDir, cleanup, write } from '../_helpers';

/** These tests cover expansion; engine/command-shell.test.ts covers the permission check. */
const permit = async () => undefined;

const dirs: string[] = [];
const savedClaude = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  cleanup(...dirs.splice(0));
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
});
function td(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}
const map = defaultModelMapper('anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5');

describe('Codex', () => {
  test('custom prompts load as prompts:<name> with one-based $1', async () => {
    const dir = td();
    write(join(dir, 'review.md'), `---\ndescription: Review a file\nargument-hint: FILE\n---\nReview $1 then $2. All: $ARGUMENTS. Price: $$5`);
    const [c] = loadCodexPrompts(dir, map);
    expect(c.name).toBe('prompts:review');
    expect(c.argStyle).toBe('numbered');
    expect(c.source).toBe('codex');
    const out = await expandCommand(c, 'a.ts b.ts', { machine: new FakeMachine({ home: td() }), cwd: dir, permit });
    expect(out).toBe('Review a.ts then b.ts. All: a.ts b.ts. Price: $5');
  });

  test('agent role TOML maps like Codex importer in reverse; missing description is skipped', () => {
    const dir = td();
    write(join(dir, 'reviewer.toml'), `name = "reviewer"\ndescription = "Reviews diffs"\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\nsandbox_mode = "read-only"\ndeveloper_instructions = """You review code."""\n`);
    write(join(dir, 'nested', 'worker.toml'), `description = "Does work"\nsandbox_mode = "workspace-write"\n`);
    write(join(dir, 'bad.toml'), `name = "bad"\n`);
    const agents = loadCodexAgents(dir, map);
    const by = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(Object.keys(by).sort()).toEqual(['reviewer', 'worker']);
    expect(by.reviewer.prompt).toBe('You review code.');
    expect(by.reviewer.model).toBe('openai/gpt-5.5');
    expect(by.reviewer.thinking).toBe('xhigh');
    expect(by.reviewer.disallowedTools).toContain('Edit');
    expect(by.worker.permissionMode).toBe('acceptEdits');
    expect(by.worker.subagent).toBe(true);
  });
});

describe('OpenCode', () => {
  test('agents: nested names, permission map to tools, mode, model rename, hex colour only', () => {
    const dir = td();
    write(join(dir, 'sec', 'audit.md'), `---\ndescription: Audits\nmode: subagent\nmodel: zai-coding-plan/glm-4.6\ncolor: "#3366ff"\npermission:\n  "*": deny\n  read: allow\n  grep: allow\n  bash:\n    "*": ask\n    "git diff*": allow\n---\nYou audit.`);
    write(join(dir, 'builder.md'), `---\ndescription: Builds\nmode: primary\ncolor: blue\ntools:\n  webfetch: false\n---\nYou build.`);
    const agents = loadOpenCodeAgents(dir, map);
    const by = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(by['sec/audit'].tools?.sort()).toEqual(['Bash', 'Grep', 'Read']);
    expect(by['sec/audit'].subagent).toBe(true);
    expect(by['sec/audit'].primary).toBe(false);
    expect(by['sec/audit'].model).toBe('zai/glm-4.6');
    expect(by['sec/audit'].color).toBe('#3366ff');
    expect(by.builder.disallowedTools).toEqual(['WebFetch']);
    expect(by.builder.color).toBeUndefined();
    expect(by.builder.primary).toBe(true);
    expect(by.builder.source).toBe('opencode');
  });

  test('permission edge cases', () => {
    expect(opencodePermissionToTools('deny', undefined)).toEqual({ tools: [] });
    expect(opencodePermissionToTools({ edit: 'deny' }, undefined).disallowedTools?.sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
    expect(opencodePermissionToTools(undefined, undefined)).toEqual({});
  });

  test('commands: path names and OpenCode argument rules', async () => {
    const dir = td();
    write(join(dir, 'git', 'commit.md'), `---\ndescription: Commit\nagent: plan\nsubtask: true\n---\nTicket: $1. Notes: $2`);
    write(join(dir, 'plain.md'), `Summarize`);
    const cmds = loadOpenCodeCommands(dir, map);
    const by = Object.fromEntries(cmds.map((c) => [c.name, c]));
    expect(by['git/commit'].agent).toBe('plan');
    expect(by['git/commit'].subtask).toBe(true);
    const ctx = { machine: new FakeMachine({ home: td() }), cwd: dir, permit };
    // The highest placeholder takes the rest.
    expect(await expandCommand(by['git/commit'], 'ABC-1 fix the login bug', ctx)).toBe('Ticket: ABC-1. Notes: fix the login bug');
    // No placeholder: the args are appended after a blank line.
    expect(await expandCommand(by.plain, 'this file', ctx)).toBe('Summarize\n\nthis file');
  });
});

describe('Gemini CLI', () => {
  test('TOML commands: colon names, {{args}}, !{} with quoted args, @{file}, append rule', async () => {
    const dir = td();
    const cwd = td();
    write(join(cwd, 'guide.md'), 'STYLE GUIDE');
    write(join(dir, 'git', 'commit.toml'), `description = "Commit"\nprompt = """\nMessage for {{args}}:\n!{echo {{args}}}\nStyle: @{guide.md}\n"""\n`);
    write(join(dir, 'sync.toml'), `prompt = "Sync now"\n`);
    write(join(dir, 'broken.toml'), `description = "no prompt"\n`);
    const cmds = loadGeminiCommands(dir);
    const by = Object.fromEntries(cmds.map((c) => [c.name, c]));
    expect(Object.keys(by).sort()).toEqual(['git:commit', 'sync']);
    const ctx = { machine: new FakeMachine({ home: td() }), cwd, permit };
    const out = await expandCommand(by['git:commit'], "it's done", ctx);
    expect(out).toContain("Message for it's done:");
    expect(out).toContain("\nit's done\n"); // shell-quoted inside !{}, so the quote survived
    expect(out).toContain('guide.md:\n\nSTYLE GUIDE');
    expect(await expandCommand(by.sync, 'a b', ctx)).toBe('Sync now\n\n/sync a b');
  });

  test('agents map Gemini tool names', () => {
    const dir = td();
    write(join(dir, 'pve-auditor.md'), `---\nname: pve-auditor\ndescription: Audits Proxmox\nkind: local\ntools: [read_file, grep_search, run_shell_command, "mcp_pve_*"]\nmodel: gemini-3-flash-preview\n---\nAudit.`);
    const [a] = loadGeminiAgents(dir, map);
    expect(a.tools?.sort()).toEqual(['Bash', 'Grep', 'Read']);
    expect(a.model).toBe('google/gemini-3-flash-preview');
    expect(a.source).toBe('gemini');
  });
});

describe('registry with compat flags', () => {
  function setup(flags: { codex?: boolean; opencode?: boolean; gemini?: boolean }) {
    const home = td();
    const claude = td();
    process.env.CLAUDE_CONFIG_DIR = claude;
    const H = { agents: join(home, 'agents-home'), codex: join(home, 'codex'), opencode: join(home, 'opencode'), gemini: join(home, 'gemini') };
    const config = new ConfigStore(join(home, 'conclave'));
    config.update({ compat: { ...config.get().compat, ...flags } });
    const ext = new Extensions({ config, plugins: new PluginManager({ dir: join(home, 'plugins'), defaultMarketplaces: [] }), compatHomes: H });
    return { ext, H, claude, config };
  }

  test('nothing loads from other CLIs while the flags are off', () => {
    const { ext, H } = setup({});
    write(join(H.agents, 'skills', 'shared', 'SKILL.md'), `---\nname: shared\ndescription: s\n---\nb`);
    write(join(H.gemini, 'commands', 'x.toml'), `prompt = "x"`);
    ext.reload();
    expect(ext.skill('shared')).toBeUndefined();
    expect(ext.command('x')).toBeUndefined();
  });

  test('flags on: each CLI loads, project folders included, Claude shadows ~/.agents', () => {
    const { ext, H, claude } = setup({ codex: true, opencode: true, gemini: true });
    const cwd = td();
    mkdirSync(join(cwd, '.git'));
    write(join(H.agents, 'skills', 'shared', 'SKILL.md'), `---\nname: shared\ndescription: from agents\n---\nb`);
    write(join(claude, 'skills', 'shared', 'SKILL.md'), `---\nname: shared\ndescription: from claude\n---\nb`);
    write(join(H.codex, 'prompts', 'fix.md'), `Fix $1`);
    write(join(H.codex, 'agents', 'ops.toml'), `description = "Ops"\ndeveloper_instructions = "Run ops"`);
    write(join(cwd, '.agents', 'skills', 'repo-skill', 'SKILL.md'), `---\nname: repo-skill\ndescription: r\n---\nb`);
    write(join(H.opencode, 'agent', 'oc.md'), `---\ndescription: oc\nmode: subagent\n---\nb`);
    write(join(cwd, '.opencode', 'commands', 'deploy.md'), `Deploy $1`);
    write(join(cwd, '.opencode', 'skills', 'group', 'deep', 'SKILL.md'), `---\nname: deep-skill\ndescription: nested\n---\nb`);
    write(join(H.gemini, 'commands', 'git', 'log.toml'), `prompt = "Log {{args}}"`);
    write(join(cwd, '.gemini', 'skills', 'gem', 'SKILL.md'), `---\nname: gem\ndescription: g\n---\nb`);
    ext.reload();

    expect(ext.skill('shared', cwd)?.description).toBe('from claude');
    expect(ext.command('prompts:fix', cwd)?.source).toBe('codex');
    expect(ext.agent('ops', cwd)?.source).toBe('codex');
    expect(ext.skill('repo-skill', cwd)?.source).toBe('agents');
    expect(ext.agent('oc', cwd)?.source).toBe('opencode');
    expect(ext.command('deploy', cwd)?.argStyle).toBe('opencode');
    expect(ext.skill('deep-skill', cwd)?.source).toBe('opencode');
    expect(ext.command('git:log', cwd)?.argStyle).toBe('gemini');
    expect(ext.skill('gem', cwd)?.source).toBe('gemini');

    const inv = ext.inventory(cwd).filter((i) => i.kind === 'skill' && i.name === 'shared');
    expect(inv.map((i) => [i.source, i.active, i.shadowedBy])).toEqual([
      ['agents', false, 'claude user'],
      ['claude', true, undefined],
    ]);
  });

  test('typed command names resolve case-insensitively and skills double as commands', () => {
    const { ext, claude } = setup({});
    write(join(claude, 'commands', 'Deploy.md'), `Deploy now`);
    write(join(claude, 'skills', 'notes', 'SKILL.md'), `---\nname: notes\ndescription: Notes\n---\nTake notes on $ARGUMENTS`);
    ext.reload();
    expect(ext.command('deploy')?.body).toBe('Deploy now');
    const skillCmd = ext.command('notes');
    expect(skillCmd?.body).toContain('Base directory for this skill:');
    expect(skillCmd?.body).toContain('Take notes on $ARGUMENTS');
  });
});

describe('MCP converters', () => {
  test('import from each CLI', () => {
    expect(mcpFromCodexToml(`[mcp_servers.mem]\ncommand = "uvx"\nargs = ["basic-memory", "mcp"]\nenv_vars = ["BASIC_MEMORY_HOME"]\n[mcp_servers.mem.env]\nFOO = "bar"\n\n[mcp_servers.web]\nurl = "https://madx.tail/mcp"\nbearer_token_env_var = "MEM_TOKEN"\nenabled_tools = ["search"]\n`)).toEqual({
      mem: { command: 'uvx', args: ['basic-memory', 'mcp'], env: { FOO: 'bar', BASIC_MEMORY_HOME: '${env:BASIC_MEMORY_HOME}' } },
      web: { url: 'https://madx.tail/mcp', type: 'http', headers: { Authorization: 'Bearer ${env:MEM_TOKEN}' }, tools: ['search'] },
    });
    expect(mcpFromOpenCode({ mcp: { mem: { type: 'local', command: ['uvx', 'basic-memory', 'mcp'], environment: { HOME_DIR: '{env:HOME}' } }, r: { type: 'remote', url: 'https://x/mcp', headers: { Authorization: 'Bearer {env:T}' }, enabled: false } } })).toEqual({
      mem: { command: 'uvx', args: ['basic-memory', 'mcp'], env: { HOME_DIR: '${env:HOME}' } },
      r: { url: 'https://x/mcp', type: 'http', headers: { Authorization: 'Bearer ${env:T}' }, enabled: false },
    });
    expect(mcpFromGemini({ mcpServers: { mem: { command: 'uvx', args: ['basic-memory', 'mcp'], env: { D: '$HOME/notes' } }, h: { httpUrl: 'https://h/mcp', includeTools: ['a'] } } })).toEqual({
      mem: { command: 'uvx', args: ['basic-memory', 'mcp'], env: { D: '${env:HOME}/notes' } },
      h: { url: 'https://h/mcp', type: 'http', tools: ['a'] },
    });
    expect(mcpFromClaude({ mcpServers: { gh: { type: 'http', url: 'https://api/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } } } })).toEqual({
      gh: { type: 'http', url: 'https://api/mcp', headers: { Authorization: 'Bearer ${env:GITHUB_TOKEN}' } },
    });
  });

  test('export round-trips through each format', () => {
    const stdio = { command: 'uvx', args: ['basic-memory', 'mcp'], env: { BASIC_MEMORY_HOME: '${env:BASIC_MEMORY_HOME}', MODE: 'x' } };
    const http = { type: 'http' as const, url: 'https://madx.tail/mcp', headers: { Authorization: 'Bearer ${env:MEM_TOKEN}' } };
    expect(mcpFromCodexToml(mcpToCodexToml('mem', stdio)).mem).toEqual(stdio);
    expect(mcpFromCodexToml(mcpToCodexToml('web', http)).web).toEqual(http);
    expect(mcpFromOpenCode({ mcp: { mem: mcpToOpenCode(stdio) } }).mem).toEqual(stdio);
    expect(mcpFromGemini({ mcpServers: { web: mcpToGemini(http) } }).web).toEqual(http);
    expect(mcpFromClaude({ mcpServers: { mem: mcpToClaude(stdio) } }).mem).toEqual({ type: 'stdio', ...stdio });
    expect(mcpToOpenCode(http)).toEqual({ type: 'remote', url: 'https://madx.tail/mcp', headers: { Authorization: 'Bearer {env:MEM_TOKEN}' }, enabled: true });
  });
});

describe('hook importers', () => {
  test('Gemini: events, tool names and ms to s', () => {
    const res = hooksFromGemini({
      hooks: {
        BeforeTool: [{ matcher: 'run_shell_command|write_file', hooks: [{ type: 'command', command: '$GEMINI_PROJECT_DIR/guard.sh', timeout: 5000 }] }],
        BeforeAgent: [{ hooks: [{ type: 'command', command: 'ctx.sh' }] }],
        BeforeModel: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
    });
    expect(res.hooks.PreToolUse).toEqual([{ matcher: 'Bash|Write', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/guard.sh', timeout: 5 }] }]);
    expect(res.hooks.UserPromptSubmit?.[0].hooks[0].command).toBe('ctx.sh');
    expect(res.skipped).toEqual(['BeforeModel']);
  });

  test('Codex: same shape, unknown events skipped, trust state ignored', () => {
    const res = hooksFromCodex({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh', timeout: 30, statusMessage: 'x' }] }], Interrupt: [{ hooks: [{ type: 'command', command: 'b' }] }], state: {} } });
    expect(res.hooks).toEqual({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh', timeout: 30 }] }] });
    expect(res.skipped).toEqual(['Interrupt']);
  });
});

describe('cli-sync writes files each CLI accepts', () => {
  test('agents round-trip through the Codex, OpenCode and Gemini loaders', async () => {
    const { syncToClis } = await import('../../../src/extensions/cli-sync');
    const home = td();
    const machine = new FakeMachine({ home, clis: { codex: '0.163.0', opencode: '1.19.3', gemini: '0.64.0' } });
    const agent = { name: 'reviewer', description: 'Reviews diffs', prompt: "You review.\nSay '''quoted'''.", tools: ['Read', 'Grep', 'Bash'], model: 'openai/gpt-5.5', color: 'red', thinking: 'high' as const, source: 'user' as const, subagent: true };
    const skillDir = td();
    write(join(skillDir, 'SKILL.md'), `---\nname: notes\ndescription: n\n---\nb`);
    await syncToClis(machine, { agents: [agent], skills: [{ name: 'notes', description: 'n', dir: skillDir, path: join(skillDir, 'SKILL.md'), source: 'user' }] });

    const [codex] = loadCodexAgents(join(home, '.codex', 'agents'), map);
    expect(codex.prompt).toBe(agent.prompt);
    expect(codex.model).toBe('openai/gpt-5.5');
    expect(codex.thinking).toBe('high');
    expect(codex.disallowedTools).toContain('Edit'); // no edit tools -> read-only sandbox

    // Validated against OpenCode 1.19.3 (`opencode debug agent`): this file loads; a Claude-style one does not.
    const ocText = await Bun.file(join(home, '.config', 'opencode', 'agent', 'reviewer.md')).text();
    expect(ocText).not.toMatch(/^tools:/m);
    expect(ocText).not.toMatch(/^color:/m); // named colours are rejected by OpenCode
    const [oc] = loadOpenCodeAgents(join(home, '.config', 'opencode', 'agent'), map);
    expect(oc.tools?.sort()).toEqual(['Bash', 'Grep', 'Read']);

    const [gem] = loadGeminiAgents(join(home, '.gemini', 'agents'), map);
    expect(gem.tools?.sort()).toEqual(['Bash', 'Grep', 'Read']);
    const gemText = await Bun.file(join(home, '.gemini', 'agents', 'reviewer.md')).text();
    expect(gemText).toContain('kind: local');
    expect(gemText).not.toContain('color');

    // One shared skill copy for Codex, OpenCode and Gemini.
    expect(await Bun.file(join(home, '.agents', 'skills', 'notes', 'SKILL.md')).exists()).toBe(true);
    expect(await Bun.file(join(home, '.codex', 'skills', 'notes', 'SKILL.md')).exists()).toBe(false);
  });

  test('mcpConnectPlan gives a command or snippet per CLI', async () => {
    const { mcpConnectPlan } = await import('../../../src/extensions/cli-sync');
    const steps = mcpConnectPlan('basic-memory', { command: 'uvx', args: ['basic-memory', 'mcp'], env: { BASIC_MEMORY_HOME: '/home/me/notes' } });
    const by = Object.fromEntries(steps.map((s) => [s.cli, s]));
    expect(by.claude.command).toBe(`claude mcp add-json -s user basic-memory '{"type":"stdio","command":"uvx","args":["basic-memory","mcp"],"env":{"BASIC_MEMORY_HOME":"/home/me/notes"}}'`);
    expect(by.codex.command).toBe('codex mcp add basic-memory --env BASIC_MEMORY_HOME=/home/me/notes -- uvx basic-memory mcp');
    expect(by.gemini.command).toBe('gemini mcp add -s user -e BASIC_MEMORY_HOME=/home/me/notes basic-memory uvx basic-memory mcp');
    expect(JSON.parse(by.opencode.snippet)).toEqual({ mcp: { 'basic-memory': { type: 'local', command: ['uvx', 'basic-memory', 'mcp'], environment: { BASIC_MEMORY_HOME: '/home/me/notes' }, enabled: true } } });

    const remote = mcpConnectPlan('madx-mem', { type: 'http', url: 'https://madx.tail/mcp', headers: { Authorization: 'Bearer ${env:MEM_TOKEN}' } });
    const r = Object.fromEntries(remote.map((s) => [s.cli, s]));
    expect(r.codex.command).toBe('codex mcp add madx-mem --url https://madx.tail/mcp --bearer-token-env-var MEM_TOKEN');
    expect(r.gemini.command).toBe(`gemini mcp add -s user -t http -H 'Authorization: Bearer \${MEM_TOKEN}' madx-mem https://madx.tail/mcp`);
  });
});

describe('helpers for the Extensions UI', () => {
  test('sync dry run lists files and writes nothing', async () => {
    const { syncToClis } = await import('../../../src/extensions/cli-sync');
    const home = td();
    const machine = new FakeMachine({ home, clis: { opencode: '1' } });
    const paths = await syncToClis(machine, { dryRun: true, skills: [], agents: [{ name: 'a', description: 'd', prompt: 'p', source: 'user' }] });
    expect(paths).toContain(join(home, '.config', 'opencode', 'agent', 'a.md'));
    expect(await Bun.file(join(home, '.claude', 'agents', 'a.md')).exists()).toBe(false);
  });

  test('Hooks.recent keeps the last handler runs per event', async () => {
    const { Hooks } = await import('../../../src/extensions/hooks');
    const runner = new Hooks();
    await runner.run('PreToolUse', { session_id: 's9', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { matcherValue: 'Bash', hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
    const [last] = runner.recent({ event: 'PreToolUse' });
    expect(last.sessionId).toBe('s9');
    expect(last.exitCode).toBe(0);
    expect(last.label).toBe('echo hi');
    expect(runner.recent({ event: 'Stop' })).toHaveLength(0);
  });
});
