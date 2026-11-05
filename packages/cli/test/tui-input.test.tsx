/** The chat screen's keys, driven through Ink with fake terminal streams. */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render, type Instance } from 'ink';
import { stripAnsi } from '../src/ansi';
import { App } from '../src/tui/App';
import { ChatController } from '../src/tui/controller';
import { History } from '../src/tui/history';
import { transcriptLines } from '../src/tui/FullView';
import { Picker } from '../src/tui/Picker';
import { inkFrame, reflowExtraRows, xtermKeysToCsiU } from '../src/tui/main';
import { BUILTINS } from '../src/tui/slash';
import { renderMarkdown } from '../src/render/markdown';
import { createPainter, truncateWords } from '../src/ansi';
import type { Item } from '../src/tui/transcript';

class FakeStdin extends EventEmitter {
  isTTY = true;
  private buf: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.buf;
    this.buf = null;
    return d;
  };
  write(d: string) {
    this.buf = d;
    this.emit('readable');
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows = 30,
  ) {
    super();
  }
  write = (s: string) => {
    this.frames.push(s);
    return true;
  };
  get text() {
    return stripAnsi(this.frames.join(''));
  }
  /** The last frame with visible text (mode switches like paste on/off come after it). */
  get screen() {
    return this.frames.filter((f) => stripAnsi(f).trim()).at(-1) ?? '';
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let mounted: Instance | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

async function mount(columns = 120, cwd = '/tmp') {
  const ctl = new ChatController({ client: {} as never, hubUrl: 'http://x', hubSource: 'local', draft: { device: 'local', cwd }, version: 't' });
  const sent: string[] = [];
  ctl.send = async (t: string) => void sent.push(t);
  const toggles: string[] = [];
  ctl.onFullScreen = (on) => void toggles.push(on ? 'full on' : 'full off');
  ctl.onRepaint = () => void toggles.push('repaint');
  ctl.onExit = () => void toggles.push('exit');
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(columns);
  mounted = render(<App ctl={ctl} history={new History('/dev/null')} />, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
  await tick();
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      stdin.write(k);
      await tick();
    }
  };
  return { ctl, sent, toggles, stdout, type };
}

