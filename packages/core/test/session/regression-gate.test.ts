import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import type { Session } from '../../src/types';
import type { Machine } from '../../src/machine/types';
import { LocalMachine } from '../../src/machine/local';
import { changesSince, parseRawDiff, restoreTurnCheckpoint, startTurnCheckpoint, type ChangedFile, type TurnCheckpoint } from '../../src/session/checkpoints';
import { handleLimit } from '../../src/session/limits';
import { ProviderError } from '../../src/providers/types';
import { planTestRun, REGRESSION_REMINDER, RegressionGate, splitChanges } from '../../src/session/regression-gate';
import { recipeGroups, wantsRegressionGate } from '../../src/extensions/agent-hooks';

/** temp folders the gate makes go here, so a test can see that none is left */
let scratch = '';
let savedTmp: string | undefined;
let savedClaude: string | undefined;
const made: string[] = [];
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'conclave-rg-tmp-'));
  savedTmp = process.env.TMPDIR;
  savedClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'conclave-rg-claude-'));
  made.push(scratch, process.env.CLAUDE_CONFIG_DIR);
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** A Python project like the bench's tasksd: tests import a helper from tests/, run by unittest discover. */
const PY = {
  'calc.py': 'def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n',
  'tests/helpers.py': 'from calc import add, mul\n',
  'tests/test_calc.py': 'import unittest\n\nfrom helpers import mul\n\n\nclass MulTest(unittest.TestCase):\n    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n',
};
const PY_FIX = { 'calc.py': PY['calc.py'].replace('a - b', 'a + b') };
const pyTest = (name: string, body: string) => ({ [`tests/${name}`]: `import unittest\n\nfrom helpers import add, mul\n\n\nclass T(unittest.TestCase):\n    def test_it(self):\n        ${body}\n` });

/** A Bun project like the bench's ledgerkit. */
const TS = {
  'package.json': '{"name":"p","type":"module","scripts":{"test":"bun test"}}',
  'src/price.ts': 'export function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 1);\n}\n',
  'test/price.test.ts': "import { expect, test } from 'bun:test';\nimport { total } from '../src/price';\n\ntest('empty', () => expect(typeof total([])).toBe('number'));\n",
};

interface Rig {
  engine: Engine;
  cwd: string;
  session: Session;
  machine: Machine;
  gate: RegressionGate;
  events: Array<Record<string, any>>;
  audit(): string[];
  put(files: Record<string, string>): void;
  /** The turn's checkpoint, taken and done, with the turn's state reset. */
  turn(): Promise<TurnCheckpoint>;
  close(): Promise<void>;
}

async function rig(files: Record<string, string>, opts: { agent?: string; trust?: boolean; gate?: { timeoutMs?: number; checkpointWaitMs?: number } } = {}): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), 'conclave-rg-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'conclave-rg-cwd-'));
  made.push(home, cwd);
  put(cwd, files);
  const engine = await createEngine({ home, noBackground: true, version: 'test' });
  if (opts.trust !== false) engine.trust.set(cwd, true);
  const session = await engine.createSession({ title: 'r', cwd, agent: opts.agent ?? 'coder' });
  const machine = engine.machineFor(session);
  const gate = new RegressionGate(engine, opts.gate);
  const events: Array<Record<string, any>> = [];
  const off = engine.bus.on((e: Record<string, any>) => {
    if (e.type === 'regression.checked') events.push(e);
  });
  return {
    engine,
    cwd,
    session,
    machine,
    gate,
    events,
    audit: () => engine.listAudit({ sessionId: session.id }).filter((a) => a.action === 'regression.gate').map((a) => a.detail),
    put: (f) => put(cwd, f),
    async turn() {
      const t = startTurnCheckpoint(engine, session, machine);
      await t.done;
      // the runner holds the turn's checkpoint; noteTool marks writes on it
      engine.runnerFor(session.id).turnCheckpoint = t;
      return t;
    },
    async close() {
      off();
      await engine.shutdown();
    },
  };
}

