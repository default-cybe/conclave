/**
 * The Preview pane's element picker (Orca's Design Mode, Claude Code's
 * preview click): the element under a point, as text the agent can act on.
 * PICK_DOM runs in an isolated world (the page's scripts cannot change what
 * it reads); PICK_SOURCE runs in the page's own world, where React and Vue
 * keep their debug data. cleanPick trims and redacts both on the hub: what
 * comes back is page data, fenced as untrusted wherever it goes.
 */

/** Computed properties the payload keeps. */
export const PICK_STYLES = [
  'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color',
  'border', 'border-radius', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'z-index',
];

export const MAX_HTML = 4096;
const MAX_DEPTH = 10;

export interface RawPick {
  selector: string[];
  html: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  url: string;
  attrs: Record<string, string>;
}

export interface SourceHints {
  file?: string;
  line?: number;
  column?: number;
  components?: string[];
}

export interface Pick {
  selector: string;
  html: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  url: string;
  source?: string;
  components?: string[];
}

/** (x, y, styles) in CSS pixels to RawPick | null. Plain function source: it runs in the page. */
export const PICK_DOM = `(x, y, styles) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const part = (e) => {
    let s = e.localName;
    if (e.id) return s + '#' + CSS.escape(e.id);
    s += [...e.classList].slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
    const p = e.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.localName === e.localName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
    }
    return s;
  };
  const selector = [];
  for (let e = el; e && e.nodeType === 1 && selector.length < ${MAX_DEPTH}; e = e.parentElement) {
    selector.unshift(part(e));
    if (e.id) break;
  }
  const cs = getComputedStyle(el);
  const st = {};
  for (const k of styles) st[k] = cs.getPropertyValue(k);
  const r = el.getBoundingClientRect();
  const attrs = {};
  for (let e = el; e && e.nodeType === 1 && !Object.keys(attrs).length; e = e.parentElement) {
    for (const a of e.attributes) if (/^data-(source|inspector-|locatorjs)/.test(a.name)) attrs[a.name] = a.value;
  }
  return { selector, html: el.outerHTML.slice(0, 20000), styles: st, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, url: location.href, attrs };
}`;

/** (x, y) to SourceHints from React's fiber (_debugSource, React 18 and older) or Vue's __file. */
export const PICK_SOURCE = `(x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return {};
  const out = {};
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (key) {
    const names = [];
    for (let f = el[key]; f; f = f.return) {
      if (!out.file && f._debugSource) Object.assign(out, { file: f._debugSource.fileName, line: f._debugSource.lineNumber, column: f._debugSource.columnNumber });
      const t = f.type;
      const n = typeof t === 'function' ? t.displayName || t.name : t && typeof t === 'object' ? t.displayName : undefined;
      if (n && names.length < 6 && !names.includes(n)) names.push(n);
    }
    if (names.length) out.components = names;
  }
  for (let e = el; e && !out.file; e = e.parentElement) {
    const c = e.__vueParentComponent || (e.__vue__ && { type: e.__vue__.$options });
    const file = c && c.type && c.type.__file;
    if (file) out.file = file;
  }
  return out;
}`;

/** Attribute names whose values never leave the hub; value is always out (a typed password, a card number). */
const SECRET_NAME = /(^value$|token|secret|password|passwd|api[-_]?key|auth|session|csrf|xsrf|nonce|signature|credential|private)/i;
/** Values that look like a key whatever their attribute: a JWT, a long hex or base64 run. */
const SECRET_VALUE = /^(eyJ[\w-]+\.[\w-]+\.[\w-]*|[a-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/;

/** Scripts out, secret-like attribute values redacted, then cut to MAX_HTML. */
export function cleanHtml(html: string): string {
  let s = html.replace(/<script\b[\s\S]*?(<\/script\s*>|$)/gi, '<script>[removed]</script>');
  s = s.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (all, name: string, _q, dq: string | undefined, sq: string | undefined) =>
    SECRET_NAME.test(name) || SECRET_VALUE.test(dq ?? sq ?? '') ? `${name}="[redacted]"` : all,
  );
  return s.length > MAX_HTML ? `${s.slice(0, MAX_HTML)}…[${s.length - MAX_HTML} more chars]` : s;
}

/** The page address without its query and hash, which may carry tokens. */
export function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

const short = (v: unknown, n = 300): string => (typeof v === 'string' ? v.slice(0, n) : '');

export function cleanPick(raw: RawPick, hints: SourceHints = {}): Pick {
  const styles: Record<string, string> = {};
  for (const k of PICK_STYLES) {
    const v = short(raw.styles?.[k], 200);
    if (v) styles[k] = v;
  }
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0);
  const attr = Object.values(raw.attrs ?? {}).map((v) => short(v)).find(Boolean);
  // the page's own JS gives these: line and column count only as numbers
  const line = num(hints.line);
  const column = num(hints.column);
  const file = short(hints.file);
  const hinted = file ? `${file}${line > 0 ? `:${line}${column > 0 ? `:${column}` : ''}` : ''}` : undefined;
  const source = attr || hinted;
  const comps = (Array.isArray(hints.components) ? hints.components : []).slice(0, 6).map((c) => short(c, 80)).filter(Boolean);
  return {
    selector: (raw.selector ?? []).slice(-MAX_DEPTH).map((p) => short(p, 120)).join(' > '),
    html: cleanHtml(String(raw.html ?? '')),
    styles,
    rect: { x: num(raw.rect?.x), y: num(raw.rect?.y), width: num(raw.rect?.width), height: num(raw.rect?.height) },
    url: bareUrl(String(raw.url ?? '')),
    ...(source ? { source } : {}),
    ...(comps.length ? { components: comps } : {}),
  };
}

/** The pick as text for the agent; routes-preview.ts fences it as untrusted page data (wrapUntrusted). */
export function pickText(p: Pick): string {
  return [
    `Element picked in the Preview at ${p.url || 'the preview'}:`,
    `selector: ${p.selector}`,
    ...(p.source ? [`source: ${p.source}`] : []),
    ...(p.components ? [`components: ${p.components.join(' < ')}`] : []),
    `box: ${p.rect.width}x${p.rect.height} at ${p.rect.x},${p.rect.y}`,
    `styles: ${Object.entries(p.styles).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
    'html:',
    p.html,
  ].join('\n');
}
