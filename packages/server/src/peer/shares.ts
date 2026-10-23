/**
 * Shares between friends (docs/design/FRIENDS.md, phases 2 and 3).
 *
 * Sending. The review (preview) runs the sanitizer over the session and its
 * subagents in the chosen range and lists each value it found, so the owner
 * can keep one anyway; with code, the session's diff (or, when asked, a git
 * bundle of its branch) comes from the session's device without untracked
 * or credential files (core session/share-code.ts). Send signs it all as one
 * bundle with the hub key, seals it for each friend's subkey as a content
 * addressed blob, and queues a small share.offer through the outbox. Update
 * sends a new revision of the same share; unsend withdraws the blobs and
 * queues share.revoke, which asks the friend's hub to delete its copy.
 *
 * Receiving. A share.offer is an Inbox card ("Alice sent 'Fix flaky auth
 * test' (session, 42 messages, diff 12 files)"); nothing is fetched until
 * the owner accepts. Accept fetches the blob, opens it, checks the bundle's
 * signature against the friend's fingerprint and its shape, keeps it, and
 * answers share.ack. An offer not accepted in 30 days expires. An unsend
 * that comes before its offer is remembered, and the offer dropped. From an
 * accepted share the owner can view it (quoted data), fork it, hand it off
 * to a fresh session, keep it as a reference, or put its code on a new
 * branch through a plan they approve (core session/friend-share.ts).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type {
  ApplyShareInput,
  ApplySharePlan,
  ApplyShareResult,
  ForkShareInput,
  HandoffDraft,
  HandoffShareInput,
  ReceivedShareDto,
  SendShareInput,
  SentShareDto,
  SentShareState,
  ShareCodeMode,
  ShareContentOptions,
  ShareCodePreview,
  SharePreview,
  SharePreviewInput,
  ShareSummary,
  ShareViewDto,
  UpdateShareInput,
} from '@conclave/core/client/friends.ts';
import type { BundleCode, BundleShareInfo, ConclaveBundle, ToolOutputMode } from '@conclave/core/client/share.ts';
import { formatFingerprint } from '@conclave/core/client/index.ts';
import { RedactionLog, Redactor, addReport, collectBundle, redactOptionsFor, signBundle, verifyBundle, type BundleSigner, type CollectedBundle } from '@conclave/core/session/share.ts';
import { CodeError, applyCode, collectDiff, collectGitBundle, friendBranch, planApply, type ApplyPlan } from '@conclave/core/session/share-code.ts';
import { checkReceived, handoffBrief, hubOf, quotedMessages, sanitizeReceived, type FriendProvenance, type FriendShareMeta } from '@conclave/core/session/friend-share.ts';
import { defuseFrameworkTags } from '@conclave/core/session/untrusted.ts';
import type { Message, Session } from '@conclave/core/types.ts';
import { newId } from '@conclave/core/util/ids.ts';
import { logger } from '@conclave/core/util/log.ts';
import { HttpError } from '../http';
import { isSealedBox, open, seal, type SealContext, type Signer } from './crypto';
import type { PeerService } from './service';
import { ShareStore, type InShare, type OutShare, type ShareSend } from './share-store';
import type { Friend } from './store';
import { ULID, ulid } from './ulid';

const log = logger('peer.shares');

/** An offer not accepted in this long expires. */
export const SHARE_TTL_MS = 30 * 86_400_000;
/**
 * A share a friend unsent before its offer came here is remembered this
 * long, so the offer is dropped when it comes later (the outbox gives up
 * after 7 days), and at most this many per friend.
 */
export const UNSENT_KEEP_MS = 30 * 86_400_000;
export const UNSENT_MAX = 1000;
/** Largest sealed payload: a share is 100 MB at most (FRIENDS.md 2). */
export const SHARE_MAX_BYTES = 100 * 1024 * 1024;
const TITLE_MAX = 200;
const NOTE_MAX = 2000;
const BRIEF_MAX = 20_000;
const MAX_RECIPIENTS = 20;
const PLAN_TTL_MS = 10 * 60_000;

export interface ShareHost {
  engine: EngineApi;
  identity: Signer & { bundleSigner(name?: string): BundleSigner };
  now: () => number;
  home: string;
}

/** A share's title or another line from outside: one line, at most `max` characters. */
function line(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || undefined;
}

function count(v: unknown, max = 10_000_000): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, max) : 0;
}

