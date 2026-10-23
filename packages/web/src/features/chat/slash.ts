/**
 * The "/" menu of a session composer, as in Claude Code: Commands (built
 * in), Skills (what this session's agent can load, each run through the
 * Skill tool as /<name> args) and Custom (the hub's and plugins' commands).
 * Settings commands (/mcp, /hooks, /permissions, /agents, /skills, /model,
 * /memory, /context, /cost, /status, /resume, /help) open a sheet over the
 * session; the others run, or wait for their arguments.
 *
 * A session in Chat mode (no tools) keeps a smaller set: no coding
 * commands and no skills. This file is logic only; Composer.tsx draws it.
 */
import type { AgentDef, CommandDef, SkillDef } from '@conclave/core/extensions/types';
import { fuzzy } from '@/lib/text';

export type SlashSection = 'commands' | 'skills' | 'custom';
export type SlashMode = 'code' | 'chat';

/** The sheets a command opens over the session (SessionSheets.tsx). */
export type SheetId = 'help' | 'mcp' | 'hooks' | 'permissions' | 'agents' | 'skills' | 'model' | 'memory' | 'context' | 'cost' | 'status' | 'resume';

export interface SlashItem {
  name: string;
  description: string;
  /** <x> is needed, [x] may follow. */
  arg?: string;
  section: SlashSection;
  /** Where a skill or a custom command comes from: a plugin or a folder. */
  source?: string;
  /** Opens this sheet (with no argument, for a command that also takes one). */
  sheet?: SheetId;
  /** Other names it answers to when typed in full (/agent for /agents). */
  aliases?: string[];
  /** The row that shows the rest of the commands, with how many it hides. */
  more?: number;
}

/** The commands a bare "/" lists first, so skills show without scrolling. The rest are one row away. */
export const TOP_COMMANDS = ['clear', 'compact', 'context', 'help', 'mcp', 'model', 'permissions', 'resume'];
/** Phones have room for fewer before the skills. */
export const PHONE_TOP_COMMANDS = ['compact', 'context', 'help', 'mcp', 'model'];

/**
 * What the menu lists for what follows "/". Typing searches everything. A
 * bare "/" lists the top commands, a row for the rest, then every skill and
 * custom command; `all` lists every command.
 */
export function menuList(items: SlashItem[], query: string, all = false, first: string[] = TOP_COMMANDS): SlashItem[] {
  if (query.trim()) return filterSlash(items, query);
  if (all) return items;
  const commands = items.filter((it) => it.section === 'commands');
  const top = commands.filter((it) => first.includes(it.name));
  const hidden = commands.filter((it) => !first.includes(it.name)).map((it) => it.name);
  // a few of them by name, the ones people look for first
  const named = ['agents', 'hooks', 'skills', 'memory', 'cost', 'status', 'export'].filter((n) => hidden.includes(n)).slice(0, 4);
  const more: SlashItem[] = hidden.length ? [{ name: 'more', description: named.map((n) => `/${n}`).join(', '), section: 'commands', more: hidden.length }] : [];
  return [...top, ...more, ...items.filter((it) => it.section !== 'commands')];
}

export const SECTION_WORDS: Record<SlashSection, string> = { commands: 'Commands', skills: 'Skills', custom: 'Custom' };

/** The titles of the sheets. /mcp opens Connectors. */
export const SHEET_TITLES: Record<SheetId, string> = {
  help: 'Commands',
  mcp: 'Connectors',
  hooks: 'Hooks',
  permissions: 'Permissions',
  agents: 'Agents',
  skills: 'Skills',
  model: 'Model',
  memory: 'Memory',
  context: 'Context',
  cost: 'Cost',
  status: 'Status',
  resume: 'Resume',
};

type Builtin = Omit<SlashItem, 'section'> & { modes: SlashMode[] };

const BOTH: SlashMode[] = ['code', 'chat'];
const CODE: SlashMode[] = ['code'];

/** Built-in commands, by name. Claude Code's names and words where Conclave has the same thing. */
const BUILTINS: Builtin[] = [
  { name: 'agents', description: 'Pick the agent for this session', arg: '[name]', sheet: 'agents', aliases: ['agent'], modes: CODE },
  { name: 'clear', description: 'Start a new session with the same settings', modes: BOTH },
  { name: 'compact', description: 'Summarize older messages to free context', arg: '[instructions]', modes: BOTH },
  { name: 'context', description: 'What fills the context now', sheet: 'context', modes: CODE },
  { name: 'cost', description: 'Tokens and cost of this session', sheet: 'cost', modes: BOTH },
  { name: 'cwd', description: 'Change the working folder', arg: '<path>', modes: CODE },
  { name: 'debate', description: 'Let two models argue it out', arg: '[question]', modes: CODE },
  { name: 'device', description: 'Run tools on another device', arg: '[device]', modes: CODE },
  { name: 'export', description: 'Download this session', arg: '[md|json]', modes: BOTH },
  { name: 'fork', description: 'Fork this session', modes: BOTH },
  { name: 'handoff', description: 'Switch this session to another model', arg: '<provider/model>', modes: BOTH },
  { name: 'help', description: 'Commands and keys', sheet: 'help', modes: BOTH },
  { name: 'hooks', description: 'Hooks: on or off, recipes', sheet: 'hooks', modes: CODE },
  { name: 'init', description: 'Write an AGENTS.md that explains this project', modes: CODE },
  { name: 'jury', description: 'Ask a jury of models', arg: '[question]', modes: CODE },
  { name: 'mcp', description: 'Connectors: MCP servers for this session', sheet: 'mcp', modes: CODE },
  { name: 'memory', description: 'What it remembers here, and the memory switch', sheet: 'memory', modes: BOTH },
  { name: 'mode', description: 'Agent, chat, plan, jury, debate or loop', arg: '[mode]', modes: BOTH },
  { name: 'model', description: 'Model and effort', arg: '[provider/model]', sheet: 'model', modes: BOTH },
  { name: 'new', description: 'New session with the same agent', modes: BOTH },
  { name: 'permissions', description: 'Permission mode and rules', sheet: 'permissions', modes: CODE },
  { name: 'resume', description: 'Open an earlier session', sheet: 'resume', modes: BOTH },
  { name: 'review', description: 'Second opinion on the last reply', arg: '[model]', modes: CODE },
  { name: 'rewind', description: 'Undo the last exchange', modes: BOTH },
  { name: 'skills', description: 'Skills this agent can load', sheet: 'skills', modes: CODE },
  { name: 'status', description: 'Model, agent, device, folder and hub', sheet: 'status', modes: BOTH },
];

