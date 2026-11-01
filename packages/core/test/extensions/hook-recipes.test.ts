import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HooksConfig } from '../../src/config/schema';
import { HOOK_RECIPES, RECIPE_STARTER } from '../../src/extensions/hook-recipes';
import { HookRecipes, RecipeError, envPrefix, isRecipeHandler, recipeHooks, runRecipeTests, toCodex, toGemini, withoutRecipe } from '../../src/extensions/recipes';
import { FakeMachine, tempDir, cleanup } from './_helpers';

/**
 * Hook recipes (docs/design/ECOSYSTEM.md 4.2). Every bundled test case runs
 * through the real hook runner from the data file alone, the way Install and
 * POST /api/hooks/recipes/:id/test run them. Cases whose programs are missing
 * on this machine are skipped.
 */

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

const binOf = (n: string) => n.split(/\s+/)[0];
const missing = (needs: string[]) => needs.map(binOf).filter((b) => !Bun.which(b));

describe('recipe data', () => {
  test('ids are unique and kebab case, and every handler can run', () => {
    const ids = HOOK_RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of HOOK_RECIPES) {
      expect(r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      for (const h of r.handlers) {
        if (h.type === 'command') {
          expect(h.command).toBeTruthy();
          if (h.command!.includes('{script}')) expect(r.script).toBeTruthy();
        } else expect(h.prompt).toBeTruthy();
      }
    }
  });

  test('every tunable is read by the script', () => {
    for (const r of HOOK_RECIPES) for (const e of r.env ?? []) expect(r.script ?? '').toContain(e.name);
  });

  test('the starter set exists and needs only bash, git, grep and jq', () => {
    for (const id of RECIPE_STARTER) {
      const r = HOOK_RECIPES.find((x) => x.id === id);
      expect(r).toBeDefined();
      expect(r!.needs.map(binOf).every((b) => ['bash', 'jq', 'git', 'grep'].includes(b))).toBe(true);
    }
  });

  test('every script is valid bash', () => {
    const dir = tempDir('conclave-recipe-lint-');
    dirs.push(dir);
    for (const r of HOOK_RECIPES) {
      if (!r.script) continue;
      const file = join(dir, `${r.id}.sh`);
      writeFileSync(file, r.script);
      const p = Bun.spawnSync(['bash', '-n', file]);
      if (p.exitCode !== 0) throw new Error(`${r.id}: ${p.stderr.toString()}`);
      expect(r.script.startsWith('#!/usr/bin/env bash')).toBe(true);
    }
  });
});

