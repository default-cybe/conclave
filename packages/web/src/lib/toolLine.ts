/**
 * The tool line on a phone (docs/design/MOBILE-V2.md 5): an assistant turn's
 * tool calls as one short sentence, "Read redirect.ts, edited it, ran bun
 * test and 4 more", and each call as a plain row (verb, file name, the
 * command) once the line opens. Pure: the transcript passes the calls in
 * the order they ran.
 */
import { fileName } from './format';

export interface ToolCall {
  name: string;
  input?: Record<string, unknown>;
}

/** Phrases the sentence shows before "and 4 more". */
export const SHOWN = 3;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/**
 * A command as people say it: the program and what it does, "bun test",
 * "git push", "npm run build". Past "cd dir &&" and VAR=value; a path to
 * the program is its name.
 */
export function shortCommand(command: string): string {
  const parts = command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const main = parts.find((p) => !/^(cd|export|set)\s/.test(p)) ?? parts[0] ?? command.trim();
  const words = main.split(/\s+/);
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const plain = (w: string | undefined) => !!w && /^[a-z][a-z0-9:-]*$/.test(w);
  const out = [fileName(words[0] ?? '')];
  if (plain(words[1])) {
    out.push(words[1]);
    if ((words[1] === 'run' || words[1] === 'exec' || words[1] === 'x') && plain(words[2])) out.push(words[2]);
  }
  return out.join(' ');
}

/** One call as a phrase: a verb, maybe what it acted on, and how several of its kind read together. */
interface Act {
  /** Calls with the same key in a row read as one phrase. */
  key: string;
  verb: string;
  /** What it acted on, as the sentence says it ("redirect.ts", "bun test"). */
  obj?: string;
  /** A file it acted on, so the next phrase about the same file says "it". */
  file?: string;
  /** The phrase for n calls or n different things ("read 3 files"). */
  many: (n: number) => string;
  /** Different things stay apart ("ran bun test, ran git push"); the same one again still reads once. */
  apart?: boolean;
}

const counted = (verb: string, one: string, more: string) => (n: number) => `${verb} ${n} ${n === 1 ? one : more}`;
const same = (text: string) => () => text;

