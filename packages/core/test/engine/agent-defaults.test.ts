import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_AGENTS, builtinAgentDefault, builtinAgents } from '../../src/extensions/builtin-agents';
import { BASE_PROMPT, MODE_NOTES, basePromptFor, buildSystemPrompt, parseModeNotes } from '../../src/session/prompt';
import { createEngine } from '../../src/engine';
import type { Session } from '../../src/types';
import { cleanup, tempDir } from '../extensions/_helpers';
import { startTestEngine } from './harness';

const DIR = join(import.meta.dir, '..', '..', 'src', 'agents-defaults');

describe('built-in agents come from agents-defaults/*.md', () => {
  test('every agent file is loaded, in a stable order, with its frontmatter', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'BASE.md' && f !== 'modes.md').map((f) => f.slice(0, -3));
    expect(BUILTIN_AGENTS.map((a) => a.name).sort()).toEqual(files.sort());
    expect(BUILTIN_AGENTS[0].name).toBe('assistant');
    for (const a of BUILTIN_AGENTS) {
      expect(a.source).toBe('builtin');
      expect(a.description.length).toBeGreaterThan(20);
      expect(a.prompt.length).toBeGreaterThan(500);
      expect(a.prompt.startsWith('---')).toBe(false);
      // the body is the file minus its frontmatter
      expect(readFileSync(join(DIR, `${a.name}.md`), 'utf8')).toContain(a.prompt.slice(0, 200));
    }
    const planner = BUILTIN_AGENTS.find((a) => a.name === 'planner')!;
    expect(planner.mode).toBe('plan');
    expect(planner.permissionMode).toBe('plan');
    expect(planner.tools).toContain('ExitPlanMode');
    const explore = BUILTIN_AGENTS.find((a) => a.name === 'explore')!;
    expect(explore.subagent).toBe(true);
    expect(explore.primary).toBeUndefined();
    expect(BUILTIN_AGENTS.find((a) => a.name === 'assistant')!.memory).toBe('global');
    // multi-line YAML descriptions fold to one line
    expect(BUILTIN_AGENTS.find((a) => a.name === 'coder')!.description).not.toContain('\n');
  });

  test('builtinAgents() returns copies and builtinAgentDefault() the raw file', () => {
    const a = builtinAgents();
    a[0].prompt = 'changed';
    expect(BUILTIN_AGENTS[0].prompt).not.toBe('changed');
    const d = builtinAgentDefault('coder')!;
    expect(d.markdown).toBe(readFileSync(join(DIR, 'coder.md'), 'utf8'));
    expect(d.agent.name).toBe('coder');
    expect(builtinAgentDefault('nope')).toBeUndefined();
  });
});

