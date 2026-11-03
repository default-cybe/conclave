/**
 * Canvas undo and redo (features/graph/history.ts): steps go back and
 * forward in order, a new edit clears redo, and a step that fails stays on
 * its stack.
 *
 *   bun test packages/web/test/graph-history.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { History, insertStep } from '../src/features/graph/history';

describe('History', () => {
  test('undo, redo, and a new edit clears redo', async () => {
    let x = 0;
    const h = new History();
    const set = (from: number, to: number) => ({ label: `${from}>${to}`, undo: async () => void (x = from), redo: async () => void (x = to) });
    x = 1;
    h.push(set(0, 1));
    x = 2;
    h.push(set(1, 2));
    await h.undo();
    expect(x).toBe(1);
    await h.undo();
    expect(x).toBe(0);
    expect(await h.undo()).toBeUndefined();
    await h.redo();
    expect(x).toBe(1);
    x = 5;
    h.push(set(1, 5));
    expect(h.future).toEqual([]);
    await h.undo();
    expect(x).toBe(1);
  });

  test('undoing a node added over saved positions puts the old layout keys back after the old script', async () => {
    const log: string[] = [];
    const restore = async (sha: string) => void log.push(`restore ${sha}`);
    const save = async (p: Record<string, { x: number; y: number }>) => void log.push(`layout ${Object.keys(p).join(',')}`);
    const h = new History();
    h.push(insertStep(restore, save, { sha: 'v1', layout: { 'agent-2': { x: 80, y: 80 } } }, { sha: 'v2', layout: { 'agent-3': { x: 80, y: 80 } } }));
    await h.undo();
    await h.redo();
    expect(log).toEqual(['restore v1', 'layout agent-2', 'restore v2', 'layout agent-3']);
    // no saved positions: the script only, no side file written
    log.length = 0;
    h.push(insertStep(restore, save, { sha: 'v2', layout: {} }, { sha: 'v3' }));
    await h.undo();
    expect(log).toEqual(['restore v2']);
  });

  test('a step that fails stays where it was', async () => {
    const h = new History();
    let fail = true;
    h.push({ label: 'edit', undo: async () => (fail ? Promise.reject(new Error('script changed')) : undefined), redo: async () => undefined });
    await expect(h.undo()).rejects.toThrow('script changed');
    expect(h.past.length).toBe(1);
    expect(h.busy).toBe(false);
    fail = false;
    await h.undo();
    expect(h.past.length).toBe(0);
    expect(h.future.length).toBe(1);
  });
});
