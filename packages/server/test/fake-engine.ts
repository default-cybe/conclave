/**
 * Fake EngineApi for server tests. Real bus, config (temp home), sqlite repos
 * and device registry; everything else is a small stub that records calls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceHub, EngineApi } from '@conclave/core/engine/api.ts';
import { ConfigStore, type ConclaveConfig } from '@conclave/core/config/index.ts';
import { openDb } from '@conclave/core/storage/db.ts';
import { Repos, type SessionFilter } from '@conclave/core/storage/repos.ts';
import { searchPastSessions } from '@conclave/core/session/search.ts';
import { movedSession } from '@conclave/core/session/delegated.ts';
import { EventBus } from '@conclave/core/util/bus.ts';
import { newId } from '@conclave/core/util/ids.ts';
import { DeviceRegistry } from '@conclave/core/machine/registry.ts';
import { HookRecipes } from '@conclave/core/extensions/recipes.ts';
import type {
  ApprovalRequest,
  ApprovalResponse,
  MemoryEntry,
  Message,
  QuestionRequest,
  Routine,
  RoutineRun,
  Session,
  Task,
} from '@conclave/core/types.ts';
import type { CreateSessionInput, HubInfo, SessionPatch, UsageSummary } from '@conclave/core/client/index.ts';
import type { ExtensionRegistry, AgentDef } from '@conclave/core/extensions/types.ts';
import type { MemoryService } from '@conclave/core/memory/types.ts';
import type { RoutineInput, RoutineService, Scheduler } from '@conclave/core/scheduler/types.ts';
import type { Notifier } from '@conclave/core/notify/types.ts';
import { FakeMachine } from '../../core/test/machine/fake-machine';
import { SqliteMemory } from '@conclave/core/memory/store.ts';
import { MemoryConnections, MemoryConnectionService } from '@conclave/core/memory/connections/index.ts';
import { builtinAgentDefault } from '@conclave/core/extensions/builtin-agents.ts';
import { mcpConnectPlan } from '@conclave/core/extensions/cli-sync.ts';
import { mcpFromClaude } from '@conclave/core/extensions/compat.ts';
import { EngineError } from '@conclave/core/engine/errors.ts';
import { createBackup, restoreBackup } from '@conclave/core/engine/backup.ts';
import { exportSession as exportShared } from '@conclave/core/session/share.ts';
import type { McpStatus } from '@conclave/core/client/index.ts';
import { PeopleStore } from '@conclave/core/people/store.ts';
import { AccountSecrets } from '@conclave/core/people/secrets.ts';
import { ProviderAccess } from '@conclave/core/people/access.ts';
import { OWNER_ID, currentAccount, isMember } from '@conclave/core/people/context.ts';

export interface FakeEngine extends EngineApi {
  calls: Array<{ method: string; args: unknown[] }>;
  touches: string[];
  /** Client ids the hub stopped holding notifications for (presence false or a closed socket). */
  releases: string[];
  approvals: Map<string, ApprovalRequest>;
  resolved: Array<{ id: string; response: ApprovalResponse }>;
  routineRuns: Array<{ id: string; trigger?: string; extra?: string }>;
  registry: DeviceRegistry;
  home: string;
  /** The real store behind memoryAdmin (engine.memory itself is a stub). */
  memoryStore: SqliteMemory;
  cleanup(): void;
}

