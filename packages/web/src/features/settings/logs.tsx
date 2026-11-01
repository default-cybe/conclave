/**
 * Settings > Logs (docs/DESIGN.md 33): the hub's log files. How big they
 * are and how long they are kept, the errors of today and this week, debug
 * lines for a while, and Download logs: one zip with the files, a summary
 * and the settings without keys, to hand to a developer.
 */
import { useState } from 'react';
import type { LogsStatus } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile, useLoad, useNow } from '@/lib/hooks';
import { bytes, durationShort, int, plural } from '@/lib/format';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { OnOff, Segmented } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Group, Outcome, SettingRow, errText } from './parts';

type Days = '1' | '7' | '28';
/** Debug lines stay on this long, then turn off on their own. */
export const DEBUG_HOURS = 24;

function saveBlob(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** "12 files, 4.2 MB, 14 Oct to 21 Oct" */
export function filesWords(s: Pick<LogsStatus, 'files' | 'bytes' | 'oldest' | 'newest'>): string {
  if (!s.files) return 'No files yet';
  const span = s.oldest && s.newest ? (s.oldest === s.newest ? `, ${s.oldest}` : `, ${s.oldest} to ${s.newest}`) : '';
  return `${plural(s.files, 'file')}, ${bytes(s.bytes)}${span}`;
}

export function LogsSection() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const now = useNow(30_000);
  const { data: status, error, reload } = useLoad(() => api().logs(), []);
  const [shown, setShown] = useState<LogsStatus>();
  const s = shown ?? status;
  const [days, setDays] = useState<Days>('7');
  const [busy, setBusy] = useState<'debug' | 'download' | null>(null);

  const debugOn = !!s?.debugUntil && s.debugUntil > now;

  const setDebug = async (on: boolean) => {
    setBusy('debug');
    try {
      setShown(await api().setLogsDebug(on ? DEBUG_HOURS : 0));
    } catch (e) {
      toast({ title: `Could not change it. ${errText(e)}`, level: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy('download');
    try {
      const { name, data } = await api().exportLogs({ days: Number(days) });
      saveBlob(name, data);
      toast({ title: mobile ? 'Logs saved.' : `Saved ${name}.` });
      reload();
    } catch (e) {
      toast({ title: `Could not download the logs. ${errText(e)}`, level: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (!s && error) return <p className="text-[13px] text-fault">{`Could not read the logs. ${errText(error)}`}</p>;
  if (!s) return <LoadingRows loading rows={4} />;

  return (
    <div className="space-y-9">
      <Group title="Files" help="The hub writes what it does to a file a day: turns, tool calls, devices, errors. Never chat text, keys or passwords.">
        <SettingRow label="Size">
          <span className="num text-[14px] text-fg md:text-right">{filesWords(s)}</span>
        </SettingRow>
        <SettingRow label="Kept" help="logs.keepDays and logs.maxMB in the config change it. The oldest days go first.">
          <span className="text-[14px] text-fg md:text-right">
            {plural(s.keepDays, 'day')}, at most {int(s.maxMB)} MB
          </span>
        </SettingRow>
        <SettingRow label="Folder" help="On the hub.">
          <span className="font-mono text-[13px] break-all text-fg md:text-right">{s.dir}</span>
        </SettingRow>
        {s.problem && (
          <SettingRow label="Problem">
            <Outcome word="Not writing" tone="fault">
              {s.problem}
            </Outcome>
          </SettingRow>
        )}
      </Group>

      <Group title="Errors">
        <SettingRow label="Today">
          <span className="text-[14px] md:text-right">
            <span className={s.errorsToday ? 'text-fault' : 'text-fg'}>{plural(s.errorsToday, 'error')}</span>
            <span className="text-fg-3">, {plural(s.warningsToday, 'warning')}</span>
          </span>
        </SettingRow>
        <SettingRow label="This week">
          <span className={s.errorsWeek ? 'text-[14px] text-fault md:text-right' : 'text-[14px] text-fg md:text-right'}>{plural(s.errorsWeek, 'error')}</span>
        </SettingRow>
      </Group>

      <Group title="Debug">
        <SettingRow
          label="Debug lines"
          help={debugOn ? `More detail, to look into a problem. Off in ${durationShort(s.debugUntil! - now)}.` : `More detail, to look into a problem. It turns off on its own after ${DEBUG_HOURS} hours.`}
        >
          <OnOff label="Debug lines" size={size} checked={debugOn} disabled={busy === 'debug'} onChange={(v) => void setDebug(v)} />
        </SettingRow>
      </Group>

      <Group title="Download">
        <SettingRow label="Days" help="The log files of these days, a summary, your settings without keys, and each online device's recent log, in one zip.">
          <Segmented<Days>
            label="Days to download"
            size={size}
            value={days}
            onChange={setDays}
            options={[
              { value: '1', label: '1 day' },
              { value: '7', label: '7 days' },
              { value: '28', label: '28 days' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Download logs" help="Give the file to a developer to see what went wrong.">
          <Button variant="solid" size={mobile ? 'touch' : 'md'} busy={busy === 'download' ? 'Preparing' : false} onClick={() => void download()}>
            Download logs
          </Button>
        </SettingRow>
      </Group>
    </div>
  );
}
