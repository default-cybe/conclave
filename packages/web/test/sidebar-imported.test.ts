/**
 * Imported chats in the sidebar (core session/imported.ts): a group of their
 * own after the mode's groups, newest first by their original date, with the
 * source and that date; a continued one goes back to its date group.
 */
import { expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import { continuedPatch, splitAttached } from '@conclave/core/session/imported';
import { sideGroups } from '../src/lib/sidebar';

const NOW = new Date(2026, 9, 22, 15, 0).getTime();
const DAY = 86_400_000;

function chat(id: string, p: Partial<Session>): Session {
  return { id, title: id, agent: 'chat', kind: 'chat', model: 'm', mode: 'agent', permissionMode: 'default', cwd: '~', device: 'local', status: 'idle', tags: [], pinned: false, archived: false, createdAt: NOW - DAY, updatedAt: NOW - 60_000, stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, ...p };
}

const imp = (id: string, at: number, source = 'claude-ai') => chat(id, { archived: true, tags: ['imported', source], createdAt: at, updatedAt: at, meta: { import: { source, createdAt: at, importedAt: NOW - 1000 } } });

test('imported chats group last, newest first, with source and date; they never land in Today', () => {
  const sessions = [chat('mine', {}), imp('old', NOW - 200 * DAY), imp('new', NOW - 30 * DAY, 'chatgpt'), chat('archived', { archived: true }), { ...imp('dup', NOW), meta: { import: { source: 'claude-ai', duplicateOf: 'old' } } }];
  const groups = sideGroups({ sessions, mode: 'chat', by: 'time', ctx: { projects: {}, devices: {} }, now: NOW });
  expect(groups.map((g) => g.key)).toEqual(['today', 'imported']);
  const last = groups.at(-1)!;
  expect(last.label).toBe('Imported');
  expect(last.rows.map((r) => r.id)).toEqual(['new', 'old']);
  // the ICU in use writes Sep or Sept
  expect(last.rows[0].device).toMatch(new RegExp(`^ChatGPT, ${new Date(NOW - 30 * DAY).getDate()} Sept?$`));
  // in Code mode a chat import does not show
  expect(sideGroups({ sessions, mode: 'code', by: 'time', ctx: { projects: {}, devices: {} }, now: NOW }).some((g) => g.key === 'imported')).toBe(false);
});

test('a continued imported chat leaves Imported for its date group', () => {
  const s = imp('cont', NOW - 200 * DAY);
  const next = { ...s, ...continuedPatch(s, NOW), updatedAt: NOW - 1000 };
  const groups = sideGroups({ sessions: [next], mode: 'chat', by: 'time', ctx: { projects: {}, devices: {} }, now: NOW });
  expect(groups.map((g) => g.key)).toEqual(['today']);
});

test('attachments split into file chips, the typed words stay', () => {
  expect(splitAttached([{ type: 'text', text: 'Chart this.' }, { type: 'text', text: '[Attached sales.csv]\nmonth,total' }, { type: 'text', text: '[Attached logo.png]' }])).toEqual({ text: 'Chart this.', files: ['sales.csv', 'logo.png'] });
});
