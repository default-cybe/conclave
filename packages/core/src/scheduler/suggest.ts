/**
 * Suggested routines service (docs/design/ECOSYSTEM.md 2.3 and 5.2): the
 * Suggested section in the Routines tab reads the list with what is already
 * added, what is missing on the hub and which hub changes a suggestion still
 * waits for; Add creates the agent when it is missing, then one routine per
 * picked device.
 *
 * The host is passed in so the same code runs on the hub and in the web mock.
 * No node imports here.
 */
import type { Device, Routine } from '../types';
import type { RoutineInput } from './types';
import { ROUTINE_SUGGESTIONS, SUGGESTED_AGENTS, type DeviceRole, type HubGap, type RoutineSuggestion, type SuggestionNeed } from './suggestions';

/**
 * Hub changes this hub has made (ECOSYSTEM.md 5.3). A suggestion that is
 * blocked by a gap not in this list cannot be added yet.
 * - routine-allow: Routine.allow and deny reach the routine's sessions; scheduled and webhook runs refuse calls that need approval and go on.
 * - bash-allow-safe: Bash rules with a command no longer allow &, $( ), backticks, subshells or redirects to files.
 * - agent-tools-allow: an agent's tools list no longer allows those tools without asking.
 * - session-tools: SessionSearch and SessionRead read past sessions (session/search.ts).
 */
export const CLOSED_GAPS: HubGap[] = ['routine-allow', 'bash-allow-safe', 'agent-tools-allow', 'session-tools'];

export interface RoutineSuggestionDto extends RoutineSuggestion {
  /** Routine ids already made from this suggestion. */
  added: string[];
  /** Needs that are not met on the hub (agents, MCP servers, secrets). Device needs are checked when a device is picked. */
  missing: SuggestionNeed[];
  /** blockedBy entries the hub has not closed yet. Add is disabled while this is not empty. */
  waitingOn: HubGap[];
}

export interface RoutineSuggestionsDto {
  suggestions: RoutineSuggestionDto[];
  /** Gaps this hub has closed. */
  closed: HubGap[];
  /** Suggested agents and whether an agent with that name exists. */
  agents: Record<string, { exists: boolean }>;
  /** The hub's own folder, which suggestions write as ~/.conclave (/data in Docker). */
  hubHome?: string;
  /** The hub's own machine has code repos in ~/code, so suggestions that read code may run there too (hubNeedsRepos). */
  hubRepos?: boolean;
}

export interface AddSuggestionRequest {
  /** One device id, or several when deviceRole is "each". Empty picks the device for the role. */
  devices?: string[];
  cwd?: string;
  enabled?: boolean;
  /** Edits made in the sheet. allow may only drop rules; deny may add them. */
  overrides?: Partial<Pick<RoutineInput, 'name' | 'schedule' | 'timezone' | 'prompt' | 'notify' | 'model' | 'allow' | 'deny' | 'precheck' | 'onApproval' | 'timeoutMin' | 'maxCostUsd'>>;
}

export interface AddSuggestionResult {
  routines: Routine[];
  /** Name of the agent Add created, when it was missing. */
  agentCreated?: string;
}

export interface SuggestionHost {
  routines(): Routine[];
  createRoutine(input: RoutineInput): Routine | Promise<Routine>;
  /** Used to undo routines made before a later one failed. */
  removeRoutine(id: string): void | Promise<void>;
  agentExists(name: string): boolean;
  /** Write an agent markdown file at user scope. */
  createAgent(name: string, markdown: string): Promise<void>;
  /** MCP server names the hub knows (config and plugins). */
  mcpServers(): string[];
  /** Names in the secrets store. */
  secrets(): string[];
  devices(): Device[];
  /** Throws when the hub cannot read the schedule; checked before anything is made. */
  checkSchedule?(schedule: string, timezone?: string): void | Promise<void>;
  /** The hub's own folder (CONCLAVE_HOME, /data in Docker). Suggestions write it as ~/.conclave. */
  hubHome?(): string | undefined;
  /** The hub's own machine has a git repo in ~/code. Unset: it has none. */
  hubHasRepos?(): boolean;
}

