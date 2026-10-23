/**
 * The daily digest (memory/digest.ts, docs/MEMORY.md): a fresh hub has it
 * off; the switch installs, retimes and disables its routine; one run imports
 * the day's chats from an online fake device through the import service and
 * names the offline one, catches up extraction and summaries, and writes one
 * note to a fake connection, which a second run rewrites; the routine runs
 * in code and a failure is an error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type RequestBody, type TestEngine } from '../engine/harness';
import { tempDir } from '../extensions/_helpers';
import { LocalMachine } from '../../src/machine/local';
import { DailyDigest, digestOf, parseNote, renderDailyNote, summaryOf, timeOf } from '../../src/memory/digest';
import type { ExternalNote } from '../../src/memory/external';
import type { SqliteMemory } from '../../src/memory/store';
import { ROUTINE_TEMPLATES } from '../../src/scheduler/templates';
import { ROUTINE_SUGGESTIONS } from '../../src/scheduler/suggestions';
import { RoutineSuggestions } from '../../src/scheduler/suggest';
import type { Routine } from '../../src/types';

/** A paired machine whose home is a folder of fixtures. */
class DeviceAt extends LocalMachine {
  constructor(
    id: string,
    name: string,
    private home: string,
  ) {
    super({ id, name });
  }
  override resolve(path: string, cwd: string): string {
    if (path === '~') return this.home;
    if (path.startsWith('~/')) return join(this.home, path.slice(2));
    return super.resolve(path, cwd);
  }
  override async info() {
    return { ...(await super.info()), home: this.home };
  }
}

const SID = '9a1b2c3d-1111-4222-8333-444455556666';
const CWD = '/home/kai/code/homelab';
const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const DATE = new Date(dayStart).toISOString().slice(0, 10);
/** 02:30 UTC the next night: the digest covers today. */
const NIGHT = dayStart + 26.5 * 3_600_000;

