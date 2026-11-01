import { randomBytes } from 'node:crypto';
import type { Tool } from './types';
import { cellId, findCell, joinSource, parseNotebook, splitSource, type NotebookCell } from './notebook';
import { chatRefusal, extname, fail, readMarkOf, resolveAbsolute, staleCheck, unifiedDiff, pathRule } from './util';

export interface NotebookEditInput {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

const DESCRIPTION = `Change one cell of a Jupyter notebook (.ipynb).

Usage:
- notebook_path is absolute or relative to the working directory. Read the notebook first; the edit is refused if it changed since.
- cell_id identifies the cell: its id as shown by Read, or "cell-N" / N for the 0-based position.
- edit_mode "replace" (default) sets the cell's source to new_source and clears its outputs. Pass cell_type to change the cell's type too.
- edit_mode "insert" adds a new cell after cell_id (or at the top when cell_id is omitted). cell_type is required.
- edit_mode "delete" removes the cell; new_source is ignored (pass an empty string).`;

function newCellId(): string {
  return randomBytes(4).toString('hex');
}

export const NotebookEditTool: Tool<NotebookEditInput> = {
  name: 'NotebookEdit',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Path of the .ipynb file, absolute or relative to the working directory' },
      cell_id: { type: 'string', description: 'Cell id, or "cell-N" for the 0-based position' },
      new_source: { type: 'string', description: 'New source for the cell' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type; required for insert' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'replace (default), insert or delete' },
    },
    required: ['notebook_path', 'new_source'],
    additionalProperties: false,
  },
  readOnly: false,
  editsFiles: true,
  ruleContent: (input, ctx) => pathRule(ctx, input.notebook_path),
  summarize: (input) => `${input.edit_mode ?? 'replace'} cell ${input.cell_id ?? ''} in ${input.notebook_path}`,
  async run(input, ctx) {
    const r = resolveAbsolute(ctx, input.notebook_path, 'notebook_path');
    if ('error' in r) return fail(r.error);
    const path = r.path;
    const refusal = chatRefusal(ctx, path);
    if (refusal) return fail(refusal, { writeRefused: true });
    if (extname(path) !== 'ipynb') return fail(`${path} is not a .ipynb file. Use Edit for other files.`);
    const mode = input.edit_mode ?? 'replace';
    if (!['replace', 'insert', 'delete'].includes(mode)) return fail('edit_mode must be replace, insert or delete.');

    const st = await ctx.machine.stat(path);
    if (!st) return fail(`Notebook does not exist: ${path}`);
    const raw = await ctx.machine.readText(path);
    const stale = staleCheck(ctx, path, st.mtimeMs, 'edit', raw);
    if (stale) return fail(stale, { writeRefused: true });

    let nb;
    try {
      nb = parseNotebook(raw);
    } catch (err) {
      return fail(`Could not parse notebook: ${(err as Error).message}`);
    }
    const withIds = (nb.nbformat ?? 4) > 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) >= 5);
    const source = typeof input.new_source === 'string' ? input.new_source : '';

    let idx = -1;
    if (input.cell_id !== undefined && input.cell_id !== '') {
      idx = findCell(nb, String(input.cell_id));
      if (idx === -1) return fail(`No cell "${input.cell_id}" in ${path} (it has ${nb.cells.length} cells). Use an id shown by Read or "cell-N".`);
    } else if (mode !== 'insert') {
      return fail(`cell_id is required for ${mode}.`);
    }

    let before = '';
    let after = '';
    let label: string;
    let message: string;
    if (mode === 'delete') {
      const [removed] = nb.cells.splice(idx, 1);
      before = joinSource(removed.source);
      label = cellId(removed, idx);
      message = `Deleted cell ${label} from ${path}. ${nb.cells.length} cells remain.`;
    } else if (mode === 'insert') {
      if (!input.cell_type) return fail('cell_type (code or markdown) is required when inserting a cell.');
      const cell: NotebookCell = { cell_type: input.cell_type, metadata: {}, source: splitSource(source) };
      if (withIds) cell.id = newCellId();
      if (input.cell_type === 'code') {
        cell.execution_count = null;
        cell.outputs = [];
      }
      const at = idx === -1 ? 0 : idx + 1;
      nb.cells.splice(at, 0, cell);
      after = source;
      label = cellId(cell, at);
      message = `Inserted ${input.cell_type} cell ${label} at position ${at} in ${path}.`;
    } else {
      const cell = nb.cells[idx];
      before = joinSource(cell.source);
      after = source;
      cell.source = splitSource(source);
      if (input.cell_type && input.cell_type !== cell.cell_type) {
        cell.cell_type = input.cell_type;
        if (input.cell_type === 'markdown') {
          delete cell.outputs;
          delete cell.execution_count;
        }
      }
      if (cell.cell_type === 'code') {
        cell.execution_count = null;
        cell.outputs = [];
      }
      label = cellId(cell, idx);
      message = `Updated cell ${label} in ${path}.`;
    }

    const indent = raw.match(/^\{\s*\n( +)"/)?.[1].length ?? 1;
    const written = JSON.stringify(nb, null, indent) + '\n';
    await ctx.machine.writeFile(path, written);
    const st2 = await ctx.machine.stat(path);
    if (st2) ctx.readState.set(path, st2.mtimeMs);
    return { content: message, meta: { path, diff: unifiedDiff(`${path}#${label}`, before, after), cellId: label, ...(st2 ? { readMark: readMarkOf(path, st2.mtimeMs, written) } : {}) } };
  },
};
