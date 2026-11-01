/**
 * Messages in and out. Reading uses postal-mime (pinned in package.json):
 * multipart, charsets, quoted-printable and base64, encoded words. Writing is
 * one text/plain part, which is all a drafted reply needs, with headers that
 * cannot carry a line break into another header.
 */
import PostalMime from 'postal-mime';
import { randomUUID } from 'node:crypto';
import type { MailAddress } from './types';

/** No CR or LF, so a value cannot start a new header. */
export function headerSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}

const ADDR = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+\.[^\s@<>(),;:"\[\]\\]+$/;

/** A bare address ("ana@example.com") or "Ana <ana@example.com>". */
export function parseAddress(s: string): MailAddress | undefined {
  const t = headerSafe(s);
  const m = /^(.*)<([^<>]+)>$/.exec(t);
  const address = (m ? m[2] : t).trim();
  if (!ADDR.test(address)) return undefined;
  const name = m ? m[1].trim().replace(/^"|"$/g, '').trim() : '';
  return { address, ...(name ? { name } : {}) };
}

/** RFC 2047 B encoding for a header word that is not ASCII. */
export function encodeWord(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const out: string[] = [];
  let chunk = '';
  for (const ch of s) {
    // 45 bytes of UTF-8 keep each encoded word under 75 characters
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      out.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) out.push(chunk);
  return out.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join(' ');
}

function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address;
  const name = /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\]/g, '')}"` : encodeWord(a.name);
  return `${name} <${a.address}>`;
}

function rfc2822Date(ts: number): string {
  return new Date(ts).toUTCString().replace('GMT', '+0000');
}

export interface ComposeInput {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  date?: number;
  messageId?: string;
}

