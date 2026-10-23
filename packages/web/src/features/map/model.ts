/**
 * The Map's data on the client (docs/DESIGN.md 29): words for states,
 * the header sentence, deltas applied to a snapshot, and where a node opens.
 * Pure, so test/map-model.test.ts checks it without a browser.
 */
import type { MapDelta, MapGroup, MapNode, MapSnapshot, MapState, MapUsage } from '@conclave/core/client';
import type { StateTone } from '@/components/ui/List';
import type { MarkState } from '@/components/motion';

export const STATE_WORD: Record<MapState, string> = {
  running: 'running',
  waiting: 'waiting on you',
  idle: 'idle',
  done: 'done',
  failed: 'failed',
  paused: 'paused',
};

/** Color means one thing: violet for live work, amber for what needs you, the fault color for failures; the rest is quiet. */
export const STATE_TONE: Record<MapState, StateTone> = {
  running: 'signal',
  waiting: 'warn',
  failed: 'fault',
  idle: 'dim',
  done: 'dim',
  paused: 'dim',
};

/** Busy nodes: they get color and streams. */
export const isBusy = (s: MapState) => s === 'running' || s === 'waiting';

/** The last four characters of an id, the way a label shows it ("x7k2"). Runs use their run id. */
export function shortId(id: string): string {
  const raw = id.startsWith('wf:') ? id.slice(3) : id;
  const tail = raw.includes('_') ? raw.slice(raw.lastIndexOf('_') + 1) : raw;
  return tail.slice(-4);
}

/** The hub's state from its nodes: waiting on you before running, then idle. Workflow runs count through their agents. */
export function hubState(nodes: MapNode[]): MapState {
  const counted = nodes.filter((n) => n.kind !== 'workflow');
  if (counted.some((n) => n.state === 'waiting')) return 'waiting';
  if (counted.some((n) => n.state === 'running')) return 'running';
  return 'idle';
}

/** The Knot's state for the hub: a tool running lights the knot; offline draws back to a stub. */
export function hubKnot(state: MapState, nodes: MapNode[], online: boolean): MarkState {
  if (!online) return 'paused';
  if (state === 'waiting') return 'waiting';
  if (state === 'running') return nodes.some((n) => n.state === 'running' && n.tool) ? 'tool' : 'thinking';
  return 'done';
}

export function counts(nodes: MapNode[]): { running: number; waiting: number } {
  let running = 0;
  let waiting = 0;
  for (const n of nodes) {
    if (n.kind === 'workflow') continue;
    if (n.state === 'running') running++;
    else if (n.state === 'waiting') waiting++;
  }
  return { running, waiting };
}

/** A group's agents and how many run or wait. */
export function groupStats(group: string, nodes: MapNode[]): { agents: number; running: number; waiting: number } {
  const mine = nodes.filter((n) => n.group === group && n.kind !== 'workflow');
  return { agents: mine.length, ...counts(mine) };
}

/** The group's state for its dot: waiting before running before failed. */
export function groupState(group: string, nodes: MapNode[]): MapState {
  const mine = nodes.filter((n) => n.group === group);
  if (mine.some((n) => n.state === 'waiting')) return 'waiting';
  if (mine.some((n) => n.state === 'running')) return 'running';
  return 'idle';
}

/** What a group holds: chats in the chats, agents elsewhere. */
export const groupNoun = (n: number, chats = false) => (chats ? (n === 1 ? 'chat' : 'chats') : n === 1 ? 'agent' : 'agents');

/** "4 agents, 2 running" under a group's name. */
export function groupLine(stats: { agents: number; running: number; waiting: number }, chats = false): string {
  const parts = [`${stats.agents} ${groupNoun(stats.agents, chats)}`];
  if (stats.running) parts.push(`${stats.running} running`);
  if (stats.waiting) parts.push(`${stats.waiting} waiting`);
  return parts.join(', ');
}

const usageDiff = (a: MapUsage | undefined, b: MapUsage) => ({
  tokens: b.inputTokens + b.outputTokens - ((a?.inputTokens ?? 0) + (a?.outputTokens ?? 0)),
  cost: b.costUsd - (a?.costUsd ?? 0),
});

/**
 * A delta applied to a snapshot. Returns a new snapshot (the old one is not
 * changed). Usage that grew adds to today's totals; finished tools go to
 * the front of the recent list; a whole node replaces the one it names.
 */
