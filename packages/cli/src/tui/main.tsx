/** Mount the Ink app and wire the controller to the terminal. */
import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import type { ConclaveClient } from '@conclave/core/client/index.ts';
import type { PermissionMode, SessionMode } from '@conclave/core/types.ts';
import { err as ep } from '../ansi';
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
    process.stdout.write('\n'.repeat(Math.max(0, (process.stdout.rows || 24) - 1)) + '\x1b[H\x1b[2J');
  };
  void ctl.start({ resume: o.resume, continueLast: o.continueLast, prompt: o.prompt }).catch((e) => ctl.error(e));
  await instance.waitUntilExit();
  ctl.dispose();
  const s = ctl.session;
  if (s) process.stderr.write(ep.dim(`Resume this session: conclave -r ${s.id}\n`));
  return 0;
}
