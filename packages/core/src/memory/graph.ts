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
 */
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphEdgeKind, MemoryGraphNode } from '../client/memory-graph';
import type { MemoryEntry } from '../types';
import { noteKeyOf, notePlace, perFactPermalink } from './connections/grouped';
import { IMPORTED_TAG, SOURCE_TAG_PREFIX, isActive } from './store';

/** Most nodes a map draws by default; the route takes up to MAX_LIMIT. */
export const GRAPH_LIMIT = 300;
export const GRAPH_MAX_LIMIT = 1000;
const TEXT_MAX = 600;

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
  limit?: number;
}

export function buildMemoryGraph(input: BuildGraphInput): MemoryGraph {
  const limit = Math.max(1, Math.min(GRAPH_MAX_LIMIT, Math.floor(input.limit ?? GRAPH_LIMIT)));
  const bm = input.bm;
  const nodes = new Map<string, MemoryGraphNode>();
  const edges = new Map<string, MemoryGraphEdge>();
  const addEdge = (from: string, to: string, kind: MemoryGraphEdgeKind, label: string) => {
    if (from === to) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}|${b}|${kind}`;
    if (!edges.has(key)) edges.set(key, { from, to, kind, label });
  };

  // ----- Basic Memory notes -------------------------------------------------------
  const byStem = new Map<string, MemoryGraphNode>();
  const byTitle = new Map<string, MemoryGraphNode>();
  for (const n of bm?.notes ?? []) {
    const folder = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
    const node: MemoryGraphNode = { id: `bm:${n.permalink}`, kind: 'note', source: 'basic-memory', title: n.title, note: { permalink: n.permalink, path: n.path, folder }, degree: 0, ...(n.at ? { at: n.at } : {}) };
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
      nodes.set(id, { id, source: 'conclave', at: e.updatedAt, degree: 0, ...own });
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
    nodes.set(id, { id, kind: 'tag', source: 'conclave', title: t, degree: 0 });
    for (const m of ids) addEdge(m, id, 'tag', 'tagged');
  }
  for (const [s, ids] of sessionMembers) {
    const id = `ses:${s}`;
    nodes.set(id, { id, kind: 'session', source: 'conclave', title: input.sessionTitle?.(s)?.trim() || 'A past session', sessionId: s, degree: 0 });
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

  // ----- the cap: the owner's memories first, then the best linked notes ------------------
  const chosen = pick([...nodes.values()], edges, limit, bm ? Math.ceil(limit / 2) : limit);
  const out = [...chosen].map((id) => nodes.get(id)!);
  return {
    nodes: out,
    edges: [...edges.values()].filter((e) => chosen.has(e.from) && chosen.has(e.to)),
    basicMemory: bm ? { state: 'ok', name: bm.name } : input.bmOffline ? { state: 'offline', name: input.bmOffline.name, error: input.bmOffline.error } : { state: 'none' },
    total: nodes.size,
    limit,
  };
}

/**
 * Which nodes stay under the cap. Memories rank by kind (profile first),
 * importance, use and age, and take up to `memoryShare` places; notes and
 * the rest rank by links, then by age. A tag joins once two chosen nodes
 * carry it and a session once one does, and each takes a place.
 */
function pick(all: MemoryGraphNode[], edges: Map<string, MemoryGraphEdge>, limit: number, memoryShare: number): Set<string> {
  const hubsOf = new Map<string, string[]>();
  for (const e of edges.values()) {
    if (e.kind !== 'tag' && e.kind !== 'session') continue;
    hubsOf.set(e.from, [...(hubsOf.get(e.from) ?? []), e.to]);
  }
  const isHub = (n: MemoryGraphNode) => n.kind === 'tag' || n.kind === 'session';
  const content = all.filter((n) => !isHub(n));
  const memories = content.filter((n) => n.memoryId);
  const rest = content.filter((n) => !n.memoryId);
  const kindRank = (n: MemoryGraphNode) => (n.kind === 'profile' ? 0 : 1);
  memories.sort((a, b) => kindRank(a) - kindRank(b) || b.degree - a.degree || (b.at ?? 0) - (a.at ?? 0) || (a.id < b.id ? -1 : 1));
  rest.sort((a, b) => b.degree - a.degree || (b.at ?? 0) - (a.at ?? 0) || (a.id < b.id ? -1 : 1));

  const chosen = new Set<string>();
  const members = new Map<string, number>();
  const add = (n: MemoryGraphNode) => {
    chosen.add(n.id);
    for (const h of hubsOf.get(n.id) ?? []) {
      const c = (members.get(h) ?? 0) + 1;
      members.set(h, c);
      if (chosen.size < limit && !chosen.has(h) && (h.startsWith('ses:') || c >= 2)) chosen.add(h);
    }
  };
  let mem = 0;
  for (const n of memories) {
    if (chosen.size >= limit || mem >= memoryShare) break;
    add(n);
    mem++;
  }
  const leftover = memories.slice(mem);
  // notes by links; memories past their share only after the notes
  for (const n of [...rest, ...leftover]) {
    if (chosen.size >= limit) break;
    add(n);
  }
  return chosen;
}
