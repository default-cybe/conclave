/**
 * Proactive preferences (Muse's PROACTIVE_PREFERENCES.md, kept in Conclave
 * memory): what is worth a message, what never is, when messages may arrive
 * and how they read. Stored in kv and rendered as one profile memory for the
 * assistant agent, so it is in the assistant's system prompt on every turn.
 * An edit to that memory on the Memory page is parsed back on the next read.
 *
 * The heartbeat checklist lives here too: one procedure memory for the
 * assistant, tagged heartbeat-checklist, that the owner and the assistant
 * both edit.
 */
import type { KvRepo } from '../storage/repos';
import type { MemoryEntry } from '../types';
import type { MemoryService } from '../memory/types';
import { redactSecrets } from '../memory/secrets';
import { DEFAULT_PREFS, PROACTIVE_HOW_LABEL, type PrefsPatch, type ProactiveHow, type ProactivePrefs, type TimezoneSource } from './types';
import { hubZone, insideHours, nextOpening, validHhmm, validZone, zoneIn } from './time';

export const PREFS_KEY = 'assistant.prefs';
const PREFS_MEMORY_KEY = 'assistant.prefs.memoryId';
const CHECKLIST_KEY = 'assistant.heartbeat.checklist';
export const PREFS_TAG = 'proactive-preferences';
export const CHECKLIST_TAG = 'heartbeat-checklist';
/** The agent whose profile holds the preferences. */
export const ASSISTANT_AGENT = 'assistant';

const HOW_WORDS: Record<ProactiveHow, string> = { line: 'one brief line', list: 'a short list', page: 'a full page when it needs one' };

/** The checklist a new heartbeat starts with. */
export const DEFAULT_CHECKLIST = `Heartbeat checklist
- A task due in the next 2 hours that is not started yet.
- A goal whose target date is today or tomorrow, or has passed.
- A uni deadline, exam or registration within 3 days that has no task yet.
- Something I asked to be reminded about today.`;

export class PrefsError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
  }
}

function list(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new PrefsError(`${field} must be a list of short lines.`);
  const out = [...new Set((v as string[]).map((x) => redactSecrets(x.replace(/[;\n]+/g, ',').replace(/\s+/g, ' ').trim().replace(/\.$/, ''))).filter(Boolean))];
  if (out.length > 20) throw new PrefsError(`${field} has more than 20 lines. Keep the ones that matter.`);
  for (const x of out) if (x.length > 160) throw new PrefsError(`A line in ${field} is longer than 160 characters.`);
  return out;
}

/** Check and merge a partial update. Throws PrefsError with a sentence. */
export function mergePrefs(cur: ProactivePrefs, patch: PrefsPatch): ProactivePrefs {
  const next: ProactivePrefs = { ...cur, hours: { ...cur.hours } };
  if (patch.tell !== undefined) next.tell = list(patch.tell, 'tell');
  if (patch.never !== undefined) next.never = list(patch.never, 'never');
  if (patch.hours !== undefined) {
    const h = typeof patch.hours === 'string' ? parseHours(patch.hours) : (patch.hours as { start?: unknown; end?: unknown } | null);
    if (!h || !validHhmm(h.start) || !validHhmm(h.end)) throw new PrefsError('hours needs a start and an end like 09:00 and 21:30.');
    next.hours = { start: h.start, end: h.end };
  }
  if (patch.how !== undefined) {
    if (typeof patch.how !== 'string' || !Object.hasOwn(PROACTIVE_HOW_LABEL, patch.how)) throw new PrefsError('how must be line, list or page.');
    next.how = patch.how;
  }
  if (patch.timezone !== undefined) {
    const tz = typeof patch.timezone === 'string' ? patch.timezone.trim() : '';
    if (tz && !validZone(tz)) throw new PrefsError(`${tz} is not a timezone. Use a name like Europe/Berlin.`);
    if (tz) next.timezone = tz;
    else delete next.timezone;
  }
  return next;
}

/** "09:00-21:30", "9:00 to 21:30". */
export function parseHours(s: string): { start: string; end: string } | undefined {
  const m = /(\d{1,2}):(\d{2})\s*(?:-|to|and|until)\s*(\d{1,2}):(\d{2})/i.exec(s);
  if (!m) return undefined;
  const pad = (h: string, mi: string) => `${h.padStart(2, '0')}:${mi}`;
  const out = { start: pad(m[1], m[2]), end: pad(m[3], m[4]) };
  return validHhmm(out.start) && validHhmm(out.end) ? out : undefined;
}

