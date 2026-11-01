/**
 * Shared projects between friends (docs/design/FRIENDS.md, "Shared projects
 * as built").
 *
 * A shared project is a name, an optional GitHub repository, and items:
 * notes, memories the owner picks one by one, and chats or sessions shared
 * through the phase 2 share mechanics. Code never goes hub to hub; it syncs
 * through GitHub, and the project page reads each member's open branches and
 * pull requests there.
 *
 * Topology. The hub that made the project (its owner) is the hub of a star:
 * every member is the owner's friend, members need not be friends with each
 * other. A member's item goes to the owner's hub, which passes it on to the
 * other members. Every message is a peer envelope (signed by the sending
 * hub, sealed for the receiving one, through the outbox, so it waits while a
 * hub is offline and can be pulled). Every item is also signed by its
 * author's hub key, so the owner's hub can pass it on but cannot change it,
 * and an item a hub cannot check against its author's key is refused.
 *
 *   project.invite  owner to a friend: the card (name, repo, owner, members). Nothing else before Accept.
 *   project.join    member to owner: accepted. The owner answers with project.state.
 *   project.leave   member to owner: declined, or left.
 *   project.meta    owner to members: name, repo, members and their keys, ended. Numbered by seq.
 *   project.item    one version of one item, signed by its author: member to owner, owner to members.
 *   project.state   owner to a member: the meta and every item, on join and on sync.
 *   project.sync    member to owner: send me project.state again.
 *
 * Each item has one author and only its author edits or deletes it. An edit
 * is a new version; the last HISTORY_KEEP versions are kept, and an older
 * one is never sent on. Last writer wins only within one author's own item
 * (higher version, then the later time), against the newest version, which
 * is always kept, so a gone version changes nothing. Everything that
 * leaves the hub passes the secret rule first, and a friend's items pass it
 * again when they are shown or read. To this hub's agents a friend's items
 * are untrusted data, fenced and named (core session/shared-project.ts).
 */
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { ShareSummary } from '@conclave/core/client/friends.ts';
import type {
  CreateSharedProjectInput,
  SharedItemDto,
  SharedItemKind,
  SharedItemVersionDto,
  SharedMemberDto,
  SharedMemberState,
  SharedMemoryCandidate,
  SharedProjectChange,
  SharedProjectCodeDto,
  SharedProjectDto,
  SharedProjectState,
  SharedProjectView,
  SharedPullDto,
  SharedWriteResult,
  UpdateSharedProjectInput,
} from '@conclave/core/client/shared-projects.ts';
import type { Session } from '@conclave/core/types.ts';
import type { Tool } from '@conclave/core/tools/types.ts';
import type { RunnerExtension } from '@conclave/core/session/runner-ext.ts';
import { canonicalJson } from '@conclave/core/session/share.ts';
import { friendShareOf } from '@conclave/core/session/friend-share.ts';
import { isUntrusted } from '@conclave/core/session/untrusted.ts';
import { SHARED_PROJECT_TOOL, sharedProjectTool, type SharedContextProject } from '@conclave/core/session/shared-project.ts';
import { redactSecrets, redactSecretsCounted } from '@conclave/core/memory/secrets.ts';
import { parseRepoName } from '@conclave/core/github/api.ts';
import { githubOf } from '@conclave/core/github/attached.ts';
import { projectsOf } from '@conclave/core/projects/attached.ts';
import { formatFingerprint } from '@conclave/core/client/index.ts';
import { logger } from '@conclave/core/util/log.ts';
import { HttpError } from '../http';
import { FINGERPRINT, PEER_TAG, fingerprintOf, verifySigned, type Signer } from './crypto';
import { HISTORY_KEEP, ProjectShareStore, type ItemRow, type MemberRow, type ProjectRow, type WireItem } from './project-store';
import type { PeerService } from './service';
import type { Friend } from './store';
import { ULID, ulid } from './ulid';

const log = logger('peer.projects');

/** What an item's author signs: this, then the canonical JSON of the item without its signature. */
export const ITEM_PREFIX = `${PEER_TAG} project-item\n`;
export const NAME_MAX = 120;
export const DESC_MAX = 2000;
export const TITLE_MAX = 200;
export const NOTE_MAX = 64_000;
export const MEMORY_MAX = 8000;
/** Members besides the owner. */
export const MAX_MEMBERS = 20;
/** Items a project keeps, deleted ones too. */
export const MAX_ITEMS = 2000;
/** A member that asks for the whole project again (sync, or join while in it) gets it at most this often. */
export const STATE_EVERY_MS = 60_000;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MEMBER_STATES: readonly SharedMemberState[] = ['invited', 'active', 'declined', 'left', 'removed'];

export interface ProjectHost {
  engine: EngineApi;
  identity: Signer;
  now: () => number;
}

interface Meta {
  projectId: string;
  seq: number;
  name: string;
  description?: string;
  repo?: string;
  ended?: true;
  members: Array<{ fingerprint: string; publicKey: string; name: string; role: 'owner' | 'member'; state: SharedMemberState; github?: string }>;
}

/** One line from outside: no control characters or line breaks, at most `max` characters. */
function line(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
}

/** Text from outside: no control characters but line breaks and tabs, at most `max` characters. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || undefined;
}

function count(v: unknown, max = 10_000_000): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, max) : 0;
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e14;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function short(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

/** owner/name from what an owner typed: owner/name, a github.com address, or a git remote. */
export function repoName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const n = parseRepoName(s);
  return n ? `${n.owner}/${n.name}` : undefined;
}

/** A remote a local project knows ("github.com/owner/name") as owner/name. */
function githubRemote(remotes: string[]): string | undefined {
  for (const r of remotes) {
    const m = /^github\.com\/([^/]+\/[^/]+)$/i.exec(r);
    if (m) return repoName(m[1]);
  }
  return undefined;
}

function cleanSummary(v: unknown): ShareSummary | undefined {
  const s = v as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  const c = s.code as { kind?: unknown; files?: unknown } | undefined;
  return {
    messages: count(s.messages),
    sessions: count(s.sessions, 1000),
    ...(c && (c.kind === 'diff' || c.kind === 'git-bundle') ? { code: { kind: c.kind, files: count(c.files) } } : {}),
    bytes: count(s.bytes),
  };
}

/** An item from another hub, with exactly the fields an author signs, or undefined when it does not have the shape. */
export function parseItem(raw: unknown, projectId: string): WireItem | undefined {
  const i = raw as Record<string, unknown>;
  if (!i || typeof i !== 'object' || Array.isArray(i)) return undefined;
  if (i.v !== 1 || i.project !== projectId || typeof i.id !== 'string' || !ULID.test(i.id)) return undefined;
  if (typeof i.author !== 'string' || !FINGERPRINT.test(i.author)) return undefined;
  if (i.kind !== 'note' && i.kind !== 'memory' && i.kind !== 'chat') return undefined;
  if (typeof i.version !== 'number' || !Number.isSafeInteger(i.version) || i.version < 1 || i.version > 1_000_000) return undefined;
  if (!isTime(i.createdAt) || !isTime(i.updatedAt)) return undefined;
  if (i.deleted !== undefined && i.deleted !== true) return undefined;
  if (i.title !== undefined && (typeof i.title !== 'string' || i.title.length > TITLE_MAX)) return undefined;
  if (typeof i.text !== 'string' || i.text.length > (i.kind === 'memory' ? MEMORY_MAX : NOTE_MAX)) return undefined;
  let chat: WireItem['chat'];
  if (i.chat !== undefined) {
    const c = i.chat as Record<string, unknown>;
    const summary = cleanSummary(c?.summary);
    if (i.kind !== 'chat' || !c || typeof c.shareId !== 'string' || !ULID.test(c.shareId) || (c.kind !== 'chat' && c.kind !== 'session') || !summary) return undefined;
    chat = { shareId: c.shareId, kind: c.kind, summary };
  } else if (i.kind === 'chat' && !i.deleted) return undefined;
  if (typeof i.sig !== 'string' || !i.sig || i.sig.length > 200) return undefined;
  return {
    v: 1,
    project: projectId,
    id: i.id,
    author: i.author,
    kind: i.kind,
    version: i.version,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    ...(i.deleted ? { deleted: true as const } : {}),
    ...(i.title !== undefined ? { title: i.title as string } : {}),
    text: i.text,
    ...(chat ? { chat } : {}),
    sig: i.sig,
  };
}