const ALLOWED_TAGS = new Set(['table', 'tr', 'td', 'span', 'b', 'strong', 'a', 'br', 'div', 'p']);
const VOID_TAGS = new Set(['br']);
const STYLE_PROP = /^(color|font|font-family|font-size|font-weight|font-style|line-height|text-decoration)$/i;

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeAttrEntities(s: string): string {
  return s.replace(/&(nbsp|amp|lt|gt|quot|apos|#\d{1,8}|#x[0-9a-f]{1,8});?/gi, (m, e: string) => {
    const named: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (e[0] !== '#') return named[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function sanitizeHref(raw: string): string | undefined {
  const decoded = decodeAttrEntities(raw).replace(/[\u0000-\u0020]+/g, '');
  if (!/^(https?:\/\/|mailto:)/i.test(decoded)) return undefined;
  return escapeAttr(decodeAttrEntities(raw).replace(/[\u0000-\u001f\u007f]+/g, '').trim());
}

function sanitizeStyle(raw: string): string | undefined {
  const decoded = decodeAttrEntities(raw);
  const out: string[] = [];
  for (const decl of decoded.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (!STYLE_PROP.test(prop) || !val) continue;
    if (/url\s*\(|expression\s*\(|javascript:|vbscript:|data:|@import|behavior\s*:|-moz-binding|[<>\\]/i.test(val)) continue;
    if (!/^[#a-zA-Z0-9\s,.'"%/+-]+$/.test(val)) continue;
    out.push(`${prop}:${val.replace(/"/g, "'")}`);
  }
  return out.length ? escapeAttr(out.join(';')) : undefined;
}

/**
 * Sanitize an HTML signature to the allowed subset: table, tr, td, span, b,
 * strong, a (href http/https/mailto), br, div, p, and style attributes for
 * color/font only. Strips script/style/head blocks, event handlers, and other
 * tags or URLs.
 */
export function sanitizeSignatureHtml(html: string): string {
  const cleaned = html
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, 20_000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|iframe|object|embed|svg|math)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|head|iframe|object|embed|svg|math)\b[^>]*\/?>/gi, '');
  return cleaned
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)(\s[^>]*)?\s*\/?>/g, (full, rawName: string, rawAttrs = '') => {
      const tag = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (full.startsWith('</')) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
      const attrs: string[] = [];
      const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rawAttrs)) !== null) {
        const name = m[1].toLowerCase();
        const val = m[2] ?? m[3] ?? m[4] ?? '';
        if (name === 'style') {
          const s = sanitizeStyle(val);
          if (s) attrs.push(`style="${s}"`);
        } else if (tag === 'a' && name === 'href') {
          const h = sanitizeHref(val);
          if (h) attrs.push(`href="${h}"`);
        }
      }
      return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
    })
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape plain text and wrap paragraphs in <p>, with single line breaks as <br>. */
export function bodyToHtml(text: string): string {
  const norm = text.replace(/\r\n/g, '\n').trim();
  if (!norm) return '<p></p>';
  return norm
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Build the plain-text and HTML bodies for a draft, appending the account's signature when set. */
export function applySignature(body: string, signatureHtml?: string): { text: string; html?: string } {
  const cleanSig = signatureHtml ? sanitizeSignatureHtml(signatureHtml) : '';
  if (!cleanSig) return { text: body };
  const sigText = htmlText(cleanSig);
  const trimmedBody = body.replace(/\s+$/, '');
  const text = sigText ? `${trimmedBody}\n\n${sigText}` : body;
  const html = `${bodyToHtml(body)}\n${cleanSig}`;
  return { text, html };
}

function base64Block(s: string): string {
  return Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');
}

/** A complete RFC 5322 message with CRLF line ends. */
export function composeMessage(m: ComposeInput): { raw: string; messageId: string } {
  const domain = m.from.address.split('@')[1] ?? 'conclave.local';
  const messageId = m.messageId ?? `<${randomUUID()}@${domain}>`;
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeWord(headerSafe(m.subject))}`,
    `Date: ${rfc2822Date(m.date ?? Date.now())}`,
    `Message-ID: ${messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${headerSafe(m.inReplyTo)}`] : []),
    ...(m.references || m.inReplyTo ? [`References: ${headerSafe([m.references, m.inReplyTo].filter(Boolean).join(' '))}`] : []),
    'MIME-Version: 1.0',
  ];
  if (m.html) {
    const boundary = `conclave_${randomUUID().replace(/-/g, '')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, 'X-Mailer: Conclave');
    const textPart = [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Block(m.body)].join('\r\n');
    const htmlPart = [`--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Block(m.html)].join('\r\n');
    return { raw: `${headers.join('\r\n')}\r\n\r\n${textPart}\r\n${htmlPart}\r\n--${boundary}--\r\n`, messageId };
  }
  headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'X-Mailer: Conclave');
  const body = base64Block(m.body);
  return { raw: `${headers.join('\r\n')}\r\n\r\n${body}\r\n`, messageId };
}

export interface ParsedMail {
  from?: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  date?: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text: string;
  attachments: Array<{ name: string; type: string; size?: number }>;
}

type PmAddress = { name: string; address?: string; group?: Array<{ name: string; address: string }> };

function flat(list: PmAddress[] | undefined): MailAddress[] {
  const out: MailAddress[] = [];
  for (const a of list ?? []) {
    if (a.group) for (const g of a.group) out.push({ address: g.address, ...(g.name ? { name: g.name } : {}) });
    else if (a.address) out.push({ address: a.address, ...(a.name ? { name: a.name } : {}) });
  }
  return out;
}

/** HTML to plain text: blocks become lines, tags and scripts go, entities are read. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => (label.replace(/<[^>]+>/g, '').trim() && !href.startsWith('mailto:') ? `${label} (${href})` : label))
    .replace(/<[^>]+>/g, '')
    // one pass, so "&amp;lt;" stays "&lt;"; a number past Unicode (a sender can type one) stays as it was
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#\d{1,8}|#x[0-9a-f]{1,8});/gi, (m, e: string) => {
      const named: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (e[0] !== '#') return named[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Read a raw message. Never throws: a message it cannot read comes back empty with what it could get. */
export async function parseMessage(raw: string | Uint8Array): Promise<ParsedMail> {
  try {
    const e = await PostalMime.parse(raw as never, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 20, maxPartCount: 200 });
    const date = e.date ? Date.parse(e.date) : NaN;
    const from = flat(e.from ? [e.from as PmAddress] : [])[0];
    const text = (e.text && e.text.trim()) || (e.html ? htmlText(e.html) : '');
    return {
      ...(from ? { from } : {}),
      to: flat(e.to as PmAddress[] | undefined),
      cc: flat(e.cc as PmAddress[] | undefined),
      subject: e.subject ?? '',
      ...(Number.isFinite(date) ? { date } : {}),
      ...(e.messageId ? { messageId: e.messageId } : {}),
      ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}),
      ...(e.references ? { references: e.references } : {}),
      text,
      attachments: e.attachments
        .filter((a) => a.disposition !== 'inline' || a.filename)
        .map((a) => ({ name: a.filename ?? '(no name)', type: a.mimeType, size: typeof a.content === 'string' ? a.content.length : a.content.byteLength })),
    };
  } catch {
    return { to: [], cc: [], subject: '', text: '', attachments: [] };
  }
}

/** The first words of a text, for a list. */
export function snippet(text: string, n = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}
