/** Render one transcript item to an ANSI string (pre-wrapped to the width). */
import { truncate, width as strWidth, type Painter } from '../ansi';
import { formatDuration } from '../render/format';
import { renderMarkdown } from '../render/markdown';
import { modelColor, shortModel } from '../render/models';
import { toolPreview, toolTitle } from '../render/tools';
import { indentLines, wrapAnsi } from '../render/wrap';
import type { Item } from './transcript';

export interface RenderCtx {
  width: number;
  painter: Painter;
  showThinking: boolean;
  cwd?: string;
  now?: number;
  /** Full tool output (the ctrl+o transcript) instead of the collapsed summary. */
  expand?: boolean;
}

export const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/** The "⎿" gutter for a line that belongs to the item above it. */
const ELBOW = '  ⎿  ';

/** Blank line above this item? Aside bodies sit flush under their label; notes hang under the turn they belong to. */
export function itemGap(item: Item, prev?: Item): boolean {
  if (item.kind === 'text' && item.aside && prev?.kind === 'label') return false;
  if (item.kind === 'text' && item.cont) return false;
  if (item.kind === 'tool' && item.aside && prev?.kind === 'label') return false;
  if (item.kind === 'info' && item.gap === false) return false;
  if ((item.kind === 'notice' || item.kind === 'stop') && prev && prev.kind !== 'banner' && prev.kind !== 'info') return false;
  return true;
}

export function renderItem(item: Item, ctx: RenderCtx): string {
  const p = ctx.painter;
  const w = Math.max(20, ctx.width);
  switch (item.kind) {
    case 'banner':
      return item.lines.map((l) => truncate(l, w)).join('\n');
    case 'info':
      return item.text;
    case 'user': {
      const body = wrapAnsi(item.text.replace(/\s+$/, ''), w - 2);
      const att = item.attachments ? '\n' + p.dim(`[${item.attachments} attachment${item.attachments === 1 ? '' : 's'}]`) : '';
      return indentLines(body + att, p.dim('> '), '  ');
    }
    case 'label': {
      const c = p.fg(modelColor(item.model));
      return c(p.bold(`◆ ${item.text}`)) + (item.model ? c(` · ${shortModel(item.model)}`) : '');
    }
    case 'text': {
      const md = renderMarkdown(item.text, { width: w - 2, painter: p });
      if (item.aside) {
        const bar = p.fg(modelColor(item.model))('│ ');
        return indentLines(md, bar, bar);
      }
      const dot = item.first ? p.fg(modelColor(item.model))('● ') : '  ';
      // a blank line stays blank (no indent spaces left at its end)
      return indentLines(md, dot, '  ').replace(/^ +$/gm, '');
    }
    case 'thinking': {
      if (!ctx.showThinking) return p.dim(p.italic(item.final ? '✻ Thought' : '✻ Thinking…'));
      const body = wrapAnsi(item.text.trim(), w - 2);
      return p.dim(p.italic('✻ Thinking')) + '\n' + indentLines(p.dim(p.italic(body)), '  ', '  ');
    }
    case 'tool':
      return renderTool(item, ctx);
    case 'notice': {
      const color = item.level === 'error' ? p.red : item.level === 'warning' ? p.yellow : item.level === 'success' ? p.green : p.dim;
      return indentLines(color(wrapAnsi(item.text, w - 5)), p.dim(ELBOW), '     ');
    }
    case 'stop': {
      const color = item.tone === 'error' ? p.red : item.tone === 'warning' ? p.yellow : p.dim;
      const head = color(wrapAnsi(item.title + (item.evidence ? `: ${item.evidence}` : ''), w - 5));
      const body = item.next ? '\n' + p.dim(wrapAnsi(item.next, w - 5)) : '';
      return indentLines(head + body, p.dim(ELBOW), '     ');
    }
    case 'summary': {
      const first = item.text.split('\n').find((l) => l.trim()) ?? '';
      return p.dim(`※ Earlier conversation compacted`) + (first ? '\n' + p.dim(truncate(`  ${first}`, w)) : '');
    }
  }
}

function renderTool(item: Extract<Item, { kind: 'tool' }>, ctx: RenderCtx): string {
  const p = ctx.painter;
  const w = Math.max(20, ctx.width);
  const t = toolTitle(item.name, item.input, ctx.cwd);
  let dot: string;
  switch (item.status) {
    case 'running':
      dot = p.dim('●');
      break;
    case 'pending':
      dot = p.dim('○');
      break;
    case 'waiting':
      dot = p.yellow('●');
      break;
    case 'done':
      dot = p.green('●');
      break;
    case 'error':
      dot = p.red('●');
      break;
    default:
      dot = p.gray('●');
  }
  const gutter = item.aside ? p.fg(modelColor(undefined))('│ ') : '';
  let suffix = '';
  if (item.status === 'running' && item.startedAt) {
    const el = (ctx.now ?? Date.now()) - item.startedAt;
    if (el > 2000) suffix = p.dim(` (${formatDuration(el)})`);
  }
  // "Read(src/app.ts)"; a name that already carries parentheses ("Task(explorer)") takes the detail after a space
  const paren = !t.name.endsWith(')');
  const room = w - strWidth(gutter) - 2 - strWidth(t.name) - 2 - strWidth(suffix);
  const detail = t.detail ? truncate(t.detail, Math.max(8, room)) : '';
  const head = `${gutter}${dot} ${p.bold(t.name)}${detail ? (paren ? `(${detail})` : ` ${detail}`) : ''}${suffix}`;
  const lines: string[] = [];
  if (item.result) lines.push(...toolPreview(item.name, item.result, { painter: p, width: w - 6, input: item.input, expand: ctx.expand }));
  else if (item.status === 'running' && item.progress) {
    const prog = item.progress.replace(/\s+$/, '').split('\n').slice(-3);
    lines.push(...prog.map((l) => p.dim(truncate(l, w - 6))));
  }
  if (!lines.length) return head;
  const body = lines.map((l, i) => (i === 0 ? p.dim(ELBOW) : '     ') + l).join('\n');
  return head + '\n' + (gutter ? indentLines(body, gutter, gutter) : body);
}