function short(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "(session, 42 messages, diff 12 files)". */
export function describeShare(kind: 'chat' | 'session', s: ShareSummary): string {
  const code = s.code ? `, ${s.code.kind === 'diff' ? 'diff' : 'git bundle'} ${plural(s.code.files, 'file')}` : '';
  return `(${kind}, ${plural(s.messages, 'message')}${code})`;
}

/** What binds a sealed payload to its share and revision, and to both hubs. */
function payloadContext(from: string, to: string, shareId: string, revision: number): SealContext {
  return { from, to, id: `${shareId}.${revision}`, type: 'share.payload' };
}

interface Plan {
  id: string;
  shareRow: string;
  device: string;
  plan: ApplyPlan;
  expiresAt: number;
}

export class ShareService {
  readonly store: ShareStore;
  private readonly dirOut: string;
  private readonly dirIn: string;
  private plans = new Map<string, Plan>();

  constructor(
    private readonly peer: PeerService,
    private readonly host: ShareHost,
  ) {
    this.store = new ShareStore(host.engine.repos.db, host.now);
    this.dirOut = join(host.home, 'peer', 'shares', 'out');
    this.dirIn = join(host.home, 'peer', 'shares', 'in');
  }

  private get engine(): EngineApi {
    return this.host.engine;
  }

  private now(): number {
    return this.host.now();
  }

  private writeFile(dir: string, name: string, data: string): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    writeFileSync(path, data, { mode: 0o600 });
    return path;
  }

  // -------------------------------------------------------------------------
  // DTOs
  // -------------------------------------------------------------------------

  private sendState(s: ShareSend): { state: SentShareState; lastError?: string } {
    if (s.state === 'revoked' || s.state === 'expired' || s.state === 'accepted') return { state: s.state };
    const item = s.msgId ? this.peer.store.outboxItem(s.msgId) : undefined;
    if (!item) return { state: 'sent' };
    if (item.state === 'delivered') return { state: 'delivered' };
    if (item.state === 'queued') return { state: 'sent', ...(item.lastError ? { lastError: item.lastError } : {}) };
    return { state: 'failed', lastError: item.lastError ?? `The offer was ${item.state}.` };
  }

  sentDto(s: OutShare): SentShareDto {
    const names = new Map(this.peer.store.friends({ removed: true }).map((f) => [f.id, f.name]));
    return {
      id: s.id,
      sessionId: s.sessionId,
      kind: s.kind,
      title: s.title,
      ...(s.note ? { note: s.note } : {}),
      revision: s.revision,
      state: s.state,
      options: s.options,
      summary: s.summary,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      recipients: this.store.sends(s.id).map((r) => ({
        friendId: r.friendId,
        friendName: names.get(r.friendId) ?? 'a friend',
        ...this.sendState(r),
        revision: r.revision,
        ...(r.acceptedRevision ? { acceptedRevision: r.acceptedRevision } : {}),
        ...(r.acceptedAt ? { acceptedAt: r.acceptedAt } : {}),
      })),
    };
  }

  receivedDto(r: InShare, friendName?: string): ReceivedShareDto {
    const name = friendName ?? this.peer.store.friend(r.friendId)?.name ?? 'A friend';
    const waiting = r.state === 'offered' || (r.state === 'accepted' && (r.acceptedRevision ?? 0) < r.revision);
    return {
      id: r.id,
      shareId: r.shareId,
      friendId: r.friendId,
      friendName: name,
      fingerprint: r.fingerprint,
      kind: r.kind,
      title: r.title,
      ...(r.note ? { note: r.note } : {}),
      revision: r.revision,
      ...(r.acceptedRevision ? { acceptedRevision: r.acceptedRevision } : {}),
      updateWaiting: r.state === 'accepted' && (r.acceptedRevision ?? 0) < r.revision,
      summary: r.summary,
      line: `${name} sent '${r.title}' ${describeShare(r.kind, r.summary)}`,
      state: r.state,
      receivedAt: r.receivedAt,
      ...(r.state === 'offered' ? { expiresAt: r.expiresAt } : {}),
      ...(r.acceptedAt ? { acceptedAt: r.acceptedAt } : {}),
      ...(r.error ? { error: r.error } : {}),
      sessions: r.sessions,
      read: !waiting || r.updatedAt <= this.peer.readMark(r.friendId),
    };
  }

  private emitSent(id: string, change: 'sent' | 'updated' | 'accepted' | 'revoked' | 'failed'): void {
    const s = this.store.out(id);
    if (s) this.engine.bus.emit({ type: 'friend.share.sent', change, share: this.sentDto(s) });
  }

  private emitReceived(id: string, change: 'received' | 'updated' | 'accepted' | 'revoked' | 'expired'): void {
    const r = this.store.in(id);
    if (!r) return;
    this.engine.bus.emit({ type: 'friend.share', change, share: this.receivedDto(r) });
    // the friend's unread count moved; a message from their hub tells the apps itself (service.ts received)
    if (change === 'accepted' || change === 'expired') this.peer.emitFriend(r.friendId);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private session(id: string): Session {
    const s = this.engine.getSession(id);
    // friends are the owner's (docs/design/ACCOUNTS.md 7): only the owner's sessions go out
    if (!s || (s.accountId ?? 'owner') !== 'owner') throw new HttpError(404, `Unknown session ${id}`);
    if (s.parentId) throw new HttpError(400, 'Send the session that started this subagent; its subagents go with it.');
    if ((s.meta?.friendShare as FriendShareMeta | undefined)?.role === 'reference') throw new HttpError(409, 'This is a reference from a friend. It cannot be sent on.');
    return s;
  }

  /** The options with their defaults: no thinking, full tool output, attachments, a session's diff (a chat has no code). */
  private resolve(s: Session, o: ShareContentOptions): SharePreview['options'] {
    const code: ShareCodeMode = o.code ?? (s.kind === 'chat' ? 'none' : 'diff');
    if (!['none', 'diff', 'git-bundle'].includes(code)) throw new HttpError(400, 'code must be none, diff or git-bundle');
    const toolOutput: ToolOutputMode = o.toolOutput ?? 'full';
    if (!['full', 'summary', 'none'].includes(toolOutput)) throw new HttpError(400, 'toolOutput must be full, summary or none');
    if (s.kind === 'chat' && code !== 'none') throw new HttpError(400, 'A chat has no folder, so it has no code to send.');
    return {
      thinking: !!o.thinking,
      toolOutput,
      attachments: o.attachments !== false,
      code,
      ...(o.upTo ? { upTo: o.upTo } : {}),
      ...(o.keep?.length ? { keep: [...new Set(o.keep)].slice(0, 2000) } : {}),
    };
  }

  /** The session's code from its device, the diff through the text rules (into the same log). */
  private async code(s: Session, mode: ShareCodeMode, logOf: RedactionLog, c: CollectedBundle): Promise<BundleCode | undefined> {
    if (mode === 'none') return undefined;
    const machine = this.engine.devices.get(s.device);
    if (!machine || !this.engine.devices.isOnline(s.device)) {
      const name = this.engine.devices.list().find((d) => d.id === s.device)?.name ?? s.device;
      throw new CodeError(`${name}, the device with the session's folder, is offline.`);
    }
    const code = mode === 'diff' ? await collectDiff(machine, s.cwd) : await collectGitBundle(machine, s.cwd);
    if (code.kind === 'diff' && code.diff) {
      const red = new Redactor({ ...redactOptionsFor(this.engine, s, {}), log: logOf });
      code.diff = red.text(code.diff);
      addReport(c.report, red.report);
    }
    return code;
  }

  /** Collect, sanitize and (for a send) sign what a share carries. */
  private async build(sessionId: string, input: ShareContentOptions, share?: Omit<BundleShareInfo, 'upTo'>) {
    const s = this.session(sessionId);
    const options = this.resolve(s, input);
    const logOf = new RedactionLog(options.keep ?? []);
    let c: CollectedBundle;
    try {
      c = collectBundle(this.engine, s.id, { thinking: options.thinking, toolOutput: options.toolOutput, attachments: options.attachments, code: options.code !== 'none', ...(options.upTo ? { upTo: options.upTo } : {}), log: logOf });
    } catch (err) {
      throw new HttpError((err as { status?: number }).status ?? 400, short(err));
    }
    let code: BundleCode | undefined;
    let codeError: string | undefined;
    try {
      code = await this.code(s, options.code, logOf, c);
    } catch (err) {
      codeError = short(err);
    }
    const warnings: string[] = [];
    if (options.thinking) warnings.push('Thinking text goes, without its signatures.');
    if (code?.kind === 'git-bundle') warnings.push('A git bundle carries the commits as they are: the sanitizer cannot read inside them. Changes not committed are not in it.');
    if (code?.excluded.length) warnings.push(`${plural(code.excluded.length, 'file')} ${code.excluded.length === 1 ? 'stays' : 'stay'} home: ${code.excluded.slice(0, 5).map((e) => `${e.path} (${e.reason})`).join(', ')}${code.excluded.length > 5 ? ', ...' : ''}.`);
    if (s.status === 'running' || s.status === 'waiting_approval') warnings.push('The session is still running: what goes is what it has now.');
    const items = logOf.list();
    let bundle: ConclaveBundle | undefined;
    let json: string | undefined;
    if (share) {
      if (codeError) throw new HttpError(409, `The code could not be read: ${codeError} Send without code, or try again.`);
      bundle = signBundle(c, { signer: this.host.identity.bundleSigner(this.peer.ourName()), share: { ...share, ...(c.upTo ? { upTo: c.upTo.id } : {}) }, ...(code ? { attach: code } : {}) });
      json = JSON.stringify(bundle);
    }
    const bytes = json?.length ?? JSON.stringify(c.sessions).length + (code?.diff?.length ?? code?.data?.length ?? 0);
    // the sealed payload is base64url of the bundle: a third larger
    if (Math.ceil((bytes * 4) / 3) + 1024 > SHARE_MAX_BYTES) {
      const mb = Math.round(bytes / 1024 / 1024);
      if (share) throw new HttpError(413, `This share is about ${mb} MB; a share is ${SHARE_MAX_BYTES / 1024 / 1024} MB at most once sealed. Leave out attachments or tool output, or send a shorter range.`);
      warnings.push(`It is about ${mb} MB: too large to send. Leave out attachments or tool output, or send a shorter range.`);
    }
    const summary: ShareSummary = {
      messages: c.sessions[0]?.messages.length ?? 0,
      sessions: c.sessions.length,
      ...(code ? { code: { kind: code.kind, files: code.files.length } } : {}),
      bytes,
    };
    const codePreview: ShareCodePreview | undefined =
      options.code === 'none'
        ? undefined
        : codeError || !code
          ? { kind: options.code, error: codeError ?? 'no code' }
          : { kind: code.kind, files: code.files, excluded: code.excluded, bytes: code.diff?.length ?? Math.floor(((code.data?.length ?? 0) * 3) / 4), ...(code.branch ? { branch: code.branch } : {}) };
    const preview: SharePreview = {
      sessionId: s.id,
      kind: s.kind === 'chat' ? 'chat' : 'session',
      title: c.sessions[0]?.title ?? s.title,
      options,
      messages: summary.messages,
      total: c.total,
      sessions: c.sessions.length,
      report: c.report,
      items,
      ...(codePreview ? { code: codePreview } : {}),
      bytes,
      warnings,
    };
    return { session: s, options, preview, summary, bundle, json };
  }

  async preview(input: SharePreviewInput): Promise<SharePreview> {
    return (await this.build(input.sessionId, input)).preview;
  }

  /** Friends a share can go to: active, with a key to seal for. */
  private recipients(to: unknown): Friend[] {
    const list = Array.isArray(to) ? to : typeof to === 'string' ? [to] : [];
    if (!list.length) throw new HttpError(400, 'to: name at least one friend');
    if (list.length > MAX_RECIPIENTS) throw new HttpError(400, `A share goes to ${MAX_RECIPIENTS} friends at most.`);
    const out = new Map<string, Friend>();
    for (const who of list) {
      if (typeof who !== 'string') throw new HttpError(400, 'to: friend ids or fingerprints');
      const f = this.peer.require(who);
      if (f.status !== 'active') throw new HttpError(409, f.status === 'blocked' ? `${f.name}'s hub has a new key. Confirm it in Friends first.` : `You are not friends with ${f.name} now.`);
      if (!f.subkey) throw new HttpError(409, `This hub does not have ${f.name}'s key for sealing yet. Try Sync.`);
      out.set(f.id, f);
    }
    return [...out.values()];
  }

  /** Seal the payload for one friend, offer it as a blob, and queue the offer (or update). */
  private offerTo(share: OutShare, friend: Friend, json: string, type: 'share.offer' | 'share.update', actor: string): void {
    const box = seal(friend.subkey!, json, payloadContext(this.peer.fingerprint, friend.fingerprint, share.id, share.revision));
    const bytes = Buffer.from(JSON.stringify(box), 'utf8');
    if (bytes.length > SHARE_MAX_BYTES) throw new HttpError(413, `This share is ${Math.round(bytes.length / 1024 / 1024)} MB sealed; a share is ${SHARE_MAX_BYTES / 1024 / 1024} MB at most.`);
    const msgId = ulid(this.now());
    const sha256 = this.peer.offerBlob(friend, bytes, msgId);
    const prev = this.store.send(share.id, friend.id);
    if (prev?.blob && prev.blob !== sha256) this.peer.withdrawBlob(prev.blob, friend.id);
    // a message not delivered yet for this share is replaced by this one
    if (prev?.msgId) {
      const item = this.peer.store.outboxItem(prev.msgId);
      if (item?.state === 'queued') this.peer.store.updateOutbox(item.id, { state: 'cancelled' });
    }
    const body = {
      shareId: share.id,
      revision: share.revision,
      title: share.title,
      ...(share.note ? { note: share.note } : {}),
      kind: share.kind,
      summary: share.summary,
      payload: { sha256, size: bytes.length },
      sentAt: this.now(),
    };
    this.peer.queue(friend, type, body, { id: msgId, preview: `${type === 'share.offer' ? 'share' : 'share update'}: ${share.title}`, actor });
    this.store.putSend({
      shareId: share.id,
      friendId: friend.id,
      revision: share.revision,
      msgId,
      blob: sha256,
      state: prev?.state === 'accepted' && prev.acceptedRevision === share.revision ? 'accepted' : 'sent',
      ...(prev?.acceptedRevision ? { acceptedRevision: prev.acceptedRevision } : {}),
      ...(prev?.acceptedAt ? { acceptedAt: prev.acceptedAt } : {}),
      sentAt: this.now(),
    });
  }

  async send(input: SendShareInput, actor = 'owner'): Promise<SentShareDto> {
    const friends = this.recipients(input.to);
    const s = this.session(input.sessionId);
    // the session's own title goes through the text rules like the rest; a title the owner typed goes as typed
    const sanitized = () => new Redactor({ ...redactOptionsFor(this.engine, s, {}), log: new RedactionLog(input.keep ?? []) }).text(s.title);
    const title = line(input.title, TITLE_MAX) ?? line(sanitized(), TITLE_MAX) ?? 'Shared session';
    const note = text(input.note, NOTE_MAX);
    const id = ulid(this.now());
    const built = await this.build(s.id, input, { id, revision: 1, title, ...(note ? { note } : {}) });
    const payload = this.writeFile(this.dirOut, `${id}.json`, built.json!);
    const share = this.store.insertOut({
      id,
      sessionId: s.id,
      kind: built.preview.kind,
      title,
      ...(note ? { note } : {}),
      options: built.options,
      revision: 1,
      state: 'active',
      summary: built.summary,
      payload,
    });
    for (const f of friends) this.offerTo(share, f, built.json!, 'share.offer', actor);
    this.peer.audit(actor, 'friend.share.send', `'${title}' ${describeShare(share.kind, share.summary)} from session ${s.id} to ${friends.map((f) => `${f.name} (${f.fingerprint})`).join(', ')}; ${plural(built.preview.report.secrets, 'secret')} and ${plural(built.preview.report.paths, 'path')} taken out, ${built.preview.items.filter((i) => i.kept).length} kept anyway`);
    this.emitSent(id, 'sent');
    return this.sentDto(this.store.out(id)!);
  }

  private requireOut(id: string): OutShare {
    const s = this.store.out(id);
    if (!s) throw new HttpError(404, `unknown share ${id}`);
    return s;
  }

  sent(): SentShareDto[] {
    return this.store.outs().map((s) => this.sentDto(s));
  }

  sentOne(id: string): SentShareDto {
    return this.sentDto(this.requireOut(id));
  }

  /** A new revision from the session as it is now, to everyone it went to who has not had it unsent. */
  async update(id: string, input: UpdateShareInput, actor = 'owner'): Promise<SentShareDto> {
    const share = this.requireOut(id);
    if (share.state === 'revoked') throw new HttpError(409, 'This share was unsent.');
    const pick = <K extends keyof ShareContentOptions>(k: K) => (input[k] !== undefined ? input[k] : share.options[k]);
    const options: ShareContentOptions = { thinking: pick('thinking'), toolOutput: pick('toolOutput'), attachments: pick('attachments'), code: pick('code'), upTo: pick('upTo'), keep: pick('keep') };
    const title = line(input.title, TITLE_MAX) ?? share.title;
    const note = input.note !== undefined ? text(input.note, NOTE_MAX) : share.note;
    const revision = share.revision + 1;
    const built = await this.build(share.sessionId, options, { id: share.id, revision, title, ...(note ? { note } : {}) });
    const payload = this.writeFile(this.dirOut, `${share.id}.json`, built.json!);
    const next = this.store.updateOut(share.id, { revision, title, note: note ?? null, options: built.options, summary: built.summary, payload })!;
    let n = 0;
    for (const send of this.store.sends(share.id)) {
      if (send.state === 'revoked') continue;
      const f = this.peer.store.friend(send.friendId);
      if (f?.status !== 'active' || !f.subkey) continue;
      this.offerTo(next, f, built.json!, 'share.update', actor);
      n++;
    }
    this.peer.audit(actor, 'friend.share.update', `'${title}' revision ${revision} ${describeShare(next.kind, next.summary)} to ${plural(n, 'friend')}`);
    this.emitSent(share.id, 'updated');
    return this.sentDto(this.store.out(share.id)!);
  }

  /** Unsend: take the blobs back, stop what was not delivered, and ask each friend's hub to delete its copy. */
  unsend(id: string, actor = 'owner'): SentShareDto {
    const share = this.requireOut(id);
    if (share.state === 'revoked') return this.sentDto(share);
    const asked: string[] = [];
    for (const send of this.store.sends(share.id)) {
      if (send.state === 'revoked') continue;
      if (send.msgId) {
        const item = this.peer.store.outboxItem(send.msgId);
        if (item && (item.state === 'queued' || item.state === 'failed')) this.peer.store.updateOutbox(item.id, { state: 'cancelled' });
      }
      if (send.blob) this.peer.withdrawBlob(send.blob, send.friendId);
      const f = this.peer.store.friend(send.friendId);
      if (f?.status === 'active' && f.subkey) {
        this.peer.queue(f, 'share.revoke', { shareId: share.id }, { preview: `unsend: ${share.title}`, actor });
        asked.push(f.name);
      }
      this.store.putSend({ ...send, state: 'revoked' });
    }
    if (share.payload) rmSync(share.payload, { force: true });
    this.store.updateOut(share.id, { state: 'revoked', payload: null });
    this.peer.audit(actor, 'friend.share.unsend', `'${share.title}': ${asked.length ? `${asked.join(', ')} ${asked.length === 1 ? 'is' : 'are'} asked to delete their copy` : 'no friend to tell'}`);
    this.emitSent(share.id, 'revoked');
    return this.sentDto(this.store.out(share.id)!);
  }

  /** A friend's subkey changed: seal what they have not fetched yet again, as an update of the same revision. */
  resealFor(friend: Friend): number {
    if (!friend.subkey || friend.status !== 'active') return 0;
    let n = 0;
    for (const send of this.store.openSendsTo(friend.id)) {
      const share = this.store.out(send.shareId);
      if (!share || share.state !== 'active' || !share.payload || !existsSync(share.payload)) continue;
      try {
        this.offerTo(share, friend, readFileSync(share.payload, 'utf8'), 'share.update', 'hub');
        n++;
      } catch (err) {
        log.warn(`could not seal share ${share.id} again for ${friend.name}: ${short(err)}`);
      }
    }
    return n;
  }

  /**
   * Offer a share this hub sent to one more friend, at its current revision
   * (a member who joined a shared project later). False when the friend has
   * it already, it was unsent, or its payload is gone (30 days).
   */
  addRecipient(id: string, friend: Friend, actor = 'hub'): boolean {
    const share = this.store.out(id);
    if (!share || share.state !== 'active' || !share.payload || !existsSync(share.payload)) return false;
    if (friend.status !== 'active' || !friend.subkey) return false;
    const prev = this.store.send(share.id, friend.id);
    if (prev && prev.state !== 'expired') return false;
    this.offerTo(share, friend, readFileSync(share.payload, 'utf8'), 'share.offer', actor);
    this.peer.audit(actor, 'friend.share.send', `'${share.title}' revision ${share.revision} to ${friend.name} (${friend.fingerprint}) as well`);
    this.emitSent(share.id, 'updated');
    return true;
  }

  // -------------------------------------------------------------------------
  // Receiving: share.offer, update, revoke, and ack (for shares this hub sent)
  // -------------------------------------------------------------------------

  private refuse(message: string): Error {
    return this.peer.refusal(400, 'body', message);
  }

  /** A share message from a friend. Returns what the inbox keeps. Throws a PeerRefusal when the body is wrong. */
  receive(friend: Friend, type: string, b: Record<string, unknown>): unknown {
    const shareId = typeof b.shareId === 'string' && ULID.test(b.shareId) ? b.shareId : undefined;
    if (!shareId) throw this.refuse('A share message needs its shareId.');
    if (type === 'share.revoke') return this.revoked(friend, shareId);
    const revision = count(b.revision, 1_000_000);
    if (revision < 1) throw this.refuse('A share message needs its revision.');
    if (type === 'share.ack') return this.acked(friend, shareId, revision);
    return this.offered(friend, shareId, revision, b);
  }

  private offered(friend: Friend, shareId: string, revision: number, b: Record<string, unknown>): unknown {
    const title = line(b.title, TITLE_MAX);
    const kind: 'chat' | 'session' | undefined = b.kind === 'chat' ? 'chat' : b.kind === 'session' ? 'session' : undefined;
    const p = b.payload as { sha256?: unknown; size?: unknown } | undefined;
    const sha256 = typeof p?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(p.sha256) ? p.sha256 : undefined;
    const size = count(p?.size, SHARE_MAX_BYTES + 1);
    if (!title || !kind || !sha256 || size < 1) throw this.refuse('The offer needs a title, a kind and its payload.');
    if (size > SHARE_MAX_BYTES) throw this.peer.refusal(413, 'too-large', `A share is ${SHARE_MAX_BYTES / 1024 / 1024} MB at most.`);
    const note = text(b.note, NOTE_MAX);
    const s = (b.summary ?? {}) as Record<string, unknown>;
    const c = s.code as { kind?: unknown; files?: unknown } | undefined;
    const summary: ShareSummary = {
      messages: count(s.messages),
      sessions: count(s.sessions, 1000),
      ...(c && (c.kind === 'diff' || c.kind === 'git-bundle') ? { code: { kind: c.kind, files: count(c.files) } } : {}),
      bytes: count(s.bytes, SHARE_MAX_BYTES * 2),
    };
    const blob = { sha256, size };
    const now = this.now();
    const row = this.store.inByShare(friend.id, shareId);
    if (!row && this.store.unsentEarly(friend.id, shareId, now - UNSENT_KEEP_MS)) {
      // the unsend came first (the offer met a passing error on its way): no card for it
      this.peer.audit(this.peer.friendActor(friend), 'friend.share.revoked', `'${title}': ${friend.name} unsent it before the offer came; no card`);
      return { shareId, revision, ignored: true };
    }
    if (!row) {
      const created = this.store.insertIn({ id: newId('shr'), friendId: friend.id, shareId, fingerprint: friend.fingerprint, kind, title, ...(note ? { note } : {}), revision, summary, blob, state: 'offered', sessions: [], receivedAt: now, expiresAt: now + SHARE_TTL_MS });
      this.peer.audit(this.peer.friendActor(friend), 'friend.share.offered', `'${title}' ${describeShare(kind, summary)}, nothing fetched`);
      this.emitReceived(created.id, 'received');
      this.peer.notify(`${friend.name} sent '${title}'`, `${describeShare(kind, summary).slice(1, -1)}. Nothing is fetched until you accept it in Friends.`);
      return { shareId, revision };
    }
    // an unsent share stays unsent, and an older revision changes nothing
    if (row.state === 'revoked' || revision < row.revision) return { shareId, revision, ignored: true };
    const patch = { title, note: note ?? null, kind, summary, blob, revision, fingerprint: friend.fingerprint, error: null };
    if (revision === row.revision) {
      // the same revision sealed again for this hub's new key: only the payload moved
      this.store.updateIn(row.id, patch);
      return { shareId, revision };
    }
    const offered = row.state !== 'accepted' && row.state !== 'fetching';
    this.store.updateIn(row.id, { ...patch, ...(offered ? { state: 'offered' as const, expiresAt: now + SHARE_TTL_MS } : {}) });
    this.peer.audit(this.peer.friendActor(friend), 'friend.share.updated', `'${title}' revision ${revision}, nothing fetched`);
    this.emitReceived(row.id, 'updated');
    this.peer.notify(`${friend.name} updated '${title}'`, `Revision ${revision} ${describeShare(kind, summary)}. Accept it in Friends to fetch it.`);
    return { shareId, revision };
  }

  private revoked(friend: Friend, shareId: string): unknown {
    const row = this.store.inByShare(friend.id, shareId);
    if (!row) {
      // its offer has not come yet: remember the unsend, so the offer is dropped when it comes
      this.store.tombstone(friend.id, shareId, UNSENT_MAX);
      return { shareId, early: true };
    }
    if (row.state === 'revoked') return { shareId };
    if (row.payload) rmSync(row.payload, { force: true });
    // a reference is the friend's copy: it goes; a fork or handoff is the owner's own work and stays
    const kept: InShare['sessions'] = [];
    for (const s of row.sessions) {
      if (s.role === 'reference') void this.engine.deleteSession(s.id).catch((err) => log.warn(`could not delete reference ${s.id}: ${short(err)}`));
      else kept.push(s);
    }
    this.store.updateIn(row.id, { state: 'revoked', payload: null, sessions: kept });
    this.peer.audit(this.peer.friendActor(friend), 'friend.share.revoked', `'${row.title}': ${friend.name} unsent it; the copy here is deleted${kept.length ? `, ${plural(kept.length, 'fork')} kept` : ''}`);
    this.emitReceived(row.id, 'revoked');
    this.peer.notify(`${friend.name} unsent '${row.title}'`, `Their hub asked this one to delete its copy, and it did.${kept.length ? ' Forks and handoffs you made stay yours.' : ''}`);
    return { shareId };
  }

  private acked(friend: Friend, shareId: string, revision: number): unknown {
    const send = this.store.send(shareId, friend.id);
    const share = this.store.out(shareId);
    if (!send || !share || send.state === 'revoked' || revision > send.revision) return { shareId, revision };
    this.store.putSend({ ...send, state: revision === send.revision ? 'accepted' : send.state, acceptedRevision: revision, acceptedAt: this.now() });
    this.peer.audit(this.peer.friendActor(friend), 'friend.share.accepted', `'${share.title}' revision ${revision}`);
    this.emitSent(shareId, 'accepted');
    this.peer.notify(`${friend.name} accepted '${share.title}'`, `Their hub fetched revision ${revision}.`, 'success');
    return { shareId, revision };
  }

  // -------------------------------------------------------------------------
  // The owner's side of a received share
  // -------------------------------------------------------------------------

  private requireIn(id: string): InShare {
    const r = this.store.in(id);
    if (!r) throw new HttpError(404, `unknown share ${id}`);
    return r;
  }

  received(): ReceivedShareDto[] {
    const names = new Map(this.peer.store.friends({ removed: true }).map((f) => [f.id, f.name]));
    return this.store.ins().map((r) => this.receivedDto(r, names.get(r.friendId)));
  }

  receivedOne(id: string): ReceivedShareDto {
    return this.receivedDto(this.requireIn(id));
  }

  /** Fetch the share from the friend's hub, open it, check it, keep it, and tell their hub. */
  async accept(id: string, actor = 'owner'): Promise<ReceivedShareDto> {
    const row = this.requireIn(id);
    if (row.state === 'revoked') throw new HttpError(409, `${this.receivedDto(row).friendName} unsent this share.`);
    if (row.state === 'expired') throw new HttpError(409, 'This share expired: it was not accepted in 30 days. Ask for it again.');
    if (row.state === 'fetching') throw new HttpError(409, 'It is being fetched now.');
    if (row.state === 'accepted' && row.acceptedRevision === row.revision) return this.receivedDto(row);
    const friend = this.peer.store.friend(row.friendId);
    if (!friend || friend.status !== 'active') throw new HttpError(409, `You are not friends with ${friend?.name ?? 'them'} now.`);
    const back = row.state;
    this.store.updateIn(row.id, { state: 'fetching', error: null });
    try {
      const bytes = await this.peer.fetchOffered(friend.id, row.blob.sha256, row.blob.size);
      let box: unknown;
      try {
        box = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new HttpError(502, 'What came is not a sealed share.');
      }
      if (!isSealedBox(box)) throw new HttpError(502, 'What came is not a sealed share.');
      let plain: Buffer;
      try {
        plain = open(this.peer.subkey, box, payloadContext(row.fingerprint, this.peer.fingerprint, row.shareId, row.revision));
      } catch (err) {
        throw new HttpError(502, `The share does not open: ${short(err)}`);
      }
      let bundle: ConclaveBundle;
      try {
        bundle = JSON.parse(plain.toString('utf8')) as ConclaveBundle;
      } catch {
        throw new HttpError(502, 'The share is not JSON.');
      }
      // the key that offered it: the offer came in an envelope that key signed
      const check = verifyBundle(bundle, { fingerprint: row.fingerprint });
      if (!check.ok) throw new HttpError(502, `The share's signature does not check out against ${friend.name}'s key: ${check.reason}.`);
      if (bundle.share?.id !== row.shareId || bundle.share.revision !== row.revision) throw new HttpError(502, 'The share is not the one offered.');
      const shape = checkReceived(bundle);
      if (shape) throw new HttpError(502, `The share is malformed: ${shape}.`);
      // unsent while it was fetched: keep nothing
      if (this.store.in(row.id)?.state === 'revoked') throw new HttpError(409, `${friend.name} unsent this share while it was fetched.`);
      const payload = this.writeFile(this.dirIn, `${row.id}.json`, plain.toString('utf8'));
      this.store.updateIn(row.id, { state: 'accepted', acceptedRevision: row.revision, acceptedAt: this.now(), payload, error: null });
      this.peer.queue(friend, 'share.ack', { shareId: row.shareId, revision: row.revision }, { preview: `accepted share: ${row.title}`, actor });
      this.peer.audit(actor, 'friend.share.accept', `'${row.title}' revision ${row.revision} from ${friend.name} (${friend.fingerprint}), signature checked`);
      this.emitReceived(row.id, 'accepted');
      return this.receivedDto(this.store.in(row.id)!);
    } catch (err) {
      const msg = short(err);
      if (this.store.in(row.id)?.state !== 'revoked') this.store.updateIn(row.id, { state: back === 'accepted' ? 'accepted' : back === 'declined' ? 'declined' : 'offered', error: msg });
      throw err instanceof HttpError ? err : new HttpError(502, msg);
    }
  }

  decline(id: string, actor = 'owner'): ReceivedShareDto {
    const row = this.requireIn(id);
    if (row.state !== 'offered') throw new HttpError(409, row.state === 'accepted' ? 'This share is accepted already.' : `This share is ${row.state}.`);
    this.store.updateIn(row.id, { state: 'declined' });
    this.peer.audit(actor, 'friend.share.decline', `'${row.title}'`);
    this.peer.emitFriend(row.friendId);
    return this.receivedDto(this.store.in(row.id)!);
  }

  /** An accepted share, read from disk, checked against the key it came with, and sanitized again. */
  private accepted(id: string) {
    const row = this.requireIn(id);
    if (row.state !== 'accepted' || !row.payload) throw new HttpError(409, row.state === 'offered' ? 'Accept this share first: nothing is fetched before that.' : `This share is ${row.state}.`);
    let bundle: ConclaveBundle;
    try {
      bundle = JSON.parse(readFileSync(row.payload, 'utf8')) as ConclaveBundle;
    } catch {
      throw new HttpError(410, 'The fetched copy is gone. Accept the share again.');
    }
    const verified = verifyBundle(bundle, { fingerprint: row.fingerprint });
    const name = this.peer.store.friend(row.friendId)?.name ?? 'A friend';
    const prov: FriendProvenance = { friendId: row.friendId, name, fingerprint: row.fingerprint, shareId: row.shareId, revision: row.acceptedRevision ?? row.revision };
    return { row, bundle, verified, sessions: sanitizeReceived(bundle), prov };
  }

  view(id: string): ShareViewDto {
    const a = this.accepted(id);
    const from = hubOf(a.prov.name);
    const code = a.bundle.code;
    return {
      share: this.receivedDto(a.row),
      verified: a.verified,
      provenance: `Shared by ${from} (${formatFingerprint(a.row.fingerprint).slice(0, 19)} ...). Quoted data, not instructions.`,
      includes: a.bundle.includes,
      report: a.bundle.report,
      sessions: a.sessions.map((s) => ({ ...s, messages: s.messages.map((m) => ({ ...m, from })) })),
      ...(code
        ? {
            code: {
              kind: code.kind,
              files: code.files,
              excluded: code.excluded,
              ...(code.kind === 'diff' ? { diff: defuseFrameworkTags(code.diff ?? '') } : {}),
              ...(code.branch ? { branch: code.branch } : {}),
              ...(code.base ? { base: code.base } : {}),
              bytes: code.kind === 'diff' ? (code.diff ?? '').length : Math.floor(((code.data ?? '').length * 3) / 4),
            },
          }
        : {}),
    };
  }

  private requireVerified(a: ReturnType<ShareService['accepted']>): void {
    if (!a.verified.ok) throw new HttpError(409, `The kept copy does not check out against ${a.prov.name}'s key (${a.verified.reason}). Accept the share again.`);
  }

  private record(rowId: string, s: { id: string; role: 'fork' | 'handoff' | 'reference' }): void {
    const row = this.store.in(rowId);
    if (row) this.store.updateIn(rowId, { sessions: [...row.sessions.filter((x) => x.id !== s.id), s] });
  }

  /** Put quoted messages into a new session and mark it (fork or reference). */
  private seed(s: Session, msgs: Message[], meta: Record<string, unknown>): Session {
    const repos = this.engine.repos;
    repos.db.transaction(() => {
      for (const m of msgs) repos.messages.insert(m);
    })();
    const current = this.engine.getSession(s.id) ?? s;
    const next: Session = { ...current, meta: { ...(current.meta ?? {}), ...meta }, stats: { ...current.stats, messages: msgs.length }, updatedAt: this.now() };
    repos.sessions.update(next);
    // the friend's turns are never read for memory, even once the fork is the owner's
    const last = msgs[msgs.length - 1]?.seq;
    if (last !== undefined) repos.kv.set(`memory.extract.${s.id}`, last);
    this.engine.bus.emit({ type: 'session.updated', session: next });
    return next;
  }

  private agentInput(input: Omit<ForkShareInput, 'prompt' | 'kind'>) {
    const str = (v: unknown, k: string, max = 500) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${k} must be a string`);
      return v;
    };
    return { agent: str(input.agent, 'agent', 100), model: str(input.model, 'model', 200), device: str(input.device, 'device', 100), cwd: str(input.cwd, 'cwd', 4096) };
  }

  /** Continue as a fork: a new chat or session on this hub's models, the friend's turns quoted, the first turn guarded. */
  async fork(id: string, input: ForkShareInput = {}, actor = 'owner'): Promise<Session> {
    const a = this.accepted(id);
    this.requireVerified(a);
    const root = a.sessions.find((s) => !s.parentId) ?? a.sessions[0];
    const kind = input.kind ?? (root.kind === 'chat' ? 'chat' : 'agent');
    if (kind !== 'chat' && kind !== 'agent') throw new HttpError(400, 'kind must be chat or agent');
    const title = line(input.title, TITLE_MAX) ?? `${a.row.title} (from ${a.prov.name})`;
    const s = await this.engine.createSession({ kind, ...this.agentInput(input), title, tags: ['from-friend'] });
    const msgs = quotedMessages(root, a.prov, s.id, 1, () => newId('msg'));
    const meta: FriendShareMeta = { ...a.prov, role: 'fork', guard: true, turns: 0, importedThrough: msgs[msgs.length - 1]?.seq ?? 0 };
    this.seed(s, msgs, { untrusted: true, friendShare: meta });
    this.record(a.row.id, { id: s.id, role: 'fork' });
    this.peer.audit(actor, 'friend.share.fork', `'${a.row.title}' from ${a.prov.name} into ${s.id}, ${plural(msgs.length, 'quoted message')}, first turn guarded`);
    const prompt = text(input.prompt, BRIEF_MAX);
    if (prompt) await this.engine.send(s.id, { text: prompt });
    return this.engine.getSession(s.id)!;
  }

  handoffDraft(id: string): HandoffDraft {
    const a = this.accepted(id);
    this.requireVerified(a);
    const { brief, files } = handoffBrief({ sessions: a.sessions, ...(a.bundle.code ? { code: a.bundle.code } : {}) }, a.prov, { title: a.row.title, ...(a.row.note ? { note: a.row.note } : {}) });
    return { title: `${a.row.title} (handoff from ${a.prov.name})`, brief, files };
  }

  /** A fresh session that starts from the brief the owner edited. Its first turn is guarded too: the brief quotes the friend. */
  async handoff(id: string, input: HandoffShareInput, actor = 'owner'): Promise<Session> {
    const a = this.accepted(id);
    this.requireVerified(a);
    const brief = text(input.brief, BRIEF_MAX);
    if (!brief) throw new HttpError(400, 'brief is required');
    const title = line(input.title, TITLE_MAX) ?? `${a.row.title} (handoff from ${a.prov.name})`;
    const s = await this.engine.createSession({ kind: 'agent', ...this.agentInput(input), title, tags: ['from-friend'] });
    const meta: FriendShareMeta = { ...a.prov, role: 'handoff', guard: true, turns: 0, importedThrough: 0 };
    this.seed(s, [], { untrusted: true, friendShare: meta });
    this.record(a.row.id, { id: s.id, role: 'handoff' });
    this.peer.audit(actor, 'friend.share.handoff', `'${a.row.title}' from ${a.prov.name} into ${s.id}, first turn guarded`);
    await this.engine.send(s.id, { text: brief });
    return this.engine.getSession(s.id)!;
  }

  /** Keep the share as a read only reference this hub's agents can read like a past chat. */
  async reference(id: string, actor = 'owner'): Promise<Session> {
    const a = this.accepted(id);
    this.requireVerified(a);
    const have = a.row.sessions.find((s) => s.role === 'reference' && this.engine.getSession(s.id));
    if (have) return this.engine.getSession(have.id)!;
    const root = a.sessions.find((s) => !s.parentId) ?? a.sessions[0];
    const s = await this.engine.createSession({ kind: root.kind === 'chat' ? 'chat' : 'agent', title: `${a.row.title} (reference from ${a.prov.name})`, tags: ['from-friend', 'reference'] });
    const msgs = quotedMessages(root, a.prov, s.id, 1, () => newId('msg'));
    const meta: FriendShareMeta = { ...a.prov, role: 'reference', importedThrough: msgs[msgs.length - 1]?.seq ?? 0 };
    const next = this.seed(s, msgs, { friendShare: meta });
    this.record(a.row.id, { id: s.id, role: 'reference' });
    this.peer.audit(actor, 'friend.share.reference', `'${a.row.title}' from ${a.prov.name} kept as reference ${s.id}`);
    return next;
  }

  // -------------------------------------------------------------------------
  // Code: a plan, then the owner's approval
  // -------------------------------------------------------------------------

  private codeOf(a: ReturnType<ShareService['accepted']>): BundleCode {
    const code = a.bundle.code;
    if (!code) throw new HttpError(409, 'This share has no code.');
    return code;
  }

  private machine(device: unknown) {
    if (typeof device !== 'string' || !device) throw new HttpError(400, 'device is required');
    const m = this.engine.devices.get(device);
    const d = this.engine.devices.list().find((x) => x.id === device);
    if (!m || !d) throw new HttpError(404, `unknown device ${device}`);
    if (!this.engine.devices.isOnline(device)) throw new HttpError(409, `${d.name} is offline.`);
    return { machine: m, name: d.name };
  }

  /** Check where the code would land, without changing anything there. The plan waits 10 minutes for the owner's approval. */
  async planApply(id: string, input: ApplyShareInput): Promise<ApplySharePlan> {
    const a = this.accepted(id);
    this.requireVerified(a);
    const code = this.codeOf(a);
    const { machine, name } = this.machine(input.device);
    if (typeof input.cwd !== 'string' || !input.cwd.trim()) throw new HttpError(400, 'cwd is required: a folder in the repository');
    const want = line(input.branch, 200) ?? friendBranch(a.prov.name, a.row.title);
    let plan: ApplyPlan;
    try {
      plan = await planApply(machine, input.cwd, code, want);
    } catch (err) {
      throw new HttpError(409, short(err));
    }
    const now = this.now();
    for (const [k, p] of this.plans) if (p.expiresAt < now) this.plans.delete(k);
    const planId = newId('apl');
    this.plans.set(planId, { id: planId, shareRow: a.row.id, device: input.device, plan, expiresAt: now + PLAN_TTL_MS });
    return { planId, device: input.device, deviceName: name, kind: code.kind, root: plan.root, branch: plan.branch, ...(plan.base ? { base: plan.base } : {}), files: plan.files, runsCode: plan.runsCode, check: plan.check, expiresAt: now + PLAN_TTL_MS };
  }

  /** The owner approved the plan: the code lands on its new branch. Nothing from the share runs. */
  async apply(id: string, planId: unknown, actor = 'owner'): Promise<ApplyShareResult> {
    const p = typeof planId === 'string' ? this.plans.get(planId) : undefined;
    if (!p || p.shareRow !== id || p.expiresAt < this.now()) throw new HttpError(409, 'No such plan, or it expired (plans last 10 minutes). Make the plan again.');
    if (!p.plan.check.ok) throw new HttpError(409, `The plan's check failed: ${p.plan.check.error}`);
    const a = this.accepted(id);
    this.requireVerified(a);
    const code = this.codeOf(a);
    const { machine, name } = this.machine(p.device);
    let done: { branch: string; commit: string };
    try {
      done = await applyCode(machine, p.plan, code, {
        name: `${a.prov.name} (friend)`,
        email: `${a.prov.fingerprint}@friends.conclave.invalid`,
        message: `${a.row.title}\n\nShared by ${hubOf(a.prov.name)} (${a.prov.fingerprint}), revision ${a.prov.revision}.\nApplied by Conclave; nothing from the share ran.`,
      });
    } catch (err) {
      throw new HttpError(err instanceof CodeError ? 409 : 502, short(err));
    }
    this.plans.delete(p.id);
    this.peer.audit(actor, 'friend.share.apply', `'${a.row.title}' from ${a.prov.name}: ${code.kind} onto ${done.branch} (${done.commit.slice(0, 12)}) in ${p.plan.root} on ${name}`);
    return { device: p.device, root: p.plan.root, branch: done.branch, commit: done.commit };
  }

  // -------------------------------------------------------------------------
  // Start and expiry
  // -------------------------------------------------------------------------

  /** At start: an Accept the hub stopped in the middle of is undone, so the owner can accept again. */
  start(): void {
    for (const r of this.store.fetchingIns()) this.store.updateIn(r.id, { state: r.acceptedRevision ? 'accepted' : 'offered', error: 'The hub stopped while it fetched this. Accept it again.' });
  }

  /** Hourly (service.ts sweep): offers past 30 days expire on both sides, and old payload files and unsends go. */
  sweep(): void {
    const now = this.now();
    this.store.pruneTombstones(now - UNSENT_KEEP_MS);
    for (const r of this.store.expiredOffers(now)) {
      this.store.updateIn(r.id, { state: 'expired' });
      this.emitReceived(r.id, 'expired');
    }
    for (const s of this.store.staleSends(now - SHARE_TTL_MS)) this.store.putSend({ ...s, state: 'expired' });
    for (const s of this.store.oldPayloads(now - SHARE_TTL_MS)) {
      if (s.payload) rmSync(s.payload, { force: true });
      this.store.updateOut(s.id, { payload: null });
    }
  }
}
