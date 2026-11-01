/**
 * Step 9, Starter routines (spec 11.11): three suggested routines for the
 * owner's machines first (ECOSYSTEM.md 5.2; Add opens the same sheet as the
 * Routines tab), then each template as a sentence with its time editable in
 * place. Add creates the routine at once; Undo deletes it again.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { Routine } from '@conclave/core/types';
import type { RoutineInput } from '@conclave/core/scheduler/types';
import { api } from '@/lib/api';
import { describeSchedule, parseCron } from '@/lib/schedule';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { removeKey, toast, upsertRoutine, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { StepFrame } from '../StepLayout';
import { errText, LINK, useCtlSize } from '../parts';
import { SuggestedSection } from '@/features/routines/Suggested';
import { AddSuggestionSheet } from '@/features/routines/AddSuggestion';

type Template = RoutineInput & { id: string; description: string };

/** The rest of the sentence after the schedule, for the starter set. */
const SENTENCE: Record<string, string> = {
  tpl_librarian: 'the librarian files notes and merges duplicates.',
  tpl_brief: 'a morning brief with deadlines and failed jobs, sent to your phone.',
  tpl_watchdog: 'a server watchdog checks your containers.',
  tpl_deadlines: 'uni deadlines from Moodle and course calendars.',
  tpl_backup: 'a backup check verifies the latest Proxmox Backup Server snapshots.',
  tpl_ctf: 'a reminder to write up the CTF challenges you solved.',
};

const NOTIFY: Record<string, string> = { always: 'notifies you each run', on_error: 'notifies you on a failure', never: 'never notifies' };

const pad = (n: number) => String(n).padStart(2, '0');

/** "30 7 * * 1-5" -> "07:30" when the schedule runs at one fixed time. */
function timeOf(schedule: string): string | undefined {
  const c = parseCron(schedule);
  if (!c || !/^\d+$/.test(c.raw[0]) || !/^\d+$/.test(c.raw[1])) return undefined;
  return `${pad(Number(c.raw[1]))}:${pad(Number(c.raw[0]))}`;
}

function withTime(schedule: string, hhmm: string): string | undefined {
  const m = hhmm.trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  const f = schedule.trim().split(/\s+/);
  return [String(min), String(h), ...f.slice(2)].join(' ');
}

/** The schedule words with the time as an inline input: "Weekdays at [07:30]". */
function When({ schedule, time, onTime, disabled, label }: { schedule: string; time?: string; onTime: (t: string) => void; disabled?: boolean; label: string }) {
  const words = describeSchedule(schedule);
  const cur = timeOf(schedule);
  if (!cur) return <>{words}</>;
  const lead = words.replace(/ at \d{2}:\d{2}$/, '').replace(/^Daily$/, 'Every day');
  const bad = time !== undefined && !withTime(schedule, time);
  if (disabled)
    return (
      <>
        {lead === 'Daily' ? 'Every day' : lead} at <span className="font-mono text-[0.93em] tracking-[-0.01em]">{cur}</span>
      </>
    );
  return (
    <>
      {lead === 'Daily' ? 'Every day' : lead} at{' '}
      <input
        value={time ?? cur}
        onChange={(e) => onTime(e.target.value)}
        disabled={disabled}
        aria-label={`${label} time`}
        aria-invalid={bad || undefined}
        inputMode="numeric"
        maxLength={5}
        className={cn(
          'mx-0.5 h-[26px] w-[58px] rounded-[var(--r-1)] border bg-sunk px-1.5 text-center align-[1px] font-mono text-[13px] text-fg tracking-[-0.01em] focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)] focus:outline-none disabled:border-transparent disabled:bg-transparent disabled:px-0 disabled:text-fg phone:h-9 phone:w-[68px] phone:text-[16px]',
          bad ? 'border-fault' : 'border-edge',
        )}
      />
    </>
  );
}

