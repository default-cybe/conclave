/**
 * A program flow as a node graph, and edits back into its file
 * (docs/design/VISUAL-PROGRAMMING.md 4.2 and 5.3). Code wins: the graph is
 * read from flows/<name>.flow.ts each time, never stored, and the file is
 * never run to read it.
 *
 * The dialect is flat: each top-level statement is one node. Bun allows
 * top-level await, so a flow needs no main() and no nested body parser.
 *
 *   const <id> = '<literal>'                        Value
 *   const <id> = await <helper>({ k: v, ... })      a block from the catalog (plugins.ts)
 *   await <helper>({ ... })                         a block with no output (Log)
 *
 * A literal value is a setting, an identifier or `id.field` is a wire, and
 * `{ url }` is a wire too. Anything else is a Code node with its exact text:
 * its inputs are the names it reads, its outputs the names it declares. The
 * `import ... from './lib'` line is hidden. Built on the workflow graph's
 * tokenizer and statement splitter (workflows/graph.ts).
 */
import type { FlowArg, GraphEdge, GraphNode, WorkflowGraph } from '../client/graph';
import type { FlowOp } from '../client/flows';
import { tokenize, type Tok } from '../workflows/meta';
import { GraphEditError, closing, declaredNames, freshName, lineAt, lineStarts, literalOf, quoteString, readNames, splitArgs, statements, stringValue } from '../workflows/graph';
import { BASE_NAME, BLOCK_BY_HELPER, BLOCK_BY_NAME } from './plugins';

export type FlowGraph = WorkflowGraph & { error?: string };

type Raw = Omit<GraphNode, 'id'> & { id?: string; reads: Set<string> };

const IDENT = /^[A-Za-z_$][\w$]*$/;
const FIELD = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,7}$/;
const NOT_REFS = new Set(['true', 'false', 'null', 'undefined', 'this']);

function isLibImport(t: Tok[]): boolean {
  if (t[0]?.text !== 'import') return false;
  const from = t.findIndex((x) => x.text === 'from');
  const s = from > 0 && t[from + 1] ? stringValue(t[from + 1]) : undefined;
  return s === './lib' || s === './lib/index' || s === './lib/index.ts';
}

/** Literal entries, wires and locked values of `{ ... }` at t[open]..t[close]; undefined when it is not a plain object (spread, method, duplicate key). */
function argsOf(t: Tok[], open: number, close: number): Record<string, FlowArg> | undefined {
  const out: Record<string, FlowArg> = {};
  for (const [a, b] of splitArgs(t, open, close)) {
    const k = t[a];
    if (!k) continue;
    if (b - a === 1 && k.kind === 'ident' && !NOT_REFS.has(k.text)) {
      if (out[k.text]) return undefined;
      out[k.text] = { start: k.start, end: k.end, ref: k.text, shorthand: true };
      continue;
    }
    const key = k.kind === 'ident' ? k.text : stringValue(k);
    if (!key || t[a + 1]?.text !== ':' || b - a < 3 || out[key]) return undefined;
    const v = t.slice(a + 2, b);
    const span = { start: v[0].start, end: v[v.length - 1].end };
    const lit = v.length === 1 ? literalOf(v[0]) : undefined;
    if (lit) out[key] = { ...span, value: lit.value, ...(lit.quote ? { quote: lit.quote } : {}) };
    else if (v.length % 2 === 1 && v[0].kind === 'ident' && !NOT_REFS.has(v[0].text) && v.every((x, i) => (i % 2 ? x.text === '.' : x.kind === 'ident'))) {
      const field = v
        .filter((_, i) => i % 2 === 0)
        .slice(1)
        .map((x) => x.text)
        .join('.');
      out[key] = { ...span, ref: v[0].text, ...(field ? { field } : {}) };
    } else out[key] = { ...span, locked: `${key} is computed; edit it in the code` };
  }
  return out;
}

