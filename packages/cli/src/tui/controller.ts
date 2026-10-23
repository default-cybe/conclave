/**
 * Chat state outside React. Talks to the hub only through ConclaveClient
 * (HTTP + WebSocket) and publishes immutable snapshots for the UI.
 */
import type { Attachment, ConclaveClient, HubInfo, ModelGroup, SendInput } from '@conclave/core/client/index.ts';
import type { AgentDef, CommandDef } from '@conclave/core/extensions/types.ts';
import type {
  ApprovalRequest,
  ApprovalResponse,
  EngineEventEnvelope,
  LimitState,
  PermissionMode,
  QuestionRequest,
  Session,
  SessionMode,
  Todo,
  Usage,
} from '@conclave/core/types.ts';
import { tui as p, truncate } from '../ansi';
import { DedupeNotes, eventSessionId, isActiveStatus } from '../events';
import { describeError } from '../commands/shared';
import { shortenPath } from '../render/format';
import { TranscriptStore, type Item } from './transcript';

export type { Item };

export interface Draft {
  agent?: string;
  model?: string;
  mode?: SessionMode;
  /** Undefined lets the hub use config.permissions.mode. */
  permissionMode?: PermissionMode;
  device: string;
  cwd: string;
}

export interface Snapshot {
  version: number;
  hubStatus: 'connecting' | 'open' | 'closed';
  hubUrl: string;
  hubSource: string;
  hubInfo?: HubInfo;
  session?: Session;
  draft: Draft;
  committed: Item[];
  live: Item[];
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  limits: LimitState[];
  lastUsage?: Usage;
  contextWindow?: number;
  turnStartedAt?: number;
  staticKey: number;
  showThinking: boolean;
  /** Provider id -> subscription id, for picking the relevant limit. */
  subscriptions: Record<string, string>;
  /** Transient line under the input (e.g. "permission mode: plan"). */
  flash?: string;
}

