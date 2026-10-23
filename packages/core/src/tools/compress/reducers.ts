/**
 * The reducers behind reduceOutput (tools/compress/index.ts). Each one keeps
 * what matters for its kind and writes a marker line, `[... N ... ...]`, in
 * place of what it left out.
 */

/** Lines a log reducer always keeps: errors, failures, warnings, tracebacks and stack frames. */
const IMPORTANT = [
  /\b(ERROR|ERR!|FATAL|CRITICAL|FAIL|FAILED|FAILURE|FAILURES|WARN|WARNING|PANIC)\b/,
  /\b(error|warning|warn|fatal)(\[[A-Z]?\d+\])?:/i,
  /\berror TS\d+\b/,
  /\b\w*(Error|Exception)\b(:|$)/,
  /^\s*Traceback \(most recent call last\)/,
  /\bpanic(ked)?\b/,
  /^\s+at\s/, // JavaScript, Java, Rust backtrace locations
  /^\s+File "[^"]+", line \d+/, // Python
  /^\s+\d+: \S/, // Rust backtrace frames
  /^\S+\.go:\d+/, // Go
  /^\s*\/\S+\.go:\d+/,
];
const CONTEXT = 3;

/** A line with a log level, a timestamp or a [tag] at its start. */
const LOG_LINE = /\b(INFO|DEBUG|TRACE|NOTICE|WARN|WARNING|ERROR)\b|^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\[?\d{2}:\d{2}:\d{2}\b|^\[[\w.:-]+\]/;
/** A line of source code or of a numbered file listing. */
const CODE_LINE = /[;{}]\s*$|^\s*(import|export|const|let|var|function|def|class|return|if|for|while|fn|pub|func)\b|^\s*\d+\t/;

/**
 * Log-shaped text: many lines with levels or timestamps, or error lines in
 * text that is not source code. A list of numbers or paths is not a log, and
 * code that mentions Error is not one either.
 */
export function looksLikeLog(lines: string[]): boolean {
  const full = lines.filter((l) => l.trim());
  if (full.length < 20) return false;
  const share = (re: RegExp) => full.filter((l) => re.test(l)).length / full.length;
  if (share(LOG_LINE) >= 0.3) return true;
  return share(CODE_LINE) < 0.3 && full.some((l) => IMPORTANT.some((re) => re.test(l)));
}

/** "[... 3 lines left out: 2 INFO ...]". */
function marker(n: number, noun: string, rest = 'left out', plural = `${noun}s`): string {
  return `[... ${n} ${n === 1 ? noun : plural} ${rest} ...]`;
}

/** Level words in a run of left-out lines, for the marker: "3 INFO, 1 DEBUG". */
function levelCounts(lines: string[]): string {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const m = /\b(INFO|DEBUG|TRACE|NOTICE|VERBOSE)\b/.exec(l);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
}

/** Keep the lines whose index is in keep; each run of others becomes one marker line. */
function keepLines(lines: string[], keep: Set<number>, markerFor: (run: string[]) => string): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push(markerFor(run));
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      flush();
      out.push(lines[i]);
    } else run.push(lines[i]);
  }
  flush();
  return out.join('\n');
}

/** Logs: the first and last 2 lines, and every important line with 3 lines of context around it. */
export function reduceLog(text: string): string {
  const lines = text.split('\n');
  const keep = new Set<number>([0, 1, lines.length - 2, lines.length - 1].filter((i) => i >= 0));
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORTANT.some((re) => re.test(lines[i]))) continue;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep.add(j);
  }
  return keepLines(lines, keep, (run) => {
    const levels = levelCounts(run);
    return marker(run.length, 'line', `left out${levels ? `: ${levels}` : ''}`);
  });
}

/** A line that reports one passing test, in the formats of the common runners. */
const PASSING = [
  /^test \S+ \.\.\. ok$/, // cargo
  /^=== (RUN|PAUSE|CONT)\s/, // go -v
  /^\s*--- PASS: /, // go -v
  /^\s*\(pass\) /, // bun
  /^\s*(✓|✔|√)\s/, // jest, vitest, mocha
  /^\S+::\S+.* PASSED(\s+\[\s*\d+%\])?$/, // pytest -v
  /^PASS\s+\S+/, // jest file line
  /^ok\s+\S+\s+[\d.]+s$/, // go package line
];

/** Test reports: every line but the passing tests, which become a count. Counts and failures stay whole. */
export function reduceTests(text: string): string {
  const lines = text.split('\n');
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) if (!PASSING.some((re) => re.test(lines[i]))) keep.add(i);
  return keepLines(lines, keep, (run) => marker(run.length, 'line', 'left out: passing tests'));
}

