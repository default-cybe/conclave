/**
 * The Preview pane of a Code session: the session's dev server (or an HTML
 * file of its folder) shown in a fresh hub browser, where the agent and the
 * owner see the same page.
 *
 *   device   runs the dev server (Machine.spawn) and opens loopback TCP to
 *            the ports the hub asks for (Machine.connect, protocol 6)
 *   hub      a PreviewRelay per port on 127.0.0.1:<free>, each socket piped
 *            to machine.connect(port); a throwaway browser per session
 *            (BrowserManager.startPreview) that reaches only those relays
 *            and http://preview.invalid/ (the session folder's files)
 *   web      draws the screencast; the app never loads in a hub page
 */
import { createServer, type Server, type Socket } from 'node:net';
import { posix, win32 } from 'node:path';
import type { Machine, MachineProcess } from '../machine/types';
import type { Tool, ToolContext } from '../tools/types';
import { wrapUntrusted } from './snapshot';
import { PREVIEW_FILE_HOST, type BrowserManager, type PreviewLogEntry } from './manager';
import { LAUNCH_FILES, chooseConfig, launchLine, parseLaunch, planLaunch, wantsFreePort, type LaunchConfig, type LaunchPlan } from './launch';
import { PICK_DOM, PICK_SOURCE, PICK_STYLES, cleanPick, type Pick, type RawPick, type SourceHints } from './picker';

const LOG_MAX = 300;
const IDLE_MS = 30 * 60_000;
const READY_MS = 90_000;
const MAX_CROP = 2 * 1024 * 1024;
const PICK_MS = 5_000;
/** Sockets one relay holds at once: a page opening thousands cannot fill the hub. */
export const RELAY_MAX_SOCKETS = 64;
export const VIEW_WIDTHS = [390, 768, 1440] as const;

/** start() without the launch line it runs: the caller shows the line to the owner (or the agent names it) and calls again. */
export class PreviewConfirm extends Error {
  constructor(
    readonly config: string,
    readonly line: string,
  ) {
    super(`launch.json configuration "${config}" runs: ${line}\nCall preview_start again with command set to exactly that line to run it (the owner approves it like a Bash command).`);
  }
}

function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, fail) => (t = setTimeout(() => fail(new Error(`${what} took longer than ${ms / 1000}s; the page may be busy.`)), ms)))]).finally(() => clearTimeout(t));
}

/** A loopback listener on the hub whose every socket is a Machine.connect stream to one device port. */
export class PreviewRelay {
  private sockets = new Set<Socket>();
  private constructor(
    private readonly server: Server,
    readonly port: number,
    readonly target: number,
  ) {}

  static start(open: (port: number) => MachineProcess, target: number): Promise<PreviewRelay> {
    return new Promise((done, fail) => {
      let relay: PreviewRelay | undefined;
      const server = createServer((client) => relay?.pipe(client, open));
      server.once('error', fail);
      // loopback only: nothing else on the network reaches the device's port through the hub
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const a = server.address();
        if (!a || typeof a === 'string') return fail(new Error('the preview relay has no port'));
        relay = new PreviewRelay(server, a.port, target);
        done(relay);
      });
    });
  }

  private pipe(client: Socket, open: (port: number) => MachineProcess): void {
    if (this.sockets.size >= RELAY_MAX_SOCKETS) return void client.destroy();
    this.sockets.add(client);
    let up: MachineProcess;
    try {
      up = open(this.target);
    } catch {
      client.destroy();
      return;
    }
    // shortcut: browser-to-device bytes are not paced (MachineProcess.write has no backpressure); the browser holds the body anyway
    client.on('data', (b: Buffer) => up.write(new Uint8Array(b)));
    client.on('end', () => up.closeStdin());
    client.on('error', () => {});
    client.once('close', () => {
      this.sockets.delete(client);
      up.kill();
    });
    void (async () => {
      const reader = up.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (client.destroyed) break;
          // a slow reader paces the device: the next read waits for the socket to drain
          if (!client.write(value)) await new Promise<void>((r) => (client.once('drain', r), client.once('close', r)));
        }
      } catch {
        /* stream gone */
      }
      client.end();
    })();
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}