/** The profile memory text. Plain sentences, parsed back by parsePrefsText. */
export function renderPrefs(p: ProactivePrefs, zone: string): string {
  const tell = p.tell.length ? p.tell.join('; ') : 'nothing set, so only what is urgent and time-bound';
  const never = p.never.length ? p.never.join('; ') : 'nothing set';
  return `Proactive preferences. Tell me about: ${tell}. Never tell me about: ${never}. Messages only between ${p.hours.start} and ${p.hours.end} (${zone}); outside that they wait, except approvals, questions and failures. How: ${HOW_WORDS[p.how]}.`;
}

/** Read the profile memory text back. Undefined when it does not look like one. */
export function parsePrefsText(text: string): Partial<ProactivePrefs> | undefined {
  if (!/proactive preferences/i.test(text)) return undefined;
  const labels: Array<{ key: 'tell' | 'never' | 'hours' | 'how'; re: RegExp }> = [
    { key: 'tell', re: /(?<!never\s)\btell me about:/i },
    { key: 'never', re: /\bnever tell me about:/i },
    { key: 'hours', re: /\bmessages only between\b/i },
    { key: 'how', re: /\bhow:/i },
  ];
  const found = labels
    .map((l) => {
      const m = l.re.exec(text);
      return m ? { key: l.key, at: m.index, end: m.index + m[0].length } : undefined;
    })
    .filter((x): x is { key: 'tell' | 'never' | 'hours' | 'how'; at: number; end: number } => !!x)
    .sort((a, b) => a.at - b.at);
  const value: Partial<Record<'tell' | 'never' | 'hours' | 'how', string>> = {};
  found.forEach((f, i) => (value[f.key] = text.slice(f.end, found[i + 1]?.at ?? text.length).trim().replace(/[.\s]+$/, '')));
  const items = (v: string | undefined) => (v === undefined ? undefined : /^nothing set/i.test(v) || !v ? [] : v.split(/;|\n/).map((x) => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean));
  const out: Partial<ProactivePrefs> = {};
  const tell = items(value.tell);
  const never = items(value.never);
  if (tell) out.tell = tell;
  if (never) out.never = never;
  if (value.hours !== undefined) {
    const h = parseHours(value.hours);
    if (h) out.hours = h;
  }
  const how = value.how?.toLowerCase() ?? '';
  if (/line/.test(how)) out.how = 'line';
  else if (/page/.test(how)) out.how = 'page';
  else if (/list/.test(how)) out.how = 'list';
  return Object.keys(out).length ? out : undefined;
}

type PrefsMemory = Pick<MemoryService, 'save' | 'update' | 'get' | 'list' | 'remove'>;

export interface PrefsServiceOptions {
  kv: KvRepo;
  memory: PrefsMemory;
  now?: () => number;
  /** The hub's zone. Default from Intl. */
  hubZone?: () => string;
}

export class PrefsService {
  private kv: KvRepo;
  private memory: PrefsMemory;
  private now: () => number;
  private hub: () => string;

  constructor(opts: PrefsServiceOptions) {
    this.kv = opts.kv;
    this.memory = opts.memory;
    this.now = opts.now ?? Date.now;
    this.hub = opts.hubZone ?? hubZone;
  }

  private stored(): ProactivePrefs {
    const raw = this.kv.get<Partial<ProactivePrefs> | null>(PREFS_KEY, null);
    return { ...DEFAULT_PREFS, ...(raw ?? {}), hours: { ...DEFAULT_PREFS.hours, ...(raw?.hours ?? {}) }, tell: raw?.tell ?? [], never: raw?.never ?? [] };
  }

  private memoryRow(): MemoryEntry | undefined {
    const id = this.kv.get<string>(PREFS_MEMORY_KEY, '');
    const byId = id ? this.memory.get(id) : undefined;
    if (byId) return byId;
    return this.memory.list({ scope: 'agent', scopeKey: ASSISTANT_AGENT, kind: 'profile', limit: 200 }).find((m) => m.tags.includes(PREFS_TAG));
  }

  /** The preferences, after taking in an edit made to the memory on the Memory page. */
  get(): ProactivePrefs {
    const p = this.stored();
    const row = this.memoryRow();
    if (row && row.content !== renderPrefs(p, this.zoneFor(p).zone)) {
      const parsed = parsePrefsText(row.content);
      if (parsed) {
        try {
          const merged = mergePrefs(p, parsed);
          this.kv.set(PREFS_KEY, merged);
          return merged;
        } catch {
          /* an edit that does not parse keeps the stored preferences */
        }
      }
    }
    return p;
  }

