/**
 * The memory map's graph (GET /api/memory/graph): Conclave's memories and a
 * Basic Memory server's notes in one picture. Pure, so
 * test/memory/graph.test.ts checks it without a server.
 *
 * Only links that exist in the data become edges: Basic Memory relations
 * and wiki links (recent_activity gives them as permalinks), a memory's line
 * in a grouped note Conclave writes, a tag two memories share (through a
 * tag node, so a common tag is a star and not a tangle) and the session a
 * memory came from. A fact or procedure Conclave mirrored as its own note
 * (perFactPermalink) and a note imported from the server are one node.
 *
 * Every item goes out, once, with edges as index triples, so search and
 * paths on the map reach all of it (about 3,000 items are a few hundred KB).
 */
import type { MemoryGraph, MemoryGraphEdgeKind, MemoryGraphNode } from '../client/memory-graph';
import type { MemoryEntry } from '../types';
import { noteKeyOf, notePlace, perFactPermalink } from './connections/grouped';
import { IMPORTED_TAG, SOURCE_TAG_PREFIX, isActive } from './store';

const TEXT_MAX = 600;

/**
 * The map's first ring: areas of the owner's life and work, chosen from his
 * Basic Memory folders (people 323, services 147, courses 150, ...). Small
 * folders that belong together fold into one area (nodes, containers and
 * homelab are Homelab). A folder no rule names becomes an area of its own
 * once it has AREA_MIN notes, else Other.
 */
const AREA_RULES: Array<[string, RegExp]> = [
  ['People', /^((entities\/)?people|profile)$/],
  ['Projects', /^(entities\/)?projects$/],
  ['Courses', /^entities\/courses$/],
  ['Homelab', /^(homelab|entities\/(nodes|containers|domains))$/],
  ['Services', /^entities\/services$/],
  ['Devices', /^entities\/devices$/],
  ['Vendors', /^entities\/(vendors|accounts)$/],
  ['Security', /^entities\/(cves|incidents|certs)$/],
  ['Conversations', /^conversations(\/|$)/],
  ['Conclave', /^conclave(\/|$)/],
  ['Topics', /^(areas|topics)$/],
];
export const AREA_MIN = 20;

/** "entities/cooking" reads as "Cooking"; a year keeps the part before it. */
const folderWord = (folder: string) => {
  const w = folder.split('/').filter((p) => p && !/^\d+$/.test(p) && p !== 'entities').pop() ?? '';
  return w ? w[0].toUpperCase() + w.slice(1).replace(/[-_]+/g, ' ') : '';
};

/** Areas for every node: a note by its folder, a profile memory under People, the rest of Conclave's own under Conclave. */
export function assignAreas(nodes: MemoryGraphNode[]): void {
  const ruled = (f: string) => AREA_RULES.find(([, re]) => re.test(f))?.[0];
  const sizes = new Map<string, number>();
  for (const n of nodes) if (n.folder !== undefined && !ruled(n.folder)) sizes.set(folderWord(n.folder), (sizes.get(folderWord(n.folder)) ?? 0) + 1);
  for (const n of nodes) {
    if (n.folder !== undefined) {
      const w = folderWord(n.folder);
      n.area = ruled(n.folder) ?? (w && (sizes.get(w) ?? 0) >= AREA_MIN ? w : 'Other');
    } else n.area = n.kind === 'profile' ? 'People' : 'Conclave';
  }
}

/** A note as Basic Memory's recent_activity lists it. */
export interface BmNoteRow {
  /** Permalink with the project in front ("main/entities/people/ada"). */
  permalink: string;
  title: string;
  /** File path inside the project ("entities/people/Ada.md"). */
  path: string;
  at?: number;
}

export interface BmLinkRow {
  from: string;
  /** Relation type in words. */
  type: string;
  to: string;
}

export interface BmGraphData {
  /** Connection id: imported memories carry source:<id>. */
  connection: string;
  name: string;
  /** The folder Conclave writes into (default conclave). */
  folder: string;
  notes: BmNoteRow[];
  links: BmLinkRow[];
}

