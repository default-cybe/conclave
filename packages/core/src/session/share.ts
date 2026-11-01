/**
 * Sharing a session (DESIGN.md, Export and sharing).
 *
 * redactMessages walks every block of a transcript and takes out what must
 * not leave the hub: system reminders (hook context, recalled memories,
 * subagent notes), recalled memory ids, reasoning signatures and encrypted
 * reasoning, thinking unless asked for, secrets, absolute paths, private
 * addresses, emails and the names of the owner's devices. Image and document
 * data, signatures and ids are never run through the text rules: the hex and
 * high-entropy rules would mangle base64 and digests. The report counts what
 * each rule took out, so a client can show a preview before sharing.
 *
 * exportSession is GET /api/sessions/:id/export: sanitized by default, the
 * raw rows only for an owner backup. buildBundle is GET
 * /api/sessions/:id/bundle: the session and its subagents, signed with the
 * hub key so another Conclave can check where it came from (verifyBundle).
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { homedir } from 'node:os';
import type { ContentBlock, Device, DocumentBlock, ImageBlock, Message, Session, ToolResultBlock } from '../types';
import type {
  BundleCode,
  BundleIncludes,
  BundleMessage,
  BundleProject,
  BundleSession,
  BundleShareInfo,
  ConclaveBundle,
  RedactionItem,
  RedactionRule,
  RedactReport,
  ShareOptions,
  ToolOutputMode,
} from '../client/share';
import type { Repos } from '../storage/repos';
import { json } from '../storage/db';
import { redactSecretsWith } from '../memory/secrets';
import { EngineError } from '../engine/errors';
import { isReminder, renderTranscript } from './transcript';

/** What a bundle signature covers: this, then the canonical JSON of the bundle without its signature. */
export const BUNDLE_PREFIX = 'conclave-bundle-v1\n';

export interface RedactOptions {
  /** The session's folder: absolute paths inside it become relative. */
  cwd?: string;
  /** The device's home folder: becomes ~. */
  home?: string;
  /** Keep thinking text (without signatures). Default false. */
  includeThinking?: boolean;
  /** Keep tool results. False replaces each with a short placeholder. Default true. */
  includeToolOutput?: boolean;
  /** Overrides includeToolOutput: full, summary (the first lines of each result) or none. */
  toolOutput?: ToolOutputMode;
  /** Keep images and documents. False replaces each with a short placeholder. Default true. */
  includeAttachments?: boolean;
  /** Keep edit diffs (tool_result meta.diff). Default true. */
  includeDiffs?: boolean;
  /** Device names and hostnames of the hub's devices: each becomes [host]. */
  hostnames?: string[];
  /** secrets: only the secret rule runs over text (a received bundle, sanitized again). Default all. */
  textRules?: 'all' | 'secrets';
  /** Records each value the text rules find, and the ones the owner keeps anyway. */
  log?: RedactionLog;
}

/**
 * The values the text rules found, across every session of a bundle, for
 * the review before sending. A value whose id is in `keep` stays as it is
 * and is not counted in the report.
 */
export class RedactionLog {
  readonly items = new Map<string, RedactionItem>();
  readonly keep: Set<string>;

  constructor(keep: Iterable<string> = []) {
    this.keep = new Set(keep);
  }

  static id(rule: RedactionRule, value: string): string {
    return createHash('sha256').update(`${rule}\n${value}`).digest('hex').slice(0, 12);
  }

  /** Note a find. Returns true when the owner keeps it. */
  hit(rule: RedactionRule, value: string, replacement: string, messageId: string | undefined): boolean {
    const id = RedactionLog.id(rule, value);
    const kept = this.keep.has(id);
    let item = this.items.get(id);
    if (!item) {
      item = { id, rule, original: value, replacement, count: 0, messageIds: [], kept };
      this.items.set(id, item);
    }
    item.count++;
    if (messageId && item.messageIds.length < 5 && !item.messageIds.includes(messageId)) item.messageIds.push(messageId);
    return kept;
  }