/** A block statement: Value or a catalog helper call as the whole statement. */
function matchBlock(t: Tok[]): Pick<Raw, 'block' | 'args' | 'optsObject'> & { id?: string } | undefined {
  let i = 0;
  let id: string | undefined;
  const end = t[t.length - 1]?.text === ';' ? t.length - 1 : t.length;
  if (['const', 'let', 'var'].includes(t[0]?.text ?? '') && t[1]?.kind === 'ident' && t[2]?.text === '=') {
    id = t[1].text;
    i = 3;
  }
  if (id && end - i === 1) {
    const lit = literalOf(t[i]);
    if (!lit) return undefined;
    return { id, block: 'value', args: { value: { start: lit.start, end: lit.end, value: lit.value, ...(lit.quote ? { quote: lit.quote } : {}) } } };
  }
  if (t[i]?.text === 'await') i++;
  const spec = t[i]?.kind === 'ident' ? BLOCK_BY_HELPER.get(t[i].text) : undefined;
  if (!spec || t[i + 1]?.text !== '(') return undefined;
  const open = i + 1;
  const close = closing(t, open);
  if (close !== end - 1) return undefined;
  if (close === open + 1) return { id, block: spec.block, args: {} };
  if (t[open + 1]?.text !== '{' || closing(t, open + 1) !== close - 1) return undefined;
  const args = argsOf(t, open + 1, close - 1);
  if (!args) return undefined;
  return { id, block: spec.block, args, optsObject: { open: t[open + 1].start, close: t[close - 1].start } };
}

/** The node graph of a flow file. Never throws: a file that does not tokenize gives no nodes and the reason. */
export function parseFlow(src: string): FlowGraph {
  try {
    return parse(src);
  } catch (err) {
    return { name: '', phases: [], nodes: [], edges: [], error: (err as Error).message };
  }
}

function parse(src: string): FlowGraph {
  let toks: Tok[];
  try {
    toks = tokenize(src);
  } catch (err) {
    return { name: '', phases: [], nodes: [], edges: [], error: (err as Error).message };
  }
  const starts = lineStarts(src);
  const line = (o: number) => lineAt(starts, o);
  const raw: Raw[] = [];
  for (const st of statements(src, toks)) {
    const t = st.toks;
    if (isLibImport(t)) continue;
    const text = src.slice(st.start, st.end);
    const span = { start: line(st.start), end: line(st.end) };
    const range = { start: st.start, end: st.end };
    const m = matchBlock(t);
    if (m) {
      const spec = BLOCK_BY_NAME.get(m.block!)!;
      const reads = new Set(Object.values(m.args ?? {}).flatMap((a) => (a.ref ? [a.ref] : [])));
      raw.push({ ...(m.id ? { id: m.id } : {}), kind: 'block', block: m.block, args: m.args, ...(m.optsObject ? { optsObject: m.optsObject } : {}), label: m.id ?? spec.title, span, declares: m.id ? [m.id] : [], calls: [], source: text, range, reads });
      continue;
    }
    const declares = declaredNames(t);
    const prev = raw[raw.length - 1];
    // code next to code reads as one block; its source and label are set once below, so a long run stays linear
    if (prev && prev.kind === 'code') {
      prev.range!.end = st.end;
      prev.span.end = span.end;
      for (const d of declares) prev.declares.push(d);
      for (const r of readNames(t)) prev.reads.add(r);
      continue;
    }
    raw.push({ kind: 'code', label: '', span, declares, calls: [], source: '', range, reads: readNames(t) });
  }
  for (const r of raw) {
    if (r.kind !== 'code') continue;
    r.source = src.slice(r.range!.start, r.range!.end);
    r.label = r.declares.length ? r.declares.slice(0, 3).join(', ') + (r.declares.length > 3 ? ` +${r.declares.length - 3}` : '') : firstLine(r.source);
  }
  const counts = new Map<string, number>();
  const used = new Set(raw.flatMap((r) => (r.id ? [r.id] : [])));
  const nodes: GraphNode[] = raw.map(({ reads: _r, id, ...n }) => {
    if (id) return { id, ...n };
    const base = n.kind === 'code' ? 'code' : n.block!;
    let k = counts.get(base) ?? 0;
    do k++;
    while (used.has(`${base}-${k}`));
    counts.set(base, k);
    return { id: `${base}-${k}`, ...n };
  });
  const edges: GraphEdge[] = [];
  const declaredBy = new Map<string, string>();
  nodes.forEach((node, i) => {
    if (node.kind === 'block') {
      for (const [input, a] of Object.entries(node.args ?? {})) {
        const from = a.ref ? declaredBy.get(a.ref) : undefined;
        if (from && from !== node.id) edges.push({ from, to: node.id, name: input });
      }
    } else {
      const own = new Set(node.declares);
      const seen = new Set<string>();
      for (const r of raw[i].reads) {
        const from = declaredBy.get(r);
        if (!from || own.has(r) || seen.has(from)) continue;
        seen.add(from);
        edges.push({ from, to: node.id, name: r });
      }
    }
    for (const d of node.declares) declaredBy.set(d, node.id);
  });
  return { name: '', phases: [], nodes, edges };
}

function firstLine(s: string): string {
  const one = (s.slice(0, 4096).split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) ?? s.slice(0, 4096)).trim();
  return one.length > 48 ? `${one.slice(0, 47)}…` : one;
}