describe('base prompt and mode notes come from BASE.md and modes.md', () => {
  test('mode notes render as "# Mode: <name>"', () => {
    expect(BASE_PROMPT).toBe(readFileSync(join(DIR, 'BASE.md'), 'utf8').trim());
    expect(Object.keys(MODE_NOTES).sort()).toEqual(['chat', 'loop', 'plan', 'ultra', 'workflow']);
    expect(MODE_NOTES.plan).toStartWith('# Mode: plan\nYou are in plan mode.');
    expect(parseModeNotes('## chat\nA\n\n## plan\nB\nC\n')).toEqual({ chat: '# Mode: chat\nA', plan: '# Mode: plan\nB\nC' });
  });

  test('the composed system prompt starts with BASE.md, then environment, mode note and role', () => {
    const agent = BUILTIN_AGENTS.find((a) => a.name === 'planner')!;
    const session = { id: 's', cwd: '/repo', agent: 'planner', mode: 'plan' } as Session;
    const blocks = buildSystemPrompt({
      session, agent, modelRef: 'x/y', mode: 'plan', toolNames: [], platform: 'linux', isGitRepo: true, deviceName: 'hub',
      projectInstructions: [], profile: [], skills: [], subagents: [], date: '2026-10-16',
    });
    expect(blocks[0].text).toBe(basePromptFor([]));
    expect(blocks[1].text).toStartWith('# Environment');
    expect(blocks[2].text).toBe(MODE_NOTES.plan!);
    expect(blocks[3].text).toBe(`# Your role: planner\n${agent.prompt}`);
  });

  test('a model other than Claude gets the tool-use section, naming only the tools it has', () => {
    const agent = BUILTIN_AGENTS.find((a) => a.name === 'coder')!;
    const session = { id: 's', cwd: '/repo', agent: 'coder', mode: 'agent' } as Session;
    const prompt = (modelRef: string, toolNames: string[]) =>
      buildSystemPrompt({ session, agent, modelRef, mode: 'agent', toolNames, platform: 'linux', isGitRepo: true, deviceName: 'hub', projectInstructions: [], profile: [], skills: [], subagents: [], date: '2026-10-25' }).map((b) => b.text);
    const glm = prompt('zai/glm-5.3', ['Read', 'Bash', 'Task', 'ToolSearch']);
    const note = glm.find((t) => t.startsWith("# Using Conclave's tools"))!;
    expect(glm.indexOf(note)).toBe(2);
    for (const tool of ['Read opens', 'unzip', 'Task runs', 'ToolSearch']) expect(note).toContain(tool);
    expect(note).not.toContain('Delegate');
    expect(note).not.toContain('Workflow');
    expect(prompt('google/gemini-3-flash-preview', ['Read']).some((t) => t.startsWith("# Using Conclave's tools"))).toBe(true);
    for (const ref of ['anthropic/claude-opus-5-5', 'cliproxy/neu/claude-sonnet-5-5']) expect(prompt(ref, ['Read']).some((t) => t.startsWith("# Using Conclave's tools"))).toBe(false);
    expect(prompt('zai/glm-5.3', []).some((t) => t.startsWith("# Using Conclave's tools"))).toBe(false);
  });

  test('the tool-use section follows the model an alias resolves to, not the alias', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5', 'glm-5.3'], script: [[{ text: 'ok' }]] });
    try {
      const s = await t.engine.createSession({ title: 's', agent: 'coder', cwd: t.cwd });
      const has = async (ref: string) => (await t.engine.systemPromptFor(s, t.engine.agentFor(s), ref, 'agent', ['Read'])).some((b) => b.text.startsWith("# Using Conclave's tools"));
      // "smart" is the default model, a Claude model
      expect(await has('smart')).toBe(false);
      expect(await has('mock/glm-5.3')).toBe(true);
    } finally {
      await t.close();
    }
  });

  test('memory and skill rules are in the base prompt only when their tools are', () => {
    const none = basePromptFor(['Read', 'Bash']);
    expect(none).not.toContain('# Memory');
    expect(none).not.toContain('# Skills you write');
    expect(none).toStartWith('You are running inside Conclave');
    expect(none).toContain('# Tone and style');
    const both = basePromptFor(['Read', 'MemorySave', 'SkillManage']);
    expect(both).toBe(BASE_PROMPT);
    const memoryOnly = basePromptFor(['SessionSearch']);
    expect(memoryOnly).toContain('# Memory');
    expect(memoryOnly).not.toContain('# Skills you write');
  });
});

describe('Engine.agentDefault', () => {
  test('reports the shipped default and whether a user copy overrides it', async () => {
    const home = tempDir('conclave-defaults-');
    const claude = tempDir('conclave-defaults-claude-');
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claude;
    const engine = await createEngine({ home, noBackground: true, version: 'test' });
    try {
      const before = engine.agentDefault('tutor')!;
      expect(before.overridden).toBe(false);
      expect(before.resettable).toBe(false);
      expect(before.activeSource).toBe('builtin');
      expect(before.markdown).toContain('name: tutor');

      await engine.extensions.saveAgent({ ...before.agent, prompt: 'My own tutor.', source: 'user' }, 'user');
      const after = engine.agentDefault('tutor')!;
      expect(after.overridden).toBe(true);
      expect(after.resettable).toBe(true);
      expect(after.active?.prompt).toBe('My own tutor.');
      expect(after.agent.prompt).toBe(before.agent.prompt);

      await engine.extensions.deleteAgent('tutor');
      expect(engine.agentDefault('tutor')!.overridden).toBe(false);
      expect(engine.agentDefault('not-builtin')).toBeUndefined();
    } finally {
      await engine.shutdown();
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      cleanup(home, claude);
    }
  });
});

