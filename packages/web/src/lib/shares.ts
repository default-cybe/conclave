/**
 * Shares with friends in words (docs/design/FRIENDS.md, phases 2 and 3): the
 * card both sides see, a share's state, the review before sending (what
 * goes, what the sanitizer found, keep anyway), the range a share can stop
 * at, a shared conversation as quoted turns, a friend's thread with notes
 * and shares, and what to mark read. No React here, so the tests run it as
 * is.
 */
import type {
  ApplySharePlan,
  BundleMessage,
  FriendDto,
  InboxItemDto,
  OutboxItemDto,
  ReceivedShareDto,
  RedactionItem,
  RedactReport,
  SentShareDto,
  ShareCodeMode,
  ShareContentOptions,
  SharePreview,
  ShareSummary,
  ToolOutputMode,
} from '@conclave/core/client';
import type { Message } from '@conclave/core/types';
import type { ToolCall } from './toolLine';
import { hhmm, shortDate } from './format';
import { stampText, STAMP_GAP_MS, type Tone } from './friends';
import { shareWaiting, unreadNotes, unreadShare } from './friendInbox';

export { shareWaiting, unreadNotes, unreadShare };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** "session, 42 messages, diff 12 files", as the hub writes it inside the brackets. */
function summaryParts(kind: 'chat' | 'session', s: ShareSummary): string {
  const code = s.code ? `, ${s.code.kind === 'diff' ? 'diff' : 'git bundle'} ${plural(s.code.files, 'file')}` : '';
  return `${kind}, ${plural(s.messages, 'message')}${code}`;
}

/** "(session, 42 messages, diff 12 files)". */
export function describeShare(kind: 'chat' | 'session', s: ShareSummary): string {
  return `(${summaryParts(kind, s)})`;
}

/** "Session, 42 messages, diff 12 files": the line under a share's title. */
export function summaryText(kind: 'chat' | 'session', s: ShareSummary): string {
  const t = summaryParts(kind, s);
  return t[0].toUpperCase() + t.slice(1);
}

/** The Inbox line: "Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files)". The hub's own, else made here. */
export function shareLine(s: Pick<ReceivedShareDto, 'line' | 'friendName' | 'title' | 'kind' | 'summary'>): string {
  return s.line || `${s.friendName} sent '${s.title}' ${describeShare(s.kind, s.summary)}`;
}

export interface ShareWords {
  /** Short: "Waiting for you", "Accepted". */
  word: string;
  tone: Tone;
  /** One more sentence, when there is more to say. */
  line?: string;
}

/** "on 19 Nov", "tomorrow", "in 3 days": when an offer expires. */
function expiresWords(ts: number, now: number): string {
  const days = Math.round((ts - now) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days} days`;
  return `on ${shortDate(ts)}`;
}

/** How a share from a friend stands, for its card and its page. */
export function receivedWords(s: ReceivedShareDto, now = Date.now()): ShareWords {
  const who = s.friendName;
  switch (s.state) {
    case 'offered':
      return { word: 'Waiting for you', tone: 'warn', line: `Nothing is fetched until you accept.${s.expiresAt ? ` It expires ${expiresWords(s.expiresAt, now)}.` : ''}${s.error ? ` ${s.error}` : ''}` };
    case 'fetching':
      return { word: 'Fetching', tone: 'dim', line: `Fetching it from ${who}'s hub and checking the signature.` };
    case 'accepted':
      if (s.updateWaiting) return { word: `Revision ${s.revision} waits`, tone: 'warn', line: `${who} sent a new revision. Accept it to fetch it.${s.error ? ` ${s.error}` : ''}` };
      return { word: 'Accepted', tone: 'ok', ...(s.error ? { line: s.error } : {}) };
    case 'declined':
      return { word: 'Declined', tone: 'dim', line: `${who}'s hub is not told. You can still accept it.` };
    case 'revoked':
      return { word: 'Unsent', tone: 'dim', line: `${who} unsent it. Their hub asked yours to delete its copy, and it did. Forks and handoffs you made stay yours.` };
    case 'expired':
      return { word: 'Expired', tone: 'dim', line: `It was not accepted in 30 days. Ask ${who} to send it again.` };
  }
}