export class SuggestionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ROLE_WORDS: Record<Exclude<DeviceRole, 'each'>, string> = {
  hub: 'the hub',
  proxmox: 'the Proxmox host',
  workstation: 'your workstation',
  laptop: 'your laptop',
};

/** "the Proxmox host", for sheet hints and errors. */
export function roleWords(role: DeviceRole): string {
  return role === 'each' ? 'each device you pick' : ROLE_WORDS[role];
}

const ROLE_MATCH: Record<Exclude<DeviceRole, 'each' | 'hub'>, (d: Device) => boolean> = {
  proxmox: (d) => /^(pve|proxmox)\b/i.test(d.name) || /^(pve|proxmox)\b/i.test(d.info?.hostname ?? '') || !!d.info?.clis?.pvesh,
  workstation: (d) => /desktop|workstation|arch|tower|\bpc\b/i.test(d.name) && d.info?.platform !== 'darwin',
  laptop: (d) => /mac|book|laptop/i.test(d.name) || d.info?.platform === 'darwin',
};

/**
 * The device a role means on this hub: hub is the hub itself (madx), proxmox
 * the Proxmox host (pve), workstation the main desktop (arch-desktop), laptop
 * the Mac. Matched by name, then by what the device reports. A workstation
 * falls back to the first online device that is not the hub, then the hub. A
 * Proxmox host or a laptop has no stand-in: undefined, and the owner picks.
 */
export function roleDevice(role: DeviceRole, devices: Device[]): Device | undefined {
  const hub = devices.find((d) => d.id === 'local');
  if (role === 'hub') return hub ?? devices[0];
  if (role === 'each') return undefined;
  const others = devices.filter((d) => d.id !== 'local');
  const match = ROLE_MATCH[role];
  const found = others.find((d) => match(d) && d.online) ?? others.find(match);
  if (found || role !== 'workstation') return found;
  return others.find((d) => d.online) ?? hub;
}

/**
 * The devices a suggestion may run on: every one, except the hub for a
 * suggestion that reads code repos when the hub has none (the librarian's
 * deep pass on a hub in Docker or on a NAS).
 */
export function offeredDevices(s: Pick<RoutineSuggestion, 'hubNeedsRepos'>, devices: Device[], hubRepos: boolean | undefined): Device[] {
  return s.hubNeedsRepos && !hubRepos ? devices.filter((d) => d.id !== 'local') : devices;
}

/**
 * The devices an "each" suggestion starts with: the machines its eachOf roles
 * point to (arch-desktop and the macbook for the session harvester), or every
 * online device when it names none. Pass the offered devices.
 */
export function eachDefaults(s: Pick<RoutineSuggestion, 'deviceRole' | 'eachOf'>, devices: Device[]): Device[] {
  if (s.deviceRole !== 'each') return [];
  if (!s.eachOf?.length) return devices.filter((d) => d.online);
  const out: Device[] = [];
  for (const role of s.eachOf) {
    const d = roleDevice(role, devices);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * "~/.conclave" is where suggestions say the hub keeps its files. On the hub
 * itself that is its real folder, which is /data in Docker, so routines that
 * run there get the real path in their folder and prompt.
 */
export function hubPaths(text: string, hubHome: string | undefined): string {
  if (!hubHome) return text;
  const h = hubHome.replace(/\/+$/, '');
  return text.replace(/~\/\.conclave(?=\/|\b|$)/g, h);
}

/** "~/code" on a device whose home is /home/kai: "/home/kai/code". Unknown home keeps the ~. */
export function expandHome(path: string | undefined, home: string | undefined): string | undefined {
  const p = path?.trim();
  if (!p) return undefined;
  if (!home) return p;
  const h = home.replace(/\/+$/, '') || '/';
  if (p === '~') return h;
  if (p.startsWith('~/')) return `${h === '/' ? '' : h}/${p.slice(2)}`;
  return p;
}

function needMet(n: SuggestionNeed, host: { servers: Set<string>; secrets: Set<string>; agentExists: (name: string) => boolean }): boolean {
  switch (n.kind) {
    case 'mcp':
      return host.servers.has(n.id);
    case 'secret':
      return host.secrets.has(n.id);
    case 'agent':
      return host.agentExists(n.id);
    default:
      // bin and note needs depend on the device and the notes; the routine reports them
      return true;
  }
}

const TEXT_FIELDS = ['name', 'schedule', 'timezone', 'prompt', 'model', 'precheck'] as const;
const NOTIFY_VALUES = ['always', 'on_error', 'on_attention', 'never'];

/** Check the sheet's edits: wrong types get a sentence, not a crash. */
function cleanOverrides(raw: AddSuggestionRequest['overrides']): NonNullable<AddSuggestionRequest['overrides']> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new SuggestionError(400, 'overrides must be an object');
  const o = raw as Record<string, unknown>;
  for (const k of TEXT_FIELDS) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') throw new SuggestionError(400, `${k} must be text`);
  for (const k of ['allow', 'deny'] as const) {
    const v = o[k];
    if (v !== undefined && v !== null && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) throw new SuggestionError(400, `${k} must be a list of permission rules`);
  }
  if (o.notify !== undefined && o.notify !== null && !NOTIFY_VALUES.includes(o.notify as string)) throw new SuggestionError(400, `notify must be one of ${NOTIFY_VALUES.join(', ')}`);
  if (o.onApproval !== undefined && o.onApproval !== null && o.onApproval !== 'deny' && o.onApproval !== 'wait') throw new SuggestionError(400, 'onApproval must be deny or wait');
  for (const k of ['timeoutMin', 'maxCostUsd'] as const) {
    const v = o[k];
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) throw new SuggestionError(400, `${k} must be a number above 0`);
  }
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as NonNullable<AddSuggestionRequest['overrides']>;
  if (out.allow) out.allow = out.allow.map((r) => r.trim()).filter(Boolean);
  if (out.deny) out.deny = out.deny.map((r) => r.trim()).filter(Boolean);
  return out;
}