/** True for an array item that reports an error or a failure. */
function errorItem(item: unknown): boolean {
  const s = JSON.stringify(item) ?? '';
  return /"(error|errors|err|exception|failure|failed)"\s*:\s*(?!null|false|0\b|""|\[\])/i.test(s) || /"(status|level|state|result|conclusion)"\s*:\s*"(error|errored|fail|failed|failure|fatal)"/i.test(s);
}

function keysOf(items: unknown[]): string[] {
  const keys = new Set<string>();
  for (const it of items) if (it && typeof it === 'object' && !Array.isArray(it)) for (const k of Object.keys(it)) keys.add(k);
  return [...keys].slice(0, 30);
}

/** A long array as its first 2 and last 2 items plus error items, with a schema line and markers. */
function shortArray(items: unknown[], indent: string): string {
  const keep = new Set<number>([0, 1, items.length - 2, items.length - 1]);
  for (let i = 0; i < items.length; i++) if (errorItem(items[i])) keep.add(i);
  const keys = keysOf(items);
  const pad = `${indent}  `;
  const out: string[] = [`${pad}${marker(items.length, 'item', `in this array${keys.length ? `, keys ${keys.join(', ')}` : ''}; shown: the first 2, the last 2 and the error items`)}`];
  let gap = 0;
  for (let i = 0; i < items.length; i++) {
    if (!keep.has(i)) {
      gap++;
      continue;
    }
    if (gap) out.push(`${pad}${marker(gap, 'item')}`);
    gap = 0;
    out.push(pad + JSON.stringify(items[i], null, 2).replace(/\n/g, `\n${pad}`));
  }
  return `[\n${out.join(',\n')}\n${indent}]`;
}

/** JSON: arrays longer than 8 items, at the top or one level down, keep their ends and their error items. */
export function reduceJson(text: string): string {
  const value = JSON.parse(text) as unknown;
  const long = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 8;
  if (long(value)) return shortArray(value, '');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return text;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.some(([, v]) => long(v))) return text;
  const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${long(v) ? shortArray(v, '  ') : JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`);
  return `{\n${body.join(',\n')}\n}`;
}

/** Unified diffs: long runs of context inside hunks shrink to 3 lines each side; past max, whole files are named instead. */
export function reduceDiff(text: string, max = Infinity): string {
  const files = text.split(/(?=^diff --git )/m);
  const shrink = (file: string): string => {
    const lines = file.split('\n');
    const keep = new Set<number>();
    let inHunk = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('@@')) inHunk = true;
      if (!inHunk || !l.startsWith(' ')) {
        keep.add(i);
        continue;
      }
      // a context line stays when a change is within 3 lines of it
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) {
        if (/^[+-]/.test(lines[j]) && !/^(\+\+\+|---) /.test(lines[j])) {
          keep.add(i);
          break;
        }
      }
    }
    return keepLines(lines, keep, (run) => marker(run.length, 'unchanged line'));
  };
  const out: string[] = [];
  const dropped: string[] = [];
  let size = 0;
  for (const f of files) {
    const s = shrink(f);
    if (size + s.length > max && out.length) {
      dropped.push(/^diff --git a\/(\S+)/.exec(f)?.[1] ?? /^\+\+\+ b?\/?(\S+)/m.exec(f)?.[1] ?? '(unnamed)');
      continue;
    }
    out.push(s);
    size += s.length;
  }
  if (dropped.length) out.push(marker(dropped.length, 'more changed file', `not shown: ${dropped.join(', ')}`));
  return out.join('\n').replace(/\n+$/, '');
}

/** grep -n and rg output: the first 5 matches per file, then a count per file. */
export function reduceSearch(text: string): string {
  const lines = text.split('\n');
  const perFile = new Map<string, number>();
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s:][^:\n]*):\d+[:-]/.exec(lines[i]);
    if (!m) {
      keep.add(i);
      continue;
    }
    const n = (perFile.get(m[1]) ?? 0) + 1;
    perFile.set(m[1], n);
    if (n <= 5) keep.add(i);
  }
  return keepLines(lines, keep, (run) => {
    const file = /^([^\s:][^:\n]*):\d+/.exec(run[0])?.[1];
    const same = file && run.every((l) => l.startsWith(`${file}:`));
    return marker(run.length, 'more match', same ? `in ${file}` : 'left out', 'more matches');
  });
}
