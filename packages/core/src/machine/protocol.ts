/**
 * Device protocol: JSON messages over one WebSocket per daemon.
 *
 * The hub sends RPC requests that mirror the Machine interface. The daemon
 * answers each one with a result or an error. Long running work streams:
 * exec output (when the hub asked for it) and spawned processes, whose
 * stdout/stderr/exit arrive as proc.* events.
 *
 * "pid" in proc.* messages is a handle chosen by the hub when it sends the
 * spawn request, not the OS pid. That lets the hub return a MachineProcess
 * synchronously and lets output arrive before the spawn result.
 */
import type { MachineInfo } from '../types';
import type { DirEntry, ExecResult, FileStat, GlobOptions, GrepOptions, GrepResult, SpawnOptions } from './types';
import type { SyncthingFolder, SyncthingStatus } from './syncthing';
import type { ImportAppendParams, ImportAppendResult, ImportReadParams, ImportScanParams, ImportScanWire } from '../import/types';
import type { ConvertedSession } from '../importers/types';
import type { DaemonLogTail } from '../client/logs';
import type { UpdateManifest } from '../update/manifest';

/**
 * Version 2 adds the RPCs readRange, importScan, importRead, syncthingFolders
 * and syncthingStatus. Version 3 adds logTail (the daemon's recent log, for
 * the hub's logs export). Version 4 adds selfUpdate (the daemon replaces its
 * own binary with the hub's version and restarts). Version 5 adds importAppend
 * (Conclave's turns written back into a Claude Code chat, import/writeback.ts).
 * The hub accepts any version from
 * MIN_PROTOCOL_VERSION to PROTOCOL_VERSION and calls the newer RPCs only on
 * daemons that speak them.
 */
export const PROTOCOL_VERSION = 5;
export const MIN_PROTOCOL_VERSION = 1;

/** First version with each RPC added after version 1. */
export const RPC_SINCE: Partial<Record<RpcMethod, number>> = { syncthingFolders: 2, syncthingStatus: 2, readRange: 2, importScan: 2, importRead: 2, logTail: 3, selfUpdate: 4, importAppend: 5 };

/** Both sides ping every HEARTBEAT_MS. A peer silent for HEARTBEAT_MS * 3 is treated as gone. */
export const HEARTBEAT_MS = 20_000;

/**
 * Most raw file bytes one reply may carry. Base64 makes it 4/3 bigger, and the
 * hub closes a daemon socket on a message over 64 MB (server/src/app.ts
 * maxPayloadLength), so larger reads go in pieces.
 */
export const MAX_READ_BYTES = 32 * 1024 * 1024;

/** Default timeout for RPCs other than exec with its own timeout. */
export const RPC_TIMEOUT_MS = 60_000;

/** exec options that survive JSON (no signal, no callback). */
export interface WireExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  maxOutputBytes?: number;
  /** Send exec.output events while the command runs. */
  stream?: boolean;
}

export interface RpcParams {
  info: Record<string, never>;
  stat: { path: string };
  readFile: { path: string };
  readText: { path: string };
  /** Exactly one of text or base64. */
  writeFile: { path: string; text?: string; base64?: string };
  readdir: { path: string };
  mkdir: { path: string };
  remove: { path: string; recursive?: boolean };
  rename: { from: string; to: string };
  glob: { pattern: string; opts: GlobOptions };
  grep: { opts: GrepOptions };
  exec: { command: string; opts: WireExecOptions };
  /** handle is the hub-chosen process id used by proc.* messages. */
  spawn: { handle: number; command: string; args: string[]; opts: SpawnOptions };
  resolve: { path: string; cwd: string };
  // ----- version 2: folders across devices (machine/syncthing.ts) -----
  syncthingFolders: Record<string, never>;
  syncthingStatus: { folderId: string };
  // ----- version 2: chat import (import/wire.ts). The device reads its own transcripts and sends compact rows -----
  readRange: { path: string; offset: number; length: number };
  importScan: ImportScanParams;
  importRead: ImportReadParams;
  // ----- version 3: the daemon's recent log for the hub's logs export (logs/ring.ts) -----
  logTail: { lines?: number };
  // ----- version 4: the daemon updates itself (docs/DESIGN.md, Updates) -----
  /** The hub's version and that release's manifest; the daemon picks its own file from it and checks its signature. */
  selfUpdate: { version: string; manifest: UpdateManifest };
  // ----- version 5: Conclave's turns appended to a Claude Code chat, checked on the device that holds it -----
  importAppend: ImportAppendParams;
}

