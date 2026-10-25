/**
 * Shapes every session reader returns, so the import service treats Claude
 * Code, Codex, Gemini CLI and uploaded exports the same way.
 */
import type { Message } from '../types';
import type { ImportSessionKind, ImportSource } from '../client/import';

export type ImportedMessage = Omit<Message, 'id' | 'sessionId' | 'seq'>;

/**
 * Who wrote an imported user message. Only "human" counts as the owner's
 * words; the rest are notices a harness put in the user role.
 */
export type MessageOrigin = 'human' | 'task' | 'peer' | 'sdk' | 'system';

export interface ConvertedSession {
  source: ImportSource;
  /** The tool's own session id. */
  nativeId?: string;
  /**
   * The native id goes in the fingerprint. Claude Code ids can repeat across
   * project folders, so its fingerprint keeps the first message ids too; false
   * for a subagent transcript, which carries its parent's id.
   */
  nativeIdUnique: boolean;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  repo?: string;
  /** Last model, "provider/model". */
  model?: string;
  kind: ImportSessionKind;
  /** Native id of the parent session, for subagent and internal threads. */
  parentNativeId?: string;
  /** Claude Code entrypoint (cli, sdk-ts...) or Codex source (cli, exec, mcp...). */
  entrypoint?: string;
  messages: ImportedMessage[];
  /** Line and content types the reader did not know, counted. */
  unknown: Record<string, number>;
  /** False for the tool's own memory and review threads: never learned from. */
  learnable: boolean;
}

/** Counts the import UI and the skip rules need, from converted messages. */
export interface SessionStats {
  messages: number;
  humanPrompts: number;
  humanChars: number;
  createdAt: number;
  updatedAt: number;
  /** External ids of the first 3 messages, for the fingerprint. */
  firstIds: string[];
}

export function externalId(m: Pick<ImportedMessage, 'meta'>): string | undefined {
  const ext = m.meta?.external as { id?: unknown } | undefined;
  return ext && typeof ext.id === 'string' && ext.id ? ext.id : undefined;
}

export function originOf(m: Pick<ImportedMessage, 'meta' | 'role' | 'kind'>): MessageOrigin | undefined {
  if (m.role !== 'user') return undefined;
  const o = m.meta?.origin;
  return o === 'human' || o === 'task' || o === 'peer' || o === 'sdk' || o === 'system' ? o : m.kind === 'normal' ? 'human' : 'system';
}

/** Text the owner typed in a message, or '' for anything else. */
export function humanText(m: ImportedMessage): string {
  if (m.role !== 'user' || m.kind !== 'normal' || originOf(m) !== 'human') return '';
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')
    .trim();
}

export function sessionStats(messages: ImportedMessage[]): SessionStats {
  let humanPrompts = 0;
  let humanChars = 0;
  let createdAt = Infinity;
  let updatedAt = 0;
  const firstIds: string[] = [];
  for (const m of messages) {
    const t = humanText(m);
    if (t) {
      humanPrompts++;
      humanChars += t.length;
    }
    if (m.createdAt < createdAt) createdAt = m.createdAt;
    if (m.createdAt > updatedAt) updatedAt = m.createdAt;
    const id = externalId(m);
    if (id && firstIds.length < 3) firstIds.push(id);
  }
  return { messages: messages.length, humanPrompts, humanChars, createdAt: Number.isFinite(createdAt) ? createdAt : 0, updatedAt, firstIds };
}

export function bump(counts: Record<string, number>, key: string, n = 1): void {
  counts[key] = (counts[key] ?? 0) + n;
}
