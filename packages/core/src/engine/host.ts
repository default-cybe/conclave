import type {
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemoryScope,
  Notice,
  QuestionRequest,
  Session,
  Todo,
} from '../types';
import type { ToolHost } from '../tools/types';
import type { Engine } from './engine';
import type { SessionRunner } from '../session/runner';
import { completeText } from '../session/stream';
import { reminder } from '../session/transcript';
import { assistantFor } from '../assistant/registry';
import { workflowsOf } from '../workflows/attached';
import { mapsOf } from '../maps/registry';
import { pimFor } from '../pim/registry';
import { watchesOf } from '../watches';
import { LearnedSkills } from '../extensions/learned';
import { runDelegate } from './delegate';
import type { DelegateRequest } from '../tools/delegate';
import { savedSearchKey } from '../tools/search-settings';
import { checkShareable, outputsDir } from '../files/share';
import type { BrowserManager } from '../browser/manager';
import { loadPlaywright } from '../browser/runtime';
import type { RenderBrowser } from '../tools/render-file';
import { hubCapture, type CaptureOptions, type CaptureResult } from '../browser/capture';
import { mkdirSync } from 'node:fs';
import { findFfmpeg } from '../util/ffmpeg';

/** ToolHost bound to one running session. Tools call this, never the engine directly. */
export class EngineToolHost implements ToolHost {
  constructor(
    private engine: Engine,
    private runner: SessionRunner,
  ) {}

  private get session(): Session {
    return this.runner.session;
  }

  config() {
    return this.engine.config.get();
  }

  /** Web search runs on the hub's keys for every account (docs/design/ACCOUNTS.md). */
  searchKey(provider: string) {
    return savedSearchKey(this.engine.config)(provider);
  }

  async runSubagent(opts: Parameters<ToolHost['runSubagent']>[0]) {
    return this.engine.runSubagent(opts);
  }

  /** Task's preflight (engine/tool-check.ts): the agent's tool lists as this session's account sees it. */
  subagentTools(agent: string) {
    const def = this.engine.agentNamed(agent, this.session.cwd, this.engine.accountOf(this.session));
    return def ? { name: def.name, tools: def.tools, disallowedTools: def.disallowedTools } : undefined;
  }

  askUser(sessionId: string, questions: QuestionRequest['questions'], signal?: AbortSignal) {
    return this.engine.askUser(sessionId, questions, signal ?? new AbortController().signal);
  }

  complete(opts: { model?: string; system?: string; prompt: string; maxTokens?: number; signal?: AbortSignal; purpose?: string }) {
    return completeText(this.engine, { ...opts, sessionId: this.runner.id });
  }

  /** The session's account's memory: a tool never reads or writes another account's (docs/design/ACCOUNTS.md). */
  private get mem() {
    return this.engine.memoryFor(this.engine.accountOf(this.session));
  }

  memory = {
    search: (query: string, opts?: { scope?: MemoryScope; scopeKey?: string; limit?: number; kinds?: MemoryKind[] }): Promise<MemoryHit[]> => this.mem.search(query, opts),
    save: (entry: { content: string; kind?: MemoryKind; scope?: MemoryScope; scopeKey?: string; tags?: string[]; sourceSessionId?: string; importance?: number }): Promise<MemoryEntry> =>
      this.mem.save({ ...entry, scopeKey: entry.scopeKey ?? (entry.scope === 'project' ? this.session.cwd : entry.scope === 'agent' ? this.session.agent : undefined), sourceSessionId: entry.sourceSessionId ?? this.runner.id }),
    remove: (id: string): Promise<boolean> => this.mem.remove(id),
  };

  setTodos(sessionId: string, todos: Todo[]) {
    this.engine.setTodos(sessionId, todos);
  }
  getTodos(sessionId: string) {
    return this.engine.getTodos(sessionId);
  }

