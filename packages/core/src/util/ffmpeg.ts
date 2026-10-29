/**
 * ffmpeg for the hub: the one on PATH, else a pinned static build fetched on
 * first use into <CONCLAVE_HOME>/ffmpeg/<tag>/ffmpeg. Like Install on the hub
 * (browser/setup.ts), the download is checked against a sha256 pinned here
 * before anything is unpacked, runs as the hub's own user and never needs
 * root. Capture (browser/capture.ts) uses it for contact sheets; anything that
 * needs ffmpeg later calls findFfmpeg too.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * eugeneware/ffmpeg-static release b6.1.1: one gzipped static binary per
 * platform (GPL build from johnvansickle.com, ffmpeg 7.0.2). The hashes are of
 * the .gz assets as downloaded on 2026-10-29.
 */
export const FFMPEG_TAG = 'b6.1.1';
export const FFMPEG_BUILDS: Record<string, { url: string; sha256: string }> = {
  'linux-x64': { url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-linux-x64.gz`, sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa' },
  'linux-arm64': { url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-linux-arm64.gz`, sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0' },
};
const FETCH_TIMEOUT_MS = 180_000;
/** The .gz is about 30 MB; anything far bigger is not the pinned file. */
const MAX_DOWNLOAD = 64 * 1024 * 1024;
/** A failed fetch is not tried again for this long, so every capture does not wait on a dead download. */
const RETRY_MS = 10 * 60_000;

/** Where the pinned build lives on the hub. */
export function hubFfmpegPath(home: string): string {
  return join(home, 'ffmpeg', FFMPEG_TAG, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

let inflight: Promise<{ path: string } | { error: string }> | undefined;
let failed: { at: number; error: string } | undefined;

/** Forget a remembered failure (tests). */
export function resetFfmpegCache(): void {
  inflight = undefined;
  failed = undefined;
}

/**
 * The ffmpeg to run: PATH first, then the hub's pinned copy, fetching it when
 * missing. Never throws: an error says why there is none.
 */
export async function findFfmpeg(home: string, o: { fetch?: typeof fetch; which?: (cmd: string) => string | null } = {}): Promise<{ path: string } | { error: string }> {
  const onPath = (o.which ?? Bun.which)('ffmpeg');
  if (onPath) return { path: onPath };
  const dest = hubFfmpegPath(home);
  if (existsSync(dest)) return { path: dest };
  if (failed && Date.now() - failed.at < RETRY_MS) return { error: failed.error };
  inflight ??= fetchFfmpeg(dest, o.fetch ?? fetch).then(
    (r) => {
      inflight = undefined;
      if ('error' in r) failed = { at: Date.now(), error: r.error };
      return r;
    },
  );
  return inflight;
}

async function fetchFfmpeg(dest: string, f: typeof fetch): Promise<{ path: string } | { error: string }> {
  const build = FFMPEG_BUILDS[`${process.platform}-${process.arch}`];
  if (!build) return { error: `ffmpeg is not on PATH and there is no pinned build for ${process.platform}-${process.arch}.` };
  try {
    const res = await f(build.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok || !res.body) return { error: `ffmpeg download answered ${res.status}.` };
    const h = createHash('sha256');
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD) return { error: 'ffmpeg download is larger than the pinned file; stopped.' };
      h.update(chunk);
      parts.push(chunk);
    }
    const got = h.digest('hex');
    if (got !== build.sha256) return { error: `ffmpeg download does not match its pinned sha256 (got ${got.slice(0, 16)}...); nothing was unpacked.` };
    const bin = gunzipSync(Buffer.concat(parts));
    mkdirSync(join(dest, '..'), { recursive: true });
    const part = `${dest}.part`;
    const fd = openSync(part, 'w', 0o755);
    try {
      writeSync(fd, bin);
    } finally {
      closeSync(fd);
    }
    chmodSync(part, 0o755);
    renameSync(part, dest);
    return { path: dest };
  } catch (e) {
    rmSync(`${dest}.part`, { force: true });
    return { error: `ffmpeg could not be fetched: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Arguments that tile numbered frames (input is a printf pattern such as
 * /tmp/x/f%03d.png) into contact sheets (output pattern such as sheet-%02d.png),
 * cols x rows frames each (fewer rows when fewer frames), every frame scaled
 * to width pixels, on a gray grid so white pages stay apart. ffmpeg's tile
 * filter emits a sheet each cols*rows frames and pads the last one.
 */
export function contactSheetArgs(o: { input: string; output: string; frames: number; cols?: number; rows?: number; width?: number }): string[] {
  const cols = o.cols ?? 4;
  const rows = Math.max(1, Math.min(o.rows ?? 3, Math.ceil(o.frames / cols)));
  const width = o.width ?? 360;
  const sheets = Math.max(1, Math.ceil(o.frames / (cols * rows)));
  return ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-start_number', '0', '-i', o.input, '-vf', `scale=${width}:-2,tile=${cols}x${rows}:padding=6:margin=6:color=gray`, '-frames:v', String(sheets), o.output];
}

/** Run ffmpeg with args; stderr's tail on failure. */
export async function runFfmpeg(path: string, args: string[], o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = Bun.spawn([path, ...args], { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' });
  const kill = () => p.kill();
  const timer = setTimeout(kill, o.timeoutMs ?? 60_000);
  o.signal?.addEventListener('abort', kill, { once: true });
  try {
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    return code === 0 ? { ok: true } : { ok: false, error: `ffmpeg exited ${code}: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 400)}` };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', kill);
  }
}
