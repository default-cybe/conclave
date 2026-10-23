/**
 * Tiny ANSI styling. A Painter is either on or off so tests and pipes get
 * plain text. Nested styles reopen after an inner close, like chalk does.
 */
import stringWidth from 'string-width';

export interface Painter {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  italic(s: string): string;
  underline(s: string): string;
  inverse(s: string): string;
  strike(s: string): string;
  /** Named color (red, gray, cyanBright...) or #rrggbb. */
  fg(color: string): (s: string) => string;
  bg(color: string): (s: string) => string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

const NAMED: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97,
};

export function hexToRgb(hex: string): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** Nearest xterm-256 color: the 6x6x6 cube (non-linear steps) or the gray ramp. */
export function rgbTo256(r: number, g: number, b: number): number {
  const nearest = (v: number) => {
    let best = 0;
    for (let i = 1; i < CUBE.length; i++) if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i;
    return best;
  };
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (CUBE[ri] - r) ** 2 + (CUBE[gi] - g) ** 2 + (CUBE[bi] - b) ** 2;
  const avg = (r + g + b) / 3;
  const grayIdx = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + grayIdx * 10;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return grayDist < cubeDist ? 232 + grayIdx : cube;
}

export function supportsTruecolor(env: Record<string, string | undefined> = process.env): boolean {
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return true;
  const tp = env.TERM_PROGRAM ?? '';
  if (['iTerm.app', 'vscode', 'WezTerm', 'ghostty', 'Hyper', 'Tabby'].includes(tp)) return true;
  const term = env.TERM ?? '';
  return /kitty|ghostty|alacritty|direct|truecolor/.test(term);
}

/** Color on for a TTY unless NO_COLOR. FORCE_COLOR forces it on (or off with 0). */
export function colorEnabledFor(stream: { isTTY?: boolean } | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.TERM === 'dumb') return false;
  return !!stream?.isTTY;
}

export function createPainter(opts: { enabled: boolean; truecolor?: boolean }): Painter {
  const on = opts.enabled;
  const tc = opts.truecolor ?? supportsTruecolor();
  const wrap = (open: string, close: string) => (s: string) => {
    if (!on || s === '') return s;
    return open + s.split(close).join(close + open) + close;
  };
  const colorCode = (color: string, background: boolean): string | undefined => {
    const named = NAMED[color];
    if (named !== undefined) return `\x1b[${background ? named + 10 : named}m`;
    const rgb = hexToRgb(color);
    if (!rgb) return undefined;
    const base = background ? 48 : 38;
    return tc ? `\x1b[${base};2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[${base};5;${rgbTo256(...rgb)}m`;
  };
  const cache = new Map<string, (s: string) => string>();
  const color = (c: string, background: boolean) => {
    const key = (background ? 'bg:' : 'fg:') + c;
    let fn = cache.get(key);
    if (!fn) {
      const open = colorCode(c, background);
      fn = open ? wrap(open, background ? '\x1b[49m' : '\x1b[39m') : (s: string) => s;
      cache.set(key, fn);
    }
    return fn;
  };
  const fg = (c: string) => color(c, false);
  return {
    enabled: on,
    bold: wrap('\x1b[1m', '\x1b[22m'),
    dim: wrap('\x1b[2m', '\x1b[22m'),
    italic: wrap('\x1b[3m', '\x1b[23m'),
    underline: wrap('\x1b[4m', '\x1b[24m'),
    inverse: wrap('\x1b[7m', '\x1b[27m'),
    strike: wrap('\x1b[9m', '\x1b[29m'),
    fg,
    bg: (c: string) => color(c, true),
    red: fg('red'),
    green: fg('green'),
    yellow: fg('yellow'),
    blue: fg('blue'),
    magenta: fg('magenta'),
    cyan: fg('cyan'),
    gray: fg('gray'),
  };
}

/** Painter for stdout. */
export const out = createPainter({ enabled: colorEnabledFor(process.stdout) });
/** Painter for stderr. */
export const err = createPainter({ enabled: colorEnabledFor(process.stderr) });
/** Painter for Ink output. The TUI only runs on a TTY, so only NO_COLOR turns it off. */
export const tui = createPainter({ enabled: !process.env.NO_COLOR });

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Text a tool or a model wrote, with its control characters shown as
 * symbols (ESC as ␛) instead of sent to the terminal, so it cannot hide
 * part of a command or move the cursor. Newlines and tabs stay.
 */
export function visible(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => (c < ' ' ? String.fromCharCode(0x2400 + c.charCodeAt(0)) : c === '\x7f' ? '␡' : '�'));
}

/** Display width in terminal columns, ignoring ANSI codes. */
export function width(s: string): number {
  return stringWidth(s);
}

export function padEnd(s: string, w: number): string {
  const n = width(s);
  return n >= w ? s : s + ' '.repeat(w - n);
}

export function padStart(s: string, w: number): string {
  const n = width(s);
  return n >= w ? s : ' '.repeat(w - n) + s;
}

/** Cut text to a display width with an ellipsis. ANSI codes are kept whole and reset at the cut. */
export function truncate(s: string, w: number): string {
  if (w <= 0) return '';
  if (width(s) <= w) return s;
  let outStr = '';
  let used = 0;
  let styled = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]|^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
      if (m) {
        outStr += m[0];
        styled = true;
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = width(ch);
    if (used + cw > w - 1) break;
    outStr += ch;
    used += cw;
    i += ch.length;
  }
  return outStr + '…' + (styled ? '\x1b[0m' : '');
}
