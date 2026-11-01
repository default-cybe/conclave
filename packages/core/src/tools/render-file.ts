/**
 * RenderFile: turn an HTML, SVG or Markdown file in the session's outputs
 * folder into a PDF or a PNG with the hub's Chromium, so a chat makes
 * documents, charts and images without a shell. The page renders offline:
 * every request but the files of the outputs folder (served under a made-up
 * origin) is aborted, the host resolver maps every name to nothing, and
 * JavaScript and service workers are off. Input and output are capped and
 * the browser is closed after each call. Opt-in (the chat and the assistant
 * name it); never for an untrusted agent. A member's render fits their disk cap.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { insideFolder, mediaTypeOf, usesOutputs } from '../files/share';
import type { Tool } from './types';
import { fail } from './util';

export interface RenderFileInput {
  path: string;
  format: 'pdf' | 'png';
  output?: string;
  paper?: 'A4' | 'Letter';
  landscape?: boolean;
  width?: number;
}

/** What RenderFile launches: playwright-core's chromium and the hub's browser binary (engine/host.ts). */
export interface RenderBrowser {
  chromium: { launch(o: { executablePath: string; headless: boolean; args: string[]; timeout: number }): Promise<RenderBrowserInstance> };
  executable: string;
}
// the slice of playwright-core's Browser that rendering uses, so tools need no playwright types
interface RenderBrowserInstance {
  newContext(o: Record<string, unknown>): Promise<{
    newPage(): Promise<RenderPage>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}
interface RenderPage {
  route(url: string, handler: (route: RenderRoute) => Promise<void>): Promise<void>;
  setDefaultTimeout(ms: number): void;
  goto(url: string, o: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  pdf(o: Record<string, unknown>): Promise<Buffer>;
  screenshot(o: Record<string, unknown>): Promise<Buffer>;
  locator(sel: string): { first(): { count(): Promise<number>; screenshot(o: Record<string, unknown>): Promise<Buffer> } };
}
interface RenderRoute {
  request(): { url(): string };
  fulfill(o: { status: number; contentType: string; body: string | Buffer }): Promise<void>;
  abort(code?: string): Promise<void>;
}

export const RENDER_MAX_INPUT = 5 * 1024 * 1024;
export const RENDER_MAX_OUTPUT = 25 * 1024 * 1024;
export const RENDER_TIMEOUT_MS = 30_000;
// .invalid never resolves (RFC 2606); only the route handler answers it
const ORIGIN = 'http://outputs.invalid';
const MD_PAGE = '/__conclave_render__.html';

const KINDS: Record<string, 'html' | 'svg' | 'md'> = { '.html': 'html', '.htm': 'html', '.svg': 'svg', '.md': 'md', '.markdown': 'md' };

const PRINT_CSS = `body{font:11pt/1.5 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"DejaVu Sans",sans-serif;color:#111;max-width:46em;margin:0 auto}
@media screen{body{padding:24px}}
h1,h2,h3,h4{line-height:1.25;margin:1.2em 0 .5em;page-break-after:avoid}h1{font-size:1.8em}h2{font-size:1.4em;border-bottom:1px solid #ddd;padding-bottom:.2em}h3{font-size:1.15em}
code,pre{font-family:"DejaVu Sans Mono",Menlo,Consolas,monospace;font-size:.9em}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}
pre{background:#f5f5f5;padding:.8em;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}pre code{background:none;padding:0}
table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid #ccc;padding:.35em .6em;text-align:left;vertical-align:top}th{background:#f2f2f2}
blockquote{margin:1em 0;padding:0 1em;color:#555;border-left:3px solid #ddd}img,svg{max-width:100%}a{color:#1a56b8}tr,img,pre,blockquote{page-break-inside:avoid}`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Markdown to a print-ready HTML page, with Bun's built-in GFM renderer. */
export function markdownPage(text: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${Bun.markdown.html(text)}</body></html>`;
}

/**
 * Render one file. dir is the outputs folder: the only place the page may load
 * files from. Returns the blocked request URLs (at most 20) for the result line.
 */
export async function renderFile(o: {
  browser: RenderBrowser;
  dir: string;
  input: string;
  output: string;
  format: 'pdf' | 'png';
  paper?: 'A4' | 'Letter';
  landscape?: boolean;
  width?: number;
  signal?: AbortSignal;
}): Promise<{ bytes: number; blocked: string[] }> {
  const kind = KINDS[extname(o.input).toLowerCase()];
  if (!kind) throw new Error('RenderFile takes an .html, .svg or .md file.');
  const rel = relative(o.dir, o.input).split(sep).join('/');
  const mainPath = kind === 'md' ? MD_PAGE : `/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const mdHtml = kind === 'md' ? markdownPage(await readFile(o.input, 'utf8'), basename(o.input)) : undefined;
  const blocked: string[] = [];
  const browser = await o.browser.chromium.launch({
    executablePath: o.browser.executable,
    headless: true,
    timeout: RENDER_TIMEOUT_MS,
    // belt and braces with the route below: no name resolves, and Chromium's own background fetches stay off
    args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check'],
  });
  const stop = () => void browser.close().catch(() => {});
  o.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, RENDER_TIMEOUT_MS);
  try {
    const width = Math.min(2400, Math.max(200, Math.round(o.width ?? 1200)));
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, viewport: { width, height: 800 }, offline: false });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        let u: URL | undefined;
        try {
          u = new URL(url);
        } catch {
          /* not a URL: blocked below */
        }
        if (u?.origin === ORIGIN) {
          if (mdHtml !== undefined && u.pathname === MD_PAGE) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mdHtml });
          let file: string;
          try {
            file = join(o.dir, decodeURIComponent(u.pathname));
          } catch {
            return route.abort('blockedbyclient');
          }
          // only files in the outputs folder, symlinks followed, each under the input cap
          if (insideFolder(o.dir, file)) {
            const st = await stat(file).catch(() => undefined);
            if (st?.isFile() && st.size <= RENDER_MAX_INPUT) {
              const ext = extname(file).toLowerCase();
              const type = ext === '.css' ? 'text/css' : ext === '.html' || ext === '.htm' ? 'text/html; charset=utf-8' : mediaTypeOf(file);
              return route.fulfill({ status: 200, contentType: type, body: await readFile(file) });
            }
          }
          return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
        }
        if (blocked.length < 20) blocked.push(url.slice(0, 200));
        return route.abort('blockedbyclient');
      });
      await page.goto(ORIGIN + mainPath, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
      let out: Buffer;
      if (o.format === 'pdf') {
        out = await page.pdf({ format: o.paper ?? 'A4', landscape: !!o.landscape, printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } });
      } else {
        const svg = kind === 'svg' ? page.locator('svg').first() : undefined;
        out = svg && (await svg.count()) ? await svg.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png', fullPage: true });
      }
      if (out.length > RENDER_MAX_OUTPUT) throw new Error(`The ${o.format.toUpperCase()} came out at ${(out.length / 1024 / 1024).toFixed(1)} MB; the limit is ${RENDER_MAX_OUTPUT / 1024 / 1024} MB. Make the page smaller.`);
      await writeFile(o.output, out);
      return { bytes: out.length, blocked };
    } finally {
      await context.close().catch(() => {});
    }
  } catch (e) {
    if (o.signal?.aborted) throw new Error('Stopped.');
    throw e;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', stop);
    await browser.close().catch(() => {});
  }
}