// ----- edits (docs/design/VISUAL-PROGRAMMING.md 5.3) -----

function printLiteral(v: string | number | boolean, quote = "'"): string {
  if (typeof v === 'string') return quoteString(v, quote);
  return String(v);
}

function checkValue(block: string, input: string, v: unknown): string | number | boolean {
  const spec = BLOCK_BY_NAME.get(block)?.inputs.find((i) => i.name === input);
  if (!spec) throw new GraphEditError(`${block} has no input ${input}`);
  if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) throw new GraphEditError('a number setting is 0 or more; write other numbers in the code');
  if (block === 'value') {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new GraphEditError('a value is text, a number or true/false');
    return v;
  }
  if (spec.widget === 'toggle' && typeof v !== 'boolean') throw new GraphEditError(`${input} is true or false`);
  if (spec.widget === 'number' && typeof v !== 'number') throw new GraphEditError(`${input} is a number`);
  if ((spec.widget === 'text' || spec.widget === 'combo') && typeof v !== 'string') throw new GraphEditError(`${input} is text`);
  if (spec.widget === 'combo' && !spec.options!.includes(v as string)) throw new GraphEditError(`${input} is one of ${spec.options!.join(', ')}`);
  if (typeof v === 'string' && v.length > 20_000) throw new GraphEditError(`${input} is longer than 20,000 characters`);
  return v as string | number | boolean;
}

const sameShape = (a: FlowGraph, b: FlowGraph) => a.nodes.map((n) => `${n.id}:${n.kind}`).join(',') === b.nodes.map((n) => `${n.id}:${n.kind}`).join(',');

/**
 * Apply one op to a flow's text. set, connect and disconnect replace one
 * input's value span (or add a key after `{`); insert adds a statement on a
 * line of its own; remove deletes a statement's lines. Everything else stays
 * byte for byte. Throws GraphEditError with the reason; the result is checked
 * by parsing it again.
 */
export function applyFlowOp(src: string, op: FlowOp): { src: string; nodeId?: string } {
  const g = parseFlow(src);
  if (g.error) throw new GraphEditError(`the flow does not parse: ${g.error}`);
  const splice = (start: number, end: number, text: string) => src.slice(0, start) + text + src.slice(end);
  const nodeOf = (id: string) => {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) throw new GraphEditError(`no node ${id}; reload the graph`);
    return n;
  };
  const blockOf = (id: string) => {
    const n = nodeOf(id);
    if (n.kind !== 'block') throw new GraphEditError(`${id} is code; edit it in the file`);
    return n;
  };
  // replace an input's value, or add `input: text` after the object's `{`
  const putArg = (n: GraphNode, input: string, text: string): string => {
    const a = n.args?.[input];
    if (a?.locked) throw new GraphEditError(a.locked);
    if (a) return splice(a.start, a.end, a.shorthand ? `${input}: ${text}` : text);
    if (!n.optsObject) throw new GraphEditError(`${n.label} has no settings object; add ${input} in the code`);
    const inner = src.slice(n.optsObject.open + 1, n.optsObject.close);
    return inner.trim() ? splice(n.optsObject.open + 1, n.optsObject.open + 1, ` ${input}: ${text},`) : splice(n.optsObject.open + 1, n.optsObject.close, ` ${input}: ${text} `);
  };
  const checked = (next: string, nodeId?: string) => {
    const g2 = parseFlow(next);
    if (g2.error || !sameShape(g, g2)) throw new GraphEditError('the edit would not read back as the same blocks; edit it in the code');
    return { src: next, ...(nodeId ? { nodeId } : {}) };
  };

  switch (op.op) {
    case 'set': {
      const n = blockOf(op.nodeId);
      const v = checkValue(n.block!, op.input, op.value);
      if (!BLOCK_BY_NAME.get(n.block!)!.inputs.some((i) => i.name === op.input)) throw new GraphEditError(`${n.block} has no input ${op.input}`);
      const quote = n.args?.[op.input]?.quote ?? Object.values(n.args ?? {}).find((a) => a.quote)?.quote;
      return checked(putArg(n, op.input, printLiteral(v, quote)));
    }
    case 'connect': {
      const n = blockOf(op.nodeId);
      if (n.block === 'value') throw new GraphEditError('a Value has no inputs');
      const inp = BLOCK_BY_NAME.get(n.block!)!.inputs.find((i) => i.name === op.input);
      if (!inp) throw new GraphEditError(`${n.block} has no input ${op.input}`);
      // a choice or a switch is a setting picked on the block: a wire of any value into it would not run
      if (inp.widget !== 'text') throw new GraphEditError(`${op.input} is a setting (${inp.widget === 'combo' ? inp.options!.join(', ') : 'true or false'}); pick it on the block`);
      if (!IDENT.test(op.from)) throw new GraphEditError('from is a node name');
      if (op.field !== undefined && op.field !== '' && !FIELD.test(op.field)) throw new GraphEditError('a field is a name such as items or data.items');
      const at = g.nodes.indexOf(n);
      // no forward wires: the name must be declared by a statement above
      if (!g.nodes.slice(0, at).some((x) => x.declares.includes(op.from))) throw new GraphEditError(`${op.from} is not set above ${n.label}; a wire comes from an earlier block`);
      return checked(putArg(n, op.input, op.field ? `${op.from}.${op.field}` : op.from));
    }
    case 'disconnect': {
      const n = blockOf(op.nodeId);
      const a = n.args?.[op.input];
      if (!a?.ref) throw new GraphEditError(`${op.input} has no wire`);
      const spec = BLOCK_BY_NAME.get(n.block!)!.inputs.find((i) => i.name === op.input);
      return checked(putArg(n, op.input, printLiteral(spec?.default ?? '')));
    }
    case 'insert':
      return insertBlock(src, g, op.block, op.after);
    case 'remove': {
      const n = nodeOf(op.nodeId);
      const readers = g.edges.filter((e) => e.from === n.id).map((e) => e.to);
      if (readers.length) throw new GraphEditError(`${[...new Set(readers)].join(', ')} ${readers.length === 1 ? 'reads' : 'read'} ${n.label}; cut those wires first`);
      const starts = lineStarts(src);
      const r = n.range!;
      const l1 = lineAt(starts, r.start);
      const l2 = lineAt(starts, r.end);
      const lineEnd = l2 < starts.length ? starts[l2] : src.length;
      const after = src.slice(r.end, lineEnd).trim();
      if (src.slice(starts[l1 - 1], r.start).trim() || (after && !after.startsWith('//'))) throw new GraphEditError(`${n.label} shares a line with other code; remove it in the file`);
      const next = src.slice(0, starts[l1 - 1]) + src.slice(lineEnd);
      const g2 = parseFlow(next);
      if (g2.error || g2.nodes.length !== g.nodes.length - 1 || g2.nodes.some((x) => x.id === n.id && n.kind === 'block')) throw new GraphEditError('removing it would change other blocks; remove it in the file');
      return { src: next };
    }
    case 'rename':
      return renameBlock(src, g, blockOf(op.nodeId), op.name);
    default:
      throw new GraphEditError('op is set, connect, disconnect, insert, remove or rename');
  }
}

