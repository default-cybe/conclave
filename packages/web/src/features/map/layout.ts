/**
 * Where everything sits on the Map (docs/DESIGN.md 29). Pure: the same
 * snapshot always gives the same picture, and test/map-layout.test.ts
 * checks that no two marks or labels overlap.
 *
 * The hub is at (0, 0). Its children (devices, and the groups on the hub
 * itself) stack in bands to its left and right, and each subtree grows
 * outward in columns: device, project, session, subagent. Every leaf has a
 * row of its own and a parent sits at the middle of its children, so rows
 * never collide. A node with children carries its label above it; a leaf
 * carries it beside, on the outer side. Last, each side bends gently around
 * the hub; when a bend would make two things touch, it is made smaller
 * until nothing does.
 */
import type { MapDevice, MapGroup, MapNode, MapSnapshot } from '@conclave/core/client';
import { STATE_WORD, groupLine, groupStats, shortId, stuckWords } from './model';

export type LKind = 'hub' | 'device' | 'group' | 'node';

export interface LBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LNode {
  id: string;
  kind: LKind;
  node?: MapNode;
  group?: MapGroup;
  device?: MapDevice;
  x: number;
  y: number;
  /** Radius of the mark. */
  r: number;
  /** 1: right of the hub, -1: left. The hub is 0. */
  side: 1 | -1 | 0;
  depth: number;
  /** The node it hangs off on the map (the hub for the first ring). */
  parent?: string;
  leaf: boolean;
  label: LBox & { place: 'beside' | 'above' | 'below'; title: string; meta: string };
}

export interface LLink {
  /** The child's id: one link per child. */
  id: string;
  from: string;
  to: string;
  /** A cubic from the child to the parent: x0 y0, c1, c2, x3 y3. */
  p: [number, number, number, number, number, number, number, number];
}

export interface Layout {
  nodes: LNode[];
  byId: Map<string, LNode>;
  links: LLink[];
  bounds: LBox;
}

/** Text width in px. title: 13px medium, meta: 12px, name: 14px semibold (the hub and groups). */
export type Measure = (text: string, font: 'title' | 'meta' | 'name') => number;

export interface LayoutOptions {
  measure?: Measure;
  /** both: subtrees left and right of the hub (desktop). right: all on the right, for a tall phone screen. */
  sides?: 'both' | 'right';
  /** Phones: tighter columns. */
  compact?: boolean;
  /** The screen's width over its height: rows spread apart (up to 1.7 times) until the map is about that shape. */
  aspect?: number;
  now?: number;
}

export const ROW = 40;
export const LABEL_H = 32;
/** Room above a node with children for its label. */
export const LABEL_PAD = 38;
export const TITLE_MAX = 184;
export const NAME_MAX = 200;
const GAP = 10;
const BAND_GAP = 14;
const HUB_R = 34;
const MARGIN = 2;

/** Mark radius by kind. */
export function markRadius(kind: LKind, n?: MapNode): number {
  if (kind === 'hub') return HUB_R;
  if (kind === 'device') return 7;
  if (kind === 'group') return 11;
  if (n?.kind === 'workflow') return 7;
  if (n?.kind === 'subagent' || n?.kind === 'agent') return 4.5;
  return 6;
}

/** A width guess per character for Mona Sans; the browser passes a real measure. */
export const approxMeasure: Measure = (text, font) => {
  const size = font === 'name' ? 14 : font === 'title' ? 13 : 12;
  let w = 0;
  for (const ch of text) {
    if ('il.,:;!|\'`'.includes(ch)) w += 0.27;
    else if (ch === ' ') w += 0.28;
    else if ('mwMW@'.includes(ch)) w += 0.82;
    else if (ch >= 'A' && ch <= 'Z') w += 0.66;
    else if (ch >= '0' && ch <= '9') w += 0.58;
    else w += 0.53;
  }
  return Math.ceil(w * size * (font === 'name' ? 1.04 : 1));
};

interface T {
  id: string;
  kind: LKind;
  node?: MapNode;
  group?: MapGroup;
  device?: MapDevice;
  children: T[];
  depth: number;
  side: 1 | -1;
  extent: number;
  x: number;
  y: number;
  r: number;
  title: string;
  meta: string;
  lw: number;
}

/** The words a node's label shows: its title, then its short id and state (or how long it has been stuck). */
export function labelWords(n: MapNode, now = Date.now()): { title: string; meta: string } {
  return { title: n.title, meta: `${shortId(n.id)}  ${stuckWords(n, now) ?? STATE_WORD[n.state]}` };
}

