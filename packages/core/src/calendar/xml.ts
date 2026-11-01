/**
 * A small namespace-aware XML reader for WebDAV answers (multistatus). Servers
 * pick their own prefixes (d:, D:, a default xmlns), so elements are matched
 * by namespace URI and local name, never by prefix. No DTDs, no external
 * entities: only the five predefined ones and character references.
 */

export const DAV = 'DAV:';
export const CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const CS = 'http://calendarserver.org/ns/';
export const APPLE = 'http://apple.com/ns/ical/';

export interface XmlNode {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? m;
  });
}

/** Parse a document. Throws on text that is not XML. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { ns: '', name: '#root', attrs: {}, children: [], text: '' };
  const stack: Array<{ node: XmlNode; scope: Map<string, string> }> = [{ node: root, scope: new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]) }];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt === -1) {
      top.node.text += decode(xml.slice(i));
      break;
    }
    if (lt > i) top.node.text += decode(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('XML comment not closed');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('CDATA not closed');
      top.node.text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('XML declaration not closed');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      // a DOCTYPE: skipped, never expanded
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) throw new Error('XML doctype not closed');
      i = end + 1;
      continue;
    }
    const gt = tagEnd(xml, lt + 1);
    if (gt === -1) throw new Error('XML tag not closed');
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      if (stack.length <= 1) throw new Error('XML close tag without an open one');
      stack.pop();
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new Error('XML tag without a name');
    const qname = m[1];
    const attrs: Record<string, string> = {};
    const scope = new Map(top.scope);
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(qname.length);
    while ((a = attrRe.exec(rest))) {
      const key = a[1];
      const value = decode(a[3] ?? a[4] ?? '');
      if (key === 'xmlns') scope.set('', value);
      else if (key.startsWith('xmlns:')) scope.set(key.slice(6), value);
      else attrs[key] = value;
    }
    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    const node: XmlNode = { ns: scope.get(prefix) ?? '', name: colon === -1 ? qname : qname.slice(colon + 1), attrs, children: [], text: '' };
    top.node.children.push(node);
    if (!selfClose) stack.push({ node, scope });
  }
  const doc = root.children[0];
  if (!doc) throw new Error('Not an XML document');
  return doc;
}

/** The end of a tag, past quoted attribute values that may hold ">". */
function tagEnd(xml: string, from: number): number {
  let q = '';
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

/** Direct children with this namespace and name. */
export function kids(node: XmlNode | undefined, ns: string, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.ns === ns && c.name === name) : [];
}

export function kid(node: XmlNode | undefined, ns: string, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.ns === ns && c.name === name);
}

/** Descendants with this namespace and name, depth first. */
export function find(node: XmlNode | undefined, ns: string, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (x: XmlNode) => {
    for (const c of x.children) {
      if (c.ns === ns && c.name === name) out.push(c);
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

/** All text inside a node. */
export function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  return node.text + node.children.map(textOf).join('');
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One <response> of a multistatus: its href and the props that came back with 200. */
export interface DavResponse {
  href: string;
  status?: number;
  props: XmlNode[];
}

/** The responses of a 207 Multi-Status body. */
export function multistatus(xml: string): DavResponse[] {
  const doc = parseXml(xml);
  return kids(doc, DAV, 'response').map((r) => {
    // kept as sent (percent-encoded), so it goes back to the server unchanged
    const href = textOf(kid(r, DAV, 'href')).trim();
    const props: XmlNode[] = [];
    for (const ps of kids(r, DAV, 'propstat')) {
      const st = statusCode(textOf(kid(ps, DAV, 'status')));
      if (st !== undefined && (st < 200 || st >= 300)) continue;
      for (const p of kids(ps, DAV, 'prop')) props.push(...p.children);
    }
    const status = statusCode(textOf(kid(r, DAV, 'status')));
    return { href, props, ...(status !== undefined ? { status } : {}) };
  });
}

function statusCode(line: string): number | undefined {
  const m = /HTTP\/[\d.]+\s+(\d{3})/.exec(line);
  return m ? Number(m[1]) : undefined;
}

export function prop(r: DavResponse, ns: string, name: string): XmlNode | undefined {
  return r.props.find((p) => p.ns === ns && p.name === name);
}
