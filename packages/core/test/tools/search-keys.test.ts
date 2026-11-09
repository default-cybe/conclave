/**
 * Several web search keys per engine (tools/search-keys.ts, websearch.ts,
 * search-settings.ts): rotation on each refusal, cool-off and reset, the
 * automatic order falling through to the next engine, the single-key
 * migration, no key in replies or logs, members kept apart, and the loop
 * guard stopping WebSearch once every key is down.
 *
 *   bun test packages/core/test/tools/search-keys.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { classifyKeyError, COOLOFF_MS, keyPool, memoryMeta, nextUtcDay, readKeys } from '../../src/tools/search-keys';
import { activeEngine, webSearch, type SearchKeys } from '../../src/tools/websearch';
import { hubKeyStore, memberKeyStore, memberSearchKeys, memberSearchSettings, patchSearchKeys, searchSettings, storeKeys, updateSearchKey, type SearchKeyStore } from '../../src/tools/search-settings';
import { LoopGuard } from '../../src/session/loop-guard';
import { setLogTap } from '../../src/util/log';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setLogTap(undefined);
});

/** A secrets map that looks like ConfigStore's values. */
function fakeConfig(values: Record<string, string> = {}, provider = 'auto') {
  const v = new Map(Object.entries(values));
  return {
    v,
    get: () => ({ search: { provider } }) as never,
    getUser: () => ({}) as never,
    replace: () => undefined,
    secretValue: (n: string) => v.get(n),
    setSecret: (_k: 'values' | 'providers', n: string, val: string | undefined) => void (val === undefined ? v.delete(n) : v.set(n, val)),
  };
}

const store = (values: Record<string, string> = {}): SearchKeyStore & { v: Map<string, string> } => {
  const c = fakeConfig(values);
  return { ...hubKeyStore(c, memoryMeta()), v: c.v };
};

/** fetch answers by the key in the request: status per key, results otherwise. */
function serve(byKey: Record<string, { status: number; body?: string; headers?: Record<string, string> }>, seen: string[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const raw = `${String(input)} ${h.get('x-subscription-token') ?? ''} ${h.get('authorization') ?? ''} ${typeof init?.body === 'string' ? init.body : ''}`;
    const key = Object.keys(byKey).find((k) => k && raw.includes(k)) ?? '';
    seen.push(/(?:BSA|tvly)-[\w-]+/.exec(raw)?.[0] ?? '');
    const r = byKey[key];
    if (r && r.status !== 200) return new Response(r.body ?? '', { status: r.status, headers: r.headers });
    if (String(input).includes('duckduckgo')) return new Response('<html></html>', { status: 200 });
    // a Brave-shaped and a Tavily-shaped answer in one
    return Response.json({ web: { results: [{ title: 'T', url: 'https://ex.com/a', description: 'd' }] }, results: [{ title: 'T', url: 'https://ex.com/a', content: 'd' }] });
  }) as typeof fetch;
  return seen;
}

const sig = () => new AbortController().signal;

describe('classifyKeyError', () => {
  const now = Date.UTC(2026, 10, 8, 15, 0, 0);
  test('401 and invalid keys are rejected', () => {
    expect(classifyKeyError(401, '', undefined, now)?.status).toBe('rejected');
    expect(classifyKeyError(422, '{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"invalid subscription token"}', undefined, now)?.status).toBe('rejected');
  });
  test('402 and 403 are out of credit until the next UTC day, or the reset header', () => {
    expect(classifyKeyError(402, '', undefined, now)).toEqual({ status: 'credit', until: nextUtcDay(now), at: now });
    expect(classifyKeyError(403, 'Forbidden', undefined, now)?.until).toBe(nextUtcDay(now));
    expect(classifyKeyError(403, 'quota', new Headers({ 'x-ratelimit-reset': '1, 3600' }), now)?.until).toBe(now + 3600_000);
  });
  test('429 cools off briefly, or until Retry-After; a 429 about the quota is out of credit', () => {
    expect(classifyKeyError(429, 'slow down', undefined, now)).toEqual({ status: 'cooloff', until: now + COOLOFF_MS, at: now });
    expect(classifyKeyError(429, '', new Headers({ 'retry-after': '5' }), now)?.until).toBe(now + 5000);
    expect(classifyKeyError(429, 'monthly quota exceeded', undefined, now)?.status).toBe('credit');
  });
  test('server errors and bad queries do not blame the key', () => {
    expect(classifyKeyError(500, 'oops', undefined, now)).toBeUndefined();
    expect(classifyKeyError(400, 'q is required', undefined, now)).toBeUndefined();
  });
});

