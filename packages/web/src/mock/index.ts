/**
 * Fake hub for VITE_MOCK=1. Implements the HTTP contract from
 * @conclave/core/client against in-memory fixtures and streams engine events
 * through a fake WebSocket, so the UI can be built before the hub exists.
 */
import type { ApprovalResponse, ContentBlock, Device, EngineEvent, EngineEventEnvelope, Message, Session, Task, Routine, RoutineRun, MemoryEntry, Todo } from '@conclave/core/types';
import type { AppDto, ContextUsageDto, ModelGroup, SwitchEstimate } from '@conclave/core/client';
import { DEFAULT_CONFIG } from '@conclave/core/config/schema';
import { isDelegated, movedSession, movedToMain } from '@conclave/core/session/delegated';
import { askOnceUsd, isCheapTarget, summaryUsd, SUGGEST_BRIEF_USD, SWITCH_BRIEF_AT, switchMath } from '@conclave/core/modes/switch-math';
import * as D from './data';
import { registerExtensionCatalog } from './ext-catalog';
import { registerExtensionRuntime } from './ext-runtime';
import { registerMemoryConnections } from './memory-connections';
import { registerPunch } from './punch';
import { registerChat } from './chat';
import { registerSharedChats } from './shared';
import { createMockQueue } from './queue';
import { registerRemote } from './remote';
import { registerNotify } from './notify';
import { registerOAuth } from './oauth';
import { registerDiscover } from './discover';
import { registerRoutinesSuggest } from './routines-suggest';
import { registerAssistant } from './assistant';
import { registerPim } from './pim';
import { registerProjects } from './projects';
import { registerImport } from './import';
import { registerWorkflows } from './workflows';
import { registerLearnedSkills } from './learned-skills';
import { registerDigest } from './digest';
import { registerSubscriptions } from './subscriptions';
import { registerAccounts } from './accounts';
import { registerFriends } from './friends';
import { registerMap } from './map';
import { registerGithub } from './github';
import { registerMaps } from './maps';
import { registerWebSearch } from './websearch';
import { registerLogs } from './logs';
import { registerUpdates } from './updates';
import { registerBrowser } from './browser';
import { registerBrowserLive } from './browserLive';
import { registerMeetings } from './meetings';
import { mockIdentity, OWNER_TOKEN, registerIdentity, scenarioError, seedAddresses } from './identity';

const MIN = 60_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Modes. Normal mock: a set up hub with a busy day (ui.onboarded true).
// First run: open the app with ?fresh=1 (remembered in sessionStorage for the
// tab). The hub has no keys, sessions or routines and onboarding runs.
// Progress (config, keys, routines, imports) survives reloads in that tab.
// ?fresh=0 goes back to the normal mock; ?reset=1 clears the saved first-run
// progress and starts it again.
// ---------------------------------------------------------------------------

const FRESH_KEY = 'conclave.mock.fresh';
const FRESH_STATE_KEY = 'conclave.mock.freshState';

function readMode(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    const fresh = q.get('fresh');
    if (fresh === '1' || q.has('reset')) {
      sessionStorage.setItem(FRESH_KEY, '1');
      sessionStorage.removeItem(FRESH_STATE_KEY);
    } else if (fresh === '0') {
      sessionStorage.removeItem(FRESH_KEY);
      sessionStorage.removeItem(FRESH_STATE_KEY);
    }
    if (fresh !== null || q.has('reset')) {
      q.delete('fresh');
      q.delete('reset');
      const rest = q.toString();
      history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    }
    return sessionStorage.getItem(FRESH_KEY) === '1';
  } catch {
    return false;
  }
}

/** True when the mock runs as a hub that has never been set up. */
export const FRESH = readMode();

interface FreshState {
  config: Record<string, unknown>;
  keys: Record<string, string>;
  routines: Routine[];
  imported: Session[];
  paired: Device[];
  /** Phones paired in setup: apps, as on a real hub. */
  apps?: AppDto[];
}

