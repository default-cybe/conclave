/**
 * Usage (spec 11.8): what the range cost, where it went, and how close each
 * plan is to its limits right now. Range drives the stats, the cost chart and
 * the breakdowns; limits are live and sit in their own column on desktop.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { LimitState, UsageRecord } from '@conclave/core/types';
import type { UsageBucketDto, UsageSummary } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { useDelayed, useIsDesktop, useIsMobile, useIsWide, useLoad, useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { compact, duration, hhmm, longDate, shortDate, usd } from '@/lib/format';
import { harnessId, splitRef } from '@/lib/models';
import { Page, PageHeader } from '@/components/ui/Page';
import { Input, Segmented } from '@/components/ui/Field';
import { Section, SectionHeading, TextAction, Notice } from '@/components/ui/Section';
import { Stat } from '@/components/ui/Stat';
import { Meter, LimitGroup, isRateWindow, limitPeak } from '@/components/ui/Meter';
import { limitKey } from '@conclave/core/accounts/windows';
import { Table, type Column } from '@/components/ui/Table';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { HarnessName, ModelName } from '@/components/logo';
import { LiveStatus } from '@/components/motion';
import { useAccounts } from '@/lib/accounts';
import { CostColumns, type ColumnDatum } from './charts';
import { planServed, savedDetail, savedSentence, worth, type Valued } from './value';

type Range = 'today' | '7d' | '30d' | 'month' | 'custom';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const RECENT = 500;

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const keyTime = (key: string) => new Date(key + 'T12:00').getTime();

function rangeBounds(range: Range, custom: { from: string; to: string }, now: number) {
  if (range === 'today') return { from: startOfDay(now), to: now };
  if (range === '7d') return { from: startOfDay(now - 6 * DAY), to: now };
  if (range === 'month') {
    const d = new Date(now);
    return {
      from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
      to: now,
    };
  }
  if (range === 'custom') {
    const from = new Date(custom.from + 'T00:00').getTime();
    const to = Math.min(now, new Date(custom.to + 'T23:59:59').getTime());
    return { from: Math.min(from, to), to };
  }
  return { from: startOfDay(now - 29 * DAY), to: now };
}

const EMPTY: UsageBucketDto = {
  key: '',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  apiValueUsd: 0,
  calls: 0,
};
const tokensIn = (b: UsageBucketDto) => b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
const tokensAll = (b: UsageBucketDto) => tokensIn(b) + b.outputTokens;
const cacheRate = (b: UsageBucketDto) => (tokensIn(b) ? b.cacheReadTokens / tokensIn(b) : 0);
const percent = (f: number) => `${Math.round(f * 100)}%`;

/** Where usage came from, in words. */
const SOURCES: Record<string, { name: string; help: string }> = {
  api: {
    name: 'Direct API',
    help: 'Sessions, routines and juries calling providers',
  },
  chat: { name: 'Chat', help: 'Conversations on the Chat page' },
  gateway: { name: 'Gateway', help: 'CLIs routed through the hub' },
  starter: { name: 'Window starter', help: 'One tiny request per 5-hour window' },
  'claude-code': { name: 'Claude Code', help: 'Read from its own logs' },
  codex: { name: 'Codex', help: 'Read from its own logs' },
  'gemini-cli': { name: 'Gemini CLI', help: 'Read from its own logs' },
  opencode: { name: 'OpenCode', help: 'Read from its own logs' },
};

/** What each call was for. */
const PURPOSES: Record<string, string> = {
  turn: 'Session turns',
  jury: 'Juries',
  debate: 'Debates',
  review: 'Second opinions',
  compaction: 'Compaction',
  title: 'Titles',
  memory: 'Memory notes',
  routine: 'Routines',
  summary: 'Summaries',
  handoff: 'Switches',
  starter: 'Window starter',
};

const LIMIT_SOURCE: Record<LimitState['source'], string> = {
  headers: 'Headers',
  oauth: 'OAuth',
  logs: 'CLI logs',
  api: 'Plan API',
  ledger: 'Cost records',
  error: 'Could not be read',
};

function ageWords(ts: number, now: number) {
  const d = now - ts;
  if (d < 45_000) return 'just now';
  if (d < HOUR) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  return shortDate(ts);
}

