import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadTool } from '../../src/tools/read';
import { WriteTool } from '../../src/tools/write';
import { EditTool } from '../../src/tools/edit';
import { MultiEditTool } from '../../src/tools/multiedit';
import { applyEdit } from '../../src/tools/edit-core';
import { checkPermission } from '../../src/session/permissions';
import { makeCtx, tempDir, text } from './helpers';

const { dir, cleanup } = tempDir();
afterAll(cleanup);

function file(name: string, content: string | Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** Push the mtime forward so a change is visible even within the same millisecond. */
function touchLater(p: string) {
  const t = new Date(Date.now() + 5_000);
  utimesSync(p, t, t);
}

describe('diffStats', () => {
  test('a removed "-- note" line inside a hunk counts, file headers do not', async () => {
    const p = file('schema.sql', 'a\n-- keep the users table\n++ x\nb\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const out = await WriteTool.run({ file_path: p, content: 'a\nb\n' }, ctx);
    expect(text(out)).toContain('+0 -2 lines');
  });
});

describe('Read', () => {
  test('a relative path resolves in the session folder for Read, Edit and Write (bench run 3)', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'rel', 'tests'), { recursive: true });
    const p = file('rel/tests/test_api.py', 'a = 1\n');
    const ctx = makeCtx({ cwd: join(dir, 'rel') });
    // the read-before-write check still holds, keyed by the absolute path
    expect((await EditTool.run({ file_path: 'tests/test_api.py', old_string: 'a = 1', new_string: 'a = 2' }, ctx)).isError).toBe(true);
    const read = await ReadTool.run({ file_path: 'tests/test_api.py' }, ctx);
    expect(read.isError).toBeFalsy();
    expect(read.meta?.path).toBe(p);
    expect(ctx.readState.has(p)).toBe(true);
    const edit = await EditTool.run({ file_path: './tests/test_api.py', old_string: 'a = 1', new_string: 'a = 2' }, ctx);
    expect(edit.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('a = 2\n');
    const write = await WriteTool.run({ file_path: 'tests/new.py', content: 'b = 1\n' }, ctx);
    expect(text(write)).toContain(`Created ${join(dir, 'rel', 'tests', 'new.py')}`);
  });

  test('a path that dropped a folder of the working directory gets the file it meant (run r4e37h)', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'repo', 'src'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'src', 'entry.ts'), 'x\n');
    const out = await ReadTool.run({ file_path: join(dir, 'src', 'entry.ts') }, makeCtx({ cwd: join(dir, 'repo') }));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain(`Did you mean ${join(dir, 'repo', 'src', 'entry.ts')}?`);
  });

  test('cat -n output, offset and limit, records readState', async () => {
    const p = file('lines.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const ctx = makeCtx({ cwd: dir });
    const out = await ReadTool.run({ file_path: p }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out).split('\n')[0]).toBe('     1\tline 1');
    expect(ctx.readState.has(p)).toBe(true);

    const part = await ReadTool.run({ file_path: p, offset: 3, limit: 2 }, ctx);
    const t = text(part);
    expect(t).toContain('     3\tline 3');
    expect(t).toContain('     4\tline 4');
    expect(t).not.toContain('line 5\n');
    expect(t).toContain('Showing lines 3-4 of 10');
  });

  test('truncates very long lines', async () => {
    const p = file('long.txt', 'x'.repeat(5000));
    const out = await ReadTool.run({ file_path: p }, makeCtx({ cwd: dir }));
    expect(text(out)).toContain('line truncated, 5000 chars total');
  });

  test('empty file note', async () => {
    const p = file('empty.txt', '');
    const out = await ReadTool.run({ file_path: p }, makeCtx({ cwd: dir }));
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain('empty');
  });

  test('missing file suggests similar names', async () => {
    file('Config.json', '{}');
    const out = await ReadTool.run({ file_path: join(dir, 'config.json') }, makeCtx({ cwd: dir }));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('Config.json');
  });

  test('binary files are refused', async () => {
    const p = file('blob.dat', new Uint8Array([0, 1, 2, 3, 0, 255, 0]));
    const out = await ReadTool.run({ file_path: p }, makeCtx({ cwd: dir }));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('binary');
  });

  test('images come back as image blocks', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const p = file('pic.png', png);
    const out = await ReadTool.run({ file_path: p }, makeCtx({ cwd: dir }));
    expect(Array.isArray(out.content)).toBe(true);
    const img = (out.content as any[]).find((b) => b.type === 'image');
    expect(img.mediaType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').equals(Buffer.from(png))).toBe(true);
  });

  test('directories are refused', async () => {
    const out = await ReadTool.run({ file_path: dir }, makeCtx({ cwd: dir }));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('directory');
  });
});

