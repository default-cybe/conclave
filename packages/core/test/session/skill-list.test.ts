import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillDef } from '../../src/extensions/types';
import { resolveName } from '../../src/extensions/registry';
import { DEFAULT_SKILL_TOKENS, estimateTokens, matchSkills, skillsSection } from '../../src/session/skill-list';
import { buildSystemPrompt } from '../../src/session/prompt';
import { SkillTool } from '../../src/tools/skill';
import { createEngine } from '../../src/engine';
import { fakeHost, makeCtx, text } from '../tools/helpers';

const TOPICS = ['kubernetes', 'postgres', 'react', 'django', 'rust', 'terraform', 'kafka', 'swift', 'flutter', 'graphql'];

/** 500 skills: 480 in five plugins, 20 of the hub's own; descriptions about 200 characters. */
function fakeSkills(): SkillDef[] {
  const out: SkillDef[] = [];
  for (let i = 0; i < 500; i++) {
    const plugin = i < 480 ? `pack${i % 5}` : undefined;
    const topic = TOPICS[i % TOPICS.length];
    const base = `${topic}-helper-${i}`;
    out.push({
      name: plugin ? `${plugin}:${base}` : base,
      description: `Patterns and checks for ${topic} work number ${i}: setup, review, failure modes, and the commands to verify a change. Use when a ${topic} task needs a careful, repeatable method.`,
      dir: `/skills/${base}`,
      path: `/skills/${base}/SKILL.md`,
      source: plugin ? 'plugin' : 'user',
      ...(plugin ? { plugin } : {}),
    });
  }
  out.push({ name: 'pack0:zebra-striping', description: 'Stripe zebra tables in spreadsheets with alternating colors.', dir: '/z', path: '/z/SKILL.md', source: 'plugin', plugin: 'pack0' });
  return out;
}

const described = (section: string, s: SkillDef) => section.includes(`- ${s.name}: ${s.description}`);
const short = (s: SkillDef) => (s.plugin ? s.name.slice(s.plugin.length + 1) : s.name);

describe('skills section budget', () => {
  const skills = fakeSkills();

  test('a small list keeps every description, as before', () => {
    const few = skills.slice(0, 5);
    const out = skillsSection({ skills: few });
    for (const s of few) expect(described(out, s)).toBe(true);
    expect(out).not.toContain('by name only');
  });

  test('500 skills stay under the budget and every name stays in the section', () => {
    const out = skillsSection({ skills, context: 'general-purpose' });
    expect(estimateTokens(skillsSection({ skills, budget: 0 }))).toBeGreaterThan(DEFAULT_SKILL_TOKENS * 4);
    expect(estimateTokens(out)).toBeLessThanOrEqual(DEFAULT_SKILL_TOKENS);
    const lines = out.split('\n');
    for (const s of skills) {
      const groupLine = lines.find((l) => l.startsWith(s.plugin ? `- ${s.plugin}: ` : '- ') && !l.includes(': Patterns'));
      expect(described(out, s) || !!groupLine?.split(/: |, /).includes(short(s))).toBe(true);
    }
    // the hub's own skills keep their descriptions before plugin skills do
    expect(skills.filter((s) => s.source === 'user').some((s) => described(out, s))).toBe(true);
  });

  test("the agent's own skills and keyword matches get descriptions", () => {
    const own = skills[7];
    const out = skillsSection({ skills, wanted: [short(own)], context: 'Please stripe the zebra table colors in my spreadsheet' });
    expect(described(out, own)).toBe(true);
    const zebra = skills.find((s) => s.name === 'pack0:zebra-striping')!;
    expect(matchSkills(skills, 'stripe zebra colors')[0]).toBe(zebra);
    expect(described(out, zebra)).toBe(true);
  });

  test('past the names cap, plugins show as counts with the Skill query hint', () => {
    const out = skillsSection({ skills, budget: 1000 });
    expect(estimateTokens(out)).toBeLessThanOrEqual(1000);
    expect(out).toContain('- pack0: ');
    expect(out).toMatch(/- pack1: \d+ skills/);
    expect(out).toContain('query set to a plugin name');
  });

  test('the Skill tool loads a name-only skill and lists or searches the rest', async () => {
    const out = skillsSection({ skills, context: '' });
    const nameOnly = skills.find((s) => s.plugin === 'pack3' && !described(out, s))!;
    const host = {
      ...fakeHost(),
      async loadSkill(name: string) {
        const s = resolveName(skills, name);
        return s ? { name: s.name, body: `Body of ${s.name}`, dir: s.dir } : undefined;
      },
      async listSkills() {
        return skills;
      },
    };
    const loaded = await SkillTool.run({ skill: nameOnly.name }, makeCtx({ cwd: '/tmp', host: host as never }));
    expect(loaded.isError).toBeFalsy();
    expect(text(loaded)).toContain(`Body of ${nameOnly.name}`);
    const listed = text(await SkillTool.run({ query: 'pack3' }, makeCtx({ cwd: '/tmp', host: host as never })));
    expect(listed).toContain('96 skills in pack3');
    expect(listed).toContain(nameOnly.name);
    const found = text(await SkillTool.run({ query: 'zebra stripes' }, makeCtx({ cwd: '/tmp', host: host as never })));
    expect(found.split('\n')[1]).toContain('pack0:zebra-striping');
    expect((await SkillTool.run({}, makeCtx({ cwd: '/tmp' }))).isError).toBe(true);
  });
});

describe('skills section in a session', () => {
  test('matches the first message and is the same on the next turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-skill-list-'));
    const claude = mkdtempSync(join(tmpdir(), 'conclave-skill-list-claude-'));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claude;
    for (let i = 0; i < 300; i++) {
      const dir = join(home, 'skills', `topic-${i}`);
      mkdirSync(dir, { recursive: true });
      const desc = i === 123 ? 'Stripe zebra tables in spreadsheets.' : `Generic method ${i} for routine work with long careful steps, checks and pitfalls to avoid in practice.`;
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: topic-${i}\ndescription: ${desc}\n---\nbody ${i}\n`);
    }
    const engine = await createEngine({ home, noBackground: true, version: 'test' });
    try {
      engine.config.update({ agents: { ...engine.config.get().agents, skillTokens: 1500 } });
      const session = await engine.createSession({ title: 't', cwd: home, agent: 'general-purpose' });
      engine.addMessage(session.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: '<system-reminder>\nnoise\n</system-reminder>' }, { type: 'text', text: 'Stripe the zebra table please' }] });
      const section = async () => {
        const parts = await engine.systemPromptParts(session, engine.agentFor(session), 'x/y', 'agent', ['Skill', 'Read']);
        return buildSystemPrompt(parts).find((b) => b.text.startsWith('# Skills'))!.text;
      };
      const first = await section();
      expect(first).toContain('- topic-123: Stripe zebra tables in spreadsheets.');
      expect(estimateTokens(first)).toBeLessThanOrEqual(1500);
      engine.addMessage(session.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'Done.' }] });
      engine.addMessage(session.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Now something about kubernetes postgres react' }] });
      expect(await section()).toBe(first);
    } finally {
      await engine.shutdown();
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      rmSync(home, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
    }
  }, 30_000);
});
