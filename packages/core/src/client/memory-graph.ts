/**
 * Memory map DTOs (GET /api/memory/graph): everything the owner's memory
 * holds as one graph. Conclave's own memories and the notes of a linked
 * Basic Memory server are nodes; a memory mirrored as a note is one node.
 * Edges are only links that exist in the data: Basic Memory relations and
 * wiki links, a memory's place in a grouped note, shared tags (a tag node)
 * and the session a memory came from (a session node).
 */

/** conclave: a Conclave memory, or a tag or session it points at. basic-memory: a note there. both: a memory and the note it is mirrored as. */
export type MemoryGraphSource = 'conclave' | 'basic-memory' | 'both';

/** Memory kinds, a Basic Memory note, and the tags and sessions memories share. */
export type MemoryGraphNodeKind = 'fact' | 'profile' | 'procedure' | 'episode' | 'note' | 'tag' | 'session';

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
  /** A Basic Memory note: its permalink, file path and folder. */
  note?: { permalink: string; path: string; folder: string };
  /** Last change, epoch ms, when known. */
  at?: number;
  /** Links in the whole graph, before the node cap. */
  degree: number;
}

/** relation: a Basic Memory relation or wiki link. note: a memory written into a grouped note. tag: shares a tag. session: came from a session. */
export type MemoryGraphEdgeKind = 'relation' | 'note' | 'tag' | 'session';

export interface MemoryGraphEdge {
  from: string;
  to: string;
  kind: MemoryGraphEdgeKind;
  /** The relation type in words ("relates to", "mentions"), or what the link is ("in note", "tagged", "from session"). */
  label: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  /** none: no Basic Memory connection. offline: it did not answer, so only Conclave's memory is drawn. */
  basicMemory: { state: 'ok' | 'offline' | 'none'; name?: string; error?: string };
  /** Nodes before the cap. */
  total: number;
  /** The cap that applied. */
  limit: number;
}
