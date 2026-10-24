/**
 * Settings > About, Updates (docs/DESIGN.md, Updates). The owner only: the
 * running version against the newest release (checked when this opens and
 * once a day by the hub), Update now with its progress, the command for a hub
 * that updates another way (Docker, a checkout), whether a new release pops
 * up when the app starts, and Install updates automatically (when idle or at
 * night). Update now while work runs says what runs and offers Update anyway
 * or Update when idle.
 */
import { useEffect, useState } from 'react';
import type { UpdateStatusDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { OnOff, Segmented } from '@/components/ui/Field';
import { TextAction } from '@/components/ui/Section';
import { LiveStatus } from '@/components/motion';
import { busyMessage, cannotWords, installWords, jobRunning, jobTone, jobWords, latestWords } from '@/lib/updates';
import { BusyChoices, setHubUpdateStatus, setUpdateStartup, useHubUpdate } from '@/components/UpdateBanners';
import { agoWords, errText, Group, Outcome, SettingRow } from './parts';

export function UpdatesGroup() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [s, setOwn] = useState<UpdateStatusDto>();
  const [busy, setBusy] = useState<string | null>(null);
  /** Update now found work running: what runs, in a sentence. */
  const [blocked, setBlocked] = useState<string>();
  const startup = useHubUpdate((u) => u.prefs.startup);
  // the shell's copy (the popup, the dot on the account row) follows what About reads
  const setS = (next: UpdateStatusDto) => {
    setOwn(next);
    setHubUpdateStatus(next);
  };

  const call = async (id: string, fn: () => Promise<UpdateStatusDto>) => {
    setBusy(id);
    try {
      setS(await fn());
      setBlocked(undefined);
    } catch (e) {
      const why = busyMessage(e);
      if (why) setBlocked(why);
      else toast({ title: errText(e), level: 'error' });
    } finally {
      setBusy(null);
    }
  };

  // opening About looks at the newest release
  useEffect(() => {
    void api()
      .hubUpdate()
      .then(setS)
      .catch(() => {});
    void api()
      .checkHubUpdate()
      .then(setS)
      .catch(() => {});
  }, []);

  const running = jobRunning(s?.job);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void api()
        .hubUpdate()
        .then(setS)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [running]);

  if (!s) return null;
  const cannot = cannotWords(s);
  const job = s.job;
  return (
    <Group title="Updates">
      <SettingRow label="Newest release" help={`${s.checkedAt ? `Looked ${agoWords(s.checkedAt)}. ` : ''}The hub looks ${s.auto.on && s.auto.window === 'idle' ? 'every hour' : 'once a day'}.`}>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 md:justify-end">
          {s.checking ? <LiveStatus state="tool" label="Checking" /> : <span className="text-[14px] text-fg">{latestWords(s)}</span>}
          <TextAction label="Check now" onClick={() => void call('check', () => api().checkHubUpdate())} />
        </span>
      </SettingRow>
      {s.latest?.notes && s.available && (
        <SettingRow label={`What is new in ${s.latest.version}`} stack>
          <p className="m-0 max-h-40 overflow-y-auto text-[13px] leading-[1.5] whitespace-pre-wrap text-fg-2">{s.latest.notes}</p>
        </SettingRow>
      )}
      {job && (
        <SettingRow label={jobRunning(job) ? 'Updating' : 'Last update'}>
          <span className="flex items-center gap-2 md:justify-end">
            {jobRunning(job) ? <LiveStatus state="tool" label={jobWords(job)} /> : <Outcome word={jobWords(job)} tone={jobTone(job)} />}
          </span>
        </SettingRow>
      )}
      {s.available && s.latest && !cannot && !running && (
        <SettingRow
          label={`Update to ${s.latest.version}`}
          help={
            s.whenIdle === s.latest.version
              ? 'Installs once nothing runs.'
              : 'Downloads it, checks its signature, swaps it in and restarts the hub. The previous version stays next to it, and comes back if the new one does not start.'
          }
        >
          <Button variant="solid" size={size} busy={busy === 'apply' ? 'Starting' : false} onClick={() => void call('apply', () => api().applyHubUpdate(s.latest!.version))}>
            Update now
          </Button>
        </SettingRow>
      )}
      {blocked && s.available && s.latest && !running && (
        <SettingRow label="Work is running" help={`${blocked} The restart would stop it.`}>
          <BusyChoices
            size={size}
            busy={busy}
            className="md:justify-end"
            onWhenIdle={() => void call('idle', () => api().applyHubUpdate(s.latest!.version, { when: 'idle' }))}
            onForce={() => void call('force', () => api().applyHubUpdate(s.latest!.version, { force: true }))}
          />
        </SettingRow>
      )}
      {cannot && (
        <SettingRow label="How to update" help={cannot} stack={!!s.install.command}>
          {s.install.command ? <code className="block rounded-[var(--r-1)] bg-sunk px-2.5 py-1.5 font-mono text-[12.5px] break-all text-fg">{s.install.command}</code> : undefined}
        </SettingRow>
      )}
      <SettingRow label="Show new versions at startup" help={startup ? 'A new release opens a popup when the app starts.' : 'Off: a new release shows as a dot on your account and here.'}>
        <OnOff label="Show new versions at startup" size={size} checked={startup} onChange={setUpdateStartup} />
      </SettingRow>
      <SettingRow label="Installed as" help={s.install.dir}>
        <span className="text-[14px] text-fg">{installWords(s.install)}</span>
      </SettingRow>
      {s.install.canUpdate && (
        <SettingRow label="Install updates automatically" help="Updates install by themselves when nothing is running. Device daemons update too, each when nothing runs on it.">
          <OnOff label="Install updates automatically" size={size} checked={s.auto.on} disabled={busy === 'auto'} onChange={(v) => void call('auto', () => api().setAutoUpdate({ auto: v }))} />
        </SettingRow>
      )}
      {s.install.canUpdate && s.auto.on && (
        <SettingRow label="When" help={s.auto.window === 'idle' ? 'As soon as nothing has run for a while.' : `At night, ${s.auto.hours} on the hub's clock, when nothing runs.`}>
          <Segmented<'idle' | 'night'>
            label="When updates install"
            size={size}
            value={s.auto.window}
            disabled={busy === 'window'}
            onChange={(v) => void call('window', () => api().setAutoUpdate({ window: v }))}
            options={[
              { value: 'idle', label: 'When idle' },
              { value: 'night', label: 'At night' },
            ]}
          />
        </SettingRow>
      )}
    </Group>
  );
}
