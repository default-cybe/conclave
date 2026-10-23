/**
 * What a new conversation starts, by the sidebar's switch: Chat (a plain
 * chat with the chat agent), Assistant (the assistant agent, on the hub,
 * with no device or folder) or Code (the default coding agent, which hands
 * work to its subagents itself, in a folder on a computer). The switch and
 * Code's picks are remembered per device.
 */
import { create } from 'zustand';
import type { Device, PermissionMode, Session } from '@conclave/core/types';
import { underParent } from '@conclave/core/session/delegated';
import { clampEffort, isEffortSetting, type EffortSetting, type ModelEffort } from '@conclave/core/providers/effort';

export type StartMode = 'chat' | 'assistant' | 'code';

export const START_MODES: Array<{ value: StartMode; label: string; detail: string }> = [
  { value: 'chat', label: 'Chat', detail: 'A model answers, with the web and your memory.' },
  { value: 'assistant', label: 'Assistant', detail: 'Your day, goals and setup, on the hub.' },
  { value: 'code', label: 'Code', detail: 'An agent works in a folder on your computer.' },
];

/** The agents the switch starts. Code starts a custom agent only when one was picked under "+". */
export const ASSISTANT_AGENT = 'assistant';
export const CODE_AGENT = 'coder';
const CHAT_AGENT = 'chat';

/**
 * A new key: the old one (conclave.home.start) could hold "session", which
 * turned a plain question on Home into an agent session on a device without
 * the owner seeing it. Nobody starts in Code by accident now.
 */
const MODE_KEY = 'conclave.mode';
/** Kept from the old quick start bar, so the picks made there carry over. */
const PICKS_KEY = 'conclave.quickstart';

export function readMode(): StartMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'assistant' || v === 'code' ? v : 'chat';
  } catch {
    return 'chat';
  }
}

export function saveMode(mode: StartMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode: this page only */
  }
}

/** The switch in the sidebar, shared by every screen. `fresh` counts new conversations started in a place, so the box reads the picks again. */
export const useStartMode = create<{ mode: StartMode; fresh: number }>(() => ({ mode: readMode(), fresh: 0 }));

export function setStartMode(mode: StartMode) {
  saveMode(mode);
  if (useStartMode.getState().mode !== mode) useStartMode.setState({ mode });
}

/** Which switch a conversation belongs to: a chat, the assistant's, or Code. */
export function modeOf(s: Pick<Session, 'kind' | 'agent'>): StartMode {
  if (s.kind === 'chat') return 'chat';
  return s.agent === ASSISTANT_AGENT ? 'assistant' : 'code';
}

/** An agent Code may start in place of its own: not the chat or the assistant agent. */
export function customAgent(name: string | undefined): boolean {
  return !!name && name !== CHAT_AGENT && name !== ASSISTANT_AGENT;
}

/** What the owner picked for Code, and the assistant's model. Unset fields follow the last session or the hub. */
export interface Picks {
  /** A custom agent picked under "+". Unset: the default coding agent. */
  agent?: string;
  model?: string;
  /** The model the Assistant switch starts with. */
  assistantModel?: string;
  /** A device picked by hand in this browser or app (kept until another is picked). */
  device?: string;
  cwd?: string;
  /** The device the folder in `cwd` is on (it was picked there). */
  cwdDevice?: string;
  /** The permission mode, Effort (with the model, in one picker) and Ultra for the next session. */
  permissionMode?: PermissionMode;
  /** Unset follows the agent (Code runs at medium unless told); off is kept. */
  thinking?: EffortSetting;
  ultra?: boolean;
  /** Code from GitHub (docs/DESIGN.md 30): owner/name, and the branch to start from (unset: the default branch). */
  repo?: string;
  base?: string;
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

/** The saved picks' format: from 2, `device` is only a device picked by hand and a folder keeps the device it is on. */
const PICKS_VERSION = 2;

export function readPicks(): Picks {
  try {
    const raw = JSON.parse(localStorage.getItem(PICKS_KEY) ?? '{}') as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const mode = PERMISSION_MODES.find((m) => m === raw.permissionMode);
    const thinking = isEffortSetting(raw.thinking) ? raw.thinking : undefined;
    const cwd = str(raw.cwd);
    // before, a folder pick saved the device it was on as if picked by hand: that device is the folder's, not a pick
    const old = raw.v !== PICKS_VERSION;
    const device = old ? (cwd === undefined ? str(raw.device) : undefined) : str(raw.device);
    const cwdDevice = old ? (cwd !== undefined ? str(raw.device) : undefined) : str(raw.cwdDevice);
    return { agent: str(raw.agent), model: str(raw.model), assistantModel: str(raw.assistantModel), device, cwd, cwdDevice, permissionMode: mode, thinking, ultra: raw.ultra === true || undefined, repo: str(raw.repo), base: str(raw.base) };
  } catch {
    return {};
  }
}

export function savePicks(p: Picks) {
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify({ ...p, v: PICKS_VERSION }));
  } catch {
    /* private mode: keep the picks for this page only */
  }
}

