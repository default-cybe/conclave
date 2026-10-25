import type {
  AgentResultRef,
  ApprovalResponse,
  ContentBlock,
  ImageBlock,
  Message,
  QueuedMessage,
  Session,
  SessionMode,
  TextBlock,
  Todo,
  ToolResultBlock,
  ToolUseBlock,
} from '../types';
import type { SendInput, SendResult } from '../client';
import type { ReadMark, Tool, ToolContext, ToolOutput } from '../tools/types';
import { coerceInput, timeoutOutput, toolIsReadOnly, validateInput } from '../tools/types';
import type { AgentDef } from '../extensions/types';
import type { ProviderMessage, SystemBlock, ToolSpec } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { Engine } from '../engine/engine';
import { activeMessages, buildProviderMessages, lastAssistantText, reminder, isReminder } from './transcript';
import { buildSystemPrompt, subagentCatalog, type PromptParts } from './prompt';
import { delegateCatalog } from '../engine/delegate';
import { flattenLastToolTurn, isTranscriptShapeError } from './pairing';
import { streamCompletion, type Served } from './stream';
import { transcribeImages } from './image-text';
import { seesImages } from '../providers/common';
import { refusalPlan, refusalStepOf, refusalWords, RefusalWalk, servedLabel, stepOfTarget, type FallbackTarget } from './refusal-fallback';
import { checkPermission, dangerousCommand } from './permissions';
import { ReadTool } from '../tools/read';
import { maybeCompact, estimateRequestTokens, meteredTokens, partHash, type TokenMeter } from './compaction';
import { applyClearing } from './context-edit';
import { afterWokenTurn, handleLimit, nextAccount, switchBack } from './limits';
import { OWNER_ID, isMember, runAs } from '../people/context';
import { deviceFolder, runHarnessTurn } from './harness';
import { LoopGuard, type Verdict } from './loop-guard';
import { restoreTurnCheckpoint, startTurnCheckpoint, type TurnCheckpoint } from './checkpoints';
import { runJury } from '../modes/jury';
import { runDebate } from '../modes/debate';
import { loopCheck } from '../modes/loop';
import { defuseFrameworkTags } from './untrusted';
import { friendGuardTurn } from './friend-share';
import { oneLine, truncateMiddle } from '../util/text';
import { newId } from '../util/ids';
import { KEEPS, KIND_NAMES, reduceOutput } from '../tools/compress';
import { logger } from '../util/log';
import { logTurn, type TurnLog } from '../logs/events';
import { memoryRecallBudget } from '../engine/builtin-hooks';
import { STOP_BLOCK_CAP } from '../extensions/hooks';
import { loadPathRules, loadScopedInstructions, type InstructionFile, type PathRule } from '../extensions/instructions';
import { pendingSwitch, switchNote } from '../modes/switch-marker';
import type { Machine } from '../machine/types';

const log = logger('runner');

/** Model calls per user turn when config and agent say nothing (config limits.maxSteps, limits.subagentMaxSteps). */
export const DEFAULT_MAX_STEPS = 250;
export const DEFAULT_SUBAGENT_MAX_STEPS = 100;
/** Share of the step budget after which the model gets one note to save progress. */
const STEP_NOTE_AT = 0.8;

/** Why the last agent loop ended, for callers that report it (subagents, routines). */
export type LoopStop = 'done' | 'step_limit' | 'loop_capped' | 'output_limit' | 'refusal' | 'empty_reply' | 'rate_limit' | 'hook' | 'harness';

/** File tools after which nested instruction files and path rules for that file are shown (item 11). */
const SCOPED_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);
/** Longest part of one scoped instruction file shown on a tool result. */
const SCOPED_FILE_CHARS = 4_000;

/** Tools that are safe to run at the same time as others even though they are not read-only. */
const CONCURRENT_TOOLS = new Set(['Task', 'Delegate', 'Consult', 'WebFetch', 'WebSearch']);
/** Continuations after replies cut by the output limit, in a row, before the loop stops. */
const MAX_LENGTH_CONTINUES = 2;
/** Retries of an empty reply per turn. */
const MAX_EMPTY_RETRIES = 1;
/** Compactions in one turn (a long tool loop can fill the window more than once). */
const MAX_COMPACTIONS_PER_TURN = 3;

export const NOT_RUN_MAX_TOKENS =
  'Not run: your reply hit the output token limit before this call was complete. Send it again in smaller parts, for example a short Write followed by Edit calls.';
export const NOT_RUN_REFUSAL = 'Not run: your reply ended with a refusal, so its tool calls were dropped.';
export const INTERRUPTED = 'Interrupted: the turn was stopped before this call finished. It may have run in part; check the current state before you retry it.';
const CONTINUE_AFTER_OUTPUT_LIMIT =
  'Your last reply hit the output token limit and was cut off. Continue exactly where it stopped, without repeating what you already wrote. Split long output into smaller parts.';
/** Sent before the retry of an empty reply: the same request again tends to get the same empty reply. */
export const CONTINUE_AFTER_EMPTY_REPLY = 'Your last reply was empty. Continue: answer the user, or take the next step of the task.';

export function stepBudgetNote(used: number, max: number): string {
  return `Step budget: you have used ${used} of ${max} steps in this turn. Save durable progress now (files, TodoWrite), then continue. Do not stop only because of this note.`;
}

export function stepLimitReminder(max: number): string {
  return `You reached the step limit for this turn (${max} steps). Do not call tools. Reply with a final report: what you did, what you found, what is left, and the next step you recommend.`;
}

/** Sent before the toolless final-answer call after the loop guard stopped the turn. */
export function loopStopReminder(why: string): string {
  return `The loop guard stopped your tool calls for this turn: ${why} Do not call tools. Reply with a final report: what you did, what you found, what is left, and what is blocking you.`;
}

/** No visible text and no tool calls. Thinking alone does not count as a reply. */
function isEmptyReply(content: ContentBlock[]): boolean {
  return !content.some((b) => (b.type === 'text' && b.text.trim()) || b.type === 'tool_use');
}

/** A model's name for the model to read ("Claude Opus 5.5"), else its ref. */
function modelLabel(engine: Engine, ref: string): string {
  try {
    return engine.providers.resolve(ref).info.name || ref;
  } catch {
    return ref;
  }
}

/** Nobody watches the turn as it runs: subagents, loop mode and routines. */
/** A turns row for a user turn. Recap data must never break a turn. */
function startTurn(engine: Engine, sessionId: string, model: string, startedAt: number): string | undefined {
  try {
    return engine.repos.turns.start({ sessionId, model, startedAt });
  } catch (err) {
    log.debug('turn row not written', err);
    return undefined;
  }
}

/** Close a turns row: tool calls since the user message, the account of its last call, how it ended. Returns the tool calls. */
function endTurn(engine: Engine, turnId: string, sessionId: string, userSeq: number, startedAt: number, outcome: string): number | undefined {
  try {
    let tools = 0;
    for (const m of engine.repos.messages.list(sessionId, { afterSeq: userSeq })) if (m.role === 'assistant') tools += m.content.filter((b) => b.type === 'tool_use').length;
    engine.repos.turns.end(turnId, { tools, outcome, account: engine.repos.usage.lastAccount(sessionId, startedAt) });
    return tools;
  } catch (err) {
    log.debug('turn row not closed', err);
    return undefined;
  }
}

/** One line in the hub's log files per user turn (docs/DESIGN.md 33): ids, model, time, tokens, cost, how it ended. Never the text. */
function logTurnLine(engine: Engine, t: Omit<TurnLog, 'usage'>): void {
  try {
    const u = engine.repos.usage.totals({ sessionId: t.sessionId, from: t.startedAt });
    logTurn({ ...t, usage: { calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: u.costUsd } });
  } catch {
    /* logging must never break a turn */
  }
}

export function isUnattended(session: Session, mode: SessionMode, depth: number): boolean {
  return depth > 0 || mode === 'loop' || !!session.routineId || (session.tags ?? []).includes('routine');
}

/** Nobody reads the result as it comes: the unattended cases, a headless `conclave run` (tagged cli-run) and a workflow step (tagged workflow). */
export function isHeadless(session: Session, mode: SessionMode, depth: number): boolean {
  const tags = session.tags ?? [];
  return isUnattended(session, mode, depth) || tags.includes('cli-run') || tags.includes('workflow');
}

/**
 * Prompt cache lifetime for a request (config cache.ttl). auto: 5m when
 * nobody waits on the turn, since its requests come seconds apart and a 5m
 * write costs 1.25x input against 2x for 1h; 1h in an interactive session,
 * where the next request after the reply may come minutes later and should
 * still read the history at the cache read price.
 */
export function cacheTtlFor(setting: 'auto' | '5m' | '1h' | undefined, headless: boolean): '5m' | '1h' {
  if (setting === '5m' || setting === '1h') return setting;
  return headless ? '5m' : '1h';
}

interface Queued {
  input: SendInput;
  auto?: boolean;
  /** Continues a turn a usage limit parked (session/limits.ts resumeAfterReset). */
  resume?: boolean;
  /** Resume only a failed native inference, without submitting a user turn again. */
  inference?: boolean;
  /** Started to show pending notes to an idle session. */
  forNotes?: boolean;
  /** Sent by a person while the session was busy: apps show it until it joins the transcript (session.queue). */
  pending?: QueuedMessage;
  /** "Try the next model" on a refused reply: the turn runs again on the next refusal fallback entry, with no new user message. */
  refusal?: { served: Served; reply?: Message };
  /** Work that owns this one turn only (a routine run in the assistant home thread). */
  turn?: TurnHooks;
}

/**
 * A turn that belongs to someone else's work in a shared session (a routine
 * in the assistant home thread): meta marks its user message, start and end
 * run around this turn alone, and end also runs when the turn never starts
 * (Stop drops it). The person's messages never join it as steering.
 */
export interface TurnHooks {
  meta?: Record<string, unknown>;
  start?: () => void;
  end?: () => void;
}

/** How an agentLoop call starts (the "Try the next model" button). */
export interface LoopOptions {
  /** The reply that refused (already dropped): the loop starts on the refusal fallback entry after it. reply stands again when no entry answers. */
  refusal?: { served: Served; reply?: Message };
}

/** A steering message: it joins the running turn at its next step. */
interface Steer {
  input: SendInput;
  pending: QueuedMessage;
}

/** Where a session's waiting messages are kept (kv), so a hub restart keeps them. */
export const QUEUE_KEY = 'queue.';

/** A waiting message as kept in kv: what runs, and what apps show. */
export interface StoredQueued {
  input: SendInput;
  pending: QueuedMessage;
}

/** What an app may name a waiting message (SendInput.pendingId). */
const PENDING_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Said to the model with a steering message, as a reminder: apps show only your words. */
export const STEER_NOTE = 'Sent while you were working.';

/** What unqueue found: taken off the queue, its turn already started, or no such message. */
export type UnqueueResult = 'removed' | 'started' | 'missing';

/** The system prompt a runner keeps between steps (SessionRunner.systemFor). */
interface PromptSnapshot {
  /** What the prompt is built from that may change within a session: agent, model, mode, folder, device, switches. */
  key: string;
  parts: PromptParts;
  blocks: SystemBlock[];
  /** agentLoop call (user turn) the instruction files were last read in. */
  loop: number;
}

/** The parts of a prompt read again once per user turn; the same text keeps the snapshot. */
function partsSignature(p: PromptParts): string {
  return JSON.stringify([p.projectInstructions, p.skills.map((k) => [k.name, k.description]), p.isGitRepo, p.testCommand ?? '', p.workspace ?? {}, p.platform, p.hostname ?? '', p.deviceName, p.conclave ?? null]);
}

/** Every memory the snapshot shows is still there with the same text (new ones wait for the next rebuild). */
function profileHolds(shown: PromptParts['profile'], now: PromptParts['profile']): boolean {
  if (!shown.length) return true;
  const byId = new Map(now.map((m) => [m.id, m.content]));
  return shown.every((m) => byId.get(m.id) === m.content);
}

/** A note for the model that arrived from outside the loop (a background subagent's result). */
export interface PendingNote {
  block: ContentBlock;
  /** Child session the note came from. */
  source?: string;
  /** Start a turn for this note when the session is idle. */
  wake: boolean;
  /** A finished background task's report: the message that carries it says so in meta.agentResults, for the apps' row. */
  result?: AgentResultRef;
}

/**
 * Owns one session's execution: a queue of user inputs and the agent loop.
 * The engine keeps one runner per active session.
 */