export interface PreviewTarget {
  name: string;
  url: string;
}

export interface PreviewState {
  running: boolean;
  name?: string;
  url?: string;
  targets: PreviewTarget[];
  logs: number;
  server?: 'running' | 'exited';
}

interface Live {
  sessionId: string;
  machine: Machine;
  cwd: string;
  win: boolean;
  name: string;
  relays: PreviewRelay[];
  proc?: MachineProcess;
  exited?: boolean;
  out: string[];
  targets: PreviewTarget[];
  logs: Array<PreviewLogEntry & { seq: number; at: number }>;
  seq: number;
  idle?: ReturnType<typeof setTimeout>;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
};

/**
 * A path under root, or undefined: no "..", no absolute path, and no
 * symlink on the way (a link could leave the folder). Each step is checked
 * with readdir, which works the same on the hub and on a paired device.
 */
export async function containedFile(machine: Machine, root: string, rel: string, win = false): Promise<string | undefined> {
  const P = win ? win32 : posix;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  // a dot part is "..", "." or a dotfile (.env, .git): none is served
  if (!parts.length || parts.some((p) => p.startsWith('.') || p.includes('\0')) || /^([a-z]:|[\\/])/i.test(rel)) return undefined;
  let dir = root;
  for (const [i, part] of parts.entries()) {
    const entry = (await machine.readdir(dir).catch(() => [])).find((e) => e.name === part);
    if (!entry || entry.type === 'symlink' || entry.type === 'other') return undefined;
    if (i < parts.length - 1 && entry.type !== 'dir') return undefined;
    dir = P.join(dir, part);
  }
  return dir;
}

export class PreviewService {
  private live = new Map<string, Live>();
  /** Bumped by every start and stop: a start that finds it changed tears itself down. */
  private gen = new Map<string, number>();
  /** The port the server listens on (serve --port), on top of hubPorts. */
  private listening = new Set<number>();

  constructor(
    private readonly browser: BrowserManager,
    /** The hub's own ports (its server, its CLIProxyAPI): a session on the hub may not preview them. */
    private readonly hubPorts: () => Array<number | undefined> = () => [],
  ) {
    browser.onActivity = (id) => this.touch(id);
  }

  /** The port the hub's server really listens on (startServer). */
  hubListening(port: number): void {
    this.listening.add(port);
  }

  private hubPort(port: number): boolean {
    return this.listening.has(port) || this.hubPorts().includes(port);
  }

  state(sessionId: string): PreviewState {
    const l = this.live.get(sessionId);
    if (!l) return { running: false, targets: [], logs: 0 };
    return { running: true, name: l.name, url: l.targets[0]?.url, targets: l.targets, logs: l.seq, ...(l.proc ? { server: l.exited ? 'exited' : 'running' } : {}) };
  }

  logs(sessionId: string, after = 0): Array<PreviewLogEntry & { seq: number; at: number }> {
    return (this.live.get(sessionId)?.logs ?? []).filter((e) => e.seq > after);
  }

