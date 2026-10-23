import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** Headers on every response. CSP only matters for documents but is harmless elsewhere. */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

/** Files that must always be revalidated so a deploy shows up right away. */
const NO_CACHE = new Set(['/index.html', '/sw.js', '/service-worker.js', '/manifest.webmanifest', '/manifest.json', '/registerSW.js']);

/** Vite style content hash in the file name: index-B2x9_aQz.js, chunk.3f9a1c2b.css */
const HASHED = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

/** First existing directory with an index.html: explicit, packages/web/dist, ~/.conclave/web. */
export function resolveWebDir(candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (!c) continue;
    const dir = resolve(c);
    try {
      if (existsSync(join(dir, 'index.html')) && statSync(dir).isDirectory()) return dir;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** packages/web/dist relative to this file. */
export function bundledWebDir(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

/**
 * Candidate web dirs, in priority order. In a compiled binary import.meta.url
 * points inside the bundle, so we also look for a "web" folder next to the real
 * executable (the installer symlinks the binary, hence realpathSync).
 */
export function webDirCandidates(): string[] {
  const out = [bundledWebDir()];
  try {
    const exe = realpathSync(process.execPath);
    out.push(join(dirname(exe), 'web'), join(dirname(exe), 'web', 'dist'));
  } catch {
    /* ignore */
  }
  return out;
}

function headersFor(path: string, size?: number): Headers {
  const h = new Headers(SECURITY_HEADERS);
  h.set('content-type', MIME[extname(path).toLowerCase()] ?? 'application/octet-stream');
  const name = path.split('/').pop() ?? '';
  if (NO_CACHE.has(path) || name === 'index.html') h.set('cache-control', 'no-cache');
  else if (path.startsWith('/assets/') || HASHED.test(name)) h.set('cache-control', 'public, max-age=31536000, immutable');
  else h.set('cache-control', 'public, max-age=3600');
  if (extname(path) === '.html') h.set('content-security-policy', CSP);
  if (size !== undefined) h.set('content-length', String(size));
  return h;
}

/**
 * Serve a file from dir. Unknown paths without an extension (client routes
 * like /s/abc) fall back to index.html. Returns undefined when nothing fits.
 */
export async function serveStatic(dir: string, pathname: string, method: string): Promise<Response | undefined> {
  if (method !== 'GET' && method !== 'HEAD') return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (rel.includes('\0')) return undefined;
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(dir, rel));
  if (full !== dir && !full.startsWith(dir + sep)) return undefined;

  let target = full;
  let urlPath = rel;
  let file = Bun.file(target);
  if (!(await file.exists()) || isDir(target)) {
    // SPA fallback only for route-like paths; a missing /assets/x.js should 404
    if (extname(rel) && extname(rel) !== '.html') return undefined;
    target = join(dir, 'index.html');
    urlPath = '/index.html';
    file = Bun.file(target);
    if (!(await file.exists())) return undefined;
  }
  const headers = headersFor(urlPath, file.size);
  return new Response(method === 'HEAD' ? null : file, { status: 200, headers });
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** A small page of the hub's own (an approval link, an OAuth error). `body` is HTML; escape what goes in it. */
export function htmlPage(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#e4e4e7;background:#111113}}h1{font-size:20px;font-weight:600}p{color:inherit;opacity:.85}button{font:inherit;padding:.6em 1.2em}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  const h = new Headers(SECURITY_HEADERS);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  h.set('content-security-policy', CSP);
  return new Response(html, { status, headers: h });
}

/**
 * Shown at / when no web build exists. `looked` are the folders this hub
 * searched, its home's (CONCLAVE_HOME) first, then those next to its binary,
 * so the page names where this hub would find a build.
 */
export function placeholderPage(version: string, looked: string[] = []): Response {
  // a compiled binary's own bundle ($bunfs, B:/~BUN) is no place anyone can put a build
  const places = [...new Set(looked.filter((p) => p && !/\$bunfs|~BUN/.test(p)).map((p) => resolve(p)))];
  const list = places.length ? `<ul>${places.map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conclave hub</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}}code{background:#8882;padding:.1em .3em;border-radius:4px;word-break:break-all}</style></head>
<body><h1>Conclave hub ${esc(version)}</h1><p>The hub is running. The web app is not built yet: run <code>bun run build</code>, or put a build (the folder with <code>index.html</code> in it) in one of the places this hub looks, then reload this page:</p>${list}<p>API: <code>/api/health</code></p></body></html>`;
  const h = new Headers(SECURITY_HEADERS);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-cache');
  h.set('content-security-policy', CSP);
  return new Response(html, { headers: h });
}