const RESERVED = new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield async of'.split(' '));

/**
 * A block's variable renamed where it is declared and everywhere it is read:
 * every identifier with that name except a property (`x.name`) or an object
 * key; a shorthand `{ name }` becomes `{ name: next }`. Checked by parsing
 * again: the same blocks and the same wires, or it is refused.
 */
function renameBlock(src: string, g: FlowGraph, n: GraphNode, next: string): { src: string; nodeId: string } {
  const old = n.declares[0];
  if (!old) throw new GraphEditError(`${n.label} has no name; it gives no value`);
  if (next === old) return { src, nodeId: n.id };
  if (!IDENT.test(next) || next.length > 64 || RESERVED.has(next)) throw new GraphEditError('a name is letters, digits, _ or $, not starting with a digit, and not a JavaScript word');
  const toks = tokenize(src);
  const word = (name: string) => new RegExp(`(^|[^\\w$])${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}($|[^\\w$])`);
  if (toks.some((t) => (t.kind === 'ident' && t.text === next) || (t.kind === 'tmpl' && word(next).test(t.text)))) throw new GraphEditError(`${next} is used in this flow already`);
  // a name inside a template's ${...} is one token to the parser: it could not be renamed safely
  if (toks.some((t) => t.kind === 'tmpl' && t.interp && word(old).test(t.text))) throw new GraphEditError(`a template reads ${old}; rename it in the code`);
  const stack: string[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  toks.forEach((t, i) => {
    if (t.text === '{' || t.text === '[' || t.text === '(') stack.push(t.text);
    else if (t.text === '}' || t.text === ']' || t.text === ')') stack.pop();
    if (t.kind !== 'ident' || t.text !== old) return;
    const prev = toks[i - 1]?.text;
    const nxt = toks[i + 1]?.text;
    if (prev === '.' || prev === '?.') return;
    const inObject = stack[stack.length - 1] === '{' && (prev === '{' || prev === ',');
    if (inObject && (nxt === ':' || nxt === '(')) return;
    edits.push({ start: t.start, end: t.end, text: inObject && (nxt === '}' || nxt === ',') ? `${old}: ${next}` : next });
  });
  let out = src;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  const g2 = parseFlow(out);
  const ids = (x: FlowGraph, from: string, to: string) => x.nodes.map((m) => `${m.kind}:${m.block ?? ''}:${m.id === from ? to : m.id}`).join(',');
  const wires = (x: FlowGraph, from: string, to: string) =>
    x.edges
      // a wire into code is named after the variable; into a block, after the input
      .map((e) => `${e.from === from ? to : e.from}>${e.to === from ? to : e.to}.${e.name === from && !x.nodes.find((m) => m.id === e.to && m.kind === 'block') ? to : e.name}`)
      .sort()
      .join(',');
  if (g2.error || ids(g, n.id, next) !== ids(g2, '', '') || wires(g, old, next) !== wires(g2, '', '')) throw new GraphEditError(`some code reads ${old} in a way the canvas cannot rename; rename it in the code`);
  return { src: out, nodeId: next };
}

/** A new block's statement after node `after` (its first input wired to after's output), else at the end of the file. */
function insertBlock(src: string, g: FlowGraph, block: string, afterId?: string): { src: string; nodeId: string } {
  const spec = BLOCK_BY_NAME.get(block);
  if (!spec) throw new GraphEditError(`no block ${block}`);
  const toks = tokenize(src);
  const starts = lineStarts(src);
  const crlf = src.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
  const a = afterId ? g.nodes.find((n) => n.id === afterId) : undefined;
  if (afterId && !a) throw new GraphEditError(`no node ${afterId}; reload the graph`);
  const from = a?.declares[0];
  const id = spec.output ? freshName(toks, BASE_NAME[block] ?? block) : undefined;
  // the wire goes to the first input that starts empty (the data input), else the first one
  const wired = Math.max(0, spec.inputs.findIndex((inp) => inp.default === ''));
  // always `;`: without it a next line that starts with ( [ or ` would continue the new statement
  let stmt: string;
  if (block === 'value') stmt = `const ${id} = '';`;
  else {
    const entries = spec.inputs.map((inp, i) => `${inp.name}: ${i === wired && from ? from : printLiteral(inp.default)}`);
    stmt = `${id ? `const ${id} = ` : ''}await ${spec.helper}({ ${entries.join(', ')} });`;
  }
  let at: number;
  let text: string;
  if (a) {
    const l = lineAt(starts, a.range!.end);
    const lineEnd = l < starts.length ? starts[l] - 1 - (crlf && src[starts[l] - 2] === '\r' ? 1 : 0) : src.length;
    const rest = src.slice(a.range!.end, lineEnd).trim();
    if (rest && !rest.startsWith('//')) throw new GraphEditError(`${a.label} shares its last line with other code; add it in the file`);
    const l0 = lineAt(starts, a.range!.start);
    const indent = /^[ \t]*/.exec(src.slice(starts[l0 - 1]))![0];
    at = lineEnd;
    text = `${eol}${indent}${stmt}`;
  } else {
    at = src.length;
    text = `${src.endsWith('\n') || !src ? '' : eol}${stmt}${eol}`;
  }
  const next = src.slice(0, at) + text + src.slice(at);
  const g2 = parseFlow(next);
  const newLine = lineAt(lineStarts(next), at + (text.startsWith(eol) ? eol.length : 0));
  const added = g2.nodes.find((n) => n.span.start === newLine && n.kind === 'block' && n.block === block);
  if (g2.error || g2.nodes.length !== g.nodes.length + 1 || !added) throw new GraphEditError('the new block would not read as its own step here; add it in the file');
  return { src: spec.helper ? withImport(next, spec.helper, eol) : next, nodeId: added.id };
}

/** The helper named in the `import { ... } from './lib'` line, added when missing (a line of its own at the top when there is none). */
function withImport(src: string, helper: string, eol: string): string {
  const toks = tokenize(src);
  for (const st of statements(src, toks)) {
    if (!isLibImport(st.toks)) continue;
    const t = st.toks;
    const o = t.findIndex((x) => x.text === '{');
    // import * as lib: every helper is there already
    if (o < 0) return src;
    const c = closing(t, o);
    const inner = t.slice(o + 1, c);
    if (inner.some((x) => x.text === helper)) return src;
    const last = inner.filter((x) => x.text !== ',').at(-1);
    return last ? `${src.slice(0, last.end)}, ${helper}${src.slice(last.end)}` : `${src.slice(0, t[o].start + 1)} ${helper} ${src.slice(t[c].start)}`;
  }
  return `import { ${helper} } from './lib';${eol}${src}`;
}