  list(): RedactionItem[] {
    const order: RedactionRule[] = ['secret', 'email', 'privateIp', 'hostname', 'path'];
    return [...this.items.values()].sort((a, b) => order.indexOf(a.rule) - order.indexOf(b.rule) || b.count - a.count || a.original.localeCompare(b.original));
  }
}

export function emptyReport(): RedactReport {
  return { reminders: 0, recalled: 0, thinking: 0, signatures: 0, redactedThinking: 0, secrets: 0, paths: 0, privateIps: 0, emails: 0, hostnames: 0, toolOutputs: 0, attachments: 0 };
}

export function addReport(into: RedactReport, from: RedactReport): RedactReport {
  for (const k of Object.keys(into) as Array<keyof RedactReport>) into[k] += from[k];
  return into;
}

// ---------------------------------------------------------------------------
// text rules
// ---------------------------------------------------------------------------

/** A reminder inside a text block, or one that never closes. */
const REMINDER_SPAN = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)[ \t]*\n?/g;

/** 10/8, 172.16/12, 192.168/16, and 100.64/10 (carrier NAT, Tailscale). */
const PRIVATE_IP = /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?!\.?\d)/g;

const EMAIL = /\b([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** /home/<user>, /Users/<user>, C:\Users\<user> (either slash, escaped backslashes too). */
const USER_HOME = /(?<![\w.~-])(?:\/home|\/Users|[A-Za-z]:(?:\\{1,2}|\/)Users)(?:\\{1,2}|\/)(?!(?:Shared|Public|Default|All Users)(?![\w-]))[^\\/\s"'`<>|:*?;,()[\]{}]+/gi;

/** Device names too common to replace as words. */
const COMMON_NAMES = new Set(['local', 'localhost', 'hub', 'host', 'server', 'desktop', 'laptop', 'phone', 'computer', 'machine', 'home', 'mac', 'linux', 'windows', 'ubuntu', 'debian', 'arch', 'fedora', 'root', 'admin', 'user', 'test', 'default', 'main', 'work', 'unknown']);

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A folder as a pattern: either slash, escaped backslashes, any case for a
 * Windows path. Then either a separator before more of a path (captured), or
 * the end of the path. "/" and one-level folders other than /root match too
 * much and are left out.
 */
function folderRe(dir: string | undefined): RegExp | undefined {
  if (!dir) return undefined;
  const trimmed = dir.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]+/);
  const depth = parts.filter(Boolean).length;
  if (depth < 2 && trimmed !== '/root') return undefined;
  const body = parts.map(escRe).join('[\\\\/]{1,2}');
  const windows = /^[A-Za-z]:/.test(trimmed);
  return new RegExp(`(?<![\\w.~-])${body}(?:([\\\\/]{1,2})(?=[\\w.~@%+-])|(?![\\w-]|\\.\\w))`, windows ? 'gi' : 'g');
}

function hostRe(names: string[] | undefined): RegExp | undefined {
  const list = [...new Set((names ?? []).map((n) => n.trim()).filter((n) => n.length >= 3 && !COMMON_NAMES.has(n.toLowerCase())))];
  if (!list.length) return undefined;
  list.sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\w.-])(?:${list.map(escRe).join('|')})(?![\\w-])`, 'gi');
}

const REPORT_KEY: Record<RedactionRule, keyof RedactReport> = { secret: 'secrets', path: 'paths', privateIp: 'privateIps', email: 'emails', hostname: 'hostnames' };

/** The text rules for one session, counting into a report. */
export class Redactor {
  readonly report = emptyReport();
  /** The message being redacted, for the log. */
  at?: string;
  private readonly cwdRe?: RegExp;
  private readonly homeRe?: RegExp;
  private readonly hostRe?: RegExp;

  constructor(readonly opts: RedactOptions = {}) {
    // a session in the home folder reads better with ~ than with relative paths
    const sameAsHome = !!opts.cwd && !!opts.home && opts.cwd.replace(/[\\/]+$/, '') === opts.home.replace(/[\\/]+$/, '');
    this.cwdRe = sameAsHome ? undefined : folderRe(opts.cwd);
    this.homeRe = folderRe(opts.home);
    this.hostRe = hostRe(opts.hostnames);
  }

  /**
   * One find: the replacement, or the match itself when the owner keeps it.
   * `value` names the find in the log (a folder without its last separator).
   */
  private hit(rule: RedactionRule, match: string, replacement: string, value = match): string {
    if (this.opts.log?.hit(rule, value, replacement, this.at)) return match;
    this.report[REPORT_KEY[rule]]++;
    return replacement;
  }

  /** Absolute paths: relative to the session folder, the home folder and any user's home as ~. */
  paths(text: string): string {
    let out = text;
    const folder = (m: string) => m.replace(/[\\/]+$/, '');
    if (this.cwdRe) out = out.replace(this.cwdRe, (m, sep?: string) => this.hit('path', m, sep ? '' : '.', folder(m)));
    if (this.homeRe) out = out.replace(this.homeRe, (m, sep?: string) => this.hit('path', m, sep ? `~${sep}` : '~', folder(m)));
    out = out.replace(USER_HOME, (m) => this.hit('path', m, '~'));
    return out;
  }

  /** Every text rule: secrets, paths, private addresses, emails, device names. */
  text(text: string): string {
    if (!text) return text;
    let out = redactSecretsWith(text, (m) => this.hit('secret', m, '[redacted]'));
    if (this.opts.textRules === 'secrets') return out;
    out = this.paths(out);
    out = out.replace(PRIVATE_IP, (m) => this.hit('privateIp', m, '[private ip]'));
    out = out.replace(EMAIL, (m, local: string) => {
      // git@github.com:owner/repo is a remote, not a person
      if (local.toLowerCase() === 'git') return m;
      return this.hit('email', m, '[email]');
    });
    if (this.hostRe) out = out.replace(this.hostRe, (m) => this.hit('hostname', m, '[host]'));
    return out;
  }

  /** Text a person or a tool wrote: reminder spans out first, then every rule. */
  prose(text: string): string {
    const stripped = text.replace(REMINDER_SPAN, () => {
      this.report.reminders++;
      return '';
    });
    return this.text(stripped);
  }

  /** Every string inside a value (tool input, mode settings); keys stay. */
  deep<T>(v: T): T {
    if (typeof v === 'string') return this.text(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.deep(x)) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x)])) as T;
    return v;
  }
}

// ---------------------------------------------------------------------------
// blocks and messages
// ---------------------------------------------------------------------------

/** tool_result meta a shared copy keeps. The rest (output ids, the shell's folder, read marks, hook data) stays home. */
const RESULT_META = ['path', 'diff', 'exitCode', 'truncated', 'durationMs', 'sessionId', 'agent', 'background', 'structured'];
/** Message meta a shared copy keeps: what the transcript renderer needs to read it. */
const MESSAGE_META = ['auto', 'resume', 'level', 'coversThroughSeq'];

function attachment(b: ImageBlock | DocumentBlock, red: Redactor): ContentBlock {
  if (red.opts.includeAttachments === false) {
    red.report.attachments++;
    return { type: 'text', text: b.type === 'image' ? '[image left out]' : '[document left out]' };
  }
  // the data stays byte for byte; a file URL or a title can name a path
  const url = b.url && !b.url.startsWith('data:') ? red.paths(b.url) : b.url;
  if (b.type === 'document') return { ...b, ...(url !== undefined ? { url } : {}), ...(b.title ? { title: red.text(b.title) } : {}) };
  return { ...b, ...(url !== undefined ? { url } : {}) };
}

function toolResult(b: ToolResultBlock, red: Redactor): ToolResultBlock {
  const meta: Record<string, unknown> = {};
  for (const k of RESULT_META) {
    const v = b.meta?.[k];
    if (v === undefined) continue;
    if (k === 'diff') {
      if (red.opts.includeDiffs !== false && typeof v === 'string') meta.diff = red.text(v);
      continue;
    }
    meta[k] = k === 'path' && typeof v === 'string' ? red.text(v) : v;
  }
  let content: ToolResultBlock['content'];
  const mode = red.opts.toolOutput ?? (red.opts.includeToolOutput === false ? 'none' : 'full');
  if (mode === 'none') {
    red.report.toolOutputs++;
    content = '[tool output left out]';
  } else if (mode === 'summary') {
    const text = typeof b.content === 'string' ? b.content : b.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    content = summarize(red.prose(text));
    if (content !== text) red.report.toolOutputs++;
  } else if (typeof b.content === 'string') content = red.prose(b.content);
  else content = b.content.map((c) => (c.type === 'text' ? { type: 'text' as const, text: red.prose(c.text) } : (attachment(c, red) as ImageBlock | DocumentBlock)));
  return { type: 'tool_result', toolUseId: b.toolUseId, content, ...(b.isError ? { isError: true } : {}), ...(Object.keys(meta).length ? { meta } : {}) };
}

/** A tool result cut to its first lines: at most 3 lines and 300 characters, and how much was left out. */
export function summarize(text: string): string {
  const lines = text.split('\n');
  let head = lines.slice(0, 3).join('\n');
  if (head.length > 300) head = `${head.slice(0, 300)}...`;
  const rest = lines.length - Math.min(3, lines.length);
  if (rest <= 0 && head.length === text.length) return text;
  return `${head}\n[output cut to a summary: ${lines.length} lines, ${text.length} characters]`;
}

function redactBlock(b: ContentBlock, red: Redactor): ContentBlock[] {
  switch (b.type) {
    case 'text': {
      if (isReminder(b)) {
        red.report.reminders++;
        return [];
      }
      const text = red.prose(b.text);
      return text.trim() || !b.text.trim() ? [{ type: 'text', text }] : [];
    }
    case 'thinking':
      if (b.signature) red.report.signatures++;
      if (!red.opts.includeThinking) {
        red.report.thinking++;
        return [];
      }
      return [{ type: 'thinking', thinking: red.text(b.thinking) }];
    case 'redacted_thinking':
      red.report.redactedThinking++;
      return [];
    case 'image':
    case 'document':
      return [attachment(b, red)];
    case 'tool_use':
      if (b.signature) red.report.signatures++;
      return [{ type: 'tool_use', id: b.id, name: b.name, input: red.deep(b.input ?? {}) }];
    case 'tool_result':
      return [toolResult(b, red)];
    default:
      return [];
  }
}

function redactMessage(m: Message, red: Redactor): Message | undefined {
  red.at = m.id;
  const content = m.content.flatMap((b) => redactBlock(b, red));
  if (!content.length) return undefined;
  const recalled = m.meta?.recalled;
  if (Array.isArray(recalled)) red.report.recalled += recalled.length;
  const meta: Record<string, unknown> = {};
  for (const k of MESSAGE_META) if (m.meta?.[k] !== undefined) meta[k] = m.meta[k];
  return {
    id: m.id,
    sessionId: m.sessionId,
    seq: m.seq,
    role: m.role,
    kind: m.kind,
    content,
    ...(m.model ? { model: m.model } : {}),
    ...(m.agent ? { agent: m.agent } : {}),
    ...(m.author ? { author: m.author } : {}),
    ...(m.group ? { group: m.group } : {}),
    ...(m.stopReason ? { stopReason: m.stopReason } : {}),
    createdAt: m.createdAt,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

/**
 * A transcript safe to share, and what was taken out. Messages left with no
 * content (only reminders or thinking) are dropped; usage and cost go too.
 */
export function redactMessages(messages: Message[], opts: RedactOptions = {}): { messages: Message[]; report: RedactReport } {
  const red = new Redactor(opts);
  const out = messages.map((m) => redactMessage(m, red)).filter((m): m is Message => !!m);
  return { messages: out, report: red.report };
}

// ---------------------------------------------------------------------------
// export and bundle
// ---------------------------------------------------------------------------

/** What sharing needs from the engine; EngineApi has it. */
export interface ShareHost {
  repos: Pick<Repos, 'sessions' | 'messages' | 'db'>;
  devices: { list(): Device[] };
}

/** Options for a bundle. ShareOptions, and what a share to a friend adds. */
export interface BundleOptions extends Omit<ShareOptions, 'toolOutput'> {
  /** true or full: tool results as they are, sanitized; summary: their first lines; false or none: a placeholder. */
  toolOutput?: boolean | ToolOutputMode;
  /** Stop after this message of the root session (its id). Subagents it had not started by then stay out. */
  upTo?: string;
  /** Ids of redaction items (RedactionItem) the owner keeps anyway. */
  keep?: string[];
  /** Collect the finds here (with its own keep list), to add the code's to them. */
  log?: RedactionLog;
}

function toolMode(v: BundleOptions['toolOutput']): ToolOutputMode {
  if (v === false || v === 'none') return 'none';
  return v === 'summary' ? 'summary' : 'full';
}

/** The redaction settings for one session: its folder, its device's home, and every device's names. */
export function redactOptionsFor(host: ShareHost, session: Session, opts: BundleOptions = {}): RedactOptions {
  const devices = host.devices.list();
  const device = devices.find((d) => d.id === session.device);
  const home = device?.info?.home || (session.device === 'local' ? homedir() : undefined);
  return {
    cwd: session.cwd,
    ...(home ? { home } : {}),
    includeThinking: !!opts.thinking,
    includeToolOutput: toolMode(opts.toolOutput) !== 'none',
    toolOutput: toolMode(opts.toolOutput),
    includeAttachments: opts.attachments !== false,
    includeDiffs: true,
    hostnames: devices.flatMap((d) => [d.name, d.info?.hostname ?? '']).filter(Boolean),
  };
}

function fileName(title: string, ext: string): string {
  return `${title.replace(/\W+/g, '-').replace(/^-+|-+$/g, '') || 'session'}.${ext}`;
}

/** The fields of a session that may leave the hub, with its title and settings through the text rules. */
function sharedSession(s: Session, red: Redactor): Omit<BundleSession, 'messages'> {
  return {
    id: s.id,
    title: red.text(s.title),
    kind: s.kind === 'chat' ? 'chat' : 'agent',
    mode: s.mode,
    ...(s.modeConfig ? { modeConfig: red.deep(s.modeConfig) } : {}),
    ...(s.chat ? { chat: { ...s.chat } } : {}),
    tags: s.tags.map((t) => red.text(t)),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    hints: { agent: s.agent, model: s.model },
  };
}

export interface ExportResult {
  content: string;
  filename: string;
  /** What the sanitizer took out. Unset for a raw export. */
  report?: RedactReport;
}

/**
 * GET /api/sessions/:id/export. Markdown or JSON, sanitized by redactMessages.
 * raw is the stored rows as they are, reminders and recalled memories
 * included: for the owner's backups only (the route checks the token).
 */
export function exportSession(host: ShareHost, id: string, format: 'md' | 'json', opts: ShareOptions & { raw?: boolean } = {}): ExportResult {
  const s = host.repos.sessions.get(id);
  if (!s) throw new EngineError(404, `Unknown session ${id}`);
  const msgs = host.repos.messages.list(id);
  if (opts.raw) {
    if (format === 'json') return { content: JSON.stringify({ session: s, messages: msgs }, null, 2), filename: fileName(s.title, 'json') };
    return { content: `# ${s.title}\n\n${renderTranscript(msgs, { includeThinking: true, includeTools: true })}`, filename: fileName(s.title, 'md') };
  }
  const red = new Redactor(redactOptionsFor(host, s, opts));
  const session = sharedSession(s, red);
  const messages = msgs.map((m) => redactMessage(m, red)).filter((m): m is Message => !!m);
  const report = red.report;
  if (format === 'json') {
    const shared = messages.map(({ sessionId: _s, agent: _a, ...m }) => m);
    return { content: JSON.stringify({ format: 'conclave-export', version: 1, session, messages: shared, report }, null, 2), filename: fileName(session.title, 'json'), report };
  }
  const md = `# ${session.title}\n\n${renderTranscript(messages, { includeThinking: !!opts.thinking, includeTools: true })}`;
  return { content: md, filename: fileName(session.title, 'md'), report };
}