function actOf(c: ToolCall): Act {
  const i = c.input ?? {};
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  const file = path ? fileName(path) : undefined;
  switch (c.name) {
    case 'Read':
    case 'NotebookRead':
      return { key: 'read', verb: 'read', obj: file, file: path, many: counted('read', 'file', 'files') };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { key: 'edit', verb: 'edited', obj: file, file: path, many: counted('edited', 'file', 'files') };
    case 'Write':
      return { key: 'write', verb: 'wrote', obj: file, file: path, many: counted('wrote', 'file', 'files') };
    case 'Bash':
      return { key: 'bash', verb: 'ran', obj: str(i.command) ? shortCommand(String(i.command)) : 'a command', many: counted('ran', 'command', 'commands'), apart: true };
    case 'Grep':
    case 'Glob': {
      const q = str(i.pattern);
      return { key: 'search', verb: 'searched', obj: q && q.length <= 24 ? `for ${q}` : 'the code', many: (n) => `searched ${n} times` };
    }
    case 'LS':
      return { key: 'list', verb: 'listed', obj: file ?? 'a folder', many: counted('listed', 'folder', 'folders') };
    case 'WebSearch':
      return { key: 'web', verb: 'searched the web', many: (n) => `searched the web ${n} times` };
    case 'WebFetch':
      return { key: 'fetch', verb: 'read', obj: host(str(i.url)) ?? 'a page', many: counted('read', 'page', 'pages') };
    case 'Browser':
      return { key: 'browse', verb: 'browsed', obj: host(str(i.url)) ?? 'the web', many: same('browsed the web') };
    case 'Task':
      return { key: 'agent', verb: 'ran a subagent', many: counted('ran', 'subagent', 'subagents') };
    case 'Delegate':
      return { key: 'delegate', verb: 'handed on a job', many: counted('handed on', 'job', 'jobs') };
    case 'Workflow':
      return { key: 'workflow', verb: 'ran a workflow', many: counted('ran', 'workflow', 'workflows') };
    case 'TodoWrite':
      return { key: 'plan', verb: 'updated the plan', many: same('updated the plan') };
    case 'AskUserQuestion':
      return { key: 'ask', verb: 'asked you', many: same('asked you') };
    case 'MemorySearch':
      return { key: 'recall', verb: 'checked memory', many: same('checked memory') };
    case 'MemorySave':
      return { key: 'save', verb: 'saved a note', many: counted('saved', 'note', 'notes') };
    case 'MemoryForget':
      return { key: 'forget', verb: 'retired a note', many: counted('retired', 'note', 'notes') };
    case 'Memory':
      return { key: 'memory', verb: 'used memory', many: same('used memory') };
    case 'Skill': {
      const skill = str(i.skill) ?? str(i.name);
      return { key: `skill:${skill}`, verb: 'used', obj: skill ? `the ${skill} skill` : 'a skill', many: same(skill ? `used the ${skill} skill` : 'used a skill') };
    }
    // maps (features/maps): the cards under the line say the rest
    case 'PlaceSearch': {
      const q = str(i.query) ?? str(i.type)?.replace(/_/g, ' ');
      const named = q && q.length <= 24 ? q : undefined;
      return { key: 'places', verb: named ? 'looked for' : 'looked for places', obj: named, many: (n) => `looked for places ${n} times` };
    }
    case 'PlaceDetails':
      return { key: 'place', verb: 'looked up a place', many: counted('looked up', 'place', 'places') };
    case 'Directions':
      return { key: 'route', verb: 'got directions', many: same('got directions') };
    case 'MapImage':
      return { key: 'map', verb: 'drew a map', many: counted('drew', 'map', 'maps') };
    // calendar and mail (docs/DESIGN.md 32): a proposal writes nothing, so the words say proposed
    case 'DayPlan':
      return { key: 'day', verb: i.save ? 'saved the day plan' : 'read the day', many: same(i.save ? 'saved the day plan' : 'read the day') };
    case 'CalendarList':
      return { key: 'calendar', verb: 'read the calendar', many: same('read the calendar') };
    case 'CalendarFreeBusy':
      return { key: 'freebusy', verb: 'found free time', many: same('found free time') };
    case 'CalendarEvent':
      return { key: 'propose-event', verb: 'proposed', obj: str(i.title) ?? 'an event change', many: counted('proposed', 'event', 'events') };
    case 'MailDraft':
      return { key: 'propose-mail', verb: 'proposed a message', many: counted('proposed', 'message', 'messages') };
    case 'MailSearch':
      return { key: 'mail', verb: 'searched mail', many: (n) => `searched mail ${n} times` };
    case 'MailRead':
      return { key: 'mail-read', verb: 'read', obj: 'a message', many: counted('read', 'message', 'messages') };
    // watches (features/watches): the cards under the line show the items
    case 'WatchReport':
      return { key: 'items', verb: 'found', obj: Array.isArray(i.items) ? `${i.items.length} ${i.items.length === 1 ? 'item' : 'items'}` : 'items', many: same('found items') };
    case 'WatchCreate':
      return { key: 'watch', verb: 'made a watch', many: counted('made', 'watch', 'watches') };
    case 'browser_navigate':
      return { key: 'browse', verb: 'browsed', obj: host(str(i.url)) ?? 'the web', many: same('browsed the web') };
  }
  if (c.name.startsWith('browser_')) return { key: 'browse', verb: 'browsed', obj: 'the web', many: same('browsed the web') };
  if (c.name.startsWith('mcp__')) {
    const [, server = '', ...rest] = c.name.split('__');
    const what = `${server} ${rest.join(' ')}`.trim();
    return { key: `mcp:${c.name}`, verb: 'used', obj: what, many: same(`used ${what}`) };
  }
  return { key: `tool:${c.name}`, verb: 'used', obj: c.name, many: same(`used ${c.name}`) };
}

interface Phrase {
  act: Act;
  /** Different things it acted on, in order. */
  objs: string[];
  /** Files it acted on. */
  files: string[];
  /** Calls without a thing of their own. */
  n: number;
}

