import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstUserText, startTestEngine, toolResults, type Block, type RequestBody, type Step } from './harness';
import { briefOf, renderPacket } from '../../src/modes/review';
import type { Message } from '../../src/types';

/**
 * Specialist subagents through the real engine with a scripted model
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 4.2): agent hooks and recipes,
 * model tiers, Task with a schema, the verify gate on main sessions and
 * subagents, and the frozen review packet. No paid calls.
 */

// the diff-budget recipe (coder, builder) keeps a counter file per session in TMPDIR; remove the ones these tests made
const budgetFilesBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('conclave-diff-budget-')));
afterAll(() => {
  for (const f of readdirSync(tmpdir())) if (f.startsWith('conclave-diff-budget-') && !budgetFilesBefore.has(f)) rmSync(join(tmpdir(), f), { force: true });
});

const bash = (command: string): Block => ({ tool: 'Bash', input: { command, description: 'test' } });
const write = (file_path: string, content: string): Block => ({ tool: 'Write', input: { file_path, content } });
const task = (subagent_type: string, prompt: string, extra: Record<string, unknown> = {}): Block => ({ tool: 'Task', input: { description: 'child job', prompt, subagent_type, ...extra } });

/** Route a child's requests (first user text has `marker`) through its own script. */
function childRoute(marker: string, steps: Step[]): (body: RequestBody) => Step | undefined {
  let n = 0;
  return (body) => (firstUserText(body).includes(marker) ? steps[Math.min(n++, steps.length - 1)] : undefined);
}

function notices(engine: { getMessages(id: string): Message[] }, id: string): string {
  return engine.getMessages(id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content)).join('\n');
}

