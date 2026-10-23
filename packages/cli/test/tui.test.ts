import { describe, expect, test } from 'bun:test';
import type { LimitState, Session } from '@conclave/core/types.ts';
import { createPainter, stripAnsi, truncate, width } from '../src/ansi';
import { atToken, matchCommands, matchFiles, slashToken } from '../src/tui/complete';
import { attachmentsFor, ChatController } from '../src/tui/controller';
import * as ed from '../src/tui/editor';
import { History } from '../src/tui/history';
import { renderItem } from '../src/tui/render-item';
import { approvalPreview } from '../src/render/tools';
import { contextPercent, footerLine, headerLine, tightestLimit } from '../src/tui/statusline';
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
    const out = footerLine(
      { session, model: 'claude-code/opus', lastUsage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 48_000 }, contextWindow: 200_000, limits, subscriptions: { 'claude-code': 'claude-max' }, now },
      plain,
      200,
    );
    expect(out).toBe('ctx 25% · 4k in / 500 out · $0.42 · cache 75% · claude 5h 62% · resets 1h12m');
  });

  test('waiting_reset shows a countdown', () => {
    const out = footerLine({ session: { ...session, status: 'waiting_reset', resumeAt: now + 65_000 }, limits: [], subscriptions: {}, now }, plain, 200);
    expect(out.startsWith('⏸ limit reached · resumes in 1m05s')).toBe(true);
  });

  test('header shows model, agent, mode, permissions, device, cwd and hub', () => {
    const out = stripAnsi(headerLine({ model: 'zai/glm-5', agent: 'coder', mode: 'agent', permissionMode: 'acceptEdits', device: 'pc', cwd: '/srv/app', hubStatus: 'open' }, plain, 200));
    expect(out).toBe('● glm-5 · @coder · agent · ⏵⏵ accept edits · pc:/srv/app · ● hub');
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