/** Calls in a row of the same kind become one phrase: the same file once, different files counted. */
function phrases(calls: ToolCall[]): Phrase[] {
  const out: Phrase[] = [];
  for (const c of calls) {
    const act = actOf(c);
    const last = out[out.length - 1];
    if (last && last.act.key === act.key && (!act.apart || last.objs[0] === act.obj)) {
      if (act.obj !== undefined && !last.objs.includes(act.obj)) last.objs.push(act.obj);
      if (act.file && !last.files.includes(act.file)) last.files.push(act.file);
      if (act.obj === undefined) last.n++;
      continue;
    }
    out.push({ act, objs: act.obj !== undefined ? [act.obj] : [], files: act.file ? [act.file] : [], n: 1 });
  }
  return out;
}

function words(p: Phrase, prev: Phrase | undefined): string {
  if (p.objs.length > 1) return p.act.many(p.objs.length);
  if (!p.objs.length) return p.n > 1 ? p.act.many(p.n) : p.act.verb;
  // the same one file as the phrase before: "Read redirect.ts, edited it"
  const it = p.files.length === 1 && prev?.files.length === 1 && prev.files[0] === p.files[0] && prev.objs.length === 1;
  return `${p.act.verb} ${it ? 'it' : p.objs[0]}`;
}

