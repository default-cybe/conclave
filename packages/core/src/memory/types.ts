import type { MemoryEntry, MemoryHit, MemoryKind, MemoryScope, Message } from '../types';

export interface MemorySearchOptions {
  scope?: MemoryScope;
  scopeKey?: string;
  kinds?: MemoryKind[];
  limit?: number;
  /** Also search the external memory server (Basic Memory, etc.). Default true. */
  external?: boolean;
}

export interface MemoryInput {
  content: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  scopeKey?: string;
  tags?: string[];
  sourceSessionId?: string;
  importance?: number;
}

/** What extract() did beyond the memories it returns, for a caller that reports it (the daily digest). */
export interface ExtractReport {
  /** Facts not saved because the owner's own notes already state them. */
  inNotes: number;
}

/**
 * Memory layers:
 * 1. profile: small, always in the system prompt.
 * 2. facts/procedures: retrieved per turn (FTS5 BM25, plus embeddings when configured).
 * 3. episodes: summaries of past sessions, retrieved the same way.
 * 4. external: an MCP or HTTP memory server (Basic Memory) searched and written alongside.
 */
export interface MemoryService {
  search(query: string, opts?: MemorySearchOptions): Promise<MemoryHit[]>;
  save(input: MemoryInput): Promise<MemoryEntry>;
  update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'tags' | 'kind' | 'importance' | 'scope' | 'scopeKey'>>): Promise<MemoryEntry | undefined>;
  remove(id: string): Promise<boolean>;
  get(id: string): MemoryEntry | undefined;
  list(opts?: { scope?: MemoryScope; scopeKey?: string; kind?: MemoryKind; limit?: number; offset?: number }): MemoryEntry[];
  /** Profile entries for the system prompt (global + project + agent). */
  profile(opts: { project?: string | string[]; agent?: string }): MemoryEntry[];
  /** Relevant memories for a user turn, formatted for injection. */
  recall(query: string, opts: { project?: string | string[]; agent?: string; limit?: number }): Promise<MemoryHit[]>;
  /** Extract durable memories from a finished session (uses the small model). Facts the owner's own notes already state are left out and counted in report. */
  extract(sessionId: string, messages: Message[], opts: { project?: string; agent?: string; report?: ExtractReport }): Promise<MemoryEntry[]>;
  /** Write an episode summary for a session. */
  summarizeEpisode(sessionId: string, messages: Message[], opts: { project?: string; agent?: string }): Promise<MemoryEntry | undefined>;
  stats(): { total: number; byKind: Record<string, number> };
}
