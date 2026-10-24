import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GlobTool } from '../../src/tools/glob';
import { GrepTool } from '../../src/tools/grep';
import { LSTool } from '../../src/tools/ls';
import { RepoMapTool, extractSymbols } from '../../src/tools/repo-map';
import { hasRg, makeCtx, tempDir, text } from './helpers';

const { dir: rawDir, cleanup } = tempDir();
const dir = realpathSync(rawDir);

function put(rel: string, content: string, ageSec = 0) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  if (ageSec) {
    const t = new Date(Date.now() - ageSec * 1000);
    utimesSync(p, t, t);
  }
  return p;
}

beforeAll(() => {
  // a git repo so .gitignore applies
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  put('.gitignore', 'ignored/\n');
  put('src/engine.ts', 'export class Engine {\n  run(input: string) {\n    return helperFunction(input);\n  }\n}\n', 30);
  put('src/util.ts', 'export function helperFunction(x: string) {\n  return x.toUpperCase();\n}\n', 20);
  put('src/app.ts', "import { Engine } from './engine';\nimport { helperFunction } from './util';\nconst e = new Engine();\nhelperFunction('a');\n", 10);
  put('src/lower.py', 'def search_things(q):\n    return q\n\nclass Finder:\n    def find(self):\n        pass\n');
  put('ignored/skip.ts', 'export const hidden = helperFunction;\n');
  put('README.md', '# Title\nhelperFunction is documented here\n');
});
afterAll(cleanup);

describe.skipIf(!hasRg)('Glob', () => {
  test('finds files sorted by mtime, absolute, skipping ignored', async () => {
    const out = await GlobTool.run({ pattern: '**/*.ts' }, makeCtx({ cwd: dir }));
    const files = text(out).split('\n');
    expect(files).toEqual([join(dir, 'src/app.ts'), join(dir, 'src/util.ts'), join(dir, 'src/engine.ts')]);
  });

  test('pattern without slash matches at any depth; path param works', async () => {
    const out = await GlobTool.run({ pattern: '*.py', path: join(dir, 'src') }, makeCtx({ cwd: '/' }));
    expect(text(out)).toBe(join(dir, 'src/lower.py'));
  });

  test('absolute pattern', async () => {
    const out = await GlobTool.run({ pattern: join(dir, 'src', '*.py') }, makeCtx({ cwd: '/' }));
    expect(text(out)).toBe(join(dir, 'src/lower.py'));
  });

  test('no matches', async () => {
    const out = await GlobTool.run({ pattern: '**/*.zig' }, makeCtx({ cwd: dir }));
    expect(text(out)).toContain('No files found');
  });
});

describe.skipIf(!hasRg)('Grep', () => {
  test('files_with_matches by default', async () => {
    const out = await GrepTool.run({ pattern: 'helperFunction' }, makeCtx({ cwd: dir }));
    const t = text(out);
    expect(t).toContain('Found 4 files');
    expect(t).toContain(join(dir, 'src/util.ts'));
    expect(t).toContain(join(dir, 'src/engine.ts'));
    expect(t).toContain(join(dir, 'README.md'));
    expect(t).not.toContain('ignored/skip.ts');
  });

  test('content mode with line numbers, glob and context', async () => {
    const out = await GrepTool.run({ pattern: 'toUpperCase', output_mode: 'content', glob: '*.ts', '-B': 1 }, makeCtx({ cwd: dir }));
    const t = text(out);
    expect(t).toContain(`${join(dir, 'src/util.ts')}:2:  return x.toUpperCase();`);
    expect(t).toContain(`${join(dir, 'src/util.ts')}-1-export function helperFunction`);
  });

  test('count mode, case-insensitive and type filter', async () => {
    const out = await GrepTool.run({ pattern: 'HELPERFUNCTION', output_mode: 'count', '-i': true, type: 'ts' }, makeCtx({ cwd: dir }));
    const t = text(out);
    expect(t).toContain(`${join(dir, 'src/app.ts')}:2`);
    expect(t).not.toContain('README');
    expect(t).toMatch(/^4 matches in 3 files/);
  });

  test('head_limit and offset paginate', async () => {
    const first = await GrepTool.run({ pattern: 'helperFunction', output_mode: 'content', head_limit: 2 }, makeCtx({ cwd: dir }));
    expect(text(first)).toContain('Pass offset=2');
    const second = await GrepTool.run({ pattern: 'helperFunction', output_mode: 'content', head_limit: 2, offset: 2 }, makeCtx({ cwd: dir }));
    expect(text(second)).not.toBe(text(first));
  });

  test('a single file path with no output_mode shows matching lines', async () => {
    const out = await GrepTool.run({ pattern: 'to[A-Z][a-z]+Case', path: join(dir, 'src/util.ts') }, makeCtx({ cwd: dir }));
    expect(text(out)).toContain('2:  return x.toUpperCase();');
    expect(text(out)).not.toContain('Found 1 file');
    // an explicit mode still wins
    const files = await GrepTool.run({ pattern: 'toUpperCase', path: join(dir, 'src/util.ts'), output_mode: 'files_with_matches' }, makeCtx({ cwd: dir }));
    expect(text(files)).toContain('Found 1 file');
  });

  test('multiline', async () => {
    const out = await GrepTool.run({ pattern: 'class Engine \\{\\s+run', multiline: true, output_mode: 'files_with_matches' }, makeCtx({ cwd: dir }));
    expect(text(out)).toContain('engine.ts');
  });

  test('invalid regex is an error', async () => {
    const out = await GrepTool.run({ pattern: '(unclosed' }, makeCtx({ cwd: dir }));
    expect(out.isError).toBe(true);
  });
});

