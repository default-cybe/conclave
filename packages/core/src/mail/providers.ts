/**
 * The three ways the hub reaches mail, behind one interface: the Gmail API,
 * Microsoft Graph, and IMAP (with SMTP for sending). Each works with its own
 * message ids; the mail service turns them into short ids for the tools.
 */
import { addressParser, decodeWords } from 'postal-mime';
import { ImapClient, ImapError, imapDate, searchArg, str, type ImapOptions, type ImapValue } from './imap';
import { composeMessage, htmlText, parseMessage, snippet } from './mime';
import { sendMail, type SmtpOptions } from './smtp';
import type { MailAddress, MailQuery } from './types';

export interface ProviderSummary {
  ref: string;
  from?: MailAddress;
  to: MailAddress[];
  subject: string;
  date?: number;
  unread: boolean;
  snippet?: string;
  folder?: string;
  hasAttachments?: boolean;
}

export interface ProviderMessage extends ProviderSummary {
  cc: MailAddress[];
  text: string;
  messageId?: string;
  references?: string;
  threadRef?: string;
  attachments: Array<{ name: string; type: string; size?: number }>;
}

export interface Outgoing {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  body: string;
  reply?: { ref: string; messageId?: string; references?: string; threadRef?: string };
}

export interface MailProvider {
  search(q: MailQuery): Promise<ProviderSummary[]>;
  read(ref: string): Promise<ProviderMessage>;
  /** Save a draft; returns where it went, for the owner. */
  saveDraft(m: Outgoing): Promise<string>;
  send(m: Outgoing): Promise<string>;
  /** A one-line check that the account works ("Inbox: 1,204 messages"). */
  test(): Promise<string>;
}

