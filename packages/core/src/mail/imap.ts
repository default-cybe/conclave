/**
 * A small IMAP4rev1 client (RFC 3501) for what the assistant needs: log in
 * with an app password, list folders, open one read-only (EXAMINE), search,
 * fetch messages without marking them read (BODY.PEEK), and APPEND a draft.
 * One connection per call, closed after. Written out here because the full
 * clients pull in a dozen packages for features this never uses.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { MailSecurity } from './types';

/** A parsed IMAP value: atom or quoted string, literal bytes, NIL, or a list. */
export type ImapValue = string | Uint8Array | null | ImapValue[];

export interface ImapOptions {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  password: string;
  timeoutMs?: number;
  /** Tests: accept a self-signed certificate. */
  rejectUnauthorized?: boolean;
  /** The address to dial for host, checked right before each connect, or throws (a member's server: people/net.ts resolvePublic). */
  dialAddress?: (host: string) => Promise<string>;
}

export class ImapError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'connect' | 'protocol' | 'no' = 'protocol',
  ) {
    super(message);
  }
}

interface Pending {
  tag: string;
  untagged: ImapValue[][];
  resolve: (r: { status: string; text: string; untagged: ImapValue[][] }) => void;
  reject: (e: Error) => void;
  onContinue?: () => void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** An IMAP string argument: quoted when plain ASCII, else a literal. */
function quote(s: string): { text: string; literal?: Uint8Array } {
  if (/^[\x20-\x7e]*$/.test(s) && s.length < 1000) return { text: `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` };
  const bytes = enc.encode(s);
  return { text: `{${bytes.length}}`, literal: bytes };
}

/** Modified UTF-7 for mailbox names (RFC 3501 5.1.3), decoding only. */
export function decodeMailbox(name: string): string {
  return name.replace(/&([^-]*)-/g, (_m, b: string) => {
    if (!b) return '&';
    const bytes = Buffer.from(b.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

/** Read one response line's values. Literals were already cut out and are passed in order. */
export function parseValues(line: string, literals: Uint8Array[]): ImapValue[] {
  let i = 0;
  let lit = 0;
  const top: ImapValue[] = [];
  const stack: ImapValue[][] = [top];
  const cur = () => stack[stack.length - 1];
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      i++;
      continue;
    }
    if (c === '(') {
      const list: ImapValue[] = [];
      cur().push(list);
      stack.push(list);
      i++;
      continue;
    }
    if (c === ')') {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++;
        s += line[i];
        i++;
      }
      i++;
      cur().push(s);
      continue;
    }
    if (c === '\u0000') {
      // a placeholder where a literal stood
      cur().push(literals[lit++] ?? new Uint8Array());
      i++;
      continue;
    }
    // an atom; a [section] inside it (BODY[HEADER.FIELDS (FROM)]) belongs to it
    let s = '';
    while (i < line.length && line[i] !== ' ' && line[i] !== ')' && line[i] !== '(') {
      if (line[i] === '[') {
        const end = line.indexOf(']', i);
        const stop = end === -1 ? line.length : end + 1;
        s += line.slice(i, stop);
        i = stop;
        continue;
      }
      s += line[i];
      i++;
    }
    cur().push(s.toUpperCase() === 'NIL' ? null : s);
  }
  return top;
}

export function str(v: ImapValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return dec.decode(v);
  return '';
}

export class ImapClient {
  private socket!: Socket | TLSSocket;
  private buf = Buffer.alloc(0);
  private seq = 0;
  private pending?: Pending;
  private greeting?: (line: string) => void;
  private closed = false;
  capabilities = new Set<string>();

  private constructor(private readonly o: ImapOptions) {}

  /** Connect and log in. */
  static async connect(o: ImapOptions): Promise<ImapClient> {
    const c = new ImapClient(o);
    try {
      await c.open();
    } catch (err) {
      // a refused login, a silent server or a failed STARTTLS: no caller holds this connection to close it
      c.closed = true;
      (c.socket as Socket | TLSSocket | undefined)?.destroy();
      throw err;
    }
    return c;
  }

  private async open(): Promise<void> {
    const timeout = this.o.timeoutMs ?? 20_000;
    const dial = this.o.dialAddress ? await this.o.dialAddress(this.o.host) : this.o.host;
    const tlsOpts = { host: dial, port: this.o.port, servername: this.o.host, rejectUnauthorized: this.o.rejectUnauthorized ?? true };
    let greetTimer: ReturnType<typeof setTimeout> | undefined;
    const greeted = new Promise<string>((resolve, reject) => {
      this.greeting = (line) => {
        clearTimeout(greetTimer);
        resolve(line);
      };
      greetTimer = setTimeout(() => reject(new ImapError(`${this.o.host} did not greet within ${Math.round(timeout / 1000)} seconds.`, 'connect')), timeout);
    });
    // a failed connect must not leave the greeting's timer to reject later with nobody listening
    greeted.catch(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const s = this.o.security === 'tls' ? tlsConnect(tlsOpts, () => resolve()) : netConnect({ host: dial, port: this.o.port }, () => resolve());
        s.once('error', (e) => reject(new ImapError(`Could not reach ${this.o.host}:${this.o.port}: ${e.message}`, 'connect')));
        this.attach(s);
      });
    } catch (err) {
      clearTimeout(greetTimer);
      throw err;
    }
    const hello = await greeted;
    if (/^\* BYE/i.test(hello)) throw new ImapError(`The server closed the connection: ${hello.slice(6)}`, 'connect');
    if (this.o.security === 'starttls') {
      const r = await this.command('STARTTLS');
      if (r.status !== 'OK') throw new ImapError('The server refused STARTTLS.', 'connect');
      const plain = this.socket as Socket;
      plain.removeAllListeners('data');
      await new Promise<void>((resolve, reject) => {
        const s = tlsConnect({ ...tlsOpts, socket: plain }, () => resolve());
        s.once('error', (e) => reject(new ImapError(`TLS failed: ${e.message}`, 'connect')));
        this.attach(s);
      });
    }
    await this.capability();
    if (this.capabilities.has('LOGINDISABLED')) throw new ImapError('The server does not allow a password login here. Use TLS, or sign in with the provider.', 'auth');
    const u = quote(this.o.username);
    const p = quote(this.o.password);
    const r = await this.command(`LOGIN ${u.text} ${p.text}`, [u.literal, p.literal].filter((x): x is Uint8Array => !!x));
    if (r.status !== 'OK') throw new ImapError(`The server refused the login: ${r.text || r.status}`, 'auth');
    await this.capability();
  }

