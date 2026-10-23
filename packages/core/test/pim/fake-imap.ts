/**
 * An in-process IMAP server (and a tiny SMTP one) for tests and the real
 * run. Enough of RFC 3501 for the client: CAPABILITY, LOGIN (quoted or
 * literal), LIST with special-use flags, EXAMINE, UID SEARCH (ALL, FROM, TO,
 * SUBJECT, TEXT, UNSEEN, SINCE, BEFORE, CHARSET), UID FETCH of FLAGS,
 * INTERNALDATE and BODY.PEEK[] with a partial range, APPEND with a literal,
 * LOGOUT. It never sets \Seen on a peek, and records what the client sent.
 */
import { createServer, type Server, type Socket } from 'node:net';

export interface FakeMessage {
  uid: number;
  raw: string;
  flags: string[];
  date: number;
}

export interface FakeImap {
  host: string;
  port: number;
  user: string;
  password: string;
  boxes: Map<string, { flags: string[]; messages: FakeMessage[]; uidValidity: number }>;
  commands: string[];
  /** UIDs another client deleted after this one searched: SEARCH still lists them, FETCH leaves them out and answers NO (RFC 2180 4.1.2). */
  expungedElsewhere: Set<number>;
  add(box: string, raw: string, opts?: { flags?: string[]; date?: number }): number;
  stop(): void;
}

function months(m: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m.toLowerCase());
}

function header(raw: string, name: string): string {
  const head = raw.split(/\r?\n\r?\n/)[0];
  const m = new RegExp(`^${name}:(.*(?:\\r?\\n[ \\t].*)*)`, 'im').exec(head);
  return m ? m[1].replace(/\r?\n[ \t]/g, ' ').trim() : '';
}

/** Tokenize a command line: atoms, quoted strings and literals already cut in. */
function tokens(line: string, literals: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  let lit = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++;
        s += line[i++];
      }
      i++;
      out.push(s);
      continue;
    }
    if (c === '\u0000') {
      out.push(literals[lit++] ?? '');
      i++;
      continue;
    }
    if (c === '(') {
      // a parenthesized list stays one token
      let depth = 0;
      let s = '';
      do {
        if (line[i] === '(') depth++;
        if (line[i] === ')') depth--;
        s += line[i++];
      } while (i < line.length && depth > 0);
      out.push(s);
      continue;
    }
    let s = '';
    while (i < line.length && line[i] !== ' ') {
      if (line[i] === '[') {
        const end = line.indexOf(']', i);
        s += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      s += line[i++];
    }
    out.push(s);
  }
  return out;
}