const DESCRIPTION = `Turn an HTML, SVG or Markdown file in your outputs folder into a PDF or a PNG image, with the hub's browser. Write the source file first, render it, then call ShareFile with the output path.

- path: the .html, .svg or .md file. A plain name is read from your outputs folder.
- format: pdf (a document, A4 unless paper is Letter) or png (an image; an SVG renders at its own size, a page at width pixels, default 1200, as tall as the page).
- output: optional file name; default the same name with .pdf or .png.
- The page renders offline with JavaScript off: draw charts and diagrams as inline SVG, put styles in a <style> block, and refer to images in the outputs folder by relative name. Anything on the internet is not loaded.`;

export const RenderFileTool: Tool<RenderFileInput> = {
  name: 'RenderFile',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The .html, .svg or .md file to render' },
      format: { type: 'string', enum: ['pdf', 'png'] },
      output: { type: 'string', description: 'Output file name; default the input name with .pdf or .png' },
      paper: { type: 'string', enum: ['A4', 'Letter'], description: 'PDF paper size, default A4' },
      landscape: { type: 'boolean', description: 'PDF in landscape' },
      width: { type: 'number', description: 'PNG page width in pixels, 200 to 2400, default 1200' },
    },
    required: ['path', 'format'],
    additionalProperties: false,
  },
  readOnly: false,
  // acceptEdits lets it run like Write; the paths it may touch are checked in run
  editsFiles: true,
  optIn: true,
  timeoutMs: 60_000,
  summarize: (i) => `Render ${String(i.path ?? '').split('/').pop()} to ${String(i.format ?? '').toUpperCase()}`,
  async run(input, ctx) {
    if (!usesOutputs(ctx.session) || !ctx.host.outputsDir || !ctx.host.renderBrowser) return fail('RenderFile works only in a chat or a session that keeps files in its outputs folder on the hub.');
    const dir = ctx.host.outputsDir();
    const format = input.format;
    if (format !== 'pdf' && format !== 'png') return fail('format must be pdf or png.');
    const at = (p: string) => (isAbsolute(p) ? resolve(p) : resolve(dir, p));
    const raw = String(input.path ?? '').trim();
    if (!raw) return fail('Give the path of the file to render.');
    const src = at(raw);
    if (!KINDS[extname(src).toLowerCase()]) return fail('RenderFile takes an .html, .svg or .md file.');
    const outRaw = typeof input.output === 'string' && input.output.trim() ? input.output.trim() : join(dirname(src), `${basename(src, extname(src))}.${format}`);
    const out = at(outRaw);
    if (extname(out).toLowerCase() !== `.${format}`) return fail(`output must end in .${format}.`);
    for (const p of [src, out]) if (!insideFolder(dir, p)) return fail(`Refused: RenderFile reads and writes only in the outputs folder (${dir}).`);
    const st = await stat(src).catch(() => undefined);
    if (!st?.isFile()) return fail(`No file at ${src}. Write it first.`);
    if (st.size > RENDER_MAX_INPUT) return fail(`Refused: ${basename(src)} is ${(st.size / 1024 / 1024).toFixed(1)} MB; the limit is ${RENDER_MAX_INPUT / 1024 / 1024} MB.`);
    // a member's outputs count toward their disk cap: the output is at most a few times the input
    const full = ctx.host.diskRefusal?.(st.size);
    if (full) return fail(full);
    const browser = await ctx.host.renderBrowser();
    if ('error' in browser) return fail(browser.error);
    try {
      const r = await renderFile({ browser, dir, input: src, output: out, format, paper: input.paper === 'Letter' ? 'Letter' : 'A4', landscape: input.landscape === true, width: typeof input.width === 'number' ? input.width : undefined, signal: ctx.signal });
      const kb = (r.bytes / 1024).toFixed(1);
      const note = r.blocked.length ? ` Blocked ${r.blocked.length} request${r.blocked.length > 1 ? 's' : ''} to the network (rendering is offline).` : '';
      return { content: `Rendered ${out} (${kb} KB). Call ShareFile with this path to give it to the owner.${note}`, meta: { path: out, bytes: r.bytes, blocked: r.blocked } };
    } catch (e) {
      return fail(`Render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
