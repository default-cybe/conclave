/**
 * Reflect's report (GET /api/reflect/report, docs/ASSISTANT.md, Reflect):
 * your own week, month or last 3, 6 or 12 months. Eight short sections, each
 * hidden when there is too little to say: the headline and big numbers, what
 * you worked on, when you work, the four AI Fluency habits, models and
 * agents, fun stats, suggestions and a question to talk through in a new
 * chat. Kept per range until Refresh or a week old.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { AssistantSettingsDto, ReflectRange, ReflectReport } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { compact, int, usd } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Input, Segmented } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { SectionHeading } from '@/components/ui/Section';
import { Stat, StatGroup } from '@/components/ui/Stat';
import { toast } from '@/store/store';
import { startChat } from '@/features/conversation/actions';
import { errText, Group, SettingRow } from './parts';
import { bigNumbers, dayWords, excludedWords, HABIT_WORDS, heatLevel, lateLine, madeWords, RANGES, reportRange, TIME } from './reflectWords';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HEAT = ['bg-sunk', 'bg-fg/15', 'bg-fg/30', 'bg-fg/55', 'bg-fg/80'];
const TEXT = 'text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]';

export function ReportSection() {
  const mobile = useIsMobile();
  const [range, setRange] = useState<ReflectRange>('week');
  const [byRange, setByRange] = useState<Partial<Record<ReflectRange, ReflectReport>>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const r = byRange[range];

  useEffect(() => {
    if (byRange[range]) return;
    setError(undefined);
    api()
      .reflectReport(range)
      .then((d) => setByRange((m) => ({ ...m, [range]: d })))
      .catch((e) => setError(errText(e)));
  }, [range, byRange]);

  const refresh = async () => {
    setBusy(true);
    try {
      const d = await api().reflectRefresh(range);
      setByRange((m) => ({ ...m, [range]: d }));
    } catch (e) {
      toast({ title: `Could not refresh. ${errText(e)}`, level: 'error' });
    }
    setBusy(false);
  };

  const empty = !!r && !r.totals.chats && !r.totals.sessions;
  return (
    <section aria-labelledby="report-h" className="space-y-10">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="report-h" className="t-section m-0 text-fg">
            Your report{r && <span className="ml-2 font-[450] text-fg-3">{reportRange(r)}</span>}
          </h2>
          <Segmented label="Range" size={mobile ? 'touch' : 'sm'} value={range} onChange={setRange} options={RANGES} />
        </div>
        {error ? (
          <p className="mt-4 text-[13px] text-fault">Could not load the report. {error}</p>
        ) : !r ? (
          <LoadingRows loading rows={5} className="mt-4" />
        ) : (
          <>
            <p className="mt-4 mb-0 max-w-[60ch] text-[19px] leading-[1.35] text-fg phone:text-[18px]">{r.headline}</p>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
              <span className="text-[12px] text-fg-3 phone:text-[13px]">{madeWords(r)}</span>
              {!empty && (
                <Button variant="outline" size={mobile ? 'touch' : 'sm'} busy={busy ? 'Making it' : false} onClick={() => void refresh()}>
                  Refresh
                </Button>
              )}
            </div>
            {r.insightsNote && <p className="mt-2 mb-0 text-[12px] text-warn phone:text-[13px]">{r.insightsNote}</p>}
          </>
        )}
      </div>

      {r && !empty && <Report r={r} />}
      <Controls />
    </section>
  );
}

function Report({ r }: { r: ReflectReport }) {
  const [, navigate] = useLocation();
  const late = lateLine(r.rhythm.lateNightShare, r.rhythm.messages);
  const max = Math.max(...r.rhythm.heatmap.flat());
  const fun = r.fun;
  const funRows = [
    fun.topTool && ['Most-used tool', `${fun.topTool.name}, ${int(fun.topTool.count)} calls`],
    fun.longestChat && ['Longest chat', `${fun.longestChat.title}, ${fun.longestChat.messages} messages from you`],
    fun.biggestWorkflow && ['Biggest workflow', `${fun.biggestWorkflow.name}, ${fun.biggestWorkflow.agents} agents${fun.biggestWorkflow.costUsd ? `, ${usd(fun.biggestWorkflow.costUsd)}` : ''}`],
    fun.newPeople.length > 0 && ['New people', fun.newPeople.join(', ')],
    fun.memoriesAdded > 0 && ['Memories added', int(fun.memoriesAdded)],
    fun.skillsLearned.length > 0 && ['Skills learned', fun.skillsLearned.join(', ')],
    (fun.goalsMoved > 0 || fun.goalsDone > 0) && ['Goals', `${fun.goalsMoved} progress ${fun.goalsMoved === 1 ? 'entry' : 'entries'}${fun.goalsDone ? `, ${fun.goalsDone} done` : ''}`],
  ].filter(Boolean) as Array<[string, string]>;
  const talk = () =>
    void startChat({ text: `Let's talk through a question from my Reflect report (${reportRange(r)}): "${r.question}"\n\n${r.headline}\n\nAsk me one thing at a time and keep it short.`, attachments: [] }, { chat: {} }, navigate);
  const footnote = excludedWords(r.excluded);

  return (
    <div className="space-y-11">
      <StatGroup className="phone:flex-wrap phone:gap-y-4 phone:[&>*]:basis-[45%] phone:[&>*:nth-child(3)]:border-l-0 phone:[&>*:nth-child(3)]:pl-0">
        {bigNumbers(r.totals).map((b) => (
          <Stat key={b.label} value={b.value} label={b.label} />
        ))}
      </StatGroup>

      {(r.work.topics.length > 0 || r.work.projects.length > 0) && (
        <div>
          <SectionHeading>What you worked on</SectionHeading>
          <ul className="m-0 mt-1 list-none p-0">
            {(r.work.topics.length ? r.work.topics.map((t) => ({ name: t.name, line: t.example, meta: '' })) : r.work.projects.map((p) => ({ name: p.name, line: p.example, meta: p.sessions === 1 ? '1 session' : `${p.sessions} sessions` }))).map((t) => (
              <li key={t.name} className="border-b border-rule py-2.5 last:border-b-0">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 text-[14px] font-[500] text-fg phone:text-[15px]">{t.name}</span>
                  {t.meta && <span className="num shrink-0 text-[13px] text-fg-3">{t.meta}</span>}
                </div>
                {t.line && <p className="m-0 mt-0.5 truncate text-[13px] text-fg-3 phone:text-[14px]">{t.line}</p>}
              </li>
            ))}
          </ul>
          {r.work.topics.length > 0 && r.work.projects.length > 0 && (
            <p className={`mt-3 mb-0 ${TEXT}`}>
              Projects: {r.work.projects.map((p, i) => (
                <span key={p.name}>
                  {i > 0 && ', '}
                  <span className="text-fg">{p.name}</span> <span className="num text-fg-3">{p.sessions}</span>
                </span>
              ))}
              .
            </p>
          )}
          {r.work.newThisPeriod.length > 0 && <p className={`mt-1 mb-0 ${TEXT}`}>New this period: {r.work.newThisPeriod.join(', ')}.</p>}
        </div>
      )}

      {r.rhythm.messages >= 5 && (
        <div>
          <SectionHeading>When you work</SectionHeading>
          <div className="mt-3 overflow-x-auto" role="img" aria-label={`Your messages by weekday and hour, busiest ${r.rhythm.busiestDay?.date ?? ''}`}>
            <div className="grid min-w-[300px] gap-[2px]" style={{ gridTemplateColumns: '30px repeat(24, minmax(0, 1fr))' }}>
              {r.rhythm.heatmap.map((row, d) => (
                <div key={DAYS[d]} className="contents">
                  <span className="pr-1 text-[11px] leading-[14px] text-fg-3">{DAYS[d]}</span>
                  {row.map((v, h) => (
                    <span key={h} title={`${DAYS[d]} ${String(h).padStart(2, '0')}:00, ${v}`} className={`h-[14px] rounded-[2px] ${HEAT[heatLevel(v, max)]}`} />
                  ))}
                </div>
              ))}
              <span />
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="num text-center text-[10px] text-fg-4">
                  {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
                </span>
              ))}
            </div>
          </div>
          <p className={`mt-3 mb-0 ${TEXT}`}>
            {r.rhythm.activeDays} active {r.rhythm.activeDays === 1 ? 'day' : 'days'}, longest streak {r.rhythm.longestStreak} {r.rhythm.longestStreak === 1 ? 'day' : 'days'}
            {r.rhythm.busiestDay && `, busiest ${dayWords(r.rhythm.busiestDay.date)} with ${r.rhythm.busiestDay.count} messages`}. {Math.round(r.rhythm.lateNightShare * 100)}% late at night.
          </p>
          {late && <p className="mt-1 mb-0 text-[14px] leading-[1.5] text-fg phone:text-[15px]">{late}</p>}
        </div>
      )}

      {r.habits.length > 0 && (
        <div>
          <SectionHeading>How you work with AI</SectionHeading>
          <div className="mt-2 grid gap-x-10 md:grid-cols-2">
            {r.habits.map((h) => (
              <div key={h.key} className="border-b border-rule py-3">
                <p className="m-0 text-[14px] font-[550] text-fg phone:text-[15px]">
                  {HABIT_WORDS[h.key]!.title} <span className="font-[400] text-fg-3">{HABIT_WORDS[h.key]!.what.toLowerCase()}</span>
                </p>
                <p className={`m-0 mt-1 ${TEXT}`}>{h.observation}</p>
                {h.example && <p className="m-0 mt-1 text-[13px] leading-[1.45] text-fg-3 phone:text-[14px]">{h.example}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {r.models.models.length > 0 && (
        <div>
          <SectionHeading>Your models and agents</SectionHeading>
          <ul className="m-0 list-none p-0">
            {r.models.models.slice(0, 5).map((m) => (
              <li key={m.name} className="flex items-baseline gap-3 border-b border-rule py-2.5 last:border-b-0">
                <span title={m.name} className="min-w-0 flex-1 truncate text-[13.5px] font-[500] text-fg phone:text-[15px]">
                  {m.name}
                </span>
                <span className="num shrink-0 text-[13px] text-fg-2 phone:text-[14px]">{compact(m.tokens)}</span>
                <span className="num w-16 shrink-0 text-right text-[13px] text-fg-3 phone:text-[14px]">{m.costUsd ? usd(m.costUsd) : 'plan'}</span>
              </li>
            ))}
          </ul>
          <p className={`mt-3 mb-0 ${TEXT}`}>
            {r.models.agents.length > 0 && <>Agents: {r.models.agents.map((a) => `${a.name} ${a.count}`).join(', ')}. </>}
            {r.models.fallbacks > 0 && <>{r.models.fallbacks} fallbacks{r.models.topFallback ? `, most often ${r.models.topFallback}` : ''}. </>}
            {r.models.costPerResult !== undefined && <>About {usd(r.models.costPerResult, { precise: true })} per finished turn over {int(r.models.finishedTurns)} turns.</>}
          </p>
        </div>
      )}

      {funRows.length >= 2 && (
        <div>
          <SectionHeading>Fun stats</SectionHeading>
          <dl className="m-0 mt-1">
            {funRows.map(([k, v]) => (
              <div key={k} className="flex gap-4 border-b border-rule py-2 last:border-b-0 phone:flex-col phone:gap-0.5">
                <dt className="w-[140px] shrink-0 text-[13px] text-fg-3 phone:text-[14px]">{k}</dt>
                <dd className="m-0 min-w-0 text-[14px] text-fg phone:text-[15px]">
                  {k === 'Longest chat' && fun.longestChat ? <Link href={`/chat/${fun.longestChat.sessionId}`} className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg">{v}</Link> : v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {r.suggestions.length > 0 && (
        <div>
          <SectionHeading>Suggestions</SectionHeading>
          <ol className="m-0 mt-2 list-decimal space-y-3 pl-5 marker:text-fg-3">
            {r.suggestions.map((s) => (
              <li key={s.text} className="pl-1">
                <p className="m-0 text-[14px] font-[500] text-fg phone:text-[15px]">{s.text}</p>
                {s.why && <p className="m-0 mt-0.5 text-[13px] text-fg-3 phone:text-[14px]">{s.why}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {r.question && (
        <div>
          <SectionHeading>A question for you</SectionHeading>
          <p className="mt-2 mb-3 max-w-[56ch] text-[17px] leading-[1.4] text-fg phone:text-[17px]">{r.question}</p>
          <Button variant="solid" size="sm" onClick={talk}>
            Talk it through
          </Button>
        </div>
      )}

      {footnote && <p className="m-0 max-w-[70ch] text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">{footnote}</p>}
    </div>
  );
}

/** Quiet hours (the message hours of Settings > Assistant). Conclave has no break nudge yet, so the page says so. */
function Controls() {
  const mobile = useIsMobile();
  const [s, setS] = useState<AssistantSettingsDto>();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api()
      .assistantSettings()
      .then((d) => {
        setS(d);
        setStart(d.prefs.hours.start);
        setEnd(d.prefs.hours.end);
      })
      .catch(() => undefined);
  }, []);
  if (!s) return null;
  const dirty = start !== s.prefs.hours.start || end !== s.prefs.hours.end;
  const save = async () => {
    setBusy(true);
    try {
      setS(await api().setAssistantPrefs({ hours: { start, end } }));
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(false);
  };
  return (
    <Group title="Rest" help="Break reminders are not in Conclave yet. Quiet hours are: outside your message hours, routine messages wait until morning.">
      <SettingRow label="Message hours" help={`Quiet from ${s.prefs.hours.end} to ${s.prefs.hours.start}. The same setting as Settings, Assistant.`} top>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <Input mono inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.trim())} aria-label="Messages from" placeholder="09:00" className="w-[88px]!" size="sm" invalid={!TIME.test(start)} />
          <span className="text-[13px] text-fg-3">to</span>
          <Input mono inputMode="numeric" value={end} onChange={(e) => setEnd(e.target.value.trim())} aria-label="Messages until" placeholder="21:30" className="w-[88px]!" size="sm" invalid={!TIME.test(end)} />
          {dirty && (
            <Button variant="solid" size={mobile ? 'touch' : 'sm'} disabled={!TIME.test(start) || !TIME.test(end)} busy={busy ? 'Saving' : false} onClick={() => void save()}>
              Save
            </Button>
          )}
        </div>
      </SettingRow>
    </Group>
  );
}
