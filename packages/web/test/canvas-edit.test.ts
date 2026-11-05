/**
 * Canvas mode, PR 2 (docs/design/CANVAS-MODE.md 5 and 6, features/canvas/
 * editor.ts, core flows/ports.ts): typed ports refuse a wire with a short
 * reason, and each edit (insert, wire, delete, multi-delete, copy and paste,
 * rename, a setting) runs on the hub's real flow ops, saves at once, is one
 * undo, and a file changed on disk reloads instead of being written over.
 *
 *   bun test packages/web/test/canvas-edit.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { ApiError, type FlowOp } from '@conclave/core/client';
import { applyFlowOp, parseFlow } from '@conclave/core/flows/graph';
import { BLOCK_BY_NAME } from '@conclave/core/flows/plugins';
import { givesType, typeRefusal, wireRefusal } from '@conclave/core/flows/ports';
import { CONFLICT, FileEditor, copyClip, pasteClip, programRenamable, removeOps, saveWords, workflowRenamable, type SaveState } from '../src/features/canvas/editor';
import { SCRAPER_FLOW } from '../src/mock/flows';

const FLOW = `import { fetchUrl, pick, joinText, map, shell, regex } from './lib';

const url = 'https://example.com/api';
const data = await fetchUrl({ url, as: 'json', method: 'GET' });
const page = await fetchUrl({ url, as: 'text', method: 'GET' });
const titles = await map({ items: data, field: 'title' });
const out = await shell({ command: 'ls' });
const one = await regex({ text: page, pattern: 'a', flags: 'g', many: false });
const joined = await joinText({ items: titles, sep: ', ' });
`;

const node = (src: string, id: string) => parseFlow(src).nodes.find((n) => n.id === id)!;
const defaults = (b: string, i: string) => BLOCK_BY_NAME.get(b)?.inputs.find((x) => x.name === i)?.default;

/** A hub in memory: the real flow ops, versions by sha, 409 when the base is stale. */
function hub(start: string) {
  let src = start;
  let n = 1;
  const versions = new Map([['v1', src]]);
  const view = () => ({ sha: `v${n}`, src, graph: parseFlow(src) });
  return {
    get src() {
      return src;
    },
    view,
    /** Someone else writes the file. */
    outside(next: string) {
      src = next;
      n++;
      versions.set(`v${n}`, src);
    },
    async op(op: FlowOp, base: string) {
      if (base !== `v${n}`) throw new ApiError(409, 'script changed: the file changed since the graph was read; reload it');
      const r = applyFlowOp(src, op);
      src = r.src;
      n++;
      versions.set(`v${n}`, src);
      return { ...view(), nodeId: r.nodeId };
    },
    async restore(sha: string, base: string) {
      if (base !== `v${n}`) throw new ApiError(409, 'script changed');
      src = versions.get(sha)!;
      n++;
      versions.set(`v${n}`, src);
      return view();
    },
  };
}

function editor(h: ReturnType<typeof hub>) {
  const states: SaveState[] = [];
  let shown = h.view();
  const ed = new FileEditor({ show: (v) => (shown = v), restore: (s, b) => h.restore(s, b), reload: async () => h.view(), status: (s) => states.push(s) });
  ed.shows(shown.sha);
  const ops = (label: string, list: FlowOp[] | ((send: (op: FlowOp) => Promise<{ nodeId?: string }>) => Promise<unknown>)) =>
    ed.edit(label, async (base, took) => {
      const send = async (op: FlowOp) => {
        const r = await h.op(op, base());
        took(r);
        return r;
      };
      if (typeof list === 'function') await list(send);
      else for (const op of list) await send(op);
    });
  return { ed, ops, states, shown: () => shown };
}