/** True when the item is signed by `publicKey` (its author's hub key). */
export function verifyItem(item: WireItem, publicKey: string): boolean {
  try {
    if (fingerprintOf(publicKey) !== item.author) return false;
  } catch {
    return false;
  }
  const { sig, ...rest } = item;
  return verifySigned(publicKey, ITEM_PREFIX, canonicalJson(rest), sig);
}

export function signItem(signer: Signer, item: Omit<WireItem, 'sig'>): WireItem {
  return { ...item, sig: signer.sign(ITEM_PREFIX, canonicalJson(item)) };
}

/** The owner's meta, checked: one owner, the sender; every member's key matches its fingerprint. */
export function parseMeta(b: Record<string, unknown>, ownerFp: string): Meta | undefined {
  const projectId = typeof b.projectId === 'string' && ULID.test(b.projectId) ? b.projectId : undefined;
  const seq = typeof b.seq === 'number' && Number.isSafeInteger(b.seq) && b.seq >= 1 ? b.seq : undefined;
  const name = line(b.name, NAME_MAX);
  if (!projectId || !seq || !name || !Array.isArray(b.members) || !b.members.length || b.members.length > MAX_MEMBERS + 1) return undefined;
  const members: Meta['members'] = [];
  const seen = new Set<string>();
  for (const raw of b.members) {
    const m = raw as Record<string, unknown>;
    if (!m || typeof m.fingerprint !== 'string' || !FINGERPRINT.test(m.fingerprint) || typeof m.publicKey !== 'string' || seen.has(m.fingerprint)) return undefined;
    try {
      if (fingerprintOf(m.publicKey) !== m.fingerprint) return undefined;
    } catch {
      return undefined;
    }
    if ((m.role !== 'owner' && m.role !== 'member') || !MEMBER_STATES.includes(m.state as SharedMemberState)) return undefined;
    seen.add(m.fingerprint);
    members.push({
      fingerprint: m.fingerprint,
      publicKey: m.publicKey,
      name: line(m.name, 60) ?? `Hub ${formatFingerprint(m.fingerprint).slice(0, 9)}`,
      role: m.role,
      state: m.state as SharedMemberState,
      ...(typeof m.github === 'string' && GITHUB_LOGIN.test(m.github) ? { github: m.github } : {}),
    });
  }
  const owners = members.filter((m) => m.role === 'owner');
  if (owners.length !== 1 || owners[0].fingerprint !== ownerFp) return undefined;
  const description = text(b.description, DESC_MAX);
  const repo = repoName(b.repo);
  return { projectId, seq, name, ...(description ? { description } : {}), ...(repo ? { repo } : {}), ...(b.ended === true ? { ended: true as const } : {}), members };
}

export class SharedProjectService {
  readonly store: ProjectShareStore;
  readonly tool: Tool;
  private off: Array<() => void> = [];
  private lastStatus = new Map<string, Session['status']>();
  private bg = new Set<Promise<unknown>>();
  /** When the whole project last went to a member: "<project>:<fingerprint>". */
  private stateSentAt = new Map<string, number>();

  constructor(
    private readonly peer: PeerService,
    private readonly host: ProjectHost,
  ) {
    this.store = new ProjectShareStore(host.engine.repos.db, host.now);
    this.tool = sharedProjectTool((s) => this.contextFor(s)) as unknown as Tool;
  }

  private get engine(): EngineApi {
    return this.host.engine;
  }

  private now(): number {
    return this.host.now();
  }

  private get me(): string {
    return this.peer.fingerprint;
  }

  // -------------------------------------------------------------------------
  // Lifecycle: the SharedProject tool, and sharing new sessions
  // -------------------------------------------------------------------------

  start(): void {
    if (this.off.length) return;
    // the real engine takes runner extensions; a hub without them has no tool
    const ext = (this.engine as unknown as { runnerExtensions?: { register(e: RunnerExtension): () => void } }).runnerExtensions;
    if (ext?.register) {
      this.off.push(
        ext.register({
          name: 'shared-projects',
          tools: (session, tools, depth) => {
            if (depth > 0 || tools.some((t) => t.name === SHARED_PROJECT_TOOL)) return;
            if (this.untrusted(session) || !this.linked(session).length) return;
            return [...tools, this.tool];
          },
        }),
      );
    }
    this.off.push(this.engine.bus.on((e) => this.onEvent(e as { type: string; session?: Session })));
  }

  stop(): void {
    for (const f of this.off.splice(0)) f();
  }

  /** Wait for background work (chats shared after a join, new sessions shared). */
  async settled(): Promise<void> {
    while (this.bg.size) await Promise.allSettled([...this.bg]);
  }

  private track(p: Promise<unknown>): void {
    const done = p.catch((err) => log.warn(`shared project work failed: ${short(err)}`)).finally(() => this.bg.delete(done));
    this.bg.add(done);
  }

  private untrusted(session: Session): boolean {
    const own = (this.engine as unknown as { isUntrusted?: (s: Session) => boolean }).isUntrusted;
    return own ? own.call(this.engine, session) : isUntrusted(session);
  }

  /** A turn ended in a session of a project that shares new sessions: send it to the members once. */
  private onEvent(e: { type: string; session?: Session }): void {
    if (e.type !== 'session.updated' || !e.session) return;
    const s = e.session;
    const was = this.lastStatus.get(s.id);
    this.lastStatus.set(s.id, s.status);
    if (this.lastStatus.size > 5000) this.lastStatus.clear();
    if (was !== 'running' || s.status !== 'idle') return;
    if (s.parentId || friendShareOf(s) || this.untrusted(s)) return;
    for (const p of this.linked(s)) {
      // only sessions created after the switch went on; one made in the same millisecond is not new
      if (!p.shareNew || p.state !== 'active' || s.createdAt <= (p.shareNewSince ?? Infinity)) continue;
      if (this.store.bySource(p.id, s.id)) continue;
      this.track(this.shareChats(p.id, [s.id], 'hub'));
    }
  }

  // -------------------------------------------------------------------------
  // DTOs
  // -------------------------------------------------------------------------

  private require(id: string): ProjectRow {
    const p = this.store.get(id);
    if (!p) throw new HttpError(404, `unknown shared project ${id}`);
    return p;
  }

  /** A member's name here: the friend's name on this hub, else the name the owner listed. This hub: its own name. */
  private nameOf(m: Pick<MemberRow, 'fingerprint' | 'name'>): string {
    if (m.fingerprint === this.me) return this.peer.ourName();
    return this.peer.store.friendByFingerprint(m.fingerprint)?.name ?? m.name;
  }

  private memberDto(m: MemberRow): SharedMemberDto {
    const f = m.fingerprint === this.me ? undefined : this.peer.store.friendByFingerprint(m.fingerprint);
    return {
      fingerprint: m.fingerprint,
      name: this.nameOf(m),
      role: m.role,
      state: m.state,
      you: m.fingerprint === this.me,
      ...(f && f.status !== 'removed' ? { friendId: f.id } : {}),
      ...(m.github ? { github: m.github } : {}),
    };
  }

  private lineOf(p: ProjectRow, ownerName: string, members: SharedMemberDto[], counts: SharedProjectDto['counts']): string {
    const others = members.filter((m) => !m.you && m.state === 'active').map((m) => m.name);
    const memories = counts.memories === 1 ? '1 memory' : `${counts.memories} memories`;
    const what = [counts.notes ? plural(counts.notes, 'note') : '', counts.memories ? memories : '', counts.chats ? plural(counts.chats, 'chat') : ''].filter(Boolean).join(', ');
    switch (p.state) {
      case 'invited':
        return `${ownerName} invited you to '${p.name}'`;
      case 'declined':
        return 'You declined.';
      case 'left':
        return 'You left. Your copy stays here, read only.';
      case 'removed':
        return `${ownerName} took you out. Your copy stays here, read only.`;
      case 'ended':
        return `${ownerName} ended it. Your copy stays here, read only.`;
      default: {
        const waiting = members.filter((m) => !m.you && m.state === 'invited').length;
        const who = others.length ? `With ${others.join(', ')}` : waiting ? `${plural(waiting, 'invite')} waiting` : 'Just you so far';
        return `${who}${what ? `. ${what}` : ''}`;
      }
    }
  }

