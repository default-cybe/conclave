/**
 * A Claude Code chat merged from copies on two devices (core
 * ImportService.mergeDuplicates): the main session's line under its title
 * links every branch with messages of its own; a copy the merge archived as
 * a duplicate is left out of it and of the session lists.
 *
 *   cd packages/web && bun test test/imported-branches.test.tsx
 */
import { expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import { importBranches, isDuplicateCopy } from '../src/features/import/ImportedLine';

const imp = { source: 'claude-code', device: 'mac', path: '/Users/default/.claude/projects/-Users-default-CMU/x.jsonl', id: 'x', importedAt: 1, createdAt: 1 };

function s(id: string, p: Partial<Session>): Session {
  return { id, title: id, agent: 'coder', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', permissionMode: 'default', cwd: '/w', device: 'mac', status: 'idle', tags: ['imported', 'claude-code'], pinned: false, archived: true, createdAt: 1, updatedAt: 1, stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, meta: { import: imp }, ...p } as Session;
}

test('the main session links its branches, not the archived duplicate', () => {
  const main = s('main', { title: 'Research Chat' });
  const branch = s('br', { parentId: 'main', title: 'Branch from mac: so whats next?', meta: { import: imp, branchOf: 'main' } });
  const dup = s('dup', { parentId: 'main', title: 'Continued in Claude Code on arch', meta: { import: { ...imp, duplicateOf: 'main' } } });
  const sub = s('sub', { parentId: 'main', tags: ['subagent'] });
  expect(importBranches({ main, br: branch, dup, sub }, 'main').map((x) => x.id)).toEqual(['br']);
  expect(isDuplicateCopy(dup)).toBe(true);
  expect(isDuplicateCopy(main)).toBe(false);
});