/** Signs bundles with the hub key. The key stays in the server package (identity.ts). */
export interface BundleSigner {
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  /** First 16 bytes of SHA-256 of the raw key, hex. */
  fingerprint: string;
  name?: string;
  /** base64url Ed25519 signature of BUNDLE_PREFIX + payload. The signer adds the prefix itself. */
  signBundle(payload: string): string;
}

/** JSON with keys sorted at every level and no spaces; undefined values left out. What a bundle signature covers. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** The root session and the subagents it started, found through Task results' meta.sessionId (tools/task.ts). */
function sessionTree(host: ShareHost, root: Session, upTo?: number): Array<{ session: Session; messages: Message[] }> {
  const out: Array<{ session: Session; messages: Message[] }> = [];
  const seen = new Set([root.id]);
  const queue = [root];
  while (queue.length && out.length < 50) {
    const s = queue.shift()!;
    const all = host.repos.messages.list(s.id);
    // the range applies to the root; a subagent it started inside the range comes whole
    const messages = s.id === root.id && upTo !== undefined ? all.filter((m) => m.seq <= upTo) : all;
    out.push({ session: s, messages });
    for (const m of messages) {
      for (const b of m.content) {
        const child = b.type === 'tool_result' ? b.meta?.sessionId : undefined;
        if (typeof child !== 'string' || seen.has(child)) continue;
        const c = host.repos.sessions.get(child);
        // only a session this one started: a result cannot pull in an unrelated session
        if (!c || c.parentId !== s.id) continue;
        seen.add(child);
        queue.push(c);
      }
    }
  }
  return out;
}