  /** Save a partial update and refresh the profile memory. */
  async set(patch: PrefsPatch): Promise<ProactivePrefs> {
    const next = mergePrefs(this.get(), patch);
    this.kv.set(PREFS_KEY, next);
    await this.writeMemory(next);
    return next;
  }

  /** Make sure the profile memory exists and matches (first start, or after the owner deleted it). */
  async ensureMemory(): Promise<void> {
    if (!this.kv.get<unknown>(PREFS_KEY, null)) return;
    const p = this.get();
    const row = this.memoryRow();
    if (!row || row.content !== renderPrefs(p, this.zoneFor(p).zone)) await this.writeMemory(p);
  }

  private async writeMemory(p: ProactivePrefs): Promise<void> {
    const content = renderPrefs(p, this.zoneFor(p).zone);
    const row = this.memoryRow();
    if (row) {
      if (row.content !== content) await this.memory.update(row.id, { content });
      this.kv.set(PREFS_MEMORY_KEY, row.id);
      return;
    }
    const saved = await this.memory.save({ content, kind: 'profile', scope: 'agent', scopeKey: ASSISTANT_AGENT, tags: [PREFS_TAG], importance: 0.9 });
    this.kv.set(PREFS_MEMORY_KEY, saved.id);
  }

  /** The owner's zone: set in the preferences, else named in profile memory, else the hub's. */
  timezone(): { zone: string; source: TimezoneSource } {
    return this.zoneFor(this.stored());
  }

  private zoneFor(p: ProactivePrefs): { zone: string; source: TimezoneSource } {
    if (p.timezone && validZone(p.timezone)) return { zone: p.timezone, source: 'set' };
    const profiles = this.memory.list({ scope: 'global', kind: 'profile', limit: 100 });
    for (const m of profiles) {
      const z = zoneIn(m.content);
      if (z) return { zone: z, source: 'profile' };
    }
    const hub = this.hub();
    return { zone: validZone(hub) ? hub : 'UTC', source: 'hub' };
  }

  /** Quiet hours now, and when they end. */
  quiet(ts = this.now()): { now: boolean; until?: number } {
    const p = this.get();
    const { zone } = this.zoneFor(p);
    if (insideHours(ts, p.hours, zone)) return { now: false };
    return { now: true, until: nextOpening(ts, p.hours, zone) };
  }

  // -------------------------------------------------------------------------
  // heartbeat checklist
  // -------------------------------------------------------------------------

  private checklistRow(): MemoryEntry | undefined {
    return this.memory
      .list({ scope: 'agent', scopeKey: ASSISTANT_AGENT, kind: 'procedure', limit: 200 })
      .filter((m) => m.tags.includes(CHECKLIST_TAG))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /** The checklist note: the memory when there is one, else the last saved text, else the default. */
  checklist(): { id?: string; text: string } {
    const row = this.checklistRow();
    if (row) return { id: row.id, text: row.content };
    // never set: the default. Cleared on purpose: empty, so the heartbeat skips
    return { text: this.kv.get<string | null>(CHECKLIST_KEY, null) ?? DEFAULT_CHECKLIST };
  }

  async setChecklist(text: string): Promise<{ id?: string; text: string }> {
    const t = redactSecrets(String(text ?? '').replace(/\r\n/g, '\n').trim());
    if (t.length > 4000) throw new PrefsError('The checklist is longer than 4000 characters. Keep one check per line.');
    this.kv.set(CHECKLIST_KEY, t);
    const row = this.checklistRow();
    if (row) {
      if (!t) {
        // clearing the checklist removes its note; otherwise the old note would still be read
        for (const m of this.memory.list({ scope: 'agent', scopeKey: ASSISTANT_AGENT, kind: 'procedure', limit: 200 }).filter((x) => x.tags.includes(CHECKLIST_TAG))) await this.memory.remove(m.id);
        return { text: '' };
      }
      const e = await this.memory.update(row.id, { content: t });
      return { id: e?.id ?? row.id, text: t };
    }
    if (!t) return { text: '' };
    const saved = await this.memory.save({ content: t, kind: 'procedure', scope: 'agent', scopeKey: ASSISTANT_AGENT, tags: [CHECKLIST_TAG], importance: 0.6 });
    return { id: saved.id.startsWith('ext:') ? undefined : saved.id, text: t };
  }
}
