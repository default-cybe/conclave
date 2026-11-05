import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { outputsDir } from '../../src/files/share';
import { INCOGNITO_IDLE_MS } from '../../src/session/incognito';
import { searchPastSessions } from '../../src/session/search';
import { sessionAllowsTool } from '../../src/session/chat';
import { buildRecap } from '../../src/assistant/recap';
import { sessionsBetween } from '../../src/assistant/day';
import { ChatParticipantStore } from '../../src/people/shared-chats';
import { cleanup, tempDir } from '../extensions/_helpers';

const dirs: string[] = [];
const engines: Engine[] = [];
const savedClaude = process.env.CLAUDE_CONFIG_DIR;

async function hub(): Promise<Engine> {
  const home = tempDir('conclave-incog-');
  const claude = tempDir('conclave-incog-claude-');
  dirs.push(home, claude);
  process.env.CLAUDE_CONFIG_DIR = claude;
  const e = await createEngine({ home, noBackground: true, version: 'test' });
  engines.push(e);
  return e;
}

afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown();
  cleanup(...dirs.splice(0));
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
});

/** A transcript with a marker word, written the way a turn writes it. */
function talk(e: Engine, sessionId: string, word: string) {
  const now = Date.now();
  e.repos.messages.insert({ id: `msg_${sessionId}_1`, sessionId, seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: `${word} owner text` }], createdAt: now } as never);
  e.repos.messages.insert({ id: `msg_${sessionId}_2`, sessionId, seq: 2, role: 'assistant', kind: 'normal', content: [{ type: 'text', text: `${word} reply` }], createdAt: now } as never);
}

const count = (e: Engine, sql: string, ...args: unknown[]) => (e.repos.db.query(sql).get(...(args as never[])) as { n: number }).n;

test('not listed and not searchable', async () => {
  const e = await hub();
  const s = await e.createSession({ kind: 'chat', incognito: true, title: 'zebrasecret plan' });
  talk(e, s.id, 'zebrasecret');
  expect(e.getSession(s.id)?.incognito).toBe(true);
  expect(e.listSessions({ accountId: 'owner' }).some((x) => x.id === s.id)).toBe(false);
  expect(e.listSessions({ accountId: 'owner', search: 'zebrasecret' })).toHaveLength(0);
  expect(e.search('zebrasecret')).toHaveLength(0);
  expect(count(e, 'SELECT COUNT(*) n FROM messages_fts WHERE session_id = ?', s.id)).toBe(0);
  expect(count(e, 'SELECT COUNT(*) n FROM sessions_fts WHERE session_id = ?', s.id)).toBe(0);
  expect(searchPastSessions(e.repos.db, { query: 'zebrasecret' })).toHaveLength(0);
  expect(sessionsBetween(e.repos.db, 0, Date.now() + 1000).some((x) => x.id === s.id)).toBe(false);
  expect(buildRecap(e.repos.db, 'owner', 'year', 'UTC').totals.chats).toBe(0);
  expect(() => e.exportSession(s.id, 'md')).toThrow(/incognito/);
  expect(() => e.forkSession(s.id)).toThrow(/incognito/);
});

test('"Use only" reads memory and saves nothing; "Off" reads nothing', async () => {
  const e = await hub();
  const useOnly = await e.createSession({ kind: 'chat', incognito: true });
  expect(useOnly.chat?.memory).toBe(true);
  expect(useOnly.chat?.memorySave).toBe(false);
  expect(e.usesMemory(useOnly)).toBe(true);
  expect(e.savesMemory(useOnly)).toBe(false);
  expect(sessionAllowsTool(useOnly, 'MemorySearch')).toBe(true);
  expect(sessionAllowsTool(useOnly, 'MemorySave')).toBe(false);
  expect(sessionAllowsTool(useOnly, 'MemoryForget')).toBe(false);
  expect(sessionAllowsTool(useOnly, 'mcp__basic-memory__write_note')).toBe(false);
  expect(sessionAllowsTool(useOnly, 'mcp__basic-memory__search_notes')).toBe(true);
  // a Code session too
  const code = await e.createSession({ incognito: true });
  expect(e.savesMemory(code)).toBe(false);
  expect(sessionAllowsTool(code, 'MemorySave')).toBe(false);
  const off = await e.createSession({ kind: 'chat', incognito: true, chat: { memory: false } });
  expect(e.usesMemory(off)).toBe(false);
  expect(sessionAllowsTool(off, 'MemorySearch')).toBe(false);
  expect(sessionAllowsTool(off, 'mcp__basic-memory__search_notes')).toBe(false);
  // a normal session keeps "Use and save"
  const normal = await e.createSession({ kind: 'chat' });
  expect(e.savesMemory(normal)).toBe(true);
});