function loadFresh(): Partial<FreshState> {
  try {
    return JSON.parse(sessionStorage.getItem(FRESH_STATE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveFresh() {
  if (!FRESH) return;
  try {
    const st: FreshState = {
      config: db.config,
      keys: db.keys,
      routines: [...db.routines.values()],
      imported: [...db.sessions.values()].filter((x) => x.archived),
      paired: [...db.devices.values()].filter((d) => d.id !== 'local' && d.id !== 'arch-desktop'),
      apps: [...db.apps.values()],
    };
    sessionStorage.setItem(FRESH_STATE_KEY, JSON.stringify(st));
  } catch {
    /* storage full or blocked */
  }
}

const saved = FRESH ? loadFresh() : {};

const BASE_CONFIG = {
  ...DEFAULT_CONFIG,
  defaultAgent: 'assistant',
  permissions: { ...DEFAULT_CONFIG.permissions, mode: 'default' as const, allow: ['Bash(bun test:*)', 'Bash(git status)', 'Bash(git diff:*)', 'Read(~/code/**)'], deny: ['Bash(rm -rf /*)', 'Read(~/.ssh/**)'], ask: ['Bash(git push:*)', 'Bash(pct destroy:*)'] },
  hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command' as const, command: 'bunx biome format --write "$CLAUDE_FILE_PATHS"' }] }] },
  mcpServers: { github: { type: 'http' as const, url: 'https://api.githubcopilot.com/mcp/' }, proxmox: { command: 'pve-mcp', args: ['--host', 'pve.lan'] }, 'basic-memory': { command: 'uvx', args: ['basic-memory', 'mcp'] } },
  notifications: { ...DEFAULT_CONFIG.notifications },
  ui: { theme: 'system' as const, onboarded: true, limitWarn: 70, limitFault: 90 },
  setup: { completedAt: D.NOW - 58 * 86_400_000 },
  // Refusal fallback, the owner's "safety priority" (Settings > Models): Opus on neu, Opus on personal, GLM, then ChatGPT on personal
  models: {
    refusalFallback: {
      enabled: false,
      entries: [
        { model: 'cliproxy/claude-opus-5-5', account: 'claude-kai@neu.edu' },
        { model: 'cliproxy/claude-opus-5-5', account: 'claude-kai@kaivalya.dev' },
        { model: 'zai/glm-5.3' },
        { model: 'cliproxy/gpt-6-astra', account: 'codex-kai@kaivalya.dev' },
      ],
    },
  },
};

const FRESH_CONFIG = {
  ...DEFAULT_CONFIG,
  ui: { theme: 'system' as const, onboarded: false, limitWarn: 70, limitFault: 90 },
};

/** Kai's iPhone, paired as the web app (a set up hub). */
const MOCK_PHONE: AppDto = { id: 'cli_iphone', name: 'iPhone', platform: 'ios', createdAt: D.NOW - 40 * 86_400_000, lastSeenAt: D.NOW - 3 * MIN, revoked: false, accountId: 'owner', online: true };

/** The two machines a first-run hub knows: itself and the computer running setup. */
const FRESH_DEVICES: Device[] = [
  { ...D.devices.find((d) => d.id === 'local')!, createdAt: Date.now() - 20 * MIN },
  { ...D.devices.find((d) => d.id === 'arch-desktop')!, createdAt: Date.now() - 2 * MIN, roots: ['~'] },
];

const db = {
  sessions: new Map<string, Session>(FRESH ? (saved.imported ?? []).map((x) => [x.id, x]) : D.sessions.map((x) => [x.id, structuredClone(x)])),
  messages: new Map<string, Message[]>(FRESH ? [] : Object.entries(D.transcripts).map(([k, v]) => [k, structuredClone(v)])),
  todos: new Map<string, Todo[]>(FRESH ? [] : Object.entries(D.todos)),
  approvals: new Map(FRESH ? [] : D.approvals.map((a) => [a.id, a])),
  questions: new Map(FRESH ? [] : D.questions.map((q) => [q.id, q])),
  tasks: new Map(FRESH ? [] : D.tasks.map((t) => [t.id, t])),
  routines: new Map<string, Routine>(FRESH ? (saved.routines ?? []).map((r) => [r.id, r]) : D.routines.map((r) => [r.id, r])),
  memories: new Map(FRESH ? [] : D.memories.map((m) => [m.id, m])),
  devices: new Map<string, Device>((FRESH ? [...FRESH_DEVICES, ...(saved.paired ?? [])] : D.devices).map((d) => [d.id, structuredClone(d)])),
  // paired apps: phones pair as apps, not devices (GET /api/clients, app.updated)
  apps: new Map<string, AppDto>((FRESH ? (saved.apps ?? []) : [MOCK_PHONE]).map((a) => [a.id, structuredClone(a)])),
  agents: [...D.agents],
  plugins: FRESH ? [] : [...D.plugins],
  gatewayKeys: FRESH ? [] : [...D.gatewayKeys],
  limits: new Map(FRESH ? [] : D.limits.map((l) => [l.provider, l])),
  config: structuredClone(FRESH ? (saved.config ?? FRESH_CONFIG) : BASE_CONFIG) as Record<string, unknown>,
  /** provider -> key value (mock only; the real hub never returns values) */
  keys: (FRESH ? (saved.keys ?? {}) : { anthropic: 'sk-ant-api03-mock', openai: 'sk-proj-mock', google: 'AIzaSyMock', zai: '7c1e0b5f2a9d4e3c8b6a1f0e9d2c4b7a.Mock', openrouter: 'sk-or-v1-mock', deepseek: 'sk-revoked-mock' }) as Record<string, string>,
  values: FRESH ? ([] as string[]) : ['CF_API_TOKEN'],
};

function secrets() {
  return { providers: Object.keys(db.keys), values: db.values };
}

let seq = 1000;
let idSeq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(++idSeq).toString(36)}`;

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

const sockets = new Set<MockWebSocket>();
let scenarioStarted = false;

function emit(e: EngineEvent) {
  const env = { ...e, seq: ++seq, ts: Date.now() } as EngineEventEnvelope;
  for (const s of sockets) s.deliver(env);
}

/** Messages sent while a session works (mock/queue.ts). */
const waiting = createMockQueue(emit, uid);

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      if (this.readyState === 3) return; // closed before it opened (StrictMode remount)
      this.readyState = 1;
      sockets.add(this);
      this.onopen?.(new Event('open'));
      this.raw({ type: 'hello', seq });
      if (!scenarioStarted && !FRESH) {
        scenarioStarted = true;
        void runScenario();
      }
    }, 120);
  }
  raw(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
  deliver(env: EngineEventEnvelope) {
    if (this.readyState === 1) this.raw(env);
  }
  send(_data: string) {
    /* ping, since: nothing to do */
  }
  close() {
    this.readyState = 3;
    sockets.delete(this);
    this.onclose?.(new CloseEvent('close'));
  }
}

// ---------------------------------------------------------------------------
// Simulation helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nextSeq(sessionId: string) {
  const list = db.messages.get(sessionId) ?? [];
  return (list[list.length - 1]?.seq ?? 0) + 1;
}

function addMessage(m: Omit<Message, 'id' | 'seq' | 'createdAt'> & Partial<Pick<Message, 'id'>>): Message {
  const full: Message = { id: m.id ?? uid('m'), seq: nextSeq(m.sessionId), createdAt: Date.now(), ...m } as Message;
  const list = db.messages.get(m.sessionId) ?? [];
  list.push(full);
  db.messages.set(m.sessionId, list);
  emit({ type: 'message.created', message: structuredClone(full) });
  return full;
}

function updateMessage(m: Message) {
  emit({ type: 'message.updated', message: structuredClone(m) });
}

function patchSession(id: string, patch: Partial<Session>) {
  const s = db.sessions.get(id);
  if (!s) return;
  // a turn stopped: unread until opened, as on the hub (core engine setStatus, session/unread.ts)
  const done = s.status === 'running' && patch.status && patch.status !== 'running' && patch.status !== 'paused';
  Object.assign(s, patch, { updatedAt: Date.now() }, done ? { meta: { ...s.meta, ...patch.meta, doneAt: Date.now() } } : {});
  emit({ type: 'session.updated', session: structuredClone(s) });
  return s;
}

async function streamText(m: Message, index: number, kind: 'text' | 'thinking', body: string, speed = 1) {
  const block: ContentBlock = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
  m.content[index] = block;
  const parts = body.match(/\S+\s*|\s+/g) ?? [];
  let buf = '';
  for (let i = 0; i < parts.length; i++) {
    buf += parts[i];
    if (buf.length < 6 && i < parts.length - 1) continue;
    if (block.type === 'text') block.text += buf;
    else if (block.type === 'thinking') block.thinking += buf;
    emit({ type: 'message.delta', sessionId: m.sessionId, messageId: m.id, index, kind, text: buf });
    buf = '';
    await sleep((22 + Math.random() * 40) / speed);
  }
}

async function runTool(sessionId: string, m: Message, name: string, input: Record<string, unknown>, result: { content: string; meta?: Record<string, unknown>; isError?: boolean; progress?: string[]; delay?: number }) {
  const id = uid('tu');
  m.content.push({ type: 'tool_use', id, name, input });
  emit({ type: 'tool.started', sessionId, messageId: m.id, toolUseId: id, name, input });
  updateMessage(m);
  const started = Date.now();
  for (const line of result.progress ?? []) {
    await sleep(140 + Math.random() * 180);
    emit({ type: 'tool.progress', sessionId, toolUseId: id, text: line + '\n' });
  }
  await sleep(result.delay ?? 400);
  const block = { type: 'tool_result' as const, toolUseId: id, content: result.content, isError: result.isError, meta: { durationMs: Date.now() - started, ...result.meta } };
  emit({ type: 'tool.completed', sessionId, toolUseId: id, result: block });
  addMessage({ sessionId, role: 'user', kind: 'normal', content: [block] });
  return id;
}

function assistant(sessionId: string, extra: Partial<Message> = {}): Message {
  const s = db.sessions.get(sessionId)!;
  return addMessage({ sessionId, role: 'assistant', kind: 'normal', content: [], model: s.model, agent: s.agent, ...extra });
}

function finish(m: Message, usage = { inputTokens: 24_000, outputTokens: 300, cacheReadTokens: 22_000 }) {
  m.stopReason = 'end_turn';
  m.usage = usage;
  updateMessage(m);
  emit({
    type: 'usage.recorded',
    record: { id: uid('u'), ts: Date.now(), sessionId: m.sessionId, source: 'api', provider: (m.model ?? '').split('/')[0], model: m.model ?? '', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.012, purpose: 'turn' },
  });
}

const pendingApprovals = new Map<string, (r: ApprovalResponse) => void>();

function requestApproval(sessionId: string, toolUseId: string, tool: string, input: Record<string, unknown>, summary: string, suggestedRule?: string) {
  const approval = { id: uid('ap'), sessionId, toolUseId, tool, input, summary, suggestedRule, createdAt: Date.now() };
  db.approvals.set(approval.id, approval);
  emit({ type: 'approval.requested', approval });
  patchSession(sessionId, { status: 'waiting_approval' });
  emit({ type: 'notice', notice: { id: uid('n'), title: 'Approval needed', body: summary, level: 'warning', sessionId, link: `/s/${sessionId}`, approvalId: approval.id, createdAt: Date.now() } });
  return new Promise<ApprovalResponse>((resolve) => pendingApprovals.set(approval.id, resolve));
}

// ---------------------------------------------------------------------------
// The live coding session scenario
// ---------------------------------------------------------------------------

async function runScenario() {
  const S = 's_auth';
  await sleep(600);
  const m1 = assistant(S);
  await streamText(m1, 0, 'thinking', 'Both review points are valid. Pin HS256 via the options argument, add an issuer check since pair.ts signs with iss=conclave, and short circuit on an empty token.', 3);
  await streamText(m1, 1, 'text', 'Both fair. Pinning `HS256`, checking the issuer, and returning 401 early on an empty token.');
  // calls in a row: one group, open while it runs, closed once the next words start (CHAT-AND-MOTION 6.3)
  await runTool(S, m1, 'Read', { file_path: 'packages/server/src/auth.ts' }, { content: "import { jwtVerify } from 'jose';\nimport type { MiddlewareHandler } from 'hono';\n\nconst SECRET = new TextEncoder().encode(process.env.CONCLAVE_JWT_SECRET!);", delay: 700 });
  await runTool(S, m1, 'Grep', { pattern: 'iss: ', path: 'packages/server/src' }, { content: 'packages/server/src/pair.ts:41:  return new SignJWT({ sub, kind, iss: "conclave" })', delay: 600 });
  await runTool(S, m1, 'Edit', { file_path: 'packages/server/src/auth.ts', old_string: 'const { payload } = await jwtVerify<Claims>(token, SECRET);', new_string: 'const { payload } = await jwtVerify<Claims>(token, SECRET, VERIFY);' }, { content: 'Edited packages/server/src/auth.ts', meta: { diff: D.AUTH_DIFF_2, path: 'packages/server/src/auth.ts' }, delay: 500 });
  finish(m1);
  emit({ type: 'todo.updated', sessionId: S, todos: setTodo(S, 3, 'completed', 4, 'in_progress') });

  await sleep(500);
  joinSteering(S);
  const m2 = assistant(S);
  await streamText(m2, 0, 'text', 'Diff looks right. Re-running the server tests to make sure the stricter verify options did not break the pairing flow, which signs its own short lived tokens.');
  await runTool(S, m2, 'Bash', { command: 'bun test packages/server', description: 'Run the server tests' }, {
    content: 'bun test v1.4.2\n\n 48 pass\n 0 fail\n 118 expect() calls\nRan 48 tests across 7 files. [1.91s]',
    meta: { exitCode: 0 },
    progress: ['bun test v1.4.2', '', 'packages/server/test/auth.test.ts:', '✓ auth > rejects a missing header [0.38ms]', '✓ auth > rejects alg none [0.51ms]', '✓ auth > rejects wrong issuer [1.20ms]', '✓ auth > accepts a valid HS256 token [2.04ms]', 'packages/server/test/sessions.test.ts:', '✓ sessions > create, list, patch [13.9ms]'],
    delay: 300,
  });
  finish(m2);

  await sleep(400);
  joinSteering(S);
  const m3 = assistant(S);
  await streamText(m3, 0, 'text', 'All 48 tests pass, including two new cases for `alg: none` and a wrong issuer. Pushing `feat/jose-auth` needs your OK.');
  const input = { command: 'git push -u origin feat/jose-auth', description: 'Push the branch' };
  const id = uid('tu');
  m3.content.push({ type: 'tool_use', id, name: 'Bash', input });
  updateMessage(m3);
  const answer = await requestApproval(S, id, 'Bash', input, 'Run: git push -u origin feat/jose-auth', 'Bash(git push:*)');
  patchSession(S, { status: 'running' });
  emit({ type: 'tool.started', sessionId: S, messageId: m3.id, toolUseId: id, name: 'Bash', input });
  await sleep(700);
  const denied = answer.decision === 'deny';
  const block = {
    type: 'tool_result' as const,
    toolUseId: id,
    isError: denied,
    content: denied ? `Denied by user${answer.decision === 'deny' && answer.message ? `: ${answer.message}` : ''}` : "To github.com:kai/conclave.git\n * [new branch]      feat/jose-auth -> feat/jose-auth\nbranch 'feat/jose-auth' set up to track 'origin/feat/jose-auth'.",
    meta: { durationMs: 1_240, exitCode: denied ? 1 : 0 },
  };
  emit({ type: 'tool.completed', sessionId: S, toolUseId: id, result: block });
  addMessage({ sessionId: S, role: 'user', kind: 'normal', content: [block] });
  finish(m3);
  joinSteering(S);
  const m4 = assistant(S);
  await streamText(m4, 0, 'text', denied ? 'Okay, not pushing. The branch is committed locally whenever you want it.' : 'Pushed. Want me to open a PR with a summary of the change and the reviewer notes?');
  finish(m4);
  emit({ type: 'todo.updated', sessionId: S, todos: setTodo(S, 4, 'completed') });
  patchSession(S, { status: 'idle' });
  void runNext(S);
}

/** Steering for the running turn joins it at its next step, each as your message. */
function joinSteering(sessionId: string) {
  const steer = waiting.takeSteering(sessionId);
  if (!steer.length) return;
  for (const w of steer) addMessage({ sessionId, role: 'user', kind: 'normal', content: waiting.content(w, true), meta: { whenBusy: 'steer', pendingIds: [w.id] } });
  waiting.done(sessionId, steer.map((w) => w.id));
}

/** A turn ended: the next message that waited runs, as on the hub (it stays listed until its message is written). */
async function runNext(sessionId: string) {
  if (!waiting.next(sessionId)) return;
  patchSession(sessionId, { status: 'running' });
  await sleep(300);
  const w = waiting.next(sessionId);
  if (!w) return patchSession(sessionId, { status: 'idle' });
  addMessage({ sessionId, role: 'user', kind: 'normal', content: waiting.content(w), meta: { pendingIds: [w.id], whenBusy: 'queue' } });
  waiting.done(sessionId, [w.id]);
  void reply(sessionId, w.text);
}

function setTodo(sessionId: string, i: number, status: Todo['status'], j?: number, status2?: Todo['status']) {
  const list = (db.todos.get(sessionId) ?? []).map((t) => ({ ...t }));
  if (list[i]) list[i].status = status;
  if (j !== undefined && list[j] && status2) list[j].status = status2;
  db.todos.set(sessionId, list);
  return list;
}

// ---------------------------------------------------------------------------
// Replies to user actions
// ---------------------------------------------------------------------------

const REPLIES = [
  'Here is the short version.\n\n1. Check the current state first: `systemctl status` and the last boot journal.\n2. Make one change at a time and verify it.\n3. Keep a snapshot so you can roll back.\n\nWant me to run the checks on your device?',
  'Done. I kept the change small and left a note in the commit message. Run `bun test` once more if you want to double check.',
  'Good question. The short answer is **it depends on your threat model**: if the box is only reachable over WireGuard, the simpler option is fine. If it faces the internet, add rate limiting and fail2ban in front.',
];

async function reply(sessionId: string, prompt: string) {
  const s = db.sessions.get(sessionId);
  if (!s) return;
  patchSession(sessionId, { status: 'running' });
  await sleep(500);
  joinSteering(sessionId);
  if (s.mode === 'jury' && s.modeConfig?.jury) {
    const group = uid('g');
    const jurors = s.modeConfig.jury.jurors.map((model, i) => addMessage({ sessionId, role: 'assistant', kind: 'aside', content: [], model, author: `Juror ${i + 1}`, group, meta: { role: 'juror', mode: 'jury' } }));
    await Promise.all(jurors.map((m, i) => streamText(m, 0, 'text', REPLIES[i % REPLIES.length], 1.5).then(() => finish(m))));
    const v = assistant(sessionId, { author: 'Verdict', group, meta: { role: 'verdict', mode: 'jury' } });
    await streamText(v, 0, 'text', `**Verdict.** The jurors agree on the core point: ${prompt.slice(0, 60)}... is best handled step by step, verifying each change. Juror 3 added the most useful detail about threat models.`);
    finish(v);
  } else {
    const m = assistant(sessionId);
    if (s.mode !== 'chat') await streamText(m, 0, 'thinking', 'Thinking about the request and what to check first.', 3);
    await streamText(m, m.content.length, 'text', REPLIES[Math.floor(Math.random() * REPLIES.length)]);
    finish(m);
  }
  patchSession(sessionId, { status: 'idle', stats: { ...s.stats, messages: s.stats.messages + 2 } });
  void runNext(sessionId);
}

async function secondOpinion(sessionId: string, reviewer: string) {
  await sleep(300);
  const m = addMessage({ sessionId, role: 'assistant', kind: 'aside', content: [], model: reviewer, author: 'Second opinion' });
  await streamText(m, 0, 'text', 'I mostly agree. One gap: the answer assumes the service runs as root. Check the unit file for `User=` first, and prefer `systemctl edit` over editing the vendor unit so updates do not overwrite it.');
  finish(m);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** auth: the bearer token the request carried. */
type Handler = (p: { params: string[]; query: URLSearchParams; body: any; auth?: string }) => unknown;
const routes: Array<[string, RegExp, Handler]> = [];
const on = (method: string, path: string, h: Handler) => routes.push([method, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]);

/** A route module returns ctx.pass to hand the request on to the next route that matches. */
const PASS = Symbol('pass');

class HttpError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

/**
 * Shared state and helpers for the route modules in this folder. Each module
 * registers its routes first, so they win over any older handler below.
 */
const ctx = {
  on,
  db,
  emit,
  uid,
  sleep,
  notFound,
  fail: (status: number, msg: string): never => {
    throw new HttpError(status, msg);
  },
  FRESH,
  pass: PASS as symbol,
  /** Call another mock route, as the client would. */
  request: (path: string, init?: RequestInit) => mockFetch(path, init),
  /** Hold a tool call on an approval (the session waits on you) until the owner decides. */
  requestApproval,
  /** A QR code look-alike for a text (it does not scan). */
  qr: fakeQr,
  /** Messages sent while a session works (mock/queue.ts). */
  waiting,
};
export type MockCtx = typeof ctx;
registerExtensionCatalog(ctx);
registerExtensionRuntime(ctx);
registerMemoryConnections(ctx);
registerPunch(ctx);
// shared chats: a chat of Nihir's you are in, an invite, your own chat shared (docs/design/SHARED-WITH-MEMBERS.md 6); before chat, so a post in Nihir's chat runs on your seat
registerSharedChats(ctx);
registerChat(ctx);
registerRemote(ctx);
registerNotify(ctx);
// OAuth on /mcp: the consent page and Settings > Connected apps
registerOAuth(ctx);
// before Discover: these answer /api/routines/suggestions with the hub's own service
registerRoutinesSuggest(ctx);
registerDiscover(ctx);
registerAssistant(ctx);
// calendar and mail: accounts, sign-ins and proposals
registerPim(ctx);
// folders across devices: move, location, projects, device folders
registerProjects(ctx);
// chat import: scan, estimate, batches, uploads, sync, retention, review queue
registerImport(ctx);
// workflows: the library, runs, calls, findings, worktrees
registerWorkflows(ctx);
// skills agents wrote: list, read, edit, turn off, delete
registerLearnedSkills(ctx);
// the daily digest switch in Settings, Memory
registerDigest(ctx);
// subscription sign-in through CLIProxyAPI: status, mode, sign-in, accounts, the models it adds
registerSubscriptions(ctx);
// accounts and their order: Settings > Models > Accounts, and the per-account limits on Usage
registerAccounts(ctx);
// the Map: the snapshot, a replay with ?at, and deltas for the running agents
registerMap(ctx);
// repo sessions: the GitHub connection, repositories, push, pull requests, clean up
registerGithub(ctx);
// maps: Settings > Maps, the Test button, leave-by times and map pictures
registerMaps(ctx);
// Settings > Web search: the engine, its key and the Test button
registerWebSearch(ctx);
// Settings > Logs: size, errors, the debug switch and the lines the app sends
registerLogs(ctx);
registerUpdates(ctx);
registerBrowser(ctx);
registerBrowserLive(ctx);
// meeting mode: meetings, segments, answers, notes (docs/design/MEETING-MODE.md 3)
registerMeetings(ctx);
// the hub's key, its password and logging in with it; the offline and stranger scenarios
registerIdentity(ctx);
// friends: other owners' hubs, requests, a key change, notes both ways
registerFriends(ctx);
seedAddresses();

const hub = { name: 'madx', version: '0.1.0', startedAt: D.NOW - 3 * 24 * 3_600_000, devices: D.devices.length, publicUrl: 'https://madx.tail4e2a.ts.net:7420', defaultModel: 'anthropic/claude-sonnet-5-5', features: ['acp', 'gateway', 'push', 'memory', 'extensions', 'memory-connections', 'mcp-server', 'project-trust', 'subscriptions'] };

on('GET', '/api/info', async () => ({ ...hub, fingerprint: (await mockIdentity()).fingerprint }));
// the owner's account; its layout of Side by side starts with three sessions (?split=0 starts empty)
const mePrefs: { splitView?: string[] } = FRESH || new URLSearchParams(location.search).get('split') === '0' ? {} : { splitView: ['s_auth', 's_backup', 's_os'] };
// ?member=1 signs in as a member (nihir), with their own fallback lists in Settings > Models
const MEMBER = new URLSearchParams(location.search).get('member') === '1';
const memberLists: Record<string, unknown> = { limitFallback: { enabled: true, models: ['anthropic/claude-sonnet-5-5', 'openai/gpt-6-mini'] }, refusalFallback: { enabled: true, entries: [{ model: 'anthropic/claude-sonnet-5-5' }, { model: 'openai/gpt-6-mini' }] } };
on('GET', '/api/me', () => (MEMBER ? { id: 'acc_nihir', name: 'nihir', displayName: 'Nihir', role: 'member', people: true, hubMachine: false, passwordSet: true, providers: [], preferences: {} } : { id: 'owner', name: 'owner', role: 'owner', people: false, hubMachine: true, passwordSet: false, providers: [], preferences: { ...mePrefs } }));
on('PATCH', '/api/me', ({ body }) => {
  if (MEMBER && body?.usageFallback !== undefined) memberLists.limitFallback = body.usageFallback;
  if (MEMBER && body?.refusalFallback !== undefined) memberLists.refusalFallback = body.refusalFallback;
  if (body && 'splitView' in body) {
    if (body.splitView?.length) mePrefs.splitView = [...new Set(body.splitView as string[])];
    else delete mePrefs.splitView;
  }
  return { ok: true };
});
on('POST', '/api/pair', async ({ body }) => {
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(String(body?.code ?? '').toUpperCase())) throw new HttpError(400, 'Invalid or expired code');
  const identity = await mockIdentity();
  return { token: 'mock-token', clientId: uid('c'), hub: { ...hub, fingerprint: identity.fingerprint }, identity };
});
let pairingSeq = 0;
/** Codes the mock made, and when each expires, so the panel can ask for one again with new addresses. */
const mockCodes = new Map<string, { kind: string; expiresAt: number }>();
on('POST', '/api/pairing', ({ body }) => {
  const kind = body?.kind === 'device' ? 'device' : 'client';
  const pairingInfo = (code: string, expiresAt: number) => ({ code, url: hub.publicUrl, deepLink: `conclave://pair?url=${encodeURIComponent(hub.publicUrl)}&code=${code}`, qrSvg: fakeQr(code), expiresAt, kind });
  // the same code again (the hub's addresses changed while it was shown): mock/remote.ts puts the new ones in
  const again = typeof body?.code === 'string' ? mockCodes.get(body.code) : undefined;
  if (again && again.kind === kind && again.expiresAt > Date.now()) return pairingInfo(body.code, again.expiresAt);
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from({ length: 8 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expiresAt = Date.now() + 10 * MIN;
  mockCodes.set(code, { kind, expiresAt });
  const mine = ++pairingSeq;
  // the phone (or another machine) scans the code and pairs a few seconds later; a phone pairs as an app, as on a real hub
  setTimeout(() => {
    if (mine !== pairingSeq) return;
    if (kind === 'client') {
      if ([...db.apps.values()].some((a) => a.id.startsWith('cli_paired'))) return;
      const app: AppDto = { id: uid('cli_paired'), name: 'Pixel 8', platform: 'android', createdAt: Date.now(), lastSeenAt: Date.now(), revoked: false, accountId: 'owner', online: true };
      db.apps.set(app.id, app);
      emit({ type: 'app.updated', app: structuredClone(app) });
      saveFresh();
      return;
    }
    if (db.devices.get('macbook')?.online) return;
    const d: Device = { ...(D.devices.find((x) => x.id === 'macbook') as Device), online: true, lastSeenAt: Date.now() };
    db.devices.set(d.id, d);
    emit({ type: 'device.updated', device: structuredClone(d) });
    saveFresh();
  }, 6_500);
  return pairingInfo(code, expiresAt);
});

// sessions
on('POST', '/api/sessions', ({ body }) => {
  const now = Date.now();
  const agent = D.agents.find((a) => a.name === (body.agent ?? 'assistant'));
  const s: Session = {
    id: uid('s'),
    title: body.title ?? (body.prompt ? String(body.prompt).slice(0, 48) : 'New chat'),
    agent: body.agent ?? 'assistant',
    model: body.model ?? agent?.model ?? hub.defaultModel,
    mode: body.mode ?? 'agent',
    permissionMode: body.permissionMode ?? 'default',
    cwd: body.cwd ?? '~',
    device: body.device ?? agent?.device ?? 'local',
    status: 'idle',
    tags: body.tags ?? [],
    pinned: false,
    archived: false,
    taskId: body.taskId,
    parentId: body.parentId,
    modeConfig: body.modeConfig,
    createdAt: now,
    updatedAt: now,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
  };
  db.sessions.set(s.id, s);
  db.messages.set(s.id, []);
  emit({ type: 'session.created', session: structuredClone(s) });
  if (body.prompt) {
    setTimeout(() => {
      addMessage({ sessionId: s.id, role: 'user', kind: 'normal', content: [{ type: 'text', text: body.prompt }] });
      void reply(s.id, body.prompt);
    }, 50);
  }
  return s;
});
// the one assistant thread: the session marked home, made the first time
on('GET', '/api/assistant/home', async () => {
  const found = [...db.sessions.values()].find((x) => x.agent === 'assistant' && x.meta?.home);
  if (found) return found;
  const res = await mockFetch('/api/sessions', { method: 'POST', body: JSON.stringify({ agent: 'assistant', title: 'Assistant' }) });
  const s: Session = { ...(await res.json()), pinned: true, meta: { home: true } };
  db.sessions.set(s.id, s);
  emit({ type: 'session.updated', session: structuredClone(s) });
  return s;
});
on('PATCH', '/api/sessions/:id', ({ params, body }) => {
  const patch = { ...body };
  if (patch.taskId === null) patch.taskId = undefined;
  // connectors off for this session ride in meta, as on the hub (core session/connectors.ts)
  if ('mcpOff' in patch) {
    const meta = { ...(db.sessions.get(params[0])?.meta ?? {}) } as Record<string, unknown>;
    if (Array.isArray(patch.mcpOff) && patch.mcpOff.length) meta.mcpOff = patch.mcpOff;
    else delete meta.mcpOff;
    delete patch.mcpOff;
    patch.meta = meta;
  }
  // the design direction rides in meta; the screenshot's bytes stay out of it (core session/design-brief.ts)
  if ('design' in patch) {
    const meta = { ...(patch.meta ?? db.sessions.get(params[0])?.meta ?? {}) } as Record<string, unknown>;
    const d = patch.design as { direction: string; url?: string; image?: { name?: string; mediaType: string } | null } | null;
    const kept = (meta.design as { image?: unknown } | undefined)?.image;
    const image = d?.direction !== 'reference' || d.image === null ? undefined : d.image ? { name: d.image.name ?? 'screenshot', mediaType: d.image.mediaType } : kept;
    if (d) meta.design = { direction: d.direction, ...(d.direction === 'reference' && d.url ? { url: d.url } : {}), ...(image ? { image } : {}) };
    else delete meta.design;
    delete patch.design;
    patch.meta = meta;
  }
  if (patch.chat) patch.chat = { ...(db.sessions.get(params[0])?.chat ?? {}), ...patch.chat, ...(patch.chat.thinking === null ? { thinking: undefined } : {}) };
  return patchSession(params[0], patch) ?? notFound();
});
on('DELETE', '/api/sessions/:id', ({ params }) => {
  db.sessions.delete(params[0]);
  emit({ type: 'session.deleted', sessionId: params[0] });
  return { ok: true };
});
// Move to main list: delegated work becomes a normal session of its kind, as on the hub (core session/delegated.ts)
on('POST', '/api/sessions/:id/main-list', ({ params }) => {
  const s = db.sessions.get(params[0]);
  if (!s) return notFound();
  if (movedToMain(s)) return s;
  if (!isDelegated(s)) return ctx.fail(400, 'Only delegated work moves to the main list.');
  if (s.status !== 'idle' && s.status !== 'error') return ctx.fail(409, 'It is still working on the job. Move it once it has answered.');
  const next = movedSession(s);
  db.sessions.set(next.id, next);
  emit({ type: 'session.updated', session: structuredClone(next) });
  return next;
});
// the owner opened it: no longer unread, and it keeps its place in the lists (core session/unread.ts)
on('POST', '/api/sessions/:id/seen', ({ params }) => {
  const s = db.sessions.get(params[0]);
  if (!s) return notFound();
  s.meta = { ...s.meta, seenAt: Date.now() };
  emit({ type: 'session.updated', session: structuredClone(s) });
  return s;
});
on('POST', '/api/sessions/:id/fork', ({ params, body }) => {
  const src = getSession(params[0]);
  const s = { ...structuredClone(src), id: uid('s'), title: `${src.title} (fork)`, status: 'idle' as const, parentId: undefined, createdAt: Date.now(), updatedAt: Date.now() };
  db.sessions.set(s.id, s);
  // new ids, as the hub does; a second opinion keeps pointing at its reply's copy
  const kept = (db.messages.get(src.id) ?? []).filter((m) => body?.fromSeq === undefined || m.seq <= body.fromSeq);
  const ids = new Map(kept.map((m) => [m.id, uid('m')]));
  db.messages.set(
    s.id,
    kept.map((m) => {
      const about = typeof m.meta?.messageId === 'string' ? ids.get(m.meta.messageId) : undefined;
      return { ...structuredClone(m), sessionId: s.id, id: ids.get(m.id)!, ...(about ? { meta: { ...m.meta, messageId: about } } : {}) };
    }),
  );
  emit({ type: 'session.created', session: structuredClone(s) });
  return s;
});
on('GET', '/api/sessions/:id/messages', ({ params }) => structuredClone(db.messages.get(params[0]) ?? []));
on('POST', '/api/sessions/:id/messages', ({ params, body }) => {
  const s = getSession(params[0]);
  // a turn runs or waits on you: the message waits, listed, until its turn (as on the hub)
  if (s.status === 'running' || s.status === 'waiting_approval' || s.status === 'waiting_input') return waiting.wait(s.id, body ?? {});
  const content: ContentBlock[] = [{ type: 'text', text: body.text }];
  for (const a of body.attachments ?? []) if (a.mediaType?.startsWith('image/')) content.push({ type: 'image', mediaType: a.mediaType, data: a.data });
  addMessage({ sessionId: s.id, role: 'user', kind: 'normal', content });
  if (s.stats.messages === 0 && s.title === 'New chat') patchSession(s.id, { title: String(body.text).slice(0, 48) });
  void reply(s.id, body.text);
  return { queued: false };
});
on('GET', '/api/sessions/:id/queue', ({ params }) => {
  getSession(params[0]);
  return waiting.list(params[0]);
});
on('DELETE', '/api/sessions/:id/queue/:pending', ({ params }) => {
  getSession(params[0]);
  if (!waiting.remove(params[0], decodeURIComponent(params[1]))) return ctx.fail(404, 'That message is not waiting any more.');
  return { ok: true };
});
on('POST', '/api/sessions/:id/queue/:pending/send', ({ params }) => {
  const s = getSession(params[0]);
  if (!waiting.release(s.id, decodeURIComponent(params[1]))) return ctx.fail(404, 'That message is not waiting any more.');
  if (s.status === 'idle') void runNext(s.id);
  return { ok: true };
});
on('POST', '/api/sessions/:id/btw', ({ params, body }) => {
  getSession(params[0]);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return ctx.fail(400, 'text is required');
  return { answer: `(mock) A side answer to "${text}". The running turn never sees it.` };
});
on('POST', '/api/sessions/:id/abort', ({ params }) => {
  waiting.hold(params[0]);
  patchSession(params[0], { status: 'idle' });
  addMessage({ sessionId: params[0], role: 'assistant', kind: 'notice', content: [{ type: 'text', text: 'Stopped by you.' }] });
  return { ok: true };
});
on('POST', '/api/sessions/:id/rewind', ({ params, body }) => {
  // like the hub (truncateAfter): keep messages up to and including seq
  const list = (db.messages.get(params[0]) ?? []).filter((m) => m.seq <= body.seq);
  db.messages.set(params[0], list);
  emit({ type: 'config.updated' });
  return getSession(params[0]);
});
on('POST', '/api/sessions/:id/second-opinion', ({ params, body }) => {
  void secondOpinion(params[0], body?.reviewer ?? 'openai/gpt-5.5');
  return { ok: true };
});
on('POST', '/api/sessions/:id/handoff', ({ params, body }) => {
  const from = getSession(params[0]).model;
  const name = (ref: string) => D.modelGroups.flatMap((g) => g.models).find((m) => m.ref === ref)?.name ?? ref;
  // a short handover, as the hub writes it (core modes/handoff.ts): a summary, then the switch notice
  const brief = body.brief === true && !!mockSwitchEstimate(params[0], body.model).brief;
  if (brief) addMessage({ sessionId: params[0], role: 'user', kind: 'summary', content: [{ type: 'text', text: MOCK_HANDOVER }], meta: { switch: { from, to: body.model }, trigger: 'manual' } });
  const s = patchSession(params[0], { model: body.model });
  const how = brief ? ' with a short handover: a 3K token summary and the recent turns, 9 old tool outputs cleared' : '';
  addMessage({ sessionId: params[0], role: 'assistant', kind: 'notice', content: [{ type: 'text', text: `Switched from ${name(from)} to ${name(body.model)}${how}.` }], meta: { type: 'switch', from, model: body.model, ...(brief ? { brief: true, summaryTokens: 3_100, cleared: 9 } : {}) } });
  return s;
});
on('GET', '/api/sessions/:id/switch-estimate', ({ params, query }) => mockSwitchEstimate(params[0], query.get('model') ?? ''));
// "Try the next model" on a refused reply (core engine.tryNextModel): the reply goes, the next model of Refusal fallback answers
on('POST', '/api/sessions/:id/next-model', ({ params }) => {
  const id = params[0];
  const list = db.messages.get(id) ?? [];
  const at = list.findLastIndex((m) => m.role === 'assistant' && m.kind === 'normal');
  if (at < 0 || list[at].stopReason !== 'refusal') return ctx.fail(409, 'The last reply was not refused.');
  const [gone] = list.splice(at, 1);
  emit({ type: 'message.deleted', sessionId: id, messageId: gone.id });
  const to = 'GLM-5.3';
  void (async () => {
    patchSession(id, { status: 'running' });
    const n = addMessage({ sessionId: id, role: 'assistant', kind: 'notice', content: [{ type: 'text', text: `Opus 5.5 (personal) declined. Trying ${to}.` }], meta: { type: 'refusal', outcome: 'trying', from: 'Opus 5.5 (personal)', to, model: 'zai/glm-5.3', level: 'warning' } });
    await sleep(700);
    const m = assistant(id, { model: 'zai/glm-5.3' });
    await streamText(m, 0, 'text', 'Here is a draft advisory: summary, affected versions, the request that triggers the crash in `handle_login()`, impact, and the fix (a bounded copy with a length check).');
    finish(m);
    n.content = [{ type: 'text', text: `Opus 5.5 (personal) declined. Answered by ${to}.` }];
    n.meta = { ...n.meta, outcome: 'answered', level: 'info' };
    updateMessage(n);
    patchSession(id, { status: 'idle' });
  })();
  return { model: 'zai/glm-5.3', label: to };
});
on('POST', '/api/sessions/:id/compact', ({ params, body }) => {
  const kept = typeof body?.instructions === 'string' && body.instructions ? ` Kept: ${body.instructions}.` : '';
  addMessage({ sessionId: params[0], role: 'assistant', kind: 'notice', content: [{ type: 'text', text: `Compacted 41K tokens into a 2.1K summary.${kept}` }], meta: { type: 'compact' } });
  return { ok: true, compacted: true };
});
// /context: what fills the context, from the last reply's usage and the transcript (core session/context-usage.ts)
on('GET', '/api/sessions/:id/context', ({ params }) => mockContext(params[0]));

/** A short handover's summary, in the template's shape (core session/prompt.ts). */
const MOCK_HANDOVER = [
  '## Objective',
  'Move the auth middleware from jsonwebtoken to jose without changing the API.',
  '## Decisions',
  '- Verify with `jwtVerify` and a shared `createRemoteJWKSet`; keep the 30 s clock tolerance.',
  '## Work state',
  '- `packages/server/src/auth.ts` is moved; `refresh.ts` still imports jsonwebtoken.',
  '## Pending asks',
  '- Keep the error messages the apps match on.',
  '## Next step',
  'Move `refresh.ts`, then run `bun test packages/server`.',
].join('\n');

/**
 * What a switch costs (core modes/switch-cost.ts), from the same context
 * numbers as /context and the hub's own arithmetic (switch-math.ts). The
 * short handover keeps the system prompt and tools, a 3K summary with the
 * quoted asks, and the newest turns with old output cleared.
 */
function mockSwitchEstimate(id: string, to: string): SwitchEstimate {
  const s = getSession(id);
  const info = (ref: string) => D.modelGroups.flatMap((g) => g.models).find((m) => m.ref === ref);
  const ctx = mockContext(id);
  const tokens = Math.max(ctx.total, ctx.measured ?? 0);
  const from = info(s.model);
  const target = info(to);
  const ttl = '1h' as const;
  const zero = { tokens, onceUsd: 0, stayUsd: 0, replyUsd: 0, stayReplyUsd: 0 };
  if (!from || !target || to === s.model) return { from: s.model, to, tokens, threshold: SWITCH_BRIEF_AT, ttl, full: zero, askUsd: 0, confirm: false, suggestBrief: false, priced: false };
  const full = switchMath(from, target, tokens, ttl);
  const offered = tokens >= SWITCH_BRIEF_AT && !isCheapTarget(target, full.onceUsd) && full.onceUsd > 0;
  const small = info(DEFAULT_CONFIG.smallModel) ?? target;
  const briefTokens = ctx.parts.system + ctx.parts.tools + 9_000 + Math.min(14_000, ctx.parts.messages + ctx.parts.toolOutput);
  const sUsd = summaryUsd(small, tokens - ctx.parts.system - ctx.parts.tools);
  const brief = offered && briefTokens < tokens ? { ...switchMath(from, target, tokens, ttl, { tokens: briefTokens, extraUsd: sUsd }), summaryUsd: sUsd } : undefined;
  return {
    from: s.model,
    to,
    tokens,
    threshold: SWITCH_BRIEF_AT,
    ttl,
    full,
    ...(brief ? { brief } : {}),
    askUsd: askOnceUsd(target),
    confirm: offered,
    suggestBrief: !!brief && full.onceUsd - brief.onceUsd >= SUGGEST_BRIEF_USD,
    priced: full.onceUsd > 0,
  };
}

function mockContext(id: string): ContextUsageDto {
  const s = getSession(id);
  const msgs = db.messages.get(s.id) ?? [];
  let text = 0;
  let output = 0;
  for (const m of msgs) {
    if (m.kind === 'notice') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') output += typeof b.content === 'string' ? b.content.length : 2000;
      else if (b.type === 'text') text += b.text.length;
      else if (b.type === 'thinking') text += b.thinking.length;
      else if (b.type === 'tool_use') text += JSON.stringify(b.input).length + b.name.length;
    }
  }
  const window = D.modelGroups.flatMap((g) => g.models).find((m) => m.ref === s.model)?.contextWindow ?? 200_000;
  const off = Array.isArray(s.meta?.mcpOff) ? (s.meta.mcpOff as string[]) : [];
  const mcp = D.mcp.filter((m) => m.status === 'connected' && !off.includes(m.name)).reduce((n, m) => n + m.tools, 0);
  // past 30 MCP tools the request carries ToolSearch and the tools it loaded (config mcp.deferAbove)
  const deferred = mcp > 30 ? mcp - 6 : 0;
  const shown = mcp - deferred;
  // a long coding session reads like one: many files read
  const parts = { system: 6_400, tools: 11_800 + shown * 310 + (deferred ? 900 : 0), messages: Math.max(Math.ceil(text / 4), s.id === 's_auth' ? 21_600 : 0), toolOutput: Math.max(Math.ceil(output / 4), s.id === 's_auth' ? 64_900 : 0) };
  const total = parts.system + parts.tools + parts.messages + parts.toolOutput;
  return { model: s.model, window, compactAt: 0.8, compactTokens: Math.round(window * 0.8), parts, systemKnown: true, total, measured: total + 1_240, toolCount: 24 + shown + (deferred ? 1 : 0), mcpTools: shown, deferredTools: deferred, messageCount: msgs.filter((m) => m.kind !== 'notice').length, summarized: false, olderTokens: 0 };
}
on('POST', '/api/sessions/:id/command', ({ body }) => ({ ok: true, output: `Ran ${body.line}` }));
on('GET', '/api/sessions/:id/todos', ({ params }) => db.todos.get(params[0]) ?? []);
on('GET', '/api/sessions/:id/checkpoints', ({ params }) => D.checkpoints[params[0]] ?? []);
on('GET', '/api/sessions/:id/diff', ({ params }) => (params[0] === 's_auth' ? D.sessionDiff : { diff: '', files: [] }));
on('GET', '/api/sessions/:id/export', ({ params, query }) => {
  const s = getSession(params[0]);
  const msgs = db.messages.get(s.id) ?? [];
  if (query.get('format') === 'json') return { content: JSON.stringify({ session: s, messages: msgs }, null, 2), filename: `${s.id}.json` };
  const md = [`# ${s.title}`, '', ...msgs.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => `**${m.role}**: ${(b as { text: string }).text}\n`))].join('\n');
  return { content: md, filename: `${s.id}.md` };
});
on('GET', '/api/search', ({ query }) => {
  const q = (query.get('q') ?? '').toLowerCase();
  if (!q) return [];
  const out: Array<{ sessionId: string; messageId: string; snippet: string; title: string }> = [];
  for (const [sid, list] of db.messages) {
    for (const m of list) {
      for (const b of m.content) {
        if (b.type !== 'text') continue;
        const i = b.text.toLowerCase().indexOf(q);
        if (i >= 0) out.push({ sessionId: sid, messageId: m.id, snippet: b.text.slice(Math.max(0, i - 40), i + 80), title: db.sessions.get(sid)?.title ?? '' });
      }
    }
  }
  return out.slice(0, 20);
});