describe('agent profile hooks and recipes', () => {
  test("an agent's own PreToolUse hook applies to its sessions only", async () => {
    const t = await startTestEngine({ script: [[bash('echo one')], [{ text: 'done' }], [bash('echo two')], [{ text: 'done' }]], approve: 'allow' });
    try {
      await t.engine.extensions.saveAgent(
        { name: 'guarded', description: 'test agent', prompt: 'Test agent.', source: 'user', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "echo 'refused by the guarded profile' >&2; exit 2", timeout: 10 }] }] } },
        'user',
      );
      // the saved file keeps the hooks
      expect(t.engine.extensions.agent('guarded')?.hooks?.PreToolUse?.[0].matcher).toBe('Bash');
      const guarded = await t.engine.createSession({ title: 'g', cwd: t.cwd, agent: 'guarded' });
      await t.run(guarded.id, 'go');
      expect(toolResults(t.engine, guarded.id)[0].content).toContain('refused by the guarded profile');
      const plain = await t.engine.createSession({ title: 'p', cwd: t.cwd, agent: 'general-purpose' });
      await t.run(plain.id, 'go');
      expect(toolResults(t.engine, plain.id)[0].content).toContain('two');
    } finally {
      await t.close();
    }
  }, 60_000);

  test("a subagent's Stop hooks run on SubagentStop", async () => {
    const t = await startTestEngine({
      script: [[task('stopper', 'CHILD-STOP: say hi')], [{ text: 'parent done' }]],
      route: childRoute('CHILD-STOP', [[{ text: 'hi from child' }]]),
    });
    try {
      await t.engine.extensions.saveAgent({ name: 'stopper', description: 'test child', prompt: 'Child.', source: 'user', subagent: true, hooks: { Stop: [{ hooks: [t.hook('log')] }] } }, 'user');
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      const logged = t.hookLog().map((l) => l.input);
      expect(logged.some((i) => i.hook_event_name === 'SubagentStop' && i.agent_type === 'stopper')).toBe(true);
      expect(logged.some((i) => i.hook_event_name === 'Stop')).toBe(false);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a write-scope recipe in the profile refuses writes outside its globs', async () => {
    let cwd = '';
    const t = await startTestEngine({
      script: [[{ tool: 'Write', input: { file_path: 'PLACEHOLDER_SRC', content: 'x' } }], [{ text: 'done' }]],
      approve: 'allow',
      route: (body) => {
        // fill in the real paths once the cwd is known
        const n = (body.messages?.length ?? 0) as number;
        if (n === 1) return [write(join(cwd, 'src', 'a.ts'), 'code'), write(join(cwd, 'docs', 'a.md'), '# doc')];
        return [{ text: 'done' }];
      },
    });
    cwd = t.cwd;
    try {
      await t.engine.extensions.saveAgent({ name: 'scoped', description: 'test agent', prompt: 'Docs only.', source: 'user', recipes: ['write-scope WRITE_GLOB=docs/**,**/*.md'] }, 'user');
      const s = await t.engine.createSession({ title: 's', cwd: t.cwd, agent: 'scoped' });
      await t.run(s.id, 'go');
      const results = toolResults(t.engine, s.id);
      expect(results[0].content).toContain("outside this agent's write scope");
      expect(existsSync(join(t.cwd, 'src', 'a.ts'))).toBe(false);
      expect(readFileSync(join(t.cwd, 'docs', 'a.md'), 'utf8')).toBe('# doc');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('model tiers', () => {
  test("a subagent runs on its profile's tier through models.tiers", async () => {
    const t = await startTestEngine({
      script: [[task('quick', 'CHILD-TIER: look')], [{ text: 'parent done' }]],
      route: childRoute('CHILD-TIER', [[{ text: 'looked' }]]),
      overrides: { models: { tiers: { fast: 'mock/claude-haiku-5-5', deep: 'mock/claude-sonnet-5-5' } } } as never,
    });
    try {
      await t.engine.extensions.saveAgent({ name: 'quick', description: 'test child', prompt: 'Child.', source: 'user', subagent: true, model: 'fast' }, 'user');
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      const child = t.engine.listSessions({ parentId: s.id })[0]!;
      expect(child.model).toBe('mock/claude-haiku-5-5');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a primary agent with a tier word starts sessions on a real model, and ultra: true turns Ultra on', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      await t.engine.extensions.saveAgent({ name: 'lead', description: 'test agent', prompt: 'Lead.', source: 'user', primary: true, model: 'smart', ultra: true }, 'user');
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd, agent: 'lead' });
      expect(s.model).toBe('mock/claude-sonnet-5-5');
      expect(s.ultra).toBe(true);
      const chat = await t.engine.createSession({ title: 'c', agent: 'lead', kind: 'chat' });
      expect(chat.ultra).toBeUndefined();
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('Task with a schema', () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverifiable'] }, note: { type: 'string' } }, required: ['verdict', 'note'] };

  test('the child gets StructuredOutput and the call returns the validated object', async () => {
    const t = await startTestEngine({
      script: [[task('verifier', 'CHILD-SCHEMA: check it', { schema })], [{ text: 'parent done' }]],
      route: childRoute('CHILD-SCHEMA', [
        // a bad call, then a good one, then the closing line
        [{ tool: 'StructuredOutput', input: { verdict: 'maybe', note: 'x' } }],
        [{ tool: 'StructuredOutput', input: { verdict: 'refuted', note: 'pre-existing' } }],
        [{ text: 'Recorded.' }],
      ]),
    });
    try {
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      const childReq = t.requests.map((r) => JSON.parse(r) as RequestBody).filter((b) => firstUserText(b).includes('CHILD-SCHEMA'));
      expect(childReq[0].tools?.map((x) => x.name)).toContain('StructuredOutput');
      // the parent never gets the tool
      const parentReq = t.requests.map((r) => JSON.parse(r) as RequestBody).find((b) => !firstUserText(b).includes('CHILD-SCHEMA'))!;
      expect(parentReq.tools?.map((x) => x.name)).not.toContain('StructuredOutput');
      expect(JSON.stringify(childReq[1].messages)).toContain('does not match the schema');
      const result = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual({ verdict: 'refuted', note: 'pre-existing' });
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a child that ends without the tool is nudged, and the call fails after the attempts', async () => {
    const t = await startTestEngine({
      script: [[task('general-purpose', 'CHILD-NUDGE: do it', { schema })], [{ text: 'parent done' }]],
      route: childRoute('CHILD-NUDGE', [[{ text: 'plain text, no tool' }]]),
    });
    try {
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      const childReq = t.requests.filter((r) => firstUserText(JSON.parse(r)).includes('CHILD-NUDGE'));
      expect(childReq.length).toBe(5);
      expect(childReq[1]).toContain('must go through the StructuredOutput tool');
      const result = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
      expect(result.isError).toBe(true);
      expect(result.content).toContain('no valid StructuredOutput call');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a schema with run_in_background, or one whose root is not an object, is refused', async () => {
    const t = await startTestEngine({
      script: [[task('general-purpose', 'x', { schema, run_in_background: true }), task('general-purpose', 'y', { schema: { type: 'array' } })], [{ text: 'done' }]],
    });
    try {
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      await t.run(s.id, 'go');
      const [a, b] = toolResults(t.engine, s.id);
      expect(a.content).toContain('schema needs a foreground Task');
      expect(b.content).toContain('schema is not usable');
      expect(t.engine.listSessions({ parentId: s.id }).length).toBe(0);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('verify gate', () => {
  function project(cwd: string, check: string): void {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'p', scripts: { typecheck: check } }));
    writeFileSync(join(cwd, 'bun.lock'), '');
  }

  test('a failing check sends the coder back with its output; the fix passes it', async () => {
    let cwd = '';
    const steps: Step[] = [];
    const t = await startTestEngine({
      script: [[{ text: 'unused' }]],
      approve: 'allow',
      route: () => steps.shift(),
    });
    cwd = t.cwd;
    steps.push([write(join(cwd, 'status.txt'), 'broken\n')], [{ text: 'Done.' }], [write(join(cwd, 'status.txt'), 'fixed\n')], [{ text: 'Done, the check passes.' }]);
    try {
      project(cwd, "grep -q fixed status.txt || (echo 'status.txt(1,1): error: not fixed' && exit 1)");
      t.engine.trust.set(cwd, true);
      const s = await t.engine.createSession({ title: 'c', cwd, agent: 'coder' });
      await t.run(s.id, 'fix it');
      expect(t.requests.length).toBe(4);
      expect(t.requests[2]).toContain('The check `bun run typecheck` failed (exit 1)');
      expect(t.requests[2]).toContain('error: not fixed');
      expect(notices(t.engine, s.id)).not.toContain('verify gate');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('in a folder that is not trusted the gate does not run project code, and says so once', async () => {
    const steps: Step[] = [];
    const t = await startTestEngine({ script: [[{ text: 'unused' }]], approve: 'allow', route: () => steps.shift() });
    steps.push([write(join(t.cwd, 'a.txt'), 'x')], [{ text: 'Done.' }]);
    try {
      project(t.cwd, 'touch ran.txt; exit 1');
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'go');
      expect(t.requests.length).toBe(2);
      expect(existsSync(join(t.cwd, 'ran.txt'))).toBe(false);
      expect(notices(t.engine, s.id)).toContain('The verify gate did not run');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('agents without the gate, and turns without edits, run no check', async () => {
    const steps: Step[] = [];
    const t = await startTestEngine({ script: [[{ text: 'unused' }]], approve: 'allow', route: () => steps.shift() });
    steps.push([write(join(t.cwd, 'a.txt'), 'x')], [{ text: 'Done.' }], [{ text: 'Just an answer.' }]);
    try {
      project(t.cwd, 'touch ran.txt; exit 1');
      t.engine.trust.set(t.cwd, true);
      const plain = await t.engine.createSession({ title: 'g', cwd: t.cwd, agent: 'general-purpose' });
      await t.run(plain.id, 'go');
      const coder = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(coder.id, 'question');
      expect(existsSync(join(t.cwd, 'ran.txt'))).toBe(false);
      expect(t.requests.length).toBe(3);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('the third failure in a turn posts a notice; the profile verifyCommand wins', async () => {
    const steps: Step[] = [];
    const t = await startTestEngine({ script: [[{ text: 'unused' }]], approve: 'allow', route: () => steps.shift() ?? [{ text: 'Giving up.' }] });
    for (let i = 0; i < 4; i++) steps.push([write(join(t.cwd, `f${i}.txt`), 'x')], [{ text: 'Done.' }]);
    try {
      t.engine.trust.set(t.cwd, true);
      await t.engine.extensions.saveAgent({ name: 'strict', description: 'test agent', prompt: 'Strict.', source: 'user', verifyCommand: "echo 'always red' && exit 3" }, 'user');
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'strict' });
      await t.run(s.id, 'go');
      // 3 reminders, then the runner's cap ends the turn
      expect(t.requests.length).toBe(8);
      expect(t.requests[2]).toContain("The check `echo 'always red' && exit 3` failed (exit 3)");
      expect(notices(t.engine, s.id)).toContain('sent the agent back 3 times this turn');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a subagent with the gate is sent back through SubagentStop', async () => {
    let cwd = '';
    const childSteps: Step[] = [];
    const t = await startTestEngine({
      script: [[task('builder', 'CHILD-BUILD: make status fixed')], [{ text: 'parent done' }]],
      approve: 'allow',
      route: (body) => (firstUserText(body).includes('CHILD-BUILD') ? childSteps.shift() ?? [{ text: 'child idle' }] : undefined),
    });
    cwd = t.cwd;
    childSteps.push([write(join(cwd, 'status.txt'), 'broken\n')], [{ text: 'Built.' }], [write(join(cwd, 'status.txt'), 'fixed\n')], [{ text: 'Built and checked.' }]);
    try {
      project(cwd, "grep -q fixed status.txt || (echo 'not fixed yet' && exit 1)");
      t.engine.trust.set(cwd, true);
      const s = await t.engine.createSession({ title: 'p', cwd });
      await t.run(s.id, 'go');
      const childReqs = t.requests.filter((r) => firstUserText(JSON.parse(r)).includes('CHILD-BUILD'));
      expect(childReqs.length).toBe(4);
      expect(childReqs[2]).toContain('SubagentStop hook feedback');
      expect(childReqs[2]).toContain('not fixed yet');
      expect(toolResults(t.engine, s.id).find((r) => r.name === 'Task')!.content).toContain('Built and checked.');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('review sends a frozen packet', () => {
  test('the brief is the owner\'s own messages, newest kept', () => {
    const m = (seq: number, role: 'user' | 'assistant', text: string, auto = false) => ({ id: `m${seq}`, seq, role, kind: 'normal', content: [{ type: 'text', text }], ...(auto ? { meta: { auto: true } } : {}) }) as unknown as Message;
    const msgs = [m(1, 'user', 'add a flag'), m(2, 'assistant', 'done'), m(3, 'user', 'auto note', true), m(4, 'user', 'also document it'), m(5, 'assistant', 'documented')];
    expect(briefOf(msgs, msgs[4])).toBe('1. add a flag\n\n2. also document it');
    const text = renderPacket({ brief: 'b', answer: 'a', diff: '+x', rules: [{ path: '/r/AGENTS.md', content: 'rule one' }] }, { inlineRules: false });
    expect(text).toContain('/r/AGENTS.md');
    expect(text).not.toContain('rule one');
    expect(renderPacket({ brief: 'b', answer: 'a', diff: '', rules: [{ path: '/r/AGENTS.md', content: 'rule one' }] }, { inlineRules: true })).toContain('rule one');
  });

  test('a second opinion gets the brief, the diff with new files and AGENTS.md, not the transcript', async () => {
    const t = await startTestEngine({ script: [[bash('echo SECRET-TRANSCRIPT-LINE')], [{ text: 'Added the retry flag.' }]], approve: 'allow' });
    try {
      const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: t.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      git('init', '-q');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
      writeFileSync(join(t.cwd, 'AGENTS.md'), 'Rule: retries default to 3.\n');
      writeFileSync(join(t.cwd, 'retry.ts'), 'export const RETRIES = 5;\n');
      const s = await t.engine.createSession({ title: 'r', cwd: t.cwd });
      await t.run(s.id, 'make the retries configurable');
      const before = t.chores.length;
      await t.engine.secondOpinion(s.id, { reviewer: 'mock/claude-sonnet-5-5' });
      const sent = t.chores.slice(before).find((c) => c.includes('The answer to review'))!;
      expect(sent).toBeDefined();
      expect(sent).toContain('make the retries configurable');
      expect(sent).toContain('Added the retry flag.');
      expect(sent).toContain('RETRIES = 5');
      expect(sent).toContain('retries default to 3');
      expect(sent).not.toContain('SECRET-TRANSCRIPT-LINE');
      // opt in to the transcript
      await t.engine.secondOpinion(s.id, { reviewer: 'mock/claude-sonnet-5-5', includeTranscript: true });
      expect(t.chores[t.chores.length - 1]).toContain('SECRET-TRANSCRIPT-LINE');
    } finally {
      await t.close();
    }
  }, 60_000);
});