export function startFakeImap(opts: { user?: string; password?: string } = {}): Promise<FakeImap> {
  const user = opts.user ?? 'owner@example.com';
  const password = opts.password ?? 'imap-app-pass-5678';
  const boxes: FakeImap['boxes'] = new Map([
    ['INBOX', { flags: [], messages: [], uidValidity: 42 }],
    ['Drafts', { flags: ['\\Drafts'], messages: [], uidValidity: 43 }],
    ['Sent Messages', { flags: ['\\Sent'], messages: [], uidValidity: 44 }],
  ]);
  const commands: string[] = [];
  const expungedElsewhere = new Set<number>();
  let nextUid = 100;

  const handle = (sock: Socket) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    let selected: string | undefined;
    // a command waiting for literal bytes
    let wait: { need: number; line: string; literals: string[]; rest: string } | undefined;
    const send = (s: string) => sock.write(s);
    sock.write('* OK [CAPABILITY IMAP4rev1 LITERAL+ UIDPLUS SPECIAL-USE] fake ready\r\n');
    const run = (tagLine: string, literals: string[]) => {
      commands.push(tagLine.replace(/\u0000/g, '{lit}'));
      const t = tokens(tagLine, literals);
      const tag = t[0];
      const cmd = (t[1] ?? '').toUpperCase();
      const args = t.slice(2);
      if (cmd === 'CAPABILITY') return send(`* CAPABILITY IMAP4rev1 LITERAL+ UIDPLUS SPECIAL-USE AUTH=PLAIN\r\n${tag} OK done\r\n`);
      if (cmd === 'LOGIN') {
        if (args[0] === user && args[1] === password) {
          authed = true;
          return send(`${tag} OK logged in\r\n`);
        }
        return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      }
      if (cmd === 'LOGOUT') {
        send(`* BYE bye\r\n${tag} OK bye\r\n`);
        return sock.end();
      }
      if (cmd === 'NOOP') return send(`${tag} OK\r\n`);
      if (!authed) return send(`${tag} NO not logged in\r\n`);
      if (cmd === 'LIST') {
        for (const [name, b] of boxes) send(`* LIST (${b.flags.join(' ')}) "/" "${name}"\r\n`);
        return send(`${tag} OK listed\r\n`);
      }
      if (cmd === 'EXAMINE' || cmd === 'SELECT') {
        const b = boxes.get(args[0]);
        if (!b) return send(`${tag} NO no such mailbox\r\n`);
        selected = args[0];
        return send(`* ${b.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${b.uidValidity}] UIDs valid\r\n${tag} OK [READ-ONLY] examined\r\n`);
      }
      if (cmd === 'UID' && (args[0] ?? '').toUpperCase() === 'SEARCH') {
        const b = boxes.get(selected ?? '');
        if (!b) return send(`${tag} NO nothing selected\r\n`);
        let crit = args.slice(1);
        if ((crit[0] ?? '').toUpperCase() === 'CHARSET') crit = crit.slice(2);
        let list = b.messages;
        for (let i = 0; i < crit.length; i++) {
          const k = crit[i].toUpperCase();
          const v = crit[i + 1] ?? '';
          const has = (h: string) => (m: FakeMessage) => header(m.raw, h).toLowerCase().includes(v.toLowerCase());
          if (k === 'ALL') continue;
          if (k === 'UNSEEN') list = list.filter((m) => !m.flags.includes('\\Seen'));
          else if (k === 'FROM') (list = list.filter(has('from'))), i++;
          else if (k === 'TO') (list = list.filter(has('to'))), i++;
          else if (k === 'SUBJECT') (list = list.filter(has('subject'))), i++;
          else if (k === 'TEXT') (list = list.filter((m) => m.raw.toLowerCase().includes(v.toLowerCase()))), i++;
          else if (k === 'SINCE' || k === 'BEFORE') {
            const [d, mo, y] = v.split('-');
            const at = Date.UTC(Number(y), months(mo), Number(d));
            list = list.filter((m) => (k === 'SINCE' ? m.date >= at : m.date < at));
            i++;
          }
        }
        return send(`* SEARCH ${list.map((m) => m.uid).join(' ')}\r\n${tag} OK searched\r\n`);
      }
      if (cmd === 'UID' && (args[0] ?? '').toUpperCase() === 'FETCH') {
        const b = boxes.get(selected ?? '');
        if (!b) return send(`${tag} NO nothing selected\r\n`);
        const uids = new Set(args[1].split(',').map(Number));
        const items = args.slice(2).join(' ').toUpperCase();
        const part = /BODY\.PEEK\[\]<0\.(\d+)>/.exec(items);
        let seq = 0;
        let gone = false;
        for (const m of b.messages) {
          seq++;
          if (!uids.has(m.uid)) continue;
          if (expungedElsewhere.has(m.uid)) {
            gone = true;
            continue;
          }
          const bytes = Buffer.from(m.raw, 'utf8');
          const body = part ? bytes.subarray(0, Number(part[1])) : bytes;
          const date = new Date(m.date);
          const idate = `${String(date.getUTCDate()).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]}-${date.getUTCFullYear()} 10:00:00 +0000`;
          sock.write(`* ${seq} FETCH (UID ${m.uid} FLAGS (${m.flags.join(' ')}) INTERNALDATE "${idate}" BODY[]${part ? '<0>' : ''} {${body.length}}\r\n`);
          sock.write(body);
          sock.write(')\r\n');
        }
        return send(gone ? `${tag} NO [EXPUNGEISSUED] Some of the requested messages no longer exist\r\n` : `${tag} OK fetched\r\n`);
      }
      if (cmd === 'APPEND') {
        const b = boxes.get(args[0]);
        if (!b) return send(`${tag} NO [TRYCREATE] no such mailbox\r\n`);
        const flags = (args[1] ?? '').replace(/[()]/g, '').split(' ').filter(Boolean);
        const raw = args[args.length - 1];
        const uid = nextUid++;
        b.messages.push({ uid, raw, flags, date: Date.now() });
        return send(`${tag} OK [APPENDUID ${b.uidValidity} ${uid}] appended\r\n`);
      }
      return send(`${tag} BAD unknown command\r\n`);
    };
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (wait) {
          if (buf.length < wait.need) return;
          wait.literals.push(buf.subarray(0, wait.need).toString('utf8'));
          buf = buf.subarray(wait.need);
          const nl = buf.indexOf('\r\n');
          if (nl === -1) return;
          const more = buf.subarray(0, nl).toString('utf8');
          buf = buf.subarray(nl + 2);
          const m = /\{(\d+)(\+?)\}$/.exec(more);
          if (m) {
            wait = { need: Number(m[1]), line: wait.line + '\u0000' + more.slice(0, m.index), literals: wait.literals, rest: '' };
            if (!m[2]) sock.write('+ go ahead\r\n');
            continue;
          }
          const line = wait.line + '\u0000' + more;
          const lits = wait.literals;
          wait = undefined;
          run(line, lits);
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 2);
        const m = /\{(\d+)(\+?)\}$/.exec(line);
        if (m) {
          wait = { need: Number(m[1]), line: line.slice(0, m.index), literals: [], rest: '' };
          if (!m[2]) sock.write('+ go ahead\r\n');
          continue;
        }
        run(line, []);
      }
    });
    sock.on('error', () => undefined);
  };

  const server: Server = createServer(handle);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        host: '127.0.0.1',
        port: addr.port,
        user,
        password,
        boxes,
        commands,
        expungedElsewhere,
        add(box, raw, o = {}) {
          const b = boxes.get(box)!;
          const uid = nextUid++;
          b.messages.push({ uid, raw: raw.replace(/\r?\n/g, '\r\n'), flags: o.flags ?? [], date: o.date ?? Date.now() });
          return uid;
        },
        stop: () => server.close(),
      });
    });
  });
}