describe('recipe tests through the real runner', () => {
  for (const r of HOOK_RECIPES) {
    if (!r.tests.length) continue;
    const lacking = missing(r.needs).filter((b) => !(b === 'conclave' && r.tests.every((x) => x.stubConclave)));
    const t = lacking.length ? test.skip : test;
    t(`${r.id}: ${r.tests.length} case${r.tests.length > 1 ? 's' : ''}${lacking.length ? ` (needs ${lacking.join(', ')})` : ''}`, async () => {
      const results = await runRecipeTests(r);
      const failed = results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.why}`);
      expect(failed).toEqual([]);
      expect(results.length).toBe(r.tests.length);
    }, 60_000);
  }

  test('a recipe whose programs are missing reports them instead of running', async () => {
    const r = HOOK_RECIPES.find((x) => x.id === 'git-work-saver')!;
    const res = await runRecipeTests(r, { which: (b) => (b === 'jq' ? null : `/usr/bin/${b}`) });
    expect(res.every((x) => !x.ok && /jq is not on the hub/.test(x.why ?? ''))).toBe(true);
  });
});

describe('install helpers', () => {
  const trim = HOOK_RECIPES.find((x) => x.id === 'test-output-trim')!;

  test('env prefix holds only changed tunables, single quoted', () => {
    expect(envPrefix(trim, { TEST_TRIM_MIN: '6000' }).prefix).toBe('');
    expect(envPrefix(trim, { TEST_TRIM_MIN: '9000' }).prefix).toBe("TEST_TRIM_MIN='9000' ");
    expect(() => envPrefix(trim, { NOPE: '1' })).toThrow(RecipeError);
    expect(() => envPrefix(trim, { TEST_TRIM_MIN: "1'; rm -rf ~" })).toThrow(RecipeError);
  });

  test('recipeHooks fills the script path and tags handlers', () => {
    const h = recipeHooks(trim, '/h/recipes/test-output-trim.sh', { TEST_TRIM_LINES: '50' });
    const cmd = h.PostToolUse![0].hooks[0] as { command: string; recipe?: string; timeout?: number };
    expect(h.PostToolUse![0].matcher).toBe('Bash');
    expect(cmd.command).toBe("TEST_TRIM_LINES='50' /h/recipes/test-output-trim.sh");
    expect(cmd.recipe).toBe('test-output-trim');
    expect(cmd.timeout).toBe(10);
    expect((recipeHooks(trim, '/x.sh', {}, false).PostToolUse![0].hooks[0] as { recipe?: string }).recipe).toBeUndefined();
  });

  test('withoutRecipe finds handlers by tag or by script path', () => {
    const hooks: HooksConfig = {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/a/recipes/test-output-trim.sh' }, { type: 'command', command: 'other' }] },
        { hooks: [{ type: 'command', command: 'x', recipe: 'test-output-trim' } as never] },
      ],
    };
    const out = withoutRecipe(hooks, 'test-output-trim');
    expect(out.removed).toBe(2);
    expect(out.hooks.PostToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }]);
    expect(isRecipeHandler({ command: '/x/recipes/other.sh' }, 'test-output-trim')).toBe(false);
  });

  test('withoutRecipe leaves shapes it does not know alone', () => {
    const odd = { PreToolUse: 'not a list', Stop: [{ hooks: [{ type: 'command', command: '/x/recipes/stop-verify.sh' }] }] } as unknown as HooksConfig;
    const out = withoutRecipe(odd, 'stop-verify');
    expect(out.removed).toBe(1);
    expect(out.hooks).toEqual({ PreToolUse: 'not a list' } as unknown as HooksConfig);
  });

  test('every matcher a Codex install writes has no lookaround (Rust regex has none)', () => {
    for (const r of HOOK_RECIPES.filter((x) => x.targets.includes('codex'))) {
      const hooks = toCodex(recipeHooks(r, '/s.sh', {}, false));
      for (const groups of Object.values(hooks)) for (const g of groups ?? []) if (g.matcher) expect(g.matcher).not.toMatch(/\(\?<?[=!]/);
    }
  });

  test('mcp-write-gate asks for writes and stays quiet for Conclave and Basic Memory when the matcher lets them through', () => {
    if (missing(['bash', 'jq']).length) return;
    const r = HOOK_RECIPES.find((x) => x.id === 'mcp-write-gate')!;
    const dir = tempDir('conclave-recipe-gate-');
    dirs.push(dir);
    const file = join(dir, 'gate.sh');
    writeFileSync(file, r.script!, { mode: 0o755 });
    const run = (tool: string) => Bun.spawnSync(['bash', file], { stdin: Buffer.from(JSON.stringify({ tool_name: tool, tool_input: {} })) });
    for (const tool of ['mcp__basic-memory__write_note', 'mcp__conclave__memory_save']) {
      const p = run(tool);
      expect(p.exitCode).toBe(0);
      expect(p.stdout.toString()).toBe('');
    }
    const ask = run('mcp__github__create_issue');
    expect(JSON.parse(ask.stdout.toString()).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  test('Gemini export renames events and tools and uses milliseconds', () => {
    const g = toGemini(recipeHooks(HOOK_RECIPES.find((x) => x.id === 'git-work-saver')!, '/s.sh', {}, false)) as Record<string, Array<{ matcher?: string; hooks: Array<{ timeout?: number }> }>>;
    expect(Object.keys(g)).toEqual(['BeforeTool']);
    expect(g.BeforeTool[0].matcher).toBe('run_shell_command');
    expect(g.BeforeTool[0].hooks[0].timeout).toBe(10_000);
    expect(() => toGemini({ PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }] })).toThrow(/no PermissionRequest/);
  });
});

describe('HookRecipes service', () => {
  function service(opts: { which?: (b: string) => string | null; trusted?: (cwd: string) => boolean } = {}) {
    const home = tempDir('conclave-recipes-home-');
    const project = tempDir('conclave-recipes-proj-');
    dirs.push(home, project);
    const scopes = new Map<string, HooksConfig>();
    const kv = new Map<string, unknown>();
    const device = new FakeMachine({ home: tempDir('conclave-recipes-dev-') });
    dirs.push(device.home);
    const audits: string[] = [];
    const svc = new HookRecipes({
      hooksDir: join(home, 'hooks'),
      configPath: join(home, 'config.json'),
      readScope: (scope, cwd) => structuredClone(scopes.get(scope === 'user' ? 'user' : cwd!) ?? {}),
      saveScope: (scope, cwd, hooks) => void scopes.set(scope === 'user' ? 'user' : cwd!, structuredClone(hooks)),
      machine: (id) => (id === 'arch-desktop' ? device : undefined),
      store: { get: <T>(k: string, f: T) => (kv.has(k) ? (kv.get(k) as T) : f), set: (k, v) => void kv.set(k, structuredClone(v)) },
      audit: (a, d) => void audits.push(`${a} ${d}`),
      which: opts.which,
      trusted: opts.trusted,
    });
    return { svc, home, project, scopes, device, audits };
  }

  test('install at user scope writes the script, adds tagged handlers and runs the tests', async () => {
    const { svc, home, scopes, audits } = service();
    const res = await svc.install('secrets-firewall', { scope: 'user' });
    const script = join(home, 'hooks', 'recipes', 'secrets-firewall.sh');
    expect(existsSync(script)).toBe(true);
    expect(statSync(script).mode & 0o777).toBe(0o755);
    expect(readFileSync(script, 'utf8')).toBe(HOOK_RECIPES.find((r) => r.id === 'secrets-firewall')!.script!);
    const user = scopes.get('user')!;
    const handlers = Object.values(user).flatMap((g) => g!.flatMap((x) => x.hooks)) as Array<{ command?: string; recipe?: string }>;
    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers.every((h) => h.recipe === 'secrets-firewall' && h.command?.includes(script))).toBe(true);
    expect(res.file).toBe(join(home, 'config.json'));
    if (!missing(['bash', 'jq']).length) expect(res.tests.every((t) => t.ok)).toBe(true);
    expect(svc.list().find((r) => r.id === 'secrets-firewall')!.installed.map((i) => i.scope)).toEqual(['user']);
    expect(audits[0]).toContain('hooks.recipe.install secrets-firewall user');
  }, 60_000);

  test('installing again with new tunables replaces the handlers instead of doubling them', async () => {
    const { svc, scopes } = service();
    await svc.install('test-output-trim', { scope: 'user', skipTests: true });
    await svc.install('test-output-trim', { scope: 'user', env: { TEST_TRIM_MIN: '8000' }, skipTests: true });
    const list = scopes.get('user')!.PostToolUse!;
    expect(list.length).toBe(1);
    expect((list[0].hooks[0] as { command: string }).command).toStartWith("TEST_TRIM_MIN='8000' ");
    expect(svc.get('test-output-trim').installed[0].env).toEqual({ TEST_TRIM_MIN: '8000' });
  });

  test('project scope goes to that folder, and remove takes handlers and the script away', async () => {
    const { svc, home, project, scopes } = service();
    await svc.install('proxmox-guard', { scope: 'project', cwd: project, skipTests: true });
    await svc.install('test-output-trim', { scope: 'user', skipTests: true });
    expect(Object.keys(scopes.get(project)!)).toContain('PreToolUse');
    expect(svc.installed('proxmox-guard', project)[0]).toMatchObject({ scope: 'project', cwd: project });
    const script = join(home, 'hooks', 'recipes', 'proxmox-guard.sh');
    expect(existsSync(script)).toBe(true);
    const res = await svc.remove('proxmox-guard', { scope: 'project', cwd: project });
    expect(res.removed).toBe(1);
    expect(scopes.get(project)).toEqual({});
    expect(existsSync(script)).toBe(false);
    // the other recipe stays
    expect(scopes.get('user')!.PostToolUse!.length).toBe(1);
  });

  test('missing programs refuse the install unless forced', async () => {
    const { svc } = service({ which: (b) => (b === 'jq' ? null : `/usr/bin/${b}`) });
    await expect(svc.install('git-work-saver', { scope: 'user' })).rejects.toThrow(/needs jq on the hub/);
    const res = await svc.install('git-work-saver', { scope: 'user', force: true, skipTests: true });
    expect(res.ok).toBe(true);
  });

  test('install into Claude Code on a device writes its settings without the recipe field, and remove finds it by path', async () => {
    const { svc, device } = service();
    const settings = join(device.home, '.claude', 'settings.json');
    await device.writeFile(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    const res = await svc.install('git-work-saver', { scope: 'user', target: { cli: 'claude-code', device: 'arch-desktop' }, skipTests: true });
    expect(res.installed).toMatchObject({ scope: 'claude-code', device: 'arch-desktop' });
    const data = JSON.parse(readFileSync(settings, 'utf8'));
    expect(data.model).toBe('opus');
    expect(data.hooks.Stop.length).toBe(1);
    const h = data.hooks.PreToolUse[0].hooks[0];
    expect(h.command).toBe(join(device.home, '.conclave', 'hooks', 'recipes', 'git-work-saver.sh'));
    expect(h.recipe).toBeUndefined();
    expect(existsSync(h.command)).toBe(true);
    expect(svc.get('git-work-saver').installed.map((i) => i.scope)).toEqual(['claude-code']);

    const rm = await svc.remove('git-work-saver', { cli: 'claude-code', device: 'arch-desktop' });
    expect(rm.removed).toBe(1);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    expect(after.hooks.PreToolUse).toBeUndefined();
    expect(after.hooks.Stop.length).toBe(1);
    expect(existsSync(h.command)).toBe(false);
  });

  test('a project folder must be a full path, so nothing lands next to where the hub started', async () => {
    const { svc, scopes } = service();
    await expect(svc.install('proxmox-guard', { scope: 'project', cwd: 'code/app', skipTests: true })).rejects.toThrow(/must be a full path/);
    await expect(svc.install('proxmox-guard', { scope: 'project', cwd: '../../etc', skipTests: true })).rejects.toThrow(RecipeError);
    await expect(svc.remove('proxmox-guard', { scope: 'project', cwd: 'code/app' })).rejects.toThrow(/must be a full path/);
    expect(scopes.size).toBe(0);
  });

  test('a project install says when the folder is not trusted yet, since its hooks stay off', async () => {
    const off = service({ trusted: () => false });
    expect((await off.svc.install('proxmox-guard', { scope: 'project', cwd: off.project, skipTests: true })).note).toMatch(/not trusted yet/);
    const on = service({ trusted: () => true });
    expect((await on.svc.install('proxmox-guard', { scope: 'project', cwd: on.project, skipTests: true })).note).toBeUndefined();
    expect((await on.svc.install('proxmox-guard', { scope: 'user', skipTests: true })).note).toBeUndefined();
  });

  test('an old install record with a relative folder can still be removed, without touching files', async () => {
    const { svc, scopes } = service();
    const store = (svc as unknown as { host: { store: { set(k: string, v: unknown): void } } }).host.store;
    store.set('hooks.recipes.installs', { 'proxmox-guard': [{ scope: 'project', cwd: 'qa-rel', env: {}, installedAt: 1 }] });
    expect(svc.installed('proxmox-guard').map((i) => i.cwd)).toEqual(['qa-rel']);
    expect(await svc.remove('proxmox-guard', { scope: 'project', cwd: 'qa-rel' })).toEqual({ ok: true, removed: 0 });
    expect(svc.installed('proxmox-guard')).toEqual([]);
    expect(scopes.size).toBe(0);
  });

  test('Codex gets matchers without lookahead, the script skips what the lookahead skipped, and both CLIs get a next step', async () => {
    const { svc, device } = service();
    const res = await svc.install('mcp-write-gate', { scope: 'user', target: { cli: 'codex', device: 'arch-desktop' }, skipTests: true });
    expect(res.note).toMatch(/trust/);
    const codex = JSON.parse(readFileSync(join(device.home, '.codex', 'hooks.json'), 'utf8'));
    const matcher: string = codex.hooks.PreToolUse[0].matcher;
    expect(matcher).not.toContain('(?');
    expect(matcher.startsWith('^mcp__.*__(create|')).toBe(true);
    const cc = await svc.install('mcp-write-gate', { scope: 'user', target: { cli: 'claude-code', device: 'arch-desktop' }, skipTests: true });
    expect(cc.note).toMatch(/Restart/);
    // Claude Code keeps the JavaScript regex as it is
    expect(JSON.parse(readFileSync(join(device.home, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].matcher).toContain('(?!conclave__');
  });

  test('remove refuses a settings file that is not valid JSON instead of failing with a parse error', async () => {
    const { svc, device } = service();
    await device.writeFile(join(device.home, '.claude', 'settings.json'), '{ "hooks": { // a comment\n } }');
    await expect(svc.remove('git-work-saver', { cli: 'claude-code', device: 'arch-desktop' })).rejects.toThrow(/not valid JSON.*will not overwrite/);
  });

  test('a recipe that only works in some CLIs refuses the others', async () => {
    const { svc } = service();
    await expect(svc.install('ri-trace-export', { scope: 'user' })).rejects.toThrow(/works only in claude-code/);
    await expect(svc.install('git-work-saver', { scope: 'user', target: { cli: 'claude-code', device: 'pve' } })).rejects.toThrow(/not connected/);
    await expect(svc.install('nope', { scope: 'user' })).rejects.toThrow(/no hook recipe called nope/);
  });
});