  async notify(notice: Omit<Notice, 'id' | 'createdAt'>) {
    // the session's own account gets it, whatever the tool said
    await this.engine.notifier.send({ ...notice, accountId: this.engine.accountOf(this.session) });
  }

  saveOutput(sessionId: string, tool: string, content: string) {
    return this.engine.repos.outputs.save(sessionId, tool, content);
  }
  readOutput(id: string) {
    const out = this.engine.repos.outputs.get(id);
    // an output of another account's session reads as one that is not there
    const stored = out && (!out.sessionId || this.engine.sessionAccount(out.sessionId) === this.engine.accountOf(this.session)) ? out.content : undefined;
    if (stored !== undefined) return stored;
    // a cleared result that was never offloaded is read back from its message by tool call id (session/context-edit.ts)
    for (const m of this.engine.repos.messages.list(this.runner.id)) {
      for (const b of m.content) {
        if (b.type !== 'tool_result' || b.toolUseId !== id) continue;
        return typeof b.content === 'string' ? b.content : b.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      }
    }
    return undefined;
  }

  async listSkills() {
    // the same skills loadSkill would load: a member's session gets the ones that ship and plugin skills only
    const member = this.engine.isMemberSession(this.session);
    return this.engine.extensions
      .skills(member ? undefined : this.session.cwd)
      .filter((s) => !member || s.source === 'builtin' || s.source === 'plugin')
      .map((s) => ({ name: s.name, description: s.description, plugin: s.plugin }));
  }

  async loadSkill(name: string) {
    const member = this.engine.isMemberSession(this.session);
    const skill = this.engine.extensions.skill(name, member ? undefined : this.session.cwd);
    if (!skill) return undefined;
    // a member's session loads the skills that ship and plugin skills only, never the owner's own or learned ones
    if (member && skill.source !== 'builtin' && skill.source !== 'plugin') return undefined;
    // a learned skill lives on the hub, whatever device the session runs on; its use feeds the skill review
    if (skill.learned) {
      const store = new LearnedSkills(this.engine.config.paths.home, this.engine.repos.kv);
      const s = store.get(skill.name);
      if (!s) return undefined;
      store.recordUse(s.name);
      return { name: s.name, body: s.body, dir: s.dir };
    }
    // a built-in skill ships as text in the binary, whatever device the session runs on
    if (skill.body !== undefined) return { name: skill.name, body: skill.body, dir: skill.dir };
    try {
      const body = await this.engine.machineFor(this.session).readText(skill.path);
      const stripped = body.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      return { name: skill.name, body: stripped, dir: skill.dir };
    } catch {
      return undefined;
    }
  }

  async createRoutine(input: { name: string; schedule: string; prompt: string; agent?: string; cwd?: string; device?: string }) {
    return this.engine.createRoutineFromChat({ ...input, cwd: input.cwd ?? this.session.cwd, device: input.device ?? this.session.device, agent: input.agent ?? this.session.agent }, this.engine.accountOf(this.session));
  }

  setPermissionMode(sessionId: string, mode: Session['permissionMode']) {
    this.engine.setPermissionMode(sessionId, mode);
  }

  shellEnded(sessionId: string, text: string) {
    if (sessionId !== this.runner.id) return;
    // a finished subagent child must not start an orphan turn nobody reads (subagent.ts does the same)
    this.runner.deliver({ block: reminder(text), wake: !this.session.meta?.subagent });
  }

  audit(sessionId: string, action: string, detail: string) {
    this.engine.audit(sessionId, action, detail);
  }

  get assistant() {
    return assistantFor(this.engine, this.engine.accountOf(this.session));
  }

  get workflows() {
    return workflowsOf(this.engine);
  }

  /** Maps spend the owner's key and the hub's daily cap and know the owner's home: none for a member (docs/design/ACCOUNTS.md 5). */
  get maps() {
    return this.engine.isMemberSession(this.session) ? undefined : mapsOf(this.engine);
  }