/** The project a session belongs to, without local paths (no folders, no Syncthing ids, no clone URL). */
function projectOf(host: ShareHost, projectId: string | undefined): BundleProject | undefined {
  if (!projectId) return undefined;
  try {
    const r = host.repos.db.query('SELECT name, identity FROM projects WHERE id = ?').get(projectId) as { name: string; identity: string } | null;
    if (!r) return undefined;
    const id = json<{ gitRoots?: string[]; remotes?: string[]; shallow?: boolean; marker?: string; head?: string }>(r.identity, {});
    return {
      name: r.name,
      gitRoots: id.gitRoots ?? [],
      remotes: id.remotes ?? [],
      shallow: !!id.shallow,
      ...(id.marker ? { marker: id.marker } : {}),
      ...(id.head ? { head: id.head } : {}),
    };
  } catch {
    // a hub without the projects table
    return undefined;
  }
}

function bundleMessage(m: Message): BundleMessage {
  return {
    role: m.role,
    kind: m.kind,
    content: m.content,
    ...(m.model ? { model: m.model } : {}),
    ...(m.author ? { author: m.author } : {}),
    ...(m.group ? { group: m.group } : {}),
    createdAt: m.createdAt,
    ...(m.stopReason ? { stopReason: m.stopReason } : {}),
    meta: { external: { id: m.id } },
  };
}

