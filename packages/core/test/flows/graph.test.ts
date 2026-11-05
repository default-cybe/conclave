/**
 * Program flows as graphs and edits back into the file (flows/graph.ts,
 * docs/design/VISUAL-PROGRAMMING.md 4.2 and 5.3): each block shape parses,
 * foreign code becomes Code nodes, the parser never throws or runs the file,
 * and each op changes only its own span and leaves valid TypeScript.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyFlowOp, parseFlow } from '../../src/flows/graph';
import { FLOW_BLOCKS } from '../../src/flows/plugins';
import { flowTemplate } from '../../src/flows/lib';

const fixture = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', `${n}.flow.ts`), 'utf8');
const scraper = fixture('scraper');
const mixed = fixture('mixed');
const transpiler = new Bun.Transpiler({ loader: 'ts' });
/** Valid TypeScript: Bun's parser accepts it (it throws on a syntax error). */
const parses = (src: string) => expect(() => transpiler.transformSync(src)).not.toThrow();

/** The part of `b` that differs from `a`, as [prefix length, suffix length]. */
function changed(a: string, b: string): { pre: number; suf: number } {
  let pre = 0;
  while (pre < a.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

describe('parseFlow', () => {
  test('the scraper reads as six blocks wired in a line', () => {
    const g = parseFlow(scraper);
    expect(g.error).toBeUndefined();
    expect(g.nodes.map((n) => `${n.id}:${n.block}`)).toEqual(['url:value', 'data:fetchUrl', 'posts:pick', 'bun:filter', 'csv:writeCsv', 'log-1:log']);
    expect(g.edges.map((e) => `${e.from}>${e.to}.${e.name}`)).toEqual(['url>data.url', 'data>posts.from', 'posts>bun.items', 'bun>csv.rows', 'csv>log-1.value']);
    const bun = g.nodes.find((n) => n.id === 'bun')!;
    expect(bun.args?.op?.value).toBe('contains');
    expect(bun.args?.items?.ref).toBe('posts');
    // { url } shorthand is a wire
    expect(g.nodes[1].args?.url).toMatchObject({ ref: 'url', shorthand: true });
  });

  test('every block kind parses from its own starter statement', () => {
    for (const spec of FLOW_BLOCKS) {
      const src = `import { x } from './lib';\nconst a = 'seed';\n`;
      const { src: next, nodeId } = applyFlowOp(src, { op: 'insert', block: spec.block });
      parses(next);
      const n = parseFlow(next).nodes.find((x) => x.id === nodeId)!;
      expect(n.kind).toBe('block');
      expect(n.block).toBe(spec.block);
      for (const inp of spec.block === 'value' ? [] : spec.inputs) expect(n.args?.[inp.name]?.value).toBe(inp.default);
    }
  });

  test('foreign code, comments, annotations and computed values', () => {
    const g = parseFlow(mixed);
    expect(g.error).toBeUndefined();
    const kinds = g.nodes.map((n) => `${n.id}:${n.kind}`);
    // `const limit: number = 3` has an annotation: code. The function and the line after merge into one Code node.
    expect(kinds).toContain('code-1:code');
    expect(g.nodes.find((n) => n.id === 'code-1')!.declares).toEqual(['limit']);
    const code2 = g.nodes.find((n) => n.id === 'code-2')!;
    expect(code2.declares).toEqual(['top', 'double', 'doubled']);
    expect(g.edges).toContainEqual({ from: 'nums', to: 'code-2', name: 'nums' });
    expect(g.edges).toContainEqual({ from: 'code-2', to: 'names', name: 'items' });
    // a template with ${} is locked with a reason; raw.stdout is a wire with a field
    expect(g.nodes.find((n) => n.id === 'saved')!.args?.path?.locked).toContain('edit it in the code');
    expect(g.nodes.find((n) => n.id === 'parsed')!.args?.text).toMatchObject({ ref: 'raw', field: 'stdout' });
    // the import line and the comments are hidden
    expect(g.nodes.some((n) => n.source?.includes('import'))).toBe(false);
  });

  test('node spans and the gaps between them give the file back byte for byte', () => {
    for (const src of [scraper, mixed, mixed.replace(/\n/g, '\r\n')]) {
      const g = parseFlow(src);
      let at = 0;
      let rebuilt = '';
      for (const n of g.nodes) {
        expect(n.range!.start).toBeGreaterThanOrEqual(at);
        const gap = src.slice(at, n.range!.start);
        // only blanks, comments and the lib import live between nodes
        expect(gap.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|import \{[^}]*\} from '\.\/lib';?|\s/g, '')).toBe('');
        rebuilt += gap + src.slice(n.range!.start, n.range!.end);
        expect(src.slice(n.range!.start, n.range!.end)).toBe(n.source!);
        at = n.range!.end;
      }
      expect(rebuilt + src.slice(at)).toBe(src);
    }
  });

  test('never throws and never runs the file', () => {
    globalThis.__flowRan = false;
    const bad = ['const a = "open', 'const x = await fetchUrl({ url: `${', '}}}{{{', '\u0000\uffff', 'globalThis.__flowRan = true', 'const a = await pick({ ...rest })', ''];
    for (const s of bad) expect(() => parseFlow(s)).not.toThrow();
    expect(globalThis.__flowRan).toBe(false);
    expect(parseFlow('const a = "open').error).toBeTruthy();
    // a spread is not a plain settings object: code
    expect(parseFlow('const a = await pick({ ...rest })').nodes[0].kind).toBe('code');
  });

  test('the starter flow is all blocks', () => {
    const g = parseFlow(flowTemplate('hn'));
    expect(g.nodes.every((n) => n.kind === 'block')).toBe(true);
    parses(flowTemplate('hn'));
  });
});

