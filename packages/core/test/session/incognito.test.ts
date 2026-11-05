import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
