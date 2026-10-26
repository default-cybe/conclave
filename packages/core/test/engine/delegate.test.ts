/**
 * Delegate (engine/delegate.ts, tools/delegate.ts): a chat hands a job to a
 * Code or Assistant session on one of the owner's devices and answers with
 * what comes back, on the real engine with the scripted model.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, toolResults, until, type Block, type RequestBody, type TestEngine } from './harness';
import { HomeMachine } from '../projects/machines';
import { cleanup, tempDir } from '../extensions/_helpers';
import { delegateCatalog, delegateMode, findDevice, runDelegate } from '../../src/engine/delegate';
import { delegateTitle } from '../../src/tools/delegate';
import { projectsOf } from '../../src/projects/attached';
import type { Device, Session, ToolResultBlock } from '../../src/types';

let t: TestEngine | undefined;
const homes: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  cleanup(...homes.splice(0));
});

const BRIEF = 'CHILD-BRIEF: list every person named in the PDFs in this folder.';
const isChild = (body: RequestBody) => firstUserText(body).includes('CHILD-BRIEF');
const toolNames = (body: string) => ((JSON.parse(body) as { tools?: Array<{ name: string }> }).tools ?? []).map((x) => x.name);

/** A device called "MadX Arch" over a temp home with a capstone folder, connected unless `online` is false. */
function madx(t: TestEngine, online = true): HomeMachine {
  const home = tempDir('conclave-madx-');
  homes.push(home);
  mkdirSync(join(home, 'capstone'), { recursive: true });
  writeFileSync(join(home, 'capstone', 'notes.txt'), 'Ada Lovelace wrote the report.\n');
  const m = new HomeMachine('arch', 'MadX Arch', home);
  t.engine.repos.devices.insert({ id: m.id, name: m.name, tokenHash: 'test', roots: [] });
  if (online) {
    const row = t.engine.repos.devices.get(m.id)!;
    t.engine.devices.attach({ ...row, online: true, info: m.infoNow() } as Device, m);
  }
  return m;
}

function delegateCall(input: Record<string, unknown>): Block {
  return { tool: 'Delegate', input: { to: 'code', prompt: BRIEF, description: 'Find names in the capstone PDFs', ...input } };
}

function resultOf(t: TestEngine, sessionId: string): ToolResultBlock | undefined {
  for (const m of t.engine.getMessages(sessionId)) for (const b of m.content) if (b.type === 'tool_result') return b;
  return undefined;
}

