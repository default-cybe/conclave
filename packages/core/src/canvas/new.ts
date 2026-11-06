/**
 * Canvas's New (docs/WORKFLOWS.md, Canvas): a blank program, flows/untitled-N.flow.ts,
 * opened straight away. With no folder asked for it goes to the account's
 * Canvas folder on the hub, <projects hub root>/canvas/<account> (the same
 * root Move to hub copies into), read through a Code session there made on
 * first use. Members get no shell or file tools on the hub
 * (docs/design/ACCOUNTS.md 5), so a member's New names a folder on a device
 * of their own; the session is always the caller's own.
 */
import { join } from 'node:path';
import type { Engine } from '../engine/engine';
import { EngineError } from '../engine/errors';
import { ASSISTANT_AGENT } from '../assistant/prefs';
import { isMember } from '../people/context';
import { CODE_NEEDS_DEVICE } from '../people/guard';
import { hubRoot } from '../projects/hubcopy';
import type { FlowView } from '../client/flows';
import type { Session } from '../types';
import { flowsOf } from '../flows/service';

export const MEMBER_PICKS_FOLDER = 'Your programs live on a computer you paired: pick a folder there (New in folder).';

/** The account's Canvas folder on the hub. */
export function canvasFolder(engine: Pick<Engine, 'config'>, accountId: string): string {
  return join(hubRoot(engine.config.get().projects?.hubRoot), 'canvas', accountId.replace(/[^\w-]/g, '-'));
}

/** The account's newest Code session in that folder on that device, if any. */
export function folderSession(engine: Engine, accountId: string, device: string, cwd: string): Session | undefined {
  return engine
    .listSessions({ accountId, device, archived: false, limit: 1000 })
    .filter((s) => s.cwd === cwd && s.kind !== 'chat' && s.kind !== 'meeting' && !s.parentId && s.agent !== ASSISTANT_AGENT && !s.incognito)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export interface NewProgram {
  sessionId: string;
  device: string;
  cwd: string;
  view: FlowView;
}

/** A blank program in the folder asked for, else the account's Canvas folder on the hub; the session there is reused or made. */
export async function newProgram(engine: Engine, accountId: string, input: { device?: string; cwd?: string; name?: string } = {}): Promise<NewProgram> {
  const member = isMember(accountId);
  let device = input.device || 'local';
  let cwd = input.cwd?.trim();
  if (!cwd) {
    if (member) throw new EngineError(400, MEMBER_PICKS_FOLDER);
    device = 'local';
    cwd = canvasFolder(engine, accountId);
    await engine.machineFor({ device: 'local', accountId } as Session).mkdir(cwd);
  } else if (member && device === 'local') throw new EngineError(400, CODE_NEEDS_DEVICE);
  // someone else's device answers 404 (createSession checks it too, for a new session)
  if (device !== 'local' && engine.repos.devices.accountOf(device) !== accountId) throw new EngineError(404, `Device ${device} not found`);
  const s = folderSession(engine, accountId, device, cwd) ?? (await engine.createSession({ device, cwd, title: 'Canvas', ...(engine.extensions.agent('coder') ? { agent: 'coder' } : {}) }, accountId, { byPerson: true }));
  const flows = flowsOf(engine);
  const name = input.name ?? (await flows.untitled(s.id));
  return { sessionId: s.id, device, cwd: s.cwd, view: await flows.create(s.id, name, { blank: true }) };
}