/** How one friend has a share this hub sent. */
export function recipientWords(r: SentShareDto['recipients'][number], share: Pick<SentShareDto, 'revision' | 'state'>): ShareWords {
  if (share.state === 'revoked' || r.state === 'revoked') return { word: 'Unsent', tone: 'dim', line: `${r.friendName}'s hub is asked to delete its copy.` };
  switch (r.state) {
    case 'accepted':
      if (r.acceptedRevision && r.acceptedRevision < share.revision) return { word: `Accepted revision ${r.acceptedRevision}`, tone: 'ok', line: `Revision ${share.revision} waits for ${r.friendName}.` };
      return { word: 'Accepted', tone: 'ok' };
    case 'delivered':
      return { word: 'Delivered', tone: 'dim', line: `Waiting for ${r.friendName} to accept.` };
    case 'sent':
      return r.lastError ? { word: 'Not delivered yet', tone: 'warn', line: r.lastError } : { word: 'Sending', tone: 'dim' };
    case 'failed':
      return { word: 'Not delivered', tone: 'fault', line: r.lastError ?? `${r.friendName}'s hub could not be reached for 7 days.` };
    case 'expired':
      return { word: 'Expired', tone: 'dim', line: `${r.friendName} did not accept it in 30 days.` };
  }
}

/** A sent share is still out: it can get a new revision or be unsent. */
export const sentActive = (s: Pick<SentShareDto, 'state'>) => s.state === 'active';

// ---------------------------------------------------------------------------
// The review before sending
// ---------------------------------------------------------------------------

/** What the owner picks in the review. Title and note do not change what the sanitizer finds. */
export interface ReviewChoices {
  /** The last message that goes (its id); unset: the whole session. */
  upTo?: string;
  toolOutput: ToolOutputMode;
  attachments: boolean;
  thinking: boolean;
  code: ShareCodeMode;
  /** Redaction items to send anyway. */
  keep: string[];
}

/** The hub's defaults: full tool output, attachments, no thinking, a session's diff (a chat has no code). */
export function reviewStart(kind: 'chat' | 'session', from?: ShareContentOptions): ReviewChoices {
  return {
    ...(from?.upTo ? { upTo: from.upTo } : {}),
    toolOutput: from?.toolOutput ?? 'full',
    attachments: from?.attachments ?? true,
    thinking: from?.thinking ?? false,
    code: kind === 'chat' ? 'none' : (from?.code ?? 'diff'),
    keep: [...(from?.keep ?? [])],
  };
}

/** The choices as the hub takes them, every field said so nothing falls back to a default by surprise. */
export function reviewOptions(c: ReviewChoices): ShareContentOptions {
  return { toolOutput: c.toolOutput, attachments: c.attachments, thinking: c.thinking, code: c.code, ...(c.upTo ? { upTo: c.upTo } : {}), ...(c.keep.length ? { keep: [...c.keep].sort() } : {}) };
}

/** Changes when the review has to ask the hub again. */
export function reviewKey(c: ReviewChoices): string {
  return JSON.stringify(reviewOptions(c));
}

/** Keep an item anyway, or take it out again. */
export function toggleKeep(c: ReviewChoices, id: string): ReviewChoices {
  return { ...c, keep: c.keep.includes(id) ? c.keep.filter((k) => k !== id) : [...c.keep, id] };
}

const RULE_WORDS: Record<RedactionItem['rule'], string> = {
  secret: 'Secret',
  path: 'Path',
  privateIp: 'Private address',
  email: 'Email',
  hostname: 'Device name',
};

/** "Secret", "Path", "Private address", "Email", "Device name". */
export const ruleWord = (rule: RedactionItem['rule']) => RULE_WORDS[rule] ?? 'Value';

/** A found value until the owner asks to see it: its ends, the middle hidden. */
export function maskValue(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= 8) return '•'.repeat(Math.max(4, one.length));
  return `${one.slice(0, 4)}•••${one.slice(-2)}`;
}

/** "Found 3 times", "Found once". */
export function timesWords(n: number): string {
  return n === 1 ? 'Found once' : n === 2 ? 'Found twice' : `Found ${n} times`;
}

/** What goes in place of an item: its replacement, or a word for nothing. */
export function goesAs(item: RedactionItem): string {
  if (item.kept) return 'Goes as it is';
  return item.replacement ? `Goes as ${item.replacement}` : 'Taken out';
}

const REPORT_WORDS: Array<[keyof RedactReport, string, string?]> = [
  ['secrets', 'secret'],
  ['paths', 'path'],
  ['privateIps', 'private address', 'private addresses'],
  ['emails', 'email'],
  ['hostnames', 'device name'],
  ['reminders', 'system reminder'],
  ['recalled', 'recalled memory', 'recalled memories'],
  ['thinking', 'thinking block'],
  ['signatures', 'reasoning signature'],
  ['redactedThinking', 'encrypted reasoning block'],
  ['toolOutputs', 'tool output'],
  ['attachments', 'attachment'],
];