export interface FakeSmtp {
  host: string;
  port: number;
  sent: Array<{ from: string; to: string[]; data: string; auth: string }>;
  stop(): void;
}

/** A plain SMTP server that takes AUTH PLAIN and keeps what it gets. */
export function startFakeSmtp(opts: { user: string; password: string }): Promise<FakeSmtp> {
  const sent: FakeSmtp['sent'] = [];
  const server = createServer((sock) => {
    let buf = '';
    let from = '';
    let to: string[] = [];
    let auth = '';
    let data: string | undefined;
    sock.write('220 fake smtp\r\n');
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== undefined) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          sent.push({ from, to, data: data.replace(/^\.\./gm, '.'), auth });
          data = undefined;
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (up.startsWith('AUTH PLAIN')) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          auth = u;
          sock.write(u === opts.user && p === opts.password ? '235 ok\r\n' : '535 no\r\n');
        } else if (up.startsWith('MAIL FROM:')) {
          from = line.slice(10).replace(/[<>]/g, '');
          to = [];
          sock.write('250 ok\r\n');
        } else if (up.startsWith('RCPT TO:')) {
          to.push(line.slice(8).replace(/[<>]/g, ''));
          sock.write('250 ok\r\n');
        } else if (up === 'DATA') {
          data = '';
          sock.write('354 go\r\n');
        } else if (up === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('502 no\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ host: '127.0.0.1', port: addr.port, sent, stop: () => server.close() });
    });
  });
}