describe('Write', () => {
  test('permission rules judge the path the tool writes, also where resolve does not trim (a remote device)', () => {
    // RemoteMachine.resolve keeps a leading space, so " /etc/hosts" once read as a file inside the session folder
    const machine = { resolve: (p: string, cwd: string) => (p.startsWith('/') ? p : `${cwd}/${p}`) } as never;
    const ctx = makeCtx({ cwd: '/home/me/proj', machine });
    const content = WriteTool.ruleContent!({ file_path: ' /etc/hosts', content: 'x' }, ctx);
    expect(content).toBe('/etc/hosts');
    const check = checkPermission({ tool: WriteTool as never, input: {}, content, mode: 'acceptEdits', rules: { allow: [], deny: [], ask: [] }, sessionAllow: [], cwd: '/home/me/proj', home: '/home/me', workspaceRoots: ['/home/me/proj'] });
    expect(check.decision).toBe('ask');
  });

  test('creates new files without a prior read', async () => {
    const ctx = makeCtx({ cwd: dir });
    const p = join(dir, 'nested', 'deep', 'new.txt');
    const out = await WriteTool.run({ file_path: p, content: 'hello\n' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('hello\n');
    expect(out.meta?.path).toBe(p);
    expect(String(out.meta?.diff)).toContain('+hello');
  });

  test('refuses to overwrite an unread file', async () => {
    const p = file('existing.txt', 'old\n');
    const out = await WriteTool.run({ file_path: p, content: 'new\n' }, makeCtx({ cwd: dir }));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('Read');
    expect(readFileSync(p, 'utf8')).toBe('old\n');
  });

  test('overwrites after read, refuses when stale', async () => {
    const p = file('stale.txt', 'v1\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const ok = await WriteTool.run({ file_path: p, content: 'v2\n' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(String(ok.meta?.diff)).toContain('-v1');

    // someone else changes it
    writeFileSync(p, 'v3\n');
    touchLater(p);
    const stale = await WriteTool.run({ file_path: p, content: 'v4\n' }, ctx);
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain('modified');
    expect(readFileSync(p, 'utf8')).toBe('v3\n');
  });
});

describe('Edit', () => {
  test('requires a prior Read', async () => {
    const p = file('e1.ts', 'const a = 1;\n');
    const out = await EditTool.run({ file_path: p, old_string: 'a = 1', new_string: 'a = 2' }, makeCtx({ cwd: dir }));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('Read');
  });

  test('replaces a unique match and returns a numbered snippet and diff', async () => {
    const p = file('e2.ts', 'line1\nconst a = 1;\nline3\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const out = await EditTool.run({ file_path: p, old_string: 'const a = 1;', new_string: 'const a = 2;' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('line1\nconst a = 2;\nline3\n');
    expect(text(out)).toContain('     2\tconst a = 2;');
    expect(String(out.meta?.diff)).toContain('+const a = 2;');
    // a second edit works without re-reading (readState refreshed)
    const again = await EditTool.run({ file_path: p, old_string: 'line3', new_string: 'line three' }, ctx);
    expect(again.isError).toBeFalsy();
  });

  test('multiple matches need replace_all', async () => {
    const p = file('e3.ts', 'foo();\nbar();\nfoo();\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const out = await EditTool.run({ file_path: p, old_string: 'foo()', new_string: 'baz()' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('matches 2 places');
    expect(text(out)).toContain('lines 1, 3');
    const all = await EditTool.run({ file_path: p, old_string: 'foo()', new_string: 'baz()', replace_all: true }, ctx);
    expect(all.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('baz();\nbar();\nbaz();\n');
  });

  test('not found and identical strings give clear errors', async () => {
    const p = file('e4.ts', 'alpha\nbeta\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const nf = await EditTool.run({ file_path: p, old_string: 'gamma', new_string: 'delta' }, ctx);
    expect(nf.isError).toBe(true);
    expect(text(nf)).toContain('not found');
    const same = await EditTool.run({ file_path: p, old_string: 'alpha', new_string: 'alpha' }, ctx);
    expect(same.isError).toBe(true);
    expect(text(same)).toContain('identical');
  });

  test('refuses stale files', async () => {
    const p = file('e5.ts', 'one\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    writeFileSync(p, 'one\ntwo\n');
    touchLater(p);
    const out = await EditTool.run({ file_path: p, old_string: 'one', new_string: 'uno' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('modified');
  });

  test('curly quotes in the file still match straight quotes and keep their style', async () => {
    const p = file('e6.md', 'He said \u201chello\u201d to me.\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const out = await EditTool.run({ file_path: p, old_string: 'said "hello"', new_string: 'said "goodbye"' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain('curly quotes');
    expect(readFileSync(p, 'utf8')).toBe('He said \u201cgoodbye\u201d to me.\n');
  });

  test('indentation differences are tolerated and re-indented', async () => {
    const p = file('e7.py', 'def f():\n    if x:\n        return 1\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const out = await EditTool.run({ file_path: p, old_string: 'if x:\n    return 1', new_string: 'if y:\n    return 2' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('def f():\n    if y:\n        return 2\n');
  });

  test('keeps CRLF line endings', async () => {
    const p = file('e8.txt', 'a\r\nb\r\nc\r\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const out = await EditTool.run({ file_path: p, old_string: 'a\nb', new_string: 'A\nB' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('A\r\nB\r\nc\r\n');
  });

  test('empty old_string creates a missing file', async () => {
    const p = join(dir, 'created-by-edit.txt');
    const out = await EditTool.run({ file_path: p, old_string: '', new_string: 'fresh\n' }, makeCtx({ cwd: dir }));
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('fresh\n');
  });

  test('line-number prefixes copied from Read are stripped', () => {
    const r = applyEdit('foo\nbar\n', { old_string: '     1\tfoo\n     2\tbar', new_string: '     1\tFOO\n     2\tBAR' }, '/x');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('FOO\nBAR\n');
  });
});

describe('MultiEdit', () => {
  test('applies edits in order, atomically', async () => {
    const p = file('m1.ts', 'let a = 1;\nlet b = 2;\n');
    const ctx = makeCtx({ cwd: dir });
    await ReadTool.run({ file_path: p }, ctx);
    const out = await MultiEditTool.run(
      {
        file_path: p,
        edits: [
          { old_string: 'let a = 1;', new_string: 'let a = 10;' },
          { old_string: 'let a = 10;\nlet b = 2;', new_string: 'let a = 10;\nlet b = 20;' },
        ],
      },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(readFileSync(p, 'utf8')).toBe('let a = 10;\nlet b = 20;\n');

    const bad = await MultiEditTool.run(
      { file_path: p, edits: [{ old_string: 'let a = 10;', new_string: 'let a = 99;' }, { old_string: 'missing', new_string: 'x' }] },
      ctx,
    );
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Edit 2 of 2 failed');
    expect(readFileSync(p, 'utf8')).toBe('let a = 10;\nlet b = 20;\n');
  });
});

/** Smallest useful PDF: one page per entry, each with one line of Helvetica text. */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const n = pages.length;
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((t, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe.skipIf(!Bun.which('pdftotext'))('Read PDF', () => {
  test('extracts text per page and honors pages', async () => {
    const p = file('doc.pdf', makePdf(['Alpha page one', 'Beta page two', 'Gamma page three']));
    const ctx = makeCtx({ cwd: dir });
    const all = text(await ReadTool.run({ file_path: p }, ctx));
    expect(all).toContain('--- page 1 ---');
    expect(all).toContain('Alpha page one');
    expect(all).toContain('Gamma page three');
    const two = text(await ReadTool.run({ file_path: p, pages: '2' }, ctx));
    expect(two).toContain('Beta page two');
    expect(two).not.toContain('Alpha');
    const bad = await ReadTool.run({ file_path: p, pages: 'x-y' }, ctx);
    expect(bad.isError).toBe(true);
  });
});
