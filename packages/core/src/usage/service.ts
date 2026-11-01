/**
 * Usage records, summaries and subscription limits.
 *
 * Records come from two places: Conclave's own provider calls (the engine
 * calls record()) and other tools' local logs (Claude Code, Codex) read by
 * refreshLimits(). Log records carry an ext_key so re-reading never double
 * counts. Limits come from logs, the Z.ai quota endpoint, an opt-in Claude
 * OAuth read, and response headers (the engine calls setLimit for those).
 */
import type { LimitState, Usage, UsageRecord } from '../types';
import type { UsageSummary } from '../client';
import type { Machine } from '../machine/types';
import type { Repos, UnvaluedGroup, UsageBucket, UsageDimension, UsageQuery } from '../storage/repos';
import type { EventBus } from '../util/bus';
import { newId } from '../util/ids';
import { logger } from '../util/log';
import type { ExtUsage, UsageInput } from './readers/common';
import { BLOCK_MS, CLAUDE_CODE_SOURCE, claudeCodeLimit, currentBlock, readClaudeCodeUsage, type BlockInfo } from './readers/claude-code-logs';
import { codexLimit, readCodexUsage, type CodexRateSnapshot } from './readers/codex-logs';
import { CLAUDE_OAUTH_FLAG, fetchClaudeOAuthLimits } from './readers/claude-oauth';
import { fetchZaiLimits } from './readers/zai';
import { OWNER_ID, currentAccount } from '../people/context';

const log = logger('usage');
const DAY = 24 * 60 * 60 * 1000;
const CODEX_SNAPSHOTS_KEY = 'usage.codex.rateLimits';
/** At most this many usage.recorded events per bulk import, so a first log scan does not flood clients. */
const MAX_EVENTS_PER_BATCH = 20;

export interface UsageServiceOptions {
  repos: Repos;
  bus: EventBus;
  /** USD cost of a usage for "provider/model". */
  priceOf: (modelRef: string, usage: Usage) => number;
  /** Optional per-million prices, used for cache savings when given. */
  pricesOf?: (modelRef: string) => { inputPrice: number; cacheReadPrice: number } | undefined;
  /**
   * What a call is worth at the model's API prices (usage/value.ts): the
   * catalog price for a signed in plan, what was billed for a key. Left out,
   * the value is what was billed.
   */
  apiValueOf?: (row: { provider: string; model: string; account?: string; costUsd: number }, usage: Usage) => number;
  /** Z.ai key and base URL when a Z.ai provider is configured. */
  zai?: () => { apiKey: string; baseUrl?: string } | undefined;
  /** Opt-in for the Claude OAuth usage read (the kv flag usage.claudeOAuth.enabled also enables it). */
  claudeOAuth?: () => boolean;
  fetch?: typeof fetch;
  /** The account of a session and of a device, so each row is someone's (docs/design/ACCOUNTS.md). */
  sessionAccount?: (sessionId: string) => string | undefined;
  deviceAccount?: (deviceId: string) => string | undefined;
}

export interface RefreshReport {
  limits: LimitState[];
  imported: number;
  errors: string[];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** What plans saved: the API value of the calls less what was billed (equal for keys, so only plans count). */
export function savedOf(b: { costUsd: number; apiValueUsd?: number }): number {
  return round6(Math.max(0, (b.apiValueUsd ?? 0) - (b.costUsd ?? 0)));
}

export class UsageService {
  private refreshing?: Promise<RefreshReport>;
  /** Last refresh errors, for a status page. */
  lastErrors: string[] = [];

  constructor(private opts: UsageServiceOptions) {}

  private get repos(): Repos {
    return this.opts.repos;
  }

