/** Mount the Ink app and wire the controller to the terminal. */
import React from 'react';
import { render } from 'ink';
// Ink keeps its renderer per stdout here; read only to size the live frame after a resize (reflowRows).
import inkInstances from '../../node_modules/ink/build/instances.js';
import { resolve } from 'node:path';
import type { ConclaveClient } from '@conclave/core/client/index.ts';
import type { PermissionMode, SessionMode } from '@conclave/core/types.ts';
import { out as op, stripAnsi, width as strWidth } from '../ansi';
import type { HubTarget } from '../hub';
import { cliPaths } from '../files';
import { VERSION } from '../version';
import { App } from './App';
import { ChatController } from './controller';
import { History } from './history';

export interface TuiOptions {
  client: ConclaveClient;
  target: HubTarget;
  agent?: string;
  model?: string;
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  device?: string;
  cwd?: string;
  resume?: string;
  continueLast?: boolean;
  prompt?: string;
}

/** Rows the live frame takes once a reflowing terminal rewraps it at `cols`, minus the rows it took before. */
export function reflowExtraRows(frame: string, cols: number): number {
  const lines = frame.split('\n');
  const after = lines.reduce((n, l) => n + Math.max(1, Math.ceil(strWidth(stripAnsi(l)) / Math.max(1, cols))), 0);
  return after - lines.length;
}

/**
 * tmux with extended-keys on, in its default xterm format, sends a modified key as CSI 27;mods;code~,
 * which Ink drops. Rewrite it to the CSI code;mods u form Ink reads (shift+enter becomes CSI 13;2u).
 */
export function xtermKeysToCsiU(chunk: string): string {
  return chunk.replace(/\x1b\[27;(\d+);(\d+)~/g, '\x1b[$2;$1u');
}

/** The live frame Ink last drew on this stream, if its renderer can be found. */
export function inkFrame(stdout: NodeJS.WritableStream): string | undefined {
  return (inkInstances.get(stdout) as unknown as { lastOutput?: string } | undefined)?.lastOutput;
}

export async function startTui(o: TuiOptions): Promise<number> {
  const ctl = new ChatController({
    client: o.client,
    hubUrl: o.target.url,
    hubSource: o.target.source,
    draft: {
      agent: o.agent,
      model: o.model,
      mode: o.mode,
      permissionMode: o.permissionMode,
      device: o.device ?? 'local',
      cwd: resolve(o.cwd ?? process.cwd()),
    },
    version: VERSION,
  });
  const history = new History(cliPaths().history);
  const out = process.stdout;
  let fullScreen = false;
  let cols = out.columns || 80;
  // Narrower terminal: finished output is left to the terminal's own reflow. Ink erases only as many
  // rows as its frame had, so first erase the extra rows the reflow wrapped it into.
  // shortcut: assumes the terminal reflows (tmux, kitty, iTerm2, VTE, Windows Terminal do; plain xterm does not).
  const onResize = () => {
    const next = out.columns || 80;
    const frame = fullScreen || next >= cols ? undefined : inkFrame(out);
    cols = next;
    const extra = frame ? reflowExtraRows(frame, next) : 0;
    if (extra > 0) out.write(`\x1b[${extra}A\r\x1b[J`);
  };
  // before Ink's own resize handler, which erases its frame and draws it again
  out.prependListener('resize', onResize);
  // tmux with extended-keys on sends shift+enter as CSI 27;2;13~ or CSI 13;2u once asked (modifyOtherKeys)
  const tmux = !!process.env.TMUX;
  if (tmux) {
    out.write('\x1b[>4;1m');
    const stdin = process.stdin;
    const read = stdin.read.bind(stdin);
    stdin.read = ((size?: number) => {
      const chunk = read(size) as string | Buffer | null;
      if (chunk === null) return chunk;
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      return s.includes('\x1b[27;') ? xtermKeysToCsiU(s) : chunk;
    }) as typeof stdin.read;
  }
  const instance = render(<App ctl={ctl} history={history} />, {
    exitOnCtrlC: false,
    patchConsole: true,
    maxFps: 30,
    // only changed lines are written: less to send over SSH and through tmux
    incrementalRendering: true,
    // terminals that speak the kitty keyboard protocol tell shift+enter from enter
    kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
  });
  ctl.onClearScreen = () => {
    instance.clear();
    // Scroll the screen up into scrollback instead of erasing it (no \x1b[3J), so nothing earlier is lost.
    out.write('\n'.repeat(Math.max(0, (out.rows || 24) - 1)) + '\x1b[H\x1b[2J');
  };
  // ctrl+l: erase the live area only; the next frame draws it again
  ctl.onRepaint = () => instance.clear();
  // ctrl+o: the transcript view gets its own screen; leaving it restores the main screen and its scrollback as they were
  ctl.onFullScreen = (on) => {
    instance.clear();
    fullScreen = on;
    out.write(on ? '\x1b[?1049h\x1b[H\x1b[2J' : '\x1b[?1049l');
  };
  // quitting: erase the input and any popup, so only the transcript stays on screen
  ctl.onExit = () => instance.clear();
  void ctl.start({ resume: o.resume, continueLast: o.continueLast, prompt: o.prompt }).catch((e) => ctl.error(e));
  await instance.waitUntilExit();
  out.off('resize', onResize);
  if (fullScreen) out.write('\x1b[?1049l');
  if (tmux) out.write('\x1b[>4m');
  ctl.dispose();
  const s = ctl.session;
  if (s) out.write(op.dim(`Session ${s.id} · resume with: conclave -r ${s.id}`) + '\n');
  return 0;
}
