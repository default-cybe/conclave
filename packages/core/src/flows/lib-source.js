// Conclave flow helpers v1. Generated once; yours to change.
// Each export is one block on the canvas (docs/design/VISUAL-PROGRAMMING.md 4.3).
// When Conclave's Run sets CONCLAVE_FLOW_TRACE, each call writes one line to
// stderr that the canvas shows on its block. Without it they print nothing extra,
// so `bun flows/<name>.flow.ts` runs the same anywhere.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TRACE = process.env.CONCLAVE_FLOW_TRACE;

/** The flow file's line that called the helper, from the stack. */
function callerLine() {
  const m = /\.flow\.ts:(\d+):\d+/.exec(new Error().stack ?? '');
  return m ? Number(m[1]) : undefined;
}

function cut(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** A short label for the wire. */
function summary(v) {
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  if (typeof v === 'string') return v.length <= 40 ? v : `${v.length} chars`;
  if (v && typeof v === 'object') return cut(`{ ${Object.keys(v).join(', ')} }`, 40);
  return String(v);
}

function preview(v) {
  let s;
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v));
  } catch {
    s = String(v);
  }
  // longer than the 2000 the canvas shows: the hub masks .env values first, then cuts
  return cut(s, 8000);
}

function emit(rec) {
  process.stderr.write(`\x1e${TRACE} ${JSON.stringify(rec)}\n`);
}

/** Run one block and trace it. Called first thing in each helper, so the stack still holds the flow's line. */
async function step(run) {
  const line = TRACE ? callerLine() : undefined;
  const t0 = performance.now();
  try {
    const v = await run();
    if (TRACE) emit({ line, ok: true, ms: Math.round(performance.now() - t0), summary: summary(v), value: preview(v) });
    return v;
  } catch (err) {
    if (TRACE) emit({ line, ok: false, ms: Math.round(performance.now() - t0), error: String(err?.message ?? err) });
    throw err;
  }
}

function get(obj, field) {
  let v = obj;
  for (const k of String(field).split('.').filter(Boolean)) {
    if (v === null || v === undefined || typeof v !== 'object') throw new Error(`no field ${field}: ${k} is inside a ${v === null ? 'null' : typeof v}`);
    if (!(k in v)) throw new Error(`no field ${field}: it has ${Object.keys(v).slice(0, 8).join(', ') || 'no fields'}`);
    v = v[k];
  }
  return v;
}

function list(items, what) {
  if (!Array.isArray(items)) throw new Error(`${what} needs a list, got ${items === null ? 'null' : typeof items}`);
  return items;
}

function asText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function readFile({ path, as = 'text' }) {
  return step(() => (as === 'json' ? Bun.file(path).json() : Bun.file(path).text()));
}

export function writeFile({ path, text }) {
  return step(async () => {
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, asText(text));
    return path;
  });
}

export function fetchUrl({ url, as = 'json', method = 'GET', body }) {
  return step(async () => {
    const res = await fetch(url, { method, ...(body !== undefined ? { body: asText(body), headers: { 'content-type': 'application/json' } } : {}) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    return as === 'json' ? res.json() : res.text();
  });
}

export function parseJson({ text }) {
  return step(() => JSON.parse(String(text)));
}

export function pick({ from, field }) {
  return step(() => get(from, field));
}

export function map({ items, field }) {
  return step(() => list(items, 'Map').map((x) => get(x, field)));
}

export function filter({ items, field, op = 'contains', value }) {
  return step(() =>
    list(items, 'Filter').filter((x) => {
      const f = get(x, field);
      if (op === 'contains') return String(f).toLowerCase().includes(String(value).toLowerCase());
      if (op === '==') return String(f) === String(value);
      if (op === '!=') return String(f) !== String(value);
      if (op === '>') return Number(f) > Number(value);
      if (op === '<') return Number(f) < Number(value);
      throw new Error(`Filter op is contains, ==, !=, > or <, not ${op}`);
    }),
  );
}

export function joinText({ items, sep = '\n' }) {
  return step(() => list(items, 'Join text').map(asText).join(sep));
}

export function regex({ text, pattern, flags = 'g', many = true }) {
  return step(() => {
    const re = new RegExp(pattern, many && !flags.includes('g') ? `${flags}g` : flags);
    if (many) return [...String(text).matchAll(re)].map((m) => m[1] ?? m[0]);
    const m = re.exec(String(text));
    return m ? (m[1] ?? m[0]) : null;
  });
}

export function writeCsv({ path, rows, columns = '' }) {
  return step(async () => {
    const all = list(rows, 'Write CSV');
    const cols = String(columns).split(',').map((c) => c.trim()).filter(Boolean);
    const head = cols.length ? cols : Object.keys(all[0] ?? {});
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : asText(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.map(cell).join(','), ...all.map((r) => head.map((c) => cell(r?.[c])).join(','))];
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, `${lines.join('\n')}\n`);
    return path;
  });
}

export function log({ value }) {
  return step(() => {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return value;
  });
}

/** A model through the hub's gateway: CONCLAVE_GATEWAY_URL (…/gw/openai/v1) and CONCLAVE_GATEWAY_KEY in the project's .env. */
export function ai({ prompt, input, model = 'fast' }) {
  return step(async () => {
    const url = process.env.CONCLAVE_GATEWAY_URL;
    const key = process.env.CONCLAVE_GATEWAY_KEY;
    if (!url || !key) throw new Error('Call AI needs CONCLAVE_GATEWAY_URL and CONCLAVE_GATEWAY_KEY in the project .env');
    const content = input === undefined || input === '' ? prompt : `${prompt}\n\n${asText(input)}`;
    const res = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) throw new Error(`the gateway said ${res.status}: ${cut(await res.text(), 300)}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? '';
  });
}

// shortcut: runs through sh, so not on Windows without one; use Bun.$ when flows run there
export function shell({ command }) {
  return step(async () => {
    const p = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'inherit' });
    const stdout = await new Response(p.stdout).text();
    return { stdout, code: await p.exited };
  });
}