export interface RpcResults {
  info: MachineInfo;
  stat: FileStat | null;
  /** base64 */
  readFile: string;
  readText: string;
  writeFile: null;
  readdir: DirEntry[];
  mkdir: null;
  remove: null;
  rename: null;
  glob: string[];
  grep: GrepResult;
  exec: ExecResult;
  /** OS pid when known. */
  spawn: { pid?: number };
  resolve: string;
  /** Folder id, label, path and paused only. Never the API key. */
  syncthingFolders: SyncthingFolder[];
  syncthingStatus: SyncthingStatus;
  /** base64 of the bytes read (fewer than asked at the end of the file). */
  readRange: string;
  importScan: ImportScanWire;
  importRead: ConvertedSession;
  /** Its own lines since it started and the end of its log file, secrets filtered on the device. */
  logTail: DaemonLogTail;
  /** The new binary is in place and checked; the daemon restarts right after this answer. */
  selfUpdate: SelfUpdateResult;
  importAppend: ImportAppendResult;
}

export interface SelfUpdateResult {
  from: string;
  to: string;
  /** The daemon exits now and its service starts the new binary. */
  restarting: boolean;
}

export type RpcMethod = keyof RpcParams;

export const RPC_METHODS: RpcMethod[] = [
  'info',
  'stat',
  'readFile',
  'readText',
  'writeFile',
  'readdir',
  'mkdir',
  'remove',
  'rename',
  'glob',
  'grep',
  'exec',
  'spawn',
  'resolve',
  'syncthingFolders',
  'syncthingStatus',
  'readRange',
  'importScan',
  'importRead',
  'logTail',
  'selfUpdate',
  'importAppend',
];

export interface WireError {
  message: string;
  /** Node style error code (ENOENT, EACCES...) so tools can branch on it. */
  code?: string;
}

export type RpcRequest = { [M in RpcMethod]: { type: 'rpc'; id: number; method: M; params: RpcParams[M] } }[RpcMethod];

export type RpcResponse = { type: 'result'; id: number; result: unknown } | { type: 'result'; id: number; error: WireError };

/** Hub to daemon. */
export type HubMessage =
  | RpcRequest
  | { type: 'welcome'; version: number; hubVersion?: string; deviceId: string; name: string }
  | { type: 'error'; message: string }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number }
  | { type: 'exec.abort'; id: number }
  /**
   * Every address that reaches the hub, best first. Sent after welcome and
   * whenever it changes (a quick tunnel gets a new address before the old one
   * stops). The daemon saves them, moves to urls[0] and tries the others when
   * the one it uses stops answering. Older daemons ignore it.
   */
  | { type: 'addresses'; urls: string[] }
  /** data is base64. end closes stdin (data may be omitted then). */
  | { type: 'proc.stdin'; pid: number; data?: string; end?: boolean }
  | { type: 'proc.kill'; pid: number; signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' };

/** Daemon to hub. */
export type DaemonMessage =
  | { type: 'hello'; version: number; deviceId: string; name?: string; info: MachineInfo }
  | RpcResponse
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number }
  /** Live exec output for an exec RPC sent with stream: true. Plain text. */
  | { type: 'exec.output'; id: number; stream: 'stdout' | 'stderr'; data: string }
  /** data is base64. */
  | { type: 'proc.stdout'; pid: number; data: string }
  | { type: 'proc.stderr'; pid: number; data: string }
  | { type: 'proc.exit'; pid: number; code: number | null };

export function encodeBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

export function decodeBase64(data: string): Uint8Array {
  const buf = Buffer.from(data, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function toWireError(err: unknown): WireError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { message: err.message, code: typeof code === 'string' ? code : undefined };
  }
  return { message: String(err) };
}

/** Rebuild an Error with the same message and code on the receiving side. */
export function fromWireError(e: WireError): Error {
  const err = new Error(e.message) as Error & { code?: string };
  if (e.code) err.code = e.code;
  return err;
}

/** Parse a WebSocket frame into a message object. Returns undefined for junk. */
export function parseFrame(data: unknown): Record<string, unknown> | undefined {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as Uint8Array);
  else return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && typeof v.type === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** http(s)://host[/prefix] -> ws(s)://host[/prefix]/api/daemon */
export function daemonUrl(hubUrl: string): string {
  const base = hubUrl.replace(/\/+$/, '').replace(/^http/i, 'ws');
  return base.endsWith('/api/daemon') ? base : `${base}/api/daemon`;
}
