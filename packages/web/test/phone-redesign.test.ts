/**
 * The phone layout (the iPhone app, docs/design/MOBILE-V2.md): where each
 * route sits (a main screen with the menu, a conversation with its own bar,
 * a page with a back arrow), the bar's title, which list New chat starts
 * from, the status sentence offline, the Inbox's results and the short words
 * on the phone approval prompt and its Inbox row.
 *
 *   bun test packages/web/test/phone-redesign.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ApprovalRequest, Session } from '@conclave/core/types';
import { pageTitle } from '../src/components/Shell';
import { phonePlace, phoneTitle, startsCode } from '../src/components/PhoneFrame';
import { statusClauses } from '../src/features/home/status';
import { finishedSince } from '../src/features/home/inbox';
import { approvalLine, approvalSubject, approvalTitle, durationWords } from '../src/components/inbox/ApprovalCard';

describe('phonePlace', () => {
  test('Home, Chats, Code and the Inbox have the menu', () => {
    for (const p of ['/', '/chats', '/sessions', '/sessions?archived', '/approvals', '/inbox']) expect(phonePlace(p)).toBe('main');
  });
  test('a chat and a session draw their own bar', () => {
    expect(phonePlace('/s/s_auth')).toBe('conversation');
    expect(phonePlace('/chat')).toBe('conversation');
    expect(phonePlace('/chat/c_1')).toBe('conversation');
  });
  test('the pages under More and Settings have a back arrow; pages inside them too', () => {
    for (const p of ['/routines', '/workflows', '/workflows/runs', '/tasks', '/memory', '/agents', '/usage', '/devices', '/settings', '/goals', '/extensions']) expect(phonePlace(p)).toBe('page');
    for (const p of ['/settings/remote', '/routines/r_backup', '/agents/coder', '/tasks/t1', '/goals/g1', '/devices/d1/files', '/workflows/runs/r1', '/memory/notes']) expect(phonePlace(p)).toBe('inner');
  });
});

describe('phoneTitle', () => {
  test('the screen in one word, Home none', () => {
    expect(phoneTitle('/').title).toBe('');
    expect(phoneTitle('/chats').title).toBe('Chats');
    expect(phoneTitle('/sessions?archived').title).toBe('Code');
    expect(phoneTitle('/approvals').title).toBe('Inbox');
    // the pages are in Settings' More list on a phone: back goes there
    expect(phoneTitle('/memory')).toEqual({ title: 'Memory', back: '/settings' });
    expect(phoneTitle('/settings')).toEqual({ title: 'Settings', back: '/' });
    expect(phoneTitle('/workflows/runs').title).toBe('Workflows');
  });
  test('an inner page goes back to its page when nothing came before', () => {
    expect(phoneTitle('/settings/remote')).toEqual({ title: 'Settings', back: '/settings' });
    expect(phoneTitle('/routines/new')).toEqual({ title: 'New routine', back: '/routines' });
    expect(phoneTitle('/workflows/runs/r1')).toEqual({ title: 'Run', back: '/workflows' });
  });
  test('New chat starts a session from Code and its sessions, a chat elsewhere', () => {
    expect(startsCode('/sessions')).toBe(true);
    expect(startsCode('/s/x')).toBe(true);
    expect(startsCode('/chats')).toBe(false);
    expect(startsCode('/')).toBe(false);
  });
});

describe('pageTitle', () => {
  test("the window says which page is open: its own title, the nav item's, Home as the product", () => {
    expect(pageTitle('/')).toBe('Conclave');
    expect(pageTitle('/approvals')).toBe('Inbox, Conclave');
    expect(pageTitle('/sessions')).toBe('Sessions, Conclave');
    expect(pageTitle('/s/s_auth', 'Fix login redirect')).toBe('Fix login redirect, Conclave');
    expect(pageTitle('/settings/remote', 'Remote access')).toBe('Remote access, Conclave');
    expect(pageTitle('/settings/remote')).toBe('Settings, Conclave');
  });
});

describe('statusClauses offline', () => {
  test('not known when this app never heard from the hub, else from when', () => {
    const at = new Date(2026, 9, 20, 10, 37).getTime();
    const base = { running: 0, waiting: 0, firstDay: false, limits: [], thresholds: { warn: 70, fault: 90 }, routines: [], now: at };
    expect(statusClauses({ ...base, offline: { name: 'madx' } }).first.map((c) => c.text)).toEqual(["Can't tell what needs you while madx is offline."]);
    expect(statusClauses({ ...base, running: 1, offline: { name: 'madx', at } }).second?.text).toBe('madx is offline, so this is from 10:37.');
  });
});

describe('finishedSince', () => {
  const s = (id: string, p: Partial<Session>): Session => ({ id, title: id, agent: 'coder', model: 'm', device: 'd', cwd: '~', mode: 'agent', status: 'idle', createdAt: 0, updatedAt: 100, stats: { messages: 3 }, ...p }) as Session;
  test('sessions that finished or failed since then, newest first', () => {
    const list = [
      s('done', { updatedAt: 150 }),
      s('failed', { status: 'error', updatedAt: 200 }),
      s('old', { updatedAt: 50 }),
      s('running', { status: 'running', updatedAt: 300 }),
      s('waiting', { status: 'waiting_approval', updatedAt: 300 }),
      s('chat', { kind: 'chat', updatedAt: 300 }),
      s('sub', { parentId: 'done', updatedAt: 300 }),
      s('empty', { stats: { messages: 0 } as Session['stats'], updatedAt: 300 }),
      s('archived', { archived: true, updatedAt: 300 }),
    ];
    expect(finishedSince(list, 100).map((x) => x.id)).toEqual(['failed', 'done']);
  });
});

describe('phone approval words', () => {
  const a = (tool: string, input: Record<string, unknown>): ApprovalRequest => ({ id: 'a', sessionId: 's', tool, input, summary: 'summary', createdAt: 0 }) as ApprovalRequest;
  test('what it wants, in mono where it is a command, a path, a host or a tool', () => {
    expect(approvalSubject(a('Bash', { command: 'git push origin fix/login' }))).toMatchObject({ text: 'git push origin fix/login', mono: true, verb: 'Wants to run' });
    expect(approvalSubject(a('Edit', { file_path: 'src/auth.ts' }))).toMatchObject({ text: 'src/auth.ts', mono: true, verb: 'Wants to edit' });
    expect(approvalSubject(a('Write', { file_path: 'notes.md' })).verb).toBe('Wants to write');
    expect(approvalSubject(a('WebFetch', { url: 'https://example.com/a' }))).toMatchObject({ text: 'https://example.com/a', verb: 'Wants to fetch' });
    expect(approvalSubject(a('mcp__proxmox__list_guests', {}))).toMatchObject({ text: 'proxmox list_guests', verb: 'Wants to use' });
    expect(approvalSubject(a('Task', {}))).toMatchObject({ text: 'summary', mono: false, verb: 'Wants to use Task' });
  });
  test('how long it has waited, short', () => {
    expect(durationWords(42_000)).toBe('42 s');
    expect(durationWords(4 * 60_000 + 5_000)).toBe('4 min');
    expect(durationWords(-5)).toBe('0 s');
    expect(durationWords(65 * 60_000)).toBe('1h 5m');
  });
  test("the prompt's title and the Inbox row's line", () => {
    expect(approvalTitle(a('Bash', { command: 'git push origin fix/login' }))).toBe('Run this command?');
    expect(approvalTitle(a('Edit', { file_path: '/x/src/auth/redirect.ts' }))).toBe('Edit redirect.ts?');
    expect(approvalTitle(a('Write', { file_path: 'notes.md' }))).toBe('Write notes.md?');
    expect(approvalTitle(a('WebFetch', { url: 'https://example.com/a' }))).toBe('Fetch example.com?');
    expect(approvalLine(a('Bash', { command: 'git push origin fix/login' }))).toBe('Wants to run git push');
    expect(approvalLine(a('Edit', { file_path: '/x/src/auth/redirect.ts' }))).toBe('Wants to edit redirect.ts');
    expect(approvalLine(a('WebFetch', { url: 'https://example.com/a' }))).toBe('Wants to fetch example.com');
    expect(approvalLine(a('mcp__proxmox__list_guests', {}))).toBe('Wants to use proxmox list_guests');
    expect(approvalLine(a('Task', {}))).toBe('Wants to use Task');
  });
});