describe('Delegate from a chat', () => {
  test('runs a code session on the named device and folder, read-only, and returns its answer', async () => {
    t = await startTestEngine({
      script: [[delegateCall({ device: 'madx-arch', folder: '~/capstone' })], [{ text: 'The PDFs name Ada Lovelace.' }]],
      route: (body) => (isChild(body) ? [{ text: 'NAMES: Ada Lovelace (notes.txt)' }] : undefined),
    });
    const m = madx(t);
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'ask code for the names in the capstone pdfs on madx arch');

    // the chat was offered Delegate with the device by name
    const first = t.requests.find((r) => !isChild(JSON.parse(r)))!;
    expect(toolNames(first)).toContain('Delegate');
    expect(first).toContain('MadX Arch');

    const kids = t.engine.listSessions({ parentId: chat.id });
    expect(kids).toHaveLength(1);
    const child = kids[0];
    expect(child.parentId).toBe(chat.id);
    expect(child.device).toBe('arch');
    expect(child.cwd).toBe(join(m.home, 'capstone'));
    expect(child.agent).toBe('explore');
    // the chat's own mode, not plan: read-only is the tools
    expect(child.permissionMode).toBe('default');
    expect(child.title).toBe('Find names in the capstone PDFs');
    expect(child.kind).toBeUndefined();
    expect(child.tags).toContain('delegated');
    const place = child.meta?.delegate as Record<string, unknown>;
    expect(place).toMatchObject({ to: 'code', device: 'arch', deviceName: 'MadX Arch', readOnly: true, permissionMode: 'default' });

    // the brief went over whole, with the read-only note
    const childReq = t.requests.find((r) => isChild(JSON.parse(r)))!;
    expect(childReq).toContain('This job is read-only');
    // explore keeps its reads and its shell
    expect(toolNames(childReq)).toEqual(expect.arrayContaining(['Read', 'Grep', 'Bash']));

    const res = resultOf(t, chat.id)!;
    expect(res.isError).toBeFalsy();
    expect(String(res.content)).toContain('NAMES: Ada Lovelace');
    expect(String(res.content)).toContain('on MadX Arch');
    expect(res.meta?.sessionId).toBe(child.id);
    expect((res.meta?.delegate as { deviceName: string }).deviceName).toBe('MadX Arch');
    expect(place.toolUseId).toBe(res.toolUseId);
    // the chat reported back
    const last = t.engine.getMessages(chat.id).filter((x) => x.role === 'assistant').pop()!;
    expect(JSON.stringify(last.content)).toContain('Ada Lovelace');
  });

  test('a read-only job keeps a bypass caller\'s mode but gets no file-editing tools, even with coder', async () => {
    t = await startTestEngine({
      script: [[delegateCall({ agent: 'coder' })], [{ text: 'done' }]],
      route: (body) => (isChild(body) ? [{ text: 'looked' }] : undefined),
    });
    const chat = await t.engine.createSession({ kind: 'chat' });
    t.engine.updateSession(chat.id, { permissionMode: 'bypass' });
    await t.run(chat.id, 'look at it');
    const child = t.engine.listSessions({ parentId: chat.id })[0];
    expect(child.agent).toBe('coder');
    expect(child.permissionMode).toBe('bypass');
    const names = toolNames(t.requests.find((r) => isChild(JSON.parse(r)))!);
    expect(names).toEqual(expect.arrayContaining(['Read', 'Grep', 'Bash']));
    for (const w of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(names).not.toContain(w);
  });

  test('with changes asked for, the coder runs in the caller\'s mode: bypass stays bypass', async () => {
    t = await startTestEngine({
      script: [[delegateCall({ readOnly: false, description: 'Fix the script' })], [{ text: 'done' }]],
      route: (body) => (isChild(body) ? [{ text: 'changed' }] : undefined),
    });
    const chat = await t.engine.createSession({ kind: 'chat' });
    t.engine.updateSession(chat.id, { permissionMode: 'bypass' });
    await t.run(chat.id, 'fix it');
    const child = t.engine.listSessions({ parentId: chat.id })[0];
    expect(child.agent).toBe('coder');
    expect(child.permissionMode).toBe('bypass');
    expect(toolNames(t.requests.find((r) => isChild(JSON.parse(r)))!)).toContain('Edit');
    // the hub is the default device
    expect(child.device).toBe('local');
  });

  test('a Code session in plan mode hands on changes in plan mode', async () => {
    t = await startTestEngine({
      script: [[delegateCall({ to: 'assistant', readOnly: false, description: 'Draft the mail' })], [{ text: 'done' }]],
      route: (body) => (isChild(body) ? [{ text: 'drafted' }] : undefined),
    });
    const code = await t.engine.createSession({ agent: 'coder', cwd: t.cwd, permissionMode: 'plan' });
    await t.run(code.id, 'ask the assistant to draft it');
    const child = t.engine.listSessions({ parentId: code.id })[0];
    expect(child.agent).toBe('assistant');
    expect(child.permissionMode).toBe('plan');
    expect((child.meta?.delegate as { to: string }).to).toBe('assistant');
  });

  test('the child gets the parent\'s mode; only a plan parent gives plan', () => {
    expect(delegateMode('plan')).toBe('plan');
    expect(delegateMode('default')).toBe('default');
    expect(delegateMode('acceptEdits')).toBe('acceptEdits');
    expect(delegateMode('bypass')).toBe('bypass');
    expect(delegateMode(undefined)).toBe('default');
  });

  test('an offline device gives a clear error and starts nothing', async () => {
    t = await startTestEngine({ script: [[delegateCall({ device: 'MadX Arch' })], [{ text: 'It is offline.' }]] });
    madx(t, false);
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'ask code');
    const res = toolResults(t.engine, chat.id).find((r) => r.name === 'Delegate')!;
    expect(res.isError).toBe(true);
    expect(res.content).toContain('MadX Arch is offline');
    expect(res.content).toContain('daemon');
    expect(t.engine.listSessions({ parentId: chat.id })).toHaveLength(0);
    // the description says so too
    expect(t.requests[0]).toContain('Offline now, so nothing runs there: MadX Arch.');
  });

  test('a model the caller names runs the job; with none the agent keeps its own model', async () => {
    t = await startTestEngine({
      models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
      script: [[delegateCall({ device: 'madx arch', model: 'mock/claude-opus-5-5' })], [{ text: 'done' }], [delegateCall({ device: 'madx arch' })], [{ text: 'done' }]],
      route: (body) => (isChild(body) ? [{ text: 'OK' }] : undefined),
    });
    madx(t);
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'ask code on opus');
    await t.run(chat.id, 'ask code again');
    const kids = t.engine.listSessions({ parentId: chat.id }).sort((a, b) => a.createdAt - b.createdAt);
    expect(kids).toHaveLength(2);
    expect(kids[0].model).toBe('mock/claude-opus-5-5');
    expect(kids[1].model).toBe(t.engine.config.get().defaultModel);
    expect(t.requests.some((r) => isChild(JSON.parse(r)) && JSON.parse(r).model === 'claude-opus-5-5')).toBe(true);
  });

  test('a named model that cannot run is refused, never swapped for another', async () => {
    t = await startTestEngine({ script: [[delegateCall({ device: 'madx arch', model: 'nope/not-a-model' })], [{ text: 'no' }]] });
    madx(t);
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'ask code on that model');
    const res = toolResults(t.engine, chat.id).find((r) => r.name === 'Delegate')!;
    expect(res.isError).toBe(true);
    expect(res.content).toContain('The model nope/not-a-model cannot run here: it is not set up on this hub.');
    // refused, so the words never claim it falls back
    expect(res.content).not.toContain('using the session model');
    expect(t.engine.listSessions({ parentId: chat.id })).toHaveLength(0);
  });

  test('a named model on a harness that is off says where to turn it on', async () => {
    t = await startTestEngine({ script: [[delegateCall({ device: 'madx arch', model: 'claude-code/opus' })], [{ text: 'no' }]] });
    t.engine.config.update({ providers: { 'claude-code': { type: 'acp', name: 'Claude Code', command: 'claude', enabled: false } } } as never);
    madx(t);
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'ask code on claude code');
    const res = toolResults(t.engine, chat.id).find((r) => r.name === 'Delegate')!;
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Claude Code is off as an engine. Turn it on in Settings, Providers');
    expect(t.engine.listSessions({ parentId: chat.id })).toHaveLength(0);
  });

  test('a named model the provider does not know fails the job, never moves to the parent model', async () => {
    t = await startTestEngine({
      models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
      script: [[delegateCall({ device: 'madx arch', model: 'mock/claude-opus-5-5' })], [{ text: 'it failed' }]],
      route: (body) => (isChild(body) ? { status: 404, type: 'not_found_error', error: 'model: claude-opus-5-5' } : undefined),
    });
    madx(t);
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'ask code on opus');
    const [kid] = t.engine.listSessions({ parentId: chat.id });
    expect(kid.model).toBe('mock/claude-opus-5-5');
    expect(t.requests.some((r) => isChild(JSON.parse(r)) && JSON.parse(r).model === 'claude-sonnet-5-5')).toBe(false);
    expect(toolResults(t.engine, chat.id).find((r) => r.name === 'Delegate')!.content).toContain('claude-opus-5-5');
  });

  test('a folder that is not there is refused before anything starts', async () => {
    t = await startTestEngine({ script: [[delegateCall({ device: 'madx arch', folder: '~/nope' })], [{ text: 'no' }]] });
    madx(t);
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'ask code');
    const res = toolResults(t.engine, chat.id).find((r) => r.name === 'Delegate')!;
    expect(res.isError).toBe(true);
    expect(res.content).toContain('There is no folder ~/nope on MadX Arch.');
    expect(t.engine.listSessions({ parentId: chat.id })).toHaveLength(0);
  });

  test('background returns at once and the answer reaches the chat later', async () => {
    t = await startTestEngine({
      script: [[delegateCall({ device: 'madx arch', background: true })], [{ text: 'Started; I will tell you.' }], [{ text: 'It found Ada Lovelace.' }]],
      route: (body) => (isChild(body) ? { blocks: [{ text: 'REPORT: Ada Lovelace' }], delayMs: 400 } : undefined),
    });
    madx(t);
    const chat = await t.engine.createSession({ kind: 'chat' });
    t.engine.runnerFor(chat.id).noteDelayMs = 50;
    await t.run(chat.id, 'ask code in the background');
    const parentRequests = () => t!.requests.filter((r) => !isChild(JSON.parse(r)));
    expect(parentRequests()).toHaveLength(2);
    expect(parentRequests()[1]).not.toContain('REPORT: Ada Lovelace');
    const res = resultOf(t, chat.id)!;
    expect(res.meta?.background).toBe(true);
    expect(String(res.content)).toContain('started in the background');

    expect(await until(() => parentRequests().length === 3, 10_000)).toBe(true);
    await t.engine.runnerFor(chat.id).waitIdle();
    expect(parentRequests()[2]).toContain('REPORT: Ada Lovelace');
    expect(parentRequests()[2]).toContain('<subagent_result session=');
    const child = t.engine.listSessions({ parentId: chat.id })[0];
    expect(child.parentId).toBe(chat.id);
    expect((child.meta?.background as { state: string }).state).toBe('completed');
  });
});

