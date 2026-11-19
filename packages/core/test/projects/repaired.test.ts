/**
 * The same computer removed and paired again under a new device id (the desktop
 * app's switch turned off and on before it kept the pairing): a session left on the
 * old id moves to the new one at its exact folder, not to the home folder.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { projectsOf } from '../../src/projects/registry';
import type { ProjectsService } from '../../src/projects/service';
import { attach, detach, HomeMachine, twoDevices, type TwoDevices } from './machines';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;

afterEach(async () => {
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  t = d = undefined;
});

test('a move to the same computer paired again keeps the exact folder', async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  d = twoDevices(t.engine);
  const svc = projectsOf(t.engine) as ProjectsService;
  // a plain folder (no git): elsewhere it would only be a weak match
  const site = join(d.pc.home, 'Coding', 'site', 'website');
  mkdirSync(site, { recursive: true });
  const s = await t.engine.createSession({ device: 'pc', cwd: site });
  await svc.recordState(s);
  t.engine.repos.devices.seen('pc', d.pc.infoNow());

  // removed itself, then paired again as pc2 on the same disk
  detach(t.engine, 'pc');
  t.engine.repos.devices.delete('pc');
  const again = new HomeMachine('pc2', d.pc.name, d.pc.home);
  t.engine.repos.devices.insert({ id: 'pc2', name: d.pc.name, tokenHash: 'test' });
  t.engine.repos.devices.seen('pc2', again.infoNow());
  attach(t.engine, again);
  expect(t.engine.repos.devices.sameMachine('pc', 'pc2')).toBe(true);
  // another computer is not the same machine
  expect(t.engine.repos.devices.sameMachine('pc', 'mac')).toBe(false);
  // two live devices that share a hostname are never the same machine
  t.engine.repos.devices.insert({ id: 'pc3', name: d.pc.name, tokenHash: 'test' });
  t.engine.repos.devices.seen('pc3', again.infoNow());
  expect(t.engine.repos.devices.sameMachine('pc2', 'pc3')).toBe(false);
  t.engine.repos.devices.delete('pc3');

  const r = await svc.move(s.id, { device: 'pc2' });
  expect(r).toMatchObject({ resolved: true, via: 'same-path', level: 'exact', cwd: site });
  expect(t.engine.requireSession(s.id)).toMatchObject({ device: 'pc2', cwd: site });
});
