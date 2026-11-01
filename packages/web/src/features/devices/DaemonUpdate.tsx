/**
 * A device's daemon against the hub's version, on the Devices page
 * (docs/DESIGN.md, Updates). The owner only. An older daemon that can update
 * itself gets Update: it downloads the hub's version for its own system,
 * checks the signature, replaces itself and restarts; the line follows it
 * until it is back. The desktop app's daemon updates with the app.
 */
import { useEffect, useState } from 'react';
import type { Device } from '@conclave/core/types';
import type { DeviceUpdateDto, DeviceUpdatesDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast, useHub } from '@/store/store';
import { useIsOwner } from '@/lib/people';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { deviceUpdateView } from '@/lib/updates';
import { Outcome, errText } from '../settings/parts';

/** Every device's daemon update; again every few seconds while one is updating. */
export function useDeviceUpdates(): DeviceUpdatesDto | undefined {
  const owner = useIsOwner();
  const booted = useHub((s) => s.booted);
  const member = useHub((s) => s.me?.role === 'member');
  // a device that comes back (its new version) changes the list: ask again
  const devices = useHub((s) => s.devices);
  const [data, setData] = useState<DeviceUpdatesDto>();
  const show = owner && booted && !member;
  const busy = !!data?.devices.some((d) => d.state === 'sent' || d.state === 'updating');
  useEffect(() => {
    if (!show) return;
    let stop = false;
    const load = () =>
      void api()
        .deviceUpdates()
        .then((d) => !stop && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, busy ? 3000 : 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [show, busy, devices]);
  return show ? data : undefined;
}

export function DaemonUpdate({ d, update, onChange }: { d: Device; update: DeviceUpdateDto | undefined; onChange: (u: DeviceUpdateDto) => void }) {
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const view = deviceUpdateView(update, d.online);
  if (!view.words) return null;
  return (
    <div className="flex flex-col items-start gap-1.5 py-1.5">
      <Outcome word={view.words} tone={view.tone} />
      {view.action && (
        <Button
          variant="outline"
          size={mobile ? 'touch' : 'sm'}
          busy={busy ? 'Sending' : false}
          onClick={async () => {
            setBusy(true);
            try {
              onChange(await api().updateDeviceDaemon(d.id));
            } catch (e) {
              toast({ title: errText(e), level: 'error' });
            } finally {
              setBusy(false);
            }
          }}
        >
          Update
        </Button>
      )}
    </div>
  );
}
