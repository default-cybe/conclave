/**
 * The accounts route sweep (docs/design/ACCOUNTS.md 11). A real engine and
 * server with the owner and two members, alice and bob. Each has a chat
 * with messages and usage, memory, a task, a routine, a goal, a device, an
 * app, an open approval and question, a project, a path pair, an import
 * batch, a workflow run, an alert, a connected app, a calendar account and a
 * calendar proposal, and a key of their own.
 *
 * - Every route the app has is in the route table (route-policy.ts).
 * - Every list (a GET with no id) answers alice without a word or an id of
 *   bob's or the owner's, and the owner without one of a member's.
 * - Every route with an id, given someone else's id, answers 404 and
 *   changes nothing: alice with bob's and the owner's, the owner with bob's.
 * - Every owner route answers alice 403.
 * - Ids in bodies and queries (parent session, device, task, workflow
 *   session) are refused.
 * - The socket and its replay carry only the account's own events.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@conclave/core/engine/index.ts';
import { setAlerts } from '@conclave/core/alerts/attached.ts';
import { pimFor } from '@conclave/core/pim/registry.ts';
import { accountKey } from '@conclave/core/people/store.ts';
import type { AlertService } from '@conclave/core/alerts/service.ts';
import type { AlertItem } from '@conclave/core/client/alerts.ts';
import { ACCOUNT_TABLES, CHILD_TABLES, HUB_TABLES } from '@conclave/core/people/tables.ts';
import { OAuthStore } from '../src/oauth/store';
import { OWN_AUTH_ROUTES, ROUTE_POLICY, ruleFor, type OwnedKind } from '../src/route-policy';
import { startServer, type RunningServer } from '../src/app';
import { openWs } from './helpers';

const OWNER = 'owner-token-sweep-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

type Who = 'owner' | 'alice' | 'bob';
interface Seeded {
  token: string;
  marker: string;
  accountId: string;
  ids: Partial<Record<OwnedKind, string>>;
  /** Every id of theirs, for the leak check. */
  all: string[];
}

let root: string;
let mock: ReturnType<typeof Bun.serve>;
let engine: Engine;
let running: RunningServer;
let base: string;
const who: Record<Who, Seeded> = {} as never;
const aborts: AbortController[] = [];

/** The scripted model: every request gets "ok". */
function okReply(): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

async function call(token: string | null, method: string, path: string, json?: unknown): Promise<{ status: number; text: string; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, text, body };
}

async function ok<T = any>(token: string, method: string, path: string, json?: unknown): Promise<T> {
  const r = await call(token, method, path, json);
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body as T;
}

const sql = (q: string, ...args: unknown[]) => engine.repos.db.query(q).run(...(args as never[]));