describe('rotation', () => {
  for (const [status, mark] of [
    [401, 'rejected'],
    [402, 'credit'],
    [403, 'credit'],
    [429, 'cooloff'],
  ] as const) {
    test(`HTTP ${status}: key 1 is marked ${mark} and the same call runs on key 2`, async () => {
      const s = store();
      updateSearchKey(s, { provider: 'brave', key: 'BSA-first-key-0001', add: true, label: 'personal' });
      updateSearchKey(s, { provider: 'brave', key: 'BSA-second-key-0002', add: true, label: 'card 2' });
      const seen = serve({ 'BSA-first-key-0001': { status } });
      const out = await webSearch({ provider: 'brave' } as never, 'bun', { signal: sig(), keys: storeKeys(s) });
      expect(out.provider).toBe('brave');
      expect(out.results.length).toBe(1);
      expect(seen).toEqual(['BSA-first-key-0001', 'BSA-second-key-0002']);
      expect(out.note).toContain('"personal"');
      const keys = storeKeys(s).pool.list('brave');
      expect(keys[0]!.mark?.status).toBe(mark);
      expect(keys[1]!.mark).toBeUndefined();
      // the next call skips the marked key
      seen.length = 0;
      await webSearch({ provider: 'brave' } as never, 'bun', { signal: sig(), keys: storeKeys(s) });
      expect(seen).toEqual(['BSA-second-key-0002']);
    });
  }

  test('a cool-off ends by itself; a rejected key stays down until it is replaced', () => {
    const meta = memoryMeta();
    const slots = { v: new Map([['search.brave', 'BSA-aaaaaaaaaaaa']]), get(n: string) { return this.v.get(n); }, set(n: string, x?: string) { if (x) this.v.set(n, x); else this.v.delete(n); } };
    const pool = keyPool(slots, meta);
    pool.mark('brave', 'BSA-aaaaaaaaaaaa', { status: 'cooloff', until: Date.now() - 1, at: Date.now() - 2 });
    expect(pool.list('brave')[0]!.mark).toBeUndefined();
    pool.mark('brave', 'BSA-aaaaaaaaaaaa', { status: 'rejected', at: Date.now() - 1e9 });
    expect(pool.list('brave')[0]!.mark?.status).toBe('rejected');
    const s = { slots, meta };
    updateSearchKey(s, { provider: 'brave', key: 'BSA-bbbbbbbbbbbb', index: 0 });
    expect(keyPool(slots, meta).list('brave')[0]!.mark).toBeUndefined();
  });

  test('Automatic falls through to the next engine with a key when every key of one is down', async () => {
    const s = store();
    updateSearchKey(s, { provider: 'tavily', key: 'tvly-only-key-0001', add: true });
    updateSearchKey(s, { provider: 'brave', key: 'BSA-brave-key-0001', add: true });
    serve({ 'tvly-only-key-0001': { status: 432, body: 'usage limit exceeded, plan credits' } });
    const out = await webSearch({ provider: 'auto' } as never, 'bun', { signal: sig(), keys: storeKeys(s) });
    expect(out.provider).toBe('brave');
    expect(activeEngine({ provider: 'auto' } as never, storeKeys(s))).toBe('brave');
  });

  test('nothing left: one clear line, the keysDown flag, and the loop guard stops WebSearch for the turn', async () => {
    const s = store();
    updateSearchKey(s, { provider: 'brave', key: 'BSA-first-key-0001', add: true });
    updateSearchKey(s, { provider: 'brave', key: 'BSA-second-key-0002', add: true });
    serve({ 'BSA-first-key-0001': { status: 402 }, 'BSA-second-key-0002': { status: 402 }, '': { status: 403 } });
    const err = await webSearch({ provider: 'brave' } as never, 'bun', { signal: sig(), keys: storeKeys(s) }).catch((e) => e);
    expect(err.message).toContain('All Brave Search keys are out of credit (2 keys); add one in Settings > Web search');
    expect(err.keysDown).toBe(true);
    const guard = new LoopGuard({ unattended: true });
    const v = guard.after('WebSearch', { query: 'a' }, { content: 'x', isError: true, meta: { searchKeysDown: true } } as never);
    expect(v.code).toBe('search_down');
    expect(guard.before('WebSearch', { query: 'something else' }).level).toBe('halt');
  });
});

