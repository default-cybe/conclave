/**
 * Content-aware reducers for large tool output (HARNESS-REVIEW item 16).
 *
 * A blind middle cut drops the middle of a log, which is where a build or
 * test failure usually sits. Before the head and tail cut, the output's kind
 * is detected (in a fixed order: strict JSON, test report, diff, search
 * results, log, text) and a reducer keeps what matters for that kind. The
 * full text always stays behind the output id. Reducers are pure and
 * deterministic, so the same output gives the same bytes on every turn, and
 * reducing a reduced text gives it back unchanged.
 */
import { looksLikeLog, reduceDiff, reduceJson, reduceLog, reduceSearch, reduceTests } from './reducers';

export { retrieve } from './retrieve';

export type OutputKind = 'json' | 'tests' | 'diff' | 'search' | 'log' | 'text';

export interface Reduced {
  text: string;
  kind: OutputKind;
  /** False when nothing smaller came out: text is the input. */
  reduced: boolean;
}

/** What each kind keeps, for the note on the result. */
export const KEEPS: Record<OutputKind, string> = {
  json: 'the first and last items, error items and a schema line',
  tests: 'the counts and every failure',
  diff: 'the changed hunks; files left out are named',
  search: 'the first matches in each file',
  log: 'the first and last lines and every error, failure and warning line with 3 lines of context',
  text: 'the start and the end',
};

/** Each kind as a phrase, for the note: "reduced as a test report". */
export const KIND_NAMES: Record<OutputKind, string> = { json: 'a JSON value', tests: 'a test report', diff: 'a diff', search: 'search results', log: 'a log', text: 'text' };

/** Lines a reducer writes in place of what it left out. Text that has one was reduced already. */
export const MARKER = /^[ \t]*\[\.\.\. \d+ [^\n]* \.\.\.\]$/m;
/** Outputs this short are never reduced. */
const MIN_CHARS = 2_000;

const TEST_SIGNS = [
  /^test result: (ok|FAILED)\./m, // cargo
  /^(--- (PASS|FAIL): |=== RUN )/m, // go -v
  /^(ok|FAIL)\s+\S+\s+[\d.]+s$/m, // go
  /^=+ .*\b(passed|failed|error)\b.* in [\d.]+s\b.*=+$/m, // pytest
  /^ *\d+ (pass|fail)$/m, // bun
  /^Tests?:\s+\d+/m, // jest
  /^\s*Test Files\s+\d+/m, // vitest
  /^\s*\((pass|fail)\) /m, // bun lines
];

/** The kind of a tool output. */
export function detectKind(text: string): OutputKind {
  const t = text.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && isJson(t)) return 'json';
  if (TEST_SIGNS.some((re) => re.test(text))) return 'tests';
  if (/^diff --git /m.test(text) || (/^--- \S/m.test(text) && /^\+\+\+ \S/m.test(text) && /^@@ /m.test(text))) return 'diff';
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length >= 10 && lines.filter((l) => /^[^\s:][^:\n]*:\d+[:-]/.test(l)).length >= lines.length * 0.6) return 'search';
  if (looksLikeLog(lines)) return 'log';
  return 'text';
}

function isJson(t: string): boolean {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reduce a large output by its kind. max is the size the caller will cut to
 * afterwards (a diff drops whole files past it). The input comes back when
 * it is short, already reduced, plain text, or no smaller after reduction.
 */
export function reduceOutput(text: string, max = Infinity): Reduced {
  const kind = detectKind(text);
  if (text.length < MIN_CHARS || kind === 'text' || MARKER.test(text)) return { text, kind, reduced: false };
  let out: string;
  switch (kind) {
    case 'json':
      out = reduceJson(text);
      break;
    case 'tests':
      out = reduceTests(text);
      break;
    case 'diff':
      out = reduceDiff(text, max);
      break;
    case 'search':
      out = reduceSearch(text);
      break;
    default:
      out = reduceLog(text);
  }
  return out.length < text.length ? { text: out, kind, reduced: true } : { text, kind, reduced: false };
}
