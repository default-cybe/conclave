/**
 * Flows in a Code session (docs/design/VISUAL-PROGRAMMING.md 4 to 6): list,
 * create, read as a graph, edit by ops, undo, save the layout, and Run.
 * Every file goes through the session's Machine, so the device can be any
 * paired one. Run is `bun flows/<name>.flow.ts` in the session's folder,
 * asked about like an agent's Bash call (engine/commands.ts bashRefusal).
 * The helpers trace each block on stderr behind a per-run nonce; the hub
 * cuts those lines out of the output and keeps the last run per flow in
 * memory, values masked against the project's .env.
 */
import { createHash } from 'node:crypto';
import type { Engine } from '../engine/engine';
import { EngineError } from '../engine/errors';
import { bashRefusal } from '../engine/commands';
import type { Machine } from '../machine/types';
import type { Session } from '../types';
import type { FlowEditResult, FlowNodeLive, FlowOp, FlowRunView, FlowSummary, FlowView } from '../client/flows';
import { GraphEditError, cleanPositions, lineDiff, printLayout, readLayout, type GraphPositions } from '../workflows/graph';
import { newId } from '../util/ids';
import { oneLine } from '../util/text';
import { applyFlowOp, parseFlow, type FlowGraph } from './graph';
import { FLOW_NAME_RE, LIB_SOURCE, flowTemplate } from './lib';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Flow node ids are variable names, or kind-n for unnamed blocks and code. */
const FLOW_ID_RE = /^[A-Za-z_$][\w$]{0,99}(-\d{1,5})?$/;
const MAX_FLOW_BYTES = 256 * 1024;
const MAX_OUTPUT = 64 * 1024;
/** Longest stderr line kept whole (a trace line is far shorter), and how much of a trace field is masked before it is cut. */
const MAX_CARRY = 256 * 1024;
const MAX_TRACE = 8 * 1024;
const RUN_TIMEOUT_MS = 10 * 60_000;
/** The files Bun reads into process.env on its own (bun.sh/docs/runtime/env). */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.development.local', '.env.production.local', '.env.test.local'];

interface LiveRun {
  view: FlowRunView;
  controller: AbortController;
}

export class FlowService {
  private readonly runs = new Map<string, LiveRun>();
  /** Versions of each flow the hub wrote, for undo: in memory, the last 40 per file. */
  private readonly versions = new Map<string, Map<string, string>>();

  constructor(private readonly engine: Engine) {}

  private where(sessionId: string): { s: Session; machine: Machine; cwd: string } {
    const s = this.engine.getSession(sessionId);
    if (!s) throw new EngineError(404, `unknown session ${sessionId}`);
    if (s.kind === 'chat') throw new EngineError(400, 'flows live in a Code session: a chat has no folder');
    return { s, machine: this.engine.machineFor(s), cwd: s.cwd };
  }

  private paths(cwd: string, name: string) {
    if (!FLOW_NAME_RE.test(name)) throw new EngineError(400, 'a flow name is lowercase letters, digits and dashes, up to 64');
    return { rel: `flows/${name}.flow.ts`, file: `${cwd}/flows/${name}.flow.ts`, layout: `${cwd}/.conclave/graph/${name}.json`, lib: `${cwd}/flows/lib/index.ts` };
  }

  private async write(m: Machine, p: string, text: string): Promise<void> {
    const tmp = `${p}.${newId('tmp')}.tmp`;
    await m.writeFile(tmp, text);
    await m.rename(tmp, p);
  }

  async list(sessionId: string): Promise<FlowSummary[]> {
    const { machine, cwd } = this.where(sessionId);
    const files = await machine.glob('flows/*.flow.ts', { cwd, limit: 200, includeIgnored: true }).catch(() => [] as string[]);
    return files
      .map((f) => /([^/\\]+)\.flow\.ts$/.exec(f)?.[1] ?? '')
      .filter((n) => FLOW_NAME_RE.test(n))
      .sort()
      .map((name) => ({ name, path: `flows/${name}.flow.ts` }));
  }