const rowStr = (r: Record<string, unknown>, k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
const stem = (path: string) => path.replace(/\.md$/i, '').toLowerCase();

/**
 * Notes and links from recent_activity rows (type entity and relation). A
 * relation row's permalink is "<from permalink>/<relation-type>/<target>"
 * and its file_path is the source note's. A target that names no note (a
 * forward reference) is left out, so no edge points at nothing.
 */
export function parseBmActivity(entities: unknown[], relations: unknown[]): { notes: BmNoteRow[]; links: BmLinkRow[] } {
  const notes = new Map<string, BmNoteRow>();
  const byPath = new Map<string, BmNoteRow>();
  const byLast = new Map<string, BmNoteRow | null>();
  for (const raw of entities) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const permalink = rowStr(r, 'permalink');
    const title = rowStr(r, 'title')?.trim();
    const path = rowStr(r, 'file_path') ?? '';
    if (!permalink || !title || notes.has(permalink)) continue;
    const at = Date.parse(rowStr(r, 'updated_at') ?? rowStr(r, 'created_at') ?? '');
    const n: BmNoteRow = { permalink, title, path, ...(Number.isFinite(at) ? { at } : {}) };
    notes.set(permalink, n);
    if (path) byPath.set(path, n);
    const last = permalink.split('/').pop()!;
    byLast.set(last, byLast.has(last) ? null : n);
  }
  const resolve = (from: BmNoteRow, target: string): BmNoteRow | undefined => {
    const project = from.permalink.split('/')[0];
    // a last part shared by two notes is ambiguous: no edge rather than a wrong one
    return notes.get(target) ?? notes.get(`${project}/${target}`) ?? (target.includes('/') ? undefined : (byLast.get(target) ?? undefined));
  };
  const links: BmLinkRow[] = [];
  const seen = new Set<string>();
  for (const raw of relations) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const permalink = rowStr(r, 'permalink');
    const path = rowStr(r, 'file_path');
    const from = path ? byPath.get(path) : undefined;
    if (!permalink || !from || !permalink.startsWith(`${from.permalink}/`)) continue;
    const [type, ...rest] = permalink.slice(from.permalink.length + 1).split('/');
    const to = rest.length ? resolve(from, rest.join('/')) : undefined;
    if (!type || !to || to === from) continue;
    const key = `${from.permalink}|${type}|${to.permalink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ from: from.permalink, type: type.replace(/[-_]+/g, ' '), to: to.permalink });
  }
  return { notes: [...notes.values()], links };
}

/** Tags that say where a row came from, not what it is about. */
function linkTag(t: string): boolean {
  return t !== IMPORTED_TAG && t !== 'learned' && !t.startsWith(SOURCE_TAG_PREFIX) && !t.startsWith('batch:') && !t.startsWith('kind:');
}

export interface BuildGraphInput {
  memories: MemoryEntry[];
  /** A session's title, when the hub still has it. */
  sessionTitle?: (id: string) => string | undefined;
  bm?: BmGraphData;
  /** Basic Memory is linked but did not answer. */
  bmOffline?: { name: string; error: string };
}

export function buildMemoryGraph(input: BuildGraphInput): MemoryGraph {
  const bm = input.bm;
  const nodes = new Map<string, MemoryGraphNode>();
  const edges = new Map<string, { from: string; to: string; label: string }>();
  const addEdge = (from: string, to: string, kind: MemoryGraphEdgeKind, label: string) => {
    if (from === to) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}|${b}|${kind}`;
    if (!edges.has(key)) edges.set(key, { from, to, label });
  };

  // ----- Basic Memory notes -------------------------------------------------------
  const byStem = new Map<string, MemoryGraphNode>();
  const byTitle = new Map<string, MemoryGraphNode>();
  for (const n of bm?.notes ?? []) {
    const folder = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
    const node: MemoryGraphNode = { id: `bm:${n.permalink}`, kind: 'note', source: 'basic-memory', title: n.title, folder, area: '', degree: 0, ...(n.at ? { at: n.at } : {}) };
    nodes.set(node.id, node);
    if (n.path) byStem.set(stem(n.path), node);
    byTitle.set(n.title.toLowerCase(), node);
  }
  // the connection's folder option renames the conclave folder Conclave writes into
  const inFolder = (p: string) => (bm && bm.folder !== 'conclave' ? p.replace(/^conclave(?=\/|$)/, bm.folder) : p).toLowerCase();

  // ----- Conclave memories, merged with the note they are mirrored as -----------------
  const tagMembers = new Map<string, string[]>();
  const sessionMembers = new Map<string, string[]>();
  for (const e of input.memories) {
    if (!isActive(e)) continue;
    let mirror: MemoryGraphNode | undefined;
    if (bm) {
      const pf = perFactPermalink(e);
      if (pf) mirror = byStem.get(inFolder(pf));
      // a note imported from this server starts with the note's title (store.ts upsertImported)
      if (!mirror && e.tags.includes(`${SOURCE_TAG_PREFIX}${bm.connection}`)) {
        const text = e.content.toLowerCase();
        mirror = byTitle.get(text.split(/:\s/)[0]);
        // shortcut: a scan per imported memory, fine for a few thousand notes
        let best = '';
        if (!mirror) for (const [t, n] of byTitle) if (t.length >= 3 && t.length > best.length && text.startsWith(t)) [best, mirror] = [t, n];
      }
    }
    // the memory's own words, not the cut title its note got
    const title = e.content.length > TEXT_MAX ? `${e.content.slice(0, TEXT_MAX - 1)}…` : e.content;
    const own = { kind: e.kind, memoryId: e.id, title, ...(e.sourceSessionId ? { sessionId: e.sourceSessionId } : {}) };
    let id: string;
    if (mirror && !mirror.memoryId) {
      Object.assign(mirror, own, { source: 'both', at: Math.max(mirror.at ?? 0, e.updatedAt) });
      id = mirror.id;
    } else {
      id = `mem:${e.id}`;
      nodes.set(id, { id, source: 'conclave', area: '', at: e.updatedAt, degree: 0, ...own });
    }
    if (bm && !e.tags.includes(IMPORTED_TAG)) {
      const key = noteKeyOf(e);
      if (key) {
        const { folder, title } = notePlace(key);
        const note = byStem.get(inFolder(`${folder}/${title}`));
        if (note) addEdge(id, note.id, 'note', 'in note');
      }
    }
    for (const t of new Set(e.tags.filter(linkTag))) tagMembers.set(t, [...(tagMembers.get(t) ?? []), id]);
    if (e.sourceSessionId) sessionMembers.set(e.sourceSessionId, [...(sessionMembers.get(e.sourceSessionId) ?? []), id]);
  }

  // ----- tags two memories share, and the sessions memories came from ---------------
  for (const [t, ids] of tagMembers) {
    if (new Set(ids).size < 2) continue;
    const id = `tag:${t}`;
    nodes.set(id, { id, kind: 'tag', source: 'conclave', title: t, area: '', degree: 0 });
    for (const m of ids) addEdge(m, id, 'tag', 'tagged');
  }
  for (const [s, ids] of sessionMembers) {
    const id = `ses:${s}`;
    nodes.set(id, { id, kind: 'session', source: 'conclave', title: input.sessionTitle?.(s)?.trim() || 'A past session', sessionId: s, area: '', degree: 0 });
    for (const m of ids) addEdge(m, id, 'session', 'from session');
  }

  // ----- Basic Memory relations and wiki links -----------------------------------------
  for (const l of bm?.links ?? []) {
    const a = `bm:${l.from}`;
    const b = `bm:${l.to}`;
    if (nodes.has(a) && nodes.has(b)) addEdge(a, b, 'relation', l.type);
  }

  for (const e of edges.values()) {
    nodes.get(e.from)!.degree++;
    nodes.get(e.to)!.degree++;
  }

  const out = [...nodes.values()];
  assignAreas(out);
  const index = new Map(out.map((n, i) => [n.id, i]));
  const labels: string[] = [];
  const labelIx = new Map<string, number>();
  const ix = (l: string) => labelIx.get(l) ?? (labelIx.set(l, labels.push(l) - 1), labels.length - 1);
  return {
    nodes: out,
    edges: [...edges.values()].map((e) => [index.get(e.from)!, index.get(e.to)!, ix(e.label)]),
    labels,
    basicMemory: bm ? { state: 'ok', name: bm.name } : input.bmOffline ? { state: 'offline', name: input.bmOffline.name, error: input.bmOffline.error } : { state: 'none' },
  };
}