/** The gate's temp folders still on disk. */
const leftovers = () => readdirSync(scratch).filter((n) => n.startsWith('conclave-before-') || n.startsWith('conclave-index-'));

describe('splitChanges', () => {
  const f = (path: string, status = 'M'): ChangedFile => ({ path, status, blob: 'b' });
  test('tests, their helpers and the source, by name and folder', () => {
    const s = splitChanges([f('calc.py'), f('tests/test_add.py', 'A'), f('tests/helpers.py'), f('conftest.py'), f('src/a.ts'), f('test/a.test.ts', 'A'), f('src/b.spec.js'), f('bowling_test.py', 'A'), f('README.md'), f('main.go'), f('tests/old_test.py', 'D')]);
    expect(s.tests).toEqual(['tests/test_add.py', 'test/a.test.ts', 'src/b.spec.js', 'bowling_test.py']);
    expect(s.helpers).toEqual(['tests/helpers.py', 'conftest.py']);
    expect(s.sources).toEqual(['calc.py', 'src/a.ts']);
  });

  test('raw diff output', () => {
    const out = ':100644 100644 aaa bbb M\0calc.py\0:000000 100644 000 ccc A\0tests/test add.py\0';
    expect(parseRawDiff(out)).toEqual([
      { status: 'M', path: 'calc.py', blob: 'bbb' },
      { status: 'A', path: 'tests/test add.py', blob: 'ccc' },
    ]);
  });
});

describe('changesSince', () => {
  test('a same-size edit in the second of the snapshot is still seen after that second ends', async () => {
    const r = await rig({ 'a.py': 'x = 1\n' });
    try {
      // start at the top of a second, so the file, the snapshot and the edit share one
      await Bun.sleep(1000 - (Date.now() % 1000) + 5);
      r.put({ 'a.py': 'x = 2\n' });
      const turn = startTurnCheckpoint(r.engine, r.session, r.machine);
      const ckpt = (await turn.done)!;
      r.put({ 'a.py': 'x = 3\n' });
      expect(Date.now() % 1000).toBeLessThan(900);
      // the copied index must not look newer than the edit
      await Bun.sleep(1000 - (Date.now() % 1000) + 5);
      const changed = await changesSince(r.engine, r.session, r.machine, ckpt);
      expect(changed?.map((f) => `${f.status} ${f.path}`)).toEqual(['M a.py']);
    } finally {
      await r.close();
    }
  }, 30_000);
});

describe('planTestRun', () => {
  const machine = new LocalMachine();
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'conclave-rg-plan-'));
    made.push(d);
    put(d, files);
    return d;
  };

  test('unittest discover: module names, with the start folder on PYTHONPATH', async () => {
    const plan = await planTestRun(machine, dir(PY), ['tests/test_add.py', 'tests/unit/test_b.py']);
    expect(plan).toEqual({ command: 'python3 -m unittest test_add unit.test_b', env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: 'tests' } });
  });

  test('pytest, root unittest, bun, and runners it does not know', async () => {
    expect((await planTestRun(machine, dir({ 'pytest.ini': '[pytest]\n', 'tests/test_a.py': '' }), ['tests/test_a.py']))?.command).toBe("python3 -m pytest -q -p no:cacheprovider 'tests/test_a.py'");
    expect((await planTestRun(machine, dir({ 'bowling.py': '' }), ['bowling_test.py']))?.command).toBe('python3 -m unittest bowling_test');
    expect((await planTestRun(machine, dir(TS), ['test/total.test.ts']))?.command).toBe("bun test './test/total.test.ts'");
    expect(await planTestRun(machine, dir({ 'package.json': '{"scripts":{"test":"vitest run"}}' }), ['a.test.ts'])).toBeUndefined();
    expect(await planTestRun(machine, dir(PY), ['tests/test_a.py', 'a.test.ts'])).toBeUndefined();
    expect(await planTestRun(machine, dir(PY), ['tests/test-a.py'])).toBeUndefined();
  });
});

