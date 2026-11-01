/**
 * A small SMTP submission client (RFC 6409): TLS on 465 or STARTTLS on 587,
 * AUTH PLAIN or LOGIN with an app password, one message per connection.
 * Only used when the owner turned sending on for an IMAP account and
 * approved the message on its card.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { MailSecurity } from './types';

export interface SmtpOptions {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  password: string;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
  /** The name sent with EHLO. */
  helo?: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

class Conn {
  private buf = '';
  private waiter?: { resolve: (r: { code: number; text: string }) => void; reject: (e: Error) => void };
  private lines: string[] = [];

  constructor(
    public socket: Socket | TLSSocket,
    private timeoutMs: number,
  ) {
    this.listen(socket);
  }

  listen(s: Socket | TLSSocket): void {
    this.socket = s;
    s.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let nl: number;
      while ((nl = this.buf.indexOf('\r\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        this.lines.push(line);
        // "250-..." goes on, "250 ..." ends the reply
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const code = Number(line.slice(0, 3));
          const text = this.lines.map((l) => l.slice(4)).join('\n');
          this.lines = [];
          const w = this.waiter;
          this.waiter = undefined;
          w?.resolve({ code, text });
        }
      }
    });
    s.on('error', (e) => this.waiter?.reject(new SmtpError(e.message)));
    s.on('close', () => this.waiter?.reject(new SmtpError('The server closed the connection.')));
  }

  reply(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new SmtpError('The mail server did not answer in time.')), this.timeoutMs);
      this.waiter = {
        resolve: (r) => {
          clearTimeout(t);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
    });
  }

  /** Send a line. An error names `what` (or the line's command word), never the line: AUTH LOGIN's lines are the user name and password in base64. */
  async send(line: string, expect: number[], what?: string): Promise<{ code: number; text: string }> {
    const p = this.reply();
    this.socket.write(`${line}\r\n`);
    const r = await p;
    if (!expect.includes(r.code)) throw new SmtpError(`${what ?? line.split(' ')[0]} failed: ${r.code} ${r.text}`, r.code);
    return r;
  }
}

/** Dot-stuffing (RFC 5321 4.5.2) and CRLF line ends. */
export function dotStuff(raw: string): string {
  return raw
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? `.${l}` : l))
    .join('\r\n');
}

/** Send one message. from is the envelope sender; to are all recipients (To and Cc). */
export async function sendMail(o: SmtpOptions, from: string, to: string[], raw: string): Promise<{ response: string }> {
  const timeout = o.timeoutMs ?? 30_000;
  const tlsOpts = { host: o.host, port: o.port, servername: o.host, rejectUnauthorized: o.rejectUnauthorized ?? true };
  const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const s = o.security === 'tls' ? tlsConnect(tlsOpts, () => resolve(s)) : netConnect({ host: o.host, port: o.port }, () => resolve(s));
    s.once('error', (e) => reject(new SmtpError(`Could not reach ${o.host}:${o.port}: ${e.message}`)));
  });
  const c = new Conn(socket, timeout);
  try {
    const hello = await c.reply();
    if (hello.code !== 220) throw new SmtpError(`The server did not greet: ${hello.code} ${hello.text}`);
    const helo = o.helo ?? 'conclave.local';
    let ehlo = await c.send(`EHLO ${helo}`, [250]);
    if (o.security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError('The server does not offer STARTTLS. Refusing to send the password in the clear.');
      await c.send('STARTTLS', [220]);
      socket.removeAllListeners('data');
      const secure = await new Promise<TLSSocket>((resolve, reject) => {
        const s = tlsConnect({ ...tlsOpts, socket: socket as Socket }, () => resolve(s));
        s.once('error', (e) => reject(new SmtpError(`TLS failed: ${e.message}`)));
      });
      c.listen(secure);
      ehlo = await c.send(`EHLO ${helo}`, [250]);
    }
    const auth = /AUTH[ =]([^\n]*)/i.exec(ehlo.text)?.[1]?.toUpperCase() ?? '';
    if (auth.includes('PLAIN')) {
      await c.send(`AUTH PLAIN ${Buffer.from(`\u0000${o.username}\u0000${o.password}`, 'utf8').toString('base64')}`, [235], 'AUTH PLAIN');
    } else if (auth.includes('LOGIN')) {
      await c.send('AUTH LOGIN', [334]);
      await c.send(Buffer.from(o.username, 'utf8').toString('base64'), [334], 'AUTH LOGIN (user name)');
      await c.send(Buffer.from(o.password, 'utf8').toString('base64'), [235], 'AUTH LOGIN (password)');
    } else {
      throw new SmtpError('The server offers no password login (AUTH PLAIN or LOGIN).');
    }
    await c.send(`MAIL FROM:<${from}>`, [250]);
    for (const r of to) await c.send(`RCPT TO:<${r}>`, [250, 251]);
    await c.send('DATA', [354]);
    const done = await c.send(`${dotStuff(raw).replace(/\r\n$/, '')}\r\n.`, [250], 'The message');
    await c.send('QUIT', [221]).catch(() => undefined);
    return { response: done.text };
  } finally {
    c.socket.destroy();
  }
}
