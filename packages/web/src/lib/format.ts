/** Formatting helpers. Numbers are compact, times are relative, all short. */

const UNITS = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
] as const;

export function compact(n: number | undefined, digits = 1): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0';
  const abs = Math.abs(n);
  for (const [size, word] of UNITS) {
    if (abs < size) continue;
    const s = trim((n / size).toFixed(size === 1e3 && abs >= 1e4 ? 0 : digits));
    // 999,950 rounds to "1000K": it reads in the next unit up, "1M"
    if (word !== 'B' && Math.abs(Number(s)) >= 1000) return compact(Math.sign(n) * size * 1000, digits);
    return s + word;
  }
  const r = Math.round(n);
  return Math.abs(r) >= 1000 ? compact(Math.sign(n) * 1000, digits) : String(r);
}

function trim(s: string) {
  return s.replace(/\.0+$/, '');
}

export function usd(n: number | undefined, opts: { precise?: boolean } = {}): string {
  const v = n ?? 0;
  if (v === 0) return '$0';
  if (opts.precise || Math.abs(v) < 1) {
    if (Math.abs(v) < 0.01) return '<$0.01';
    return '$' + v.toFixed(Math.abs(v) < 10 ? 2 : 2);
  }
  if (Math.abs(v) >= 1000) return '$' + compact(v);
  return '$' + v.toFixed(2);
}

export function int(n: number | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "in 1h 23m", "2d 4h" style countdown. */
export function countdown(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  let d = Math.max(0, ts - now);
  if (d < 1000) return 'now';
  const days = Math.floor(d / DAY);
  d -= days * DAY;
  const h = Math.floor(d / HOUR);
  d -= h * HOUR;
  const m = Math.floor(d / MIN);
  const s = Math.floor((d - m * MIN) / 1000);
  if (days) return `${days}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function bytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function plural(n: number, word: string, many?: string): string {
  return `${n} ${n === 1 ? word : (many ?? word + 's')}`;
}

/** A Windows path with forward slashes ("C:\Users\sam\x" is "C:/Users/sam/x"), so one set of rules reads both. */
export const slashes = (p: string) => (/^[A-Za-z]:[\\/]/.test(p) || (p.includes('\\') && !p.includes('/')) ? p.replace(/\\/g, '/') : p);

/** The home folder as ~: /home/sam, /Users/sam and C:/Users/sam. */
const home = (p: string) => slashes(p).replace(/^(\/(home|Users)|[A-Za-z]:\/Users)\/[^/]+/, '~');

/** Last path segments, with ~ for home. */
export function shortPath(p: string | undefined, segments = 2): string {
  if (!p) return '';
  const h = home(p);
  const parts = h.split('/').filter(Boolean);
  if (parts.length <= segments + 1) return h;
  return '…/' + parts.slice(-segments).join('/');
}

const homeRel = (p: string) => home(p).replace(/\/+$/, '');

/**
 * A file as a session talks about it: relative to the session's folder when
 * it is inside it ("src/auth/redirect.ts"), else as shortPath gives it
 * ("…/conclave/notes.md"). The file name is always there. Windows paths
 * compare without case, as Windows does.
 */
export function pathIn(p: string | undefined, cwd: string | undefined): string {
  if (!p) return '';
  const base = cwd ? homeRel(cwd) : '';
  const full = homeRel(p);
  const fold = (s: string) => (/^[A-Za-z]:[\\/]/.test(cwd ?? '') ? s.toLowerCase() : s);
  if (base && base !== '~' && fold(full).startsWith(fold(base) + '/')) return full.slice(base.length + 1);
  return shortPath(p, 3);
}

/** The file's own name, from a path in either form ("redirect.ts"). */
export function fileName(p: string): string {
  return slashes(p).replace(/\/+$/, '').split('/').pop() || p;
}

/** The last part of a folder, the name people use for the project ("fernway-web"). Empty for the home folder. */
export function folderName(cwd: string | undefined): string {
  if (!cwd || cwd === '/') return '';
  const rel = homeRel(cwd);
  return rel === '~' ? '' : (rel.split('/').pop() ?? '');
}

// ---------------------------------------------------------------------------
// Spec formats (docs/design/SPEC.md 4.4)
// ---------------------------------------------------------------------------

/** Elapsed counter: "0:42", "12:04", "1:02:04". Tabular in the UI. */
export function elapsedClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Short duration: "41s", "12m", "1h 22m", "3d 4h". */
export function durationShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "in 6 min", "in 1h 22m", "now". */
export function inTime(ts: number, now = Date.now()): string {
  const d = ts - now;
  if (d <= 30_000) return 'now';
  if (d < 3_600_000) return `in ${Math.max(1, Math.round(d / 60_000))} min`;
  return `in ${durationShort(d)}`;
}

/** Counts one to nine as words, 10 and up as digits (status sentences). */
export function countWord(n: number, capital = false): string {
  const w = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n] ?? String(n);
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}

/** "Friday 16 October" */
export function longDate(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}`;
}

/** "16 Oct" */
export function shortDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;
}

/** "14:08" (24 hour). */
export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "14:08" today, "2 Apr, 14:08" another day (an imported message's own time). */
export function dayTime(ts: number, now = Date.now()): string {
  return new Date(ts).toDateString() === new Date(now).toDateString() ? hhmm(ts) : `${shortDate(ts)}, ${hhmm(ts)}`;
}

/** Relative time for lists: "now", "2m", "3h", "Tue", "16 Oct". */
export function relTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const d = now - ts;
  if (d < 45_000) return 'now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  if (d < 6 * 86_400_000) return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' });
  return shortDate(ts);
}