/** The built-in commands of a mode, in name order. */
export function builtinCommands(mode: SlashMode): SlashItem[] {
  return BUILTINS.filter((b) => b.modes.includes(mode)).map(({ modes: _m, ...b }) => ({ ...b, section: 'commands' as const }));
}

/** The mode of the "/" menu for a session: Chat mode (no tools) gets the small set. */
export function slashMode(s: { mode: string; kind?: string }): SlashMode {
  return s.mode === 'chat' || s.kind === 'chat' ? 'chat' : 'code';
}

/** True when the agent can load skills: its tool list names Skill, or it has none (all default tools). */
export function agentHasSkills(agent: Pick<AgentDef, 'tools' | 'disallowedTools'> | undefined): boolean {
  if (!agent) return true;
  if (agent.disallowedTools?.includes('Skill')) return false;
  return !agent.tools || agent.tools.includes('Skill');
}

/**
 * Every item of the menu, in sections. Skills come only in Code mode and
 * only when the agent has the Skill tool. As on the hub (engine/commands.ts),
 * a built-in wins over a custom command of the same name, and a custom
 * command over a skill.
 */
export function slashItems(input: { mode: SlashMode; skills: Array<Pick<SkillDef, 'name' | 'description' | 'source' | 'plugin'>>; commands: Array<Pick<CommandDef, 'name' | 'description' | 'argumentHint' | 'source' | 'plugin'>>; agent?: Pick<AgentDef, 'tools' | 'disallowedTools'> }): SlashItem[] {
  const builtins = builtinCommands(input.mode);
  const taken = new Set(builtins.flatMap((b) => [b.name, ...(b.aliases ?? [])]));
  const custom: SlashItem[] = input.commands
    .filter((c) => !taken.has(c.name))
    .map((c) => ({ name: c.name, description: c.description ?? '', ...(c.argumentHint ? { arg: c.argumentHint } : {}), section: 'custom' as const, source: c.plugin ?? c.source }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const c of custom) taken.add(c.name);
  const skills: SlashItem[] =
    input.mode === 'code' && agentHasSkills(input.agent)
      ? input.skills
          .filter((k) => !taken.has(k.name))
          .map((k) => ({ name: k.name, description: k.description, arg: '[args]', section: 'skills' as const, source: k.plugin ?? (k.source === 'user' ? undefined : k.source) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  return [...builtins, ...skills, ...custom];
}

/** Items that match what follows "/", best match first in each section; the sections keep their order. */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim();
  if (!q) return items;
  const order: SlashSection[] = ['commands', 'skills', 'custom'];
  const out: SlashItem[] = [];
  for (const section of order) {
    const scored = items
      .filter((it) => it.section === section)
      .map((it) => ({ it, s: Math.max(fuzzy(q, it.name), ...(it.aliases ?? []).map((a) => fuzzy(q, a) - 1)) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s);
    out.push(...scored.map((x) => x.it));
  }
  return out;
}

/** The item a typed line names: its name or an alias, case does not matter. */
export function findSlash(items: SlashItem[], name: string): SlashItem | undefined {
  const n = name.toLowerCase();
  return items.find((it) => it.name.toLowerCase() === n) ?? items.find((it) => it.aliases?.includes(n));
}

/**
 * What picking an item does. sheet: open its sheet. fill: put "/name " in
 * the box for the arguments (a skill, or a command that needs one). run:
 * run it now.
 */
export function pickAction(item: SlashItem): 'sheet' | 'fill' | 'run' | 'more' {
  if (item.more) return 'more';
  if (item.sheet) return 'sheet';
  if (item.section === 'skills') return 'fill';
  if (item.arg?.startsWith('<')) return 'fill';
  if (item.section === 'custom' && item.arg) return 'fill';
  return 'run';
}

/** The sections of a list, for headings. */
export function sectionsOf(items: SlashItem[]): Array<{ section: SlashSection; label: string; items: SlashItem[] }> {
  const out: Array<{ section: SlashSection; label: string; items: SlashItem[] }> = [];
  for (const it of items) {
    let g = out.find((x) => x.section === it.section);
    if (!g) out.push((g = { section: it.section, label: SECTION_WORDS[it.section], items: [] }));
    g.items.push(it);
  }
  return out;
}

/** The prompt /init sends: Claude Code's /init, for AGENTS.md (Conclave, Codex and OpenCode read it; Claude Code reads CLAUDE.md). */
export const INIT_PROMPT = `Look through this project and write an AGENTS.md at its root for coding agents that work here later. Keep it short and factual:

- what the project is, in two sentences
- how to install, build, run and test it (the exact commands)
- the layout: the main folders and what lives in each
- conventions the code follows that are not obvious from one file
- anything that breaks easily

If an AGENTS.md or CLAUDE.md is already there, improve it instead of starting over. Do not invent commands; run them to check.`;