  /** A new flow from the starter, and flows/lib/index.ts when the project has none. The helpers are never overwritten. */
  async create(sessionId: string, name: string): Promise<FlowView> {
    const { machine, cwd } = this.where(sessionId);
    const p = this.paths(cwd, name);
    if (await machine.stat(p.file).catch(() => null)) throw new EngineError(409, `${p.rel} already exists`);
    if (!(await machine.stat(p.lib).catch(() => null))) await this.write(machine, p.lib, LIB_SOURCE);
    await this.write(machine, p.file, flowTemplate(name));
    return this.view(sessionId, name);
  }

  private async read(machine: Machine, file: string, rel: string): Promise<string> {
    const st = await machine.stat(file).catch(() => null);
    if (!st || st.type !== 'file') throw new EngineError(404, `${rel} not found`);
    if (st.size > MAX_FLOW_BYTES) throw new EngineError(400, `${rel} is larger than ${MAX_FLOW_BYTES / 1024} KB`);
    return machine.readText(file);
  }

  private viewOf(name: string, rel: string, src: string, sessionId: string): FlowView {
    const last = this.runs.get(`${sessionId}\0${name}`)?.view;
    return { name, path: rel, graph: parseFlow(src), sha: sha256(src), ...(last ? { lastRun: last } : {}) };
  }

  async view(sessionId: string, name: string): Promise<FlowView> {
    const { machine, cwd } = this.where(sessionId);
    const p = this.paths(cwd, name);
    const src = await this.read(machine, p.file, p.rel);
    const v = this.viewOf(name, p.rel, src, sessionId);
    const layout = readLayout(await machine.readText(p.layout).catch(() => undefined), FLOW_ID_RE);
    if (Object.keys(layout).length) v.layout = layout;
    return v;
  }

  private remember(key: string, ...texts: string[]): void {
    const m = this.versions.get(key) ?? new Map<string, string>();
    for (const t of texts) {
      m.delete(sha256(t));
      m.set(sha256(t), t);
    }
    // shortcut: only the last 40 versions per file are kept, raise it if owners undo further back
    while (m.size > 40) m.delete(m.keys().next().value!);
    this.versions.set(key, m);
  }

  /** One op from the canvas over the version it shows (baseSha), else 409. */
  async edit(sessionId: string, name: string, op: FlowOp, baseSha: string, opts: { member?: boolean } = {}): Promise<FlowEditResult> {
    const { machine, cwd } = this.where(sessionId);
    const p = this.paths(cwd, name);
    const disk = await this.read(machine, p.file, p.rel);
    if (sha256(disk) !== baseSha) throw new EngineError(409, 'flow changed: the file changed since the graph was read; reload it');
    // Call AI bills a gateway key that belongs to the owner
    if (op.op === 'insert' && op.block === 'ai' && opts.member) throw new EngineError(403, 'Call AI is for the owner of this hub');
    let res: { src: string; nodeId?: string };
    try {
      res = applyFlowOp(disk, op);
    } catch (err) {
      if (err instanceof GraphEditError) throw new EngineError(400, err.message);
      throw err;
    }
    if (Buffer.byteLength(res.src, 'utf8') > MAX_FLOW_BYTES) throw new EngineError(400, `the flow would be larger than ${MAX_FLOW_BYTES / 1024} KB`);
    await this.write(machine, p.file, res.src);
    this.remember(`${sessionId}\0${p.file}`, disk, res.src);
    this.engine.audit(sessionId, 'flow.edit', `${name} ${op.op} ${'nodeId' in op ? op.nodeId : op.block}`);
    const view = await this.view(sessionId, name);
    return { sha: view.sha, diff: lineDiff(disk, res.src), view, ...(res.nodeId ? { nodeId: res.nodeId } : {}) };
  }

  /** Undo or redo: put back a version the hub wrote, if the file is still baseSha. */
  async restore(sessionId: string, name: string, sha: string, baseSha: string): Promise<FlowEditResult> {
    const { machine, cwd } = this.where(sessionId);
    const p = this.paths(cwd, name);
    const disk = await this.read(machine, p.file, p.rel);
    if (sha256(disk) !== baseSha) throw new EngineError(409, 'flow changed: the file changed since the graph was read; reload it');
    const next = this.versions.get(`${sessionId}\0${p.file}`)?.get(sha);
    if (next === undefined) throw new EngineError(404, 'that version is gone (the hub restarted or it is too old); edit it in the file');
    await this.write(machine, p.file, next);
    this.remember(`${sessionId}\0${p.file}`, disk, next);
    const view = await this.view(sessionId, name);
    return { sha: view.sha, diff: lineDiff(disk, next), view };
  }

