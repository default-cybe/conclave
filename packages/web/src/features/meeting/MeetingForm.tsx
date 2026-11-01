/**
 * The new and edit form of docs/design/MEETING-MODE.md 11.3: a 560px dialog
 * on a computer, a full-screen page on a phone. "Start now" is the same form
 * without the date fields; its button prepares the meeting and opens the
 * overlay. SteeringFields is shared with the meeting page's Steering tab.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ApiError } from '@conclave/core/client';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, OnOff, Segmented, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Dialog, Popover } from '@/components/ui/Overlay';
import { PickerButton, SelectMenu } from '@/components/ui/Select';
import { api } from '@/lib/api';
import { folderName, relTime } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { toast, useHub } from '@/store/store';
import { AttachmentStrip } from '@/features/conversation/ComposerParts';
import type { AnswerLength, AnswerModelChoice, Meeting, MeetingCalendarEvent, MeetingFile, MeetingFolder, ReminderMin, SteeringPreset } from '@/overlay/wire';
import { meetings, openOverlay, uploadMeetingFiles } from './api';
import { dayBounds, fromInputs, hm, toInputs, when, zoneLabel } from './time';

const MIN = 60_000;
const TITLE_MAX = 200;
const AGENDA_MAX = 4000;
const STEERING_MAX = 4000;
const DURATIONS = ['', '15', '30', '45', '60', '90', '120'] as const;
const REMINDERS: [ReminderMin, string][] = [
  [1440, '1 day before'],
  [60, '1 hour before'],
  [15, '15 minutes before'],
];

/** The owner's zone (prefs.timezone), read once; the browser's until it answers. */
let zoneOnce: Promise<string> | undefined;
export function useOwnerZone(): string {
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  useEffect(() => {
    zoneOnce ??= api()
      .assistantSettings()
      .then((s) => s.timezone.zone)
      .catch(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    let live = true;
    void zoneOnce.then((z) => live && setZone(z));
    return () => {
      live = false;
    };
  }, []);
  return zone;
}

let presetsOnce: Promise<SteeringPreset[]> | undefined;
function usePresets(): SteeringPreset[] {
  const [p, setP] = useState<SteeringPreset[]>([]);
  useEffect(() => {
    presetsOnce ??= meetings().presets().catch(() => []);
    void presetsOnce.then(setP);
  }, []);
  return p;
}

let modelsOnce: Promise<AnswerModelChoice[]> | undefined;
function useAnswerModels(): AnswerModelChoice[] | undefined {
  const [list, setList] = useState<AnswerModelChoice[]>();
  useEffect(() => {
    modelsOnce ??= meetings()
      .models()
      .catch(() => {
        modelsOnce = undefined;
        return [];
      });
    void modelsOnce.then(setList);
  }, []);
  return list;
}

const SPEED: Record<AnswerModelChoice['speed'], string> = { fastest: 'Fastest', fast: 'Fast', balanced: 'Balanced', best: 'Best, slow' };

/** The menu's options: the hub default first, then the hub's list (fastest first). A saved ref the list lacks still shows. */
export function modelOptions(list: AnswerModelChoice[], value: string) {
  const opts = [{ value: '', label: 'Hub default', detail: 'The fastest model you can use', hint: SPEED.fastest }, ...list.map((c) => ({ value: c.ref, label: c.label, detail: c.note, hint: SPEED[c.speed] }))];
  if (value && !list.some((c) => c.ref === value)) opts.push({ value, label: value, detail: 'Not in the list any more', hint: '' });
  return opts;
}

/** "Answers from": which model writes the live answers. */
function AnswerModelPicker({ value, onChange }: { value: string; onChange: (ref: string) => void }) {
  const list = useAnswerModels();
  return <SelectMenu label="Answers from" value={value} onChange={onChange} options={modelOptions(list ?? [], value)} placeholder={list ? 'Hub default' : 'Loading models'} />;
}

/** "Or add files": a drop zone with a picker, and the files as chips. Saved files and ones still to upload in one row. */
function FilesField({ saved, pending, onAdd, onRemove, invalid }: { saved: MeetingFile[]; pending: File[]; onAdd: (f: File[]) => void; onRemove: (i: number) => void; invalid?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const phone = useIsMobile();
  const all = [...saved.map((f) => ({ name: f.name, size: f.size, mediaType: f.mediaType })), ...pending.map((f) => ({ name: f.name, size: f.size, mediaType: f.type }))];
  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) onAdd([...e.dataTransfer.files]);
        }}
        className={cn('flex items-center justify-between gap-3 rounded-[var(--r-2)] border border-dashed px-3 py-3 text-[13px] text-fg-3 phone:text-[14px]', over ? 'border-signal bg-hover' : invalid ? 'border-fault' : 'border-rule')}
      >
        <span>{phone ? 'Resume, job description, notes, slides' : 'Drop a resume, job description, notes or slides here'}</span>
        <Button size={phone ? 'touch' : 'sm'} onClick={() => input.current?.click()}>
          Add files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".pdf,.md,.txt,.docx,.pptx,.csv,.json,.html,text/*,application/pdf"
          onChange={(e) => {
            if (e.target.files?.length) onAdd([...e.target.files]);
            e.target.value = '';
          }}
        />
      </div>
      {all.length > 0 && (
        <div className="-mx-3 -mt-1">
          <AttachmentStrip phone={phone} files={all} onRemove={onRemove} />
        </div>
      )}
    </div>
  );
}

