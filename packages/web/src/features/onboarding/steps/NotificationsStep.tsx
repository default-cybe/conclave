/**
 * Step 8, Notifications (spec 11.11). Notifications stay inside Conclave:
 * "Allow notifications" for this device with a test, a note for other
 * devices and the Android app, then what is worth a notification. Same
 * config keys and words as Settings > Notifications.
 */
import { useHub } from '@/store/store';
import { deviceName, isDesktopApp, useDeviceNotify, useNotifyDevices } from '@/lib/notify';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { SectionHeading } from '@/components/ui/Section';
import { save } from '@/features/settings/parts';
import { ANDROID_NOTE, deviceWords, NOTIFY_DEFAULTS, NOTIFY_EVENTS, type NotifyOn } from '@/features/settings/notifications';
import { StepFrame } from '../StepLayout';
import { andList, Footnote, OutcomeWords, SettingRow, useCtlSize, type Outcome } from '../parts';

interface NotifyCfg {
  on?: Partial<NotifyOn>;
  idleSeconds?: number;
}

export function NotificationsStep() {
  const ctl = useCtlSize();
  const config = useHub((s) => s.config);
  const n = (config?.notifications ?? {}) as NotifyCfg;
  const on: NotifyOn = { ...NOTIFY_DEFAULTS, ...n.on };
  const me = useDeviceNotify();
  const { list, mine } = useNotifyDevices();
  const others = list.filter((d) => d.id !== mine).map((d) => d.name || 'A browser');

  const outcome: Outcome =
    me.test === 'sending'
      ? { state: 'working', word: 'Sending' }
      : me.test === 'sent'
        ? { state: 'ok', word: 'Sent', detail: 'check this device' }
        : me.busy
          ? { state: 'working', word: isDesktopApp() ? 'Asking the system' : 'Asking the browser' }
          : { state: 'idle' };

  const here = isDesktopApp() ? 'This computer' : deviceName();
  const summary =
    me.state === 'on'
      ? `${here} gets notifications${others.length ? `, and ${others.length === 1 ? 'one more device' : `${others.length} more devices`}` : ''}.`
      : others.length
        ? `${andList(others)} ${others.length === 1 ? 'gets' : 'get'} notifications.`
        : 'No device yet. The Inbox still shows approvals and questions.';
  const idle = n.idleSeconds ?? 60;

  return (
    <StepFrame summary={summary}>
      <section>
        <SectionHeading>This device</SectionHeading>
        <div className="rows">
          <SettingRow
            label="Notify this device"
            help={
              <>
                {deviceWords(me.state)}
                {me.error && <span className="mt-1 block text-fault">{me.error}</span>}
              </>
            }
            top
          >
            <div className="flex min-h-[30px] flex-wrap items-center gap-x-4 gap-y-2 md:justify-end">
              {me.state === 'on' ? (
                <>
                  <span className="text-[13px] text-ok phone:text-[14px]">On</span>
                  <Button variant="outline" size={ctl} disabled={me.test === 'sending'} onClick={() => void me.sendTest()}>
                    Send a test
                  </Button>
                </>
              ) : (
                <Button variant="outline" size={ctl} onClick={() => void me.turn(true)} disabled={me.state !== 'off' || me.busy}>
                  Allow notifications
                </Button>
              )}
              <OutcomeWords outcome={outcome} />
            </div>
          </SettingRow>
        </div>
        <div className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Footnote title="Other computers and phones">Open Conclave on each one and turn on Notify this device there. Settings has the list.</Footnote>
          <Footnote title="Android app">{ANDROID_NOTE}</Footnote>
        </div>
      </section>

      <section className="mt-10">
        <SectionHeading>Notify me about</SectionHeading>
        <div className="grid gap-x-8 gap-y-1 pt-3 md:grid-cols-2">
          {NOTIFY_EVENTS.map((e) => (
            <Checkbox key={e.key} checked={on[e.key]} onChange={(v) => void save({ notifications: { on: { [e.key]: v } } })} label={e.label} description={e.help} className="py-1.5" />
          ))}
        </div>
        <p className="m-0 mt-4 text-[12px] text-fg-3 phone:text-[13px]">
          {idle > 0
            ? 'While you are using Conclave on any device, only approvals, questions and failures go out. Settings can change this.'
            : 'Notifications go out even while you are using Conclave. Settings can change this.'}
        </p>
      </section>
    </StepFrame>
  );
}
