/**
 * Memory > Map's model (MemoryMap.tsx), pure so test/memory-map.test.ts
 * checks it. The map is a mind map of the owner's whole memory: the brain
 * in the middle, the areas of his life and work around it (People,
 * Homelab, Courses, ... from GET /api/memory/graph), an area's items when
 * it is open, and an item's links when that is open. Any item can become
 * the center; then its links stand around it in groups by relation, as in
 * the focus graph prototype, with a trail back to the brain.
 *
 * Text only, no marks: every node is a label, and the links run from a
 * label's outer edge to the next label's inner edge. The layout is the
 * Map's (features/map/layout.ts) without the bend: each subtree grows
 * outward in columns as wide as their widest label, every leaf has a row
 * of its own and a parent sits in the middle of its children, so two
 * labels never overlap. Labels are short titles made the way the Map makes
 * them (features/map/model.ts mapLabel), never ids or slugs.
 */
import type { MemoryGraph, MemoryGraphNode } from '@conclave/core/client';
import type { Measure } from '@/features/map/layout';
import { mapLabel } from '@/features/map/model';

export const BRAIN = 'brain';
export const areaId = (name: string) => `area:${name}`;

const KIND_WORD: Record<MemoryGraphNode['kind'], string> = { fact: 'Fact', profile: 'Profile', procedure: 'Procedure', episode: 'Episode', note: 'Note', tag: 'Tag', session: 'Session' };

/** "Fact, in Conclave and Basic Memory", "Note in Basic Memory, entities/people". */
export function nodeWords(n: MemoryGraphNode): string {
  if (n.kind === 'tag') return 'Tag two or more memories share';
  if (n.kind === 'session') return 'Session memories came from';
  const where = n.source === 'both' ? 'in Conclave and Basic Memory' : n.source === 'basic-memory' ? 'in Basic Memory' : 'in Conclave';
  const folder = n.kind === 'note' && n.folder ? `, ${n.folder}` : '';
  return `${KIND_WORD[n.kind]} ${where}${folder}`;
}

