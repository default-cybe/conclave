import type { MachineInfo } from '../types';

/**
 * A Machine is where tools touch the world: files, shells, processes.
 *
 * The agent loop always runs on the hub. Tools never call node:fs or
 * child_process directly; they go through ctx.machine. The hub's own disk is
 * LocalMachine ("local"). A paired PC or Mac is a RemoteMachine that forwards
 * the same calls over the daemon WebSocket. That is how one brain gets many
 * hands: pick a device per session and every tool runs there.
 */
export interface Machine {
  readonly id: string;
  readonly name: string;
  info(): Promise<MachineInfo>;

  stat(path: string): Promise<FileStat | null>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /** Creates parent directories. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;

  /** Glob relative to cwd. Respects .gitignore when possible. Returns absolute paths sorted by mtime desc. */
  glob(pattern: string, opts: GlobOptions): Promise<string[]>;
  grep(opts: GrepOptions): Promise<GrepResult>;

  /** Run a shell command to completion. */
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
  /** Start a long-lived process (ACP agents, background shells, dev servers). */
  spawn(command: string, args: string[], opts: SpawnOptions): MachineProcess;

  /** Resolve "~" and relative paths against cwd. */
  resolve(path: string, cwd: string): string;

  /**
   * Syncthing folders on this machine (id, label, path, paused), read from its
   * config.xml (machine/syncthing.ts). Missing on daemons older than protocol 2.
   */
  syncthingFolders?(): Promise<import('./syncthing').SyncthingFolder[]>;
  /** One folder's sync state from the machine's own Syncthing. The API key stays on the machine. */
  syncthingStatus?(folderId: string): Promise<import('./syncthing').SyncthingStatus>;

  // ----- chat import (import/wire.ts). Missing on daemons older than protocol 2: the hub reads files itself then -----
  /** Up to `length` bytes of a file from `offset`. */
  readRange?(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Scan this machine for past sessions; files in `known` with the same size and mtime are not read. */
  importScan?(params: import('../import/types').ImportScanParams): Promise<import('../import/types').ImportScanWire>;
  /** Read and convert one past session on this machine. */
  importRead?(params: import('../import/types').ImportReadParams): Promise<import('../importers/types').ConvertedSession>;
  /** Append Conclave's rows to a Claude Code chat on this machine, unless Claude Code has it open (protocol 5). */
  importAppend?(params: import('../import/types').ImportAppendParams): Promise<import('../import/types').ImportAppendResult>;

  /** A paired daemon's recent log (protocol 3), for the hub's logs export. The hub's own machine has none: its lines are in the files. */
  logTail?(lines?: number): Promise<import('../client/logs').DaemonLogTail>;

  /** A paired daemon replaces its own binary with the hub's version and restarts (protocol 4, docs/DESIGN.md, Updates). */
  selfUpdate?(params: import('./protocol').RpcParams['selfUpdate']): Promise<import('./protocol').SelfUpdateResult>;
}

export interface FileStat {
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

export interface GlobOptions {
  cwd: string;
  limit?: number;
  /** Include files ignored by .gitignore. */
  includeIgnored?: boolean;
  /** Include dotfiles. */
  dot?: boolean;
}

export interface GrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  type?: string;
  caseInsensitive?: boolean;
  multiline?: boolean;
  /** content: matching lines. files: paths only. count: per-file counts. */
  outputMode: 'content' | 'files' | 'count';
  before?: number;
  after?: number;
  lineNumbers?: boolean;
  limit?: number;
  offset?: number;
}

export interface GrepResult {
  output: string;
  /** Number of output lines or files before limit/offset. */
  total: number;
  truncated: boolean;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  /** Streaming output for live tool progress. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Max bytes kept per stream. Older output is dropped from the middle. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
}

export interface MachineProcess {
  readonly pid?: number;
  /** Raw stdout bytes. */
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  write(data: string | Uint8Array): void;
  closeStdin(): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): void;
  readonly exited: Promise<number | null>;
}
