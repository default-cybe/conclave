/**
 * Settings > Assistant (docs/design/ROUND-LIFE-ASSISTANT.md 6): proactive
 * preferences (what to tell you, what never, how), message hours and quiet
 * hours, the heartbeat with its checklist, and the nightly reflection. The
 * preferences are one profile memory the assistant always sees; the
 * checklist is a memory note the assistant can edit too.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { AssistantRoutineDto, AssistantSettingsDto, ProactiveHow } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { hhmm } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Segmented, Textarea } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { errText, Group, Outcome, SettingRow, agoWords } from './parts';
import { toast } from '@/store/store';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const lines = (s: string) => s.split('\n').map((x) => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean);

export function AssistantSection() {
  const [s, setS] = useState<AssistantSettingsDto>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api()
      .assistantSettings()
      .then(setS)
      .catch((e) => setError(errText(e)));
  }, []);
  if (error) return <p className="text-[13px] text-fault">Could not load the assistant settings. {error}</p>;
  if (!s) return <LoadingRows loading rows={6} />;
  return <Body s={s} onChange={setS} />;
}

function Body({ s, onChange }: { s: AssistantSettingsDto; onChange: (s: AssistantSettingsDto) => void }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [tell, setTell] = useState(s.prefs.tell.join('\n'));
  const [never, setNever] = useState(s.prefs.never.join('\n'));
  const [start, setStart] = useState(s.prefs.hours.start);
  const [end, setEnd] = useState(s.prefs.hours.end);
  const [zone, setZone] = useState(s.prefs.timezone ?? '');
  const [checklist, setChecklist] = useState(s.heartbeat.checklist ?? '');
  const [busy, setBusy] = useState<string>();

  const call = async (key: string, fn: () => Promise<AssistantSettingsDto>): Promise<AssistantSettingsDto | undefined> => {
    setBusy(key);
    let out: AssistantSettingsDto | undefined;
    try {
      out = await fn();
      onChange(out);
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
    return out;
  };
  // the hub tidies what it saves (a trailing full stop, repeats, secrets), so show what it kept
  const saveLists = async () => {
    const out = await call('lists', () => api().setAssistantPrefs({ tell: lines(tell), never: lines(never) }));
    if (out) {
      setTell(out.prefs.tell.join('\n'));
      setNever(out.prefs.never.join('\n'));
    }
  };
  const saveChecklist = async () => {
    const out = await call('check', () => api().setHeartbeat({ checklist }));
    if (out) setChecklist(out.heartbeat.checklist ?? '');
  };

  const listsDirty = tell !== s.prefs.tell.join('\n') || never !== s.prefs.never.join('\n');
  const hoursDirty = start !== s.prefs.hours.start || end !== s.prefs.hours.end;
  const zoneDirty = zone.trim() !== (s.prefs.timezone ?? '');
  const checklistDirty = checklist !== (s.heartbeat.checklist ?? '');
  const zoneWhere = s.timezone.source === 'set' ? 'set here' : s.timezone.source === 'profile' ? 'from profile memory' : "the hub's own";

  return (
    <div className="space-y-9">
      <Group title="What reaches you" help="The assistant reads these on every turn, and routines use them to decide what is worth a message. You can also tell it in chat, such as stop telling me about sports.">
        <SettingRow label="Tell me about" help="One per line. Worth a message without asking." stack>
          <Textarea value={tell} onChange={(e) => setTell(e.target.value)} minRows={3} maxRows={8} placeholder={'uni deadlines within 3 days\nhomelab outages and failed backups'} aria-label="Tell me about" />
        </SettingRow>
        <SettingRow label="Never tell me about" help="One per line. Never brought up on its own." stack>
          <Textarea value={never} onChange={(e) => setNever(e.target.value)} minRows={2} maxRows={6} placeholder="sports" aria-label="Never tell me about" />
        </SettingRow>
        <div className="flex items-center gap-3 py-3.5">
          <Button variant="solid" size={size} disabled={!listsDirty} busy={busy === 'lists' ? 'Saving' : false} onClick={() => void saveLists()}>
            Save
          </Button>
          {listsDirty && <span className="text-[12px] text-fg-3 phone:text-[13px]">Not saved yet</span>}
        </div>
        <SettingRow label="How" help="How a message the assistant sends on its own reads.">
          <Segmented<ProactiveHow>
            label="How"
            size={mobile ? 'touch' : 'sm'}
            value={s.prefs.how}
            onChange={(v) => void call('how', () => api().setAssistantPrefs({ how: v }))}
            options={[
              { value: 'line', label: 'One line' },
              { value: 'list', label: 'Short list' },
              { value: 'page', label: 'Full page' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group title="When">
        <SettingRow label="Message hours" help="Outside them are your quiet hours: routine messages wait and go out when the hours start. Approvals, questions and failures always go out." top>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Input mono inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.trim())} aria-label="Messages from" placeholder="09:00" className="w-[88px]!" size="sm" invalid={!HHMM.test(start)} />
            <span className="text-[13px] text-fg-3">to</span>
            <Input mono inputMode="numeric" value={end} onChange={(e) => setEnd(e.target.value.trim())} aria-label="Messages until" placeholder="21:30" className="w-[88px]!" size="sm" invalid={!HHMM.test(end)} />
            {hoursDirty && (
              <Button variant="solid" size={size} disabled={!HHMM.test(start) || !HHMM.test(end)} busy={busy === 'hours' ? 'Saving' : false} onClick={() => void call('hours', () => api().setAssistantPrefs({ hours: { start, end } }))}>
                Save
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Timezone" help={`${s.timezone.zone}, ${zoneWhere}. Set it here when that is wrong.`} top>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Input mono value={zone} onChange={(e) => setZone(e.target.value)} placeholder={s.timezone.zone} aria-label="Timezone" className="w-[200px]!" size="sm" spellCheck={false} />
            {zoneDirty && (
              <Button variant="solid" size={size} busy={busy === 'zone' ? 'Saving' : false} onClick={() => void call('zone', () => api().setAssistantPrefs({ timezone: zone.trim() }))}>
                {zone.trim() ? 'Save' : 'Clear'}
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Right now">
          {s.quiet.now ? (
            <Outcome word="Quiet hours" tone="dim">
              until {s.quiet.until ? hhmm(s.quiet.until) : s.prefs.hours.start}
              {s.waiting ? `, ${s.waiting} ${s.waiting === 1 ? 'message waits' : 'messages wait'}` : ''}
            </Outcome>
          ) : (
            <Outcome word="Messages go out" tone="ok">
              until {s.prefs.hours.end}
            </Outcome>
          )}
        </SettingRow>
      </Group>

      <Group title="Heartbeat" help="A poll, not a live watch: every 30 minutes inside your message hours. The hub looks at your tasks, goals and this checklist first and wakes the model only when something changed, and at least once a day. Runs on the small model.">
        <SettingRow label="Heartbeat" help="Messages you only when something passes your preferences. Otherwise it stays silent.">
          <OnOff label="Heartbeat" size={size} checked={s.heartbeat.enabled} disabled={busy === 'hb'} onChange={(v) => void call('hb', () => api().setHeartbeat({ enabled: v }))} />
        </SettingRow>
        <SettingRow label="Checklist" help="One check per line. It is a note in memory, so the assistant can change it when you ask." stack>
          <Textarea mono value={checklist} onChange={(e) => setChecklist(e.target.value)} minRows={4} maxRows={12} aria-label="Heartbeat checklist" />
          {checklistDirty && (
            <div className="mt-2">
              <Button variant="solid" size={size} busy={busy === 'check' ? 'Saving' : false} onClick={() => void saveChecklist()}>
                Save checklist
              </Button>
            </div>
          )}
        </SettingRow>
        <RunRow r={s.heartbeat} label="Last check" />
      </Group>

      <Group title="Nightly reflection" help="At 02:40 it reads the day's chats for what worked and what bothered you, and keeps at most 3 notes on how to work with you, retiring the ones they replace. It never takes a note from an email, a web page or a tool result. Skipped on days without chats.">
        <SettingRow
          label="Nightly reflection"
          help={
            <>
              Notes go to memory for the assistant only. Read, edit or delete them, set the time and model, or reflect now in{' '}
              <Link href="/settings/reflect" className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                Reflect
              </Link>
              .
            </>
          }
        >
          <OnOff label="Nightly reflection" size={size} checked={s.reflection.enabled} disabled={busy === 'rf'} onChange={(v) => void call('rf', () => api().setReflection({ enabled: v }))} />
        </SettingRow>
        <RunRow r={s.reflection} label="Last run" />
      </Group>
    </div>
  );
}

/** What the routine last did, from its run history, and a link to it. */
function RunRow({ r, label }: { r: AssistantRoutineDto; label: string }) {
  const run = r.lastRun;
  const what = !run
    ? r.routineId
      ? 'Has not run yet.'
      : 'Off. Turning it on adds the routine.'
    : run.status === 'skipped'
      ? `${agoWords(run.startedAt)}, skipped: ${(run.error ?? 'nothing new').replace(/\.$/, '').toLowerCase()}.`
      : run.status === 'error'
        ? `${agoWords(run.startedAt)}, failed: ${run.error ?? 'error'}`
        : run.status === 'running'
          ? 'Running now.'
          : `${agoWords(run.startedAt)}, ${run.outcome === 'attention' ? 'sent you a message' : 'ok'}.`;
  const today = r.today.ran + r.today.skipped ? ` Today ${r.today.ran} ran, ${r.today.skipped} skipped.` : '';
  return (
    <SettingRow
      label={label}
      help={
        <>
          {what}
          {today}
          {r.enabled && r.nextRunAt ? ` Next ${hhmm(r.nextRunAt)}.` : ''}
        </>
      }
    >
      {r.routineId && (
        <Link href={`/routines/${r.routineId}`} className="text-[13px] text-fg-3 underline decoration-rule-2 underline-offset-[3px] hover:text-fg phone:text-[14px]">
          Open routine
        </Link>
      )}
    </SettingRow>
  );
}