export interface Steering {
  steering: string;
  steeringPreset?: string;
  answerLength: AnswerLength;
}

/** The framed block exactly as the live answers get it (11.3.3). */
export function framed(s: Steering): string {
  return [
    "The owner's steering for this meeting. Follow it for tone, emphasis, what to avoid and length.",
    'It never overrides the rules above: only facts from the context, the "Say this" format, nothing a listener should not hear.',
    '---',
    s.steering.trim(),
    '---',
    `Length: ${s.answerLength === 'long' ? 'up to 6 bullets, each at most 30 words' : '1 to 4 bullets, each at most 20 words'}`,
  ].join('\n');
}

/** Presets, the text, and the answer length. Picking a preset over edited text asks first. */
export function SteeringFields({ value, onChange, rows }: { value: Steering; onChange: (v: Steering) => void; rows?: number }) {
  const presets = usePresets();
  const phone = useIsMobile();
  const [ask, setAsk] = useState<SteeringPreset>();
  const edited = value.steeringPreset === 'custom' || (!value.steeringPreset && !!value.steering.trim());
  const pick = (p: SteeringPreset) => onChange({ ...value, steering: p.text, steeringPreset: p.id });
  const presetValue = value.steeringPreset && value.steeringPreset !== 'custom' ? value.steeringPreset : '';
  const presetOptions = [...presets.map((p) => ({ value: p.id, label: p.label })), ...(edited ? [{ value: '', label: 'Custom' }] : [])];
  const choose = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    if (edited && value.steering.trim()) setAsk(p);
    else pick(p);
  };
  return (
    <div className="flex flex-col gap-2">
      {presets.length > 0 &&
        // a phone has no room for every preset in one row: a menu there, so none is cut off
        (phone ? (
          <SelectMenu label="Steering preset" value={presetValue} onChange={choose} options={presetOptions} placeholder="Pick a preset" />
        ) : (
          <div className="overflow-x-auto">
            <Segmented label="Steering preset" size="sm" value={presetValue} options={presetOptions} onChange={choose} />
          </div>
        ))}
      <Textarea
        prose
        aria-label="How it should answer"
        minRows={rows ?? (phone ? 8 : 6)}
        maxRows={16}
        maxLength={STEERING_MAX}
        value={value.steering}
        placeholder="Tone, what to stress, what to avoid. Pick a preset to start from."
        onChange={(e) => onChange({ ...value, steering: e.target.value, steeringPreset: 'custom' })}
      />
      <div className="flex items-center gap-3">
        <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Answer length</span>
        <Segmented
          label="Answer length"
          size={phone ? 'touch' : 'sm'}
          value={value.answerLength}
          onChange={(answerLength) => onChange({ ...value, answerLength })}
          options={[
            { value: 'short', label: 'Short' },
            { value: 'long', label: 'Longer' },
          ]}
        />
      </div>
      <ConfirmDialog
        open={!!ask}
        onClose={() => setAsk(undefined)}
        title={`Replace your text with the ${ask?.label.split(' /')[0]} preset?`}
        confirm="Replace"
        tone="neutral"
        onConfirm={() => ask && pick(ask)}
      />
    </div>
  );
}

