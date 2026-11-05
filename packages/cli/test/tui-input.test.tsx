/** The chat screen's keys, driven through Ink with fake terminal streams. */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render, type Instance } from 'ink';
import { stripAnsi } from '../src/ansi';
import { App } from '../src/tui/App';
import { ChatController } from '../src/tui/controller';
import { History } from '../src/tui/history';

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
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let mounted: Instance | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

async function mount(columns = 120) {
  const ctl = new ChatController({ client: {} as never, hubUrl: 'http://x', hubSource: 'local', draft: { device: 'local', cwd: '/tmp' }, version: 't' });
  const sent: string[] = [];
  ctl.send = async (t: string) => void sent.push(t);
  const toggles: string[] = [];
  ctl.toggleExpand = () => void toggles.push('expand');
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

  test('ctrl+o toggles the expanded transcript', async () => {
    const { toggles, type } = await mount();
    await type('\x0f');
    expect(toggles).toEqual(['expand']);
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

  test('? on an empty prompt shows the shortcuts', async () => {
    const { stdout, type } = await mount();
    await type('?');
    expect(stripAnsi(stdout.frames.at(-1)!)).toContain('ctrl+o expand tool output');
  });
});
