/**
 * Preview, install, update, rollback and remove against local git repos in
 * temp folders (never github.com), with an in-memory host and a real
 * PluginManager. raw.githubusercontent.com reads are answered from the
 * local repo through the fixture fetch.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogInstaller, CatalogError, fillPlaceholders } from '../../src/catalog/install';
import { CatalogStore } from '../../src/catalog/store';
import { CatalogHttp } from '../../src/catalog/http';
import { GithubClient } from '../../src/catalog/github';
import { McpRegistry } from '../../src/catalog/registry';
import { gitRunner } from '../../src/catalog/git';
import type { CatalogItem } from '../../src/catalog/recommended';
import type { CatalogItemDto } from '../../src/catalog/types';
import { PluginManager, parsePluginSource } from '../../src/extensions/plugins';
import { cleanupAll, fakeHost, fixtureFetch, gitRepo, git, json, tempHome, type FakeHost, type Home } from './helpers';

afterEach(cleanupAll);

function installer(home: Home, host: FakeHost, items: CatalogItem[], bins: Record<string, boolean> = {}) {
  const store = new CatalogStore(home.db);
  // raw.githubusercontent.com/<local repo path>/<ref>/<file>: read the file from the local repo at that ref
  const f = fixtureFetch([
    [/^https:\/\/raw\.githubusercontent\.com\//, async (u) => {
      const m = /^\/(\/.+?)\/([0-9a-f]{40}|HEAD)\/(.+)$/.exec(decodeURIComponent(u.pathname));
      if (!m) return new Response('nope', { status: 404 });
      try {
        return new Response(await git(m[1], 'show', `${m[2]}:${m[3]}`));
      } catch {
        return new Response('missing', { status: 404 });
      }
    }],
  ]);
  const http = new CatalogHttp(store, { fetch: f });
  const ins = new CatalogInstaller({
    paths: home.paths,
    store,
    http,
    git: gitRunner(),
    github: new GithubClient({ http, fetch: f }),
    registry: new McpRegistry(http),
    host,
    checkBin: async (b) => bins[b] ?? true,
    itemFor: (id) => items.find((i) => i.id === id),
    dtoFor: (i) => ({ ...i, ready: { ok: true, missing: [] } }) as CatalogItemDto,
  });
  return { ins, store };
}

const base = (o: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'kind' | 'install'>): CatalogItem => ({
  name: o.id.split(':')[1],
  description: 'test item',
  category: 'dev',
  tags: [],
  touches: [],
  recommended: true,
  source: 'recommended',
  ...o,
});

describe('skill files', () => {
  test('preview lists every file and script; install copies without .git, marks the folder, and remove deletes only that', async () => {
    const repo = await gitRepo({
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo\n---\nbody\n',
      'skills/demo/run.sh': { text: '#!/bin/sh\necho hi\n', mode: 0o755 },
      'README.md': '# demo\n',
    });
    const home = tempHome();
    const host = fakeHost(home);
    const item = base({ id: 'skill:demo', kind: 'skill', install: { type: 'files', repo: repo.dir, sha: repo.sha, files: [{ from: 'skills/demo/', to: 'skills/demo/' }] } });
    const { ins, store } = installer(home, host, [item]);
    const p = await ins.preview(item, { id: item.id });
    expect(p.sha).toBe(repo.sha);
    expect(p.shaFrom).toBe('pinned');
    expect(p.files.map((f) => f.path).sort()).toEqual(['~/.conclave/skills/demo/SKILL.md', '~/.conclave/skills/demo/run.sh']);
    expect(p.files.find((f) => f.path.endsWith('run.sh'))).toMatchObject({ executable: true, role: 'script' });
    expect(p.scripts).toEqual(['skills/demo/run.sh']);
    expect(p.warnings.some((w) => w.text.includes('script'))).toBe(true);
    // nothing written outside the staging folder yet
    expect(existsSync(join(home.paths.skills, 'demo'))).toBe(false);

    const r = await ins.install({ planId: p.planId });
    expect(r.ok).toBe(true);
    expect(r.installed).toMatchObject({ kind: 'skill', ref: 'demo', sha: repo.sha, href: '/extensions/skills?skill=demo' });
    const dest = join(home.paths.skills, 'demo');
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('name: demo');
    expect(existsSync(join(dest, '.git'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, '.conclave-catalog.json'), 'utf8'))).toMatchObject({ id: 'skill:demo', sha: repo.sha });
    expect(store.getInstall('skill:demo')?.sha).toBe(repo.sha);
    expect(host.state.audit).toContainEqual({ action: 'catalog.install', detail: `skill:demo ${repo.sha}` });
    // the staged copy is gone and the plan cannot be used twice
    expect(existsSync(join(home.paths.cache, 'catalog', p.planId))).toBe(false);
    await expect(ins.install({ planId: p.planId })).rejects.toMatchObject({ status: 409 });

    expect(ins.matchByName(item)).toMatchObject({ matchedBy: 'name', ref: 'demo' });
    const rm = await ins.remove('skill:demo');
    expect(rm.removed).toEqual([dest]);
    expect(existsSync(dest)).toBe(false);
  });

  test('a linked SKILL.md inside the repo is fetched and copied as a file; links out of the repo are dropped', async () => {
    const repo = await gitRepo({ 'pkg/data/SKILL.md': '---\nname: linked\ndescription: x\n---\nreal body\n', 'README.md': 'x' });
    const { symlinkSync } = await import('node:fs');
    mkdirSync(join(repo.dir, '.claude/skills/linked'), { recursive: true });
    symlinkSync('../../../pkg/data/SKILL.md', join(repo.dir, '.claude/skills/linked/SKILL.md'));
    symlinkSync('/etc/hostname', join(repo.dir, '.claude/skills/linked/host'));
    const sha = await repo.commit({}, 'links');
    const home = tempHome();
    const item = base({ id: 'skill:linked', kind: 'skill', install: { type: 'files', repo: repo.dir, sha, files: [{ from: '.claude/skills/linked/', to: 'skills/linked/' }] } });
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    expect(p.files.map((f) => f.path)).toEqual(['~/.conclave/skills/linked/SKILL.md']);
    await ins.install({ planId: p.planId });
    const dest = join(home.paths.skills, 'linked');
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('real body');
    expect(existsSync(join(dest, 'host'))).toBe(false);
  });

  test('the preview names the !`command` lines a skill or command runs when it is typed', async () => {
    const repo = await gitRepo({
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: x\n---\nRecent: !`git log -3`\n',
      'skills/demo/notes.md': 'Not run: !`rm -rf ~`\n',
      'commands/ship.md': 'Ship it: !`git push`\n',
    });
    const home = tempHome();
    const item = base({ id: 'skill:demo', kind: 'skill', install: { type: 'files', repo: repo.dir, sha: repo.sha, files: [{ from: 'skills/demo/', to: 'skills/demo/' }, { from: 'commands/ship.md', to: 'commands/ship.md' }] } });
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    const w = p.warnings.find((x) => x.text.includes('without asking'));
    expect(w?.text).toContain('2 shell commands');
    expect(w?.text).toContain('git log -3; git push');
    expect(w?.text).not.toContain('rm -rf');
  });

  test('a folder Discover did not write is never replaced', async () => {
    const repo = await gitRepo({ 'skills/demo/SKILL.md': '---\nname: demo\ndescription: x\n---\n' });
    const home = tempHome();
    mkdirSync(join(home.paths.skills, 'demo'), { recursive: true });
    writeFileSync(join(home.paths.skills, 'demo', 'SKILL.md'), 'mine');
    const item = base({ id: 'skill:demo', kind: 'skill', install: { type: 'files', repo: repo.dir, sha: repo.sha, files: [{ from: 'skills/demo/', to: 'skills/demo/' }] } });
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    expect(p.warnings[0]).toMatchObject({ level: 'risk' });
    await expect(ins.install({ planId: p.planId })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(home.paths.skills, 'demo', 'SKILL.md'), 'utf8')).toBe('mine');
  });

  test('paths outside the repo or outside skills, agents and commands are refused', async () => {
    const repo = await gitRepo({ 'a.md': 'x' });
    const home = tempHome();
    const bad = base({ id: 'command:x', kind: 'command', install: { type: 'files', repo: repo.dir, sha: repo.sha, files: [{ from: 'a.md', to: '../config.json' }] } });
    const { ins } = installer(home, fakeHost(home), [bad]);
    await expect(ins.preview(bad, { id: bad.id })).rejects.toBeInstanceOf(CatalogError);
    const bad2 = base({ id: 'command:y', kind: 'command', install: { type: 'files', repo: repo.dir, sha: repo.sha, files: [{ from: '../../etc/passwd', to: 'commands/p.md' }] } });
    await expect(ins.preview(bad2, { id: bad2.id })).rejects.toBeInstanceOf(CatalogError);
  });
});

describe('plugins', () => {
  async function pluginRepo() {
    return gitRepo({
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'tmk', plugins: [{ name: 'demo', source: './', description: 'Demo plugin' }] }),
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0', license: 'MIT', userConfig: { a: {} } }),
      'hooks/hooks.json': JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/start.js"', timeout: 5 }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'curl -s https://example.com/check' }] }],
        },
      }),
      'hooks/start.js': 'console.log("{}")\n',
      'skills/x/SKILL.md': '---\nname: x\ndescription: x skill\n---\n',
    });
  }

  test('preview shows every hook command, needs and warnings; install with hooks off keeps skills and drops hooks; the commit is recorded', async () => {
    const repo = await pluginRepo();
    const home = tempHome();
    const host = fakeHost(home);
    const item = base({ id: 'plugin:demo', kind: 'plugin', install: { type: 'plugin', marketplace: repo.dir, plugins: ['demo@tmk'], sha: repo.sha, hooks: 'on' } });
    const { ins, store } = installer(home, host, [item], { node: false });
    const p = await ins.preview(item, { id: item.id, options: { hooks: false } });
    expect(p.sha).toBe(repo.sha);
    expect(p.plugins).toEqual([{ source: 'demo@tmk', name: 'demo', description: 'Demo plugin', selected: true }]);
    expect(p.hooks.map((h) => [h.event, h.interpreter, h.network])).toEqual([
      ['SessionStart', 'node', false],
      ['PreToolUse', 'curl', true],
    ]);
    expect(p.hooks[0].command).toContain('hooks/start.js');
    const text = p.warnings.map((w) => w.text).join('\n');
    expect(text).toContain('network calls');
    expect(text).toContain('every tool call');
    expect(text).toContain('Hooks off');
    expect(text).toContain('userConfig');
    expect(p.files.some((f) => f.path === '~/.conclave/plugins/demo/hooks/hooks.json')).toBe(true);
    expect(p.license).toBe('MIT');
    expect(p.steps[0].say).toContain('Adds the marketplace');

    const r = await ins.install({ planId: p.planId });
    expect(r.ok).toBe(true);
    expect(r.installed).toMatchObject({ kind: 'plugin', ref: 'demo', sha: repo.sha, version: '1.0.0' });
    const installed = host.pm.plugins()[0];
    expect(installed).toMatchObject({ name: 'demo', source: 'demo@tmk', sha: repo.sha, hooksEnabled: false });
    expect(existsSync(join(installed.dir, '.git'))).toBe(false);
    expect(host.pm.pluginHooks()).toEqual({});
    expect(host.pm.marketplaceSources().map((m) => m.name)).toEqual(['tmk']);
    expect(store.getInstall('plugin:demo')?.meta.plugins).toEqual(['demo']);
    await host.pm.setPluginHooks('demo', true);
    expect(Object.keys(host.pm.pluginHooks())).toEqual(['SessionStart', 'PreToolUse']);
  });

  test('the preview names the !`command` lines in a plugin command', async () => {
    const repo = await gitRepo({
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'tmk', plugins: [{ name: 'cmds', source: './' }] }),
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'cmds' }),
      'commands/go.md': 'Status: !`git status`\n',
    });
    const home = tempHome();
    const item = base({ id: 'plugin:cmds', kind: 'plugin', install: { type: 'plugin', marketplace: repo.dir, plugins: ['cmds@tmk'], sha: repo.sha } });
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    expect(p.warnings.find((x) => x.text.includes('without asking'))?.text).toContain('a shell command on the session\'s device, without asking, when you type their /name: git status.');
  });

  test('update: a changed hook needs review, update writes the new commit, rollback restores the old copy', async () => {
    const repo = await pluginRepo();
    const home = tempHome();
    const host = fakeHost(home);
    const item = base({ id: 'plugin:demo', kind: 'plugin', install: { type: 'plugin', marketplace: repo.dir, plugins: ['demo@tmk'], sha: repo.sha } });
    const { ins } = installer(home, host, [item]);
    await ins.install({ planId: (await ins.preview(item, { id: item.id })).planId });
    const next = await repo.commit({ 'hooks/start.js': 'console.log("changed")\n', 'skills/x/SKILL.md': '---\nname: x\ndescription: x skill v2\n---\n' });

    const checked = await ins.checkUpdates();
    expect(checked[0]).toMatchObject({ id: 'plugin:demo', upstreamSha: next, updateAvailable: true });
    const up = await ins.updatePreview('plugin:demo');
    expect(up.from).toBe(repo.sha);
    expect(up.to).toBe(next);
    expect(up.hooksChanged).toBe(true);
    expect(up.needsReview).toBe(true);
    expect(up.changes.map((c) => c.path).sort()).toEqual(['plugins/demo/hooks/start.js', 'plugins/demo/skills/x/SKILL.md']);
    expect(up.changes.find((c) => c.path.endsWith('start.js'))?.diff).toContain('changed');

    const after = await ins.update('plugin:demo', up.planId);
    expect(after.sha).toBe(next);
    expect(readFileSync(join(home.paths.plugins, 'demo', 'hooks', 'start.js'), 'utf8')).toContain('changed');
    expect(after.previous?.sha).toBe(repo.sha);

    const back = await ins.rollback('plugin:demo');
    expect(back.sha).toBe(repo.sha);
    expect(readFileSync(join(home.paths.plugins, 'demo', 'hooks', 'start.js'), 'utf8')).not.toContain('changed');
    expect(host.pm.plugins()[0].sha).toBe(repo.sha);
    expect(host.state.audit.map((a) => a.action)).toEqual(['catalog.install', 'catalog.update', 'catalog.rollback']);
  });
});

describe('MCP servers', () => {
  const item = base({
    id: 'mcp:demo',
    kind: 'mcp',
    install: { type: 'mcp', server: 'demo', config: { command: 'npx', args: ['-y', 'demo-mcp@1.0.0', '{{WORKSPACE}}'], env: { DEMO_TOKEN: '{{DEMO_TOKEN}}', DEMO_REGION: '{{DEMO_REGION}}' } }, offer: ['connect-clis'] },
    inputs: [
      { name: 'DEMO_TOKEN', label: 'Token', description: '', required: true, secret: true, secretKey: 'demo-token' },
      { name: 'DEMO_REGION', label: 'Region', description: '', required: false, secret: false },
      { name: 'WORKSPACE', label: 'Workspace', description: '', required: true, secret: false, default: '/srv/demo' },
    ],
  });

  test('the preview shows the final config with secrets as ${secret:key}', async () => {
    const home = tempHome();
    const { ins } = installer(home, fakeHost(home), [item], { npx: false });
    const p = await ins.preview(item, { id: item.id });
    expect(p.config).toEqual({ command: 'npx', args: ['-y', 'demo-mcp@1.0.0', '/srv/demo'], env: { DEMO_TOKEN: '${secret:demo-token}', DEMO_REGION: '{{DEMO_REGION}}' } });
    expect(p.needs).toContainEqual(expect.objectContaining({ bin: 'npx', found: false, checkedOn: 'hub' }));
    expect(p.equivalent).toStartWith('conclave config set mcpServers.demo ');
  });

  test('a missing required input is a 400 with the names, and the plan stays usable', async () => {
    const home = tempHome();
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    await expect(ins.install({ planId: p.planId, values: {} })).rejects.toMatchObject({ status: 400, data: { missing: ['DEMO_TOKEN'] } });
    const r = await ins.install({ planId: p.planId, values: { DEMO_TOKEN: 'tok-1' } });
    expect(r.ok).toBe(true);
  });

  test('a passing test saves it: the secret goes to the store, an empty optional input drops its key', async () => {
    const home = tempHome();
    const host = fakeHost(home);
    const { ins, store } = installer(home, host, [item]);
    const p = await ins.preview(item, { id: item.id });
    const r = await ins.install({ planId: p.planId, values: { DEMO_TOKEN: 'tok-1' } });
    expect(r).toMatchObject({ ok: true, test: { ok: true }, installed: { ref: 'demo', href: '/extensions/mcp?server=demo' } });
    expect(r.next.map((n) => n.label)).toEqual(['Open in MCP servers', 'Connect to my CLIs']);
    expect(host.state.mcp.get('demo')).toEqual({ command: 'npx', args: ['-y', 'demo-mcp@1.0.0', '/srv/demo'], env: { DEMO_TOKEN: '${secret:demo-token}' } });
    expect(host.state.secrets.get('demo-token')).toBe('tok-1');
    expect(store.getInstall('mcp:demo')).toMatchObject({ version: '1.0.0', meta: { server: 'demo', secrets: ['demo-token'] } });
  });

  test('a failed test saves nothing and drops the new secret, unless Save disabled is ticked', async () => {
    const home = tempHome();
    const host = fakeHost(home);
    host.state.testResult = { ok: false, ms: 3, tools: 0, error: 'spawn npx ENOENT' };
    const { ins, store } = installer(home, host, [item]);
    const r = await ins.install({ planId: (await ins.preview(item, { id: item.id })).planId, values: { DEMO_TOKEN: 'tok-1' } });
    expect(r.ok).toBe(false);
    expect(host.state.mcp.size).toBe(0);
    expect(host.state.secrets.size).toBe(0);
    expect(store.getInstall('mcp:demo')).toBeUndefined();
    const r2 = await ins.install({ planId: (await ins.preview(item, { id: item.id })).planId, values: { DEMO_TOKEN: 'tok-1' }, saveOnFail: true });
    expect(r2.ok).toBe(true);
    expect(host.state.mcp.get('demo')?.enabled).toBe(false);
  });

  test('remove takes the server out, and its secrets only when asked', async () => {
    const home = tempHome();
    const host = fakeHost(home);
    const { ins } = installer(home, host, [item]);
    await ins.install({ planId: (await ins.preview(item, { id: item.id })).planId, values: { DEMO_TOKEN: 'tok-1' } });
    const rm = await ins.remove('mcp:demo');
    expect(rm.removed).toEqual(['mcpServers.demo']);
    expect(host.state.secrets.has('demo-token')).toBe(true);
    await ins.install({ planId: (await ins.preview(item, { id: item.id })).planId, values: {} });
    expect((await ins.remove('mcp:demo', { secrets: true })).removed).toEqual(['mcpServers.demo', 'secret demo-token']);
  });

  test('fillPlaceholders reuses a stored secret when the field is left empty', () => {
    const out = fillPlaceholders({ env: { A: '{{A}}' } }, [{ name: 'A', label: 'A', description: '', required: true, secret: true, secretKey: 'a-key' }], {}, (k) => k === 'a-key');
    expect(out).toEqual({ value: { env: { A: '${secret:a-key}' } }, secrets: [], missing: [], secretKeys: ['a-key'] });
  });
});

describe('hook recipes and routines', () => {
  test('a recipe preview shows the script path and handlers; install goes through the recipe service', async () => {
    const home = tempHome();
    const host = fakeHost(home, { recipes: true });
    const item = base({ id: 'hook:git-work-saver', kind: 'hook', source: 'recipe', install: { type: 'hook', recipe: 'git-work-saver' } });
    const { ins } = installer(home, host, [item]);
    const p = await ins.preview(item, { id: item.id, options: { scope: 'user' } });
    expect(p.files[0].path).toBe('~/.conclave/hooks/recipes/git-work-saver.sh');
    expect(p.hooks.length).toBeGreaterThan(0);
    expect(p.hooks[0].command).toContain(join(home.paths.hooks, 'recipes', 'git-work-saver.sh'));
    const r = await ins.install({ planId: p.planId });
    expect(r.recipeTests?.length).toBe(2);
    expect(host.state.recipeInstalls[0]).toMatchObject({ id: 'git-work-saver', req: { scope: 'user', env: {} } });
  });

  test('without the recipe service the preview says so and install is a 501', async () => {
    const home = tempHome();
    const item = base({ id: 'hook:git-work-saver', kind: 'hook', source: 'recipe', install: { type: 'hook', recipe: 'git-work-saver' } });
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    expect(p.warnings[0].level).toBe('risk');
    await expect(ins.install({ planId: p.planId })).rejects.toMatchObject({ status: 501 });
  });

  test('a routine hands off to the Routines tab', async () => {
    const home = tempHome();
    const item = base({ id: 'routine:librarian-deep-pass', kind: 'routine', source: 'suggestion', install: { type: 'routine', suggestion: 'librarian-deep-pass' } });
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    expect(p.handoff).toEqual({ label: 'Open in Routines', href: '/routines?suggest=librarian-deep-pass' });
    await expect(ins.install({ planId: p.planId })).rejects.toMatchObject({ status: 400 });
  });
});

describe('live results', () => {
  test('a repo with SKILL.md folders becomes a skill install at its latest commit', async () => {
    const repo = await gitRepo({ 'ctf-web/SKILL.md': '---\nname: ctf-web\ndescription: web\n---\n', 'ctf-pwn/SKILL.md': '---\nname: ctf-pwn\ndescription: pwn\n---\n', 'README.md': '# ctf\n' });
    const home = tempHome();
    const item = base({ id: 'gh:someone/ctf-skills', kind: 'skill', source: 'github', recommended: false, repo: repo.dir, install: { type: 'manual', steps: [] } });
    const { ins } = installer(home, fakeHost(home), [item]);
    const p = await ins.preview(item, { id: item.id });
    expect(p.shaFrom).toBe('head');
    expect(p.sha).toBe(repo.sha);
    expect(p.files.map((f) => f.path).sort()).toEqual(['~/.conclave/skills/ctf-pwn/SKILL.md', '~/.conclave/skills/ctf-web/SKILL.md']);
    // the branch moved after the preview: install refuses
    await repo.commit({ 'ctf-web/SKILL.md': '---\nname: ctf-web\ndescription: web v2\n---\n' });
    await expect(ins.install({ planId: p.planId })).rejects.toMatchObject({ status: 409 });
  });

  test('a repo with nothing installable says so', async () => {
    const repo = await gitRepo({ 'main.go': 'package main\n' });
    const home = tempHome();
    const item = base({ id: 'gh:someone/tool', kind: 'mcp', source: 'github', repo: repo.dir, install: { type: 'manual', steps: [] } });
    const { ins } = installer(home, fakeHost(home), [item]);
    await expect(ins.preview(item, { id: item.id })).rejects.toThrow(/No plugin\.json, SKILL\.md or MCP server found/);
  });
});

describe('plugin installer pins', () => {
  test('a marketplace entry pinned by sha installs that commit even after the branch moved, and a bad sha fails loudly', async () => {
    const plugin = await gitRepo({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'pinned', version: '1.0.0' }), 'VERSION': 'one\n' });
    const old = plugin.sha;
    await plugin.commit({ VERSION: 'two\n' });
    const mk = await gitRepo({ '.claude-plugin/marketplace.json': JSON.stringify({ name: 'pm', plugins: [{ name: 'pinned', source: { source: 'url', url: plugin.dir, sha: old } }, { name: 'bad', source: { source: 'url', url: plugin.dir, sha: 'f'.repeat(40) } }] }) });
    const home = tempHome();
    const pm = new PluginManager({ dir: home.paths.plugins, defaultMarketplaces: [] });
    await pm.addMarketplace(mk.dir);
    const p = await pm.installPlugin('pinned@pm');
    expect(p.sha).toBe(old);
    expect(readFileSync(join(p.dir, 'VERSION'), 'utf8')).toBe('one\n');
    expect(existsSync(join(p.dir, '.git'))).toBe(false);
    await expect(pm.installPlugin('bad@pm')).rejects.toThrow(/failed/);
  });

  test('owner/repo@ref#subdir sets the ref; strict:false entries use the entry as the manifest', async () => {
    expect(parsePluginSource('acme/tools@v1.2.0#plugins/x')).toMatchObject({ kind: 'git', url: 'https://github.com/acme/tools.git', ref: 'v1.2.0', subdir: 'plugins/x' });
    expect(parsePluginSource('acme/tools')).toMatchObject({ ref: undefined });
    const repo = await gitRepo({
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'sk', plugins: [{ name: 'docs-only', source: './', strict: false, skills: ['./skills/docx'] }] }),
      'skills/docx/SKILL.md': '---\nname: docx\ndescription: docx\n---\n',
      'skills/xlsx/SKILL.md': '---\nname: xlsx\ndescription: xlsx\n---\n',
    });
    const home = tempHome();
    const pm = new PluginManager({ dir: home.paths.plugins, defaultMarketplaces: [] });
    await pm.addMarketplace(repo.dir);
    const p = await pm.installPlugin('docs-only@sk');
    expect(p.name).toBe('docs-only');
    expect(p.manifest.skills).toEqual(['./skills/docx']);
  });
});

void json;
