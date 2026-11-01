/**
 * What the platform card is built from, read from the engine's live state
 * (platform/card.ts renders it). The runner reads it once per user turn with
 * the rest of the prompt's parts (session/runner.ts systemFor), so a device
 * that connects mid-turn waits for the next turn, like Delegate's list.
 */
import type { AgentDef } from '../extensions/types';
import type { Session } from '../types';
import type { Engine } from '../engine/engine';
import { accountsOf } from '../accounts/attached';
import { ENGINE_LABEL } from '../browser/engine';
import type { BrowserManager } from '../browser/manager';
import { hubPlace } from '../system/host';
import { isUntrusted } from '../session/untrusted';
import { CHAT_AGENT } from '../session/chat';
import { platformCard, subagentNote, type PlatformFacts, type Surface } from './card';

/** The system blocks the card adds: the card, and for a primary session its live block. */
export interface PlatformBlocks {
  card: string;
  live?: string;
}

const ASSISTANT_AGENT = 'assistant';

const OS_WORDS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows', freebsd: 'FreeBSD' };

let whereCache: string | undefined;

/** "Linux x64 in an LXC container (CT 100)": read once per process, it does not change. */
export function hubWhere(): string {
  if (whereCache !== undefined) return whereCache;
  let place = '';
  if (process.platform === 'linux') {
    try {
      const p = hubPlace();
      place = p.kind === 'lxc' ? ` in an LXC container${p.ctid ? ` (CT ${p.ctid})` : ''}` : p.kind === 'docker' ? ' in Docker' : p.kind === 'vm' ? ' in a VM' : p.kind === 'container' ? ' in a container' : '';
    } catch {
      place = '';
    }
  }
  whereCache = `${OS_WORDS[process.platform] ?? process.platform} ${process.arch}${place}`;
  return whereCache;
}

/** Which switch of the app a session belongs to. */
export function surfaceOf(s: Pick<Session, 'kind' | 'agent'>): Surface {
  if (s.kind === 'chat' || s.agent === CHAT_AGENT) return 'chat';
  return s.agent === ASSISTANT_AGENT ? 'assistant' : 'code';
}

/** True when the card is on for this agent: config agents.platformCard and the agent's own switch, both on unless set false. */
export function cardEnabled(engine: Pick<Engine, 'config'>, agent: Pick<AgentDef, 'platformCard'>): boolean {
  return engine.config.get().agents?.platformCard !== false && agent.platformCard !== false;
}

/** MCP server names from tool names (mcp__<server>__<tool>), sorted, so a server that reconnects first does not move the card. */
export function mcpServersOf(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const m = /^mcp__(.+?)__/.exec(n);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

async function browserState(engine: Engine, tools: string[]): Promise<Pick<PlatformFacts, 'browser' | 'browserEngine'>> {
  if (!tools.some((t) => t.startsWith('browser_'))) return { browser: 'none' };
  const b = (engine as unknown as { browser?: BrowserManager }).browser;
  if (!b) return { browser: 'missing' };
  const ok = await b.available().then((a) => a.ok, () => false);
  if (!ok) return { browser: 'missing' };
  let label: string | undefined;
  try {
    // the default profile's engine, not this session's profile, so browser_profile does not change the card
    label = ENGINE_LABEL[b.engineOf(b.defaultProfileName())];
  } catch {
    label = undefined;
  }
  return { browser: 'ready', ...(label ? { browserEngine: label } : {}) };
}

/** The model accounts set up, in the owner's order, then providers with a key that no account covers. */
function accountWords(engine: Engine): string[] {
  const out: string[] = [];
  const covered = new Set<string>();
  try {
    for (const a of accountsOf(engine)?.status().accounts ?? []) {
      if (!a.enabled) continue;
      if (a.provider) covered.add(a.provider);
      out.push(a.kind === 'subscription' ? `${a.vendorName} plan ${a.label}` : a.label);
    }
  } catch {
    /* no accounts service, or it failed: the keys below still show */
  }
  const cfg = engine.config.get();
  for (const [id, p] of Object.entries(cfg.providers ?? {})) {
    if (!p || p.type === 'acp' || p.enabled === false || id === 'cliproxy' || covered.has(id)) continue;
    let keyed = false;
    try {
      keyed = engine.config.hasProviderKey(id);
    } catch {
      keyed = false;
    }
    if (keyed) out.push(`${engine.providerLabel(id)} key`);
  }
  return out;
}

/** Harness engines that are on (Settings > Models > Providers). */
function enginesOn(engine: Engine): string[] {
  return Object.entries(engine.config.get().providers ?? {})
    .filter(([, p]) => p?.type === 'acp' && p.enabled === true)
    .map(([id, p]) => p.name ?? id);
}

/**
 * The card for a session's system prompt, or undefined when it is off
 * (agents.platformCard, the agent's platformCard). A primary session (depth
 * 0, not a subagent or workflow step) gets the card and the live block; a
 * subagent, a workflow step or an untrusted session gets two lines.
 */
export async function platformBlocksFor(engine: Engine, session: Session, agent: AgentDef, toolNames: string[], depth = 0): Promise<PlatformBlocks | undefined> {
  if (!cardEnabled(engine, agent)) return undefined;
  const info = engine.info();
  const hub = { name: info.name, version: engine.version, where: hubWhere() };
  if (depth > 0 || session.meta?.subagent || session.meta?.workflow) return { card: subagentNote({ hub, tools: toolNames }, 'subagent') };
  // a session that reads outside content gets no map of the owner's devices and accounts
  if (isUntrusted(session, agent.untrusted)) return { card: subagentNote({ hub, tools: toolNames }, 'untrusted') };
  const member = engine.isMemberSession(session);
  const devices = engine.devices
    .list(engine.accountOf(session))
    .map((d) => ({ name: d.name, online: d.online, hub: d.id === 'local' }))
    .sort((a, b) => Number(!!b.hub) - Number(!!a.hub) || a.name.localeCompare(b.name));
  const facts: PlatformFacts = {
    hub,
    surface: surfaceOf(session),
    agent: agent.name,
    tools: toolNames,
    mcpServers: mcpServersOf([...toolNames, ...engine.deferredToolsFor(session.id).map((t) => t.name)]),
    devices,
    ...(await browserState(engine, toolNames)),
    accounts: member ? [] : accountWords(engine),
    engines: member ? [] : enginesOn(engine),
    defaultModel: engine.config.get().defaultModel,
    ...(member ? { member: true } : {}),
  };
  return platformCard(facts);
}