export interface ControllerOptions {
  client: ConclaveClient;
  hubUrl: string;
  hubSource: string;
  draft: Draft;
  version: string;
}

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Images and PDFs mentioned as @path go along as attachments the hub reads on the device. */
export function attachmentsFor(text: string, cwd: string): Attachment[] {
  const out: Attachment[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const path = m[1];
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const mediaType = IMAGE_EXT[ext];
    if (!mediaType) continue;
    const abs = path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`;
    out.push({ path: abs, mediaType, name: path.split(/[\\/]/).pop() });
  }
  return out;
}

export class ChatController {
  readonly client: ConclaveClient;
  readonly store = new TranscriptStore();
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private committedCopy: Item[] = [];
  private emitTimer?: ReturnType<typeof setTimeout>;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private closeWs?: (() => void) & { setActive(active: boolean): void };
  private lastPresence = 0;
  private lastUsage?: Usage;
  models: ModelGroup[] = [];
  commands: CommandDef[] = [];
  agents: AgentDef[] = [];
  /** Called when the screen must be cleared before Static re-renders. */
  onClearScreen?: () => void;
  onExit?: () => void;

  constructor(private opts: ControllerOptions) {
    this.client = opts.client;
    this.snap = {
      version: 0,
      hubStatus: 'connecting',
      hubUrl: opts.hubUrl,
      hubSource: opts.hubSource,
      draft: opts.draft,
      committed: [],
      live: [],
      approvals: [],
      questions: [],
      todos: [],
      limits: [],
      staticKey: 0,
      showThinking: false,
      subscriptions: {},
    };
  }

  // ----- store plumbing -------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  private set(patch: Partial<Snapshot>, now = false): void {
    this.snap = { ...this.snap, ...patch };
    this.emit(now);
  }

  emit(now = false): void {
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      this.flush();
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.flush();
    }, 40);
  }

  private flush(): void {
    const { committed, live, changed } = this.store.build();
    if (changed || this.committedCopy.length !== committed.length) this.committedCopy = committed.slice();
    this.snap = {
      ...this.snap,
      version: this.snap.version + 1,
      committed: this.committedCopy,
      live,
      lastUsage: this.lastUsage,
      contextWindow: this.contextWindowFor(this.currentModel()),
    };
    for (const l of this.listeners) l();
  }

  get session(): Session | undefined {
    return this.snap.session;
  }

  currentModel(): string | undefined {
    return this.snap.session?.model ?? this.snap.draft.model ?? this.snap.hubInfo?.defaultModel;
  }

  currentCwd(): string {
    return this.snap.session?.cwd ?? this.snap.draft.cwd;
  }

  currentDevice(): string {
    return this.snap.session?.device ?? this.snap.draft.device;
  }

  private contextWindowFor(ref: string | undefined): number | undefined {
    if (!ref) return undefined;
    for (const g of this.models) for (const m of g.models) if (m.ref === ref) return m.contextWindow;
    return undefined;
  }

  info(text: string, gap = true): void {
    this.store.addLocal({ kind: 'info', text, gap } as Omit<Extract<Item, { kind: 'info' }>, 'id' | 'final'>);
    this.emit();
  }

  private seenErrors = new DedupeNotes();

  notice(text: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    if ((level === 'error' || level === 'warning') && !this.seenErrors.fresh(text)) return;
    this.store.addLocal({ kind: 'notice', text, level });
    this.emit();
  }

  error(e: unknown): void {
    this.notice(describeError(e), 'error');
  }

  flash(text: string, ms = 2500): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.set({ flash: text }, true);
    this.flashTimer = setTimeout(() => this.set({ flash: undefined }, true), ms);
  }

  /** Clear the terminal and print the transcript again (thinking toggle, resume, /clear). */
  rerender(): void {
    this.store.recommit();
    this.committedCopy = [];
    this.onClearScreen?.();
    this.set({ staticKey: this.snap.staticKey + 1 }, true);
  }

  toggleThinking(): void {
    this.snap = { ...this.snap, showThinking: !this.snap.showThinking };
    this.rerender();
  }

  // ----- lifecycle ------------------------------------------------------------

  async start(init: { resume?: string; continueLast?: boolean; prompt?: string }): Promise<void> {
    // active: the hub holds notifications while someone uses Conclave; inUse() keeps that true while you type
    this.closeWs = this.client.connect(this.onEvent, { onStatus: (s) => this.set({ hubStatus: s }, true), onResync: () => void this.resync(), active: true });
    this.lastPresence = Date.now();
    this.banner();
    const infoP = this.client.info().then(
      (hubInfo) => this.set({ hubInfo }, true),
      () => {},
    );
    void this.refreshMeta();
    try {
      if (init.resume) await this.resume(init.resume);
      else if (init.continueLast) {
        const list = await this.client.listSessions({ limit: 50, archived: false });
        const cwd = this.snap.draft.cwd;
        const s = list.find((x) => x.cwd === cwd && !x.parentId) ?? list.find((x) => x.cwd === cwd);
        if (s) await this.resume(s.id);
        else this.notice(`No earlier session in ${shortenPath(cwd)}. Starting a new one.`);
      }
    } catch (e) {
      this.error(e);
    }
    await infoP;
    if (init.prompt) await this.send(init.prompt);
    this.emit(true);
  }

  async refreshMeta(): Promise<void> {
    const [models, commands, limits, cfg] = await Promise.allSettled([this.client.models(), this.client.commands(), this.client.limits(), this.client.config()]);
    if (models.status === 'fulfilled') this.models = models.value;
    if (commands.status === 'fulfilled') this.commands = commands.value;
    const patch: Partial<Snapshot> = {};
    if (limits.status === 'fulfilled') patch.limits = limits.value;
    if (cfg.status === 'fulfilled') {
      const providers = (cfg.value.config?.providers ?? {}) as Record<string, { subscription?: string }>;
      patch.subscriptions = Object.fromEntries(Object.entries(providers).filter(([, v]) => v?.subscription).map(([k, v]) => [k, v.subscription!]));
    }
    this.set(patch);
  }

  /**
   * A key was pressed: you are using Conclave here. The hub counts that for
   * notifications.idleSeconds, so a terminal left open while you are away
   * stops holding notifications. At most one frame every 20 seconds.
   */
  inUse(): void {
    const now = Date.now();
    if (now - this.lastPresence < 20_000) return;
    this.lastPresence = now;
    this.closeWs?.setActive(true);
  }

  dispose(): void {
    this.closeWs?.();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
  }

  private banner(): void {
    const mark = p.bold(p.fg('#C792EA')('◆ Conclave'));
    this.store.addLocal({
      kind: 'banner',
      lines: [
        `${mark} ${p.dim('v' + this.opts.version)}`,
        '',
        p.dim('/help for commands · @ to mention files · esc to interrupt'),
        p.dim(`cwd  ${shortenPath(this.snap.draft.cwd, 50)}`),
        p.dim(`hub  ${this.opts.hubUrl}${this.opts.hubSource === 'local' ? ' (local)' : ''}`),
      ],
    });
  }

  // ----- events -----------------------------------------------------------------

  private onEvent = (ev: EngineEventEnvelope): void => {
    switch (ev.type) {
      case 'limit.updated': {
        const limits = [...this.snap.limits.filter((l) => l.provider !== ev.limit.provider), ev.limit];
        this.set({ limits });
        return;
      }
      case 'config.updated':
        void this.resync();
        return;
      default:
        break;
    }
    const sid = eventSessionId(ev);
    const cur = this.snap.session;
    if (!cur || sid !== cur.id) return;
    switch (ev.type) {
      case 'session.updated':
        this.applySession(ev.session);
        return;
      case 'session.deleted':
        this.notice('This session was deleted on the hub.', 'warning');
        this.snap = { ...this.snap, session: undefined };
        this.emit(true);
        return;
      case 'message.created':
      case 'message.updated':
        if (ev.message.role === 'assistant' && ev.message.usage && ev.message.kind === 'normal') this.lastUsage = ev.message.usage;
        // A notice message comes first; remember it so the matching notice events stay quiet.
        if (ev.message.kind === 'notice') for (const b of ev.message.content) if (b.type === 'text') this.seenErrors.fresh(b.text);
        this.store.upsert(ev.message, ev.type === 'message.created');
        break;
      case 'message.delta':
        this.store.delta(ev);
        break;
      case 'tool.started':
        this.store.toolStarted(ev.toolUseId, ev.name, ev.input);
        break;
      case 'tool.progress':
        this.store.toolProgress(ev.toolUseId, ev.text);
        break;
      case 'tool.completed':
        this.store.toolCompleted(ev.toolUseId, ev.result);
        break;
      case 'approval.requested': {
        const approvals = [...this.snap.approvals.filter((a) => a.id !== ev.approval.id), ev.approval];
        this.store.setWaiting(approvals.map((a) => a.toolUseId));
        this.set({ approvals }, true);
        return;
      }
      case 'approval.resolved': {
        const approvals = this.snap.approvals.filter((a) => a.id !== ev.id);
        this.store.setWaiting(approvals.map((a) => a.toolUseId));
        this.set({ approvals }, true);
        return;
      }
      case 'question.asked':
        this.set({ questions: [...this.snap.questions.filter((q) => q.id !== ev.question.id), ev.question] }, true);
        return;
      case 'question.answered':
        this.set({ questions: this.snap.questions.filter((q) => q.id !== ev.id) }, true);
        return;
      case 'todo.updated':
        this.set({ todos: ev.todos });
        return;
      case 'notice': {
        const n = ev.notice;
        const text = n.body || n.title;
        if ((n.level === 'error' || n.level === 'warning') && !this.seenErrors.fresh(text)) break;
        this.store.addLocal({ kind: 'notice', text, level: n.level });
        break;
      }
      default:
        return;
    }
    this.emit();
  };

  private applySession(s: Session): void {
    const prev = this.snap.session;
    const wasActive = isActiveStatus(prev?.status);
    const active = isActiveStatus(s.status);
    this.store.setActive(active);
    const patch: Partial<Snapshot> = { session: s };
    if (active && !wasActive) patch.turnStartedAt = Date.now();
    if (!active) {
      patch.turnStartedAt = undefined;
      if (wasActive) {
        // drop stale prompts when a turn ends
        patch.approvals = this.snap.approvals.filter((a) => a.sessionId !== s.id);
        patch.questions = this.snap.questions.filter((q) => q.sessionId !== s.id);
      }
    }
    if (prev && prev.model !== s.model) this.store.addLocal({ kind: 'notice', text: `Model: ${prev.model} -> ${s.model}`, level: 'info' });
    if (s.status === 'error' && s.error && prev?.status !== 'error' && this.seenErrors.fresh(s.error)) this.store.addLocal({ kind: 'notice', text: s.error, level: 'error' });
    this.snap = { ...this.snap, ...patch };
    this.emit(!active || !wasActive);
  }

  /** After a WebSocket resync: refetch the session and its messages. */
  private async resync(): Promise<void> {
    const s = this.snap.session;
    if (!s) return;
    try {
      const [session, msgs] = await Promise.all([this.client.getSession(s.id), this.client.messages(s.id)]);
      this.applySession(session);
      for (const m of msgs) this.store.upsert(m, false);
      this.emit();
    } catch {
      /* next event will try again */
    }
  }

  // ----- actions ------------------------------------------------------------------

  private creating?: Promise<Session>;

  async ensureSession(): Promise<Session> {
    if (this.snap.session) return this.snap.session;
    // two quick sends must not create two sessions
    if (!this.creating) {
      const d = this.snap.draft;
      this.creating = this.client
        .createSession({ agent: d.agent, model: d.model, mode: d.mode, permissionMode: d.permissionMode, cwd: d.cwd, device: d.device })
        .then((s) => {
          this.snap = { ...this.snap, session: s };
          this.store.setActive(isActiveStatus(s.status));
          this.emit(true);
          return s;
        })
        .finally(() => {
          this.creating = undefined;
        });
    }
    return this.creating;
  }

  async send(text: string, extra: Partial<SendInput> = {}): Promise<void> {
    if (!text.trim()) return;
    try {
      const s = await this.ensureSession();
      if (isActiveStatus(s.status)) this.info(p.dim(`⏳ Queued: ${truncate(text.replace(/\s+/g, ' '), 80)}`));
      const attachments = attachmentsFor(text, s.cwd);
      await this.client.send(s.id, { text, ...(attachments.length ? { attachments } : {}), ...extra });
    } catch (e) {
      this.error(e);
    }
  }

  async abort(): Promise<void> {
    const s = this.snap.session;
    if (!s) return;
    try {
      await this.client.abort(s.id);
      this.notice('Interrupted', 'warning');
    } catch (e) {
      this.error(e);
    }
  }

  async resolveApproval(a: ApprovalRequest, response: ApprovalResponse): Promise<void> {
    const approvals = this.snap.approvals.filter((x) => x.id !== a.id);
    this.store.setWaiting(approvals.map((x) => x.toolUseId));
    this.set({ approvals }, true);
    try {
      await this.client.resolveApproval(a.id, response);
    } catch (e) {
      this.error(e);
    }
  }

  async answerQuestion(q: QuestionRequest, answers: Record<string, string>): Promise<void> {
    this.set({ questions: this.snap.questions.filter((x) => x.id !== q.id) }, true);
    try {
      await this.client.answerQuestion(q.id, answers);
    } catch (e) {
      this.error(e);
    }
  }

  async patchSession(patch: Partial<Pick<Session, 'model' | 'agent' | 'mode' | 'permissionMode' | 'device' | 'cwd' | 'modeConfig' | 'title'>>): Promise<void> {
    const s = this.snap.session;
    if (!s) {
      const d = { ...this.snap.draft };
      for (const [k, v] of Object.entries(patch)) if (k in d || ['model', 'agent', 'mode', 'permissionMode', 'device', 'cwd'].includes(k)) (d as Record<string, unknown>)[k] = v;
      this.set({ draft: d }, true);
      if (patch.modeConfig) {
        // modeConfig needs a session
        await this.ensureSession();
        await this.patchSession({ modeConfig: patch.modeConfig });
      }
      return;
    }
    try {
      const next = await this.client.updateSession(s.id, patch);
      this.applySession(next);
    } catch (e) {
      this.error(e);
    }
  }

  async cyclePermissionMode(): Promise<void> {
    const cur = this.snap.session?.permissionMode ?? this.snap.draft.permissionMode ?? 'default';
    const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(cur) + 1) % PERMISSION_MODES.length];
    this.flash(`permission mode: ${next}`);
    await this.patchSession({ permissionMode: next });
  }

  newSession(): void {
    this.store.clear();
    this.lastUsage = undefined;
    this.snap = { ...this.snap, session: undefined, approvals: [], questions: [], todos: [], turnStartedAt: undefined };
    this.store.setActive(false);
    this.banner();
    this.rerender();
  }

  async resume(id: string): Promise<void> {
    const [s, msgs, approvals, questions, todos] = await Promise.all([
      this.client.getSession(id),
      this.client.messages(id),
      this.client.approvals().catch(() => [] as ApprovalRequest[]),
      this.client.questions().catch(() => [] as QuestionRequest[]),
      this.client.todos(id).catch(() => [] as Todo[]),
    ]);
    this.store.clear();
    const active = isActiveStatus(s.status);
    this.store.setActive(active);
    this.banner();
    this.store.load(msgs, active);
    this.lastUsage = [...msgs].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal' && m.usage)?.usage;
    const mine = approvals.filter((a) => a.sessionId === id);
    this.store.setWaiting(mine.map((a) => a.toolUseId));
    this.store.addLocal({ kind: 'notice', text: `Resumed "${s.title || 'untitled'}" · ${msgs.length} messages · ${s.id}`, level: 'info' });
    this.snap = {
      ...this.snap,
      session: s,
      draft: { ...this.snap.draft, cwd: s.cwd, device: s.device },
      approvals: mine,
      questions: questions.filter((q) => q.sessionId === id),
      todos,
      turnStartedAt: active ? Date.now() : undefined,
    };
    this.rerender();
  }

  async fork(): Promise<void> {
    const s = this.snap.session;
    if (!s) return this.notice('Nothing to fork yet.', 'warning');
    try {
      const f = await this.client.forkSession(s.id);
      await this.resume(f.id);
      this.notice(`Forked from ${s.id}`, 'success');
    } catch (e) {
      this.error(e);
    }
  }

  async rewind(seq: number, restoreFiles: boolean): Promise<void> {
    const s = this.snap.session;
    if (!s) return;
    try {
      await this.client.rewind(s.id, seq, restoreFiles);
      await this.resume(s.id);
      this.notice(`Rewound to before message ${seq}${restoreFiles ? ' and restored files' : ''}`, 'success');
    } catch (e) {
      this.error(e);
    }
  }
}