describe('input keys', () => {
  test('enter sends; shift+enter (kitty CSI 13;2u), alt+enter, ctrl+j and a trailing \\ add a line', async () => {
    const { sent, type } = await mount();
    await type('a', '\x1b[13;2u', 'b', '\x1b\r', 'c', '\n', 'd', '\\', '\r', 'e', '\r');
    expect(sent).toEqual(['a\nb\nc\nd\ne']);
  });

  test('ctrl+o opens the transcript on its own screen and q closes it, printing nothing twice', async () => {
    const { ctl, toggles, stdout, type } = await mount(80);
    const key = ctl.getSnapshot().staticKey;
    await type('\x0f');
    const view = stripAnsi(stdout.screen);
    expect(view).toContain('Transcript ·');
    expect(view).not.toContain('Ask anything');
    await type('q');
    expect(toggles).toEqual(['full on', 'full off']);
    expect(stripAnsi(stdout.screen)).toContain('Ask anything');
    // the transcript is not printed again into scrollback
    expect(ctl.getSnapshot().staticKey).toBe(key);
  });

  test('the full view draws only the rows in view, and every line of a 1000-line output is there', async () => {
    const content = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join('\n');
    const tool: Item = { kind: 'tool', id: 't', final: true, name: 'Bash', input: { command: 'seq' }, status: 'done', result: { type: 'tool_result', toolUseId: 't', content }, aside: false };
    const lines = transcriptLines([tool], 80, '/tmp').map(stripAnsi);
    expect(lines.some((l) => l.includes('row 999'))).toBe(true);
    expect(lines.some((l) => l.includes('lines'))).toBe(false);
    const { ctl, stdout, type } = await mount(80);
    ctl.store.addLocal({ kind: 'info', text: content });
    ctl.emit(true);
    await type('\x0f');
    const frame = stripAnsi(stdout.screen).split('\n').slice(-30);
    expect(frame.join('\n')).toContain('row 999');
    await type('g');
    const top = stripAnsi(stdout.screen).split('\n').slice(-30).join('\n');
    expect(top).toContain('row 0');
    expect(top).not.toContain('row 999');
  });

  test('ctrl+l repaints the live area without printing the transcript again', async () => {
    const { ctl, toggles, type } = await mount();
    const key = ctl.getSnapshot().staticKey;
    await type('\x0c');
    expect(toggles).toEqual(['repaint']);
    expect(ctl.getSnapshot().staticKey).toBe(key);
  });

  test('a resize erases the rows a reflowing terminal wrapped the live frame into', () => {
    const frame = ['short', 'x'.repeat(80), '\x1b[2m' + 'y'.repeat(100) + '\x1b[22m'].join('\n');
    expect(reflowExtraRows(frame, 60)).toBe(1 + 1);
    expect(reflowExtraRows(frame, 120)).toBe(0);
  });

  test('Ink renderer is found for its stdout (the resize fix reads its frame)', async () => {
    const { stdout } = await mount();
    expect(typeof inkFrame(stdout as never)).toBe('string');
  });

  test('a long paste is one token, backspace removes it whole, enter sends the text', async () => {
    const { sent, stdout, type } = await mount();
    const big = Array.from({ length: 12 }, (_, i) => `pasted ${i}`).join('\n');
    await type('see ', `\x1b[200~${big}\x1b[201~`);
    expect(stripAnsi(stdout.frames.at(-1)!)).toContain('see [Pasted text #1 +12 lines]');
    await type('\x7f');
    expect(stripAnsi(stdout.frames.at(-1)!)).toContain('> see ');
    expect(stripAnsi(stdout.frames.at(-1)!)).not.toContain('Pasted');
    await type(`\x1b[200~${big}\x1b[201~`, ' ok', '\r');
    expect(sent).toEqual([`see ${big} ok`]);
    // a short paste goes in as typed
    await type('\x1b[200~two\nlines\x1b[201~', '\r');
    expect(sent[1]).toBe('two\nlines');
  });

  test('ctrl+c twice erases the live area before quitting', async () => {
    const { toggles, type } = await mount();
    await type('\x03', '\x03');
    expect(toggles).toEqual(['exit']);
  });

  test('the spinner uses the dimmed foreground, not magenta', async () => {
    const { ctl, stdout } = await mount();
    (ctl as unknown as { snap: object }).snap = { ...ctl.getSnapshot(), session: { id: 's', status: 'running', cwd: '/tmp', device: 'local', stats: { messages: 0 } }, turnStartedAt: Date.now() };
    ctl.emit(true);
    await tick(150);
    const frame = stdout.screen;
    const row = frame.split('\n').find((l) => l.includes('esc to interrupt'))!;
    expect(row).toContain('\x1b[2m');
    expect(row).not.toContain('\x1b[35m');
  });
});

describe('tmux newline', () => {
  const was = process.env.TMUX;
  afterEach(() => {
    if (was === undefined) delete process.env.TMUX;
    else process.env.TMUX = was;
  });

  test("tmux's xterm-format extended keys are read as CSI-u", () => {
    expect(xtermKeysToCsiU('a\x1b[27;2;13~b')).toBe('a\x1b[13;2ub');
    expect(xtermKeysToCsiU('\x1b[27;3;13~')).toBe('\x1b[13;3u');
    expect(xtermKeysToCsiU('\x1b[A')).toBe('\x1b[A');
  });

  test('in tmux the hint row says how to add a line until shift+enter is seen', async () => {
    process.env.TMUX = '/tmp/tmux-1/default,1,0';
    const { ctl, sent, stdout, type } = await mount(60);
    (ctl as unknown as { snap: object }).snap = { ...ctl.getSnapshot(), hubStatus: 'open' };
    ctl.emit(true);
    await tick();
    expect(stripAnsi(stdout.screen)).toContain('alt+enter or \\ for newline');
    await type('a', xtermKeysToCsiU('\x1b[27;2;13~'), 'b');
    expect(stripAnsi(stdout.screen)).not.toContain('alt+enter or');
    await type('\x1b[13;2u', 'c', '\r');
    expect(sent).toEqual(['a\nb\nc']);
  });

  test('outside tmux the row keeps "? for shortcuts"', async () => {
    delete process.env.TMUX;
    const { stdout } = await mount(120);
    const frame = stripAnsi(stdout.frames.at(-1)!);
    expect(frame).not.toContain('alt+enter or');
  });
});

