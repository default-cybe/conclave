/**
 * The window starter (core/src/accounts/starter.ts) on a fake clock with a
 * fake provider: when it sends, what it sends, to which account, and what
 * stops it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { AccountsService, checkStarter, type CliproxyCredentialFacts } from '../../src/accounts/service';
import {
  STARTER_MAX_TOKENS,
  STARTER_PROMPT,
  WindowStarter,
  classifyError,
  decide,
  hoursOf,
  inHours,
  nextStart,
  observe,
  pinFor,
  starterCandidates,
  type StarterFacts,
  type StarterMemory,
  type StarterSendResult,
} from '../../src/accounts/starter';
import { ProviderError, type ChatRequest } from '../../src/providers/types';
import type { LimitWindow } from '../../src/types';
import type { UsageInput } from '../../src/usage/readers/common';
import { UsageService } from '../../src/usage/service';

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const T = (iso: string) => Date.parse(iso);

const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5'];

function claude(extra: Partial<StarterFacts> = {}): StarterFacts {
  return { id: 'claude-a', label: 'Account 1', vendor: 'anthropic', provider: 'cliproxy', enabled: true, disabled: false, windows: [], cooldowns: [], models: CLAUDE_MODELS, starter: { enabled: true }, ...extra };
}

const w5 = (resetsAt: number | undefined, observedAt: number, extra: Partial<LimitWindow> = {}): LimitWindow => ({ name: '5h', usedPercent: 20, ...(resetsAt ? { resetsAt } : {}), observedAt, source: 'headers', ...extra });
const week = (usedPercent: number, resetsAt: number, observedAt: number, name = '7d'): LimitWindow => ({ name, usedPercent, resetsAt, observedAt, source: 'oauth' });

const ok = (): StarterSendResult => ({ usage: { inputTokens: 14, outputTokens: 1 }, windows: [], latencyMs: 320, costUsd: 0 });

function harness(opts: { facts: StarterFacts[]; now: number; zone?: string; send?: (provider: string, req: ChatRequest) => StarterSendResult | Promise<StarterSendResult> }) {
  const clock = { t: opts.now };
  const box = { facts: opts.facts };
  const planned = new Map<string, number | undefined>();
  const sent: Array<{ provider: string; req: ChatRequest; at: number }> = [];
  const rows: UsageInput[] = [];
  const notes: Array<{ title: string; body: string }> = [];
  const reads: Array<{ id: string; usage?: boolean; at: number }> = [];
  const hooks: { onRead?: (id: string, o: { usage?: boolean }) => void } = {};
  const kv = new Map<string, unknown>();
  const starter = new WindowStarter({
    facts: () => box.facts,
    kv: { get: <V>(k: string, d: V) => (kv.has(k) ? (structuredClone(kv.get(k)) as V) : d), set: (k: string, v: unknown) => void kv.set(k, structuredClone(v)) },
    zone: () => opts.zone ?? 'UTC',
    plan: (id, at) => void planned.set(id, at),
    send: async (provider, req) => {
      sent.push({ provider, req, at: clock.t });
      return (opts.send ?? ok)(provider, req);
    },
    read: async (id, o) => {
      reads.push({ id, ...o, at: clock.t });
      hooks.onRead?.(id, o);
    },
    record: (r) => void rows.push(r),
    notify: (title, body) => void notes.push({ title, body }),
    now: () => clock.t,
  });
  /** Set the clock to the planned wake and run the job, as the scheduler would. */
  const wake = async (id = 'claude-a') => {
    const at = planned.get(id);
    if (at === undefined) throw new Error(`nothing planned for ${id}`);
    clock.t = Math.max(clock.t, at);
    await starter.run(id);
  };
  const view = (id = 'claude-a') => starter.view(box.facts.find((f) => f.id === id)!, box.facts);
  return { clock, box, planned, sent, rows, notes, reads, hooks, starter, wake, view, kv };
}

