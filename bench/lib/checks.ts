/**
 * `bench check`: static checks of the task kit. Fast, no toolchains, no model.
 * `validate` runs the tests; this file reads the files. Both must be clean
 * before a set.
 *
 * What it checks, per task:
 *   - task.json matches the catalog (so `build` would not change it).
 *   - Polyglot prompts hold their "Notes for this task" block.
 *   - Error messages and API names the hidden tests need appear in the prompt
 *     or in repo/ (the agent never sees the hidden tests).
 *   - Bug prompts do not name the real cause.
 *   - Seeded repos carry no comments that point at the bug.
 *   - Time limit fits the difficulty.
 * And for the whole set: the difficulty mix the protocol promises.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, taskJson } from './catalog';
import { loadTask, notesBlock, type Task } from './tasks';
import { listFiles } from './util';

export interface CheckResult {
  id: string;
  problems: string[];
  notes: string[];
}

/**
 * Words a bug prompt must not contain, because they name the real cause or
 * the file that holds it. Each bug report is meant to point the wrong way.
 */
export const CAUSE_WORDS: Record<string, string[]> = {
  'bug-ts-cents': ['csv.ts', 'importer', 'parseAmount', 'parseFloat', 'Math.floor', 'floating'],
  'bug-ts-timezone': ['dates.ts', 'filter.ts', 'UTC', 'parseDate', 'monthRange', 'midnight', 'toISOString'],
  'bug-ts-config': ['config.ts', 'resolveConfig', 'merge', 'undefined', 'spread'],
  'bug-py-retry': ['worker.py', 'millisecond', '1000', 'next_run_at', 'now_ms', 'unit'],
  'bug-py-utf8': ['http_util', 'Content-Length', 'byte', 'send_json', 'send_error_json', 'encode', 'len('],
  'bug-py-cursor': ['store.py', 'cursor.py', 'created_at', 'same second', 'tie', 'keyset', 'dedupe'],
};

const REVEALING = /\b(BUG|FIXME|XXX|HACK|seeded|hidden tests?|reference solution|benchmark)\b/i;

const LIMIT = { easy: 600, medium: 900, hard: 1200 } as const;

/** Members the JS test frameworks and the language provide; not part of the exercise API. */
const JS_BUILTIN = new Set(['length', 'push', 'map', 'filter', 'forEach', 'join', 'split', 'slice', 'concat', 'keys', 'entries', 'toString', 'not', 'resolves', 'rejects', 'only', 'skip', 'each', 'mock', 'fn', 'prototype', 'call', 'apply', 'bind', 'then', 'catch']);
/** The same for Python unittest. */
const PY_BUILTIN = new Set(['exception', 'args', 'subTest', 'maxDiff', 'TestCase', 'main', 'setUp', 'tearDown', 'fail', 'skipTest', 'append', 'items', 'keys', 'values', 'get', 'format', 'join', 'split', 'strip']);