describe('lists and pickers', () => {
  const plain = createPainter({ enabled: false });

  test('pickers are a plain numbered list under a dim header, no box', async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout(60);
    const picked: string[] = [];
    const items = ['alpha', 'beta', 'gamma'].map((v) => ({ label: v, value: v, hint: 'a long hint about this item that will not fit the row' }));
    mounted = render(<Picker spec={{ title: 'Model', items, onSelect: (it) => void picked.push(it.value) }} width={60} onClose={() => {}} />, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, debug: true });
    await tick();
    const frame = stdout.frames.at(-1)!;
    const rows = stripAnsi(frame).split('\n').filter(Boolean);
    expect(rows[0]).toBe('Model · type to search');
    expect(rows[1]).toStartWith('❯ 1. alpha');
    expect(rows[2]).toStartWith('  2. beta');
    expect(rows.at(-1)).toBe('enter select · esc cancel');
    expect(rows.join('')).not.toMatch(/[╭╰│]/);
    // hints end at a whole word
    const hint = 'a long hint about this item that will not fit the row';
    for (const r of rows.slice(1, 4)) {
      expect(r.length).toBeLessThanOrEqual(60);
      const cut = r.replace(/^.*?(a long)/, '$1').replace(/…$/, '');
      expect(hint.startsWith(cut) && hint[cut.length] === ' ').toBe(true);
    }
    stdin.write('2');
    await tick();
    expect(picked).toEqual(['beta']);
  });

  test('ordered list numbers are right-aligned past 9', () => {
    const src = Array.from({ length: 12 }, (_, i) => `${i + 1}. item ${i + 1}`).join('\n');
    const lines = renderMarkdown(src, { painter: plain, width: 60 }).split('\n');
    expect(lines[0]).toBe(' 1. item 1');
    expect(lines[8]).toBe(' 9. item 9');
    expect(lines[9]).toBe('10. item 10');
    expect(renderMarkdown('1. a\n2. b', { painter: plain, width: 60 })).toBe('1. a\n2. b');
  });

  test('/help key descriptions start in one column; hints cut at a word with an ellipsis', () => {
    let info = '';
    const ctl = { commands: [], info: (t: string) => void (info = t) } as never;
    for (const width of [60, 120]) {
      BUILTINS.find((b) => b.name === 'help')!.run({ ctl, width: () => width, openPicker() {}, exit() {} }, '');
      const rows = stripAnsi(info).split('\n');
      const keys = rows.slice(rows.indexOf('Keys') + 1);
      const cols = new Set(keys.flatMap((r) => [...r.matchAll(/new line|interrupt|full transcript|show thinking|permission mode|quit/g)].map((m) => m.index)));
      expect(cols.size).toBe(width === 60 ? 1 : 2);
      expect(keys.every((r) => r.length <= width)).toBe(true);
    }
    expect(truncateWords('Clear the screen and start a new session', 30)).toBe('Clear the screen and start a…');
    expect(truncateWords('Supercalifragilistic', 10)).toBe('Supercali…');
  });

  test('the status row is one line under a single rounded box, at 60 and 120 cols', async () => {
    for (const cols of [60, 120]) {
      const { stdout } = await mount(cols);
      const frame = stdout.frames.at(-1)!;
      const lines = stripAnsi(frame).split('\n').filter(Boolean);
      expect(lines.at(-4)).toStartWith('╭');
      expect(lines.at(-3)).toContain('Ask anything');
      expect(lines.at(-2)).toStartWith('╰');
      // no hub behind the stub controller, so the row says so; no model is known yet, so none is named
      expect(lines.at(-1)!.trim()).toBe('◌ connecting');
      expect(lines.every((l) => l.length <= cols)).toBe(true);
      mounted?.unmount();
      mounted = undefined;
    }
  });

  test('@ completion at 60 cols keeps the file name of a long path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cv-at-'));
    mkdirSync(join(root, 'packages/cli/test/fixtures/deep'), { recursive: true });
    writeFileSync(join(root, 'packages/cli/test/fixtures/deep/transcript-render.test.ts'), '');
    const { stdout, type } = await mount(60, root);
    await type('@', 't', 'r', 'a', 'n', 's');
    await tick(150);
    const rows = stripAnsi(stdout.frames.at(-1)!).split('\n');
    expect(rows.some((l) => l.includes('/deep/transcript-render.test.ts'))).toBe(true);
    expect(rows.every((l) => l.length <= 60)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('? on an empty prompt shows the shortcuts', async () => {
    const { stdout, type } = await mount();
    await type('?');
    expect(stripAnsi(stdout.frames.at(-1)!)).toContain('ctrl+o full transcript');
  });
});
