import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadTool } from '../../src/tools/read';
import { NotebookEditTool } from '../../src/tools/notebook-edit';
import { makeCtx, tempDir, text } from './helpers';

const { dir, cleanup } = tempDir();
afterAll(cleanup);

const NB = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { language: 'python', name: 'python3' } },
  cells: [
    { cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# Title\n', 'Some text'] },
    {
      cell_type: 'code',
      id: 'calc',
      metadata: {},
      execution_count: 1,
      source: ['x = 1 + 1\n', 'print(x)'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['2\n'] }],
    },
  ],
};

describe('notebooks', () => {
  test('Read renders cells and outputs', async () => {
    const p = join(dir, 'a.ipynb');
    writeFileSync(p, JSON.stringify(NB, null, 1));
    const out = await ReadTool.run({ file_path: p }, makeCtx({ cwd: dir }));
    const t = text(out);
    expect(t).toContain('<cell id="intro" index="0" type="markdown">');
    expect(t).toContain('print(x)');
    expect(t).toContain('<output cell="calc">\n2');
  });

  test('NotebookEdit replace, insert, delete', async () => {
    const p = join(dir, 'b.ipynb');
    writeFileSync(p, JSON.stringify(NB, null, 1));
    const ctx = makeCtx({ cwd: dir });
    expect((await NotebookEditTool.run({ notebook_path: p, cell_id: 'calc', new_source: 'y = 3' }, ctx)).isError).toBe(true);

    await ReadTool.run({ file_path: p }, ctx);
    const rep = await NotebookEditTool.run({ notebook_path: p, cell_id: 'calc', new_source: 'y = 3\nprint(y)' }, ctx);
    expect(rep.isError).toBeFalsy();
    let nb = JSON.parse(readFileSync(p, 'utf8'));
    expect(nb.cells[1].source).toEqual(['y = 3\n', 'print(y)']);
    expect(nb.cells[1].outputs).toEqual([]);
    expect(nb.cells[1].execution_count).toBeNull();

    const ins = await NotebookEditTool.run({ notebook_path: p, cell_id: 'cell-0', new_source: 'import os', cell_type: 'code', edit_mode: 'insert' }, ctx);
    expect(ins.isError).toBeFalsy();
    nb = JSON.parse(readFileSync(p, 'utf8'));
    expect(nb.cells.length).toBe(3);
    expect(nb.cells[1].source).toEqual(['import os']);
    expect(typeof nb.cells[1].id).toBe('string');

    const del = await NotebookEditTool.run({ notebook_path: p, cell_id: 'intro', new_source: '', edit_mode: 'delete' }, ctx);
    expect(del.isError).toBeFalsy();
    nb = JSON.parse(readFileSync(p, 'utf8'));
    expect(nb.cells.map((c: any) => c.id)).not.toContain('intro');

    const missing = await NotebookEditTool.run({ notebook_path: p, cell_id: 'nope', new_source: 'x' }, ctx);
    expect(missing.isError).toBe(true);
  });
});
