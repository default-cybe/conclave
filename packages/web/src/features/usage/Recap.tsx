/**
 * Recap (ideas item recap-stats): the last 14 days in two small stacked
 * charts, spend and requests per provider per day, from the same
 * recent-records feed the hourly view reads. Self-contained on purpose: the
 * Usage page restructure can move it without unwiring. Pure grouping in
 * recapSeries, so test/usage-recap.test.ts checks it.
 */
import { useMemo } from 'react';
import type { UsageRecord } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useHub } from '@/store/store';
import { useLoad } from '@/lib/hooks';
import { compact, shortDate, usd } from '@/lib/format';
import { SectionHeading } from '@/components/ui/Section';
import { useWidth } from './charts';
import { worth } from './value';

const DAY = 86_400_000;
export const RECAP_DAYS = 14;
/** The server caps /api/usage/recent at 1000; heavier windows read as truncated. */
const RECENT = 1000;

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface RecapSeries {
  days: Array<{ key: string; t: number }>;
  /** Providers by total worth, then requests; both series are per-day and zero-filled. */
  providers: Array<{ provider: string; spend: number[]; calls: number[]; totalSpend: number; totalCalls: number }>;
  truncated: boolean;
}

export function recapSeries(records: UsageRecord[], now: number, days = RECAP_DAYS): RecapSeries {
  const end = startOfDay(now);
  const list = Array.from({ length: days }, (_, i) => {
    const t = end - (days - 1 - i) * DAY;
    return { key: dayKey(t), t };
  });
  const at = new Map(list.map((d, i) => [d.key, i]));
  const from = list[0].t;
  const by = new Map<string, { spend: number[]; calls: number[] }>();
  for (const r of records) {
    if (r.ts < from || r.ts > now) continue;
    const i = at.get(dayKey(r.ts));
    if (i === undefined) continue;
    const p = by.get(r.provider) ?? { spend: Array<number>(days).fill(0), calls: Array<number>(days).fill(0) };
    p.spend[i] += worth(r);
    p.calls[i] += 1;
    by.set(r.provider, p);
  }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const providers = [...by.entries()]
    .map(([provider, v]) => ({ provider, ...v, totalSpend: sum(v.spend), totalCalls: sum(v.calls) }))
    .sort((a, b) => b.totalSpend - a.totalSpend || b.totalCalls - a.totalCalls);
  const truncated = records.length >= RECENT && records[records.length - 1].ts > from;
  return { days: list, providers, truncated };
}

/** Providers stack strongest first, so the biggest name gets the clearest shade. */
const shade = (i: number) => `color-mix(in oklab, var(--meter-on) ${Math.max(20, 80 - i * 15)}%, var(--bg))`;

function Stacked({ s, metric, label, format }: { s: RecapSeries; metric: 'spend' | 'calls'; label: string; format: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = 120;
  const bottom = 18;
  const plotH = height - bottom;
  const peak = Math.max(1, ...s.days.map((_, i) => s.providers.reduce((a, p) => a + p[metric][i], 0)));
  const slot = s.days.length ? width / s.days.length : 0;
  const bw = Math.max(2, Math.min(24, slot * 0.6));
  const x = (i: number) => i * slot + slot / 2;
  return (
    <figure className="m-0 min-w-0" aria-label={label}>
      <figcaption className="mb-1.5 text-[12px] text-fg-3 phone:text-[13px]">{label}</figcaption>
      <div ref={ref} style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} className="block" aria-hidden>
            <line x1={0} x2={width} y1={height - bottom + 0.5} y2={height - bottom + 0.5} stroke="var(--rule-2)" strokeWidth="1" />
            {s.days.map((d, i) => {
              let y = plotH;
              const total = s.providers.reduce((a, p) => a + p[metric][i], 0);
              return (
                <g key={d.key}>
                  {s.providers.map((p, j) => {
                    const v = p[metric][i];
                    if (!v) return null;
                    const h = (v / peak) * plotH;
                    y -= h;
                    return <rect key={p.provider} x={x(i) - bw / 2} y={y} width={bw} height={Math.max(h, 0.5)} fill={shade(j)} />;
                  })}
                  {total === 0 && <rect x={x(i) - bw / 2} y={plotH - 1} width={bw} height={1} fill="var(--rule)" />}
                </g>
              );
            })}
            {s.days.map((d, i) =>
              i % 3 === (s.days.length - 1) % 3 ? (
                <text key={`l${d.key}`} x={x(i)} y={height - 5} textAnchor="middle" className="fill-[var(--fg-3)] font-mono text-[11px] font-[450]" style={{ fontFeatureSettings: '"zero" 1' }}>
                  {shortDate(d.t)}
                </text>
              ) : null,
            )}
          </svg>
        )}
      </div>
      <p className="m-0 mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-fg-2 phone:text-[13px]">
        {s.providers.map((p, j) => (
          <span key={p.provider} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-[2px]" style={{ background: shade(j) }} />
            {p.provider}: {metric === 'spend' ? usd(p.totalSpend) : `${compact(p.totalCalls)} ${p.totalCalls === 1 ? 'request' : 'requests'}`}
          </span>
        ))}
      </p>
      {/* the totals, for screen readers and hover */}
      <table className="sr-only">
        <caption>{label} by provider per day</caption>
        <tbody>
          {s.days.map((d, i) => (
            <tr key={d.key}>
              <th scope="row">{shortDate(d.t)}</th>
              {s.providers.map((p) => (
                <td key={p.provider}>
                  {p.provider} {format(p[metric][i])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export default function Recap() {
  const tick = useHub((s) => s.usageVersion);
  const recent = useLoad(() => api().usageRecent(RECENT), [Math.floor(tick / 3)]);
  const s = useMemo(() => (recent.data ? recapSeries(recent.data, Date.now()) : undefined), [recent.data]);
  if (!s || s.providers.length === 0) return null;
  return (
    <section aria-labelledby="usage-recap" className="anim-fade">
      <SectionHeading id="usage-recap">Last 14 days</SectionHeading>
      <div className="grid gap-6 pt-3 sm:grid-cols-2">
        <Stacked s={s} metric="spend" label="Spend per provider, per day (at API prices)" format={(n) => usd(n)} />
        <Stacked s={s} metric="calls" label="Requests per provider, per day" format={(n) => String(n)} />
      </div>
      <p className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">
        Plans you pay for monthly bill $0 per call, so spend reads at API prices.
        {s.truncated && ` Earlier days may be missing: this view reads the last ${RECENT} requests.`}
      </p>
    </section>
  );
}