  dto(p: ProjectRow): SharedProjectDto {
    const members = this.store.members(p.id).map((m) => this.memberDto(m));
    const owner = members.find((m) => m.role === 'owner');
    const ownerName = owner?.name ?? this.peer.store.friendByFingerprint(p.ownerFp)?.name ?? 'Its owner';
    const counts = this.store.counts(p.id);
    const unread = p.state === 'invited' ? 1 : p.state === 'active' ? this.store.unread(p.id, this.me, p.readAt ?? 0) : 0;
    return {
      id: p.id,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(p.repo ? { repo: p.repo } : {}),
      role: p.ownerFp === this.me ? 'owner' : 'member',
      state: p.state,
      owner: { fingerprint: p.ownerFp, name: ownerName, you: p.ownerFp === this.me, ...(owner?.friendId ? { friendId: owner.friendId } : {}) },
      members,
      counts,
      unread,
      line: this.lineOf(p, ownerName, members, counts),
      ...(p.localProjectId ? { localProjectId: p.localProjectId } : {}),
      shareNewSessions: p.shareNew,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      ...(p.readAt ? { readAt: p.readAt } : {}),
    };
  }

  private itemDto(p: ProjectRow, r: ItemRow): SharedItemDto {
    const i = r.item;
    const mine = r.author === this.me;
    const author = this.store.member(p.id, r.author);
    let chat: SharedItemDto['chat'];
    if (i.chat) {
      const friend = mine ? undefined : this.peer.store.friendByFingerprint(r.author);
      const received = friend ? this.peer.shares.store.inByShare(friend.id, i.chat.shareId) : undefined;
      chat = { ...i.chat, ...(received ? { receivedId: received.id } : {}), ...(mine && r.source ? { sessionId: r.source } : {}) };
    }
    return {
      id: r.id,
      kind: r.kind,
      author: r.author,
      authorName: author ? this.nameOf(author) : mine ? this.peer.ourName() : (this.peer.store.friendByFingerprint(r.author)?.name ?? 'A member'),
      mine,
      version: r.version,
      // the secret rule again on what came from another hub
      ...(i.title !== undefined ? { title: mine ? i.title : redactSecrets(i.title) } : {}),
      text: mine ? i.text : redactSecrets(i.text),
      ...(chat ? { chat } : {}),
      ...(r.deleted ? { deleted: true } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      receivedAt: r.receivedAt,
      unread: !mine && !r.deleted && p.state === 'active' && r.receivedAt > (p.readAt ?? 0),
    };
  }

  list(): SharedProjectDto[] {
    return this.store.list().map((p) => this.dto(p));
  }

  view(id: string): SharedProjectView {
    const p = this.require(id);
    // an invite shows its card only: nothing of the project is here before Accept
    const items = p.state === 'invited' ? [] : this.store.items(p.id).map((r) => this.itemDto(p, r));
    return { ...this.dto(p), items };
  }

  private emit(id: string, change: SharedProjectChange, item?: SharedItemDto): void {
    const p = this.store.get(id);
    if (p) this.engine.bus.emit({ type: 'friend.project', change, project: this.dto(p), ...(item ? { item } : {}) });
  }

  private link(id: string): string {
    return `/projects/${id}`;
  }

  // -------------------------------------------------------------------------
  // Sending: to the owner, or from the owner to the members
  // -------------------------------------------------------------------------

  /** A friend this hub can seal for, or undefined. */
  private friendOf(fp: string): Friend | undefined {
    const f = this.peer.store.friendByFingerprint(fp);
    return f && f.status === 'active' && f.subkey ? f : undefined;
  }

  /** The owner's hub, as a friend to send to. */
  private ownerFriend(p: ProjectRow): Friend {
    const f = this.peer.store.friendByFingerprint(p.ownerFp);
    if (!f || f.status !== 'active') throw new HttpError(409, `You are not friends with ${f?.name ?? "the project's owner"} now, so nothing goes to the project.`);
    if (!f.subkey) throw new HttpError(409, `This hub does not have ${f.name}'s key for sealing yet. Try Sync.`);
    return f;
  }

  /** The owner sends to members in these states (active by default), but not to `except`. */
  private fanout(p: ProjectRow, type: string, body: unknown, opts: { except?: string[]; also?: string[]; preview: string }): number {
    let n = 0;
    for (const m of this.store.members(p.id)) {
      if (m.fingerprint === this.me || opts.except?.includes(m.fingerprint)) continue;
      if (m.state !== 'active' && !opts.also?.includes(m.fingerprint)) continue;
      const f = this.friendOf(m.fingerprint);
      if (!f) {
        log.warn(`shared project ${p.id}: ${m.name} is not a friend this hub can seal for; skipped`);
        continue;
      }
      this.peer.queue(f, type, body, { preview: opts.preview, actor: 'hub' });
      n++;
    }
    return n;
  }

  private meta(p: ProjectRow): Meta {
    return {
      projectId: p.id,
      seq: p.metaSeq,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(p.repo ? { repo: p.repo } : {}),
      ...(p.state === 'ended' ? { ended: true as const } : {}),
      members: this.store.members(p.id).map((m) => ({
        fingerprint: m.fingerprint,
        publicKey: m.publicKey,
        name: m.fingerprint === this.me ? this.peer.ourName() : m.name,
        role: m.role,
        state: m.state,
        ...(m.github ? { github: m.github } : {}),
      })),
    };
  }

  /** The owner changed the project or its members: a new meta to every active member (and `also`). */
  private bumpMeta(p: ProjectRow, also: string[] = [], except: string[] = []): ProjectRow {
    const next = this.store.update(p.id, { metaSeq: p.metaSeq + 1 })!;
    this.fanout(next, 'project.meta', this.meta(next), { also, except, preview: `project: ${next.name}` });
    return next;
  }

  /** The whole project for one member: on join and on sync. */
  private sendState(p: ProjectRow, f: Friend): void {
    // the newest state stands for an older one still waiting for that member, so the outbox holds one per project
    for (const q of this.peer.store.queued(f.id)) {
      if (q.type !== 'project.state' || !q.body) continue;
      try {
        if ((JSON.parse(q.body) as { projectId?: unknown }).projectId === p.id) this.peer.store.updateOutbox(q.id, { state: 'cancelled' });
      } catch {
        /* not a body this hub wrote */
      }
    }
    const items = this.store.items(p.id, { deleted: true }).map((r) => r.item).filter((i) => i.kind !== 'chat' || i.chat || i.deleted);
    this.peer.queue(f, 'project.state', { ...this.meta(p), items }, { preview: `project: ${p.name}, ${plural(items.length, 'item')}`, actor: 'hub' });
    this.stateSentAt.set(`${p.id}:${f.fingerprint}`, this.now());
    if (this.stateSentAt.size > 1000) this.stateSentAt.delete(this.stateSentAt.keys().next().value as string);
  }

  /** The whole project went to this member a moment ago: asking again is not answered yet (each answer is every item). */
  private stateTooSoon(p: ProjectRow, f: Friend): boolean {
    const at = this.stateSentAt.get(`${p.id}:${f.fingerprint}`);
    return at !== undefined && this.now() - at < STATE_EVERY_MS;
  }

  /** An item this hub keeps goes on: a member's to the owner, the owner's (or one it passes on) to the members. */
  private sendItem(p: ProjectRow, item: WireItem): void {
    // a chat waits for a member it can be shared with
    if (item.kind === 'chat' && !item.chat && !item.deleted) return;
    const preview = `project ${item.kind}: ${p.name}`;
    if (p.ownerFp === this.me) this.fanout(p, 'project.item', { projectId: p.id, item }, { except: [item.author], preview });
    else this.peer.queue(this.ownerFriend(p), 'project.item', { projectId: p.id, item }, { preview, actor: 'hub' });
  }

  // -------------------------------------------------------------------------
  // Writing items: only the author, through the secret rule
  // -------------------------------------------------------------------------

  private writable(p: ProjectRow): void {
    if (p.state !== 'active') throw new HttpError(409, p.state === 'invited' ? 'Accept the invite first.' : 'This project is read only here now.');
  }

  /**
   * Keep a version. The history keeps the last HISTORY_KEEP: older versions
   * go from it, and those still waiting in the outbox for a hub never go.
   */
  private keep(item: WireItem, source?: string): ItemRow {
    const row = this.store.putItem(item, source);
    if (row.version > HISTORY_KEEP) this.peer.store.cancelItemVersions(item.project, item.id, row.version - HISTORY_KEEP);
    return row;
  }

  /** A new item, or a new version of one this hub wrote. Secrets come out before it is signed and leaves. */
  private write(p: ProjectRow, input: { id?: string; kind: SharedItemKind; title?: string; text: string; chat?: WireItem['chat']; deleted?: boolean }, source?: string): SharedWriteResult {
    this.writable(p);
    const prev = input.id ? this.store.item(p.id, input.id) : undefined;
    if (input.id && !prev) throw new HttpError(404, `No item ${input.id} in this project.`);
    if (prev && prev.author !== this.me) {
      const who = this.store.member(p.id, prev.author);
      throw new HttpError(403, `Only its author edits or deletes it. This one is ${who ? this.nameOf(who) : "another member"}'s.`);
    }
    if (prev && prev.kind !== input.kind) throw new HttpError(400, `That item is a ${prev.kind}.`);
    if (!prev && this.store.items(p.id, { deleted: true }).length >= MAX_ITEMS) throw new HttpError(413, `A project keeps ${MAX_ITEMS} items at most.`);
    // a member's item goes to the owner: nothing is kept here when it cannot go
    if (p.ownerFp !== this.me) this.ownerFriend(p);
    let redacted = 0;
    const clean = (s: string) => {
      const r = redactSecretsCounted(s);
      redacted += r.count;
      return r.text;
    };
    const title = input.deleted || input.title === undefined ? undefined : clean(input.title);
    const body = input.deleted ? '' : clean(input.text);
    const now = this.now();
    const item = signItem(this.host.identity, {
      v: 1,
      project: p.id,
      id: prev?.id ?? ulid(now),
      author: this.me,
      kind: input.kind,
      version: (prev?.version ?? 0) + 1,
      createdAt: prev?.createdAt ?? now,
      updatedAt: Math.max(now, (prev?.updatedAt ?? 0) + 1),
      ...(input.deleted ? { deleted: true as const } : {}),
      ...(title ? { title } : {}),
      text: body,
      ...(input.chat && !input.deleted ? { chat: input.chat } : {}),
    });
    const row = this.keep(item, source);
    this.sendItem(p, item);
    this.peer.audit('owner', input.deleted ? 'project.item.delete' : prev ? 'project.item.edit' : 'project.item.add', `${input.kind} ${item.id} v${item.version} in '${p.name}'${redacted ? `, ${plural(redacted, 'secret')} taken out` : ''}`);
    const dto = this.itemDto(this.store.get(p.id)!, row);
    this.emit(p.id, 'item', dto);
    return { item: dto, redacted };
  }

  addNote(id: string, input: { title?: unknown; text?: unknown }): SharedWriteResult {
    const p = this.require(id);
    const body = text(input.text, NOTE_MAX);
    if (!body) throw new HttpError(400, 'text is required');
    if (typeof input.text === 'string' && input.text.length > NOTE_MAX) throw new HttpError(413, `A note is ${NOTE_MAX} characters at most.`);
    return this.write(p, { kind: 'note', title: line(input.title, TITLE_MAX), text: body });
  }

  editItem(id: string, itemId: string, input: { title?: unknown; text?: unknown }): SharedWriteResult {
    const p = this.require(id);
    const prev = this.store.item(p.id, itemId);
    if (!prev) throw new HttpError(404, `No item ${itemId} in this project.`);
    if (prev.deleted) throw new HttpError(409, 'That item was deleted.');
    if (prev.kind === 'chat') throw new HttpError(400, 'A chat is updated from its session: Update in Shares.');
    const max = prev.kind === 'memory' ? MEMORY_MAX : NOTE_MAX;
    const body = input.text === undefined ? prev.item.text : text(input.text, max);
    if (!body) throw new HttpError(400, 'text is required');
    const title = input.title === undefined ? prev.item.title : line(input.title, TITLE_MAX);
    return this.write(p, { id: prev.id, kind: prev.kind, title, text: body });
  }

  deleteItem(id: string, itemId: string, actor = 'owner'): SharedWriteResult {
    const p = this.require(id);
    const prev = this.store.item(p.id, itemId);
    if (!prev) throw new HttpError(404, `No item ${itemId} in this project.`);
    if (prev.deleted) return { item: this.itemDto(p, prev), redacted: 0 };
    const out = this.write(p, { id: prev.id, kind: prev.kind, text: '', deleted: true });
    // a chat's share is asked back from the members too
    if (prev.kind === 'chat' && prev.item.chat) {
      try {
        this.peer.shares.unsend(prev.item.chat.shareId, actor);
      } catch (err) {
        log.warn(`could not unsend the chat of item ${prev.id}: ${short(err)}`);
      }
    }
    return out;
  }

  history(id: string, itemId: string): SharedItemVersionDto[] {
    const p = this.require(id);
    const r = this.store.item(p.id, itemId);
    if (!r) throw new HttpError(404, `No item ${itemId} in this project.`);
    const mine = r.author === this.me;
    return this.store.versions(p.id, itemId).map(({ item, receivedAt }) => ({
      version: item.version,
      ...(item.title !== undefined ? { title: mine ? item.title : redactSecrets(item.title) } : {}),
      text: mine ? item.text : redactSecrets(item.text),
      ...(item.deleted ? { deleted: true } : {}),
      updatedAt: item.updatedAt,
      receivedAt,
    }));
  }

  /** The project's memories on this hub, to pick from: those under its folders on any device, else every project memory. */
  memoryCandidates(id: string): SharedMemoryCandidate[] {
    const p = this.require(id);
    const keys = this.memoryKeys(p);
    const all = this.engine.memory.list({ scope: 'project', limit: 1000 }).filter((m) => m.scope === 'project');
    const fits = keys.length ? all.filter((m) => !!m.scopeKey && keys.some((k) => m.scopeKey === k || m.scopeKey!.startsWith(`${k}/`))) : all;
    return fits.slice(0, 500).map((m) => ({ id: m.id, content: m.content, kind: m.kind, ...(m.scopeKey ? { scopeKey: m.scopeKey } : {}), shared: !!this.store.bySource(p.id, m.id) }));
  }

  private memoryKeys(p: ProjectRow): string[] {
    if (!p.localProjectId) return [];
    const svc = projectsOf(this.engine);
    if (!svc) return [p.localProjectId];
    return [p.localProjectId, ...svc.store.locations(p.localProjectId).map((l) => l.path)];
  }

  /** Share memories the owner picked, one item each; a memory shared before is a new version when it changed. */
  shareMemories(id: string, memoryIds: unknown): SharedWriteResult[] {
    const p = this.require(id);
    this.writable(p);
    if (!Array.isArray(memoryIds) || !memoryIds.length || memoryIds.length > 200 || memoryIds.some((m) => typeof m !== 'string')) throw new HttpError(400, 'memoryIds: the memories to share, by id');
    const out: SharedWriteResult[] = [];
    for (const mid of new Set(memoryIds as string[])) {
      const m = this.engine.memory.get(mid);
      if (!m) throw new HttpError(404, `unknown memory ${mid}`);
      const body = text(m.content, MEMORY_MAX) ?? '';
      if (!body) continue;
      const had = this.store.bySource(p.id, m.id);
      if (had && had.item.text === redactSecretsCounted(body).text) {
        out.push({ item: this.itemDto(p, had), redacted: 0 });
        continue;
      }
      out.push(this.write(p, { ...(had ? { id: had.id } : {}), kind: 'memory', title: m.kind, text: body }, m.id));
    }
    return out;
  }

  /**
   * Chats and sessions for the members: an item each, and a share (phase 2)
   * to every member who is this hub's friend, without code (code goes
   * through GitHub). Before a member has joined, the item waits here.
   */
  async shareChats(id: string, sessionIds: unknown, actor = 'owner'): Promise<SharedWriteResult[]> {
    const p = this.require(id);
    this.writable(p);
    if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 50 || sessionIds.some((s) => typeof s !== 'string')) throw new HttpError(400, 'sessionIds: the chats and sessions to share, by id');
    const out: SharedWriteResult[] = [];
    for (const sid of new Set(sessionIds as string[])) {
      const s = this.engine.getSession(sid);
      // only the owner's chats go to friends (docs/design/ACCOUNTS.md 7)
      if (!s || (s.accountId ?? 'owner') !== 'owner') throw new HttpError(404, `Unknown session ${sid}`);
      if (s.parentId) throw new HttpError(400, 'Share the session that started this subagent; its subagents go with it.');
      if (friendShareOf(s)?.role === 'reference') throw new HttpError(409, 'This is a reference from a friend. It cannot be shared on.');
      const had = this.store.bySource(p.id, s.id);
      if (had) {
        out.push({ item: this.itemDto(p, had), redacted: 0 });
        continue;
      }
      out.push(this.write(p, { kind: 'chat', title: line(s.title, TITLE_MAX) ?? 'Shared chat', text: '' }, s.id));
    }
    await this.chatShares(p.id, actor);
    return out.map((r) => {
      const row = this.store.item(p.id, r.item.id);
      return row ? { ...r, item: this.itemDto(this.store.get(p.id)!, row) } : r;
    });
  }

