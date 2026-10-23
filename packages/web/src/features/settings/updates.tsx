/**
 * Settings > About, Updates (docs/DESIGN.md, Updates). The owner only: the
 * running version against the newest release (checked when this opens and
 * once a day by the hub), Update now with its progress, the command for a hub
 * that updates another way (Docker, a checkout), whether a new release pops
 * up when the app starts, and Install updates automatically.
 */
import { useEffect, useState } from 'react';
import type { UpdateStatusDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { OnOff } from '@/components/ui/Field';
import { TextAction } from '@/components/ui/Section';
import { LiveStatus } from '@/components/motion';
import { cannotWords, installWords, jobRunning, jobTone, jobWords, latestWords } from '@/lib/updates';
import { setHubUpdateStatus, setUpdateStartup, useHubUpdate } from '@/components/UpdateBanners';
import { agoWords, errText, Group, Outcome, SettingRow } from './parts';

export function UpdatesGroup() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [s, setOwn] = useState<UpdateStatusDto>();
  const [busy, setBusy] = useState<string | null>(null);
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
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
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
      <SettingRow label="Newest release" help={s.checkedAt ? `Looked ${agoWords(s.checkedAt)}. The hub looks once a day.` : 'The hub looks once a day.'}>
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
        <SettingRow label={`Update to ${s.latest.version}`} help="Downloads it, checks its signature, swaps it in and restarts the hub. The previous version stays next to it, and comes back if the new one does not start.">
          <Button variant="solid" size={size} busy={busy === 'apply' ? 'Starting' : false} onClick={() => void call('apply', () => api().applyHubUpdate(s.latest!.version))}>
            Update now
          </Button>
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
        <SettingRow label="Install updates automatically" help={`At night, ${s.auto.window} on the hub's clock, when no session is working. Device daemons update then too.`}>
          <OnOff label="Install updates automatically" size={size} checked={s.auto.on} disabled={busy === 'auto'} onChange={(v) => void call('auto', () => api().setAutoUpdate(v))} />
        </SettingRow>
      )}
    </Group>
  );
}