describe('the gate is on for coder, builder and tester only', () => {
  test('wantsRegressionGate, and the recipe is not a hook', () => {
    expect(wantsRegressionGate({ name: 'x', description: '', prompt: '', recipes: ['regression-gate'] } as never)).toBe(true);
    expect(wantsRegressionGate({ name: 'x', description: '', prompt: '', recipes: ['verify-gate'] } as never)).toBe(false);
    expect(recipeGroups({ name: 'x', description: '', prompt: '', recipes: ['regression-gate', 'verify-gate'] } as never, scratch)).toEqual({});
  });
});

describe('regression gate', () => {
  test('a Python test that fails on the old code is proven: no message, an audit row and an event', async () => {
    process.env.TMPDIR = scratch;
    const r = await rig(PY);
    try {
      const turn = await r.turn();
      r.put({ ...PY_FIX, ...pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)') });
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({ outcome: 'proven', command: 'python3 -m unittest test_add', tests: ['tests/test_add.py'], reminded: false });
      expect(r.audit()).toEqual(['proven: python3 -m unittest test_add (the tests fail on the code from before the turn)']);
      // the old tree went away; the shadow repo's own index was not touched by the look
      expect(leftovers()).toEqual([]);
      // the same changes are not run again at the next stop
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events).toHaveLength(1);
    } finally {
      await r.close();
    }
  }, 30_000);

  test('a test that passes on the old code gets one reminder per user turn', async () => {
    process.env.TMPDIR = scratch;
    const r = await rig(PY);
    try {
      let turn = await r.turn();
      r.put({ ...PY_FIX, ...pyTest('test_mul2.py', 'self.assertEqual(mul(2, 2), 4)') });
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBe(REGRESSION_REMINDER);
      // the agent changes the test, still passing on the old code: looked at again, no second reminder this turn
      r.put(pyTest('test_mul2.py', 'self.assertEqual(mul(3, 2), 6)'));
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events.map((e) => [e.outcome, e.reminded])).toEqual([
        ['passes', true],
        ['passes', false],
      ]);
      // the audit rows carry the same (the bench reads them when the event stream is missing)
      expect(r.audit().sort()).toEqual(['passes, reminded: python3 -m unittest test_mul2 (the tests pass on the code from before the turn)', 'passes: python3 -m unittest test_mul2 (the tests pass on the code from before the turn)']);
      // the next user turn may remind again
      turn = await r.turn();
      r.put({ 'calc.py': `${PY_FIX['calc.py']}\n# tidy\n`, ...pyTest('test_mul3.py', 'self.assertEqual(mul(1, 1), 1)') });
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBe(REGRESSION_REMINDER);
      expect(leftovers()).toEqual([]);
    } finally {
      await r.close();
    }
  }, 30_000);

  test('a turn with no test changes, or tests and no source, runs nothing', async () => {
    const r = await rig(PY);
    try {
      let turn = await r.turn();
      r.put(PY_FIX);
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      turn = await r.turn();
      r.put(pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)'));
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      // a turn that ran only read-only tools is not even looked at
      turn = await r.turn();
      r.put({ 'calc.py': 'def add(a, b):\n    return 0\n', ...pyTest('test_zero.py', 'self.assertEqual(add(1, 1), 0)') });
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events).toEqual([]);
      expect(r.audit()).toEqual([]);
    } finally {
      await r.close();
    }
  }, 30_000);

  test('the old code hangs: the run times out, no message', async () => {
    process.env.TMPDIR = scratch;
    const r = await rig({ ...PY, 'calc.py': 'import time\n\n\ndef add(a, b):\n    time.sleep(20)\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n' }, { gate: { timeoutMs: 1_000 } });
    try {
      const turn = await r.turn();
      r.put({ 'calc.py': PY_FIX['calc.py'], ...pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)') });
      r.gate.noteTool(r.session, false);
      const started = Date.now();
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(r.events[0]).toMatchObject({ outcome: 'not_run', why: 'the test timed out', reminded: false });
      expect(leftovers()).toEqual([]);
    } finally {
      await r.close();
    }
  }, 30_000);

  test('Bun: a failing test is proven; a test that cannot load on the old code says nothing', async () => {
    process.env.TMPDIR = scratch;
    const r = await rig(TS);
    try {
      let turn = await r.turn();
      r.put({
        'src/price.ts': TS['src/price.ts'].replace('b, 1)', 'b, 0)'),
        'test/total.test.ts': "import { expect, test } from 'bun:test';\nimport { total } from '../src/price';\n\ntest('sum', () => expect(total([2, 3])).toBe(5));\n",
      });
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events[0]).toMatchObject({ outcome: 'proven', command: "bun test './test/total.test.ts'" });
      // a new module the old tree does not have: the test does not load there (NOT_RUN), so no message
      turn = await r.turn();
      r.put({ 'src/tax.ts': 'export const tax = (x: number) => x * 0.2;\n', 'test/tax.test.ts': "import { expect, test } from 'bun:test';\nimport { tax } from '../src/tax';\n\ntest('tax', () => expect(tax(10)).toBe(2));\n" });
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events[1]).toMatchObject({ outcome: 'not_run', reminded: false });
      expect(r.events[1].why).toContain('did not run cleanly');
    } finally {
      await r.close();
    }
  }, 30_000);

  test('checkpoint race: a write before the snapshot finished skips the run; the gate waits for a snapshot still running', async () => {
    const r = await rig(PY, { gate: { checkpointWaitMs: 2_000 } });
    try {
      // the turn wrote before the snapshot was done
      let turn = startTurnCheckpoint(r.engine, r.session, r.machine);
      r.gate.noteWrite(turn);
      await turn.done;
      r.put({ ...PY_FIX, ...pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)') });
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events[0]).toMatchObject({ outcome: 'skipped', why: 'the checkpoint finished after the turn first changed files', command: null });

      // the source edit landed in the snapshot, so only the test looks changed: still reported as a race, not dropped
      r.put({ 'calc.py': 'def add(a, b):\n    return b + a\n\n\ndef mul(a, b):\n    return a * b\n' });
      turn = startTurnCheckpoint(r.engine, r.session, r.machine);
      r.gate.noteWrite(turn);
      await turn.done;
      r.put(pyTest('test_add1.py', 'self.assertEqual(add(1, 2), 3)'));
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events[1]).toMatchObject({ outcome: 'skipped', tests: ['tests/test_add1.py'] });
      r.events.splice(1, 1);

      // a snapshot still running at stop: the gate waits for it, then sees that it raced
      const real = await r.turn();
      r.put(pyTest('test_add2.py', 'self.assertEqual(add(1, 1), 2)'));
      r.put({ 'calc.py': `${PY_FIX['calc.py']}\n# again\n` });
      const ckpt = await real.done;
      const slow: TurnCheckpoint = { startedAt: Date.now(), done: Promise.resolve(undefined) };
      slow.done = Bun.sleep(300)
        .then(() => ckpt)
        .finally(() => (slow.settledAt = Date.now()));
      r.gate.noteWrite(slow);
      const started = Date.now();
      expect(await r.gate.check(r.session, slow)).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(r.events[1]).toMatchObject({ outcome: 'skipped' });

      // a snapshot that never finishes, or none at all: nothing to compare with, no event
      turn = await r.turn();
      r.put(pyTest('test_add3.py', 'self.assertEqual(add(2, 2), 4)'));
      r.put({ 'calc.py': `${PY_FIX['calc.py']}\n# third\n` });
      r.gate.noteTool(r.session, false);
      const never: TurnCheckpoint = { startedAt: Date.now(), done: new Promise(() => {}), firstWriteAt: Date.now() };
      expect(await r.gate.check(r.session, never)).toBeUndefined();
      expect(await r.gate.check(r.session, undefined)).toBeUndefined();
      expect(await r.gate.check(r.session, { startedAt: Date.now(), settledAt: Date.now(), done: Promise.resolve(undefined), firstWriteAt: Date.now() })).toBeUndefined();
      expect(r.events).toHaveLength(2);
    } finally {
      await r.close();
    }
  }, 30_000);

  test('a turn parked by a usage limit is found again by a new engine on the same home', async () => {
    process.env.TMPDIR = scratch;
    const home = mkdtempSync(join(tmpdir(), 'conclave-rg-restart-'));
    const cwd = mkdtempSync(join(tmpdir(), 'conclave-rg-cwd-'));
    made.push(home, cwd);
    put(cwd, PY);
    const first = await createEngine({ home, noBackground: true, version: 'test' });
    first.trust.set(cwd, true);
    const session = await first.createSession({ title: 'r', cwd, agent: 'coder' });
    const runner = first.runnerFor(session.id);
    const turn = startTurnCheckpoint(first, session, first.machineFor(session));
    runner.turnCheckpoint = turn;
    await turn.done;
    put(cwd, { ...PY_FIX, ...pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)') });
    new RegressionGate(first).noteTool(session, false);
    const parked = await handleLimit(first, runner, session.model, new ProviderError('rate_limit', 'limit', { resetAt: Date.now() + 3_600_000 }));
    expect(parked.parked).toBe(true);
    await Bun.sleep(50);
    await first.shutdown();

    const second = await createEngine({ home, noBackground: true, version: 'test' });
    try {
      const again = second.getSession(session.id)!;
      expect(again.status).toBe('waiting_reset');
      const restored = restoreTurnCheckpoint(second, again);
      expect(restored?.firstWriteAt).toBe(turn.firstWriteAt);
      const events: Array<Record<string, any>> = [];
      second.bus.on((e: Record<string, any>) => {
        if (e.type === 'regression.checked') events.push(e);
      });
      expect(await new RegressionGate(second).check(again, restored)).toBeUndefined();
      expect(events.map((e) => e.outcome)).toEqual(['proven']);
    } finally {
      await second.shutdown();
    }
  }, 30_000);

  test('a subagent write counts for its parent turn', async () => {
    process.env.TMPDIR = scratch;
    const r = await rig(PY);
    try {
      const turn = await r.turn();
      const child = await r.engine.createSession({ title: 'child', cwd: r.cwd, agent: 'builder', parentId: r.session.id });
      r.put({ ...PY_FIX, ...pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)') });
      r.gate.noteTool(child, false);
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events[0]).toMatchObject({ outcome: 'proven' });
    } finally {
      await r.close();
    }
  }, 30_000);

  test('an untrusted folder in default mode does not run project code; agents without the recipe are not checked', async () => {
    const r = await rig(PY, { trust: false });
    try {
      const turn = await r.turn();
      r.put({ ...PY_FIX, ...pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)') });
      r.gate.noteTool(r.session, false);
      expect(await r.gate.check(r.session, turn)).toBeUndefined();
      expect(r.events[0]).toMatchObject({ outcome: 'skipped', command: 'python3 -m unittest test_add' });
      expect(r.events[0].why).toContain('not trusted');
    } finally {
      await r.close();
    }
    const g = await rig(PY, { agent: 'general-purpose' });
    try {
      const turn = await g.turn();
      g.put({ ...PY_FIX, ...pyTest('test_add.py', 'self.assertEqual(add(2, 3), 5)') });
      g.gate.noteTool(g.session, false);
      expect(await g.gate.check(g.session, turn)).toBeUndefined();
      expect(g.events).toEqual([]);
    } finally {
      await g.close();
    }
  }, 30_000);
});
