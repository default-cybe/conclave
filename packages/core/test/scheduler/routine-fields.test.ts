import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { JobScheduler } from '../../src/scheduler/scheduler';
import { Routines, parseOutcome, shouldNotify, type PrecheckRunner, type RoutineRunner } from '../../src/scheduler/routines';

describe('status contract', () => {
  test('parseOutcome reads the first line only', () => {
    expect(parseOutcome('STATUS: ok')).toBe('ok');
    expect(parseOutcome('\n  **STATUS: attention**\nsomething')).toBe('attention');
    expect(parseOutcome('Status: Problem - disk 97%')).toBe('problem');
    expect(parseOutcome('## STATUS: ok')).toBe('ok');
    expect(parseOutcome('All good.\nSTATUS: problem')).toBeUndefined();
    expect(parseOutcome('STATUS: okay')).toBeUndefined();
    expect(parseOutcome(undefined)).toBeUndefined();
  });

  test('shouldNotify follows the routine setting', () => {
    expect(shouldNotify('always', { status: 'ok', outcome: 'ok' })).toBe(true);
    expect(shouldNotify('never', { status: 'error' })).toBe(false);
    expect(shouldNotify('on_error', { status: 'ok', outcome: 'problem' })).toBe(false);
    expect(shouldNotify('on_error', { status: 'error' })).toBe(true);
    expect(shouldNotify('on_attention', { status: 'ok', outcome: 'ok' })).toBe(false);
    expect(shouldNotify('on_attention', { status: 'ok' })).toBe(false);
    expect(shouldNotify('on_attention', { status: 'ok', outcome: 'attention' })).toBe(true);
    expect(shouldNotify('on_attention', { status: 'ok', outcome: 'problem' })).toBe(true);
    expect(shouldNotify('on_attention', { status: 'error' })).toBe(true);
  });
});