export class SessionRunner {
  readonly id: string;
  private queue: Queued[] = [];
  private inferenceError?: ProviderError;
  private retryNotice?: string;
  private steering: Steer[] = [];
  /** The waiting message whose turn is starting: listed until its user message is in the transcript, so apps never lose it. */
  private starting?: Queued;
  /** The hub is shutting down: no next turn starts, and what waits stays stored for the next boot. */
  private closed = false;
  private controller?: AbortController;
  running = false;
  readState = new Map<string, number>();
  sessionAllow: string[] = [];
  todos: Todo[] = [];
  shellCwd?: string;
  depth = 0;
  /** The input whose turn runs now. */
  private current?: Queued;
  /** Resolves when the current drain finishes (used by subagents and routines). */
  private idleWaiters: Array<() => void> = [];
  private turnStartedAt = 0;
  /** The turns row of the user turn in progress (Recap data); an ACP harness adds its session id to it. */
  turnId?: string;
  /** SessionStart has fired for this runner (so SessionEnd should fire when it ends). */
  private sessionStarted = false;
  /** Fire SessionStart with this source on the next user turn (after /clear or a compaction). */
  private pendingStart?: 'clear' | 'compact';
  /** Claude's stop_hook_active: false until a Stop hook blocks and the loop continues. */
  private stopHookActive = false;
  /** Notes waiting for the next tool-results message or the next turn. */
  private pendingNotes: PendingNote[] = [];
  private noteTimer?: ReturnType<typeof setTimeout>;
  /** Set by abort(): pending notes wait for the next turn instead of starting one. */
  private notesHeld = false;
  /** agentLoop calls in progress (subagents run the loop without drain), so abort() reaches them too. */
  private activeLoops = new Set<AbortController>();
  /** Notes that arrive within this window of each other start one turn. */
  noteDelayMs = 2_000;
  /** Why the last agentLoop call ended. */
  lastStop?: LoopStop;
  /** The checkpoint of the current turn (agent and loop mode), for the regression gate. */
  turnCheckpoint?: TurnCheckpoint;
  /** The system prompt, kept byte for byte between steps (systemFor). */
  private prompt?: PromptSnapshot;
  /** Build the system prompt again on the next step (after a compaction or /clear). */
  private promptStale = false;
  /** agentLoop calls so far: one per user turn, or per jury and debate call. */
  private loops = 0;
  /** The last provider call's usage, the base of the next request estimate (HARNESS-REVIEW item 8). */
  private meter?: TokenMeter;
  /** Path rules (`.claude/rules` with paths:), read once per user turn. */
  private pathRules?: { loop: number; cwd: string; rules: PathRule[]; dirs: Map<string, InstructionFile[]> };
  /** Scoped instruction files already shown in this session (session meta scopedInstructions). */
  private scopedShown?: Set<string>;
  /** Read marks by path: the active messages' file tool results, then this runner's newer ones (item 17). */
  private marks?: Map<string, ReadMark>;
  /** Results of the current step's calls, before the step stores them as one message (engine.sharedFile reads a card from here). */
  readonly stepResults = new Map<string, ToolResultBlock>();
  /** Marks in messages at or below this seq do not count (the session moved since). */
  private marksAfterSeq = 0;

  constructor(
    private engine: Engine,
    id: string,
  ) {
    this.id = id;
  }

  get session(): Session {
    const s = this.engine.repos.sessions.get(this.id);
    if (!s) throw new Error(`Session ${this.id} not found`);
    return s;
  }

  /**
   * Queue a user input. Idle, its turn starts now. Busy, it waits: after the
   * running turn (queue), or until the running turn's next step (steer). A
   * person's message that waits is listed for apps (session.queue) under its
   * pendingId until it joins the transcript.
   */
  async enqueue(input: SendInput, opts: { auto?: boolean; resume?: boolean; turn?: TurnHooks } = {}): Promise<SendResult> {
    if (this.running) {
      if (input.whenBusy === 'steer' && !opts.auto && !this.current?.turn) {
        const pending = this.pendingFor(input, 'steer');
        this.steering.push({ input, pending });
        this.emitQueue();
        return { queued: true, pendingId: pending.id };
      }
      const pending = opts.auto ? undefined : this.pendingFor(input, 'queue');
      this.queue.push({ input, auto: opts.auto, resume: opts.resume, pending, turn: opts.turn });
      if (pending) this.emitQueue();
      return { queued: true, ...(pending ? { pendingId: pending.id } : {}) };
    }
    this.queue.push({ input, auto: opts.auto, resume: opts.resume, turn: opts.turn });
    void this.drain();
    return { queued: false };
  }

  /**
   * "Try the next model": run the last turn again on the next refusal
   * fallback entry after `served` (engine.tryNextModel dropped the refused
   * reply). No user message is added; the owner's words stay as they are.
   */
  retryRefusal(served: Served, reply?: Message): void {
    this.queue.push({ input: { text: '' }, auto: true, refusal: { served, ...(reply ? { reply } : {}) } });
    void this.drain();
  }

  /** Consume a failed inference boundary before starting work, so concurrent or stale retries cannot replay it. */
  retryProvider(messageId: string, model: string): void {
    const engine = this.engine;
    const messages = engine.repos.messages.list(this.id);
    const at = messages.findIndex((m) => m.id === messageId);
    const notice = messages[at];
    if (this.busy || this.session.status !== 'error' || this.retryNotice !== messageId || !notice || messages.slice(at + 1).some((m) => m.kind !== 'notice')) {
      throw new Error('This failed inference is no longer available to retry. Nothing was rerun.');
    }
    this.retryNotice = undefined;
    engine.updateMessage(messageId, { meta: { ...notice.meta, canRetry: false } });
    engine.updateSession(this.id, { model });
    engine.notice(this.id, `Retrying failed inference with ${engine.displayModel(model)} (${model}). Completed tool calls are preserved.`, 'info');
    this.queue.push({ input: { text: '' }, auto: true, inference: true });
    void this.drain();
  }

  /** What waits, in the order it joins the transcript: the turn starting now, steering for the running turn, then the queue. */
  get pending(): QueuedMessage[] {
    const out: QueuedMessage[] = [];
    if (this.starting?.pending) out.push(this.starting.pending);
    for (const s of this.steering) out.push(s.pending);
    for (const q of this.queue) if (q.pending) out.push(q.pending);
    return out;
  }

  /** Take a waiting message off before it runs. */
  unqueue(pendingId: string): UnqueueResult {
    if (this.starting?.pending?.id === pendingId) return 'started';
    const q = this.queue.findIndex((x) => x.pending?.id === pendingId);
    if (q >= 0) this.queue.splice(q, 1);
    else {
      const s = this.steering.findIndex((x) => x.pending.id === pendingId);
      if (s < 0) return 'missing';
      this.steering.splice(s, 1);
    }
    this.emitQueue();
    return 'removed';
  }

  private pendingFor(input: SendInput, whenBusy: QueuedMessage['whenBusy']): QueuedMessage {
    const asked = input.pendingId;
    const id = typeof asked === 'string' && PENDING_ID.test(asked) && !this.pending.some((p) => p.id === asked) ? asked : newId('q');
    const attachments = (input.attachments ?? []).map((a) => {
      const name = a.name ?? a.path?.split(/[\\/]/).pop();
      return { mediaType: a.mediaType, ...(name ? { name } : {}) };
    });
    return { id, text: input.text, at: Date.now(), whenBusy, ...(attachments.length ? { attachments } : {}) };
  }

  /** Send a message Stop held: it runs in its place in the queue. False when it is not waiting. */
  release(pendingId: string): boolean {
    const i = this.queue.findIndex((x) => x.pending?.id === pendingId);
    if (i < 0) return false;
    const q = this.queue[i];
    if (q.pending?.held) {
      const { held: _h, ...pending } = q.pending;
      this.queue[i] = { ...q, pending };
      this.emitQueue();
    }
    if (!this.running) void this.drain();
    return true;
  }

  /** Messages kept from before a hub restart (engine.restoreQueues): they wait again, in their order, and run unless held. */
  restore(items: StoredQueued[]): void {
    this.queue.push(...items.map((x): Queued => ({ input: { ...x.input, whenBusy: 'queue' }, pending: { ...x.pending, whenBusy: 'queue' } })));
    this.emitQueue();
    const s = this.engine.repos.sessions.get(this.id);
    // a parked session runs them when it resumes
    if (s && !s.archived && s.status !== 'waiting_reset') void this.drain();
  }

  private emitQueue(): void {
    this.storeQueue();
    this.engine.bus.emit({ type: 'session.queue', sessionId: this.id, queue: this.pending });
  }

  /** What waits is stored each time it changes, and a message leaves only once it is in the transcript. */
  private storeQueue(): void {
    const items: StoredQueued[] = [];
    for (const q of [...(this.starting ? [this.starting] : []), ...this.steering, ...this.queue]) if (q.pending) items.push({ input: q.input, pending: q.pending });
    try {
      // shortcut: attachments are stored inline (base64) with the message; move them to files if queues with big files show up
      if (items.length) this.engine.repos.kv.set(QUEUE_KEY + this.id, items);
      else this.engine.repos.kv.delete(QUEUE_KEY + this.id);
    } catch (err) {
      log.warn(`could not store the queue of ${this.id}`, err);
    }
  }

  /**
   * The person's queued messages at the front of the queue become steering for
   * the running turn, in order. One held, or with its own mode or model, waits
   * for its own turn, and so does everything after it.
   */
  private queuedToSteering(): void {
    if (this.current?.turn) return;
    const take: Steer[] = [];
    for (const q of this.queue) {
      if (!q.pending) continue;
      if (q.pending.held || q.auto || q.input.mode || q.input.model) break;
      take.push({ input: q.input, pending: q.pending });
    }
    if (!take.length) return;
    const moved = new Set(take.map((s) => s.pending.id));
    this.queue = this.queue.filter((q) => !q.pending || !moved.has(q.pending.id));
    this.steering.push(...take);
  }

  /** The first input that may run: a message Stop held waits for the owner. */
  private nextIndex(): number {
    return this.closed ? -1 : this.queue.findIndex((q) => !q.pending?.held);
  }

  /**
   * Stop (or the hub shutting down). Auto inputs go; what a person sent waits
   * on, stored: after a Stop it is held until they send or remove it, at
   * shutdown it runs after the next boot.
   */
  abort(why: 'stop' | 'shutdown' = 'stop'): void {
    if (why === 'shutdown') this.closed = true;
    const late = this.steering.map((s): Queued => ({ input: { ...s.input, whenBusy: 'queue' }, pending: { ...s.pending, whenBusy: 'queue' } }));
    const waiting = [...late, ...this.queue.filter((q) => q.pending)];
    for (const q of this.queue) if (!q.pending) q.turn?.end?.();
    const changed = waiting.length > 0 || this.queue.length > 0;
    this.queue = waiting.map((q) => (why === 'stop' ? { ...q, pending: { ...q.pending!, held: true } } : q));
    this.steering = [];
    this.notesHeld = true;
    this.controller?.abort();
    for (const loop of this.activeLoops) loop.abort();
    this.engine.cancelPendingFor(this.id);
    if (changed && why === 'stop') this.emitQueue();
  }

  /** True while a turn or an agent loop runs for this session. */
  get busy(): boolean {
    return this.running || this.activeLoops.size > 0;
  }

  /**
   * Hand the model a note from outside the loop. While the session works, the
   * note joins the next tool-results message; when it is idle and the note
   * may wake it, a turn starts (notes within noteDelayMs share one turn).
   * Otherwise the note joins the next turn's user message.
   */
  deliver(note: PendingNote): void {
    this.pendingNotes.push(note);
    if (!this.busy) this.scheduleNoteTurn();
  }

  /** Notes not yet shown to the model. */
  get pendingNoteCount(): number {
    return this.pendingNotes.length;
  }

  private takeNotes(): PendingNote[] {
    return this.pendingNotes.splice(0);
  }

  private scheduleNoteTurn(): void {
    if (this.noteTimer || this.notesHeld || !this.pendingNotes.some((n) => n.wake)) return;
    this.noteTimer = setTimeout(() => {
      this.noteTimer = undefined;
      if (this.busy || this.notesHeld || !this.pendingNotes.some((n) => n.wake)) return;
      const session = this.engine.repos.sessions.get(this.id);
      // a parked session picks the notes up when it resumes
      if (!session || session.archived || session.status === 'waiting_reset') return;
      const mode = session.mode === 'jury' || session.mode === 'debate' ? 'agent' : undefined;
      this.queue.push({ input: { text: '', ...(mode ? { mode } : {}) }, auto: true, forNotes: true });
      void this.drain();
    }, this.noteDelayMs);
  }

  /** True once SessionStart fired for this runner. The engine fires SessionEnd only for these. */
  get started(): boolean {
    return this.sessionStarted;
  }

