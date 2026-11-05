/**
 * Canvas's node menu (right-click, or a long-press on touch): the rows in
 * their fixed order, only the ones a file offers, and Open in code's address.
 *
 *   bun test packages/web/test/canvas-node-menu.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { nodeMenuItems } from '../src/features/graph/GraphCanvas';
import { codeHref } from '../src/features/canvas/model';

const noop = () => {};

describe('node menu rows', () => {
  test('every action: Rename, Duplicate, Delete, Open in code, Run from here, Delete marked danger', () => {
    const items = nodeMenuItems({ runFrom: noop, openCode: noop, remove: noop, duplicate: noop, rename: noop });
    expect(items.map((i) => i.label)).toEqual(['Rename', 'Duplicate', 'Delete', 'Open in code', 'Run from here']);
    expect(items.filter((i) => i.danger).map((i) => i.label)).toEqual(['Delete']);
  });

  test('a read-only workflow: only what it offers, so no Rename or Delete', () => {
    expect(nodeMenuItems({ openCode: noop, runFrom: noop }).map((i) => i.label)).toEqual(['Open in code', 'Run from here']);
  });

  test('nothing offered: no rows, so no menu opens', () => {
    expect(nodeMenuItems({})).toEqual([]);
  });

  test('a row runs its action', () => {
    let hit = '';
    const items = nodeMenuItems({ duplicate: () => (hit = 'dup'), rename: () => (hit = 'ren') });
    items[1].onSelect?.();
    expect(hit).toBe('dup');
  });
});

describe('Open in code', () => {
  test('a program opens in its device file browser, in its flows folder', () => {
    expect(codeHref('arch desktop', '~/code/conclave/flows/fetch.flow.ts')).toBe('/devices/arch%20desktop/files?path=%7E%2Fcode%2Fconclave%2Fflows&file=%7E%2Fcode%2Fconclave%2Fflows%2Ffetch.flow.ts');
  });

  test('a workflow of yours opens on the hub', () => {
    const href = codeHref('local', '/home/me/.conclave/workflows/review.ts')!;
    const q = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/devices/local/files?')).toBe(true);
    expect(q.get('path')).toBe('/home/me/.conclave/workflows');
    expect(q.get('file')).toBe('/home/me/.conclave/workflows/review.ts');
  });

  test('a built-in workflow, no path or no device: nothing to open', () => {
    expect(codeHref('local', 'builtin:review')).toBeUndefined();
    expect(codeHref('local', undefined)).toBeUndefined();
    expect(codeHref('', '/a/b.ts')).toBeUndefined();
  });
});
