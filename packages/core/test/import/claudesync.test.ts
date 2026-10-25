/**
 * Claude Code chats that a sync tool (claudesync) copied between a Mac and a
 * PC, imported from both: one session per chat id, never ambiguous; copies
 * that split are synced into the copy each file continues; the folder is one
 * checked on the device; imported chats go on with the owner's model; and the
 * merge that leaves one visible session per chat, with every copy that has
 * messages of its own as a branch of it.
 *
 *   bun test packages/core/test/import/claudesync.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import { importedIds } from '../../src/import/ledger';
import { fingerprintOf } from '../../src/import/sources';
import { claudeCwdCandidates, claudeDeviceCwd, convertClaudeCode } from '../../src/importers/claude-code';
import { sessionStats } from '../../src/importers/types';
import { LocalMachine } from '../../src/machine/local';
import { newId } from '../../src/util/ids';
import type { Session } from '../../src/types';

/** A device whose ~ is its own folder. */
class HomeMachine extends LocalMachine {
  constructor(
    readonly home: string,
    id: string,
  ) {
    super({ id, name: id });
  }
  override resolve(path: string, cwd: string): string {
    const p = path === '~' ? this.home : path.startsWith('~/') ? `${this.home}/${path.slice(2)}` : path;
    return super.resolve(p, cwd === '~' ? this.home : cwd);
  }
}

const ID_A = 'a1a1a1a1-0000-4000-8000-00000000000a';
/** Chat A resumed in Claude Code under a new id: the same first messages, then its own. */
const ID_B = 'b2b2b2b2-0000-4000-8000-00000000000b';
const ID_C = 'c3c3c3c3-0000-4000-8000-00000000000c';
/** One chat in two Mac folders that split after 3 turns (the CVE chat). */
const ID_D = 'd4d4d4d4-0000-4000-8000-00000000000d';
/** A chat the owner went on with in Conclave, then forked twice by older syncs (the Research chat). */
const ID_E = 'e5e5e5e5-0000-4000-8000-00000000000e';
const MAC_DIR = '-Users-default-MadX-CMU';
const BUG_DIR = '-Users-default-CMU-bug';
const ARCH_DIR = '-home-default-CMU';
const LINUX_CWD = '/home/default/CMU';

