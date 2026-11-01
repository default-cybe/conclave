import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { loadPathRules, loadProjectInstructions, loadScopedInstructions } from '../../src/extensions/instructions';
import { DEFAULT_CONFIG } from '../../src/config';
import { FakeMachine, tempDir, cleanup, write } from './_helpers';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

describe('loadProjectInstructions', () => {
  test('collects user and project files in load order and resolves imports', async () => {
    const home = tempDir();
    dirs.push(home);
    const machine = new FakeMachine({ home });
    const project = join(home, 'project');
    const sub = join(project, 'sub');

    // User level.
    write(join(home, '.conclave', 'CONCLAVE.md'), 'user conclave');
    write(join(home, '.claude', 'CLAUDE.md'), 'user claude');
    write(join(home, '.codex', 'AGENTS.md'), 'user agents');
    // Project level.
    write(join(project, 'CLAUDE.md'), 'project claude\nsee @shared.md');
    write(join(project, 'shared.md'), 'shared import');
    write(join(sub, 'CLAUDE.md'), 'sub claude');

    const files = await loadProjectInstructions(machine, sub, { ...DEFAULT_CONFIG });
    const contents = files.map((f) => f.content);

    expect(contents).toContain('user conclave');
    expect(contents).toContain('user claude');
    expect(contents).toContain('user agents');
    expect(contents).toContain('project claude\nsee @shared.md');
    expect(contents).toContain('shared import');
    expect(contents).toContain('sub claude');

    // Order: user before project; project root before its child (sub last).
    const idxUser = contents.indexOf('user conclave');
    const idxProject = contents.indexOf('project claude\nsee @shared.md');
    const idxSub = contents.indexOf('sub claude');
    expect(idxUser).toBeLessThan(idxProject);
    expect(idxProject).toBeLessThan(idxSub);
    // The import follows the file that imported it.
    expect(contents.indexOf('shared import')).toBeGreaterThan(idxProject);
  });

  test('compat flags gate claude and agents files', async () => {
    const home = tempDir();
    dirs.push(home);
    const machine = new FakeMachine({ home });
    write(join(home, '.claude', 'CLAUDE.md'), 'user claude');
    write(join(home, '.codex', 'AGENTS.md'), 'user agents');
    write(join(home, '.conclave', 'CONCLAVE.md'), 'user conclave');

    const config = { ...DEFAULT_CONFIG, compat: { claudeCode: false, agentsMd: false } };
    const files = await loadProjectInstructions(machine, home, config);
    const contents = files.map((f) => f.content);
    expect(contents).toContain('user conclave');
    expect(contents).not.toContain('user claude');
    expect(contents).not.toContain('user agents');
  });
});

describe('scoped instructions (item 11)', () => {
  test('nested AGENTS.md and CLAUDE.md below cwd, closest last, and rules whose paths match', async () => {
    const home = tempDir();
    dirs.push(home);
    const machine = new FakeMachine({ home });
    const project = join(home, 'project');
    write(join(project, 'AGENTS.md'), 'root agents (loads at start)');
    write(join(project, 'pkg', 'AGENTS.md'), 'pkg agents');
    write(join(project, 'pkg', 'web', 'CLAUDE.md'), 'web claude');
    write(join(project, 'pkg', 'web', 'App.tsx'), 'x');
    write(join(project, '.claude', 'rules', 'api.md'), '---\npaths: src/api/**\n---\nAPI handlers validate input with zod.');
    write(join(project, '.claude', 'rules', 'tests.md'), '---\npaths:\n  - "**/*.test.ts"\n---\nTests use bun:test.');
    write(join(project, '.claude', 'rules', 'always.md'), 'Always rule (loads at start).');
    write(join(home, '.claude', 'rules', 'tsx.md'), '---\npaths: "**/*.tsx"\n---\nComponents are function components.');

    const rules = await loadPathRules(machine, project, { ...DEFAULT_CONFIG });
    expect(rules.map((r) => r.body).sort()).toEqual(['API handlers validate input with zod.', 'Components are function components.', 'Tests use bun:test.']);

    const web = await loadScopedInstructions(machine, project, join(project, 'pkg', 'web', 'App.tsx'), { ...DEFAULT_CONFIG }, rules);
    expect(web.map((f) => f.content)).toEqual(['pkg agents', 'web claude', 'Components are function components.']);
    const api = await loadScopedInstructions(machine, project, join(project, 'src', 'api', 'users.ts'), { ...DEFAULT_CONFIG }, rules);
    expect(api.map((f) => f.content)).toEqual(['API handlers validate input with zod.']);
    const test = await loadScopedInstructions(machine, project, join(project, 'src', 'api', 'users.test.ts'), { ...DEFAULT_CONFIG }, rules);
    expect(test.map((f) => f.content)).toEqual(['API handlers validate input with zod.', 'Tests use bun:test.']);
    // the root's own files and a file outside the session folder add nothing
    expect(await loadScopedInstructions(machine, project, join(project, 'README.md'), { ...DEFAULT_CONFIG }, rules)).toEqual([]);
    expect(await loadScopedInstructions(machine, project, join(home, 'other', 'x.ts'), { ...DEFAULT_CONFIG }, [])).toEqual([]);
  });
});