/** What the sanitizer took out or replaced, in words, the rules the owner can keep first: "2 secrets", "3 paths". */
export function reportWords(r: RedactReport): string[] {
  return REPORT_WORDS.filter(([k]) => (r[k] ?? 0) > 0).map(([k, one, many]) => `${r[k]} ${r[k] === 1 ? one : (many ?? `${one}s`)}`);
}

/** "Taken out: 2 secrets, 3 paths and 1 email." or "Nothing taken out." */
export function reportSentence(r: RedactReport): string {
  const w = reportWords(r);
  if (!w.length) return 'Nothing taken out.';
  const list = w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
  return `Taken out: ${list}.`;
}

/** "About 48 KB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `About ${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `About ${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The send button: "Send to Alice", "Send to Alice and Ben", "Send to 3 friends". */
export function sendLabel(names: string[]): string {
  if (!names.length) return 'Send';
  if (names.length === 1) return `Send to ${names[0]}`;
  if (names.length === 2) return `Send to ${names[0]} and ${names[1]}`;
  return `Send to ${names.length} friends`;
}

/** "Alice", "Alice and Ben", "Alice, Ben and Chen". */
export function namesWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Messages that go of all, for the review's range line: "12 of 42 messages", "All 42 messages". */
export function rangeWords(p: Pick<SharePreview, 'messages' | 'total'>): string {
  return p.messages >= p.total ? `All ${plural(p.total, 'message')}` : `${p.messages} of ${plural(p.total, 'message')}`;
}

