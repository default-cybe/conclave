/**
 * Imported sessions join the project of their folder: a Claude Code chat on
 * the Mac and a Conclave session on the pc, in clones of one repository,
 * land in one project. Real git repos on two devices over the local disk
 * (test/projects/machines.ts) and the scripted fake model.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import { projectsOf } from '../../src/projects/registry';
import type { ProjectsService } from '../../src/projects/service';
import type { ConvertedSession } from '../../src/importers/types';
import type { Session } from '../../src/types';
import { cloneRepo, detach, makeRepo, attach, twoDevices, type TwoDevices } from '../projects/machines';

let t: TestEngine | undefined;
let d: TwoDevices | undefined;

afterEach(async () => {
  await (t && projectsOf(t.engine))?.settled();
  await t?.close();
  d?.cleanup();
  t = undefined;
  d = undefined;
});

async function setup() {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  d = twoDevices(t.engine);
  return { t, d, projects: projectsOf(t.engine) as ProjectsService, imports: importOf(t.engine) as ImportService };
}

/** A Claude Code chat as the reader hands it over. */
function claudeChat(cwd: string, id: string, title = 'Group the list by project'): ConvertedSession {
  const at = Date.now() - 3_600_000;
  return {
    source: 'claude-code',
    nativeId: id,
    nativeIdUnique: false,
    title,
    cwd,
    kind: 'main',
    learnable: true,
    unknown: {},
    messages: [
      { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Group the session list by project.' }], createdAt: at, meta: { external: { source: 'claude-code', id: `${id}-1` } } },
      { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'Done. Each project is one group.' }], createdAt: at + 60_000, meta: { external: { source: 'claude-code', id: `${id}-2` } } },
    ],
  };
}

const found = (path: string) => ({ source: 'claude-code' as const, path, size: 100, mtime: Date.now() });

describe('imported sessions join the project of their folder', () => {
  test('a Claude Code chat on the Mac lands in the project of a pc session in a clone of the same repo', async () => {
    const { t, d, projects, imports } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'conclave');
    const macRepo = join(d.mac.home, 'Developer', 'conclave');
    makeRepo(pcRepo, 'git@github.com:kai/conclave.git');
    cloneRepo(pcRepo, macRepo, { remote: 'https://github.com/kai/conclave.git' });
    const own = await t.engine.createSession({ device: 'pc', cwd: pcRepo });
    await projects.recordState(own);
    const projectId = t.engine.requireSession(own.id).projectId;
    expect(projectId).toBeTruthy();

    const events: Session[] = [];
    const off = t.engine.bus.on((e) => {
      if (e.type === 'session.updated' && e.session.projectId) events.push(e.session);
    });
    const r = await imports.importConverted('mac', claudeChat(macRepo, 'cc-1'), found(join(d.mac.home, '.claude', 'projects', 'x', 'cc-1.jsonl')), 'b1');
    off();
    expect(r.state).toBe('imported');
    const imported = t.engine.requireSession(r.sessionId!);
    expect(imported.device).toBe('mac');
    expect(imported.projectId).toBe(projectId);
    // the lists hear about it without a reload
    expect(events.some((s) => s.id === imported.id && s.projectId === projectId)).toBe(true);
    // the project now knows where it lives on the Mac
    expect(projects.store.locations(projectId!).map((l) => l.device).sort()).toEqual(['mac', 'pc']);
  });

  test('a folder from another repository gets its own project, a plain folder none', async () => {
    const { t, d, projects, imports } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'conclave');
    const other = join(d.mac.home, 'code', 'portfolio');
    const plain = join(d.mac.home, 'notes');
    makeRepo(pcRepo, 'git@github.com:kai/conclave.git');
    makeRepo(other, 'git@github.com:kai/portfolio.git');
    Bun.spawnSync(['mkdir', '-p', plain]);
    const own = await t.engine.createSession({ device: 'pc', cwd: pcRepo });
    await projects.recordState(own);
    const conclave = t.engine.requireSession(own.id).projectId!;

    const a = await imports.importConverted('mac', claudeChat(other, 'cc-2', 'Contact form'), found(join(d.mac.home, '.claude', 'a.jsonl')), 'b1');
    const b = await imports.importConverted('mac', claudeChat(plain, 'cc-3', 'Notes'), found(join(d.mac.home, '.claude', 'b.jsonl')), 'b1');
    const pa = t.engine.requireSession(a.sessionId!).projectId;
    expect(pa).toBeTruthy();
    expect(pa).not.toBe(conclave);
    expect(projects.store.get(pa!)?.name).toBe('portfolio');
    expect(t.engine.requireSession(b.sessionId!).projectId).toBeUndefined();
  });

  test('imported while the Mac was offline: the project is found when it connects', async () => {
    const { t, d, projects, imports } = await setup();
    const pcRepo = join(d.pc.home, 'code', 'conclave');
    const macRepo = join(d.mac.home, 'Developer', 'conclave');
    makeRepo(pcRepo, 'git@github.com:kai/conclave.git');
    cloneRepo(pcRepo, macRepo, { remote: 'git@github.com:kai/conclave.git' });
    const own = await t.engine.createSession({ device: 'pc', cwd: pcRepo });
    await projects.recordState(own);
    const projectId = t.engine.requireSession(own.id).projectId;

    detach(t.engine, 'mac');
    const r = await imports.importConverted('mac', claudeChat(macRepo, 'cc-4'), found(join(d.mac.home, '.claude', 'c.jsonl')), 'b1');
    expect(t.engine.requireSession(r.sessionId!).projectId).toBeUndefined();

    attach(t.engine, d.mac);
    // the import service listens for the device; wait for its pass
    for (let i = 0; i < 50 && !t.engine.requireSession(r.sessionId!).projectId; i++) await Bun.sleep(20);
    expect(t.engine.requireSession(r.sessionId!).projectId).toBe(projectId);
    // a second pass has nothing left to do
    expect(await imports.attachProjects('mac')).toBe(0);
  });

  test('chats from claude.ai stay out of projects', async () => {
    const { t, imports } = await setup();
    const conv: ConvertedSession = { ...claudeChat('/home/kai', 'ai-1', 'Plan a trip'), source: 'claude-ai', cwd: undefined };
    const r = await imports.importConverted('upload:abc', conv, { source: 'claude-ai', path: 'conversations.json#ai-1', size: 10, mtime: Date.now() }, 'b1');
    const s = t.engine.requireSession(r.sessionId!);
    expect(s.kind).toBe('chat');
    expect(s.projectId).toBeUndefined();
  });
});
