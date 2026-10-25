import { describe, expect, test } from 'bun:test';
import { appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { readClaudeCodeUsage, currentBlock, claudeCodeLimit, BLOCK_MS } from '../../src/usage/readers/claude-code-logs';
import { codexLimit, readCodexUsage, toSnapshot, windowName } from '../../src/usage/readers/codex-logs';
import { mapClaudeOAuthUsage } from '../../src/usage/readers/claude-oauth';
import { mapZaiQuota, zaiQuotaUrl } from '../../src/usage/readers/zai';
import { mapAntigravityUsage } from '../../src/usage/readers/antigravity';
import { scanKey } from '../../src/usage/readers/common';
import { TestMachine } from '../acp/test-machine';
import { PATHS, fixtureHome } from '../importers/fixture-home';

function setup() {
  const home = fixtureHome();
  const repos = new Repos(openDb(':memory:'));
  const machine = new TestMachine({ id: 'pc', home });
  return { home, repos, machine, ctx: { machine, kv: repos.kv } };
}

const T = (iso: string) => Date.parse(iso);

describe('Claude Code log reader', () => {
  test('reads assistant usage, dedupes split lines, counts sidechains and subagents', async () => {
    const { ctx } = setup();
    const { records, files } = await readClaudeCodeUsage(ctx);
    expect(files).toBe(4);
    const byKey = Object.fromEntries(records.map((r) => [r.extKey, r.record]));
    expect(Object.keys(byKey).sort()).toEqual(['msg_01:req_01', 'msg_02:req_02', 'msg_b1:req_b1', 'msg_side:req_side', 'msg_sub:req_sub']);
    expect(byKey['msg_01:req_01']).toEqual({
      ts: T('2025-10-01T10:00:06.000Z'),
      source: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 10,
      outputTokens: 120,
      cacheReadTokens: 5000,
      cacheWriteTokens: 1000,
      reasoningTokens: 0,
      // the device whose logs these are, and the folder the line names
      device: 'pc',
      cwd: '/home/u/proj',
    });
    expect(byKey['msg_side:req_side'].model).toBe('claude-haiku-4-5-20251001');
  });

  test('only reads new bytes of changed files on the next scan', async () => {
    const { ctx, home, repos } = setup();
    await readClaudeCodeUsage(ctx);
    expect((await readClaudeCodeUsage(ctx)).files).toBe(0);

    const file = join(home, PATHS.claudeB);
    const line = {
      type: 'assistant',
      requestId: 'req_b2',
      uuid: 'b3',
      timestamp: '2025-10-03T12:05:00.000Z',
      message: { id: 'msg_b2', role: 'assistant', model: 'claude-opus-4-1-20250805', content: [], usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 } },
    };
    appendFileSync(file, JSON.stringify(line) + '\n' + '{"type":"assistant","partial');
    const t = new Date('2025-10-03T12:06:00Z');
    utimesSync(file, t, t);
    const second = await readClaudeCodeUsage(ctx);
    expect(second.files).toBe(1);
    expect(second.records.map((r) => r.extKey)).toEqual(['msg_b2:req_b2']);

    // the half-written line is picked up once it is finished
    appendFileSync(file, '"}\n');
    const t2 = new Date('2025-10-03T12:07:00Z');
    utimesSync(file, t2, t2);
    expect((await readClaudeCodeUsage(ctx)).records).toEqual([]);
    const state = repos.kv.get<Record<string, { o: number }>>(scanKey('claude-code', 'pc'), {});
    expect(state[file].o).toBeGreaterThan(0);
  });

  test('a machine with readRange sends only the new bytes of a grown file', async () => {
    const { home, repos } = setup();
    const full: string[] = [];
    const ranges: Array<[string, number, number]> = [];
    class RangeMachine extends TestMachine {
      override readFile(path: string) {
        full.push(path);
        return super.readFile(path);
      }
      async readRange(path: string, offset: number, length: number) {
        ranges.push([path, offset, length]);
        return (await super.readFile(path)).subarray(offset, offset + length);
      }
    }
    const ctx = { machine: new RangeMachine({ id: 'pc', home }), kv: repos.kv };
    await readClaudeCodeUsage(ctx);
    const file = join(home, PATHS.claudeB);
    const before = repos.kv.get<Record<string, { o: number }>>(scanKey('claude-code', 'pc'), {})[file].o;
    full.length = 0;
    const line = { type: 'assistant', requestId: 'req_b3', uuid: 'b4', timestamp: '2025-10-03T12:08:00.000Z', message: { id: 'msg_b3', role: 'assistant', model: 'claude-opus-4-1-20250805', content: [], usage: { input_tokens: 1, output_tokens: 2 } } };
    appendFileSync(file, JSON.stringify(line) + '\n');
    const t = new Date('2025-10-03T12:09:00Z');
    utimesSync(file, t, t);
    const next = await readClaudeCodeUsage(ctx);
    expect(next.records.map((r) => r.extKey)).toEqual(['msg_b3:req_b3']);
    expect(full).toEqual([]);
    expect(ranges.at(-1)).toEqual([file, before, JSON.stringify(line).length + 1]);
    expect(repos.kv.get<Record<string, { o: number }>>(scanKey('claude-code', 'pc'), {})[file].o).toBe(before + JSON.stringify(line).length + 1);
  });

  test('missing ~/.claude yields nothing', async () => {
    const repos = new Repos(openDb(':memory:'));
    const machine = new TestMachine({ id: 'pc', home: '/nonexistent-conclave' });
    expect(await readClaudeCodeUsage({ machine, kv: repos.kv })).toEqual({ records: [], files: 0 });
  });
});