/** Friends a share can go to: active ones, by name. */
export function shareTargets(friends: FriendDto[]): FriendDto[] {
  return friends.filter((f) => f.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
}

/** Text of a message's text blocks, on one line, without the hub's own context for the model (system reminders). */
function oneLine(m: Pick<Message, 'content'>): string {
  return m.content
    .filter((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>'))
    .map((b) => (b as { text: string }).text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RangeStop {
  /** The last message of the turn: what upTo names. */
  id: string;
  /** What the owner asked in that turn. */
  label: string;
  /** Messages up to and with this turn. */
  count: number;
}

/**
 * Where a share can stop: after each turn but the last (the last is the
 * whole session). A turn starts with a message the owner wrote and goes on
 * to the message before the next one.
 */
export function rangeStops(messages: Array<Pick<Message, 'id' | 'role' | 'kind' | 'content'>>): RangeStop[] {
  const starts: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.kind !== 'notice' && oneLine(m)) starts.push(i);
  });
  const out: RangeStop[] = [];
  for (let t = 0; t < starts.length - 1; t++) {
    const end = starts[t + 1] - 1;
    const text = oneLine(messages[starts[t]]);
    out.push({ id: messages[end].id, label: text.length > 80 ? `${text.slice(0, 79)}…` : text, count: end + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A shared conversation, quoted
// ---------------------------------------------------------------------------

export type QuotedUnit =
  | { kind: 'user'; key: string; text: string; at: number; attachments: number }
  /** first: the first reply after the friend's message, which names who answers. */
  | { kind: 'assistant'; key: string; text: string; at: number; model?: string; calls: ToolCall[]; failed: number; first: boolean };

/**
 * A shared session's messages as turns to read: what the friend asked, then
 * each message of their assistant, its words and its tool calls folded into
 * one line after them. A tool result (a user message that only carries
 * results) counts toward the calls before it.
 */
export function quotedUnits(messages: Array<Pick<BundleMessage, 'role' | 'kind' | 'content' | 'createdAt' | 'model' | 'meta'>>): QuotedUnit[] {
  const out: QuotedUnit[] = [];
  messages.forEach((m, i) => {
    const key = m.meta?.external?.id ?? String(i);
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n\n')
      .trim();
    const prev = out[out.length - 1];
    if (m.role === 'user') {
      const failed = m.content.filter((b) => b.type === 'tool_result' && (b as { isError?: boolean }).isError).length;
      if (prev?.kind === 'assistant') prev.failed += failed;
      const attachments = m.content.filter((b) => b.type === 'image' || b.type === 'document').length;
      if (text || attachments) out.push({ kind: 'user', key, text, at: m.createdAt, attachments });
      return;
    }
    const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ name: (b as { name: string }).name, input: (b as { input?: Record<string, unknown> }).input }));
    if (!text && !calls.length) return;
    out.push({ kind: 'assistant', key, text, at: m.createdAt, ...(m.model ? { model: m.model } : {}), calls, failed: 0, first: prev?.kind !== 'assistant' });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/** "Diff of 3 files", "Git bundle of fix/login, 4 files". */
export function codeWords(c: { kind: 'diff' | 'git-bundle'; files: string[] | number; branch?: string }): string {
  const n = typeof c.files === 'number' ? c.files : c.files.length;
  return c.kind === 'diff' ? `Diff of ${plural(n, 'file')}` : `Git bundle${c.branch ? ` of ${c.branch}` : ''}, ${plural(n, 'file')}`;
}

/** A slug as the hub makes branch names (core session/share-code.ts slug). */
function slug(text: string, max = 40): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'share';
}

/** The branch the hub names when the owner leaves it to it: from-alice/fix-flaky-auth-test. */
export function branchHint(friend: string, title: string): string {
  return `from-${slug(friend, 24)}/${slug(title)}`;
}

/** What applying the plan does, in one sentence. */
export function planSentence(p: Pick<ApplySharePlan, 'kind' | 'files' | 'branch' | 'root' | 'deviceName' | 'base'>): string {
  return `${p.kind === 'diff' ? 'The diff' : 'The git bundle'} of ${plural(p.files.length, 'file')} goes onto a new branch ${p.branch} in ${p.root} on ${p.deviceName}${p.base ? `, from ${p.base.slice(0, 10)}` : ''}.`;
}

/** "good until 14:32": how long a plan waits for the owner's approval. */
export function planUntil(p: Pick<ApplySharePlan, 'expiresAt'>): string {
  return `This check is good until ${hhmm(p.expiresAt)}.`;
}

// ---------------------------------------------------------------------------
// A friend's thread: notes and shares both ways
// ---------------------------------------------------------------------------

export type FriendEntry =
  | { kind: 'in'; id: string; at: number; text: string; state: InboxItemDto['state']; stamp?: string }
  | { kind: 'out'; id: string; at: number; text: string; item: OutboxItemDto; stamp?: string }
  | { kind: 'share-in'; id: string; at: number; share: ReceivedShareDto; stamp?: string }
  | { kind: 'share-out'; id: string; at: number; share: SentShareDto; stamp?: string };

/** The preview the hub keeps of a sent note, without its "note: " prefix. */
const previewText = (preview: string) => preview.replace(/^note:\s*/, '');

/**
 * Notes and shares with one friend, oldest first. A sent note shows its
 * whole text (the hub keeps it, OutboxItemDto.text); a hub from before that
 * gives only its preview. A share sits where it was first sent or received.
 * The first entry, and one after a pause, get a time label.
 */
export function friendThread(friendId: string, inbox: InboxItemDto[], outbox: OutboxItemDto[], received: ReceivedShareDto[], sent: SentShareDto[], now = Date.now()): FriendEntry[] {
  const list: FriendEntry[] = [
    ...inbox.filter((n) => n.type === 'note' && n.friendId === friendId).map((n): FriendEntry => ({ kind: 'in', id: n.id, at: n.receivedAt, text: n.text ?? '', state: n.state })),
    ...outbox.filter((o) => o.type === 'note' && o.friendId === friendId).map((o): FriendEntry => ({ kind: 'out', id: o.id, at: o.createdAt, text: o.text ?? previewText(o.preview), item: o })),
    ...received.filter((s) => s.friendId === friendId).map((s): FriendEntry => ({ kind: 'share-in', id: s.id, at: s.receivedAt, share: s })),
    ...sent.filter((s) => s.recipients.some((r) => r.friendId === friendId)).map((s): FriendEntry => ({ kind: 'share-out', id: s.id, at: s.createdAt, share: s })),
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  let last = -Infinity;
  for (const e of list) {
    if (e.at - last >= STAMP_GAP_MS) e.stamp = stampText(e.at, now);
    last = e.at;
  }
  return list;
}

// ---------------------------------------------------------------------------
// Read marks
// ---------------------------------------------------------------------------

/**
 * What to tell the hub is read once a friend's page shows it: the newest
 * note not read yet, and each share card not read yet (a mark is a time on
 * the hub's clock, and a share's is when it last changed there). Nothing
 * when all is read.
 */
export function readTargets(f: Pick<FriendDto, 'id' | 'unread' | 'readAt'>, notes: InboxItemDto[], shares: ReceivedShareDto[]): string[] {
  if (f.unread === 0) return [];
  const mine = notes.filter((n) => n.friendId === f.id);
  const newest = unreadNotes(f, mine).reduce<InboxItemDto | undefined>((a, b) => (!a || b.receivedAt > a.receivedAt ? b : a), undefined);
  return [...(newest ? [newest.id] : []), ...shares.filter((s) => s.friendId === f.id && unreadShare(s)).map((s) => s.id)];
}
