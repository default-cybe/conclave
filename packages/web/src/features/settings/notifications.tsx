/**
 * Settings > Notifications. Notifications stay inside Conclave: this device
 * (Web Push in a browser, native notifications in the desktop app) with a
 * test, the other browsers the hub notifies, a note that the Android app
 * keeps its own connection, then what is worth a notification and the hold
 * while you are using Conclave. Same config keys as onboarding step 8.
 */
import { useState, type ReactNode } from 'react';
import { useHub, toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { deviceName, INSECURE_WORDS, isDesktopApp, removeNotifyDevice, useDeviceNotify, useNotifyDevices, type DeviceNotifyState } from '@/lib/notify';
import { shortDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { OnOff, Segmented } from '@/components/ui/Field';
import { LiveStatus } from '@/components/motion';
import { errText, Group, Outcome, save, SettingRow } from './parts';

export type NotifyOn = {
  sessionDone: boolean;
  approvalNeeded: boolean;
  limitReset: boolean;
  routineDone: boolean;
  errors: boolean;
  friendMessage: boolean;
  fileConflict: boolean;
  stuck: boolean;
};

export const NOTIFY_DEFAULTS: NotifyOn = { sessionDone: true, approvalNeeded: true, limitReset: true, routineDone: true, errors: true, friendMessage: true, fileConflict: true, stuck: true };

export const NOTIFY_EVENTS: Array<{ key: keyof NotifyOn; label: string; help: string }> = [
  { key: 'approvalNeeded', label: 'Approvals and questions', help: 'A session is waiting on you. Answer from the notification or the Inbox.' },
  { key: 'errors', label: 'Failures', help: 'A session or a routine failed.' },
  { key: 'stuck', label: 'Stuck sessions', help: 'A running session made no progress for 5 minutes, or one tool failed the same way 3 times. Stop it or keep waiting from the Inbox.' },
  { key: 'fileConflict', label: 'File conflicts', help: 'Two chats edited the same file within 10 minutes. Both are linked from the Inbox.' },
  { key: 'limitReset', label: 'Limit resets', help: 'A plan you ran out of is usable again.' },
  { key: 'routineDone', label: 'Routine finished', help: 'Each routine run, with its summary. A routine can turn this off for itself.' },
  { key: 'sessionDone', label: 'Session finished', help: 'A session finished its turn while you were away.' },
  { key: 'friendMessage', label: 'Friends', help: "A note or a request from a friend, a friend's hub with a new key, a note that could not be delivered." },
];

/** What "Notify this device" says about itself, per state. */
export function deviceWords(state: DeviceNotifyState): string {
  const desktop = isDesktopApp();
  switch (state) {
    case 'checking':
      return desktop ? 'Checking this computer.' : 'Checking this browser.';
    case 'unsupported':
      return desktop ? 'This version of the desktop app cannot show notifications. Update it.' : 'This browser cannot get notifications. On an iPhone, add Conclave to the Home Screen and open it from there.';
    case 'insecure':
      return INSECURE_WORDS;
    case 'denied':
      return desktop ? 'Blocked in your system settings. Allow notifications for Conclave there.' : 'Blocked in the browser settings. Allow notifications for this site, then reload.';
    case 'on':
      return desktop ? 'This computer gets notifications while the desktop app runs, also from the tray.' : `${deviceName()} gets notifications, also while Conclave is closed.`;
    case 'off':
      return `${desktop ? 'This computer' : deviceName()} does not get notifications. Turn it on to hear about approvals and failures while Conclave is closed.`;
  }
}

export const ANDROID_NOTE = "It keeps its own connection to the hub and notifies you there, with Approve and Deny on approvals. Turn it on in the app's Settings.";

interface NotifyCfg {
  on?: Partial<NotifyOn>;
  idleSeconds?: number;
}

export function NotificationsSection() {
  const mobile = useIsMobile();
  const config = useHub((s) => s.config);
  const n = (config?.notifications ?? {}) as NotifyCfg;
  const on: NotifyOn = { ...NOTIFY_DEFAULTS, ...n.on };
  const size = mobile ? 'touch' : 'sm';
  const me = useDeviceNotify();
  const { list, mine } = useNotifyDevices();
  const others = list.filter((d) => d.id !== mine);
  const locked = me.state === 'unsupported' || me.state === 'insecure' || me.state === 'denied' || me.state === 'checking';

  const testView: ReactNode =
    me.test === 'sending' ? (
      <LiveStatus state="tool" label="Sending" />
    ) : me.test === 'sent' ? (
      <Outcome word="Sent" tone="ok">
        check this device
      </Outcome>
    ) : me.test === 'failed' ? (
      <Outcome word="Failed" tone="fault" />
    ) : null;

  return (
    <div className="space-y-9">
      <Group title="Devices">
        <SettingRow
          label="Notify this device"
          top
          help={
            <>
              {deviceWords(me.state)}
              {me.error && <span className="mt-1 block text-fault">{me.error}</span>}
            </>
          }
        >
          {/* the switch lines up with the other rows on wide screens and comes first on phones */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:flex-row-reverse md:justify-start">
            <OnOff label="Notify this device" size={size} checked={me.state === 'on'} disabled={locked || me.busy} onChange={(v) => void me.turn(v)} />
            {me.state === 'on' && (
              <Button variant="outline" size={size} disabled={me.test === 'sending' || me.busy} onClick={() => void me.sendTest()}>
                Send a test
              </Button>
            )}
            {testView}
          </div>
        </SettingRow>

        {others.map((d) => (
          <OtherDevice key={d.id} name={d.name} createdAt={d.createdAt} size={size} onRemove={() => removeNotifyDevice(d.id)} />
        ))}

        <SettingRow label="Android app" help={ANDROID_NOTE} />
      </Group>

      <Group title="Notify me about" help="These apply to every device. Approvals and questions also wait in the Inbox.">
        {NOTIFY_EVENTS.map((e) => (
          <SettingRow key={e.key} label={e.label} help={e.help}>
            <OnOff label={e.label} checked={on[e.key]} onChange={(v) => void save({ notifications: { on: { [e.key]: v } } })} size={size} />
          </SettingRow>
        ))}
      </Group>

      <Group title="While you are here">
        <SettingRow label="Hold notifications" help="While you are using Conclave on any device, only approvals, questions and failures go out. A window left alone for longer than this stops counting.">
          <Segmented
            label="Hold notifications"
            size={size}
            value={String(n.idleSeconds ?? 60)}
            onChange={(v) => void save({ notifications: { idleSeconds: Number(v) } })}
            options={[
              { value: '0', label: 'Never' },
              { value: '60', label: '1 min' },
              { value: '300', label: '5 min' },
            ]}
          />
        </SettingRow>
      </Group>
    </div>
  );
}

/** Another browser the hub notifies, with a way to stop it. Name and Remove stay on one line, also on phones. */
function OtherDevice({ name, createdAt, size, onRemove }: { name?: string; createdAt?: number; size: 'sm' | 'touch'; onRemove: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px]">{name || 'A browser'}</div>
        <div className="mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{createdAt ? `Gets notifications. Added ${shortDate(createdAt)}.` : 'Gets notifications.'}</div>
      </div>
      <Button
        variant="quiet"
        size={size}
        className="-mr-2 shrink-0 phone:-mr-3"
        busy={busy ? 'Removing' : false}
        onClick={async () => {
          setBusy(true);
          try {
            await onRemove();
          } catch (e) {
            toast({ title: `Could not remove it. ${errText(e)}`, level: 'error' });
            setBusy(false);
          }
        }}
      >
        Remove
      </Button>
    </div>
  );
}