/** One Claude Code chat from today, long enough to import. */
function todaysChat(): string {
  const base = Math.max(dayStart + 60_000, Date.now() - 30 * 60_000);
  const at = (min: number) => new Date(base + min * 1000).toISOString();
  const common = { isSidechain: false, userType: 'external', cwd: CWD, sessionId: SID, version: '2.1.42', gitBranch: 'main', entrypoint: 'cli' };
  const user = (uuid: string, parent: string | null, t: string, text: string) => ({ ...common, parentUuid: parent, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: t });
  const asst = (uuid: string, parent: string, t: string, id: string, text: string) => ({ ...common, parentUuid: parent, type: 'assistant', requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }, uuid, timestamp: t });
  const u = (n: number) => `d${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return (
    [
      user(u(1), null, at(0), 'Write a restore test for the PBS backups on pve. Restore the newest snapshot into a throwaway LXC with id 999, start it, check that the service answers, then destroy it again.'),
      asst(u(2), u(1), at(1), 'msg_1', 'Done: scripts/restore-test.sh restores into LXC 999 and destroys it afterwards.'),
      user(u(3), u(2), at(2), 'Good. Keep 7 daily snapshots, because the PBS disk is small. And run the restore test every Sunday from cron on pve, not on madx.'),
      asst(u(4), u(3), at(3), 'msg_2', 'Set retention to 7 daily and added the Sunday cron entry on pve.'),
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
}

let t: TestEngine;
let home: string;
const calls = { learn: 0, extract: 0, episode: 0, note: 0 };
let noteFails = false;
let notePrompt = '';

function chore(body: RequestBody): Array<{ text: string }> | number | undefined {
  const sys = JSON.stringify(body.system ?? '');
  if (sys.includes('You turn one past session into memory')) {
    calls.learn++;
    return [{ text: JSON.stringify({ episode: 'Wrote a PBS restore test on pve and set retention to 7 daily snapshots.', items: [] }) }];
  }
  if (sys.includes('You maintain long-term memory')) {
    calls.extract++;
    return [{ text: JSON.stringify({ add: [{ content: 'The user keeps the Grafana dashboards for madx in the homelab repo.', kind: 'fact', scope: 'global', tags: ['grafana'] }], update: [] }) }];
  }
  if (sys.includes('Summarize this assistant session')) {
    calls.episode++;
    return [{ text: 'Set up Grafana dashboards for madx.\nThey live in the homelab repo.' }];
  }
  if (sys.includes('Daily digest. Write the owner')) {
    calls.note++;
    notePrompt = JSON.stringify(body.messages ?? []);
    if (noteFails) return 500;
    return [
      {
        text: JSON.stringify({
          worked: [
            { project: 'homelab', line: 'Wrote a restore test for the PBS backups on pve.' },
            { project: 'homelab', line: 'Set up Grafana dashboards for madx.' },
          ],
          decisions: [{ line: 'Keep 7 daily snapshots', why: 'because the PBS disk is small' }],
          learned: ['The restore test runs on pve every Sunday, not on madx.', 'The token is ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
          open: ['A restore test for the media LXC.'],
        }),
      },
    ];
  }
  return undefined;
}

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]], chore, overrides: { memory: { enabled: true, autoExtract: true, autoInject: false, injectLimit: 5 }, limits: { maxRetries: 0 } } as never });
  home = tempDir('conclave-digest-device-');
  mkdirSync(join(home, '.claude', 'projects', '-home-kai-code-homelab'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', '-home-kai-code-homelab', `${SID}.jsonl`), todaysChat());
  t.engine.repos.devices.insert({ id: 'arch', name: 'arch-desktop', tokenHash: 'x' });
  t.engine.repos.devices.insert({ id: 'mac', name: 'macbook', tokenHash: 'x' });
  t.engine.devices.attach(t.engine.repos.devices.get('arch')!, new DeviceAt('arch', 'arch-desktop', home));
});

afterAll(async () => {
  await t.close();
  rmSync(home, { recursive: true, force: true });
});

describe('the switch', () => {
  test('a fresh hub has the digest off and no routine for it', () => {
    const d = digestOf(t.engine)!;
    expect(d.settings()).toMatchObject({ enabled: false, time: '02:30', schedule: '30 2 * * *', writes: false });
    expect(d.settings().routineId).toBeUndefined();
    expect(t.engine.routines.list().filter((r) => r.builtin)).toEqual([]);
  });

  test('on installs the routine, the time moves its schedule, off disables it', () => {
    const d = digestOf(t.engine)!;
    const on = d.set({ enabled: true });
    expect(on).toMatchObject({ enabled: true, time: '02:30' });
    const r = t.engine.routines.get(on.routineId!)!;
    expect(r).toMatchObject({ builtin: 'daily-digest', suggestion: 'daily-digest', schedule: '30 2 * * *', enabled: true, notify: 'on_error' });
    expect(d.set({ time: '01:45' })).toMatchObject({ time: '01:45', schedule: '45 1 * * *' });
    const off = d.set({ enabled: false });
    expect(off).toMatchObject({ enabled: false, routineId: r.id, time: '01:45' });
    expect(t.engine.routines.get(r.id)!.enabled).toBe(false);
    // on again reuses the same routine
    expect(d.set({ enabled: true }).routineId).toBe(r.id);
    d.set({ enabled: false });
    expect(() => d.set({ time: '25:00' })).toThrow(/HH:MM/);
    expect(() => d.set({ enabled: 'yes' })).toThrow(/true or false/);
  });
});

describe('one night', () => {
  test('imports from the online device, names the offline one, catches up memory and writes one note; a second run rewrites it', async () => {
    const { engine } = t;
    // a Conclave session from today that extraction never saw, one it already did, and a chat with memory off
    const fresh = await engine.createSession({ cwd: t.cwd, agent: 'coder', title: 'Grafana dashboards' });
    engine.repos.sessions.update({ ...engine.requireSession(fresh.id), cwd: CWD });
    engine.addMessage(fresh.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Set up Grafana dashboards for madx and keep them in the homelab repo.' }] });
    engine.addMessage(fresh.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'Added dashboards/madx.json to the homelab repo.' }] });
    const done = await engine.createSession({ cwd: t.cwd, title: 'Already done' });
    engine.addMessage(done.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'What is the uptime of pve?' }] });
    const last = engine.addMessage(done.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: '41 days.' }] });
    engine.repos.kv.set(`memory.extract.${done.id}`, last.seq);
    (engine.memory as SqliteMemory).saveLearnedEpisode({ content: 'Checked the uptime of pve.', scope: 'global', tags: ['episode'], sourceSessionId: done.id, meta: {} });
    const quiet = await engine.createSession({ kind: 'chat', chat: { memory: false }, title: 'Private' });
    engine.addMessage(quiet.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Something private about my health.' }] });
    await engine.memory.save({ content: 'madx runs Grafana on port 3000', tags: ['host:madx'] });

    const notes: ExternalNote[] = [];
    const digest = new DailyDigest(engine, { writer: { groupedTargets: () => ['bm'], writeGrouped: async (n) => void notes.push(n) }, now: () => NIGHT });
    const r = await digest.digest({ zone: 'UTC' });
    expect(r.date).toBe(DATE);
    expect(r.problems).toEqual([]);

    // a: the fake device's chat came in through the import service and was learned; the offline one is named
    const byId = Object.fromEntries(r.devices.map((d) => [d.id, d]));
    expect(byId.arch).toMatchObject({ state: 'imported', chats: 1, learned: 1 });
    expect(byId.mac).toMatchObject({ state: 'offline', name: 'macbook' });
    expect(calls.learn).toBe(1);
    const imported = engine.repos.sessions.list({ archived: true } as never).find((s) => s.tags.includes('imported'))!;
    expect(imported).toMatchObject({ device: 'arch', cwd: CWD });

    // b: extraction only where it never ran, a summary for each session of the day without one, nothing for the private chat
    expect(calls.extract).toBe(1);
    expect(r.extracted).toBe(1);
    expect(engine.repos.kv.get(`memory.extract.${quiet.id}`, -1)).toBe(-1);
    expect(r.summaries).toBe(1);
    expect(engine.memory.list({ kind: 'fact' }).map((m) => m.content)).toContain('The user keeps the Grafana dashboards for madx in the homelab repo.');

    // c: one note, short, grouped by project, linked, without the secret line
    expect(calls.note).toBe(1);
    expect(notes).toHaveLength(1);
    const n = notes[0];
    expect(n).toMatchObject({ title: DATE, folder: 'conclave/daily', grouped: true });
    const lines = n.content.split('\n');
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(n.content).toContain('## Worked on');
    expect(n.content).toContain('- [worked] [[homelab]] Wrote a restore test for the PBS backups on pve.');
    expect(n.content).toContain('- [decision] Keep 7 daily snapshots (why: the PBS disk is small)');
    expect(n.content).toContain('- [open] A restore test for the media LXC.');
    expect(n.content).not.toContain('ghp_');
    expect(n.content).toContain('- relates_to [[homelab]]');
    expect(n.content).toContain('- relates_to [[madx]]');
    // the small model saw the day: the imported chat's summary and the Conclave session, never the private chat
    expect(notePrompt).toContain('Wrote a PBS restore test on pve');
    expect(notePrompt).toContain('Grafana dashboards');
    expect(notePrompt).not.toContain('Something private');
    expect(summaryOf(r)).toStartWith('STATUS: ok');
    expect(summaryOf(r)).toContain('macbook offline, skipped');
    expect(summaryOf(r)).toContain(`Daily note conclave/daily/${DATE}.md`);

    // again the same night: nothing new to import or extract, the same note rewritten, never a second one
    const again = await digest.digest({ zone: 'UTC' });
    expect(again.devices.find((d) => d.id === 'arch')!.state).toBe('nothing');
    expect(calls.learn).toBe(1);
    expect(calls.extract).toBe(1);
    expect(notes.map((x) => `${x.folder}/${x.title}`)).toEqual([`conclave/daily/${DATE}`, `conclave/daily/${DATE}`]);
    expect(digest.settings().lastNote).toMatchObject({ date: DATE });
  });

  test('no connection: no note and no model call for it; a failed note is a problem', async () => {
    const before = calls.note;
    const none = await new DailyDigest(t.engine, { writer: { groupedTargets: () => [], writeGrouped: async () => {} }, now: () => NIGHT }).digest({ zone: 'UTC' });
    expect(none.note).toEqual({ skipped: 'no memory connection takes grouped notes' });
    expect(calls.note).toBe(before);
    noteFails = true;
    try {
      const failed = await new DailyDigest(t.engine, { writer: { groupedTargets: () => ['bm'], writeGrouped: async () => {} }, now: () => NIGHT }).digest({ zone: 'UTC' });
      expect(failed.problems.join(' ')).toContain('The daily note was not written');
      expect(summaryOf(failed)).toStartWith('STATUS: problem');
    } finally {
      noteFails = false;
    }
  });

  test('the routine runs in code, not as an agent session, and ends silent', async () => {
    const d = digestOf(t.engine)!;
    const id = d.set({ enabled: true }).routineId!;
    const sessionsBefore = t.engine.listSessions({}).length;
    const run = await t.engine.routines.runNow(id, 'manual');
    expect(run.status).toBe('ok');
    expect(run.sessionId ?? '').toBe('');
    expect(run.summary).toContain('STATUS: ok');
    expect(t.engine.listSessions({}).length).toBe(sessionsBefore);
    d.set({ enabled: false });
  });
});

describe('the note format', () => {
  test('parseNote cleans lines and drops secrets; renderDailyNote stays near 40 lines', () => {
    const many = { worked: Array.from({ length: 20 }, (_, i) => ({ project: i % 2 ? 'conclave' : 'homelab', line: `Item ${i}` })), decisions: [], learned: Array.from({ length: 20 }, (_, i) => `Fact ${i}`), open: [] };
    const parsed = parseNote(JSON.stringify(many))!;
    expect(parsed.worked).toHaveLength(12);
    expect(parsed.learned).toHaveLength(6);
    const { note, lines } = renderDailyNote('2026-10-17', parsed, { projects: [], hosts: [], goals: [] });
    expect(lines).toBeLessThanOrEqual(40);
    expect(note.content.indexOf('[[conclave]] Item 1')).toBeLessThan(note.content.indexOf('[[homelab]] Item 0'));
    expect(parseNote('not json')).toBeUndefined();
    expect(timeOf('30 2 * * *')).toBe('02:30');
    expect(timeOf('30 2 * * 1-5')).toBeUndefined();
  });
});

describe('templates and suggestions', () => {
  test('the digest is at 02:30, before the reflection (02:40) and the librarian (03:05)', () => {
    const at = (id: string) => ROUTINE_TEMPLATES.find((x) => x.id === id)!.schedule;
    expect([ROUTINE_SUGGESTIONS.find((s) => s.id === 'daily-digest')!.schedule, at('nightly-reflection'), at('nightly-librarian')]).toEqual(['30 2 * * *', '40 2 * * *', '5 3 * * *']);
  });

  test('daily-digest is recommended but off; session-harvester says it is replaced and keeps working', async () => {
    const dd = ROUTINE_SUGGESTIONS.find((s) => s.id === 'daily-digest')!;
    expect(dd).toMatchObject({ recommended: true, enabledByDefault: false, builtin: 'daily-digest', deviceRole: 'hub', notify: 'on_error' });
    const sh = ROUTINE_SUGGESTIONS.find((s) => s.id === 'session-harvester')!;
    expect(sh).toMatchObject({ replacedBy: 'daily-digest', recommended: false });
    const made: Routine[] = [];
    const svc = new RoutineSuggestions({
      routines: () => made,
      createRoutine: (input) => {
        const r = { ...input, id: `rt_${made.length}`, agent: input.agent ?? 'assistant', mode: 'agent', enabled: input.enabled ?? true, sessionPolicy: 'new', notify: 'on_error', createdAt: 0, updatedAt: 0 } as Routine;
        made.push(r);
        return r;
      },
      removeRoutine: () => {},
      agentExists: () => true,
      createAgent: async () => {},
      mcpServers: () => [],
      secrets: () => [],
      devices: () => [{ id: 'local', name: 'madx', online: true, roots: [], createdAt: 0 }],
    });
    const added = await svc.add('daily-digest');
    expect(added.routines[0]).toMatchObject({ builtin: 'daily-digest', enabled: false, suggestion: 'daily-digest', device: 'local' });
    // the note's connection is optional: the rest runs without it, and the app does not list it as missing
    expect(svc.list().suggestions.find((s) => s.id === 'daily-digest')!.missing.every((n) => n.optional)).toBe(true);
  });
});
