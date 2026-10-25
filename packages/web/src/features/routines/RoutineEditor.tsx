/**
 * Routine editor (spec 11.5): a 720px column of sections with a sticky
 * footer. The schedule field takes words or cron and shows what the hub
 * understood plus the next five runs from previewSchedule as you type.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { Routine, SessionMode } from '@conclave/core/types';
import type { RoutineInput } from '@conclave/core/scheduler/types';
import { api, loadConnection } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { agentByName, attempt, upsertRoutine, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm, inTime } from '@/lib/format';
import { dayStart, describeSchedule } from '@/lib/schedule';
import { modelName } from '@/lib/models';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Segmented, Textarea } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { CodeBlock } from '@/components/ui/Code';
import { TextAction } from '@/components/ui/Section';
import { AgentPicker } from '@/components/pickers/Pickers';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { EditorFooter, EditorSection, FormRow } from './form';
import { SCHEDULE_EXAMPLES, toSchedule } from './scheduleWords';
import { FolderPicker } from './FolderPicker';
import { routineInput, useRoutineActions } from './actions';
import { nextRun, nextWords, otherZone, upcoming } from './words';

export const BLANK_ROUTINE: RoutineInput = { name: '', schedule: '30 7 * * 1-5', prompt: '', agent: 'assistant', mode: 'agent', enabled: true, sessionPolicy: 'new', notify: 'on_error' };

const MODE_OPTIONS: Array<{ value: SessionMode; label: string; help: string }> = [
  { value: 'agent', label: 'Agent', help: 'Uses tools and works until done.' },
  { value: 'chat', label: 'Chat', help: 'Answers without tools.' },
  { value: 'jury', label: 'Jury', help: 'Several models answer and a judge decides.' },
];
const OTHER_MODES: Record<string, string> = { plan: 'Plan', debate: 'Debate', loop: 'Loop' };

const NOTIFY: Array<{ value: Routine['notify']; label: string }> = [
  { value: 'on_error', label: 'On failure' },
  { value: 'on_attention', label: 'On problems' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
];

const NOTIFY_HELP: Record<Routine['notify'], string> = {
  on_error: 'When a run fails.',
  on_attention: 'When a run fails, or its reply starts with STATUS: attention or STATUS: problem.',
  always: 'After every run, with the first lines of the reply.',
  never: 'Runs stay in the history.',
};

/** Rules as typed, one per line; blank lines are kept while editing and dropped on save. */
const ruleLines = (v: string[] | undefined) => (v ?? []).join('\n');
const cleanRules = (v: string[] | undefined) => [...new Set((v ?? []).map((x) => x.trim()).filter(Boolean))];
const numberOrNull = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : (null as unknown as undefined));

const ZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Amsterdam', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