function capital(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export default function UsagePage() {
  const desktop = useIsDesktop();
  const wide = useIsWide();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const [range, setRange] = useState<Range>('30d');
  const [custom, setCustom] = useState({
    from: dayKey(Date.now() - 13 * DAY),
    to: dayKey(Date.now()),
  });
  const usageVersion = useHub((s) => s.usageVersion);
  const tick = Math.floor(usageVersion / 3);
  const config = useHub((s) => s.config);

  // the range ends now: new usage moves the end, or every reload would leave it out
  const { from, to } = useMemo(() => rangeBounds(range, custom, Date.now()), [range, custom, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = Math.max(1, Math.round((startOfDay(to) - startOfDay(from)) / DAY) + 1);
  const tz = new Date().getTimezoneOffset();

  const usage = useLoad(() => api().usage({ from, to, tzOffset: tz }), [from, to]);
  // the window just before, for "up 12% on the 7 days before"; yesterday for Today
  const prevRange = range === 'today' ? { from: from - DAY, to: from - 1 } : { from: from - days * DAY, to: from - 1 };
  const prev = useLoad(() => api().usage({ from: prevRange.from, to: prevRange.to, tzOffset: tz }), [from, to]);
  const recent = useLoad(() => api().usageRecent(RECENT), [tick]);
  const u = usage.data;
  // "Your plans saved you about $Z this month" is always this month, whatever the range
  const monthBounds = rangeBounds('month', custom, Date.now());
  const monthLoad = useLoad(() => (range === 'month' ? Promise.resolve(undefined) : api().usage({ from: monthBounds.from, to: monthBounds.to, tzOffset: tz })), [range, tick]);
  const month = range === 'month' ? u : monthLoad.data;

  // which providers bill as a plan, so a $0 row reads "plan" instead of "$0"
  const planProviders = useMemo(() => {
    const p = (config?.providers ?? {}) as Record<string, { type?: string; subscription?: string }>;
    return new Set(
      Object.entries(p)
        .filter(([, v]) => v?.type === 'acp' || !!v?.subscription)
        .map(([k]) => k),
    );
  }, [config]);

  const columns = useMemo(() => buildColumns(range, u, recent.data, from, to), [range, u, recent.data, from, to]);
  const empty = !!u && u.totals.calls === 0 && u.totals.costUsd === 0;
  const rangeWords = range === 'today' ? `Today, ${longDate(to)}` : `${shortDate(from)} to ${shortDate(to)}`;

  const rangeControl = (
    <Segmented
      label="Range"
      size={mobile ? 'md' : 'sm'}
      full={mobile}
      className="phone:h-11!"
      value={range}
      onChange={setRange}
      options={[
        { value: 'today', label: 'Today' },
        { value: '7d', label: '7 days' },
        { value: '30d', label: '30 days' },
        { value: 'month', label: 'This month' },
        { value: 'custom', label: 'Custom' },
      ]}
    />
  );

  const header = (
    <PageHeader title="Usage" sub={rangeWords} actions={!mobile && rangeControl}>
      {(mobile || range === 'custom') && (
        <>
          {mobile && rangeControl}
          {range === 'custom' && (
            <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-2 anim-fade', mobile && 'mt-3')}>
              <span className="w-[156px] shrink-0">
                <Input type="date" mono size="sm" aria-label="From" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} />
              </span>
              <span className="text-[13px] text-fg-3">to</span>
              <span className="w-[156px] shrink-0">
                <Input type="date" mono size="sm" aria-label="To" value={custom.to} min={custom.from} max={dayKey(Date.now())} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} />
              </span>
            </div>
          )}
        </>
      )}
    </PageHeader>
  );

  const loading = <LoadingRows loading={usage.loading && !u} rows={5} />;
  const failed = usage.error && !u && (
    <Notice tone="fault" action={{ label: 'Try again', onClick: usage.reload }}>
      {`Failed. Could not load usage. ${usage.error}`}
    </Notice>
  );

  const stats = u && !empty && <Stats u={u} prev={prev.data} range={range} days={days} mobile={mobile} wide={wide} />;
  const savings = month && <PlanSavings totals={month.totals} />;
  const cost = u && !empty && <CostSection range={range} data={columns.data} truncated={columns.truncated} dim={usage.loading} rows={u} />;
  const byModel = u && !empty && <ByModel u={u} plans={planProviders} mobile={mobile} />;
  const breakdown = u && !empty && (
    <>
      <ByAccount u={u} />
      <BySource u={u} />
      <ByPurpose u={u} />
    </>
  );
  const recentRows = u && !empty && <Recent rows={recent.data} plans={planProviders} onOpen={(id) => navigate(`/s/${id}`)} />;
  // a quiet past range is not a first day: offer the default range back instead of a first session
  const emptyState =
    empty &&
    (range === '30d' ? (
      <EmptyState action={{ label: 'Start a session', onClick: () => navigate('/') }}>Nothing used in the last 30 days. Spend, tokens and where they went show up here once a session runs.</EmptyState>
    ) : (
      <EmptyState
        action={{
          label: 'Show the last 30 days',
          onClick: () => setRange('30d'),
        }}
      >
        Nothing used in this range. Pick a longer one, or start a session and it shows up here.
      </EmptyState>
    ));
  const limits = <Limits wave={!empty} />;

  if (desktop)
    return (
      <Page width="wide">
        <div className="grid grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 pr-7">
            {header}
            <div className="space-y-8">
              {loading}
              {failed}
              {savings}
              {stats}
              {emptyState}
              {cost}
              {byModel}
              {breakdown}
              {recentRows}
            </div>
          </div>
          <aside className="min-w-0 border-l border-rule pt-[30px] pl-7" aria-label="Limits">
            {limits}
          </aside>
        </div>
      </Page>
    );

  return (
    <Page width="wide">
      {header}
      <div className="space-y-8">
        {loading}
        {failed}
        {savings}
        {stats}
        {emptyState}
        {cost}
        {limits}
        {byModel}
        {breakdown}
        {recentRows}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// What the plans saved this month
// ---------------------------------------------------------------------------

/** One line, only when a signed in plan served calls this month: what they would have cost on an API key. */
function PlanSavings({ totals }: { totals: Valued }) {
  const sentence = savedSentence(totals);
  if (!sentence) return null;
  return (
    <section aria-label="What your plans saved" className="anim-fade">
      <p className="m-0 text-[15px] font-medium text-fg phone:text-[16px]">{sentence}</p>
      <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">{savedDetail(totals)}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function Stats({ u, prev, range, days, mobile, wide }: { u: UsageSummary; prev?: UsageSummary; range: Range; days: number; mobile: boolean; wide: boolean }) {
  const t = u.totals;
  let delta: ReactNode = null;
  if (prev) {
    const p = prev.totals.costUsd;
    if (range === 'today') delta = p > 0 ? `yesterday ${usd(p)}` : null;
    else {
      // compare only when the hub has data for most of the window before
      const covered = prev.byDay.filter((d) => d.calls > 0).length >= Math.ceil(days * 0.5);
      if (covered && p > 0) {
        const change = (t.costUsd - p) / p;
        const words = Math.abs(change) < 0.005 ? 'same as' : `${change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(change) * 100)}% on`;
        delta = `${words} the ${days} days before`;
      }
    }
  }
  const items = [
    <Stat key="spend" value={usd(t.costUsd)} label="Spend" delta={delta} />,
    <Stat key="in" value={compact(tokensIn(t))} label="Tokens in" delta={t.cacheReadTokens ? `${compact(t.cacheReadTokens)} from cache` : null} />,
    <Stat key="out" value={compact(t.outputTokens)} label="Tokens out" delta={t.calls ? `${compact(t.outputTokens / t.calls)} per request` : null} />,
    <Stat key="cache" value={percent(u.cacheHitRate)} label="Cache hits" delta={u.cacheSavingsUsd > 0 ? `saved ${usd(u.cacheSavingsUsd)}` : null} />,
    <Stat key="calls" value={compact(t.calls)} label="Requests" delta={t.calls ? `${usd(t.costUsd / t.calls, { precise: true })} each` : null} />,
  ];
  // the spend column leads and gets the room its comparison line needs
  const row = 'flex items-start [&>*]:min-w-0 [&>*]:flex-1 [&>*:first-child]:flex-[1.45] [&>*+*]:border-l [&>*+*]:border-rule [&>*+*]:pl-5 [&>*:not(:last-child)]:pr-5';
  if (mobile)
    return (
      <div className="space-y-4">
        <div>{items[0]}</div>
        <div className={cn(row, 'border-t border-rule pt-4 [&>*+*]:pl-4 [&>*:not(:last-child)]:pr-4')}>{items.slice(1, 3)}</div>
        <div className={cn(row, 'border-t border-rule pt-4 [&>*+*]:pl-4 [&>*:not(:last-child)]:pr-4')}>{items.slice(3, 5)}</div>
      </div>
    );
  if (!wide)
    return (
      <div className="space-y-4">
        <div className={row}>{items.slice(0, 3)}</div>
        <div className={cn(row, 'border-t border-rule pt-4')}>
          {items.slice(3)}
          <span aria-hidden />
        </div>
      </div>
    );
  return <div className={cn(row, 'pt-1 pb-1')}>{items}</div>;
}

// ---------------------------------------------------------------------------
// Cost over time
// ---------------------------------------------------------------------------

interface Columns {
  data: Array<ColumnDatum & { tokens: number; calls: number; worth: number }>;
  truncated: boolean;
}

/** Top three models by cost in a set of records, for the readout. */
function topModels(records: UsageRecord[]): Array<{ model: string; cost: number }> {
  const by = new Map<string, number>();
  for (const r of records) by.set(r.model, (by.get(r.model) ?? 0) + r.costUsd);
  return [...by.entries()]
    .map(([model, cost]) => ({ model, cost }))
    .filter((m) => m.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3);
}

function Readout({ tokens, calls, models, value }: { tokens: number; calls: number; models: Array<{ model: string; cost: number }>; value?: Valued }) {
  return (
    <>
      <div className="text-fg-3">
        {compact(tokens)} tokens, {compact(calls)} {calls === 1 ? 'request' : 'requests'}
      </div>
      {value && planServed(value) && <div className="text-fg-3">Worth {usd(worth(value))} at API prices</div>}
      {models.length > 0 && (
        <div className="mt-1.5 space-y-1 border-t border-rule pt-1.5">
          {models.map((m) => (
            <div key={m.model} className="flex items-center justify-between gap-3">
              <ModelName model={m.model} as="model" size={13} className="min-w-0 text-fg-2" />
              <span className="num shrink-0 text-fg-2">{usd(m.cost)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function buildColumns(range: Range, u: UsageSummary | undefined, records: UsageRecord[] | undefined, from: number, to: number): Columns {
  const recs = records ?? [];
  const truncated = recs.length >= RECENT && recs[recs.length - 1].ts > from;
  if (range === 'today') {
    const start = startOfDay(to);
    const nowHour = new Date(to).getHours();
    const hours = Array.from({ length: 24 }, (_, h) => recs.filter((r) => r.ts >= start + h * HOUR && r.ts < start + (h + 1) * HOUR));
    return {
      truncated,
      data: hours.map((list, h) => {
        const cost = list.reduce((a, r) => a + r.costUsd, 0);
        const value = list.reduce((a, r) => a + worth(r), 0);
        const tokens = list.reduce((a, r) => a + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens, 0);
        const hh = String(h).padStart(2, '0');
        return {
          key: hh,
          label: hh,
          long: `${hh}:00 to ${String(h + 1).padStart(2, '0')}:00`,
          value: cost,
          worth: value,
          tokens,
          calls: list.length,
          current: h === nowHour,
          future: h > nowHour,
          detail: <Readout tokens={tokens} calls={list.length} models={topModels(list)} value={{ costUsd: cost, apiValueUsd: value }} />,
        };
      }),
    };
  }
  if (!u) return { data: [], truncated: false };
  const have = new Map(u.byDay.map((d) => [d.key, d]));
  const keys: string[] = [];
  for (let t = startOfDay(from); t <= to; t += DAY) keys.push(dayKey(t + DAY / 2));
  // the hub may bucket a request just outside the range into a neighbouring day; keep the axis to the range
  const first = dayKey(from);
  const last = dayKey(to);
  for (const d of u.byDay) if (!keys.includes(d.key) && d.key >= first && d.key <= last) keys.push(d.key);
  keys.sort();
  const today = dayKey(Date.now());
  const byDayRecords = new Map<string, UsageRecord[]>();
  for (const r of recs) {
    const k = dayKey(r.ts);
    byDayRecords.set(k, [...(byDayRecords.get(k) ?? []), r]);
  }
  return {
    truncated: false,
    data: keys.map((key) => {
      const b = have.get(key) ?? { ...EMPTY, key };
      const t = keyTime(key);
      const tokens = tokensAll(b);
      return {
        key,
        label: range === '7d' ? new Date(t).toLocaleDateString('en-GB', { weekday: 'short' }) : shortDate(t),
        long: longDate(t),
        value: b.costUsd,
        worth: worth(b),
        tokens,
        calls: b.calls,
        current: key === today,
        detail: <Readout tokens={tokens} calls={b.calls} models={topModels(byDayRecords.get(key) ?? [])} value={b} />,
      };
    }),
  };
}

function CostSection({ range, data, truncated, dim, rows }: { range: Range; data: Columns['data']; truncated: boolean; dim: boolean; rows: UsageSummary }) {
  const [table, setTable] = useState(false);
  const hourly = range === 'today';
  const title = hourly ? 'Cost per hour' : 'Cost per day';
  const fmt = (n: number) => usd(n);
  // a plan served some of it: the table says what each day was worth at API prices
  const valued = data.some((d) => planServed({ costUsd: d.value, apiValueUsd: d.worth }));
  return (
    <section aria-labelledby="usage-cost">
      <SectionHeading id="usage-cost" right={<TextAction label={table ? 'View as chart' : 'View as table'} onClick={() => setTable((t) => !t)} />}>
        {title}
      </SectionHeading>
      {table ? (
        <div className="max-h-[340px] overflow-y-auto">
          <table className="tbl">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th>{hourly ? 'Hour' : 'Day'}</th>
                <th className="r">Tokens</th>
                <th className="r">Requests</th>
                {valued && <th className="r">At API prices</th>}
                <th className="r">{valued ? 'Billed' : 'Cost'}</th>
              </tr>
            </thead>
            <tbody>
              {[...data]
                .filter((d) => !d.future)
                .reverse()
                .map((d) => (
                  <tr key={d.key}>
                    <td className={cn(d.current ? 'text-fg' : 'text-fg-2')}>{hourly ? <span className="num">{d.long}</span> : d.long}</td>
                    <td className="r text-fg-2">{compact(d.tokens)}</td>
                    <td className="r text-fg-2">{compact(d.calls)}</td>
                    {valued && <td className="r text-fg-2">{planServed({ costUsd: d.value, apiValueUsd: d.worth }) ? usd(d.worth, { precise: d.worth < 10 }) : <span className="text-fg-3">same</span>}</td>}
                    <td className="r text-fg">{usd(d.value, { precise: d.value > 0 && d.value < 10 })}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pt-4">
          <CostColumns data={data} label={`${title}, ${usd(rows.totals.costUsd)} in total`} dim={dim} format={fmt} labelAt={hourly ? (i) => i % 3 === 0 : data.length <= 8 ? () => true : undefined} />
        </div>
      )}
      <p className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">
        All providers in US dollars. Plans you pay for monthly bill $0 per call{valued ? '; the table view says what their calls are worth at API prices' : ''}.
        {hourly && truncated && ` Earlier hours may be missing: this view reads the last ${RECENT} requests.`}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

function ShareCell({ share, label, mobile }: { share: number; label: string; mobile?: boolean }) {
  if (mobile) return <span className="num">{percent(share)} of spend</span>;
  return (
    <span className="inline-flex items-center justify-end gap-2.5 align-middle">
      <span className="block w-14">
        <Meter value={share * 100} label={`${label}, ${Math.round(share * 100)} percent of spend`} />
      </span>
      <span className="num w-9 text-right text-fg-2">{percent(share)}</span>
    </span>
  );
}

function ByModel({ u, plans, mobile }: { u: UsageSummary; plans: Set<string>; mobile: boolean }) {
  const wide = useIsWide();
  const total = u.totals.costUsd || 1;
  const rows = u.byModel.filter((b) => b.calls > 0 || b.costUsd > 0);
  const isPlan = (ref: string) => {
    const { provider } = splitRef(ref);
    return plans.has(provider) || !!harnessId(ref);
  };
  const cols: Column<UsageBucketDto>[] = [
    {
      key: 'model',
      header: 'Model',
      title: true,
      render: (r) => {
        const { provider } = splitRef(r.key);
        const name = <ModelName model={r.key} as="model" tone="brand" size={14} />;
        if (provider !== 'openrouter') return name;
        return (
          <span className="inline-flex min-w-0 items-center whitespace-nowrap">
            {name}
            <span className="font-normal text-fg-3">, OpenRouter</span>
          </span>
        );
      },
    },
    {
      key: 'calls',
      header: 'Requests',
      numeric: true,
      dim: true,
      width: 92,
      sort: (a, b) => a.calls - b.calls,
      render: (r) => (mobile ? `${compact(r.calls)} requests` : compact(r.calls)),
    },
    {
      key: 'in',
      header: 'Tokens in',
      numeric: true,
      dim: true,
      phoneHide: true,
      width: 92,
      sort: (a, b) => tokensIn(a) - tokensIn(b),
      render: (r) => compact(tokensIn(r)),
    },
    {
      key: 'out',
      header: 'Tokens out',
      numeric: true,
      dim: true,
      phoneHide: true,
      width: 92,
      sort: (a, b) => a.outputTokens - b.outputTokens,
      render: (r) => compact(r.outputTokens),
    },
    {
      key: 'cache',
      header: 'Cache hits',
      numeric: true,
      dim: true,
      phoneHide: true,
      width: 92,
      sort: (a, b) => cacheRate(a) - cacheRate(b),
      render: (r) => percent(cacheRate(r)),
    },
    // narrow desktops show one tokens column instead of in, out and cache
    {
      key: 'tokens',
      header: 'Tokens',
      numeric: true,
      dim: true,
      width: 92,
      sort: (a, b) => tokensAll(a) - tokensAll(b),
      render: (r) => compact(tokensAll(r)),
    },
    {
      key: 'share',
      header: 'Share',
      className: 'r',
      width: 132,
      // a phone row of a plan says what it is worth, not "0% of spend"
      render: (r) => (mobile && r.costUsd === 0 ? '' : <ShareCell share={r.costUsd / total} label={r.key} mobile={mobile} />),
    },
    ...valueColumns<UsageBucketDto>(rows, mobile, (r) => isPlan(r.key)),
  ];
  return (
    <Section title="By model" count={rows.length} rows={false}>
      <Table
        caption="Usage by model"
        // with plans, what they are worth takes the place of the share of spend, so the row fits
        columns={phoneOrder(cols.filter((c) => (wide || mobile ? c.key !== 'tokens' : !['in', 'out', 'cache'].includes(c.key)) && !(c.key === 'share' && cols.some((x) => x.key === 'worth') && !mobile)), mobile)}
        rows={rows}
        rowKey={(r) => r.key}
        defaultSort={{ key: 'cost', dir: 'desc' }}
      />
    </Section>
  );
}

/** On a phone the share of spend goes last in a row's line, so what a plan's calls are worth is not cut off. */
function phoneOrder<T>(cols: Column<T>[], mobile: boolean): Column<T>[] {
  return mobile ? [...cols.filter((c) => c.key !== 'share'), ...cols.filter((c) => c.key === 'share')] : cols;
}

/**
 * Billed, and what the calls are worth at API prices when a signed in plan
 * served some of the rows: "$0" beside "$41.20". A plan row with no price to
 * show says plan. On phones the value goes in the row's meta line.
 */
function valueColumns<T extends Valued>(rows: T[], mobile: boolean, isPlan?: (r: T) => boolean): Column<T>[] {
  const valued = rows.some(planServed);
  const billed: Column<T> = {
    key: 'cost',
    header: valued ? 'Billed' : 'Cost',
    numeric: true,
    width: 84,
    sort: (a, b) => a.costUsd - b.costUsd,
    render: (r) => (r.costUsd === 0 && !planServed(r) && isPlan?.(r) ? <span className="text-fg-3">plan</span> : <span className="text-fg">{usd(r.costUsd)}</span>),
  };
  if (!valued) return [billed];
  const value: Column<T> = {
    key: 'worth',
    header: 'At API prices',
    numeric: true,
    dim: true,
    width: 112,
    sort: (a, b) => worth(a) - worth(b),
    render: (r) => (planServed(r) ? (mobile ? `worth ${usd(worth(r))} at API prices` : usd(worth(r))) : mobile ? '' : <span className="text-fg-3">same</span>),
  };
  return [value, billed];
}

function SourceName({ id }: { id: string }) {
  const s = SOURCES[id];
  const harness = ['claude-code', 'codex', 'gemini-cli', 'opencode'].includes(id);
  return (
    <span className="block min-w-0">
      <span className="block truncate font-medium text-fg">{harness ? <HarnessName harness={id} size={14} /> : (s?.name ?? capital(id))}</span>
      {s?.help && <span className="block truncate text-[12px] font-normal text-fg-3 phone:hidden">{s.help}</span>}
    </span>
  );
}

function Breakdown({ title, rows, total, name, caption, isPlan }: { title: string; rows: UsageBucketDto[]; total: number; name: (key: string) => ReactNode; caption: string; isPlan?: (key: string) => boolean }) {
  const mobile = useIsMobile();
  const cols: Column<UsageBucketDto>[] = [
    { key: 'name', header: 'Source', title: true, render: (r) => name(r.key) },
    {
      key: 'calls',
      header: 'Requests',
      numeric: true,
      dim: true,
      phoneHide: true,
      width: 92,
      render: (r) => compact(r.calls),
    },
    {
      key: 'tokens',
      header: 'Tokens',
      numeric: true,
      dim: true,
      width: 92,
      render: (r) => (mobile ? `${compact(tokensAll(r))} tokens` : compact(tokensAll(r))),
    },
    {
      key: 'share',
      header: 'Share',
      className: 'r',
      width: 132,
      render: (r) => (mobile && r.costUsd === 0 ? '' : <ShareCell share={r.costUsd / (total || 1)} label={r.key} mobile={mobile} />),
    },
  ];
  if (cols[0]) cols[0].header = title === 'By purpose' ? 'Purpose' : title === 'By account' ? 'Account' : 'Source';
  const list = [...rows].filter((r) => r.calls > 0 || r.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd);
  // plan rows bill $0: what they are worth at API prices reads beside it
  cols.push(...valueColumns(list, mobile, isPlan ? (r) => isPlan(r.key) : undefined));
  return (
    <Section title={title} count={list.length} rows={false} className="min-w-0">
      <Table caption={caption} columns={phoneOrder(cols, mobile)} rows={list} rowKey={(r) => r.key} />
    </Section>
  );
}

/** Spend per account (Settings > Models > Accounts), so a plan's use and the API key's spend read apart. */
function ByAccount({ u }: { u: UsageSummary }) {
  const { status } = useAccounts();
  const rows = u.byAccount ?? [];
  if (!rows.some((r) => r.key)) return null;
  const name = (k: string) => {
    const a = status?.accounts.find((x) => x.id === k);
    if (!k)
      return (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-fg">No account</span>
          <span className="block truncate text-[12px] font-normal text-fg-3 phone:hidden">Calls from before accounts, CLI logs and local models</span>
        </span>
      );
    return (
      <span className="block min-w-0">
        <span className="block truncate font-medium text-fg">{a?.label ?? k}</span>
        {a && <span className="block truncate text-[12px] font-normal text-fg-3 phone:hidden">{a.kind === 'api' ? (a.budget ? `Budget $${a.budget.usd} a ${a.budget.period ?? 'month'}` : 'API key, no budget') : `${a.vendorName}${a.plan ? ` ${a.plan}` : ''}`}</span>}
      </span>
    );
  };
  const isPlan = (k: string) => status?.accounts.find((a) => a.id === k)?.kind === 'subscription';
  // the list sorts by cost; plans cost nothing per token, so they go by what they are worth, then requests, among themselves
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd || worth(b) - worth(a) || b.calls - a.calls);
  return <Breakdown title="By account" caption="Usage by account" rows={sorted} total={u.totals.costUsd} name={name} isPlan={isPlan} />;
}

function BySource({ u }: { u: UsageSummary }) {
  return <Breakdown title="By source" caption="Usage by source" rows={u.bySource} total={u.totals.costUsd} name={(k) => <SourceName id={k} />} />;
}

function ByPurpose({ u }: { u: UsageSummary }) {
  // juries and debates read as one line of work
  const merged = new Map<string, UsageBucketDto>();
  for (const b of u.byPurpose) {
    const k = b.key === 'debate' ? 'jury' : b.key || 'turn';
    const cur = merged.get(k) ?? { ...EMPTY, key: k };
    merged.set(k, {
      key: k,
      inputTokens: cur.inputTokens + b.inputTokens,
      outputTokens: cur.outputTokens + b.outputTokens,
      cacheReadTokens: cur.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: cur.cacheWriteTokens + b.cacheWriteTokens,
      costUsd: cur.costUsd + b.costUsd,
      apiValueUsd: worth(cur) + worth(b),
      ...(cur.estimatedUsd || b.estimatedUsd ? { estimatedUsd: (cur.estimatedUsd ?? 0) + (b.estimatedUsd ?? 0) } : {}),
      calls: cur.calls + b.calls,
    });
  }
  const label = (k: string) => (k === 'jury' && u.byPurpose.some((b) => b.key === 'debate') ? 'Juries and debates' : (PURPOSES[k] ?? capital(k)));
  return <Breakdown title="By purpose" caption="Usage by purpose" rows={[...merged.values()]} total={u.totals.costUsd} name={(k) => <span className="font-medium text-fg">{label(k)}</span>} />;
}

// ---------------------------------------------------------------------------
// Limits (live, not tied to the range)
// ---------------------------------------------------------------------------

function Limits({ wave }: { wave: boolean }) {
  const [, navigate] = useLocation();
  const map = useHub((s) => s.limits);
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const slow = useDelayed(busy, 1000);
  const mobile = useIsMobile();
  const { status: accounts } = useAccounts();
  const nowIds = new Set((accounts?.now ?? []).map((n) => n.account).filter((x): x is string => !!x));
  // phones skip per-minute API windows under 50%, like Home
  const limits = useMemo(
    () =>
      Object.values(map)
        .filter((l) => !mobile || !!l.note || l.windows.some((w) => !isRateWindow(w) || (w.usedPercent ?? 0) > 50))
        .sort((a, b) => limitPeak(b) - limitPeak(a)),
    [map, mobile],
  );

  const refresh = async () => {
    setBusy(true);
    const list = await attempt(() => api().refreshLimits());
    if (list)
      useHub.setState({
        limits: Object.fromEntries(list.map((l) => [limitKey(l), l])),
      });
    setBusy(false);
  };

  const right = busy ? slow ? <LiveStatus state="tool" label="Refreshing" /> : <span className="text-[12px] text-fg-3">Refreshing</span> : <TextAction label="Refresh" onClick={() => void refresh()} />;

  const accountLimits = limits.filter((l) => l.account);
  const otherLimits = limits.filter((l) => !l.account);
  const group = (l: LimitState) => (
    <LimitGroup
      key={limitKey(l)}
      limit={l}
      hideRate={mobile}
      right={
        // the account taking calls says so; the rest say where their numbers came from
        l.account && nowIds.has(l.account) ? (
          <span className="text-ok">Now using</span>
        ) : (
          <span className={cn(l.source === 'error' && 'text-fault')}>{l.source === 'error' ? LIMIT_SOURCE.error : `${LIMIT_SOURCE[l.source]}, ${ageWords(l.updatedAt, now)}`}</span>
        )
      }
    />
  );
  // accounts in the owner's order, so "Account 1, then Account 2, then the key" reads top to bottom
  const rank = new Map((accounts?.routes ?? []).filter((r) => !r.match).flatMap((r) => r.order).map((id, i) => [id, i]));
  accountLimits.sort((a, b) => (rank.get(a.account!) ?? 99) - (rank.get(b.account!) ?? 99));

  return (
    <section aria-labelledby="usage-limits">
      <SectionHeading id="usage-limits" count={limits.length || undefined} right={right}>
        Limits
      </SectionHeading>
      {limits.length > 0 && accountLimits.length > 0 ? (
        <>
          <p className="m-0 mt-3 text-[12px] text-fg-3 phone:text-[13px]">By account, in the order the hub uses them</p>
          <div className="rows">{accountLimits.map(group)}</div>
          {otherLimits.length > 0 && <p className="m-0 mt-4 text-[12px] text-fg-3 phone:text-[13px]">Other plans and keys</p>}
          <div className="rows">{otherLimits.map(group)}</div>
        </>
      ) : limits.length === 0 ? (
        <EmptyState
          wave={wave}
          action={
            <Button variant="outline" onClick={() => navigate('/settings/providers')}>
              Add a provider
            </Button>
          }
        >
          No plan limits yet. Sign in through Claude Code or Codex, or add a key, and each window shows up here with its reset.
        </EmptyState>
      ) : (
        <div className="rows">{limits.map(group)}</div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent requests (collapsed by default)
// ---------------------------------------------------------------------------

function Recent({ rows, onOpen, plans }: { rows: UsageRecord[] | undefined; onOpen: (sessionId: string) => void; plans: Set<string> }) {
  const [open, setOpen] = useState(false);
  const { status: accounts } = useAccounts();
  const [all, setAll] = useState(false);
  const mobile = useIsMobile();
  const list = (rows ?? []).slice(0, 100);
  const shown = all ? list : list.slice(0, 25);
  const cols: Column<UsageRecord>[] = [
    {
      key: 'time',
      header: 'Time',
      dim: true,
      render: (r) => <span className="num">{hhmm(r.ts)}</span>,
    },
    {
      key: 'model',
      header: 'Model',
      title: true,
      render: (r) => <ModelName model={r.model} as="model" size={14} />,
    },
    {
      key: 'source',
      header: 'Source',
      dim: true,
      render: (r) => SOURCES[r.source]?.name ?? capital(r.source),
    },
    {
      key: 'purpose',
      header: 'Purpose',
      dim: true,
      phoneHide: true,
      render: (r) => (r.purpose ? (PURPOSES[r.purpose] ?? capital(r.purpose)) : ''),
    },
    {
      key: 'account',
      header: 'Account',
      dim: true,
      phoneHide: true,
      render: (r) => (r.account ? (accounts?.accounts.find((a) => a.id === r.account)?.label ?? r.account) : ''),
    },
    {
      key: 'in',
      header: 'In',
      numeric: true,
      dim: true,
      phoneHide: true,
      render: (r) => compact(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens),
    },
    {
      key: 'out',
      header: 'Out',
      numeric: true,
      dim: true,
      phoneHide: true,
      render: (r) => compact(r.outputTokens),
    },
    {
      key: 'latency',
      header: 'Latency',
      numeric: true,
      dim: true,
      phoneHide: true,
      render: (r) => duration(r.latencyMs),
    },
    {
      key: 'worth',
      header: 'At API prices',
      numeric: true,
      dim: true,
      phoneHide: true,
      render: (r) => (planServed(r) ? <span title={r.apiValueEstimated ? "Priced from today's list prices: the hub did not keep it then" : undefined}>{usd(worth(r), { precise: true })}{r.apiValueEstimated ? ' est.' : ''}</span> : ''),
    },
    {
      key: 'cost',
      header: 'Billed',
      numeric: true,
      render: (r) => (r.costUsd === 0 && !planServed(r) && (plans.has(r.provider) || !!harnessId(r.model)) ? <span className="text-fg-3">plan</span> : <span className="text-fg">{usd(r.costUsd, { precise: true })}</span>),
    },
  ];
  return (
    <section aria-labelledby="usage-recent">
      <SectionHeading id="usage-recent" count={open ? list.length : undefined} right={<TextAction label={open ? 'Hide' : 'Show recent requests'} onClick={() => setOpen((o) => !o)} />}>
        Recent requests
      </SectionHeading>
      {open && (
        <div className="anim-fade">
          <Table caption="Recent requests" columns={mobile ? cols.filter((c) => c.key !== 'source') : cols} rows={shown} rowKey={(r) => r.id} onRowClick={(r) => r.sessionId && onOpen(r.sessionId)} />
          {!all && list.length > shown.length && (
            <div className="border-t border-rule pt-2.5">
              <TextAction label={`Show ${list.length - shown.length} more`} onClick={() => setAll(true)} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