/** Everything one account has, made through the API where there is one. */
async function seed(name: Who, token: string, accountId: string): Promise<Seeded> {
  const M = `ZQX${name.toUpperCase()}`;
  const ids: Seeded['ids'] = {};
  const all: string[] = [];
  const keep = (kind: OwnedKind | null, id: string) => {
    if (kind) ids[kind] = id;
    all.push(id);
    return id;
  };

  const s = await ok(token, 'POST', '/api/sessions', { title: `${M} chat`, kind: 'chat' });
  keep('session', s.id);
  await ok(token, 'POST', `/api/sessions/${s.id}/messages`, { text: `zebra ${M} hello` });
  await engine.runnerFor(s.id).waitIdle();

  keep('memory', (await ok(token, 'POST', '/api/memory', { content: `zebra ${M} likes green tea`, kind: 'fact' })).id);
  keep('task', (await ok(token, 'POST', '/api/tasks', { title: `zebra ${M} task` })).id);
  keep('routine', (await ok(token, 'POST', '/api/routines', { name: `${M} routine`, schedule: '0 7 * * *', prompt: `zebra ${M} brief` })).id);
  keep('goal', (await ok(token, 'POST', '/api/goals', { title: `zebra ${M} goal`, area: 'other' })).id);

  // a device and an app of theirs
  const code = (await ok(token, 'POST', '/api/pairing', { kind: 'device' })).code;
  const reg = await ok(token, 'POST', '/api/daemon/register', { code, name: `${M}-box` });
  keep('device', reg.deviceId);
  const appCode = (await ok(token, 'POST', '/api/pairing', { kind: 'client' })).code;
  const paired = await ok(null as never, 'POST', '/api/pair', { code: appCode, name: `${M} app`, platform: 'web' });
  keep('client', paired.clientId);

  // an open approval and question in their chat
  const a1 = new AbortController();
  const a2 = new AbortController();
  aborts.push(a1, a2);
  void engine.requestApproval(s.id, { toolUseId: `tu_${name}`, tool: 'Bash', input: { command: `echo ${M}` }, summary: `Run: echo ${M}` }, a1.signal).catch(() => {});
  void engine.askUser(s.id, [{ question: `${M} which one?`, options: [{ label: 'a' }, { label: 'b' }] }], a2.signal).catch(() => {});
  keep('approval', engine.pendingApprovals(accountId).find((x) => x.sessionId === s.id)!.id);
  keep('question', engine.pendingQuestions(accountId).find((x) => x.sessionId === s.id)!.id);

  // rows whose services have no create route a test can drive alone
  const now = Date.now();
  keep('project', `prj_${name}`);
  sql('INSERT INTO projects (id, name, identity, created_at, updated_at, account_id) VALUES (?,?,?,?,?,?)', `prj_${name}`, `${M} project`, `git:${M}`, now, now, accountId);
  keep('pathPrefix', `pfx_${name}`);
  sql('INSERT INTO path_prefixes (id, from_device, from_prefix, to_device, to_prefix, created_at) VALUES (?,?,?,?,?,?)', `pfx_${name}`, reg.deviceId, `/home/${M}`, reg.deviceId, `/Users/${M}`, now);
  keep('importBatch', `imb_${name}`);
  sql("INSERT INTO import_batches (id, device, mode, status, created_at, updated_at, account_id) VALUES (?,?,'learn','done',?,?,?)", `imb_${name}`, reg.deviceId, now, now, accountId);
  keep('workflowRun', `wfr_${name}`);
  sql(
    "INSERT INTO workflow_runs (id, name, source, script, script_sha, session_id, device, cwd, status, created_at) VALUES (?,?,'inline','x','x',?,'local','/',?,?)",
    `wfr_${name}`,
    `${M} workflow`,
    s.id,
    'done',
    now,
  );
  keep('alert', `alrt_${name}`);

  // a calendar account and a proposal waiting for approval (pim/store.ts), each in the account's own store
  const pimId = `acct_pim${name}`;
  engine.repos.kv.set(accountKey(accountId, 'pim.accounts'), [{ id: pimId, kind: 'caldav', label: `${M} calendar`, serverUrl: 'https://dav.example.com', username: M, createdAt: now, updatedAt: now }]);
  keep('pimAccount', pimId);
  const proposal = pimFor(engine, accountId)!.store.addProposal({ kind: 'event', sessionId: s.id, payload: { dto: { kind: 'event', action: 'create', summary: `${M} dentist on Friday` } } });
  keep('proposal', proposal.id);

  // a saved launch preset on a built-in workflow, this account's own (routes-workflows.ts)
  const preset = await ok(token, 'POST', '/api/workflows/deep-research/presets', { name: `${M} preset`, args: { question: `zebra ${M}` } });
  keep('preset', preset.id);

  // a meeting (routes-meetings.ts), this account's own
  keep('meeting', (await ok(token, 'POST', '/api/meetings', { device: ids.device, cwd: '/tmp', title: `${M} meeting` })).id);

  // a chat invite waiting for this account (routes-shared-chats.ts): the row is the invitee's while it waits
  sql("INSERT INTO chat_participants (session_id, account_id, friend_id, access, state, history, joined_seq, added_by, added_at, updated_at) VALUES (?,?,'','participant','invited','joined',1,?,?,?)", s.id, accountId, accountId, now, now);
  keep('chatInvite', s.id);

  // a connected app (claude.ai) that this account allowed
  const store = new OAuthStore(engine.repos.db);
  const client = store.register({ name: `${M} connector`, redirectUris: ['https://claude.ai/api/mcp/auth_callback'], applicationType: 'web', authMethod: 'none' }).client;
  const grant = store.createGrant({ id: `oag_${name}`, client: client.id, scope: ['memory:read'], resource: `${base}/mcp`, redirectUri: client.redirectUris[0], approvedBy: name, accountId });
  store.issue(grant.id, ['memory:read']);
  keep(null, client.id);

  return { token, marker: M, accountId, ids, all };
}

