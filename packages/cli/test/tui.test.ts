import { describe, expect, test } from 'bun:test';
import type { LimitState, Session } from '@conclave/core/types.ts';
import { createPainter, inkColor, stripAnsi, truncate, width } from '../src/ansi';
import { BUILTINS, type PickerSpec } from '../src/tui/slash';
import { askFrom } from '../src/tui/Prompts';
import { TranscriptStore } from '../src/tui/transcript';
import { atToken, matchCommands, matchFiles, slashToken } from '../src/tui/complete';
import { attachmentsFor, ChatController } from '../src/tui/controller';
import * as ed from '../src/tui/editor';
import { History } from '../src/tui/history';
import { renderItem } from '../src/tui/render-item';
import { approvalPreview, toolTitle } from '../src/render/tools';
import { contextPercent, footerLine, headerLine, spread, tightestLimit, usageLine } from '../src/tui/statusline';
import { getPath, parseValue, patchFor } from '../src/commands/config';

const plain = createPainter({ enabled: false });

describe('editor', () => {
  test('insert, backspace, cursor moves', () => {
    let e = ed.insert(ed.empty, 'hello');
    e = ed.left(ed.left(e));
    e = ed.insert(e, 'X');
    expect(e).toEqual({ value: 'helXlo', cursor: 4 });
    e = ed.backspace(e);
    expect(e.value).toBe('hello');
  });

  test('up/down move between lines and return undefined at the edges', () => {
    const e = ed.set('one\ntwo\nthree');
    expect(ed.down(e)).toBeUndefined();
    const up = ed.up(e)!;
    expect(ed.position(up)).toEqual({ row: 1, col: 3, rows: 3 });
    expect(ed.up(ed.up(up)!)).toBeUndefined();
  });

  test('kill and word ops', () => {
    expect(ed.deleteWordBack(ed.set('git commit -m')).value).toBe('git commit ');
    expect(ed.killToLineStart(ed.set('a\nbcd')).value).toBe('a\n');
    expect(ed.killToLineEnd({ value: 'abc\ndef', cursor: 1 }).value).toBe('a\ndef');
  });

  test('surrogate pairs move and delete as one', () => {
    const e = ed.set('a😀');
    expect(ed.backspace(e).value).toBe('a');
    expect(ed.left(e).cursor).toBe(1);
  });
});

describe('history', () => {
  test('prev/next walk with a saved draft', () => {
    const h = new History();
    h.push('one');
    h.push('two');
    h.push('two');
    expect(h.prev('draft')).toBe('two');
    expect(h.prev('')).toBe('one');
    expect(h.prev('')).toBeUndefined();
    expect(h.next()).toBe('two');
    expect(h.next()).toBe('draft');
  });
});

describe('completion', () => {
  const cmds = [{ name: 'model', args: '[ref]', description: 'Switch model' }, { name: 'mode', description: 'Switch mode' }, { name: 'memory', args: '[q]' }, { name: 'help' }];
  test('slash token only in the first word', () => {
    expect(slashToken({ value: '/mo', cursor: 3 })).toEqual({ start: 0, end: 3, query: 'mo' });
    expect(slashToken({ value: '/model gpt', cursor: 10 })).toBeUndefined();
    expect(slashToken({ value: 'hi /mo', cursor: 6 })).toBeUndefined();
  });

  test('prefix matches rank first', () => {
    expect(matchCommands(cmds, 'mo').map((s) => s.value)).toEqual(['/mode', '/model', '/memory']);
    expect(matchCommands(cmds, 'em').map((s) => s.value)).toEqual(['/memory']);
  });

  test('@ token under the cursor', () => {
    expect(atToken({ value: 'read @src/ap now', cursor: 12 })).toEqual({ start: 5, end: 12, query: 'src/ap' });
    expect(atToken({ value: 'mail me@x.com', cursor: 13 })).toBeUndefined();
  });

  test('file matches keep the directory and put dirs first', () => {
    const entries = [
      { name: 'app.ts', type: 'file' },
      { name: 'api', type: 'dir' },
      { name: '.hidden', type: 'file' },
      { name: 'zeta.ts', type: 'file' },
    ];
    expect(matchFiles(entries, 'src/ap').map((s) => s.value)).toEqual(['@src/api/', '@src/app.ts']);
    expect(matchFiles(entries, '').map((s) => s.label)).toEqual(['api/', 'app.ts', 'zeta.ts']);
  });
});