  /** The session's account's calendars and mail. */
  get pim() {
    return pimFor(this.engine, this.engine.accountOf(this.session));
  }

  untrusted(): boolean {
    return this.engine.isUntrusted(this.session);
  }

  /** Watches browse with the hub's Chromium: the owner's (docs/design/ACCOUNTS.md 5). */
  get watches() {
    return this.engine.isMemberSession(this.session) ? undefined : watchesOf(this.engine);
  }

  get learnedSkills(): NonNullable<ToolHost['learnedSkills']> {
    // learned skills live in the owner's skills folder: a member's session never writes there
    if (this.engine.isMemberSession(this.session)) throw new Error('Learned skills are the hub owner\'s. Your session cannot keep one.');
    const store = new LearnedSkills(this.engine.config.paths.home, this.engine.repos.kv);
    const changed = <T>(v: T): T => {
      void this.engine.extensions.reload().catch(() => {});
      return v;
    };
    return {
      list: () => store.list(),
      get: (name) => store.get(name),
      create: (input) => changed(store.create({ ...input, sessionId: this.runner.id })),
      patch: (name, input) => changed(store.patch(name, input)),
      disable: (name, reason) => changed(store.setEnabled(name, false, reason)),
      taken: (name) => {
        const s = this.engine.extensions.skill(name, this.session.cwd);
        if (!s || s.learned || s.name !== name) return undefined;
        return s.plugin ? `plugin ${s.plugin}` : s.source;
      },
    };
  }

  /** Past chats, without this session and the sessions it runs under (a subagent's parents). */
  get pastSessions(): NonNullable<ToolHost['pastSessions']> {
    const exclude: string[] = [];
    for (let s: Session | undefined = this.session, depth = 0; s && depth < 8; depth++) {
      exclude.push(s.id);
      s = s.parentId ? this.engine.getSession(s.parentId) : undefined;
    }
    return {
      // the session's own account's past only
      search: (q) => this.engine.searchPast({ ...q, exclude, accountId: this.engine.accountOf(this.session) }),
      read: (id, opts) => this.engine.readPast(id, { ...opts, exclude, accountId: this.engine.accountOf(this.session) }),
    };
  }

  deferredTools() {
    return this.engine.deferredToolsFor(this.runner.id);
  }

  get tasks() {
    return this.engine.backgroundTasks;
  }

  /** A Code or Assistant session on a device does the job and answers this one (engine/delegate.ts). */
  delegate(req: DelegateRequest) {
    return runDelegate(this.engine, this.runner.id, req);
  }

  /** ShareFile: the path checked against this session's folders now (files/share.ts). */
  shareCheck(path: string) {
    return checkShareable(path, this.engine.shareRoots(this.session), this.engine.config.paths.home);
  }

  outputsDir() {
    const dir = outputsDir(this.engine.config.paths.home, this.session.id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** RenderFile: a fresh headless Chromium per call from the hub's browser install (browser/manager.ts finds it). */
  async renderBrowser(): Promise<RenderBrowser | { error: string }> {
    const b = (this.engine as unknown as { browser?: BrowserManager }).browser;
    const executable = b?.executable();
    if (!b || !executable) return { error: 'No browser is installed on this hub yet, so files cannot be rendered. The owner can install one in Settings, Browser, Engines.' };
    try {
      return { chromium: (await loadPlaywright(b.runtimeDir())).chromium as unknown as RenderBrowser['chromium'], executable };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Capture: a fresh stock browser per call, files in this session's outputs folder (browser/capture.ts). */
  capture(url: string, opts: CaptureOptions, signal?: AbortSignal): Promise<CaptureResult> {
    const b = (this.engine as unknown as { browser?: BrowserManager }).browser;
    return hubCapture(b, this.engine.config.paths.home, this.outputsDir(), url, opts, signal);
  }

  ffmpeg() {
    return findFfmpeg(this.engine.config.paths.home);
  }
}
