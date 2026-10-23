/**
 * Loading a workflow script (docs/WORKFLOWS.md, "Loading"):
 *
 * 1. Find `export const meta = {...}` as the first statement with a small
 *    tokenizer, and check that it is a pure literal: objects, arrays,
 *    strings, numbers, true, false and null only. No variables, calls,
 *    spreads or template interpolation.
 * 2. The literal is evaluated by the sandbox in an empty context and must
 *    survive a JSON round trip (sandbox.ts evalMeta).
 * 3. The body loses its `export` keywords and is wrapped in an async
 *    function, so top-level await and return work. `import` is refused.
 *
 * The tokenizer knows strings, template literals (with nested ${}),
 * comments and regular expression literals, so `import` inside a string or a
 * comment is not mistaken for a statement.
 */

export const MAX_SCRIPT_BYTES = 256 * 1024;

export class WorkflowLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowLoadError';
  }
}

type TokKind = 'ident' | 'num' | 'str' | 'tmpl' | 'punct' | 'regex';
interface Tok {
  kind: TokKind;
  text: string;
  start: number;
  end: number;
  /** For templates: true when it has ${...}. */
  interp?: boolean;
}

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function isIdStart(c: string): boolean {
  return /[A-Za-z_$\u0080-￿]/.test(c);
}
function isIdPart(c: string): boolean {
  return /[A-Za-z0-9_$\u0080-￿]/.test(c);
}

