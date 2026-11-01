/**
 * Map deltas (docs/DESIGN.md 29). Follows the engine's events and tells the
 * Map what moved: the token rate of each session, the tool it runs, the
 * tools it finished, its usage, and whole nodes when one starts or changes
 * state. At most one `map.delta` per interval, and none while no client
 * watches the map.
 *
 * Tokens per second come from the streamed text (about 4 characters a
 * token), smoothed over a few seconds so the streams speed up and slow down
 * instead of flickering.
 */
import type { EventBus } from '../util/bus';
import type { EngineEventEnvelope, Session } from '../types';
import type { MapDelta, MapDevice, MapGroup, MapNodePatch, MapSnapshot, MapTool, MapUsage } from '../client/map';
import type { MapLiveView } from './snapshot';
import { toolTarget } from './tools';
import { MAP_RECENT_TOOLS } from './snapshot';

/** The time constant of the smoothed rate. */
export const RATE_TAU_MS = 3_000;
/** A rate under this counts as stopped. */
const RATE_FLOOR = 0.05;
const MINUTE = 60_000;

export interface MapLiveOptions {
  bus: EventBus;
  /** True while some client watches the map. Unset: always. */
  wanted?: () => boolean;
  /** The live snapshot of an account, for whole nodes. */
  snapshot?: (accountId: string) => MapSnapshot;
  /** A session's account: each delta goes to its own account (docs/design/ACCOUNTS.md). Unset: one delta for the owner. */
  accountOf?: (sessionId: string) => string | undefined;
  /** A session's usage totals now. */
  usage?: (sessionId: string) => MapUsage | undefined;
  /** At most one delta per this many ms. */
  intervalMs?: number;
  now?: () => number;
}

interface Track {
  /** [time, tokens] of the last minute. */
  window: Array<[number, number]>;
  /** Tokens since the last flush. */
  fresh: number;
  rate: number;
  sentRate: number;
  sentPerMin: number;
  rateAt: number;
  inflight: Map<string, MapTool>;
  recent: MapTool[];
  done: MapTool[];
  toolDirty: boolean;
  usageDirty: boolean;
  lastActivityAt?: number;
}

/** Status, title and the rest that change where and how a node shows. */
const shape = (s: Session) => `${s.status}|${s.title}|${s.model}|${s.agent}|${s.parentId ?? ''}|${s.archived ? 1 : 0}|${s.device}|${s.cwd}`;

export class MapLive implements MapLiveView {
  private tracks = new Map<string, Track>();
  private shapes = new Map<string, string>();
  private whole = new Set<string>();
  private removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = 0;
  private readonly off: () => void;
  private readonly interval: number;
  private readonly now: () => number;

  constructor(private readonly opts: MapLiveOptions) {
    this.interval = opts.intervalMs ?? 500;
    this.now = opts.now ?? Date.now;
    this.off = opts.bus.on((e) => this.onEvent(e));
  }