declare global {
  var __flowRan: boolean;
}

describe('applyFlowOp', () => {
  test('set writes one literal; the rest of the file is byte-identical', () => {
    const { src } = applyFlowOp(scraper, { op: 'set', nodeId: 'bun', input: 'value', value: "it's \"bun\"" });
    const g = parseFlow(scraper);
    const a = g.nodes.find((n) => n.id === 'bun')!.args!.value!;
    expect(src.slice(0, a.start)).toBe(scraper.slice(0, a.start));
    expect(src.slice(src.length - (scraper.length - a.end))).toBe(scraper.slice(a.end));
    expect(parseFlow(src).nodes.find((n) => n.id === 'bun')!.args!.value!.value).toBe("it's \"bun\"");
    parses(src);
    // a combo takes only its options; a Value takes a number
    expect(() => applyFlowOp(scraper, { op: 'set', nodeId: 'bun', input: 'op', value: 'like' })).toThrow('one of');
    const v = applyFlowOp(scraper, { op: 'set', nodeId: 'url', input: 'value', value: 42 }).src;
    expect(v).toContain('const url = 42');
  });

  test('set on a missing key adds it after the brace', () => {
    const src = "import { regex } from './lib';\nconst m = await regex({ text: 'a1' });\n";
    const next = applyFlowOp(src, { op: 'set', nodeId: 'm', input: 'many', value: false }).src;
    expect(next).toBe("import { regex } from './lib';\nconst m = await regex({ many: false, text: 'a1' });\n");
  });

  test('connect and disconnect replace one value span', () => {
    const c = applyFlowOp(scraper, { op: 'connect', nodeId: 'csv', input: 'path', from: 'data', field: 'name' }).src;
    const d = changed(scraper, c);
    expect(scraper.slice(d.pre, scraper.length - d.suf)).toBe("'out/posts.csv'");
    expect(c.slice(d.pre, c.length - d.suf)).toBe('data.name');
    expect(parseFlow(c).edges).toContainEqual({ from: 'data', to: 'csv', name: 'path' });
    parses(c);
    const back = applyFlowOp(c, { op: 'disconnect', nodeId: 'csv', input: 'path' }).src;
    expect(back).toBe(scraper.replace("'out/posts.csv'", "'out/rows.csv'"));
    // a choice or a switch takes no wire
    expect(() => applyFlowOp(scraper, { op: 'connect', nodeId: 'bun', input: 'op', from: 'url' })).toThrow('is a setting');
    // a shorthand wire cut gets its key back
    const cut = applyFlowOp(scraper, { op: 'disconnect', nodeId: 'data', input: 'url' }).src;
    expect(cut).toContain("fetchUrl({ url: 'https://example.com', as:");
    parses(cut);
  });

  test('forward wires, unknown nodes and code nodes are refused', () => {
    expect(() => applyFlowOp(scraper, { op: 'connect', nodeId: 'data', input: 'url', from: 'csv' })).toThrow('earlier block');
    expect(() => applyFlowOp(scraper, { op: 'connect', nodeId: 'data', input: 'url', from: 'data' })).toThrow('earlier block');
    expect(() => applyFlowOp(scraper, { op: 'connect', nodeId: 'data', input: 'url', from: 'url; process.exit()' })).toThrow('node name');
    expect(() => applyFlowOp(scraper, { op: 'set', nodeId: 'nope', input: 'x', value: 'y' })).toThrow('no node');
    expect(() => applyFlowOp(mixed, { op: 'set', nodeId: 'code-1', input: 'x', value: 'y' })).toThrow('is code');
    expect(() => applyFlowOp(mixed, { op: 'set', nodeId: 'saved', input: 'path', value: 'y' })).toThrow('computed');
  });

  test('insert after a node wires its first input and adds the import', () => {
    const { src, nodeId } = applyFlowOp(scraper, { op: 'insert', block: 'map', after: 'bun' });
    expect(nodeId).toBe('mapped');
    parses(src);
    expect(src).toContain("import { fetchUrl, pick, filter, writeCsv, log, map } from './lib';");
    expect(src).toContain("const bun = await filter({ items: posts, field: 'title', op: 'contains', value: 'bun' });\nconst mapped = await map({ items: bun, field: 'title' });\nconst csv");
    const g = parseFlow(src);
    expect(g.nodes.map((n) => n.id)).toEqual(['url', 'data', 'posts', 'bun', 'mapped', 'csv', 'log-1']);
    expect(g.edges).toContainEqual({ from: 'bun', to: 'mapped', name: 'items' });
    // names are fresh
    expect(applyFlowOp(src, { op: 'insert', block: 'map' }).nodeId).toBe('mapped2');
    // a file with no import line gets one
    expect(applyFlowOp('const a = 1\n', { op: 'insert', block: 'log', after: 'a' }).src).toBe("import { log } from './lib';\nconst a = 1\nawait log({ value: a });\n");
    // the wire goes to the data input, not the first setting
    expect(applyFlowOp(scraper, { op: 'insert', block: 'writeFile', after: 'bun' }).src).toContain("await writeFile({ path: 'out/out.txt', text: bun });");
  });

  test('insert ends with ; so a next line starting with [ ( or ` stays its own statement', () => {
    for (const next of ['[1, 2].forEach((x) => x)', '(() => 1)()', '`t`.length']) {
      const { src } = applyFlowOp(`const a = 'x'\n${next}\n`, { op: 'insert', block: 'log', after: 'a' });
      expect(src).toContain(`await log({ value: a });\n${next}`);
      parses(src);
    }
  });

  test('a long run of code statements parses in linear time', () => {
    const t0 = performance.now();
    const g = parseFlow('x()\n'.repeat(65_000));
    expect(g.nodes.length).toBe(1);
    expect(g.nodes[0].source.length).toBe(65_000 * 4 - 1);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  test('remove deletes the lines, refused while another node reads it', () => {
    expect(() => applyFlowOp(scraper, { op: 'remove', nodeId: 'bun' })).toThrow('cut those wires first');
    const { src } = applyFlowOp(scraper, { op: 'remove', nodeId: 'log-1' });
    expect(src).toBe(scraper.replace('await log({ value: csv });\n', ''));
    parses(src);
  });

  test('rename changes the name where it is set and read, not properties or keys', () => {
    const src = "import { pick, log } from './lib';\nconst posts = await pick({ from: 'x', field: 'posts' });\nconst n = posts.length + posts.posts;\nconst o = { posts: 1 };\nconst p = { posts };\nawait log({ value: posts });\n";
    const { src: next, nodeId } = applyFlowOp(src, { op: 'rename', nodeId: 'posts', name: 'items' });
    expect(nodeId).toBe('items');
    expect(next).toBe("import { pick, log } from './lib';\nconst items = await pick({ from: 'x', field: 'posts' });\nconst n = items.length + items.posts;\nconst o = { posts: 1 };\nconst p = { posts: items };\nawait log({ value: items });\n");
    parses(next);
    // the scraper's shorthand `{ url }` keeps its key
    expect(applyFlowOp(scraper, { op: 'rename', nodeId: 'url', name: 'page' }).src).toContain("const page = '");
    expect(applyFlowOp(scraper, { op: 'rename', nodeId: 'url', name: 'page' }).src).toContain('fetchUrl({ url: page');
    expect(() => applyFlowOp(scraper, { op: 'rename', nodeId: 'url', name: 'data' })).toThrow('used in this flow already');
    expect(() => applyFlowOp(scraper, { op: 'rename', nodeId: 'url', name: 'class' })).toThrow('JavaScript word');
    expect(() => applyFlowOp(scraper, { op: 'rename', nodeId: 'url', name: '1x' })).toThrow('a name is');
    expect(() => applyFlowOp(scraper, { op: 'rename', nodeId: 'log-1', name: 'x' })).toThrow('has no name');
    // a template reads it: refused, the file is not touched
    expect(() => applyFlowOp("const a = 'x';\nconst b = `${a}!`;\n", { op: 'rename', nodeId: 'a', name: 'z' })).toThrow('template');
  });

  test('CRLF files keep CRLF', () => {
    const crlf = scraper.replace(/\n/g, '\r\n');
    const { src } = applyFlowOp(crlf, { op: 'insert', block: 'log', after: 'csv' });
    expect(src.replace(/\r\n/g, '')).not.toContain('\n');
    parses(src);
  });
});