/** What a bundle holds before it is signed, and what the text rules found on the way. */
export interface CollectedBundle {
  root: Session;
  includes: BundleIncludes;
  report: RedactReport;
  items: RedactionItem[];
  sessions: BundleSession[];
  project?: BundleProject;
  /** Messages in the root session, and how many of them the range takes. */
  total: number;
  /** The range's last message, when it stops early. */
  upTo?: { id: string; seq: number };
}

/** The sanitized sessions of a bundle and what was found, without a signature (the review before sending uses this too). */
export function collectBundle(host: ShareHost, sessionId: string, opts: BundleOptions = {}): CollectedBundle {
  const root = host.repos.sessions.get(sessionId);
  if (!root) throw new EngineError(404, `Unknown session ${sessionId}`);
  const mode = toolMode(opts.toolOutput);
  const includes: BundleIncludes = { thinking: !!opts.thinking, toolOutput: mode !== 'none', attachments: opts.attachments !== false, code: !!opts.code, ...(mode === 'summary' ? { toolSummaries: true } : {}) };
  let upTo: CollectedBundle['upTo'];
  const rootMessages = host.repos.messages.list(root.id);
  if (opts.upTo) {
    const m = rootMessages.find((x) => x.id === opts.upTo);
    if (!m) throw new EngineError(400, `Message ${opts.upTo} is not in this session.`);
    upTo = { id: m.id, seq: m.seq };
  }
  const log = opts.log ?? new RedactionLog(opts.keep ?? []);
  const report = emptyReport();
  const tree = sessionTree(host, root, upTo?.seq);
  const ids = new Set(tree.map((t) => t.session.id));
  const sessions: BundleSession[] = tree.map(({ session: s, messages }) => {
    const red = new Redactor({ ...redactOptionsFor(host, s, opts), includeDiffs: includes.code, log });
    const shared = sharedSession(s, red);
    const out = messages.map((m) => redactMessage(m, red)).filter((m): m is Message => !!m);
    addReport(report, red.report);
    return { ...shared, ...(s.parentId && ids.has(s.parentId) && s.id !== root.id ? { parentId: s.parentId } : {}), messages: out.map(bundleMessage) };
  });
  const project = includes.code ? projectOf(host, root.projectId) : undefined;
  return { root, includes, report, items: log.list(), sessions, ...(project ? { project } : {}), total: rootMessages.length, ...(upTo ? { upTo } : {}) };
}