const OPTION = 'flex w-full flex-col rounded-[var(--r-1)] px-2 py-1.5 text-left hov:bg-hover phone:min-h-12 phone:justify-center';

/** 11.3.1: the account's device and folder pairs, searchable; a typed path works on a picked device. */
function FolderPicker({ value, onChange, invalid }: { value?: { device: string; cwd: string }; onChange: (f: MeetingFolder) => void; invalid?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [list, setList] = useState<MeetingFolder[]>();
  const devices = useHub((s) => s.devices);
  useEffect(() => {
    void meetings()
      .folders()
      .then(setList, () => setList([]));
  }, []);
  const ql = q.trim().toLowerCase();
  const shown = (list ?? []).filter((f) => !ql || [f.cwd, f.projectName ?? '', f.deviceName].some((s) => s.toLowerCase().includes(ql))).slice(0, 300);
  const typed = /^[~/]|^[A-Za-z]:\\/.test(q.trim()) ? q.trim() : undefined;
  const cur = value && (list?.find((f) => f.device === value.device && f.cwd === value.cwd) ?? { device: value.device, deviceName: devices[value.device]?.name ?? value.device, cwd: value.cwd, chats: 0, lastAt: 0, online: devices[value.device]?.online ?? true });
  const done = (f: MeetingFolder) => {
    onChange(f);
    setOpen(false);
    setQ('');
  };
  return (
    <>
      <PickerButton ref={ref} invalid={invalid} aria-haspopup="dialog" aria-expanded={open} aria-label={cur ? `Project folder, ${cur.cwd} on ${cur.deviceName}` : 'Project folder'} onClick={() => setOpen((o) => !o)}>
        {cur ? (
          <span>
            {cur.projectName ?? folderName(cur.cwd)} <span className="text-fg-3">· {cur.deviceName}</span>
          </span>
        ) : (
          <span className="text-fg-3">Pick a folder</span>
        )}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={460} maxHeight={420} label="Project folder" sheetTitle="Project folder">
        <div className="p-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search folders, or type a path" aria-label="Search folders" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </div>
        <div role="listbox" aria-label="Folders" className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {!list && <p className="m-0 px-2 py-2 text-[13px] text-fg-3">Loading folders</p>}
          {list && !shown.length && !typed && <p className="m-0 px-2 py-2 text-[13px] text-fg-3 phone:text-[15px]">{q ? `No folder matches "${q}". Type a full path to use one.` : 'No folders yet. Start a Code session in one first.'}</p>}
          {shown.map((f) => (
            <button key={`${f.device}:${f.cwd}`} type="button" role="option" aria-selected={value?.device === f.device && value.cwd === f.cwd} onClick={() => done(f)} className={OPTION}>
              <span className="truncate text-[13px] text-fg phone:text-[16px]">
                {f.projectName ?? folderName(f.cwd)}{' '}
                <span className="num text-fg-3">
                  · {f.deviceName}
                  {f.online ? '' : ' (offline)'} · {f.chats} chats{f.lastAt ? ` · ${relTime(f.lastAt)}` : ''}
                </span>
              </span>
              <span className="truncate font-mono text-[11.5px] text-fg-3 phone:text-[13px]">{f.cwd}</span>
            </button>
          ))}
          {typed &&
            Object.values(devices).map((d) => (
              <button key={d.id} type="button" role="option" aria-selected={false} onClick={() => done({ device: d.id, deviceName: d.name, online: d.online, cwd: typed, chats: 0, lastAt: 0 })} className={OPTION}>
                <span className="truncate text-[13px] text-fg phone:text-[16px]">
                  Use <span className="font-mono text-[12.5px]">{typed}</span> on {d.name}
                </span>
              </button>
            ))}
        </div>
      </Popover>
    </>
  );
}

/** 11.3.2: an event on the picked day (or the next 14 days), "None" first. Event text is shown, never prompted. */
function EventPicker({ date, zone, value, onPick }: { date?: string; zone: string; value?: string; onPick: (e: MeetingCalendarEvent | undefined) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<MeetingCalendarEvent[]>();
  const [connected, setConnected] = useState<boolean>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    void api()
      .pimSettings()
      .then(
        (s) => setConnected(s.accounts.some((a) => a.calendar)),
        () => setConnected(false),
      );
  }, []);
  useEffect(() => {
    if (!connected) return;
    const b = (date && dayBounds(date, zone)) || { from: Date.now(), to: Date.now() + 14 * 24 * 60 * MIN };
    let live = true;
    void meetings()
      .calendar(b.from, b.to)
      .then(
        (r) => {
          if (!live) return;
          setEvents(r.events);
          setErr(r.errors[0]);
        },
        (e: Error) => live && setErr(e.message),
      );
    return () => {
      live = false;
    };
  }, [date, zone, connected]);
  if (connected === false)
    return (
      <p className="m-0 text-[13px] text-fg-3 phone:text-[15px]">
        No calendar connected.{' '}
        <Link href="/settings/calmail" className="link">
          Settings, Calendar and mail
        </Link>
      </p>
    );
  const cur = events?.find((e) => e.id === value);
  return (
    <>
      <PickerButton ref={ref} aria-haspopup="listbox" aria-expanded={open} aria-label={cur ? `Calendar event, ${cur.title}` : 'Calendar event, none'} onClick={() => setOpen((o) => !o)}>
        {cur ? (
          <span>
            {cur.title} <span className="num text-fg-3">· {hm(cur.start, zone)}</span>
          </span>
        ) : value ? (
          <span className="text-fg-2">Linked event</span>
        ) : (
          <span className="text-fg-3">None</span>
        )}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={420} maxHeight={360} label="Calendar event" sheetTitle="Calendar event">
        <div role="listbox" aria-label="Calendar events" className="p-1">
          <button type="button" role="option" aria-selected={!value} onClick={() => (onPick(undefined), setOpen(false))} className={OPTION}>
            <span className="text-[13px] text-fg phone:text-[16px]">None</span>
          </button>
          {err && <p className="m-0 px-2 py-1.5 text-[13px] text-fault">{err}</p>}
          {events && !events.length && <p className="m-0 px-2 py-1.5 text-[13px] text-fg-3 phone:text-[15px]">{date ? 'No events that day.' : 'No events in the next 14 days.'}</p>}
          {events?.map((e) => (
            <button key={e.id} type="button" role="option" aria-selected={value === e.id} onClick={() => (onPick(e), setOpen(false))} className={OPTION}>
              <span className="truncate text-[13px] text-fg phone:text-[16px]">{e.title}</span>
              <span className="num truncate text-[12px] text-fg-3 phone:text-[14px]">
                {when(e.start, Math.round((e.end - e.start) / MIN), zone)}
                {e.location ? ` · ${e.location}` : ''}
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

export type FormMode = { kind: 'new' } | { kind: 'start' } | { kind: 'edit'; meeting: Meeting; files?: MeetingFile[] };

/**
 * The form. `others` are the account's meetings, for the overlap note.
 * `prefill` comes from "Schedule a meeting here..." (device and folder).
 */
export function MeetingForm({ mode, open, onClose, onSaved, others = [], prefill, page }: { mode: FormMode; open: boolean; onClose: () => void; onSaved: (m: Meeting, opened?: boolean) => void; others?: Meeting[]; prefill?: { device: string; cwd: string }; page?: boolean }) {
  const zone = useOwnerZone();
  const phone = useIsMobile();
  const m = mode.kind === 'edit' ? mode.meeting : undefined;
  const start = mode.kind === 'start';
  const z = m?.tz ?? zone;
  const init = m?.scheduledAt ? toInputs(m.scheduledAt, z) : { date: '', time: '' };
  const [title, setTitle] = useState(m?.title ?? '');
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [duration, setDuration] = useState<string>(m?.durationMin ? String(m.durationMin) : '');
  const [folder, setFolder] = useState<{ device: string; cwd: string; online?: boolean; deviceName?: string } | undefined>(m ? (m.cwd ? { device: m.device, cwd: m.cwd } : undefined) : prefill);
  const [answerModel, setAnswerModel] = useState(m?.answerModel ?? '');
  const [saved, setSaved] = useState<MeetingFile[]>(mode.kind === 'edit' ? (mode.files ?? []) : []);
  const [pending, setPending] = useState<File[]>([]);
  const [event, setEvent] = useState<{ id: string; calendarId: string } | undefined>(m?.calendarEventId ? { id: m.calendarEventId, calendarId: m.calendarId ?? '' } : undefined);
  const [agenda, setAgenda] = useState(m?.agenda ?? '');
  const [steer, setSteer] = useState<Steering>({ steering: m?.steering ?? '', steeringPreset: m?.steeringPreset, answerLength: m?.answerLength ?? 'short' });
  const [reminders, setReminders] = useState<ReminderMin[]>((m?.reminders as ReminderMin[] | undefined) ?? [1440, 15]);
  const [autoPrep, setAutoPrep] = useState(m?.autoPrep ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const at = date && time ? fromInputs(date, time, z) : undefined;
  const offline = folder && folder.online === false;
  const overlap = at
    ? others.find((o) => o.id !== m?.id && o.scheduledAt !== undefined && o.status === 'scheduled' && o.scheduledAt < at + (Number(duration) || 1) * MIN && at < o.scheduledAt + (o.durationMin ?? 1) * MIN)
    : undefined;

  const check = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (title.length > TITLE_MAX) e.title = `At most ${TITLE_MAX} characters.`;
    if (!folder && !saved.length && !pending.length) e.cwd = 'Pick the project folder the meeting is about, or add files.';
    if (!start) {
      if (!at) e.scheduledAt = 'Pick a date and a time.';
      else if (at < Date.now() + 5 * MIN) e.scheduledAt = 'Pick a time at least 5 minutes from now.';
      else if (at > Date.now() + 365 * 24 * 60 * MIN) e.scheduledAt = 'Pick a time within a year.';
    }
    if (agenda.length > AGENDA_MAX) e.agenda = `At most ${AGENDA_MAX} characters.`;
    return e;
  };

  const save = async () => {
    const e = check();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    // '' and null clear a field on the hub: JSON drops undefined, and the hub would keep the old value
    const steering = { steering: steer.steering.trim(), steeringPreset: steer.steeringPreset, answerLength: steer.answerLength };
    const durationMin = Number(duration) || null;
    const where = folder ? { device: folder.device, cwd: folder.cwd } : {};
    // the meeting is saved first; a file that fails to upload is said, and the meeting stays
    const upload = async (id: string) => {
      if (!pending.length) return;
      try {
        const added = await uploadMeetingFiles(id, pending);
        setSaved((s) => [...s, ...added]);
        setPending([]);
      } catch (err) {
        toast({ title: 'The meeting is saved, but its files did not upload', body: err instanceof Error ? err.message : String(err), level: 'error' });
      }
    };
    try {
      if (m) {
        const sched = m.status === 'scheduled' || (m.status === 'ready' && !m.startedAt) || !m.startedAt ? { scheduledAt: at, durationMin, tz: z } : {};
        const out = await meetings().patch(m.id, { title: title.trim() || undefined, agenda, ...sched, ...steering, answerModel: answerModel || null, calendarEventId: event?.id ?? null, calendarId: event?.calendarId ?? null, reminders, autoPrep });
        await upload(m.id);
        onSaved(out);
      } else if (start) {
        const out = await meetings().create({ ...where, title: title.trim() || undefined, agenda: agenda || undefined, ...steering, answerModel: answerModel || undefined });
        await upload(out.id);
        onSaved(out, await openOverlay(out.id));
      } else {
        const out = await meetings().create({ ...where, title: title.trim() || undefined, agenda: agenda || undefined, scheduledAt: at, durationMin: durationMin ?? undefined, tz: z, ...steering, answerModel: answerModel || undefined, calendarEventId: event?.id, calendarId: event?.calendarId, reminders, autoPrep });
        await upload(out.id);
        onSaved(out);
      }
    } catch (err) {
      // 400 { field, error } shows under its field; anything else as a toast
      const body = err instanceof ApiError ? (err.body as { field?: string; error?: string } | undefined) : undefined;
      if (body?.field) setErrors({ [body.field]: body.error ?? 'Not valid.' });
      else toast({ title: start ? 'Could not start the meeting' : 'Could not save the meeting', body: err instanceof Error ? err.message : String(err), level: 'error' });
    }
    setBusy(false);
  };

  const pickEvent = (e: MeetingCalendarEvent | undefined) => {
    setEvent(e ? { id: e.id, calendarId: e.calendarId } : undefined);
    if (!e) return;
    // fills only what is still empty (11.3.2)
    if (!title.trim()) setTitle(e.title.slice(0, TITLE_MAX));
    const t = toInputs(e.start, z);
    if (!date) setDate(t.date);
    if (!time) setTime(t.time);
    if (!m?.durationMin) setDuration(String(Math.round((e.end - e.start) / MIN)));
  };

  const verb = m ? 'Save' : start ? 'Prepare and start' : 'Schedule';
  const busyVerb = m ? 'Saving...' : start ? 'Preparing...' : 'Scheduling...';
  const size = phone ? 'touch' : 'md';
  const fields = (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Title" optional error={errors.title}>
        <Input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly sync with Dr. Moore" />
      </Field>
      {!start && (
        <Field label="Date and time" error={errors.scheduledAt} help={overlap ? `${zoneLabel(z)}. Overlaps ${overlap.title} ${hm(overlap.scheduledAt!, z)}${overlap.durationMin ? ` to ${hm(overlap.scheduledAt! + overlap.durationMin * MIN, z)}` : ''}.` : zoneLabel(z)}>
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 phone:grid-cols-2">
            <Input type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} invalid={!!errors.scheduledAt} />
            <Input type="time" aria-label="Time" step={300} value={time} onChange={(e) => setTime(e.target.value)} invalid={!!errors.scheduledAt} className="w-[120px] phone:w-full" />
            <SelectMenu
              label="Duration"
              className="w-[120px] phone:col-span-2 phone:w-full"
              value={duration}
              onChange={setDuration}
              options={DURATIONS.map((d) => ({ value: d, label: d ? `${d} min` : 'No duration' }))}
            />
          </div>
        </Field>
      )}
      <Field label="Project folder" optional help={offline ? undefined : 'Prep reads every chat on this folder and below it, its code and git history.'}>
        {m ? (
          // the hub keeps the folder a meeting was made with
          <p className="m-0 text-[13px] text-fg-2 phone:text-[15px]">{m.cwd ? <span className="font-mono text-[12.5px]">{m.cwd}</span> : 'None, files only'}</p>
        ) : (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <FolderPicker value={folder} invalid={!!errors.cwd} onChange={(f) => setFolder(f)} />
            </div>
            {folder && (
              <Button variant="quiet" size={size} onClick={() => setFolder(undefined)}>
                No folder
              </Button>
            )}
          </div>
        )}
      </Field>
      <Field label="Or add files" optional error={errors.cwd} help={folder ? 'Read with the folder: prep and the live answers use both.' : 'Prep and the live answers read these. Text is taken out of PDFs and documents the way chat attachments are.'}>
        <FilesField
          saved={saved}
          pending={pending}
          invalid={!!errors.cwd}
          onAdd={(f) => setPending((p) => [...p, ...f])}
          onRemove={(i) => {
            if (i >= saved.length) return setPending((p) => p.filter((_, k) => k !== i - saved.length));
            const f = saved[i]!;
            void meetings()
              .removeFile(m!.id, f.id)
              .then(
                () => setSaved((s) => s.filter((x) => x.id !== f.id)),
                (err: Error) => toast({ title: `Could not remove ${f.name}`, body: err.message, level: 'error' }),
              );
          }}
        />
      </Field>
      <Field label="Answers from" help="The model that writes live answers. Faster models answer in about a second; slower ones answer better but late.">
        <AnswerModelPicker value={answerModel} onChange={setAnswerModel} />
      </Field>
      {offline && (
        <p className="-mt-3 text-[12px] leading-[1.4] text-warn phone:text-[13px]">
          {folder.deviceName} is offline. Prep will read your chats now, and the code and git history only once {folder.deviceName} is online.
        </p>
      )}
      {!start && (
        <Field label="Calendar event" optional>
          <EventPicker date={date || undefined} zone={z} value={event?.id} onPick={pickEvent} />
        </Field>
      )}
      <Field label="What it's for" optional error={errors.agenda}>
        <Textarea prose minRows={3} maxRows={10} maxLength={AGENDA_MAX} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="Present all evidence, defend the findings, 10 min talk then questions." />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">How it should answer</span>
        <SteeringFields value={steer} onChange={setSteer} />
      </div>
      {!start && (
        <>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[12px] font-medium text-fg-2 phone:text-[13px]">Reminders</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {REMINDERS.map(([min, label]) => (
                <Checkbox key={min} label={label} checked={reminders.includes(min)} onChange={(on) => setReminders((r) => (on ? [...r, min] : r.filter((x) => x !== min)))} />
              ))}
            </div>
          </fieldset>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[13px] text-fg phone:text-[15px]">Prepare the evening before</p>
              <p className="text-[12px] text-fg-3 phone:text-[13px]">At 19:00 the day before, if you have not prepared yet.</p>
            </div>
            <OnOff label="Prepare the evening before" checked={autoPrep} onChange={setAutoPrep} size={phone ? 'touch' : 'sm'} />
          </div>
        </>
      )}
      <button type="submit" hidden />
    </form>
  );
  const actions = (
    <>
      <Button variant="quiet" size={size} onClick={onClose}>
        Cancel
      </Button>
      <Button variant="solid" size={size} disabled={busy} onClick={() => void save()} className={cn(page && 'flex-1')}>
        {busy ? busyVerb : verb}
      </Button>
    </>
  );
  const heading = m ? 'Edit meeting' : start ? 'Start a meeting now' : 'Schedule a meeting';
  if (page)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-[var(--gutter)] pt-2 pb-6">{fields}</div>
        <div className="flex shrink-0 gap-2 border-t border-rule bg-bg px-[var(--gutter)] pt-2 pb-2 pb-safe">{actions}</div>
      </div>
    );
  return (
    <Dialog open={open} onClose={onClose} title={heading} width={560} top="6vh" footer={actions} footerRule>
      {fields}
    </Dialog>
  );
}