export function applyDelta(snap: MapSnapshot, delta: MapDelta): MapSnapshot {
  const nodes = new Map(snap.nodes.map((n) => [n.id, n]));
  let tokens = snap.totals.today.tokens;
  let cost = snap.totals.today.costUsd;
  let groups = snap.groups;
  let devices = snap.devices;
  if (delta.groups?.length) {
    const g = new Map<string, MapGroup>(groups.map((x) => [x.id, x]));
    for (const x of delta.groups) g.set(x.id, x);
    groups = [...g.values()];
  }
  if (delta.devices?.length) {
    const d = new Map(devices.map((x) => [x.id, x]));
    for (const x of delta.devices) d.set(x.id, x);
    devices = [...d.values()];
  }
  for (const p of delta.nodes) {
    const old = nodes.get(p.id);
    if (p.removed) {
      nodes.delete(p.id);
      continue;
    }
    if (p.node) {
      if (old) {
        const d = usageDiff(old.usage, p.node.usage);
        tokens += Math.max(0, d.tokens);
        cost += Math.max(0, d.cost);
      }
      nodes.set(p.id, p.node);
      continue;
    }
    if (!old) continue;
    const next: MapNode = { ...old };
    if (p.state) next.state = p.state;
    if (p.waitingOn === null) delete next.waitingOn;
    else if (p.waitingOn) next.waitingOn = p.waitingOn;
    if (p.title) next.title = p.title;
    if (p.tool === null) delete next.tool;
    else if (p.tool) next.tool = p.tool;
    if (p.done?.length) {
      const seen = new Set(p.done.map((t) => t.id));
      next.tools = [...[...p.done].reverse(), ...old.tools.filter((t) => !t.id || !seen.has(t.id))].slice(0, 5);
    }
    if (p.usage) {
      const d = usageDiff(old.usage, p.usage);
      tokens += Math.max(0, d.tokens);
      cost += Math.max(0, d.cost);
      next.usage = p.usage;
    }
    if (p.tokensPerMin !== undefined) next.tokensPerMin = p.tokensPerMin;
    if (p.rate !== undefined) next.rate = p.rate;
    if (p.lastActivityAt) next.lastActivityAt = Math.max(old.lastActivityAt, p.lastActivityAt);
    if (p.endedAt) next.endedAt = p.endedAt;
    if (p.error) next.error = p.error;
    nodes.set(p.id, next);
  }
  // a node whose parent left the map stands on its own
  const list = [...nodes.values()].map((n) => (n.parentId && !nodes.has(n.parentId) ? { ...n, parentId: undefined } : n));
  const c = counts(list);
  return {
    ...snap,
    at: Math.max(snap.at, delta.at),
    groups,
    devices,
    nodes: list,
    hub: { ...snap.hub, state: delta.hub?.state ?? hubState(list) },
    totals: { ...snap.totals, ...c, today: { ...snap.totals.today, tokens, costUsd: cost } },
  };
}

/** Where Open chat goes: the chat, the session, or the workflow run. */
export function nodeHref(n: MapNode): string {
  if (n.kind === 'workflow' && n.runId) return `/workflows/runs/${n.runId}`;
  if (n.kind === 'chat') return `/chat/${n.id}`;
  return `/s/${n.id}`;
}

/** Stop applies to work that is going or waiting. */
export const canStop = (n: MapNode) => n.state === 'running' || n.state === 'waiting' || (n.kind === 'workflow' && n.state === 'paused');

/** The nodes that hang off a node, oldest first. */
export function childrenOf(nodes: MapNode[], id: string): MapNode[] {
  return nodes.filter((n) => n.parentId === id).sort((a, b) => a.startedAt - b.startedAt);
}

/** "No progress 6m" for a stuck node (the stuck agent alert fills stuckSince). */
export function stuckWords(n: MapNode, now: number): string | undefined {
  if (!n.stuckSince) return undefined;
  const m = Math.max(1, Math.round((now - n.stuckSince) / 60_000));
  return m >= 60 ? `No progress ${Math.floor(m / 60)}h ${m % 60}m` : `No progress ${m}m`;
}

/** Tick marks for the replay scrubber: every 3 hours on the hour, within [from, to]. */
export function replayTicks(from: number, to: number, everyHours = 3): number[] {
  const out: number[] = [];
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  for (let t = d.getTime(); t <= to; t += 3_600_000) {
    if (new Date(t).getHours() % everyHours === 0) out.push(t);
  }
  return out;
}

/** "14:05", or "Yesterday 22:40" when it is not today. */
export function clockWords(t: number, now = Date.now()): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `Yesterday ${hm}`;
}