/** Debounced previewSchedule for a hub expression. */
function usePreview(expr: string | undefined, tz: string | undefined) {
  const [state, setState] = useState<{ expr: string; next: number[]; error?: string } | null>(null);
  useEffect(() => {
    if (!expr) {
      setState(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api()
        .previewSchedule(expr, tz)
        .then((r) => live && setState({ expr, ...r }))
        .catch((e: unknown) => live && setState({ expr, next: [], error: e instanceof Error ? e.message : 'The hub could not read that schedule.' }));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [expr, tz]);
  return state;
}

/**
 * The Sessions choices. Post into the Assistant chat is left out for a watch,
 * as save refuses it (core scheduler/routines.ts checkPolicy); a webhook run
 * of a home routine gets its own session on the hub, so the help says so.
 */
export function sessionOptions(d: Pick<RoutineInput, 'watch'>): Array<{ value: Routine['sessionPolicy']; label: string }> {
  return [{ value: 'new', label: 'New each run' }, { value: 'reuse', label: 'Keep one session' }, ...(d.watch ? [] : [{ value: 'home' as const, label: 'Post into the Assistant chat' }])];
}

export const SESSION_HELP: Record<Routine['sessionPolicy'], string> = {
  new: 'Each run starts clean and shows up as its own session.',
  reuse: 'Every run adds to the same session, so it remembers earlier runs.',
  home: 'Each run posts its prompt and answer into your Assistant chat. A webhook run still gets its own session.',
};

export function webhookUrl(r: Routine): string {
  const hub = (loadConnection()?.baseUrl ?? location.origin).replace(/\/+$/, '');
  return `${hub}/api/routines/${r.id}/trigger${r.webhookSecret ? `?secret=${r.webhookSecret}` : ''}`;
}

type Draft = RoutineInput & { scheduleText: string; costText: string };

export function RoutineEditor({ initial, routine, onCancel }: { initial: RoutineInput; routine?: Routine; onCancel?: () => void }) {
  const [, navigate] = useLocation();
  const devices = useHub((s) => s.devices);
  const isNew = !routine;
  const phone = useIsMobile();
  const toDraft = (r: RoutineInput): Draft => ({ ...routineInput(r), scheduleText: scheduleText(r.schedule), costText: r.maxCostUsd ? String(r.maxCostUsd) : '' });
  const [d, setD] = useState<Draft>(() => toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [browse, setBrowse] = useState(false);
  const actions = useRoutineActions(routine ?? ({ id: '', name: d.name, enabled: true } as Routine), { afterDelete: '/routines' });

  // follow outside changes (another client, Pause from the header) while there are no local edits
  const base = JSON.stringify(toDraft(initial));
  const [baseline, setBaseline] = useState(base);
  const dirty = JSON.stringify(d) !== baseline;
  useEffect(() => {
    if (!dirty) {
      setD(toDraft(initial));
      setBaseline(base);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // /routines/x?tab=settings#when opens at that section
  useEffect(() => {
    const el = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    el?.scrollIntoView({ block: 'start' });
  }, []);

  const up = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const parsed = useMemo(() => toSchedule(d.scheduleText), [d.scheduleText]);
  const expr = parsed && 'expr' in parsed ? parsed.expr : undefined;
  const preview = usePreview(expr, d.timezone);
  // cron is worked out here in the routine's zone, so the list matches the routine page; the hub still checks it
  const localNext = useMemo(
    () => (expr && !expr.startsWith('@') && !(preview?.expr === expr && preview.error) ? upcoming({ id: '', name: '', agent: '', mode: 'agent', prompt: '', enabled: true, sessionPolicy: 'new', notify: 'never', createdAt: 0, updatedAt: 0, schedule: expr, timezone: d.timezone }) : undefined),
    [expr, d.timezone, preview],
  );
  const scheduleError = !parsed ? 'Add a schedule.' : 'error' in parsed ? parsed.error : preview?.expr === expr ? preview?.error : undefined;

  const agent = agentByName(d.agent);
  const agentModel = agent?.model;
  const runDevice = d.device ?? agent?.device ?? 'local';

  const missing = [!d.name.trim() && 'a name', !d.prompt.trim() && 'a prompt'].filter(Boolean) as string[];
  const blocked = missing.length > 0 || !!scheduleError;

  const save = async () => {
    setTried(true);
    // ⌘S again while a save runs would create a second routine
    if (blocked || !expr || saving) return;
    setSaving(true);
    // cleared fields go as "" or null so the hub drops them on update
    const input = routineInput({
      ...d,
      name: d.name.trim(),
      schedule: expr,
      allow: cleanRules(d.allow),
      deny: cleanRules(d.deny),
      precheck: d.precheck?.trim() ?? '',
      timeoutMin: numberOrNull(d.timeoutMin),
      maxCostUsd: numberOrNull(Number(d.costText)),
    });
    const r = routine ? await attempt(() => api().updateRoutine(routine.id, input)) : await attempt(() => api().createRoutine(input), `Created ${input.name}.`);
    setSaving(false);
    if (!r) return;
    upsertRoutine(r);
    const next = toDraft(r);
    setD(next);
    setBaseline(JSON.stringify(next));
    setTried(false);
    if (isNew) navigate(`/routines/${r.id}`, { replace: true });
  };

  const modeOptions = MODE_OPTIONS.map((m) => ({ value: m.value, label: m.label }));
  if (d.mode && OTHER_MODES[d.mode]) modeOptions.push({ value: d.mode, label: OTHER_MODES[d.mode] });

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([zone, ...ZONES, ...(d.timezone ? [d.timezone] : [])])];

  const note = saving
    ? 'Saving'
    : tried && blocked
      ? missing.length
        ? `Add ${missing.join(' and ')} to save.`
        : 'Fix the schedule to save.'
      : dirty
        ? 'Unsaved changes.'
        : routine
          ? routine.enabled && nextRun(routine) ? `Saved. Next run ${nextWords(nextRun(routine))}${otherZone(routine.timezone) ? ' your time' : ''}.` : 'Saved. Paused, so nothing is scheduled.'
          : '';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          void save();
        }
      }}
      className="space-y-9 phone:space-y-8"
    >
      <EditorSection title="What" id="what">
        <FormRow label="Name" htmlFor="rt-name" error={tried && !d.name.trim() ? 'Give it a name you will recognise in notifications.' : undefined}>
          <Input id="rt-name" value={d.name} onChange={(e) => up({ name: e.target.value })} placeholder="Server watchdog" autoFocus={isNew && !d.name} invalid={tried && !d.name.trim()} />
        </FormRow>
        <FormRow label="Prompt" help="Sent as the first message of every run. Say when it should bother you." htmlFor="rt-prompt" stack error={tried && !d.prompt.trim() ? 'Write what the routine should do.' : undefined}>
          <Textarea
            id="rt-prompt"
            prose
            minRows={4}
            maxRows={14}
            value={d.prompt}
            onChange={(e) => up({ prompt: e.target.value })}
            placeholder="Check that every container answers on its health URL. Only notify on a failure."
            invalid={tried && !d.prompt.trim()}
          />
        </FormRow>
        <FormRow label="Mode" help={MODE_OPTIONS.find((m) => m.value === d.mode)?.help}>
          <Segmented label="Mode" value={d.mode ?? 'agent'} onChange={(v) => up({ mode: v })} options={modeOptions} />
        </FormRow>
        <FormRow label="Sessions" help={SESSION_HELP[d.sessionPolicy ?? 'new']}>
          <Segmented label="Sessions" value={d.sessionPolicy ?? 'new'} onChange={(v) => up({ sessionPolicy: v })} options={sessionOptions({ watch: d.watch ?? routine?.watch })} />
        </FormRow>
      </EditorSection>

      <EditorSection title="When" id="when">
        <FormRow
          label="Schedule"
          htmlFor="rt-schedule"
          stack
          help={
            <>
              Words or cron. Try{' '}
              {SCHEDULE_EXAMPLES.map((x, i) => (
                <span key={x}>
                  <button type="button" className="link" onClick={() => up({ scheduleText: x })}>
                    {x}
                  </button>
                  {i < SCHEDULE_EXAMPLES.length - 2 ? ', ' : i === SCHEDULE_EXAMPLES.length - 2 ? ' or ' : '.'}
                </span>
              ))}
            </>
          }
        >
          <Input
            id="rt-schedule"
            size="lg"
            value={d.scheduleText}
            onChange={(e) => up({ scheduleText: e.target.value })}
            spellCheck={false}
            autoComplete="off"
            invalid={!!scheduleError && (tried || !!d.scheduleText.trim())}
            aria-describedby="rt-schedule-read"
          />
          <SchedulePreview
            id="rt-schedule-read"
            expr={expr}
            typed={d.scheduleText}
            fromWords={!!parsed && 'expr' in parsed && parsed.fromWords}
            error={d.scheduleText.trim() || tried ? scheduleError : undefined}
            next={localNext ?? (preview && preview.expr === expr ? preview.next : undefined)}
            timezone={d.timezone}
          />
        </FormRow>
        <FormRow label="Time zone" help="Schedules follow this zone, so 07:30 stays 07:30 when you travel.">
          <SelectMenu
            label="Time zone"
            value={d.timezone ?? ''}
            onChange={(v) => up({ timezone: v || undefined })}
            options={[{ value: '', label: "The hub's zone", text: "The hub's zone" }, ...zones.map((z) => ({ value: z, label: z, hint: z === zone ? 'this device' : undefined }))]}
          />
        </FormRow>
        <FormRow label="Active" help="Paused routines keep their history and do not run.">
          <OnOff label="Active" checked={d.enabled !== false} onChange={(v) => up({ enabled: v })} onLabel="Active" offLabel="Paused" />
        </FormRow>
      </EditorSection>

      <EditorSection title="Who and where" id="who">
        <FormRow label="Agent" help={agent?.description}>
          <AgentPicker look="field" value={d.agent} onChange={(v) => up({ agent: v })} includeHidden />
        </FormRow>
        <FormRow
          label="Model"
          help={
            d.model ? (
              <>
                Overrides the agent's model. <TextAction label="Use the agent's" onClick={() => up({ model: undefined })} className="link text-[12px]" />
              </>
            ) : agentModel ? (
              `Uses ${d.agent}'s model.`
            ) : (
              'Uses the default model.'
            )
          }
        >
          <ModelPicker look="field" value={d.model} onChange={(v) => up({ model: v })} placeholder={agentModel ? `Agent default, ${modelName(agentModel)}` : 'Default model'} />
        </FormRow>
        <FormRow label="Device" help="Where its tools run.">
          <SelectMenu
            label="Device"
            value={d.device ?? ''}
            onChange={(v) => up({ device: v || undefined })}
            options={[
              { value: '', label: agent?.device ? `Agent default, ${devices[agent.device]?.name ?? agent.device}` : 'Agent default', text: agent?.device ? `Agent default, ${devices[agent.device]?.name ?? agent.device}` : 'Agent default' },
              ...Object.values(devices).map((x) => ({
                value: x.id,
                label: x.name,
                text: x.name,
                hint: <span className={x.online ? 'text-ok' : 'text-fg-3'}>{x.online ? 'online' : 'offline'}</span>,
              })),
            ]}
          />
        </FormRow>
        <FormRow label="Folder" help="The working folder on that device. Empty means home." htmlFor="rt-folder">
          <div className="flex gap-2">
            <Input id="rt-folder" mono value={d.cwd ?? ''} onChange={(e) => up({ cwd: e.target.value || undefined })} placeholder="~" className="min-w-0 flex-1" spellCheck={false} />
            <Button variant="outline" size="md" className="h-[34px] phone:h-11" onClick={() => setBrowse(true)}>
              Browse
            </Button>
          </div>
        </FormRow>
      </EditorSection>

      <EditorSection title="After a run" id="after">
        <FormRow
          label="Notify"
          help={
            <>
              Through the channels in{' '}
              <Link href="/settings/notifications" className="link">
                Notifications
              </Link>
              .
            </>
          }
        >
          <Segmented label="Notify" value={d.notify ?? 'on_error'} onChange={(v) => up({ notify: v })} options={NOTIFY} />
          <p className="mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">{NOTIFY_HELP[d.notify ?? 'on_error']}</p>
        </FormRow>
      </EditorSection>

      <EditorSection title="While you are away" id="away">
        <FormRow
          label="Needs approval"
          help={d.onApproval === 'wait' ? 'A scheduled run waits until you approve or deny the call. Later runs are skipped while it waits.' : 'A scheduled run refuses the call, lists it on the run and goes on. Run now still asks you.'}
        >
          <Segmented
            label="Needs approval"
            value={d.onApproval ?? 'deny'}
            onChange={(v) => up({ onApproval: v })}
            options={[
              { value: 'deny', label: 'Refuse and go on' },
              { value: 'wait', label: 'Wait for me' },
            ]}
          />
        </FormRow>
        <FormRow label="Allowed without asking" help="One rule per line, in Claude Code syntax: Bash(git log:*), mcp__basic-memory__edit_note. Only this routine's sessions get them." htmlFor="rt-allow" stack>
          <Textarea id="rt-allow" mono minRows={2} maxRows={10} value={ruleLines(d.allow)} onChange={(e) => up({ allow: e.target.value.split('\n') })} placeholder="Bash(zpool status -x)" spellCheck={false} />
        </FormRow>
        <FormRow label="Never allowed" help="Refused even when another rule allows them." htmlFor="rt-deny" stack>
          <Textarea id="rt-deny" mono minRows={1} maxRows={8} value={ruleLines(d.deny)} onChange={(e) => up({ deny: e.target.value.split('\n') })} placeholder="Bash(zpool scrub:*)" spellCheck={false} />
        </FormRow>
        <FormRow label="Before it runs" help="A command run on the device first, 30 seconds at most. When it prints nothing, or the same as last time, the run is skipped without calling the model. Run now skips it." htmlFor="rt-precheck" stack>
          <Input id="rt-precheck" mono value={d.precheck ?? ''} onChange={(e) => up({ precheck: e.target.value })} placeholder="git -C ~/code/conclave log -1 --format=%h" spellCheck={false} />
        </FormRow>
        <FormRow label="Limits" help="The run stops when it takes longer or costs more. Empty means no limit.">
          <div className="flex flex-wrap gap-2">
            {/* the field fills its box, so the box sets the width */}
            <div className="w-[140px]">
              <Input aria-label="Timeout in minutes" inputMode="numeric" suffix="min" value={d.timeoutMin ?? ''} onChange={(e) => up({ timeoutMin: Number(e.target.value.replace(/\D/g, '')) || undefined })} placeholder="No limit" />
            </div>
            <div className="w-[140px]">
              <Input aria-label="Cost limit in dollars" inputMode="decimal" prefix="$" value={d.costText} onChange={(e) => up({ costText: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="No limit" />
            </div>
          </div>
        </FormRow>
      </EditorSection>

      {routine && (
        <EditorSection title="Webhook" id="webhook">
          <FormRow label="Run it from anywhere" help="A POST to this address runs the routine now. The request body is added to the prompt." stack>
            <CodeBlock code={`curl -X POST '${webhookUrl(routine)}'`} shell wrap title="Shell" />
          </FormRow>
        </EditorSection>
      )}

      {routine && (
        <EditorSection title="Delete" id="danger">
          <FormRow label="Delete this routine" help="It stops running. The sessions it started stay.">
            <div className="flex justify-end phone:justify-start">
              <Button variant="danger" onClick={actions.askDelete}>
                Delete routine
              </Button>
            </div>
          </FormRow>
        </EditorSection>
      )}

      <EditorFooter note={<span className={cn(tried && blocked && 'text-fault')}>{note}</span>}>
        <Button
          variant="quiet"
          size={phone ? 'touch' : 'md'}
          onClick={() => {
            if (onCancel && (!dirty || isNew)) return onCancel();
            setD(JSON.parse(baseline) as Draft);
            setTried(false);
          }}
        >
          {dirty && !isNew ? 'Discard changes' : 'Cancel'}
        </Button>
        <Button type="submit" variant="solid" size={phone ? 'touch' : 'md'} busy={saving ? 'Saving' : false} disabled={!dirty && !isNew}>
          {isNew ? 'Create routine' : 'Save'}
        </Button>
      </EditorFooter>

      <FolderPicker open={browse} onClose={() => setBrowse(false)} device={runDevice} value={d.cwd} onPick={(p) => up({ cwd: p })} />
      {actions.dialogs}
    </form>
  );
}

/** What the hub understood, and the next five runs. */
function SchedulePreview({ id, expr, typed, fromWords, error, next, timezone }: { id: string; expr?: string; typed: string; fromWords: boolean; error?: string; next?: number[]; timezone?: string }) {
  if (error)
    return (
      <p id={id} className="text-[13px] leading-[1.45] text-fault phone:text-[14px]" role="status">
        {error}
      </p>
    );
  if (!expr) return null;
  const words = describeSchedule(expr);
  return (
    <div id={id} role="status" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-x-6 gap-y-4 pt-1 phone:grid-cols-1">
      <div className="min-w-0">
        {words.toLowerCase() !== typed.trim().toLowerCase() && (
          <p className="text-[14px] text-fg phone:text-[15px]">
            {words}
            {timezone && <span className="text-fg-3">, {timezone}</span>}
          </p>
        )}
        {fromWords && words !== expr && (
          <p className="mt-1 text-[12px] text-fg-3 first:mt-0 phone:text-[13px]">
            Saved as <span className="mono text-fg-2">{expr}</span>
            {timezone && words.toLowerCase() === typed.trim().toLowerCase() && `, ${timezone}`}
          </p>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-[12px] text-fg-3 phone:text-[13px]">Next runs</p>
        {next === undefined ? (
          <p className="mt-1 text-[13px] text-fg-3">Asking the hub</p>
        ) : next.length === 0 ? (
          <p className="mt-1 text-[13px] text-fg-3">No more runs. A one time schedule in the past never runs.</p>
        ) : (
          <ol className="mt-1">
            {next.slice(0, 5).map((t) => (
              <li key={t} className="grid grid-cols-[88px_48px_minmax(0,1fr)] items-baseline gap-x-2 py-[3px] text-[13px] phone:text-[14px]">
                <span className="text-fg-2">{dayDate(t)}</span>
                <span className="font-mono text-[12.5px] font-normal text-fg">{hhmm(t)}</span>
                <span className="num text-right text-[12px] text-fg-3">{inTime(t)}</span>
              </li>
            ))}
          </ol>
        )}
        {timezone && timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone && <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">Times shown in this device's zone, {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>}
      </div>
    </div>
  );
}

/** "Today", "Tomorrow", "Mon 19 Oct" */
export function dayDate(ts: number, now = Date.now()): string {
  const start = dayStart(now);
  if (ts >= start && ts < start + 86_400_000) return 'Today';
  if (ts >= start + 86_400_000 && ts < start + 2 * 86_400_000) return 'Tomorrow';
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;
}

/** Show a schedule as words in the field when the words read back to the same expression. */
function scheduleText(expr: string): string {
  const words = describeSchedule(expr);
  const back = toSchedule(words);
  return back && 'expr' in back && back.expr === expr ? words : expr;
}