// approvals and questions
on('GET', '/api/approvals', () => [...db.approvals.values()]);
on('POST', '/api/approvals/:id', ({ params, body }) => {
  const a = db.approvals.get(params[0]);
  if (!a) return notFound();
  db.approvals.delete(a.id);
  emit({ type: 'approval.resolved', id: a.id, sessionId: a.sessionId, response: body });
  const waiter = pendingApprovals.get(a.id);
  if (waiter) waiter(body);
  else if (a.id === 'ap_mail') void mailAnswered(body);
  else patchSession(a.sessionId, { status: body.decision === 'allow' ? 'running' : 'idle' });
  if (!waiter && a.id !== 'ap_mail' && body.decision === 'allow') setTimeout(() => patchSession(a.sessionId, { status: 'idle' }), 2500);
  return { ok: true };
});

/** The assistant chat's email subagent got its answer (mock/data.ts s_mail): it reads the message and reports, and the chat replies. */
async function mailAnswered(r: ApprovalResponse) {
  const child = 's_mail_email';
  const parent = 's_mail';
  const allowed = r.decision === 'allow';
  patchSession(child, { status: 'running' });
  await sleep(500);
  const read = allowed
    ? { type: 'tool_result' as const, toolUseId: 'tu_mail_read', content: 'Message [msg_4f1c] in kai@fastmail.com:\nFrom: TAP Air Portugal <booking@flytap.com>\nSubject: Your booking confirmation, Lisbon\n\nBooking code X7K2PQ. TP 1351, Berlin to Lisbon, 14 November, 09:40.', meta: { durationMs: 420 } }
    : { type: 'tool_result' as const, toolUseId: 'tu_mail_read', content: 'The owner denied this.', isError: true, meta: { denied: true } };
  emit({ type: 'tool.completed', sessionId: child, toolUseId: 'tu_mail_read', result: read });
  addMessage({ sessionId: child, role: 'user', kind: 'normal', content: [read] });
  const report = allowed ? 'Booking code X7K2PQ. TAP flight TP 1351, Berlin to Lisbon, 14 November at 09:40.' : 'I was not allowed to open the TAP confirmation (msg_4f1c), so I have no booking code.';
  const cm = assistant(child);
  await streamText(cm, 0, 'text', report, 2);
  finish(cm, { inputTokens: 6_800, outputTokens: 60, cacheReadTokens: 0 });
  patchSession(child, { status: 'idle' });
  const task = { type: 'tool_result' as const, toolUseId: 'tu_mail_task', content: report, meta: { durationMs: Date.now() - (db.sessions.get(child)?.createdAt ?? Date.now()), sessionId: child, agent: 'email' } };
  emit({ type: 'tool.completed', sessionId: parent, toolUseId: 'tu_mail_task', result: task });
  addMessage({ sessionId: parent, role: 'user', kind: 'normal', content: [task] });
  await sleep(300);
  const pm = assistant(parent);
  await streamText(pm, 0, 'text', allowed ? 'Your booking code is **X7K2PQ**: TAP flight TP 1351 from Berlin to Lisbon on 14 November, leaving at 09:40.' : 'The email agent could not open the TAP confirmation, so I do not have the code. Tell me if it may read that one message and I will ask again.');
  finish(pm);
  patchSession(parent, { status: 'idle' });
}
on('GET', '/api/questions', () => [...db.questions.values()]);
on('POST', '/api/questions/:id', ({ params }) => {
  const q = db.questions.get(params[0]);
  if (!q) return notFound();
  db.questions.delete(q.id);
  emit({ type: 'question.answered', id: q.id, sessionId: q.sessionId });
  void reply(q.sessionId, 'answer');
  return { ok: true };
});