  /** Ask for a SessionStart hook with this source on the next user turn. */
  markSessionStart(source: 'clear' | 'compact'): void {
    this.pendingStart = source;
    this.promptStale = true;
    this.meter = undefined;
    // a Read the compaction dropped no longer counts: the model no longer sees that text
    this.marks = undefined;
    // the results that carried scoped instructions are gone from context, so they are shown again on the next touch
    this.scopedShown = new Set();
    if (this.engine.repos.sessions.get(this.id)?.meta?.scopedInstructions) this.engine.patchMeta(this.id, { scopedInstructions: undefined });
  }

  /**
   * The session's folder or device changed: the shell starts in the new
   * folder, files must be read again before an edit, and session allow rules
   * that name a path stop applying (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.1 bug 2).
   */
  resetPathState(): void {
    this.shellCwd = undefined;
    this.readState.clear();
    this.marks = undefined;
    this.marksAfterSeq = this.engine.repos.messages.nextSeq(this.id) - 1;
    this.sessionAllow = this.sessionAllow.filter((r) => !/[/\\~]/.test(r));
  }

  /**
   * Ask the runner extensions before a model step. A park sets waiting_input
   * and waits; afterwards they are asked again. Returns false to end the turn.
   */
  private async stepGate(mode: SessionMode, iter: number, signal: AbortSignal): Promise<boolean> {
    const engine = this.engine;
    for (let round = 0; round < 50; round++) {
      if (signal.aborted) throw new Error('aborted');
      const verdict = await engine.runnerExtensions.beforeStep({ sessionId: this.id, session: this.session, mode, depth: this.depth, iter, signal });
      if (!verdict) return true;
      if ('stop' in verdict) {
        engine.notice(this.id, verdict.stop, 'warning');
        return false;
      }
      engine.setStatus(this.id, 'waiting_input');
      engine.notice(this.id, verdict.park, 'warning');
      const next = await verdict.until(signal);
      if (signal.aborted) throw new Error('aborted');
      if (next === 'stop') return false;
      engine.setStatus(this.id, 'running');
    }
    return true;
  }