describe('attachments', () => {
  test('images and pdfs mentioned with @ become attachments', () => {
    expect(attachmentsFor('see @shot.png and @docs/a.pdf and @src/x.ts', '/p')).toEqual([
      { path: '/p/shot.png', mediaType: 'image/png', name: 'shot.png' },
      { path: '/p/docs/a.pdf', mediaType: 'application/pdf', name: 'a.pdf' },
    ]);
  });
});

describe('render items', () => {
  test('user prompt gets a > gutter', () => {
    expect(renderItem({ kind: 'user', id: 'u', final: true, text: 'hello\nworld', attachments: 0 }, { width: 40, painter: plain, showThinking: false })).toBe('> hello\n  world');
  });

  test('thinking collapses to one line', () => {
    const out = renderItem({ kind: 'thinking', id: 't', final: true, text: 'a b c' }, { width: 40, painter: plain, showThinking: false });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('3 words');
  });

  test('tool line with status and preview', () => {
    const out = renderItem(
      { kind: 'tool', id: 'x', final: true, name: 'Bash', input: { command: 'ls' }, status: 'done', result: { type: 'tool_result', toolUseId: 'x', content: 'a\nb' }, aside: false },
      { width: 60, painter: plain, showThinking: false },
    );
    expect(out).toBe('● Bash ls\n  ⎿  a\n     b');
  });

  test('aside label uses the model', () => {
    expect(renderItem({ kind: 'label', id: 'l', final: true, text: 'Second opinion', model: 'openai/gpt-5.5' }, { width: 60, painter: plain, showThinking: false })).toBe('◆ Second opinion · gpt-5.5');
  });
});

describe('approval preview', () => {
  test('a command shows as it will run: escape codes as symbols, and how many lines are left out', () => {
    // SGR 8 hides the text after it on most terminals; Ink passes SGR codes through
    const command = ['ls \x1b[8mrm -rf ~\x1b[28m', ...Array.from({ length: 9 }, (_, i) => `echo ${i}\r`)].join('\n');
    const lines = approvalPreview('Bash', { command }, plain, 80);
    expect(lines[0]).toBe('ls ␛[8mrm -rf ~␛[28m');
    expect(lines[1]).toBe('echo 0␍');
    expect(lines.at(-1)).toBe('… +2 lines');
    expect(lines).toHaveLength(9);
    expect(lines.join('\n')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(approvalPreview('Write', { content: 'x\x1b]52;c;ZXZpbA==\x07' }, plain, 80)).toEqual(['+x␛]52;c;ZXZpbA==␇']);
  });
});

describe('status line', () => {
  const session = {
    id: 's1',
    model: 'anthropic/claude-sonnet-5-5',
    status: 'idle',
    stats: { messages: 4, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 3000, costUsd: 0.42 },
  } as Session;
  const now = 1_000_000;
  const limits: LimitState[] = [
    { provider: 'claude-max', label: 'Claude', windows: [{ name: '5h', usedPercent: 62, resetsAt: now + 72 * 60_000 }, { name: '7d', usedPercent: 20 }], updatedAt: now, source: 'headers' },
    { provider: 'openai', label: 'OpenAI', windows: [{ name: 'rpm', usedPercent: 90 }], updatedAt: now, source: 'headers' },
  ];

  test('tightest limit prefers the current provider or its subscription', () => {
    const t = tightestLimit(limits, 'claude-code/opus', { 'claude-code': 'claude-max' })!;
    expect(t.limit.provider).toBe('claude-max');
    expect(t.window.name).toBe('5h');
  });

  test('footer shows context, tokens, cost, cache and the limit', () => {
    const out = usageLine(
      { session, model: 'claude-code/opus', lastUsage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 48_000 }, contextWindow: 200_000, limits, subscriptions: { 'claude-code': 'claude-max' }, now },
      plain,
    );
    expect(out).toBe('ctx 25% · 4k in / 500 out · $0.42 · cache 75% · claude 5h 62% · resets 1h12m');
  });

  test('waiting_reset shows a countdown', () => {
    const out = usageLine({ session: { ...session, status: 'waiting_reset', resumeAt: now + 65_000 }, limits: [], subscriptions: {}, now }, plain);
    expect(out.startsWith('⏸ limit reached · resumes in 1m05s')).toBe(true);
  });

  test('header shows model, effort, agent and mode left, permissions right', () => {
    const out = headerLine({ model: 'zai/glm-5', effort: 'high', agent: 'coder', mode: 'plan', permissionMode: 'acceptEdits' }, plain, 60);
    expect(out).toStartWith('● glm-5 · high · @coder · plan  ');
    expect(out).toEndWith('  ⏵⏵ accept edits');
    expect(width(out)).toBe(60);
    // the plain agent mode is not repeated on every frame
    expect(headerLine({ model: 'zai/glm-5', mode: 'agent' }, plain, 40)).not.toContain('agent');
  });

  test('footer puts the folder left and usage right; the hub only shows when it is not connected', () => {
    const out = footerLine({ device: 'pc', cwd: '/srv/app', hubStatus: 'open', session, limits: [], subscriptions: {}, now }, plain, 80);
    expect(out.startsWith('pc:/srv/app ')).toBe(true);
    expect(out.endsWith('$0.42 · cache 75%')).toBe(true);
    expect(width(out)).toBe(80);
    expect(footerLine({ device: 'pc', cwd: '/srv/app', hubStatus: 'closed', limits: [], subscriptions: {}, now }, plain, 80)).toStartWith('● hub offline · pc:/srv/app');
  });

  test('narrow rows keep the right side and cut the left', () => {
    const out = spread('a very long left side that does not fit', 'right', 30);
    expect(width(out)).toBeLessThanOrEqual(30);
    expect(out.endsWith('  right')).toBe(true);
    expect(spread('left', 'a right side far too wide', 16)).toBe(truncate('left', 16));
  });

  test('context percent', () => {
    expect(contextPercent({ inputTokens: 50, outputTokens: 50 }, 1000)).toBe(10);
    expect(contextPercent(undefined, 1000)).toBeUndefined();
  });
});

