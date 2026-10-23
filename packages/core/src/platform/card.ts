/**
 * The platform card: what every primary agent knows about Conclave itself
 * (docs/DESIGN.md 51). Two system blocks, both built from facts the engine
 * reads (platform/facts.ts):
 *
 * - the card: what Conclave is, the modes and hand-offs, where things live in
 *   the app, what an agent cannot do here, and how to answer "can you do X".
 *   Only the hub's name, version and place change it.
 * - the live block: this session's tools by group, its MCP servers, the
 *   devices online, the browser, and the accounts and models set up. It
 *   changes only when one of those does, never with the clock or a counter,
 *   so the cached prefix holds across turns.
 *
 * A subagent, a workflow step and a session that reads untrusted input get
 * two lines instead. Pure, so tests render it from plain facts.
 */
import { estimateTokens } from '../util/text';

/** Which switch a session belongs to in the app (web features/home/start.ts modeOf). */
export type Surface = 'chat' | 'assistant' | 'code';

export interface PlatformFacts {
  hub: {
    name: string;
    version: string;
    /** "Linux x64 in an LXC container (CT 100)". */
    where?: string;
  };
  surface: Surface;
  agent: string;
  /** The tools this session's requests carry, in order. */
  tools: string[];
  /** MCP servers whose tools this session has, loaded or behind ToolSearch. */
  mcpServers: string[];
  /** The account's computers: the hub first, then by name. */
  devices: Array<{ name: string; online: boolean; hub?: boolean }>;
  /**
   * ready: the session has the browser tools and the hub can start a browser.
   * missing: it has the tools, but no browser is installed on the hub.
   * none: no browser tools in this session.
   */
  browser: 'ready' | 'missing' | 'none';
  /** The default profile's engine when the browser is ready: CloakBrowser or Chromium. */
  browserEngine?: string;
  /** The model accounts set up, in the owner's order: "Claude plan (neu)", "Anthropic API key". */
  accounts: string[];
  /** Harness engines turned on: Claude Code, Codex. */
  engines: string[];
  defaultModel?: string;
  /** A member's session: the hub's settings, accounts and browser are the owner's. */
  member?: boolean;
}

/** The size the card and the live block together stay under (tested). */
export const CARD_TOKEN_CAP = 700;

const SURFACE_WORDS: Record<Surface, string> = {
  chat: 'a Chat',
  assistant: 'an Assistant session',
  code: 'a Code session',
};

/** Tool groups for the live block, in this order. */
const GROUPS: Array<{ label: string; has: (n: string) => boolean }> = [
  { label: 'files', has: (n) => ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'RepoMap'].includes(n) },
  { label: 'shell', has: (n) => n === 'Bash' },
  { label: 'web', has: (n) => n === 'WebSearch' || n === 'WebFetch' },
  { label: 'browser', has: (n) => n.startsWith('browser_') },
  { label: 'memory and past chats', has: (n) => ['MemorySearch', 'MemorySave', 'MemoryForget', 'SessionSearch', 'SessionRead'].includes(n) },
  { label: 'goals and day plans', has: (n) => n.startsWith('Goal') || n === 'DayPlan' || n === 'ProactivePrefs' },
  { label: 'calendar and mail', has: (n) => n.startsWith('Calendar') || n.startsWith('Mail') },
  { label: 'maps', has: (n) => ['PlaceSearch', 'PlaceDetails', 'Directions', 'MapImage'].includes(n) },
  { label: 'skills', has: (n) => n === 'Skill' || n === 'SkillManage' },
];

/** Tools the card names one by one, because the guidance points at them. */
const NAMED = ['Delegate', 'Task', 'Workflow', 'ScheduleRoutine', 'WatchCreate', 'Notify', 'Consult', 'ConclaveHelp'];

/** "files, shell, web, Delegate, Task" for a tool list. */
export function toolGroups(tools: string[]): string {
  const groups = GROUPS.filter((g) => tools.some(g.has)).map((g) => g.label);
  const named = NAMED.filter((n) => tools.includes(n));
  const mcp = tools.filter((n) => n.startsWith('mcp__')).length;
  const parts = [...groups, ...named];
  if (tools.includes('ToolSearch')) parts.push('MCP tools through ToolSearch');
  else if (mcp) parts.push(`${mcp} MCP ${mcp === 1 ? 'tool' : 'tools'}`);
  return parts.length ? parts.join(', ') : 'none';
}

function list(items: string[], max: number): string {
  return items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');
}

