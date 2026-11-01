/**
 * Where "Schedule a meeting here..." in a Code session's menu goes
 * (docs/design/MEETING-MODE.md 11.1): the form, with the session's device and
 * folder filled in.
 */
import type { Session } from '@conclave/core/types';

/** A Code session with a real folder (not a chat, a meeting, or the home folder). */
export const canScheduleHere = (s: Pick<Session, 'kind' | 'cwd'>) => s.kind !== 'chat' && s.kind !== 'meeting' && !!s.cwd && s.cwd !== '~' && s.cwd !== '/';

export const scheduleHere = (s: Pick<Session, 'device' | 'cwd'>) => `/meetings/new?${new URLSearchParams({ device: s.device, cwd: s.cwd ?? '' })}`;
