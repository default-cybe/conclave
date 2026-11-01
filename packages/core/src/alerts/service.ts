/**
 * Alerts about work in progress (docs/DESIGN.md 28), after the AOS
 * dashboard's two warnings for Claude Code:
 *
 * - File conflicts. The hub keeps, per device and absolute path, which
 *   session wrote a file and when: from the write tools (Write, Edit,
 *   MultiEdit, NotebookEdit) through a runner extension, and from the edits
 *   an ACP harness reports with its tool results. A write on a file another
 *   live session wrote in the last 10 minutes gets one line on its result for
 *   the model, and the Inbox gets one item and a notification per pair of
 *   sessions and file per 10 minutes. A subagent and its parent never
 *   conflict, and sessions of one tree only while both run. Agents in their
 *   own worktrees write other paths, so they never meet here. With
 *   permissions.onFileConflict "ask" such a write asks first instead.
 * - Stuck turns (alerts/stuck.ts): no progress for the threshold, or the same
 *   tool failing the same way 3 times in a row. One Inbox item with Stop and
 *   Keep waiting (the threshold doubles, counted from the answer); it clears
 *   itself when progress comes or the turn ends. A quiet subagent or workflow
 *   agent has nobody to answer in time, so no item: its call is cut, and it
 *   fails over to its fallback model once, else reports the stall to its
 *   parent (engine/subagent.ts driveSubagent).
 *
 * Everything lives in memory: a hub restart drops the alerts with the turns
 * they were about.
 */
import type { EngineEventEnvelope, Session, SessionStatus, TextBlock } from '../types';
import type { AlertAction, AlertItem, LiveAlerts } from '../client/alerts';
import type { Engine } from '../engine/engine';
import type { RunnerExtension, ToolCallContext } from '../session/runner-ext';
import type { ToolOutput } from '../tools/types';
import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } from '../tools/bash';
import { clampInt } from '../tools/util';
import { newId } from '../util/ids';
import { oneLine } from '../util/text';
import { logger } from '../util/log';
import { CONFLICT_WINDOW_MS, FileWrites, absolutePath, conflictLine, shownPath } from './writes';
import { DEFAULT_STUCK_MINUTES, StuckWatch, type IdleVerdict, type LoopVerdict, type StuckReason } from './stuck';
import { setAlerts } from './attached';

const log = logger('alerts');

/** How often the stuck check runs. */
export const ALERT_TICK_MS = 15_000;

/** A turn in progress: running, or waiting on the owner in the middle of it. */
const ACTIVE = new Set<SessionStatus>(['running', 'waiting_approval', 'waiting_input']);

/** Tools that wait on other work (a subagent, a workflow, the owner): they never count as stuck. */
const WAITING_TOOLS = new Set(['Task', 'Delegate', 'Workflow', 'TaskWait', 'TaskContinue', 'AskUserQuestion', 'ExitPlanMode', 'Consult']);

/** Results that say nothing about the tool: the owner said no, or the call never ran to the end. */
function countsAsFailure(meta: Record<string, unknown> | undefined): boolean {
  return !(meta?.denied === 'user' || meta?.interrupted || meta?.notRun || meta?.planRejected);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && (b as TextBlock).type === 'text' ? (b as TextBlock).text : '')).join('\n');
  return '';
}

