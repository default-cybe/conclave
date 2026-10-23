/**
 * Shapes for sharing a session: the sanitized export and the signed bundle
 * one Conclave hands to another (session/share.ts builds both).
 */
import type { ChatSettings, ContentBlock, MessageKind, ModeConfig, Role, SessionKind, SessionMode, StopReason } from '../types';

/** What each sanitizer rule took out or replaced, for a preview before sharing. */
export interface RedactReport {
  /** System reminder blocks and spans (hook context, recalled memories, subagent notes). */
  reminders: number;
  /** Ids of recalled memories dropped from message meta. */
  recalled: number;
  /** Thinking blocks left out. */
  thinking: number;
  /** Reasoning signatures removed from thinking and tool calls. */
  signatures: number;
  /** Encrypted reasoning blocks left out. */
  redactedThinking: number;
  /** Values that looked like a secret. */
  secrets: number;
  /** Absolute paths made relative to the session folder or to ~. */
  paths: number;
  privateIps: number;
  emails: number;
  /** Names of the hub's devices. */
  hostnames: number;
  /** Tool results replaced with a placeholder or cut to a summary. */
  toolOutputs: number;
  /** Images and documents replaced with a placeholder. */
  attachments: number;
}

/** Options for the sanitized export and the bundle. Unset: thinking off, tool output and attachments on, code off. */
export interface ShareOptions {
  thinking?: boolean;
  toolOutput?: boolean;
  attachments?: boolean;
  /** Bundle only: edit diffs in tool results and the project identity. */
  code?: boolean;
}

/** full: tool results as they are (sanitized); summary: the first lines of each; none: a placeholder. */
export type ToolOutputMode = 'full' | 'summary' | 'none';

/** A rule whose finds the sender sees one by one and may keep anyway. */
export type RedactionRule = 'secret' | 'path' | 'privateIp' | 'email' | 'hostname';

/**
 * One value a text rule found, for the review before sending. The same rule
 * and value always get the same id, which a keep list names.
 */
export interface RedactionItem {
  id: string;
  rule: RedactionRule;
  /** The text found. The owner's own data, shown on request; it leaves only when kept. */
  original: string;
  /** What takes its place. */
  replacement: string;
  /** Times found. */
  count: number;
  /** The first messages it is in (ids on this hub). */
  messageIds: string[];
  /** The owner chose to keep it. */
  kept: boolean;
}

export interface BundleIncludes {
  thinking: boolean;
  toolOutput: boolean;
  attachments: boolean;
  code: boolean;
  /** Tool results were cut to their first lines. */
  toolSummaries?: boolean;
}

/** A share's code. Never untracked files or credential files (session/share-code.ts). */
export interface BundleCode {
  /** diff: the session's changes as a patch; git-bundle: the session branch's commits. */
  kind: 'diff' | 'git-bundle';
  /** diff: the patch with relative paths, credential files taken out and the text rules applied. */
  diff?: string;
  /** git-bundle: the bundle file, base64. */
  data?: string;
  /** git-bundle: the branch it holds. */
  branch?: string;
  /** git-bundle: the commit its range starts after; the receiver needs it to apply. */
  base?: string;
  /** Paths it changes, relative to the repository. */
  files: string[];
  /** Files left out, and why. */
  excluded: Array<{ path: string; reason: string }>;
}

/** What a bundle sent to a friend says about the share it belongs to. */
export interface BundleShareInfo {
  /** The share's id on the sending hub (a ULID). */
  id: string;
  revision: number;
  title: string;
  note?: string;
  /** The last message the share includes (an id on the sending hub), when it stops early. */
  upTo?: string;
}

/** One message as shared: no usage, no cost, no meta but the original id. */
export interface BundleMessage {
  role: Role;
  kind: MessageKind;
  content: ContentBlock[];
  model?: string;
  author?: string;
  group?: string;
  createdAt: number;
  stopReason?: StopReason;
  meta: { external: { id: string } };
}

/** One session as shared. Never its folder, device, project, permissions, routine, task, cost or meta. */
export interface BundleSession {
  /** The session's id on the hub that made the bundle. */
  id: string;
  /** Set on a subagent: the id of the session in this bundle that started it. */
  parentId?: string;
  title: string;
  kind: SessionKind;
  mode: SessionMode;
  modeConfig?: ModeConfig;
  chat?: ChatSettings;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** What it ran on, as a hint: the other hub may not have the agent or the model. */
  hints: { agent: string; model: string };
  messages: BundleMessage[];
}

/** The project a bundle's code comes from, without local paths. */
export interface BundleProject {
  name: string;
  /** Root commit hashes. */
  gitRoots: string[];
  /** host/owner/repo. */
  remotes: string[];
  shallow: boolean;
  marker?: string;
  head?: string;
}

/**
 * A signed bundle: the root session and its subagents. The signature is
 * Ed25519 over "conclave-bundle-v1\n" and the canonical JSON of the bundle
 * without its signature (session/share.ts canonicalJson).
 */
export interface ConclaveBundle {
  format: 'conclave-bundle';
  version: 1;
  createdAt: number;
  from: { publicKey: string; fingerprint: string; name?: string };
  includes: BundleIncludes;
  report: RedactReport;
  sessions: BundleSession[];
  /** Set when includes.code: the root session's project. */
  project?: BundleProject;
  /** Set on a bundle sent to a friend. */
  share?: BundleShareInfo;
  /** Set on a bundle sent to a friend with code. */
  code?: BundleCode;
  /** base64url. */
  signature: string;
}