describe('5-hour blocks', () => {
  const h = (hh: number, mm = 0) => T(`2025-10-01T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

  test('starts on the floored hour and rolls after 5h', () => {
    const entries = [
      { ts: h(10, 15), tokens: 100 },
      { ts: h(11), tokens: 50 },
      { ts: h(14, 59), tokens: 10 },
    ];
    const b = currentBlock(entries, h(15, 30))!;
    expect(b.start).toBe(h(10));
    expect(b.end).toBe(h(15));
    expect(b.tokens).toBe(160);
    expect(b.active).toBe(false);
    expect(currentBlock(entries, h(14, 59))!.active).toBe(true);

    const next = currentBlock([...entries, { ts: h(15, 30), tokens: 7 }], h(16))!;
    expect(next).toMatchObject({ start: h(15), end: h(20), tokens: 7, entries: 1, active: true });
  });

  test('a 5h gap starts a new block', () => {
    const b = currentBlock(
      [
        { ts: h(1), tokens: 1 },
        { ts: h(7, 30), tokens: 2 },
      ],
      h(8),
    )!;
    expect(b.start).toBe(h(7));
    expect(b.tokens).toBe(2);
    expect(currentBlock([], h(8))).toBeUndefined();
  });

  test('claudeCodeLimit has a window only while the block is active', () => {
    const b = currentBlock([{ ts: h(9, 10), tokens: 1 }], h(10))!;
    expect(claudeCodeLimit(b, h(10))).toEqual({
      provider: 'claude-code',
      label: 'Claude Code (local logs)',
      windows: [{ name: '5h block', resetsAt: h(9) + BLOCK_MS }],
      updatedAt: h(10),
      source: 'logs',
    });
    expect(claudeCodeLimit(undefined, h(10)).windows).toEqual([]);
  });
});

describe('Codex log reader', () => {
  test('one record per new running total, cached input split out, latest rate limits', async () => {
    const { ctx } = setup();
    const { records, snapshots, files } = await readCodexUsage(ctx);
    expect(files).toBe(2);
    const sid = '33333333-3333-4333-8333-333333333333';
    expect(records.map((r) => r.extKey)).toEqual([`${sid}:1050`, `${sid}:2280`, `${sid}:3620`]);
    expect(records[1].record).toEqual({
      ts: T('2025-10-02T08:00:05.100Z'),
      source: 'codex',
      provider: 'openai',
      model: 'gpt-5-codex',
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      device: 'pc',
      cwd: '/home/u/proj',
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      ts: T('2025-10-02T08:01:04.100Z'),
      planType: 'plus',
      primary: { usedPercent: 14, windowMinutes: 300, resetsAt: 1759395600_000 },
      secondary: { usedPercent: 4.5, windowMinutes: 10080, resetsAt: 1759900000_000 },
    });
    // nothing new on a second scan
    expect((await readCodexUsage(ctx)).records).toEqual([]);
  });

  test('codexLimit maps windows and clears expired ones', () => {
    const snap = toSnapshot(
      { primary: { used_percent: 100, window_minutes: 299, resets_in_seconds: 600 }, secondary: { used_percent: 40, window_minutes: 10079, resets_at: 1_800_000_000 }, plan_type: 'pro' },
      T('2025-10-02T08:00:00Z'),
    );
    expect(snap.primary!.resetsAt).toBe(T('2025-10-02T08:10:00Z'));
    const live = codexLimit(snap, T('2025-10-02T08:05:00Z'));
    expect(live).toEqual({
      provider: 'codex',
      label: 'Codex (ChatGPT Pro)',
      windows: [
        { name: '5h', usedPercent: 100, resetsAt: T('2025-10-02T08:10:00Z') },
        { name: '7d', usedPercent: 40, resetsAt: 1_800_000_000_000 },
      ],
      updatedAt: T('2025-10-02T08:00:00Z'),
      blocked: true,
      source: 'logs',
    });
    const later = codexLimit(snap, T('2025-10-02T08:20:00Z'));
    expect(later.windows[0]).toEqual({ name: '5h', usedPercent: 0 });
    expect(later.blocked).toBe(false);
    expect(codexLimit({ ...snap, limitId: 'gpt-5-mini' }).provider).toBe('codex-gpt-5-mini');
  });

  test('windowName', () => {
    expect(windowName(299, 'x')).toBe('5h');
    expect(windowName(10079, 'x')).toBe('7d');
    expect(windowName(undefined, 'x')).toBe('x');
    expect(windowName(30, 'x')).toBe('30m');
  });
});

describe('API limit mappers', () => {
  test('Claude OAuth usage', () => {
    const l = mapClaudeOAuthUsage(
      {
        five_hour: { utilization: 37.0, resets_at: '2025-11-04T04:59:59.943648+00:00' },
        seven_day: { utilization: 100, resets_at: '2025-11-06T03:59:59+00:00' },
        seven_day_opus: { utilization: 0.0, resets_at: null },
        seven_day_oauth_apps: null,
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25 },
      },
      1000,
      'max',
    );
    expect(l).toEqual({
      provider: 'claude-max',
      label: 'Claude Max (OAuth)',
      windows: [
        { name: '5h', usedPercent: 37, resetsAt: Date.parse('2025-11-04T04:59:59.943Z') },
        { name: '7d', usedPercent: 100, resetsAt: Date.parse('2025-11-06T03:59:59Z') },
        { name: '7d opus', usedPercent: 0 },
        { name: 'extra usage', usedPercent: 25, limit: 5000, remaining: 3750 },
      ],
      updatedAt: 1000,
      blocked: true,
      source: 'oauth',
    });
  });

  test('Z.ai quota', () => {
    const l = mapZaiQuota(
      {
        code: 200,
        success: true,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 200_000_000, currentValue: 50_000_000, remaining: 150_000_000, percentage: 25, nextResetTime: 1_760_000_000_000 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 1_000_000_000, currentValue: 100_000_000, percentage: 10, nextResetTime: 1_760_500_000_000 },
            { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 1000, remaining: 0, percentage: 100 },
          ],
        },
      },
      5,
    );
    expect(l).toEqual({
      provider: 'zai',
      label: 'Z.ai Coding Plan',
      windows: [
        { name: '5h', usedPercent: 25, limit: 200_000_000, remaining: 150_000_000, resetsAt: 1_760_000_000_000 },
        { name: '7d', usedPercent: 10, limit: 1_000_000_000, remaining: 900_000_000, resetsAt: 1_760_500_000_000 },
        { name: 'MCP monthly', usedPercent: 100, limit: 1000, remaining: 0 },
      ],
      updatedAt: 5,
      blocked: false,
      source: 'api',
    });
  });

  test('Z.ai credit limits are the 5 hour and weekly windows; unknown types read as words', () => {
    // as the live plan answered in Oct 2026: an unstarted 5 hour window has no reset
    const l = mapZaiQuota({
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', usage: 12000, currentValue: 0, remaining: 12000, percentage: 0 },
          { type: 'CREDIT_LIMIT', usage: 60000, currentValue: 3226, remaining: 56774, percentage: 5, nextResetTime: 1_793_305_885_976 },
          { type: 'SOME_NEW_LIMIT', percentage: 1 },
        ],
      },
    });
    expect(l.windows.map((w) => [w.name, w.resetsAt])).toEqual([
      ['5h', undefined],
      ['7d', 1_793_305_885_976],
      ['some new limit', undefined],
    ]);
  });

  test('Z.ai credit limits are told apart by size or a near reset, not order', () => {
    const now = 1_793_000_000_000;
    const names = (limits: object[]) => mapZaiQuota({ data: { limits } }, now).windows.map((w) => [w.name, w.limit]);
    const day = { type: 'CREDIT_LIMIT', usage: 12000, percentage: 0 };
    const week = { type: 'CREDIT_LIMIT', usage: 60000, percentage: 5, nextResetTime: now + 3 * 86_400_000 };
    expect(names([week, day])).toEqual([['7d', 60000], ['5h', 12000]]);
    // a reset within 6 hours is the 5 hour window, whatever its size
    expect(names([{ ...week, usage: 5000 }, { ...day, nextResetTime: now + 3_600_000 }])).toEqual([['7d', 5000], ['5h', 12000]]);
  });

  test('Antigravity loadCodeAssist: the credits balance and the tier, not 5h or weekly windows', () => {
    const l = mapAntigravityUsage({
      currentTier: { id: 'GOOGLE_ONE_AI_PREMIUM' },
      paidTier: { id: 'GOOGLE_ONE_AI_PREMIUM', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '96.5', minimumCreditAmountForUsage: '5' }] },
    });
    expect(l).toEqual({ plan: 'AI Pro', windows: [{ name: 'credits', remaining: 91.5 }] });
    // under the minimum for use: spent, so the account reads blocked
    expect(mapAntigravityUsage({ paidTier: { id: 'google_one_ai_premium', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: 1, minimumCreditAmountForUsage: 5 }] } })).toEqual({
      plan: 'AI Pro',
      windows: [{ name: 'credits', remaining: 0, usedPercent: 100 }],
    });
    // a tier without a credits list: the plan only, and the page keeps saying Google reports no usage
    expect(mapAntigravityUsage({ currentTier: { id: 'INDIVIDUAL_STANDARD_NOCC' } })).toEqual({ plan: 'Standard', windows: [] });
    expect(mapAntigravityUsage({ paidTier: { id: 'SOME_NEW_TIER' } })).toEqual({ plan: 'some new tier', windows: [] });
    expect(mapAntigravityUsage(undefined)).toEqual({ windows: [] });
  });

  test('zaiQuotaUrl follows the configured host', () => {
    expect(zaiQuotaUrl()).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(zaiQuotaUrl('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(zaiQuotaUrl('https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  });
});
