import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { loadProjectInstructions } from '../../../src/extensions/instructions';
import { DEFAULT_CONFIG } from '../../../src/config';
import { FakeMachine, tempDir, cleanup, write } from '../_helpers';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

describe('instruction files from other CLIs', () => {
  test('.claude/rules without paths load; with paths they wait; AGENTS.override.md shadows AGENTS.md', async () => {
    const home = tempDir();
    dirs.push(home);
    const project = join(home, 'project');
    write(join(project, '.claude', 'rules', 'always.md'), 'RULE ALWAYS');
    write(join(project, '.claude', 'rules', 'py', 'python.md'), '---\npaths: ["src/**/*.py"]\n---\nRULE PY');
    write(join(project, '.claude', 'CLAUDE.md'), 'DOT CLAUDE');
    write(join(project, 'AGENTS.md'), 'AGENTS PLAIN');
    write(join(project, 'AGENTS.override.md'), 'AGENTS OVERRIDE');
    write(join(home, '.claude', 'rules', 'me.md'), 'USER RULE');
    const files = await loadProjectInstructions(new FakeMachine({ home }), project, { ...DEFAULT_CONFIG });
    const text = files.map((f) => f.content).join('\n');
    expect(text).toContain('RULE ALWAYS');
    expect(text).toContain('USER RULE');
    expect(text).toContain('DOT CLAUDE');
    expect(text).not.toContain('RULE PY');
    expect(text).toContain('AGENTS OVERRIDE');
    expect(text).not.toContain('AGENTS PLAIN');
  });

  test('GEMINI.md and OpenCode global AGENTS.md only with their flags', async () => {
    const home = tempDir();
    dirs.push(home);
    const project = join(home, 'project');
    write(join(project, 'GEMINI.md'), 'GEMINI PROJECT');
    write(join(home, '.gemini', 'GEMINI.md'), 'GEMINI USER');
    write(join(home, '.config', 'opencode', 'AGENTS.md'), 'OPENCODE USER');
    const machine = new FakeMachine({ home });
    const off = (await loadProjectInstructions(machine, project, { ...DEFAULT_CONFIG })).map((f) => f.content).join('\n');
    expect(off).not.toContain('GEMINI');
    expect(off).not.toContain('OPENCODE');
    const on = (await loadProjectInstructions(machine, project, { ...DEFAULT_CONFIG, compat: { ...DEFAULT_CONFIG.compat, gemini: true, opencode: true } })).map((f) => f.content);
    expect(on).toContain('GEMINI PROJECT');
    expect(on).toContain('GEMINI USER');
    expect(on).toContain('OPENCODE USER');
    expect(on.indexOf('GEMINI USER')).toBeLessThan(on.indexOf('GEMINI PROJECT'));
  });
});