describe('who may delegate', () => {
  test('a subagent, a workflow step, an untrusted session and a member get no Delegate and are refused', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat' });
    const has = (s: Session, depth = 0) => engine.toolsFor(s, engine.agentFor(s), 'agent', depth).some((x) => x.name === 'Delegate');
    expect(has(chat)).toBe(true);
    const code = await engine.createSession({ agent: 'coder', cwd: t.cwd });
    expect(has(code)).toBe(true);
    const assistant = await engine.createSession({ agent: 'assistant', cwd: t.cwd });
    expect(has(assistant)).toBe(true);

    // a subagent: by depth, and by its mark after a restart resets the depth
    expect(has(code, 1)).toBe(false);
    const sub = await engine.createSession({ agent: 'coder', cwd: t.cwd, parentId: code.id });
    engine.patchMeta(sub.id, { subagent: true });
    expect(has(engine.getSession(sub.id)!)).toBe(false);
    const req = { to: 'code' as const, prompt: 'x', title: 'x', readOnly: true, background: false, toolUseId: 't1' };
    await expect(runDelegate(engine, code.id, { ...req, depth: 1 })).rejects.toThrow('not available in a subagent');
    await expect(runDelegate(engine, sub.id, { ...req, depth: 0 })).rejects.toThrow('not available in a subagent');

    const step = await engine.createSession({ agent: 'coder', cwd: t.cwd });
    engine.patchMeta(step.id, { workflow: { runId: 'wf_1' } });
    expect(has(engine.getSession(step.id)!)).toBe(false);

    const hooked = await engine.createSession({ agent: 'assistant', cwd: t.cwd });
    engine.patchMeta(hooked.id, { untrusted: true });
    expect(has(engine.getSession(hooked.id)!)).toBe(false);
    const email = await engine.createSession({ agent: 'email', cwd: t.cwd });
    expect(has(email)).toBe(false);

    const alice = engine.people.create({ name: 'alice' });
    const hers = await engine.createSession({ kind: 'chat' }, alice.id);
    expect(has(hers)).toBe(false);
    await expect(runDelegate(engine, hers.id, { ...req, depth: 0 })).rejects.toThrow("hub owner's");
  });
});

