import { describe, test, expect, afterAll } from 'bun:test';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigStore } from '../../../src/config';
import { Extensions } from '../../../src/extensions/registry';
import { PluginManager } from '../../../src/extensions/plugins';
import { Hooks } from '../../../src/extensions/hooks';
import type { HookInput, RuntimeHookCommand } from '../../../src/extensions/types';
import { tempDir, cleanup } from '../_helpers';
import { cachedRepo } from './_repos';

/**
 * Install real, published plugins into a temp Conclave home and check that
 * every component loads with the names, paths and plugin-root expansion that
 * Claude Code gives them. Repos are cloned once into a cache; offline, these
 * tests skip.
 */

const superpowers = await cachedRepo('obra/superpowers');
const official = await cachedRepo('anthropics/claude-plugins-official');
const scientific = await cachedRepo('K-Dense-AI/scientific-agent-skills', ['/plugin.json', '/skills/', '/.claude-plugin/']);

const dirs: string[] = [];
const savedClaude = process.env.CLAUDE_CONFIG_DIR;
afterAll(() => {
  cleanup(...dirs);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
});

function setup() {
  const home = tempDir('conclave-compat-home-');
  const claude = tempDir('conclave-compat-claude-');
  dirs.push(home, claude);
  process.env.CLAUDE_CONFIG_DIR = claude;
  const config = new ConfigStore(home);
  const plugins = new PluginManager({ dir: join(home, 'plugins'), defaultMarketplaces: [] });
  const ext = new Extensions({ config, plugins, compatHomes: { agents: join(home, 'none'), codex: join(home, 'none'), opencode: join(home, 'none'), gemini: join(home, 'none') } });
  return { home, ext, plugins };
}

function input(event: HookInput['hook_event_name'], cwd: string, extra: Partial<HookInput> = {}): HookInput {
  return { session_id: 's1', cwd, hook_event_name: event, ...extra };
}

describe.skipIf(!superpowers)('obra/superpowers', () => {
  test('skills load namespaced and the SessionStart hook runs with CLAUDE_PLUGIN_ROOT', async () => {
    const { ext, home } = setup();
    const installed = await ext.installPlugin(superpowers as string);
    expect(installed.name).toBe('superpowers');
    expect(installed.manifest.version).toBeDefined();

    const skillDirs = readdirSync(join(superpowers as string, 'skills')).filter((d) => existsSync(join(superpowers as string, 'skills', d, 'SKILL.md')));
    const skills = ext.skills().filter((s) => s.plugin === 'superpowers');
    expect(skills.length).toBe(skillDirs.length);
    for (const s of skills) {
      expect(s.name.startsWith('superpowers:')).toBe(true);
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.dir.startsWith(installed.dir)).toBe(true);
    }
    // Bare names still resolve when unique, like typing /brainstorming in Claude Code.
    expect(ext.skill('brainstorming')?.name).toBe('superpowers:brainstorming');
    expect(ext.skill('superpowers:test-driven-development')?.path).toBe(join(installed.dir, 'skills', 'test-driven-development', 'SKILL.md'));

    const hooks = ext.pluginHooks();
    const group = hooks.SessionStart?.[0];
    expect(group?.matcher).toBe('startup|clear|compact');
    const handler = group?.hooks[0] as RuntimeHookCommand;
    expect(handler.command).toContain(join(installed.dir, 'hooks', 'run-hook.cmd'));
    expect(handler.command).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(handler.pluginRoot).toBe(installed.dir);
    expect(handler.shell).toBe('bash');

    // Run the real hook. It reads skills/using-superpowers/SKILL.md and returns it as context.
    const runner = new Hooks();
    const cwd = tempDir();
    dirs.push(cwd);
    const out = await runner.run('SessionStart', input('SessionStart', cwd, { source: 'startup' }), { matcherValue: 'startup', hooks });
    expect(out.blocked).toBe(false);
    expect(out.additionalContext.join('\n')).toContain('superpowers');
    expect(out.trace?.[0].exitCode).toBe(0);
    // The hook chose the Claude Code output shape because CLAUDE_PLUGIN_ROOT was set.
    expect(out.trace?.[0].stdout).toContain('hookSpecificOutput');

    // Matcher "startup|clear|compact" does not fire on resume.
    const resumed = await runner.run('SessionStart', input('SessionStart', cwd, { source: 'resume' }), { matcherValue: 'resume', hooks });
    expect(resumed.trace ?? []).toHaveLength(0);
    void home;
  }, 60_000);
});

