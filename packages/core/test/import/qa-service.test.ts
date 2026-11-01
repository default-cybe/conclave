/**
 * Adversarial QA of the import service on a real engine with a scripted
 * model (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.5 to 1.10): Codex's
 * own memory threads, learn only followed by an import, one Claude Code id in
 * two folders, a file that now holds another conversation, a device that
 * sends a malformed reply, undo after the owner kept going, and an episode
 * that runs on. Every test here failed before its fix.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestEngine, type RequestBody, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import type { ExternalSessionInfo, SessionImportInfo } from '../../src/client/import';
import type { ImportReadParams, ImportScanParams, ImportScanWire } from '../../src/import/types';
import type { ConvertedSession } from '../../src/importers/types';
import { LocalMachine } from '../../src/machine/local';
import type { SqliteMemory } from '../../src/memory/store';
import { newId } from '../../src/util/ids';
import { buildOwnerHome, claudeSessionB, OWNER, type OwnerHome } from '../importers/owner-home';

let t: TestEngine;
let svc: ImportService;
let h: OwnerHome;
let dev: string;
const saved: Record<string, string | undefined> = {};
const learnPrompts: string[] = [];

/** Every session gets an episode named after its title; the gemini chat gets one that runs on. */
function chore(body: RequestBody): Array<{ text: string }> | undefined {
  const s = JSON.stringify(body.system ?? '');
  const p = JSON.stringify(body.messages ?? []);
  if (s.includes('You turn one past session into memory')) {
    learnPrompts.push(p);
    const title = /title=\\"([^\\]*)\\"/.exec(p)?.[1] ?? 'a session';
    const episode = p.includes('hero image') ? `Worked on ${title}.\n${'and then more '.repeat(800)}` : `Worked on ${title}.`;
    return [{ text: JSON.stringify({ episode, items: [] }) }];
  }
  if (s.includes('You tidy a memory store')) return [{ text: '{"operations": []}' }];
  return undefined;
}

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

/** A v2 device with a bug (or worse): its importRead names another source and adds junk messages. */
class OddDevice extends HomeMachine {
  override async importRead(p: ImportReadParams): Promise<ConvertedSession> {
    const conv = await super.importRead(p);
    return { ...conv, source: 'codex', messages: [...conv.messages, { role: 'system', kind: 'normal', content: 'not a list', createdAt: 0 } as never, null as never, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'ok' }], createdAt: 'yesterday' } as never] };
  }
}

/** A v2 device whose scan sends rows of the wrong shape next to good ones. */
class OddScanner extends HomeMachine {
  override async importScan(p: ImportScanParams): Promise<ImportScanWire> {
    const res = await super.importScan(p);
    const bad = [
      { found: { source: 'claude-code', path: 42, size: 1, mtime: 1 }, info: { title: 7 } },
      { found: { source: 'nope', path: '/x.jsonl', size: 1, mtime: 1 }, info: { id: 'x', title: 'x', messages: 3 } },
      { found: { source: 'codex', path: '/y.jsonl', size: 1, mtime: 1 }, info: { id: 'y', title: 'y', cwd: 9, messages: 'many', humanPrompts: 3, fingerprint: 'f' } },
      null,
    ] as never[];
    return { ...res, rows: [...res.rows, ...bad] };
  }
}