export function createFakeEngine(overrides: Partial<ConclaveConfig> = {}): FakeEngine {
  const home = mkdtempSync(join(tmpdir(), 'conclave-server-test-'));
  const config = new ConfigStore(home);
  // update() rather than constructor overrides: overrides do not survive later updates
  config.update({ ...overrides, server: { ...config.get().server, ...(overrides.server ?? {}), token: 'owner-token-0123456789abcdef' } });
  const repos = new Repos(openDb(':memory:'));
  const bus = new EventBus();
  const calls: FakeEngine['calls'] = [];
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const touches: string[] = [];
  const releases: string[] = [];
  const approvals = new Map<string, ApprovalRequest>();
  const resolved: FakeEngine['resolved'] = [];
  const routineRuns: FakeEngine['routineRuns'] = [];
  const questions = new Map<string, QuestionRequest>();
  const local = new FakeMachine('local', 'hub');
  const registry = new DeviceRegistry({ local, repos, bus });
  const memories = new Map<string, MemoryEntry>();
  const routines = new Map<string, Routine>();
  const tasks = new Map<string, Task>();
  const scopeHooks = new Map<string, import('@conclave/core/config/schema.ts').HooksConfig>();
  /** Readers Refresh models runs (the CLIProxyAPI manager adds one). */
  const refreshers = new Set<() => Promise<void>>();
  let recipes: HookRecipes | undefined;

  const notifier: Notifier = {
    async send(n) {
      return { ...n, id: newId('ntc'), createdAt: Date.now() };
    },
    touch: (id) => void touches.push(id),
    release: (id) => void releases.push(id),
    channels: () => [{ id: 'webpush', enabled: true }],
    async test(channel, opts) {
      rec('notifier.test', channel, opts);
    },
    addPushSubscription: (sub, device) => void rec('notifier.addPushSubscription', sub, device),
    removePushSubscription: (e) => void rec('notifier.removePushSubscription', e),
    devices: () => [{ id: 'a1b2c3d4e5f60718', name: 'Safari on iOS', kind: 'webpush', createdAt: 1 }],
    removeDevice: (id) => (rec('notifier.removeDevice', id), id === 'a1b2c3d4e5f60718'),
    vapidPublicKey: () => 'vapid-public',
  };

  const memory: MemoryService = {
    async search(q) {
      return [...memories.values()].filter((m) => m.content.includes(q)).map((m) => ({ ...m, score: 1 }));
    },
    async save(input) {
      const e: MemoryEntry = {
        id: newId('mem'),
        scope: input.scope ?? 'global',
        scopeKey: input.scopeKey,
        kind: input.kind ?? 'fact',
        content: input.content,
        tags: input.tags ?? [],
        importance: input.importance ?? 0.5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        useCount: 0,
      };
      memories.set(e.id, e);
      return e;
    },
    async update(id, patch) {
      const e = memories.get(id);
      if (!e) return undefined;
      Object.assign(e, patch);
      return e;
    },
    async remove(id) {
      return memories.delete(id);
    },
    get: (id) => memories.get(id),
    list: () => [...memories.values()],
    profile: () => [],
    recall: async () => [],
    extract: async () => [],
    summarizeEpisode: async () => undefined,
    stats: () => ({ total: memories.size, byKind: {} }),
  };

  const routineService: RoutineService = {
    list: () => [...routines.values()],
    get: (id) => routines.get(id),
    create(input: RoutineInput) {
      if (input.schedule === 'bad') throw new Error('invalid schedule');
      const r: Routine = {
        // keep the optional fields (cwd, device, allow, suggestion...) like the real service
        ...(input as Partial<Routine>),
        id: newId('rtn'),
        name: input.name,
        schedule: input.schedule,
        agent: input.agent ?? 'assistant',
        mode: input.mode ?? 'agent',
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        sessionPolicy: input.sessionPolicy ?? 'new',
        notify: input.notify ?? 'always',
        webhookSecret: 'hook-secret',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      routines.set(r.id, r);
      return r;
    },
    update(id, patch) {
      if (patch.schedule === 'bad') throw new Error('invalid schedule');
      const r = { ...routines.get(id)!, ...patch, updatedAt: Date.now() } as Routine;
      routines.set(id, r);
      return r;
    },
    remove: (id) => void routines.delete(id),
    async runNow(id, trigger, extra, opts) {
      routineRuns.push({ id, trigger, extra });
      const run = { id: newId('run'), routineId: id, status: 'running', trigger: trigger ?? 'manual', startedAt: Date.now(), sessionId: 'ses_fake' } satisfies RoutineRun;
      opts?.onStart?.(run);
      // "hang" stands for a run that takes minutes: the route must answer at its start
      if (extra === 'hang') return new Promise<RoutineRun>(() => {});
      return run;
    },
    runs: () => [],
    preview(schedule) {
      if (schedule === 'bad') throw new Error('invalid schedule');
      return [Date.now() + 60_000];
    },
    templates: () => [],
  };

  const scheduler: Scheduler = {
    start() {},
    stop() {},
    enqueue: () => newId('job'),
    cancel() {},
    handle() {},
    poke() {},
  };

  // memory connections: the real service over a real store on the fake's db
  const memoryStore = new SqliteMemory({ db: repos.db, bus, config, complete: async () => '' });
  const memoryConnections = new MemoryConnections({ config });
  // a local Basic Memory runs as the hub's basic-memory server, as in engine/create.ts
  const memoryAdmin = new MemoryConnectionService({ config, connections: memoryConnections, memory: memoryStore, db: repos.db, addMcpServer: (name, cfg) => config.update({ mcpServers: { ...config.getUser().mcpServers, [name]: cfg } }) });
  const trusted = new Set<string>();
  const mcpStatusOf = (name: string): McpStatus => ({ name, status: 'connected', tools: 1, source: 'stdio', origin: 'config', transport: 'stdio', enabled: true });
  const requireMcp = (name: string) => {
    if (!config.get().mcpServers[name]) throw new EngineError(404, `unknown mcp server ${name}`);
  };

  const agents = new Map<string, AgentDef>([['assistant', { name: 'assistant', description: 'default', prompt: 'hi', source: 'builtin' }]]);
  const extensions: ExtensionRegistry = {
    async reload() {
      rec('extensions.reload');
    },
    agents: () => [...agents.values()],
    agent: (n) => agents.get(n),
    async saveAgent(def) {
      agents.set(def.name, def);
      return def;
    },
    async deleteAgent(n) {
      return agents.delete(n);
    },
    skills: () => [],
    skill: () => undefined,
    commands: () => [],
    command: () => undefined,
    pluginHooks: () => ({}),
    pluginMcpServers: () => ({}),
    plugins: () => [],
    async installPlugin(source) {
      return { name: 'p', dir: '/x', manifest: { name: 'p' }, enabled: true, source, installedAt: Date.now() };
    },
    removePlugin: async () => false,
    setPluginEnabled: async () => {},
    marketplaces: async () => [],
    addMarketplace: async () => {},
  };

  const sessionOr404 = (id: string): Session => {
    const s = repos.sessions.get(id);
    if (!s) throw Object.assign(new Error(`unknown session ${id}`), { status: 404 });
    return s;
  };

  // accounts (docs/design/ACCOUNTS.md): the real store over the same database
  const people = new PeopleStore(repos.db);
  const accountSecrets = new AccountSecrets(config);
  const access = new ProviderAccess({ db: repos.db, config, people, secrets: accountSecrets });
  const memberMemories = new Map<string, SqliteMemory>();
  const memoryFor = (acct: string | undefined): SqliteMemory => {
    if (!isMember(acct)) return memory as unknown as SqliteMemory;
    let m = memberMemories.get(acct!);
    if (!m) memberMemories.set(acct!, (m = new SqliteMemory({ db: repos.db, bus, config, complete: async () => '', accountId: acct })));
    return m;
  };
  const sessionAccount = (id: string) => repos.sessions.get(id)?.accountId;

  const startedAt = Date.now();
  const engine: FakeEngine = {
    people,
    accountSecrets,
    access,
    sessionAccount,
    memoryFor,
    memoryAdminFor: () => memoryAdmin,
    providersFor: () => ({ groups: async () => [] }) as never,
    isUsable: () => true,
    agentsFor: (acct) => (isMember(acct) ? extensions.agents().filter((a) => a.source === 'builtin' || a.source === 'plugin') : extensions.agents()),
    pendingAccount: (id) => {
      const sid = approvals.get(id)?.sessionId ?? questions.get(id)?.sessionId;
      return sid ? sessionAccount(sid) : undefined;
    },
    async forgetAccount() {},
    bus,
    config,
    repos,
    extensions,
    memory,
    routines: routineService,
    scheduler,
    notifier,
    devices: registry as DeviceHub,
    startedAt,
    version: '0.0.0-test',
    memoryAdmin,
    memoryStore,
    calls,
    touches,
    releases,
    approvals,
    resolved,
    routineRuns,
    registry,
    home,
    cleanup() {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },

    info(): HubInfo {
      return { name: 'test hub', version: '0.0.0-test', startedAt, devices: registry.list().length, defaultModel: config.get().defaultModel, features: ['test'] };
    },

    listSessions(filter: SessionFilter) {
      rec('listSessions', filter);
      return repos.sessions.list(filter);
    },
    getSession: (id) => repos.sessions.get(id),
    async createSession(input: CreateSessionInput, accountId?: string) {
      const now = Date.now();
      const s: Session = {
        id: newId('ses'),
        accountId: accountId ?? currentAccount() ?? 'owner',
        title: input.title ?? 'New chat',
        agent: input.agent ?? 'assistant',
        model: input.model ?? config.get().defaultModel,
        mode: input.mode ?? 'agent',
        permissionMode: input.permissionMode ?? 'default',
        cwd: input.cwd ?? '/home/me',
        device: input.device ?? 'local',
        status: 'idle',
        tags: input.tags ?? [],
        pinned: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
        stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      };
      repos.sessions.insert(s);
      bus.emit({ type: 'session.created', session: s });
      return s;
    },
    async assistantHome(accountId: string) {
      const found = repos.sessions.list({ accountId, agent: 'assistant', home: true, limit: 1 })[0];
      if (found) return found;
      const s = { ...(await engine.createSession({ agent: 'assistant', title: 'Assistant' }, accountId)), pinned: true, meta: { home: true } };
      repos.sessions.update(s);
      return s;
    },
    updateSession(id, patch: SessionPatch) {
      const s = { ...sessionOr404(id), ...patch, updatedAt: Date.now() } as Session;
      if (patch.taskId === null) s.taskId = undefined;
      repos.sessions.update(s);
      bus.emit({ type: 'session.updated', session: s });
      return s;
    },
    async deleteSession(id) {
      repos.sessions.delete(id);
      bus.emit({ type: 'session.deleted', sessionId: id });
    },
    moveToMainList(id) {
      rec('moveToMainList', id);
      const next = movedSession(sessionOr404(id));
      repos.sessions.update(next);
      return next;
    },
    forkSession(id, fromSeq) {
      rec('forkSession', id, fromSeq);
      return { ...sessionOr404(id), id: newId('ses'), parentId: id };
    },
    getMessages: (id, afterSeq) => repos.messages.list(id, { afterSeq }),
    async send(id, input) {
      rec('send', id, input);
      const m: Message = {
        id: newId('msg'),
        sessionId: id,
        seq: repos.messages.nextSeq(id),
        role: 'user',
        kind: 'normal',
        content: [{ type: 'text', text: input.text }],
        createdAt: Date.now(),
      };
      repos.messages.insert(m);
      bus.emit({ type: 'message.created', message: m });
      return { queued: false, messageId: m.id };
    },
    queue: (id) => {
      sessionOr404(id);
      return [];
    },
    unqueue: (id, pendingId) => {
      rec('unqueue', id, pendingId);
      sessionOr404(id);
    },
    sendQueued: (id, pendingId) => {
      rec('sendQueued', id, pendingId);
      sessionOr404(id);
    },
    // tests replace busyWork with the work they need running
    busyWork: () => [],
    isIdle(device) {
      return !this.busyWork(device).length;
    },
    notifyEvent: (kind, notice) => rec('notifyEvent', kind, notice),
    async btw(id, text) {
      rec('btw', id, text);
      sessionOr404(id);
      return { answer: `btw: ${text}` };
    },
    abort: (id) => void rec('abort', id),
    pauseSession(id) {
      rec('pauseSession', id);
      return sessionOr404(id);
    },
    async resumeSession(id) {
      rec('resumeSession', id);
      return sessionOr404(id);
    },
    async rewind(id, seq, restoreFiles) {
      rec('rewind', id, seq, restoreFiles);
      return sessionOr404(id);
    },
    async secondOpinion(id, input) {
      rec('secondOpinion', id, input);
    },
    async handoff(id, model, opts) {
      rec('handoff', id, model, opts);
      return { ...sessionOr404(id), model };
    },
    async tryNextModel(id, messageId) {
      rec('tryNextModel', id, messageId);
      sessionOr404(id);
      return { model: 'mock/next', label: 'Next' };
    },
    async retryProvider(id, messageId, model) {
      rec('retryProvider', id, messageId, model);
      sessionOr404(id);
      return { model, label: model };
    },
    switchEstimate(id, model) {
      rec('switchEstimate', id, model);
      sessionOr404(id);
      const full = { tokens: 100_000, onceUsd: 0.4, stayUsd: 0.02, replyUsd: 0.042, stayReplyUsd: 0.084, paybackReplies: 9 };
      return { from: 'mock/m', to: model, tokens: 100_000, threshold: 50_000, ttl: '1h', full, brief: { ...full, tokens: 35_000, onceUsd: 0.145, replyUsd: 0.0355, paybackReplies: 3, summaryUsd: 0.005 }, askUsd: 0.037, confirm: true, suggestBrief: true, priced: true };
    },
    async compact(id, instructions) {
      rec('compact', id, instructions);
      return true;
    },
    async contextUsage(id) {
      rec('contextUsage', id);
      sessionOr404(id);
      return { model: 'mock/m', window: 200_000, compactAt: 0.8, compactTokens: 160_000, parts: { system: 1000, tools: 2000, messages: 300, toolOutput: 50 }, systemKnown: true, total: 3350, toolCount: 12, mcpTools: 0, deferredTools: 0, messageCount: 4, summarized: false, olderTokens: 0 };
    },
    async command(id, line) {
      rec('command', id, line);
      return { output: `ran ${line}` };
    },
    todos: () => [{ content: 'x', status: 'pending' }],
    checkpoints: (id) => repos.checkpoints.list(id),
    async restoreCheckpoint(id, cp) {
      rec('restoreCheckpoint', id, cp);
    },
    async diff() {
      return { diff: '', files: [] };
    },
    // the real sanitizer (core session/share.ts) over the real repos, so the export routes are tested end to end
    exportSession(id, format, opts) {
      sessionOr404(id);
      rec('exportSession', id, format, opts);
      return exportShared(engine, id, format, opts);
    },
    search: (q) => repos.messages.search(q).map((h) => ({ ...h, title: repos.sessions.get(h.sessionId)?.title ?? '' })),
    searchPast: (q) => searchPastSessions(repos.db, q),

    pendingApprovals: () => [...approvals.values()],
    resolveApproval(id, response) {
      if (!approvals.has(id)) return false;
      approvals.delete(id);
      resolved.push({ id, response });
      return true;
    },
    pendingQuestions: () => [...questions.values()],
    answerQuestion: (id) => questions.delete(id),

    onRefreshModels(fn) {
      refreshers.add(fn);
      return () => refreshers.delete(fn);
    },
    async refreshModels() {
      rec('refreshModels');
      const failed: string[] = [];
      for (const fn of refreshers) await fn().catch((err: unknown) => failed.push(String(err)));
      return { groups: await this.listModels(), failed };
    },

    async listModels() {
      return [
        {
          provider: 'anthropic',
          name: 'Anthropic',
          type: 'anthropic',
          configured: true,
          enabled: true,
          models: [
            {
              id: 'claude-opus-test',
              ref: 'anthropic/claude-opus-test',
              provider: 'anthropic',
              name: 'Opus',
              contextWindow: 200_000,
              maxOutput: 32_000,
              vision: true,
              tools: true,
              thinking: true,
              caching: 'explicit',
              inputPrice: 15,
              outputPrice: 75,
              cacheReadPrice: 1.5,
              cacheWritePrice: 18.75,
              tier: 'deep',
            },
          ],
        },
      ];
    },
    async testProvider(id) {
      return { ok: true, detail: `tested ${id}` };
    },
    listTools: () => [],
    mcpStatus: () => [],
    async reload() {
      rec('reload');
    },
    async syncToClis(device, opts) {
      rec('syncToClis', device, opts);
      return ['~/.claude/agents/x.md'];
    },

    agentDefault(name) {
      const d = builtinAgentDefault(name);
      if (!d) return undefined;
      const active = agents.get(name);
      const overridden = !!active && active.source !== 'builtin';
      return { name, markdown: d.markdown, agent: d.agent, active, overridden, activeSource: active?.source, resettable: overridden && active?.source === 'user' };
    },
    async extensionsOverview(cwd, device) {
      rec('extensionsOverview', cwd, device);
      return {
        counts: { tools: 30, mcpTools: 0, agents: agents.size, skills: 0, commands: 0, hookHandlers: 0, plugins: { installed: 0, enabled: 0 }, mcpServers: { enabled: 0, connected: 0 } },
        compat: { claudeCode: true, agentsMd: true, codex: false, opencode: false, gemini: false },
        clis: { claude: null, codex: null, opencode: null, gemini: null },
        problems: [],
      };
    },
    extensionsInventory(cwd, kind) {
      rec('extensionsInventory', cwd, kind);
      return [...agents.values()].filter(() => !kind || kind === 'agent').map((a) => ({ kind: 'agent' as const, name: a.name, source: a.source, scope: a.source, active: true }));
    },
    extensionSources(cwd) {
      rec('extensionSources', cwd);
      return [{ id: 'builtin', label: 'Built-in', on: true, toggle: null, paths: [], counts: { agents: agents.size, skills: 0, commands: 0 } }];
    },
    async toolsDetail(q) {
      rec('toolsDetail', q);
      return [
        {
          name: 'Bash',
          description: 'Run a shell command',
          readOnly: false,
          source: 'builtin',
          kind: 'builtin',
          group: 'shell',
          agents: [{ name: 'assistant', visible: true }],
          permission: { decision: 'ask', reason: 'Needs approval', rule: null, ruleSource: null },
          hooks: {},
        },
      ];
    },
    async checkTool(input) {
      rec('checkTool', input);
      if (input.tool !== 'Bash') throw new EngineError(404, `unknown tool ${input.tool}`);
      return { decision: 'ask', reason: 'Needs approval', rule: null, ruleSource: null, dangerous: false, hooks: 0 };
    },
    hooksOverview(cwd) {
      rec('hooksOverview', cwd);
      return { events: [{ event: 'PreToolUse', gloss: 'Before a tool runs', matcherValue: 'tool name', fires: true, groups: [], last: [] }] };
    },
    async testHook(input) {
      rec('testHook', input);
      if (input.event !== 'PreToolUse') throw new EngineError(400, 'event must be a hook event');
      return { blocked: false, additionalContext: [], systemMessages: [], trace: [], modelWouldSee: 'No change; the normal permission check decides.' };
    },
    saveHooks(input) {
      rec('saveHooks', input);
      scopeHooks.set(input.scope === 'user' ? 'user' : (input.cwd ?? ''), structuredClone(input.hooks));
      return [];
    },
    readScopeHooks(scope, cwd) {
      return structuredClone(scopeHooks.get(scope === 'user' ? 'user' : (cwd ?? '')) ?? {});
    },
    hookRecipes() {
      return (recipes ??= new HookRecipes({
        hooksDir: join(home, 'hooks'),
        configPath: join(home, 'config.json'),
        readScope: (scope, cwd) => engine.readScopeHooks(scope, cwd),
        saveScope: (scope, cwd, hooks) => void engine.saveHooks({ scope, cwd, hooks }),
        store: repos.kv,
      }));
    },
    builtinHooks() {
      return [];
    },
    setBuiltinHook(id) {
      throw new EngineError(404, `unknown built-in hook ${id}`);
    },
    importHooks(from, cwd) {
      rec('importHooks', from, cwd);
      return { hooks: {}, skipped: [], notes: [] };
    },
    projectTrust(cwd) {
      return { cwd, trusted: trusted.has(cwd), hooks: 0, allow: 0, mcpServers: 0, files: [] };
    },
    setProjectTrust(cwd, value) {
      if (!cwd.startsWith('/')) throw new EngineError(400, 'cwd must be an absolute path');
      if (value) trusted.add(cwd);
      else trusted.delete(cwd);
      return { cwd, trusted: value, hooks: 0, allow: 0, mcpServers: 0, files: [] };
    },
    pluginDetail: () => undefined,
    async updatePlugin(name) {
      throw new EngineError(404, `unknown plugin ${name}`);
    },
    async searchMarketplace(q) {
      rec('searchMarketplace', q);
      return { marketplaces: [], results: [] };
    },
    async restartMcp(name) {
      requireMcp(name);
      rec('restartMcp', name);
      return mcpStatusOf(name);
    },
    async testMcp(name) {
      requireMcp(name);
      return { ok: true, ms: 5, tools: 1 };
    },
    async mcpServerTools(name) {
      requireMcp(name);
      return [{ name: 'echo', fullName: `mcp__${name}__echo`, readOnly: true }];
    },
    async callMcpTool(name, tool, args) {
      requireMcp(name);
      rec('callMcpTool', name, tool, args);
      return { content: `called ${tool}` };
    },
    addMcpServer(name, cfg) {
      if (config.get().mcpServers[name]) throw new EngineError(409, `an mcp server named ${name} already exists`);
      config.update({ mcpServers: { ...config.getUser().mcpServers, [name]: cfg } });
      return mcpStatusOf(name);
    },
    updateMcpServer(name, patch) {
      requireMcp(name);
      rec('updateMcpServer', name, patch);
      return { ...mcpStatusOf(name), enabled: patch.enabled ?? true };
    },
    removeMcpServer(name) {
      if (!config.get().mcpServers[name]) return false;
      const user = config.getUser();
      const servers = { ...(user.mcpServers ?? {}) };
      delete servers[name];
      config.replace({ ...user, mcpServers: servers });
      return true;
    },
    importMcp(from, text) {
      if (from !== 'claude') throw new EngineError(400, 'fake handles claude only');
      return mcpFromClaude(JSON.parse(text));
    },
    mcpConnectPlan(name) {
      requireMcp(name);
      return mcpConnectPlan(name, config.get().mcpServers[name]);
    },
    async connectMcp(name, device, clis) {
      requireMcp(name);
      rec('connectMcp', name, device, clis);
      return clis.map((cli) => ({ cli, exitCode: 0, stdout: 'ok', stderr: '' }));
    },
    memoryConnectPlan(id) {
      memoryAdmin.getConnection(id);
      return [];
    },

    listTasks: (f) => repos.tasks.list(f),
    createTask(input) {
      const t: Task = {
        id: newId('tsk'),
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'inbox',
        priority: input.priority ?? 1,
        labels: input.labels ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      repos.tasks.upsert(t);
      tasks.set(t.id, t);
      return t;
    },
    updateTask(id, patch) {
      const t = { ...repos.tasks.get(id)!, ...patch, updatedAt: Date.now() };
      repos.tasks.upsert(t);
      return t;
    },
    deleteTask: (id) => repos.tasks.delete(id),
    async startTask(id, opts) {
      rec('startTask', id, opts);
      return engine.createSession({ title: repos.tasks.get(id)!.title, taskId: id });
    },

    usageSummary(q): UsageSummary {
      const totals = repos.usage.totals(q);
      return { from: q.from ?? 0, to: q.to ?? Date.now(), totals, byDay: [], byModel: [], bySource: [], byPurpose: [], cacheHitRate: 0, cacheSavingsUsd: 0 };
    },
    usageRecent: (limit) => repos.usage.recent(limit),
    limits: () => repos.usage.limits(),
    refreshLimits: async () => repos.usage.limits(),

    async browse(device, path) {
      const m = registry.get(device)!;
      return (await m.readdir(path || '/home/me')).map((e) => ({ ...e, path: `${path}/${e.name}` }));
    },
    async readDeviceFile(device, path) {
      return { content: await registry.get(device)!.readText(path), truncated: false };
    },
    // shared files are served by the real engine (session-files-routes.test.ts)
    async sharedFile(sessionId) {
      throw new EngineError(404, `unknown session ${sessionId}`);
    },
    externalSessions: async () => [],
    async importSession(source, id, device) {
      rec('importSession', source, id, device);
      return engine.createSession({ title: `imported ${id}` });
    },

    listAudit: (q: { sessionId?: string; limit?: number }) => repos.audit.list(q),
    // the real backup module over this fake's config and sqlite repos
    backup: (opts) => createBackup({ config, repos, version: 'test', hubName: () => 'test-hub' }, opts),
    restore: (data, opts) => restoreBackup({ config, repos, version: 'test', bus }, data, opts),
    async shutdown() {},
  };
  return engine;
}
