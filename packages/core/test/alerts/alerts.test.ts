import { describe, expect, test } from 'bun:test';
import { CONFLICT_WINDOW_MS, FileWrites, absolutePath, conflictLine, shownPath } from '../../src/alerts/writes';
import { LOOP_FAILURES, StuckWatch } from '../../src/alerts/stuck';

const MIN = 60_000;
const five = () => 5 * MIN;

describe('file writes', () => {
  test('paths are absolute and normalized, relative ones against the session folder', () => {
    expect(absolutePath('/repo/src/../src/a.ts', '/x')).toBe('/repo/src/a.ts');
    expect(absolutePath('src/a.ts', '/repo')).toBe('/repo/src/a.ts');
    expect(absolutePath('./a.ts', '/repo/')).toBe('/repo/a.ts');
    expect(absolutePath('C:/code/a.ts', '/repo')).toBe('C:\\code\\a.ts');
    expect(absolutePath('src/a.ts', 'C:\\code')).toBe('C:\\code\\src\\a.ts');
    expect(absolutePath(42, '/repo')).toBeUndefined();
    expect(absolutePath('  ', '/repo')).toBeUndefined();
    expect(absolutePath('a.ts', 'relative')).toBeUndefined();
  });

  test('the Inbox shows a path inside a session folder relative to it', () => {
    expect(shownPath('/repo/src/auth/redirect.ts', ['/repo'])).toBe('src/auth/redirect.ts');
    expect(shownPath('/repo/src/a.ts', ['/elsewhere', '/repo/'])).toBe('src/a.ts');
    expect(shownPath('/repository/a.ts', ['/repo'])).toBe('/repository/a.ts');
    expect(shownPath('C:\\code\\a.ts', ['C:\\code'])).toBe('a.ts');
  });

  test('the line for the model says who and when', () => {
    expect(conflictLine('Fix login', 1_000, 1_000 + 30_000)).toBe("Another chat, 'Fix login', changed this file less than a minute ago.");
    expect(conflictLine('Fix login', 0, 3 * MIN + 10_000)).toBe("Another chat, 'Fix login', changed this file 3 min ago.");
  });

  test('other writers within the window, newest first; per device and path', () => {
    const w = new FileWrites();
    w.record('local', '/a.ts', 's1', 1_000);
    w.record('local', '/a.ts', 's2', 2_000);
    w.record('mac', '/a.ts', 's3', 2_500);
    w.record('local', '/a.ts', 's1', 500); // an older time never moves it back
    expect(w.others('local', '/a.ts', 's3', 3_000)).toEqual([
      { sessionId: 's2', at: 2_000 },
      { sessionId: 's1', at: 1_000 },
    ]);
    expect(w.others('local', '/a.ts', 's2', 3_000).map((x) => x.sessionId)).toEqual(['s1']);
    expect(w.others('local', '/b.ts', 's2', 3_000)).toEqual([]);
    expect(w.others('local', '/a.ts', 's3', 1_000 + CONFLICT_WINDOW_MS + 1).map((x) => x.sessionId)).toEqual(['s2']);
    w.prune(2_000 + CONFLICT_WINDOW_MS + 1);
    expect(w.size).toBe(1);
    w.forget('s3');
    expect(w.size).toBe(0);
  });
});