describe('typed ports', () => {
  test('output types come from the catalog, and a setting decides Fetch URL and Regex', () => {
    expect(givesType(node(FLOW, 'data'))).toBe('any');
    expect(givesType(node(FLOW, 'page'))).toBe('text');
    expect(givesType(node(FLOW, 'titles'))).toBe('list');
    expect(givesType(node(FLOW, 'out'))).toBe('record');
    expect(givesType(node(FLOW, 'one'))).toBe('text');
    expect(givesType(node(FLOW, 'url'))).toBe('text');
  });

  test('a list into a text input is refused with a short reason and a way out', () => {
    expect(typeRefusal(node(FLOW, 'titles'), node(FLOW, 'page'), 'url')).toBe('url takes text; titles gives a list. Join text makes a list one text.');
    expect(typeRefusal(node(FLOW, 'out'), node(FLOW, 'titles'), 'items')).toBe('items takes a list; out gives a record. Pick field takes one field of it.');
    expect(typeRefusal(node(FLOW, 'page'), node(FLOW, 'titles'), 'items')).toBe('items takes a list; page gives text.');
  });

  test('unknown types, matching types and a field are allowed', () => {
    expect(typeRefusal(node(FLOW, 'data'), node(FLOW, 'titles'), 'items')).toBeUndefined();
    expect(typeRefusal(node(FLOW, 'titles'), node(FLOW, 'joined'), 'items')).toBeUndefined();
    expect(typeRefusal(node(FLOW, 'out'), node(FLOW, 'page'), 'url', 'stdout')).toBeUndefined();
  });

  test('the canvas check also refuses settings, forward wires and self wires', () => {
    const g = parseFlow(FLOW);
    expect(wireRefusal(g, 'joined', 'titles', 'items')).toBe('joined comes after titles; a wire runs from an earlier block.');
    expect(wireRefusal(g, 'url', 'data', 'as')).toBe('as is a setting; pick it on the block.');
    expect(wireRefusal(g, 'titles', 'titles', 'items')).toBe('A block cannot read its own value.');
    expect(wireRefusal(g, 'titles', 'one', 'text')).toBe('text takes text; titles gives a list. Join text makes a list one text.');
    expect(wireRefusal(g, 'data', 'titles', 'items')).toBeUndefined();
  });

  test('the hub refuses the same wire in a connect op, so a hand-made request cannot skip it', () => {
    expect(() => applyFlowOp(FLOW, { op: 'connect', nodeId: 'one', input: 'text', from: 'titles' })).toThrow('text takes text; titles gives a list');
    expect(applyFlowOp(FLOW, { op: 'connect', nodeId: 'joined', input: 'items', from: 'titles' }).src).toBe(FLOW);
  });
});