  waitIdle(): Promise<void> {
    if (!this.running && this.nextIndex() < 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = this.nextIndex(); i >= 0; i = this.nextIndex()) {
        const [next] = this.queue.splice(i, 1);
        // a waiting message stays listed while its turn starts (hooks, recall), until its user message is stored
        if (next.pending) this.starting = next;
        this.current = next;
        next.turn?.start?.();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        try {
          // the turn is its session's account's work, wherever it was started from (the machine guard reads this)
          this.inferenceError = undefined;
          this.retryNotice = undefined;
          await runAs(this.session.accountId ?? OWNER_ID, async () => {
            if (!next.inference) return this.turn(next, signal);
            this.engine.setStatus(this.id, 'running');
            await this.agentLoop(this.session.model, this.session.mode, signal);
            if (this.session.status === 'running') this.engine.setStatus(this.id, 'idle');
            this.engine.afterTurn(this.id, Date.now() - this.turnStartedAt);
          });
        } catch (err) {
          if (this.controller.signal.aborted) {
            this.engine.notice(this.id, 'Stopped', 'info');
            this.engine.setStatus(this.id, 'idle');
          } else {
            log.error(`turn failed in ${this.id}`, err);
            const msg = turnErrorText(this.engine, err);
            const canRetry = err === this.inferenceError && !this.inferenceError?.code && ['agent', 'chat', 'plan'].includes(this.session.mode);
            const unsafe = err === this.inferenceError && !canRetry ? ' Alternate-model retry is unavailable for this session mode because its orchestration cannot safely resume at the failed inference.' : '';
            const notice = this.engine.notice(this.id, `Error: ${msg}${unsafe}`, 'error', undefined, canRetry ? { type: 'provider_error', canRetry: true } : undefined);
            if (canRetry) this.retryNotice = notice?.id;
            this.engine.setStatus(this.id, 'error', msg);
            this.engine.notifyEvent('errors', { title: 'Session error', body: oneLine(msg, 160), level: 'error', sessionId: this.id, link: `/s/${this.id}` });
          }
          // it failed or stopped before its message was stored: the message waits again at the front, held so a failure does not repeat on its own
          if (this.starting) {
            const q = this.starting;
            this.starting = undefined;
            this.queue.unshift(this.closed ? q : { ...q, pending: { ...q.pending!, held: true } });
            this.emitQueue();
          }
        } finally {
          this.current = undefined;
          next.turn?.end?.();
        }
        // a parked Task child a message woke: its parent still waits for the report (session/limits.ts)
        void afterWokenTurn(this.engine, this.id).catch((err) => log.warn(`${this.id}: woken subagent report failed`, err));
        // a turn that ended before it stored the message (a hook blocked it): the message leaves the list
        if (this.starting) {
          this.starting = undefined;
          this.emitQueue();
        }
        // steering that came too late for the turn (it was on its last step, or the mode takes none) runs next as its own turn
        if (this.steering.length) {
          const late = this.steering.splice(0).map((s): Queued => ({ input: { ...s.input, whenBusy: 'queue' }, pending: { ...s.pending, whenBusy: 'queue' } }));
          this.queue.unshift(...late);
          this.emitQueue();
        }
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      // notes that came in after the last tool results start their own turn
      if (this.pendingNotes.length) this.scheduleNoteTurn();
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  // -------------------------------------------------------------------------
  // One user turn
  // -------------------------------------------------------------------------

  private async turn(q: Queued, signal: AbortSignal): Promise<void> {
    const engine = this.engine;
    let session = this.session;
    // a fork of a friend's share: its first turn runs guarded, and the owner's own message after it lifts the guard
    const guarded = friendGuardTurn(engine, session, !q.auto && !q.forNotes && !q.resume && !!q.input.text.trim());
    if (guarded) session = guarded;
    // a usage-limit failover moved the session off a plan: back to the owner's first ready plan, between turns only
    const back = !q.input.model && !q.refusal ? switchBack(engine, this.id) : undefined;
    if (back) session = { ...session, model: back };
    const mode = q.input.mode ?? session.mode;
    const modelRef = q.input.model ?? session.model;
    this.turnStartedAt = Date.now();
    this.shellCwd ??= session.cwd;

    const agent = engine.agentFor(session);
    const machine = engine.machineFor(session);

    // user content: text, attachments, then reminders (hooks, memory, todos)
    const content: ContentBlock[] = [];
    if (q.input.text) content.push({ type: 'text', text: q.input.text });
    for (const a of q.input.attachments ?? []) {
      const block = await engine.attachmentBlock(session, a);
      if (block) content.push(block);
    }

    engine.setStatus(this.id, 'running');
    this.notesHeld = false;

    // SessionStart: once per runner (startup, or resume after a hub restart), and again after /clear or a compaction
    const startSource = this.pendingStart ?? (this.sessionStarted ? undefined : session.stats.messages === 0 ? 'startup' : 'resume');
    if (startSource) {
      if (!this.sessionStarted) engine.warnUntrustedProject(session);
      this.pendingStart = undefined;
      this.sessionStarted = true;
      const start = await engine.runHook(session, 'SessionStart', { source: startSource, model: session.model }, startSource);
      for (const ctx of start.additionalContext) content.push(reminder(ctx));
      for (const m of start.systemMessages) engine.notice(this.id, m, 'info');
    }

    if (!q.auto) {
      const hook = await engine.runHook(session, 'UserPromptSubmit', { prompt: q.input.text });
      if (hook.blocked) {
        engine.notice(this.id, `Prompt blocked by hook: ${hook.reason ?? 'no reason given'}`, 'warning');
        engine.setStatus(this.id, 'idle');
        return;
      }
      for (const ctx of hook.additionalContext) content.push(reminder(ctx));
      for (const m of hook.systemMessages) engine.notice(this.id, m, 'info');
    }

    const cfg = engine.config.get();
    let recalled: string[] = [];
    if (cfg.memory.enabled && cfg.memory.autoInject && agent.memory !== 'none' && engine.usesMemory(session) && q.input.text.length > 3) {
      const started = Date.now();
      try {
        // project notes follow the project across devices (projects/service.ts memoryKeys)
        // the session's account's memory only: recall never crosses accounts
        const hits = await engine.memoryFor(engine.accountOf(session)).recall(q.input.text, { project: engine.memoryProject(session), agent: agent.name, limit: cfg.memory.injectLimit });
        let chars = 0;
        if (hits.length) {
          recalled = hits.map((h) => h.id);
          let text = `Relevant memories (from earlier sessions; may be outdated):\n${hits.map((h) => `- [${h.id}] ${h.content}`).join('\n')}`;
          const budget = memoryRecallBudget(engine);
          if (text.length > budget) text = `${text.slice(0, budget)}\n[cut by Conclave: ${text.length - budget} chars over budget]`;
          chars = text.length;
          content.push(reminder(text));
        }
        // shown in Extensions > Hooks > Built in, priced like any hook that adds context
        engine.hookRunner?.record({ event: 'UserPromptSubmit', type: 'function', label: 'memory-recall', durationMs: Date.now() - started, result: hits.length ? 'context' : 'noop', ...(chars ? { contextChars: chars, stdout: `${hits.length} memories` } : {}) }, this.id);
      } catch (err) {
        log.warn('memory recall failed', err);
        engine.hookRunner?.record({ event: 'UserPromptSubmit', type: 'function', label: 'memory-recall', durationMs: Date.now() - started, result: 'error', stderr: (err as Error)?.message }, this.id);
      }
    }

    // the first message from the owner; notices before it (a repo session's worktree line) do not count
    const isFirstTurn = session.stats.messages === 0 || (session.stats.messages < 5 && !engine.repos.messages.list(this.id, { limit: 5 }).some((m) => m.role === 'user'));
    const userMeta: Record<string, unknown> = {};
    if (q.auto) userMeta.auto = true;
    if (q.resume) userMeta.resume = true;
    if (q.turn?.meta) Object.assign(userMeta, q.turn.meta);
    // it waited while the session was busy: apps swap their pending bubble for this message
    if (q.pending) {
      userMeta.pendingIds = [q.pending.id];
      userMeta.whenBusy = 'queue';
    }
    if (recalled.length) userMeta.recalled = recalled;
    // notes from background subagents that finished while the session was idle (a retry has no message to carry them)
    const retry = q.refusal;
    const notes = retry ? [] : this.takeNotes();
    if (notes.length) {
      content.push(...notes.map((n) => n.block));
      const sources = notes.map((n) => n.source).filter((x): x is string => !!x);
      if (sources.length) userMeta.subagentResults = sources;
      const results = notes.flatMap((n) => (n.result ? [n.result] : []));
      if (results.length) {
        userMeta.agentResults = results;
        // nothing the owner wrote: the apps draw the task's row, not a bubble
        if (!content.some((b) => (b.type === 'text' && !isReminder(b) && b.text.trim()) || b.type === 'image' || b.type === 'document')) userMeta.kind = 'agent-result';
      }
    }
    if (q.forNotes && !notes.length) {
      // the notes this turn was for were already shown to the model
      engine.setStatus(this.id, 'idle');
      return;
    }
    // the first request after a switch says who wrote the replies so far (modes/switch-marker.ts)
    const switched = retry ? undefined : pendingSwitch(engine.repos.sessions.get(this.id)?.meta);
    if (switched && mode !== 'jury' && mode !== 'debate') {
      if (switched.from !== modelRef) content.push(reminder(switchNote(modelLabel(engine, switched.from))));
      engine.patchMeta(this.id, { switched: undefined });
    }
    // a retry on the next model adds nothing: the turn runs again on the same stored messages
    const userMsg = retry
      ? ([...engine.repos.messages.list(this.id)].reverse().find((m) => m.role === 'user' && m.kind === 'normal') ?? { seq: 0 })
      : engine.addMessage(this.id, { role: 'user', kind: 'normal', content, meta: Object.keys(userMeta).length ? userMeta : undefined });
    if (q.pending && this.starting === q) {
      this.starting = undefined;
      this.emitQueue();
    }
    // a headless run is named here from its prompt, so it does not end before its title is written; other sessions are named after the first answer (engine.retitle)
    if (isFirstTurn && !retry) void engine.generateTitle(this.id);

    // checkpoint before anything can change files (a chat has no file tools); it runs while the
    // first model call does, and the regression gate waits for it at stop (session/regression-gate.ts)
    const parked = this.turnCheckpoint;
    if ((mode === 'agent' || mode === 'loop') && session.kind !== 'chat') {
      const fresh = startTurnCheckpoint(engine, session, machine);
      // a run resumed after a usage limit continues the parked user turn: the gate compares with the code
      // from before that turn, kept here or, after a hub restart, in session meta (session/limits.ts)
      this.turnCheckpoint = q.resume ? (parked ?? restoreTurnCheckpoint(engine, session) ?? fresh) : fresh;
      if (!q.resume && session.meta?.turnBase) engine.patchMeta(this.id, { turnBase: undefined });
    } else this.turnCheckpoint = undefined;

    // one turns row per user turn: when, which model and account, how many tool calls, how it ended
    const turnId = this.depth ? undefined : startTurn(engine, this.id, modelRef, this.turnStartedAt);
    this.turnId = turnId;
    let outcome = 'error';
    let turnError: unknown;
    try {
      session = this.session;
      if (mode === 'jury') {
        await runJury(engine, this, session, signal);
        outcome = 'done';
      } else if (mode === 'debate') {
        await runDebate(engine, this, session, signal);
        outcome = 'done';
      } else {
        // a new task gets the loop's whole iteration budget; its own follow-ups are auto turns
        if (mode === 'loop' && !q.auto && session.meta?.loop) engine.patchMeta(this.id, { loop: undefined });
        const done = await this.agentLoop(modelRef, mode, signal, retry ? { refusal: retry } : undefined);
        outcome = this.lastStop === 'harness' ? (done ? 'done' : 'error') : (this.lastStop ?? (done ? 'done' : 'stopped'));
        if (done && mode === 'loop') {
          const next = await loopCheck(engine, this.session, signal);
          if (next) this.queue.unshift({ input: { text: next }, auto: true });
        }
      }
    } catch (err) {
      outcome = signal.aborted ? 'aborted' : 'error';
      if (!signal.aborted) turnError = err;
      throw err;
    } finally {
      const tools = turnId ? endTurn(engine, turnId, this.id, userMsg.seq, this.turnStartedAt, outcome) : undefined;
      this.turnId = undefined;
      logTurnLine(engine, {
        sessionId: this.id,
        agent: agent.name,
        model: modelRef,
        mode,
        kind: session.kind,
        device: session.device,
        startedAt: this.turnStartedAt,
        stop: outcome,
        tools,
        unattended: isUnattended(session, mode, this.depth),
        ...(turnError !== undefined ? { error: turnErrorText(engine, turnError) } : {}),
      });
    }

    session = this.session;
    if (session.status === 'running' || session.status === 'waiting_approval' || session.status === 'waiting_input') {
      engine.setStatus(this.id, 'idle');
    }

    engine.afterTurn(this.id, Date.now() - this.turnStartedAt);
  }

  // -------------------------------------------------------------------------
  // The agent loop
  // -------------------------------------------------------------------------

  /** Returns true when the model finished normally. */
  async agentLoop(modelRef: string, mode: SessionMode, signal: AbortSignal, opts: LoopOptions = {}): Promise<boolean> {
    // a subagent's loop runs on its caller's signal; this one lets Stop on the subagent's own session end it too
    const loop = new AbortController();
    const onAbort = () => loop.abort();
    if (signal.aborted) loop.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
    this.activeLoops.add(loop);
    this.loops++;
    this.lastStop = undefined;
    try {
      return await runAs(this.session.accountId ?? OWNER_ID, () => this.runLoop(modelRef, mode, loop.signal, opts));
    } finally {
      this.activeLoops.delete(loop);
      signal.removeEventListener('abort', onAbort);
      if (!this.busy && this.pendingNotes.length) this.scheduleNoteTurn();
    }
  }

  private async runLoop(modelRef: string, mode: SessionMode, signal: AbortSignal, opts: LoopOptions = {}): Promise<boolean> {
    const engine = this.engine;
    const end = (stop: LoopStop, done: boolean): boolean => {
      this.lastStop = stop;
      return done;
    };
    let currentModel = modelRef;
    let resolved = engine.registryFor(this.session).resolve(currentModel);
    if (!this.depth) {
      // a harness that is off (imported chats keep claude-code/default): the turn goes on with the account's default model instead of stopping
      const to = (isMember(this.session.accountId) ? engine.accountPrefs(this.session.accountId!).defaultModel : undefined) ?? engine.config.get().defaultModel;
      if (resolved.acp && engine.harnessOff(currentModel) && !engine.harnessOff(to)) {
        engine.notice(this.id, `${engine.displayModel(currentModel)} is off as an engine, so this session goes on with ${engine.displayModel(to)}.`, 'info');
        if (this.session.model === currentModel) engine.updateSession(this.id, { model: to });
        currentModel = to;
        resolved = engine.registryFor(this.session).resolve(to);
      }
      // an imported chat can name another device's folder: map it on this device or ask (a harness turn checks in runHarnessTurn)
      if (!resolved.acp && this.session.tags.includes('imported') && !(await deviceFolder(engine, this.session, engine.machineFor(this.session)))) return end('hook', false);
    }

    // Refusal fallback (session/refusal-fallback.ts): after a refusal the provider signals, the same request runs on the
    // owner's next listed model and account. On its own when the owner turned it on; from "Try the next model" either way.
    // the list names the owner's accounts: a member's session has none to walk
    const plan = isMember(this.session.accountId) ? undefined : refusalPlan(engine.config.get(), engine.agentFor(this.session));
    // "Try the next model" on a reply a marked plan or a list entry refused starts after that step
    const walk = plan && (plan.auto || opts.refusal) ? new RefusalWalk(engine, this.session, plan, refusalStepOf(opts.refusal?.reply)) : undefined;
    /** The notice of the step running now ("X declined. Trying Y."): it becomes "X declined. Answered by Y." */
    let stepNotice: { id: string; from?: string; meta: Record<string, unknown> } | undefined;
    /** The last refused reply, dropped while the next entry runs: it stands again when no entry can answer. */
    let lastRefusal: Message | undefined = opts.refusal?.reply;
    /** An entry was started and has not answered yet: a failure moves on to the next one. */
    let walkPending = false;
    const moveTo = (t: FallbackTarget) => {
      const reg = engine.registryFor(this.session);
      currentModel = t.ref;
      resolved = t.pin ? reg.resolveAt(t.pin.provider, t.pin.model) : reg.resolve(t.ref);
    };
    const step = (from: string | undefined, t: FallbackTarget) => {
      const meta = { type: 'refusal', outcome: 'trying', ...(from ? { from } : {}), to: t.label, model: t.ref, ...(t.pin?.account ? { account: t.pin.account } : {}), ...(t.loose ? { loose: true } : {}) };
      const n = engine.notice(this.id, from ? refusalWords.trying(from, t.label) : `Trying ${t.label}.`, 'warning', undefined, meta);
      stepNotice = n ? { id: n.id, from, meta } : undefined;
      walkPending = true;
      moveTo(t);
    };
    /** The entry running now answered: its notice says so, and with "stay" the session keeps it. */
    const answered = () => {
      walkPending = false;
      if (!walk?.current || !stepNotice) return;
      const t = walk.current;
      const stay = walk.plan.stay && this.depth === 0;
      const text = stepNotice.from ? refusalWords.answered(stepNotice.from, t.label, stay) : `Answered by ${t.label}.${stay ? ` This chat now uses ${t.label}.` : ''}`;
      try {
        engine.updateMessage(stepNotice.id, { content: [{ type: 'text', text }], meta: { ...stepNotice.meta, outcome: 'answered', level: 'info' } });
      } catch {
        /* the notice went (a rewind): the answer stands anyway */
      }
      stepNotice = undefined;
      if (stay) engine.updateSession(this.id, { model: t.ref });
    };
    /** Whether "Try the next model" has an entry to go to after `served` refused (for the notice's button). */
    const canTryNext = (served: Served) => !!plan && !!new RefusalWalk(engine, this.session, plan, stepOfTarget(walk?.current)).next(served);
    /** The words of what refused: the entry's own label while one runs, else the model and account that answered. */
    const refusedLabel = (served: Served) => walk?.current?.label ?? servedLabel(engine, served);
    /** No entry left after a failed one: the last refusal stands again, with its calls answered "Not run". */
    const restoreRefusal = () => {
      const r = lastRefusal;
      if (!r) return;
      lastRefusal = undefined;
      engine.addMessage(this.id, { role: 'assistant', kind: 'normal', content: r.content, model: r.model, agent: r.agent, usage: r.usage, stopReason: 'refusal', ...(r.meta ? { meta: r.meta } : {}) });
      const uses = r.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (uses.length) engine.addMessage(this.id, { role: 'user', kind: 'normal', content: uses.map((u) => ({ type: 'tool_result', toolUseId: u.id, content: NOT_RUN_REFUSAL, isError: true, meta: { notRun: 'refusal' } })) });
    };

    // "Try the next model": the refused reply is gone already; start on the entry after it
    if (opts.refusal && walk) {
      walk.refused.push(opts.refusal.served);
      const t = walk.next(opts.refusal.served);
      if (!t) {
        engine.notice(this.id, 'No model is left in Refusal fallback.', 'warning', undefined, { type: 'refusal', outcome: 'exhausted' });
        return end('refusal', false);
      }
      step(servedLabel(engine, opts.refusal.served), t);
    }

    // runner extensions (runner-ext.ts) may park the turn, for example while the session's device is offline
    if (!(await this.stepGate(mode, 0, signal))) return end('hook', false);
    if (resolved.acp) {
      // a harness turn: its refusal counts when the ACP agent says so (stopReason refusal), and then the turn moves to
      // the next entry in the hub's own loop, like a switch from the harness
      let stop = '';
      let replyId = '';
      const ok = await runHarnessTurn(engine, this, this.session, resolved.provider, resolved.model, signal, { quietRefusal: !!plan, onStop: (r, id) => ((stop = r), (replyId = id)) });
      if (stop !== 'refusal' || !plan) return end('harness', ok);
      const served: Served = { provider: resolved.provider, model: resolved.model };
      const from = refusedLabel(served);
      const t = walk?.onRefusal(served);
      if (!t) {
        // the switch is off (the button walks the list) or no entry can take it
        engine.notice(this.id, `${from} declined to continue.`, 'warning', undefined, { type: 'refusal', canTryNext: !walk && canTryNext(served) });
        return end('harness', false);
      }
      // a refused reply that ran tools stays (those changes happened, the next model reads them); one that only spoke goes
      const reply = engine.repos.messages.get(replyId);
      if (reply && !reply.content.some((b) => b.type === 'tool_use')) engine.removeMessage(replyId);
      step(from, t);
    }

    // MCP tools join the tool set from the engine's cache; list them first if it is cold
    await engine.prefetchMcpTools();

    /** Compactions this turn. After each, the next estimate must be smaller, or no more run this turn. */
    let compactions = 0;
    let estimateBeforeCompaction: number | undefined;
    let compactionHelped = true;
    /** Replies in a row that hit the output token limit. */
    let lengthStops = 0;
    let emptyRetries = 0;
    /** One repair and retry per turn when the API rejects the transcript shape. */
    let shapeRetry: 'unused' | 'next' | 'used' = 'unused';
    /** Models that hit a limit this turn: a limit fallback never goes back to one. */
    const limited: string[] = [];
    const maxSteps = this.stepBudget();
    let budgetNoted = false;
    // one loop guard per user turn; interactive turns get one strong warning before a halt ends them
    const guard = new LoopGuard({ unattended: isUnattended(this.session, mode, this.depth) });
    const guardWarned = new Set<string>();
    let guardHalts = 0;
    this.stopHookActive = false;
    // a broken Stop hook could keep a turn going forever; after STOP_BLOCK_CAP blocks the next one is ignored
    let stopBlocks = 0;
    /** The note about background tasks that still run went out this turn. */
    let tasksNoted = false;
    for (let iter = 0; iter < maxSteps; iter++) {
      if (signal.aborted) throw new Error('aborted');
      if (iter > 0 && !(await this.stepGate(mode, iter, signal))) return end('hook', false);
      let session = this.session;
      const agent = engine.agentFor(session);
      const tools = engine.toolsFor(session, agent, mode, this.depth);
      const toolMap = new Map(tools.map((t) => [t.name, t]));
      const toolSpecs = this.specsFor(tools, session);

      // after tool calls, what the person queued joins this turn as steering (as Claude Code does); a harness turn never gets here
      if (iter > 0) this.queuedToSteering();
      // steering messages typed while the model works join the transcript now, one message each (the request merges them)
      if (this.steering.length) {
        // read the attachments first: until each is stored it stays listed, so apps never lose it
        const steer = [...this.steering];
        const built: Array<{ s: Steer; content: ContentBlock[] }> = [];
        for (const s of steer) {
          const content: ContentBlock[] = s.input.text ? [{ type: 'text', text: s.input.text }] : [];
          for (const a of s.input.attachments ?? []) {
            const block = await engine.attachmentBlock(session, a);
            if (block) content.push(block);
          }
          content.push(reminder(STEER_NOTE));
          built.push({ s, content });
        }
        if (signal.aborted) throw new Error('aborted');
        // one removed meanwhile stays out; what came in meanwhile joins the next step
        const still = built.filter((b) => this.steering.includes(b.s));
        this.steering = this.steering.filter((x) => !steer.includes(x));
        for (const { s, content } of still) engine.addMessage(this.id, { role: 'user', kind: 'normal', content, meta: { whenBusy: 'steer', pendingIds: [s.pending.id] } });
        this.emitQueue();
      }

      const system = await this.systemFor(session, agent, currentModel, mode, tools.map((t) => t.name));
      const cfg = engine.config.get();
      // old tool output is cleared in one batch and the marks are stored, so later requests send the same bytes
      if (cfg.context.clearToolResultsAfterTurns !== 0 && cfg.context.clearBatchTokens !== 0) {
        // the stored messages got shorter, so the last usage overstates them
        if (applyClearing(engine, this.id, { protectTokens: cfg.context.clearProtectTokens, batchTokens: cfg.context.clearBatchTokens })) this.meter = undefined;
      }
      // a model without vision reads images as text another model wrote (session/image-text.ts)
      const imageText = !seesImages(resolved.model, resolved.info, cfg.providers[resolved.provider]);
      if (imageText) await transcribeImages(engine, this.id, engine.sessionAccount(this.id), signal);
      const stored = engine.repos.messages.list(this.id);
      let messages: ProviderMessage[] = buildProviderMessages(stored, {
        modelRef: currentModel,
        toolNames: new Set(tools.map((t) => t.name)),
        cache: cfg.context.promptCaching,
        imageText,
      });
      // the retry after a shape 400: the last calls go as text
      if (shapeRetry === 'next') {
        shapeRetry = 'used';
        messages = flattenLastToolTurn(messages);
      }

      const info = resolved.info;
      // the last real usage plus what was stored since; chars/4 alone undercounts schemas, code and CJK text.
      // The larger of the two counts, so a provider that reports no usage never delays a compaction.
      const hashes = { model: currentModel, systemHash: partHash(system), toolsHash: partHash(toolSpecs) };
      const estimate = Math.max(estimateRequestTokens(system, messages, toolSpecs), meteredTokens(this.meter, hashes, stored) ?? 0);
      if (estimateBeforeCompaction !== undefined) {
        if (estimate >= estimateBeforeCompaction) compactionHelped = false;
        estimateBeforeCompaction = undefined;
      }
      const mayCompact = compactions < MAX_COMPACTIONS_PER_TURN && compactionHelped;
      if (mayCompact && estimate > info.contextWindow * cfg.context.compactAt) {
        const did = await maybeCompact(engine, this.id, currentModel, signal, 'auto');
        if (did) {
          compactions++;
          estimateBeforeCompaction = estimate;
          this.markSessionStart('compact');
          guard.armAfterCompaction();
          continue;
        }
      }

      const assistant = engine.addMessage(this.id, { role: 'assistant', kind: 'normal', content: [], model: currentModel, agent: agent.name });
      let result;
      try {
        result = await streamCompletion(
          engine,
          currentModel,
          {
            system,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
            thinking: engine.thinkingFor(agent, info, session),
            // a refusal retry on a Daybreak plan carries its own program; the session's Cyber access stays as it is
            accessPrograms: walk?.current?.accessPrograms ?? engine.accessProgramsFor(info, session),
            temperature: agent.temperature,
            cacheKey: cfg.context.promptCaching ? `conclave-${this.id}` : undefined,
            cacheTtl: cfg.context.promptCaching ? cacheTtlFor(cfg.cache?.ttl, isHeadless(session, mode, this.depth)) : undefined,
            signal,
            userId: 'conclave',
          },
          { sessionId: this.id, messageId: assistant.id, purpose: this.depth ? 'subagent' : 'turn', ...(walk?.current?.pin ? { pin: walk.current.pin } : {}) },
        );
      } catch (err) {
        engine.removeMessage(assistant.id);
        if (err instanceof ProviderError) {
          if (err.kind === 'aborted') throw err;
          // the API rejected the transcript shape despite the guard: one repair and retry per turn
          if (shapeRetry === 'unused' && isTranscriptShapeError(err)) {
            shapeRetry = 'next';
            log.warn(`transcript shape rejected in ${this.id}; retrying with the last calls as text: ${err.message}`);
            continue;
          }
          if (err.kind === 'context_length' && mayCompact) {
            if (await maybeCompact(engine, this.id, currentModel, signal, 'auto')) {
              compactions++;
              estimateBeforeCompaction = estimate;
              this.markSessionStart('compact');
              guard.armAfterCompaction();
              continue;
            }
          }
        }
        // a refusal fallback entry that cannot answer (a limit, a refused sign in, an error): say so, then the next entry
        if (walk?.current && walkPending && !signal.aborted) {
          const failed = walk.current;
          const why = oneLine((err as Error)?.message ?? String(err), 160);
          log.warn(`${this.id}: refusal fallback entry ${failed.ref} failed: ${why}`);
          if (stepNotice) {
            try {
              engine.updateMessage(stepNotice.id, { meta: { ...stepNotice.meta, outcome: 'failed' } });
            } catch {
              /* gone: nothing to mark */
            }
            stepNotice = undefined;
          }
          engine.notice(this.id, refusalWords.failed(failed.label, why), 'warning', undefined, { type: 'refusal', outcome: 'failed', to: failed.label });
          // an entry at its limit: the same model on the owner's next ready plan first, then the next entry
          const other = err instanceof ProviderError && (err.kind === 'rate_limit' || err.kind === 'quota') && failed.pin && !failed.accessPrograms ? nextAccount(engine, this.id, failed.ref) : undefined;
          if (other) {
            const gw = failed.pin!.provider;
            const t: FallbackTarget = { ...failed, ref: other.ref, label: other.to, pin: { provider: gw, model: other.ref.slice(gw.length + 1), account: other.account } };
            walk.current = t;
            step(undefined, t);
            continue;
          }
          const t = walk.next({ provider: resolved.provider, model: resolved.model, ...(failed.pin?.account ? { account: failed.pin.account } : {}), ...(failed.accessPrograms ? { cyber: failed.accessPrograms.cyber } : {}) });
          if (t) {
            step(undefined, t);
            continue;
          }
          restoreRefusal();
          engine.notice(this.id, 'No model is left in Refusal fallback.', 'warning', undefined, { type: 'refusal', outcome: 'exhausted' });
          return end('refusal', false);
        }
        if (err instanceof ProviderError) {
          if (err.kind === 'rate_limit' || err.kind === 'quota') {
            limited.push(currentModel);
            const outcome = await handleLimit(engine, this, currentModel, err, limited);
            if (outcome.fallback) {
              currentModel = outcome.fallback;
              resolved = engine.registryFor(this.session).resolve(currentModel);
              if (resolved.acp) return end('harness', await runHarnessTurn(engine, this, this.session, resolved.provider, resolved.model, signal));
              continue;
            }
            return end('rate_limit', false);
          }
        }
        if (err instanceof ProviderError && err.kind !== 'auth' && err.kind !== 'aborted' && !err.code && mode === this.session.mode) this.inferenceError = err;
        throw err;
      }

      const declined = result.stopReason === 'refusal';
      const finalMsg = engine.updateMessage(assistant.id, {
        content: result.content,
        usage: result.usage,
        stopReason: result.stopReason,
        // which provider, model and account refused, and at which step of a walk: "Try the next model" starts after it
        ...(declined && (result.served || walk?.current) ? { meta: { ...assistant.meta, ...(result.served ? { served: result.served } : {}), ...(walk?.current ? { refusalStep: stepOfTarget(walk.current) } : {}) } } : {}),
        // whose account signed its thinking: a later call on another vendor's account drops it (session/transcript.ts)
        ...(!declined && result.served?.vendor && result.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking') ? { meta: { ...assistant.meta, signedBy: result.served.vendor } } : {}),
      });
      engine.addStats(this.id, result.usage);
      const u = result.usage;
      this.meter = { ...hashes, baseTokens: (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0) + (u?.outputTokens ?? 0), throughSeq: assistant.seq };

      // refusal fallback: the refused reply is dropped and the same request runs on the next entry
      const served: Served = result.served ?? { provider: resolved.provider, model: resolved.model };
      let refusalNote: string | undefined;
      if (declined && walk) {
        const from = refusedLabel(served);
        if (stepNotice) {
          // the entry that was tried declined too: its notice keeps "Trying", the next step says the rest
          try {
            engine.updateMessage(stepNotice.id, { meta: { ...stepNotice.meta, outcome: 'declined' } });
          } catch {
            /* gone */
          }
          stepNotice = undefined;
        }
        const t = walk.onRefusal(served);
        if (t) {
          lastRefusal = finalMsg;
          engine.removeMessage(assistant.id);
          // the meter counted a reply the next request no longer carries
          this.meter = undefined;
          lengthStops = 0;
          step(from, t);
          continue;
        }
        // nothing left: the last refusal stands, with one notice that says so
        if (walk.refused.length > 1) refusalNote = refusalWords.exhausted(from);
      } else if (!declined) answered();
      lastRefusal = declined ? lastRefusal : undefined;
      const refusalMeta = () => ({ type: 'refusal', ...(refusalNote ? { outcome: 'exhausted' } : {}), canTryNext: !refusalNote && canTryNext(served) });

      const toolUses = result.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (result.stopReason === 'max_tokens') lengthStops++;
      else lengthStops = 0;

      // calls from a reply cut by the output limit or ended by a refusal never run: their input may be partial
      if (toolUses.length && (result.stopReason === 'max_tokens' || result.stopReason === 'refusal')) {
        const why = result.stopReason;
        const text = why === 'max_tokens' ? NOT_RUN_MAX_TOKENS : NOT_RUN_REFUSAL;
        const notRun: ToolResultBlock[] = toolUses.map((u) => ({ type: 'tool_result', toolUseId: u.id, content: text, isError: true, meta: { notRun: why } }));
        for (const r of notRun) engine.bus.emit({ type: 'tool.completed', sessionId: this.id, toolUseId: r.toolUseId, result: r });
        engine.addMessage(this.id, { role: 'user', kind: 'normal', content: notRun });
        if (why === 'refusal') {
          engine.notice(this.id, refusalNote ?? refusalWords.refusedCalls, 'warning', undefined, refusalMeta());
          return end('refusal', false);
        }
        if (lengthStops > MAX_LENGTH_CONTINUES) {
          engine.notice(this.id, `The reply hit the output token limit ${lengthStops} times in a row. Stopped.`, 'warning');
          return end('output_limit', false);
        }
        engine.notice(this.id, 'The reply hit the output token limit before its tool calls were complete. They were not run; the model was asked to resend them in smaller parts.', 'warning');
        continue;
      }

      // an empty reply (no text, no calls) is retried once per turn with a note to continue, then reported
      if (!toolUses.length && (result.stopReason === 'end_turn' || result.stopReason === 'stop_sequence') && isEmptyReply(result.content)) {
        engine.removeMessage(assistant.id);
        if (emptyRetries < MAX_EMPTY_RETRIES) {
          emptyRetries++;
          log.debug(`empty reply in ${this.id}; retrying`);
          engine.addMessage(this.id, { role: 'user', kind: 'normal', content: [reminder(CONTINUE_AFTER_EMPTY_REPLY)], meta: { auto: true } });
          continue;
        }
        engine.notice(this.id, 'The model returned an empty reply.', 'warning');
        return end('empty_reply', false);
      }

      if (!toolUses.length) {
        if (result.stopReason === 'max_tokens') {
          // unattended runs get a continuation note (nobody is there to say "go on"); interactive ones stop with a notice
          if (isUnattended(this.session, mode, this.depth) && lengthStops <= MAX_LENGTH_CONTINUES) {
            engine.addMessage(this.id, { role: 'user', kind: 'normal', content: [reminder(CONTINUE_AFTER_OUTPUT_LIMIT)], meta: { auto: true } });
            continue;
          }
          engine.notice(this.id, 'The reply hit the output token limit.', 'warning');
        }
        if (result.stopReason === 'refusal') {
          engine.notice(this.id, refusalNote ?? refusalWords.refused, 'warning', undefined, refusalMeta());
          return end('refusal', false);
        }
        if (result.stopReason === 'pause_turn') continue;
        const stopKind: LoopStop = result.stopReason === 'max_tokens' ? 'output_limit' : 'done';
        // Subagents end with SubagentStop, fired by the caller (engine/subagent.ts).
        // a run nobody wakes later (a subagent, a routine) hears once which of its background tasks still run (item 21)
        if (!tasksNoted && this.session.meta?.backgroundTasks && isUnattended(this.session, mode, this.depth)) {
          const running = engine.backgroundTasks.list(this.id).filter((t) => t.state === 'running');
          if (running.length) {
            tasksNoted = true;
            const list = running.map((t) => `${t.id} (${t.agent}: ${t.description})`).join(', ');
            const why = this.depth > 0 ? 'Their reports do not reach your caller after you finish.' : 'This run ends with your reply.';
            engine.addMessage(this.id, { role: 'user', kind: 'normal', content: [reminder(`Background tasks still running: ${list}. ${why} Wait for them with TaskWait if you need their results, or finish now.`)], meta: { auto: true } });
            continue;
          }
        }
        if (this.depth > 0) return end(stopKind, true);
        // Stop hook can keep the model going. stop_hook_active turns true only after a Stop hook blocked.
        session = this.session;
        const lastText = result.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('');
        const stop = await engine.runHook(session, 'Stop', { stop_hook_active: this.stopHookActive, last_assistant_message: lastText });
        if (stop.blocked && stop.reason) {
          if (stopBlocks >= STOP_BLOCK_CAP) {
            engine.notice(this.id, `A Stop hook asked to keep going ${STOP_BLOCK_CAP} times in this turn, so Conclave ended the turn. Check the hook in Extensions > Hooks. Its last reason: ${oneLine(stop.reason, 160)}`, 'warning');
            return true;
          }
          stopBlocks++;
          this.stopHookActive = true;
          engine.addMessage(this.id, { role: 'user', kind: 'normal', content: [reminder(`Stop hook feedback:\n${stop.reason}`)], meta: { auto: true } });
          continue;
        }
        // runner extensions (a verify gate) may keep the model going, under the same cap as Stop hooks
        if (stopBlocks < STOP_BLOCK_CAP) {
          const more = await engine.runnerExtensions.onStop({ sessionId: this.id, session, mode, depth: this.depth, iter, signal, lastText });
          if (more.length) {
            stopBlocks++;
            engine.addMessage(this.id, { role: 'user', kind: 'normal', content: more.map((t) => reminder(t)), meta: { auto: true } });
            continue;
          }
        }
        return end(stopKind, true);
      }

      // execute tool calls: consecutive concurrency-safe calls run together
      const results: ToolResultBlock[] = [];
      let batch: ToolUseBlock[] = [];
      this.stepResults.clear();
      const run = (u: ToolUseBlock) =>
        this.executeTool(u, toolMap, assistant.id, signal)
          .catch((err) => {
            if (signal.aborted) throw err;
            // a failure outside the tool itself still answers the call
            log.warn(`tool ${u.name} failed in ${this.id}`, err);
            return this.errorResult(u, `Tool error: ${(err as Error)?.message ?? String(err)}`);
          })
          .then((r) => (this.stepResults.set(r.toolUseId, r), r));
      const flush = async () => {
        if (!batch.length) return;
        const out = await Promise.all(batch.map(run));
        results.push(...out);
        batch = [];
      };
      // keep result order matching tool_use order
      const order = new Map(toolUses.map((u, i) => [u.id, i]));
      const inOrder = (rs: ToolResultBlock[]) => rs.sort((a, b) => (order.get(a.toolUseId) ?? 0) - (order.get(b.toolUseId) ?? 0));
      let stopRequested: string | undefined;
      const refused: Array<{ verdict: Verdict; use: ToolUseBlock }> = [];
      try {
        for (const use of toolUses) {
          // after a stop, the calls left get "Interrupted" results in the catch below
          if (signal.aborted) throw new Error('aborted');
          // a call the loop guard already stopped this turn does not run again
          const pre = guard.before(use.name, use.input);
          if (pre.level === 'halt') {
            const r: ToolResultBlock = { type: 'tool_result', toolUseId: use.id, content: pre.message ?? 'Not run: stopped by the loop guard.', isError: true, meta: { loopGuard: 'refused' } };
            engine.bus.emit({ type: 'tool.completed', sessionId: this.id, toolUseId: use.id, result: r });
            results.push(r);
            refused.push({ verdict: pre, use });
            continue;
          }
          const tool = resolveTool(toolMap, use.name);
          const safe = tool && (toolIsReadOnly(tool, use.input) || CONCURRENT_TOOLS.has(tool.name));
          if (safe) {
            batch.push(use);
            continue;
          }
          await flush();
          const r = await run(use);
          results.push(r);
          if (r.meta?.stopTurn) stopRequested = String(r.meta.stopTurn);
        }
        await flush();
      } catch (err) {
        // stopped in the middle of the calls: each call still gets a result, so the next request pairs up
        const done = new Set(results.map((r) => r.toolUseId));
        const missing = toolUses.filter((u) => !done.has(u.id)).map((u) => this.errorResult(u, INTERRUPTED, { interrupted: true }));
        engine.addMessage(this.id, { role: 'user', kind: 'normal', content: inOrder([...results, ...missing]) });
        throw err;
      }
      inOrder(results);

      const extra: ContentBlock[] = [];
      if (this.todos.length && iter > 0 && iter % 6 === 0 && !toolUses.some((u) => u.name === 'TodoWrite')) {
        extra.push(reminder(`Current todo list:\n${this.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}\nKeep it up to date with TodoWrite.`));
      }
      // one note on the newest results (never an older row, so the cached prefix holds) once most of the budget is used
      const used = iter + 1;
      if (!budgetNoted && used < maxSteps && used >= Math.max(1, Math.floor(maxSteps * STEP_NOTE_AT))) {
        budgetNoted = true;
        extra.push(reminder(stepBudgetNote(used, maxSteps)));
      }
      // loop guard: every call and its result in tool_use order; warnings ride after the results, each kind once per turn
      const byId = new Map(toolUses.map((u) => [u.id, u]));
      let halt: { verdict: Verdict; use: ToolUseBlock } | undefined;
      const warnings: string[] = [];
      for (const r of results) {
        const use = byId.get(r.toolUseId);
        if (!use || r.meta?.loopGuard === 'refused') continue;
        const v = guard.after(use.name, use.input, r);
        if (v.level !== 'ok') log.info(`loop guard ${v.level} ${v.code} in ${this.id}: ${use.name}`);
        if (v.level === 'halt' && !halt) halt = { verdict: v, use };
        else if (v.level === 'warn' && v.code && !guardWarned.has(v.code)) {
          guardWarned.add(v.code);
          warnings.push(v.message ?? 'You are repeating yourself.');
        }
      }
      // calling a stopped call again counts as the guard tripping again
      if (!halt && refused.length) halt = refused[0];
      let guardStop: string | undefined;
      if (halt) {
        guardHalts++;
        guard.stop(halt.use.name, halt.use.input);
        const why = halt.verdict.message ?? 'The same calls keep repeating.';
        if (guard.unattended || guardHalts > 1) {
          // the reason reaches the model once, in loopStopReminder before the final-answer call
          guardStop = why;
        } else {
          // interactive: one strong warning first
          extra.push(reminder(`Loop guard: ${why} This is the last warning in this turn: if the loop guard trips again, the turn ends. Change your approach now, or stop and tell the user what is blocking you.`));
        }
      }
      if (warnings.length) extra.push(reminder(`Loop guard:\n${warnings.map((w) => `- ${w}`).join('\n')}`));

      // results of background subagents that finished during this step
      const notes = this.takeNotes();
      extra.push(...notes.map((n) => n.block));
      const noteSources = notes.map((n) => n.source).filter((x): x is string => !!x);
      const resultMeta: Record<string, unknown> = {};
      if (noteSources.length) resultMeta.subagentResults = noteSources;
      const noteResults = notes.flatMap((n) => (n.result ? [n.result] : []));
      if (noteResults.length) resultMeta.agentResults = noteResults;
      if (halt) resultMeta.loopGuard = { code: halt.verdict.code, stopped: !!guardStop };
      engine.addMessage(this.id, { role: 'user', kind: 'normal', content: [...results, ...extra], meta: Object.keys(resultMeta).length ? resultMeta : undefined });

      if (signal.aborted) throw new Error('aborted');
      if (guardStop) {
        engine.audit(this.id, 'loop_guard', `${halt?.verdict.code}: ${oneLine(guardStop, 200)}`);
        engine.notice(this.id, `Loop guard stopped the turn: ${guardStop}`, 'warning');
        // no more tools, but one toolless call so the turn (and a subagent's result) ends with a report
        await this.finalAnswerTurn(currentModel, mode, signal, loopStopReminder(guardStop), { loopGuard: halt?.verdict.code ?? 'stopped' });
        return end('loop_capped', false);
      }
      if (stopRequested) {
        engine.notice(this.id, stopRequested, 'info');
        return end('hook', true);
      }
      if (this.session.status === 'waiting_reset') return end('rate_limit', false);
    }
    // at the cap: one more call that may not use tools, so the model reports instead of stopping mid-task
    await this.finalAnswerTurn(currentModel, mode, signal, stepLimitReminder(maxSteps), { stepLimit: maxSteps });
    engine.notice(this.id, `Stopped after ${maxSteps} steps.`, 'warning');
    return end('step_limit', false);
  }

  /** Model calls this runner may make in one user turn: the agent's maxSteps, else the config for parents or subagents. */
  stepBudget(): number {
    const lim = this.engine.config.get().limits;
    const agent = this.engine.agentFor(this.session);
    const n = agent.maxSteps ?? (this.depth > 0 ? (lim.subagentMaxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS) : (lim.maxSteps ?? DEFAULT_MAX_STEPS));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_STEPS;
  }

  /**
   * The system prompt for a step. It is built once and then sent byte for
   * byte, so the cached prefix holds (HARNESS-REVIEW item 12). It is built
   * again after a compaction or /clear; when what it is built from changes
   * (agent, model, mode, folder, device, the Skill tool, Ultra); when a
   * memory it shows was removed or edited; and when the instruction files,
   * skills or the platform card's live state (tools, MCP servers, devices,
   * browser, accounts), read again once per user turn, say something else. New memories
   * wait for the next rebuild, so extraction after a turn does not break it.
   */
  private async systemFor(session: Session, agent: AgentDef, modelRef: string, mode: SessionMode, toolNames: string[]): Promise<SystemBlock[]> {
    const engine = this.engine;
    const key = JSON.stringify([agent.name, agent.prompt, modelRef, mode, session.cwd, session.device, session.kind ?? '', !!session.ultra, !!session.meta?.workflow, toolNames.includes('Skill')]);
    const snap = this.prompt;
    let fresh: PromptParts | undefined;
    if (snap && !this.promptStale && snap.key === key && profileHolds(snap.parts.profile, engine.profileFor(session, agent))) {
      if (snap.loop === this.loops) return snap.blocks;
      fresh = await engine.systemPromptParts(session, agent, modelRef, mode, toolNames, this.depth);
      if (partsSignature(fresh) === partsSignature(snap.parts)) {
        snap.loop = this.loops;
        return snap.blocks;
      }
    }
    const parts = fresh ?? (await engine.systemPromptParts(session, agent, modelRef, mode, toolNames, this.depth));
    this.prompt = { key, parts, blocks: buildSystemPrompt(parts), loop: this.loops };
    this.promptStale = false;
    return this.prompt.blocks;
  }

  /**
   * The newest read mark for a path: what the newest Read, Edit or Write
   * result in the active messages recorded, or a newer one from this turn.
   * Loaded from the messages on first use, so it holds after a hub restart.
   */
  readMark(path: string): ReadMark | undefined {
    if (!this.marks) {
      this.marks = new Map();
      for (const m of activeMessages(this.engine.repos.messages.list(this.id))) {
        if (m.seq <= this.marksAfterSeq) continue;
        for (const b of m.content) {
          const mark = b.type === 'tool_result' && !b.isError ? (b.meta?.readMark as ReadMark | undefined) : undefined;
          if (mark && typeof mark.path === 'string' && typeof mark.mtimeMs === 'number') this.marks.set(mark.path, mark);
        }
      }
    }
    return this.marks.get(path);
  }

  /**
   * The note a file tool's result gets for instruction files that apply to
   * that file and were not shown yet in this session: AGENTS.md and
   * CLAUDE.md below the session folder, and `.claude/rules` whose paths:
   * match. Each file is cut to SCOPED_FILE_CHARS.
   */
  private async scopedNote(session: Session, machine: Machine, path: unknown): Promise<string | undefined> {
    if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
    const cfg = this.engine.config.get();
    if (!this.pathRules || this.pathRules.loop !== this.loops || this.pathRules.cwd !== session.cwd) {
      this.pathRules = { loop: this.loops, cwd: session.cwd, rules: await loadPathRules(machine, session.cwd, cfg).catch(() => []), dirs: new Map() };
    }
    const files = await loadScopedInstructions(machine, session.cwd, path, cfg, this.pathRules.rules, this.pathRules.dirs);
    const stored = this.engine.repos.sessions.get(this.id)?.meta?.scopedInstructions;
    this.scopedShown ??= new Set(Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []);
    const fresh = files.filter((f) => !this.scopedShown!.has(f.path));
    if (!fresh.length) return undefined;
    for (const f of fresh) this.scopedShown.add(f.path);
    this.engine.patchMeta(this.id, { scopedInstructions: [...this.scopedShown] });
    const body = fresh.map((f) => `Contents of ${f.path}:\n\n${truncateMiddle(f.content.trim(), SCOPED_FILE_CHARS, 'omitted').text}`).join('\n\n---\n\n');
    return reminder(`These instructions come from the user and apply to files in this part of the project. Follow them for this file and the files near it.\n\n${body}`).text;
  }

  /** Delegate's device list, read once per turn so the tools the cache holds stay put within it. */
  private delegateNote?: { loop: number; text: string };

  private specsFor(tools: Tool[], session: Session): ToolSpec[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.name === 'Task' ? t.description + subagentCatalog(this.engine.subagents(session)) : t.name === 'Delegate' ? t.description + this.delegateDevices(session) : t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private delegateDevices(session: Session): string {
    if (this.delegateNote?.loop !== this.loops) this.delegateNote = { loop: this.loops, text: delegateCatalog(this.engine, session) };
    return this.delegateNote.text;
  }

  /**
   * The final-answer turn (step limit or loop-guard stop): a final reminder, then one call with the same tool
   * specs and toolChoice "none". The cached tools and system prompt hold; on
   * Anthropic the new tool choice means the messages are read again once. A provider that
   * rejects the tool choice gets one retry with tools left out. Tool calls in
   * the reply are dropped. Failures only log: the caller still posts the notice.
   */
  private async finalAnswerTurn(modelRef: string, mode: SessionMode, signal: AbortSignal, note: string, meta: Record<string, unknown>): Promise<void> {
    const engine = this.engine;
    if (signal.aborted) throw new Error('aborted');
    let resolved;
    try {
      resolved = engine.registryFor(this.session).resolve(modelRef);
    } catch {
      return;
    }
    if (resolved.acp) return;
    engine.addMessage(this.id, { role: 'user', kind: 'normal', content: [reminder(note)], meta: { auto: true, ...meta } });
    const session = this.session;
    const agent = engine.agentFor(session);
    const tools = engine.toolsFor(session, agent, mode, this.depth);
    const toolSpecs = this.specsFor(tools, session);
    const system = await this.systemFor(session, agent, modelRef, mode, tools.map((t) => t.name));
    const cfg = engine.config.get();
    const build = (names: Set<string>) =>
      buildProviderMessages(engine.repos.messages.list(this.id), {
        modelRef,
        toolNames: names,
        cache: cfg.context.promptCaching,
        imageText: !seesImages(resolved.model, resolved.info, cfg.providers[resolved.provider]),
      });
    const assistant = engine.addMessage(this.id, { role: 'assistant', kind: 'normal', content: [], model: modelRef, agent: agent.name });
    const call = (withTools: boolean) =>
      streamCompletion(
        engine,
        modelRef,
        {
          system,
          // without tools, earlier calls are sent as text (a request with tool blocks must define tools)
          messages: build(withTools ? new Set(tools.map((t) => t.name)) : new Set()),
          tools: withTools ? toolSpecs : undefined,
          toolChoice: withTools ? 'none' : undefined,
          thinking: engine.thinkingFor(agent, resolved.info, session),
          accessPrograms: engine.accessProgramsFor(resolved.info, session),
          temperature: agent.temperature,
          cacheKey: cfg.context.promptCaching ? `conclave-${this.id}` : undefined,
          cacheTtl: cfg.context.promptCaching ? cacheTtlFor(cfg.cache?.ttl, isHeadless(session, mode, this.depth)) : undefined,
          signal,
          userId: 'conclave',
        },
        { sessionId: this.id, messageId: assistant.id, purpose: this.depth ? 'subagent' : 'turn' },
      );
    let result;
    try {
      try {
        result = await call(toolSpecs.length > 0);
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'bad_request' || !toolSpecs.length) throw err;
        log.info(`final-answer turn: tool choice rejected (${err.message}); retrying without tools`);
        result = await call(false);
      }
    } catch (err) {
      engine.removeMessage(assistant.id);
      if (signal.aborted || (err instanceof ProviderError && err.kind === 'aborted')) throw err;
      log.warn('final-answer turn failed', err);
      return;
    }
    engine.addStats(this.id, result.usage);
    const content = result.content.filter((b) => b.type !== 'tool_use');
    if (isEmptyReply(content)) {
      engine.removeMessage(assistant.id);
      return;
    }
    engine.updateMessage(assistant.id, { content, usage: result.usage, stopReason: result.stopReason === 'tool_use' ? 'end_turn' : result.stopReason });
  }

  // -------------------------------------------------------------------------
  // Tool execution with hooks and permissions
  // -------------------------------------------------------------------------

  /** An error result for a call, sent to clients like any other. */
  private errorResult(use: ToolUseBlock, text: string, meta?: Record<string, unknown>): ToolResultBlock {
    const r: ToolResultBlock = { type: 'tool_result', toolUseId: use.id, content: text, isError: true, ...(meta ? { meta } : {}) };
    this.engine.bus.emit({ type: 'tool.completed', sessionId: this.id, toolUseId: use.id, result: r });
    return r;
  }

  async executeTool(use: ToolUseBlock, toolMap: Map<string, Tool>, messageId: string, signal: AbortSignal): Promise<ToolResultBlock> {
    const engine = this.engine;
    const session = this.session;
    const started = Date.now();
    let callMeta: Record<string, unknown> = {};
    const fail = (text: string, meta?: Record<string, unknown>): ToolResultBlock => {
      const r: ToolResultBlock = { type: 'tool_result', toolUseId: use.id, content: text, isError: true, meta: { durationMs: Date.now() - started, ...callMeta, ...meta } };
      engine.bus.emit({ type: 'tool.completed', sessionId: this.id, toolUseId: use.id, result: r });
      return r;
    };

    // a name that matches a tool except for case ("bash") runs that tool; permissions below judge the resolved tool
    const tool = resolveTool(toolMap, use.name);
    engine.bus.emit({ type: 'tool.started', sessionId: this.id, messageId, toolUseId: use.id, name: use.name, input: use.input });
    if (!tool) {
      // a deferred MCP tool (tools/tool-search.ts) needs its schema loaded first
      if (engine.deferredToolsFor(this.id).some((t) => t.name === use.name)) {
        return fail(`${use.name} is not loaded yet. Call ToolSearch with query "select:${use.name}" first, then call it in your next step.`, { unknownTool: true, deferred: true });
      }
      return fail(`Unknown tool: ${use.name}. Available tools: ${[...toolMap.keys()].join(', ')}`, { unknownTool: true });
    }
    if (tool.name !== use.name) callMeta = { resolvedTool: tool.name };
    if ((use.input as Record<string, unknown>)?._raw !== undefined) {
      return fail('The tool input was not valid JSON (possibly cut off by the output limit). Send the call again with complete, valid JSON input.');
    }
    // a string that spells the expected array, object, boolean or number is read as that value
    const { input: given, coerced } = coerceInput(tool.inputSchema, use.input);
    if (coerced.length) log.debug(`${tool.name} in ${this.id}: read ${coerced.join(', ')} from strings`);
    // a tool that checks its own input (StructuredOutput) reports every problem itself
    const invalid = tool.validatesInput ? undefined : validateInput(tool.inputSchema, given);
    if (invalid) return fail(`Invalid input: ${invalid}`);

    let input = given as Record<string, any>;
    const original = input;
    const machine = engine.machineFor(session);
    // an untrusted session (session/untrusted.ts): only allow rules let a call through, hooks cannot answer for the owner
    const untrusted = engine.isUntrusted(session);
    const cwd = tool.name === 'Bash' ? (this.shellCwd ?? session.cwd) : session.cwd;

    // PreToolUse hooks
    const pre = await engine.runHook(session, 'PreToolUse', { tool_name: tool.name, tool_input: input, tool_use_id: use.id }, tool.name);
    if (pre.updatedInput) input = pre.updatedInput as Record<string, any>;
    if (pre.blocked || pre.permissionDecision === 'deny') {
      return fail(`Blocked by hook: ${pre.reason ?? 'no reason given'}`, { denied: 'hook' });
    }
    const rewritten = !!pre.updatedInput && JSON.stringify(pre.updatedInput) !== JSON.stringify(original);

    // permissions
    const cfg = engine.config.get();
    const rules = engine.permissionRulesFor(session);
    const home = (await engine.machineHome(machine)) ?? '/';
    // a moved session's file tools map old paths to the current folder, so rules judge the path the tool will touch
    const oldRoots = engine.runnerExtensions.toolContext(session).pathMap?.roots;
    const judge = (inp: Record<string, any>) => {
      let content: string | undefined;
      try {
        content = tool.ruleContent?.(inp, { cwd, machine, ...(oldRoots?.length ? { pathMap: { roots: oldRoots, hits: [] } } : {}) });
      } catch {
        content = undefined;
      }
      return checkPermission({
        tool,
        input: inp,
        content,
        mode: session.permissionMode,
        rules,
        sessionAllow: this.sessionAllow,
        cwd: session.cwd,
        home,
        workspaceRoots: [session.cwd, ...cfg.permissions.additionalDirectories],
      });
    };
    let decision: { decision: 'allow' | 'ask' | 'deny'; reason: string };
    if (!rewritten) {
      const judged = judge(input);
      // A hook "allow" skips the approval prompt, but a deny rule (or plan mode) still wins, as in Claude Code
      // since 2.1.77: a plugin hook that allows everything must not undo the owner's deny rules.
      // In an untrusted session a hook allow counts for nothing; its deny still does.
      decision = pre.permissionDecision === 'allow' && judged.decision !== 'deny' && !untrusted ? { decision: 'allow', reason: 'Allowed by hook' } : judged;
    } else {
      // A rewrite keeps the original call's verdict: the original is judged, and the new input can only make it
      // stricter (a deny rule, or an explicit ask rule). A hook "allow" that comes with a rewrite counts only
      // when the original call was allowed anyway (ECOSYSTEM.md 4.3 item 12).
      const before = judge(original);
      const after = judge(input);
      decision = rewriteVerdict(before, after);
      if (pre.permissionDecision === 'allow' && before.decision === 'allow' && decision.decision === 'allow' && !untrusted) decision = { decision: 'allow', reason: 'Allowed by hook' };
    }
    for (const cmd of tool.name === 'Bash' ? [original.command, input.command] : []) {
      if (typeof cmd !== 'string') continue;
      const danger = dangerousCommand(cmd);
      if (danger && decision.decision === 'allow') decision = { decision: 'ask', reason: 'Potentially destructive command' };
    }
    if (tool.name === 'ExitPlanMode') decision = { decision: 'ask', reason: 'Approve the plan to start working' };
    // a PreToolUse hook answering "ask" forces a prompt, unless a rule already denies the call
    if (pre.permissionDecision === 'ask' && decision.decision !== 'deny') decision = { decision: 'ask', reason: pre.reason ?? 'A hook asked for approval' };

    if (decision.decision === 'deny') return fail(`Permission denied: ${decision.reason}`, { denied: 'rule' });
    // runner extensions (runner-ext.ts), for example the folder check after a session moved
    const callCtx = { sessionId: this.id, session, tool, input, toolUseId: use.id, depth: this.depth, readOnly: toolIsReadOnly(tool, input), signal };
    const extVerdict = await engine.runnerExtensions.beforeTool(callCtx, { failClosed: untrusted });
    if (extVerdict?.decision === 'deny') return fail(extVerdict.reason, { denied: 'extension' });
    if (extVerdict?.decision === 'ask' && decision.decision === 'allow') decision = { decision: 'ask', reason: extVerdict.reason };
    let askUser = decision.decision === 'ask';
    // a machine this account may not use (people/guard.ts): no card for a shell or file call that cannot run there; the tool says why
    if (askUser && (machine as { refused?: boolean }).refused && (tool.name === 'Bash' || tool.editsFiles)) askUser = false;
    if (askUser) {
      // PermissionRequest hooks can answer the prompt for the user
      const perm = await engine.runHook(session, 'PermissionRequest', { tool_name: tool.name, tool_input: input, tool_use_id: use.id }, tool.name);
      if (perm.blocked || perm.permissionDecision === 'deny') return fail(`Permission denied by hook: ${perm.reason ?? 'no reason given'}`, { denied: 'hook' });
      // in an untrusted session the owner answers, never a hook
      if (perm.permissionDecision === 'allow' && !untrusted) {
        askUser = false;
        if (perm.updatedInput) input = perm.updatedInput as Record<string, any>;
        if (tool.name === 'ExitPlanMode') engine.setPermissionMode(this.id, 'default');
      }
    }
    if (askUser) {
      // an old path from before a move: the card says where the call really lands
      let mappedTo: string | undefined;
      if (oldRoots?.length) {
        const pm = { roots: oldRoots, hits: [] as string[] };
        try {
          const c = tool.ruleContent?.(input, { cwd, machine, pathMap: pm });
          if (pm.hits.length) mappedTo = c;
        } catch {
          mappedTo = undefined;
        }
      }
      const base = (tool.summarize?.(input) ?? `${tool.name} ${oneLine(JSON.stringify(input), 100)}`) + (mappedTo ? ` (now ${mappedTo})` : '');
      // an extension that asked (the folder check after a move) says why on the card
      const summary = extVerdict?.decision === 'ask' ? `${base}. ${extVerdict.reason}` : base;
      const response: ApprovalResponse = await engine.requestApproval(this.id, {
        toolUseId: use.id,
        tool: tool.name,
        input,
        summary,
        suggestedRule: tool.suggestRule?.(input) ?? (tool.name === 'ExitPlanMode' ? undefined : tool.name),
      }, signal);
      if (response.decision === 'deny') {
        // a rejected plan is feedback for the next draft, so the loop guard does not count it as a refused action
        return fail(`The user denied this action.${response.message ? ` Their note: ${response.message}` : ''} Do not retry the same thing; adjust your approach or ask.`, tool.name === 'ExitPlanMode' ? { planRejected: true } : { denied: 'user' });
      }
      if (response.scope === 'session') this.sessionAllow.push(response.rule ?? tool.suggestRule?.(input) ?? tool.name);
      if (tool.name === 'ExitPlanMode') engine.setPermissionMode(this.id, 'default');
    }

    // run
    const ctx: ToolContext = {
      sessionId: this.id,
      session,
      cwd,
      machine,
      host: engine.toolHost(this),
      signal,
      model: session.model,
      agent: session.agent,
      depth: this.depth,
      readState: this.readState,
      readMark: (p) => this.readMark(p),
      readAllowed: (p) =>
        checkPermission({ tool: ReadTool as unknown as Tool, input: { file_path: p }, content: p, mode: session.permissionMode, rules, sessionAllow: this.sessionAllow, cwd: session.cwd, home, workspaceRoots: [session.cwd, ...cfg.permissions.additionalDirectories] }).decision === 'allow',
      toolUseId: use.id,
      toolNames: [...toolMap.keys()],
      progress: (text) => engine.bus.emit({ type: 'tool.progress', sessionId: this.id, toolUseId: use.id, text }),
      ...engine.runnerExtensions.toolContext(session),
    };

    let output: ToolOutput;
    try {
      output = tool.timeoutMs ? await runBounded(tool, input, ctx, tool.timeoutMs) : await tool.run(input, ctx);
    } catch (err) {
      if (signal.aborted) throw err;
      output = { content: `Tool error: ${(err as Error)?.message ?? String(err)}`, isError: true };
    }
    output = await engine.runnerExtensions.afterTool({ ...callCtx, input }, ctx, output);
    // text from outside cannot pass itself off as the framework (session/untrusted.ts)
    if (untrusted) output = { ...output, content: typeof output.content === 'string' ? defuseFrameworkTags(output.content) : output.content.map((b) => (b.type === 'text' ? { ...b, text: defuseFrameworkTags(b.text) } : b)) };
    const mark = output.meta?.readMark as ReadMark | undefined;
    if (!output.isError && mark && typeof mark.path === 'string') {
      // load the marks from context first, then this newer one wins
      this.readMark(mark.path);
      this.marks?.set(mark.path, mark);
    }
    // instruction files for this file's folder and path rules that match it, once each (HARNESS-REVIEW item 11)
    const scoped = !output.isError && SCOPED_TOOLS.has(tool.name) ? await this.scopedNote(session, machine, typeof output.meta?.path === 'string' ? output.meta.path : input.file_path).catch(() => undefined) : undefined;

    // follow the shell's working directory
    if (tool.name === 'Bash' && typeof output.meta?.cwd === 'string') this.shellCwd = output.meta.cwd;

    // offload large text output
    const meta = { ...(output.meta ?? {}), durationMs: Date.now() - started, ...callMeta };
    let content = output.content;
    const max = cfg.context.maxToolResultChars;
    // An MCP server that sends several blocks gives a block array; measure its text too, so big results still spill
    // to ReadToolOutput. Images stay as they are.
    const joined = typeof content === 'string' ? content : textOfBlocks(content);
    if (joined !== undefined && joined.length > max) {
      const images = typeof content === 'string' ? [] : content.filter((b) => b.type !== 'text');
      const id = engine.repos.outputs.save(this.id, tool.name, joined);
      // reduced by its kind first (a test report keeps its failures), then cut (tools/compress)
      const reduced = reduceOutput(joined, max);
      const cut = truncateMiddle(reduced.text, max, 'omitted');
      const how = reduced.reduced ? ` and was reduced as ${KIND_NAMES[reduced.kind]} (kept: ${KEEPS[reduced.kind]})${cut.truncated ? ', then truncated' : ''}` : ' and was truncated';
      const text = `${cut.text}\n\n[Output was ${joined.length} chars${how}. Full output id: ${id}. Use ReadToolOutput with this id to read more, grep it or query it.]`;
      content = images.length ? [{ type: 'text', text } as TextBlock, ...images] : text;
      meta.outputId = id;
      meta.truncated = true;
    }

    // PostToolUse hooks. Built-in tools send Claude Code's response objects; conclave.output_text is what the model sees.
    const seen = typeof content === 'string' ? content : (textOfBlocks(content) ?? '[blocks]');
    const response = toolResponse(tool.name, input, seen.slice(0, 20_000), output);
    const post = await engine.runHook(
      session,
      output.isError ? 'PostToolUseFailure' : 'PostToolUse',
      {
        tool_name: tool.name,
        tool_input: input,
        tool_use_id: use.id,
        tool_response: response,
        duration_ms: Date.now() - started,
        conclave: { model: session.model, agent: session.agent, device: session.device, output_text: seen.slice(0, 20_000) },
        ...(output.isError ? { error: seen.slice(0, 2_000) || 'Tool error' } : {}),
      },
      tool.name,
    );
    if (post.updatedToolOutput !== undefined) {
      const v = post.updatedToolOutput;
      content = typeof v === 'string' ? v : JSON.stringify(v);
    }
    // PreToolUse additionalContext reaches the model with the result, like PostToolUse feedback
    const notes = [...pre.additionalContext, ...post.additionalContext];
    if (post.blocked && post.reason) notes.push(post.reason);
    if (notes.length) {
      const note = `\n\n<hook_feedback>\n${notes.join('\n')}\n</hook_feedback>`;
      if (typeof content === 'string') content = content + note;
      else content = [...content, { type: 'text', text: note } as TextBlock];
    }
    if (post.stop) (meta as Record<string, unknown>).stopTurn = post.stop.reason ?? 'Stopped by hook';
    // after the offload, so a long result never cuts the instructions
    if (scoped) content = typeof content === 'string' ? `${content}\n\n${scoped}` : [...content, { type: 'text', text: scoped } as TextBlock];

    if (!toolIsReadOnly(tool, input)) {
      engine.audit(this.id, `tool:${tool.name}`, tool.summarize?.(input) ?? oneLine(JSON.stringify(input), 300));
    }

    const result: ToolResultBlock = { type: 'tool_result', toolUseId: use.id, content, isError: output.isError, meta };
    engine.bus.emit({ type: 'tool.completed', sessionId: this.id, toolUseId: use.id, result });
    return result;
  }
}

/**
 * Run a tool that has a time limit (MCP tools): the call stops being waited
 * on at the limit or on a user stop, even when the tool ignores its signal
 * (HARNESS-REVIEW item 9). The tool's own signal fires at the limit too.
 */
export function runBounded(tool: Tool, input: Record<string, unknown>, ctx: ToolContext, ms: number): Promise<ToolOutput> {
  const stop = AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]);
  return new Promise<ToolOutput>((resolve, reject) => {
    const onStop = () => (ctx.signal.aborted ? reject(new Error('aborted')) : resolve(timeoutOutput(ms)));
    if (stop.aborted) return onStop();
    stop.addEventListener('abort', onStop, { once: true });
    tool.run(input, { ...ctx, signal: stop }).then(resolve, reject).finally(() => stop.removeEventListener('abort', onStop));
  });
}

/** The tool a call names: the exact name, else the one tool whose name matches it without case ("bash"). */
export function resolveTool(toolMap: Map<string, Tool>, name: string): Tool | undefined {
  const exact = toolMap.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const hits = [...toolMap.values()].filter((t) => t.name.toLowerCase() === lower);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * A rewrite keeps the original call's verdict. The rewritten input can make it
 * stricter (any deny, or an ask from an explicit ask rule) but not looser, and
 * a plain "no allow rule matched" for the new input does not count, so
 * Bash(git status) still covers a hook's "rtk git status".
 */
export function rewriteVerdict<T extends { decision: 'allow' | 'ask' | 'deny'; reason: string; rule?: string }>(before: T, after: T): T {
  if (after.decision === 'deny' && before.decision !== 'deny') return { ...after, reason: `${after.reason} (after a hook changed the input)` };
  if (after.decision === 'ask' && after.rule && before.decision === 'allow') return { ...after, reason: `${after.reason} (after a hook changed the input)` };
  return before;
}

/** Joined text of a result's text blocks, or undefined when it has none. */
function textOfBlocks(blocks: ContentBlock[]): string | undefined {
  const texts = blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text);
  return texts.length ? texts.join('\n') : undefined;
}

/**
 * tool_response as Claude Code sends it for its built-in tools, so hooks
 * written for Claude Code find the fields they read (security-guidance reads
 * Bash stdout, karanb192's hooks read Write and Edit file objects). Other
 * tools get the text the model sees.
 */
export function toolResponse(tool: string, input: Record<string, any>, text: string, output: ToolOutput): unknown {
  const meta = (output.meta ?? {}) as Record<string, unknown>;
  const path = (typeof meta.path === 'string' ? meta.path : undefined) ?? input.file_path;
  switch (tool) {
    case 'Bash':
      if (meta.background) return text;
      return { stdout: text, stderr: '', interrupted: /\bCommand was interrupted\.|\btimed out after\b/.test(text), isImage: false, noOutputExpected: false };
    case 'Write':
      return { type: meta.created ? 'create' : 'update', filePath: path, content: input.content, success: !output.isError };
    case 'Edit':
      return { filePath: path, oldString: input.old_string, newString: input.new_string, replaceAll: !!input.replace_all, userModified: false, success: !output.isError };
    case 'MultiEdit':
      return { filePath: path, edits: input.edits, success: !output.isError };
    default:
      return text;
  }
}

/** Text the user typed in a message, ignoring reminders. */
export function userText(m: Message): string {
  return m.content
    .filter((b): b is TextBlock => b.type === 'text' && !isReminder(b))
    .map((b) => b.text)
    .join('\n');
}

export function finalText(msgs: Message[]): string {
  return lastAssistantText(msgs);
}

export type { AgentDef, ImageBlock };

/**
 * The reason a turn failed, for the owner: what went wrong and what to do
 * next. A missing or refused key and an empty account say where to fix it;
 * anything else keeps the provider's own words.
 */
export function turnErrorText(engine: Engine, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ProviderError) || !err.provider) return raw;
  // a member's access and budget on the hub's keys: the message says it all (people/access.ts)
  if (err.kind === 'auth' && (err.code === 'access' || err.code === 'budget')) return raw;
  const label = engine.providerLabel(err.provider);
  const name = label === err.provider ? label.charAt(0).toUpperCase() + label.slice(1) : label;
  if (err.kind === 'auth') {
    return engine.providers.isConfigured(err.provider)
      ? `${name} did not accept its API key (${raw}). Check the key in Settings, Providers, then retry.`
      : `${name} has no API key on this hub. Add one in Settings, Providers, or switch model, then retry.`;
  }
  if (err.kind === 'quota') return `${name} says the account is out of credit (${raw}). Add credit or switch model, then retry.`;
  return raw;
}