// models, agents, extensions
on('GET', '/api/models', () => modelGroups());
on('POST', '/api/providers/:p/test', async ({ params }) => {
  await sleep(650 + Math.random() * 700);
  return testProvider(params[0]);
});
on('GET', '/api/agents', () => db.agents);
on('POST', '/api/reload', () => ({ ok: true }));

// tasks
on('GET', '/api/tasks', () => [...db.tasks.values()]);
on('POST', '/api/tasks', ({ body }) => {
  const t: Task = { id: uid('t'), description: '', status: 'inbox', priority: 1, labels: [], createdAt: Date.now(), updatedAt: Date.now(), ...body };
  db.tasks.set(t.id, t);
  emit({ type: 'task.updated', task: t });
  return t;
});
on('PATCH', '/api/tasks/:id', ({ params, body }) => {
  const t = db.tasks.get(params[0]);
  if (!t) return notFound();
  Object.assign(t, body, { updatedAt: Date.now() });
  emit({ type: 'task.updated', task: { ...t } });
  return t;
});
on('DELETE', '/api/tasks/:id', ({ params }) => {
  db.tasks.delete(params[0]);
  emit({ type: 'task.deleted', taskId: params[0] });
  return { ok: true };
});
on('POST', '/api/tasks/:id/start', async ({ params, body }) => {
  const t = db.tasks.get(params[0]);
  if (!t) return notFound();
  t.status = 'doing';
  emit({ type: 'task.updated', task: { ...t } });
  // through the router: the chat module's POST /api/sessions passes agent sessions on
  const res = await mockFetch('/api/sessions', { method: 'POST', body: JSON.stringify({ agent: body.agent ?? t.agent, model: body.model, taskId: t.id, title: t.title, prompt: `${t.title}\n\n${t.description}`.trim() }) });
  return res.json();
});