  /** Where the owner dragged the blocks, in .conclave/graph/<name>.json. Layout only; ids not in the graph are dropped. */
  async saveLayout(sessionId: string, name: string, positions: unknown): Promise<GraphPositions> {
    const { machine, cwd } = this.where(sessionId);
    const p = this.paths(cwd, name);
    const src = await this.read(machine, p.file, p.rel);
    const clean = cleanPositions(positions, new Set(parseFlow(src).nodes.map((n) => n.id)), FLOW_ID_RE);
    await this.write(machine, p.layout, printLayout(clean, sha256(src)));
    return clean;
  }

  runState(sessionId: string, name: string): FlowRunView | undefined {
    if (!FLOW_NAME_RE.test(name)) throw new EngineError(400, 'a flow name is lowercase letters, digits and dashes, up to 64');
    return this.runs.get(`${sessionId}\0${name}`)?.view;
  }

  stop(sessionId: string, name: string): FlowRunView | undefined {
    const r = this.runs.get(`${sessionId}\0${name}`);
    if (r && (r.view.status === 'running' || r.view.status === 'approval')) r.controller.abort();
    return r?.view;
  }

  /**
   * Run the flow. Returns at once with status `approval` or `running`; the
   * rest goes on in the background. The approval card names the command,
   * then each literal Shell command and Fetch URL in the flow, since an
   * "always allow" on the command covers them.
   */
  async run(sessionId: string, name: string): Promise<FlowRunView> {
    const { s, machine, cwd } = this.where(sessionId);
    const p = this.paths(cwd, name);
    const key = `${sessionId}\0${name}`;
    const prev = this.runs.get(key);
    if (prev && (prev.view.status === 'running' || prev.view.status === 'approval')) throw new EngineError(409, `${name} is running; stop it first`);
    const src = await this.read(machine, p.file, p.rel);
    const graph = parseFlow(src);
    const command = `bun ${p.rel}`;
    const controller = new AbortController();
    const view: FlowRunView = { runId: newId('flr'), flow: name, status: 'approval', startedAt: Date.now(), output: '', nodes: {} };
    this.runs.set(key, { view, controller });
    void this.go(s, machine, cwd, command, graph, view, controller).catch((err) => {
      view.status = 'failed';
      view.error = (err as Error).message;
      view.finishedAt = Date.now();
    });
    return view;
  }