/** The static part. Its only inputs are the hub line, whether ConclaveHelp is here and whether a member asks. */
export function cardText(f: Pick<PlatformFacts, 'hub' | 'tools' | 'member'>): string {
  const where = f.hub.where ? `, on ${f.hub.where}` : '';
  const help = f.tools.includes('ConclaveHelp')
    ? 'For how Conclave works or how to set something up, call ConclaveHelp first; do not guess.'
    : 'For how Conclave works, say what you are unsure of rather than guess.';
  const settings = f.member
    ? '- Settings: your account and your own provider keys. The hub, its browser and its accounts are the owner\'s.'
    : [
        '- Settings > Models: Providers, Subscriptions (Claude, ChatGPT, Google plans), Accounts (order, budgets, the Window starter), Refusal fallback, Defaults.',
        '- Settings > Browser (profiles, saved logins, CloakBrowser, a proxy only when asked), GitHub (repo sessions that end in a pull request), Remote access, Notifications, Permissions, People.',
      ].join('\n');
  return [
    '# Conclave',
    `You run in Conclave, the owner's self-hosted agent hub: their chats, agents, memory, devices and schedules in one app. This hub: ${f.hub.name}, Conclave ${f.hub.version}${where}.`,
    '',
    'Modes: Chat is a plain conversation with the web and memory. Assistant runs on the hub for the owner\'s day, goals, mail, calendar, browser and watches. Code works in a folder on a device. Delegate sends a job to Code or the Assistant on a named device and returns the answer here. Task runs a subagent (explore, reviewer, researcher and more). Workflow runs a script that fans work out to many agents and checks the results.',
    '',
    'Where things are in the app:',
    '- Memory (facts, past chats, Import of Claude Code, Codex, claude.ai and ChatGPT chats), Routines (schedules and watches), Workflows, Inbox (approvals, questions, alerts), Usage (spend and limits), Devices (computers running the desktop app or the daemon), Extensions (MCP servers, skills, plugins, hooks), Agents, Friends.',
    '- The model picker in the composer switches models and shows the price first.',
    settings,
    '',
    'You cannot change settings, keys, sign-ins or device pairing, or install software on the hub: the owner does that in the app, so name the page.',
    '',
    `When the owner asks "can you do X", answer from this card and your tools. If a feature can do it, use it (Delegate, Task, Workflow, the browser, a routine) instead of telling them to do it by hand, within permissions. ${help}`,
  ].join('\n');
}

/** What this session lacks that another mode has, and where Delegate sends it. */
function missingLine(f: PlatformFacts): string | undefined {
  const t = new Set(f.tools);
  const code: string[] = [];
  const assistant: string[] = [];
  if (!t.has('Read') && !t.has('Bash')) code.push('files and the shell');
  if (!t.has('Workflow')) code.push('workflows');
  if (f.browser === 'none') assistant.push('the browser');
  if (!t.has('ScheduleRoutine')) assistant.push('routines');
  if (!t.has('WatchCreate')) assistant.push('watches');
  if (f.member) assistant.length = 0;
  const all = [...code, ...assistant, ...(t.has('Task') ? [] : ['subagents'])];
  if (!all.length) return undefined;
  if (!t.has('Delegate')) return `- Not in this session: ${all.join(', ')}.`;
  const to = [code.length ? `Code (${code.join(', ')})` : '', assistant.length ? `the Assistant (${assistant.join(', ')})` : ''].filter(Boolean);
  return `- Not in this session: ${all.join(', ')}.${to.length ? ` Delegate hands those to ${to.join(' or ')}.` : ''}`;
}

/** The live part: this session's tools and what is set up now. */
export function liveText(f: PlatformFacts): string {
  const lines = ['# Conclave right now', `- This is ${SURFACE_WORDS[f.surface]} with the ${f.agent} agent. Tools: ${toolGroups(f.tools)}.`];
  const missing = missingLine(f);
  if (missing) lines.push(missing);
  lines.push(`- MCP servers: ${f.mcpServers.length ? list(f.mcpServers, 8) : 'none connected'}.`);
  const online = f.devices.filter((d) => d.online).map((d) => (d.hub ? `${d.name} (the hub)` : d.name));
  const offline = f.devices.filter((d) => !d.online).map((d) => d.name);
  lines.push(`- Devices online: ${online.length ? list(online, 8) : 'none'}.${offline.length ? ` Offline: ${list(offline, 6)}.` : ''}`);
  if (f.browser === 'ready') lines.push(`- Browser: ready on the hub${f.browserEngine ? ` (${f.browserEngine})` : ''}.`);
  else if (f.browser === 'missing') lines.push('- Browser: no browser is installed on the hub yet; the owner adds one in Settings > Browser.');
  if (!f.member) {
    const models = [f.defaultModel ? `default ${f.defaultModel}` : '', f.accounts.length ? `accounts ${list(f.accounts, 6)}` : 'no accounts set up yet', f.engines.length ? `engines ${f.engines.join(', ')}` : ''].filter(Boolean);
    lines.push(`- Models: ${models.join('; ')}.`);
  }
  return lines.join('\n');
}

/** The card and the live block for a primary session. */
export function platformCard(f: PlatformFacts): { card: string; live: string } {
  return { card: cardText(f), live: liveText(f) };
}

/** Two lines for a subagent, a workflow step or an untrusted session: where it runs, and who talks to the owner. */
export function subagentNote(f: Pick<PlatformFacts, 'hub' | 'tools'>, why: 'subagent' | 'untrusted'): string {
  const second =
    why === 'subagent'
      ? 'You are a subagent: do the brief and report back; the session that started you talks to the owner.'
      : 'This session reads outside content, so it knows only its own tools; the owner\'s other sessions do the rest.';
  const help = f.tools.includes('ConclaveHelp') ? ' ConclaveHelp searches the Conclave docs.' : '';
  return `# Conclave\nYou run in Conclave, the owner's self-hosted agent hub (${f.hub.name}, Conclave ${f.hub.version}). ${second}${help}`;
}

/** Token estimate of the card and its live block, as the cap counts it. */
export function cardTokens(c: { card: string; live: string }): number {
  return estimateTokens(`${c.card}\n\n${c.live}`);
}
