/**
 * A session with no project moves into the repository its work went into
 * (projects/adopt.ts, ProjectsService.adopt). Real engine, scripted model,
 * two devices over the local disk.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTestEngine, toolResults, until, type Step, type TestEngine } from '../engine/harness';
import { projectsOf } from '../../src/projects/registry';
import type { ProjectsService } from '../../src/projects/service';
import { cloneTargets, workRoot } from '../../src/projects/adopt';
import { makeRepo, twoDevices, type TwoDevices } from './machines';
import type { EngineEventEnvelope } from '../../src/types';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;

afterEach(async () => {
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  t = undefined;
  d = undefined;
});

let plan: Step[] = [];

async function setup() {
  plan = [];
  t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => plan.shift() });
  d = twoDevices(t.engine);
  const svc = projectsOf(t.engine) as ProjectsService;
  const events: EngineEventEnvelope[] = [];
  t.engine.bus.on((e) => void events.push(e));
  return { t, d, svc, events };
}

describe('cloneTargets', () => {
  const home = '/home/kai';
  test('reads the folder of git clone and gh repo clone, following cd', () => {
    expect(cloneTargets('git clone https://github.com/default-cybe/conclave ~/work/conclave', home, home)).toEqual(['/home/kai/work/conclave']);
    expect(cloneTargets('mkdir -p ~/work && cd ~/work && git clone --depth 1 -b main git@github.com:default-cybe/conclave.git', home, home)).toEqual(['/home/kai/work/conclave']);
    expect(cloneTargets('gh repo clone default-cybe/conclave -- --depth 1', '/home/kai/code', home)).toEqual(['/home/kai/code/conclave']);
    expect(cloneTargets('git -C /srv clone https://x.org/a/b.git b2', home, home)).toEqual(['/srv/b2']);
    expect(cloneTargets('git status && ls', home, home)).toEqual([]);
  });

  test('workRoot needs a clone or three edits, and more than half of the work', async () => {
    const rootOf = async (dir: string) => (dir.startsWith('/r/a') ? '/r/a' : dir.startsWith('/r/b') ? '/r/b' : undefined);
    expect(await workRoot({ clones: ['/r/a'], edits: new Map() }, rootOf)).toBe('/r/a');
    expect(await workRoot({ clones: ['/r/a', '/r/b'], edits: new Map() }, rootOf)).toBeUndefined();
    expect(await workRoot({ clones: [], edits: new Map([['/r/b/src', 3]]) }, rootOf)).toBe('/r/b');
    expect(await workRoot({ clones: [], edits: new Map([['/r/b/src', 2]]) }, rootOf)).toBeUndefined();
    expect(await workRoot({ clones: [], edits: new Map([['/r/b/src', 3], ['/notes', 4]]) }, rootOf)).toBeUndefined();
  });
});

describe('moving a session into its project', () => {
  test('a home-folder session that clones a repo moves into it; the next shell starts there', async () => {
    const { t, d, svc, events } = await setup();
    const upstream = join(d.base, 'upstream', 'conclave');
    makeRepo(upstream, 'git@github.com:default-cybe/conclave.git');
    const s = await t.engine.createSession({ device: 'pc', cwd: d.pc.home, permissionMode: 'bypass' });
    plan = [[{ tool: 'Bash', input: { command: `mkdir -p ~/work && cd ~/work && git clone -q ${upstream} conclave` } }], [{ text: 'cloned' }]];
    await t.run(s.id, 'clone conclave and finish the plans');
    const root = join(d.pc.home, 'work', 'conclave');
    expect(await until(() => t.engine.requireSession(s.id).cwd === root)).toBe(true);
    await svc.settled();
    const after = t.engine.requireSession(s.id);
    expect(after).toMatchObject({ device: 'pc', cwd: root });
    expect(after.projectId).toBeTruthy();
    // a known project folder on that device now
    expect(svc.store.locationsOnDevice('pc').map((l) => l.path)).toContain(root);
    expect(events.find((e) => e.type === 'session.moved')).toMatchObject({ sessionId: s.id, from: { device: 'pc', cwd: d.pc.home }, to: { device: 'pc', cwd: root } });
    const notices = t.engine.getMessages(s.id).flatMap((m) => m.content.map((b) => JSON.stringify(b)));
    expect(notices.some((x) => x.includes('Moved this chat to project ~/work/conclave'))).toBe(true);
    // the next Bash call starts in the repo
    plan = [[{ tool: 'Bash', input: { command: 'pwd' } }], [{ text: 'here' }]];
    await t.run(s.id, 'where are you');
    expect(toolResults(t.engine, s.id).filter((r) => r.name === 'Bash').pop()?.content).toContain(root);
  });

  test('a session that has a project is not moved by a clone', async () => {
    const { t, d, svc, events } = await setup();
    const own = join(d.pc.home, 'code', 'portfolio');
    makeRepo(own);
    const upstream = join(d.base, 'upstream', 'other');
    makeRepo(upstream, 'git@github.com:kai/other.git');
    const s = await t.engine.createSession({ device: 'pc', cwd: own, permissionMode: 'bypass' });
    await svc.recordState(s);
    expect(t.engine.requireSession(s.id).projectId).toBeTruthy();
    plan = [[{ tool: 'Bash', input: { command: `git clone -q ${upstream} ~/work/other` } }], [{ text: 'cloned' }]];
    await t.run(s.id, 'clone the other repo');
    await Bun.sleep(200);
    await svc.settled();
    expect(t.engine.requireSession(s.id).cwd).toBe(own);
    expect(events.some((e) => e.type === 'session.moved')).toBe(false);
  });
});
