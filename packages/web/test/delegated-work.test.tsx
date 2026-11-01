/**
 * Delegated work in the sidebar and the drawer (lib/sidebar.ts
 * delegatedRows, docs/design/SPEC.md 5.3, docs/DESIGN.md 43): a Delegate
 * call's sessions are a group of their own, newest first, not in the main
 * list; moved to the main list (core session/delegated.ts), one is a normal
 * session of its kind there, its parentId kept, and the call row of the
 * chat it came from still opens it.
 *
 *   cd packages/web && bun test test/delegated-work.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { Session, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { movedSession } from '@conclave/core/session/delegated';
import type { GroupContext } from '../src/lib/grouping';
import { DELEGATED_WORDS, delegatedRows, delegateWho, fromWords, modeSessions, sideGroups } from '../src/lib/sidebar';
import { subagentOf } from '../src/features/chat/liveTasks';

const MIN = 60_000;
const NOW = new Date(2026, 9, 22, 15, 0).getTime();

function s(id: string, p: Partial<Session>): Session {
  return {
    id,
    title: id,
    agent: 'coder',
    model: 'anthropic/claude-sonnet-5-5',
    mode: 'agent',
    permissionMode: 'default',
    cwd: '~',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW - 30 * MIN,
    stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ...p,
  };
}

const ctx: GroupContext = {
  projects: {},
  devices: {
    local: { id: 'local', name: 'madx', info: { home: '/root' } as never },
    arch: { id: 'arch', name: 'MadX Arch', info: { home: '/home/kai' } as never },
  },
};

const place = (to: 'code' | 'assistant', device: string, deviceName: string, toolUseId: string) => ({ to, device, deviceName, folder: '/home/kai/capstone', readOnly: true, permissionMode: 'plan', toolUseId });
const delegated = (id: string, p: Partial<Session>, mark: ReturnType<typeof place>) => s(id, { tags: ['subagent', 'delegated'], meta: { subagent: true, delegate: mark }, ...p });

const chat = s('chat', { kind: 'chat', agent: 'chat', title: 'Capstone', updatedAt: NOW - 2 * MIN });
const plan = s('plan', { agent: 'assistant', title: 'Plan my week', updatedAt: NOW - 50 * MIN });
const names = delegated('names', { title: 'Find names in the capstone PDFs', agent: 'explore', parentId: 'chat', device: 'arch', cwd: '/home/kai/capstone', updatedAt: NOW - 5 * MIN }, place('code', 'arch', 'MadX Arch', 'd1'));
const draft = delegated('draft', { title: 'Draft the reply', agent: 'assistant', parentId: 'chat', status: 'running', updatedAt: NOW - MIN }, place('assistant', 'local', 'madx', 'd2'));
const lisbon = delegated('lisbon', { title: 'Find the booking PDF', agent: 'explore', parentId: 'plan', device: 'arch', updatedAt: NOW - 90 * MIN }, place('code', 'arch', 'MadX Arch', 'd3'));
const gone = delegated('gone', { title: 'Old job', parentId: 'chat', archived: true }, place('code', 'local', 'madx', 'd4'));
// a plain subagent of the chat: never in the group
const sub = s('sub', { agent: 'explore', parentId: 'chat', tags: ['subagent'], meta: { subagent: true } });
const sessions = [chat, plan, names, draft, lisbon, gone, sub];

const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);
const mainIds = (list: Session[], mode: 'chat' | 'assistant' | 'code') => sideGroups({ sessions: list, mode, by: 'time', ctx, now: NOW }).flatMap((g) => g.rows.map((r) => r.id));

describe('Delegated work', () => {
  test('lists delegated sessions newest first, and none of them in the main list of any mode', () => {
    expect(ids(delegatedRows({ sessions, ctx }))).toEqual(['draft', 'names', 'lisbon']);
    expect(mainIds(sessions, 'chat')).toEqual(['chat']);
    expect(mainIds(sessions, 'assistant')).toEqual(['plan']);
    expect(mainIds(sessions, 'code')).toEqual([]);
    expect(DELEGATED_WORDS).toBe('Delegated work');
  });

  test('a row: title, who did it and where, its dot, and where it came from', () => {
    const rows = delegatedRows({ sessions, ctx, waiting: new Set(['names']) });
    expect(rows[0]).toEqual({ id: 'draft', title: 'Draft the reply', href: '/s/draft', state: 'running', who: 'Assistant on madx', from: 'from Capstone chat' });
    expect(rows[1]).toEqual({ id: 'names', title: 'Find names in the capstone PDFs', href: '/s/names', state: 'waiting', who: 'Code on MadX Arch', from: 'from Capstone chat' });
    expect(rows[2].from).toBe('from Plan my week in Assistant');
    // a parent that is gone leaves the second line out
    expect(delegatedRows({ sessions: [names], ctx })[0].from).toBeUndefined();
    expect(delegatedRows({ sessions, ctx, limit: 1 })).toHaveLength(1);
  });

  test('the words', () => {
    expect(fromWords(chat)).toBe('from Capstone chat');
    expect(fromWords({ ...chat, title: 'New chat' })).toBe('from New chat');
    expect(fromWords(s('c', { title: 'Fix auth' }))).toBe('from Fix auth in Code');
    expect(fromWords(undefined)).toBeUndefined();
    // the device by its name now, else the name the call saw
    expect(delegateWho(names, { devices: {} })).toBe('Code on MadX Arch');
    expect(delegateWho({ ...names, device: 'arch' }, { devices: { arch: { id: 'arch', name: 'arch-renamed' } as never } })).toBe('Code on arch-renamed');
  });
});

describe('after Move to main list', () => {
  const moved = movedSession(names, NOW);
  const after = sessions.map((x) => (x.id === 'names' ? moved : x));

  test('it is in the main list of its kind, not in the group, and keeps its parent', () => {
    expect(moved.parentId).toBe('chat');
    expect(ids(delegatedRows({ sessions: after, ctx }))).toEqual(['draft', 'lisbon']);
    expect(mainIds(after, 'code')).toEqual(['names']);
    expect(modeSessions(after, 'chat').map((x) => x.id)).toEqual(['chat']);
    // the assistant's job moves to the Assistant list
    const asst = sessions.map((x) => (x.id === 'draft' ? movedSession({ ...draft, status: 'idle' }, NOW) : x));
    expect(mainIds(asst, 'assistant')).toEqual(['draft', 'plan']);
  });

  test("the chat's call row still finds it and links to it, with or without the result", () => {
    const call: ToolUseBlock = { type: 'tool_use', id: 'd1', name: 'Delegate', input: { to: 'code', device: 'madx arch', prompt: 'List the names.', description: 'Find names in the capstone PDFs' } };
    const result: ToolResultBlock = { type: 'tool_result', toolUseId: 'd1', content: 'Ada Lovelace', meta: { sessionId: 'names', agent: 'explore', delegate: place('code', 'arch', 'MadX Arch', 'd1') } };
    const sessionsById = Object.fromEntries(after.map((x) => [x.id, x]));
    const done = subagentOf({ tool: call, result }, { sessionId: 'chat', status: 'idle', sessions: sessionsById });
    expect(done).toMatchObject({ state: 'done', childId: 'names', handedTo: 'Code on MadX Arch' });
    // an interrupted call has no result: the session is found by the call id it kept in movedFrom
    const renamed = { ...sessionsById, names: { ...moved, title: 'Capstone names, kept' } };
    expect(subagentOf({ tool: call }, { sessionId: 'chat', status: 'idle', sessions: renamed })).toMatchObject({ childId: 'names', handedTo: 'Code on MadX Arch' });
  });
});

describe('the drawn group', async () => {
  const { DelegatedGroup } = await import('../src/components/Sidebar');
  const actions = { open: () => undefined, dialogs: null };
  const draw = (folded: boolean, phone = false) =>
    renderToStaticMarkup(
      <Router ssrPath="/s/names">
        <DelegatedGroup rows={delegatedRows({ sessions, ctx })} folded={folded} path="/s/names" phone={phone} actions={actions} />
      </Router>,
    );

  test('a "Delegated work" group with the rows, their words, links and menus', () => {
    const out = draw(false);
    expect(out).toContain('aria-label="Delegated work"');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('href="/s/names"');
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('Code on MadX Arch');
    expect(out).toContain('from Capstone chat');
    expect(out).toContain('href="/s/draft"');
    expect(out).toContain('aria-label="Running"');
    expect(out).toContain('aria-label="Actions for Find names in the capstone PDFs"');
    expect(out).not.toContain('href="/s/sub"');
  });

  test('folded, it keeps its heading only; the phone has no ... button', () => {
    const folded = draw(true);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toContain('href="/s/names"');
    expect(draw(false, true)).not.toContain('Actions for');
  });
});
