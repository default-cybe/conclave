/**
 * HarnessAdapter over ACP.
 *
 * Starts the harness command from config on the session's Machine, keeps the
 * initialized process in a pool keyed by (harness, machine, cwd, command, env)
 * and reuses it for the next turn. Idle processes are killed after 10 minutes.
 *
 * A turn: open or resume the harness session, pick the model and Effort if
 * asked, send session/prompt, translate session/update notifications into HarnessEvents,
 * route permission prompts into Conclave approvals, finish with `done`.
 */
import type * as acp from '@agentclientprotocol/sdk';
import type { ApprovalResponse, ContentBlock } from '../types';
import type { McpServerConfig, ProviderConfig } from '../config/schema';
import type { Machine } from '../machine/types';
import type { HarnessAdapter, HarnessEvent, HarnessModel, HarnessTurnOptions } from './types';
import { AcpError, HarnessConnection, toAcpError, type ConnectionSpec, type OpenSession, type RawSessionUpdate, type SessionHandler } from './client';
import { harnessOffWords } from './harness-off';
import { logger } from '../util/log';
import { shellQuote } from '../tools/util';
import { clampEffort, EFFORTS, type Effort } from '../providers/effort';

const log = logger('acp');

export interface AcpAdapterOptions {
  /** Kill pooled processes idle for this long. Default 10 minutes. */
  idleMs?: number;
  /** Time allowed for spawn + initialize + session setup. Default 90s (npx may download first). */
  startTimeoutMs?: number;
  /** After session/cancel, how long to wait for the agent to stop before killing it. Default 5s. */
  cancelGraceMs?: number;
}

type DoneReason = Extract<HarnessEvent, { type: 'done' }>['stopReason'];
type ToolStatus = Extract<HarnessEvent, { type: 'tool_update' }>['status'];

const STOP_REASONS = new Set<DoneReason>(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
/**
 * Harness session modes that run every tool without asking, picked for a
 * turn in bypass (permission auto), first one offered wins. claude-agent-acp
 * (Claude Code) calls it bypassPermissions and offers it only when it does
 * not run as root, or with IS_SANDBOX set.
 */
const BYPASS_MODES = ['bypassPermissions'];
const READONLY_SAFE_KINDS = new Set(['read', 'search', 'fetch', 'think']);
const KIND_TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Bash',
  think: 'Think',
  fetch: 'WebFetch',
  switch_mode: 'SwitchMode',
  other: 'Tool',
};

export class AcpAdapter implements HarnessAdapter {
  private pool = new Map<string, HarnessConnection[]>();
  private sweeper?: ReturnType<typeof setInterval>;
  readonly idleMs: number;
  readonly startTimeoutMs: number;
  readonly cancelGraceMs: number;

  constructor(
    private getProviderConfig: (id: string) => ProviderConfig | undefined,
    opts: AcpAdapterOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 90_000;
    this.cancelGraceMs = opts.cancelGraceMs ?? 5_000;
  }

  async probe(harness: string, machine: Machine): Promise<{ ok: boolean; version?: string; detail?: string }> {
    const cfg = this.getProviderConfig(harness);
    if (!cfg || cfg.type !== 'acp' || !cfg.command) return { ok: false, detail: `${harness} is not an ACP harness in config` };
    const home = machine.resolve('~', '/');
    try {
      const which = await machine.exec(`command -v ${shellQuote(cfg.command)}`, { cwd: home, timeoutMs: 10_000 });
      if (which.exitCode !== 0) return { ok: false, detail: `${cfg.command} not found on ${machine.name}` };
    } catch (err) {
      return { ok: false, detail: `could not check for ${cfg.command}: ${String(err)}` };
    }
    let conn: HarnessConnection | undefined;
    try {
      conn = new HarnessConnection({ harness, machine, cwd: home, command: cfg.command, args: cfg.args ?? [], env: cfg.env });
      const init = await conn.initialize(20_000);
      return { ok: true, version: conn.agentName, detail: `ACP protocol v${init.protocolVersion}` };
    } catch (err) {
      const tail = conn?.stderrTail();
      return { ok: false, detail: `${toAcpError(err).message}${tail ? `\n--- stderr ---\n${tail}` : ''}` };
    } finally {
      conn?.kill('probe finished');
    }
  }

  async listModels(harness: string, machine: Machine): Promise<HarnessModel[]> {
    const cfg = this.config(harness);
    const home = machine.resolve('~', '/');
    const conn = new HarnessConnection({ harness, machine, cwd: home, command: cfg.command!, args: cfg.args ?? [], env: cfg.env });
    try {
      await conn.initialize(this.startTimeoutMs);
      const res = await conn.request<acp.NewSessionResponse>('session/new', { cwd: home, mcpServers: [] }, this.startTimeoutMs);
      return harnessModels(res);
    } catch (err) {
      const tail = conn.stderrTail();
      throw new AcpError(`${harness} did not list its models: ${toAcpError(err).message}${tail ? `\n--- stderr ---\n${tail}` : ''}`);
    } finally {
      conn.kill('model list read');
    }
  }