describe.skipIf(!official)('anthropics/claude-plugins-official via its marketplace', () => {
  // example-plugin is in the repo but not in its marketplace.json, so it installs from a local path.
  const names = ['hookify', 'feature-dev', 'pr-review-toolkit', 'context7', 'github', 'fakechat', 'security-guidance', 'ralph-loop'];

  test('marketplace lists entries and relative-path plugins install', async () => {
    const { ext } = setup();
    await ext.addMarketplace(official as string);
    const entries = await ext.marketplaces();
    expect(entries.length).toBeGreaterThan(50);
    for (const n of names) expect(entries.find((e) => e.name === n)?.marketplace).toBe('claude-plugins-official');

    for (const n of names) {
      const p = await ext.installPlugin(`${n}@claude-plugins-official`);
      expect(p.name).toBe(n);
    }
    await ext.installPlugin(join(official as string, 'plugins', 'example-plugin'));
    expect(ext.plugins().map((p) => p.name).sort()).toEqual([...names, 'example-plugin'].sort());

    // Agents: two plugins ship "code-reviewer"; both load under their own prefix.
    const fd = ext.agent('feature-dev:code-reviewer');
    const pr = ext.agent('pr-review-toolkit:code-reviewer');
    expect(fd?.plugin).toBe('feature-dev');
    expect(pr?.plugin).toBe('pr-review-toolkit');
    expect(fd?.tools).toContain('Grep');
    expect(fd?.model).toBe('smart'); // "sonnet" maps to the smart tier
    expect(fd?.color).toBe('red');
    expect(ext.agent('code-reviewer')).toBeUndefined(); // ambiguous bare name
    expect(ext.agent('reviewer')?.source).toBe('builtin'); // built-in untouched
    // This file's frontmatter is not valid YAML; the lenient parser still reads it.
    expect(ext.agent('pr-review-toolkit:silent-failure-hunter')?.description.length).toBeGreaterThan(20);
    expect(ext.agent('feature-dev:code-explorer')?.prompt.length).toBeGreaterThan(100);

    // Commands: hookify and ralph-loop both have "help".
    const hookifyCmds = ext.commands().filter((c) => c.plugin === 'hookify').map((c) => c.name).sort();
    expect(hookifyCmds).toEqual(['hookify:configure', 'hookify:help', 'hookify:hookify', 'hookify:list']);
    expect(ext.command('hookify:help')?.body.length).toBeGreaterThan(20);
    expect(ext.command('help')).toBeUndefined();
    expect(ext.command('hookify')?.argumentHint).toBe('Optional specific behavior to address');
    expect(ext.command('hookify')?.allowedTools).toContain('Read');
    expect(ext.command('feature-dev')?.name).toBe('feature-dev:feature-dev');

    // Skills, including a skill that doubles as a slash command.
    // Claude names skills by folder (verified live): folder writing-rules, frontmatter name writing-hookify-rules.
    expect(ext.skill('hookify:writing-rules')?.description.length).toBeGreaterThan(10);
    expect(ext.skill('hookify:writing-hookify-rules')).toBeUndefined();
    expect(ext.skill('example-plugin:example-skill')).toBeDefined();
    const skillCmd = ext.command('example-plugin:example-command');
    expect(skillCmd?.body.length).toBeGreaterThan(10);

    // Hooks: plugin root expanded, timeouts kept, plugin tagged.
    const hooks = ext.pluginHooks();
    const hookify = (hooks.PreToolUse ?? []).flatMap((g) => g.hooks as RuntimeHookCommand[]).find((h) => h.plugin === 'hookify');
    const hookifyDir = ext.plugins().find((p) => p.name === 'hookify')!.dir;
    expect(hookify?.command).toBe(`python3 "${hookifyDir}/hooks/pretooluse.py"`);
    expect(hookify?.timeout).toBe(10);
    for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'] as const) {
      expect((hooks[ev] ?? []).some((g) => (g.hooks as RuntimeHookCommand[]).some((h) => h.plugin === 'hookify'))).toBe(true);
    }
    expect((hooks.Stop ?? []).some((g) => (g.hooks as RuntimeHookCommand[]).some((h) => h.plugin === 'ralph-loop' && h.command?.includes('stop-hook.sh')))).toBe(true);

    // security-guidance uses Claude's `if` filter; only the matching handler is planned.
    const runner = new Hooks();
    const sg = (cmd: string) =>
      runner
        .plan('PostToolUse', input('PostToolUse', '/tmp', { tool_name: 'Bash', tool_input: { command: cmd } }), { matcherValue: 'Bash', hooks })
        .filter((h) => h.plugin === 'security-guidance')
        .map((h) => h.if);
    expect(sg('git commit -m "x"')).toEqual(['Bash(git*commit*)']);
    expect(sg('git push origin main')).toEqual(['Bash(git*push*)']);
    expect(sg('ls -la')).toEqual([]);
    // Its Edit|Write|MultiEdit matcher also fires on Conclave's MultiEdit.
    const edits = runner.plan('PostToolUse', input('PostToolUse', '/tmp', { tool_name: 'MultiEdit', tool_input: { file_path: 'a.ts' } }), { matcherValue: 'MultiEdit', hooks });
    expect(edits.some((h) => h.plugin === 'security-guidance')).toBe(true);

    // MCP: Claude's key, so tools are mcp__plugin_<plugin>_<server>__<tool>.
    const mcp = ext.pluginMcpServers();
    expect(mcp.plugin_context7_context7?.url).toContain('mcp.context7.com');
    expect(mcp['plugin_example-plugin_example-server']?.url).toBe('https://mcp.example.com/api'); // flat .mcp.json
    expect(mcp.plugin_github_github?.headers?.Authorization).toBe('Bearer ${env:GITHUB_PERSONAL_ACCESS_TOKEN}');
    const fakechatDir = ext.plugins().find((p) => p.name === 'fakechat')!.dir;
    expect(mcp.plugin_fakechat_fakechat?.command).toBe('bun');
    expect(mcp.plugin_fakechat_fakechat?.args).toContain(fakechatDir);

    // Plugin detail for the UI.
    const detail = ext.pluginDetail('hookify');
    expect(detail?.commands.length).toBe(4);
    expect(detail?.agents.map((a) => a.name)).toEqual(['hookify:conversation-analyzer']);
    expect(Object.keys(detail?.hooks ?? {}).sort()).toEqual(['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);

    // Disabling a plugin removes everything it adds.
    await ext.setPluginEnabled('hookify', false);
    expect(ext.commands().some((c) => c.plugin === 'hookify')).toBe(false);
    expect((ext.pluginHooks().PreToolUse ?? []).some((g) => (g.hooks as RuntimeHookCommand[]).some((h) => h.plugin === 'hookify'))).toBe(false);
  }, 120_000);
});

describe.skipIf(!scientific)('K-Dense-AI/scientific-agent-skills', () => {
  test('a root plugin.json with $schema installs and every skill loads', async () => {
    const { ext } = setup();
    const installed = await ext.installPlugin(scientific as string);
    expect(installed.name).toBe('scientific-agent-skills');
    const expected = readdirSync(join(scientific as string, 'skills')).filter((d) => existsSync(join(scientific as string, 'skills', d, 'SKILL.md')));
    const skills = ext.skills().filter((s) => s.plugin === 'scientific-agent-skills');
    expect(expected.length).toBeGreaterThan(100);
    expect(skills.length).toBe(expected.length);
    const noDescription = skills.filter((s) => !s.description).map((s) => s.name);
    expect(noDescription).toEqual([]);
    expect(skills.every((s) => s.name.startsWith('scientific-agent-skills:'))).toBe(true);
  }, 120_000);
});
