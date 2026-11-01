/**
 * Review pass of section 2.7: an old path from before a move maps to the
 * current folder, so permission rules must judge the path the tool really
 * touches. Two devices over the local disk, the scripted fake model.
 */
import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, type Step, type TestEngine } from '../engine/harness';
import { projectsOf } from '../../src/projects/registry';
import type { ProjectsService } from '../../src/projects/service';
import { cloneRepo, makeRepo, twoDevices, writeSyncthing, type TwoDevices } from './machines';
import { mapOldPath } from '../../src/tools/util';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;
let plan: Step[] = [];

afterEach(async () => {
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  t = undefined;
  d = undefined;
});

async function movedToMac(opts: Partial<Parameters<typeof startTestEngine>[0]> = {}) {
  plan = [];
  t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => plan.shift(), ...opts });
  d = twoDevices(t.engine);
  const svc = projectsOf(t.engine) as ProjectsService;
  const pcRepo = join(d.pc.home, 'code', 'portfolio');
  const macRepo = join(d.mac.home, 'Developer', 'portfolio');
  makeRepo(pcRepo);
  cloneRepo(pcRepo, macRepo);
  writeSyncthing(d.pc.home, [{ id: 'code-1', label: 'code', path: '~/code' }]);
  writeSyncthing(d.mac.home, [{ id: 'code-1', label: 'code', path: '~/Developer' }]);
  const s = await t.engine.createSession({ device: 'pc', cwd: pcRepo });
  await svc.recordState(s);
  const r = await svc.move(s.id, { device: 'mac' });
  expect(r).toMatchObject({ resolved: true, cwd: macRepo });
  return { t, d, svc, s, pcRepo, macRepo };
}

test('a deny rule on a file still holds when the model names it by its old path', async () => {
  const { t, s, pcRepo, macRepo } = await movedToMac({ overrides: { permissions: { mode: 'default', allow: [], deny: ['Read(./.env)'], ask: [], additionalDirectories: [] } } as never });
  writeFileSync(join(macRepo, '.env'), 'TOKEN=on-the-mac\n');
  // the old path from earlier messages: before, the rule judged the pc path and the tool then read the mac file
  plan = [[{ tool: 'Read', input: { file_path: join(pcRepo, '.env') } }], [{ tool: 'Read', input: { file_path: join(macRepo, '.env') } }], [{ text: 'done' }]];
  await t.run(s.id, 'read the env file');
  const reads = toolResults(t.engine, s.id).filter((x) => x.name === 'Read');
  expect(reads.length).toBe(2);
  for (const r of reads) {
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Permission denied');
    expect(r.content).not.toContain('on-the-mac');
  }
});

test('in acceptEdits a write by the old path lands in the current folder without a prompt, as a write there would', async () => {
  const { t, s, pcRepo, macRepo } = await movedToMac({ approve: 'deny' });
  t.engine.setPermissionMode(s.id, 'acceptEdits');
  // the move asked once for the folder; the owner said yes, so later writes do not ask again
  projectsOf(t.engine)!.passGate({ sessionId: s.id, fromSeq: 0, level: 'exact' } as never);
  const before = t.approvals.length;
  plan = [[{ tool: 'Write', input: { file_path: join(pcRepo, 'notes.md'), content: 'hello\n' } }], [{ text: 'done' }]];
  await t.run(s.id, 'write a note');
  const w = toolResults(t.engine, s.id).find((x) => x.name === 'Write');
  expect(w?.isError).toBe(false);
  expect(Bun.file(join(macRepo, 'notes.md')).size).toBeGreaterThan(0);
  // the rule check saw the mac path inside the workspace, so acceptEdits did not stop to ask about a pc path
  expect(t.approvals.slice(before).some((a) => a.includes(pcRepo))).toBe(false);
});

test('a root of / is never an old root: it would map every path on the device', () => {
  const ctx = { pathMap: { roots: [{ from: '', to: '/Users/kai/Developer/portfolio' }], hits: [] as string[] } };
  expect(mapOldPath(ctx, '/etc/hosts')).toBe('/etc/hosts');
});

test('the approval card for an old path names where the call really lands', async () => {
  const { t, s, pcRepo, macRepo } = await movedToMac();
  projectsOf(t.engine)!.passGate({ sessionId: s.id, fromSeq: 0, level: 'exact' } as never);
  const before = t.approvals.length;
  plan = [[{ tool: 'Write', input: { file_path: join(pcRepo, 'notes.md'), content: 'hello\n' } }], [{ text: 'done' }]];
  await t.run(s.id, 'write a note');
  const card = t.approvals.slice(before).find((a) => a.includes('notes.md'));
  expect(card).toContain(`(now ${join(macRepo, 'notes.md')})`);
});