  /**
   * This hub's chats in a project reach every active member who is its
   * friend: a share is made for a chat that waited, and a member who came
   * later is added to the shares made before.
   */
  private async chatShares(id: string, actor = 'hub'): Promise<void> {
    const p = this.store.get(id);
    if (!p || p.state !== 'active') return;
    const to = this.store.members(p.id).filter((m) => m.fingerprint !== this.me && m.state === 'active').map((m) => this.friendOf(m.fingerprint)).filter((f): f is Friend => !!f);
    if (!to.length) return;
    for (const r of this.store.items(p.id)) {
      if (r.author !== this.me || r.kind !== 'chat') continue;
      if (r.item.chat) {
        for (const f of to) this.peer.shares.addRecipient(r.item.chat.shareId, f, actor);
        continue;
      }
      if (!r.source || !this.engine.getSession(r.source)) continue;
      try {
        const sent = await this.peer.shares.send({ sessionId: r.source, to: to.map((f) => f.id), code: 'none', note: `In the shared project '${p.name}'.` }, actor);
        const now = this.store.get(p.id);
        if (now?.state === 'active') this.write(now, { id: r.id, kind: 'chat', title: sent.title, text: '', chat: { shareId: sent.id, kind: sent.kind, summary: sent.summary } }, r.source);
      } catch (err) {
        log.warn(`could not share chat ${r.source} in '${p.name}': ${short(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The owner: make, change, invite, take out, end
  // -------------------------------------------------------------------------

  /** Active friends this hub can seal for, from ids or fingerprints. */
  private friends(list: unknown): Friend[] {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new HttpError(400, 'members: friend ids or fingerprints');
    if (list.length > MAX_MEMBERS) throw new HttpError(400, `A project has ${MAX_MEMBERS} members at most.`);
    const out = new Map<string, Friend>();
    for (const who of list) {
      if (typeof who !== 'string') throw new HttpError(400, 'members: friend ids or fingerprints');
      const f = this.peer.require(who);
      if (f.status !== 'active') throw new HttpError(409, f.status === 'blocked' ? `${f.name}'s hub has a new key. Confirm it in Friends first.` : `You are not friends with ${f.name} now.`);
      if (!f.subkey) throw new HttpError(409, `This hub does not have ${f.name}'s key for sealing yet. Try Sync.`);
      out.set(f.id, f);
    }
    return [...out.values()];
  }

  private requireOwner(p: ProjectRow): void {
    if (p.ownerFp !== this.me) throw new HttpError(403, `Only its owner, ${this.dto(p).owner.name}, does that.`);
  }

  async create(input: CreateSharedProjectInput, actor = 'owner'): Promise<SharedProjectView> {
    const name = line(input.name, NAME_MAX);
    if (!name) throw new HttpError(400, 'name is required');
    const friends = this.friends(input.members);
    const local = input.localProjectId ? this.localProject(input.localProjectId) : undefined;
    const repo = input.repo !== undefined && input.repo !== '' ? repoName(input.repo) : local?.repo;
    if (input.repo && !repo) throw new HttpError(400, 'repo must be owner/name on GitHub');
    // what goes in it must be there before the project is made
    for (const mid of input.memoryIds ?? []) if (!this.engine.memory.get(mid)) throw new HttpError(404, `unknown memory ${mid}`);
    for (const sid of input.sessionIds ?? []) {
      // only the owner's chats go to friends (docs/design/ACCOUNTS.md 7)
      const s = this.engine.getSession(sid);
      if (!s || (s.accountId ?? 'owner') !== 'owner') throw new HttpError(404, `Unknown session ${sid}`);
    }
    const description = text(input.description, DESC_MAX);
    const now = this.now();
    const login = await githubOf(this.engine)?.login().catch(() => undefined);
    const id = ulid(now);
    const p = this.store.insert({
      id,
      ownerFp: this.me,
      name: redactSecrets(name),
      ...(description ? { description: redactSecrets(description) } : {}),
      ...(repo ? { repo } : {}),
      state: 'active',
      metaSeq: 1,
      ...(input.localProjectId ? { localProjectId: input.localProjectId } : {}),
      shareNew: !!input.shareNewSessions,
      ...(input.shareNewSessions ? { shareNewSince: now } : {}),
      readAt: now,
    });
    this.store.putMember({ projectId: id, fingerprint: this.me, publicKey: this.host.identity.publicKey, name: this.peer.ourName(), role: 'owner', state: 'active', ...(login ? { github: login } : {}) });
    for (const f of friends) this.store.putMember({ projectId: id, fingerprint: f.fingerprint, publicKey: f.publicKey, name: f.name, role: 'member', state: 'invited' });
    this.peer.audit(actor, 'project.create', `'${p.name}'${repo ? ` (${repo})` : ''}, inviting ${friends.map((f) => `${f.name} (${f.fingerprint})`).join(', ') || 'nobody yet'}`);
    const notes = text(input.notes, NOTE_MAX);
    if (notes) this.write(p, { kind: 'note', title: 'Project notes', text: notes });
    if (input.memoryIds?.length) this.shareMemories(id, input.memoryIds);
    if (input.sessionIds?.length) await this.shareChats(id, input.sessionIds, actor);
    this.sendInvites(this.store.get(id)!, friends);
    this.emit(id, 'updated');
    return this.view(id);
  }

  /** A local project of this hub (folders across devices), and the GitHub repository its remotes name. */
  private localProject(id: string): { repo?: string } | undefined {
    const svc = projectsOf(this.engine);
    if (!svc) return undefined;
    const p = svc.store.get(id);
    // a project of the owner's: a member's folders are theirs
    if (!p || (p.accountId ?? 'owner') !== 'owner') throw new HttpError(404, `unknown project ${id}`);
    const repo = githubRemote(p.identity.remotes);
    return repo ? { repo } : {};
  }

  private sendInvites(p: ProjectRow, friends: Friend[]): void {
    const counts = this.store.counts(p.id);
    for (const f of friends) this.peer.queue(f, 'project.invite', { ...this.meta(p), counts }, { preview: `project invite: ${p.name}`, actor: 'hub' });
  }

  update(id: string, input: UpdateSharedProjectInput, actor = 'owner'): SharedProjectView {
    const p = this.require(id);
    const own: Parameters<ProjectShareStore['update']>[1] = {};
    const ownerOnly = input.name !== undefined || input.description !== undefined || input.repo !== undefined;
    if (ownerOnly) {
      this.requireOwner(p);
      if (p.state !== 'active') throw new HttpError(409, 'This project ended.');
      if (input.name !== undefined) {
        const name = line(input.name, NAME_MAX);
        if (!name) throw new HttpError(400, 'name is required');
        own.name = redactSecrets(name);
      }
      if (input.description !== undefined) own.description = input.description ? (text(redactSecrets(input.description), DESC_MAX) ?? null) : null;
      if (input.repo !== undefined) {
        const repo = input.repo ? repoName(input.repo) : undefined;
        if (input.repo && !repo) throw new HttpError(400, 'repo must be owner/name on GitHub');
        own.repo = repo ?? null;
      }
    }
    if (input.localProjectId !== undefined) {
      if (input.localProjectId) this.localProject(input.localProjectId);
      own.localProjectId = input.localProjectId || null;
    }
    if (input.shareNewSessions !== undefined) {
      own.shareNew = input.shareNewSessions;
      own.shareNewSince = input.shareNewSessions ? (p.shareNew ? (p.shareNewSince ?? this.now()) : this.now()) : null;
    }
    let next = this.store.update(p.id, own)!;
    if (ownerOnly) next = this.bumpMeta(next);
    this.peer.audit(actor, 'project.update', `'${next.name}': ${Object.keys(own).join(', ') || 'nothing'}`);
    this.emit(p.id, 'updated');
    return this.view(p.id);
  }

  /** The owner invites more friends. A member who left or declined may be asked again. */
  invite(id: string, list: unknown, actor = 'owner'): SharedProjectView {
    const p = this.require(id);
    this.requireOwner(p);
    if (p.state !== 'active') throw new HttpError(409, 'This project ended.');
    const friends = this.friends(list);
    if (!friends.length) throw new HttpError(400, 'friends: at least one friend to invite');
    const others = this.store.members(p.id).filter((m) => m.role === 'member' && (m.state === 'active' || m.state === 'invited')).length;
    const fresh = friends.filter((f) => !['active', 'invited'].includes(this.store.member(p.id, f.fingerprint)?.state ?? ''));
    if (others + fresh.length > MAX_MEMBERS) throw new HttpError(400, `A project has ${MAX_MEMBERS} members at most.`);
    for (const f of fresh) this.store.putMember({ projectId: p.id, fingerprint: f.fingerprint, publicKey: f.publicKey, name: f.name, role: 'member', state: 'invited' });
    if (!fresh.length) return this.view(p.id);
    const next = this.bumpMeta(p);
    this.sendInvites(next, fresh);
    this.peer.audit(actor, 'project.invite', `'${p.name}': ${fresh.map((f) => `${f.name} (${f.fingerprint})`).join(', ')}`);
    this.emit(p.id, 'members');
    return this.view(p.id);
  }

  /** The owner takes a member out: their hub keeps a read only copy and gets nothing more. */
  removeMember(id: string, fingerprint: string, actor = 'owner'): SharedProjectView {
    const p = this.require(id);
    this.requireOwner(p);
    const m = this.store.member(p.id, fingerprint.toLowerCase());
    if (!m || m.role === 'owner') throw new HttpError(404, 'No such member.');
    if (m.state === 'removed') return this.view(p.id);
    this.store.putMember({ ...m, state: 'removed' });
    this.bumpMeta(p, [m.fingerprint]);
    this.peer.audit(actor, 'project.member.remove', `'${p.name}': ${m.name} (${m.fingerprint})`);
    this.emit(p.id, 'members');
    return this.view(p.id);
  }

  /**
   * Leave: a member tells the owner and keeps a read only copy; the owner
   * ends the project for everyone. With `forget`, a project no longer
   * active here goes from this hub.
   */
  leave(id: string, opts: { forget?: boolean } = {}, actor = 'owner'): SharedProjectDto | { ok: true } {
    const p = this.require(id);
    if (opts.forget) {
      if (p.state === 'active' || p.state === 'invited') throw new HttpError(409, p.ownerFp === this.me ? 'End it first.' : 'Leave it first.');
      this.store.delete(p.id);
      this.peer.audit(actor, 'project.forget', `'${p.name}'`);
      this.engine.bus.emit({ type: 'friend.project', change: 'forgotten', project: { ...this.dto(p), state: p.state, members: [], unread: 0 } });
      return { ok: true };
    }
    if (p.ownerFp === this.me) {
      if (p.state !== 'active') return this.dto(p);
      const ended = this.store.update(p.id, { state: 'ended' })!;
      this.bumpMeta(ended);
      this.peer.audit(actor, 'project.end', `'${p.name}': the members keep their copies`);
      this.emit(p.id, 'ended');
      return this.dto(this.store.get(p.id)!);
    }
    if (p.state === 'invited') return this.decline(id, actor);
    if (p.state !== 'active') return this.dto(p);
    const f = this.peer.store.friendByFingerprint(p.ownerFp);
    if (f?.status === 'active' && f.subkey) this.peer.queue(f, 'project.leave', { projectId: p.id }, { preview: `left project: ${p.name}`, actor });
    this.store.update(p.id, { state: 'left' });
    this.peer.audit(actor, 'project.leave', `'${p.name}': a read only copy stays here`);
    this.emit(p.id, 'left');
    return this.dto(this.store.get(p.id)!);
  }

  // -------------------------------------------------------------------------
  // A member: accept, decline, sync, read
  // -------------------------------------------------------------------------

  async accept(id: string, actor = 'owner'): Promise<SharedProjectView> {
    const p = this.require(id);
    if (p.state === 'active') return this.view(id);
    if (p.state !== 'invited') throw new HttpError(409, `This project is ${p.state} here.`);
    const owner = this.ownerFriend(p);
    const login = await githubOf(this.engine)?.login().catch(() => undefined);
    this.peer.queue(owner, 'project.join', { projectId: p.id, ...(login ? { github: login } : {}) }, { preview: `joined project: ${p.name}`, actor });
    this.store.update(p.id, { state: 'active', readAt: this.now() });
    const me = this.store.member(p.id, this.me);
    if (me) this.store.putMember({ ...me, state: 'active', ...(login ? { github: login } : {}) });
    this.peer.audit(actor, 'project.accept', `'${p.name}' from ${owner.name} (${owner.fingerprint})`);
    this.emit(p.id, 'updated');
    return this.view(id);
  }

  decline(id: string, actor = 'owner'): SharedProjectDto {
    const p = this.require(id);
    if (p.state !== 'invited') throw new HttpError(409, p.state === 'active' ? 'You are in it: leave it instead.' : `This project is ${p.state} here.`);
    const f = this.peer.store.friendByFingerprint(p.ownerFp);
    if (f?.status === 'active' && f.subkey) this.peer.queue(f, 'project.leave', { projectId: p.id, declined: true }, { preview: `declined project: ${p.name}`, actor });
    this.store.update(p.id, { state: 'declined' });
    this.peer.audit(actor, 'project.decline', `'${p.name}'`);
    this.emit(p.id, 'updated');
    return this.dto(this.store.get(p.id)!);
  }

  /** Send what waits, fetch what the owner's hub holds, and ask it for the whole project again. */
  async sync(id: string): Promise<SharedProjectView> {
    const p = this.require(id);
    if (p.ownerFp === this.me) {
      const ids = this.store.members(p.id).filter((m) => m.state === 'active' && m.fingerprint !== this.me).map((m) => this.friendOf(m.fingerprint)?.id).filter((x): x is string => !!x);
      await Promise.all(ids.map((fid) => this.peer.sync(fid).catch(() => undefined)));
    } else if (p.state === 'active') {
      const owner = this.ownerFriend(p);
      this.peer.queue(owner, 'project.sync', { projectId: p.id }, { preview: `sync project: ${p.name}`, actor: 'hub' });
      await this.peer.sync(owner.id).catch(() => undefined);
    }
    return this.view(id);
  }

  markRead(id: string): SharedProjectDto {
    const p = this.require(id);
    this.store.update(p.id, { readAt: this.now() });
    this.emit(p.id, 'updated');
    return this.dto(this.store.get(p.id)!);
  }

  // -------------------------------------------------------------------------
  // Code: GitHub only
  // -------------------------------------------------------------------------

  async code(id: string): Promise<SharedProjectCodeDto> {
    const p = this.require(id);
    const members = this.store.members(p.id).filter((m) => m.state === 'active' || m.role === 'owner').map((m) => this.memberDto(m));
    const empty = (reason: string): SharedProjectCodeDto => ({ ...(p.repo ? { repo: p.repo, url: `https://github.com/${p.repo}` } : {}), connected: false, reason, members: members.map((m) => ({ fingerprint: m.fingerprint, name: m.name, you: m.you, ...(m.github ? { github: m.github } : {}), pulls: [], branches: [] })), others: [], branches: [] });
    if (!p.repo) return empty('No GitHub repository is linked. The owner can add one.');
    const gh = githubOf(this.engine);
    if (!gh) return empty('GitHub is not set up on this hub.');
    let a: Awaited<ReturnType<typeof gh.repoActivity>>;
    try {
      a = await gh.repoActivity(p.repo);
    } catch (err) {
      return empty(short(err));
    }
    // this hub's own login, when its member row does not have it yet
    const logins = new Map<string, string>();
    for (const m of members) {
      const login = m.github ?? (m.you ? a.login : undefined);
      if (login) logins.set(login.toLowerCase(), m.fingerprint);
    }
    const pull = (x: (typeof a.pulls)[number]): SharedPullDto => ({ number: x.number, title: x.title, url: x.url, author: x.author, branch: x.branch, draft: x.draft, ...(x.updatedAt ? { updatedAt: x.updatedAt } : {}) });
    const withPull = new Set(a.pulls.map((x) => x.branch));
    return {
      repo: a.fullName,
      url: a.url,
      connected: true,
      defaultBranch: a.defaultBranch,
      private: a.private,
      members: members.map((m) => {
        const login = m.github ?? (m.you ? a.login : undefined);
        const pulls = a.pulls.filter((x) => login && x.author.toLowerCase() === login.toLowerCase()).map(pull);
        return { fingerprint: m.fingerprint, name: m.name, you: m.you, ...(login ? { github: login } : {}), pulls, branches: pulls.map((x) => x.branch) };
      }),
      others: a.pulls.filter((x) => !logins.has(x.author.toLowerCase())).map(pull),
      branches: a.branches.filter((b) => !withPull.has(b) && b !== a.defaultBranch).slice(0, 100),
    };
  }

  // -------------------------------------------------------------------------
  // Context for this hub's agents
  // -------------------------------------------------------------------------

  /** Shared projects a session belongs to: by the linked project of this hub, or by its GitHub repository. */
  private linked(s: Pick<Session, 'projectId' | 'meta' | 'accountId'>): ProjectRow[] {
    // shared projects are between the owner's hub and friends' hubs: a member's session is never linked or shared (docs/design/ACCOUNTS.md 7)
    if ((s.accountId ?? 'owner') !== 'owner') return [];
    const repo = ((s.meta?.repo as { repo?: string } | undefined)?.repo ?? '').toLowerCase();
    return this.store.list().filter((p) => (p.state === 'active' || p.state === 'ended') && ((!!p.localProjectId && s.projectId === p.localProjectId) || (!!p.repo && !!repo && p.repo.toLowerCase() === repo)));
  }

  /** What the SharedProject tool reads: the session's projects, a friend's items fenced by the renderer. */
  contextFor(session: Session): SharedContextProject[] {
    return this.linked(session).map((p) => {
      const members = this.store.members(p.id);
      return {
        id: p.id,
        name: p.name,
        ...(p.repo ? { repo: p.repo } : {}),
        members: members.filter((m) => m.state === 'active').map((m) => ({ name: this.nameOf(m), fingerprint: m.fingerprint, you: m.fingerprint === this.me, role: m.role })),
        items: this.store.items(p.id).map((r) => {
          const author = members.find((m) => m.fingerprint === r.author);
          return {
            kind: r.kind,
            ...(r.item.title ? { title: r.item.title } : {}),
            text: r.kind === 'chat' ? `A ${r.item.chat?.kind ?? 'chat'} shared through the project: ${r.item.title ?? ''}`.trim() : r.item.text,
            authorName: author ? this.nameOf(author) : 'A member',
            author: r.author,
            mine: r.author === this.me,
            version: r.version,
            updatedAt: r.updatedAt,
          };
        }),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private refuse(status: number, code: string, message: string): Error {
    return this.peer.refusal(status, code, message);
  }

  /** A project message from a friend. Returns what the inbox keeps (small). Throws a PeerRefusal when it is wrong. */
  receive(friend: Friend, type: string, b: Record<string, unknown>): unknown {
    const projectId = typeof b.projectId === 'string' && ULID.test(b.projectId) ? b.projectId : undefined;
    if (!projectId) throw this.refuse(400, 'body', 'A project message needs its projectId.');
    switch (type) {
      case 'project.invite':
        return this.invited(friend, projectId, b);
      case 'project.meta':
        return this.metaFrom(friend, projectId, b);
      case 'project.state':
        return this.stateFrom(friend, projectId, b);
      case 'project.item':
        return this.itemFrom(friend, projectId, b.item);
      case 'project.join':
        return this.joined(friend, projectId, b);
      case 'project.leave':
        return this.left(friend, projectId, b);
      case 'project.sync':
        return this.syncAsked(friend, projectId);
      default:
        throw this.refuse(422, 'type', `This hub does not take ${type} messages.`);
    }
  }

  /** A project the sender owns, or a refusal. */
  private owned(friend: Friend, projectId: string, opts: { create?: boolean } = {}): ProjectRow | undefined {
    const p = this.store.get(projectId);
    if (!p) {
      if (opts.create) return undefined;
      throw this.refuse(404, 'project', 'This hub has no such project.');
    }
    if (p.ownerFp !== friend.fingerprint) throw this.refuse(403, 'owner', "Only the project's owner sends that.");
    return p;
  }

  private applyMeta(p: ProjectRow, meta: Meta): ProjectRow {
    this.store.replaceMembers(p.id, meta.members);
    return this.store.update(p.id, { name: meta.name, description: meta.description ?? null, repo: meta.repo ?? null, metaSeq: meta.seq })!;
  }

  private invited(friend: Friend, projectId: string, b: Record<string, unknown>): unknown {
    const meta = parseMeta(b, friend.fingerprint);
    if (!meta || meta.projectId !== projectId) throw this.refuse(400, 'body', 'The invite does not have the shape of a project.');
    const mine = meta.members.find((m) => m.fingerprint === this.me);
    if (!mine || mine.state !== 'invited') throw this.refuse(400, 'body', 'The invite does not name this hub.');
    let p = this.owned(friend, projectId, { create: true });
    if (p && (p.state === 'active' || p.state === 'invited')) {
      if (meta.seq > p.metaSeq) this.applyMeta(p, meta);
      return { projectId, seq: meta.seq };
    }
    if (!p) p = this.store.insert({ id: projectId, ownerFp: friend.fingerprint, name: meta.name, state: 'invited', metaSeq: 0, shareNew: false });
    else p = this.store.update(p.id, { state: 'invited' })!;
    this.applyMeta(p, meta);
    this.peer.audit(this.peer.friendActor(friend), 'project.invited', `'${meta.name}'${meta.repo ? ` (${meta.repo})` : ''}, nothing else comes before Accept`);
    this.emit(projectId, 'invited');
    this.peer.notify(`${friend.name} invited you to '${meta.name}'`, `A shared project${meta.repo ? ` on ${meta.repo}` : ''}. Accept or decline it in your Inbox.`, 'info', this.link(projectId));
    return { projectId, seq: meta.seq };
  }

  private metaFrom(friend: Friend, projectId: string, b: Record<string, unknown>): unknown {
    const p = this.owned(friend, projectId)!;
    const meta = parseMeta(b, friend.fingerprint);
    if (!meta || meta.projectId !== projectId) throw this.refuse(400, 'body', 'That is not the shape of a project.');
    if (meta.seq <= p.metaSeq) return { projectId, seq: meta.seq, ignored: true };
    let next = this.applyMeta(p, meta);
    const mine = meta.members.find((m) => m.fingerprint === this.me);
    let change: SharedProjectChange = 'members';
    if (meta.ended && (p.state === 'active' || p.state === 'invited')) {
      next = this.store.update(p.id, { state: 'ended' })!;
      change = 'ended';
      this.peer.notify(`${friend.name} ended '${meta.name}'`, 'Your copy stays here, read only.', 'info', this.link(projectId));
    } else if ((!mine || mine.state === 'removed') && (p.state === 'active' || p.state === 'invited')) {
      next = this.store.update(p.id, { state: 'removed' })!;
      change = 'removed';
      this.peer.notify(`${friend.name} took you out of '${meta.name}'`, 'Your copy stays here, read only. Nothing more comes.', 'info', this.link(projectId));
    }
    this.emit(projectId, change);
    if (next.state === 'active') this.track(this.chatShares(projectId));
    return { projectId, seq: meta.seq };
  }

  private stateFrom(friend: Friend, projectId: string, b: Record<string, unknown>): unknown {
    const p = this.owned(friend, projectId)!;
    if (p.state !== 'active') return { projectId, ignored: true };
    const meta = parseMeta(b, friend.fingerprint);
    if (!meta || meta.projectId !== projectId) throw this.refuse(400, 'body', 'That is not the shape of a project.');
    if (meta.seq >= p.metaSeq) this.applyMeta(p, meta);
    const raw = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS) : [];
    let applied = 0;
    let refused = 0;
    for (const r of raw) {
      try {
        if (this.takeItem(this.store.get(projectId)!, friend, r, { quiet: true }) === 'applied') applied++;
      } catch (err) {
        refused++;
        log.warn(`refused an item of '${p.name}' from ${friend.name}: ${short(err)}`);
      }
    }
    this.peer.audit(this.peer.friendActor(friend), 'project.state', `'${meta.name}': ${plural(applied, 'item')} new${refused ? `, ${refused} refused` : ''}`);
    this.emit(projectId, 'updated');
    this.track(this.chatShares(projectId));
    return { projectId, items: raw.length, applied, refused };
  }

  private itemFrom(friend: Friend, projectId: string, raw: unknown): unknown {
    const p = this.store.get(projectId);
    if (!p) throw this.refuse(404, 'project', 'This hub has no such project.');
    const result = this.takeItem(p, friend, raw);
    return { projectId, result };
  }

  /**
   * One item version from a friend's hub. The owner takes it only from its
   * author, an active member, and passes it on; a member takes it only from
   * the owner. Either way it must check out against its author's key.
   */
  private takeItem(p: ProjectRow, friend: Friend, raw: unknown, opts: { quiet?: boolean } = {}): 'applied' | 'stale' | 'duplicate' | 'ignored' {
    const item = parseItem(raw, p.id);
    if (!item) throw this.refuse(400, 'body', 'That is not the shape of a project item.');
    let key: string;
    if (p.ownerFp === this.me) {
      const m = this.store.member(p.id, friend.fingerprint);
      if (!m || m.state !== 'active') throw this.refuse(403, 'member', 'You are not a member of this project.');
      if (item.author !== friend.fingerprint) throw this.refuse(403, 'author', "A member sends only items it wrote. Another member's item comes from the owner.");
      if (p.state !== 'active') throw this.refuse(409, 'ended', 'This project ended.');
      key = m.publicKey;
    } else {
      if (p.ownerFp !== friend.fingerprint) throw this.refuse(403, 'owner', "Items come through the project's owner.");
      if (p.state !== 'active') return 'ignored';
      if (item.author === this.me) key = this.host.identity.publicKey;
      else {
        const m = this.store.member(p.id, item.author);
        if (!m) throw this.refuse(403, 'member', 'The item is from someone who is not a member.');
        key = m.publicKey;
        // a friend of this hub too: the key the owner lists must be the one this hub knows
        const direct = this.peer.store.friendByFingerprint(item.author);
        if (direct && direct.status === 'active' && direct.publicKey !== key) throw this.refuse(409, 'key', "The owner lists another key for that member than this hub knows.");
      }
    }
    if (!verifyItem(item, key)) throw this.refuse(400, 'signature', "The item's signature does not check out against its author's key.");
    const prev = this.store.item(p.id, item.id);
    if (prev && prev.author !== item.author) throw this.refuse(409, 'author', 'Only its author edits an item.');
    if (prev) {
      if (item.version < prev.version) return 'stale';
      if (item.version === prev.version) {
        if (prev.item.sig === item.sig) return 'duplicate';
        // the same version twice from one author: the later one wins
        if (item.updatedAt <= prev.updatedAt) return 'stale';
      }
    } else if (this.store.items(p.id, { deleted: true }).length >= MAX_ITEMS) throw this.refuse(413, 'too-many', `A project keeps ${MAX_ITEMS} items at most.`);
    const row = this.keep(item);
    if (p.ownerFp === this.me) this.fanout(p, 'project.item', { projectId: p.id, item }, { except: [item.author], preview: `project ${item.kind}: ${p.name}` });
    if (!opts.quiet) {
      const dto = this.itemDto(this.store.get(p.id)!, row);
      this.emit(p.id, 'item', dto);
      if (!prev && !item.deleted && item.author !== this.me) {
        const what = item.kind === 'memory' ? 'shared a memory in' : item.kind === 'chat' ? `shared '${dto.title ?? 'a chat'}' in` : 'added a note to';
        this.peer.notify(`${dto.authorName} ${what} '${p.name}'`, item.kind === 'note' ? (dto.title ?? dto.text.replace(/\s+/g, ' ').slice(0, 160)) : 'Open the project to see it.', 'info', this.link(p.id));
      }
    }
    return 'applied';
  }

  /** The owner's side: a member accepted. They get the whole project; the others the new member list. */
  private joined(friend: Friend, projectId: string, b: Record<string, unknown>): unknown {
    const p = this.store.get(projectId);
    if (!p || p.ownerFp !== this.me) throw this.refuse(404, 'project', 'This hub owns no such project.');
    if (p.state !== 'active') throw this.refuse(409, 'ended', 'This project ended.');
    const m = this.store.member(p.id, friend.fingerprint);
    if (!m || (m.state !== 'invited' && m.state !== 'active')) throw this.refuse(403, 'not-invited', 'This hub did not invite you, or took the invite back.');
    const github = typeof b.github === 'string' && GITHUB_LOGIN.test(b.github) ? b.github : undefined;
    const fresh = m.state === 'invited';
    this.store.putMember({ ...m, state: 'active', publicKey: friend.publicKey, ...(github ? { github } : {}) });
    const next = fresh ? this.bumpMeta(p, [], [friend.fingerprint]) : p;
    if (fresh || !this.stateTooSoon(next, friend)) this.sendState(next, friend);
    if (fresh) {
      this.peer.audit(this.peer.friendActor(friend), 'project.join', `'${p.name}'`);
      this.peer.notify(`${friend.name} joined '${p.name}'`, 'They have the notes, memories and chats shared in it now.', 'success', this.link(p.id));
      this.emit(p.id, 'members');
    }
    this.track(this.chatShares(p.id));
    return { projectId };
  }

  /** The owner's side: a member declined or left. */
  private left(friend: Friend, projectId: string, b: Record<string, unknown>): unknown {
    const p = this.store.get(projectId);
    if (!p || p.ownerFp !== this.me) return { projectId, ignored: true };
    const m = this.store.member(p.id, friend.fingerprint);
    if (!m || m.role === 'owner' || m.state === 'removed' || m.state === 'left' || m.state === 'declined') return { projectId, ignored: true };
    const state: SharedMemberState = b.declined === true || m.state === 'invited' ? 'declined' : 'left';
    this.store.putMember({ ...m, state });
    if (p.state === 'active') this.bumpMeta(p);
    this.peer.audit(this.peer.friendActor(friend), state === 'declined' ? 'project.declined' : 'project.left', `'${p.name}'`);
    this.peer.notify(state === 'declined' ? `${friend.name} declined '${p.name}'` : `${friend.name} left '${p.name}'`, state === 'declined' ? 'Nothing of the project went to them.' : 'Their copy stays on their hub. Nothing more goes to them.', 'info', this.link(p.id));
    this.emit(p.id, 'members');
    return { projectId, state };
  }

  private syncAsked(friend: Friend, projectId: string): unknown {
    const p = this.store.get(projectId);
    if (!p || p.ownerFp !== this.me) throw this.refuse(404, 'project', 'This hub owns no such project.');
    const m = this.store.member(p.id, friend.fingerprint);
    if (!m || m.state !== 'active') throw this.refuse(403, 'member', 'You are not a member of this project.');
    if (this.stateTooSoon(p, friend)) return { projectId, ignored: true };
    this.sendState(p, friend);
    return { projectId };
  }

  /**
   * A friendship ended. A project this hub owns takes them out; one they
   * own is read only here now (left when this hub removed them, removed
   * when they removed this hub).
   */
  friendGone(f: Friend, by: 'us' | 'them'): void {
    for (const pid of this.store.projectsWith(f.fingerprint)) {
      const p = this.store.get(pid);
      if (!p) continue;
      if (p.ownerFp === this.me) {
        const m = this.store.member(pid, f.fingerprint);
        if (!m || (m.state !== 'active' && m.state !== 'invited')) continue;
        this.store.putMember({ ...m, state: 'removed' });
        if (p.state === 'active') this.bumpMeta(p);
        this.emit(pid, 'members');
      } else if (p.ownerFp === f.fingerprint && (p.state === 'active' || p.state === 'invited')) {
        this.store.update(pid, { state: by === 'us' ? 'left' : 'removed' });
        this.emit(pid, by === 'us' ? 'left' : 'removed');
      }
    }
  }
}
