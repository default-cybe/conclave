/**
 * Memory map DTOs (GET /api/memory/graph): everything the owner's memory
 * holds as one graph, every item once. Conclave's own memories and the
 * notes of a linked Basic Memory server are nodes; a memory mirrored as a
 * note is one node. Edges are only links that exist in the data: Basic
 * Memory relations and wiki links, a memory's place in a grouped note,
 * shared tags (a tag node) and the session a memory came from (a session
 * node). Each node names its area of life (People, Homelab, ...), the
 * first ring of the map.
 */

/** conclave: a Conclave memory, or a tag or session it points at. basic-memory: a note there. both: a memory and the note it is mirrored as. */
export type MemoryGraphSource = 'conclave' | 'basic-memory' | 'both';

/** Memory kinds, a Basic Memory note, and the tags and sessions memories share. */
export type MemoryGraphNodeKind = 'fact' | 'profile' | 'procedure' | 'episode' | 'inspiration' | 'note' | 'tag' | 'session';

export interface MemoryGraphNode {
  id: string;
  kind: MemoryGraphNodeKind;
  source: MemoryGraphSource;
  /** The memory's text (clipped), the note's title, the tag or the session's title. Clients shorten it for labels. */
  title: string;
  /** The Conclave memory (Memory > Notes opens it with ?focus=). */
  memoryId?: string;
  /** A session node, or the session a memory came from. */
  sessionId?: string;
  /** A Basic Memory note's folder ("entities/people"). */
  folder?: string;
  /** The area of life or work it belongs to ("People", "Homelab"): the map's first ring. */
  area: string;
  /** Last change, epoch ms, when known. */
  at?: number;
  /** Links in the whole graph. */
  degree: number;
}

/** relation: a Basic Memory relation or wiki link. note: a memory written into a grouped note. tag: shares a tag. session: came from a session. */
export type MemoryGraphEdgeKind = 'relation' | 'note' | 'tag' | 'session';

/** A link, compact: [from, to, label] as indexes into MemoryGraph.nodes and MemoryGraph.labels. */
export type MemoryGraphEdge = [from: number, to: number, label: number];

export interface MemoryGraph {
  /** Every item, no cap. */
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  /** The relation type in words ("relates to", "mentions"), or what the link is ("in note", "tagged", "from session"). */
  labels: string[];
  /** none: no Basic Memory connection. offline: it did not answer, so only Conclave's memory is drawn. */
  basicMemory: { state: 'ok' | 'offline' | 'none'; name?: string; error?: string };
}