/** The sentence for a turn's calls: "Read redirect.ts, edited it, ran bun test and 4 more". Empty without calls. */
export function toolLine(calls: ToolCall[]): string {
  const list = phrases(calls);
  if (!list.length) return '';
  const shown = list.slice(0, SHOWN).map((p, i) => words(p, list[i - 1]));
  const rest = list.length - shown.length;
  const text = shown.join(', ') + (rest > 0 ? ` and ${rest} more` : '');
  return text[0].toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// A group of calls as counts (docs/design/CHAT-AND-MOTION.md 6.3)
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** How calls of one kind read together: a key, what is counted (a distinct file, or each call), and the phrase. */
function countOf(c: ToolCall): { key: string; unit?: string; phrase: (n: number) => string } {
  const i = c.input ?? {};
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  switch (c.name) {
    case 'Bash':
      return { key: 'bash', phrase: (n) => `ran ${plural(n, 'command', 'commands')}` };
    case 'Read':
    case 'NotebookRead':
      return { key: 'read', unit: path, phrase: (n) => `read ${plural(n, 'file', 'files')}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { key: 'edit', unit: path, phrase: (n) => `edited ${plural(n, 'file', 'files')}` };
    case 'Write':
      return { key: 'write', unit: path, phrase: (n) => `wrote ${plural(n, 'file', 'files')}` };
    case 'Grep':
    case 'Glob':
      return { key: 'search', phrase: (n) => `searched ${times(n)}` };
    case 'LS':
      return { key: 'list', unit: path, phrase: (n) => `listed ${plural(n, 'folder', 'folders')}` };
    case 'WebSearch':
      return { key: 'web', phrase: (n) => `searched the web ${times(n)}` };
    case 'WebFetch':
      return { key: 'fetch', unit: str(i.url), phrase: (n) => `fetched ${plural(n, 'page', 'pages')}` };
    case 'Browser':
      return { key: 'browse', phrase: (n) => `used the browser ${times(n)}` };
    case 'Task':
      return { key: 'agent', phrase: (n) => `ran ${plural(n, 'subagent', 'subagents')}` };
    case 'Delegate':
      return { key: 'delegate', phrase: (n) => `handed on ${plural(n, 'job', 'jobs')}` };
    case 'TodoWrite':
      return { key: 'plan', phrase: () => 'updated the plan' };
    case 'Skill': {
      const skill = str(i.skill) ?? str(i.name);
      return { key: 'skill', unit: skill, phrase: (n) => (n === 1 && skill ? `used the ${skill} skill` : `used ${plural(n, 'skill', 'skills')}`) };
    }
    case 'MemorySearch':
      return { key: 'recall', phrase: (n) => `checked memory${n > 1 ? ` ${n} times` : ''}` };
    case 'MemorySave':
      return { key: 'save', phrase: (n) => `saved ${plural(n, 'note', 'notes')}` };
    case 'MemoryForget':
      return { key: 'forget', phrase: (n) => `retired ${plural(n, 'note', 'notes')}` };
    case 'Memory':
      return { key: 'memory', phrase: (n) => `used memory${n > 1 ? ` ${n} times` : ''}` };
  }
  if (c.name.startsWith('browser_')) return { key: 'browse', phrase: (n) => `used the browser ${times(n)}` };
  if (c.name.startsWith('mcp__')) {
    const server = c.name.split('__')[1] || 'a server';
    return { key: `mcp:${server}`, phrase: (n) => `used ${server}${n > 1 ? ` ${n} times` : ''}` };
  }
  return { key: `tool:${c.name}`, phrase: (n) => `used ${c.name}${n > 1 ? ` ${n} times` : ''}` };
}

/**
 * A group of calls as counts by kind, in the order each kind first ran:
 * "Ran 6 commands, read 2 files, searched 3 times, edited 1 file". Files
 * count once however often they were read or edited; commands and searches
 * count each call. Empty without calls.
 */
export function groupSummary(calls: readonly ToolCall[]): string {
  const kinds = new Map<string, { phrase: (n: number) => string; units: Set<string>; bare: number }>();
  for (const c of calls) {
    const k = countOf(c);
    let row = kinds.get(k.key);
    if (!row) kinds.set(k.key, (row = { phrase: k.phrase, units: new Set(), bare: 0 }));
    if (k.unit) row.units.add(k.unit);
    else row.bare++;
  }
  const parts = [...kinds.values()].map((r) => r.phrase(r.units.size + r.bare));
  const text = parts.join(', ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** "12s", "1m 24s": how long a model thought, the same words as a thought's row ("Thought for 12s"). */
export function thoughtTime(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One call as the phrase the tool line uses, lower case: "ran git log", "read auth.ts", "searched for jwt". */
export function callPhrase(c: ToolCall): string {
  const p = phrases([c])[0];
  return p ? words(p, undefined) : '';
}

/** A step of a stretch of work: a call, or a thought with how long it took (live while it still streams). */
export type WorkStep = { call: ToolCall } | { thought: { ms?: number; live?: boolean } };

/**
 * A stretch of work (the thoughts and calls between two pieces of prose) as
 * one summary: "Thought for 15s, ran git log", "Ran 6 commands, read 2
 * files, thought for 40s". The thinking is one phrase with its total time:
 * first when the work starts with a thought, else last. One call is named,
 * several are counted (groupSummary). "thinking" while a thought streams,
 * "reasoned" when no time is known. Empty without steps.
 */
export function workSummary(steps: readonly WorkStep[]): string {
  const calls = steps.flatMap((s) => ('call' in s ? [s.call] : []));
  const thoughts = steps.flatMap((s) => ('thought' in s ? [s.thought] : []));
  if (!thoughts.length) return groupSummary(calls);
  const ms = thoughts.reduce((n, t) => n + (t.ms ?? 0), 0);
  const thinking = thoughts.some((t) => t.live) ? 'thinking' : ms ? `thought for ${thoughtTime(ms)}` : 'reasoned';
  const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
  const doing = calls.length === 1 ? callPhrase(calls[0]) : lower(groupSummary(calls));
  const thoughtFirst = 'thought' in steps[0];
  const text = (thoughtFirst ? [thinking, doing] : [doing, thinking]).filter(Boolean).join(', ');
  return text[0].toUpperCase() + text.slice(1);
}

/** One call as a row of the opened line: the verb, then what it acted on. mono for a file name, a pattern or a command. */
export interface ToolRowWords {
  verb: string;
  target: string;
  mono: boolean;
}

export function toolRowWords(c: ToolCall): ToolRowWords {
  const i = c.input ?? {};
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  const file = path ? fileName(path) : '';
  switch (c.name) {
    case 'Read':
    case 'NotebookRead':
      return { verb: 'Read', target: file, mono: true };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'Edited', target: file, mono: true };
    case 'Write':
      return { verb: 'Wrote', target: file, mono: true };
    case 'Bash':
      return { verb: 'Ran', target: str(i.command) ?? '', mono: true };
    case 'Grep':
    case 'Glob':
      return { verb: 'Searched', target: str(i.pattern) ?? '', mono: true };
    case 'LS':
      return { verb: 'Listed', target: file, mono: true };
    case 'WebSearch':
      return { verb: 'Searched the web', target: str(i.query) ?? '', mono: false };
    case 'WebFetch':
      return { verb: 'Read', target: host(str(i.url)) ?? '', mono: false };
    case 'Browser':
      return { verb: 'Browsed', target: host(str(i.url)) ?? str(i.action) ?? '', mono: false };
    case 'Task':
      return { verb: 'Subagent', target: str(i.description) ?? '', mono: false };
    case 'Delegate':
      return { verb: i.to === 'assistant' ? 'Assistant' : 'Code', target: str(i.description) ?? '', mono: false };
    case 'Workflow':
      return { verb: 'Workflow', target: str(i.name) ?? str(i.description) ?? '', mono: false };
    case 'TodoWrite':
      return { verb: 'Planned', target: Array.isArray(i.todos) ? `${i.todos.length} ${i.todos.length === 1 ? 'step' : 'steps'}` : '', mono: false };
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) ? (i.questions[0] as { question?: string } | undefined)?.question : undefined;
      return { verb: 'Asked', target: q ?? '', mono: false };
    }
    case 'MemorySearch':
      return { verb: 'Checked memory', target: str(i.query) ?? '', mono: false };
    case 'MemorySave':
      return { verb: 'Saved a note', target: str(i.content) ?? '', mono: false };
    case 'MemoryForget':
      return { verb: 'Retired a note', target: '', mono: false };
    case 'Skill':
      return { verb: 'Skill', target: str(i.skill) ?? str(i.name) ?? '', mono: false };
    case 'PlaceSearch':
      return { verb: 'Searched places', target: str(i.query) ?? str(i.type)?.replace(/_/g, ' ') ?? '', mono: false };
    case 'PlaceDetails':
      return { verb: 'Looked up', target: 'a place', mono: false };
    case 'Directions': {
      const to = str(i.to);
      return { verb: 'Directions', target: to && !/^(ChIJ|osm:)/.test(to) ? `to ${to}` : 'to a place', mono: false };
    }
    case 'MapImage':
      return { verb: 'Drew', target: 'a map', mono: false };
    case 'DayPlan':
      return { verb: i.save ? 'Saved the day plan' : 'Read the day', target: str(i.guide) ? `${i.guide} guide` : '', mono: false };
    case 'CalendarList':
      return { verb: 'Read the calendar', target: str(i.from) ?? '', mono: false };
    case 'CalendarFreeBusy':
      return { verb: 'Found free time', target: Array.isArray(i.attendees) ? i.attendees.join(', ') : '', mono: false };
    case 'CalendarEvent':
      return { verb: i.action === 'delete' ? 'Proposed deleting' : i.action === 'update' ? 'Proposed a change' : 'Proposed', target: [str(i.title), str(i.start)?.replace('T', ' ')].filter(Boolean).join(', '), mono: false };
    case 'MailDraft':
      return { verb: 'Proposed a message', target: Array.isArray(i.to) ? i.to.join(', ') : '', mono: false };
    case 'MailSearch':
      return { verb: 'Searched mail', target: str(i.from) ?? str(i.query) ?? '', mono: false };
    case 'MailRead':
      return { verb: 'Read a message', target: '', mono: false };
    case 'WatchReport':
      return { verb: 'Found', target: Array.isArray(i.items) ? `${i.items.length} items` : 'items', mono: false };
    case 'WatchCreate':
      return { verb: 'Made a watch', target: str(i.name) ?? '', mono: false };
    case 'browser_navigate':
      return { verb: 'Browsed', target: host(str(i.url)) ?? '', mono: false };
  }
  if (c.name.startsWith('mcp__')) {
    const [, server = '', ...rest] = c.name.split('__');
    return { verb: 'Used', target: `${server} ${rest.join(' ')}`.trim(), mono: false };
  }
  return { verb: 'Used', target: c.name, mono: false };
}

/** An edit's change in lines: "+2 −0". */
export function changeWords(added: number, removed: number): string {
  return `+${added} −${removed}`;
}

/**
 * What a session is doing now, in a word or two for the working line:
 * "Running bun test", "Reading redirect.ts", "Searching the web". Without
 * a running call: "Working".
 */
export function workingWords(c: ToolCall | undefined): string {
  if (!c) return 'Working';
  const i = c.input ?? {};
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  const file = path ? fileName(path) : undefined;
  switch (c.name) {
    case 'Bash':
      return str(i.command) ? `Running ${shortCommand(String(i.command))}` : 'Running a command';
    case 'Read':
    case 'NotebookRead':
      return file ? `Reading ${file}` : 'Reading';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write':
      return file ? `Editing ${file}` : 'Editing';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'Searching';
    case 'WebSearch':
      return 'Searching the web';
    case 'WebFetch':
      return host(str(i.url)) ? `Reading ${host(str(i.url))}` : 'Reading';
    case 'Task':
      return 'Subagent working';
    case 'Delegate':
      return i.to === 'assistant' ? 'Assistant working' : 'Code working';
    case 'Workflow':
      return str(i.name) ? `Running ${i.name}` : 'Running a workflow';
    case 'TodoWrite':
      return 'Planning';
    case 'MemorySearch':
      return 'Checking memory';
    case 'MemorySave':
      return 'Saving to memory';
    case 'PlaceSearch':
      return 'Searching places';
    case 'PlaceDetails':
      return 'Looking up a place';
    case 'Directions':
      return 'Getting directions';
    case 'MapImage':
      return 'Drawing a map';
    case 'WatchReport':
      return 'Showing what it found';
    case 'WatchCreate':
      return 'Making the watch';
    case 'browser_navigate':
      return host(str(i.url)) ? `Opening ${host(str(i.url))}` : 'Browsing';
  }
  if (c?.name.startsWith('browser_')) return 'Reading the page';
  return 'Working';
}

/**
 * What a subagent is doing, from its latest call, for the row of its Task
 * call: the call running now in the present ("Running bun test", "Searching
 * for jwt", "Reading auth.ts"), else the last one it made in the past
 * ("Read auth.ts"). "Starting" before its first call.
 */
export function subagentNow(c: ToolCall | undefined, running: boolean): string {
  if (!c) return 'Starting';
  const i = c.input ?? {};
  if (running) {
    const q = str(i.pattern) ?? str(i.query);
    if ((c.name === 'Grep' || c.name === 'Glob') && q) return `Searching for ${q.length > 40 ? `${q.slice(0, 39)}…` : q}`;
    const w = workingWords(c);
    if (w !== 'Working') return w;
  }
  const r = toolRowWords(c);
  return [r.verb, r.target.split('\n')[0]].filter(Boolean).join(' ');
}

/**
 * What a workflow's agent is doing, from the last tool it called as the hub
 * sums it up ("Grep \"jwt\" in src", "Read /a/auth.ts", "Fetch https://…"),
 * in the words a subagent's row uses: "Searching for jwt", "Reading
 * auth.ts", "Reading caddyserver.com". A summary it does not know stays as
 * it is. waiting: the agent waits on your approval for that call.
 */
export function agentDoing(lastTool: string | undefined): { text: string; waiting: boolean } | undefined {
  let s = lastTool?.trim();
  if (!s) return undefined;
  const waiting = /^needs approval:\s*/i.test(s);
  if (waiting) s = s.replace(/^needs approval:\s*/i, '');
  return { text: doingWords(s), waiting };
}

function doingWords(s: string): string {
  const cut = (q: string) => (q.length > 40 ? `${q.slice(0, 39)}…` : q);
  const site = (u: string) => {
    try {
      return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host.replace(/^www\./, '') || u;
    } catch {
      return u;
    }
  };
  let m = /^(?:Grep|Glob)\s+"(.+?)"/.exec(s) ?? /^(?:Grep|Glob)\s+(\S+)/.exec(s);
  if (m) return `Searching for ${cut(m[1])}`;
  if ((m = /^Read\s+(\S+)$/.exec(s))) return `Reading ${fileName(m[1])}`;
  if ((m = /^(?:Edit|MultiEdit)\s+(\S+)/.exec(s))) return `Editing ${fileName(m[1])}`;
  if ((m = /^Write\s+(\S+)$/.exec(s))) return `Writing ${fileName(m[1])}`;
  if ((m = /^(?:Web)?Fetch\s+(\S+)$/.exec(s))) return `Reading ${site(m[1])}`;
  if ((m = /^(?:Search:|WebSearch)\s+(.+)$/.exec(s))) return `Searching the web for ${cut(m[1])}`;
  if ((m = /^Run:\s+(.+)$/.exec(s))) return `Running ${shortCommand(m[1])}`;
  if (/^(?:Search memory:|MemorySearch\b)/.test(s)) return 'Checking memory';
  return s;
}

/** A phrase as the end of a row's words: "Searching for jwt" in "explore: Find the auth code, searching for jwt". */
export function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
