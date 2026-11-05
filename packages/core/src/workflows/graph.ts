/**
 * Workflow script to node graph, and literal edits back into the script
 * (docs/design/VISUAL-PROGRAMMING.md 7.1, 7.2 and 7.7). Code wins: the graph
 * is read from the script each time, and an edit replaces one literal token
 * so every other byte of the file stays as it was.
 *
 * Built on the loader's tokenizer (meta.ts): top-level statements are split
 * by bracket depth and line breaks, then matched against the dialect
 * (agent, parallel, pipeline, workflow, lib.runCheck, lib.exec, lib.ask,
 * lib.approve, return, log). Anything else is a Code node with its exact
 * text and the calls inside it. Never throws on a script that tokenizes; a
 * script that does not tokenize gives an empty graph with the reason.
 */
import type { GraphEdge, GraphEditInput, GraphInnerCall, GraphLiteral, GraphNode, GraphNodeKind, WorkflowGraph } from '../client/graph';
import { tokenize, type Tok } from './meta';

export class GraphEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphEditError';
  }
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
/** A line ending in one of these goes on, as does a line starting with one. */
const CONTINUES_AFTER = new Set(['=', '(', '[', '{', ',', '.', '?.', '=>', '+', '-', '*', '/', '%', '**', '&&', '||', '??', '?', ':', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '!', '&', '|', '^', '+=', '-=', '*=', '/=', '??=', '||=', '&&=', '...', 'new', 'await', 'return', 'typeof', 'in', 'of', 'instanceof']);
const CONTINUES_BEFORE = new Set(['.', '?.', '=>', '+', '*', '/', '%', '**', '&&', '||', '??', '?', ':', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&', '|', '^', 'else', 'catch', 'finally', 'in', 'of', 'instanceof', ')', ']', '}', ',']);
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'with']);

const DIRECT: Record<string, GraphNodeKind> = { agent: 'agent', parallel: 'parallel', pipeline: 'pipeline', workflow: 'workflow' };
const LIB: Record<string, GraphNodeKind> = { runCheck: 'check', exec: 'check', ask: 'ask', approve: 'approve' };
/** Calls listed inside a Code node. */
const INNER_DIRECT = new Set(['agent', 'parallel', 'pipeline', 'workflow', 'phase']);
const INNER_LIB = new Set(['runCheck', 'exec', 'ask', 'approve', 'panel', 'judgePanel', 'loopUntilDry', 'checkCitations', 'checkCitation', 'capture', 'diff', 'checkout']);

export interface Stmt {
  toks: Tok[];
  start: number;
  end: number;
}

export function lineStarts(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') out.push(i + 1);
  return out;
}