  private attach(s: Socket | TLSSocket): void {
    this.socket = s;
    this.buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    s.on('close', () => {
      this.closed = true;
      this.pending?.reject(new ImapError('The server closed the connection.', 'connect'));
      this.pending = undefined;
    });
    s.on('error', (e) => {
      this.pending?.reject(new ImapError(e.message, 'connect'));
      this.pending = undefined;
    });
  }

  /** Cut complete responses (with their literals) off the buffer. */
  private drain(): void {
    for (;;) {
      let pos = 0;
      let line = '';
      const literals: Uint8Array[] = [];
      let complete = false;
      for (;;) {
        const nl = this.buf.indexOf('\r\n', pos);
        if (nl === -1) break;
        const part = this.buf.subarray(pos, nl).toString('latin1');
        const m = /\{(\d+)\+?\}$/.exec(part);
        if (m) {
          const n = Number(m[1]);
          const start = nl + 2;
          if (this.buf.length < start + n) break;
          literals.push(new Uint8Array(this.buf.subarray(start, start + n)));
          line += part.slice(0, m.index) + '\u0000';
          pos = start + n;
          continue;
        }
        line += part;
        pos = nl + 2;
        complete = true;
        break;
      }
      if (!complete) return;
      this.buf = this.buf.subarray(pos);
      // the text parts were read as latin1 so byte counts hold; turn them back into UTF-8
      this.handle(Buffer.from(line, 'latin1').toString('utf8'), literals);
    }
  }