/**
 * The last session the owner worked in by hand (not a routine run, a
 * subagent, a jury, a debate or a chat). `settled` skips sessions already
 * running or waiting, for the Resume line. `mode` keeps the assistant's or
 * Code's only.
 */
export function lastOwnSession(sessions: Record<string, Session>, settled = false, mode?: 'assistant' | 'code'): Session | undefined {
  return Object.values(sessions)
    .filter((s) => !s.archived && !s.routineId && !underParent(s) && s.mode !== 'jury' && s.mode !== 'debate' && s.kind !== 'chat')
    .filter((s) => !mode || modeOf(s) === mode)
    .filter((s) => !settled || s.status === 'idle' || s.status === 'error')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export interface SetupInput {
  /** What starts: the assistant on the hub, or Code. Default code. */
  kind?: 'assistant' | 'code';
  picks: Picks;
  last?: Pick<Session, 'agent' | 'model' | 'device' | 'cwd'> & { meta?: Session['meta'] };
  agents: Array<{ name: string; model?: string; device?: string; primary?: boolean }>;
  defaultAgent?: string;
  defaultDevice?: string;
  defaultModel?: string;
  devices: Record<string, Pick<Device, 'id' | 'online'>>;
  /** Providers turned off on the hub (a coding agent's harness, say): a model of theirs is not carried over. */
  offProviders?: ReadonlySet<string>;
  /** A member: the hub's own computer is not theirs to code on, so it stands in for no device of theirs (picked by hand, it stays). */
  member?: boolean;
  /**
   * Where this page runs (here.ts surface): the desktop app, a browser on a
   * computer, or a phone. Default browser.
   */
  surface?: Surface;
  /** The desktop app's own computer, when the hub may use it (here.ts): Code starts there in the app unless a device was picked. */
  here?: string;
}

/** Where the page that starts Code runs. */
export type Surface = 'desktop' | 'browser' | 'phone';

export interface Setup {
  agent?: string;
  model?: string;
  device: string;
  /** Undefined: the hub's default folder on that device. */
  cwd?: string;
}

/**
 * Agent, model, device and folder for a new session.
 *
 * Assistant: the assistant agent on the hub, with the model picked for it,
 * else its own, else the hub's. No device or folder.
 *
 * Code: the default coding agent, or a custom agent picked under "+". The
 * model is the one picked, else the last Code session's when it ran the
 * same agent, else the agent's or the hub's. The device (startDevice) is
 * the one picked by hand in this browser or app; else in the desktop app
 * its own computer when the hub may use it; on a phone the last computer
 * used; else the agent's own device, the hub's default device (Settings),
 * or the hub. A browser on a computer never picks that computer by itself.
 * It must be online (the first online one stands in), and a folder only
 * carries over on the device it belongs to. A model of a provider that is
 * off (an imported Claude Code chat on a hub without the harness) is not
 * carried over. For a member the hub stands in for nothing: their code runs
 * on a device of their own.
 */
export function sessionSetup(i: SetupInput): Setup {
  const { picks, last } = i;
  // an agent that was removed since (a saved pick, the last session's) gives way; an empty list is still loading
  const known = (name: string | undefined) => (name && (!i.agents.length || i.agents.some((a) => a.name === name)) ? name : undefined);
  const usable = (m: string | undefined) => (m && !i.offProviders?.has(m.split('/')[0]) ? m : undefined);
  if (i.kind === 'assistant') {
    const def = i.agents.find((a) => a.name === ASSISTANT_AGENT);
    return { agent: ASSISTANT_AGENT, model: usable(picks.assistantModel) ?? usable(def?.model) ?? i.defaultModel, device: 'local' };
  }
  const picked = customAgent(picks.agent) ? known(picks.agent) : undefined;
  const agent = picked ?? known(CODE_AGENT) ?? [i.defaultAgent, ...i.agents.filter((a) => a.primary !== false).map((a) => a.name)].find((n) => customAgent(n) && known(n));
  const def = i.agents.find((a) => a.name === agent);
  const fromLast = !!last && last.agent === agent;
  const model = usable(picks.model) ?? usable(fromLast ? last?.model : def?.model) ?? usable(def?.model) ?? i.defaultModel;
  const wanted = startDevice({ picked: picks.device, surface: i.surface, here: i.here, last: last?.device, agent: def?.device, hubDefault: i.defaultDevice });
  // a member's own devices only, and the hub when picked by hand
  const mine = (id: string) => !i.member || (id === 'local' ? picks.device === 'local' : !!i.devices[id]);
  const device = i.devices[wanted]?.online && mine(wanted) ? wanted : (Object.values(i.devices).find((d) => d.online && mine(d.id))?.id ?? (mine(wanted) ? wanted : (Object.keys(i.devices).find(mine) ?? wanted)));
  let cwd: string | undefined;
  const cwdDevice = picks.cwdDevice ?? picks.device;
  if (picks.cwd !== undefined) cwd = cwdDevice === undefined || cwdDevice === device ? picks.cwd : undefined;
  // a repo session's folder is its own worktree: the next session does not start there
  else if (last?.device === device && !last.meta?.repo) cwd = last.cwd;
  return { agent, model, device, cwd: cwd && cwd !== '~' ? cwd : undefined };
}

/**
 * Where Code runs when nothing else decides (docs/DESIGN.md 40, Where Code
 * runs), before the online check:
 * 1. a device picked by hand in this browser or app, remembered per browser;
 * 2. in the desktop app, its own computer when "Let the hub use this
 *    computer" is on (`here`);
 * 3. on a phone, the last computer used;
 * 4. the agent's own device, then the hub's default device from Settings;
 * 5. the hub.
 * A browser on a computer is not that computer's: it starts on the hub.
 */
export function startDevice(i: { picked?: string; surface?: Surface; here?: string; last?: string; agent?: string; hubDefault?: string }): string {
  if (i.picked) return i.picked;
  if (i.surface === 'desktop' && i.here) return i.here;
  if (i.surface === 'phone' && i.last) return i.last;
  return i.agent || i.hubDefault || 'local';
}

/** How a place to run Code reads in a picker: a computer by its name, the hub as "<its name> (hub)". */
export function placeName(d: { id: string; name?: string } | undefined, id?: string): string {
  if (!d) return id === 'local' ? 'The hub' : (id ?? '');
  return d.id === 'local' ? `${d.name || 'conclave'} (hub)` : d.name || d.id;
}

/**
 * The Effort pick for the model the session starts on: kept when the model
 * has it, else the nearest level it has, and none for a model without Effort
 * (a harness that offers none). Unset stays unset: the agent's level.
 */
export function startEffort(picked: EffortSetting | undefined, effort: ModelEffort | undefined): EffortSetting | undefined {
  return clampEffort(picked, effort);
}

/** Code for a member with no device of their own, in place of starting (people/guard.ts says the same). */
export const CODE_NEEDS_DEVICE = 'Code sessions run on a computer you paired.';

/**
 * A member with no paired device of their own: a code session would start on
 * the hub's own computer, where every tool is refused for them
 * (docs/design/ACCOUNTS.md 5), so Code says where to pair one instead. The
 * owner always has the hub.
 */
export function needsOwnDevice(member: boolean, devices: Record<string, Pick<Device, 'id'>>): boolean {
  return member && !Object.keys(devices).some((id) => id !== 'local');
}

/**
 * What "/" offers before a session exists: the hub's commands, then the
 * skills, each run as /<name> args once the session starts (the hub's
 * engine/commands.ts). A command wins over a skill of the same name.
 */
export function startCommands(commands: Array<{ name: string; description?: string; argumentHint?: string }>, skills: Array<{ name: string; description?: string }>): Array<{ name: string; description?: string; argumentHint?: string }> {
  const taken = new Set(commands.map((c) => c.name));
  return [...commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })), ...skills.filter((k) => !taken.has(k.name)).map((k) => ({ name: k.name, description: k.description }))];
}

/** A message that is one of the hub's commands ("/compact keep the plan"): its name, else undefined. */
export function commandOf(text: string, commands: Array<{ name: string }>): string | undefined {
  const m = /^\/(\S+)/.exec(text.trim());
  return m && commands.some((c) => c.name === m[1]) ? m[1] : undefined;
}