describe('hours and models', () => {
  test('the hours are in the zone, end inclusive, and may run past midnight', () => {
    const h = hoursOf({ start: '07:00', end: '22:30' }, 'Europe/Berlin');
    expect(h).toEqual({ start: 420, end: 1350, tz: 'Europe/Berlin' });
    // 06:59 and 22:31 in Berlin (CEST, UTC+2) are outside, 22:30 is inside
    expect(inHours(T('2026-10-23T04:59:00Z'), h)).toBe(false);
    expect(inHours(T('2026-10-23T20:30:00Z'), h)).toBe(true);
    expect(inHours(T('2026-10-23T20:31:00Z'), h)).toBe(false);
    // the night after the clocks go back (25 October 2026): the next start is 07:00 CET, 06:00 UTC
    expect(nextStart(T('2026-10-24T21:00:00Z'), h)).toBe(T('2026-10-25T06:00:00Z'));
    const night = hoursOf({ start: '22:00', end: '02:00' }, 'UTC');
    expect(inHours(T('2026-10-23T23:30:00Z'), night)).toBe(true);
    expect(inHours(T('2026-10-24T01:59:00Z'), night)).toBe(true);
    expect(inHours(T('2026-10-24T12:00:00Z'), night)).toBe(false);
    expect(nextStart(T('2026-10-24T12:00:00Z'), night)).toBe(T('2026-10-24T22:00:00Z'));
  });

  test('the cheapest model: newest Haiku, the smallest GPT, Flash; the owner can set one', () => {
    expect(starterCandidates('anthropic', CLAUDE_MODELS)).toEqual(['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5']);
    expect(starterCandidates('openai', ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-luna', 'gpt-6-luna', 'gpt-5.4-nano', 'gpt-5.3-codex'])).toEqual(['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-nano', 'gpt-6.1-sol', 'gpt-6-astra']);
    expect(starterCandidates('gemini', ['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-3-flash-image'])).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite']);
    // an account whose list was not read yet: the catalog's
    expect(starterCandidates('anthropic')[0]).toMatch(/^claude-haiku-/);
    expect(starterCandidates('moonshot', ['kimi-k3'])).toEqual([]);
    const own = claude({ starter: { enabled: true, model: 'claude-sonnet-5-5' }, windows: [w5(T('2026-10-23T12:00:00Z'), T('2026-10-23T09:00:00Z'))] });
    expect(decide(own, [own], { failures: 0 }, T('2026-10-23T10:00:00Z'), 'UTC').model).toBe('claude-sonnet-5-5');
  });

  test('errors in a few words, and what each means', () => {
    expect(classifyError(new ProviderError('rate_limit', 'Too many requests', { status: 429 }))).toEqual({ kind: 'stop', words: '429' });
    expect(classifyError(new ProviderError('auth', 'invalid x-api-key sk-ant-oat01-not-real', { status: 401 }))).toEqual({ kind: 'stop', words: 'Sign-in failed' });
    expect(classifyError(new ProviderError('bad_request', 'model not found', { status: 404 })).kind).toBe('model');
    expect(classifyError(new ProviderError('server', 'HTTP 500', { status: 500 })).kind).toBe('retry');
    expect(classifyError(new ProviderError('network', 'socket hang up')).kind).toBe('retry');
    expect(classifyError(new ProviderError('rate_limit', 'All credentials for model claude-haiku-5-5 are cooling down', { status: 429, body: '{"error":{"code":"model_cooldown","reset_seconds":12}}' }))).toEqual({ kind: 'cooldown', words: 'CLIProxyAPI cooldown', waitMs: 12 * S });
  });

  test('a placeholder reset that moves with each reading is no window', () => {
    const mem: StarterMemory = { failures: 0 };
    const t0 = T('2026-10-23T10:00:00Z');
    observe(mem, w5(t0 + 5 * H, t0, { source: 'oauth', usedPercent: 0 }));
    expect(mem.rolling).toBe(false);
    observe(mem, w5(t0 + 6 * MIN + 5 * H, t0 + 6 * MIN, { source: 'oauth', usedPercent: 0 }));
    expect(mem.rolling).toBe(true);
    // a running window keeps its reset
    observe(mem, w5(t0 + 6 * MIN + 5 * H, t0 + 12 * MIN, { source: 'oauth', usedPercent: 3 }));
    expect(mem.rolling).toBe(false);
  });
});

describe('the window starter', () => {
  test('fires 3 s after the reset within the hours, after a read 30 s before', async () => {
    const now = T('2026-10-23T10:00:00Z');
    const h = harness({ facts: [claude({ windows: [w5(T('2026-10-23T14:00:00Z'), now - MIN)] })], now });
    h.starter.plan();
    expect(h.planned.get('claude-a')).toBe(T('2026-10-23T13:59:30Z'));
    await h.wake();
    expect(h.reads).toEqual([{ id: 'claude-a', usage: true, at: T('2026-10-23T13:59:30Z') }]);
    expect(h.sent).toEqual([]);
    expect(h.planned.get('claude-a')).toBe(T('2026-10-23T14:00:03Z'));
    expect(h.view()).toMatchObject({ state: 'scheduled', nextAt: T('2026-10-23T14:00:03Z') });
    await h.wake();
    expect(h.sent.map((s) => s.at)).toEqual([T('2026-10-23T14:00:03Z')]);
    expect(h.view().state).toBe('checking');
    expect(h.planned.get('claude-a')).toBe(T('2026-10-23T14:00:08Z'));
  });

  test('a reset outside the hours waits for the start, in the owner zone', async () => {
    // 23:00 in Berlin: the request waits for 07:00 the next morning
    const now = T('2026-10-23T10:00:00Z');
    const h = harness({ facts: [claude({ windows: [w5(T('2026-10-23T21:00:00Z'), now - MIN)] })], now, zone: 'Europe/Berlin' });
    h.starter.plan();
    expect(h.view()).toMatchObject({ state: 'scheduled', nextAt: T('2026-10-24T05:00:00Z'), zone: 'Europe/Berlin' });
    expect(h.planned.get('claude-a')).toBe(T('2026-10-24T05:00:00Z'));
    // no window runs at 05:00 UTC: it waits for 07:00
    const early = harness({ facts: [claude({ windows: [w5(T('2026-10-23T04:00:00Z'), T('2026-10-23T00:00:00Z'))] })], now: T('2026-10-23T05:00:00Z') });
    early.starter.plan();
    expect(early.planned.get('claude-a')).toBe(T('2026-10-23T07:00:00Z'));
    await early.wake();
    expect(early.sent).toHaveLength(1);
    // the owner's own hours
    const own = harness({ facts: [claude({ starter: { enabled: true, start: '09:00', end: '18:00' }, windows: [w5(T('2026-10-23T18:30:00Z'), T('2026-10-23T14:00:00Z'))] })], now: T('2026-10-23T14:00:00Z') });
    own.starter.plan();
    expect(own.view().nextAt).toBe(T('2026-10-24T09:00:00Z'));
  });

  test('counts only once the window shows a fixed reset in the future', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const h = harness({ facts: [claude({ windows: [w5(reset, reset - 4 * H)] })], now: reset + 3 * S });
    h.starter.plan();
    await h.wake(); // fires: the window ended at 14:00
    expect(h.sent).toHaveLength(1);
    // the first read shows nothing new
    await h.wake();
    expect(h.view().state).toBe('checking');
    expect(h.reads.at(-1)).toMatchObject({ usage: false });
    // then the headers of the starter's own response: a reset 5 hours on
    h.hooks.onRead = () => (h.box.facts = [claude({ windows: [w5(reset + 5 * H + 4 * S, reset + 5 * S)] })]);
    await h.wake();
    expect(h.view()).toMatchObject({ state: 'scheduled', startedAt: reset + 18 * S, nextAt: reset + 5 * H + 7 * S, lastModel: 'claude-haiku-5-5' });
    expect(h.notes).toEqual([]);
  });

  test('a request that starts no window stops it until the next day, with one notice', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const h = harness({ facts: [claude({ windows: [w5(reset, reset - 4 * H)] })], now: reset + 3 * S });
    h.starter.plan();
    await h.wake();
    // the usage page shows a placeholder: a reset 5 hours after each reading
    h.hooks.onRead = (_id, o) => {
      if (o.usage) h.box.facts = [claude({ windows: [w5(h.clock.t + 5 * H, h.clock.t, { source: 'oauth', usedPercent: 0 })] })];
    };
    for (let i = 0; i < 5; i++) await h.wake();
    expect(h.reads.map((r) => r.usage)).toEqual([false, false, true, true, true]);
    expect(h.view()).toMatchObject({ state: 'stopped', until: T('2026-10-24T07:00:00Z'), reason: 'No window started' });
    expect(h.notes).toEqual([{ title: 'Window starter stopped: Account 1', body: 'No window started. It tries again tomorrow at 07:00.' }]);
    h.starter.plan();
    h.starter.plan();
    expect(h.notes).toHaveLength(1);
  });

  test('a 429 or a sign-in failure stops it until the next day', async () => {
    for (const [err, words] of [
      [new ProviderError('rate_limit', 'rate limited', { status: 429 }), '429'],
      [new ProviderError('auth', 'OAuth token expired', { status: 401 }), 'Sign-in failed'],
    ] as const) {
      const reset = T('2026-10-23T14:00:00Z');
      const h = harness({
        facts: [claude({ windows: [w5(reset, reset - 4 * H)] })],
        now: reset + 3 * S,
        send: () => {
          throw err;
        },
      });
      h.starter.plan();
      await h.wake();
      expect(h.sent).toHaveLength(1);
      expect(h.view()).toMatchObject({ state: 'stopped', until: T('2026-10-24T07:00:00Z'), reason: words });
      expect(h.notes).toEqual([{ title: 'Window starter stopped: Account 1', body: `${words}. It tries again tomorrow at 07:00.` }]);
      expect(h.rows).toEqual([]);
      // nothing more today; at 07:00 it starts again
      expect(h.planned.get('claude-a')).toBe(T('2026-10-24T07:00:00Z'));
      await h.wake();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].at).toBe(T('2026-10-24T07:00:00Z'));
    }
  });

  test('network and server errors try again after 5 and 15 minutes, then stop for the day', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const h = harness({
      facts: [claude({ windows: [w5(reset, reset - 4 * H)] })],
      now: reset + 3 * S,
      send: () => {
        throw new ProviderError('server', 'HTTP 502 from upstream', { status: 502 });
      },
    });
    h.starter.plan();
    await h.wake();
    expect(h.view()).toMatchObject({ state: 'scheduled', nextAt: reset + 3 * S + 5 * MIN, failures: 1, reason: 'Server error' });
    await h.wake();
    expect(h.view()).toMatchObject({ state: 'scheduled', nextAt: reset + 3 * S + 20 * MIN, failures: 2 });
    await h.wake();
    expect(h.sent.map((s) => s.at - reset)).toEqual([3 * S, 3 * S + 5 * MIN, 3 * S + 20 * MIN]);
    expect(h.view()).toMatchObject({ state: 'stopped', reason: 'Server error', until: T('2026-10-24T07:00:00Z') });
    expect(h.notes).toHaveLength(1);
  });

  test('a short CLIProxyAPI cooldown is waited out once without counting', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const cooling = new ProviderError('rate_limit', 'All credentials for model claude-haiku-5-5 are cooling down', { status: 429, body: '{"error":{"code":"model_cooldown","reset_seconds":12}}' });
    let n = 0;
    const h = harness({
      facts: [claude({ windows: [w5(reset, reset - 4 * H)] })],
      now: reset + 3 * S,
      send: () => {
        if (n++ < 2) throw cooling;
        return ok();
      },
    });
    h.starter.plan();
    await h.wake();
    expect(h.view()).toMatchObject({ state: 'scheduled', nextAt: reset + 18 * S });
    expect(h.view().failures).toBeUndefined();
    // a second one right after counts as an error: 5 minutes
    await h.wake();
    expect(h.view()).toMatchObject({ state: 'scheduled', nextAt: reset + 18 * S + 5 * MIN, failures: 1 });
    expect(h.notes).toEqual([]);
  });

  test('a model the plan refuses: the next one once, and the refused one rests', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const h = harness({
      facts: [claude({ windows: [w5(reset, reset - 4 * H)] })],
      now: reset + 3 * S,
      send: (_p, req) => {
        if (req.model === 'claude-haiku-5-5') throw new ProviderError('bad_request', 'model not available for this account', { status: 400 });
        return ok();
      },
    });
    h.starter.plan();
    await h.wake();
    expect(h.sent.map((s) => s.req.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-4-5']);
    expect(h.view().state).toBe('checking');
    // the owner's own model is not swapped: refused, it stops for the day
    const own = harness({
      facts: [claude({ starter: { enabled: true, model: 'claude-haiku-5-5' }, windows: [w5(reset, reset - 4 * H)] })],
      now: reset + 3 * S,
      send: () => {
        throw new ProviderError('bad_request', 'model not available', { status: 404 });
      },
    });
    own.starter.plan();
    await own.wake();
    expect(own.sent).toHaveLength(1);
    expect(own.view()).toMatchObject({ state: 'stopped', reason: 'Model not available' });
  });

  test('pauses while the weekly window is used up, and only for the models it limits', async () => {
    const now = T('2026-10-23T14:00:03Z');
    const tue = T('2026-10-27T10:00:00Z');
    const h = harness({ facts: [claude({ windows: [w5(T('2026-10-23T14:00:00Z'), now - H), week(100, tue, now - MIN)] })], now });
    h.starter.plan();
    expect(h.view()).toMatchObject({ state: 'paused', until: tue, reason: 'Weekly limit used up' });
    expect(h.planned.get('claude-a')).toBe(tue + 30 * S);
    await h.starter.run('claude-a');
    expect(h.sent).toEqual([]);
    // the week resets: a read, then a request
    await h.wake();
    expect(h.reads.at(-1)).toMatchObject({ usage: true, at: tue + 30 * S });
    await h.wake();
    expect(h.sent).toHaveLength(1);
    // a full Opus week does not hold back a Haiku request
    const opus = harness({ facts: [claude({ windows: [w5(T('2026-10-23T14:00:00Z'), now - H), week(100, tue, now - MIN, '7d opus')] })], now });
    opus.starter.plan();
    expect(opus.view().state).toBe('scheduled');
  });

  test('a plan with no 5 hour window never gets a request', async () => {
    const now = T('2026-10-23T14:00:00Z');
    const h = harness({ facts: [claude({ vendor: 'openai', models: ['gpt-6-luna'], windows: [week(30, now + 3 * 86_400_000, now - MIN)] })], now });
    h.starter.plan();
    expect(h.view()).toMatchObject({ state: 'never' });
    expect(h.planned.get('claude-a')).toBeUndefined();
    await h.starter.run('claude-a');
    expect(h.sent).toEqual([]);
    // nothing read yet: it waits
    const none = harness({ facts: [claude()], now });
    none.starter.plan();
    expect(none.view()).toMatchObject({ state: 'waiting', reason: 'No usage read yet' });
    expect(none.planned.get('claude-a')).toBeUndefined();
  });

  test("Antigravity: its model's scoped 5 hour window (5h gemini) is the one it starts", async () => {
    const now = T('2026-10-23T14:00:00Z');
    // mapAntigravityQuota: an unstarted window has no reset; the 3p one runs for Claude and GPT
    const quota = (at: number, gemini: Partial<LimitWindow>): LimitWindow[] => [
      { name: '5h gemini', usedPercent: 0, observedAt: at, source: 'oauth', ...gemini },
      { name: '5h 3p', usedPercent: 40, resetsAt: now + 2 * H, observedAt: at, source: 'oauth' },
      { name: '7d gemini', usedPercent: 10, resetsAt: now + 3 * 86_400_000, observedAt: at, source: 'oauth' },
    ];
    const ag = (windows: LimitWindow[]) => claude({ id: 'ag', vendor: 'gemini', models: ['gemini-3.5-flash', 'claude-opus-5-5-high'], windows });
    const h = harness({ facts: [ag(quota(now - MIN, {}))], now });
    h.starter.plan();
    expect(h.view('ag')).toMatchObject({ state: 'scheduled', nextAt: now - MIN });
    await h.wake('ag');
    expect(h.sent.map((s) => s.req.model)).toEqual(['gemini-3.5-flash']);
    // two usage readings agree on the new reset: the Gemini window started
    h.hooks.onRead = (_id, o) => {
      if (o.usage) h.box.facts = [ag(quota(h.clock.t, { usedPercent: 1, resetsAt: now + 5 * H }))];
    };
    for (let i = 0; i < 4 && h.view('ag').state === 'checking'; i++) await h.wake('ag');
    expect(h.view('ag')).toMatchObject({ state: 'scheduled', nextAt: now + 5 * H + 3 * S });
    // an owner's Claude model goes by the 3p window instead
    const own = ag(quota(now - MIN, {}));
    own.starter = { enabled: true, model: 'claude-opus-5-5-high' };
    expect(decide(own, [own], { failures: 0 }, now, 'UTC')).toMatchObject({ state: 'scheduled', nextAt: now + 2 * H + 3 * S });
  });

  test('the request is "OK" only, at most 4 tokens out, no tools, and its usage row says starter', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const h = harness({ facts: [claude({ windows: [w5(reset, reset - 4 * H)] })], now: reset + 3 * S });
    h.starter.plan();
    await h.wake();
    const { provider, req } = h.sent[0];
    expect(provider).toBe('cliproxy');
    expect(req).toEqual({ model: 'claude-haiku-5-5', system: [], messages: [{ role: 'user', content: [{ type: 'text', text: STARTER_PROMPT }] }], maxTokens: STARTER_MAX_TOKENS, thinking: { off: true } });
    expect(req.tools).toBeUndefined();
    expect(STARTER_PROMPT).toBe('Reply with exactly OK and nothing else.');
    expect(STARTER_MAX_TOKENS).toBe(4);
    expect(h.rows).toEqual([
      { source: 'starter', purpose: 'starter', provider: 'cliproxy', model: 'claude-haiku-5-5', inputTokens: 14, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, latencyMs: 320, account: 'claude-a', accountId: 'owner', paidBy: 'hub' },
    ]);
    // a starter that is off sends nothing, plans nothing
    const off = harness({ facts: [claude({ starter: undefined, windows: [w5(reset, reset - 4 * H)] })], now: reset + 3 * S });
    off.starter.plan();
    await off.starter.run('claude-a');
    expect(off.sent).toEqual([]);
    expect(off.view().state).toBe('off');
  });

  test('the next start stays put while the clock moves; a time already past goes now, inside the hours only', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const h = harness({ facts: [claude({ windows: [w5(reset, reset - 4 * H)] })], now: reset + 10 * MIN });
    h.starter.plan();
    const first = h.view();
    expect(first).toMatchObject({ state: 'scheduled', nextAt: reset + 3 * S });
    expect(h.planned.get('claude-a')).toBe(reset + 3 * S);
    h.clock.t += 7 * S;
    expect(h.view()).toEqual(first);
    // a window that shows no reset: due since that reading
    const none = harness({ facts: [claude({ windows: [w5(undefined, reset - MIN, { source: 'oauth', usedPercent: 0 })] })], now: reset });
    none.starter.plan();
    expect(none.view().nextAt).toBe(reset - MIN);
    none.clock.t += 5 * S;
    expect(none.view().nextAt).toBe(reset - MIN);
    await none.wake();
    expect(none.sent).toHaveLength(1);
    // the reset was inside the hours, but it is 23:00 now: it waits for 07:00
    const late = harness({ facts: [claude({ windows: [w5(T('2026-10-23T22:00:00Z'), T('2026-10-23T18:00:00Z'))] })], now: T('2026-10-23T23:00:00Z') });
    late.starter.plan();
    expect(late.view().nextAt).toBe(T('2026-10-24T07:00:00Z'));
    await late.starter.run('claude-a');
    expect(late.sent).toEqual([]);
  });

  test('the headers of its own response confirm it at once', async () => {
    const reset = T('2026-10-23T14:00:00Z');
    const h = harness({
      facts: [claude({ windows: [w5(reset, reset - 4 * H)] })],
      now: reset + 3 * S,
      send: () => ({ ...ok(), windows: [{ name: '5h', usedPercent: 0, resetsAt: reset + 5 * H + 3 * S }] }),
    });
    h.starter.plan();
    await h.wake();
    expect(h.view()).toMatchObject({ state: 'scheduled', startedAt: reset + 3 * S, nextAt: reset + 5 * H + 6 * S });
    expect(h.reads).toEqual([]);
  });
});