describe('device names and the list', () => {
  const devices: Device[] = [
    { id: 'local', name: 'conclave-hub', online: true, roots: [], createdAt: 0 },
    { id: 'arch', name: 'MadX Arch', online: true, roots: [], createdAt: 0 },
    { id: 'mac', name: 'MacBook Air', online: false, roots: [], createdAt: 0 },
    { id: 'mac2', name: 'MacBook Pro', online: true, roots: [], createdAt: 0 },
  ];
  const name = (r: ReturnType<typeof findDevice>) => ('error' in r ? r.error : r.name);

  test('resolve loosely: case, spaces and dashes do not count; the hub is the default', () => {
    expect(name(findDevice(devices, undefined))).toBe('conclave-hub');
    expect(name(findDevice(devices, 'hub'))).toBe('conclave-hub');
    expect(name(findDevice(devices, 'madx arch'))).toBe('MadX Arch');
    expect(name(findDevice(devices, 'MADX-ARCH'))).toBe('MadX Arch');
    expect(name(findDevice(devices, 'madxarch'))).toBe('MadX Arch');
    expect(name(findDevice(devices, 'madx'))).toBe('MadX Arch');
    expect(name(findDevice(devices, 'macbook'))).toContain('could be MacBook Air or MacBook Pro');
    expect(name(findDevice(devices, 'pve'))).toContain('There is no device called "pve". The devices are: conclave-hub (the hub), MadX Arch, MacBook Air (offline), MacBook Pro.');
  });

  test("the description lists online devices with their known project folders, and the offline ones", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const m = madx(t);
    const store = projectsOf(t.engine)!.store;
    const p = store.create('capstone', { gitRoots: [], remotes: [], shallow: false });
    store.saveLocation(p.id, { device: 'arch', path: join(m.home, 'capstone'), via: 'chosen' });
    t.engine.repos.devices.insert({ id: 'mac', name: 'MacBook Air', tokenHash: 'x', roots: [] });
    const chat = await t.engine.createSession({ kind: 'chat' });
    const text = delegateCatalog(t.engine, chat);
    expect(text).toContain('(the hub, the default)');
    expect(text).toContain('- MadX Arch: ~/capstone');
    expect(text).toContain('Offline now, so nothing runs there: MacBook Air.');
  });

  test('the title is the description, else the first line of the brief, cut at 60', () => {
    expect(delegateTitle({ description: ' Find names ', prompt: 'x' })).toBe('Find names');
    expect(delegateTitle({ prompt: '\nList the names in ~/capstone.\nReturn a list.' })).toBe('List the names in ~/capstone.');
    expect(delegateTitle({ prompt: 'a'.repeat(80) })).toHaveLength(60);
  });
});

