/**
 * The desktop app's Dock bounce / taskbar flash while an approval or a
 * question waits (src/lib/attention.ts, desktop main.rs attention).
 *
 *   bun test packages/web/test/attention.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

const g = globalThis as Record<string, unknown>;
const savedWindow = g.window;
const savedDoc = g.document;
let focused = false;
const win = new EventTarget();

beforeAll(() => {
  g.window = win;
  g.document = { visibilityState: 'visible', hasFocus: () => focused };
});
afterAll(() => {
  g.window = savedWindow;
  g.document = savedDoc;
});

const { watchAttention } = await import('../src/lib/attention');
const { setDesktop } = await import('../src/overlay/desktop');
const { useHub } = await import('../src/store/store');

let calls: unknown[];
let stop: () => void = () => undefined;
// the watcher never forgets an id it saw, so each test uses its own
let run = 0;
const waiting = (...ids: string[]) => Object.fromEntries(ids.map((id) => [`${id}.${run}`, { id: `${id}.${run}`, sessionId: 's1' }])) as never;
const asked = () => calls.filter((c) => (c as [string, { on: boolean }])[1].on);

beforeEach(() => {
  run++;
  calls = [];
  focused = false;
  useHub.setState({ approvals: {}, questions: {}, config: undefined });
  setDesktop({
    invoke: (async (cmd: string, args?: Record<string, unknown>) => void calls.push([cmd, args])) as never,
    listen: async () => () => undefined,
  });
  stop = watchAttention(useHub);
  calls = [];
});

afterEach(() => {
  stop();
  setDesktop(undefined);
});

describe('watchAttention', () => {
  test('a new approval while the window is in the background: bounce, with the count', () => {
    useHub.setState({ approvals: waiting('a1') });
    expect(calls).toEqual([['attention', { on: true, count: 1 }]]);
    // a question counts too, and asks again
    useHub.setState({ questions: waiting('q1') });
    expect(calls.at(-1)).toEqual(['attention', { on: true, count: 2 }]);
  });

  test('in front: no bounce, only the badge', () => {
    focused = true;
    useHub.setState({ approvals: waiting('a1') });
    expect(calls).toEqual([['attention', { on: false, count: 1 }]]);
  });

  test('focus stops it; a blur after does not fire again for the same approval', () => {
    useHub.setState({ approvals: waiting('a1') });
    focused = true;
    win.dispatchEvent(new Event('focus'));
    expect(calls.at(-1)).toEqual(['attention', { on: false, count: 1 }]);
    focused = false;
    useHub.setState({ toasts: [] });
    expect(calls).toHaveLength(2);
    // a new one does
    useHub.setState({ approvals: waiting('a1', 'a2') });
    expect(calls.at(-1)).toEqual(['attention', { on: true, count: 2 }]);
  });

  test('a reconnect does not fire again for the same approval, also when the list was empty for a moment', () => {
    useHub.setState({ approvals: waiting('a1') });
    stop();
    useHub.setState({ approvals: {} });
    stop = watchAttention(useHub);
    useHub.setState({ approvals: waiting('a1') });
    expect(asked()).toHaveLength(1);
  });

  test('back to 0: stops and clears the badge', () => {
    useHub.setState({ approvals: waiting('a1') });
    useHub.setState({ approvals: {} });
    expect(calls).toEqual([
      ['attention', { on: true, count: 1 }],
      ['attention', { on: false, count: 0 }],
    ]);
  });

  test('one of two answered while away: the badge follows, the bounce goes on', () => {
    useHub.setState({ approvals: waiting('a1', 'a2') });
    useHub.setState({ approvals: waiting('a2') });
    expect(calls.at(-1)).toEqual(['attention', { on: true, count: 1 }]);
  });

  test('Approvals and questions notifications off: nothing fires', () => {
    useHub.setState({ config: { notifications: { on: { approvalNeeded: false } } } });
    useHub.setState({ approvals: waiting('a1') });
    expect(asked()).toEqual([]);
  });

  test('a browser (no desktop app): nothing', () => {
    stop();
    setDesktop(undefined);
    stop = watchAttention(useHub);
    useHub.setState({ approvals: waiting('a1') });
    expect(calls).toEqual([]);
  });
});