describe('pinning to the account', () => {
  const homes: string[] = [];
  afterAll(() => {
    for (const d of homes) rmSync(d, { recursive: true, force: true });
  });

  function hub(now: { t: number }) {
    const home = mkdtempSync(join(tmpdir(), 'conclave-starter-'));
    homes.push(home);
    const config = new ConfigStore(home);
    const repos = new Repos(openDb(':memory:'));
    const bus = new EventBus();
    const accounts = new AccountsService({ config, repos, bus, now: () => now.t });
    const usage = new UsageService({ repos, bus, priceOf: () => 0 });
    const sent: ChatRequest[] = [];
    const starter = new WindowStarter({
      facts: () => accounts.starterFacts(),
      kv: repos.kv,
      zone: () => 'UTC',
      plan: () => {},
      send: async (_p, req) => {
        sent.push(req);
        return ok();
      },
      read: async () => {},
      record: (r) => void usage.record(r),
      notify: () => {},
      changed: () => accounts.refreshView(),
      now: () => now.t,
    });
    accounts.setStarterView({ view: (f, all) => starter.view(f, all), noted: () => starter.noted(), onEnable: () => starter.noteShown() });
    return { accounts, starter, sent, repos, usage, bus };
  }

  const reset = T('2026-10-23T14:00:00Z');
  const cred = (name: string, extra: Partial<CliproxyCredentialFacts> = {}): CliproxyCredentialFacts => ({
    name,
    provider: 'claude',
    disabled: false,
    windows: [
      { name: '5h', usedPercent: 60, resetsAt: reset, observedAt: reset - H, source: 'headers' },
      { name: '7d', usedPercent: 40, resetsAt: reset + 4 * 86_400_000, observedAt: reset - H, source: 'oauth' },
    ],
    cooldowns: [],
    models: CLAUDE_MODELS.map((id) => ({ id })),
    ...extra,
  });

  test('a prefix pins it; without one only a sole account is pinned', async () => {
    const now = { t: reset + 3 * S };
    const { accounts, starter, sent, repos } = hub(now);
    accounts.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json', { email: 'a@example.test' }), cred('claude-b.json', { email: 'b@example.test', prefix: 'neu' })] });
    expect(accounts.status().starterNoted).toBeUndefined();
    accounts.patch('claude-b', { starter: { enabled: true } });
    accounts.patch('claude-a', { starter: { enabled: true } });
    expect(accounts.status().starterNoted).toBe(true);
    const b = accounts.account('claude-b')!.starter!;
    expect(b).toMatchObject({ enabled: true, start: '07:00', end: '22:30', zone: 'UTC', autoModel: 'claude-haiku-5-5', state: 'scheduled' });
    // Account 1 has no prefix, and Account 2 serves bare ids too: no way to reach Account 1 alone
    expect(accounts.account('claude-a')!.starter).toMatchObject({ state: 'setup', reason: 'Cannot pin a request to it' });
    await starter.run('claude-b');
    await starter.run('claude-a');
    expect(sent.map((r) => r.model)).toEqual(['neu/claude-haiku-5-5']);
    const row = repos.usage.recent(10)[0];
    expect(row).toMatchObject({ source: 'starter', purpose: 'starter', account: 'claude-b', model: 'neu/claude-haiku-5-5', provider: 'cliproxy' });
    // Account 2 paused in CLIProxyAPI: Account 1 is the only one that serves the bare id
    const facts = accounts.starterFacts();
    const a = facts.find((f) => f.id === 'claude-a')!;
    expect(pinFor(a, facts.map((f) => (f.id === 'claude-b' ? { ...f, disabled: true } : f)), 'claude-haiku-5-5')).toBe('claude-haiku-5-5');
    // the limits line for clients that show limits only
    accounts.publish();
    const limit = repos.usage.limits().find((l) => l.account === 'claude-b')!;
    expect(limit.starter).toMatchObject({ state: 'checking' });
  });

  test('wired as the engine does it, the page hears of a change once, not on every publish', async () => {
    const now = { t: reset + 10 * MIN };
    const { accounts, starter, bus } = hub(now);
    accounts.onChange(() => starter.plan());
    let updates = 0;
    bus.on((e) => {
      if (e.type === 'accounts.updated') updates++;
    });
    accounts.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json')] });
    accounts.patch('claude-a', { starter: { enabled: true } });
    for (let i = 0; i < 20; i++) {
      now.t += 1000;
      starter.plan();
      await Bun.sleep(0);
    }
    expect(accounts.account('claude-a')!.starter).toMatchObject({ state: 'scheduled', nextAt: reset + 3 * S });
    expect(updates).toBeLessThanOrEqual(3);
  });

  test('settings are checked and saved; off and cleared fields go', () => {
    const now = { t: reset };
    const { accounts } = hub(now);
    accounts.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json')] });
    accounts.patch('claude-a', { starter: { enabled: true, start: '8:30', end: '21:00', tz: 'Europe/Berlin', model: 'claude-haiku-4-5' } });
    expect(accounts.account('claude-a')!.starter).toMatchObject({ enabled: true, start: '08:30', end: '21:00', tz: 'Europe/Berlin', zone: 'Europe/Berlin', model: 'claude-haiku-4-5' });
    accounts.patch('claude-a', { starter: { model: '', tz: '' } });
    expect(accounts.account('claude-a')!.starter).toMatchObject({ enabled: true, start: '08:30', zone: 'UTC' });
    expect(accounts.account('claude-a')!.starter!.model).toBeUndefined();
    expect(() => accounts.patch('claude-a', { starter: { start: '25:00' } })).toThrow(/a time like 07:00/);
    expect(() => accounts.patch('claude-a', { starter: { tz: 'Mars/Base' } })).toThrow(/not a time zone/);
    expect(() => accounts.patch('claude-a', { starter: { start: '21:00' } })).toThrow(/start and an end that differ/);
    expect(() => checkStarter({ enabled: 'yes' })).toThrow(/true or false/);
    accounts.patch('claude-a', { starter: null });
    expect(accounts.account('claude-a')!.starter).toMatchObject({ enabled: false, state: 'off', start: '07:00', end: '22:30' });
  });
});