export function hubWords(snap: Pick<MapSnapshot, 'hub' | 'nodes'>, online = true): { title: string; meta: string } {
  const counted = snap.nodes.filter((n) => n.kind !== 'workflow');
  const running = counted.filter((n) => n.state === 'running').length;
  const waiting = counted.filter((n) => n.state === 'waiting').length;
  const meta = !online ? 'offline' : waiting ? `${waiting} waiting on you` : running ? `${running} running` : 'idle';
  return { title: snap.hub.name, meta };
}

export function layoutMap(snap: Pick<MapSnapshot, 'hub' | 'nodes' | 'groups' | 'devices' | 'live'>, opts: LayoutOptions = {}): Layout {
  const measure = opts.measure ?? approxMeasure;
  const now = opts.now ?? Date.now();
  const compact = !!opts.compact;

  // ----- the tree ---------------------------------------------------------------
  const nodeIds = new Set(snap.nodes.map((n) => n.id));
  const groupIds = new Set(snap.groups.map((g) => g.id));
  const kids = new Map<string, MapNode[]>();
  const tops = new Map<string, MapNode[]>();
  for (const n of snap.nodes) {
    if (n.parentId && nodeIds.has(n.parentId)) {
      const l = kids.get(n.parentId) ?? [];
      l.push(n);
      kids.set(n.parentId, l);
    } else {
      const l = tops.get(n.group) ?? [];
      l.push(n);
      tops.set(n.group, l);
    }
  }
  const byStart = (a: MapNode, b: MapNode) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1);
  /** `wide`: the widest the second line can get, so a state that changes never moves the map. */
  const mk = (id: string, kind: LKind, depth: number, title: string, meta: string, wide: string, font: 'title' | 'name', extra: Partial<T> = {}): T => {
    const max = kind === 'node' ? TITLE_MAX : NAME_MAX;
    const lw = Math.max(Math.min(max, measure(title, font)), Math.min(max, Math.max(measure(meta, 'meta'), measure(wide, 'meta'))), kind === 'node' ? 118 : 60) + 4;
    return { id, kind, children: [], depth, side: 1, extent: 0, x: 0, y: 0, r: markRadius(kind, extra.node), title, meta, lw, ...extra };
  };
  const nodeT = (n: MapNode, depth: number, seen: Set<string>): T => {
    seen.add(n.id);
    const w = labelWords(n, now);
    const t = mk(n.id, 'node', depth, w.title, w.meta, `${shortId(n.id)}  ${STATE_WORD.waiting}`, 'title', { node: n });
    t.children = (kids.get(n.id) ?? []).filter((c) => !seen.has(c.id)).sort(byStart).map((c) => nodeT(c, depth + 1, seen));
    return t;
  };
  const seen = new Set<string>();
  const groupT = (g: MapGroup, depth: number): T => {
    const line = groupLine(groupStats(g.id, snap.nodes), g.kind === 'chats');
    const t = mk(`grp:${g.id}`, 'group', depth, g.name, line, line, 'name', { group: g });
    t.children = (tops.get(g.id) ?? []).sort(byStart).map((n) => nodeT(n, depth + 1, seen));
    return t;
  };
  // nodes whose group is missing from the snapshot still get one
  const groups = [...snap.groups];
  for (const g of tops.keys()) if (!groupIds.has(g)) groups.push({ id: g, kind: 'folder', name: g.split(':').pop() || g, device: 'local' });
  const byName = (a: MapGroup, b: MapGroup) => (a.kind === 'chats' ? 1 : 0) - (b.kind === 'chats' ? 1 : 0) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
  const devices = new Map(snap.devices.map((d) => [d.id, d]));
  for (const g of groups) if (g.device !== 'local' && !devices.has(g.device)) devices.set(g.device, { id: g.device, name: g.device });

  const first: T[] = [];
  for (const g of groups.filter((x) => x.device === 'local' && x.kind !== 'chats').sort(byName)) first.push(groupT(g, 1));
  for (const d of [...devices.values()].filter((x) => x.id !== 'local').sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))) {
    const meta = d.online === undefined ? 'device' : d.online ? 'online' : 'offline';
    const t = mk(`dev:${d.id}`, 'device', 1, d.name, meta, 'offline', 'name', { device: d });
    t.children = groups
      .filter((x) => x.device === d.id)
      .sort(byName)
      .map((g) => groupT(g, 2));
    first.push(t);
  }
  for (const g of groups.filter((x) => x.kind === 'chats')) first.push(groupT(g, 1));

  // ----- bands: every leaf a row, a parent above its children -------------------
  const extent = (t: T): number => {
    if (!t.children.length) return (t.extent = ROW);
    let h = LABEL_PAD;
    t.children.forEach((c, i) => (h += extent(c) + (i && (c.children.length || t.children[i - 1].children.length) ? 8 : 0)));
    return (t.extent = h);
  };
  for (const t of first) extent(t);

  const sides: Record<1 | -1, T[]> = { 1: [], [-1]: [] } as Record<1 | -1, T[]>;
  const load = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  for (const t of first) {
    const side: 1 | -1 = opts.sides === 'right' || load[1] <= load[-1] ? 1 : -1;
    sides[side].push(t);
    load[side] += t.extent + BAND_GAP;
  }

  // ----- columns ---------------------------------------------------------------------
  const all: T[] = [];
  const walk = (t: T, side: 1 | -1) => {
    t.side = side;
    all.push(t);
    for (const c of t.children) walk(c, side);
  };
  for (const s of [1, -1] as const) for (const t of sides[s]) walk(t, s);
  const hub = hubWords(snap, true);
  const hubW = Math.max(measure(hub.title, 'name'), measure(`${hub.meta}   `, 'meta'), 2 * HUB_R) + 4;
  const maxDepth = all.reduce((m, t) => Math.max(m, t.depth), 0);
  const halfAbove = (d: number) => all.filter((t) => t.depth === d && t.children.length).reduce((m, t) => Math.max(m, t.lw / 2), 0);
  const minGap = compact ? 100 : 112;
  const colX: number[] = [0, Math.max(compact ? 132 : 150, hubW / 2 + halfAbove(1) + 28, HUB_R + 60)];
  for (let d = 1; d < maxDepth; d++) colX[d + 1] = colX[d] + Math.max(minGap, halfAbove(d) + halfAbove(d + 1) + 24, halfAbove(d) + 52);

  const place = (t: T, top: number) => {
    t.x = t.side * colX[t.depth];
    if (!t.children.length) {
      t.y = top + ROW / 2;
      return;
    }
    let y = top + LABEL_PAD;
    t.children.forEach((c, i) => {
      if (i && (c.children.length || t.children[i - 1].children.length)) y += 8;
      place(c, y);
      y += c.extent;
    });
    t.y = (t.children[0].y + t.children[t.children.length - 1].y) / 2;
  };
  for (const s of [1, -1] as const) {
    const total = sides[s].reduce((h, t) => h + t.extent, 0) + Math.max(0, sides[s].length - 1) * BAND_GAP;
    let y = -total / 2;
    for (const t of sides[s]) {
      place(t, y);
      y += t.extent + BAND_GAP;
    }
  }

  // ----- a wide screen and a flat map: spread the rows, never closer, so nothing new can touch ---
  if (opts.aspect && all.length) {
    let x0 = -hubW / 2;
    let x1 = hubW / 2;
    let y0 = -HUB_R;
    let y1 = HUB_R + 10 + LABEL_H;
    for (const t of all) {
      x0 = Math.min(x0, t.x - (t.side === -1 ? t.lw + 20 : t.lw / 2));
      x1 = Math.max(x1, t.x + (t.side === 1 ? t.lw + 20 : t.lw / 2));
      y0 = Math.min(y0, t.y - ROW);
      y1 = Math.max(y1, t.y + ROW);
    }
    const stretch = Math.min(1.7, Math.max(1, (x1 - x0) / opts.aspect / Math.max(1, y1 - y0)));
    if (stretch > 1.02) for (const t of all) t.y *= stretch;
  }

  // ----- the result, with the largest bend that keeps everything apart ---------------
  const build = (k: number): Layout => {
    const out: LNode[] = [];
    out.push({
      id: 'hub',
      kind: 'hub',
      x: 0,
      y: 0,
      r: HUB_R,
      side: 0,
      depth: 0,
      leaf: false,
      label: { x: -hubW / 2, y: HUB_R + 10, w: hubW, h: LABEL_H, place: 'below', title: hub.title, meta: hub.meta },
    });
    const parentOf = new Map<string, string>();
    for (const t of first) parentOf.set(t.id, 'hub');
    for (const t of all) for (const c of t.children) parentOf.set(c.id, t.id);
    for (const t of all) {
      const x = t.x - t.side * k * bends[t.side] * t.y * t.y;
      const leaf = !t.children.length;
      const label = leaf
        ? { x: t.side === 1 ? x + t.r + GAP : x - t.r - GAP - t.lw, y: t.y - LABEL_H / 2, w: t.lw, h: LABEL_H, place: 'beside' as const }
        : { x: x - t.lw / 2, y: t.y - t.r - 6 - LABEL_H, w: t.lw, h: LABEL_H, place: 'above' as const };
      out.push({ id: t.id, kind: t.kind, node: t.node, group: t.group, device: t.device, x, y: t.y, r: t.r, side: t.side, depth: t.depth, parent: parentOf.get(t.id), leaf, label: { ...label, title: t.title, meta: t.meta } });
    }
    const byId = new Map(out.map((n) => [n.id, n]));
    const links: LLink[] = [];
    for (const n of out) {
      if (!n.parent) continue;
      const p = byId.get(n.parent)!;
      const dx = p.x - n.x;
      links.push({ id: n.id, from: n.id, to: p.id, p: [n.x, n.y, n.x + dx * 0.5, n.y, p.x - dx * 0.5, p.y, p.x, p.y] });
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of boxes(out)) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return { nodes: out, byId, links, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  };

  // each side bends by its own height, so one side growing leaves the other where it was
  const bends = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  for (const s of [1, -1] as const) {
    const maxY = all.filter((t) => t.side === s).reduce((m, t) => Math.max(m, Math.abs(t.y)), 1);
    bends[s] = Math.min(compact ? 0.0005 : 0.0007, (0.3 * colX[1]) / (maxY * maxY));
  }
  for (let k = 1; k > 0.02; k /= 2) {
    const l = build(k);
    if (!overlaps(l).length) return l;
  }
  return build(0);
}