describe('stuck watch', () => {
  test('quiet past the threshold, once, with the time of the last progress', () => {
    const w = new StuckWatch();
    w.running('s', 'm', 0);
    expect(w.check(5 * MIN, five)).toEqual([]);
    expect(w.check(5 * MIN + 1, five)).toEqual([{ sessionId: 's', since: 0, thresholdMs: 5 * MIN }]);
    expect(w.check(9 * MIN, five)).toEqual([]);
    expect(w.flags()).toEqual([{ sessionId: 's', reason: 'idle', since: 0 }]);
    // progress clears the flag and restarts the clock
    expect(w.progress('s', 9 * MIN)).toBe(true);
    expect(w.flags()).toEqual([]);
    expect(w.check(13 * MIN, five)).toEqual([]);
    expect(w.check(14 * MIN + 1, five)).toHaveLength(1);
    expect(w.end('s')).toEqual(['idle']);
    expect(w.check(60 * MIN, five)).toEqual([]);
  });

  test('a tool inside its own limit is working; one past it, or with none, is not', () => {
    const w = new StuckWatch();
    w.running('s', 'm', 0);
    w.toolStarted('s', 'bash', 'Bash', 10 * MIN, 0);
    expect(w.check(6 * MIN, five)).toEqual([]);
    expect(w.check(10 * MIN, five)).toHaveLength(1);
    w.end('s');

    w.running('t', 'm', 0);
    w.toolStarted('t', 'task', 'Task', Infinity, 0);
    expect(w.check(120 * MIN, five)).toEqual([]);
    expect(w.toolEnded('t', 'task')).toBe('Task');
    expect(w.check(120 * MIN, five)).toHaveLength(1);

    w.running('u', 'm', 0);
    w.toolStarted('u', 'read', 'Read', 0, 0);
    expect(w.check(6 * MIN, five).map((v) => v.sessionId)).toEqual(['u']);
  });

  test('waiting on the owner pauses the watch; running again restarts the clock', () => {
    const w = new StuckWatch();
    w.running('s', 'm', 0);
    expect(w.check(6 * MIN, five)).toHaveLength(1);
    expect(w.pause('s')).toBe(true);
    expect(w.check(60 * MIN, five)).toEqual([]);
    w.running('s', 'm', 60 * MIN);
    expect(w.check(64 * MIN, five)).toEqual([]);
    expect(w.check(66 * MIN, five)).toHaveLength(1);
  });

  test('Keep waiting doubles the threshold, counted from the answer, and doubles again', () => {
    const w = new StuckWatch();
    w.running('s', 'm', 0);
    expect(w.check(6 * MIN, five)).toHaveLength(1);
    // answered at once: 10 minutes from the last progress
    w.keepWaiting('s', 'idle', 6 * MIN);
    expect(w.check(16 * MIN, five)).toEqual([]);
    expect(w.check(16 * MIN + 1, five)).toEqual([{ sessionId: 's', since: 0, thresholdMs: 10 * MIN }]);
    // answered an hour later: 20 more minutes from the answer, not a new alert at once
    w.keepWaiting('s', 'idle', 76 * MIN);
    expect(w.check(77 * MIN, five)).toEqual([]);
    expect(w.check(96 * MIN, five)).toEqual([]);
    expect(w.check(96 * MIN + 1, five)).toEqual([{ sessionId: 's', since: 0, thresholdMs: 20 * MIN }]);
    // progress after that counts as usual
    w.progress('s', 100 * MIN);
    expect(w.check(119 * MIN, five)).toEqual([]);
    expect(w.check(120 * MIN + 1, five)).toHaveLength(1);
  });

  test('the same failure in a row is a loop; another outcome resets it', () => {
    const w = new StuckWatch();
    w.running('s', 'm', 0);
    expect(w.failure('s', 'Edit', 'old_string not found', 1)).toEqual({ cleared: false });
    expect(w.failure('s', 'Edit', 'old_string not found', 2)).toEqual({ cleared: false });
    expect(w.failure('s', 'Edit', 'old_string not found', 3)).toEqual({ loop: { sessionId: 's', since: 1, tool: 'Edit', error: 'old_string not found', count: LOOP_FAILURES }, cleared: false });
    expect(w.flags()).toEqual([{ sessionId: 's', reason: 'loop', since: 1 }]);
    // a different error starts a new run and clears the flag
    expect(w.failure('s', 'Edit', 'file is a directory', 4)).toEqual({ cleared: true });
    w.failure('s', 'Bash', 'Exit code 1', 5);
    w.failure('s', 'Bash', 'Exit code 1', 6);
    // a success in between breaks the run
    expect(w.success('s')).toBe(false);
    w.failure('s', 'Bash', 'Exit code 1', 7);
    w.failure('s', 'Bash', 'Exit code 1', 8);
    expect(w.failure('s', 'Bash', 'Exit code 1', 9).loop?.count).toBe(3);
    expect(w.success('s')).toBe(true);
    expect(w.flags()).toEqual([]);
  });

  test('Keep waiting on a loop waits for twice as many failures', () => {
    const w = new StuckWatch();
    w.running('s', 'm', 0);
    for (let i = 0; i < 3; i++) w.failure('s', 'Edit', 'e', i);
    w.keepWaiting('s', 'loop', 3);
    expect(w.failure('s', 'Edit', 'e', 4).loop).toBeUndefined();
    expect(w.failure('s', 'Edit', 'e', 5).loop).toBeUndefined();
    expect(w.failure('s', 'Edit', 'e', 6).loop?.count).toBe(6);
  });

  test('sessions that are not running are not watched', () => {
    const w = new StuckWatch();
    expect(w.progress('x', 1)).toBe(false);
    expect(w.failure('x', 'Edit', 'e', 1)).toEqual({});
    expect(w.pause('x')).toBe(false);
    expect(w.end('x')).toEqual([]);
  });
});