/**
 * GET /api/sessions/:id/bundle: the session and its subagents, sanitized and
 * signed. Code (edit diffs and the project identity) only with opts.code.
 * A share to a friend adds what it is (share) and its code (attach); the
 * signature covers both.
 */
export function buildBundle(host: ShareHost, sessionId: string, opts: BundleOptions & { signer: BundleSigner; now?: number; share?: BundleShareInfo; attach?: BundleCode }): ConclaveBundle {
  return signBundle(collectBundle(host, sessionId, opts), opts);
}

/** Sign what collectBundle gathered. */
export function signBundle(c: CollectedBundle, opts: { signer: BundleSigner; now?: number; share?: BundleShareInfo; attach?: BundleCode }): ConclaveBundle {
  const body: Omit<ConclaveBundle, 'signature'> = {
    format: 'conclave-bundle',
    version: 1,
    createdAt: opts.now ?? Date.now(),
    from: { publicKey: opts.signer.publicKey, fingerprint: opts.signer.fingerprint, ...(opts.signer.name ? { name: opts.signer.name } : {}) },
    includes: c.includes,
    report: c.report,
    sessions: c.sessions,
    ...(c.project ? { project: c.project } : {}),
    ...(opts.share ? { share: opts.share } : {}),
    ...(opts.attach ? { code: opts.attach } : {}),
  };
  return { ...body, signature: opts.signer.signBundle(canonicalJson(body)) };
}