describe('storage', () => {
  test('an old single key is key 1; new keys go to search.<id>#2; reorder and remove keep slots packed', () => {
    const s = store({ 'search.brave': 'BSA-old-single-0001' });
    expect(storeKeys(s).pool.list('brave').map((k) => k.key)).toEqual(['BSA-old-single-0001']);
    updateSearchKey(s, { provider: 'brave', key: 'BSA-new-second-0002', add: true, label: 'card 2' });
    expect(s.v.get('search.brave#2')).toBe('BSA-new-second-0002');
    patchSearchKeys(s, { provider: 'brave', order: [1, 0] });
    expect(readKeys(s.slots, 'brave')).toEqual(['BSA-new-second-0002', 'BSA-old-single-0001']);
    expect(storeKeys(s).pool.list('brave')[0]!.label).toBe('card 2');
    updateSearchKey(s, { provider: 'brave', key: null, index: 0 });
    expect([...s.v.keys()]).toEqual(['search.brave']);
  });

  test('replies and logs carry labels and last 4 characters, never a key', async () => {
    const KEY = 'BSA-very-secret-key-9z9z';
    const c = fakeConfig();
    const s = hubKeyStore(c, memoryMeta());
    updateSearchKey(s, { provider: 'brave', key: KEY, add: true, label: 'personal' });
    updateSearchKey(s, { provider: 'brave', key: 'BSA-other-secret-key-1a1a', add: true });
    const dto = searchSettings(c as never, s);
    expect(JSON.stringify(dto)).not.toContain(KEY);
    expect(dto.providers.find((p) => p.id === 'brave')!.keys[0]).toEqual({ label: 'personal', last4: '9z9z', status: 'working' });
    const lines: string[] = [];
    setLogTap((_l, _s, msg, extra) => void lines.push(`${msg} ${JSON.stringify(extra ?? '')}`));
    serve({ [KEY]: { status: 401, body: `bad token ${KEY}` } });
    const out = await webSearch({ provider: 'brave' } as never, 'bun', { signal: sig(), keys: storeKeys(s) });
    expect(lines.join('\n')).toContain('"personal"');
    expect(lines.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  test('members are kept apart: their own keys only, the hub keys never in their reply', () => {
    const c = fakeConfig({ 'search.brave': 'BSA-hub-owner-key-0001' });
    const hub = hubKeyStore(c, memoryMeta());
    const files = new Map<string, Map<string, string>>();
    const secrets = {
      value: (a: string, n: string) => files.get(a)?.get(n),
      set: (a: string, _k: 'values' | 'providers', n: string, v: string | undefined) => {
        const m = files.get(a) ?? new Map();
        if (v === undefined) m.delete(n);
        else m.set(n, v);
        files.set(a, m);
      },
    };
    const sam = memberKeyStore(secrets as never, 'sam', memoryMeta());
    const ann = memberKeyStore(secrets as never, 'ann', memoryMeta());
    updateSearchKey(sam, { provider: 'tavily', key: 'tvly-sam-own-key-0001', add: true });
    expect(storeKeys(ann, true).pool.list('tavily')).toEqual([]);
    const view = memberSearchSettings(c as never, ann, false, hub);
    expect(JSON.stringify(view)).not.toContain('0001');
    expect(view.providers.every((p) => p.keys.length === 0)).toBe(true);
    // not allowed the hub's search: no keys at all, so DuckDuckGo
    const k: SearchKeys = memberSearchKeys(ann, hub, false);
    expect(k.pool.list('brave')).toEqual([]);
    expect(memberSearchKeys(ann, hub, true).pool.list('brave').length).toBe(1);
  });
});