/**
 * Where a phone opens the map: the hub and its busiest project (the most
 * running and waiting, then the most agents). The hub's knot, and the
 * project's mark and label: its name matters more than the hub's line,
 * which the sentence over the map says too. A hub with no project gives its
 * chats, and an empty hub the hub alone.
 */
export function focusBox(l: Pick<Layout, 'nodes' | 'byId'>, nodes: MapNode[]): LBox {
  const groups = l.nodes.filter((n) => n.kind === 'group' && n.group);
  const score = (n: LNode) => {
    const s = groupStats(n.group!.id, nodes);
    return [n.group!.kind === 'chats' ? 0 : 1, s.running + s.waiting, s.agents];
  };
  const better = (a: LNode, b: LNode) => {
    const [x, y] = [score(a), score(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return a.id < b.id;
  };
  const top = groups.reduce<LNode | undefined>((best, n) => (!best || better(n, best) ? n : best), undefined);
  const parts = boxes([l.byId.get('hub'), top].filter((n): n is LNode => !!n)).filter((b) => b.id !== 'hub' || b.what === 'mark');
  const x0 = Math.min(...parts.map((b) => b.x));
  const y0 = Math.min(...parts.map((b) => b.y));
  return { x: x0, y: y0, w: Math.max(...parts.map((b) => b.x + b.w)) - x0, h: Math.max(...parts.map((b) => b.y + b.h)) - y0 };
}

/** Every mark and label as a box, with the id it belongs to. */
export function boxes(nodes: LNode[]): Array<LBox & { id: string; what: 'mark' | 'label' }> {
  const out: Array<LBox & { id: string; what: 'mark' | 'label' }> = [];
  for (const n of nodes) {
    out.push({ id: n.id, what: 'mark', x: n.x - n.r, y: n.y - n.r, w: 2 * n.r, h: 2 * n.r });
    out.push({ id: n.id, what: 'label', x: n.label.x, y: n.label.y, w: n.label.w, h: n.label.h });
  }
  return out;
}

/** Pairs of marks or labels of different nodes that touch (2px apart at least). */
export function overlaps(l: Pick<Layout, 'nodes'>): Array<[string, string]> {
  const b = boxes(l.nodes);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < b.length; i++)
    for (let j = i + 1; j < b.length; j++) {
      const p = b[i];
      const q = b[j];
      if (p.id === q.id) continue;
      if (p.x < q.x + q.w + MARGIN && q.x < p.x + p.w + MARGIN && p.y < q.y + q.h + MARGIN && q.y < p.y + p.h + MARGIN) out.push([`${p.id}:${p.what}`, `${q.id}:${q.what}`]);
    }
  return out;
}

/** A point on a link's cubic at t (0 at the child, 1 at the parent). */
export function cubicAt(p: LLink['p'], t: number, out: [number, number] = [0, 0]): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  out[0] = a * p[0] + b * p[2] + c * p[4] + d * p[6];
  out[1] = a * p[1] + b * p[3] + c * p[5] + d * p[7];
  return out;
}
