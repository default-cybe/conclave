/** Colored, collapsible unified diffs for Edit/Write results and approval previews. */
import type { Painter } from '../ansi';

export interface DiffOptions {
  painter: Painter;
  /** Show at most this many body lines. Default 20. */
  maxLines?: number;
  /** Keep file header lines (---/+++/diff --git). Default false. */
  headers?: boolean;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  const lines = diff.split('\n');
  const header = headerFlags(lines);
  lines.forEach((l, i) => {
    if (header[i]) return;
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  });
  return { added, removed };
}

const HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |Binary files )/;

/**
 * Which lines are file headers. Inside a hunk the @@ counts decide: a removed
 * "-- note" line reads "--- note" but is a change. A diff with no hunks (the
 * approval preview of an Edit) has no headers.
 */
function headerFlags(lines: string[]): boolean[] {
  if (!lines.some((l) => l.startsWith('@@'))) return lines.map(() => false);
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((l) => {
    const hunk = l.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      return false;
    }
    if (oldLeft > 0 || newLeft > 0) {
      if (l.startsWith('+')) newLeft--;
      else if (l.startsWith('-')) oldLeft--;
      else if (l.startsWith(' ')) {
        oldLeft--;
        newLeft--;
      }
      return false;
    }
    return HEADER.test(l);
  });
}

/** + green, - red, @@ cyan, context dim. Collapsed to maxLines with a "+N lines" note. */
export function colorDiff(diff: string, opts: DiffOptions): string {
  const p = opts.painter;
  const max = opts.maxLines ?? 20;
  const lines = diff.replace(/\n$/, '').split('\n');
  const header = headerFlags(lines);
  const body = lines.map((l, i) => ({ l, header: header[i] })).filter((x) => opts.headers || !x.header);
  const shown = max > 0 ? body.slice(0, max) : body;
  const out = shown.map((x) => (x.header ? p.bold(p.dim(x.l)) : colorDiffLine(x.l, p)));
  const hidden = body.length - shown.length;
  if (hidden > 0) out.push(p.dim(`… +${hidden} ${hidden === 1 ? 'line' : 'lines'}`));
  return out.join('\n');
}

export function colorDiffLine(l: string, p: Painter): string {
  if (l.startsWith('@@')) return p.cyan(l);
  if (l.startsWith('+')) return p.green(l);
  if (l.startsWith('-')) return p.red(l);
  if (l.startsWith('\\')) return p.dim(l);
  return p.dim(l);
}

/** A minimal diff from old/new strings (for approval previews of Edit input). */
export function simpleDiff(oldText: string, newText: string): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // trim common prefix and suffix, then show the rest as -/+
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  if (start > 0) out.push(' ' + a[start - 1]);
  for (let i = start; i <= endA; i++) out.push('-' + a[i]);
  for (let i = start; i <= endB; i++) out.push('+' + b[i]);
  if (endA + 1 < a.length) out.push(' ' + a[endA + 1]);
  return out.join('\n');
}