export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Split the top level into statements: a `;` or a line break at depth 0 ends one, unless the code clearly goes on. */
export function statements(src: string, toks: Tok[]): Stmt[] {
  const out: Stmt[] = [];
  let cur: Tok[] = [];
  let depth = 0;
  const flush = () => {
    if (cur.length) out.push({ toks: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  // `if (x)` / `for (...)` / `else` with its body on the next line
  const openHead = (): boolean => {
    if (!cur.length) return false;
    const last = cur[cur.length - 1];
    if (last.text === 'else' || last.text === 'do') return true;
    if (last.text !== ')') return false;
    // find the head whose paren group ends at last
    let d = 0;
    for (let i = cur.length - 1; i >= 0; i--) {
      const t = cur[i];
      if (t.kind === 'punct' && CLOSE.has(t.text)) d++;
      else if (t.kind === 'punct' && OPEN.has(t.text)) {
        d--;
        if (d === 0) return i > 0 && BLOCK_HEADS.has(cur[i - 1].text) && (i - 1 === 0 || cur[i - 2]?.text === 'else');
      }
    }
    return false;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (depth === 0 && cur.length) {
      const prev = cur[cur.length - 1];
      const newline = src.slice(prev.end, t.start).includes('\n');
      if (newline && !CONTINUES_AFTER.has(prev.text) && !CONTINUES_BEFORE.has(t.text) && !openHead()) {
        // a block statement (`if {...}`) is followed by `else` handled above; anything else starts anew
        flush();
      }
    }
    if (t.kind === 'punct' && t.text === ';' && depth === 0) {
      cur.push(t);
      flush();
      continue;
    }
    cur.push(t);
    if (t.kind === 'punct' && OPEN.has(t.text)) depth++;
    else if (t.kind === 'punct' && CLOSE.has(t.text)) depth = Math.max(0, depth - 1);
  }
  flush();
  return out;
}

/** The index of the token that closes the bracket at `open`, or -1. */
export function closing(toks: Tok[], open: number): number {
  let d = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'punct') continue;
    if (OPEN.has(t.text)) d++;
    else if (CLOSE.has(t.text)) {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** Split the tokens between brackets by top-level commas. */
export function splitArgs(toks: Tok[], open: number, close: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let d = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const t = toks[i];
    if (t.kind === 'punct' && OPEN.has(t.text)) d++;
    else if (t.kind === 'punct' && CLOSE.has(t.text)) d--;
    else if (d === 0 && t.text === ',') {
      out.push([from, i]);
      from = i + 1;
    }
  }
  if (from < close) out.push([from, close]);
  return out;
}

/** A hex escape's character; a bad one (not hex, past U+10FFFF) reads as U+FFFD instead of throwing. */
function codePoint(hex: string): string {
  const cp = /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN;
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
}

/** The value of a string literal token (', " or a template with no ${}). Undefined when it is not a plain literal. */
export function stringValue(t: Tok): string | undefined {
  if (t.kind !== 'str' && !(t.kind === 'tmpl' && !t.interp)) return undefined;
  const body = t.text.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === 'v') out += '\v';
    else if (n === '0' && !/[0-9]/.test(body[i + 1] ?? '')) out += '\0';
    else if (n === 'x') {
      out += codePoint(body.slice(i + 1, i + 3));
      i += 2;
    } else if (n === 'u') {
      if (body[i + 1] === '{') {
        // an unclosed \u{ ends the value (going back to -1 looped forever)
        const e = body.indexOf('}', i);
        if (e < 0) break;
        out += codePoint(body.slice(i + 2, e));
        i = e;
      } else {
        out += codePoint(body.slice(i + 1, i + 5));
        i += 4;
      }
    } else if (n === '\n') {
      // a line continuation
    } else if (n === '\r') {
      if (body[i + 1] === '\n') i++;
    } else out += n;
  }
  return out;
}

/** A string literal for value in the given quote style. */
export function quoteString(value: string, quote: string): string {
  let s = value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (quote === '`') s = s.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  else s = s.replace(/\n/g, '\\n').split(quote).join(`\\${quote}`);
  // other control characters never go in raw
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${quote}${s}${quote}`;
}

export function literalOf(t: Tok): GraphLiteral | undefined {
  const s = stringValue(t);
  if (s !== undefined) return { value: s, start: t.start, end: t.end, quote: t.text[0] };
  if (t.kind === 'num' && /^[0-9.]+$/.test(t.text)) return { value: Number(t.text), start: t.start, end: t.end };
  if (t.kind === 'ident' && (t.text === 'true' || t.text === 'false')) return { value: t.text === 'true', start: t.start, end: t.end };
  return undefined;
}

/** Literal entries of an object literal at toks[open] = '{'. */
function objectLiterals(toks: Tok[], open: number, close: number): Record<string, GraphLiteral> {
  const out: Record<string, GraphLiteral> = {};
  for (const [a, b] of splitArgs(toks, open, close)) {
    const k = toks[a];
    if (!k || toks[a + 1]?.text !== ':') continue;
    const key = k.kind === 'ident' ? k.text : stringValue(k);
    if (!key || b - a !== 3) continue;
    const lit = literalOf(toks[a + 2]);
    if (lit) out[key] = lit;
  }
  return out;
}

/** The names a declaration binds: `const x`, `const { a, b: c }`, `const [a, b]`, `function f`. */
export function declaredNames(toks: Tok[]): string[] {
  let i = 0;
  if (toks[i]?.text === 'export') i++;
  if (toks[i]?.text === 'async') i++;
  if (toks[i]?.text === 'function') return toks[i + 1]?.kind === 'ident' ? [toks[i + 1].text] : [];
  if (!['const', 'let', 'var'].includes(toks[i]?.text ?? '')) return [];
  const out: string[] = [];
  // each declarator at depth 0: a name or a pattern before `=`, `,` or the end
  let j = i + 1;
  let d = 0;
  let expectName = true;
  for (; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind === 'punct' && OPEN.has(t.text)) {
      if (expectName && d === 0) {
        const c = closing(toks, j);
        for (let k = j + 1; k < c; k++) {
          const x = toks[k];
          // a pattern's names: idents not followed by ':' (that is a key) and not after '='
          if (x.kind === 'ident' && toks[k + 1]?.text !== ':' && toks[k - 1]?.text !== '=' && toks[k - 1]?.text !== '.') out.push(x.text);
        }
        j = c;
        expectName = false;
        continue;
      }
      d++;
    } else if (t.kind === 'punct' && CLOSE.has(t.text)) d--;
    else if (d === 0 && t.text === ',') expectName = true;
    else if (d === 0 && expectName && t.kind === 'ident') {
      out.push(t.text);
      expectName = false;
    } else if (d === 0 && t.text === '=') expectName = false;
  }
  return out;
}

/** Identifiers the statement reads (not property names or object keys). */
export function readNames(toks: Tok[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'ident') continue;
    const prev = toks[i - 1]?.text;
    if (prev === '.' || prev === '?.') continue;
    if (toks[i + 1]?.text === ':' && (prev === '{' || prev === ',')) continue;
    out.add(t.text);
  }
  return out;
}

function innerCalls(toks: Tok[], line: (o: number) => number): GraphInnerCall[] {
  const out: GraphInnerCall[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'ident') continue;
    const prev = toks[i - 1]?.text;
    let name: string | undefined;
    let open = -1;
    if (INNER_DIRECT.has(t.text) && prev !== '.' && prev !== '?.' && toks[i + 1]?.text === '(') {
      name = t.text;
      open = i + 1;
    } else if (t.text === 'lib' && toks[i + 1]?.text === '.' && INNER_LIB.has(toks[i + 2]?.text ?? '') && toks[i + 3]?.text === '(') {
      name = `lib.${toks[i + 2].text}`;
      open = i + 3;
    }
    if (!name || name === 'phase') continue;
    const close = closing(toks, open);
    let label: string | undefined;
    if (name === 'agent' && close > 0) {
      const args = splitArgs(toks, open, close);
      const o = args[1];
      if (o && toks[o[0]]?.text === '{') {
        const lab = objectLiterals(toks, o[0], closing(toks, o[0])).label;
        if (typeof lab?.value === 'string') label = lab.value;
        else {
          // 'diagnose ' + round: the literal head of a computed label
          const k = toks.slice(o[0], closing(toks, o[0])).findIndex((x, n, a) => x.text === 'label' && a[n + 1]?.text === ':');
          const head = k >= 0 ? toks[o[0] + k + 2] : undefined;
          // `save-${l.label}`: the template's text before its first ${
          const s = head ? (head.kind === 'tmpl' && head.interp ? head.text.slice(1).split('${')[0] : stringValue(head)) : undefined;
          if (s?.trim()) label = s.trim();
        }
      }
    }
    out.push({ name, line: line(t.start), ...(label ? { label } : {}) });
  }
  return out;
}

function shorten(s: string, n = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Match `[const|let|var] x = await <call>(...)`, `await <call>(...)` or `x = await <call>(...)` as the whole statement. */
function matchCall(toks: Tok[]): { kind: GraphNodeKind; open: number; close: number } | undefined {
  let i = 0;
  if (['const', 'let', 'var'].includes(toks[0]?.text ?? '')) {
    i = 1;
    if (toks[i]?.kind === 'ident') i++;
    else if (toks[i]?.text === '{' || toks[i]?.text === '[') i = closing(toks, i) + 1;
    else return undefined;
    if (toks[i]?.text !== '=') return undefined;
    i++;
  } else if (toks[0]?.kind === 'ident' && toks[1]?.text === '=') i = 2;
  if (toks[i]?.text === 'await') i++;
  let kind: GraphNodeKind | undefined;
  let open = -1;
  const t = toks[i];
  if (t?.kind === 'ident' && DIRECT[t.text] && toks[i + 1]?.text === '(') {
    kind = DIRECT[t.text];
    open = i + 1;
  } else if (t?.text === 'lib' && toks[i + 1]?.text === '.' && LIB[toks[i + 2]?.text ?? ''] && toks[i + 3]?.text === '(') {
    kind = LIB[toks[i + 2].text];
    open = i + 3;
  }
  if (!kind) return undefined;
  const close = closing(toks, open);
  if (close < 0) return undefined;
  const rest = toks.slice(close + 1).filter((x) => x.text !== ';');
  if (rest.length) return undefined;
  return { kind, open, close };
}

/** The prompt's literal parts: a string, or `[ 'a', x, 'b' ].join(...)`. Others are locked with the reason. */
function promptOf(toks: Tok[], a: number, b: number): { parts: GraphLiteral[]; locked?: string } {
  const first = toks[a];
  if (b - a === 1) {
    const lit = literalOf(first);
    if (lit && typeof lit.value === 'string') return { parts: [lit] };
    if (first.kind === 'tmpl') return { parts: [], locked: 'the prompt is a template with ${...}; edit it in the script' };
    return { parts: [], locked: 'the prompt is computed; edit it in the script' };
  }
  if (first.text === '[') {
    const close = closing(toks, a);
    const tail = toks.slice(close + 1, b).map((t) => t.text).join('');
    if (!tail.startsWith('.join(')) return { parts: [], locked: 'the prompt is computed; edit it in the script' };
    const parts: GraphLiteral[] = [];
    for (const [x, y] of splitArgs(toks, a, close)) {
      if (y - x !== 1) continue;
      const lit = literalOf(toks[x]);
      if (lit && typeof lit.value === 'string') parts.push(lit);
    }
    return parts.length ? { parts } : { parts: [], locked: 'the prompt has no literal text to edit' };
  }
  return { parts: [], locked: 'the prompt is computed; edit it in the script' };
}

/** The node graph of a workflow script. Never throws: a script that does not tokenize gives no nodes. */
export function parseGraph(script: string, metaPhases: string[] = []): WorkflowGraph & { error?: string } {
  try {
    return parse(script, metaPhases);
  } catch (err) {
    // a backstop: a parser bug must not turn a workflow file into a 500
    return { name: '', phases: metaPhases, nodes: [], edges: [], error: (err as Error).message };
  }
}

function parse(script: string, metaPhases: string[]): WorkflowGraph & { error?: string } {
  let toks: Tok[];
  try {
    toks = tokenize(script);
  } catch (err) {
    return { name: '', phases: metaPhases, nodes: [], edges: [], error: (err as Error).message };
  }
  const starts = lineStarts(script);
  const line = (o: number) => lineAt(starts, o);
  const raw: Array<{ node: Omit<GraphNode, 'id'>; start: number; end: number; reads: Set<string> }> = [];
  const counts = new Map<GraphNodeKind, number>();
  const phases = [...metaPhases];
  let name = '';
  let phase: string | undefined;
  for (const st of statements(script, toks)) {
    const t = st.toks;
    const text = script.slice(st.start, st.end);
    // export const meta = {...}: hidden, its name read for the header
    if (t[0]?.text === 'export' && t[1]?.text === 'const' && t[2]?.text === 'meta') {
      const open = t.findIndex((x) => x.text === '{');
      if (open > 0) {
        const lit = objectLiterals(t, open, closing(t, open)).name;
        if (typeof lit?.value === 'string') name = lit.value;
      }
      continue;
    }
    // a leading "use strict"
    if (t.length <= 2 && t[0]?.kind === 'str' && (t.length === 1 || t[1].text === ';') && !raw.length) continue;
    if (t[0]?.text === 'phase' && t[1]?.text === '(' && t[2] && stringValue(t[2]) !== undefined && t[3]?.text === ')') {
      phase = stringValue(t[2])!;
      if (!phases.includes(phase)) phases.push(phase);
      continue;
    }
    let kind: GraphNodeKind = 'code';
    let opts: Record<string, GraphLiteral> | undefined;
    let optsObject: GraphNode['optsObject'];
    let promptParts: GraphLiteral[] | undefined;
    let promptLocked: string | undefined;
    let label = '';
    const m = matchCall(t);
    if (m) {
      kind = m.kind;
      const args = splitArgs(t, m.open, m.close);
      if (kind === 'agent') {
        const o = args[1];
        if (o && t[o[0]]?.text === '{' && closing(t, o[0]) === o[1] - 1) {
          opts = objectLiterals(t, o[0], o[1] - 1);
          optsObject = { open: t[o[0]].start, close: t[o[1] - 1].start };
        }
        if (args[0]) {
          const p = promptOf(t, args[0][0], args[0][1]);
          promptParts = p.parts;
          promptLocked = p.locked;
        }
        const lab = opts?.label?.value;
        label = typeof lab === 'string' ? lab : shorten(String(promptParts?.[0]?.value ?? 'agent'));
      } else {
        const first = args[0] && args[0][1] - args[0][0] === 1 ? stringValue(t[args[0][0]]) : undefined;
        const inner = innerCalls(t.slice(m.open + 1, m.close), line).find((c) => c.label);
        // a computed label's head ("save-") reads as its word
        label = first !== undefined ? shorten(first) : inner?.label ? inner.label.replace(/[\s\-_:#]+$/, '') || kind : kind;
      }
    } else if (t[0]?.text === 'return') {
      kind = 'return';
      label = 'return';
    } else if (t[0]?.text === 'log' && t[1]?.text === '(' && closing(t, 1) === t.length - 1 - (t[t.length - 1].text === ';' ? 1 : 0)) {
      kind = 'log';
      label = 'log';
    }
    const declares = declaredNames(t);
    const isFn =
      kind === 'code' &&
      (t[0]?.text === 'function' ||
        (t[0]?.text === 'async' && t[1]?.text === 'function') ||
        (declares.length === 1 && ['const', 'let'].includes(t[0]?.text) && t[2]?.text === '=' && (t[3]?.text === 'async' || t[3]?.text === 'function' || (t[3]?.text === '(' && t[closing(t, 3) + 1]?.text === '=>') || (t[3]?.kind === 'ident' && t[4]?.text === '=>'))));
    if (kind === 'code') label = declares.length ? `${isFn ? 'function' : t[0].text} ${declares.join(', ')}` : shorten(text.split('\n')[0], 48);
    const calls = innerCalls(t, line);
    const node: Omit<GraphNode, 'id'> = {
      kind,
      label: label.slice(0, 200),
      span: { start: line(st.start), end: line(st.end) },
      ...(phase ? { phase } : {}),
      declares,
      ...(opts ? { opts } : {}),
      ...(optsObject ? { optsObject } : {}),
      ...(promptParts ? { promptParts } : {}),
      ...(promptLocked ? { promptLocked } : {}),
      ...(isFn ? { fn: true } : {}),
      calls: kind === 'code' || kind === 'parallel' || kind === 'pipeline' ? calls : [],
      source: text,
    };
    // plain code next to plain code (setup lines with no calls) reads as one block
    const prev = raw[raw.length - 1];
    const plain = (x: Omit<GraphNode, 'id'>) => x.kind === 'code' && !x.calls.length && !x.fn;
    if (prev && plain(prev.node) && plain(node) && prev.node.phase === node.phase) {
      prev.end = st.end;
      prev.node.span.end = node.span.end;
      prev.node.source = script.slice(prev.start, st.end);
      prev.node.declares.push(...declares);
      const names = prev.node.declares;
      prev.node.label = names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : shorten(prev.node.source.split('\n')[0], 48);
      for (const r of readNames(t)) prev.reads.add(r);
      continue;
    }
    raw.push({ node, start: st.start, end: st.end, reads: readNames(t) });
  }
  const nodes: GraphNode[] = raw.map(({ node }) => {
    const n = (counts.get(node.kind) ?? 0) + 1;
    counts.set(node.kind, n);
    return { id: `${node.kind}-${n}`, ...node };
  });
  const reads = raw.map((r) => r.reads);
  // wires: a later statement that reads a name an earlier one declared
  const edges: GraphEdge[] = [];
  const declaredBy = new Map<string, string>();
  nodes.forEach((node, i) => {
    const own = new Set(node.declares);
    const seen = new Set<string>();
    for (const r of reads[i]) {
      const from = declaredBy.get(r);
      if (!from || own.has(r) || seen.has(from)) continue;
      seen.add(from);
      edges.push({ from, to: node.id, name: r });
    }
    for (const d of node.declares) declaredBy.set(d, node.id);
  });
  return { name, phases, nodes, edges };
}

const MODEL_RE = /^[A-Za-z0-9._:/@[\]+-]{1,160}$/;

/**
 * Apply one literal edit. Only the edited token's bytes change, or one
 * `key: value,` is inserted after the options object's `{`. Throws
 * GraphEditError with the reason when the edit cannot be made.
 */
export function applyEdit(script: string, edit: Pick<GraphEditInput, 'nodeId' | 'field' | 'value' | 'part'>, check?: { agentType?: (name: string) => boolean }): string {
  const graph = parseGraph(script);
  const node = graph.nodes.find((n) => n.id === edit.nodeId);
  if (!node) throw new GraphEditError(`node ${edit.nodeId} is not in the script`);
  if (typeof edit.value !== 'string') throw new GraphEditError('value must be text');
  const value = edit.value;
  const splice = (start: number, end: number, text: string) => script.slice(0, start) + text + script.slice(end);
  if (edit.field === 'prompt') {
    if (node.kind !== 'agent') throw new GraphEditError('only an agent has a prompt');
    if (node.promptLocked) throw new GraphEditError(node.promptLocked);
    const part = node.promptParts?.[edit.part ?? 0];
    if (!part) throw new GraphEditError(`prompt part ${edit.part ?? 0} is not a literal`);
    if (!value.trim()) throw new GraphEditError('the prompt text cannot be empty');
    if (value.length > 20_000) throw new GraphEditError('the prompt text is longer than 20,000 characters');
    return splice(part.start, part.end, quoteString(value, part.quote ?? "'"));
  }
  if (node.kind !== 'agent') throw new GraphEditError(`${edit.field} is an agent option; ${node.id} is a ${node.kind} node`);
  const v = value.trim();
  if (edit.field === 'label') {
    if (!v || v.length > 200) throw new GraphEditError('a label is 1 to 200 characters');
  } else if (edit.field === 'model') {
    if (!MODEL_RE.test(v)) throw new GraphEditError('a model is a tier word (fast, smart, deep) or a model name such as provider/model');
  } else if (edit.field === 'agentType') {
    if (!/^[A-Za-z0-9_:.-]{1,120}$/.test(v)) throw new GraphEditError('an agent type is a name such as explore or builder');
    if (check?.agentType && !check.agentType(v)) throw new GraphEditError(`agent ${v} is not installed here`);
  } else throw new GraphEditError(`field must be model, agentType, label or prompt`);
  const have = node.opts?.[edit.field];
  if (have) {
    if (typeof have.value !== 'string') throw new GraphEditError(`${edit.field} is not a string literal; edit it in the script`);
    return splice(have.start, have.end, quoteString(v, have.quote ?? "'"));
  }
  if (!node.optsObject) throw new GraphEditError(`the options are not an object literal; add ${edit.field} in the script`);
  // the key may be there in a form that is not a literal (label: 'fix ' + round, 'model': x, { model }), or a spread may
  // set it: an inserted key would be overridden at run time, so refuse rather than write an edit that does nothing
  const inner = script.slice(node.optsObject.open, node.optsObject.close);
  const ot = tokenize(script.slice(node.optsObject.open, node.optsObject.close + 1));
  for (const [a] of splitArgs(ot, 0, ot.length - 1)) {
    const k = ot[a];
    if (k.text === '...') throw new GraphEditError(`the options spread another object that may set ${edit.field}; edit it in the script`);
    if ((k.kind === 'ident' ? k.text : stringValue(k)) === edit.field) throw new GraphEditError(`${edit.field} is computed; edit it in the script`);
  }
  const quote = Object.values(node.opts ?? {}).find((o) => o.quote)?.quote ?? "'";
  const empty = !inner.slice(1).trim();
  return splice(node.optsObject.open + 1, node.optsObject.open + 1, `${empty ? ' ' : ' '}${edit.field}: ${quoteString(v, quote)}${empty ? ' ' : ','}`);
}

// ----- a new node from the canvas (docs/design/VISUAL-PROGRAMMING.md 7.5, phase 2) -----

export type InsertKind = 'agent' | 'parallel' | 'check' | 'approve' | 'ask';
export const INSERT_KINDS: InsertKind[] = ['agent', 'parallel', 'check', 'approve', 'ask'];

/** A name no statement in the script uses yet: base, base2, base3... */
export function freshName(toks: Tok[], base: string): string {
  const used = new Set(toks.filter((t) => t.kind === 'ident').map((t) => t.text));
  for (let i = 1; ; i++) if (!used.has(i === 1 ? base : `${base}${i}`)) return i === 1 ? base : `${base}${i}`;
}

function newStatement(kind: InsertKind, toks: Tok[], reads?: string): string {
  const plus = reads ? ` + JSON.stringify(${reads})` : '';
  switch (kind) {
    case 'agent':
      return `const ${freshName(toks, 'step')} = await agent(${reads ? `'Work from this result: '${plus}` : "'Describe the task.'"}, { label: 'new step' })`;
    case 'parallel':
      return `const ${freshName(toks, 'results')} = await parallel([() => agent('First angle.'${plus}, { label: 'angle 1' }), () => agent('Second angle.'${plus}, { label: 'angle 2' })])`;
    case 'check':
      return `const ${freshName(toks, 'check')} = await lib.runCheck('bun test')`;
    case 'approve':
      return `await lib.approve('Go on?')`;
    case 'ask':
      return `const ${freshName(toks, 'answer')} = await lib.ask('Which way?', ['Yes', 'No'])`;
  }
}

/**
 * Insert a new statement for a node: on the line after node `after`, or
 * (no after) before the script's last top-level `return`, else at the end.
 * A wire dropped from a node passes after; the new node reads its first
 * name, so the wire shows. Refuses with GraphEditError (the reason) where
 * the parser cannot place it on a line of its own: after a return, after a
 * statement that shares its last line with another, or when the result does
 * not parse back as exactly one new node of that kind.
 */
export function insertNode(script: string, input: { kind: InsertKind; after?: string }): { script: string; nodeId: string } {
  if (!INSERT_KINDS.includes(input.kind)) throw new GraphEditError(`a new node is one of ${INSERT_KINDS.join(', ')}`);
  const g = parseGraph(script);
  if (g.error) throw new GraphEditError(`the script does not parse: ${g.error}`);
  const toks = tokenize(script);
  const stmts = statements(script, toks);
  const starts = lineStarts(script);
  const line = (o: number) => lineAt(starts, o);
  const lineEnd = (l: number) => (l < starts.length ? starts[l] - 1 : script.length);
  const indentOf = (l: number) => /^[ \t]*/.exec(script.slice(starts[l - 1], lineEnd(l)))![0];
  let at: number;
  let text: string;
  if (input.after) {
    const a = g.nodes.find((n) => n.id === input.after);
    if (!a) throw new GraphEditError(`no node ${input.after}; reload the graph`);
    if (a.kind === 'return') throw new GraphEditError('nothing runs after return; add the node before it');
    // the first statement ending on the node's last line: anything after it on that line is other code
    const st = stmts.find((s) => line(s.end) === a.span.end);
    if (!st) throw new GraphEditError(`cannot find where ${a.label} ends; add it in the script`);
    const rest = script.slice(st.end, lineEnd(a.span.end)).trim();
    if (rest && !rest.startsWith('//')) throw new GraphEditError(`${a.label} shares its last line with other code; add it in the script`);
    at = lineEnd(a.span.end);
    text = `\n${indentOf(a.span.start)}${newStatement(input.kind, toks, a.fn ? undefined : a.declares[0])}`;
  } else {
    const last = stmts.at(-1);
    if (last && last.toks[0]?.text === 'return') {
      const l = line(last.start);
      if (script.slice(starts[l - 1], last.start).trim()) throw new GraphEditError('the return shares its line with other code; add it in the script');
      at = starts[l - 1];
      text = `${indentOf(l)}${newStatement(input.kind, toks)}\n`;
    } else {
      at = script.length;
      text = `${script.endsWith('\n') || !script ? '' : '\n'}${newStatement(input.kind, toks)}\n`;
    }
  }
  const next = script.slice(0, at) + text + script.slice(at);
  // the parser must read it back as one more node of this kind, on its own line
  const g2 = parseGraph(next);
  const kindOf = (x: WorkflowGraph) => x.nodes.filter((n) => n.kind === input.kind).length;
  const newLine = lineAt(lineStarts(next), at + (text.startsWith('\n') ? 1 : 0));
  const added = g2.nodes.find((n) => n.span.start === newLine && n.kind === input.kind);
  if (g2.error || g2.nodes.length !== g.nodes.length + 1 || kindOf(g2) !== kindOf(g) + 1 || !added) throw new GraphEditError('the new node would not read as its own step here; add it in the script');
  return { script: next, nodeId: added.id };
}

/** Layout ids after a node of kind was added as `nodeId`: later nodes of that kind moved up one number. */
export function shiftLayout(positions: GraphPositions, nodeId: string): GraphPositions {
  const [kind, n] = [nodeId.replace(/-\d+$/, ''), Number(nodeId.replace(/^.*-/, ''))];
  const out: GraphPositions = {};
  for (const [id, p] of Object.entries(positions)) {
    const m = /^([a-z]+)-(\d+)$/.exec(id);
    out[m && m[1] === kind && Number(m[2]) >= n ? `${kind}-${Number(m[2]) + 1}` : id] = p;
  }
  return out;
}

// ----- the layout side file (docs/design/VISUAL-PROGRAMMING.md 3.2) -----

export type GraphPositions = Record<string, { x: number; y: number }>;

/** `<name>.layout.json` next to `<name>.js`; the registry loads only `*.js`, so it never reads as a workflow. */
export function layoutPathOf(scriptPath: string): string {
  return `${scriptPath.replace(/\.js$/, '')}.layout.json`;
}

const NODE_ID_RE = /^[a-z]+-\d{1,5}$/;
const snap = (v: number) => Math.round(v / 8) * 8;

/** Positions a canvas sent or a file holds: node ids only, finite numbers on the 8px grid. Anything else is dropped. */
export function cleanPositions(raw: unknown, ids?: Set<string>, idRe: RegExp = NODE_ID_RE): GraphPositions {
  const out: GraphPositions = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>).slice(0, 2000)) {
    if (!idRe.test(id) || (ids && !ids.has(id)) || !p || typeof p !== 'object') continue;
    const { x, y } = p as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) continue;
    out[id] = { x: snap(x), y: snap(y) };
  }
  return out;
}

/** The positions of a layout file's text; a missing or broken file is no positions (the canvas lays out the rest). */
export function readLayout(text: string | undefined, idRe: RegExp = NODE_ID_RE): GraphPositions {
  if (!text) return {};
  try {
    return cleanPositions((JSON.parse(text) as { nodes?: unknown }).nodes, undefined, idRe);
  } catch {
    return {};
  }
}

/** The layout file: keys sorted, one node per line, so a diff shows only the nodes that moved. */
export function printLayout(positions: GraphPositions, scriptSha: string): string {
  const ids = Object.keys(positions).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const lines = ids.map((id) => `    ${JSON.stringify(id)}: { "x": ${positions[id].x}, "y": ${positions[id].y} }`);
  return `{\n  "v": 1,\n  "hash": ${JSON.stringify(`sha256:${scriptSha}`)},\n  "nodes": {${lines.length ? `\n${lines.join(',\n')}\n  ` : ''}}\n}\n`;
}

/**
 * The lines that differ between two texts, as - and + lines, one `@@ line N`
 * hunk per changed run: an insert that also adds a name to the import line is
 * two small hunks, not the whole file removed and added again.
 */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const x = a.slice(s, ea + 1);
  const y = b.slice(s, eb + 1);
  // shortcut: one span when the changed middle is huge (a whole-file rewrite); a real diff library if that gets common
  if (x.length * y.length > 4_000_000) return [`@@ line ${s + 1}`, ...x.map((l) => `- ${l}`), ...y.map((l) => `+ ${l}`)].join('\n');
  // longest common subsequence of the middle, then walk it into hunks
  const w = y.length + 1;
  const L = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
      continue;
    }
    const del: string[] = [];
    const add: string[] = [];
    const at = s + j + 1;
    while ((i < x.length || j < y.length) && !(i < x.length && j < y.length && x[i] === y[j])) {
      if (j >= y.length || (i < x.length && L[(i + 1) * w + j] >= L[i * w + j + 1])) del.push(x[i++]);
      else add.push(y[j++]);
    }
    out.push(`@@ line ${at}`, ...del.map((l) => `- ${l}`), ...add.map((l) => `+ ${l}`));
  }
  return out.length ? out.join('\n') : `@@ line ${s + 1}`;
}
