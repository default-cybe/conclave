import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { syncToClis } from '../../src/extensions/cli-sync';
import type { AgentDef, SkillDef } from '../../src/extensions/types';
import { FakeMachine, tempDir, cleanup, write } from './_helpers';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

function userSkill(dir: string): SkillDef {
  write(join(dir, 'SKILL.md'), `---\nname: my-skill\ndescription: d\n---\nbody`);
  write(join(dir, 'ref.md'), 'reference content');
  return { name: 'my-skill', description: 'd', dir, path: join(dir, 'SKILL.md'), source: 'user' };
}

const agent: AgentDef = { name: 'my-agent', description: 'd', prompt: 'agent body', tools: ['Read'], source: 'user' };

describe('syncToClis', () => {
  test('writes user skills and agents into present CLIs with markers', async () => {
    const home = tempDir();
    const skillSrc = tempDir();
    dirs.push(home, skillSrc);
    const machine = new FakeMachine({ home, clis: { codex: '1.0' } });
    const written = await syncToClis(machine, { skills: [userSkill(skillSrc)], agents: [agent] });

    // Claude Code (always) and Codex (present) get the files.
    const claudeSkill = join(home, '.claude', 'skills', 'my-skill', 'SKILL.md');
    const claudeMarker = join(home, '.claude', 'skills', 'my-skill', '.conclave-managed');
    const claudeAgent = join(home, '.claude', 'agents', 'my-agent.md');
    // Codex, OpenCode and Gemini share one copy in ~/.agents/skills.
    const codexSkill = join(home, '.agents', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(claudeSkill)).toBe(true);
    expect(existsSync(claudeMarker)).toBe(true);
    expect(existsSync(join(home, '.claude', 'skills', 'my-skill', 'ref.md'))).toBe(true);
    expect(existsSync(claudeAgent)).toBe(true);
    expect(readFileSync(claudeAgent, 'utf8')).toContain('agent body');
    expect(existsSync(codexSkill)).toBe(true);
    // Codex reads agent roles as TOML, never .md.
    const codexAgent = join(home, '.codex', 'agents', 'my-agent.toml');
    expect(readFileSync(codexAgent, 'utf8')).toContain('developer_instructions');
    expect(existsSync(join(home, '.codex', 'agents', 'my-agent.md'))).toBe(false);
    // OpenCode and Gemini absent -> not written.
    expect(existsSync(join(home, '.config', 'opencode', 'agent', 'my-agent.md'))).toBe(false);
    expect(existsSync(join(home, '.gemini', 'agents', 'my-agent.md'))).toBe(false);
    expect(written.some((p) => p.endsWith('.conclave-managed'))).toBe(true);
  });

  test('never overwrites a user-owned folder without the marker', async () => {
    const home = tempDir();
    const skillSrc = tempDir();
    dirs.push(home, skillSrc);
    const machine = new FakeMachine({ home });
    // Pre-create a user-owned skill folder (no marker).
    const existing = join(home, '.claude', 'skills', 'my-skill', 'SKILL.md');
    write(existing, 'USER OWNED, DO NOT TOUCH');

    await syncToClis(machine, { skills: [userSkill(skillSrc)], agents: [] });
    expect(readFileSync(existing, 'utf8')).toBe('USER OWNED, DO NOT TOUCH');
  });

  test('only syncs user-sourced items', async () => {
    const home = tempDir();
    const skillSrc = tempDir();
    dirs.push(home, skillSrc);
    const machine = new FakeMachine({ home });
    const builtinSkill: SkillDef = { ...userSkill(skillSrc), source: 'plugin' };
    const written = await syncToClis(machine, { skills: [builtinSkill], agents: [] });
    expect(written.length).toBe(0);
  });

  test('an agent whose frontmatter name climbs out of the agents folder is not synced', async () => {
    const home = tempDir();
    dirs.push(home);
    const machine = new FakeMachine({ home, clis: { codex: '1.0', opencode: '1.0' } });
    const written = await syncToClis(machine, { skills: [], agents: [{ ...agent, name: '../CLAUDE' }, agent] });
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(home, '.codex', 'CLAUDE.toml'))).toBe(false);
    expect(written.every((p) => !p.includes('CLAUDE'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'agents', 'my-agent.md'))).toBe(true);
  });
});