describe('config helpers', () => {
  test('paths and patches', () => {
    expect(getPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(patchFor('modes.reviewer', 'x')).toEqual({ modes: { reviewer: 'x' } });
    expect(parseValue('7800')).toBe(7800);
    expect(parseValue('["a"]')).toEqual(['a']);
    expect(parseValue('openai/gpt-5.5')).toBe('openai/gpt-5.5');
  });
});

describe('truncate', () => {
  const color = createPainter({ enabled: true });
  test('keeps escape codes whole and resets at the cut', () => {
    const out = truncate(color.red('hello world') + ' tail', 8);
    expect(stripAnsi(out)).toBe('hello w…');
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(width(out)).toBe(8);
  });
  test('wide characters count double', () => {
    expect(truncate('日本語のテキスト', 7)).toBe('日本語…');
  });
});

describe('terminal chat polish', () => {
  // client calls not in `over` stay pending
  const fakeCtl = (over: Record<string, unknown> = {}, session: unknown = { id: 's1', status: 'running', model: 'x/y', stats: {} }) => {
    let on: (ev: unknown) => void = () => {};
    let onResync = () => {};
    const connect = (cb: (ev: unknown) => void, o: { onResync: () => void }) => {
      on = cb;
      onResync = o.onResync;
      return Object.assign(() => {}, { setActive: () => {} });
    };
    const client = new Proxy({}, { get: (_t, k) => (k === 'connect' ? connect : typeof k === 'string' && k in over ? over[k] : () => new Promise(() => {})) });
    const ctl = new ChatController({ client: client as never, hubUrl: 'http://hub', hubSource: 'saved', draft: { cwd: '/tmp', device: 'local' }, version: '0' });
    void ctl.start({});
    (ctl as unknown as { snap: { session: unknown } }).snap.session = session ?? undefined;
    return { ctl, emit: (ev: Record<string, unknown>) => on({ seq: 1, ts: 1, ...ev }), resync: () => onResync() };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const shown = (ctl: ChatController) => (ctl.emit(true), [...ctl.getSnapshot().committed, ...ctl.getSnapshot().live].map((i) => stripAnsi(renderItem(i, { width: 80, painter: plain, showThinking: false }))));
  const host = (ctl: ChatController) => {
    const pickers: PickerSpec[] = [];
    return { pickers, host: { ctl, openPicker: (s: PickerSpec) => pickers.push(s), exit: () => {}, width: () => 80 } };
  };
  const builtin = (name: string) => BUILTINS.find((b) => b.name === name)!;

  test("a subagent's approval shows in the chat you are in, and leaves when it is answered", () => {
    const { ctl, emit } = fakeCtl();
    const from = { sessionId: 'sub1', agent: 'email', label: 'Find mail', chain: ['sub1'] };
    emit({ type: 'approval.requested', approval: { id: 'a1', sessionId: 'sub1', rootSessionId: 's1', from, toolUseId: 't1', tool: 'Bash', input: {}, createdAt: 1 } });
    emit({ type: 'question.asked', question: { id: 'q1', sessionId: 'sub1', rootSessionId: 's1', from, questions: [], createdAt: 1 } });
    // another chat's request stays out
    emit({ type: 'approval.requested', approval: { id: 'a2', sessionId: 'other', toolUseId: 't2', tool: 'Bash', input: {}, createdAt: 1 } });
    expect(ctl.getSnapshot().approvals.map((a) => a.id)).toEqual(['a1']);
    expect(ctl.getSnapshot().questions.map((q) => q.id)).toEqual(['q1']);
    expect(askFrom({ from })).toBe('Subagent email asks');
    emit({ type: 'approval.resolved', id: 'a1', sessionId: 'sub1', response: { decision: 'allow' } });
    expect(ctl.getSnapshot().approvals).toEqual([]);
    ctl.dispose();
  });

  test("a turn's end drops only its own prompts; a background child's stays until it is answered", () => {
    const { ctl, emit } = fakeCtl();
    emit({ type: 'approval.requested', approval: { id: 'own', sessionId: 's1', toolUseId: 't0', tool: 'Bash', input: {}, createdAt: 1 } });
    emit({ type: 'approval.requested', approval: { id: 'child', sessionId: 'sub1', rootSessionId: 's1', toolUseId: 't1', tool: 'Bash', input: {}, createdAt: 1 } });
    emit({ type: 'question.asked', question: { id: 'cq', sessionId: 'sub1', rootSessionId: 's1', questions: [], createdAt: 1 } });
    emit({ type: 'session.updated', session: { id: 's1', status: 'idle', model: 'x/y', stats: {} } });
    expect(ctl.getSnapshot().approvals.map((a) => a.id)).toEqual(['child']);
    expect(ctl.getSnapshot().questions.map((q) => q.id)).toEqual(['cq']);
    emit({ type: 'question.answered', id: 'cq', sessionId: 'sub1' });
    expect(ctl.getSnapshot().questions).toEqual([]);
    ctl.dispose();
  });

  test('a provider error whose notice is already shown prints the reason once', () => {
    const { ctl, emit } = fakeCtl();
    emit({ type: 'message.created', message: { id: 'n1', sessionId: 's1', seq: 1, role: 'assistant', kind: 'notice', createdAt: 1, meta: { level: 'error' }, content: [{ type: 'text', text: 'Error: provider exploded' }] } });
    emit({ type: 'session.updated', session: { id: 's1', status: 'error', error: 'provider exploded', model: 'x/y', stats: {} } });
    const out = shown(ctl);
    expect(out.filter((t) => t.includes('provider exploded'))).toHaveLength(1);
    expect(out).toContain('■ Why this turn stopped: Provider error\n  Send a message to try again, or switch model.');
    ctl.dispose();
  });

  test('a resync reads the fetched messages before it judges the stop, and refetches the queue', async () => {
    const stopped = { id: 's1', status: 'idle', model: 'x/y', stats: {}, meta: { stoppedTurn: true } };
    const msgs = [
      { id: 'm1', sessionId: 's1', seq: 1, role: 'assistant', kind: 'normal', createdAt: 1, stopReason: 'aborted', content: [{ type: 'text', text: 'working' }] },
      { id: 'm2', sessionId: 's1', seq: 2, role: 'assistant', kind: 'notice', createdAt: 2, content: [{ type: 'text', text: 'Stopped' }] },
    ];
    const { ctl, resync } = fakeCtl({ getSession: async () => stopped, messages: async () => msgs, queue: async () => [] });
    (ctl as unknown as { snap: { queue: unknown[] } }).snap.queue = [{ id: 'tui-1', text: 'next', at: 1, whenBusy: 'queue' }];
    resync();
    await tick();
    // the owner pressed Stop (from the phone): no "hub restarted" card
    expect(shown(ctl).some((t) => t.includes('Why this turn stopped'))).toBe(false);
    expect(ctl.getSnapshot().queue).toEqual([]);
    ctl.dispose();
  });

  test('a message sent while busy waits in the list at once, and leaves when it ran or failed', async () => {
    let answer: (v: unknown) => void = () => {};
    const results: Array<() => Promise<unknown>> = [() => new Promise((r) => (answer = r)), async () => ({ queued: false }), async () => Promise.reject(new Error('hub said no'))];
    const { ctl } = fakeCtl({ send: () => results.shift()!() });
    const p = ctl.send('steer this', { whenBusy: 'steer' });
    await tick();
    expect(ctl.getSnapshot().queue.map((q) => [q.text, q.whenBusy])).toEqual([['steer this', 'steer']]);
    answer({ queued: true });
    await p;
    expect(ctl.getSnapshot().queue).toHaveLength(1);
    (ctl as unknown as { snap: { queue: unknown[] } }).snap.queue = [];
    await ctl.send('ran at once');
    expect(ctl.getSnapshot().queue).toEqual([]);
    await ctl.send('fails');
    expect(ctl.getSnapshot().queue).toEqual([]);
    expect(shown(ctl).some((t) => t.includes('hub said no'))).toBe(true);
    ctl.dispose();
  });

  test('/effort lists the levels with the default, sets or clears it, and refuses unknown levels', async () => {
    const patches: unknown[] = [];
    const { ctl } = fakeCtl({ updateSession: async (_id: string, patch: unknown) => (patches.push(patch), { id: 's1', status: 'running', model: 'x/y', stats: {} }) });
    ctl.models = [{ models: [{ ref: 'x/y', effort: { levels: ['low', 'high'], off: false, default: 'high' } }] }] as never;
    const { host: h, pickers } = host(ctl);
    await builtin('effort').run(h as never, '');
    expect(pickers[0].items.map((i) => [i.value, i.hint])).toEqual([
      ['default', "the model's default is high"],
      ['low', ''],
      ['high', 'model default'],
    ]);
    await pickers[0].onSelect(pickers[0].items[0], false);
    await builtin('effort').run(h as never, 'low');
    expect(patches).toEqual([{ chat: { thinking: null } }, { chat: { thinking: 'low' } }]);
    await builtin('effort').run(h as never, 'hard');
    expect(patches).toHaveLength(2);
    expect(shown(ctl).some((t) => t.includes('Unknown effort "hard"'))).toBe(true);
    ctl.dispose();
  });

  test('an effort picked before the first message goes with the new session', async () => {
    const created: unknown[] = [];
    const { ctl } = fakeCtl({ createSession: async (input: unknown) => (created.push(input), { id: 's9', status: 'idle', model: 'x/y', stats: {} }), send: async () => ({ queued: false }) }, null);
    await ctl.patchSession({ chat: { thinking: 'high' } });
    await ctl.send('hi');
    expect((created[0] as { chat?: unknown }).chat).toEqual({ thinking: 'high' });
    ctl.dispose();
  });

  test('/queue removes with x and sends a held message with enter', async () => {
    const calls: string[] = [];
    const { ctl } = fakeCtl({ unqueue: async (_s: string, id: string) => calls.push(`unqueue ${id}`), sendQueued: async (_s: string, id: string) => calls.push(`send ${id}`) });
    (ctl as unknown as { snap: { queue: unknown[] } }).snap.queue = [
      { id: 'q1', text: 'later', at: 1, whenBusy: 'queue' },
      { id: 'q2', text: 'held', at: 1, whenBusy: 'queue', held: true },
    ];
    const { host: h, pickers } = host(ctl);
    await builtin('queue').run(h as never, '');
    const [later, held] = pickers[0].items;
    await pickers[0].onSelect(later, true);
    await pickers[0].onSelect(held, false);
    await pickers[0].onSelect(later, false);
    expect(calls).toEqual(['unqueue q1', 'send q2']);
    ctl.dispose();
  });

  test('messages waiting for the running turn follow session.queue', () => {
    const { ctl, emit } = fakeCtl();
    emit({ type: 'session.queue', sessionId: 's1', queue: [{ id: 'p1', text: 'next', at: 1, whenBusy: 'queue' }] });
    expect(ctl.getSnapshot().queue.map((q) => q.text)).toEqual(['next']);
    emit({ type: 'session.queue', sessionId: 'other', queue: [] });
    expect(ctl.getSnapshot().queue).toHaveLength(1);
    ctl.dispose();
  });

  test('a turn that ends in a provider error says why it stopped, once', () => {
    const { ctl, emit } = fakeCtl();
    emit({ type: 'session.updated', session: { id: 's1', status: 'error', error: 'provider exploded', model: 'x/y', stats: {} } });
    const items = [...ctl.getSnapshot().committed, ...ctl.getSnapshot().live];
    const stops = items.filter((i) => i.kind === 'stop');
    expect(stops).toHaveLength(1);
    expect(items.some((i) => i.kind === 'notice' && i.text === 'provider exploded')).toBe(false);
    expect(stripAnsi(renderItem(stops[0], { width: 60, painter: plain, showThinking: false }))).toBe('■ Why this turn stopped: Provider error\n  provider exploded\n  Send a message to try again, or switch model.');
    ctl.dispose();
  });

  test('hub context in a user message is not shown as the owner words', () => {
    const store = new TranscriptStore();
    store.load([{ id: 'u1', sessionId: 's1', seq: 1, role: 'user', kind: 'normal', createdAt: 1, content: [{ type: 'text', text: 'hi' }, { type: 'text', text: '<system-reminder>\nrecalled\n</system-reminder>' }] }], false);
    const b = store.build();
    const users = [...b.committed, ...b.live].filter((i) => i.kind === 'user');
    expect(users.map((u) => (u as { text: string }).text)).toEqual(['hi']);
  });

  test('NO_COLOR drops Ink colors too', () => {
    expect(inkColor('cyan', createPainter({ enabled: false }))).toBeUndefined();
    expect(inkColor('cyan', createPainter({ enabled: true }))).toBe('cyan');
  });

  test('a bare slash lists commands in their own order, most used first', () => {
    expect(matchCommands(BUILTINS, '', 3).map((s) => s.value)).toEqual(BUILTINS.slice(0, 3).map((b) => '/' + b.name));
    expect(BUILTINS.some((b) => b.name === 'effort')).toBe(true);
    expect(BUILTINS.some((b) => b.name === 'queue')).toBe(true);
  });

  test('workflow and delegate calls get a title', () => {
    expect(toolTitle('Workflow', { name: 'deep-research' })).toEqual({ name: 'Workflow', detail: 'deep-research' });
    expect(toolTitle('Delegate', { to: 'code', description: 'Fix the build' })).toEqual({ name: 'Delegate(code)', detail: 'Fix the build' });
  });
});

describe('presence', () => {
  test('the terminal app says it is in use when you type, at most every 20 seconds', () => {
    const sent: boolean[] = [];
    let opts: { active?: boolean } = {};
    const connect = (_on: unknown, o: { active?: boolean }) => {
      opts = o;
      return Object.assign(() => {}, { setActive: (a: boolean) => sent.push(a) });
    };
    // every other call stays pending: this test is only about the socket
    const client = new Proxy({}, { get: (_t, k) => (k === 'connect' ? connect : () => new Promise(() => {})) });
    const ctl = new ChatController({ client: client as never, hubUrl: 'http://hub', hubSource: 'saved', draft: { cwd: '/tmp' } as never, version: '0' });
    void ctl.start({});
    // connected as in use, so the hub holds routine notices while this terminal is open and used
    expect(opts.active).toBe(true);
    // the connect itself counts; a key right after does not send again
    ctl.inUse();
    expect(sent).toEqual([]);
    (ctl as unknown as { lastPresence: number }).lastPresence = Date.now() - 21_000;
    ctl.inUse();
    ctl.inUse();
    expect(sent).toEqual([true]);
    ctl.dispose();
  });
});