const u = (p: string, n: number) => `${p}${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ask = 'Look at the tokio scheduler for a use after free in the task harness, and write down every unsafe block you read with its file and line.';

/** Claude Code lines: n user/assistant pairs, uuids `${p}0001` and up, starting at pair `from`. */
function pairs(sid: string, cwd: string, p: string, from: number, n: number, words = 'Next'): string {
  const out: string[] = [];
  for (let i = from; i < from + n; i++) {
    const base = { isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.42', entrypoint: 'cli' };
    const at = (k: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, 2 * i + k)).toISOString();
    out.push(JSON.stringify({ ...base, type: 'user', parentUuid: i > 1 ? u(p, 2 * i - 2) : null, uuid: u(p, 2 * i - 1), timestamp: at(0), message: { role: 'user', content: i === 1 ? ask : `${words} step ${i}: keep reading the harness code and note what you find.` } }));
    out.push(JSON.stringify({ ...base, type: 'assistant', parentUuid: u(p, 2 * i - 1), uuid: u(p, 2 * i), timestamp: at(1), message: { id: `msg_${p}${i}`, role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: `Read step ${i}.` }], stop_reason: 'end_turn' } }));
  }
  return out.join('\n') + '\n';
}

/** Pairs of prefix `p` from pair `from` that go on after pair from-1 of prefix `after`. */
function then(sid: string, cwd: string, after: string, p: string, from: number, n: number, words: string): string {
  return pairs(sid, cwd, p, from, n, words).replace(`"parentUuid":"${u(p, 2 * from - 2)}"`, `"parentUuid":"${u(after, 2 * from - 2)}"`);
}

/** Chat B: chat A's first 2 pairs (same uuids), then 2 pairs of its own. */
function resumed(sid: string, cwd: string): string {
  return pairs(sid, cwd, 'a', 1, 2) + then(sid, cwd, 'a', 'b', 3, 2, 'Resumed');
}

let t: TestEngine;
let svc: ImportService;
let mac: string;
let arch: string;

function put(home: string, dir: string, id: string, text: string): string {
  mkdirSync(join(home, '.claude/projects', dir), { recursive: true });
  const p = join(home, '.claude/projects', dir, `${id}.jsonl`);
  writeFileSync(p, text);
  return p;
}

function device(id: string, home: string) {
  if (!t.engine.repos.devices.get(id)) t.engine.repos.devices.insert({ id, name: id, tokenHash: 'x' });
  t.engine.devices.attach({ id, name: id, online: true, roots: [], createdAt: Date.now() }, new HomeMachine(home, id));
}

/** Import every file of these chats on a device (a chat id can be in two folders). */
async function importAll(dev: string, ids: string[], files = ids.length) {
  const page = await svc.scan({ device: dev, refresh: true });
  const keys = page.items.filter((x) => ids.includes(x.id)).map((x) => x.key);
  expect(keys).toHaveLength(files);
  const b = await svc.startBatch({ device: dev, keys, mode: 'chats', includeSkipped: true });
  await svc.runBatch(b.id);
  return svc.batch(b.id);
}

const sessionOf = (dev: string, path: string) => svc.store.ledgerAt('claude-code', dev, path)?.sessionId;
const all = () => t.engine.repos.sessions.list({ archived: true } as never) as Session[];
const imported = () => all().filter((s) => s.tags.includes('imported'));
const get = (id: string) => t.engine.repos.sessions.get(id)!;
const ids = (id: string) => importedIds(t.engine.repos.messages.list(id));
const text = (id: string) => JSON.stringify(t.engine.repos.messages.list(id));

function conclaveTurn(sid: string, prompt: string) {
  const seq = t.engine.repos.messages.nextSeq(sid);
  t.engine.repos.messages.insert({ id: newId('msg'), sessionId: sid, seq, role: 'user', kind: 'normal', content: [{ type: 'text', text: prompt }], createdAt: Date.now() });
  t.engine.repos.messages.insert({ id: newId('msg'), sessionId: sid, seq: seq + 1, role: 'assistant', kind: 'normal', content: [{ type: 'text', text: `Answer to ${prompt}` }], model: 'anthropic/claude-opus-5-5', createdAt: Date.now() });
}

beforeAll(async () => {
  mac = mkdtempSync(join(tmpdir(), 'conclave-mac-'));
  arch = mkdtempSync(join(tmpdir(), 'conclave-arch-'));
  // the Mac has the chat's folder under its own home
  mkdirSync(join(mac, 'CMU'), { recursive: true });
  t = await startTestEngine({ script: [[{ text: 'ok' }]], overrides: { memory: { enabled: false }, limits: { maxRetries: 0 } } as never });
  svc = importOf(t.engine)!;
  device('mac', mac);
  device('arch', arch);
});

afterAll(async () => {
  await t.close();
  rmSync(mac, { recursive: true, force: true });
  rmSync(arch, { recursive: true, force: true });
});

describe('the folder on the device that holds the file', () => {
  test('candidates: a path that encodes to the project folder first, then the cwd and the same path under this home', () => {
    expect(claudeCwdCandidates(`/Users/default/.claude/projects/${MAC_DIR}/${ID_A}.jsonl`, LINUX_CWD, '/Users/default')).toEqual(['/Users/default/MadX/CMU', LINUX_CWD, '/Users/default/CMU']);
    expect(claudeCwdCandidates('/tmp/upload.jsonl', LINUX_CWD, undefined)).toEqual([LINUX_CWD]);
  });

  test('the Research chat: home-swapped /Users/u/CMU exists but the chat lives in /Users/u/MadX/CMU', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cvmac')); // no '-' so the folder name reads back
    try {
      mkdirSync(join(home, 'CMU'), { recursive: true });
      mkdirSync(join(home, 'MadX/CMU'), { recursive: true });
      const dir = join(home, 'MadX/CMU').replace(/[^a-zA-Z0-9]/g, '-');
      expect(await claudeDeviceCwd(new HomeMachine(home, 'mac'), `${home}/.claude/projects/${dir}/${ID_A}.jsonl`, LINUX_CWD)).toBe(join(home, 'MadX/CMU'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('only a folder that is there is used: -Users-default-CMU-bug never reads back as /Users/default/CMU/bug', async () => {
    const m = new HomeMachine(mac, 'mac');
    const file = `${mac}/.claude/projects/${BUG_DIR}/${ID_D}.jsonl`;
    expect(await claudeDeviceCwd(m, file, '/home/default/CMU-repos/Hunti/tokio')).toBeUndefined();
    mkdirSync(join(mac, 'CMU-repos/Hunti/tokio'), { recursive: true });
    expect(await claudeDeviceCwd(m, file, '/home/default/CMU-repos/Hunti/tokio')).toBe(join(mac, 'CMU-repos/Hunti/tokio'));
    expect(await claudeDeviceCwd(m, file, LINUX_CWD)).toBe(join(mac, 'CMU'));
  });

  test('a chat id goes in the fingerprint of a main file, not of a subagent transcript', () => {
    const a = convertClaudeCode(pairs(ID_A, LINUX_CWD, 'a', 1, 2));
    const b = convertClaudeCode(resumed(ID_B, LINUX_CWD));
    expect(a.nativeIdUnique).toBe(true);
    expect(fingerprintOf(a, sessionStats(a.messages).firstIds)).not.toBe(fingerprintOf(b, sessionStats(b.messages).firstIds));
    expect(convertClaudeCode(pairs(ID_A, '/x', 'a', 1, 1), { subagent: true, parent: ID_A }).nativeIdUnique).toBe(false);
  });
});

describe('one chat on two devices', () => {
  let macA: string;
  let macB: string;

  test('a chat and its resumed copy on the Mac are two sessions in the Mac folder, with the owner model', async () => {
    macA = put(mac, MAC_DIR, ID_A, pairs(ID_A, LINUX_CWD, 'a', 1, 3));
    macB = put(mac, MAC_DIR, ID_B, resumed(ID_B, LINUX_CWD));
    const b = await importAll('mac', [ID_A, ID_B]);
    expect(b.failed).toBe(0);
    const sa = get(sessionOf('mac', macA)!);
    const sb = get(sessionOf('mac', macB)!);
    expect(sa.id).not.toBe(sb.id);
    expect(sb.parentId).toBeUndefined();
    expect(sa.cwd).toBe(join(mac, 'CMU'));
    // Claude Code is off as an engine: the chat goes on with the owner's model, the resume id is kept
    expect(sa.model).toBe(t.engine.config.get().defaultModel);
    expect(t.engine.harnessOff(sa.model)).toBeUndefined();
    expect(sa.external?.['claude-code']).toBe(ID_A);
  });

  test("the PC's copies join their own sessions: no ambiguous row, no new session", async () => {
    const before = imported().length;
    const archA = put(arch, ARCH_DIR, ID_A, pairs(ID_A, LINUX_CWD, 'a', 1, 3));
    const archB = put(arch, ARCH_DIR, ID_B, resumed(ID_B, LINUX_CWD));
    const b = await importAll('arch', [ID_A, ID_B]);
    expect(b.failed).toBe(0);
    expect(imported().length).toBe(before);
    expect(sessionOf('arch', archA)).toBe(sessionOf('mac', macA));
    expect(sessionOf('arch', archB)).toBe(sessionOf('mac', macB));
    expect(svc.store.ledgerForDevice('arch').some((l) => l.status === 'ambiguous')).toBe(false);
  });

  test('a row an older import left ambiguous, with ledger rows of the older fingerprint, is matched again', async () => {
    const archC = put(arch, ARCH_DIR, ID_C, pairs(ID_C, LINUX_CWD, 'c', 1, 2));
    const macC = put(mac, MAC_DIR, ID_C, pairs(ID_C, LINUX_CWD, 'c', 1, 2));
    await importAll('mac', [ID_C]);
    const sid = sessionOf('mac', macC)!;
    // what an older release stored: the fingerprint without the chat id, and the PC row marked ambiguous
    const conv = convertClaudeCode(pairs(ID_C, LINUX_CWD, 'c', 1, 2));
    const legacy = fingerprintOf({ ...conv, nativeIdUnique: false }, sessionStats(conv.messages).firstIds);
    const row = svc.store.ledgerAt('claude-code', 'mac', macC)!;
    svc.store.putLedger({ ...row, fingerprint: legacy });
    svc.store.putLedger({ ...row, id: newId('isrc'), device: 'arch', path: archC, fingerprint: legacy, sessionId: undefined, status: 'ambiguous' });
    const b = await importAll('arch', [ID_C]);
    expect(b.failed).toBe(0);
    expect(sessionOf('arch', archC)).toBe(sid);
  });
});

describe('both sides grew', () => {
  test('the source ran on further: it syncs in, the Conclave turn moves to a branch, no "Continued in" session', async () => {
    const macA = svc.store.ledgerForDevice('mac').find((l) => l.nativeId === ID_A)!.path;
    const sid = sessionOf('mac', macA)!;
    const seq = t.engine.repos.messages.nextSeq(sid);
    t.engine.repos.messages.insert({ id: newId('msg'), sessionId: sid, seq, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Only in Conclave: summarize the findings.' }], createdAt: Date.now() });
    appendFileSync(macA, pairs(ID_A, LINUX_CWD, 'a', 4, 3, 'Only in Claude Code'));
    const before = imported().length;
    const r = await svc.syncSession(sid);
    expect(r).toMatchObject({ state: 'updated', added: 6 });
    expect(imported().filter((s) => s.title.startsWith('Continued in'))).toHaveLength(0);
    expect(imported().length).toBe(before + 1);
    expect(text(sid)).toContain('Only in Claude Code step 6');
    expect(text(sid)).not.toContain('Only in Conclave');
    const branch = all().find((s) => s.parentId === sid)!;
    expect(branch.title).toEndWith('(Conclave branch)');
    expect(text(branch.id)).toContain('Only in Conclave: summarize the findings.');
    // the next sync has nothing to add
    expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
  });
});

describe('copies that split', () => {
  let macD: string;
  let bugD: string;

  test('the PC copy of a chat in two split Mac folders syncs into the copy it continues, not "ambiguous"', async () => {
    macD = put(mac, MAC_DIR, ID_D, pairs(ID_D, LINUX_CWD, 'd', 1, 3) + then(ID_D, LINUX_CWD, 'd', 'e', 4, 3, 'Mac'));
    bugD = put(mac, BUG_DIR, ID_D, pairs(ID_D, LINUX_CWD, 'd', 1, 3) + then(ID_D, LINUX_CWD, 'd', 'f', 4, 2, 'yoo im back from mac now'));
    expect((await importAll('mac', [ID_D], 2)).failed).toBe(0);
    expect(sessionOf('mac', macD)).not.toBe(sessionOf('mac', bugD));
    const before = imported().length;
    const archD = put(arch, ARCH_DIR, ID_D, pairs(ID_D, LINUX_CWD, 'd', 1, 3) + then(ID_D, LINUX_CWD, 'd', 'f', 4, 2, 'yoo im back from mac now'));
    const b = await importAll('arch', [ID_D]);
    expect(b.failed).toBe(0);
    expect(sessionOf('arch', archD)).toBe(sessionOf('mac', bugD));
    expect(imported().length).toBe(before);
  });
});

describe('merge: one visible session per chat, nothing with messages of its own hidden', () => {
  let e1: string;
  let e2: string;
  let e3: string;

  test('older syncs left three copies of a chat the owner went on with in Conclave', async () => {
    const macE = put(mac, MAC_DIR, ID_E, pairs(ID_E, LINUX_CWD, 'g', 1, 3));
    await importAll('mac', [ID_E]);
    e1 = sessionOf('mac', macE)!;
    // a slash command and the reminders a Conclave turn carries are not the branch's words
    conclaveTurn(e1, '/model');
    conclaveTurn(e1, 'so whats next? summarize the findings<system-reminder>Relevant memories</system-reminder>');
    conclaveTurn(e1, 'and the second unsafe block');
    // the PC copy ran one turn on: an older sync forked it
    put(arch, ARCH_DIR, ID_E, pairs(ID_E, LINUX_CWD, 'g', 1, 4));
    await importAll('arch', [ID_E]);
    e2 = svc.store.ledgerForDevice('arch').find((l) => l.nativeId === ID_E)!.sessionId!;
    // the Mac copy ran two turns on: forked again
    appendFileSync(macE, pairs(ID_E, LINUX_CWD, 'g', 4, 2));
    await svc.syncSession(e1);
    e3 = sessionOf('mac', macE)!;
    expect(new Set([e1, e2, e3]).size).toBe(3);
    expect(ids(e3)).toHaveLength(10);
  });

  test('the longest copy leads; copies with their own messages are named branches; a subset copy is archived', () => {
    const d1 = sessionOf('mac', svc.store.ledgerForDevice('mac').find((l) => l.nativeId === ID_D && l.path.includes(MAC_DIR))!.path)!;
    const d2 = sessionOf('mac', svc.store.ledgerForDevice('mac').find((l) => l.nativeId === ID_D && l.path.includes(BUG_DIR))!.path)!;
    const title = get(e1).title;
    const dry = svc.mergeDuplicates();
    const byChat = (r: typeof dry) => Object.fromEntries(r.groups.map((g) => [g.nativeId, g]));
    expect(byChat(dry)[ID_E]).toEqual({ nativeId: ID_E, keep: e3, title, branches: [{ id: e1, title: 'Branch from mac: so whats next? summarize the findings' }], archived: [e2], ledgerRows: 1 });
    expect(byChat(dry)[ID_D]).toEqual({ nativeId: ID_D, keep: d1, title: get(d1).title, branches: [{ id: d2, title: 'Branch from mac: yoo im back from mac now' }], archived: [], ledgerRows: 0 });
    expect(get(e2).meta?.import).not.toHaveProperty('duplicateOf');

    svc.mergeDuplicates({ apply: true });
    expect(get(e3)).toMatchObject({ title });
    expect(get(e3).parentId).toBeUndefined();
    // the Conclave turn stays visible, a branch of the main session
    expect(get(e1)).toMatchObject({ parentId: e3, meta: { branchOf: e3 } });
    expect(text(e1)).toContain('so whats next? summarize the findings');
    expect(text(e1)).toContain('and the second unsafe block');
    // the split copy keeps its own messages, and its file stays on it
    expect(get(d2)).toMatchObject({ parentId: d1, meta: { branchOf: d1 } });
    expect(text(d2)).toContain('yoo im back from mac now step 5');
    expect(sessionOf('mac', bugPath())).toBe(d2);
    // the subset copy: archived, its every message in the main one, its file moved there
    expect((get(e2).meta?.import as { duplicateOf?: string }).duplicateOf).toBe(e3);
    expect(ids(e2).every((id) => ids(e3).includes(id))).toBe(true);
    expect(svc.store.ledgerForDevice('arch').find((l) => l.nativeId === ID_E)!.sessionId).toBe(e3);
  });

  test('merge, sync, merge, sync, merge: no new session, nothing to merge again', async () => {
    const before = imported().length;
    for (let pass = 0; pass < 2; pass++) {
      expect((await importAll('mac', [ID_A, ID_B, ID_C, ID_D, ID_E], 6)).failed).toBe(0);
      expect((await importAll('arch', [ID_A, ID_B, ID_C, ID_D, ID_E])).failed).toBe(0);
      for (const s of imported()) if (svc.store.ledgerBySession(s.id).length) await svc.syncSession(s.id);
      expect(imported().length).toBe(before);
      expect(svc.mergeDuplicates({ apply: true }).groups).toEqual([]);
    }
  });
});

const bugPath = () => svc.store.ledgerForDevice('mac').find((l) => l.nativeId === ID_D && l.path.includes(BUG_DIR))!.path;

describe('continue an imported chat', () => {
  test('on a harness that is off: the turn runs on the default model with a notice, in the folder mapped on the device', async () => {
    const s = imported().find((x) => x.external?.['claude-code'] === ID_A)!;
    // what older imports left: Claude Code as the model, the PC path as the folder
    t.engine.repos.sessions.update({ ...s, model: 'claude-code/default', cwd: LINUX_CWD });
    await t.run(s.id, 'go on');
    const after = get(s.id);
    expect(after.model).toBe(t.engine.config.get().defaultModel);
    expect(after.cwd).toBe(join(mac, 'CMU'));
    const msgs = t.engine.repos.messages.list(s.id);
    const notices = msgs.filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content)).join('\n');
    expect(notices).toContain('is off as an engine, so this session goes on with');
    expect(notices).toContain(`${LINUX_CWD} is not on mac, so this session works in ${join(mac, 'CMU')} there now.`);
    expect(JSON.stringify(msgs[msgs.length - 1].content)).toContain('ok');
  });

  test('a folder found nowhere on the device: asks which device or folder, no model call', async () => {
    const s = imported().find((x) => x.external?.['claude-code'] === ID_B)!;
    t.engine.repos.sessions.update({ ...s, cwd: '/home/default/Gone' });
    const calls = t.requests.length;
    await t.run(s.id, 'go on');
    const notices = t.engine.repos.messages.list(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content)).join('\n');
    expect(notices).toContain('/home/default/Gone is not on mac. Which device has this folder?');
    expect(t.requests.length).toBe(calls);
    expect(get(s.id).cwd).toBe('/home/default/Gone');
  });
});