  dispose(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ----- MapLiveView ---------------------------------------------------------

  current(sessionId: string): MapTool | undefined {
    const t = this.tracks.get(sessionId);
    if (!t?.inflight.size) return undefined;
    let last: MapTool | undefined;
    for (const x of t.inflight.values()) if (!last || x.startedAt >= last.startedAt) last = x;
    return last;
  }

  recent(sessionId: string): MapTool[] {
    return this.tracks.get(sessionId)?.recent ?? [];
  }

  rate(sessionId: string, now = this.now()): { rate: number; perMin: number } | undefined {
    const t = this.tracks.get(sessionId);
    if (!t) return undefined;
    this.advance(t, now);
    return { rate: t.rate, perMin: perMin(t, now) };
  }

  // ----- events ----------------------------------------------------------------

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { window: [], fresh: 0, rate: 0, sentRate: 0, sentPerMin: 0, rateAt: this.now(), inflight: new Map(), recent: [], done: [], toolDirty: false, usageDirty: false };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** Exposed for tests: feed one event. */
  onEvent(e: EngineEventEnvelope): void {
    const at = e.ts ?? this.now();
    switch (e.type) {
      case 'message.delta': {
        const t = this.track(e.sessionId);
        const n = Math.max(1, Math.round(e.text.length / 4));
        // a quiet session starts its smoothing clock now, not when it last spoke
        if (t.rate < RATE_FLOOR && !t.fresh) t.rateAt = at;
        t.fresh += n;
        t.window.push([at, n]);
        t.lastActivityAt = at;
        break;
      }
      case 'tool.started': {
        const t = this.track(e.sessionId);
        const target = toolTarget(e.input);
        t.inflight.set(e.toolUseId, { id: e.toolUseId, name: e.name, ...(target ? { target } : {}), startedAt: at });
        t.toolDirty = true;
        t.lastActivityAt = at;
        break;
      }
      case 'tool.completed': {
        const t = this.track(e.sessionId);
        const open = t.inflight.get(e.toolUseId);
        t.inflight.delete(e.toolUseId);
        const startedAt = open?.startedAt ?? at;
        const meta = e.result.meta?.durationMs;
        const done: MapTool = {
          id: e.toolUseId,
          name: open?.name ?? 'tool',
          ...(open?.target ? { target: open.target } : {}),
          startedAt,
          durationMs: typeof meta === 'number' && meta >= 0 ? meta : Math.max(0, at - startedAt),
          ...(e.result.isError ? { error: true } : {}),
        };
        t.recent = [done, ...t.recent.filter((x) => x.id !== done.id)].slice(0, MAP_RECENT_TOOLS);
        t.done.push(done);
        t.toolDirty = true;
        t.lastActivityAt = at;
        break;
      }
      case 'usage.recorded':
        if (e.record.sessionId) {
          const t = this.track(e.record.sessionId);
          t.usageDirty = true;
          t.lastActivityAt = at;
        }
        break;
      case 'session.created':
        this.shapes.set(e.session.id, shape(e.session));
        this.whole.add(e.session.id);
        break;
      case 'session.updated': {
        const next = shape(e.session);
        if (this.shapes.get(e.session.id) === next) return;
        this.shapes.set(e.session.id, next);
        this.whole.add(e.session.id);
        // a turn that ended leaves no tool running (one the stream never closed included)
        if (e.session.status !== 'running') {
          const t = this.tracks.get(e.session.id);
          if (t?.inflight.size && e.session.status !== 'waiting_approval' && e.session.status !== 'waiting_input') {
            t.inflight.clear();
            t.toolDirty = true;
          }
        }
        break;
      }
      case 'session.deleted':
        this.removed.add(e.sessionId);
        this.whole.delete(e.sessionId);
        this.tracks.delete(e.sessionId);
        this.shapes.delete(e.sessionId);
        break;
      case 'approval.requested':
        this.whole.add(e.approval.sessionId);
        break;
      case 'approval.resolved':
      case 'question.answered':
        this.whole.add(e.sessionId);
        break;
      case 'question.asked':
        this.whole.add(e.question.sessionId);
        break;
      case 'workflow.run':
        this.whole.add(`wf:${e.run.id}`);
        break;
      case 'workflow.agent':
        this.whole.add(`wf:${e.runId}`);
        if (e.call.childSessionId) this.whole.add(e.call.childSessionId);
        break;
      default:
        return;
    }
    this.kick();
  }

  // ----- deltas ------------------------------------------------------------------

  private advance(t: Track, now: number): void {
    const dt = now - t.rateAt;
    if (dt <= 0) return;
    // the tokens since the last step as a rate over that step, blended in with a 3 s time constant
    const inst = (t.fresh * 1000) / Math.max(dt, 250);
    const k = 1 - Math.exp(-dt / RATE_TAU_MS);
    t.rate += (inst - t.rate) * k;
    if (t.rate < RATE_FLOOR) t.rate = 0;
    t.fresh = 0;
    t.rateAt = now;
    while (t.window.length && t.window[0][0] <= now - MINUTE) t.window.shift();
  }

  private kick(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastFlush + this.interval - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Send what changed since the last delta. Returns it (tests), or undefined when nothing went out. */
  flush(): MapDelta | undefined {
    const now = this.now();
    this.lastFlush = now;
    const patches = new Map<string, MapNodePatch>();
    const patch = (id: string) => {
      let p = patches.get(id);
      if (!p) patches.set(id, (p = { id }));
      return p;
    };
    let moving = false;
    for (const [id, t] of this.tracks) {
      this.advance(t, now);
      const pm = perMin(t, now);
      const r = Math.round(t.rate * 10) / 10;
      const changed = (r === 0) !== (t.sentRate === 0) || Math.abs(r - t.sentRate) > Math.max(0.5, t.sentRate * 0.15) || Math.abs(pm - t.sentPerMin) > Math.max(20, t.sentPerMin * 0.2);
      if (changed) {
        const p = patch(id);
        p.rate = r;
        p.tokensPerMin = pm;
        t.sentRate = r;
        t.sentPerMin = pm;
      }
      if (t.rate > 0 || pm > 0) moving = true;
      if (t.toolDirty) {
        const p = patch(id);
        p.tool = this.current(id) ?? null;
        if (t.done.length) p.done = t.done;
        t.done = [];
        t.toolDirty = false;
      }
      if (t.usageDirty) {
        const u = this.opts.usage?.(id);
        if (u) patch(id).usage = u;
        t.usageDirty = false;
      }
      if (t.lastActivityAt && patches.has(id)) patch(id).lastActivityAt = t.lastActivityAt;
      // a quiet session with nothing in its last minute leaves the table
      if (!t.inflight.size && !t.window.length && t.rate === 0 && !t.recent.length) this.tracks.delete(id);
    }

    const wanted = this.opts.wanted ? this.opts.wanted() : true;
    // one delta per account (docs/design/ACCOUNTS.md): each person's map shows their own work only
    const accountOf = (id: string) => this.opts.accountOf?.(id) ?? 'owner';
    const whole = new Map<string, string[]>();
    for (const id of this.whole) {
      const acct = accountOf(id);
      whole.set(acct, [...(whole.get(acct) ?? []), id]);
    }
    const extra = new Map<string, { groups: MapGroup[]; devices: MapDevice[]; hub: MapDelta['hub'] }>();
    if (whole.size && this.opts.snapshot && wanted) {
      for (const [acct, ids] of whole) {
        const snap = this.opts.snapshot(acct);
        const byId = new Map(snap.nodes.map((n) => [n.id, n]));
        const needed = new Set<string>();
        for (const id of ids) {
          const n = byId.get(id);
          // not on the map (a workflow's host session, or one outside the window): nothing to send
          if (!n) continue;
          patch(id).node = n;
          needed.add(n.group);
        }
        const groups = snap.groups.filter((g) => needed.has(g.id));
        const devices = snap.devices.filter((d) => groups.some((g) => g.device === d.id));
        extra.set(acct, { groups, devices, hub: { state: snap.hub.state } });
      }
    }
    this.whole.clear();
    for (const id of this.removed) patch(id).removed = true;
    this.removed.clear();

    // decaying rates need more deltas until they reach zero
    if (moving) this.kick();
    if (!patches.size || !wanted) return undefined;
    const byAccount = new Map<string, MapNodePatch[]>();
    for (const p of patches.values()) {
      const acct = accountOf(p.id);
      byAccount.set(acct, [...(byAccount.get(acct) ?? []), p]);
    }
    let first: MapDelta | undefined;
    for (const [acct, nodes] of byAccount) {
      const x = extra.get(acct);
      const delta: MapDelta = {
        at: now,
        nodes,
        ...(this.opts.accountOf ? { accountId: acct } : {}),
        ...(x?.groups.length ? { groups: x.groups } : {}),
        ...(x?.devices.length ? { devices: x.devices } : {}),
        ...(x?.hub ? { hub: x.hub } : {}),
      };
      this.opts.bus.emit({ type: 'map.delta', delta });
      first ??= delta;
    }
    return first;
  }
}

function perMin(t: Track, now: number): number {
  let n = 0;
  for (const [at, k] of t.window) if (at > now - MINUTE) n += k;
  return n;
}