/**
 * Canary for the specialist prompts (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 4.3 and 4.7): each agent's key lines are pinned, so an edit that drops the
 * refute default, an output contract, the owned-files rule, never fixing
 * source or factored checking fails here.
 */
describe('specialist agents keep their key lines', () => {
  const by = Object.fromEntries(BUILTIN_AGENTS.map((a) => [a.name, a]));
  const SPECIALISTS = ['verifier', 'builder', 'tester', 'debugger', 'designer', 'refactorer', 'docs-writer', 'web-searcher', 'code-researcher', 'fact-checker', 'synthesizer'];
  const PINNED: Record<string, string[]> = {
    verifier: ['Treat it as a false positive until', 'the verdict is unverifiable, never refuted', 'refuted as pre-existing', 'not realistic', '"verdict": "confirmed | refuted | unverifiable"'],
    builder: ['Change only the files the brief names', 'stop and report which file and why', 'Never hard-code an expected value or special-case a test', 'If a test contradicts the brief', 'Line 1: done, partial or blocked', 'its exit code and its last 10 lines'],
    tester: ['You never change source code', 'injected clock', 'Never sleep', 'Never weaken an assertion', 'minimal repro command and input', 'whether the code or the test is wrong'],
    debugger: ['You diagnose; you do not fix, unless the brief says so', 'Reproduce it first', 'never in the real tree', 'The strongest alternative cause', '"confirmed by repro"', 'do not, and flag it'],
    designer: ['name the rule and ask before you break it', '390 and 1440 pixels wide, in light and in dark', 'Never describe a screenshot you did not look at', 'Pass or fail for each design rule'],
    refactorer: ['If any fail before you touch anything, stop', 'indirect forms', 'Make one refactor at a time', 'Reference counts before and after', 'rounding, ordering, error text and defaults'],
    'docs-writer': ['When you find no source, do not write the fact', 'list it as unverified', 'Run only read-only commands and `--help`', 'Each changed fact, with its source'],
    'web-searcher': ['Open a page with WebFetch before you cite it', 'A search snippet is a lead, never evidence', 'at most 8 searches', '25 words or fewer', 'page date'],
    'code-researcher': ['Never run code from the repository', '--depth 1 --filter=blob:none --sparse', 'repo@sha:path:line', 'The answer first'],
    'fact-checker': ['not the report they came from', 'off by 10x', 'the primary page wins', 'unverifiable: the page would not open'],
    synthesizer: ['Use only claims marked supported', 'Add no facts from memory', 'Start with the verdict', 'Left out (unverified)'],
    workflow: ['Do not ask questions', 'your final message goes to a script, not a person', 'StructuredOutput'],
    reviewer: ['Finder mode', 'report every candidate', 'Do not invent problems', 'Do not run tests or scripts from the change until you have read what they add', 'never install dependencies'],
    explore: ['quick', 'very thorough', 'Files to read next'],
    planner: ['names the check command that proves it worked', 'fits in one sentence'],
    coder: ['Never hard-code expected values or special-case a test', 'A change you can describe in one sentence needs no plan', 'builder for one scoped change'],
    researcher: ['one web-searcher each, at most 5 at once and at most 2 rounds', 'deep-research workflow', 'Ask one clarifying question'],
  };

  test('every specialist ships, as a subagent, with its key lines', () => {
    for (const name of [...SPECIALISTS, 'workflow']) expect(by[name]).toBeDefined();
    for (const name of SPECIALISTS) {
      expect(by[name].subagent).toBe(true);
      expect(by[name].primary).toBeUndefined();
    }
    // the workflow profile is the default step of a script, not something Task offers
    expect(by.workflow.subagent).toBeUndefined();
    expect(by.workflow.disallowedTools).toEqual(expect.arrayContaining(['AskUserQuestion', 'Workflow', 'Task']));
    for (const [name, lines] of Object.entries(PINNED)) for (const line of lines) expect({ name, has: by[name].prompt.includes(line) }).toEqual({ name, has: true });
  });

  test('tiers, effort, tools and recipes match the spec table', () => {
    expect(by.verifier.model).toBe('deep');
    expect(by.verifier.thinking).toBe('xhigh');
    expect(by.debugger.model).toBe('deep');
    expect(by['docs-writer'].model).toBe('fast');
    expect(by['web-searcher'].model).toBe('fast');
    for (const n of ['builder', 'tester', 'designer', 'refactorer', 'code-researcher', 'fact-checker', 'synthesizer']) expect(by[n].model).toBe('smart');
    // readers and checkers cannot write
    for (const n of ['verifier', 'debugger', 'code-researcher', 'fact-checker']) for (const t of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) expect(by[n].tools).not.toContain(t);
    expect(by['fact-checker'].tools).toEqual(['WebFetch', 'WebSearch', 'Read']);
    expect(by.synthesizer.tools).toEqual(['Read', 'Write']);
    const recipes = (n: string) => (by[n].recipes ?? []).map((r) => r.split(/\s+/)[0]);
    for (const n of ['coder', 'builder', 'refactorer']) expect(recipes(n)).toEqual(expect.arrayContaining(['verify-gate', 'no-test-gaming', 'diff-budget']));
    expect(recipes('coder')).toContain('new-dependency-gate');
    expect(recipes('builder')).toContain('new-dependency-gate');
    // the regression gate: changed tests run on the code from before the turn (session/regression-gate.ts)
    for (const n of ['coder', 'builder', 'tester']) expect(recipes(n)).toContain('regression-gate');
    for (const n of ['refactorer', 'designer', 'docs-writer']) expect(recipes(n)).not.toContain('regression-gate');
    expect(recipes('tester')).toEqual(['no-test-gaming', 'write-scope', 'regression-gate']);
    expect(by.tester.recipes![1]).toContain('**/*.test.*');
    expect(recipes('docs-writer')).toEqual(['write-scope']);
    expect(by['docs-writer'].recipes![0]).toContain('**/*.md');
    expect(recipes('web-searcher')).toEqual(['write-scope']);
    expect(recipes('designer')).toEqual(['verify-gate']);
    // evidence-before-done stays off by default (4.6)
    for (const a of BUILTIN_AGENTS) expect(recipes(a.name)).not.toContain('evidence-before-done');
  });

  test('prompts stay short, with no shouting, no dashes and no hype words outside the style line', () => {
    const BANNED = /\b(seamless|robust|leverage|unlock|empower|delve|elevate|streamline)\b/i;
    for (const name of [...SPECIALISTS, 'workflow']) {
      const words = by[name].prompt.split(/\s+/).length;
      expect({ name, short: words <= 360 }).toEqual({ name, short: true });
    }
    const texts: Array<[string, string]> = [...BUILTIN_AGENTS.map((a) => [a.name, a.prompt] as [string, string]), ['BASE', BASE_PROMPT], ['modes', readFileSync(join(DIR, 'modes.md'), 'utf8')]];
    for (const [name, text] of texts) {
      expect({ name, caps: /\b(MUST|CRITICAL|IMPORTANT|NEVER|ALWAYS)\b/.test(text) }).toEqual({ name, caps: false });
      for (const line of text.split('\n')) {
        // the docs writer and the synthesizer list the banned words on their style line, to avoid them
        if (/^(- )?Style:/.test(line)) continue;
        expect({ name, line, dash: /[–—]/.test(line), hype: BANNED.test(line) }).toEqual({ name, line, dash: false, hype: false });
      }
    }
  });

  test('BASE.md and modes.md carry the round 5 lines', () => {
    expect(BASE_PROMPT).toContain('Before you say how code behaves, open it.');
    expect(BASE_PROMPT).toContain('Do not start a subagent to verify or double-check your own work');
    expect(MODE_NOTES.ultra).toStartWith('# Mode: ultra\nUltra is on.');
    expect(MODE_NOTES.workflow).toStartWith('# Mode: workflow\nYou are one step of a workflow.');
  });
});
