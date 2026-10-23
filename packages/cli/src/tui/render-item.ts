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
  /** Spinner frame for running tools. */
  frame?: number;
  now?: number;
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Blank line above this item? Aside bodies sit flush under their label. */
export function itemGap(item: Item, prev?: Item): boolean {
  if (item.kind === 'text' && item.aside && prev?.kind === 'label') return false;
  if (item.kind === 'tool' && item.aside && prev?.kind === 'label') return false;
  if (item.kind === 'info' && item.gap === false) return false;
  return true;
}

export function renderItem(item: Item, ctx: RenderCtx): string {
  const p = ctx.painter;
  const w = Math.max(20, ctx.width);
  switch (item.kind) {
    case 'banner': {
      const bw = Math.min(w, 64);
      const inner = bw - 4;
      const row = (l: string) => {
        const t = truncate(l, inner);
        return p.dim('│ ') + t + ' '.repeat(Math.max(0, inner - strWidth(t))) + p.dim(' │');
      };
      return [p.dim('╭' + '─'.repeat(bw - 2) + '╮'), ...item.lines.map(row), p.dim('╰' + '─'.repeat(bw - 2) + '╯')].join('\n');
    }
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
      return indentLines(md, dot, '  ');
    }
    case 'thinking': {
      const words = item.text.trim() ? item.text.trim().split(/\s+/).length : 0;
      if (!ctx.showThinking) {
        const label = item.final ? `✻ Thought · ${words} words` : `✻ Thinking… ${words ? `${words} words` : ''}`;
        return p.dim(p.italic(label)) + p.dim('  ctrl+t to show');
      }
      const body = wrapAnsi(item.text.trim(), w - 2);
      return p.dim(p.italic('✻ Thinking')) + '\n' + indentLines(p.dim(p.italic(body)), '  ', '  ');
    }
    case 'tool':
      return renderTool(item, ctx);
    case 'notice': {
      const color = item.level === 'error' ? p.red : item.level === 'warning' ? p.yellow : item.level === 'success' ? p.green : p.dim;
      return color(wrapAnsi(`· ${item.text}`, w));
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
      dot = p.cyan(SPINNER[(ctx.frame ?? 0) % SPINNER.length]);
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
  const name = p.bold(t.name);
  let suffix = '';
  if (item.status === 'running' && item.startedAt) {
    const el = (ctx.now ?? Date.now()) - item.startedAt;
    if (el > 2000) suffix = p.dim(` (${formatDuration(el)})`);
  }
  if (item.status === 'waiting') suffix = p.yellow(' waiting for approval');
  if (item.status === 'interrupted') suffix = p.dim(' (interrupted)');
  const room = w - strWidth(gutter) - 2 - strWidth(t.name) - 1 - strWidth(suffix);
  const head = `${gutter}${dot} ${name}${t.detail ? ' ' + truncate(t.detail, Math.max(8, room)) : ''}${suffix}`;
  const lines: string[] = [];
  if (item.result) lines.push(...toolPreview(item.name, item.result, { painter: p, width: w - 6, input: item.input }));
  else if (item.status === 'running' && item.progress) {
    const prog = item.progress.replace(/\s+$/, '').split('\n').slice(-3);
    lines.push(...prog.map((l) => p.dim(truncate(l, w - 6))));
  }
  if (!lines.length) return head;
  const body = lines.map((l, i) => (i === 0 ? p.dim('  ⎿  ') : '     ') + l).join('\n');
  return head + '\n' + (gutter ? indentLines(body, gutter, gutter) : body);
}
