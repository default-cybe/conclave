import type { ImageBlock, TextBlock } from '../types';
import { stripAnsi } from './util';

/** Minimal nbformat 4 shapes. */
export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  id?: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: NotebookOutput[];
  attachments?: unknown;
}

export interface NotebookOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, any>;
  nbformat?: number;
  nbformat_minor?: number;
}

export function joinSource(src: string | string[] | undefined): string {
  if (!src) return '';
  return Array.isArray(src) ? src.join('') : src;
}

/** nbformat stores source as lines that keep their trailing newline. */
export function splitSource(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  return parts.map((p, i) => (i < parts.length - 1 ? p + '\n' : p)).filter((p, i, arr) => !(i === arr.length - 1 && p === ''));
}

export function parseNotebook(text: string): Notebook {
  const nb = JSON.parse(text) as Notebook;
  if (!nb || !Array.isArray(nb.cells)) throw new Error('Not a Jupyter notebook: missing "cells" array');
  return nb;
}

export function cellId(cell: NotebookCell, index: number): string {
  return cell.id ?? `cell-${index}`;
}

/** Find a cell by its id, "cell-N", or a bare index. */
export function findCell(nb: Notebook, id: string): number {
  const byId = nb.cells.findIndex((c) => c.id === id);
  if (byId !== -1) return byId;
  const m = id.match(/^(?:cell-)?(\d+)$/);
  if (m) {
    const idx = Number(m[1]);
    if (idx >= 0 && idx < nb.cells.length) return idx;
  }
  return -1;
}

const MAX_OUTPUT_CHARS = 4000;
const MAX_IMAGES = 5;

/** Render a notebook as text plus any image outputs. */
export function renderNotebook(nb: Notebook, path: string): Array<TextBlock | ImageBlock> {
  const lang = nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? 'python';
  const parts: string[] = [`Notebook ${path} (${nb.cells.length} cells, language: ${lang})`, ''];
  const images: ImageBlock[] = [];
  nb.cells.forEach((cell, i) => {
    const exec = cell.cell_type === 'code' && cell.execution_count != null ? ` exec="${cell.execution_count}"` : '';
    parts.push(`<cell id="${cellId(cell, i)}" index="${i}" type="${cell.cell_type}"${exec}>`);
    parts.push(joinSource(cell.source));
    parts.push('</cell>');
    const outs = cell.outputs ?? [];
    if (outs.length) {
      const rendered: string[] = [];
      for (const out of outs) {
        if (out.output_type === 'stream') rendered.push(joinSource(out.text));
        else if (out.output_type === 'error') {
          rendered.push(`${out.ename}: ${out.evalue}`);
          if (out.traceback?.length) rendered.push(stripAnsi(out.traceback.join('\n')));
        } else if (out.data) {
          const png = out.data['image/png'];
          const jpeg = out.data['image/jpeg'];
          if ((png || jpeg) && images.length < MAX_IMAGES) {
            images.push({ type: 'image', mediaType: png ? 'image/png' : 'image/jpeg', data: joinSource(png ?? jpeg).replace(/\s+/g, '') });
            rendered.push(`[image output ${images.length}]`);
          }
          const text = out.data['text/plain'] ?? out.data['text/markdown'];
          if (text) rendered.push(joinSource(text));
          else if (out.data['text/html'] && !png && !jpeg) rendered.push('[html output]');
        }
      }
      let text = stripAnsi(rendered.join('\n').trimEnd());
      if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[... output truncated, ${text.length} chars total]`;
      if (text) parts.push(`<output cell="${cellId(cell, i)}">`, text, '</output>');
    }
    parts.push('');
  });
  return [{ type: 'text', text: parts.join('\n') }, ...images];
}