beforeAll(async () => {
  process.env.CONCLAVE_CATALOG_OFFLINE ??= '1';
  root = mkdtempSync(join(tmpdir(), 'conclave-people-sweep-'));
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  mock = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.text();
      return okReply();
    },
  });
  engine = await createEngine({
    home: join(root, 'home'),
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'mock/claude-sonnet-5-5',
      smallModel: 'mock/claude-sonnet-5-5',
      providers: { mock: { type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'sk-hub-owner-key', models: ['claude-sonnet-5-5'] } },
      permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [] },
      memory: { enabled: true, autoExtract: false, autoInject: false, injectLimit: 0 },
      models: { tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'mock/claude-sonnet-5-5' } },
    } as never,
  });
  engine.config.update({ server: { ...engine.config.get().server, token: OWNER } });
  running = startServer(engine, { host: '127.0.0.1', port: 0 });
  base = running.url;

  // the owner adds two people who may use the hub's key, then they sign in
  const tokens: Record<string, { token: string; accountId: string }> = { owner: { token: OWNER, accountId: 'owner' } };
  for (const name of ['alice', 'bob']) {
    const made = await ok(OWNER, 'POST', '/api/people', { name, password: PASSWORD, providers: { mock: { monthlyUsd: 50 } } });
    const login = await ok(null as never, 'POST', '/api/login', { account: name, password: PASSWORD, name: `${name} laptop`, platform: 'web' });
    expect(login.account).toEqual({ id: made.person.id, name, displayName: name, role: 'member' });
    tokens[name] = { token: login.token, accountId: made.person.id };
  }
  for (const name of ['owner', 'alice', 'bob'] as Who[]) who[name] = await seed(name, tokens[name].token, tokens[name].accountId);
  // a key of bob's own
  await ok(who.bob.token, 'PUT', '/api/secrets', { kind: 'providers', key: 'mock', value: 'sk-ZQXBOB-own-key' });

  // alerts about each chat
  const alerts: AlertItem[] = (['owner', 'alice', 'bob'] as Who[]).map((n) => ({
    id: `alrt_${n}`,
    kind: 'stuck',
    reason: 'idle',
    sessionId: who[n].ids.session!,
    text: `No progress in '${who[n].marker} chat'`,
    createdAt: 1,
    updatedAt: 1,
    since: 0,
    thresholdMs: 300_000,
  }));
  setAlerts(engine, {
    list: () => alerts,
    act: (id: string) => (alerts.some((a) => a.id === id) ? 'ok' : 'missing'),
    live: () => ({ stuck: {}, conflicts: [] }),
    stop() {},
  } as unknown as AlertService);
}, 60_000);

afterAll(async () => {
  for (const a of aborts) a.abort();
  await running?.stop();
  await engine?.shutdown();
  mock?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Words and ids of other accounts found in a response. `wordsOnly`: the hub's logs, which hold ids of everyone's work but no words of it. */
function leaks(text: string, others: Who[], wordsOnly = false): string[] {
  const secrets = others.includes('owner') ? ['sk-hub-owner-key', 'sk-ZQXBOB-own-key'] : ['sk-ZQXBOB-own-key'];
  const out: string[] = [];
  for (const o of others) {
    if (text.includes(who[o].marker)) out.push(who[o].marker);
    if (!wordsOnly) for (const id of who[o].all) if (text.includes(id)) out.push(id);
  }
  // the hub's key never reaches a member, and bob's key never leaves the hub
  for (const secret of secrets) if (text.includes(secret)) out.push(secret);
  return out;
}

/** The routes the app has, as "METHOD /path". Middleware (ALL with a wildcard) left out. */
function appRoutes(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; path: string }> = [];
  for (const r of running.conclave.app.routes) {
    if (r.method === 'ALL' && (r.path === '*' || r.path.endsWith('/*'))) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

const SOCKETS = new Set(['/api/ws', '/api/daemon']);
/** Values for path params that are not owned ids. */
const DUMMY: Record<string, string> = { seq: '1', checkpointId: 'chk_x', entryId: 'gle_x', findingId: 'wff_x', name: 'x', owner: 'x', provider: 'mock', state: 'x', msgId: 'x', sha256: 'x', secret: 'x', device: 'x' };

function fill(path: string, values: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, p: string) => encodeURIComponent(values[p] ?? DUMMY[p] ?? 'x'));
}

describe('the route table', () => {
  test('names every route the app has, and nothing it does not', () => {
    const routes = appRoutes();
    const missing = routes.filter((r) => r.path.startsWith('/api/') && !ruleFor(r.method, r.path)).map((r) => `${r.method} ${r.path}`);
    const unknown = routes.filter((r) => !r.path.startsWith('/api/') && !OWN_AUTH_ROUTES.some((re) => re.test(`${r.method} ${r.path}`))).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(ROUTE_POLICY).filter((k) => !have.has(k))).toEqual([]);
    expect(routes.length).toBeGreaterThan(300);
  });
});