describe('editing a program', () => {
  test('insert where dropped: one op, saved, one undo and redo', async () => {
    const h = hub(SCRAPER_FLOW);
    const e = editor(h);
    await e.ops('new block', [{ op: 'insert', block: 'joinText' }]);
    expect(h.src).toContain('const joined = await joinText(');
    expect(e.states.map((s) => s.kind)).toEqual(['saving', 'saved']);
    expect(e.ed.history.past.map((s) => s.label)).toEqual(['new block']);
    await e.ed.history.undo();
    expect(h.src).toBe(SCRAPER_FLOW);
    await e.ed.history.redo();
    expect(h.src).toContain('const joined = await joinText(');
  });

  test('wire, then a refused wire: the refusal says why and leaves no undo step', async () => {
    const h = hub(SCRAPER_FLOW);
    const e = editor(h);
    await e.ops('new block', [{ op: 'insert', block: 'joinText' }]);
    await e.ops('wire', [{ op: 'connect', nodeId: 'joined', input: 'items', from: 'bun' }]);
    expect(h.src).toContain('joinText({ items: bun,');
    const before = h.src;
    await e.ops('wire', [{ op: 'connect', nodeId: 'data', input: 'url', from: 'posts' }]);
    expect(h.src).toBe(before);
    expect(e.states.at(-1)).toEqual({ kind: 'failed', reason: 'posts is not set above data; a wire comes from an earlier block' });
    expect(e.ed.history.past.length).toBe(2);
  });

  test('a setting from the inspector saves at once and undoes', async () => {
    const h = hub(SCRAPER_FLOW);
    const e = editor(h);
    await e.ops('field', [{ op: 'set', nodeId: 'posts', input: 'field', value: 'items' }]);
    expect(h.src).toContain("pick({ from: data, field: 'items' })");
    await e.ed.history.undo();
    expect(h.src).toBe(SCRAPER_FLOW);
  });

  test('rename inline: every read follows; programs rename blocks, workflows labelled agents', async () => {
    const h = hub(SCRAPER_FLOW);
    const e = editor(h);
    await e.ops('rename', [{ op: 'rename', nodeId: 'posts', name: 'hits' }]);
    expect(h.src).toContain('const hits = await pick(');
    expect(h.src).toContain('filter({ items: hits,');
    expect(programRenamable(node(h.src, 'hits'))).toBe(true);
    expect(programRenamable(node(h.src, 'code-1'))).toBe(false);
    expect(workflowRenamable({ kind: 'agent', opts: { label: { value: 'x', start: 0, end: 1 } } } as never)).toBe(true);
    expect(workflowRenamable({ kind: 'agent', opts: {} } as never)).toBe(false);
  });

  test('multi-delete removes last first and is one undo', async () => {
    const h = hub(SCRAPER_FLOW);
    const e = editor(h);
    const ops = removeOps(parseFlow(h.src), ['log-1', 'code-1']);
    expect(ops).toEqual([
      { op: 'remove', nodeId: 'log-1' },
      { op: 'remove', nodeId: 'code-1' },
    ]);
    await e.ops('remove 2 blocks', ops);
    expect(parseFlow(h.src).nodes.map((n) => n.id)).toEqual(['url', 'data', 'posts', 'bun', 'csv']);
    expect(e.ed.history.past.length).toBe(1);
    await e.ed.history.undo();
    expect(h.src).toBe(SCRAPER_FLOW);
  });

  test('copy and paste: blocks only, settings kept, a wire inside the paste goes to the copy', async () => {
    const h = hub(SCRAPER_FLOW);
    const e = editor(h);
    const clip = copyClip('f', parseFlow(h.src), ['posts', 'bun', 'code-1']);
    expect(clip.blocks.map((b) => b.block)).toEqual(['pick', 'filter']);
    expect(clip.skipped).toBe(1);
    let made: string[] = [];
    await e.ops('paste', async (send) => (made = await pasteClip(clip, send, defaults)));
    expect(made).toEqual(['picked', 'kept']);
    expect(h.src).toContain("const picked = await pick({ from: data, field: 'hits' });");
    expect(h.src).toContain("const kept = await filter({ items: picked, field: 'title', op: 'contains', value: 'bun' });");
    expect(e.ed.history.past.length).toBe(1);
    await e.ed.history.undo();
    expect(h.src).toBe(SCRAPER_FLOW);
  });

  test('the file changed on disk: the edit is not written, the canvas reloads and says so, undo starts over', async () => {
    const h = hub(SCRAPER_FLOW);
    const e = editor(h);
    await e.ops('field', [{ op: 'set', nodeId: 'posts', input: 'field', value: 'items' }]);
    const theirs = h.src.replace("'out/posts.csv'", "'out/theirs.csv'");
    h.outside(theirs);
    await e.ops('field', [{ op: 'set', nodeId: 'posts', input: 'field', value: 'nope' }]);
    expect(h.src).toBe(theirs);
    expect(e.shown().src).toBe(theirs);
    expect(e.states.at(-1)).toEqual({ kind: 'failed', reason: CONFLICT });
    expect(e.ed.history.past.length).toBe(0);
    // the next edit goes on the version it reloaded
    await e.ops('field', [{ op: 'set', nodeId: 'posts', input: 'field', value: 'x' }]);
    expect(h.src).toContain("'out/theirs.csv'");
    expect(h.src).toContain("field: 'x'");
  });

  test('status words', () => {
    expect(saveWords({ kind: 'saved' }).word).toBe('Saved');
    expect(saveWords({ kind: 'saving' }).word).toBe('Saving');
    expect(saveWords({ kind: 'failed', reason: 'no node x' })).toEqual({ word: 'Not saved: no node x', tone: 'text-fault' });
  });
});