const SECRET_ID = 'e1e2e3e4-0000-4000-8000-00000000abcd';
/** A chat whose first prompt (so its title) carries a token. */
function secretSession(): string {
  const base = { isSidechain: false, userType: 'external', cwd: '/home/kai/code/tunnel', sessionId: SECRET_ID, version: '2.1.42', gitBranch: 'main', entrypoint: 'cli' };
  const u = (n: number) => `e${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return (
    [
      { ...base, parentUuid: null, type: 'user', uuid: u(1), timestamp: '2026-03-10T10:00:00Z', message: { role: 'user', content: 'CLOUDFLARE_API_TOKEN=FakeTok3nForQaTests99 set up the tunnel on madx with cloudflared, not ngrok, and keep it in a systemd unit so it starts on boot.' } },
      { ...base, parentUuid: u(1), type: 'assistant', uuid: u(2), timestamp: '2026-03-10T10:01:00Z', message: { id: 'msg_e1', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Added cloudflared.service on madx.' }], stop_reason: 'end_turn' } },
      { ...base, parentUuid: u(2), type: 'user', uuid: u(3), timestamp: '2026-03-10T10:02:00Z', message: { role: 'user', content: 'Good. I always use cloudflared for tunnels on my machines, never ngrok, and every tunnel must run as a systemd unit, not in tmux or screen, so it comes back after a reboot of madx or pve.' } },
      { ...base, parentUuid: u(3), type: 'assistant', uuid: u(4), timestamp: '2026-03-10T10:03:00Z', message: { id: 'msg_e2', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Noted.' }], stop_reason: 'end_turn' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
}

beforeAll(async () => {
  h = buildOwnerHome();
  mkdirSync(join(h.home, '.claude/projects/-home-kai-code-tunnel'), { recursive: true });
  writeFileSync(join(h.home, `.claude/projects/-home-kai-code-tunnel/${SECRET_ID}.jsonl`), secretSession());
  dev = mkdtempSync(join(tmpdir(), 'conclave-qa-dev-'));
  cpSync(h.home, dev, { recursive: true, preserveTimestamps: true });
  t = await startTestEngine({ script: [[{ text: 'ok' }]], chore, overrides: { memory: { enabled: true, autoExtract: false, autoInject: false, injectLimit: 5 }, limits: { maxRetries: 0 } } as never });
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = join(h.home, '.claude');
  process.env.CODEX_HOME = join(h.home, '.codex');
  process.env.GEMINI_DIR = join(h.home, '.gemini');
  svc = importOf(t.engine)!;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'CLAUDE_CONFIG_DIR') continue; // the harness restores it
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await t.close();
  rmSync(h.home, { recursive: true, force: true });
  rmSync(dev, { recursive: true, force: true });
});

async function run(input: Parameters<ImportService['startBatch']>[0]) {
  const b = await svc.startBatch(input);
  await svc.runBatch(b.id);
  return svc.batch(b.id);
}

const rowOf = async (id: string, cwd?: string): Promise<ExternalSessionInfo> => (await svc.scan({ device: 'local' })).items.find((x) => x.id === id && (!cwd || x.cwd === cwd))!;

describe("Codex's own memory threads", () => {
  test('are never learned from, even when picked by hand', async () => {
    await svc.scan({ device: 'local', refresh: true });
    const t4 = await rowOf(OWNER.codexT4);
    expect(t4.skip).toBe('internal');
    learnPrompts.length = 0;
    const b = await run({ device: 'local', keys: [t4.key], mode: 'learn', includeSkipped: true });
    expect(b.status).toBe('done');
    expect(learnPrompts.filter((p) => p.includes('Consolidate the memories'))).toEqual([]);
    const b2 = await run({ device: 'local', keys: [t4.key], mode: 'chats-learn', includeSkipped: true });
    expect(b2.imported).toBe(1);
    expect(learnPrompts.filter((p) => p.includes('Consolidate the memories'))).toEqual([]);
    // and the imported copy is not offered as "not learned yet"
    const sid = (await rowOf(OWNER.codexT4)).imported!.sessionId!;
    learnPrompts.length = 0;
    await run({ device: 'local', sessionIds: [sid], mode: 'learn' });
    expect(learnPrompts).toEqual([]);
  });
});

describe('learn only, then import the chats', () => {
  test('a learned-only chat is not shown as imported, and importing it later does not learn it again', async () => {
    const row = await rowOf(OWNER.codexT3);
    learnPrompts.length = 0;
    const b = await run({ device: 'local', keys: [row.key], mode: 'learn' });
    expect(b.learnedSessions).toBe(1);
    expect(learnPrompts).toHaveLength(1);
    const after = await rowOf(OWNER.codexT3);
    expect(after.imported?.sessionId).toBeUndefined();
    // "hide imported" still lists it: there is no session for it yet
    const page = await svc.scan({ device: 'local', includeImported: false });
    expect(page.items.map((x) => x.key)).toContain(row.key);
    learnPrompts.length = 0;
    const b2 = await run({ device: 'local', keys: [row.key], mode: 'chats-learn' });
    expect(b2.imported).toBe(1);
    expect(learnPrompts).toEqual([]);
    const s = t.engine.repos.sessions.get((await rowOf(OWNER.codexT3)).imported!.sessionId!)!;
    expect((s.meta?.import as SessionImportInfo).learned).toBe(true);
    expect(svc.batches().notLearned).toBe(0);
    // undo of the learning takes its memories away, so the imported chat is offered for learning again
    await svc.undo(b.id);
    expect((t.engine.repos.sessions.get(s.id)!.meta?.import as SessionImportInfo).learned).toBe(false);
    expect(svc.batches().notLearned).toBe(1);
    learnPrompts.length = 0;
    await run({ device: 'local', notLearned: true, mode: 'learn' });
    expect(learnPrompts).toHaveLength(1);
  });
});

describe('one Claude Code id in two folders', () => {
  test('each session keeps its own episode', async () => {
    const page = await svc.scan({ device: 'local' });
    const both = page.items.filter((x) => x.id === OWNER.claudeB);
    expect(both).toHaveLength(2);
    const b = await run({ device: 'local', keys: both.map((x) => x.key), mode: 'chats-learn', includeSkipped: true });
    expect(b.learnedSessions).toBe(2);
    const episodes = (t.engine.memory as SqliteMemory).withTag('episode').filter((m) => m.meta?.extSessionId === OWNER.claudeB);
    expect(episodes).toHaveLength(2);
    expect(new Set(episodes.map((e) => e.sourceSessionId)).size).toBe(2);
  });
});

describe('an episode that runs on', () => {
  test('is kept short', async () => {
    const g = await rowOf(OWNER.gemini);
    await run({ device: 'local', keys: [g.key], mode: 'chats-learn' });
    const sid = (await rowOf(OWNER.gemini)).imported!.sessionId!;
    const ep = (t.engine.memory as SqliteMemory).withTag('episode').find((m) => m.sourceSessionId === sid)!;
    expect(ep.content.length).toBeLessThanOrEqual(1200);
  });
});

describe('a file that now holds another conversation', () => {
  test('fails closed: no fork of an unrelated chat, the session is left alone', async () => {
    const a = await rowOf(OWNER.claudeA);
    const b = await run({ device: 'local', keys: [a.key], mode: 'chats' });
    expect(b.imported).toBe(1);
    const sid = (await rowOf(OWNER.claudeA)).imported!.sessionId!;
    const before = t.engine.repos.messages.list(sid).length;
    const sessions = t.engine.repos.sessions.list({} as never).length;
    // the portfolio transcript is replaced by the homelab one (a bad copy, a sync conflict)
    writeFileSync(h.path('claudeA'), claudeSessionB());
    const at = new Date('2026-03-21T10:00:00Z');
    utimesSync(h.path('claudeA'), at, at);
    const r = await svc.syncSession(sid);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/another conversation/);
    expect(t.engine.repos.sessions.list({} as never).length).toBe(sessions);
    expect(t.engine.repos.messages.list(sid).length).toBe(before);
  });
});

describe('a device that sends a malformed reply', () => {
  test('the hub keeps the source it asked for and drops messages that are not messages', async () => {
    const odd = new OddDevice(dev, 'odd-mac');
    if (!t.engine.repos.devices.get('odd-mac')) t.engine.repos.devices.insert({ id: 'odd-mac', name: 'odd-mac', tokenHash: 'x' });
    t.engine.devices.attach({ id: 'odd-mac', name: 'odd-mac', online: true, roots: [], createdAt: Date.now() }, odd);
    const page = await svc.scan({ device: 'odd-mac', refresh: true });
    const d = page.items.find((x) => x.source === 'claude-code' && x.title === 'Homelab caddy restart') ?? page.items.find((x) => x.source === 'claude-code' && !x.skip)!;
    const b = await run({ device: 'odd-mac', keys: [d.key], mode: 'chats' });
    expect(b.failed).toBe(0);
    const s = t.engine.repos.sessions.get(svc.batch(b.id).items[0].sessionId!)!;
    expect(s.tags).toEqual(['imported', 'claude-code']);
    const msgs = t.engine.repos.messages.list(s.id);
    expect(msgs.every((m) => (m.role === 'user' || m.role === 'assistant') && Array.isArray(m.content) && Number.isFinite(m.createdAt))).toBe(true);
  });
});

describe('undo after the owner kept going', () => {
  test('a session the owner continued in Conclave is kept and listed', async () => {
    const t1 = await rowOf(OWNER.codexT1);
    const b = await run({ device: 'local', keys: [t1.key], mode: 'chats' });
    expect(b.imported).toBe(1);
    const sid = (await rowOf(OWNER.codexT1)).imported!.sessionId!;
    const seq = t.engine.repos.messages.nextSeq(sid);
    t.engine.repos.messages.insert({ id: newId('msg'), sessionId: sid, seq, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Picking this up in Conclave: add a print stylesheet.' }], createdAt: Date.now() });
    const r = await svc.undo(b.id);
    expect(t.engine.repos.sessions.get(sid)).toBeDefined();
    expect(r.keptSessions?.map((x) => x.id)).toEqual([sid]);
    expect(r.sessionsRemoved).toBe(0);
  });
});

describe('a token in the first prompt', () => {
  test('never reaches the learning model or the session title', async () => {
    await svc.scan({ device: 'local', refresh: true });
    const row = await rowOf(SECRET_ID);
    expect(row.title).not.toContain('FakeTok3nForQaTests99');
    learnPrompts.length = 0;
    const b = await run({ device: 'local', keys: [row.key], mode: 'chats-learn' });
    expect(b.imported).toBe(1);
    expect(learnPrompts.length).toBeGreaterThan(0);
    expect(learnPrompts.join('\n')).not.toContain('FakeTok3nForQaTests99');
    const s = t.engine.repos.sessions.get(svc.batch(b.id).items[0].sessionId!)!;
    expect(s.title).not.toContain('FakeTok3nForQaTests99');
    // nor the batch's item list, nor the ledger
    expect(JSON.stringify(svc.batch(b.id).items)).not.toContain('FakeTok3nForQaTests99');
    expect(JSON.stringify(svc.store.ledgerBySession(s.id))).not.toContain('FakeTok3nForQaTests99');
  });
});

describe('partial and duplicate imports', () => {
  test('a crash between the ledger row and the messages: the re-run imports it as new, and undo removes it', async () => {
    const row = await rowOf(OWNER.codexT2);
    const b0 = await run({ device: 'local', keys: [row.key], mode: 'chats' });
    const sid = svc.batch(b0.id).items[0].sessionId!;
    // what a kill after the session row and before its messages leaves behind
    for (const m of t.engine.repos.messages.list(sid)) t.engine.repos.messages.delete(m.id);
    for (const l of svc.store.ledgerBySession(sid)) svc.store.putLedger({ ...l, status: 'importing', cursor: { count: 0 } });
    const b = await run({ device: 'local', keys: [row.key], mode: 'chats' });
    expect(b).toMatchObject({ imported: 1, updated: 0 });
    expect(t.engine.repos.messages.list(sid).length).toBeGreaterThan(2);
    const r = await svc.undo(b.id);
    expect(r.sessionsRemoved).toBe(1);
    expect(t.engine.repos.sessions.get(sid)).toBeUndefined();
  });

  test('two batches on the same chat at once import it once', async () => {
    const row = await rowOf(OWNER.claudeB, '/home/kai/code/homelab');
    // claudeB was imported above; take a chat nobody imported yet
    const fresh = (await svc.scan({ device: 'local' })).items.find((x) => !x.imported?.sessionId && x.source === 'claude-code' && x.kind === 'main')!;
    expect(row).toBeDefined();
    const before = t.engine.repos.sessions.list({} as never).length;
    const [a, b] = await Promise.all([svc.startBatch({ device: 'local', keys: [fresh.key], mode: 'chats', includeSkipped: true }), svc.startBatch({ device: 'local', keys: [fresh.key], mode: 'chats', includeSkipped: true })]);
    await Promise.all([svc.runBatch(a.id), svc.runBatch(b.id)]);
    expect(svc.batch(a.id).imported + svc.batch(b.id).imported).toBe(1);
    expect(t.engine.repos.sessions.list({} as never).length).toBe(before + 1);
  });
});

describe('a device scan with rows of the wrong shape', () => {
  test('the good rows list, the bad ones are left out', async () => {
    const odd = new OddScanner(dev, 'odd-scan');
    if (!t.engine.repos.devices.get('odd-scan')) t.engine.repos.devices.insert({ id: 'odd-scan', name: 'odd-scan', tokenHash: 'x' });
    t.engine.devices.attach({ id: 'odd-scan', name: 'odd-scan', online: true, roots: [], createdAt: Date.now() }, odd);
    const page = await svc.scan({ device: 'odd-scan', refresh: true });
    expect(page.items.find((x) => x.id === OWNER.claudeA)).toBeDefined();
    expect(page.items.every((x) => typeof x.path === 'string' && typeof x.title === 'string')).toBe(true);
    expect(page.items.find((x) => x.id === 'y' || x.id === 'x')).toBeUndefined();
  });
});
