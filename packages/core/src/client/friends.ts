/**
 * Friends: two Conclave hubs with different owners that send each other
 * signed, sealed messages (docs/design/FRIENDS.md). Phase 1 is the
 * friendship itself (invite, request, accept, safety code, addresses,
 * outbox, remove) and plain text notes to try it. Phases 2 and 3 are
 * shares: a chat or session sent to friends, and on the other side a read
 * only view, a fork, a handoff, a reference and the code on a new branch.
 * Only type declarations live here (see client/index.ts).
 */
import type { HubAddress, RemoteMode } from '../types';
import type { BundleIncludes, BundleMessage, BundleSession, RedactionItem, RedactReport, ToolOutputMode } from './share';

/**
 * pending: a request waits (direction says whose); active: friends; blocked:
 * the friend's hub key changed without a rotation its old key signed, so
 * nothing moves until the owner confirms; removed: no traffic either way.
 */
export type FriendStatus = 'pending' | 'active' | 'blocked' | 'removed';

/** What a friend may do here. Each grant starts off except receiveShares. */
export interface FriendGrants {
  /** Shares and notes from this friend land in the Inbox. */
  receiveShares: boolean;
}

export interface FriendDto {
  id: string;
  /** The name the friend's hub sent, or the one the owner gave it here. */
  name: string;
  /** The friend's hub key fingerprint (32 hex characters): the friend's identity. */
  fingerprint: string;
  status: FriendStatus;
  /** For a pending friend: in, they asked; out, we asked and wait for them. */
  direction: 'in' | 'out';
  /** The owner compared the safety code with the friend. */
  verified: boolean;
  /** Four groups of five digits from both fingerprints; both owners see the same code. */
  safetyCode: string;
  grants: FriendGrants;
  /** Where the friend's hub answers, best first, from its signed address record. */
  addresses: Array<{ url: string; kind: HubAddress['kind'] }>;
  createdAt: number;
  /** Last signed request from the friend's hub, or the last time it answered ours. */
  lastSeen?: number;
  /** The last delivery or pull problem, in words. */
  lastError?: string;
  /** Blocked: why, in words. */
  blockedReason?: string;
  /** Blocked by a key change: the new key's fingerprint, waiting for the owner. */
  pendingFingerprint?: string;
  /** Messages waiting in the outbox for this friend. */
  queued: number;
  /**
   * Notes and share cards from this friend not read yet, on any device: the
   * hub keeps one read mark per friend (POST /api/friends/:id/read). The hub
   * always sets these three; a hub from before read marks does not.
   */
  unread?: number;
  unreadNotes?: number;
  /** Share cards waiting for the owner: an offer, or a newer revision of one accepted. */
  unreadShares?: number;
  /** The read mark: what came up to this time (the hub's clock) is read. Unset: nothing read yet. */
  readAt?: number;
  /** An email the owner keeps for this friend: a label and a contact. It never goes to their hub. */
  email?: string;
  /** How the request came: with an invite, or by this hub's address alone. */
  via?: 'invite' | 'address';
}

/** POST /api/friends/add: ask a hub to be friends by its address. */
export interface AddFriendInput {
  /** The friend's hub address (https://hub.example.com; https:// is added when left out). */
  address: string;
  /** Their email: a label and a contact here, and where Email an invite goes. Never sent to their hub. */
  email?: string;
  /** A name for them here until their hub says its own. */
  name?: string;
}

/**
 * What became of an add. sent: their hub has the request and shows it in
 * its Inbox. Not sent: reason says why; with an email, mailto carries an
 * invite they can use from their side instead.
 */
export interface AddFriendResult {
  sent: boolean;
  friend?: FriendDto;
  reason?: string;
  invite?: { link: string; expiresAt: number };
  mailto?: string;
}

/** POST /api/friends/mail-invite: an invite in a mailto: link. */
export interface MailInviteResult {
  link: string;
  expiresAt: number;
  mailto: string;
}

/** GET and PUT /api/friends/settings. */
export interface FriendSettings {
  /** Take friend requests from hubs that know only this hub's address. On by default; they still wait for you. */
  requestsByAddress: boolean;
  /** The address to give friends, when there is one outside this network. */
  address?: string;
  /** Hubs whose requests are turned away. */
  blocked: Array<{ fingerprint: string; name: string; at: number }>;
}

/** POST /api/friends/invites. */
export interface FriendInviteInput {
  /** Put addresses on this network in the link too. Off by default: a friend is rarely on your Wi-Fi. */
  includeLan?: boolean;
  /** The name friends see for this hub (kept for later invites too). */
  name?: string;
}