  private price(provider: string, model: string, u: Usage): number {
    try {
      const v = this.opts.priceOf(`${provider}/${model}`, u);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  /** API value of a call; never below what was billed, and what was billed when it cannot be worked out. */
  apiValue(row: { provider: string; model: string; account?: string; costUsd: number }, u: Usage): number {
    const billed = Number.isFinite(row.costUsd) ? row.costUsd : 0;
    if (!this.opts.apiValueOf) return billed;
    try {
      const v = this.opts.apiValueOf(row, u);
      return Number.isFinite(v) && v > billed ? Math.round(v * 1e8) / 1e8 : billed;
    } catch {
      return billed;
    }
  }

  private build(r: UsageInput): UsageRecord {
    const rec: UsageRecord = {
      id: newId('use'),
      ts: r.ts ?? Date.now(),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      source: r.source,
      provider: r.provider,
      model: r.model,
      inputTokens: r.inputTokens || 0,
      outputTokens: r.outputTokens || 0,
      cacheReadTokens: r.cacheReadTokens || 0,
      cacheWriteTokens: r.cacheWriteTokens || 0,
      reasoningTokens: r.reasoningTokens || 0,
      costUsd: 0,
      ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
      ...(r.purpose ? { purpose: r.purpose } : {}),
      ...(r.account ? { account: r.account } : {}),
      ...(r.device ? { device: r.device } : {}),
      ...(r.cwd ? { cwd: r.cwd } : {}),
      // whose row: the call says, else its session's, else its device's, else whoever the work runs for
      accountId:
        r.accountId ??
        (r.sessionId ? this.opts.sessionAccount?.(r.sessionId) : undefined) ??
        (r.device ? this.opts.deviceAccount?.(r.device) : undefined) ??
        currentAccount() ??
        OWNER_ID,
      ...(r.paidBy ? { paidBy: r.paidBy } : {}),
    };
    rec.costUsd =
      r.costUsd ??
      this.price(rec.provider, rec.model, {
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        cacheReadTokens: rec.cacheReadTokens,
        cacheWriteTokens: rec.cacheWriteTokens,
        reasoningTokens: rec.reasoningTokens,
      });
    // kept on the row from the day it is recorded, so a later catalog change does not move it
    rec.apiValueUsd =
      typeof r.apiValueUsd === 'number' && Number.isFinite(r.apiValueUsd)
        ? Math.max(r.apiValueUsd, rec.costUsd)
        : this.apiValue(rec, {
            inputTokens: rec.inputTokens,
            outputTokens: rec.outputTokens,
            cacheReadTokens: rec.cacheReadTokens,
            cacheWriteTokens: rec.cacheWriteTokens,
            ...(r.cacheWrite1hTokens ? { cacheWrite1hTokens: r.cacheWrite1hTokens } : {}),
            reasoningTokens: rec.reasoningTokens,
          });
    return rec;
  }

  /** Insert one record. Returns it, or undefined when extKey was already recorded. */
  record(r: UsageInput, extKey?: string): UsageRecord | undefined {
    const rec = this.build(r);
    if (!this.repos.usage.insert(rec, extKey)) return undefined;
    this.opts.bus.emit({ type: 'usage.recorded', record: rec });
    return rec;
  }

  /** Insert many log records in one transaction. Returns how many were new. */
  recordMany(items: ExtUsage[]): number {
    if (!items.length) return 0;
    const inserted: UsageRecord[] = [];
    this.repos.db.transaction(() => {
      for (const it of items) {
        const rec = this.build(it.record);
        if (this.repos.usage.insert(rec, it.extKey)) inserted.push(rec);
      }
    })();
    inserted.sort((a, b) => b.ts - a.ts);
    for (const rec of inserted.slice(0, MAX_EVENTS_PER_BATCH).reverse()) this.opts.bus.emit({ type: 'usage.recorded', record: rec });
    return inserted.length;
  }

  /**
   * Totals and breakdowns for a time range. Defaults to the last 30 days.
   * tzOffset is minutes east of UTC (-new Date().getTimezoneOffset()), used to cut days.
   */
  summary(q: { from?: number; to?: number; tzOffset?: number; accountId?: string } = {}): UsageSummary {
    const to = q.to ?? Date.now();
    const from = q.from ?? to - 30 * DAY;
    // one person's rows (the server always says whose); left out, every row
    const range = { from, to, ...(q.accountId ? { accountId: q.accountId } : {}) };
    const usage = this.repos.usage;
    const tz = q.tzOffset ?? 0;
    const totals = this.valued('total', [usage.totals(range)], range)[0];
    const denom = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
    return {
      from,
      to,
      totals,
      byDay: this.valued('day', usage.aggregate('day', range, tz), range, tz),
      byModel: this.valued('model', usage.aggregate('model', range), range),
      bySource: this.valued('source', usage.aggregate('source', range), range),
      byPurpose: this.valued('purpose', usage.aggregate('purpose', range), range),
      byAccount: this.valued('account', usage.aggregate('account', range), range),
      cacheHitRate: denom > 0 ? totals.cacheReadTokens / denom : 0,
      cacheSavingsUsd: this.cacheSavings(from, to, q.accountId),
      savedUsd: savedOf(totals),
    };
  }

  /**
   * Buckets with their API value whole: rows from before values were kept are
   * priced now from the catalog, and that part is marked as estimated.
   */
  private valued(by: UsageDimension | 'total', buckets: UsageBucket[], q: UsageQuery, tz = 0): UsageBucket[] {
    const estimates = new Map<string, number>();
    if (buckets.some((b) => (b.unvalued ?? 0) > 0)) {
      for (const g of this.repos.usage.unvalued(by, q, tz)) estimates.set(g.key, (estimates.get(g.key) ?? 0) + this.estimate(g));
    }
    return buckets.map(({ unvalued: _n, ...b }) => {
      const est = estimates.get(b.key);
      const apiValueUsd = round6((b.apiValueUsd ?? 0) + (est ?? 0));
      return { ...b, apiValueUsd, ...(est !== undefined ? { estimatedUsd: round6(est) } : {}) };
    });
  }

  /** A group of old rows priced now. */
  private estimate(g: UnvaluedGroup): number {
    return this.apiValue(
      { provider: g.provider, model: g.model, ...(g.account ? { account: g.account } : {}), costUsd: g.costUsd ?? 0 },
      { inputTokens: g.inputTokens ?? 0, outputTokens: g.outputTokens ?? 0, cacheReadTokens: g.cacheReadTokens ?? 0, cacheWriteTokens: g.cacheWriteTokens ?? 0, reasoningTokens: g.reasoningTokens ?? 0 },
    );
  }

  /** The API value of one row, kept or worked out now. */
  private withValue(r: UsageRecord): UsageRecord {
    if (typeof r.apiValueUsd === 'number') return r;
    return {
      ...r,
      apiValueUsd: this.apiValue(r, { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, reasoningTokens: r.reasoningTokens }),
      apiValueEstimated: true,
    };
  }

  /** What plans saved on a session's calls, kept or worked out now (for its stats from before the value was kept). */
  sessionSaved(sessionId: string): number {
    const q = { sessionId };
    return savedOf(this.valued('total', [this.repos.usage.totals(q)], q)[0]);
  }

  /** USD saved by cache reads: cacheReadTokens * (input price - cache read price), per model. */
  private cacheSavings(from: number, to: number, accountId?: string): number {
    const rows = this.repos.db
      .query(
        `SELECT provider, model, SUM(cache_read_tokens) as cr FROM usage
         WHERE ts >= $from AND ts < $to AND cache_read_tokens > 0 AND ($acct IS NULL OR account_id = $acct) GROUP BY provider, model`,
      )
      .all({ from, to, acct: accountId ?? null } as any) as Array<{ provider: string; model: string; cr: number }>;
    let total = 0;
    for (const r of rows) {
      const ref = `${r.provider}/${r.model}`;
      let saved = 0;
      const p = this.opts.pricesOf?.(ref);
      if (p) saved = (r.cr * (p.inputPrice - p.cacheReadPrice)) / 1_000_000;
      else {
        const full = this.price(r.provider, r.model, { inputTokens: r.cr, outputTokens: 0 });
        const cached = this.price(r.provider, r.model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: r.cr });
        saved = full - cached;
      }
      if (saved > 0) total += saved;
    }
    return Math.round(total * 1e6) / 1e6;
  }

  recent(limit = 100, accountId?: string): UsageRecord[] {
    return this.repos.usage.recent(limit, accountId ? { accountId } : {}).map((r) => this.withValue(r));
  }

  /** Store a limit and tell clients. Header-derived limits from providers come through here too. */
  setLimit(l: LimitState): void {
    this.repos.usage.setLimit(l);
    this.opts.bus.emit({ type: 'limit.updated', limit: l });
  }

  /** Store quietly when nothing but the timestamp changed. */
  private setLimitIfChanged(l: LimitState): void {
    const prev = this.repos.usage.limits().find((x) => x.provider === l.provider);
    const strip = (x: LimitState) => JSON.stringify({ ...x, updatedAt: 0 });
    if (prev && strip(prev) === strip(l)) this.repos.usage.setLimit(l);
    else this.setLimit(l);
  }

  /** Stored limits with windows past their reset time cleared. */
  limits(now = Date.now()): LimitState[] {
    return this.repos.usage.limits().map((l) => {
      let changed = false;
      const windows = l.windows.flatMap((w) => {
        if (w.resetsAt === undefined || w.resetsAt > now) return [w];
        changed = true;
        if (w.usedPercent === undefined) return [];
        const { resetsAt: _gone, ...rest } = w;
        return [{ ...rest, usedPercent: 0 }];
      });
      if (!changed) return l;
      const blocked = l.blocked ? windows.some((w) => (w.usedPercent ?? 0) >= 100) : l.blocked;
      return { ...l, windows, ...(blocked !== undefined ? { blocked } : {}) };
    });
  }

  /** The current Claude Code 5-hour block from recorded log usage (all devices). */
  claudeBlock(now = Date.now()): BlockInfo | undefined {
    const rows = this.repos.usage.recent(100_000, { from: now - DAY, source: CLAUDE_CODE_SOURCE });
    const entries = rows.map((r) => ({ ts: r.ts, tokens: r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens, costUsd: r.costUsd }));
    // only entries after the last 5h gap matter; earlier ones belong to finished chains
    entries.sort((a, b) => a.ts - b.ts);
    let startAt = 0;
    for (let i = 1; i < entries.length; i++) if (entries[i].ts - entries[i - 1].ts >= BLOCK_MS) startAt = i;
    return currentBlock(entries.slice(startAt), now);
  }

  /**
   * Lines of harness sessions Conclave ran over ACP, inside a turn whose
   * usage the harness reported (session/harness.ts writes the turn's
   * harness_session then). Claude Code and Codex also write those calls to
   * their own logs, so without this a call would count twice: once from ACP
   * with the session, once from the log scan.
   */
  private countedByAcp(): (harnessSession: string, ts: number) => boolean {
    let spans: Map<string, Array<[number, number]>>;
    try {
      spans = this.repos.turns.harnessSpans(0);
    } catch {
      return () => false;
    }
    // log lines are written a moment after the call; allow a little slack at both ends
    const SLACK = 120_000;
    return (sid, ts) => (spans.get(sid) ?? []).some(([from, to]) => ts >= from - SLACK && ts <= to + SLACK);
  }

  /** Read every device's Claude Code and Codex logs, then refresh API-based limits. */
  async refreshLimits(machines: Machine[]): Promise<LimitState[]> {
    return (await this.refresh(machines)).limits;
  }

  /** Same as refreshLimits with counts and errors. Concurrent calls share one run. */
  refresh(machines: Machine[]): Promise<RefreshReport> {
    this.refreshing ??= this.doRefresh(machines).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(machines: Machine[]): Promise<RefreshReport> {
    const errors: string[] = [];
    const kv = this.repos.kv;
    let imported = 0;
    let sawClaudeCode = false;
    const snapshots = new Map<string, CodexRateSnapshot>(Object.entries(kv.get<Record<string, CodexRateSnapshot>>(CODEX_SNAPSHOTS_KEY, {})));
    let snapshotsChanged = false;
    const counted = this.countedByAcp();

    await Promise.all(
      machines.map(async (machine) => {
        try {
          const r = await readClaudeCodeUsage({ machine, kv, counted });
          imported += this.recordMany(r.records);
          if (r.records.length) sawClaudeCode = true;
        } catch (err) {
          errors.push(`claude-code logs on ${machine.name}: ${String(err)}`);
        }
        try {
          const r = await readCodexUsage({ machine, kv, counted });
          imported += this.recordMany(r.records);
          for (const s of r.snapshots) {
            const key = s.limitId ?? 'codex';
            const prev = snapshots.get(key);
            if (!prev || s.ts > prev.ts) {
              snapshots.set(key, s);
              snapshotsChanged = true;
            }
          }
        } catch (err) {
          errors.push(`codex logs on ${machine.name}: ${String(err)}`);
        }
      }),
    );

    const now = Date.now();
    const block = this.claudeBlock(now);
    const hadClaudeCode = this.repos.usage.limits().some((l) => l.provider === 'claude-code');
    if (block || sawClaudeCode || hadClaudeCode) this.setLimitIfChanged(claudeCodeLimit(block, now));

    if (snapshotsChanged) kv.set(CODEX_SNAPSHOTS_KEY, Object.fromEntries(snapshots));
    for (const s of snapshots.values()) this.setLimitIfChanged(codexLimit(s, now));

    if (this.opts.claudeOAuth?.() || kv.get<boolean>(CLAUDE_OAUTH_FLAG, false)) {
      const ordered = [...machines].sort((a, b) => (a.id === 'local' ? -1 : b.id === 'local' ? 1 : 0));
      let done = false;
      const tried: string[] = [];
      for (const m of ordered) {
        try {
          this.setLimit(await fetchClaudeOAuthLimits(m, { fetch: this.opts.fetch, now }));
          done = true;
          break;
        } catch (err) {
          tried.push(String((err as Error).message ?? err));
        }
      }
      if (!done && tried.length) errors.push(`claude oauth: ${tried.join('; ')}`);
    }

    const zai = await this.refreshZai(now);
    if (zai) errors.push(zai);

    for (const e of errors) log.warn(e);
    this.lastErrors = errors;
    return { limits: this.limits(), imported, errors };
  }

  /** Read the Z.ai Coding Plan quota now (also the window starter, around a reset). Returns the error, if any. */
  async refreshZai(now = Date.now()): Promise<string | undefined> {
    const zai = this.opts.zai?.();
    if (!zai?.apiKey) return undefined;
    try {
      this.setLimit(await fetchZaiLimits(zai.apiKey, { baseUrl: zai.baseUrl, fetch: this.opts.fetch, now }));
    } catch (err) {
      return `zai: ${String((err as Error).message ?? err)}`;
    }
    return undefined;
  }

  /** Refresh on an interval. Returns a stop function. */
  autoRefresh(getMachines: () => Machine[], everyMs = 5 * 60_000): () => void {
    const tick = () => void this.refresh(getMachines()).catch((err) => log.warn(`refresh failed: ${String(err)}`));
    const t = setInterval(tick, everyMs);
    (t as { unref?: () => void }).unref?.();
    tick();
    return () => clearInterval(t);
  }
}