  private handle(line: string, literals: Uint8Array[]): void {
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = undefined;
      g(line);
      return;
    }
    const p = this.pending;
    if (!p) return;
    if (line.startsWith('+')) {
      p.onContinue?.();
      return;
    }
    if (line.startsWith('* ')) {
      p.untagged.push(parseValues(line.slice(2), literals));
      return;
    }
    if (line.startsWith(`${p.tag} `)) {
      const rest = line.slice(p.tag.length + 1);
      const sp = rest.indexOf(' ');
      const status = (sp === -1 ? rest : rest.slice(0, sp)).toUpperCase();
      this.pending = undefined;
      p.resolve({ status, text: sp === -1 ? '' : rest.slice(sp + 1), untagged: p.untagged });
    }
  }

  /** Send one command and wait for its tagged answer. Each literal goes out after the server's "+" continuation. */
  async command(cmd: string, literals: Uint8Array[] = []): Promise<{ status: string; text: string; untagged: ImapValue[][] }> {
    if (this.closed) throw new ImapError('The connection is closed.', 'connect');
    if (this.pending) throw new ImapError('One command at a time.');
    const tag = `C${++this.seq}`;
    // "LOGIN {5} {8}" is ["LOGIN {5}", " {8}", ""]: each part but the last ends where a literal follows
    const parts = cmd.split(/(?<=\{\d+\})/);
    // split makes no empty part after a marker at the very end
    if (/\{\d+\}$/.test(cmd)) parts.push('');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new ImapError(`The server did not answer ${cmd.split(' ')[0]} in time.`, 'connect'));
        this.socket.destroy();
      }, this.o.timeoutMs ?? 30_000);
      let i = 0;
      const writePart = () => {
        this.socket.write(`${i === 0 ? `${tag} ` : ''}${parts[i]}\r\n`);
        i++;
      };
      this.pending = {
        tag,
        untagged: [],
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        onContinue: () => {
          const lit = literals[i - 1];
          if (!lit || i >= parts.length) return;
          this.socket.write(lit);
          writePart();
        },
      };
      writePart();
    });
  }

  private async capability(): Promise<void> {
    const r = await this.command('CAPABILITY');
    for (const u of r.untagged) if (str(u[0]).toUpperCase() === 'CAPABILITY') this.capabilities = new Set(u.slice(1).map((x) => str(x).toUpperCase()));
  }

  /** Folders with their special use (\Drafts, \Sent, \All). */
  async list(): Promise<Array<{ name: string; display: string; flags: string[] }>> {
    const r = await this.command('LIST "" "*"');
    if (r.status !== 'OK') throw new ImapError(`LIST failed: ${r.text}`, 'no');
    return r.untagged
      .filter((u) => str(u[0]).toUpperCase() === 'LIST')
      .map((u) => {
        const flags = Array.isArray(u[1]) ? u[1].map((f) => str(f)) : [];
        const name = str(u[3]);
        return { name, display: decodeMailbox(name), flags };
      });
  }

  /** Open a folder read-only. */
  async examine(mailbox: string): Promise<{ exists: number; uidValidity: string }> {
    const q = quote(mailbox);
    const r = await this.command(`EXAMINE ${q.text}`, q.literal ? [q.literal] : []);
    if (r.status !== 'OK') throw new ImapError(`Could not open ${mailbox}: ${r.text}`, 'no');
    let exists = 0;
    let uidValidity = '';
    for (const u of r.untagged) {
      if (str(u[1]).toUpperCase() === 'EXISTS') exists = Number(str(u[0]));
      // "* OK [UIDVALIDITY 3857529045] UIDs valid": the bracket is one atom
      const m = /\[UIDVALIDITY (\d+)\]/i.exec(u.map((x) => (typeof x === 'string' ? x : '')).join(' '));
      if (m) uidValidity = m[1];
    }
    return { exists, uidValidity };
  }

  /** UIDs that match a search, oldest first. */
  async search(criteria: string, literals: Uint8Array[] = []): Promise<number[]> {
    const r = await this.command(`UID SEARCH ${literals.length ? 'CHARSET UTF-8 ' : ''}${criteria}`, literals);
    if (r.status !== 'OK') throw new ImapError(`SEARCH failed: ${r.text}`, 'no');
    const out: number[] = [];
    for (const u of r.untagged) if (str(u[0]).toUpperCase() === 'SEARCH') for (const x of u.slice(1)) out.push(Number(str(x)));
    return out.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  }

  /**
   * FETCH by UID: each message's items as name to value. A message another
   * client deleted since the search may make the server answer NO after
   * sending the others (RFC 2180 4.1.2, often with [EXPUNGEISSUED]): those
   * still come back and the gone one is left out. A NO that sent nothing
   * and names no deleted message is an error.
   */
  async fetch(uids: number[], items: string): Promise<Array<Record<string, ImapValue>>> {
    if (!uids.length) return [];
    const r = await this.command(`UID FETCH ${uids.join(',')} ${items}`);
    const out: Array<Record<string, ImapValue>> = [];
    for (const u of r.untagged) {
      if (str(u[1]).toUpperCase() !== 'FETCH' || !Array.isArray(u[2])) continue;
      const list = u[2];
      const rec: Record<string, ImapValue> = {};
      for (let i = 0; i + 1 < list.length; i += 2) rec[str(list[i]).toUpperCase()] = list[i + 1];
      out.push(rec);
    }
    if (r.status !== 'OK' && !(r.status === 'NO' && (out.length || /\[EXPUNGEISSUED\]/i.test(r.text)))) throw new ImapError(`FETCH failed: ${r.text}`, 'no');
    return out;
  }

  /** Store a message in a folder (a draft). Returns its UID when the server says (UIDPLUS). */
  async append(mailbox: string, flags: string[], raw: string): Promise<number | undefined> {
    const q = quote(mailbox);
    const bytes = enc.encode(raw);
    const lits = [...(q.literal ? [q.literal] : []), bytes];
    const r = await this.command(`APPEND ${q.text} (${flags.join(' ')}) {${bytes.length}}`, lits);
    if (r.status !== 'OK') throw new ImapError(`The server did not save the draft: ${r.text}`, 'no');
    const m = /\[APPENDUID \d+ (\d+)\]/i.exec(r.text);
    return m ? Number(m[1]) : undefined;
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await Promise.race([this.command('LOGOUT'), new Promise((r) => setTimeout(r, 2_000))]);
    } catch {
      // closing anyway
    }
    this.socket.destroy();
    this.closed = true;
  }
}

/** "21-Oct-2026" for SEARCH SINCE and BEFORE (dates only, server time). */
export function imapDate(ts: number): string {
  const d = new Date(ts);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()}-${mon}-${d.getUTCFullYear()}`;
}

/** A search argument and the literal it needs, if any. */
export function searchArg(s: string): { text: string; literal?: Uint8Array } {
  return quote(s);
}