// routines
on('GET', '/api/routines', () => [...db.routines.values()]);
on('GET', '/api/routines/preview', ({ query }) => {
  const r = previewSchedule(query.get('schedule') ?? '');
  return r;
});
on('POST', '/api/routines', ({ body }) => {
  const r: Routine = { id: uid('r'), agent: 'assistant', mode: 'agent', enabled: true, sessionPolicy: 'new', notify: 'always', createdAt: Date.now(), updatedAt: Date.now(), ...body, nextRunAt: previewSchedule(body.schedule).next[0] };
  db.routines.set(r.id, r);
  emit({ type: 'routine.updated', routine: r });
  saveFresh();
  return r;
});
on('PATCH', '/api/routines/:id', ({ params, body }) => {
  const r = db.routines.get(params[0]);
  if (!r) return notFound();
  Object.assign(r, body, { updatedAt: Date.now() });
  if (body.schedule) r.nextRunAt = previewSchedule(body.schedule).next[0];
  emit({ type: 'routine.updated', routine: { ...r } });
  return r;
});
on('DELETE', '/api/routines/:id', ({ params }) => {
  db.routines.delete(params[0]);
  saveFresh();
  emit({ type: 'routine.deleted', routineId: params[0] });
  return { ok: true };
});
on('POST', '/api/routines/:id/run', ({ params }) => {
  const r = db.routines.get(params[0]);
  if (!r) return notFound();
  const run: RoutineRun = { id: uid('rr'), routineId: r.id, status: 'running', trigger: 'manual', startedAt: Date.now() };
  const list = (D.routineRuns[r.id] ??= []);
  list.unshift(run);
  emit({ type: 'routine.run', run });
  setTimeout(() => {
    Object.assign(run, { status: 'ok', finishedAt: Date.now(), summary: 'Finished, nothing new' });
    emit({ type: 'routine.run', run: { ...run } });
    r.lastRunAt = Date.now();
    emit({ type: 'routine.updated', routine: { ...r } });
  }, 2500);
  return run;
});
on('GET', '/api/routines/:id/runs', ({ params }) => D.routineRuns[params[0]] ?? []);

