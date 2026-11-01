/**
 * Settings > This computer, only inside the desktop app.
 *
 * The desktop app carries the daemon behind one switch, "Let the hub use this
 * computer". The switch itself lives on the app's own settings page: this
 * page is served by the hub, and a hub page that could turn the daemon on
 * would give a script on it a shell on this computer. So here the app only
 * lets us read the state (computer_status) and open its page (open_settings).
 * See packages/desktop/src-tauri/src/main.rs, grant_hub_ipc.
 */
import { useEffect, useState } from 'react';
import { useIsMobile } from '@/lib/hooks';
import { isDesktopApp } from '@/lib/notify';
import { Button } from '@/components/ui/Button';
import { LiveStatus } from '@/components/motion';
import { Group, Outcome, SettingRow } from './parts';

/** What the desktop app's computer_status returns (ComputerView in main.rs). */
export interface ComputerView {
  enabled: boolean;
  available: boolean;
  online: boolean;
  name?: string | null;
  version?: string | null;
  words: string;
  allows: string;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function tauriInvoke(): Invoke | undefined {
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } }; __TAURI_INTERNALS__?: { invoke?: Invoke } };
  return w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
}

export const ALLOWS = 'The hub can read and change your files here and run commands and coding tools as you.';

/** The section shows only in the desktop app. */
export const showComputerSection = (): boolean => isDesktopApp();

export function ComputerSection() {
  const mobile = useIsMobile();
  const [view, setView] = useState<ComputerView | 'loading' | 'old'>('loading');

  const load = async () => {
    const invoke = tauriInvoke();
    if (!invoke) return setView('old');
    setView('loading');
    try {
      setView(await invoke<ComputerView>('computer_status'));
    } catch {
      // a desktop app from before the switch has no such command for the hub page
      setView('old');
    }
  };
  useEffect(() => {
    void load();
    // the state changes from the app's own page; look again when we come back to it
    const again = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);

  const open = () => void tauriInvoke()?.('open_settings');
  const size = mobile ? 'touch' : 'sm';
  const v = typeof view === 'object' ? view : undefined;

  return (
    <div className="space-y-9">
      <Group title="Let the hub use this computer" help={v?.allows ?? ALLOWS}>
        <SettingRow label="State" help={v?.words}>
          {view === 'loading' ? (
            <LiveStatus state="tool" label="Checking" />
          ) : view === 'old' ? (
            <span className="text-[13px] text-fg-3 md:text-right">Update the desktop app to change this here.</span>
          ) : (
            <Outcome word={view.enabled ? (view.online ? 'On' : 'On, not online') : 'Off'} tone={view.enabled ? (view.online ? 'ok' : 'warn') : 'dim'} />
          )}
        </SettingRow>
        {v?.version && (
          <SettingRow label="Daemon version">
            <span className="font-mono text-[13px] text-fg">{v.version}</span>
          </SettingRow>
        )}
        {view !== 'old' && (
          <SettingRow
            label="Change it"
            help={
              v?.enabled
                ? "Opens the app's own settings, where the switch is. Off stops and removes the service, and this computer leaves the Devices page."
                : "Opens the app's own settings, where the switch is. On pairs this computer with this hub, with no second code."
            }
          >
            <Button variant="outline" size={size} onClick={open} disabled={!v}>
              {v?.enabled ? 'Turn off in the app' : 'Turn on in the app'}
            </Button>
          </SettingRow>
        )}
      </Group>
    </div>
  );
}
