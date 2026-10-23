/**
 * The three path bugs of ROUND-IMPORT-PATHS-WORKFLOWS.md 2.1, on the real
 * engine with the scripted fake model (no paid calls):
 *
 * 1. a session on an offline paired device never runs its tools on the hub;
 *    the turn parks until the device is back;
 * 2. Bash, the read state and the notice follow a change of folder;
 * 3. a harness that cannot resume still gets the conversation as context.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, until, type Step, type TestEngine } from './harness';
import { FakeMachine } from '../machine/fake-machine';
import { isOfflineMachine } from '../../src/projects/offline';
import type { Device } from '../../src/types';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

let plan: Step[] = [];

async function setup(opts: Partial<Parameters<typeof startTestEngine>[0]> = {}) {
  plan = [];
  t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => plan.shift(), ...opts });
  return t;
}

function pair(t: TestEngine, m: FakeMachine): void {
  t.engine.repos.devices.insert({ id: m.id, name: m.name, tokenHash: 'test', roots: [] });
}

function connect(t: TestEngine, m: FakeMachine): void {
  const row = t.engine.repos.devices.get(m.id)!;
  const device: Device = { ...row, online: true, info: { hostname: m.name, platform: 'linux', arch: 'x64', home: '/home/me', shell: '/bin/sh', clis: {}, capabilities: [] } };
  t.engine.devices.attach(device, m);
}

describe('bug 1: an offline device does not fall back to the hub', () => {
  test('tools get a machine that refuses, and the turn parks until the device is back', async () => {
    const t = await setup();
    const mac = new FakeMachine('mac', 'macbook');
    pair(t, mac);
    const s = await t.engine.createSession({ device: 'mac', cwd: '/home/me' });
    const machine = t.engine.machineFor(s);
    expect(isOfflineMachine(machine)).toBe(true);
    expect(machine).not.toBe(t.engine.localMachine);
    await expect(machine.exec('echo hi', { cwd: '/' })).rejects.toThrow('macbook is offline');
    // the hub's own sessions still run on the hub
    const local = await t.engine.createSession({ cwd: t.cwd });
    expect(t.engine.machineFor(local)).toBe(t.engine.localMachine);

    const runner = t.engine.runnerFor(s.id);
    await runner.enqueue({ text: 'go' });
    expect(await until(() => t.engine.requireSession(s.id).status === 'waiting_input')).toBe(true);
    expect(t.requests).toHaveLength(0);
    const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    expect(notices.some((n) => n.includes('macbook is offline. Wait, or run on another device.'))).toBe(true);

    connect(t, mac);
    await Promise.race([runner.waitIdle(), Bun.sleep(10_000)]);
    expect(t.requests).toHaveLength(1);
    expect(t.engine.requireSession(s.id).status).toBe('idle');
  });

  test('stopping a parked turn ends it without a model call', async () => {
    const t = await setup();
    const mac = new FakeMachine('mac', 'macbook');
    pair(t, mac);
    const s = await t.engine.createSession({ device: 'mac', cwd: '/home/me' });
    const runner = t.engine.runnerFor(s.id);
    await runner.enqueue({ text: 'go' });
    expect(await until(() => t.engine.requireSession(s.id).status === 'waiting_input')).toBe(true);
    t.engine.abort(s.id);
    await Promise.race([runner.waitIdle(), Bun.sleep(5_000)]);
    expect(t.requests).toHaveLength(0);
    expect(t.engine.requireSession(s.id).status).not.toBe('running');
  });
});

describe('bug 2: a new folder resets the shell and the read state', () => {
  test('Bash starts in the new folder, an old read no longer allows an edit, and a notice says so', async () => {
    const t = await setup({ approve: 'allow' });
    const a = join(t.cwd, 'a');
    const b = join(t.cwd, 'b');
    mkdirSync(join(a, 'sub'), { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'f.txt'), 'hello\n');
    const s = await t.engine.createSession({ cwd: a, permissionMode: 'bypass' });

    plan = [[{ tool: 'Bash', input: { command: 'cd sub && pwd' } }], [{ tool: 'Read', input: { file_path: join(a, 'f.txt') } }], [{ text: 'done' }]];
    await t.run(s.id, 'look around');
    expect(toolResults(t.engine, s.id).find((r) => r.name === 'Bash')?.content).toContain(join(a, 'sub'));

    t.engine.updateSession(s.id, { cwd: b });
    const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    expect(notices.some((n) => n.includes(`Working folder is now ${b}`))).toBe(true);

    // a loose match (trailing space) needs a Read; an exact one would go through unread
    plan = [[{ tool: 'Bash', input: { command: 'pwd' } }], [{ tool: 'Edit', input: { file_path: join(a, 'f.txt'), old_string: 'hello ', new_string: 'bye' } }], [{ text: 'done' }]];
    await t.run(s.id, 'where now');
    const after = toolResults(t.engine, s.id);
    const pwd = after.filter((r) => r.name === 'Bash').at(-1)!;
    expect(pwd.content.trim().split('\n')[0]).toBe(b);
    const edit = after.find((r) => r.name === 'Edit')!;
    expect(edit.isError).toBe(true);
    expect(edit.content.toLowerCase()).toContain('read');
  });
});

describe('bug 3: a harness that cannot resume gets the conversation', () => {
  test('a failed resume on the same device still sends the earlier turns as context', async () => {
    const t = await setup();
    const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
    const cfg = t.engine.config.get();
    t.engine.config.update({ providers: { ...cfg.providers, fake: { type: 'acp', command: process.execPath, args: [AGENT], env: { FAKE_ACP_FAIL_LOAD: '1' } } } });
    const s = await t.engine.createSession({ cwd: t.cwd, model: 'fake/default' });
    await t.run(s.id, 'echo remember the word heliotrope');
    const first = t.engine.requireSession(s.id).external?.fake;
    expect(first).toBeTruthy();
    // a new harness process has no open sessions, so the next turn must load (and here fails to)
    await t.engine.acp?.shutdown();
    await t.run(s.id, 'echo what was the word');
    const text = JSON.stringify(t.engine.getMessages(s.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)?.content);
    expect(text).toContain('heliotrope');
    expect(t.engine.requireSession(s.id).external?.fake).not.toBe(first);
    const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    expect(notices.some((n) => n.includes('could not resume here, so the conversation so far was passed as context'))).toBe(true);
  });
});