export class RoutineSuggestions {
  constructor(
    private host: SuggestionHost,
    private closed: HubGap[] = CLOSED_GAPS,
    private all: RoutineSuggestion[] = ROUTINE_SUGGESTIONS,
  ) {}

  get(id: string): RoutineSuggestion | undefined {
    return this.all.find((s) => s.id === id);
  }

  list(): RoutineSuggestionsDto {
    const routines = this.host.routines();
    const ctx = { servers: new Set(this.host.mcpServers()), secrets: new Set(this.host.secrets()), agentExists: (n: string) => this.host.agentExists(n) };
    const suggestions = this.all.map((s) => ({
      ...s,
      added: routines.filter((r) => r.suggestion === s.id).map((r) => r.id),
      // an agent Add creates itself is not missing
      missing: s.requires.filter((n) => !(n.kind === 'agent' && SUGGESTED_AGENTS[n.id]) && !needMet(n, ctx)),
      waitingOn: s.blockedBy.filter((g) => !this.closed.includes(g)),
    }));
    const agents = Object.fromEntries(Object.keys(SUGGESTED_AGENTS).map((n) => [n, { exists: this.host.agentExists(n) }]));
    const hubHome = this.host.hubHome?.();
    return { suggestions, closed: [...this.closed], agents, ...(hubHome ? { hubHome } : {}), hubRepos: this.hubRepos() };
  }

  private hubRepos(): boolean {
    try {
      return !!this.host.hubHasRepos?.();
    } catch {
      return false;
    }
  }

