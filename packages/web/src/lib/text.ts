/** Small text helpers: fuzzy match and unified diffs. */

export { clsx as cn } from 'clsx';

/** Subsequence fuzzy score. Higher is better, -1 for no match. */
export function fuzzy(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    if (found === 0 || /[\s/_\-.]/.test(t[found - 1] ?? '')) score += 8;
    ti = found + 1;
  }
  return score;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((it) => ({ it, s: fuzzy(query, key(it)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let oldNo = 0;
  let newNo = 0;
  // lines the current hunk still holds, from its @@ counts
  let oldLeft = 0;
  let newLeft = 0;
  const ensure = (path = 'file') => {
    if (!cur) {
      cur = { path, lines: [], added: 0, removed: 0 };
      files.push(cur);
    }
    return cur;
  };
  for (const raw of diff.replace(/\r/g, '').split('\n')) {
    // inside a hunk, a removed "-- note" reads "--- note" and an added "++ x" reads "+++ x": lines, not headers
    const line = (oldLeft > 0 && raw.startsWith('--- ')) || (newLeft > 0 && raw.startsWith('+++ '));
    if (raw.startsWith('diff --git')) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { path: m?.[1] ?? 'file', lines: [], added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!line && raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim();
      if (cur && p !== '/dev/null') cur.path = p;
      else if (!cur) ensure(p);
      continue;
    }
    if (!line && raw.startsWith('--- ')) {
      if (!cur) ensure(raw.slice(4).replace(/^a\//, '').trim());
      continue;
    }
    if (/^(index |new file|deleted file|similarity|rename |old mode|new mode|Index:|=+$)/.test(raw)) continue;
    const f = ensure();
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[3]) : 0;
      oldLeft = m ? Number(m[2] ?? 1) : 0;
      newLeft = m ? Number(m[4] ?? 1) : 0;
      f.lines.push({ type: 'hunk', text: m?.[5]?.trim() ?? '' });
    } else if (raw.startsWith('+')) {
      f.lines.push({ type: 'add', text: raw.slice(1), newNo: newNo++ });
      f.added++;
      newLeft--;
    } else if (raw.startsWith('-')) {
      f.lines.push({ type: 'del', text: raw.slice(1), oldNo: oldNo++ });
      f.removed++;
      oldLeft--;
    } else if (raw.startsWith('\\')) {
      f.lines.push({ type: 'meta', text: raw });
    } else if (raw.length || f.lines.length) {
      f.lines.push({ type: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
      oldLeft--;
      newLeft--;
    }
  }
  for (const f of files) {
    while (f.lines.length && f.lines[f.lines.length - 1].type === 'ctx' && !f.lines[f.lines.length - 1].text) f.lines.pop();
  }
  return files.filter((f) => f.lines.length);
}

/** Build a unified diff from old/new strings (simple LCS, fine for tool inputs). */
export function makeDiff(oldStr: string, newStr: string, path = 'file'): string {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 400_000) {
    return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${n} +1,${m} @@`, ...a.map((l) => '-' + l), ...b.map((l) => '+' + l)].join('\n');
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(' ' + a[i]);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push('+' + b[j++]);
    } else {
      out.push('-' + a[i++]);
    }
  }
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${n} +1,${m} @@`, ...out].join('\n');
}
