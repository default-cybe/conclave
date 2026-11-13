/**
 * Security, Canvas and Meetings can be hidden per account (Settings,
 * Appearance, Modes; asked in setup). The choice lives on the hub with the
 * account's preferences (GET/PATCH /api/me preferences.modes), so every
 * device of the person agrees. Off only hides the mode's ways in: its
 * sessions still open, a link to one says the mode is off, and the hub still
 * serves its APIs. Meetings is a feature, not a mode of the switch: off
 * hides its sidebar row, its Settings section and the desktop overlay, and
 * the hub skips its background work.
 */
import { useEffect, useMemo } from 'react';
import { Link } from 'wouter';
import { modeOn, type MePreferences, type ModesPreference, type OptionalMode } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { Notice } from '@/components/ui/Section';
import { ipc } from '@/overlay/desktop';
import { setStartMode, START_MODES, useStartMode, type StartMode } from './start';

export const MODE_WORDS: Record<OptionalMode, { label: string; line: string }> = {
  security: { label: 'Security', line: 'For security research: scoped hunts, recon, findings.' },
  canvas: { label: 'Canvas', line: 'Build programs and workflows as blocks.' },
  meetings: { label: 'Meetings', line: 'Live transcripts, answers and notes for your calls.' },
};

/** The boxes in setup and Settings, in order. */
export const OPTIONAL_MODES: OptionalMode[] = ['security', 'canvas', 'meetings'];

const optional = (m: StartMode): m is 'security' | 'canvas' => m === 'security' || m === 'canvas';

/** The switch's modes this person sees: Chat, Assistant and Code always, Security and Canvas when on. */
export const shownModes = (prefs: Pick<MePreferences, 'modes'> | undefined) => START_MODES.filter((m) => !optional(m.value) || modeOn(prefs, m.value));

/** The mode the sidebar lists and its New starts: the open one, or Chat when that is a mode turned off (a hunt or Canvas opened by a link). */
export const listedMode = (mode: StartMode, prefs: Pick<MePreferences, 'modes'> | undefined): StartMode => (optional(mode) && !modeOn(prefs, mode) ? 'chat' : mode);

export const useModeOn = (mode: OptionalMode): boolean => useHub((s) => modeOn(s.me?.preferences, mode));

export function useShownModes() {
  const prefs = useHub((s) => s.me?.preferences);
  return useMemo(() => shownModes(prefs), [prefs]);
}

/** An account from before the setting: nothing saved, both on. Home says once that they can be turned off. The hub always sends meetings, so look at security. */
export const useModesNote = (): boolean => useHub((s) => !!s.me && s.me.preferences?.modes?.security === undefined);

/** Show or hide modes: at once on screen, then on the hub; a refusal puts the old ones back. */
export async function saveModes(patch: Partial<ModesPreference>): Promise<void> {
  const me = useHub.getState().me;
  if (!me) return;
  const before = me.preferences.modes;
  const put = (modes: Partial<ModesPreference> | undefined) => {
    const now = useHub.getState().me;
    if (now) useHub.setState({ me: { ...now, preferences: { ...now.preferences, modes } } });
  };
  put({ security: modeOn(me.preferences, 'security'), canvas: modeOn(me.preferences, 'canvas'), meetings: modeOn(me.preferences, 'meetings'), ...patch });
  if (!(await attempt(() => api().updateMe({ modes: patch })))) put(before);
}

/** A mode turned off (here or on another device) is not the one New starts: the switch goes back to Chat. */
export function useModeGuard() {
  const mode = useStartMode((s) => s.mode);
  const prefs = useHub((s) => s.me?.preferences);
  useEffect(() => {
    if (prefs && optional(mode) && !modeOn(prefs, mode)) setStartMode('chat');
  }, [mode, prefs]);
  // the desktop app's ways into Meetings (its tray items and the overlay hotkey) follow the setting; an older app has no such command
  const meetings = prefs ? modeOn(prefs, 'meetings') : undefined;
  useEffect(() => {
    if (meetings !== undefined) void ipc.enabled(meetings)?.catch(() => undefined);
  }, [meetings]);
}

/** Home, once, for an account from before the setting: both stay on, and where to turn them off. Got it saves both as on, so it does not come back. */
export function ModesNote({ className }: { className?: string }) {
  const show = useModesNote();
  if (!show) return null;
  return (
    <Notice className={className} action={{ label: 'Got it', onClick: () => void saveModes({}) }}>
      Security, Canvas and Meetings can be turned off in{' '}
      <Link href="/settings/appearance#modes" className="link" onClick={() => void saveModes({})}>
        Settings, Appearance
      </Link>
      , if you do not use them.
    </Notice>
  );
}

/** On a page of a mode that is off (a link to Canvas or to a hunt): one line saying so, and a way to turn it on. */
export function ModeOffNote({ mode, className }: { mode: OptionalMode; className?: string }) {
  const on = useModeOn(mode);
  if (on) return null;
  return (
    <Notice className={className} action={{ label: 'Turn it on', onClick: () => void saveModes({ [mode]: true }) }}>
      {MODE_WORDS[mode].label} is off in Settings.
    </Notice>
  );
}