// memory
on('GET', '/api/memory', () => [...db.memories.values()]);
on('GET', '/api/memory/search', ({ query }) => {
  const q = (query.get('q') ?? '').toLowerCase();
  return [...db.memories.values()].filter((m) => m.content.toLowerCase().includes(q)).map((m) => ({ ...m, score: 0.8 }));
});
on('POST', '/api/memory', ({ body }) => {
  const m: MemoryEntry = { id: uid('mm'), scope: 'global', kind: 'fact', tags: [], importance: 0.5, useCount: 0, createdAt: Date.now(), updatedAt: Date.now(), ...body };
  db.memories.set(m.id, m);
  emit({ type: 'memory.updated', entry: m });
  return m;
});
on('PATCH', '/api/memory/:id', ({ params, body }) => {
  const m = db.memories.get(params[0]);
  if (!m) return notFound();
  Object.assign(m, body, { updatedAt: Date.now() });
  emit({ type: 'memory.updated', entry: { ...m } });
  return m;
});
// the memory map: the builder needs the hub's SQLite, so the mock is empty unless a page sets window.__MEMORY_GRAPH__ (screenshots feed a real one)
// screenshots put a real graph in globalThis.__MEMORY_GRAPH__ (an init script)
on('GET', '/api/memory/graph', () => (globalThis as { __MEMORY_GRAPH__?: unknown }).__MEMORY_GRAPH__ ?? { nodes: [], edges: [], labels: [], basicMemory: { state: 'none' } });
on('DELETE', '/api/memory/:id', ({ params }) => {
  db.memories.delete(params[0]);
  emit({ type: 'memory.deleted', id: params[0] });
  return { ok: true };
});