export type BundleCheck = { ok: true; fingerprint: string } | { ok: false; reason: string };

/**
 * Check a bundle's signature against the key it names. With fingerprint,
 * also check that the key is the one expected (a hub paired or trusted
 * before). A bundle changed after signing, by one byte, fails.
 */
export function verifyBundle(bundle: unknown, opts: { fingerprint?: string } = {}): BundleCheck {
  if (!bundle || typeof bundle !== 'object') return { ok: false, reason: 'not a bundle' };
  const b = bundle as Partial<ConclaveBundle>;
  if (b.format !== 'conclave-bundle' || b.version !== 1) return { ok: false, reason: 'not a conclave-bundle version 1' };
  if (typeof b.signature !== 'string' || !b.signature) return { ok: false, reason: 'no signature' };
  const publicKey = b.from?.publicKey;
  if (typeof publicKey !== 'string') return { ok: false, reason: 'no public key' };
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 32) return { ok: false, reason: 'the public key is not an Ed25519 key' };
  const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  if (b.from?.fingerprint !== fingerprint) return { ok: false, reason: 'the fingerprint does not match the public key' };
  if (opts.fingerprint && opts.fingerprint.toLowerCase() !== fingerprint) return { ok: false, reason: 'signed by a different hub' };
  const { signature, ...rest } = b;
  let good = false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    good = verify(null, Buffer.from(BUNDLE_PREFIX + canonicalJson(rest), 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    good = false;
  }
  return good ? { ok: true, fingerprint } : { ok: false, reason: 'the signature does not match' };
}
