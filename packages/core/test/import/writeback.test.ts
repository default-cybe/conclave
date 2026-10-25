/**
 * Conclave to Claude Code (import/writeback.ts): Conclave's turns on an
 * imported Claude Code chat go back into its file in Claude Code's format,
 * without thinking from any model, never while Claude Code has the chat
 * open, and the next import sees them as present, not as divergence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, until, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import { buildRows, checkRows, leafClaude, leafImporter, parseRows } from '../../src/import/writeback';
import { convertClaudeCode } from '../../src/importers/claude-code';
import type { Message, Session } from '../../src/types';
import { newId } from '../../src/util/ids';
import { buildOwnerHome, OWNER, type OwnerHome } from '../importers/owner-home';

const base = { cwd: '/home/kai/code/portfolio', sessionId: OWNER.claudeA, version: '2.1.0', gitBranch: 'main', entrypoint: 'cli' };
const msg = (sessionId: string, seq: number, role: 'user' | 'assistant', content: Message['content'], model?: string): Message => ({ id: newId('msg'), sessionId, seq, role, kind: 'normal', content, createdAt: Date.now(), ...(model ? { model } : {}) });

describe('buildRows', () => {
  test('no thinking from any model, Claude Code tools kept, other tools as text, every tool_use answered', () => {
    const s = 'ses_x';
    const rows = buildRows(
      [
        msg(s, 1, 'user', [{ type: 'text', text: 'Fix the build.' }]),
        msg(s, 2, 'assistant', [{ type: 'thinking', thinking: 'CLAUDE-SECRET', signature: 'sigClaude' }, { type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', id: 't2', name: 'MemorySave', input: { content: 'x' } }], 'anthropic/claude-opus-4-6'),
        msg(s, 3, 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'file a' }, { type: 'tool_result', toolUseId: 't2', content: 'saved' }]),
        msg(s, 4, 'assistant', [{ type: 'redacted_thinking', data: 'REDACTED' }, { type: 'thinking', thinking: 'GPT-SECRET', signature: 'cv1|openai|gpt-5|x' }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'bun run build' } }], 'openai/gpt-5'),
        { ...msg(s, 5, 'assistant', [{ type: 'text', text: 'A juror said so.' }]), kind: 'aside' },
      ],
      base,
      'leaf-uuid',
    );
    const text = JSON.stringify(rows);
    for (const secret of ['CLAUDE-SECRET', 'GPT-SECRET', 'REDACTED', 'sigClaude', '"signature"', 'juror']) expect(text).not.toContain(secret);
    expect(rows.map((r) => r.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(rows[1].message.content.map((b: { type: string; name?: string }) => b.name ?? b.type)).toEqual(['text', 'Read', 'text']);
    expect(rows[1].message.content[2].text).toBe('[Conclave tool MemorySave: {"content":"x"} → saved]');
    expect(rows[2].message.content).toEqual([{ type: 'tool_result', tool_use_id: rows[1].message.content[1].id, content: 'file a' }]);
    // the last call never got a result in Conclave
    expect(rows[4].message.content).toEqual([{ type: 'tool_result', tool_use_id: rows[3].message.content[0].id, content: 'interrupted in Conclave', is_error: true }]);
    expect(rows[3].message.model).toBe('openai/gpt-5');
    expect(rows[0]).toMatchObject({ parentUuid: 'leaf-uuid', isSidechain: false, userType: 'external', ...base });
    expect(checkRows(rows, 'leaf-uuid', OWNER.claudeA)).toEqual([]);
    expect(checkRows([{ ...rows[0], message: { role: 'user', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] } }], 'leaf-uuid', OWNER.claudeA)).toHaveLength(2);
  });
});

describe('the service writes Conclave turns back', () => {
  let t: TestEngine;
  let svc: ImportService;
  let h: OwnerHome;
  let sid = '';
  const file = () => h.path('claudeA');
  const sessionsDir = () => join(h.home, '.claude', 'sessions');

  beforeAll(async () => {
    h = buildOwnerHome();
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    process.env.CLAUDE_CONFIG_DIR = join(h.home, '.claude');
    svc = importOf(t.engine)!;
    const page = await svc.scan({ device: 'local', refresh: true, sources: ['claude-code'] } as never);
    const a = page.items.find((x) => x.id === OWNER.claudeA && x.kind === 'main')!;
    const b = await svc.startBatch({ device: 'local', keys: [a.key], mode: 'chats' });
    await svc.runBatch(b.id);
    sid = (await svc.scan({ device: 'local' })).items.find((x) => x.key === a.key)!.imported!.sessionId!;
  });

  afterAll(async () => {
    await t.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const addTurn = (prompt: string, reply: string) => {
    const seq = t.engine.repos.messages.nextSeq(sid);
    t.engine.repos.messages.insert(msg(sid, seq, 'user', [{ type: 'text', text: prompt }]));
    t.engine.repos.messages.insert(msg(sid, seq + 1, 'assistant', [{ type: 'thinking', thinking: 'MOCK-THINKING', signature: 'sigMock' }, { type: 'text', text: reply }], 'mock/claude-sonnet-5-5'));
  };
  const endTurn = () => {
    const s = t.engine.repos.sessions.get(sid)!;
    t.engine.bus.emit({ type: 'session.updated', session: { ...s, status: 'running' } as Session });
    t.engine.bus.emit({ type: 'session.updated', session: s });
  };

  test('not while Claude Code has the chat open', async () => {
    const before = readFileSync(file(), 'utf8');
    addTurn('Add a 404 page.', 'Added src/pages/404.astro.');
    mkdirSync(sessionsDir(), { recursive: true });
    // a live process other than this one: the test runner's parent
    writeFileSync(join(sessionsDir(), '1.json'), JSON.stringify({ pid: process.ppid, sessionId: OWNER.claudeA }));
    expect(await svc.writeBack(sid)).toMatch(/^busy \(sessions\/1\.json pid \d+\)$/);
    expect(readFileSync(file(), 'utf8')).toBe(before);
    rmSync(sessionsDir(), { recursive: true, force: true });
  });

  test('a turn that ends is appended in Claude Code format and both leaf rules pick it', async () => {
    const before = readFileSync(file(), 'utf8');
    endTurn();
    expect(await until(() => readFileSync(file(), 'utf8').length > before.length)).toBe(true);
    await until(() => !!t.engine.repos.messages.list(sid).at(-1)?.meta?.external);
    const after = readFileSync(file(), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    const added = parseRows(after.slice(before.length), false);
    expect(added.map((r) => r.type)).toEqual(['user', 'assistant']);
    // each written message takes the id of its own row, the prompt too
    expect(t.engine.repos.messages.list(sid).slice(-2).map((m) => (m.meta?.external as { id?: string } | undefined)?.id)).toEqual(added.map((r) => r.uuid));
    expect(after.slice(before.length)).not.toContain('MOCK-THINKING');
    expect(after.slice(before.length)).not.toContain('signature');
    const rows = parseRows(after, false);
    expect(leafClaude(rows)).toBe(added[1].uuid);
    expect(leafImporter(rows, true)).toBe(added[1].uuid);
    const conv = convertClaudeCode(after);
    expect(conv.messages.at(-1)!.content).toEqual([{ type: 'text', text: 'Added src/pages/404.astro.' }]);
  });

  test('the next import sees the written turn as present, then appends what Claude Code adds after it', async () => {
    const n = t.engine.repos.messages.list(sid).length;
    expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
    // undo and mergeDuplicates rebuild the cursor without its absorbed list: the written turn still counts as present
    const l = svc.store.ledgerBySession(sid)[0];
    svc.store.putLedger({ ...l, cursor: { lastId: l.cursor.lastId, count: l.cursor.count } });
    expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
    const tail = parseRows(readFileSync(file(), 'utf8'), false).at(-1)!;
    const line = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, cwd: base.cwd, sessionId: OWNER.claudeA, ...o });
    appendFileSync(file(), line({ type: 'user', parentUuid: tail.uuid, uuid: 'c0000001-0000-4000-8000-000000000001', timestamp: new Date(Date.now() + 5_000).toISOString(), message: { role: 'user', content: 'Back in Claude Code: style the 404 page.' } }) + '\n');
    // one prompt typed in Claude Code: the scan sees it, so the watch job imports it
    const row = (await svc.scan({ device: 'local', refresh: true, sources: ['claude-code'] } as never)).items.find((x) => x.id === OWNER.claudeA && x.kind === 'main')!;
    expect(row.imported).toMatchObject({ state: 'behind', newThere: 1 });
    appendFileSync(
      file(),
      [
        line({ type: 'assistant', parentUuid: 'c0000001-0000-4000-8000-000000000001', uuid: 'c0000001-0000-4000-8000-000000000002', timestamp: new Date(Date.now() + 6_000).toISOString(), message: { id: 'msg_cc_1', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Styled it.' }], stop_reason: 'end_turn' } }),
        line({ type: 'last-prompt', leafUuid: 'c0000001-0000-4000-8000-000000000001' }),
      ].join('\n') + '\n',
    );
    const r = await svc.syncSession(sid);
    expect(r).toEqual({ state: 'updated', added: 2 });
    const msgs = t.engine.repos.messages.list(sid);
    expect(msgs).toHaveLength(n + 2);
    expect(t.engine.repos.sessions.list({ archived: true } as never).filter((s: Session) => s.parentId === sid)).toEqual([]);
    // a turn that only Claude Code ran is not written back
    expect(await svc.writeBack(sid)).toBeUndefined();
  });

  test('a write-back skipped while the chat was open is written by the next sync', async () => {
    const before = readFileSync(file(), 'utf8');
    addTurn('Add a sitemap.', 'Added the sitemap.');
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), '1.json'), JSON.stringify({ pid: process.ppid, sessionId: OWNER.claudeA }));
    expect(await svc.writeBack(sid)).toMatch(/^busy/);
    rmSync(sessionsDir(), { recursive: true, force: true });
    expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
    expect(parseRows(readFileSync(file(), 'utf8').slice(before.length), false).map((r) => r.type)).toEqual(['user', 'assistant']);
    expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
  });

  test('a sync that runs with a write-back never writes its older ledger row over it', async () => {
    addTurn('Add robots.txt.', 'Added it.');
    const [sync, wrote] = await Promise.all([svc.syncSession(sid), svc.writeBack(sid)]);
    expect([sync, wrote]).toEqual([{ state: 'unchanged', added: 0 }, undefined]);
    expect(svc.store.ledgerBySession(sid)[0].size).toBe(readFileSync(file()).length);
    expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
    expect(t.engine.repos.sessions.list({ archived: true } as never).filter((s: Session) => s.parentId === sid)).toEqual([]);
  });
});