/** A short name: 2 to 5 words, no ids, dates or slugs. A tag reads as the tag. */
export function nodeLabel(n: MemoryGraphNode): string {
  if (n.kind === 'tag') return `#${n.title}`;
  const base = n.title.replace(/^the (user|owner)('s)?\s+/i, '');
  const l = mapLabel({ title: base, kind: 'chat', agent: undefined, cwd: undefined });
  return l === 'Chat' ? KIND_WORD[n.kind] : l;
}

// ---------------------------------------------------------------------------
// The graph, indexed
// ---------------------------------------------------------------------------

export interface Nbr {
  id: string;
  label: string;
}

export interface Indexed {
  byId: Map<string, MemoryGraphNode>;
  /** Each item's links, most linked neighbor first. */
  nbrs: Map<string, Nbr[]>;
  /** Relation words by how often they occur. */
  labels: Array<{ label: string; count: number }>;
  /** The areas, biggest first; members most linked first. */
  areas: Array<{ name: string; ids: string[] }>;
}

const byRank = (a: MemoryGraphNode, b: MemoryGraphNode) => b.degree - a.degree || (b.at ?? 0) - (a.at ?? 0) || (a.id < b.id ? -1 : 1);

export function indexGraph(g: MemoryGraph): Indexed {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const nbrs = new Map<string, Nbr[]>(g.nodes.map((n) => [n.id, []]));
  const counts = new Map<string, number>();
  for (const [a, b, l] of g.edges) {
    const from = g.nodes[a];
    const to = g.nodes[b];
    const label = g.labels[l];
    if (!from || !to || label === undefined) continue;
    nbrs.get(from.id)!.push({ id: to.id, label });
    nbrs.get(to.id)!.push({ id: from.id, label });
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const deg = (id: string) => byId.get(id)?.degree ?? 0;
  for (const list of nbrs.values()) list.sort((a, b) => deg(b.id) - deg(a.id) || (a.id < b.id ? -1 : 1));
  const labels = [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
  const members = new Map<string, MemoryGraphNode[]>();
  for (const n of g.nodes) {
    const a = n.area || 'Other';
    const list = members.get(a);
    if (list) list.push(n);
    else members.set(a, [n]);
  }
  // Other last whatever its size: it is what no area took
  const areas = [...members]
    .map(([name, ns]) => ({ name, ids: ns.sort(byRank).map((n) => n.id) }))
    .sort((a, b) => Number(a.name === 'Other') - Number(b.name === 'Other') || b.ids.length - a.ids.length || (a.name < b.name ? -1 : 1));
  return { byId, nbrs, labels, areas };
}

// ---------------------------------------------------------------------------
// The tree on the map
// ---------------------------------------------------------------------------

export interface MapState {
  /** BRAIN, or the item in the middle. */
  center: string;
  /** Rings around an item center, 1 to 3. Past the first they fold into counts unless they fit `budget` or `unfold`. */
  depth: number;
  /** Relation words left out. */
  hidden: ReadonlySet<string>;
  /** Items the owner dismissed. */
  dismissed: ReadonlySet<string>;
  /** Areas (area:<name>) and items the owner opened. */
  open: ReadonlySet<string>;
  /** Rows "k more" added, by what it hangs off (an area, a group grp:<relation>, an item). */
  more: ReadonlyMap<string, number>;
  /** Links pulled in by hand or by a path: [parent on the map, item]. */
  extra?: ReadonlyArray<readonly [string, string]>;
  /** Zoomed in far enough that rings past the first read: they unfold. */
  unfold?: boolean;
  /** Rows that fit the screen at the zoom where labels read: ring 1 aims at it, and deeper rings unfold only within it. */
  budget?: number;
}

export type TKind = 'brain' | 'area' | 'focus' | 'group' | 'node' | 'more';

export interface TNode {
  /** Unique on the map: brain, area:<name>, grp:<relation>, more:<key>, or the item's id. */
  id: string;
  kind: TKind;
  item?: string;
  /** The column out from the center. */
  depth: number;
  /** The relation to the parent, in words. */
  via?: string;
  /** area and group: members; more: rows left out; node: links folded into it. */
  count?: number;
  /** more: what opening it adds rows to. */
  key?: string;
  children: TNode[];
}

/** Items an open area shows before "k more". */
export const CAP_AREA = 8;
/** Most and fewest members a relation group shows around an item center before "k more". */
export const CAP_GROUP = 8;
const CAP_GROUP_MIN = 3;
/** Links an opened item shows. */
export const CAP_OPEN = 8;
/** Links an item in ring 2 and 3 shows once unfolded. */
const CAP_DEEP = [0, 3, 2, 2];
/** Rows each "k more" adds. */
export const MORE_STEP = 20;
/** The most items on the map before the deepest rings stop. */
export const BUDGET = 240;

export function buildTree(ix: Indexed, s: MapState): { root: TNode; items: Set<string> } {
  const brain = s.center === BRAIN || !ix.byId.has(s.center);
  const root: TNode = brain ? { id: BRAIN, kind: 'brain', depth: 0, count: ix.byId.size, children: [] } : { id: s.center, kind: 'focus', item: s.center, depth: 0, children: [] };
  const items = new Set<string>(brain ? [] : [s.center]);
  // links pulled in by hand hang under the parent they were pulled from, not wherever the walk meets them first
  const forced = new Map<string, string[]>();
  const reserved = new Set<string>();
  for (const [a, b] of s.extra ?? []) {
    if (b === s.center || !ix.byId.has(b)) continue;
    forced.set(a, [...(forced.get(a) ?? []), b]);
    reserved.add(b);
  }
  const labelOf = (a: string, b: string) => ix.nbrs.get(a)?.find((n) => n.id === b)?.label ?? 'path';
  const free = (id: string) => !s.dismissed.has(id) && !items.has(id) && !reserved.has(id);
  const ok = (n: Nbr) => !s.hidden.has(n.label) && free(n.id);
  const shownOf = (key: string, cap: number) => cap + (s.more.get(key) ?? 0);
  const queue: Array<{ t: TNode; hop: number }> = [];
  // rows the tree takes: an item or a "more" row is one, a parent stops being one
  let rows = 0;
  const add = (parent: TNode, id: string, hop: number, via?: string) => {
    const t: TNode = { id, kind: 'node', item: id, depth: parent.depth + 1, via, children: [] };
    if ((parent.kind === 'node' || parent.kind === 'group') && !parent.children.length) rows--;
    rows++;
    items.add(id);
    reserved.delete(id);
    parent.children.push(t);
    queue.push({ t, hop });
  };
  const moreRow = (parent: TNode, key: string, left: number) => left > 0 && (rows++, parent.children.push({ id: `more:${key}`, kind: 'more', depth: parent.depth + 1, count: left, key, children: [] }));

  if (brain) {
    for (const a of ix.areas) {
      const id = areaId(a.name);
      const t: TNode = { id, kind: 'area', depth: 1, via: a.name, count: a.ids.length, children: [] };
      root.children.push(t);
      const pulled = (forced.get(id) ?? []).filter((v) => !items.has(v));
      for (const v of pulled) add(t, v, 2);
      if (!s.open.has(id)) continue;
      const rest = a.ids.filter(free);
      const cap = shownOf(id, CAP_AREA);
      for (const v of rest.slice(0, cap)) add(t, v, 2);
      moreRow(t, id, rest.length - Math.min(cap, rest.length));
    }
  } else queue.push({ t: root, hop: 0 });

  while (queue.length) {
    const { t, hop } = queue.shift()!;
    const u = t.item!;
    const opened = s.open.has(u);
    const pulled = (forced.get(u) ?? []).filter((v) => !items.has(v)).map((v) => ({ id: v, label: labelOf(u, v) }));
    const seen = new Set(pulled.map((p) => p.id));
    const cand: Nbr[] = [];
    for (const n of ix.nbrs.get(u) ?? []) if (!seen.has(n.id) && ok(n)) (seen.add(n.id), cand.push(n));

    if (t.kind === 'focus') {
      const groups = new Map<string, { pulled: Nbr[]; rest: Nbr[] }>();
      const group = (l: string) => groups.get(l) ?? (groups.set(l, { pulled: [], rest: [] }), groups.get(l)!);
      for (const n of pulled) group(n.label).pulled.push(n);
      for (const n of cand) group(n.label).rest.push(n);
      const order = [...groups].sort((a, b) => b[1].pulled.length + b[1].rest.length - (a[1].pulled.length + a[1].rest.length) || (a[0] < b[0] ? -1 : 1));
      // a hub with many relations shows fewer of each, so ring 1 stays about `budget` rows;
      // past that the smaller groups stay closed, one row each, until opened
      const budget = s.budget ?? 40;
      const per = Math.max(CAP_GROUP_MIN, Math.min(CAP_GROUP, Math.floor(budget / Math.max(1, order.length)) - 2));
      let spare = budget - order.length;
      for (const [label, g] of order) {
        const gid = `grp:${label}`;
        const n = g.pulled.length + g.rest.length;
        const grp: TNode = { id: gid, kind: 'group', depth: 1, via: label, count: n, children: [] };
        root.children.push(grp);
        rows++;
        const cost = Math.min(per, n) + (n > per ? 1 : 0) - 1;
        if (!s.open.has(gid) && !g.pulled.length && !s.more.has(gid) && cost > spare) continue;
        spare -= cost;
        for (const n of g.pulled) add(grp, n.id, 1, label);
        const cap = Math.max(0, shownOf(gid, per) - g.pulled.length);
        for (const n of g.rest.slice(0, cap)) add(grp, n.id, 1, label);
        moreRow(grp, gid, g.rest.length - Math.min(cap, g.rest.length));
      }
      continue;
    }
    for (const n of pulled) add(t, n.id, hop + 1, n.label);
    // around an item center, rings past the first unfold while they fit the screen's rows, or once zoomed in; anything the owner opened always does
    const grow = opened || (!brain && hop < s.depth && (!!s.unfold || rows + Math.min(cand.length, CAP_DEEP[hop] ?? 2) <= (s.budget ?? 40)));
    if (!grow || items.size >= BUDGET) {
      // folded: the links say how many there are, the owner opens or zooms in to see them
      if (cand.length) t.count = cand.length;
      continue;
    }
    const cap = shownOf(u, opened ? CAP_OPEN : (CAP_DEEP[hop] ?? 2));
    const shown = cand.slice(0, cap);
    for (const n of shown) add(t, n.id, hop + 1, n.label);
    if (opened || hop <= 1) moreRow(t, u, cand.length - shown.length);
    else if (cand.length > shown.length) t.count = cand.length - shown.length;
  }
  return { root, items };
}

/**
 * The path from what is on the map to `target`: the shortest chain from the
 * nearest item already on it (over every relation, filtered or not). It
 * returns the links to pull in, so the path hangs inside the tree under the
 * item it starts from. Around the brain, an item's path is its area.
 */
export function pathInto(ix: Indexed, center: string, onMap: ReadonlySet<string>, target: string): Array<readonly [string, string]> | undefined {
  if (!ix.byId.has(target) || target === center) return undefined;
  if (center === BRAIN || !ix.byId.has(center)) return onMap.has(target) ? [] : [[areaId(ix.byId.get(target)!.area || 'Other'), target]];
  if (onMap.has(target)) return [];
  // walk out from the target until an item on the map turns up
  const prev = new Map<string, string>([[target, target]]);
  const queue = [target];
  while (queue.length) {
    const u = queue.shift()!;
    for (const { id } of ix.nbrs.get(u) ?? []) {
      if (prev.has(id)) continue;
      prev.set(id, u);
      if (onMap.has(id)) {
        const out: Array<readonly [string, string]> = [];
        for (let a = id; a !== target; a = prev.get(a)!) out.push([a, prev.get(a)!]);
        return out;
      }
      queue.push(id);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface PNode {
  id: string;
  t: TNode;
  item?: MemoryGraphNode;
  /** The label's box: left edge, middle line, size. Links meet it at the middle line. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which side of the center it grows on; the center is 0. */
  side: 1 | -1 | 0;
  parent?: string;
  title: string;
  /** A number after the title: an area's or group's members, links folded into an item. */
  count?: string;
  font: 'name' | 'title' | 'meta';
}

export interface MLayout {
  nodes: PNode[];
  byId: Map<string, PNode>;
  /** Tree links, parent to child. */
  links: Array<{ from: string; to: string }>;
  bounds: { x: number; y: number; w: number; h: number };
}

/** Rows: a leaf's height. Phones get room for a finger. */
export const ROW = 28;
export const ROW_PHONE = 36;
const LABEL_H = 20;
const TITLE_MAX = 220;
const TITLE_MAX_PHONE = 170;
const COL_GAP = 44;
const COL_GAP_PHONE = 30;

const approx: Measure = (text, font) => Math.ceil(text.length * (font === 'name' ? 8 : font === 'title' ? 7 : 6.4)) + 12;
const num = (n: number) => n.toLocaleString('en-US');

/** Where a link meets a label: its inner edge, or for the center the edge on the child's side. */
export const inX = (p: PNode) => (p.side === -1 ? p.x + p.w : p.x);
export const outX = (p: PNode, toward: 1 | -1 | 0) => ((p.side || toward) === -1 ? p.x : p.x + p.w);

export function layoutTree(root: TNode, ix: Indexed, opts: { measure?: Measure; sides?: 'both' | 'right'; phone?: boolean; counts?: (t: TNode) => number | undefined } = {}): MLayout {
  const measure = opts.measure ?? approx;
  const row = opts.phone ? ROW_PHONE : ROW;
  const gap = opts.phone ? COL_GAP_PHONE : COL_GAP;
  const nodes: PNode[] = [];
  const byId = new Map<string, PNode>();
  const links: MLayout['links'] = [];

  const words = (t: TNode): Pick<PNode, 'title' | 'count' | 'font'> => {
    const c = opts.counts?.(t) ?? t.count;
    const count = c ? num(c) : undefined;
    if (t.kind === 'brain') return { title: 'Brain', count, font: 'name' };
    if (t.kind === 'area') return { title: t.via!, count, font: 'name' };
    if (t.kind === 'group') return { title: t.via!, count, font: 'meta' };
    if (t.kind === 'more') return { title: `${num(t.count!)} more`, font: 'title' };
    const n = ix.byId.get(t.item!)!;
    return { title: nodeLabel(n), count, font: t.kind === 'focus' ? 'name' : 'title' };
  };
  const info = new Map<TNode, { w: number; words: ReturnType<typeof words> }>();
  const titleMax = opts.phone ? TITLE_MAX_PHONE : TITLE_MAX;
  // the brain's name is 17px, measured as a 14px name scaled up
  const width = (wd: ReturnType<typeof words>, t: TNode) => Math.ceil(Math.min(titleMax, measure(wd.title, wd.font)) * (t.kind === 'brain' ? 1.22 : 1)) + (wd.count ? measure(wd.count, 'meta') - 6 : 0);

  // sides: around the brain, areas alternate so opening one never moves another; around an item, by rows
  const leaves = (t: TNode): number => (t.children.length ? t.children.reduce((s, c) => s + leaves(c), 0) : 1);
  const side = new Map<TNode, 1 | -1>();
  const rows = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  root.children.forEach((g, i) => {
    const sd: 1 | -1 = opts.sides === 'right' ? 1 : root.kind === 'brain' ? (i % 2 ? -1 : 1) : rows[1] <= rows[-1] ? 1 : -1;
    side.set(g, sd);
    rows[sd] += leaves(g);
  });

  // columns: as wide as their widest label, per side
  const colW = new Map<string, number>();
  const visit = (t: TNode, sd: 1 | -1 | 0) => {
    const wd = words(t);
    const w = width(wd, t);
    info.set(t, { w, words: wd });
    if (sd) colW.set(`${sd}:${t.depth}`, Math.max(colW.get(`${sd}:${t.depth}`) ?? 0, w));
    for (const c of t.children) visit(c, sd || side.get(c)!);
  };
  visit(root, 0);
  const rootW = info.get(root)!.w;
  /** The inner edge of column d on side sd, as a distance from the center. */
  const colX = (sd: 1 | -1, d: number): number => {
    let x = rootW / 2 + gap * 0.8;
    for (let i = 1; i < d; i++) x += (colW.get(`${sd}:${i}`) ?? 0) + gap;
    return x;
  };

  // rows: a row per leaf, a parent in the middle of its children, a little air between first-ring groups
  const ys = new Map<TNode, number>();
  const place = (t: TNode, cursor: number): number => {
    if (!t.children.length) {
      ys.set(t, cursor + row / 2);
      return cursor + row;
    }
    let c = cursor;
    for (const ch of t.children) c = place(ch, c);
    ys.set(t, (ys.get(t.children[0])! + ys.get(t.children[t.children.length - 1])!) / 2);
    return c;
  };
  const bandGap = Math.round(row * 0.4);
  for (const sd of [1, -1] as const) {
    const groups = root.children.filter((g) => side.get(g) === sd);
    let c = 0;
    // air only around a group with children: a closed area is one row
    groups.forEach((g, i) => (c = place(g, c + (i && (g.children.length || groups[i - 1].children.length) ? bandGap : 0))));
    const shift = -c / 2;
    const move = (t: TNode) => {
      ys.set(t, ys.get(t)! + shift);
      t.children.forEach(move);
    };
    groups.forEach(move);
  }
  ys.set(root, 0);

  const emit = (t: TNode, sd: 1 | -1 | 0, parent?: string) => {
    const { w, words: wd } = info.get(t)!;
    const y = ys.get(t)!;
    const x = sd === 0 ? -w / 2 : sd === 1 ? colX(1, t.depth) : -colX(-1, t.depth) - w;
    const p: PNode = { id: t.id, t, item: t.item ? ix.byId.get(t.item) : undefined, x, y, w, h: LABEL_H, side: sd, parent, ...wd };
    nodes.push(p);
    byId.set(p.id, p);
    if (parent) links.push({ from: parent, to: t.id });
    for (const c of t.children) emit(c, sd || side.get(c)!, t.id);
  };
  emit(root, 0);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; // prettier-ignore
  for (const p of nodes) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y - p.h / 2)), (x1 = Math.max(x1, p.x + p.w)), (y1 = Math.max(y1, p.y + p.h / 2)); // prettier-ignore
  return { nodes, byId, links, bounds: { x: x0 - 8, y: y0 - 8, w: x1 - x0 + 16, h: y1 - y0 + 16 } };
}

/** The ids from the center to a node, both ends included. */
export function chainTo(l: MLayout, id: string): string[] {
  const out: string[] = [];
  for (let p = l.byId.get(id); p; p = p.parent ? l.byId.get(p.parent) : undefined) out.unshift(p.id);
  return out;
}

/** Search: title or folder, any case; items on the map first, then the most linked. */
export function searchItems(ix: Indexed, q: string, onMap: ReadonlySet<string>): MemoryGraphNode[] {
  const t = q.trim().toLowerCase();
  if (t.length < 2) return [];
  const out: MemoryGraphNode[] = [];
  for (const n of ix.byId.values()) if (n.title.toLowerCase().includes(t) || (n.folder?.toLowerCase().includes(t) ?? false)) out.push(n);
  return out.sort((a, b) => Number(onMap.has(b.id)) - Number(onMap.has(a.id)) || byRank(a, b));
}