/** Tokenize JavaScript well enough to find statements, strings and comments. Throws on an unterminated string or comment. */
export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const prevSignificant = () => toks[toks.length - 1];
  const regexAllowed = () => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.kind === 'num' || p.kind === 'str' || p.kind === 'tmpl' || p.kind === 'regex') return false;
    if (p.kind === 'ident') return REGEX_AFTER_KEYWORD.has(p.text);
    return !(p.text === ')' || p.text === ']' || p.text === '}');
  };

  // template literal from i (at the backtick); returns the end index and whether it had ${}
  const readTemplate = (from: number): { end: number; interp: boolean } => {
    let j = from + 1;
    let interp = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') return { end: j + 1, interp };
      if (c === '$' && src[j + 1] === '{') {
        interp = true;
        j = skipBalanced(j + 2);
        continue;
      }
      j++;
    }
    throw new WorkflowLoadError('unterminated template literal');
  };

  // skip from just after "${" to after the matching "}", minding nested strings and templates
  const skipBalanced = (from: number): number => {
    let depth = 1;
    let j = from;
    while (j < n) {
      const c = src[j];
      if (c === '"' || c === "'") {
        j = readString(j);
        continue;
      }
      if (c === '`') {
        j = readTemplate(j).end;
        continue;
      }
      if (c === '/' && src[j + 1] === '/') {
        while (j < n && src[j] !== '\n') j++;
        continue;
      }
      if (c === '/' && src[j + 1] === '*') {
        const e = src.indexOf('*/', j + 2);
        if (e < 0) throw new WorkflowLoadError('unterminated comment');
        j = e + 2;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    throw new WorkflowLoadError('unterminated template literal');
  };

  const readString = (from: number): number => {
    const q = src[from];
    let j = from + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === q) return j + 1;
      if (c === '\n') throw new WorkflowLoadError('unterminated string');
      j++;
    }
    throw new WorkflowLoadError('unterminated string');
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿' || c === ' ' || c === ' ' || c === ' ') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new WorkflowLoadError('unterminated comment');
      i = e + 2;
      continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = readString(i);
      toks.push({ kind: 'str', text: src.slice(i, e), start: i, end: e });
      i = e;
      continue;
    }
    if (c === '`') {
      const t = readTemplate(i);
      toks.push({ kind: 'tmpl', text: src.slice(i, t.end), start: i, end: t.end, interp: t.interp });
      i = t.end;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) {
        // exponent sign
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-') && !/^0[xX]/.test(src.slice(i, j))) j += 2;
        else j++;
      }
      toks.push({ kind: 'num', text: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      toks.push({ kind: 'ident', text: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') throw new WorkflowLoadError('unterminated regular expression');
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      toks.push({ kind: 'regex', text: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i)) ?? c;
    toks.push({ kind: 'punct', text: p, start: i, end: i + p.length });
    i += p.length;
  }
  return toks;
}

/**
 * Check a token range is a pure literal: { key: value, ... }, [ ... ],
 * strings, numbers (with a leading minus), true, false, null. Keys may be
 * identifiers, strings or numbers.
 */
function assertPureLiteral(toks: Tok[], from: number, to: number): void {
  let i = from;
  const fail = (t: Tok | undefined, why: string): never => {
    throw new WorkflowLoadError(`meta must be a pure literal (no variables, calls, spreads or template interpolation): ${why}${t ? ` at "${t.text.slice(0, 40)}"` : ''}`);
  };
  const value = (): void => {
    const t = toks[i];
    if (!t || i >= to) fail(t, 'unexpected end');
    if (t.kind === 'punct' && t.text === '{') return object();
    if (t.kind === 'punct' && t.text === '[') return array();
    if (t.kind === 'str') {
      i++;
      return;
    }
    if (t.kind === 'tmpl') {
      if (t.interp) fail(t, 'template interpolation');
      i++;
      return;
    }
    if (t.kind === 'num') {
      i++;
      return;
    }
    if (t.kind === 'punct' && t.text === '-' && toks[i + 1]?.kind === 'num') {
      i += 2;
      return;
    }
    if (t.kind === 'ident' && (t.text === 'true' || t.text === 'false' || t.text === 'null')) {
      i++;
      return;
    }
    if (t.kind === 'punct' && t.text === '...') fail(t, 'spread');
    fail(t, t.kind === 'ident' ? 'a variable or call' : 'an expression');
  };
  const object = (): void => {
    i++; // {
    for (;;) {
      const t = toks[i];
      if (!t) fail(t, 'unexpected end');
      if (t.kind === 'punct' && t.text === '}') {
        i++;
        return;
      }
      if (t.kind === 'punct' && t.text === '...') fail(t, 'spread');
      if (t.kind === 'punct' && t.text === '[') fail(t, 'computed key');
      if (!(t.kind === 'ident' || t.kind === 'str' || t.kind === 'num')) fail(t, 'a key');
      i++;
      const colon = toks[i];
      if (!colon || colon.text !== ':') fail(colon, 'shorthand or method properties');
      i++;
      value();
      const sep = toks[i];
      if (sep?.text === ',') {
        i++;
        continue;
      }
      if (sep?.text === '}') {
        i++;
        return;
      }
      fail(sep, 'an expression');
    }
  };
  const array = (): void => {
    i++; // [
    for (;;) {
      const t = toks[i];
      if (!t) fail(t, 'unexpected end');
      if (t.text === ']') {
        i++;
        return;
      }
      if (t.text === '...') fail(t, 'spread');
      value();
      const sep = toks[i];
      if (sep?.text === ',') {
        i++;
        continue;
      }
      if (sep?.text === ']') {
        i++;
        return;
      }
      fail(sep, 'an expression');
    }
  };
  value();
  if (i !== to) fail(toks[i], 'an expression after the literal');
}

export interface ParsedScript {
  /** The meta literal's source text, e.g. "{ name: 'x', ... }". */
  metaSource: string;
  /** The body as the sandbox runs it: `export` removed, wrapped in an async function, the meta kept as a const. */
  body: string;
}

/**
 * Split a script into its meta literal and a runnable body. Throws
 * WorkflowLoadError with a reason the agent can fix.
 */
export function parseScript(script: string): ParsedScript {
  if (typeof script !== 'string' || !script.trim()) throw new WorkflowLoadError('the script is empty');
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw new WorkflowLoadError(`the script is larger than ${MAX_SCRIPT_BYTES / 1024} KB`);
  let toks: Tok[];
  try {
    toks = tokenize(script);
  } catch (err) {
    throw new WorkflowLoadError(`the script does not parse: ${(err as Error).message}`);
  }
  // a leading "use strict" directive is allowed
  let k = 0;
  while (toks[k]?.kind === 'str' && (toks[k + 1]?.text === ';' || toks[k + 1]?.text === 'export')) k += toks[k + 1]?.text === ';' ? 2 : 1;
  const [ex, co, me, eq, open] = [toks[k], toks[k + 1], toks[k + 2], toks[k + 3], toks[k + 4]];
  if (ex?.text !== 'export' || co?.text !== 'const' || me?.text !== 'meta' || eq?.text !== '=' || open?.text !== '{') {
    throw new WorkflowLoadError('the script must begin with `export const meta = {...}`');
  }
  // find the matching close brace
  let depth = 0;
  let close = -1;
  for (let j = k + 4; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== 'punct') continue;
    if (t.text === '{' || t.text === '[' || t.text === '(') depth++;
    else if (t.text === '}' || t.text === ']' || t.text === ')') {
      depth--;
      if (depth === 0) {
        close = j;
        break;
      }
    }
  }
  if (close < 0) throw new WorkflowLoadError('the meta literal is not closed');
  assertPureLiteral(toks, k + 4, close + 1);
  const metaSource = script.slice(toks[k + 4].start, toks[close].end);

  // import is refused, as a statement and as import()
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== 'ident' || t.text !== 'import') continue;
    const prev = toks[j - 1];
    if (prev && (prev.text === '.' || prev.text === '?.')) continue;
    const next = toks[j + 1];
    if (next && next.text === ':') continue; // an object key named import
    throw new WorkflowLoadError('import is not available in workflow scripts');
  }

  // drop `export` before declarations; the meta stays as a const the body can read
  let body = '';
  let last = 0;
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== 'ident' || t.text !== 'export') continue;
    const prev = toks[j - 1];
    if (prev && (prev.text === '.' || prev.text === '?.')) continue;
    const next = toks[j + 1];
    if (!next || !['const', 'let', 'var', 'function', 'async', 'class'].includes(next.text)) {
      throw new WorkflowLoadError('only `export const meta` and exported declarations are allowed; return the result instead of exporting it');
    }
    body += script.slice(last, t.start) + ' '.repeat(t.end - t.start);
    last = t.end;
  }
  body += script.slice(last);
  // same line numbers as the script: the wrapper opens on line 1
  return { metaSource, body: `(async () => {${body}\n})()` };
}
