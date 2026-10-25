/**
 * Types of the device side of chat import (protocol v2), with no runtime
 * code, so machine/types.ts and the wire protocol can name them without
 * pulling the readers into every program that imports the client.
 */
import type { ImportSessionKind, ImportSource } from '../client/import';

export interface FoundSession {
  source: ImportSource;
  path: string;
  size: number;
  mtime: number;
  /** Claude Code subagent transcripts: the parent session id. Gemini: the project dir. */
  parent?: string;
  project?: string;
  archived?: boolean;
}

/** What the scan keeps per file. Everything the list, the skip rules and the estimate need, nothing more. */
export interface RowInfo {
  id: string;
  title: string;
  cwd?: string;
  gitBranch?: string;
  repo?: string;
  model?: string;
  kind: ImportSessionKind;
  parentId?: string;
  entrypoint?: string;
  messages: number;
  humanPrompts: number;
  humanChars: number;
  createdAt: number;
  updatedAt: number;
  fingerprint: string;
  estTokens: number;
  learnable: boolean;
  archived?: boolean;
  unknown?: Record<string, number>;
}

export interface ScanResult {
  /** Rows for files that are new or changed since `known`. */
  rows: Array<{ found: FoundSession; info?: RowInfo; error?: string }>;
  /** Every session file present now, so the caller can drop rows for deleted files. */
  present: FoundSession[];
  failed: Array<{ source: ImportSource; error: string }>;
}

export interface ImportScanParams {
  sources?: ImportSource[];
  /** [path, size, mtime] of files the hub already has rows for. Those are not read again. */
  known?: Array<[string, number, number]>;
  concurrency?: number;
}

export type ImportScanWire = ScanResult;

/** importAppend (protocol 5): rows Conclave wrote for a Claude Code chat, appended on the device that holds the file (import/writeback.ts). */
export interface ImportAppendParams {
  /** A Claude Code session file, <sessionId>.jsonl. */
  path: string;
  sessionId: string;
  /** The chat's folder: a Claude Code process running there counts as having the chat open. */
  cwd?: string;
  /** Whole JSONL lines, the last one ending in a newline. */
  text: string;
  /** The file as the hub read it: its size and the sha256 of its last 4096 bytes. Anything else refuses. */
  expect: { size: number; tail: string };
}

/** busy: a Claude Code process has the chat open. changed: the file is not the one the hub read. partialTail: its last line is cut. */
export type ImportAppendResult = { ok: true; size: number; mtime: number } | { ok: false; reason: 'busy' | 'changed' | 'partialTail'; detail?: string };

export interface ImportReadParams {
  source: ImportSource;
  path: string;
  /** Claude Code subagent transcripts: the parent session id. */
  parent?: string;
  /** Tool results longer than this are cut on the device (the file stays there). Default 50k characters. */
  maxToolChars?: number;
}