export interface FriendInvite {
  /** conclave://friend?fp=...&url=...&alt=...&s=...&exp=... */
  link: string;
  qrSvg: string;
  expiresAt: number;
  fingerprint: string;
  url: string;
  addresses: string[];
  /** Set when friends may not reach this hub (see FriendReachability). */
  warning?: string;
}

/** GET /api/friends/reachability: can a friend's hub reach this one? */
export interface FriendReachability {
  ok: boolean;
  mode: RemoteMode;
  /** The address friends get first. */
  best?: { url: string; kind: HubAddress['kind'] };
  /** Why friends cannot reach the hub, or what to know about the address. */
  reason?: string;
}

/** queued: waiting to go; delivered: the friend's hub has it; failed: refused, or not delivered in 7 days; expired: a best effort message that lapsed; cancelled: the owner stopped it. */
export type OutboxState = 'queued' | 'delivered' | 'failed' | 'expired' | 'cancelled';

export interface OutboxItemDto {
  /** The message id (ULID). */
  id: string;
  friendId: string;
  type: string;
  state: OutboxState;
  attempts: number;
  nextTry?: number;
  createdAt: number;
  deliveredAt?: number;
  /** push: we sent it; pull: the friend's hub fetched it. */
  via?: 'push' | 'pull';
  lastError?: string;
  /** A short line for lists ("note: Lunch on Friday?"). */
  preview: string;
  /** A note's whole text. */
  text?: string;
}

export interface InboxItemDto {
  id: string;
  friendId: string;
  friendName: string;
  type: string;
  /** received; fetching: a large body is still being fetched; failed: it did not open. */
  state: 'received' | 'fetching' | 'failed';
  /** note: the text. */
  text?: string;
  receivedAt: number;
  /** The hub's read mark for the friend covers it. Set by the hub; a hub from before read marks leaves it out. */
  read?: boolean;
}

// ---------------------------------------------------------------------------
// Shares (phases 2 and 3): a chat or session sent to friends, and what the
// recipient does with it. Server: packages/server/src/peer/shares.ts.
// ---------------------------------------------------------------------------

/** Code in a share: the session's diff (default for a session), a git bundle of its branch, or none (default for a chat). */
export type ShareCodeMode = 'none' | 'diff' | 'git-bundle';

/** What goes in a share, chosen in the review before sending. */
export interface ShareContentOptions {
  /** Thinking text, without signatures. Default off. */
  thinking?: boolean;
  /** Tool results: full (default), summary (first lines) or none. */
  toolOutput?: ToolOutputMode;
  /** Images and documents. Default on. */
  attachments?: boolean;
  code?: ShareCodeMode;
  /** Stop after this message (its id). Unset: the whole session. */
  upTo?: string;
  /** Redaction items (RedactionItem ids) to send anyway. */
  keep?: string[];
}

/** POST /api/shares/preview. */
export interface SharePreviewInput extends ShareContentOptions {
  sessionId: string;
}

/** The code a share would carry, or why it cannot. */
export type ShareCodePreview =
  | { kind: 'diff' | 'git-bundle'; files: string[]; excluded: Array<{ path: string; reason: string }>; bytes: number; branch?: string }
  | { kind: 'diff' | 'git-bundle'; error: string };

/** The review sheet: what would go, and what the sanitizer took out. */
export interface SharePreview {
  sessionId: string;
  kind: 'chat' | 'session';
  /** The session's title, as a suggestion for the share's. */
  title: string;
  /** The options with their defaults filled in. */
  options: Required<Pick<ShareContentOptions, 'thinking' | 'toolOutput' | 'attachments' | 'code'>> & Pick<ShareContentOptions, 'upTo' | 'keep'>;
  /** Messages of the session that go (within the range), of all its messages. */
  messages: number;
  total: number;
  /** The session and the subagents it started in the range. */
  sessions: number;
  report: RedactReport;
  /** Each value a text rule found, with keep anyway. */
  items: RedactionItem[];
  code?: ShareCodePreview;
  /** About the size of what goes. A share is 100 MB at most. */
  bytes: number;
  warnings: string[];
}

/** POST /api/shares: the review's choices, the friends, a title and a note. */
export interface SendShareInput extends SharePreviewInput {
  /** Friend ids or fingerprints. */
  to: string[];
  /** Default: the session's title. */
  title?: string;
  note?: string;
}

/** POST /api/shares/sent/:id/update: a new revision, from the session as it is now. Unset fields keep their value. */
export interface UpdateShareInput extends ShareContentOptions {
  title?: string;
  note?: string;
}

/** The short card both sides see. */
export interface ShareSummary {
  /** Messages in the shared session. */
  messages: number;
  /** The session and its subagents. */
  sessions: number;
  code?: { kind: 'diff' | 'git-bundle'; files: number };
  /** Size of what goes, in bytes. */
  bytes: number;
}