describe('the tables', () => {
  test('each is an account’s, a child of one, or the hub’s, and an account’s has account_id', () => {
    const db = engine.repos.db;
    const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
    // full-text indexes keep their rows in shadow tables named after them
    const fts = names.filter((n) => /_fts$/.test(n));
    const shadow = (n: string) => fts.some((f) => n.startsWith(`${f}_`));
    const known = new Set([...ACCOUNT_TABLES, ...Object.keys(CHILD_TABLES), ...HUB_TABLES]);
    expect(names.filter((n) => !known.has(n) && !shadow(n))).toEqual([]);
    for (const t of ACCOUNT_TABLES.filter((t) => names.includes(t))) {
      expect([t, (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some((c) => c.name === 'account_id')]).toEqual([t, true]);
    }
    expect(names.length).toBeGreaterThan(40);
  });
});

describe('lists', () => {
  const lists = () =>
    appRoutes().filter((r) => r.method === 'GET' && r.path.startsWith('/api/') && !r.path.includes(':') && !SOCKETS.has(r.path) && ruleFor(r.method, r.path) !== 'admin');

  test('alice sees nothing of bob or the owner in any list', async () => {
    const found: string[] = [];
    let n = 0;
    for (const r of lists()) {
      const res = await call(who.alice.token, 'GET', `${r.path}?q=zebra&query=zebra&search=zebra&limit=200`);
      n++;
      const hit = leaks(res.text, ['bob', 'owner']);
      if (hit.length) found.push(`${r.path}: ${hit.join(', ')}`);
    }
    expect(found).toEqual([]);
    expect(n).toBeGreaterThan(45);
  }, 60_000);

  test('the owner sees nothing of a member in any list, People and admin pages included', async () => {
    const found: string[] = [];
    for (const r of appRoutes().filter((r) => r.method === 'GET' && r.path.startsWith('/api/') && !r.path.includes(':') && !SOCKETS.has(r.path))) {
      const res = await call(OWNER, 'GET', `${r.path}?q=zebra&query=zebra&search=zebra&limit=200`);
      // the hub's logs name the ids of everyone's work (docs/design/ACCOUNTS.md: hub wide, owner only), never their words
      const hit = leaks(res.text, ['alice', 'bob'], r.path.startsWith('/api/logs'));
      if (hit.length) found.push(`${r.path}: ${hit.join(', ')}`);
    }
    expect(found).toEqual([]);
  }, 60_000);

  test('each sees their own', async () => {
    for (const n of ['owner', 'alice', 'bob'] as Who[]) {
      const t = who[n].token;
      expect((await ok<any[]>(t, 'GET', '/api/sessions')).map((s) => s.id)).toContain(who[n].ids.session!);
      expect((await ok<any[]>(t, 'GET', '/api/memory')).map((m) => m.id)).toContain(who[n].ids.memory!);
      expect((await ok<any[]>(t, 'GET', '/api/tasks')).map((m) => m.id)).toContain(who[n].ids.task!);
      expect((await ok<any[]>(t, 'GET', '/api/routines')).map((m) => m.id)).toContain(who[n].ids.routine!);
      expect((await ok<any[]>(t, 'GET', '/api/devices')).map((m) => m.id)).toContain(who[n].ids.device!);
      expect((await ok<any[]>(t, 'GET', '/api/approvals')).map((m) => m.id)).toContain(who[n].ids.approval!);
      expect((await ok<any[]>(t, 'GET', '/api/questions')).map((m) => m.id)).toContain(who[n].ids.question!);
      expect((await ok<any[]>(t, 'GET', '/api/alerts')).map((m) => m.id)).toEqual([who[n].ids.alert!]);
      expect((await ok<any[]>(t, 'GET', '/api/search?q=zebra')).map((m) => m.sessionId)).toEqual([who[n].ids.session!]);
      expect((await ok<any[]>(t, 'GET', '/api/oauth/apps')).length).toBe(1);
      const recent = await ok<any[]>(t, 'GET', '/api/usage/recent');
      expect(recent.length).toBeGreaterThan(0);
      // the chat, and the meeting's own session (its brief)
      const meetingSession = (await ok<any>(t, 'GET', `/api/meetings/${who[n].ids.meeting}`)).sessionId;
      const seen = new Set(recent.map((u) => u.sessionId).filter(Boolean));
      expect(seen.has(who[n].ids.session!)).toBe(true);
      expect([...seen].filter((s) => s !== who[n].ids.session && s !== meetingSession)).toEqual([]);
    }
  });
});

describe('ids of someone else', () => {
  const owned = () =>
    appRoutes()
      .map((r) => ({ ...r, rule: ruleFor(r.method, r.path) }))
      // a seat rule is swept the same way: its id is a session id of the target's
      .map((r) => (r.rule && typeof r.rule === 'object' && 'seat' in r.rule ? { ...r, rule: { own: { id: 'session' as OwnedKind } } } : r))
      .filter((r): r is typeof r & { rule: { own: Record<string, OwnedKind> } } => typeof r.rule === 'object' && 'own' in r.rule);

  /** Snapshot of what an account has, to show a refused call changed nothing. */
  function state(n: Who) {
    const s = who[n];
    const session = engine.getSession(s.ids.session!);
    return {
      session: session && { title: session.title, archived: session.archived, pinned: session.pinned, device: session.device },
      messages: engine.getMessages(s.ids.session!).length,
      memory: engine.memoryFor(s.accountId).list({ limit: 50 }).map((m) => `${m.id} ${m.content}`),
      task: JSON.stringify(engine.repos.tasks.get(s.ids.task!)),
      routine: JSON.stringify(engine.routines.get(s.ids.routine!)),
      device: JSON.stringify(engine.repos.devices.get(s.ids.device!)),
      approval: engine.pendingApprovals(s.accountId).map((a) => a.id),
      question: engine.pendingQuestions(s.accountId).map((q) => q.id),
      project: JSON.stringify(engine.repos.db.query('SELECT * FROM projects WHERE id = ?').get(s.ids.project!)),
      prefix: JSON.stringify(engine.repos.db.query('SELECT * FROM path_prefixes WHERE id = ?').get(s.ids.pathPrefix!)),
      batch: JSON.stringify(engine.repos.db.query('SELECT * FROM import_batches WHERE id = ?').get(s.ids.importBatch!)),
      run: JSON.stringify(engine.repos.db.query('SELECT * FROM workflow_runs WHERE id = ?').get(s.ids.workflowRun!)),
      grants: (engine.repos.db.query('SELECT COUNT(*) AS n FROM oauth_grants WHERE account_id = ?').get(s.accountId) as { n: number }).n,
      pim: JSON.stringify(engine.repos.kv.get(accountKey(s.accountId, 'pim.accounts'), null)),
      proposals: JSON.stringify(engine.repos.db.query('SELECT id, status FROM pim_proposals WHERE account_id = ?').all(s.accountId)),
      presets: JSON.stringify(engine.repos.db.query('SELECT id FROM workflow_presets WHERE account_id = ?').all(s.accountId)),
    };
  }

  async function sweep(caller: Who, target: Who): Promise<{ wrong: string[]; count: number; skipped: string[] }> {
    const wrong: string[] = [];
    const skipped: string[] = [];
    let count = 0;
    for (const r of owned()) {
      const values: Record<string, string> = {};
      let missing = false;
      for (const [param, kind] of Object.entries(r.rule.own)) {
        const id = who[target].ids[kind];
        if (!id) missing = true;
        else values[param] = id;
      }
      if (missing) {
        skipped.push(`${r.method} ${r.path}`);
        continue;
      }
      const path = fill(r.path, values);
      const res = await call(who[caller].token, r.method === 'ALL' ? 'POST' : r.method, path, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      count++;
      if (res.status !== 404) wrong.push(`${r.method} ${path}: ${res.status} ${res.text.slice(0, 120)}`);
    }
    return { wrong, count, skipped };
  }

  test("alice gets 404 for every route with bob's ids, and bob's things stay as they were", async () => {
    const before = state('bob');
    const r = await sweep('alice', 'bob');
    expect(r.wrong).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.count).toBeGreaterThan(60);
    expect(state('bob')).toEqual(before);
    // bob's app still works
    expect((await call(who.bob.token, 'GET', '/api/me')).status).toBe(200);
  }, 60_000);

  test("alice gets 404 for every route with the owner's ids", async () => {
    const before = state('owner');
    const r = await sweep('alice', 'owner');
    expect(r.wrong).toEqual([]);
    expect(state('owner')).toEqual(before);
  }, 60_000);

  test("the owner gets 404 for every route with bob's ids too", async () => {
    const before = state('bob');
    const r = await sweep('owner', 'bob');
    expect(r.wrong).toEqual([]);
    expect(state('bob')).toEqual(before);
  }, 60_000);

  test('ids in bodies and queries are checked as well', async () => {
    const a = who.alice.token;
    const b = who.bob.ids;
    const refused = async (method: string, path: string, json?: unknown) => {
      const res = await call(a, method, path, json);
      return res.status === 404 || res.status === 403 ? res.status : `${res.status} ${res.text.slice(0, 120)}`;
    };
    expect(await refused('POST', '/api/sessions', { parentId: b.session })).toBe(404);
    expect(await refused('POST', '/api/sessions', { device: b.device })).toBe(404);
    expect(await refused('POST', '/api/sessions', { taskId: b.task })).toBe(404);
    expect(await refused('PATCH', `/api/sessions/${who.alice.ids.session}`, { device: b.device })).toBe(404);
    expect(await refused('POST', `/api/sessions/${who.alice.ids.session}/move`, { device: b.device, cwd: '~' })).toBe(404);
    expect(await refused('POST', '/api/workflows/runs', { name: 'x', sessionId: b.session })).toBe(404);
    expect(await refused('GET', `/api/workflows?sessionId=${b.session}`)).toBe(404);
    expect(await refused('GET', `/api/workflows/runs?sessionId=${b.session}`)).toBe(404);
    expect(await refused('POST', '/api/projects/identify', { device: b.device, path: '/x' })).toBe(404);
    expect(await refused('POST', '/api/projects/identify', { device: who.alice.ids.device, path: '/x', sessionId: b.session })).toBe(404);
    expect(await refused('POST', '/api/memory/import', { device: b.device })).toBe(404);
    expect(await refused('POST', '/api/memory/export', { device: b.device, dir: '/tmp' })).toBe(404);
    expect(await refused('POST', '/api/import/batches', { device: b.device, mode: 'learn' })).toBe(404);
    expect(await refused('GET', `/api/import/scan?device=${b.device}`)).toBe(404);
    expect(await refused('POST', '/api/github/sessions', { device: b.device, repo: 'acme/widgets' })).toBe(404);
    // a review answer for bob's memory does nothing
    const before = engine.memoryFor(who.bob.accountId).get(b.memory!);
    const rev = await call(a, 'POST', '/api/memory/review', { reject: [b.memory] });
    expect(rev.body?.rejected ?? 0).toBe(0);
    expect(engine.memoryFor(who.bob.accountId).get(b.memory!)).toEqual(before);
    // a routine on bob's device is refused
    expect((await call(a, 'POST', '/api/routines', { name: 'x', schedule: '0 7 * * *', prompt: 'y', device: b.device })).status).toBeGreaterThanOrEqual(400);
    // a member's calendar and mail servers are never on the hub's network
    const caldav = await call(a, 'POST', '/api/pim/accounts/caldav', { serverUrl: 'http://127.0.0.1:7/dav', username: 'x', password: 'y' });
    expect(caldav.status).toBe(400);
    expect(caldav.body.error).toContain("hub's own network");
    expect((await call(a, 'POST', '/api/pim/accounts/imap', { host: '192.168.1.5', username: 'x', password: 'y' })).status).toBe(400);
    // a member's watch browses in their own browser: it is made, it is theirs, and bob does not see it
    const watch = await call(a, 'POST', '/api/routines', { name: 'w', schedule: '0 7 * * *', prompt: 'y', watch: { url: 'https://example.com/cars' } });
    expect(watch.status).toBe(200);
    expect((await ok(who.bob.token, 'GET', '/api/watches')).map((w: { id: string }) => w.id)).not.toContain(watch.body.id);
    expect((await call(who.bob.token, 'GET', `/api/watches/${watch.body.id}`)).status).toBe(404);
    // maps use alice's own key and home, never the owner's
    expect(JSON.stringify(await ok(a, 'GET', '/api/maps/leave-by'))).not.toContain('ZQXOWNER');
    // each account's calendar list and proposals are its own
    expect((await ok<any>(a, 'GET', '/api/pim')).accounts.map((x: any) => x.id)).toEqual([who.alice.ids.pimAccount]);
    expect((await ok<any[]>(a, 'GET', '/api/proposals')).map((x) => x.id)).toEqual([who.alice.ids.proposal]);
    // launch presets are per account: alice lists her own only
    expect((await ok<any[]>(a, 'GET', '/api/workflows/deep-research/presets')).map((x) => x.id)).toEqual([who.alice.ids.preset]);
  });
});

describe('owner routes', () => {
  test('answer alice 403 and change nothing', async () => {
    const wrong: string[] = [];
    let n = 0;
    const config = JSON.stringify(engine.config.get());
    for (const r of appRoutes().filter((r) => r.path.startsWith('/api/') && ruleFor(r.method, r.path) === 'admin')) {
      const path = fill(r.path, { id: who.bob.accountId });
      const res = await call(who.alice.token, r.method, path, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      n++;
      if (res.status !== 403) wrong.push(`${r.method} ${path}: ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(n).toBeGreaterThan(100);
    expect(JSON.stringify(engine.config.get())).toBe(config);
    // People is among them
    expect((await call(who.alice.token, 'GET', '/api/people')).status).toBe(403);
    expect((await call(who.alice.token, 'DELETE', `/api/people/${who.bob.accountId}`)).status).toBe(403);
    expect(engine.people.get(who.bob.accountId)).toBeDefined();
  }, 60_000);
});

describe('the socket', () => {
  test("carries alice's events and none of bob's or the owner's, live and in the replay", async () => {
    const ws = await openWs(`${base.replace(/^http/, 'ws')}/api/ws?token=${who.alice.token}`);
    const hello = await ws.next((f) => f.type === 'hello');
    for (const n of ['bob', 'owner', 'alice'] as Who[]) {
      await ok(who[n].token, 'POST', `/api/sessions/${who[n].ids.session}/messages`, { text: `zebra ${who[n].marker} again` });
      await engine.runnerFor(who[n].ids.session!).waitIdle();
    }
    // alice's own turn arrives
    await ws.next((f) => f.sessionId === who.alice.ids.session || f.session?.id === who.alice.ids.session, 5000);
    await Bun.sleep(200);
    const live = ws.frames.map((f) => JSON.stringify(f)).join('\n');
    expect(leaks(live, ['bob', 'owner'])).toEqual([]);
    expect(live).toContain(who.alice.ids.session!);

    // the replay from the start is filtered the same way
    const from = ws.frames.length;
    ws.ws.send(JSON.stringify({ type: 'since', seq: Math.max(0, hello.seq - 1) }));
    await Bun.sleep(300);
    const replay = ws.frames.slice(from).map((f) => JSON.stringify(f)).join('\n');
    expect(replay.length).toBeGreaterThan(0);
    expect(leaks(replay, ['bob', 'owner'])).toEqual([]);
    ws.close();
  }, 30_000);

  test('the owner socket gets none of a member', async () => {
    const ws = await openWs(`${base.replace(/^http/, 'ws')}/api/ws?token=${OWNER}`);
    await ws.next((f) => f.type === 'hello');
    await ok(who.bob.token, 'POST', `/api/sessions/${who.bob.ids.session}/messages`, { text: 'zebra once more' });
    await engine.runnerFor(who.bob.ids.session!).waitIdle();
    await ok(OWNER, 'POST', `/api/sessions/${who.owner.ids.session}/messages`, { text: 'zebra owner once more' });
    await engine.runnerFor(who.owner.ids.session!).waitIdle();
    await ws.next((f) => f.sessionId === who.owner.ids.session || f.session?.id === who.owner.ids.session, 5000);
    await Bun.sleep(200);
    expect(leaks(ws.frames.map((f) => JSON.stringify(f)).join('\n'), ['alice', 'bob'])).toEqual([]);
    ws.close();
  }, 30_000);
});
