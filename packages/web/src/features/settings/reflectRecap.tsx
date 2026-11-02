/**
 * Reflect's recap (GET /api/reflect/recap): your week, month or year in the
 * hub, from its own tables and only your account. Numbers first, then what
 * you worked on, new people, likes and dislikes, rhythm and a few facts.
 * Summarise is one call on your small model; nothing else calls a model.
 */
import { useEffect, useState } from 'react';
import type { RecapDto, RecapMemory, RecapPeriod } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { compact, int, usd } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { KV, Quote, SectionHeading } from '@/components/ui/Section';
import { Stat, StatGroup } from '@/components/ui/Stat';
import { toast } from '@/store/store';
import { errText } from './parts';
import { dayWords, projectName, recapHeadline, recapRange } from './reflectWords';

const PERIODS: Array<{ value: RecapPeriod; label: string }> = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

export function RecapSection() {
  const mobile = useIsMobile();
  const [period, setPeriod] = useState<RecapPeriod>('week');
  const [byPeriod, setByPeriod] = useState<Partial<Record<RecapPeriod, RecapDto>>>({});
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<Partial<Record<RecapPeriod, string>>>({});
  const [busy, setBusy] = useState(false);
  const r = byPeriod[period];

  useEffect(() => {
    if (byPeriod[period]) return;
    setError(undefined);
    api()
      .reflectRecap(period)
      .then((d) => setByPeriod((m) => ({ ...m, [period]: d })))
      .catch((e) => setError(errText(e)));
  }, [period, byPeriod]);

  const summarise = async () => {
    setBusy(true);
    try {
      const out = await api().reflectSummary(period);
      setSummary((m) => ({ ...m, [period]: out.summary }));
    } catch (e) {
      toast({ title: `Could not summarise. ${errText(e)}`, level: 'error' });
    }
    setBusy(false);
  };

  const empty = !!r && !r.totals.chats && !r.totals.sessions && !r.totals.workflows && !r.totals.tokens;

  return (
    <section aria-labelledby="recap-h" className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="recap-h" className="t-section m-0 text-fg">
            Recap{r && <span className="ml-2 font-[450] text-fg-3">{recapRange(r)}</span>}
          </h2>
          <Segmented label="Period" size={mobile ? 'touch' : 'sm'} value={period} onChange={setPeriod} options={PERIODS} />
        </div>
        {error ? (
          <p className="mt-4 text-[13px] text-fault">Could not load the recap. {error}</p>
        ) : !r ? (
          <LoadingRows loading rows={4} className="mt-4" />
        ) : (
          <p className="mt-4 mb-0 max-w-[60ch] text-[17px] leading-[1.4] text-fg phone:text-[18px]">{recapHeadline(r)}</p>
        )}
      </div>

      {r && !empty && (
        <>
          <div className="space-y-5">
            <StatGroup className="phone:flex-wrap phone:gap-y-4 phone:[&>*]:basis-[45%] phone:[&>*:nth-child(3)]:border-l-0 phone:[&>*:nth-child(3)]:pl-0">
              <Stat value={int(r.totals.chats)} label="Chats" />
              <Stat value={int(r.totals.sessions)} label="Sessions" />
              <Stat value={int(r.totals.workflows)} label="Workflows" />
              <Stat value={int(r.rhythm.activeDays)} label="Active days" />
            </StatGroup>
            <StatGroup className="phone:flex-wrap phone:gap-y-4 phone:[&>*]:basis-[45%] phone:[&>*:nth-child(3)]:border-l-0 phone:[&>*:nth-child(3)]:pl-0">
              <Stat value={compact(r.totals.tokens)} label="Tokens" />
              <Stat value={usd(r.totals.costUsd)} label="Cost" />
              <Stat value={int(r.totals.models)} label={r.totals.models === 1 ? 'Model' : 'Models'} />
              <Stat value={r.rhythm.longestStreak ? `${r.rhythm.longestStreak}d` : '0'} label="Longest streak" />
            </StatGroup>
          </div>

          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <Button variant="outline" size={mobile ? 'touch' : 'sm'} busy={busy ? 'Summarising' : false} onClick={() => void summarise()}>
                {summary[period] ? 'Summarise again' : 'Summarise'}
              </Button>
              <span className="text-[12px] text-fg-3 phone:text-[13px]">One call on your small model.</span>
            </div>
            {summary[period] && <Quote className="mt-3 max-w-[64ch] text-[14px] leading-[1.55]">{summary[period]}</Quote>}
          </div>

          <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
            <Ranked title="Top models" empty="No model calls in this period.">
              {r.models.slice(0, 5).map((m) => (
                <Row key={m.name} name={m.name} value={`${compact(m.tokens)} tokens`} meta={m.costUsd ? usd(m.costUsd) : undefined} />
              ))}
            </Ranked>
            <Ranked title="What you worked on" empty="No folders in this period.">
              {r.projects.slice(0, 5).map((p) => (
                <Row key={p.name} name={projectName(p.name)} title={p.name} value={p.count === 1 ? '1 session' : `${p.count} sessions`} />
              ))}
            </Ranked>
          </div>

          {r.topics.length > 0 && (
            <div>
              <SectionHeading>Topics</SectionHeading>
              <p className="mt-3 mb-0 text-[14px] leading-[1.6] text-fg-2 phone:text-[15px]">
                {r.topics.map((t, i) => (
                  <span key={t.name}>
                    {i > 0 && ', '}
                    <span className="text-fg">{t.name}</span>
                    {t.count > 1 && <span className="num text-fg-3"> {t.count}</span>}
                  </span>
                ))}
              </p>
            </div>
          )}

          <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
            <Memories title="New people" items={r.people} empty="Nobody new in memory this period." />
            <Memories title="Likes and dislikes" items={r.preferences} empty="No new preferences saved this period." />
          </div>

          <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
            <div>
              <SectionHeading>Rhythm</SectionHeading>
              <dl className="m-0 mt-2">
                <KV k="Active days" keyWidth={112}>
                  <span className="num">{r.rhythm.activeDays}</span>
                </KV>
                <KV k="Longest streak" keyWidth={112}>
                  <span className="num">{r.rhythm.longestStreak === 1 ? '1 day' : `${r.rhythm.longestStreak} days`}</span>
                </KV>
                {r.rhythm.busiestDay && (
                  <KV k="Busiest day" keyWidth={112}>
                    {dayWords(r.rhythm.busiestDay.name)}
                  </KV>
                )}
                {r.rhythm.busiestHour && (
                  <KV k="Busiest hour" keyWidth={112}>
                    <span className="num">{r.rhythm.busiestHour.name}</span>
                  </KV>
                )}
                {r.rhythm.timeOfDay && (
                  <KV k="Most often" keyWidth={112}>
                    {r.rhythm.timeOfDay.name}
                  </KV>
                )}
              </dl>
            </div>
            {r.facts.length > 0 && (
              <div>
                <SectionHeading>Fun facts</SectionHeading>
                <ul className="m-0 mt-2 list-none space-y-2 p-0">
                  {r.facts.map((f) => (
                    <li key={f} className="text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Ranked({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div>
      <SectionHeading>{title}</SectionHeading>
      {children.length ? <ul className="m-0 list-none p-0">{children}</ul> : <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[15px]">{empty}</p>}
    </div>
  );
}

function Row({ name, value, meta, title }: { name: string; value: string; meta?: string; title?: string }) {
  return (
    <li className="flex items-baseline gap-3 border-b border-rule py-2.5 last:border-b-0">
      <span title={title ?? name} className="min-w-0 flex-1 truncate text-[13.5px] font-[500] text-fg phone:text-[15px]">
        {name}
      </span>
      <span className="num shrink-0 text-[13px] text-fg-2 phone:text-[14px]">{value}</span>
      {meta && <span className="num w-14 shrink-0 text-right text-[13px] text-fg-3 phone:text-[14px]">{meta}</span>}
    </li>
  );
}

function Memories({ title, items, empty }: { title: string; items: RecapMemory[]; empty: string }) {
  return (
    <div>
      <SectionHeading count={items.length || undefined}>{title}</SectionHeading>
      {items.length ? (
        <ul className="m-0 list-none p-0">
          {items.slice(0, 6).map((m) => (
            <li key={m.id} className="border-b border-rule py-2.5 text-[13.5px] leading-[1.45] text-fg last:border-b-0 phone:text-[15px]">
              {m.content}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[15px]">{empty}</p>
      )}
    </div>
  );
}