  async *runTurn(opts: HarnessTurnOptions): AsyncIterable<HarnessEvent> {
    const channel = new Channel<HarnessEvent>();
    const turn = new Turn(this, opts, channel);
    void turn.run().finally(() => channel.close());
    try {
      for await (const e of channel) yield e;
    } finally {
      if (!turn.finished) turn.abandon();
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const all = [...this.pool.values()].flat();
    this.pool.clear();
    for (const c of all) c.kill('shutdown');
    await Promise.all(all.map((c) => Promise.race([c.exited, new Promise((r) => setTimeout(r, 3000))])));
  }

  /**
   * End idle harness processes on one machine that hold any of these harness
   * sessions open. A session that moved to another device does not leave a
   * process behind on the old one (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.8).
   * Returns how many were ended; busy ones are left to finish their turn.
   */
  endSessions(machineId: string, harnessSessionIds: string[]): number {
    if (!harnessSessionIds.length) return 0;
    let n = 0;
    for (const list of this.pool.values()) {
      for (const c of [...list]) {
        if (c.busy || c.dead || c.spec.machine.id !== machineId) continue;
        if (!harnessSessionIds.some((id) => c.sessions.has(id))) continue;
        c.kill('session moved to another device');
        this.remove(c);
        n++;
      }
    }
    return n;
  }

  /** Number of live pooled processes (for status pages and tests). */
  get poolSize(): number {
    let n = 0;
    for (const list of this.pool.values()) n += list.filter((c) => !c.dead).length;
    return n;
  }

  // ----- pool (used by Turn) -----------------------------------------------

  /** @internal */
  config(harness: string): ProviderConfig {
    const cfg = this.getProviderConfig(harness);
    if (!cfg) throw new AcpError(`Unknown harness "${harness}"`);
    if (cfg.type !== 'acp' || !cfg.command) throw new AcpError(`Provider "${harness}" is not an ACP harness (needs type "acp" and a command)`);
    const off = harnessOffWords(harness, cfg);
    if (off) throw new AcpError(off);
    return cfg;
  }

  /** @internal Get an idle initialized connection, preferring one that already has `sessionId` open. */
  async acquire(spec: ConnectionSpec, sessionId?: string): Promise<HarnessConnection> {
    const key = poolKey(spec);
    const list = (this.pool.get(key) ?? []).filter((c) => !c.dead);
    this.pool.set(key, list);
    const idle = (sessionId && list.find((c) => !c.busy && c.sessions.has(sessionId))) || list.find((c) => !c.busy);
    if (idle) {
      idle.busy = true;
      idle.lastUsed = Date.now();
      return idle;
    }
    const conn = new HarnessConnection(spec);
    conn.busy = true;
    list.push(conn);
    this.ensureSweeper();
    try {
      await conn.initialize(this.startTimeoutMs);
    } catch (err) {
      const tail = conn.stderrTail();
      conn.kill('initialize failed');
      this.remove(conn);
      throw new AcpError(`${spec.harness} failed to start: ${toAcpError(err).message}${tail ? `\n--- stderr ---\n${tail}` : ''}`);
    }
    return conn;
  }

  /** @internal */
  release(conn: HarnessConnection): void {
    conn.busy = false;
    conn.lastUsed = Date.now();
    if (conn.dead) this.remove(conn);
  }

  private remove(conn: HarnessConnection): void {
    for (const [key, list] of this.pool) {
      const i = list.indexOf(conn);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.pool.delete(key);
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    const every = Math.min(60_000, Math.max(1000, Math.floor(this.idleMs / 2)));
    this.sweeper = setInterval(() => this.sweep(), every);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** @internal Kill idle and dead processes. */
  sweep(now = Date.now()): void {
    for (const list of [...this.pool.values()]) {
      for (const c of [...list]) {
        if (c.dead || (!c.busy && now - c.lastUsed > this.idleMs)) {
          c.kill('idle');
          this.remove(c);
        }
      }
    }
    if (!this.pool.size && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }
}

/**
 * The models a harness offers: its select option of category model (or id
 * "model"), flattened, else the older `models.availableModels` list. Each id
 * once, in the harness's order.
 */
export function harnessModels(res: { configOptions?: acp.SessionConfigOption[] | null; models?: { availableModels?: Array<{ modelId: string; name?: string }> } | null } | null | undefined): HarnessModel[] {
  const out: HarnessModel[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, name: unknown) => {
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) return;
    seen.add(id);
    out.push({ id, ...(typeof name === 'string' && name.trim() && name !== id ? { name } : {}) });
  };
  const opt = (res?.configOptions ?? []).find((c) => c.type === 'select' && (c.category === 'model' || c.id === 'model'));
  if (opt && opt.type === 'select') for (const x of flattenSelect(opt.options)) add(x.value, x.name);
  else for (const m of res?.models?.availableModels ?? []) add(m.modelId, m.name);
  return out;
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

interface CallState {
  id: string;
  name?: string;
  title?: string;
  kind?: string;
  input: Record<string, unknown>;
  locations: Array<{ path: string; line?: number | null }>;
  status?: ToolStatus;
  emitted: boolean;
}

class Turn {
  finished = false;
  private conn?: HarnessConnection;
  private sessionId?: string;
  private handler?: SessionHandler;
  /** Aborted on cancel or abandon; pending approvals listen to it. */
  private stop = new AbortController();
  private calls = new Map<string, CallState>();

  constructor(
    private adapter: AcpAdapter,
    private opts: HarnessTurnOptions,
    private out: Channel<HarnessEvent>,
  ) {}

  private emit(e: HarnessEvent): void {
    if (this.finished) return;
    // calls held back waiting for input are flushed before later output, so order stays right
    if (e.type === 'text_delta' || e.type === 'thinking_delta' || e.type === 'plan') this.flushCalls();
    this.out.push(e);
  }

  private finish(stopReason: DoneReason, error?: string): void {
    if (this.finished) return;
    this.flushCalls();
    this.out.push(error ? { type: 'done', stopReason, error } : { type: 'done', stopReason });
    this.finished = true;
  }

  /** Consumer stopped reading early. Cancel quietly. */
  abandon(): void {
    this.cancel();
    this.finished = true;
  }

  private cancel(): void {
    if (this.stop.signal.aborted) return;
    this.stop.abort();
    if (this.conn && this.sessionId) void this.conn.notify('session/cancel', { sessionId: this.sessionId });
  }

  async run(): Promise<void> {
    const o = this.opts;
    let cfg: ProviderConfig;
    try {
      cfg = this.adapter.config(o.harness);
    } catch (err) {
      return this.finish('error', toAcpError(err).message);
    }
    if (o.signal.aborted) return this.finish('cancelled');

    const cwd = o.machine.resolve(o.cwd, '/');
    const spec: ConnectionSpec = {
      harness: o.harness,
      machine: o.machine,
      cwd,
      command: cfg.command!,
      args: cfg.args ?? [],
      env: { ...(cfg.env ?? {}), ...(o.env ?? {}) },
      ...(o.owner ? { owner: o.owner } : {}),
    };

    const onAbort = () => this.cancel();
    o.signal.addEventListener('abort', onAbort, { once: true });
    let conn: HarnessConnection | undefined;
    try {
      const acquiring = this.adapter.acquire(spec, o.resumeId);
      const got = await Promise.race([acquiring, untilAborted(o.signal)]);
      if (!got) {
        // a slow start was aborted: hand the process back to the pool once it is up
        acquiring.then((c) => this.adapter.release(c), () => {});
        return this.finish('cancelled');
      }
      conn = got;
      this.conn = conn;

      const { session, isNew } = await this.openSession(conn, cwd);
      this.sessionId = session.id;
      this.emit({ type: 'session', id: session.id });
      // the models the harness's account offers, so the model list has the new ones without a release
      const models = harnessModels({ configOptions: session.configOptions, models: session.legacyModels });
      if (models.length) this.emit({ type: 'models', models });

      this.handler = {
        permission: o.permission,
        cwd,
        onUpdate: (u) => this.onUpdate(u),
        requestPermission: (req, signal) => this.onPermission(req, signal),
      };
      conn.attach(session.id, this.handler);

      await this.applyModel(conn, session);
      await this.applyEffort(conn, session);
      await this.applyMode(conn, session);
      if (o.signal.aborted) return this.finish('cancelled');

      const prompt = toAcpPrompt(o.prompt, isNew ? o.priorContext : undefined, conn.capabilities.promptCapabilities);
      const res = await this.prompt(conn, session.id, prompt);
      this.flushCalls();
      if (res.usage) {
        const u = res.usage;
        this.emit({
          type: 'usage',
          usage: {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            ...(u.cachedReadTokens != null ? { cacheReadTokens: u.cachedReadTokens } : {}),
            ...(u.cachedWriteTokens != null ? { cacheWriteTokens: u.cachedWriteTokens } : {}),
            ...(u.thoughtTokens != null ? { reasoningTokens: u.thoughtTokens } : {}),
          },
          model: session.reportedModel ?? session.appliedModel,
        });
      }
      const reason = STOP_REASONS.has(res.stopReason as DoneReason) ? (res.stopReason as DoneReason) : 'end_turn';
      this.finish(o.signal.aborted && reason === 'end_turn' ? 'cancelled' : reason);
    } catch (err) {
      if (o.signal.aborted || this.stop.signal.aborted) return this.finish('cancelled');
      const e = toAcpError(err);
      let msg = e.message;
      if (e.code === -32000) msg = `${o.harness} needs to sign in on ${o.machine.name}. Run its login command there, then retry. (${e.message})`;
      const tail = conn?.stderrTail();
      if (tail && !msg.includes('--- stderr ---')) msg += `\n--- stderr ---\n${tail}`;
      this.finish('error', msg);
    } finally {
      o.signal.removeEventListener('abort', onAbort);
      if (conn) {
        if (this.sessionId && this.handler) conn.detach(this.sessionId, this.handler);
        this.adapter.release(conn);
      }
    }
  }

  private async openSession(conn: HarnessConnection, cwd: string): Promise<{ session: OpenSession; isNew: boolean }> {
    const o = this.opts;
    const caps = conn.capabilities;
    const mcpServers = toAcpMcpServers(o.mcpServers, caps.mcpCapabilities);
    const timeout = this.adapter.startTimeoutMs;
    const remember = (id: string, res: { configOptions?: acp.SessionConfigOption[] | null } | null | undefined): OpenSession => {
      const legacy = (res as { models?: OpenSession['legacyModels'] } | null | undefined)?.models;
      const modes = (res as { modes?: OpenSession['modes'] } | null | undefined)?.modes;
      const prev = conn.sessions.get(id);
      const s: OpenSession = {
        id,
        cwd,
        configOptions: res?.configOptions ?? prev?.configOptions,
        legacyModels: legacy ?? prev?.legacyModels,
        appliedModel: prev?.appliedModel,
        permission: o.permission,
        reportedModel: prev?.reportedModel,
        modes: modes ?? prev?.modes,
        bypassMode: prev?.bypassMode,
        modeBefore: prev?.modeBefore,
      };
      conn.sessions.set(id, s);
      return s;
    };

    if (o.resumeId) {
      const open = conn.sessions.get(o.resumeId);
      if (open) return { session: open, isNew: false };
      try {
        if (caps.sessionCapabilities?.resume) {
          const res = await conn.request<acp.ResumeSessionResponse>('session/resume', { sessionId: o.resumeId, cwd, mcpServers }, timeout);
          return { session: remember(o.resumeId, res), isNew: false };
        }
        if (caps.loadSession) {
          conn.setReplaying(o.resumeId, true);
          try {
            const res = await conn.request<acp.LoadSessionResponse>('session/load', { sessionId: o.resumeId, cwd, mcpServers }, timeout);
            return { session: remember(o.resumeId, res), isNew: false };
          } finally {
            conn.setReplaying(o.resumeId, false);
          }
        }
      } catch (err) {
        if (conn.dead) throw err;
        log.warn(`${o.harness}: could not resume session ${o.resumeId}, starting a new one: ${toAcpError(err).message}`);
      }
    }
    const res = await conn.request<acp.NewSessionResponse>('session/new', { cwd, mcpServers }, timeout);
    return { session: remember(res.sessionId, res), isNew: true };
  }

  private async applyModel(conn: HarnessConnection, s: OpenSession): Promise<void> {
    let want = this.opts.model?.trim();
    // accept "claude-code/opus" as well as "opus"
    if (want?.startsWith(`${this.opts.harness}/`)) want = want.slice(this.opts.harness.length + 1);
    if (!want || want === 'default' || s.appliedModel === want) return;
    try {
      const opt = (s.configOptions ?? []).find((c) => c.type === 'select' && (c.category === 'model' || c.id === 'model'));
      if (opt && opt.type === 'select') {
        const value = matchChoice(
          flattenSelect(opt.options).map((x) => ({ id: x.value, name: x.name })),
          want,
        );
        if (!value) return log.debug(`${this.opts.harness}: model "${want}" not offered`);
        if (value !== opt.currentValue) {
          const res = await conn.request<acp.SetSessionConfigOptionResponse>(
            'session/set_config_option',
            { sessionId: s.id, configId: opt.id, value },
            30_000,
          );
          if (res?.configOptions) s.configOptions = res.configOptions;
        }
        s.appliedModel = want;
        return;
      }
      const legacy = s.legacyModels?.availableModels;
      if (legacy?.length) {
        const value = matchChoice(
          legacy.map((m) => ({ id: m.modelId, name: m.name })),
          want,
        );
        if (!value) return;
        if (value !== s.legacyModels?.currentModelId) await conn.request('session/set_model', { sessionId: s.id, modelId: value }, 30_000);
        s.appliedModel = want;
      }
    } catch (err) {
      log.debug(`${this.opts.harness}: could not set model ${want}: ${toAcpError(err).message}`);
    }
  }

  /**
   * The turn's Effort through the harness's own option (claude-agent-acp's
   * "effort", an ACP select of category thought_level): the nearest level it
   * offers, or its "default" again when the turn asks for none after one was
   * set. Says which levels it offers for the model, so the hub offers the same;
   * a harness without the option says none, and the hub offers none.
   */
  private async applyEffort(conn: HarnessConnection, s: OpenSession): Promise<void> {
    const opt = (s.configOptions ?? []).find((c) => c.type === 'select' && (c.category === 'thought_level' || c.id === 'effort'));
    if (!opt || opt.type !== 'select') {
      this.emit({ type: 'effort', levels: [] });
      return;
    }
    const choices = flattenSelect(opt.options);
    const byLevel = new Map<Effort, string>();
    for (const c of choices) {
      const level = effortOfChoice(c.value, c.name);
      if (level && !byLevel.has(level)) byLevel.set(level, c.value);
    }
    const levels = EFFORTS.filter((l) => byLevel.has(l));
    this.emit({ type: 'effort', levels });
    const want = this.opts.effort;
    let value: string | undefined;
    if (want) {
      const level = clampEffort(want, { levels, off: false });
      value = level && level !== 'off' ? byLevel.get(level) : undefined;
    } else if (s.appliedEffort) value = choices.find((c) => c.value === 'default')?.value;
    if (!value) return;
    try {
      if (value !== opt.currentValue) {
        const res = await conn.request<acp.SetSessionConfigOptionResponse>('session/set_config_option', { sessionId: s.id, configId: opt.id, value }, 30_000);
        if (res?.configOptions) s.configOptions = res.configOptions;
      }
      s.appliedEffort = want ? value : undefined;
    } catch (err) {
      log.debug(`${this.opts.harness}: could not set effort ${want ?? 'default'}: ${toAcpError(err).message}`);
    }
  }

  /** The agent's mode selector: a config option of category mode, else the session modes it listed. */
  private modeSelector(s: OpenSession): { ids: string[]; current?: string; option?: acp.SessionConfigOption } {
    const opt = (s.configOptions ?? []).find((c) => c.type === 'select' && (c.category === 'mode' || c.id === 'mode'));
    if (opt && opt.type === 'select') return { ids: flattenSelect(opt.options).map((c) => c.value), current: String(opt.currentValue), option: opt };
    return { ids: (s.modes?.availableModes ?? []).map((m) => m.id), current: s.modes?.currentModeId };
  }

  /**
   * Bypass reaches the harness itself. An auto turn (the session in bypass
   * mode) switches a harness that offers a bypass mode (claude-agent-acp's
   * bypassPermissions) into it, so Claude Code runs its tools without asking
   * at all, rather than asking and having each prompt answered here. A later
   * turn that asks or is read-only puts back the mode the bypass turn
   * replaced. A harness without such a mode (claude-agent-acp running as
   * root offers none) keeps having its prompts answered allow_once.
   */
  private async applyMode(conn: HarnessConnection, s: OpenSession): Promise<void> {
    const sel = this.modeSelector(s);
    const auto = this.opts.permission === 'auto';
    let want: string | undefined;
    if (auto) {
      want = BYPASS_MODES.find((id) => sel.ids.includes(id));
      if (!want || want === sel.current) return;
    } else {
      // only a mode a bypass turn set is put back; one the harness or its own user picked stays
      if (!s.bypassMode || sel.current !== s.bypassMode) {
        s.bypassMode = undefined;
        s.modeBefore = undefined;
        return;
      }
      want = s.modeBefore && s.modeBefore !== s.bypassMode && sel.ids.includes(s.modeBefore) ? s.modeBefore : sel.ids.includes('default') ? 'default' : undefined;
      if (!want) return;
    }
    try {
      if (sel.option) {
        const res = await conn.request<acp.SetSessionConfigOptionResponse>('session/set_config_option', { sessionId: s.id, configId: sel.option.id, value: want }, 30_000);
        if (res?.configOptions) s.configOptions = res.configOptions;
        else (sel.option as { currentValue: string }).currentValue = want;
      } else {
        await conn.request('session/set_mode', { sessionId: s.id, modeId: want }, 30_000);
      }
      if (s.modes) s.modes = { ...s.modes, currentModeId: want };
      if (auto) {
        s.modeBefore = sel.current;
        s.bypassMode = want;
      } else {
        s.modeBefore = undefined;
        s.bypassMode = undefined;
      }
    } catch (err) {
      // the turn still runs: its prompts are answered here (onPermission)
      log.debug(`${this.opts.harness}: could not set mode ${want}: ${toAcpError(err).message}`);
    }
  }

  /** The agent changed its mode or its options (current_mode_update, config_option_update): keep the remembered state true. */
  private noteMode(u: RawSessionUpdate): void {
    const s = this.sessionId ? this.conn?.sessions.get(this.sessionId) : undefined;
    if (!s) return;
    if (u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) {
      s.configOptions = u.configOptions as acp.SessionConfigOption[];
      return;
    }
    const id = typeof u.currentModeId === 'string' ? u.currentModeId : typeof u.modeId === 'string' ? u.modeId : undefined;
    if (!id) return;
    if (s.modes) s.modes = { ...s.modes, currentModeId: id };
    const opt = (s.configOptions ?? []).find((c) => c.type === 'select' && (c.category === 'mode' || c.id === 'mode'));
    if (opt && opt.type === 'select') (opt as { currentValue: string }).currentValue = id;
  }

  private async prompt(conn: HarnessConnection, sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const call = conn.request<acp.PromptResponse>('session/prompt', { sessionId, prompt });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = new Promise<acp.PromptResponse>((resolve) => {
      const arm = () => {
        timer = setTimeout(() => {
          // the agent ignored session/cancel; stop the process so the next turn starts clean
          conn.kill('did not stop after cancel');
          resolve({ stopReason: 'cancelled' });
        }, this.adapter.cancelGraceMs);
      };
      if (this.stop.signal.aborted) arm();
      else this.stop.signal.addEventListener('abort', arm, { once: true });
    });
    try {
      return await Promise.race([call, graceExpired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ----- session/update translation ----------------------------------------

  private onUpdate(u: RawSessionUpdate): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = chunkText(u.content);
        if (text) this.emit({ type: 'text_delta', text });
        break;
      }
      case 'agent_thought_chunk': {
        const text = chunkText(u.content);
        if (text) this.emit({ type: 'thinking_delta', text });
        break;
      }
      case 'tool_call':
      case 'tool_call_update':
        this.onToolUpdate(u);
        break;
      case 'plan':
        this.emitPlan(u.entries);
        break;
      case 'plan_update': {
        const plan = u.plan as { type?: string; entries?: unknown } | undefined;
        if (plan?.type === 'items') this.emitPlan(plan.entries);
        break;
      }
      case 'usage_update': {
        const rl = u._meta?.['_claude/rateLimit'];
        if (rl && typeof rl === 'object') {
          const windows = claudeRateLimitWindows(rl as Record<string, unknown>);
          if (windows.length) this.emit({ type: 'rate_limit', windows });
        }
        break;
      }
      case 'current_mode_update':
      case 'config_option_update':
        this.noteMode(u);
        break;
      default:
        break;
    }
  }

  private emitPlan(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    this.emit({
      type: 'plan',
      entries: entries
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => ({
          content: String(e.content ?? ''),
          status: e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending',
          ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
        })),
    });
  }

  /** Merge a tool_call / tool_call_update / permission toolCall into the call state. */
  private mergeCall(u: Record<string, unknown>): CallState {
    const id = String(u.toolCallId ?? '');
    let st = this.calls.get(id);
    if (!st) {
      st = { id, input: {}, locations: [], emitted: false };
      this.calls.set(id, st);
    }
    const meta = (u._meta ?? undefined) as Record<string, unknown> | undefined;
    const metaName = (meta?.claudeCode as { toolName?: unknown } | undefined)?.toolName;
    if (typeof u.name === 'string' && u.name) st.name = u.name;
    else if (!st.name && typeof metaName === 'string') st.name = metaName;
    if (typeof u.title === 'string' && u.title) st.title = u.title;
    if (typeof u.kind === 'string') st.kind = u.kind;
    if (u.rawInput !== undefined && u.rawInput !== null) {
      st.input = typeof u.rawInput === 'object' && !Array.isArray(u.rawInput) ? (u.rawInput as Record<string, unknown>) : { input: u.rawInput };
    }
    if (Array.isArray(u.locations)) st.locations = u.locations as CallState['locations'];
    if (typeof u.status === 'string') st.status = u.status as ToolStatus;
    return st;
  }

  private emitCall(st: CallState): void {
    if (st.emitted) return;
    st.emitted = true;
    if (!Object.keys(st.input).length && st.locations.length) st.input = { path: st.locations[0].path };
    this.emit({
      type: 'tool_call',
      id: st.id,
      name: st.name ?? KIND_TOOL_NAMES[st.kind ?? 'other'] ?? 'Tool',
      title: st.title ?? st.name ?? 'Tool call',
      ...(st.kind ? { kind: st.kind } : {}),
      input: st.input,
    });
  }

  private flushCalls(): void {
    for (const st of this.calls.values()) if (!st.emitted) this.emitCall(st);
  }

  private onToolUpdate(u: RawSessionUpdate): void {
    const st = this.mergeCall(u);
    const content = Array.isArray(u.content) ? (u.content as Array<Record<string, unknown>>) : [];
    const hasInput = Object.keys(st.input).length > 0;
    const started = !!st.status && st.status !== 'pending';
    if (!st.emitted && (hasInput || started || content.length)) this.emitCall(st);
    if (!st.emitted) return;
    if (u.sessionUpdate === 'tool_call' && !started && !content.length) return;
    if (u.sessionUpdate === 'tool_call_update' && typeof u.status !== 'string' && !content.length && u.rawOutput === undefined) return;

    const texts: string[] = [];
    const diffs: Array<{ path: string; oldText?: string; newText: string }> = [];
    for (const c of content) {
      if (c.type === 'content') {
        const t = chunkText(c.content);
        if (t) texts.push(t);
      } else if (c.type === 'diff' && typeof c.path === 'string') {
        diffs.push({ path: c.path, ...(typeof c.oldText === 'string' ? { oldText: c.oldText } : {}), newText: String(c.newText ?? '') });
      } else if (c.type === 'terminal' && typeof c.terminalId === 'string') {
        const t = this.conn?.terminalText(c.terminalId);
        if (t) texts.push(t);
      }
    }
    let output = texts.length ? texts.join('\n') : undefined;
    if (output === undefined && (st.status === 'completed' || st.status === 'failed')) output = rawOutputText(u.rawOutput);
    const status: ToolStatus = st.status ?? 'in_progress';
    this.emit({
      type: 'tool_update',
      id: st.id,
      status,
      ...(output !== undefined ? { output } : {}),
      ...(diffs[0] ? { diff: diffs[0] } : {}),
    });
    for (const d of diffs.slice(1)) this.emit({ type: 'tool_update', id: st.id, status, diff: d });
  }

  // ----- permissions --------------------------------------------------------

  private async onPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const st = this.mergeCall(req.toolCall as unknown as Record<string, unknown>);
    this.emitCall(st);
    const options = req.options ?? [];
    const mode = this.opts.permission;
    if (mode === 'auto') return pickOption(options, 'allow_once');
    if (mode === 'readonly') return pickOption(options, st.kind && READONLY_SAFE_KINDS.has(st.kind) ? 'allow_once' : 'reject_once');

    if (signal.aborted || this.stop.signal.aborted) return CANCELLED;
    let res: ApprovalResponse | undefined;
    const aborted = new Promise<undefined>((resolve) => {
      const done = () => resolve(undefined);
      signal.addEventListener('abort', done, { once: true });
      this.stop.signal.addEventListener('abort', done, { once: true });
    });
    try {
      res = await Promise.race([
        this.opts.requestApproval({
          toolUseId: st.id,
          tool: st.name ?? KIND_TOOL_NAMES[st.kind ?? 'other'] ?? 'Tool',
          input: st.input,
          summary: summarizeCall(st),
          harness: this.opts.harness,
        }),
        aborted,
      ]);
    } catch (err) {
      log.warn(`approval failed: ${String(err)}`);
      return pickOption(options, 'reject_once');
    }
    if (!res) return CANCELLED;
    if (res.decision === 'allow') return pickOption(options, !res.scope || res.scope === 'once' ? 'allow_once' : 'allow_always');
    return pickOption(options, 'reject_once');
  }
}

const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

function untilAborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

/** Pick the agent's option id for a decision, falling back to the nearest kind it offers. */
export function pickOption(options: acp.PermissionOption[], want: acp.PermissionOptionKind): acp.RequestPermissionResponse {
  const order: Record<string, acp.PermissionOptionKind[]> = {
    allow_once: ['allow_once', 'allow_always'],
    allow_always: ['allow_always', 'allow_once'],
    reject_once: ['reject_once', 'reject_always'],
    reject_always: ['reject_always', 'reject_once'],
  };
  for (const kind of order[want] ?? [want]) {
    const o = options.find((x) => x.kind === kind);
    if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  return CANCELLED;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function poolKey(s: ConnectionSpec): string {
  const env = Object.entries(s.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  // the account is part of the key: a member's turn never gets the owner's process, which runs where the owner may and as the owner
  return [s.owner ?? '', s.harness, s.machine.id, s.cwd, s.command, s.args.join('\u0001'), JSON.stringify(env)].join('\u0000');
}

function chunkText(content: unknown): string {
  const c = content as { type?: string; text?: string; uri?: string; name?: string; resource?: { text?: string; uri?: string } } | undefined;
  if (!c) return '';
  if (c.type === 'text') return c.text ?? '';
  if (c.type === 'resource_link') return c.uri ? `[${c.name ?? c.uri}](${c.uri})` : '';
  if (c.type === 'resource') return c.resource?.text ?? '';
  return '';
}

function rawOutputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const k of ['output', 'stdout', 'content', 'result', 'text']) if (typeof r[k] === 'string') return r[k] as string;
    try {
      const s = JSON.stringify(raw);
      return s.length > 20_000 ? s.slice(0, 20_000) + '...' : s;
    } catch {
      return undefined;
    }
  }
  return String(raw);
}

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/** Human one-liner for an approval prompt, e.g. "Run: rm -rf build". */
export function summarizeCall(st: { kind?: string; title?: string; name?: string; input: Record<string, unknown>; locations?: Array<{ path: string }> }): string {
  const i = st.input as Record<string, any>;
  const path: string | undefined = i.file_path ?? i.path ?? i.filePath ?? i.notebook_path ?? st.locations?.[0]?.path;
  const cmd = i.command ?? i.cmd;
  let s: string | undefined;
  switch (st.kind) {
    case 'execute':
      if (cmd) s = `Run: ${Array.isArray(cmd) ? cmd.join(' ') : String(cmd)}`;
      break;
    case 'edit':
      if (path) s = `Edit ${path}`;
      break;
    case 'delete':
      if (path) s = `Delete ${path}`;
      break;
    case 'move': {
      const from = i.from ?? i.source ?? path;
      const to = i.to ?? i.destination;
      if (from && to) s = `Move ${from} -> ${to}`;
      break;
    }
    case 'read':
      if (path) s = `Read ${path}`;
      break;
    case 'fetch':
      if (i.url) s = `Fetch ${i.url}`;
      break;
    case 'search': {
      const q = i.pattern ?? i.query;
      if (q) s = `Search ${q}`;
      break;
    }
  }
  if (!s && typeof cmd === 'string') s = `Run: ${cmd}`;
  return oneLine(s ?? st.title ?? st.name ?? 'Tool call');
}

function flattenSelect(options: acp.SessionConfigSelectOptions): acp.SessionConfigSelectOption[] {
  const out: acp.SessionConfigSelectOption[] = [];
  for (const o of options as Array<acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup>) {
    if ('options' in o && Array.isArray(o.options)) out.push(...o.options);
    else out.push(o as acp.SessionConfigSelectOption);
  }
  return out;
}

/** A harness's Effort choice as a Conclave level ("xhigh", "Extra high", "Max"); "default", "none" and "minimal" are not one. */
export function effortOfChoice(value: string, name?: string | null): Effort | undefined {
  for (const raw of [value, name ?? '']) {
    const w = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if ((EFFORTS as readonly string[]).includes(w)) return w as Effort;
    if (w === 'extrahigh' || w === 'veryhigh') return 'xhigh';
    if (w === 'maximum') return 'max';
  }
  return undefined;
}

/** Find the agent's id for a wanted model: exact id, then name, then substring. */
export function matchChoice(choices: Array<{ id: string; name?: string | null }>, want: string): string | undefined {
  const w = want.toLowerCase();
  return (
    choices.find((c) => c.id === want)?.id ??
    choices.find((c) => c.id.toLowerCase() === w)?.id ??
    choices.find((c) => (c.name ?? '').toLowerCase() === w)?.id ??
    choices.find((c) => c.id.toLowerCase().includes(w) || (c.name ?? '').toLowerCase().includes(w))?.id
  );
}

/** Map Conclave MCP server config to ACP's shape, skipping transports the agent cannot use. */
export function toAcpMcpServers(servers: Record<string, McpServerConfig> | undefined, caps?: acp.McpCapabilities): acp.McpServer[] {
  const out: acp.McpServer[] = [];
  for (const [name, s] of Object.entries(servers ?? {})) {
    if (s.enabled === false) continue;
    const type = s.type ?? (s.url ? 'http' : 'stdio');
    const pairs = (r?: Record<string, string>) => Object.entries(r ?? {}).map(([n, value]) => ({ name: n, value }));
    if (type === 'stdio' && s.command) {
      out.push({ name, command: s.command, args: s.args ?? [], env: pairs(s.env) });
    } else if (type === 'http' && s.url && caps?.http) {
      out.push({ type: 'http', name, url: s.url, headers: pairs(s.headers) });
    } else if (type === 'sse' && s.url && caps?.sse) {
      out.push({ type: 'sse', name, url: s.url, headers: pairs(s.headers) });
    } else if (s.url) {
      log.debug(`MCP server ${name}: harness does not accept ${type} servers, skipped`);
    }
  }
  return out;
}

/** Turn Conclave content blocks into an ACP prompt. Prior context goes first, wrapped. */
export function toAcpPrompt(blocks: ContentBlock[], priorContext: string | undefined, caps?: acp.PromptCapabilities): acp.ContentBlock[] {
  const out: acp.ContentBlock[] = [];
  if (priorContext?.trim()) out.push({ type: 'text', text: `<prior_conversation>\n${priorContext.trim()}\n</prior_conversation>` });
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        out.push({ type: 'text', text: b.text });
        break;
      case 'image':
        if (b.data && caps?.image) out.push({ type: 'image', data: b.data, mimeType: b.mediaType });
        else if (b.url) out.push({ type: 'resource_link', uri: b.url, name: 'image', mimeType: b.mediaType });
        else out.push({ type: 'text', text: '[image omitted: this harness does not accept images]' });
        break;
      case 'document': {
        const name = b.title ?? 'document';
        if (b.data && /^(text\/|application\/(json|xml|x-yaml|yaml))/.test(b.mediaType)) {
          const text = Buffer.from(b.data, 'base64').toString('utf8');
          if (caps?.embeddedContext) out.push({ type: 'resource', resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType: b.mediaType, text } });
          else out.push({ type: 'text', text: `<document title="${name}">\n${text}\n</document>` });
        } else if (b.data && caps?.embeddedContext) {
          out.push({ type: 'resource', resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType: b.mediaType, blob: b.data } });
        } else if (b.url) {
          out.push({ type: 'resource_link', uri: b.url, name, mimeType: b.mediaType });
        } else {
          out.push({ type: 'text', text: `[document "${name}" omitted: this harness does not accept ${b.mediaType}]` });
        }
        break;
      }
      case 'tool_use':
        out.push({ type: 'text', text: `[tool call ${b.name}: ${JSON.stringify(b.input)}]` });
        break;
      case 'tool_result': {
        const text = typeof b.content === 'string' ? b.content : b.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
        out.push({ type: 'text', text: `[tool result${b.isError ? ' (error)' : ''}: ${text}]` });
        break;
      }
      default:
        break;
    }
  }
  if (!out.length) out.push({ type: 'text', text: '' });
  return out;
}

const CLAUDE_WINDOW_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d opus',
  seven_day_sonnet: '7d sonnet',
  seven_day_overage_included: '7d',
  overage: 'overage',
};

/** claude-agent-acp forwards Claude Code's rate limit info in usage_update._meta["_claude/rateLimit"]. */
export function claudeRateLimitWindows(info: Record<string, unknown>): Array<{ name: string; usedPercent?: number; resetsAt?: number }> {
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
  const name = (type && CLAUDE_WINDOW_NAMES[type]) ?? type ?? 'limit';
  let used: number | undefined;
  if (typeof info.utilization === 'number') used = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  if (info.status === 'rejected') used = 100;
  let resetsAt: number | undefined;
  if (typeof info.resetsAt === 'number') resetsAt = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
  if (used === undefined && resetsAt === undefined) return [];
  return [{ name, ...(used !== undefined ? { usedPercent: Math.round(used * 10) / 10 } : {}), ...(resetsAt ? { resetsAt } : {}) }];
}

// ---------------------------------------------------------------------------
// Tiny async channel
// ---------------------------------------------------------------------------

class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as T, done: true });
      },
    };
  }
}