// usage
on('GET', '/api/usage', ({ query }) => (FRESH ? emptyUsage(Number(query.get('from') ?? 0) || Date.now() - 30 * 86_400_000) : D.usageSummary(Number(query.get('from') ?? 0) || D.NOW - 30 * 86_400_000, Number(query.get('to') ?? 0) || Date.now())));
on('GET', '/api/usage/recent', ({ query }) => (FRESH ? [] : D.recentUsage(Number(query.get('limit') ?? 50))));
on('GET', '/api/limits', () => (FRESH ? freshLimits() : [...db.limits.values()]));
on('POST', '/api/limits/refresh', async () => {
  await sleep(600);
  for (const l of db.limits.values()) l.updatedAt = Date.now();
  return [...db.limits.values()];
});

// devices
on('GET', '/api/devices', () => [...db.devices.values()]);
// the browser in the mock runs on the first computer that is not the hub
on('GET', '/api/devices/here', () => {
  const d = [...db.devices.values()].find((x) => x.id !== 'local' && x.online && x.info?.platform !== 'ios' && x.info?.platform !== 'android');
  return d ? { device: d.id } : {};
});
on('PATCH', '/api/devices/:id', ({ params, body }) => {
  const d = db.devices.get(params[0]);
  if (!d) return notFound();
  Object.assign(d, body);
  emit({ type: 'device.updated', device: structuredClone(d) });
  saveFresh();
  return d;
});
on('DELETE', '/api/devices/:id', ({ params }) => {
  db.devices.delete(params[0]);
  emit({ type: 'device.deleted', deviceId: params[0] });
  saveFresh();
  return { ok: true };
});
on('GET', '/api/clients', () => [...db.apps.values()]);
on('DELETE', '/api/clients/:id', ({ params }) => {
  const a = db.apps.get(params[0]);
  if (!a) return notFound();
  db.apps.delete(a.id);
  emit({ type: 'app.updated', app: { ...a, revoked: true, online: false } });
  saveFresh();
  return { ok: true };
});
// gateway
on('GET', '/api/gateway/keys', () => db.gatewayKeys);
on('POST', '/api/gateway/keys', ({ body }) => {
  const key = `cgw_${Math.random().toString(36).slice(2, 6)}${Math.random().toString(36).slice(2, 30)}`;
  const k = { id: uid('gk'), name: body.name, prefix: key.slice(0, 8), device: body.device, agent: body.agent, createdAt: Date.now(), revoked: false };
  db.gatewayKeys.unshift(k);
  return { ...k, key };
});
on('DELETE', '/api/gateway/keys/:id', ({ params }) => {
  const k = db.gatewayKeys.find((x) => x.id === params[0]);
  if (k) k.revoked = true;
  return { ok: true };
});

// config
// only the owner token sees server.token, as on the hub (the app reads it to know it is the owner)
on('GET', '/api/config', ({ auth }) => ({ config: MEMBER ? { ...db.config, models: { ...(db.config.models as object), ...memberLists } } : auth === OWNER_TOKEN ? { ...db.config, server: { ...(db.config.server as object), token: OWNER_TOKEN } } : db.config, user: {}, secrets: secrets() }));
on('PATCH', '/api/config', ({ body }) => {
  deepMerge(db.config, body);
  saveFresh();
  return { ok: true };
});
on('PUT', '/api/secrets', ({ body }) => {
  const key = String(body.key);
  if (body.kind === 'values') {
    db.values = body.value === null ? db.values.filter((k) => k !== key) : [...new Set([...db.values, key])];
  } else if (body.value === null || body.value === '') delete db.keys[key];
  else db.keys[key] = String(body.value);
  saveFresh();
  return { ok: true };
});
on('GET', '/api/audit', () => D.audit);

// ---------------------------------------------------------------------------
// Providers, imports, first-run data
// ---------------------------------------------------------------------------

interface KeyRule {
  re: RegExp;
  /** what the key should start with, for the error sentence */
  prefix?: string;
  name: string;
  host: string;
  console: string;
  models: number;
}

