/**
 * The regression gate through the real runner (session/regression-gate.ts):
 * a scripted coder fixes a Python bug and adds a test, and the gate runs that
 * test on the code from before the turn when the coder stops.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startTestEngine, type Block, type Step } from './harness';
import { REGRESSION_REMINDER } from '../../src/session/regression-gate';
import { resumeAfterReset } from '../../src/session/limits';

const write = (file_path: string, content: string): Block => ({ tool: 'Write', input: { file_path, content } });
const edit = (file_path: string, old_string: string, new_string: string): Block => ({ tool: 'Edit', input: { file_path, old_string, new_string } });

const PY = {
  'calc.py': 'def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n',
  'tests/helpers.py': 'from calc import add, mul\n',
  'tests/test_calc.py': 'import unittest\n\nfrom helpers import mul\n\n\nclass MulTest(unittest.TestCase):\n    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n',
};
const testFile = (body: string) => `import unittest\n\nfrom helpers import add, mul\n\n\nclass T(unittest.TestCase):\n    def test_it(self):\n        ${body}\n`;

async function project() {
  const steps: Array<Step | { status: number; error: string }> = [];
  const t = await startTestEngine({ script: [[{ text: 'unused' }]], approve: 'allow', route: () => steps.shift() });
  for (const [rel, text] of Object.entries(PY)) {
    mkdirSync(dirname(join(t.cwd, rel)), { recursive: true });
    writeFileSync(join(t.cwd, rel), text);
  }
  t.engine.trust.set(t.cwd, true);
  const events: Array<Record<string, any>> = [];
  t.engine.bus.on((e: Record<string, any>) => {
    if (e.type === 'regression.checked') events.push(e);
  });
  // the first reply waits a little, as a real model call does, so the turn's checkpoint is done before the first edit
  const first = (blocks: Block[]): Step => ({ blocks, delayMs: 800 });
  return { t, steps, events, first };
}

describe('regression gate in a coder session', () => {
  test('a fix with a test that fails on the old code ends the turn with no message', async () => {
    const { t, steps, events, first } = await project();
    try {
      steps.push(first([edit(join(t.cwd, 'calc.py'), 'a - b', 'a + b'), write(join(t.cwd, 'tests/test_add.py'), testFile('self.assertEqual(add(2, 3), 5)'))]), [{ text: 'Fixed add.' }]);
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'add is wrong, fix it');
      expect(t.requests.length).toBe(2);
      expect(t.requests.some((r) => r.includes('Your changed tests pass without your change'))).toBe(false);
      expect(events.map((e) => e.outcome)).toEqual(['proven']);
      expect(t.engine.listAudit({ sessionId: s.id }).some((a) => a.action === 'regression.gate' && a.detail.startsWith('proven: python3 -m unittest test_add'))).toBe(true);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a test that passes on the old code sends the coder back once', async () => {
    const { t, steps, events, first } = await project();
    try {
      steps.push(first([edit(join(t.cwd, 'calc.py'), 'a - b', 'a + b'), write(join(t.cwd, 'tests/test_mul2.py'), testFile('self.assertEqual(mul(2, 2), 4)'))]), [{ text: 'Fixed add.' }], [{ text: 'The new test covers mul, which did not change; add has no test yet.' }]);
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'add is wrong, fix it');
      expect(t.requests.length).toBe(3);
      expect(t.requests[2]).toContain(REGRESSION_REMINDER);
      expect(events.map((e) => [e.outcome, e.reminded])).toEqual([['passes', true]]);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a turn that changes no test runs nothing', async () => {
    const { t, steps, events, first } = await project();
    try {
      steps.push(first([edit(join(t.cwd, 'calc.py'), 'a - b', 'a + b')]), [{ text: 'Fixed add.' }]);
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
      await t.run(s.id, 'add is wrong, fix it');
      expect(t.requests.length).toBe(2);
      expect(events).toEqual([]);
    } finally {
      await t.close();
    }
  }, 60_000);

  /**
   * A usage limit parks the turn after its edits; session.resume continues it
   * later. The resumed run must compare with the code from before the user
   * turn, not with a snapshot taken at resume time, which holds the edits.
   */
  async function parkedTurn(dropRunnerState: boolean) {
    const { t, steps, events, first } = await project();
    steps.push(
      first([edit(join(t.cwd, 'calc.py'), 'a - b', 'a + b'), write(join(t.cwd, 'tests/test_add.py'), testFile('self.assertEqual(add(2, 3), 5)'))]),
      { status: 429, error: 'Rate limit reached. Please try again in 2h.' },
      [{ text: 'Fixed add; the new test covers it.' }],
    );
    const s = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'coder' });
    await t.run(s.id, 'add is wrong, fix it');
    expect(t.engine.getSession(s.id)?.status).toBe('waiting_reset');
    expect(events).toEqual([]);
    // the park keeps the turn's checkpoint in session meta, for a resume in a new hub process
    const base = t.engine.getSession(s.id)?.meta?.turnBase as { checkpoint?: string; firstWriteAt?: number } | undefined;
    expect(base?.checkpoint).toBe(t.engine.repos.checkpoints.list(s.id)[0].id);
    expect(typeof base?.firstWriteAt).toBe('number');
    // a hub restart: the new runner has no checkpoint of the parked turn in memory
    if (dropRunnerState) t.engine.runnerFor(s.id).turnCheckpoint = undefined;
    await resumeAfterReset(t.engine, { sessionId: s.id });
    await Promise.race([t.engine.runnerFor(s.id).waitIdle(), Bun.sleep(30_000)]);
    return { t, s, events };
  }

  test('a turn parked by a usage limit and resumed compares with the checkpoint from before the user turn', async () => {
    const { t, s, events } = await parkedTurn(false);
    try {
      // the resume took its own snapshot (for undo), after the edits
      expect(t.engine.repos.checkpoints.list(s.id).length).toBe(2);
      expect(events.map((e) => e.outcome)).toEqual(['proven']);
      expect(t.engine.getMessages(s.id).some((m) => m.role === 'user' && m.meta?.resume === true)).toBe(true);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('the same after a hub restart: the parked turn\'s checkpoint comes from session meta', async () => {
    const { t, events } = await parkedTurn(true);
    try {
      expect(events.map((e) => e.outcome)).toEqual(['proven']);
    } finally {
      await t.close();
    }
  }, 60_000);
});
