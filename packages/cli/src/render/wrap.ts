/**
 * ANSI-aware word wrap. Styles open at a line break are closed at the end of
 * the line and reopened on the next, so every line stands on its own.
 */
import { width as strWidth } from '../ansi';

const SGR_RE = /^\x1b\[([0-9;]*)m/;
const OSC_RE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;

/** Which opening SGR params a closing param cancels. */
function cancels(close: number, open: string): boolean {
  const first = Number(open.split(';')[0]);
  switch (close) {
    case 0:
      return true;
    case 22:
      return first === 1 || first === 2;
    case 23:
      return first === 3;
    case 24:
      return first === 4;
    case 27:
      return first === 7;
    case 29:
      return first === 9;
    case 39:
      return (first >= 30 && first <= 37) || (first >= 90 && first <= 97) || first === 38;
    case 49:
      return (first >= 40 && first <= 47) || (first >= 100 && first <= 107) || first === 48;
    default:
      return false;
  }
}

function applySgr(active: string[], params: string): void {
  if (params === '' || params === '0') {
    active.length = 0;
    return;
  }
  const n = Number(params.split(';')[0]);
  const isClose = n === 0 || n === 22 || n === 23 || n === 24 || n === 27 || n === 29 || n === 39 || n === 49;
  if (isClose) {
    for (let i = active.length - 1; i >= 0; i--) if (cancels(n, active[i])) active.splice(i, 1);
  } else active.push(params);
}

interface Token {
  kind: 'ansi' | 'space' | 'word' | 'newline';
  text: string;
  w: number;
}

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const sgr = SGR_RE.exec(rest) ?? OSC_RE.exec(rest);
    if (sgr) {
      out.push({ kind: 'ansi', text: sgr[0], w: 0 });
      i += sgr[0].length;
      continue;
    }
    const ch = s[i];
    if (ch === '\n') {
      out.push({ kind: 'newline', text: '\n', w: 0 });
      i++;
      continue;
    }
    if (ch === ' ') {
      let j = i;
      while (s[j] === ' ') j++;
      out.push({ kind: 'space', text: s.slice(i, j), w: j - i });
      i = j;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== ' ' && s[j] !== '\n' && s[j] !== '\x1b') j++;
    if (j === i) j = i + 1;
    const text = s.slice(i, j);
    out.push({ kind: 'word', text, w: strWidth(text) });
    i = j;
  }
  return out;
}

/** Wrap to `width` columns at spaces. Words longer than a line are broken. */
export function wrapAnsi(s: string, width: number): string {
  if (width <= 0) return s;
  const lines: string[] = [];
  const active: string[] = [];
  let cur = '';
  let curW = 0;
  let pendingSpace = '';
  // Style codes seen after a space wait with it, so a style never starts on the space.
  let pendingAnsi: string[] = [];
  const reopen = () => active.map((a) => `\x1b[${a}m`).join('');
  const flushAnsi = () => {
    for (const a of pendingAnsi) {
      const m = SGR_RE.exec(a);
      if (m) applySgr(active, m[1]);
      cur += a;
    }
    pendingAnsi = [];
  };
  const endLine = (keepSpace: boolean) => {
    lines.push(cur + (keepSpace ? pendingSpace : '') + (active.length ? '\x1b[0m' : ''));
    cur = reopen();
    curW = 0;
    pendingSpace = '';
  };
  for (const t of tokenize(s)) {
    if (t.kind === 'ansi') {
      if (pendingSpace) pendingAnsi.push(t.text);
      else {
        const m = SGR_RE.exec(t.text);
        if (m) applySgr(active, m[1]);
        cur += t.text;
      }
      continue;
    }
    if (t.kind === 'newline') {
      cur += pendingSpace;
      pendingSpace = '';
      flushAnsi();
      endLine(false);
      continue;
    }
    if (t.kind === 'space') {
      pendingSpace += t.text;
      continue;
    }
    const spaceW = pendingSpace.length;
    if (curW + spaceW + t.w <= width) {
      cur += pendingSpace;
      flushAnsi();
      cur += t.text;
      curW += spaceW + t.w;
      pendingSpace = '';
      continue;
    }
    // Does not fit: wrap before the word (the space is dropped).
    if (curW > 0) endLine(false);
    else {
      cur += pendingSpace;
      curW += spaceW;
      pendingSpace = '';
    }
    flushAnsi();
    if (curW + t.w <= width) {
      cur += t.text;
      curW += t.w;
      continue;
    }
    for (const ch of t.text) {
      const cw = strWidth(ch);
      if (curW + cw > width && curW > 0) endLine(false);
      cur += ch;
      curW += cw;
    }
  }
  cur += pendingSpace;
  flushAnsi();
  lines.push(cur);
  return lines.join('\n');
}

/** Prefix every line; `first` for line one and `rest` for the others. */
export function indentLines(s: string, first: string, rest = ' '.repeat(strWidth(first))): string {
  return s
    .split('\n')
    .map((l, i) => (i === 0 ? first : rest) + l)
    .join('\n');
}
