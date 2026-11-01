/**
 * The line under each import in Memory, Import and export, Recent imports
 * (features/import/words.ts): learned facts the owner's own notes already
 * state are counted there, and an older hub that does not send the count
 * shows the line as before.
 *
 *   bun test packages/web/test/import-words.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ImportBatch } from '@conclave/core/client';
import { batchCounts } from '../src/features/import/words';

const batch = (b: Partial<ImportBatch>): ImportBatch => ({
  id: 'imp_1',
  device: 'local',
  mode: 'chats-learn',
  status: 'done',
  total: 12,
  imported: 12,
  updated: 0,
  forked: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  learnedSessions: 12,
  memoriesAdded: 9,
  memoriesMerged: 2,
  memoriesReview: 1,
  dropped: {},
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  createdAt: 0,
  updatedAt: 0,
  ...b,
});

describe('import results', () => {
  test('say how many learned facts were already in your notes', () => {
    expect(batchCounts(batch({ memoriesInNotes: 4 }))).toEqual(['12 imported', '12 chats read', '9 memories', '2 merged', '4 already in your notes', '1 to review']);
  });

  test('leave it out when there were none, or the hub is older', () => {
    expect(batchCounts(batch({ memoriesInNotes: 0 })).join(', ')).not.toContain('notes');
    expect(batchCounts(batch({})).join(', ')).not.toContain('notes');
    // a chats only import learns nothing, so it never says it
    expect(batchCounts(batch({ mode: 'chats', memoriesInNotes: 3 })).join(', ')).not.toContain('notes');
  });
});