const KEY_RULES: Record<string, KeyRule> = {
  anthropic: { re: /^sk-ant-/, prefix: 'sk-ant-', name: 'Anthropic', host: 'api.anthropic.com', console: 'console.anthropic.com', models: 3 },
  openai: { re: /^sk-(?!ant-|or-)/, prefix: 'sk-proj-', name: 'OpenAI', host: 'api.openai.com', console: 'platform.openai.com', models: 7 },
  openrouter: { re: /^sk-or-/, prefix: 'sk-or-', name: 'OpenRouter', host: 'openrouter.ai', console: 'openrouter.ai/keys', models: 312 },
  google: { re: /^AIza/, prefix: 'AIza', name: 'Google', host: 'generativelanguage.googleapis.com', console: 'aistudio.google.com', models: 6 },
  zai: { re: /^[0-9a-f]{32}\.\w+$/i, name: 'Z.ai', host: 'api.z.ai', console: 'z.ai/manage-apikey', models: 3 },
  deepseek: { re: /^sk-(?!ant-|or-)/, prefix: 'sk-', name: 'DeepSeek', host: 'api.deepseek.com', console: 'platform.deepseek.com', models: 2 },
  moonshot: { re: /^sk-(?!ant-|or-)/, prefix: 'sk-', name: 'Moonshot', host: 'api.moonshot.ai', console: 'platform.moonshot.ai', models: 4 },
  mistral: { re: /^[A-Za-z0-9]{32}$/, name: 'Mistral', host: 'api.mistral.ai', console: 'console.mistral.ai', models: 9 },
  groq: { re: /^gsk_/, prefix: 'gsk_', name: 'Groq', host: 'api.groq.com', console: 'console.groq.com', models: 14 },
  xai: { re: /^xai-/, prefix: 'xai-', name: 'xAI', host: 'api.x.ai', console: 'console.x.ai', models: 5 },
  qwen: { re: /^sk-(?!ant-|or-)/, prefix: 'sk-', name: 'Qwen', host: 'dashscope-intl.aliyuncs.com', console: 'bailian.console.alibabacloud.com', models: 8 },
};

/** What a pasted key looks like, for errors that explain. */
function looksLike(key: string): string | undefined {
  if (key.startsWith('sk-ant-')) return 'an Anthropic key';
  if (key.startsWith('sk-or-')) return 'an OpenRouter key';
  if (key.startsWith('AIza')) return 'a Google key';
  if (key.startsWith('gsk_')) return 'a Groq key';
  if (key.startsWith('xai-')) return 'an xAI key';
  if (key.startsWith('sk-proj-')) return 'an OpenAI key';
  if (/^[0-9a-f]{32}\.\w+$/i.test(key)) return 'a Z.ai key';
  return undefined;
}

const HARNESS_TESTS: Record<string, () => { ok: boolean; detail: string }> = {
  'claude-code': () => ({ ok: true, detail: 'Signed in, Claude Max' }),
  codex: () => ({ ok: true, detail: 'Signed in, ChatGPT Pro' }),
  'gemini-cli': () => ({ ok: true, detail: 'Signed in with Google' }),
  opencode: () => (FRESH ? { ok: true, detail: 'Found 1.3.2, uses the Z.ai GLM Coding plan' } : { ok: false, detail: 'OpenCode is not installed on madx. Install it on a device that runs sessions.' }),
};

/**
 * POST /api/providers/:p/test. Keys are checked against the rules above so
 * the onboarding and Settings flows can show every result:
 * a working key ("7 models"), a wrong provider's key, a revoked key
 * (any key containing "revoked" or "bad"), no key, and Ollama without a key.
 */
function testProvider(p: string): { ok: boolean; detail: string; latencyMs?: number; models?: number; host?: string; status?: number } {
  const latencyMs = 140 + Math.round(Math.random() * 260);
  if (HARNESS_TESTS[p]) return { ...HARNESS_TESTS[p](), latencyMs };
  if (p === 'ollama' || p === 'lmstudio') return { ok: true, detail: 'Found 4 models on gpu-lxc', models: 4, latencyMs: 38, host: 'gpu-lxc:11434' };
  const rule = KEY_RULES[p];
  const key = db.keys[p];
  if (!key) return { ok: false, detail: 'No key set.', host: rule?.host };
  if (!rule) return { ok: true, detail: 'Works', latencyMs };
  if (/revoked|bad|invalid/i.test(key)) return { ok: false, status: 401, detail: `Rejected with 401. The key was revoked. Create a new one at ${rule.console}.`, host: rule.host };
  if (!rule.re.test(key)) {
    const seems = looksLike(key);
    const hint = rule.prefix ? `${rule.name} keys start with ${rule.prefix}.` : `Copy the key again from ${rule.console}.`;
    return { ok: false, status: 401, detail: `Rejected with 401. ${seems ? `This looks like ${seems}. ` : ''}${hint}`, host: rule.host };
  }
  return { ok: true, detail: `${rule.models} models`, models: rule.models, latencyMs, host: rule.host };
}

const KEY_PROVIDERS = new Set(Object.keys(KEY_RULES));

function modelGroups(): ModelGroup[] {
  if (!FRESH) return D.modelGroups;
  return D.modelGroups.map((g) => {
    if (!KEY_PROVIDERS.has(g.provider)) return { ...g, configured: true, enabled: true, error: undefined };
    const t = testProvider(g.provider);
    return { ...g, configured: !!db.keys[g.provider], enabled: t.ok, error: db.keys[g.provider] && !t.ok ? t.detail : undefined };
  });
}

/** After setup, the plans the CLI logins brought in, barely used on day one. */
function freshLimits() {
  const ui = (db.config.ui ?? {}) as { onboarded?: boolean };
  if (!ui.onboarded) return [];
  const now = Date.now();
  return [
    { provider: 'claude-max', label: 'Claude Max', windows: [{ name: '5h', usedPercent: 4, resetsAt: now + 4 * 3_600_000 + 12 * MIN }, { name: '7d', usedPercent: 9, resetsAt: now + 5 * 86_400_000 }], updatedAt: now - MIN, source: 'oauth' as const },
    { provider: 'codex', label: 'ChatGPT Pro · Codex', windows: [{ name: '5h', usedPercent: 0, resetsAt: now + 5 * 3_600_000 }, { name: 'weekly', usedPercent: 2, resetsAt: now + 6 * 86_400_000 }], updatedAt: now - 3 * MIN, source: 'logs' as const },
  ];
}

function emptyUsage(from: number) {
  const zero = { key: 'total', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0 };
  return { from, to: Date.now(), totals: zero, byDay: [], byModel: [], bySource: [], byPurpose: [], cacheHitRate: 0, cacheSavingsUsd: 0 };
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  const method = (init?.method ?? 'GET').toUpperCase();
  await sleep(40 + Math.random() * 80);
  // the client always asks with a full URL; a route calling another (ctx.request) uses a path and is never cut off
  const unreachable = typeof input === 'string' && !input.startsWith('/') ? scenarioError(url) : undefined;
  if (unreachable) throw unreachable;
  const auth = new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') || undefined;
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = url.pathname.match(re);
    if (!match) continue;
    try {
      // uploads send a file, not JSON
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const result = await h({ params: match.slice(1).map(decodeURIComponent), query: url.searchParams, body, auth });
      if (result === PASS) continue;
      // a route that sends something other than JSON (a map picture) builds its own response
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'error' }), { status, headers: { 'content-type': 'application/json' } });
    }
  }
  return new Response(JSON.stringify({ error: `mock: no route for ${method} ${url.pathname}` }), { status: 404 });
}

function getSession(id: string): Session {
  const s = db.sessions.get(id);
  if (!s) throw new HttpError(404, 'Session not found');
  return s;
}

function notFound(): never {
  throw new HttpError(404, 'Not found');
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Schedules, files, QR
// ---------------------------------------------------------------------------

function field(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      if (Number.isNaN(a)) return null;
      lo = a;
      hi = b === undefined || Number.isNaN(b) ? (stepStr ? max : a) : b;
    }
    if (lo < min || hi > max || !step) return null;
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

export function previewSchedule(schedule: string): { next: number[]; error?: string } {
  const s = schedule.trim();
  const now = Date.now();
  if (s.startsWith('@every')) {
    const m = s.slice(6).trim().match(/^(\d+)\s*(s|m|h|d)$/);
    if (!m) return { next: [], error: 'Use a duration like 30m, 2h or 1d' };
    const ms = Number(m[1]) * { s: 1000, m: MIN, h: 60 * MIN, d: 1440 * MIN }[m[2] as 's'];
    return { next: [1, 2, 3, 4, 5].map((i) => now + i * ms) };
  }
  if (s.startsWith('@once')) {
    const t = new Date(s.slice(5).trim()).getTime();
    if (Number.isNaN(t)) return { next: [], error: 'Use an ISO date like 2026-10-20T09:00' };
    return { next: t > now ? [t] : [], error: t > now ? undefined : 'That time is in the past' };
  }
  const f = s.split(/\s+/);
  if (f.length !== 5) return { next: [], error: 'Cron needs 5 fields: minute hour day month weekday' };
  const sets = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4].replace('7', '0'), 0, 6)];
  if (sets.some((x) => !x)) return { next: [], error: 'Could not parse that cron expression' };
  const [mi, h, dom, mon, dow] = sets as Set<number>[];
  const out: number[] = [];
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 600_000 && out.length < 5; i++) {
    if (mon.has(d.getMonth() + 1) && dom.has(d.getDate()) && dow.has(d.getDay()) && h.has(d.getHours()) && mi.has(d.getMinutes())) out.push(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return { next: out };
}

function fakeQr(code: string): string {
  const n = 29;
  let s = [...code].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2147483647, 7);
  const r = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  const cells: boolean[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => r() > 0.52));
  const finder = (x: number, y: number) => {
    for (let i = -1; i <= 7; i++)
      for (let j = -1; j <= 7; j++) {
        const xx = x + i;
        const yy = y + j;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        cells[yy][xx] = ring !== 2 && ring !== 4;
      }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (cells[y][x]) d += `M${x + 2} ${y + 2}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
