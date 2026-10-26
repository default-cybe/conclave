/** One-line tool titles ("Read src/app.ts") and short result previews. */
import type { Todo, ToolResultBlock } from '@conclave/core/types.ts';
import { truncate, visible, type Painter } from '../ansi';
import { colorDiff, diffStats, simpleDiff } from './diff';
import { displayPath, formatDuration, plural } from './format';

export interface ToolTitle {
  name: string;
  detail: string;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim()) ?? '';
}

export function toolTitle(name: string, input: Record<string, unknown> = {}, cwd?: string): ToolTitle {
  const path = (k: string) => displayPath(s(input[k]), cwd);
  switch (name) {
    case 'Read': {
      let d = path('file_path') || path('path');
      if (input.offset || input.limit) {
        const from = Number(input.offset ?? 1);
        d += input.limit ? ` (lines ${from}-${from + Number(input.limit) - 1})` : ` (from line ${from})`;
      }
      return { name, detail: d };
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { name: name === 'MultiEdit' ? 'Edit' : name, detail: path('file_path') || path('notebook_path') || path('path') };
    case 'Bash':
      return { name, detail: firstLine(s(input.command)) + (s(input.command).includes('\n') ? ' …' : '') };
    case 'BashOutput':
      return { name: 'Shell output', detail: s(input.bash_id ?? input.shell_id) };
    case 'KillShell':
      return { name: 'Kill shell', detail: s(input.shell_id ?? input.bash_id) };
    case 'Glob':
      return { name, detail: s(input.pattern) + (input.path ? ` in ${path('path')}` : '') };
    case 'Grep':
      return { name, detail: `"${s(input.pattern)}"` + (input.path ? ` in ${path('path')}` : '') + (input.glob ? ` (${s(input.glob)})` : '') };
    case 'LS':
      return { name: 'List', detail: path('path') || '.' };
    case 'WebFetch':
      return { name: 'Fetch', detail: s(input.url) };
    case 'WebSearch':
      return { name: 'Search', detail: s(input.query) };
    case 'Task':
    case 'Agent':
      return { name: s(input.subagent_type) ? `Task(${s(input.subagent_type)})` : 'Task', detail: s(input.description) || firstLine(s(input.prompt)) };
    case 'Workflow':
      return { name: 'Workflow', detail: s(input.name) || displayPath(s(input.scriptPath), cwd) || (input.resumeFromRunId ? `resume ${s(input.resumeFromRunId)}` : 'script') };
    case 'Delegate':
      return { name: s(input.to) ? `Delegate(${s(input.to)})` : 'Delegate', detail: s(input.description) || firstLine(s(input.prompt)) };
    case 'TodoWrite':
      return { name: 'Update todos', detail: '' };
    case 'Skill':
      return { name: 'Skill', detail: s(input.skill ?? input.name ?? input.command) };
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as Array<{ question?: string }>) : [];
      return { name: 'Question', detail: qs[0]?.question ?? '' };
    }
    case 'ReadToolOutput':
      return { name: 'Read output', detail: s(input.id) };
    case 'ExitPlanMode':
      return { name: 'Plan ready', detail: '' };
    default: {
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { name: `${server} · ${rest.join('__')}`, detail: firstStringArg(input) };
      }
      return { name, detail: firstStringArg(input) };
    }
  }
}

function firstStringArg(input: Record<string, unknown>): string {
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return firstLine(v);
  return '';
}