test('hard delete removes every row and the outputs folder; usage keeps counts only', async () => {
  const e = await hub();
  const s = await e.createSession({ kind: 'chat', incognito: true });
  talk(e, s.id, 'otterword');
  const db = e.repos.db;
  db.query("INSERT INTO tool_outputs (id, session_id, tool, content, created_at) VALUES ('out_x', ?, 'Bash', 'otterword out', 1)").run(s.id);
  e.repos.kv.set(`design-ref:${s.id}`, 1);
  const dir = outputsDir(e.config.paths.home, s.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/a.txt`, 'otterword');
  await e.deleteSession(s.id);
  for (const t of ['sessions WHERE id', 'messages WHERE session_id', 'messages_fts WHERE session_id', 'tool_outputs WHERE session_id', 'turns WHERE session_id', 'audit WHERE session_id']) {
    expect(count(e, `SELECT COUNT(*) n FROM ${t} = ?`, s.id)).toBe(0);
  }
  expect(count(e, 'SELECT COUNT(*) n FROM kv WHERE instr(key, ?) > 0', s.id)).toBe(0);
  expect(existsSync(dir)).toBe(false);
  expect(count(e, 'SELECT COUNT(*) n FROM usage WHERE session_id = ?', s.id)).toBe(0);
});

test('idle and startup cleanup', async () => {
  const e = await hub();
  const fresh = await e.createSession({ kind: 'chat', incognito: true });
  const idle = await e.createSession({ incognito: true });
  e.repos.db.query('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now() - INCOGNITO_IDLE_MS - 1000, idle.id);
  expect(await e.sweepIncognito()).toBe(1);
  expect(e.getSession(idle.id)).toBeUndefined();
  expect(e.getSession(fresh.id)).toBeDefined();
  // hub start: every one goes
  expect(await e.sweepIncognito({ all: true })).toBe(1);
  expect(e.getSession(fresh.id)).toBeUndefined();
  // a normal session is never swept
  const normal = await e.createSession({ kind: 'chat' });
  e.repos.db.query('UPDATE sessions SET updated_at = 0 WHERE id = ?').run(normal.id);
  await e.sweepIncognito({ all: true });
  expect(e.getSession(normal.id)).toBeDefined();
});

test('a new chat closes the earlier incognito one; incognito cannot be switched mid-session', async () => {
  const e = await hub();
  const a = await e.createSession({ kind: 'chat', incognito: true }, 'owner', { byPerson: true });
  await e.createSession({ kind: 'chat' }, 'owner', { byPerson: true });
  expect(e.getSession(a.id)).toBeUndefined();
  const b = await e.createSession({ kind: 'chat', incognito: true });
  e.repos.sessions.update({ ...e.getSession(b.id)!, incognito: false });
  expect(e.getSession(b.id)?.incognito).toBe(true);
});

test('member isolation: a member incognito session is theirs alone', async () => {
  const e = await hub();
  const m = e.people.create({ name: 'mia' });
  const s = await e.createSession({ kind: 'chat', incognito: true }, m.id);
  talk(e, s.id, 'pumaword');
  expect(e.sessionAccount(s.id)).toBe(m.id);
  // the owner's lists and searches never see it, neither do the member's
  expect(e.listSessions({ accountId: 'owner' }).some((x) => x.id === s.id)).toBe(false);
  expect(e.listSessions({ accountId: m.id }).some((x) => x.id === s.id)).toBe(false);
  expect(e.search('pumaword', 'owner')).toHaveLength(0);
  expect(searchPastSessions(e.repos.db, { query: 'pumaword', accountId: m.id })).toHaveLength(0);
  // sharing it with someone is refused
  expect(() => new ChatParticipantStore(e.repos.db).invite(s.id, m.id, 'owner')).toThrow(/incognito/);
});

// ----- leaks found in review: each fails on feat/incognito -----

/** Every notice the hub hands to its push channels. */
function spyNotices(e: Engine): Array<{ title: string; body: string; sessionId?: string }> {
  const sent: Array<{ title: string; body: string; sessionId?: string }> = [];
  (e.notifier as unknown as { send: (n: never) => Promise<unknown> }).send = async (n: never) => {
    sent.push(n);
    return n;
  };
  return sent;
}

test('leak: an approval request in an incognito session pushes its command text', async () => {
  const e = await hub();
  const sent = spyNotices(e);
  const s = await e.createSession({ incognito: true });
  const ac = new AbortController();
  void e.requestApproval(s.id, { tool: 'Bash', summary: 'cat ~/lynxsecret-diary.txt', input: {} } as never, ac.signal);
  ac.abort();
  expect(sent.filter((n) => n.sessionId === s.id && /lynxsecret/.test(`${n.title} ${n.body}`))).toHaveLength(0);
});

test('leak: a question in an incognito session pushes the question text', async () => {
  const e = await hub();
  const sent = spyNotices(e);
  const s = await e.createSession({ kind: 'chat', incognito: true });
  const ac = new AbortController();
  void e.askUser(s.id, [{ question: 'Should I email the lynxsecret lawyer?', header: 'q', options: [] }] as never, ac.signal);
  ac.abort();
  expect(sent.filter((n) => n.sessionId === s.id && /lynxsecret/.test(`${n.title} ${n.body}`))).toHaveLength(0);
});

test('leak: an incognito Code session in "Use only" or "Off" keeps ProactivePrefs, which saves a profile memory', async () => {
  const e = await hub();
  // the coder agent has no tools list, so every builtin reaches it unless the session switches take it away
  const useOnly = await e.createSession({ incognito: true });
  const off = await e.createSession({ incognito: true, chat: { memory: false } });
  const names = (s: typeof useOnly) => e.toolsFor(e.getSession(s.id)!, e.agentFor(s), 'default', 0).map((t) => t.name);
  // ProactivePrefs -> PrefsStore.set -> memory.save kind profile (assistant/prefs.ts:203)
  expect(names(useOnly)).not.toContain('ProactivePrefs');
  expect(names(off)).not.toContain('ProactivePrefs');
});

test('leak: "Use only" keeps the Basic Memory canvas tool, which writes a note file', async () => {
  const e = await hub();
  const code = await e.createSession({ incognito: true });
  // chat.ts savesToMemory matches write|edit|move|delete only
  expect(sessionAllowsTool(code, 'mcp__basic-memory__canvas')).toBe(false);
});

test('leak: a workflow run script saved for an incognito session outlives the purge', async () => {
  const e = await hub();
  const s = await e.createSession({ incognito: true });
  const runId = 'wfr_incog1';
  // what WorkflowService.saveScript writes for every run (workflows/service.ts:707)
  const dir = join(e.config.paths.home, 'workflows', 'runs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.js`);
  writeFileSync(path, "agent('find the heronsecret in my tax files')");
  e.repos.db
    .query("INSERT INTO workflow_runs (id, name, source, script, script_sha, script_path, session_id, device, cwd, status, created_at) VALUES (?, 'w', 'inline', 'x', 'x', ?, ?, 'local', '/tmp', 'done', 1)")
    .run(runId, path, s.id);
  await e.deleteSession(s.id);
  expect(count(e, 'SELECT COUNT(*) n FROM workflow_runs WHERE id = ?', runId)).toBe(0);
  expect(existsSync(path)).toBe(false);
});

// Not a leak, no test: the workflow ledger (workflows/store.ts upsertLedger) is per-folder project state that
// normal sessions in the same folder read and merge into, like a file on the device. Code incognito keeps
// device-side work; deleting ledger rows would also drop findings other sessions wrote or confirmed.

test('leak: the event replay buffer still holds a deleted incognito session', async () => {
  const e = await hub();
  const s = await e.createSession({ kind: 'chat', incognito: true, title: 'mothsecret' });
  // what the runner emits for each message (replayed to any reconnecting client of the account)
  e.bus.emit({ type: 'message.created', message: { id: 'msg_m1', sessionId: s.id, seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'mothsecret text' }], createdAt: Date.now() } } as never);
  await e.deleteSession(s.id);
  const left = (e.bus.since(0) ?? []).filter((ev) => JSON.stringify(ev).includes('mothsecret'));
  expect(left).toHaveLength(0);
});