export class MailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function addrList(header: string | undefined): MailAddress[] {
  if (!header) return [];
  try {
    const out: MailAddress[] = [];
    for (const a of addressParser(header) as Array<{ name: string; address?: string; group?: Array<{ name: string; address: string }> }>) {
      if (a.group) for (const g of a.group) out.push({ address: g.address, ...(g.name ? { name: decodeWords(g.name) } : {}) });
      else if (a.address) out.push({ address: a.address, ...(a.name ? { name: decodeWords(a.name) } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

/** "1 message", "1,204 messages". */
function count(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : `${word}s`}`;
}

function entities(s: string): string {
  return htmlText(s);
}

async function api<T>(f: typeof fetch, token: () => Promise<string>, url: string, init: RequestInit = {}, what = 'The mail provider'): Promise<T> {
  let res: Response;
  try {
    res = await f(url, { ...init, headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...((init.headers as Record<string, string>) ?? {}) }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new MailError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
      msg = (typeof j.error === 'object' ? j.error?.message : j.error_description ?? j.error) ?? msg;
    } catch {
      // keep the text
    }
    if (res.status === 401) throw new MailError(`${what} refused the sign-in. Sign in again in Settings.`, 401);
    if (res.status === 403) throw new MailError(`${what} says this sign-in may not do that (${msg}). It may need another permission: sign in again with drafts on.`, 403);
    throw new MailError(`${what} answered ${res.status}: ${msg}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------------------
// Gmail API
// ---------------------------------------------------------------------------

/** A Gmail search string from a query. */
export function gmailQuery(q: MailQuery): string {
  const parts: string[] = [];
  const quoteIf = (s: string) => (/\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
  if (q.from) parts.push(`from:${quoteIf(q.from)}`);
  if (q.to) parts.push(`to:${quoteIf(q.to)}`);
  if (q.subject) parts.push(`subject:(${q.subject.replace(/[()]/g, '')})`);
  // Gmail reads after:/before: as seconds since the epoch too, which avoids its date zone rules
  if (q.since) parts.push(`after:${Math.floor(q.since / 1000)}`);
  if (q.before) parts.push(`before:${Math.floor(q.before / 1000)}`);
  if (q.unread) parts.push('is:unread');
  const folder = (q.folder ?? 'inbox').toLowerCase();
  if (folder === 'inbox') parts.push('in:inbox');
  else if (folder === 'sent') parts.push('in:sent');
  else if (folder === 'drafts') parts.push('in:drafts');
  else if (folder === 'archive') parts.push('-in:inbox -in:sent -in:drafts');
  else if (folder !== 'all') parts.push(`label:${quoteIf(q.folder!)}`);
  if (q.text) parts.push(q.text);
  return parts.join(' ');
}

interface GmailMeta {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }>; parts?: Array<{ filename?: string }> };
  raw?: string;
}

export class GmailProvider implements MailProvider {
  constructor(
    private token: () => Promise<string>,
    private base = 'https://gmail.googleapis.com/gmail/v1/users/me',
    private f: typeof fetch = fetch,
  ) {}

  private get<T>(path: string, init?: RequestInit): Promise<T> {
    return api<T>(this.f, this.token, `${this.base}${path}`, init, 'Gmail');
  }

  async search(q: MailQuery): Promise<ProviderSummary[]> {
    const list = await this.get<{ messages?: Array<{ id: string }> }>(`/messages?${new URLSearchParams({ q: gmailQuery(q), maxResults: String(q.limit) })}`);
    const ids = (list.messages ?? []).slice(0, q.limit).map((m) => m.id);
    const metas = await Promise.allSettled(ids.map((id) => this.get<GmailMeta>(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
    // a message deleted between the list and its fetch answers 404: it is left out and the rest come back;
    // any other error (sign-in, quota, Gmail down) still fails the search with its own words
    const failed = metas.find((m): m is PromiseRejectedResult => m.status === 'rejected' && !(m.reason instanceof MailError && m.reason.status === 404));
    if (failed) throw failed.reason;
    return metas.flatMap((m) => (m.status === 'fulfilled' ? [this.summary(m.value)] : []));
  }

  private summary(m: GmailMeta): ProviderSummary {
    const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value;
    const from = addrList(h('from'))[0];
    const date = Number(m.internalDate);
    return {
      ref: m.id,
      ...(from ? { from } : {}),
      to: addrList(h('to')),
      subject: decodeWords(h('subject') ?? ''),
      ...(Number.isFinite(date) && date > 0 ? { date } : {}),
      unread: (m.labelIds ?? []).includes('UNREAD'),
      ...(m.snippet ? { snippet: entities(m.snippet) } : {}),
      folder: (m.labelIds ?? []).includes('INBOX') ? 'inbox' : (m.labelIds ?? []).includes('SENT') ? 'sent' : 'archive',
    };
  }

  async read(ref: string): Promise<ProviderMessage> {
    const m = await this.get<GmailMeta>(`/messages/${encodeURIComponent(ref)}?format=raw`);
    const raw = Buffer.from(m.raw ?? '', 'base64url');
    const p = await parseMessage(new Uint8Array(raw));
    const date = Number(m.internalDate);
    return {
      ref: m.id,
      ...(p.from ? { from: p.from } : {}),
      to: p.to,
      cc: p.cc,
      subject: p.subject,
      ...(p.date ?? (Number.isFinite(date) && date > 0 ? date : undefined) ? { date: p.date ?? date } : {}),
      unread: (m.labelIds ?? []).includes('UNREAD'),
      text: p.text,
      ...(p.messageId ? { messageId: p.messageId } : {}),
      ...(p.references ? { references: p.references } : {}),
      ...(m.threadId ? { threadRef: m.threadId } : {}),
      attachments: p.attachments,
      hasAttachments: p.attachments.length > 0,
    };
  }

  private raw(m: Outgoing): string {
    const { raw } = composeMessage({ from: m.from, to: m.to, cc: m.cc, subject: m.subject, body: m.body, inReplyTo: m.reply?.messageId, references: m.reply?.references });
    return Buffer.from(raw, 'utf8').toString('base64url');
  }

  async saveDraft(m: Outgoing): Promise<string> {
    const r = await this.get<{ id: string }>('/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: this.raw(m), ...(m.reply?.threadRef ? { threadId: m.reply.threadRef } : {}) } }) });
    return `Gmail drafts (draft ${r.id})`;
  }

  async send(m: Outgoing): Promise<string> {
    const r = await this.get<{ id: string }>('/messages/send', { method: 'POST', body: JSON.stringify({ raw: this.raw(m), ...(m.reply?.threadRef ? { threadId: m.reply.threadRef } : {}) }) });
    return `sent through Gmail (message ${r.id})`;
  }

  async test(): Promise<string> {
    const p = await this.get<{ emailAddress?: string; messagesTotal?: number }>('/profile');
    return `Signed in as ${p.emailAddress ?? 'this account'}, ${count(p.messagesTotal ?? 0, 'message')}.`;
  }

  /** The signed-in address. */
  async address(): Promise<string | undefined> {
    return (await this.get<{ emailAddress?: string }>('/profile')).emailAddress;
  }
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  bodyPreview?: string;
  hasAttachments?: boolean;
  conversationId?: string;
  internetMessageId?: string;
  body?: { contentType?: string; content?: string };
}

const GRAPH_SELECT = 'id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,conversationId';

function graphAddr(r: GraphRecipient | undefined): MailAddress | undefined {
  const a = r?.emailAddress?.address;
  if (!a) return undefined;
  return { address: a, ...(r?.emailAddress?.name && r.emailAddress.name !== a ? { name: r.emailAddress.name } : {}) };
}

const GRAPH_FOLDERS: Record<string, string> = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', archive: 'archive' };

/** KQL for Graph $search. */
export function graphSearch(q: MailQuery): string | undefined {
  const parts: string[] = [];
  const clean = (s: string) => s.replace(/["\\]/g, ' ').trim();
  if (q.from) parts.push(`from:${clean(q.from)}`);
  if (q.to) parts.push(`to:${clean(q.to)}`);
  if (q.subject) parts.push(`subject:${clean(q.subject)}`);
  if (q.text) parts.push(clean(q.text));
  return parts.length ? `"${parts.join(' ')}"` : undefined;
}

export class GraphProvider implements MailProvider {
  constructor(
    private token: () => Promise<string>,
    private base = 'https://graph.microsoft.com/v1.0',
    private f: typeof fetch = fetch,
  ) {}

  private call<T>(path: string, init?: RequestInit): Promise<T> {
    return api<T>(this.f, this.token, `${this.base}${path}`, init, 'Microsoft');
  }

  private async folderPath(folder: string | undefined): Promise<string> {
    const f = (folder ?? 'inbox').toLowerCase();
    if (f === 'all') return '/me/messages';
    if (GRAPH_FOLDERS[f]) return `/me/mailFolders/${GRAPH_FOLDERS[f]}/messages`;
    const found = await this.call<{ value?: Array<{ id: string }> }>(`/me/mailFolders?${new URLSearchParams({ $filter: `displayName eq '${folder!.replace(/'/g, "''")}'`, $select: 'id' })}`);
    const id = found.value?.[0]?.id;
    if (!id) throw new MailError(`There is no folder named ${folder}.`);
    return `/me/mailFolders/${encodeURIComponent(id)}/messages`;
  }

  async search(q: MailQuery): Promise<ProviderSummary[]> {
    const path = await this.folderPath(q.folder);
    const kql = graphSearch(q);
    const params = new URLSearchParams({ $select: GRAPH_SELECT, $top: String(kql ? Math.min(50, q.limit * 3) : q.limit) });
    if (kql) params.set('$search', kql);
    else {
      const filters: string[] = [];
      if (q.since) filters.push(`receivedDateTime ge ${new Date(q.since).toISOString()}`);
      if (q.before) filters.push(`receivedDateTime lt ${new Date(q.before).toISOString()}`);
      if (q.unread) filters.push('isRead eq false');
      if (filters.length) params.set('$filter', filters.join(' and '));
      params.set('$orderby', 'receivedDateTime desc');
    }
    const r = await this.call<{ value?: GraphMessage[] }>(`${path}?${params}`);
    let list = r.value ?? [];
    // $search cannot be combined with these, so they apply here
    if (kql) list = list.filter((m) => {
      const t = Date.parse(m.receivedDateTime ?? '');
      return (!q.since || t >= q.since) && (!q.before || t < q.before) && (!q.unread || m.isRead === false);
    });
    return list.slice(0, q.limit).map((m) => this.summary(m, q.folder));
  }

  private summary(m: GraphMessage, folder?: string): ProviderSummary {
    const from = graphAddr(m.from);
    const date = Date.parse(m.receivedDateTime ?? '');
    return {
      ref: m.id,
      ...(from ? { from } : {}),
      to: (m.toRecipients ?? []).map(graphAddr).filter((a): a is MailAddress => !!a),
      subject: m.subject ?? '',
      ...(Number.isFinite(date) ? { date } : {}),
      unread: m.isRead === false,
      ...(m.bodyPreview ? { snippet: snippet(m.bodyPreview) } : {}),
      ...(folder ? { folder: folder.toLowerCase() } : {}),
      ...(m.hasAttachments ? { hasAttachments: true } : {}),
    };
  }

  async read(ref: string): Promise<ProviderMessage> {
    const m = await this.call<GraphMessage>(`/me/messages/${encodeURIComponent(ref)}?$select=${GRAPH_SELECT},ccRecipients,internetMessageId,body`, { headers: { prefer: 'outlook.body-content-type="text"' } });
    const atts = m.hasAttachments ? ((await this.call<{ value?: Array<{ name?: string; contentType?: string; size?: number }> }>(`/me/messages/${encodeURIComponent(ref)}/attachments?$select=name,contentType,size`)).value ?? []) : [];
    const body = m.body?.content ?? '';
    return {
      ...this.summary(m),
      cc: (m.ccRecipients ?? []).map(graphAddr).filter((a): a is MailAddress => !!a),
      text: m.body?.contentType?.toLowerCase() === 'html' ? htmlText(body) : body.trim(),
      ...(m.internetMessageId ? { messageId: m.internetMessageId } : {}),
      ...(m.conversationId ? { threadRef: m.conversationId } : {}),
      attachments: atts.map((a) => ({ name: a.name ?? '(no name)', type: a.contentType ?? 'application/octet-stream', ...(a.size ? { size: a.size } : {}) })),
    };
  }

  private async draft(m: Outgoing): Promise<string> {
    const rcpt = (list: MailAddress[]) => list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));
    if (m.reply) {
      const d = await this.call<{ id: string }>(`/me/messages/${encodeURIComponent(m.reply.ref)}/createReply`, { method: 'POST', body: JSON.stringify({ message: { toRecipients: rcpt(m.to), ccRecipients: rcpt(m.cc) }, comment: m.body }) });
      return d.id;
    }
    const d = await this.call<{ id: string }>('/me/messages', { method: 'POST', body: JSON.stringify({ subject: m.subject, body: { contentType: 'Text', content: m.body }, toRecipients: rcpt(m.to), ccRecipients: rcpt(m.cc) }) });
    return d.id;
  }

  async saveDraft(m: Outgoing): Promise<string> {
    await this.draft(m);
    return 'the Outlook Drafts folder';
  }

  async send(m: Outgoing): Promise<string> {
    const id = await this.draft(m);
    await this.call(`/me/messages/${encodeURIComponent(id)}/send`, { method: 'POST' });
    return 'sent through Outlook';
  }

  async test(): Promise<string> {
    const me = await this.call<{ mail?: string; userPrincipalName?: string }>('/me?$select=mail,userPrincipalName');
    const inbox = await this.call<{ totalItemCount?: number }>('/me/mailFolders/inbox?$select=totalItemCount');
    return `Signed in as ${me.mail ?? me.userPrincipalName ?? 'this account'}, inbox ${count(inbox.totalItemCount ?? 0, 'message')}.`;
  }

  async address(): Promise<string | undefined> {
    const me = await this.call<{ mail?: string; userPrincipalName?: string }>('/me?$select=mail,userPrincipalName');
    return me.mail ?? me.userPrincipalName;
  }
}

// ---------------------------------------------------------------------------
// IMAP and SMTP
// ---------------------------------------------------------------------------

export interface ImapProviderOptions extends ImapOptions {
  /** The account's own address, the From of drafts. */
  address: string;
  /** Folder for drafts when the server marks none with \Drafts. */
  drafts?: string;
  smtp?: SmtpOptions;
}

const SPECIAL: Record<string, string> = { sent: '\\SENT', drafts: '\\DRAFTS', archive: '\\ARCHIVE', all: '\\ALL', trash: '\\TRASH', junk: '\\JUNK' };

/** How much of a message a list reads: headers and the start of the text. */
const PEEK_BYTES = 8_000;
/** Most of one message read: enough for any text, not every attachment. */
const READ_BYTES = 3_000_000;

export class ImapProvider implements MailProvider {
  constructor(private o: ImapProviderOptions) {}

  private async with<T>(fn: (c: ImapClient) => Promise<T>): Promise<T> {
    const c = await ImapClient.connect(this.o);
    try {
      return await fn(c);
    } finally {
      await c.logout();
    }
  }

  private async folder(c: ImapClient, name: string | undefined): Promise<string> {
    const f = (name ?? 'inbox').toLowerCase();
    if (f === 'inbox') return 'INBOX';
    const list = await c.list();
    const special = SPECIAL[f];
    if (special) {
      const hit = list.find((x) => x.flags.some((fl) => fl.toUpperCase() === special));
      if (hit) return hit.name;
      if (f === 'drafts' && this.o.drafts) return this.o.drafts;
    }
    const byName = list.find((x) => x.display.toLowerCase() === f || x.display.toLowerCase().endsWith(`/${f}`) || x.name.toLowerCase() === f);
    if (byName) return byName.name;
    if (f === 'drafts') return this.o.drafts ?? 'Drafts';
    throw new MailError(`There is no folder named ${name}.`);
  }

  private criteria(q: MailQuery): { text: string; literals: Uint8Array[] } {
    const parts: string[] = [];
    const literals: Uint8Array[] = [];
    const arg = (key: string, v: string) => {
      const a = searchArg(v);
      parts.push(`${key} ${a.text}`);
      if (a.literal) literals.push(a.literal);
    };
    if (q.from) arg('FROM', q.from);
    if (q.to) arg('TO', q.to);
    if (q.subject) arg('SUBJECT', q.subject);
    if (q.text) arg('TEXT', q.text);
    if (q.since) parts.push(`SINCE ${imapDate(q.since)}`);
    if (q.before) parts.push(`BEFORE ${imapDate(q.before)}`);
    if (q.unread) parts.push('UNSEEN');
    return { text: parts.length ? parts.join(' ') : 'ALL', literals };
  }

  async search(q: MailQuery): Promise<ProviderSummary[]> {
    return this.with(async (c) => {
      const folder = await this.folder(c, q.folder);
      const box = await c.examine(folder);
      const crit = this.criteria(q);
      const uids = (await c.search(crit.text, crit.literals)).slice(-q.limit).reverse();
      const rows = await c.fetch(uids, `(UID FLAGS INTERNALDATE BODY.PEEK[]<0.${PEEK_BYTES}>)`);
      const byUid = new Map(rows.map((r) => [Number(str(r.UID)), r]));
      const out: ProviderSummary[] = [];
      for (const uid of uids) {
        const r = byUid.get(uid);
        if (!r) continue;
        out.push(await this.summary(folder, box.uidValidity, uid, r, q.folder));
      }
      return out;
    });
  }

  private async summary(folder: string, uidValidity: string, uid: number, r: Record<string, ImapValue>, label?: string): Promise<ProviderSummary> {
    const body = Object.entries(r).find(([k]) => k.startsWith('BODY['))?.[1];
    const p = await parseMessage(body instanceof Uint8Array ? body : str(body));
    const flags = Array.isArray(r.FLAGS) ? r.FLAGS.map((f) => str(f).toUpperCase()) : [];
    const internal = Date.parse(str(r.INTERNALDATE));
    const date = p.date ?? (Number.isFinite(internal) ? internal : undefined);
    return {
      ref: `${folder}\n${uidValidity}\n${uid}`,
      ...(p.from ? { from: p.from } : {}),
      to: p.to,
      subject: p.subject,
      ...(date !== undefined ? { date } : {}),
      unread: !flags.includes('\\SEEN'),
      ...(p.text ? { snippet: snippet(p.text) } : {}),
      folder: (label ?? 'inbox').toLowerCase(),
    };
  }

  async read(ref: string): Promise<ProviderMessage> {
    const [folder, validity, uidText] = ref.split('\n');
    const uid = Number(uidText);
    if (!folder || !Number.isFinite(uid)) throw new MailError('That message id is not one of this account.');
    return this.with(async (c) => {
      const box = await c.examine(folder);
      if (validity && box.uidValidity && validity !== box.uidValidity) throw new MailError('The folder was rebuilt on the server since the search. Search again.');
      const [r] = await c.fetch([uid], `(UID FLAGS INTERNALDATE BODY.PEEK[]<0.${READ_BYTES}>)`);
      if (!r) throw new MailError('That message is gone from the server.');
      const body = Object.entries(r).find(([k]) => k.startsWith('BODY['))?.[1];
      const p = await parseMessage(body instanceof Uint8Array ? body : str(body));
      const flags = Array.isArray(r.FLAGS) ? r.FLAGS.map((f) => str(f).toUpperCase()) : [];
      return {
        ref,
        ...(p.from ? { from: p.from } : {}),
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        ...(p.date !== undefined ? { date: p.date } : {}),
        unread: !flags.includes('\\SEEN'),
        text: p.text,
        ...(p.messageId ? { messageId: p.messageId } : {}),
        ...(p.references ? { references: p.references } : {}),
        attachments: p.attachments,
        hasAttachments: p.attachments.length > 0,
      };
    });
  }

  private raw(m: Outgoing): string {
    return composeMessage({ from: m.from, to: m.to, cc: m.cc, subject: m.subject, body: m.body, inReplyTo: m.reply?.messageId, references: m.reply?.references }).raw;
  }

  async saveDraft(m: Outgoing): Promise<string> {
    return this.with(async (c) => {
      const folder = await this.folder(c, 'drafts');
      await c.append(folder, ['\\Draft', '\\Seen'], this.raw(m));
      return `the ${folder} folder`;
    });
  }

  async send(m: Outgoing): Promise<string> {
    if (!this.o.smtp) throw new MailError('Sending is off for this account. Turn it on in Settings > Calendar and mail, or save a draft.');
    await sendMail(this.o.smtp, m.from.address, [...m.to, ...m.cc].map((a) => a.address), this.raw(m));
    return `sent through ${this.o.smtp.host}`;
  }

  async test(): Promise<string> {
    try {
      return await this.with(async (c) => {
        const box = await c.examine('INBOX');
        return `Inbox: ${count(box.exists, 'message')}.`;
      });
    } catch (err) {
      if (err instanceof ImapError && err.kind === 'auth') throw new MailError(`${err.message} Check the user name and the app password.`);
      throw err;
    }
  }
}