describe('routine fields from ECOSYSTEM.md 2.3', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  function mk(opts: { run?: RoutineRunner; precheck?: PrecheckRunner } = {}) {
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const scheduler = new JobScheduler({ repos, maxSleepMs: 200 });
    let calls = 0;
    const routines = new Routines({
      repos,
      bus: new EventBus(),
      scheduler,
      run: opts.run ?? (async () => ({ sessionId: `ses_${++calls}`, summary: 'STATUS: attention\nDisk 91% on pve' })),
      precheck: opts.precheck,
    });
    stop = () => (scheduler.stop(), db.close());
    return { routines, repos, db, calls: () => calls };
  }

  const base = { name: 'Disk health', prompt: 'Check disks', schedule: '15 6 * * 3' };

  test('new fields are stored, read back and cleared', () => {
    const { routines, repos } = mk();
    const r = routines.create({
      ...base,
      notify: 'on_attention',
      allow: ['Bash(smartctl -a:*)', ' Bash(zpool status -x) ', 'Bash(smartctl -a:*)'],
      deny: ['Bash(zpool scrub:*)'],
      onApproval: 'deny',
      precheck: 'zpool status -x',
      env: { POOL: 'tank' },
      timeoutMin: 20,
      maxCostUsd: 0.5,
      suggestion: 'disk-health',
    });
    const back = repos.routines.get(r.id)!;
    expect(back.notify).toBe('on_attention');
    expect(back.allow).toEqual(['Bash(smartctl -a:*)', 'Bash(zpool status -x)']);
    expect(back.deny).toEqual(['Bash(zpool scrub:*)']);
    expect(back.onApproval).toBe('deny');
    expect(back.precheck).toBe('zpool status -x');
    expect(back.env).toEqual({ POOL: 'tank' });
    expect(back.timeoutMin).toBe(20);
    expect(back.maxCostUsd).toBe(0.5);
    expect(back.suggestion).toBe('disk-health');

    const u = routines.update(r.id, { allow: [], precheck: '', env: null as never, timeoutMin: null as never, name: 'Disks' });
    expect(u.allow).toEqual([]);
    expect(u.precheck).toBeUndefined();
    expect(u.env).toBeUndefined();
    expect(u.timeoutMin).toBeUndefined();
    expect(u.maxCostUsd).toBe(0.5);
    // a key that is present but undefined (a spread input) changes nothing
    expect(routines.update(r.id, { precheck: undefined, allow: undefined, onApproval: undefined }).maxCostUsd).toBe(0.5);
    expect(routines.get(r.id)!.deny).toEqual(['Bash(zpool scrub:*)']);
    routines.update(r.id, { precheck: 'true' });
    expect(routines.update(r.id, { precheck: undefined }).precheck).toBe('true');
    routines.update(r.id, { precheck: '' });
    const again = repos.routines.get(r.id)!;
    expect(again.name).toBe('Disks');
    expect(again.precheck).toBeUndefined();
    expect(again.suggestion).toBe('disk-health');
  });

  test('bad values are refused with a sentence', () => {
    const { routines } = mk();
    expect(() => routines.create({ ...base, allow: 'Bash' as never })).toThrow(/allow must be a list/);
    expect(() => routines.create({ ...base, onApproval: 'maybe' as never })).toThrow(/onApproval/);
    expect(() => routines.create({ ...base, notify: 'sometimes' as never })).toThrow(/notify must be one of/);
    expect(() => routines.create({ ...base, env: { 'BAD NAME': 'x' } })).toThrow(/valid variable name/);
    expect(() => routines.create({ ...base, timeoutMin: -1 })).toThrow(/timeoutMin/);
    expect(() => routines.create({ ...base, maxCostUsd: 5000 })).toThrow(/maxCostUsd/);
  });

  test('a run keeps its outcome and the calls nobody could approve', async () => {
    const { routines } = mk({
      run: async () => ({ sessionId: 'ses_1', summary: 'STATUS: problem\nsda has 12 reallocated sectors', denied: [{ tool: 'Bash', input: 'smartctl -t short /dev/sda', rule: 'Bash(smartctl -t:*)' }] }),
    });
    const r = routines.create(base);
    const run = await routines.runNow(r.id, 'schedule');
    expect(run.status).toBe('ok');
    expect(run.outcome).toBe('problem');
    expect(run.denied).toEqual([{ tool: 'Bash', input: 'smartctl -t short /dev/sda', rule: 'Bash(smartctl -t:*)' }]);
    expect(routines.runs(r.id)[0].outcome).toBe('problem');
    expect(routines.runs(r.id)[0].denied?.length).toBe(1);
  });

  test('precheck skips the model when nothing changed and runs it when something did', async () => {
    let out = '';
    let exit: number | null = 0;
    const seen: string[] = [];
    const { routines, calls } = mk({
      precheck: async (r, cmd) => {
        seen.push(`${r.name}: ${cmd}`);
        return { output: out, exitCode: exit };
      },
    });
    const r = routines.create({ ...base, precheck: 'git log -1 --format=%h' });

    // prints nothing: skipped, the model never runs
    let run = await routines.runNow(r.id, 'schedule');
    expect(run.status).toBe('skipped');
    expect(run.error).toBe('Nothing new since the last run');
    expect(calls()).toBe(0);
    expect(routines.get(r.id)?.lastRunAt).toBe(run.startedAt);

    out = 'a1b2c3d\n';
    run = await routines.runNow(r.id, 'schedule');
    expect(run.status).toBe('ok');
    expect(run.precheckOutput).toBe('a1b2c3d');
    expect(calls()).toBe(1);

    // same text as before the last run that went ahead
    run = await routines.runNow(r.id, 'webhook');
    expect(run.status).toBe('skipped');
    expect(calls()).toBe(1);

    out = 'e4f5a6b';
    expect((await routines.runNow(r.id, 'schedule')).status).toBe('ok');
    expect(calls()).toBe(2);

    // a failing precheck does not hide a run
    exit = 2;
    run = await routines.runNow(r.id, 'schedule');
    expect(run.status).toBe('ok');
    expect(run.precheckOutput).toBe('precheck exited 2: e4f5a6b');

    // Run now skips the precheck
    const before = seen.length;
    expect((await routines.runNow(r.id, 'manual')).status).toBe('ok');
    expect(seen.length).toBe(before);
    expect(seen[0]).toBe('Disk health: git log -1 --format=%h');
  });
});