  async add(id: string, req: AddSuggestionRequest = {}): Promise<AddSuggestionResult> {
    const s = this.get(id);
    if (!s) throw new SuggestionError(404, `unknown suggestion ${id}`);
    const waiting = s.blockedBy.filter((g) => !this.closed.includes(g));
    if (waiting.length) throw new SuggestionError(409, `${s.name} needs a hub update first (${waiting.join(', ')}).`);

    const o = cleanOverrides(req.overrides);
    const all = this.host.devices();
    const offered = offeredDevices(s, all, s.hubNeedsRepos ? this.hubRepos() : true);
    let picked = [...new Set((req.devices ?? []).filter((d) => typeof d === 'string' && d))];
    if (!picked.length) {
      const found = s.deviceRole === 'each' ? eachDefaults(s, offered) : [roleDevice(s.deviceRole, offered)].filter((d): d is Device => !!d);
      if (!found.length) throw new SuggestionError(400, s.deviceRole === 'each' ? 'Pick at least one device.' : `Pick a device for ${s.name}.`);
      picked = found.map((d) => d.id);
    }
    if (picked.length > 12) throw new SuggestionError(400, 'Pick at most 12 devices.');
    const devices: Device[] = [];
    for (const pid of picked) {
      const d = all.find((x) => x.id === pid) ?? all.find((x) => x.name === pid);
      if (!d) throw new SuggestionError(400, `Unknown device ${pid}.`);
      if (!offered.includes(d)) throw new SuggestionError(400, `${s.name} reads code repos in ~/code, and the hub has none there. Pick the computers that hold your code.`);
      // an id and a name for the same machine make one routine, not two
      if (!devices.includes(d)) devices.push(d);
    }
    if (devices.length > 1 && s.deviceRole !== 'each') throw new SuggestionError(400, `${s.name} runs on one device. Pick one.`);

    const cwdIn = typeof req.cwd === 'string' ? req.cwd.trim() : '';
    if (s.askCwd && !cwdIn) throw new SuggestionError(400, `Pick a folder for ${s.name}. ${s.askCwd}`);

    if (o.allow) {
      const extra = o.allow.filter((r) => !s.allow.includes(r));
      if (extra.length) throw new SuggestionError(400, `Add can only remove allow rules. Add ${extra[0]} later in the routine's settings.`);
    }
    // a schedule the hub cannot read fails here, before the agent is made
    const schedule = o.schedule?.trim() || s.schedule;
    try {
      await this.host.checkSchedule?.(schedule, o.timezone || undefined);
    } catch (err) {
      throw new SuggestionError(400, (err as Error)?.message ?? String(err));
    }

    const agent = s.agent ?? 'assistant';
    let agentCreated: string | undefined;
    if (!this.host.agentExists(agent)) {
      const md = SUGGESTED_AGENTS[agent];
      if (!md) throw new SuggestionError(400, `${s.name} runs as ${agent}, and there is no agent with that name.`);
      await this.host.createAgent(agent, md);
      agentCreated = agent;
    }

    const made: Routine[] = [];
    try {
      const hubHome = this.host.hubHome?.();
      for (const d of devices) {
        const onHub = d.id === 'local';
        const name = (o.name?.trim() || s.name) + (devices.length > 1 || s.deviceRole === 'each' ? ` (${d.name})` : '');
        const prompt = o.prompt?.trim() ? o.prompt : s.prompt;
        const cwd = cwdIn || s.cwd;
        const input: RoutineInput = {
          name,
          schedule,
          ...(o.timezone ? { timezone: o.timezone } : {}),
          prompt: onHub ? hubPaths(prompt, hubHome) : prompt,
          agent,
          ...(o.model ? { model: o.model } : s.model ? { model: s.model } : {}),
          mode: s.mode ?? 'agent',
          cwd: expandHome(onHub && cwd ? hubPaths(cwd, hubHome) : cwd, d.info?.home),
          device: d.id,
          enabled: req.enabled ?? s.enabledByDefault,
          sessionPolicy: s.sessionPolicy ?? 'new',
          notify: o.notify ?? s.notify ?? 'on_error',
          allow: o.allow ?? s.allow,
          ...((o.deny ?? s.deny)?.length ? { deny: [...new Set([...(s.deny ?? []), ...(o.deny ?? [])])] } : {}),
          ...((o.precheck ?? s.precheck) ? { precheck: o.precheck ?? s.precheck } : {}),
          ...(s.env ? { env: s.env } : {}),
          ...(o.onApproval ? { onApproval: o.onApproval } : {}),
          ...(o.timeoutMin ? { timeoutMin: o.timeoutMin } : {}),
          ...(o.maxCostUsd ? { maxCostUsd: o.maxCostUsd } : {}),
          ...(s.builtin ? { builtin: s.builtin } : {}),
          suggestion: s.id,
        };
        if (!input.cwd) delete input.cwd;
        made.push(await this.host.createRoutine(input));
      }
    } catch (err) {
      for (const r of made) {
        try {
          await this.host.removeRoutine(r.id);
        } catch {
          // best effort
        }
      }
      throw err instanceof SuggestionError ? err : new SuggestionError(400, (err as Error)?.message ?? String(err));
    }
    return { routines: made, ...(agentCreated ? { agentCreated } : {}) };
  }
}