/** One error, compared as text: whitespace folded, stored output ids masked, cut. */
function errorKey(text: string): string {
  return text.replace(/\bout_[0-9a-z]{12,}\b/g, 'out_*').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function pairKey(device: string, path: string, a: string, b: string): string {
  return ['c', device, path, ...[a, b].sort()].join('\n');
}

function stuckKey(sessionId: string, reason: StuckReason): string {
  return `s\n${sessionId}\n${reason}`;
}

function minutes(ms: number): string {
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

/** The session's id and its ancestors', nearest first (8 levels at most). */
function lineage(engine: Engine, s: Session): string[] {
  const out = [s.id];
  let cur: Session | undefined = s;
  for (let i = 0; i < 8 && cur?.parentId; i++) {
    out.push(cur.parentId);
    cur = engine.getSession(cur.parentId);
  }
  return out;
}

/** lineage: one started the other (a subagent and its parent). tree: same root session. none: unrelated. */
function relation(engine: Engine, a: Session, b: Session): 'lineage' | 'tree' | 'none' {
  const la = lineage(engine, a);
  const lb = lineage(engine, b);
  if (la.includes(b.id) || lb.includes(a.id)) return 'lineage';
  return la[la.length - 1] === lb[lb.length - 1] ? 'tree' : 'none';
}

function withLine(output: ToolOutput, line: string): ToolOutput {
  if (typeof output.content === 'string') return { ...output, content: `${output.content}\n\n${line}` };
  return { ...output, content: [...output.content, { type: 'text', text: line }] };
}

interface Pair {
  device: string;
  path: string;
  /** The session that wrote first, then the one that wrote on top of it. */
  first: string;
  second: string;
  since: number;
  lastAt: number;
}

export type ActResult = 'ok' | 'missing' | 'bad';

export class AlertService {
  private items = new Map<string, AlertItem>();
  /** Open item id per key (a pair and file, or a session and reason), and back. */
  private open = new Map<string, string>();
  private keyOf = new Map<string, string>();
  private writes = new FileWrites();
  private watch = new StuckWatch();
  private pairs = new Map<string, Pair>();
  /** When an item was last raised (or a write asked) per pair and file: the 10 minute debounce. */
  private raised = new Map<string, number>();
  /** The other writer's write each session was last told about, per file, so the model hears it once. */
  private told = new Map<string, number>();
  /** Write calls that asked first (onFileConflict ask); the owner saw the question, so no Inbox item. */
  private asked = new Map<string, number>();
  /** When each session's last turn ended. */
  private ended = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private off: Array<() => void> = [];

  constructor(private readonly engine: Engine) {}

  /** Listen to the event stream and the write tools; with timer, check for stuck turns every ALERT_TICK_MS. */
  start(opts: { timer?: boolean } = {}): this {
    this.off.push(this.engine.bus.on((e) => this.onEvent(e)));
    this.off.push(this.engine.runnerExtensions.register(this.extension()));
    if (opts.timer) {
      this.timer = setInterval(() => this.tick(), ALERT_TICK_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const f of this.off.splice(0)) f();
  }

  /** Open alerts, oldest first. */
  list(): AlertItem[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): AlertItem | undefined {
    return this.items.get(id);
  }

  /** Stop or Keep waiting on a stuck turn, Dismiss on a file conflict. */
  act(id: string, action: AlertAction): ActResult {
    const item = this.items.get(id);
    const key = this.keyOf.get(id);
    if (!item || !key) return 'missing';
    if (item.kind === 'stuck') {
      if (action === 'stop') {
        this.engine.audit(item.sessionId, 'alert.stop', item.text);
        this.clear(key);
        this.engine.abort(item.sessionId);
        return 'ok';
      }
      if (action === 'wait') {
        this.watch.keepWaiting(item.sessionId, item.reason ?? 'idle', Date.now());
        this.engine.audit(item.sessionId, 'alert.wait', item.text);
        this.clear(key);
        return 'ok';
      }
      return 'bad';
    }
    if (action !== 'dismiss') return 'bad';
    this.clear(key);
    return 'ok';
  }

  /** The live state for views that draw sessions (alerts/attached.ts liveAlerts). */
  live(now = Date.now()): LiveAlerts {
    const stuck: LiveAlerts['stuck'] = {};
    for (const f of this.watch.flags()) stuck[f.sessionId] ??= { stuckSince: f.since, reason: f.reason };
    const conflicts: LiveAlerts['conflicts'] = [];
    for (const p of this.pairs.values()) {
      if (now - p.lastAt > CONFLICT_WINDOW_MS || !this.isLive(p.first, now) || !this.isLive(p.second, now)) continue;
      conflicts.push({ file: p.path, device: p.device, sessions: [p.first, p.second], since: p.since });
    }
    return { stuck, conflicts };
  }

  /** Raise stuck alerts for turns past their threshold, and forget what is older than the window. */
  tick(now = Date.now()): void {
    for (const v of this.watch.check(now, (model) => this.thresholdMs(model))) this.raiseIdle(v, now);
    const old = now - CONFLICT_WINDOW_MS;
    this.writes.prune(now);
    for (const [k, p] of this.pairs) if (p.lastAt < old) this.pairs.delete(k);
    for (const m of [this.raised, this.told, this.asked, this.ended]) for (const [k, at] of m) if (at < old) m.delete(k);
  }

  /** The stuck threshold for a model in ms, 0 when it is off: limits.stuck.models, else limits.stuck.minutes, else 5 min. */
  thresholdMs(model: string): number {
    const cfg = this.engine.config.get().limits?.stuck;
    const models = cfg?.models ?? {};
    const provider = model.split('/')[0];
    const m = models[model] ?? models[`${provider}/*`] ?? models[provider] ?? cfg?.minutes ?? DEFAULT_STUCK_MINUTES;
    return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m * 60_000 : 0;
  }

  // -------------------------------------------------------------------------
  // File conflicts
  // -------------------------------------------------------------------------

  /** The runner extension: ask before a conflicting write (onFileConflict ask), and note one after it lands. */
  private extension(): RunnerExtension {
    return {
      name: 'alerts',
      beforeTool: (ctx) => this.beforeWrite(ctx),
      afterTool: (ctx, _toolCtx, output) => this.afterWrite(ctx, output),
    };
  }

  private beforeWrite(ctx: ToolCallContext) {
    if (!ctx.tool.editsFiles || (this.engine.config.get().permissions.onFileConflict ?? 'warn') !== 'ask') return undefined;
    const path = absolutePath(ctx.input.file_path ?? ctx.input.notebook_path, ctx.session.cwd);
    if (!path) return undefined;
    const now = Date.now();
    const device = ctx.session.device || 'local';
    // asked once per pair and file per window; a denied write asks again, since nothing was recorded
    const fresh = this.rivals(ctx.session, device, path, now).filter((r) => {
      const last = this.raised.get(pairKey(device, path, ctx.session.id, r.session.id));
      return last === undefined || now - last >= CONFLICT_WINDOW_MS;
    });
    if (!fresh.length) return undefined;
    this.asked.set(ctx.toolUseId, now);
    return { decision: 'ask' as const, reason: conflictLine(fresh[0].session.title, fresh[0].at, now) };
  }

  private afterWrite(ctx: ToolCallContext, output: ToolOutput): ToolOutput | undefined {
    const asked = this.asked.delete(ctx.toolUseId);
    if (!ctx.tool.editsFiles || output.isError) return undefined;
    // the path the tool wrote (an old path from before a move is mapped to the current folder), else its input
    const path = absolutePath(output.meta?.path ?? ctx.input.file_path ?? ctx.input.notebook_path, ctx.session.cwd);
    if (!path) return undefined;
    const line = this.onWrite(ctx.session, path, { asked });
    return line ? withLine(output, line) : undefined;
  }

  /**
   * Record a write and look for other live sessions that wrote the same file
   * in the window. Returns the line for the model when there is news for it.
   */
  onWrite(session: Session, path: string, opts: { asked?: boolean; at?: number } = {}): string | undefined {
    const now = opts.at ?? Date.now();
    const device = session.device || 'local';
    const rivals = this.rivals(session, device, path, now);
    this.writes.record(device, path, session.id, now);
    if (!rivals.length) return undefined;
    for (const r of rivals) {
      const key = pairKey(device, path, session.id, r.session.id);
      const pair = this.pairs.get(key);
      if (pair) pair.lastAt = now;
      else this.pairs.set(key, { device, path, first: r.session.id, second: session.id, since: now, lastAt: now });
      // after a question the owner already knows: that was the one item for this window
      if (opts.asked) this.raised.set(key, now);
      else this.raiseConflict(key, r.session, session, device, path, now);
    }
    const newest = rivals[0];
    const told = `${session.id}\n${device}\n${path}\n${newest.session.id}`;
    if (this.told.get(told) === newest.at) return undefined;
    this.told.set(told, newest.at);
    return conflictLine(newest.session.title, newest.at, now);
  }

  /** Other sessions whose write of this file conflicts with this session's write now, newest first. */
  private rivals(session: Session, device: string, path: string, now: number): Array<{ session: Session; at: number }> {
    const out: Array<{ session: Session; at: number }> = [];
    for (const w of this.writes.others(device, path, session.id, now)) {
      const other = this.engine.getSession(w.sessionId);
      if (!other || other.archived) continue;
      const rel = relation(this.engine, session, other);
      // a subagent and the session that started it work for one owner's request
      if (rel === 'lineage') continue;
      const active = ACTIVE.has(other.status);
      // in one tree the parent hands out the work: only agents that run at the same time conflict
      if (rel === 'tree' && !active) continue;
      if (!active && !this.isLive(other.id, now)) continue;
      out.push({ session: other, at: w.at });
    }
    return out;
  }

  /** Running now, or a turn that ended in the window. */
  private isLive(id: string, now: number): boolean {
    const s = this.engine.getSession(id);
    if (!s || s.archived) return false;
    if (ACTIVE.has(s.status)) return true;
    return now - (this.ended.get(id) ?? s.updatedAt) <= CONFLICT_WINDOW_MS;
  }

  private raiseConflict(key: string, first: Session, second: Session, device: string, path: string, now: number): void {
    const openId = this.open.get(key);
    const item = openId ? this.items.get(openId) : undefined;
    if (item) {
      item.updatedAt = now;
      this.engine.bus.emit({ type: 'alert.raised', alert: item });
      return;
    }
    const last = this.raised.get(key);
    if (last !== undefined && now - last < CONFLICT_WINDOW_MS) return;
    this.raised.set(key, now);
    const file = shownPath(path, [second.cwd, first.cwd]);
    const text = `'${first.title}' and '${second.title}' are both editing ${file}`;
    this.add(key, {
      id: newId('alrt'),
      kind: 'fileConflict',
      sessionId: second.id,
      text,
      createdAt: now,
      updatedAt: now,
      device,
      path,
      file,
      sessions: [
        { id: first.id, title: first.title },
        { id: second.id, title: second.title },
      ],
    });
    this.engine.audit(second.id, 'alert.fileConflict', `${device}:${path} with ${first.id}`);
    this.notify('fileConflict', 'File conflict', text, second.id, this.open.get(key)!);
  }

  // -------------------------------------------------------------------------
  // Stuck turns
  // -------------------------------------------------------------------------

  private onEvent(e: EngineEventEnvelope): void {
    try {
      switch (e.type) {
        case 'session.updated':
          this.onStatus(e.session, e.ts);
          break;
        case 'session.deleted':
          this.forget(e.sessionId);
          break;
        case 'message.delta':
          this.progress(e.sessionId, e.ts);
          break;
        case 'tool.started':
          this.progress(e.sessionId, e.ts);
          this.watch.toolStarted(e.sessionId, e.toolUseId, e.name, this.toolLimit(e.name, e.input), e.ts);
          break;
        case 'tool.completed':
          this.progress(e.sessionId, e.ts);
          this.onResult(e.sessionId, e.toolUseId, e.result, e.ts);
          break;
      }
    } catch (err) {
      log.warn(`alert check failed on ${e.type}`, err);
    }
  }

  private onStatus(session: Session, at: number): void {
    const st = session.status;
    if (st === 'running') this.watch.running(session.id, session.model, at);
    else if (st === 'waiting_approval' || st === 'waiting_input') {
      if (this.watch.pause(session.id)) this.clear(stuckKey(session.id, 'idle'));
    } else if (this.watch.has(session.id)) {
      // idle, error, or parked for a usage limit: the turn is over
      this.ended.set(session.id, at);
      this.watch.end(session.id);
      this.clear(stuckKey(session.id, 'idle'));
      this.clear(stuckKey(session.id, 'loop'));
    }
  }

  private progress(sessionId: string, at: number): void {
    if (this.watch.progress(sessionId, at)) this.clear(stuckKey(sessionId, 'idle'));
  }

  private onResult(sessionId: string, toolUseId: string, result: { content: unknown; isError?: boolean; meta?: Record<string, unknown> }, at: number): void {
    const name = this.watch.toolEnded(sessionId, toolUseId);
    // an ACP harness reports the files it edits on its tool results
    if (result.meta?.external && typeof result.meta.path === 'string' && !result.isError) {
      const s = this.engine.getSession(sessionId);
      const path = s ? absolutePath(result.meta.path, s.cwd) : undefined;
      if (s && path) this.onWrite(s, path);
    }
    if (!this.watch.has(sessionId) || !countsAsFailure(result.meta)) return;
    if (!result.isError) {
      if (this.watch.success(sessionId)) this.clear(stuckKey(sessionId, 'loop'));
      return;
    }
    const error = errorKey(resultText(result.content)) || 'Tool error';
    const v = this.watch.failure(sessionId, name ?? 'A tool', error, at);
    if (v.cleared) this.clear(stuckKey(sessionId, 'loop'));
    if (v.loop) this.raiseLoop(v.loop, at);
  }

  /** The tool's own time limit: Bash's timeout, an MCP tool's limit, Infinity for tools that wait on other work, 0 for none. */
  private toolLimit(name: string, input: Record<string, unknown>): number {
    if (WAITING_TOOLS.has(name)) return Infinity;
    if (name === 'Bash') return input?.run_in_background ? 0 : clampInt(input?.timeout, BASH_DEFAULT_TIMEOUT_MS, 1_000, BASH_MAX_TIMEOUT_MS);
    const tool = this.engine.allTools().find((t) => t.name === name) ?? this.engine.cachedMcpTools().find((t) => t.name === name);
    return tool?.timeoutMs ?? 0;
  }

  private raiseIdle(v: IdleVerdict, now: number): void {
    const s = this.engine.getSession(v.sessionId);
    if (!s) return;
    const key = stuckKey(s.id, 'idle');
    if (this.open.has(key)) return;
    const text = `No progress in '${s.title}' for ${minutes(now - v.since)}`;
    if (s.meta?.subagent && this.engine.runnerFor(s.id).stall(v.tool)) {
      this.engine.audit(s.id, 'alert.stall', text);
      // a fallback model gets a full threshold of its own
      this.watch.progress(s.id, now);
      return;
    }
    this.add(key, { id: newId('alrt'), kind: 'stuck', reason: 'idle', sessionId: s.id, text, createdAt: now, updatedAt: now, sessions: [{ id: s.id, title: s.title }], since: v.since, thresholdMs: v.thresholdMs });
    this.engine.audit(s.id, 'alert.stuck', text);
    // the chat's name as the title, so the body does not say it again
    this.notify('stuck', s.title, `No progress for ${minutes(now - v.since)}`, s.id, this.open.get(key)!);
  }

  private raiseLoop(v: LoopVerdict, now: number): void {
    const s = this.engine.getSession(v.sessionId);
    if (!s) return;
    const key = stuckKey(s.id, 'loop');
    if (this.open.has(key)) return;
    const text = `'${s.title}' may be in a loop: ${v.tool} failed the same way ${v.count} times`;
    this.add(key, {
      id: newId('alrt'),
      kind: 'stuck',
      reason: 'loop',
      sessionId: s.id,
      text,
      createdAt: now,
      updatedAt: now,
      sessions: [{ id: s.id, title: s.title }],
      since: v.since,
      tool: v.tool,
      count: v.count,
      error: oneLine(v.error, 200),
    });
    this.engine.audit(s.id, 'alert.loop', text);
    this.notify('stuck', s.title, `Possible loop: ${v.tool} failed the same way ${v.count} times`, s.id, this.open.get(key)!);
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private add(key: string, item: AlertItem): void {
    this.items.set(item.id, item);
    this.open.set(key, item.id);
    this.keyOf.set(item.id, key);
    this.engine.bus.emit({ type: 'alert.raised', alert: item });
  }

  private clear(key: string): void {
    const id = this.open.get(key);
    if (!id) return;
    this.open.delete(key);
    this.keyOf.delete(id);
    const item = this.items.get(id);
    this.items.delete(id);
    if (item) this.engine.bus.emit({ type: 'alert.cleared', id, sessionId: item.sessionId });
  }

  /** A session went away: its writes, its turn and every alert that names it. */
  private forget(sessionId: string): void {
    this.writes.forget(sessionId);
    this.watch.end(sessionId);
    this.ended.delete(sessionId);
    for (const [k, p] of this.pairs) if (p.first === sessionId || p.second === sessionId) this.pairs.delete(k);
    for (const item of [...this.items.values()]) {
      if (item.sessionId === sessionId || item.sessions?.some((r) => r.id === sessionId)) {
        const key = this.keyOf.get(item.id);
        if (key) this.clear(key);
      }
    }
  }

  private notify(kind: 'fileConflict' | 'stuck', title: string, body: string, sessionId: string, alertId: string): void {
    this.engine.notifyEvent(kind, { title, body, level: 'warning', sessionId, link: `/s/${sessionId}`, alertId, thread: this.engine.askOrigin(sessionId).rootSessionId });
  }
}

/** Make the alert service for an engine and start it. timer: check for stuck turns on a clock (off in tests, which call tick). */
export function attachAlerts(engine: Engine, opts: { timer?: boolean } = {}): AlertService {
  const svc = new AlertService(engine).start(opts);
  setAlerts(engine, svc);
  return svc;
}