export function resultText(result: ToolResultBlock | undefined): string {
  if (!result) return '';
  if (typeof result.content === 'string') return result.content;
  return result.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

function moreLines(lines: string[], max: number, p: Painter, width: number): string[] {
  const shown = lines.slice(0, max).map((l) => truncate(l, width));
  if (lines.length > max) shown.push(p.dim(`… +${lines.length - max} lines`));
  return shown;
}

export interface PreviewOptions {
  painter: Painter;
  width: number;
  /** Diff lines before collapsing. */
  diffLines?: number;
  input?: Record<string, unknown>;
}

/** Lines shown under a finished tool call, without the "⎿" gutter. */
export function toolPreview(name: string, result: ToolResultBlock, opts: PreviewOptions): string[] {
  const p = opts.painter;
  const text = resultText(result).replace(/\s+$/, '');
  const meta = result.meta ?? {};
  const w = Math.max(20, opts.width);
  if (result.isError) {
    const lines = text.split('\n').filter((l) => l.trim());
    return moreLines(lines.length ? lines : ['Error'], 3, p, w).map((l) => p.red(l));
  }
  switch (name) {
    case 'Bash': {
      const lines = text.split('\n');
      if (!text || text === '(no output)') return [p.dim('(no output)')];
      const out = moreLines(lines, 3, p, w);
      if (typeof meta.durationMs === 'number' && meta.durationMs > 5000) out.push(p.dim(`took ${formatDuration(meta.durationMs)}`));
      return out;
    }
    case 'Grep': {
      if (/^No (matches|files)/i.test(text)) return [p.dim(firstLine(text))];
      const head = firstLine(text);
      if (/^Found \d+|^\d+ matches/.test(head)) return [head];
      const total = typeof meta.total === 'number' ? meta.total : text.split('\n').filter((l) => l.trim() && !l.startsWith('(')).length;
      return [`Found ${plural(total, 'line')}`];
    }
    case 'Glob': {
      if (/^No files/i.test(text)) return [p.dim(firstLine(text))];
      const count = typeof meta.count === 'number' ? meta.count : text.split('\n').filter((l) => l.trim() && !l.startsWith('(')).length;
      return [`Found ${plural(count, 'file')}${meta.truncated ? '+' : ''}`];
    }
    case 'LS': {
      const n = text.split('\n').filter((l) => l.trim()).length;
      return [`Listed ${plural(n, 'entry', 'entries')}`];
    }
    case 'Read': {
      if (Array.isArray(result.content) && result.content.some((b) => b.type === 'image')) return ['Read image'];
      const numbered = text.split('\n').filter((l) => /^\s*\d+[\t→│|]/.test(l)).length;
      if (numbered) return [`Read ${plural(numbered, 'line')}` + (meta.truncated && typeof meta.lines === 'number' ? p.dim(` of ${meta.lines}`) : '')];
      return [p.dim(truncate(firstLine(text), w))];
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const diff = typeof meta.diff === 'string' ? meta.diff : '';
      if (diff) {
        const st = diffStats(diff);
        const summary = meta.created
          ? `Created with ${plural(st.added, 'line')}`
          : `${p.green('+' + st.added)} ${p.red('-' + st.removed)}`;
        return [summary, ...colorDiff(diff, { painter: p, maxLines: opts.diffLines ?? 20 }).split('\n')];
      }
      if (name === 'Write' && typeof opts.input?.content === 'string') return [`Wrote ${plural(opts.input.content.split('\n').length, 'line')}`];
      return [p.dim(truncate(firstLine(text), w))];
    }
    case 'WebFetch': {
      const kb = Math.max(1, Math.round(text.length / 1024));
      return [`Received ${kb} KB`];
    }
    case 'WebSearch': {
      const n = (text.match(/^\s*\d+\.\s|^- \[|^\[\d+\]/gm) ?? []).length;
      return [n ? `${plural(n, 'result')}` : p.dim(truncate(firstLine(text), w))];
    }
    case 'TodoWrite': {
      const todos = Array.isArray(opts.input?.todos) ? (opts.input!.todos as Todo[]) : [];
      return todos.length ? renderTodos(todos, p) : [p.dim('Updated')];
    }
    case 'Task':
    case 'Agent':
      return moreLines(text.split('\n').filter((l) => l.trim()), 2, p, w).map((l) => p.dim(l));
    default:
      if (!text) return [p.dim('(no output)')];
      return moreLines(text.split('\n').filter((l) => l.trim()), 2, p, w).map((l) => p.dim(l));
  }
}

export function renderTodos(todos: Todo[], p: Painter): string[] {
  return todos.map((t) => {
    if (t.status === 'completed') return p.dim(p.strike('☒ ' + t.content));
    if (t.status === 'in_progress') return p.bold(p.yellow('◐ ' + (t.activeForm || t.content)));
    return '☐ ' + t.content;
  });
}

/** Approval preview of what a tool is about to do. */
export function approvalPreview(tool: string, input: Record<string, unknown>, p: Painter, width: number): string[] {
  // what the owner approves must show as it is: no escape codes from the model, no lines left out unsaid
  const v = (x: unknown) => visible(s(x));
  switch (tool) {
    case 'Bash': {
      const lines = v(input.command).split('\n');
      return [...lines.slice(0, 8).map((l) => p.bold(truncate(l, width))), ...(lines.length > 8 ? [p.dim(`… +${lines.length - 8} lines`)] : [])];
    }
    case 'Edit': {
      const d = simpleDiff(v(input.old_string), v(input.new_string));
      return colorDiff(d, { painter: p, maxLines: 16 }).split('\n');
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<{ old_string?: string; new_string?: string }>) : [];
      const d = edits.map((e) => simpleDiff(v(e.old_string), v(e.new_string))).join('\n');
      return colorDiff(d, { painter: p, maxLines: 16 }).split('\n');
    }
    case 'Write': {
      const lines = v(input.content).split('\n');
      return [...lines.slice(0, 10).map((l) => p.green('+' + truncate(l, width - 1))), ...(lines.length > 10 ? [p.dim(`… +${lines.length - 10} lines`)] : [])];
    }
    case 'WebFetch':
      return [p.underline(v(input.url))];
    default: {
      const json = JSON.stringify(input, null, 2) ?? '';
      const lines = json.split('\n');
      return [...lines.slice(0, 10).map((l) => p.dim(truncate(l, width))), ...(lines.length > 10 ? [p.dim('…')] : [])];
    }
  }
}
