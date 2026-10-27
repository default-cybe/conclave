/**
 * A chat's file tools (tools/util.ts chatRefusal) and RenderFile
 * (tools/render-file.ts): Write and Read stay in the outputs folder, and
 * RenderFile turns HTML, SVG and Markdown there into a PDF or PNG offline.
 * The live tests need playwright-core and a Chromium (findBrowserExecutable),
 * and are skipped without them, like test/browser/browser.test.ts.
 *
 *   bun test packages/core/test/tools/render-file.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBrowserExecutable } from '../../src/browser';
import { ReadTool } from '../../src/tools/read';
import { WriteTool } from '../../src/tools/write';
import { RenderFileTool, markdownPage } from '../../src/tools/render-file';
import { UNTRUSTED_DENY, builtinTools } from '../../src/tools';
import { fakeHost, makeCtx, makeSession, tempDir } from './helpers';

const t = tempDir('conclave-render-');
const home = join(t.dir, 'home');
const out = join(home, 'outputs', 'sess_test');
mkdirSync(out, { recursive: true });
writeFileSync(join(home, 'secret.txt'), 'top secret');
symlinkSync(home, join(out, 'escape'));
afterAll(() => t.cleanup());

const exe = findBrowserExecutable({ headless: true });
let chromium: unknown;
try {
  chromium = (await import('playwright-core')).chromium;
} catch {
  chromium = undefined;
}
const live = exe && chromium ? describe : describe.skip;

const host = fakeHost({
  outputsDir: () => out,
  renderBrowser: async () => (exe && chromium ? { chromium: chromium as never, executable: exe } : { error: 'no browser' }),
});
// a chat's file tools run with its outputs folder as cwd (session/runner.ts CHAT_FILE_TOOLS)
const chatCtx = () => ({ ...makeCtx({ cwd: out, host }), session: makeSession(home, { id: 'sess_test', kind: 'chat' }) });

describe("a chat's Write and Read", () => {
  test('write a plain name into the outputs folder', async () => {
    const r = await WriteTool.run({ file_path: 'notes.md', content: '# hi\n' }, chatCtx());
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(out, 'notes.md'), 'utf8')).toBe('# hi\n');
  });

  test('refuse paths outside the outputs folder, through .., ~ or a symlink', async () => {
    for (const p of [join(home, 'evil.txt'), '../../evil.txt', '~/evil.txt', 'escape/evil.txt']) {
      const r = await WriteTool.run({ file_path: p, content: 'x' }, chatCtx());
      expect(r.isError).toBe(true);
      expect(String(r.content)).toContain('only in its outputs folder');
    }
    expect(existsSync(join(home, 'evil.txt'))).toBe(false);
    for (const p of [join(home, 'secret.txt'), '../../secret.txt', 'escape/secret.txt']) {
      const r = await ReadTool.run({ file_path: p }, chatCtx());
      expect(r.isError).toBe(true);
      expect(String(r.content)).not.toContain('top secret');
    }
  });

  test('a session that is not a chat is not confined', async () => {
    const r = await WriteTool.run({ file_path: join(home, 'agent.txt'), content: 'ok' }, makeCtx({ cwd: home, host }));
    expect(r.isError).toBeUndefined();
  });
});

describe('RenderFile', () => {
  test('opt-in, a built-in, never for an untrusted agent', () => {
    expect(builtinTools().find((x) => x.name === 'RenderFile')?.optIn).toBe(true);
    expect(UNTRUSTED_DENY).toContain('RenderFile');
  });

  test('refuses inputs and outputs outside the outputs folder, and other file types', async () => {
    writeFileSync(join(home, 'page.html'), '<p>x</p>');
    for (const input of [{ path: join(home, 'page.html'), format: 'pdf' as const }, { path: 'escape/page.html', format: 'pdf' as const }, { path: 'notes.md', format: 'pdf' as const, output: '../../x.pdf' }]) {
      const r = await RenderFileTool.run(input, chatCtx());
      expect(r.isError).toBe(true);
      expect(String(r.content)).toContain('only in the outputs folder');
    }
    expect((await RenderFileTool.run({ path: 'notes.txt', format: 'pdf' }, chatCtx())).content).toContain('.html, .svg or .md');
    expect((await RenderFileTool.run({ path: 'notes.md', format: 'png', output: 'x.pdf' }, chatCtx())).content).toContain('output must end in .png');
    // a project session has no outputs folder to render in
    expect((await RenderFileTool.run({ path: 'notes.md', format: 'pdf' }, makeCtx({ cwd: '/srv/proj', host }))).isError).toBe(true);
  });

  test('Markdown becomes a styled page with GFM tables', () => {
    const html = markdownPage('# Title\n\n|a|b|\n|-|-|\n|1|2|\n', 'r.md');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<style>');
  });
});

live('RenderFile with the hub Chromium', () => {
  test('HTML to PDF, and the network request in it is blocked', async () => {
    let hits = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => (hits++, new Response('x')) });
    try {
      writeFileSync(join(out, 'report.html'), `<!doctype html><title>R</title><h1>Report</h1><img src="http://127.0.0.1:${server.port}/pixel.png"><link rel="stylesheet" href="https://example.com/x.css"><img src="chart.svg"><script>fetch("http://127.0.0.1:${server.port}/from-js")</script>`);
      writeFileSync(join(out, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#c41230"/></svg>');
      const r = await RenderFileTool.run({ path: 'report.html', format: 'pdf' }, chatCtx());
      expect(r.isError).toBeUndefined();
      const pdf = readFileSync(join(out, 'report.pdf'));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(hits).toBe(0);
      const blocked = r.meta?.blocked as string[];
      expect(blocked.some((u) => u.includes('127.0.0.1'))).toBe(true);
      expect(blocked.some((u) => u.includes('example.com'))).toBe(true);
      // JavaScript is off: the script never ran, so it asked for nothing
      expect(blocked.some((u) => u.includes('from-js'))).toBe(false);
      // the local chart.svg was served from the outputs folder, not blocked
      expect(blocked.some((u) => u.includes('chart.svg'))).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test('SVG to PNG at its own size, Markdown to PDF and PNG', async () => {
    const png = await RenderFileTool.run({ path: 'chart.svg', format: 'png' }, chatCtx());
    expect(png.isError).toBeUndefined();
    const bytes = readFileSync(join(out, 'chart.png'));
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBe(120);
    expect(bytes.readUInt32BE(20)).toBe(80);

    writeFileSync(join(out, 'doc.md'), '# Doc\n\nSome **bold** text.\n\n|a|b|\n|-|-|\n|1|2|\n\n<script>document.body.innerHTML="ran"</script>\n');
    const pdf = await RenderFileTool.run({ path: 'doc.md', format: 'pdf', paper: 'Letter' }, chatCtx());
    expect(pdf.isError).toBeUndefined();
    expect(readFileSync(join(out, 'doc.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    const page = await RenderFileTool.run({ path: 'doc.md', format: 'png', output: 'doc-page.png', width: 600 }, chatCtx());
    expect(page.isError).toBeUndefined();
    const img = readFileSync(join(out, 'doc-page.png'));
    expect(img.subarray(1, 4).toString()).toBe('PNG');
    expect(img.readUInt32BE(16)).toBe(600);
  }, 60_000);
});
