/**
 * ProactivePrefs: what the owner wants to hear about without asking, what
 * never, when messages may arrive and how they read. Stored as a profile
 * memory the assistant always sees; the hub holds routine messages outside
 * the hours. With no fields it reads them.
 */
import { PrefsError, renderPrefs } from '../assistant/prefs';
import type { ProactiveHow } from '../assistant/types';
import type { Tool } from './types';
import { fail } from './util';

export interface ProactivePrefsInput {
  tell?: string[];
  never?: string[];
  hours?: string;
  how?: ProactiveHow;
  timezone?: string;
}

const FIELDS = ['tell', 'never', 'hours', 'how', 'timezone'] as const;

export const ProactivePrefsTool: Tool<ProactivePrefsInput> = {
  name: 'ProactivePrefs',
  description: `Read or change the owner's proactive preferences: what to tell them without being asked, what never to bring up, when messages may arrive, and how they read. Change them when the owner gives feedback on a message you sent on your own, or says what they want to hear about.

- tell, never: the full new lists, one short line each. Keep the lines they did not ask to change. A one-time "not now" is not a "never".
- hours: when messages may arrive, "09:00-21:30". Outside it the hub holds routine messages until the hours start, except approvals, questions and failures.
- how: line (one brief line), list (a short list) or page (a full page when it needs one).
- timezone: an IANA name like Europe/Berlin, only when the owner states it.

This does not schedule any check. Use a routine for that. With no fields it reads the current preferences.`,
  inputSchema: {
    type: 'object',
    properties: {
      tell: { type: 'array', items: { type: 'string' } },
      never: { type: 'array', items: { type: 'string' } },
      hours: { type: 'string', description: '"09:00-21:30"' },
      how: { type: 'string', enum: ['line', 'list', 'page'] },
      timezone: { type: 'string' },
    },
    additionalProperties: false,
  },
  readOnly: (input) => !FIELDS.some((k) => input?.[k] !== undefined),
  summarize: (i) => (FIELDS.some((k) => i[k] !== undefined) ? 'Change proactive preferences' : 'Read proactive preferences'),
  async run(input, ctx) {
    const s = ctx.host.assistant;
    if (!s) return fail('Proactive preferences are not available on this hub.');
    try {
      const changing = FIELDS.some((k) => input[k] !== undefined);
      const prefs = changing ? (await s.setPrefs(input)).prefs : s.prefs.get();
      const tz = s.prefs.timezone();
      return { content: `${changing ? 'Saved. ' : ''}${renderPrefs(prefs, tz.zone)} Timezone from ${tz.source === 'set' ? 'the preferences' : tz.source === 'profile' ? 'profile memory' : 'the hub'}.` };
    } catch (err) {
      return fail(err instanceof PrefsError ? err.message : `Could not save them: ${(err as Error).message}`);
    }
  },
};