function stripJs(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function stripPy(src: string): string {
  return src.replace(/#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '');
}

/** Error messages and expected strings a hidden test compares exactly. */
export function requiredLiterals(lang: string, src: string): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    if (s && s.trim()) out.add(s);
  };
  if (lang === 'javascript' || lang === 'typescript') {
    const code = stripJs(src);
    for (const m of code.matchAll(/new Error\(\s*(['"`])((?:\\.|(?!\1).)+)\1/g)) add(m[2]);
    for (const m of code.matchAll(/\.toThrow\(\s*(['"`])((?:\\.|(?!\1).)+)\1\s*\)/g)) add(m[2]);
    for (const m of code.matchAll(/\bexpected\s*=\s*(['"`])((?:\\.|(?!\1).)+)\1\s*;/g)) add(m[2]);
  } else if (lang === 'python') {
    const code = stripPy(src);
    for (const m of code.matchAll(/\.args\[0\],\s*(['"])((?:\\.|(?!\1).)+)\1/g)) add(m[2]);
    // a regex such as r".+" asks for any message; only a plain pattern is an exact text
    for (const m of code.matchAll(/assertRaisesRegex\(\s*\w+\s*,\s*r?(['"])((?:\\.|(?!\1).)+)\1/g)) if (!/[.*+?^$()[\]{}|\\]/.test(m[2])) add(m[2]);
  } else if (lang === 'rust') {
    for (const m of src.matchAll(/#\[should_panic\(expected\s*=\s*"((?:\\.|[^"])+)"\)\]/g)) add(m[1]);
  }
  return [...out];
}

/** Member names a hidden test uses on the code under test (JS and Python only). */
export function requiredMembers(lang: string, src: string): string[] {
  const out = new Set<string>();
  if (lang === 'javascript' || lang === 'typescript') {
    const code = stripJs(src).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const m of code.matchAll(/\.([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      if (/^to[A-Z]/.test(name) || JS_BUILTIN.has(name)) continue;
      out.add(name);
    }
  } else if (lang === 'python') {
    const code = stripPy(src).replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""');
    const own = new Set([...code.matchAll(/^\s*def\s+(\w+)/gm)].map((m) => m[1]));
    for (const m of code.matchAll(/\.([A-Za-z_]\w*)/g)) {
      const name = m[1];
      if (/^assert/.test(name) || PY_BUILTIN.has(name) || own.has(name)) continue;
      out.add(name);
    }
  }
  return [...out];
}

function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$])${esc}($|[^\\w$])`).test(text);
}

function readAll(dir: string): string {
  return listFiles(dir, ['node_modules/', 'target/', '__pycache__/'])
    .map((f) => {
      try {
        return readFileSync(join(dir, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

export function checkTask(t: Task): CheckResult {
  const r: CheckResult = { id: t.id, problems: [], notes: [] };
  const e = CATALOG.find((c) => c.id === t.id);
  if (!e) {
    r.problems.push('not in the catalog');
    return r;
  }
  const prompt = readFileSync(join(t.dir, 'prompt.md'), 'utf8');
  const repoText = readAll(join(t.dir, 'repo'));
  const visibleText = prompt + '\n' + repoText;

  // task.json drift
  const want = taskJson(e, t.hidden.expected_total);
  const { dir: _dir, ...have } = t as Task & Record<string, unknown>;
  if (JSON.stringify(want) !== JSON.stringify(have)) r.problems.push('task.json differs from the catalog; run `bench build` (it keeps expected_total)');
  if (t.time_limit_s !== LIMIT[t.difficulty]) r.problems.push(`time_limit_s ${t.time_limit_s} does not fit ${t.difficulty} (${LIMIT[t.difficulty]})`);

  // polyglot notes
  if (e.notes && !prompt.includes(notesBlock(e.notes))) r.problems.push('prompt.md lacks the "Notes for this task" block from the catalog; run `bench build --polyglot <clone>` or paste it in');

  // what the hidden tests need must be visible somewhere
  if (t.kind === 'polyglot') {
    for (const from of Object.keys(t.hidden.files)) {
      const src = readFileSync(join(t.dir, from), 'utf8');
      for (const lit of requiredLiterals(t.lang, src)) if (!visibleText.includes(lit)) r.problems.push(`hidden tests expect the exact text "${lit}", but neither the prompt nor repo/ states it`);
      // an API name counts as stated when repo/ code has it or the prompt shows it as code (plain words like "values" do not count)
      const codeText = repoText + '\n' + [...prompt.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join('\n');
      for (const name of requiredMembers(t.lang, src)) if (!hasWord(codeText, name)) r.problems.push(`hidden tests use \`${name}\`, but neither repo/ nor the prompt (as code) names it`);
    }
  }

  // bug prompts point the wrong way
  for (const w of CAUSE_WORDS[t.id] ?? []) if (prompt.toLowerCase().includes(w.toLowerCase())) r.problems.push(`the bug report names "${w}", which gives the cause away`);
  if (t.kind === 'bug' && !CAUSE_WORDS[t.id]) r.problems.push('bug task without a CAUSE_WORDS entry in lib/checks.ts');

  // seeded code carries no hints
  if (t.kind !== 'polyglot') {
    for (const f of listFiles(join(t.dir, 'repo'), ['node_modules/', '__pycache__/'])) {
      const lines = readFileSync(join(t.dir, 'repo', f), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (REVEALING.test(l)) r.problems.push(`repo/${f}:${i + 1} has a revealing word: ${l.trim().slice(0, 100)}`);
      });
    }
  }

  // the wrapper says hidden tests are not in the folder; note test data that is
  const testish = listFiles(join(t.dir, 'repo')).filter((f) => /(_test\.go|\.spec\.[jt]s|_test\.py|^tests?\/)/.test(f) && !f.startsWith('test/') && !f.startsWith('tests/'));
  if (testish.length) r.notes.push(`repo/ holds test files the agent can read: ${testish.join(', ')}`);
  return r;
}

export function checkAll(ids: string[]): { results: CheckResult[]; problems: string[] } {
  const results = ids.map((id) => checkTask(loadTask(id)));
  const problems: string[] = [];
  const tasks = ids.map(loadTask);
  if (ids.length === CATALOG.length) {
    const by = (d: string) => tasks.filter((t) => t.difficulty === d).length;
    if (by('hard') < 5) problems.push(`only ${by('hard')} hard tasks; the protocol needs at least 5 tasks a strong model could fail`);
    const smoke = tasks.filter((t) => t.smoke);
    if (smoke.length !== 2) problems.push(`smoke set has ${smoke.length} tasks, the protocol says 2`);
  }
  return { results, problems };
}