  private async go(s: Session, machine: Machine, cwd: string, command: string, graph: FlowGraph, view: FlowRunView, controller: AbortController): Promise<void> {
    const extra: string[] = [];
    for (const n of graph.nodes) {
      const a = n.block === 'shell' ? n.args?.command : n.block === 'fetchUrl' ? n.args?.url : undefined;
      if (!a) continue;
      extra.push(`${n.block === 'shell' ? 'shell' : 'fetch'}: ${typeof a.value === 'string' ? oneLine(a.value, 120) : `a ${n.block === 'shell' ? 'command' : 'URL'} from ${a.ref ?? 'code'}`}`);
    }
    const summary = [`Run flow ${view.flow}: ${command}`, ...extra.slice(0, 12)].join('\n');
    const refused = await bashRefusal(this.engine, s, command, summary, controller.signal);
    if (refused) {
      view.status = controller.signal.aborted ? 'stopped' : 'refused';
      view.error = controller.signal.aborted ? 'Stopped before it ran.' : `Not run: ${refused}`;
      view.finishedAt = Date.now();
      return;
    }
    view.status = 'running';
    this.engine.audit(s.id, 'flow.run', command);
    const secrets = await this.secrets(machine, cwd);
    const mask = (t: string) => secrets.reduce((acc, v) => acc.split(v).join('***'), t);
    const nonce = newId('ft');
    const marker = `\x1e${nonce} `;
    const lineNode = (line: number) => graph.nodes.find((n) => line >= n.span.start && line <= n.span.end);
    let carry = '';
    let stderr = '';
    const append = (t: string) => {
      view.output = mask(view.output + t);
      if (view.output.length > MAX_OUTPUT) view.output = view.output.slice(-MAX_OUTPUT);
    };
    const onStderr = (chunk: string) => {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      // a run that writes stderr with no line break must not grow the hub's memory
      if (carry.length > MAX_CARRY) {
        lines.push(carry);
        carry = '';
      }
      for (const l of lines) {
        if (!l.startsWith(marker)) {
          // the first frames are the ones that pin an error; the rest is in view.output
          if (stderr.length < MAX_OUTPUT) stderr += `${l}\n`;
          append(`${l}\n`);
          continue;
        }
        try {
          const rec = JSON.parse(l.slice(marker.length)) as FlowNodeLive & { line?: number };
          const node = typeof rec.line === 'number' ? lineNode(rec.line) : undefined;
          if (!node) continue;
          const live: FlowNodeLive = { ok: !!rec.ok, ...(typeof rec.ms === 'number' ? { ms: rec.ms } : {}) };
          // mask before the cut, so a secret across the cut cannot show its first part
          if (typeof rec.summary === 'string') live.summary = mask(rec.summary.slice(0, MAX_TRACE)).slice(0, 200);
          if (typeof rec.value === 'string') live.value = mask(rec.value.slice(0, MAX_TRACE)).slice(0, 2000);
          if (typeof rec.error === 'string') live.error = mask(rec.error.slice(0, MAX_TRACE)).slice(0, 2000);
          view.nodes[node.id] = live;
        } catch {
          // a broken trace line is dropped, never shown
        }
      }
    };
    const res = await machine.exec(command, {
      cwd,
      env: { CONCLAVE_FLOW_TRACE: nonce },
      timeoutMs: RUN_TIMEOUT_MS,
      signal: controller.signal,
      maxOutputBytes: 1024 * 1024,
      onOutput: (chunk, stream) => (stream === 'stderr' ? onStderr(chunk) : append(chunk)),
    });
    if (carry && !carry.startsWith(marker)) {
      stderr += carry;
      append(carry);
    }
    view.exitCode = res.exitCode;
    view.finishedAt = Date.now();
    if (res.aborted) {
      view.status = 'stopped';
      return;
    }
    if (res.exitCode === 0 && !res.timedOut) {
      view.status = 'done';
      return;
    }
    view.status = 'failed';
    if (res.timedOut) view.error = 'The flow ran longer than 10 minutes and was stopped.';
    else if (res.exitCode === 127 || /bun: (command )?not found/.test(stderr)) view.error = 'Bun is not installed on this device. Install it from https://bun.sh, then Run again.';
    else {
      // an uncaught error: pinned to the block whose lines hold the first frame in this flow file
      const at = new RegExp(`flows/${view.flow}\\.flow\\.ts:(\\d+)`).exec(stderr);
      const message = mask(stderr.split('\n').find((l) => /^\s*(\w*Error|error)\b.*:/.test(l))?.trim() ?? `exit code ${res.exitCode}`);
      view.error = message;
      const node = at ? lineNode(Number(at[1])) : undefined;
      if (node && view.nodes[node.id]?.ok !== false) view.nodes[node.id] = { ok: false, error: message };
    }
  }

  /** Values of 6 or more characters in the .env files Bun loads for the project: masked in what a run shows. */
  private async secrets(machine: Machine, cwd: string): Promise<string[]> {
    const files = ENV_FILES.map((f) => machine.readText(`${cwd}/${f}`).catch(() => ''));
    const text = (await Promise.all(files)).join('\n');
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][\w.]*\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v.length >= 6) out.push(v);
    }
    return out.sort((a, b) => b.length - a.length);
  }
}

const attached = new WeakMap<object, FlowService>();

/** The flow service of an engine, made on first use. */
export function flowsOf(engine: Engine): FlowService {
  let svc = attached.get(engine);
  if (!svc) attached.set(engine, (svc = new FlowService(engine)));
  return svc;
}
