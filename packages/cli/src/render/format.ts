import { homedir } from 'node:os';
import { relative, isAbsolute, sep } from 'node:path';

export function formatTokens(n: number | undefined): string {
  const v = n ?? 0;
  if (v < 1000) return String(v);
  if (v < 10_000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (v < 1_000_000) return Math.round(v / 1000) + 'k';
  return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function formatCost(usd: number | undefined): string {
  const v = usd ?? 0;
  if (v === 0) return '$0';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v < 10) return '$' + v.toFixed(2);
  return '$' + v.toFixed(1);
}

/** " · worth $12 at API prices" when a plan served calls an API key would have billed; else nothing. */
export function worth(billed: number, value: number | undefined): string {
  return value !== undefined && value - billed >= 0.005 ? ` · worth ${formatCost(value)} at API prices` : '';
}

/** 3725000 -> "1h02m", 65000 -> "1m05s", 9000 -> "9s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d${h ? h + 'h' : ''}`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '-';
  const d = now - ts;
  if (d < 0) return 'in ' + formatDuration(-d);
  if (d < 45_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 30 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** ~ for home, and keep only the last parts when long. */
export function shortenPath(p: string, max = 40, home = homedir()): string {
  let s = p;
  if (home && (s === home || s.startsWith(home + sep) || s.startsWith(home + '/'))) s = '~' + s.slice(home.length);
  if (s.length <= max) return s;
  const parts = s.split(/[\\/]/);
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + out;
    if (next.length + 2 > max) break;
    out = next;
  }
  return '…/' + out;
}

/** Path relative to cwd when inside it, else shortened absolute. */
export function displayPath(p: string, cwd?: string): string {
  if (!p) return p;
  if (cwd && isAbsolute(p)) {
    const rel = relative(cwd, p);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    if (rel === '') return '.';
  }
  return shortenPath(p, 60);
}

export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function percent(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? '-' : `${Math.round(n)}%`;
}
