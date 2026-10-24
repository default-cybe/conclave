/**
 * The window starter on an account row (Settings > Models > Accounts; the
 * hub side is core/src/accounts/starter.ts, the idea is Lamplighter's): a
 * switch, one line on what it does, and what it is doing now ("Next start
 * 14:03", "Stopped until tomorrow: 429"). Change opens the model, the hours
 * and the time zone. The first time the owner turns one on, a note says
 * that some providers limit automated use; it shows once.
 */
import { useState } from 'react';
import type { AccountDto, AccountStarter, AccountsStatus } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { STARTER_NOTE, starterLine } from '@/lib/accounts';
import { TONE_CLASS } from '@/lib/subscriptions';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Field, Input, OnOff, Select } from '@/components/ui/Field';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { TextAction } from '@/components/ui/Section';
import { errText } from './parts';

/** Every half hour of the day, "00:00" to "23:30". */
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

const modelName = (a: AccountDto, id: string | undefined) => (id ? (a.models.find((m) => m.id === id || m.id.endsWith(`/${id}`))?.name ?? id.replace(/^.*\//, '')) : undefined);

export function StarterRow({ a, now, noted, onSaved }: { a: AccountDto; now: number; noted: boolean; onSaved: (s: AccountsStatus) => void }) {
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(false);
  const [edit, setEdit] = useState(false);
  const s = a.starter;
  // a plan paid with a key (Z.ai) has a 5 hour window too
  if (!s || (a.kind !== 'subscription' && !a.subscription)) return null;
  const on = s.enabled;
  const line = starterLine(s, now);
  const model = modelName(a, s.model) ?? (s.autoModel ? `${modelName(a, s.autoModel)}, the cheapest` : undefined);

  const save = async (starter: AccountStarter, done?: string) => {
    setBusy(true);
    try {
      onSaved(await api().updateAccount(a.id, { starter }));
      if (done) toast({ title: done });
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setBusy(false);
  };
  const toggle = (v: boolean) => {
    if (v && !noted) setNote(true);
    else void save({ enabled: v });
  };

  return (
    <div className="mt-3 max-w-[560px] border-t border-rule pt-3">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-fg phone:text-[15px]">Window starter</span>
          <span className="block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Start the next 5-hour window automatically: one tiny request right after each reset.</span>
          {on && line.text && <span className={cn('mt-1 block text-[12.5px] leading-[1.45] phone:text-[13.5px]', TONE_CLASS[line.tone])}>{line.text}</span>}
          {on && (
            <span className="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-[12px] text-fg-3 phone:text-[13px]">
              <span>
                {[model, `${s.start} to ${s.end}`, s.tz ? s.tz : undefined].filter(Boolean).join(' · ')}
              </span>
              <TextAction label="Change" onClick={() => setEdit(true)} />
            </span>
          )}
        </span>
        <OnOff label="Start the next 5-hour window automatically" size={mobile ? 'touch' : 'sm'} checked={on} disabled={busy} onChange={toggle} />
      </div>
      <ConfirmDialog
        open={note}
        onClose={() => setNote(false)}
        onConfirm={() => save({ enabled: true }, `Window starter is on for ${a.label}.`)}
        title="Window starter"
        body={STARTER_NOTE}
        confirm="Turn on"
        busy="Turning on"
        tone="neutral"
      />
      {edit && <StarterDialog a={a} onClose={() => setEdit(false)} onSaved={onSaved} />}
    </div>
  );
}

function StarterDialog({ a, onClose, onSaved }: { a: AccountDto; onClose: () => void; onSaved: (s: AccountsStatus) => void }) {
  const s = a.starter!;
  const [model, setModel] = useState(s.model ?? '');
  const [start, setStart] = useState(s.start);
  const [end, setEnd] = useState(s.end);
  const [tz, setTz] = useState(s.tz ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const auto = modelName(a, s.autoModel);
  // the saved hours stay pickable even off the half hour
  const times = [...new Set([...TIMES, s.start, s.end])].sort();
  const save = async () => {
    if (start === end) {
      setError('The hours need a start and an end that differ.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await api().updateAccount(a.id, { starter: { model, start, end, tz: tz.trim() } }));
      onClose();
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Window starter for ${a.label}`}
      description="Right after the 5-hour window resets, it asks for OK, with no tools and at most 4 tokens, so the next window starts at once."
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" busy={busy ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Model" help="The cheapest one the plan offers is enough.">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{auto ? `Cheapest: ${auto}` : 'Cheapest'}</option>
            {a.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From">
            <Select value={start} onChange={(e) => setStart(e.target.value)}>
              {times.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Until" help="A reset later than this waits for the start the next day.">
            <Select value={end} onChange={(e) => setEnd(e.target.value)}>
              {times.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Time zone" help={`A name like Europe/Berlin. Empty uses yours: ${s.zone}.`} error={error} optional>
          <Input mono value={tz} onChange={(e) => setTz(e.target.value)} placeholder={s.zone} spellCheck={false} autoComplete="off" />
        </Field>
      </form>
    </Dialog>
  );
}