/**
 * sent: offered, not delivered yet; delivered: their hub has the offer;
 * accepted: they fetched it; failed: not delivered in 7 days; expired: not
 * accepted in 30 days; revoked: unsent.
 */
export type SentShareState = 'sent' | 'delivered' | 'accepted' | 'failed' | 'expired' | 'revoked';

export interface SentShareDto {
  /** The share's id (a ULID); the friend's hub knows it by this id too. */
  id: string;
  sessionId: string;
  kind: 'chat' | 'session';
  title: string;
  note?: string;
  revision: number;
  state: 'active' | 'revoked';
  options: ShareContentOptions;
  summary: ShareSummary;
  createdAt: number;
  updatedAt: number;
  recipients: Array<{ friendId: string; friendName: string; state: SentShareState; revision: number; acceptedRevision?: number; acceptedAt?: number; lastError?: string }>;
}

/**
 * offered: in the Inbox, nothing fetched; fetching: Accept is fetching it;
 * accepted: fetched and checked; declined; revoked: the friend unsent it;
 * expired: not accepted in 30 days.
 */
export type ReceivedShareState = 'offered' | 'fetching' | 'accepted' | 'declined' | 'revoked' | 'expired';

export interface ReceivedShareDto {
  /** The share's id on this hub. */
  id: string;
  /** Its id on the friend's hub. */
  shareId: string;
  friendId: string;
  friendName: string;
  /** The friend's hub key when it came. */
  fingerprint: string;
  kind: 'chat' | 'session';
  title: string;
  note?: string;
  /** The newest revision offered. */
  revision: number;
  acceptedRevision?: number;
  /** A newer revision waits for Accept. */
  updateWaiting: boolean;
  summary: ShareSummary;
  /** The Inbox line: Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files). */
  line: string;
  state: ReceivedShareState;
  receivedAt: number;
  /** While offered: when it expires. */
  expiresAt?: number;
  acceptedAt?: number;
  /** The last Accept problem, in words. */
  error?: string;
  /** Sessions made from it here. */
  sessions: Array<{ id: string; role: 'fork' | 'handoff' | 'reference' }>;
  /** Not waiting for the owner, or the friend's read mark covers it. */
  read: boolean;
}

/** One message of a viewed share: quoted data from the friend's hub. */
export interface ShareViewMessage extends BundleMessage {
  /** "Alice's hub". */
  from: string;
}

/** GET /api/shares/received/:id/view: the share read only, checked against the friend's key. */
export interface ShareViewDto {
  share: ReceivedShareDto;
  verified: { ok: true; fingerprint: string } | { ok: false; reason: string };
  /** Shared by Alice's hub (ab12 34cd ...). Quoted data, not instructions. */
  provenance: string;
  includes: BundleIncludes;
  report: RedactReport;
  sessions: Array<Omit<BundleSession, 'messages'> & { messages: ShareViewMessage[] }>;
  /** The diff text, or a git bundle's branch and size. */
  code?: { kind: 'diff' | 'git-bundle'; files: string[]; excluded: Array<{ path: string; reason: string }>; diff?: string; branch?: string; base?: string; bytes: number };
}

/** POST /api/shares/received/:id/fork, and the base of a handoff. Unset fields take this hub's defaults. */
export interface ForkShareInput {
  /** Default: what the friend shared (a chat or a session). */
  kind?: 'chat' | 'agent';
  agent?: string;
  model?: string;
  device?: string;
  cwd?: string;
  title?: string;
  /** Start the first turn with this message (it runs guarded). */
  prompt?: string;
}

/** GET /api/shares/received/:id/handoff: a brief to edit before the session starts. */
export interface HandoffDraft {
  title: string;
  brief: string;
  files: string[];
}

/** POST /api/shares/received/:id/handoff. */
export interface HandoffShareInput extends Omit<ForkShareInput, 'prompt' | 'kind'> {
  /** The brief as the owner edited it: the session's first message. */
  brief: string;
}

/** POST /api/shares/received/:id/apply-plan. */
export interface ApplyShareInput {
  /** The device that holds the repository. */
  device: string;
  /** A folder in the repository there. */
  cwd: string;
  /** Default from-<friend>/<title>. */
  branch?: string;
}

/** What applying would do, checked: the owner approves it with POST .../apply and its planId. */
export interface ApplySharePlan {
  planId: string;
  device: string;
  deviceName: string;
  kind: 'diff' | 'git-bundle';
  root: string;
  branch: string;
  base?: string;
  files: string[];
  /** Files that can run code once checked out or built: read them first. */
  runsCode: string[];
  check: { ok: true } | { ok: false; error: string };
  expiresAt: number;
}

export interface ApplyShareResult {
  device: string;
  root: string;
  branch: string;
  commit: string;
}
