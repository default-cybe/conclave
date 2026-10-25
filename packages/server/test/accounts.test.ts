/**
 * Accounts against the fake CLIProxyAPI (fixtures/fake-cliproxy.ts): the
 * extended credentials list, models per account, priorities written from
 * the owner's order, pause, "Try now", the plan usage reads through
 * api-call (allowlisted addresses only, canned answers), and a scan of every
 * answer, event, log line and audit row for keys and tokens.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountsStatus, SubscriptionsStatus } from '@conclave/core/client/index.ts';
import { CODEX_CLIENT_VERSION, Management, ManagementError, USAGE_CALLS, assertAllowedCall, codexModels, splitPrefixed } from '../src/cliproxy/management';
import { renderConfig } from '../src/cliproxy/config';
import { ProviderRegistry } from '@conclave/core/providers/registry.ts';
import { accountsOf } from '@conclave/core/accounts/attached.ts';
import { WindowStarter, sendStarter } from '@conclave/core/accounts/starter.ts';
import type { UsageInput } from '@conclave/core/usage/readers/common.ts';
import { startHub, type TestHub } from './helpers';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-cliproxy.ts');
const scratch = mkdtempSync(join(tmpdir(), 'conclave-accounts-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function freePort(): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = l.port;
  l.stop(true);
  return p;
}

// ---------------------------------------------------------------------------
// Pure pieces: the config, the management client against a scripted fetch
// ---------------------------------------------------------------------------

describe('config and the management client', () => {
  test('renderConfig writes the routing section: fill-first, session affinity, rebind on quota only', () => {
    const yaml = renderConfig({ port: 41001, managementHash: '$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012', clientKey: 'cpk-client', authDir: '/data/cliproxy/auth' });
    const parsed = Bun.YAML.parse(yaml) as any;
    expect(parsed.routing).toEqual({ strategy: 'fill-first', 'session-affinity': true, 'session-affinity-rebind-on': 'quota' });
  });

  /** A Management over a fetch that answers from a table and records each request. */
  function scripted(answers: Record<string, (body: any, url: URL) => { status?: number; json: unknown }>) {
    const seen: Array<{ method: string; path: string; body: any; query: Record<string, string> }> = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ method: init?.method ?? 'GET', path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
      const a = answers[`${init?.method ?? 'GET'} ${url.pathname}`];
      if (!a) return new Response('404 page not found', { status: 404 });
      const r = a(body, url);
      return Response.json(r.json, { status: r.status ?? 200 });
    }) as typeof fetch;
    return { m: new Management('http://127.0.0.1:1', 'mgmt-key-test', f), seen };
  }

  test('the credentials list keeps auth_index, priority, prefix, quota signals, cooldowns and next_retry_after, and nothing else', async () => {
    const { m } = scripted({
      'GET /v8/management/credentials': () => ({
        json: {
          observed_at: '2026-10-20T12:00:00Z',
          files: [
            {
              id: 'claude-a.json',
              auth_index: 'a1b2',
              name: 'claude-a.json',
              type: 'claude',
              provider: 'claude',
              email: 'a@example.test',
              account_type: 'oauth',
              status: 'active',
              disabled: false,
              unavailable: true,
              priority: 3,
              prefix: 'neu',
              note: 'work',
              access_token: 'at-SHOULD-NOT-SURVIVE',
              quota: { observed_at: '2026-10-20T11:59:00Z', signals: { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5', 'Retry-After': '30', 'Set-Cookie': 'x=y', Authorization: 'Bearer leak' } },
              cooldowns: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'quota', retry_at: '2026-10-20T13:00:00Z', remaining_seconds: 3600, backoff_level: 1, http_status: 429 }],
              next_retry_after: '2026-10-20T13:00:00Z',
            },
            { id: 'codex-b.json', auth_index: 'c3', name: 'codex-b.json', type: 'codex', id_token: { chatgpt_account_id: 'acct-123', email: 'x' } },
          ],
        },
      }),
    });
    const [a, b] = await m.credentials();
    expect(a).toMatchObject({
      name: 'claude-a.json',
      authIndex: 'a1b2',
      provider: 'claude',
      email: 'a@example.test',
      accountType: 'oauth',
      priority: 3,
      prefix: 'neu',
      note: 'work',
      unavailable: true,
      signals: { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5', 'Retry-After': '30' },
      signalsAt: Date.parse('2026-10-20T11:59:00Z'),
      cooldowns: [{ scope: 'model', model: 'claude-opus-5-5', reason: 'quota', retryAt: Date.parse('2026-10-20T13:00:00Z'), backoffLevel: 1, httpStatus: 429 }],
      nextRetryAfter: Date.parse('2026-10-20T13:00:00Z'),
    });
    expect(JSON.stringify(a)).not.toMatch(/SHOULD-NOT-SURVIVE|leak|Set-Cookie/);
    expect(b).toMatchObject({ name: 'codex-b.json', authIndex: 'c3', chatgptAccountId: 'acct-123' });
  });

  test('models per account, PATCH fields, cooldown reset', async () => {
    const { m, seen } = scripted({
      'GET /v8/management/credentials': () => ({ json: { files: [] } }),
      'GET /v8/management/credentials/models': (_b, url) => ({ json: { models: url.searchParams.get('name') === 'claude-a.json' ? [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'claude', owned_by: 'anthropic' }] : [] } }),
      'PATCH /v8/management/credentials/fields': () => ({ json: { status: 'ok' } }),
      'POST /v8/management/routing/cooldown/reset': () => ({ json: { status: 'ok' } }),
    });
    expect(await m.credentialModels('claude-a.json')).toEqual([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', ownedBy: 'anthropic' }]);
    await m.setFields('claude-a.json', { priority: 2 });
    await m.setFields('claude-a.json', { disabled: true, prefix: undefined });
    await m.resetCooldown('a1b2');
    expect(seen.filter((s) => s.method !== 'GET')).toEqual([
      { method: 'PATCH', path: '/v8/management/credentials/fields', body: { name: 'claude-a.json', priority: 2 }, query: {} },
      { method: 'PATCH', path: '/v8/management/credentials/fields', body: { name: 'claude-a.json', disabled: true }, query: {} },
      { method: 'POST', path: '/v8/management/routing/cooldown/reset', body: { auth_index: 'a1b2' }, query: {} },
    ]);
    expect(seen.find((s) => s.path.endsWith('/credentials/models'))?.query).toEqual({ name: 'claude-a.json' });
  });

  test('splitPrefixed: the prefix and each model once, also while an old short name is still listed', () => {
    const ids = (list: string[]) => splitPrefixed(list.map((id) => ({ id })));
    expect(ids(['claude-opus-5-5', 'claude-haiku-5-5'])).toEqual({ models: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] });
    expect(ids(['claude-opus-5-5', 'neu/claude-opus-5-5', 'claude-haiku-5-5', 'neu/claude-haiku-5-5'])).toEqual({ prefix: 'neu', models: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] });
    // a rename from personal to personal-claude, both still listed: two models, not four or six
    const both = ids(['claude-opus-5-5', 'personal/claude-opus-5-5', 'personal-claude/claude-opus-5-5', 'claude-haiku-5-5', 'personal/claude-haiku-5-5', 'personal-claude/claude-haiku-5-5']);
    expect(both.models).toEqual([{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }]);
    // a tie goes to the name the hub prefers; with force-model-prefix on (no bare ids) still each model once
    expect(splitPrefixed(['personal/claude-opus-5-5', 'personal-claude/claude-opus-5-5'].map((id) => ({ id })), 'personal-claude')).toEqual({ prefix: 'personal-claude', models: [{ id: 'claude-opus-5-5' }] });
  });

  test('api-call: the allowlisted request with the $TOKEN$ placeholder, the answer envelope parsed, Retry-After on a 429', async () => {
    let answer: { status_code: number; header: Record<string, string[]>; body: string } = { status_code: 200, header: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ five_hour: { utilization: 7 } }) };
    const { m, seen } = scripted({
      'GET /v8/management/credentials': () => ({ json: { files: [] } }),
      'POST /v8/management/requests/api-call': () => ({ json: answer }),
    });
    expect(await m.usageCall('claude-usage', 'a1b2')).toEqual({ status: 200, json: { five_hour: { utilization: 7 } } });
    expect(seen.at(-1)!.body).toEqual({ auth_index: 'a1b2', method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage', header: { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' } });
    await m.usageCall('codex-usage', 'c3', { chatgptAccountId: 'acct-123' });
    expect(seen.at(-1)!.body).toEqual({ auth_index: 'c3', method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json', 'Chatgpt-Account-Id': 'acct-123' } });
    // an account id that is not an id is left out, not passed on
    await m.usageCall('codex-usage', 'c3', { chatgptAccountId: 'x\r\nInjected: 1' });
    expect(seen.at(-1)!.body.header['Chatgpt-Account-Id']).toBeUndefined();
    await m.usageCall('antigravity-usage', 'g7');
    expect(seen.at(-1)!.body).toEqual({ auth_index: 'g7', method: 'POST', url: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', Accept: 'application/json' }, data: '{"metadata":{"ideType":"ANTIGRAVITY"}}' });
    // the quota summary: both hosts, the client name Cloud Code accepts, the project as the only value in the body
    const quotaHeader = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)' };
    await m.usageCall('antigravity-quota-daily', 'g7', { projectId: 'proj-1.a:b' });
    expect(seen.at(-1)!.body).toEqual({ auth_index: 'g7', method: 'POST', url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', header: quotaHeader, data: '{"project":"proj-1.a:b"}' });
    await m.usageCall('antigravity-quota', 'g7');
    expect(seen.at(-1)!.body).toEqual({ auth_index: 'g7', method: 'POST', url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', header: quotaHeader, data: '{}' });
    // a project that is not an id is left out, not passed on
    for (const projectId of ['x","evil":"1', 'a b', 'a'.repeat(129)]) {
      await m.usageCall('antigravity-quota', 'g7', { projectId });
      expect(seen.at(-1)!.body.data).toBe('{}');
    }
    // the project goes only into the quota calls
    await m.usageCall('antigravity-usage', 'g7', { projectId: 'proj-1' });
    expect(seen.at(-1)!.body.data).toBe('{"metadata":{"ideType":"ANTIGRAVITY"}}');
    answer = { status_code: 429, header: { 'Retry-After': ['120'] }, body: '{"error":"slow"}' };
    expect(await m.usageCall('claude-profile', 'a1b2')).toEqual({ status: 429, json: { error: 'slow' }, retryAfterMs: 120_000 });
    answer = { status_code: 502, header: {}, body: 'upstream down' };
    expect(await m.usageCall('claude-usage', 'a1b2')).toEqual({ status: 502 });
  });

  test('the allowlist refuses every other method, address and index, before anything is sent', async () => {
    const { m, seen } = scripted({ 'GET /v8/management/credentials': () => ({ json: { files: [] } }) });
    expect(() => assertAllowedCall({ method: 'GET', url: 'https://evil.example/steal' })).toThrow(ManagementError);
    expect(() => assertAllowedCall({ method: 'POST', url: USAGE_CALLS['claude-usage'].url })).toThrow(/does not send/);
    expect(() => assertAllowedCall({ method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage?x=1' })).toThrow();
    expect(() => assertAllowedCall({ method: 'GET', url: 'https://api.anthropic.com/v1/messages' })).toThrow();
    for (const c of Object.values(USAGE_CALLS)) expect(() => assertAllowedCall(c)).not.toThrow();
    expect(Object.values(USAGE_CALLS).map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.anthropic.com/api/oauth/usage',
      'GET https://api.anthropic.com/api/oauth/profile',
      'GET https://chatgpt.com/backend-api/wham/usage',
      `GET https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
      'POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    ]);
    expect(() => assertAllowedCall({ method: 'GET', url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary' })).toThrow();
    expect(() => assertAllowedCall({ method: 'POST', url: 'https://cloudcode-pa.googleapis.com/v1internal:generateContent' })).toThrow();
    // the Codex models address with any other query is refused too
    expect(() => assertAllowedCall({ method: 'GET', url: 'https://chatgpt.com/backend-api/codex/models?client_version=0.1.0' })).toThrow();
    expect(() => assertAllowedCall({ method: 'GET', url: 'https://chatgpt.com/backend-api/codex/responses' })).toThrow();
    await expect(m.usageCall('anything-else' as never, 'a1b2')).rejects.toThrow(/does not send/);
    await expect(m.usageCall('claude-usage', '../../x y')).rejects.toThrow(/index/);
    await expect(m.resetCooldown('bad index!')).rejects.toThrow(/index/);
    expect(seen.filter((s) => s.path.includes('api-call') || s.path.includes('cooldown'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The hub with an external fake CLIProxyAPI
// ---------------------------------------------------------------------------

const SECRETS = ['ext-client-key', 'ext-mgmt-key', 'at-fake-SECRET', 'rt-fake-SECRET', 'test-key-not-real'];

describe('accounts on the hub', () => {
  const dir = mkdtempSync(join(scratch, 'ext-'));
  const port = freePort();
  const mgmtLog = join(dir, 'mgmt.jsonl');
  const callLog = join(dir, 'calls.jsonl');
  const auth = join(dir, 'auth');
  let proc: ReturnType<typeof Bun.spawn>;
  let hub: TestHub;
  const bodies: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  const write = (name: string, acct: Record<string, unknown>) => writeFileSync(join(auth, name), JSON.stringify({ access_token: 'at-fake-SECRET', refresh_token: 'rt-fake-SECRET', ...acct }));
  const read = (name: string) => JSON.parse(readFileSync(join(auth, name), 'utf8'));
  const mgmtCalls = () => (existsSync(mgmtLog) ? readFileSync(mgmtLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const api = async (path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}) => {
    const res = await hub.api(path, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const status = async () => (await api('/api/accounts')).body as AccountsStatus;

  beforeAll(async () => {
    for (const fn of ['log', 'error', 'warn', 'info'] as const) {
      const orig = console[fn].bind(console);
      spies.push(
        spyOn(console, fn).mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(' '));
          orig(...(args as []));
        }),
      );
    }
    writeFileSync(join(dir, 'config.yaml'), `server:\n  host: "127.0.0.1"\n  port: ${port}\nmanagement:\n  allow-remote: false\n  secret-key: "ext-mgmt-key"\naccess:\n  api-keys:\n    - "ext-client-key"\noauth:\n  auth-dir: "${auth}"\n`);
    mkdirSync(auth);
    const reset = new Date(Date.now() + 2 * 3600_000).toISOString();
    // Account 1: 5 hours only; Account 2: a 20x plan, its week resets Tuesday
    write('claude-one@example.test.json', { type: 'claude', email: 'one@example.test', signals: { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.4', 'Anthropic-Ratelimit-Unified-5h-Reset': String(Math.floor(Date.now() / 1000) + 7200) }, usage: { five_hour: { utilization: 41, resets_at: reset } } });
    write('claude-two@example.test.json', { type: 'claude', email: 'two@example.test', usage: { five_hour: { utilization: 5, resets_at: reset }, seven_day: { utilization: 55, resets_at: '2026-10-27T10:00:00Z' }, seven_day_opus: { utilization: 20, resets_at: '2026-10-27T10:00:00Z' }, iguana_necktie: { utilization: 3, resets_at: '2026-10-27T10:00:00Z' } } });
    write('codex-me@example.test.json', { type: 'codex', email: 'me@example.test', chatgpt_account_id: 'acct-777' });
    proc = Bun.spawn([process.execPath, FAKE, '-config', join(dir, 'config.yaml')], { env: { ...process.env, FAKE_CPA_VERSION: '8.0.32', FAKE_CPA_MGMT_LOG: mgmtLog, FAKE_CPA_LOG: callLog }, stdout: 'ignore', stderr: 'ignore' });
    await until(() => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false), 5000, 'the fake');
    // an Anthropic API key (made up; nothing calls it) is the last account
    hub = startHub({ cliproxy: { credentialsMs: 200, usageMs: [60_000, 60_000], random: () => 0 } });
    hub.engine.config.setSecret('providers', 'anthropic', 'test-key-not-real');
    hub.engine.bus.on((e) => events.push(JSON.stringify(e)));
    const put = await api('/api/subscriptions', { method: 'PUT', json: { mode: 'external', url: `http://127.0.0.1:${port}`, key: 'ext-client-key', managementKey: 'ext-mgmt-key' } });
    expect(put.body.state).toBe('on');
  }, 20_000);

  afterAll(async () => {
    await hub?.stop();
    proc?.kill('SIGKILL');
    for (const s of spies) s.mockRestore();
  });

  test('every account with its plan, windows from signals and the usage page, models, and the order', async () => {
    const st = await until(async () => {
      const s = await status();
      const ready = s.accounts.length === 4 && s.accounts.every((a) => a.kind === 'api' || a.models.length) && !!s.accounts.find((a) => a.id === 'claude-two@example.test')?.plan;
      return ready ? s : undefined;
    }, 8000, 'accounts with models and plans');
    expect(st.management).toBe(true);
    expect(st.accounts.map((a) => [a.id, a.kind, a.vendor, a.label, a.plan])).toEqual([
      ['claude-one@example.test', 'subscription', 'anthropic', 'one@example.test', 'Max 20x'],
      ['claude-two@example.test', 'subscription', 'anthropic', 'two@example.test', 'Max 20x'],
      ['codex-me@example.test', 'subscription', 'openai', 'me@example.test', 'Pro'],
      ['api-anthropic', 'api', 'anthropic', 'Claude API key', 'API key'],
    ]);
    const one = st.accounts[0];
    // the usage page (41%) is newer than the signals (40%)
    expect(one.windows.find((w) => w.name === '5h')).toMatchObject({ usedPercent: 41, kind: 'session', source: 'oauth', windowMs: 5 * 3600_000 });
    expect(one.windows.some((w) => w.name === '7d')).toBe(false);
    const two = st.accounts[1];
    expect(two.windows.map((w) => w.name)).toEqual(['5h', '7d', '7d opus', '7d fable']);
    expect(two.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(st.accounts[2].windows.map((w) => [w.name, w.usedPercent])).toEqual([
      ['5h', 25],
      ['7d', 40],
    ]);
    // the API key reaches the vendor's models from the catalog
    expect(st.accounts[3].models.some((m) => m.id.startsWith('claude-'))).toBe(true);
    expect(st.routes.find((r) => r.vendor === 'anthropic')?.order).toEqual(['claude-one@example.test', 'claude-two@example.test', 'api-anthropic']);
    expect(st.now.find((n) => n.vendor === 'anthropic')).toMatchObject({ account: 'claude-one@example.test', window: { name: '5h', usedPercent: 41 } });
    // usage reads went only to the allowlisted addresses, with the placeholder, never a token
    const calls = mgmtCalls().filter((c) => c.path === 'api-call');
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(calls.map((c) => `${c.method} ${c.url}`))).toEqual(new Set(['GET https://api.anthropic.com/api/oauth/usage', 'GET https://api.anthropic.com/api/oauth/profile', 'GET https://chatgpt.com/backend-api/wham/usage', `GET https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`]));
    expect(calls.every((c) => c.authorization === 'Bearer $TOKEN$' && c.data === null)).toBe(true);
    expect(calls.find((c) => c.url.includes('wham'))?.headers).toContain('Chatgpt-Account-Id');
    expect(calls.find((c) => c.url.includes('codex/models'))?.headers).toContain('Chatgpt-Account-Id');
    // per-account limit states for the Usage page
    const limits = (await api('/api/limits')).body as Array<{ provider: string; account?: string }>;
    expect(limits.filter((l) => l.provider === 'cliproxy').map((l) => l.account).sort()).toEqual(['claude-one@example.test', 'claude-two@example.test', 'codex-me@example.test']);
  });

  test('a model only the ChatGPT plan itself lists ("gpt-6.2-nova") stays out with an external CLIProxyAPI: it would refuse it', async () => {
    // CLIProxyAPI lists a ChatGPT plan's models from its catalog only; the plan's own list (ChatGPT's Codex models address) has more
    write('codex-me@example.test.json', { ...read('codex-me@example.test.json'), codex_models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-nova'] });
    const r = await api('/api/models/refresh', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.failed).toEqual([]);
    // the hub read the plan's own list, through api-call with the placeholder only
    const call = mgmtCalls().filter((c) => c.path === 'api-call' && c.url.includes('codex/models')).at(-1);
    expect(call).toMatchObject({ name: 'codex-me@example.test.json', method: 'GET', authorization: 'Bearer $TOKEN$' });
    // this CLIProxyAPI is the owner's: the hub leaves its catalog alone, so gpt-6.2-nova is not offered where it cannot answer
    expect(mgmtCalls().some((c) => c.path === 'catalog')).toBe(false);
    expect(hub.engine.config.get().providers.cliproxy.models).not.toContain('gpt-6.2-nova');
    expect((await status()).accounts.find((a) => a.id === 'codex-me@example.test')!.models.map((m) => m.id)).not.toContain('gpt-6.2-nova');
    // as the real one: a model no account lists ends before any provider is asked
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ext-client-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.2-nova', messages: [] }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
    write('codex-me@example.test.json', { ...read('codex-me@example.test.json'), codex_models: undefined });
  });

  test('each request carries the session id, so CLIProxyAPI keeps the conversation on one account', async () => {
    const p = hub.engine.config.get().providers.cliproxy;
    expect(p.sessionHeader).toBe('X-Session-ID');
    const reg = new ProviderRegistry(hub.engine.config);
    for (const model of ['claude-opus-5-5', 'gpt-6-astra']) {
      for await (const _ of reg.get('cliproxy')!.stream({ model, system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 8, session: 'ses_abc' })) void _;
    }
    reg.dispose();
    const calls = readFileSync(callLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.slice(-2)).toEqual([
      { path: '/v1/messages', model: 'claude-opus-5-5', session: 'ses_abc' },
      { path: '/v1/responses', model: 'gpt-6-astra', session: 'ses_abc' },
    ]);
  });

  test("an owner's order in an external CLIProxyAPI: priorities are written only once the owner sets one", async () => {
    expect(mgmtCalls().filter((c) => c.path === 'fields')).toEqual([]);
    const r = await api('/api/accounts/order', { method: 'PUT', json: { vendor: 'anthropic', order: ['claude-two@example.test', 'claude-one@example.test', 'api-anthropic'] } });
    expect(r.status).toBe(200);
    expect(r.body.routes.find((x: { vendor: string }) => x.vendor === 'anthropic').order).toEqual(['claude-two@example.test', 'claude-one@example.test', 'api-anthropic']);
    expect(read('claude-two@example.test.json').priority).toBe(2);
    expect(read('claude-one@example.test.json').priority).toBe(1);
    expect(read('codex-me@example.test.json').priority).toBe(1);
    // the list shows what CLIProxyAPI now has
    const st = await until(async () => {
      const s = await status();
      return s.accounts.find((a) => a.id === 'claude-two@example.test')?.priority === 2 && s;
    });
    expect(st.now.find((n) => n.vendor === 'anthropic')?.account).toBe('claude-two@example.test');
    // nothing to write the second time
    const before = mgmtCalls().filter((c) => c.path === 'fields').length;
    await api('/api/accounts/order', { method: 'PUT', json: { vendor: 'anthropic', order: ['claude-two@example.test', 'claude-one@example.test', 'api-anthropic'] } });
    expect(mgmtCalls().filter((c) => c.path === 'fields').length).toBe(before);
    expect((await api('/api/accounts/order', { method: 'PUT', json: { vendor: 'anthropic', order: ['codex-me@example.test'] } })).status).toBe(400);
    expect(hub.engine.repos.audit.list({ limit: 20 }).find((a) => a.action === 'accounts.order')?.detail).toBe('anthropic: two@example.test, one@example.test, Claude API key');
  });

  test('pause and resume reach CLIProxyAPI; a cooldown shows, and Try now clears it', async () => {
    const paused = await api('/api/accounts/claude-one@example.test', { method: 'PATCH', json: { enabled: false } });
    expect(paused.status).toBe(200);
    expect(read('claude-one@example.test.json').disabled).toBe(true);
    expect(paused.body.accounts.find((a: { id: string }) => a.id === 'claude-one@example.test')).toMatchObject({ enabled: false, state: 'paused' });
    await api('/api/accounts/claude-one@example.test', { method: 'PATCH', json: { enabled: true } });
    expect(read('claude-one@example.test.json').disabled).toBe(false);

    const until1 = new Date(Date.now() + 3600_000).toISOString();
    write('claude-two@example.test.json', { ...read('claude-two@example.test.json'), cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: until1 }] });
    const cooling = await until(async () => {
      const s = await status();
      return s.accounts.find((a) => a.id === 'claude-two@example.test')?.state === 'cooldown' && s;
    }, 5000, 'the cooldown');
    expect(cooling.accounts.find((a) => a.id === 'claude-two@example.test')).toMatchObject({ detail: 'Hit its limit', until: Date.parse(until1) });
    // the order skips it while it rests
    expect(cooling.now.find((n) => n.vendor === 'anthropic')).toMatchObject({ account: 'claude-one@example.test', skipped: [{ account: 'claude-two@example.test', reason: 'Hit its limit' }] });
    const tried = await api('/api/accounts/claude-two@example.test/try', { method: 'POST' });
    expect(tried.status).toBe(200);
    expect(mgmtCalls().some((c) => c.path === 'cooldown-reset' && c.name === 'claude-two@example.test.json')).toBe(true);
    expect(tried.body.accounts.find((a: { id: string }) => a.id === 'claude-two@example.test').state).not.toBe('cooldown');
    expect((await api('/api/accounts/nobody/try', { method: 'POST' })).status).toBe(404);
  });

  test('the usage page asks to wait: the hub backs off instead of asking again on the next pass', async () => {
    write('claude-one@example.test.json', { ...read('claude-one@example.test.json'), usage_status: 429 });
    const count = () => mgmtCalls().filter((c) => c.path === 'api-call' && c.name === 'claude-one@example.test.json' && c.url.endsWith('/usage')).length;
    await api('/api/accounts/refresh', { method: 'POST' });
    const after429 = count();
    await api('/api/accounts/refresh', { method: 'POST' });
    await api('/api/accounts/refresh', { method: 'POST' });
    expect(count()).toBe(after429);
  });

  test('budgets for API keys: set, shown with the period, checked', async () => {
    const r = await api('/api/accounts/api-anthropic', { method: 'PATCH', json: { budget: { usd: 50, period: 'month', resetDay: 22, tz: 'Europe/Berlin', warnAt: 80 } } });
    expect(r.status).toBe(200);
    const a = r.body.accounts.find((x: { id: string }) => x.id === 'api-anthropic');
    expect(a.budget).toMatchObject({ usd: 50, period: 'month', resetDay: 22, tz: 'Europe/Berlin', spentUsd: 0 });
    expect(a.windows.find((w: { name: string }) => w.name === 'budget')).toMatchObject({ usedPercent: 0, limit: 50, remaining: 50, kind: 'budget' });
    expect((await api('/api/accounts/api-anthropic', { method: 'PATCH', json: { budget: { usd: -1 } } })).status).toBe(400);
    expect((await api('/api/accounts/claude-one@example.test', { method: 'PATCH', json: { budget: { usd: 5 } } })).status).toBe(400);
    expect((await api('/api/accounts/api-anthropic', { method: 'PATCH', json: { label: 'Work API' } })).body.accounts.find((x: { id: string }) => x.id === 'api-anthropic').label).toBe('Work API');
  });

  test('the window starter: settings checked and saved, its request pinned through CLIProxyAPI, and a read of that account alone', async () => {
    const id = 'codex-me@example.test';
    // hours around now in UTC, so the request may go at once
    const hr = new Date().getUTCHours();
    const start = `${String((hr + 23) % 24).padStart(2, '0')}:00`;
    const end = `${String((hr + 2) % 24).padStart(2, '0')}:00`;
    const on = await api(`/api/accounts/${id}`, { method: 'PATCH', json: { starter: { enabled: true, start, end, tz: 'UTC' } } });
    expect(on.status).toBe(200);
    expect(on.body.accounts.find((a: { id: string }) => a.id === id).starter).toMatchObject({ enabled: true, start, end, tz: 'UTC' });
    expect((hub.engine.config.getUser() as any).models.accounts.find((a: { id: string }) => a.id === id).starter).toEqual({ enabled: true, start, end, tz: 'UTC' });
    expect(hub.engine.repos.audit.list({ limit: 20 }).find((a) => a.action === 'accounts.update')?.detail).toBe('me@example.test: window starter on');
    expect((await api('/api/accounts/api-anthropic', { method: 'PATCH', json: { starter: { enabled: true } } })).status).toBe(400);
    expect((await api(`/api/accounts/${id}`, { method: 'PATCH', json: { starter: { start: '7am' } } })).status).toBe(400);

    // its plan shows a 5 hour window that has not started: no reset
    write('codex-me@example.test.json', { ...read('codex-me@example.test.json'), usage: { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 300_000 } } } });
    await api('/api/accounts/refresh', { method: 'POST' });
    const accounts = accountsOf(hub.engine)!;
    const reg = new ProviderRegistry(hub.engine.config);
    const rows: UsageInput[] = [];
    const clock = { skew: 0 };
    const starter = new WindowStarter({
      facts: () => accounts.starterFacts(),
      kv: hub.engine.repos.kv,
      zone: () => 'UTC',
      plan: () => {},
      send: (p, req) => sendStarter(reg, p, req),
      read: (a, o) => accounts.readNow(a, o),
      record: (r) => void rows.push(r),
      notify: () => {},
      now: () => Date.now() + clock.skew,
    });
    try {
      const facts = accounts.starterFacts();
      const view = (x: string) => starter.view(facts.find((f) => f.id === x)!, facts);
      expect(view(id)).toMatchObject({ state: 'scheduled', autoModel: 'gpt-6.1-sol' });
      // two Claude plans without a prefix: neither can be reached alone
      expect(starter.view({ ...facts.find((f) => f.id === 'claude-one@example.test')!, starter: { enabled: true } }, facts)).toMatchObject({ state: 'setup', reason: 'Cannot pin a request to it' });

      await starter.run(id);
      const sent = readFileSync(callLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
      expect(sent).toMatchObject({ path: '/v1/responses', model: 'gpt-6.1-sol' });
      expect(rows).toEqual([expect.objectContaining({ source: 'starter', purpose: 'starter', provider: 'cliproxy', model: 'gpt-6.1-sol', account: id, inputTokens: 5, outputTokens: 6 })]);
      // the checks after it: the credentials first, then the plan usage of this account only
      const before = mgmtCalls().length;
      for (const skew of [5_000, 15_000, 30_000]) {
        clock.skew = skew;
        await starter.run(id);
      }
      const usage = mgmtCalls()
        .slice(before)
        .filter((c) => c.path === 'api-call');
      expect(usage.map((c) => c.name)).toEqual(['codex-me@example.test.json']);
      expect(starter.view(accounts.starterFacts().find((f) => f.id === id)!, accounts.starterFacts()).state).toBe('checking');
    } finally {
      starter.dispose();
      reg.dispose();
      await api(`/api/accounts/${id}`, { method: 'PATCH', json: { starter: null } });
    }
  });

  test("a plan's short name: checked, written to CLIProxyAPI as its prefix, the models read again; unique, and the owner's only", async () => {
    const id = 'claude-two@example.test';
    const put = (who: string, prefix: unknown, token?: string) => api(`/api/accounts/${encodeURIComponent(who)}/prefix`, { method: 'PUT', json: prefix === undefined ? {} : { prefix }, ...(token ? { token } : {}) });
    const fields = () => mgmtCalls().filter((c) => c.path === 'fields' && 'prefix' in c.fields);
    const models = () => hub.engine.config.get().providers.cliproxy.models ?? [];
    expect(models()).not.toContain('neu/claude-opus-5-5');

    // checked before anything reaches CLIProxyAPI
    for (const bad of ['Neu', 'neu/work', 'two words', 'kai_neu', 'ü', 'a'.repeat(25)]) {
      const r = await put(id, bad);
      expect([bad, r.status, r.body.error]).toEqual([bad, 400, 'Use 1 to 24 lowercase letters, digits and dashes.']);
    }
    expect((await put(id, undefined)).status).toBe(400);
    expect((await put(id, 7)).status).toBe(400);
    expect((await put('api-anthropic', 'work')).status).toBe(400);
    expect((await put('nobody', 'work')).status).toBe(404);
    expect(fields()).toEqual([]);

    // set: CLIProxyAPI's file has it, and the models read again carry it, as after Refresh models
    const set = await put(id, ' neu ');
    expect(set.status).toBe(200);
    expect(fields()).toEqual([{ path: 'fields', name: 'claude-two@example.test.json', fields: { prefix: 'neu' } }]);
    expect(read('claude-two@example.test.json').prefix).toBe('neu');
    expect(set.body.accounts.find((a: { id: string }) => a.id === id).prefix).toBe('neu');
    expect(models()).toContain('neu/claude-opus-5-5');
    expect(models()).toContain('claude-opus-5-5');
    expect(new ProviderRegistry(hub.engine.config).resolve('cliproxy/neu/claude-opus-5-5')).toMatchObject({ provider: 'cliproxy', model: 'neu/claude-opus-5-5' });
    expect(hub.engine.repos.audit.list({ limit: 20 }).find((a) => a.action === 'accounts.update')?.detail).toBe('two@example.test: short name neu');
    // the window starter can now reach that plan alone
    const facts = accountsOf(hub.engine)!.starterFacts();
    expect(facts.find((f) => f.id === id)?.prefix).toBe('neu');
    // CLIProxyAPI's credentials list never carries the prefix (8.0.32 keeps it in the auth file only)
    const raw = (await (await fetch(`http://127.0.0.1:${port}/v8/management/credentials`, { headers: { authorization: 'Bearer ext-mgmt-key' } })).json()) as { files: Array<Record<string, unknown>> };
    expect(raw.files.find((f) => f.name === 'claude-two@example.test.json')).not.toHaveProperty('prefix');
    // the hub knows it from the plan's own models, which name each model twice: after the credentials poll and a full read too
    await Bun.sleep(500);
    const again = (await api('/api/accounts/refresh', { method: 'POST' })).body as AccountsStatus;
    const two = again.accounts.find((a) => a.id === id)!;
    expect(two.prefix).toBe('neu');
    // each model once on the plan
    expect(two.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

    // each plan's is its own, across vendors too; nothing is written
    for (const other of ['claude-one@example.test', 'codex-me@example.test']) {
      const r = await put(other, 'neu');
      expect([r.status, r.body.error]).toEqual([409, 'Another plan already has the short name neu.']);
    }
    // the same name again changes nothing in CLIProxyAPI
    expect((await put(id, 'neu')).status).toBe(200);
    expect(fields().length).toBe(1);

    // a member works on her own plans (cliproxy/member.ts): the owner's is not one of them, and hers are off
    expect((await api('/api/people', { method: 'POST', json: { name: 'alice', password: 'a long enough password' } })).status).toBe(200);
    const login = await api('/api/login', { method: 'POST', token: null, json: { account: 'alice', password: 'a long enough password', name: 'phone' } });
    expect(login.status).toBe(200);
    const hers = await put('claude-one@example.test', 'personal', login.body.token);
    expect([hers.status, hers.body.error]).toEqual([409, 'Subscriptions are off. Run CLIProxyAPI on the hub, or connect the one you run, first.']);
    expect(fields().length).toBe(1);
    expect(read('claude-one@example.test.json').prefix ?? '').toBe('');

    // empty removes it, and the prefixed ids go with it
    const off = await put(id, '');
    expect(off.status).toBe(200);
    expect(fields().at(-1)).toEqual({ path: 'fields', name: 'claude-two@example.test.json', fields: { prefix: '' } });
    expect(read('claude-two@example.test.json').prefix ?? '').toBe('');
    expect(off.body.accounts.find((a: { id: string }) => a.id === id).prefix).toBeUndefined();
    expect(models()).not.toContain('neu/claude-opus-5-5');
    expect(hub.engine.repos.audit.list({ limit: 20 }).find((a) => a.action === 'accounts.update')?.detail).toBe('two@example.test: short name removed');
  });

  test('a short name just saved stays while CLIProxyAPI still lists the old ids, so it is not lost or given twice', async () => {
    const id = 'claude-one@example.test';
    const file = 'claude-one@example.test.json';
    const put = (who: string, prefix: string) => api(`/api/accounts/${encodeURIComponent(who)}/prefix`, { method: 'PUT', json: { prefix } });
    // CLIProxyAPI has not reloaded the auth file yet: its model list has no work/ ids
    write(file, { ...read(file), listed_prefix: '' });
    expect((await put(id, 'work')).body.accounts.find((a: { id: string }) => a.id === id).prefix).toBe('work');
    const again = (await api('/api/accounts/refresh', { method: 'POST' })).body as AccountsStatus;
    const one = again.accounts.find((a) => a.id === id)!;
    expect(one.prefix).toBe('work');
    expect(one.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    // so another plan cannot take it meanwhile
    const r = await put('claude-two@example.test', 'work');
    expect([r.status, r.body.error]).toEqual([409, 'Another plan already has the short name work.']);
    // it reloaded: the list confirms the name, and from then on the list speaks
    write(file, { ...read(file), listed_prefix: undefined });
    expect(((await api('/api/accounts/refresh', { method: 'POST' })).body as AccountsStatus).accounts.find((a) => a.id === id)!.prefix).toBe('work');
    expect((await put(id, '')).body.accounts.find((a: { id: string }) => a.id === id).prefix).toBeUndefined();
  });

  test('a rename stays while CLIProxyAPI lists the old and the new short name, also after the 5 minutes', async () => {
    const id = 'claude-one@example.test';
    const file = 'claude-one@example.test.json';
    const put = (prefix: string) => api(`/api/accounts/${encodeURIComponent(id)}/prefix`, { method: 'PUT', json: { prefix } });
    const now = async () => ((await api('/api/accounts/refresh', { method: 'POST' })).body as AccountsStatus).accounts.find((a) => a.id === id)!;
    expect((await put('personal')).body.accounts.find((a: { id: string }) => a.id === id).prefix).toBe('personal');
    // the old name comes first in the list, with as many ids as the new one
    write(file, { ...read(file), listed_prefix: ['personal', 'personal-claude'] });
    await put('personal-claude');
    const one = await now();
    expect(one.prefix).toBe('personal-claude');
    expect(one.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    const real = Date.now.bind(Date);
    const clock = spyOn(Date, 'now').mockImplementation(() => real() + 6 * 60_000);
    try {
      expect((await now()).prefix).toBe('personal-claude');
    } finally {
      clock.mockRestore();
    }
    write(file, { ...read(file), listed_prefix: undefined });
    expect((await put('')).body.accounts.find((a: { id: string }) => a.id === id).prefix).toBeUndefined();
  });

  test('"Use when a model refuses": saved on the account; a plan without a short name gets the suggested one, an API key needs none', async () => {
    const id = 'codex-me@example.test';
    const prefixes = () => mgmtCalls().filter((c) => c.path === 'fields' && 'prefix' in c.fields && c.name === 'codex-me@example.test.json');
    expect((await status()).accounts.find((a) => a.id === id)?.prefix).toBeUndefined();
    expect((await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { refusal: 'yes' } })).status).toBe(400);
    const on = await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { refusal: true } });
    expect(on.status).toBe(200);
    // the part of the email before @, written to CLIProxyAPI as the prefix; the owner never typed it
    expect(prefixes()).toEqual([{ path: 'fields', name: 'codex-me@example.test.json', fields: { prefix: 'me' } }]);
    expect(on.body.accounts.find((a: { id: string }) => a.id === id)).toMatchObject({ refusal: true, prefix: 'me' });
    expect((hub.engine.config.getUser() as any).models.accounts.find((a: { id: string }) => a.id === id).refusal).toBe(true);
    expect(hub.engine.repos.audit.list({ limit: 20 }).find((a) => a.action === 'accounts.update')?.detail).toBe('me@example.test: short name me, used when a model refuses');
    // the engine sees it: a refused GPT reply is tried on this plan first, by its prefix
    expect(accountsOf(hub.engine)!.refusalAccounts('gpt-6-astra').map((a) => [a.id, a.prefix])).toEqual([[id, 'me']]);
    // on again: nothing more is written
    await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { refusal: true } });
    expect(prefixes()).toHaveLength(1);
    // off: the mark goes, the short name stays
    const off = await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { refusal: false } });
    expect(off.body.accounts.find((a: { id: string }) => a.id === id)).toMatchObject({ prefix: 'me' });
    expect(off.body.accounts.find((a: { id: string }) => a.id === id).refusal).toBeUndefined();
    // an API key is reached by its own provider: no short name, no CLIProxyAPI call
    const before = mgmtCalls().length;
    const key = await api('/api/accounts/api-anthropic', { method: 'PATCH', json: { refusal: true } });
    expect(key.body.accounts.find((a: { id: string }) => a.id === 'api-anthropic')).toMatchObject({ refusal: true });
    expect(mgmtCalls().slice(before).filter((c) => c.path === 'fields')).toEqual([]);
    await api('/api/accounts/api-anthropic', { method: 'PATCH', json: { refusal: false } });
  });

  test('no answer, event, log line or audit row holds a key or a token', async () => {
    await api('/api/accounts/refresh', { method: 'POST' });
    await api('/api/limits/refresh', { method: 'POST' });
    await api('/api/subscriptions');
    const audit = hub.engine.repos.audit.list({ limit: 500 }).map((a) => JSON.stringify(a));
    const limits = hub.engine.repos.usage.limits().map((l) => JSON.stringify(l));
    const config = JSON.stringify(hub.engine.config.getUser());
    const all = { bodies, events, logs, audit, limits, config: [config] };
    for (const [where, list] of Object.entries(all)) {
      for (const s of SECRETS) {
        const hit = list.find((x) => x.includes(s));
        expect(hit ? `${where}: ${s}` : '').toBe('');
      }
      expect(list.some((x) => /Bearer (?!\$TOKEN\$)\S{8,}/.test(x)) ? where : '').toBe('');
    }
    expect(bodies.length).toBeGreaterThan(10);
    expect(events.some((e) => e.includes('"accounts.updated"'))).toBe(true);
  });
});

describe('without CLIProxyAPI\'s management key', () => {
  test('a signed in plan cannot be marked "Use when a model refuses": it could get no short name', async () => {
    const hub = startHub({}, { models: { accounts: [{ id: 'claude-x@example.test', vendor: 'anthropic', kind: 'subscription', credential: 'claude-x@example.test.json' }] } } as any);
    try {
      const st = (await (await hub.api('/api/accounts')).json()) as AccountsStatus;
      expect(st.management).toBe(false);
      const r = await hub.api(`/api/accounts/${encodeURIComponent('claude-x@example.test')}`, { method: 'PATCH', json: { refusal: true } });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe("Using a plan when a model refuses needs a short name, and short names need CLIProxyAPI's management key. Add it in Subscriptions.");
      expect((hub.engine.config.getUser() as any).models.accounts[0].refusal).toBeUndefined();
    } finally {
      await hub.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// The hub runs the fake itself (builtin)
// ---------------------------------------------------------------------------

describe('builtin: a ChatGPT plan\'s own models reach CLIProxyAPI through its catalog', () => {
  const dir = mkdtempSync(join(scratch, 'builtin-'));
  const mgmtLog = join(dir, 'mgmt.jsonl');
  const callLog = join(dir, 'calls.jsonl');
  const wrapper = join(dir, 'cli-proxy-api');
  let hub: TestHub;
  let catalogServer: ReturnType<typeof Bun.serve>;
  let catalogReads = 0;
  // the official catalog as CLIProxyAPI reads it (router-for-me/models), cut down: one model per section
  const official = {
    claude: [{ id: 'claude-opus-5-5', object: 'model', owned_by: 'anthropic', type: 'claude', display_name: 'Claude Opus 5.5' }],
    'codex-free': [{ id: 'gpt-6-luna', object: 'model', owned_by: 'openai', type: 'openai', display_name: 'GPT 6.0 Luna' }],
    'codex-team': [{ id: 'gpt-6-astra', object: 'model', owned_by: 'openai', type: 'openai', display_name: 'GPT 6.0 Astra' }],
    'codex-plus': [{ id: 'gpt-6-astra', object: 'model', owned_by: 'openai', type: 'openai', display_name: 'GPT 6.0 Astra', context_length: 272000, thinking: { levels: ['low', 'high'] } }],
    'codex-pro': [{ id: 'gpt-6-astra', object: 'model', owned_by: 'openai', type: 'openai', display_name: 'GPT 6.0 Astra' }],
  };
  const mgmtCalls = () => (existsSync(mgmtLog) ? readFileSync(mgmtLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const authDir = () => join(hub.engine.home, 'cliproxy', 'auth');
  const write = (name: string, acct: Record<string, unknown>) => writeFileSync(join(authDir(), name), JSON.stringify({ access_token: 'at-fake-SECRET', refresh_token: 'rt-fake-SECRET', ...acct }));
  const accountModels = async (id: string) => ((await (await hub.api('/api/accounts')).json()) as AccountsStatus).accounts.find((a) => a.id === id)?.models.map((m) => m.id) ?? [];

  beforeAll(async () => {
    catalogServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => (new URL(req.url).pathname === '/models.json' ? (catalogReads++, Response.json(official)) : new Response('no', { status: 404 })),
    });
    // the hub starts CLIProxyAPI with only the variables it allows: the fake's own settings ride in its start script
    writeFileSync(wrapper, `#!/bin/sh\nFAKE_CPA_MGMT_LOG='${mgmtLog}' FAKE_CPA_LOG='${callLog}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    hub = startHub({ cliproxy: { catalogUrls: [`http://127.0.0.1:${catalogServer.port}/nothing.json`, `http://127.0.0.1:${catalogServer.port}/models.json`], credentialsMs: 200, usageMs: [60_000, 60_000], random: () => 0, readyTimeoutMs: 15_000 } }, { models: { cliproxy: { mode: 'builtin', binary: wrapper } } } as any);
    await until(async () => ((await (await hub.api('/api/subscriptions')).json()) as SubscriptionsStatus).state === 'on', 15_000, 'the hub to run the fake');
    write('codex-me@example.test.json', { type: 'codex', email: 'me@example.test', plan_type: 'plus', codex_models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-nova', { slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide' }] });
    write('codex-you@example.test.json', { type: 'codex', email: 'you@example.test', plan_type: 'pro' });
    await until(async () => ((await (await hub.api('/api/accounts')).json()) as AccountsStatus).accounts.length === 2, 8000, 'both plans');
  }, 30_000);

  afterAll(async () => {
    await hub?.stop();
    catalogServer?.stop(true);
  });

  test('Refresh models: the plan\'s own list adds gpt-6.2-nova to its catalog section, CLIProxyAPI lists and routes it', async () => {
    expect(hub.engine.config.get().providers.cliproxy.models ?? []).not.toContain('gpt-6.2-nova');
    const r = await hub.api('/api/models/refresh', { method: 'POST' });
    expect(r.status).toBe(200);
    // CLIProxyAPI was pointed at a catalog the hub wrote in its own folder
    const set = await until(() => mgmtCalls().find((c) => c.path === 'catalog' && c.catalog), 8000, 'the catalog');
    expect(set.catalog.startsWith(join(hub.engine.home, 'cliproxy', 'catalog-'))).toBe(true);
    const written = JSON.parse(readFileSync(set.catalog, 'utf8'));
    // in the plus plan's section only, with that section's capabilities; a hidden model stays out
    expect(written['codex-plus'].map((m: { id: string }) => m.id)).toEqual(['gpt-6-astra', 'gpt-6.2-nova']);
    expect(written['codex-plus'][1]).toMatchObject({ id: 'gpt-6.2-nova', display_name: 'gpt-6.2-nova', context_length: 272000, thinking: { levels: ['low', 'high'] } });
    expect(written['codex-pro'].map((m: { id: string }) => m.id)).toEqual(['gpt-6-astra']);
    expect(written.claude).toEqual(official.claude);
    expect(catalogReads).toBe(1);
    // the picker and the plan have it; the pro plan does not
    await until(() => (hub.engine.config.get().providers.cliproxy.models ?? []).includes('gpt-6.2-nova'), 8000, 'gpt-6.2-nova in the model list');
    expect(await accountModels('codex-me@example.test')).toContain('gpt-6.2-nova');
    expect(await accountModels('codex-you@example.test')).not.toContain('gpt-6.2-nova');
    // a request for it reaches CLIProxyAPI's router and is served
    const reg = new ProviderRegistry(hub.engine.config);
    let text = '';
    for await (const ev of reg.get('cliproxy')!.stream({ model: 'gpt-6.2-nova', system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 8 })) if (ev.type === 'text_delta') text += ev.text;
    reg.dispose();
    expect(text).toBe('Hello from gpt-6.2-nova over responses');
    // the same lists again change nothing: no new file, no new call
    const before = mgmtCalls().filter((c) => c.path === 'catalog').length;
    await hub.api('/api/models/refresh', { method: 'POST' });
    expect(mgmtCalls().filter((c) => c.path === 'catalog').length).toBe(before);
    expect(readdirSync(join(hub.engine.home, 'cliproxy')).filter((n) => n.startsWith('catalog-'))).toHaveLength(1);
  }, 20_000);

  test('a rename on the hub that runs CLIProxyAPI is saved and stays through its reads', async () => {
    const id = 'codex-you@example.test';
    const r = await hub.api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { label: 'ChatGPT Pro' } });
    expect(((await r.json()) as AccountsStatus).accounts.find((a) => a.id === id)?.label).toBe('ChatGPT Pro');
    // credentials polls (200 ms), a full read and a models read go by
    await Bun.sleep(600);
    await hub.api('/api/accounts/refresh', { method: 'POST' });
    await hub.api('/api/models/refresh', { method: 'POST' });
    const st = (await (await hub.api('/api/accounts')).json()) as AccountsStatus;
    expect(st.accounts.find((a) => a.id === id)).toMatchObject({ label: 'ChatGPT Pro', email: 'you@example.test' });
    expect((hub.engine.config.getUser() as any).models.accounts.find((a: { id: string }) => a.id === id)).toMatchObject({ label: 'ChatGPT Pro', credential: 'codex-you@example.test.json' });
  }, 20_000);

  test("the plan's own list names its models and their Effort levels, hides what it hides, and turns a Daybreak alias into a Daybreak Blue row; read again with its entity tag", async () => {
    const plan = [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'ultra' }], default_reasoning_level: 'medium' },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high'] },
      { slug: 'gpt-daybreak-blue-latest', display_name: 'Daybreak Blue', visibility: 'list' },
      { slug: 'gpt-reserve', display_name: 'Reserve', visibility: 'hide' },
      { slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide' },
    ];
    // no alias in the list yet: no Daybreak row, no approval
    expect(hub.engine.config.get().providers.cliproxy.models ?? []).not.toContain('gpt-daybreak-blue-latest');
    expect(accountsOf(hub.engine)!.credentialOf('codex-me@example.test')?.daybreak).toBeUndefined();
    // CLIProxyAPI registers models the plan hides (its catalog names them "GPT 6.0 Astra"), as on the owner's hub
    write('codex-me@example.test.json', { type: 'codex', email: 'me@example.test', plan_type: 'plus', codex_models: plan, codex_models_etag: '"v1"', extra_models: ['codex-auto-review', 'gpt-reserve'] });
    await hub.api('/api/models/refresh', { method: 'POST' });
    const p = () => hub.engine.config.get().providers.cliproxy;
    await until(() => p().modelMeta?.['gpt-6.1-sol'], 8000, 'the plan meta');
    // the Accounts page: the plan's names, nothing it hides, no alias
    const listed = async () => ((await (await hub.api('/api/accounts')).json()) as AccountsStatus).accounts.find((a) => a.id === 'codex-me@example.test')?.models ?? [];
    await until(async () => (await listed()).find((m) => m.id === 'gpt-6.1-sol')?.name === 'GPT-6.1-Sol', 8000, 'the plan names on the Accounts page');
    expect(await listed()).toContainEqual({ id: 'gpt-6-astra', name: 'GPT-6-Astra' });
    for (const id of ['gpt-reserve', 'codex-auto-review', 'gpt-daybreak-blue-latest']) expect((await listed()).map((m) => m.id)).not.toContain(id);
    // approved for Daybreak Blue: the alias is its row, named for the program, run on gpt-6-sol with daybreak_blue
    expect(accountsOf(hub.engine)!.credentialOf('codex-me@example.test')?.daybreak).toEqual(['daybreak_blue']);
    expect(p().models).toContain('gpt-daybreak-blue-latest');
    const rows = new ProviderRegistry(hub.engine.config);
    expect(rows.resolveAt('cliproxy', 'gpt-daybreak-blue-latest').info.name).toBe('Daybreak Blue');
    expect(rows.resolve('cliproxy/gpt-daybreak-blue-latest')).toMatchObject({ provider: 'cliproxy', model: 'gpt-6-sol' });
    rows.dispose();
    expect(p().modelMeta).toMatchObject({ 'gpt-6.1-sol': { name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'], defaultEffort: 'medium' }, 'gpt-6-astra': { name: 'GPT-6-Astra', efforts: ['low', 'medium', 'high'] } });
    for (const id of ['gpt-reserve', 'codex-auto-review']) expect(p().models).not.toContain(id);
    // the picker gets the plan's name and levels, ultra included
    const reg = new ProviderRegistry(hub.engine.config);
    expect(reg.resolveAt('cliproxy', 'gpt-6.1-sol').info).toMatchObject({ name: 'GPT-6.1-Sol', effort: { levels: ['low', 'medium', 'high', 'xhigh', 'ultra'], default: 'medium' }, cyber: ['standard', 'daybreak_blue'] });
    reg.dispose();
    // Refresh models again: the tag goes back, the 304 keeps the list
    await hub.api('/api/models/refresh', { method: 'POST' });
    const last = mgmtCalls().filter((c) => c.path === 'api-call' && c.url.includes('codex/models') && c.name === 'codex-me@example.test.json').at(-1);
    expect(last.headers).toContain('If-None-Match');
    expect(p().modelMeta?.['gpt-6.1-sol']?.name).toBe('GPT-6.1-Sol');
  }, 20_000);

  test('once no plan lists a model CLIProxyAPI lacks, it goes back to its own catalog', async () => {
    write('codex-me@example.test.json', { type: 'codex', email: 'me@example.test', plan_type: 'plus', codex_models: ['gpt-6-astra', 'gpt-6.1-sol'] });
    await hub.api('/api/models/refresh', { method: 'POST' });
    await until(() => mgmtCalls().filter((c) => c.path === 'catalog').at(-1)?.catalog === null, 8000, 'the catalog cleared');
    expect(readdirSync(join(hub.engine.home, 'cliproxy')).filter((n) => n.startsWith('catalog-'))).toEqual([]);
    await until(() => !(hub.engine.config.get().providers.cliproxy.models ?? []).includes('gpt-6.2-nova'), 8000, 'gpt-6.2-nova gone');
  }, 20_000);
});

void appendFileSync;