  /**
   * Start (or restart) the session's preview: a launch.json server, a running
   * localhost url, or an HTML file. A launch.json configuration runs only when
   * command is its launchLine (what the owner approved) or the folder is
   * trusted; else PreviewConfirm says the line.
   */
  async start(sessionId: string, machine: Machine, cwd: string, opts: { name?: string; file?: string; command?: string; trusted?: boolean } = {}): Promise<PreviewState> {
    // no command yet: only launch.json is read, and a running preview stays as it is
    if (!opts.file && opts.command === undefined && !opts.trusted) {
      const c = await this.config(machine, cwd, opts.name);
      throw new PreviewConfirm(c.name, launchLine(c));
    }
    const g = (this.gen.get(sessionId) ?? 0) + 1;
    this.gen.set(sessionId, g);
    const l: Live = { sessionId, machine, cwd, win: false, name: opts.file ?? opts.name ?? 'preview', relays: [], out: [], targets: [], logs: [], seq: 0 };
    const old = this.live.get(sessionId);
    // recorded before anything runs, so a stop (or a second start) during startup finds and ends it
    this.live.set(sessionId, l);
    if (old) await this.teardown(old);
    const current = () => {
      if (this.gen.get(sessionId) !== g) throw new Error('The preview was stopped or started again while it was starting.');
    };
    try {
      let url: string;
      if (opts.file) {
        const rel = opts.file.replace(/^\.\//, '');
        l.win = (await machine.info()).platform === 'win32';
        if (!(await containedFile(machine, cwd, rel, l.win))) throw new Error(`${opts.file} is not a file inside the session folder.`);
        url = `http://${PREVIEW_FILE_HOST}/${rel.split(/[\\/]+/).map(encodeURIComponent).join('/')}`;
      } else {
        if (!machine.connect) throw new Error(`The device "${machine.name}" runs an older daemon (protocol 5 or older); the preview needs protocol 6. Update the daemon from Settings > Devices.`);
        const c = await this.config(machine, cwd, opts.name);
        const line = launchLine(c);
        if (opts.command !== undefined && opts.command.trim() !== line) throw new Error(`launch.json configuration "${c.name}" now runs: ${line}\nThat is not the command given (${opts.command}); nothing was started.`);
        if (opts.command === undefined && !opts.trusted) throw new PreviewConfirm(c.name, line);
        const plan = planLaunch(c, wantsFreePort(c) ? await this.freePort(machine) : undefined);
        current();
        l.name = plan.name;
        if (machine.id === 'local' && this.hubPort(plan.port)) throw new Error(`Port ${plan.port} is one of the hub's own ports; the preview does not show the hub.`);
        // a fixed port that already answers is someone else's service (Syncthing, a database UI): the command would not own it
        if (plan.command && plan.fixed && (await this.answers(machine, plan.port))) throw new Error(`Port ${plan.port} already answers on the device before "${plan.name}" started. Stop what runs there, or remove "port" so the preview picks a free one.`);
        current();
        if (plan.command) this.spawn(l, plan);
        await this.waitReady(l, plan.port);
        current();
        const relay = await PreviewRelay.start((p) => machine.connect!(p), plan.port);
        l.relays.push(relay);
        current();
        url = `http://localhost:${relay.port}${plan.path}`;
      }
      l.targets = [{ name: l.name, url }];
      await this.browser.startPreview(sessionId, {
        allows: (u) => u.protocol.startsWith('http') || u.protocol.startsWith('ws') ? ['localhost', '127.0.0.1'].includes(u.hostname) && l.relays.some((r) => String(r.port) === u.port) : false,
        file: (path) => this.file(l, path),
        log: (e) => this.log(l, e),
      });
      await this.browser.navigate(sessionId, url);
      current();
      this.touch(sessionId);
      return this.state(sessionId);
    } catch (err) {
      await this.teardown(l);
      if (this.live.get(sessionId) === l) {
        this.live.delete(sessionId);
        await this.browser.stopPreview(sessionId).catch(() => {});
      }
      throw err;
    }
  }

  async stop(sessionId: string): Promise<void> {
    this.gen.set(sessionId, (this.gen.get(sessionId) ?? 0) + 1);
    const l = this.live.get(sessionId);
    this.live.delete(sessionId);
    if (l) await this.teardown(l);
    await this.browser.stopPreview(sessionId);
  }

  /** Any use keeps it; 30 minutes without one stops it. */
  touch(sessionId: string): void {
    const l = this.live.get(sessionId);
    if (!l) return;
    if (l.idle) clearTimeout(l.idle);
    l.idle = setTimeout(() => void this.stop(sessionId), IDLE_MS);
    (l.idle as { unref?: () => void }).unref?.();
  }

  /** True for a URL the pane's address bar may open: one of the session's targets' origins. */
  isTarget(sessionId: string, url: string): boolean {
    try {
      const u = new URL(url);
      return (this.live.get(sessionId)?.targets ?? []).some((t) => new URL(t.url).origin === u.origin);
    } catch {
      return false;
    }
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    if (!this.isTarget(sessionId, url)) throw new Error('The preview opens only its own dev server or files.');
    await this.browser.navigate(sessionId, url);
    this.browser.note(sessionId, `The owner opened ${url} in the Preview.`);
    this.touch(sessionId);
  }

  async reload(sessionId: string): Promise<void> {
    this.need(sessionId);
    await (await this.browser.page(sessionId)).reload({ waitUntil: 'commit' });
    this.browser.note(sessionId, 'The owner reloaded the Preview.');
    this.touch(sessionId);
  }

  async view(sessionId: string, v: { width?: number; colorScheme?: 'light' | 'dark' }): Promise<void> {
    this.need(sessionId);
    const page = await this.browser.page(sessionId);
    if (v.width) await page.setViewportSize({ width: v.width, height: v.width < 600 ? 844 : 900 });
    if (v.colorScheme) await page.emulateMedia({ colorScheme: v.colorScheme });
    this.browser.note(sessionId, `The owner set the Preview to${v.width ? ` ${v.width}px wide` : ''}${v.colorScheme ? ` ${v.colorScheme} mode` : ''}.`);
    this.touch(sessionId);
  }

  /** The element at (x, y) CSS pixels, and a PNG of it (at most 2 MiB). */
  async pick(sessionId: string, x: number, y: number): Promise<{ pick: Pick; image?: string }> {
    this.need(sessionId);
    const page = await this.browser.page(sessionId);
    const cdp = await page.context().newCDPSession(page);
    let raw: RawPick | null;
    try {
      // a page that busy-loops never answers: the pick gives up instead of hanging
      raw = await within(PICK_MS, 'Picking the element', (async () => {
        const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
        // an isolated world: the page's own scripts cannot change what the picker reads
        const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'conclave-picker' })) as { executionContextId: number };
        const r = (await cdp.send('Runtime.evaluate', { expression: `(${PICK_DOM})(${x}, ${y}, ${JSON.stringify(PICK_STYLES)})`, contextId: executionContextId, returnByValue: true })) as { result: { value?: RawPick | null } };
        return r.result.value ?? null;
      })());
    } finally {
      await cdp.detach().catch(() => {});
    }
    if (!raw) throw new Error('There is no element at that point.');
    const hints = (await within(PICK_MS, 'Reading source hints', page.evaluate(`(${PICK_SOURCE})(${x}, ${y})`)).catch(() => ({}))) as SourceHints;
    const pick = cleanPick(raw, hints && typeof hints === 'object' ? hints : {});
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const pad = 8;
    const cx = Math.max(0, pick.rect.x - pad);
    const cy = Math.max(0, pick.rect.y - pad);
    const clip = { x: cx, y: cy, width: Math.max(1, Math.min(vp.width - cx, pick.rect.width + pad * 2)), height: Math.max(1, Math.min(vp.height - cy, pick.rect.height + pad * 2)) };
    const png = await page.screenshot({ clip, type: 'png' }).catch(() => undefined);
    this.touch(sessionId);
    return { pick, ...(png && png.byteLength <= MAX_CROP ? { image: png.toString('base64') } : {}) };
  }

  private need(sessionId: string): Live {
    const l = this.live.get(sessionId);
    if (!l) throw new Error('This session has no preview running. Start it with preview_start or the Preview button.');
    return l;
  }

  private async config(machine: Machine, cwd: string, name?: string): Promise<LaunchConfig> {
    for (const f of LAUNCH_FILES) {
      const text = await machine.readText(machine.resolve(f, cwd)).catch(() => undefined);
      if (text === undefined) continue;
      const { configs, problems } = parseLaunch(text);
      if (!configs.length) throw new Error(`${f}: ${problems.join(' ') || 'no configurations.'}`);
      return chooseConfig(configs, name);
    }
    throw new Error(`No ${LAUNCH_FILES.join(' or ')} in ${cwd}. Write one with a "configurations" list (name, runtimeExecutable, runtimeArgs, port), or pass file for a plain HTML page.`);
  }

  /** A port nothing on the device answers on: a connect that is refused. */
  private async freePort(machine: Machine): Promise<number> {
    for (let i = 0; i < 20; i++) {
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      if (machine.id === 'local' && this.hubPort(port)) continue;
      if (!(await this.answers(machine, port))) return port;
    }
    throw new Error('No free port found on the device.');
  }

  /** True when a connect to the device port opens (false when it is refused). */
  private async answers(machine: Machine, port: number): Promise<boolean> {
    const p = machine.connect!(port);
    const code = await Promise.race([p.exited, new Promise<'open'>((r) => setTimeout(() => r('open'), 1_500))]);
    p.kill();
    return code !== null;
  }

  private spawn(l: Live, plan: LaunchPlan): void {
    const cwd = plan.cwd ? l.machine.resolve(plan.cwd, l.cwd) : l.cwd;
    const proc = l.machine.spawn(plan.command!, plan.args, { cwd, env: plan.env });
    l.proc = proc;
    const keep = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
        l.out.push(...dec.decode(chunk, { stream: true }).split('\n').filter(Boolean));
        if (l.out.length > 60) l.out.splice(0, l.out.length - 60);
      }
    };
    void keep(proc.stdout).catch(() => {});
    void keep(proc.stderr).catch(() => {});
    void proc.exited.then((code) => {
      l.exited = true;
      this.log(l, { kind: 'pageerror', text: `The dev server exited (code ${code ?? 'none'}).` });
    });
  }

  /** Until the device port answers an HTTP request; the server's last lines when it exits first. */
  private async waitReady(l: Live, port: number): Promise<void> {
    const until = Date.now() + READY_MS;
    while (Date.now() < until) {
      if (l.exited) throw new Error(`The dev server exited before it answered on port ${port}:\n${l.out.slice(-20).join('\n')}`);
      const p = l.machine.connect!(port);
      p.write('HEAD / HTTP/1.0\r\nHost: localhost\r\n\r\n');
      const reader = p.stdout.getReader();
      const got = await Promise.race([reader.read().then((r) => !r.done), new Promise<boolean>((r) => setTimeout(() => r(false), 2_000))]);
      p.kill();
      if (got) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Nothing answered on port ${port} in ${READY_MS / 1000}s.${l.out.length ? `\n${l.out.slice(-20).join('\n')}` : ''}`);
  }

  private async file(l: Live, path: string): Promise<{ body: Uint8Array; contentType: string } | undefined> {
    const rel = path.replace(/^\/+/, '') || 'index.html';
    const abs = await containedFile(l.machine, l.cwd, rel, l.win);
    if (!abs) return undefined;
    const ext = /\.([a-z0-9]+)$/i.exec(rel)?.[1]?.toLowerCase() ?? '';
    return { body: await l.machine.readFile(abs), contentType: MIME[ext] ?? 'application/octet-stream' };
  }

  private log(l: Live, e: PreviewLogEntry): void {
    l.logs.push({ ...e, seq: ++l.seq, at: Date.now() });
    if (l.logs.length > LOG_MAX) l.logs.splice(0, l.logs.length - LOG_MAX);
  }

  private async teardown(l: Live): Promise<void> {
    if (l.idle) clearTimeout(l.idle);
    await Promise.all(l.relays.map((r) => r.close()));
    if (l.proc && !l.exited) l.proc.kill();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

/** preview_start, preview_stop and preview_logs. The browser_* tools act on the same tab. */
export function previewTools(service: PreviewService): Tool[] {
  const start: Tool<{ name?: string; file?: string; command?: string }> = {
    name: 'preview_start',
    description:
      'Start the Preview of this project and show it to the owner in the Preview pane: runs the dev server from .conclave/launch.json or .claude/launch.json (configurations with name, runtimeExecutable, runtimeArgs, cwd, env, port, autoPort, url), or opens an HTML file of the session folder with file. For a launch.json configuration call it first without command: it returns the command line the configuration runs; call again with command set to exactly that line (approved like a Bash command). browser_screenshot, browser_snapshot, browser_click and browser_type then act on that page. The page reaches only its own dev server: outside addresses and CDNs are blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The launch.json configuration to run. Default: the first.' },
        file: { type: 'string', description: 'An HTML file in the session folder to open instead of a dev server, e.g. "index.html".' },
        command: { type: 'string', description: 'The configuration\'s command line exactly as a call without it reports it. Leave it out first: the call then only reads launch.json and says the line.' },
      },
    },
    optIn: true,
    // launch.json is code from the repo: it is asked for like a Bash command
    // the command line is what rules judge (the runner checks the session's Bash rules too); a call without it only reads launch.json
    readOnly: (input) => !input.file && !input.command,
    ruleContent: (input) => (input.file ? undefined : input.command),
    // never a tool-wide rule: an always-allow covers this exact line only
    suggestRule: (input) => (input.command ? `preview_start(${input.command})` : undefined),
    summarize: (input) => (input.file ? `Preview ${input.file}` : input.command ? `Run for the Preview: ${input.command}` : 'Read launch.json for the Preview'),
    timeoutMs: 120_000,
    run: async (input, ctx: ToolContext) => {
      try {
        const st = await service.start(ctx.sessionId, ctx.machine, ctx.cwd, { name: input.name, file: input.file, command: input.command });
        return { content: `Preview running: ${st.name} at ${st.url}. The owner sees it in the Preview pane. Use browser_screenshot to look, preview_logs for errors.`, meta: { url: st.url } };
      } catch (err) {
        if (err instanceof PreviewConfirm) return { content: err.message };
        return { content: `Preview error: ${(err as Error).message}`, isError: true };
      }
    },
  };
  const stop: Tool<Record<string, never>> = {
    name: 'preview_stop',
    description: 'Stop the Preview: its dev server, relay and browser.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: false,
    optIn: true,
    summarize: () => 'Stop the Preview',
    run: async (_input, ctx) => {
      await service.stop(ctx.sessionId);
      return { content: 'Preview stopped.' };
    },
  };
  const logs: Tool<{ since?: number }> = {
    name: 'preview_logs',
    description: 'The Preview page\'s console errors and warnings, page errors, failed requests, error responses and blocked addresses (the last 300). since: only entries after that number.',
    inputSchema: { type: 'object', properties: { since: { type: 'integer', description: 'Only entries with a number above this.' } } },
    readOnly: true,
    optIn: true,
    summarize: () => 'Preview logs',
    run: async (input, ctx) => {
      const st = service.state(ctx.sessionId);
      if (!st.running) return { content: 'No preview is running. Call preview_start.', isError: true };
      const list = service.logs(ctx.sessionId, input.since ?? 0);
      if (!list.length) return { content: `No errors logged${input.since ? ` after ${input.since}` : ''}.` };
      const body = list.map((e) => `#${e.seq} ${e.kind}${e.level ? `(${e.level})` : ''}: ${e.text}${e.url ? ` [${e.url}]` : ''}`).join('\n');
      return { content: wrapUntrusted(st.url ?? 'preview', body) };
    },
  };
  return [start, stop, logs] as Tool[];
}
