import { describe, test, expect, afterEach, beforeAll } from 'bun:test';
import { join } from 'node:path';
import { defaultModelMapper } from '../../src/extensions/loader';
import { PluginManager, parsePluginSource, expandRoot } from '../../src/extensions/plugins';
import type { RuntimeHookCommand } from '../../src/extensions/types';
import { tempDir, cleanup, write } from './_helpers';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

function td(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}

const map = defaultModelMapper('anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5');

/** Build a plugin repo on disk and git init + commit it. Returns its path. */
async function makePluginRepo(name: string): Promise<string> {
  const repo = td();
  write(join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'test plugin' }));
  write(join(repo, 'skills', 'demo', 'SKILL.md'), `---\nname: demo\ndescription: A demo skill\n---\nbody`);
  write(join(repo, 'agents', 'helper.md'), `---\nname: helper\ndescription: helps\nmodel: sonnet\n---\nhelp body`);
  write(join(repo, 'commands', 'go.md'), `---\ndescription: Go\n---\ndo it`);
  write(join(repo, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/check.sh' }] }] } }));
  write(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { api: { type: 'http', url: 'https://example.com', headers: { 'X-Root': '${CONCLAVE_PLUGIN_ROOT}' } } } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = async (args: string[]) => {
    const p = Bun.spawn(['git', ...args], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
    await p.exited;
  };
  await run(['init', '-q']);
  await run(['add', '-A']);
  await run(['commit', '-q', '-m', 'init']);
  return repo;
}

describe('parsePluginSource', () => {
  test('classifies sources', () => {
    expect(parsePluginSource('owner/repo').kind).toBe('git');
    expect(parsePluginSource('owner/repo').url).toBe('https://github.com/owner/repo.git');
    expect(parsePluginSource('github:owner/repo#sub').subdir).toBe('sub');
    expect(parsePluginSource('https://x.com/a.git').kind).toBe('git');
    expect(parsePluginSource('/abs/path').kind).toBe('local');
    expect(parsePluginSource('/abs/repo.git').kind).toBe('git');
  });
});

describe('expandRoot', () => {
  test('replaces both root variables everywhere', () => {
    const out = expandRoot({ a: '${CLAUDE_PLUGIN_ROOT}/x', b: ['${CONCLAVE_PLUGIN_ROOT}/y'] }, '/root');
    expect(out).toEqual({ a: '/root/x', b: ['/root/y'] });
  });
});

describe('install from a local git repo', () => {
  test('clones, reads manifest, loads components, hooks and mcp', async () => {
    const repo = await makePluginRepo('demo-plugin');
    const pm = new PluginManager({ dir: td(), defaultMarketplaces: [] });
    // Ends in .git routing is not needed; install via git by appending nothing: use file path as git.
    const installed = await pm.installPlugin(`${repo}/.git`);
    expect(installed.name).toBe('demo-plugin');
    expect(installed.enabled).toBe(true);

    const comps = pm.loadComponents(map);
    // Plugin components are namespaced "<plugin>:<name>", like Claude Code and Codex.
    expect(comps.skills.map((s) => s.name)).toContain('demo-plugin:demo');
    expect(comps.agents.find((a) => a.name === 'demo-plugin:helper')?.plugin).toBe('demo-plugin');
    expect(comps.agents.find((a) => a.name === 'demo-plugin:helper')?.model).toBe('smart');
    expect(comps.commands.map((c) => c.name)).toContain('demo-plugin:go');

    const hooks = pm.pluginHooks();
    const handler = hooks.PreToolUse?.[0].hooks[0] as RuntimeHookCommand;
    expect(handler.command).toContain(installed.dir);
    expect(handler.command).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(handler.pluginRoot).toBe(installed.dir);
    expect(handler.plugin).toBe('demo-plugin');

    // Same key Claude Code uses, so tools are mcp__plugin_demo-plugin_api__<tool>.
    const mcp = pm.pluginMcpServers();
    expect(mcp['plugin_demo-plugin_api']).toBeDefined();
    expect(mcp['plugin_demo-plugin_api'].headers?.['X-Root']).toBe(installed.dir);
  });

  test('git runs with the catalog guards, and a URL is never read as an option', async () => {
    const seen: Array<{ argv: string[]; env: Record<string, string> }> = [];
    const spawn = ((argv: string[], opts: { env: Record<string, string> }) => {
      seen.push({ argv, env: opts.env });
      return Bun.spawn(['sh', '-c', 'exit 1'], { stdout: 'pipe', stderr: 'pipe' });
    }) as unknown as typeof Bun.spawn;
    const pm = new PluginManager({ dir: td(), defaultMarketplaces: [], spawn });
    await expect(pm.installPlugin('https://example.invalid/--upload-pack=x.git')).rejects.toThrow(/clone/);
    const clone = seen.find((s) => s.argv[1] === 'clone')!;
    expect(clone.argv.slice(-3, -1)).toEqual(['--', 'https://example.invalid/--upload-pack=x.git']);
    expect(clone.env.GIT_CONFIG_VALUE_0).toBe('/dev/null');
    expect(clone.env.GIT_LFS_SKIP_SMUDGE).toBe('1');
  });

  test('install via local path copy, then disable and remove', async () => {
    const repo = await makePluginRepo('copy-plugin');
    const root = td();
    const pm = new PluginManager({ dir: root, defaultMarketplaces: [] });
    const installed = await pm.installPlugin(repo); // local copy route
    expect(installed.dir.startsWith(root)).toBe(true);
    expect(pm.loadComponents(map).skills.length).toBe(1);

    await pm.setPluginEnabled('copy-plugin', false);
    expect(pm.loadComponents(map).skills.length).toBe(0);

    // State persists across a reload (new manager instance over same dir).
    const pm2 = new PluginManager({ dir: root, defaultMarketplaces: [] });
    expect(pm2.plugins().find((p) => p.name === 'copy-plugin')?.enabled).toBe(false);

    expect(await pm2.removePlugin('copy-plugin')).toBe(true);
    expect(pm2.plugins().length).toBe(0);
  });
});

describe('marketplace from a local directory', () => {
  test('adds a marketplace and installs a relative-path plugin from it', async () => {
    // Marketplace root with a plugin subdir and a marketplace.json.
    const mkRoot = td();
    write(join(mkRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'local-mk',
      owner: { name: 'me' },
      plugins: [{ name: 'sub-plugin', source: './plugins/sub-plugin', description: 'from mk' }],
    }));
    write(join(mkRoot, 'plugins', 'sub-plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sub-plugin' }));
    write(join(mkRoot, 'plugins', 'sub-plugin', 'skills', 'mk-skill', 'SKILL.md'), `---\nname: mk-skill\ndescription: from marketplace\n---\nbody`);

    const pm = new PluginManager({ dir: td(), defaultMarketplaces: [] });
    await pm.addMarketplace(mkRoot);
    const entries = await pm.marketplaces();
    expect(entries.find((e) => e.name === 'sub-plugin')?.marketplace).toBe('local-mk');

    const installed = await pm.installPlugin('sub-plugin@local-mk');
    expect(installed.name).toBe('sub-plugin');
    expect(pm.loadComponents(map).skills.map((s) => s.name)).toContain('sub-plugin:mk-skill');
  });
});
