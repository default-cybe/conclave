import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadMark, ToolContext } from '../../src/tools/types';
import { EditTool } from '../../src/tools/edit';
import { MultiEditTool } from '../../src/tools/multiedit';
import { ReadTool } from '../../src/tools/read';
import { WriteTool } from '../../src/tools/write';
import { makeCtx, tempDir, text } from './helpers';

/**
 * HARNESS-REVIEW item 17: Read results record a content hash, and Edit and
 * Write judge staleness by it when the runner hands them the read marks.
 */

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A context whose read marks come from the results it saw, as the runner keeps them. */
function markedCtx(cwd: string): ToolContext & { marks: Map<string, ReadMark> } {
  const marks = new Map<string, ReadMark>();
  return Object.assign(makeCtx({ cwd }), { marks, readMark: (p: string) => marks.get(p) });
}
const keep = (ctx: { marks: Map<string, ReadMark> }, meta: Record<string, unknown> | undefined) => {
  const m = meta?.readMark as ReadMark | undefined;
  if (m) ctx.marks.set(m.path, m);
};

function setup(content: string): { dir: string; file: string } {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const file = join(dir, 'a.ts');
  writeFileSync(file, content);
  return { dir, file };
}

describe('read marks', () => {
  test('a Read result carries path, mtime and the sha256 of the text', async () => {
    const { dir, file } = setup('const a = 1;\n');
    const out = await ReadTool.run({ file_path: file }, markedCtx(dir));
    const mark = out.meta?.readMark as ReadMark;
    expect(mark.path).toBe(file);
    expect(mark.mtimeMs).toBe(statSync(file).mtimeMs);
    expect(mark.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a change that keeps the mtime is refused; the mtime map alone let it through', async () => {
    const { dir, file } = setup('const a = 1;\n');
    const ctx = markedCtx(dir);
    keep(ctx, (await ReadTool.run({ file_path: file }, ctx)).meta);
    const { atime, mtime } = statSync(file);
    writeFileSync(file, 'const a = 2;\n');
    utimesSync(file, atime, mtime);

    const edit = { file_path: file, old_string: 'const a', new_string: 'let a' };
    const refused = await EditTool.run(edit, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('was modified after you last read it');
    expect(refused.meta?.writeRefused).toBe(true);

    // the old check: the same mtime passed
    const old = makeCtx({ cwd: dir, readState: new Map([[file, mtime.getTime()]]) });
    expect((await EditTool.run(edit, old)).isError).toBeFalsy();
  });

  test('an mtime that moved without a change passes; edits refresh the mark, so a second edit needs no Read', async () => {
    const { dir, file } = setup('const a = 1;\nconst b = 2;\n');
    const ctx = markedCtx(dir);
    keep(ctx, (await ReadTool.run({ file_path: file }, ctx)).meta);
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    const first = await EditTool.run({ file_path: file, old_string: 'const a', new_string: 'let a' }, ctx);
    expect(first.isError).toBeFalsy();
    keep(ctx, first.meta);
    const second = await EditTool.run({ file_path: file, old_string: 'const b', new_string: 'let b' }, ctx);
    expect(second.isError).toBeFalsy();
    keep(ctx, second.meta);
    const write = await WriteTool.run({ file_path: file, content: 'export {};\n' }, ctx);
    expect(write.isError).toBeFalsy();
  });

  test('no mark (a compaction dropped the Read) refuses the edit even when the mtime map has the file', async () => {
    const { dir, file } = setup('x\n');
    const ctx = markedCtx(dir);
    ctx.readState.set(file, statSync(file).mtimeMs);
    const out = await WriteTool.run({ file_path: file, content: 'y\n' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('has not been read yet');
  });

  test('a file never read: an exact old_string goes through when Read is allowed, anything looser is refused', async () => {
    const { dir, file } = setup('const a = 1;\nconst b = 2;\n');
    const ctx = Object.assign(markedCtx(dir), { readAllowed: () => true });
    // the agent saw the file through cat in Bash, so it knows the text
    const ok = await EditTool.run({ file_path: file, old_string: 'const a = 1;', new_string: 'let a = 1;' }, ctx);
    expect(ok.isError).toBeFalsy();
    keep(ctx, ok.meta);

    const { file: other } = setup('x = 1\ny = 2\n');
    const multi = await MultiEditTool.run({ file_path: other, edits: [{ old_string: 'x = 1', new_string: 'x = 3' }, { old_string: 'y = 2', new_string: 'y = 4' }] }, ctx);
    expect(multi.isError).toBeFalsy();
    expect(readFileSync(other, 'utf8')).toBe('x = 3\ny = 4\n');

    // a whitespace-only match means the agent did not see the text as it is
    const { file: third } = setup('if (x) {\n  run();\n}\n');
    const loose = await EditTool.run({ file_path: third, old_string: 'if (x) {\n run();', new_string: 'if (y) {\n run();' }, ctx);
    expect(text(loose)).toContain('has not been read yet');
    expect(loose.meta?.writeRefused).toBe(true);
    expect(readFileSync(third, 'utf8')).toBe('if (x) {\n  run();\n}\n');

    // Write still needs a Read
    const write = await WriteTool.run({ file_path: third, content: 'gone\n' }, ctx);
    expect(text(write)).toContain('has not been read yet');
  });

  test('a file never read stays refused when Read would not be allowed, as under a Read deny rule', async () => {
    const { dir, file } = setup('TOKEN=abc\n');
    for (const ctx of [Object.assign(markedCtx(dir), { readAllowed: () => false }), markedCtx(dir)]) {
      const out = await EditTool.run({ file_path: file, old_string: 'TOKEN=', new_string: 'KEY=' }, ctx);
      expect(text(out)).toContain('has not been read yet');
    }
    expect(readFileSync(file, 'utf8')).toBe('TOKEN=abc\n');
  });
});