function TemplateRow({ t, added, mine, onAdd, onUndo }: { t: Template; added?: Routine; mine: boolean; onAdd: (schedule: string) => Promise<void>; onUndo: () => Promise<void> }) {
  const mobile = useIsMobile();
  const ctl = useCtlSize('sm');
  const [time, setTime] = useState<string>();
  const [busy, setBusy] = useState(false);
  const schedule = added?.schedule ?? (time !== undefined ? (withTime(t.schedule, time) ?? t.schedule) : t.schedule);
  const bad = time !== undefined && !withTime(t.schedule, time) && !added;
  const tail = SENTENCE[t.id];
  const sentence: ReactNode = tail ? (
    <>
      <When schedule={added?.schedule ?? t.schedule} time={added ? undefined : time} onTime={setTime} disabled={!!added} label={t.name} />, {tail}
    </>
  ) : (
    <>
      <When schedule={added?.schedule ?? t.schedule} time={added ? undefined : time} onTime={setTime} disabled={!!added} label={t.name} />, {t.name.toLowerCase()}. {t.description}
    </>
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const action = added ? (
    mine ? (
      <span className="flex items-center gap-1">
        <span className="state-word text-[13px] text-ok phone:text-[14px]">Added</span>
        <Button variant="quiet" size={ctl} onClick={() => void run(onUndo)} busy={busy ? 'Undoing' : false}>
          Undo
        </Button>
      </span>
    ) : (
      // a routine that was there before this step: never offer to delete it from here
      <span className="text-[13px] text-fg-3 phone:text-[14px]">Already on the hub</span>
    )
  ) : (
    <Button variant="outline" size={ctl} onClick={() => void run(() => onAdd(schedule))} disabled={bad} busy={busy ? 'Adding' : false}>
      Add
    </Button>
  );

  return (
    <div className={cn('flex gap-x-6 gap-y-2.5 py-4', mobile ? 'flex-col' : 'items-center')}>
      <div className="min-w-0 flex-1">
        <p className={cn('m-0 text-[15px] leading-[1.75] phone:text-[16px]', added ? 'text-fg' : 'text-fg')}>{sentence}</p>
        <p className="m-0 mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
          {t.name}, runs as {t.agent ?? 'assistant'}, {NOTIFY[t.notify ?? 'always'] ?? 'notifies you'}
          {bad && <span className="text-fault">. Use a time like 07:30</span>}
        </p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

export function RoutinesStep() {
  const routines = useHub((s) => s.routines);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  const [suggest, setSuggest] = useState<string | null>(null);
  /** template id -> the routine it made */
  const [made, setMade] = useState<Record<string, string>>({});

  useEffect(() => {
    api()
      .routineTemplates()
      .then(setTemplates)
      .catch((e) => setError(errText(e)));
  }, []);

  // routines already on the hub with a template's name count as added (setup run again)
  const addedFor = (t: Template): Routine | undefined => {
    const id = made[t.id];
    if (id) return routines[id];
    return Object.values(routines).find((r) => r.name === t.name);
  };

  const add = async (t: Template, schedule: string) => {
    try {
      const { id: _id, description: _d, ...input } = t;
      const r = await api().createRoutine({ ...input, schedule, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      upsertRoutine(r);
      setMade((m) => ({ ...m, [t.id]: r.id }));
    } catch (e) {
      toast({ title: `Could not add ${t.name}. ${errText(e)}`, level: 'error' });
    }
  };
  const undo = async (t: Template) => {
    const r = made[t.id] ? routines[made[t.id]] : undefined;
    if (!r) return;
    try {
      await api().deleteRoutine(r.id);
      removeKey('routines', r.id);
      setMade((m) => {
        const next = { ...m };
        delete next[t.id];
        return next;
      });
    } catch (e) {
      toast({ title: `Could not remove ${t.name}. ${errText(e)}`, level: 'error' });
    }
  };

  const first = templates?.slice(0, 4) ?? [];
  const rest = templates?.slice(4) ?? [];
  const count = Object.values(routines).length;
  const summary = count ? `${count} ${count === 1 ? 'routine' : 'routines'} on the hub.` : 'None added yet.';

  return (
    <StepFrame summary={summary}>
      <SuggestedSection limit={3} heading="Suggested for your machines" onAdd={setSuggest} className="mb-10" />
      <AddSuggestionSheet id={suggest} onClose={() => setSuggest(null)} />
      {error && <p className="m-0 text-[13px] text-fault">Could not load the templates. {error}</p>}
      {templates && (
        <section>
          <SectionHeading count={templates.length}>Templates</SectionHeading>
          <div className="rows">
            {(more ? templates : first).map((t) => (
              <TemplateRow key={t.id} t={t} added={addedFor(t)} mine={!!made[t.id]} onAdd={(s) => add(t, s)} onUndo={() => undo(t)} />
            ))}
          </div>
          {!more && rest.length > 0 && (
            <div className="border-t border-rule pt-3">
              <TextAction className={LINK} label={`${rest.length} more: ${rest.map((t) => t.name).join(', ')}`} onClick={() => setMore(true)} />
            </div>
          )}
          <p className="m-0 mt-8 max-w-[60ch] text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Each one starts with the default model and can be edited, paused or run now from Routines. Times are in this device&apos;s time zone.</p>
        </section>
      )}
    </StepFrame>
  );
}