describe('LS', () => {
  test('lists two levels, dirs first', async () => {
    const out = await LSTool.run({ path: dir, ignore: ['*.md'] }, makeCtx({ cwd: dir }));
    const t = text(out);
    expect(t).toContain('- src/');
    expect(t).toContain('    - engine.ts');
    expect(t).not.toContain('README.md');
    expect(t).toContain('- .git/ (not expanded)');
  });
  test('a relative path lists that folder of the session', async () => {
    const out = await LSTool.run({ path: 'src' }, makeCtx({ cwd: dir }));
    expect(out.isError).toBeFalsy();
    expect(text(out).split('\n')[0]).toBe(`${join(dir, 'src')}/`);
  });
});

describe('RepoMap', () => {
  test('symbol extraction', () => {
    const ts = extractSymbols('a.ts', 'export class Foo {\n  bar(x: number) {\n  }\n}\nexport const baz = () => 1;\nconst internal = 5;\nfunction helper() {}\n');
    expect(ts.map((s) => s.name)).toEqual(['Foo', 'bar', 'baz', 'helper']);
    const py = extractSymbols('a.py', 'class A:\n    def go(self):\n        pass\n    def _hidden(self):\n        pass\ndef top():\n    pass\n');
    expect(py.map((s) => s.name)).toEqual(['A', 'go', 'top']);
    const go = extractSymbols('a.go', 'package x\nfunc (s *Server) Start() error {\n}\ntype Server struct {\n}\nfunc helper() {}\n');
    expect(go.map((s) => s.name)).toEqual(['Start', 'Server', 'helper']);
    const rs = extractSymbols('a.rs', 'pub struct Thing {}\nimpl Thing {\n    pub fn new() -> Self {}\n}\nfn private_fn() {}\n');
    expect(rs.map((s) => s.name)).toEqual(['Thing', 'Thing', 'new', 'private_fn']);
  });

  test.skipIf(!hasRg)('ranks referenced files first', async () => {
    const out = await RepoMapTool.run({}, makeCtx({ cwd: dir }));
    const t = text(out);
    expect(t).toContain('Repository map of');
    const utilAt = t.indexOf('src/util.ts');
    const appAt = t.indexOf('src/app.ts');
    expect(utilAt).toBeGreaterThan(-1);
    expect(utilAt).toBeLessThan(appAt === -1 ? Infinity : appAt);
    expect(t).toContain('export function helperFunction(x: string)');
    expect(t).not.toContain('ignored/');
  });

  test.skipIf(!hasRg)('focus boosts matching files', async () => {
    const out = await RepoMapTool.run({ focus: 'finder search' }, makeCtx({ cwd: dir }));
    const t = text(out);
    const firstFile = t.split('\n')[2];
    expect(firstFile).toContain('src/lower.py');
  });
});
