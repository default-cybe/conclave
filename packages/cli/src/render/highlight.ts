/**
 * Basic syntax highlighting for fenced code: keywords, strings, comments,
 * numbers, function calls and capitalized types. One pass per line, no
 * grammar, good enough for chat output.
 */
import type { Painter } from '../ansi';

export const CODE_COLORS = {
  keyword: '#569CD6',
  control: '#C586C0',
  string: '#CE9178',
  comment: '#6A9955',
  number: '#B5CEA8',
  func: '#DCDCAA',
  type: '#4EC9B0',
  text: '#D4D4D4',
  add: '#4EC9B0',
  del: '#F48771',
  meta: '#808080',
};

const JS = 'const let var function class extends implements interface type enum import export from as default new this super typeof instanceof in of void delete async await yield static public private protected readonly abstract declare namespace module keyof infer satisfies get set null undefined true false';
const CONTROL = 'if else for while do switch case break continue return throw try catch finally goto match when loop';
const PY = 'def class import from as lambda with pass global nonlocal assert del is not and or in None True False self async await yield raise except elif print';
const GO = 'package import func var const type struct interface map chan go defer select range fallthrough nil true false make new len cap append';
const RUST = 'fn let mut pub use mod impl trait struct enum where self Self crate super ref move dyn unsafe extern as const static type async await Some None Ok Err true false';
const SH = 'echo export local readonly set unset source alias cd then fi esac elif done in function exit sudo';
const SQL = 'select from where insert into values update set delete create table index drop alter add join left right inner outer on group by order having limit offset as and or not null is primary key references distinct union all case when then else end';
const C = 'int char float double long short unsigned signed void bool struct union enum typedef static const extern sizeof include define ifdef ifndef endif auto class public private protected virtual template typename namespace using new delete nullptr true false std';
const JAVA = 'class interface extends implements public private protected static final abstract new this super void int long double float boolean char byte short package import null true false instanceof throws synchronized var val fun object data sealed override open companion';

const LANG_KEYWORDS: Record<string, string> = {
  js: JS,
  ts: JS,
  py: PY,
  go: GO,
  rs: RUST,
  sh: SH,
  sql: SQL,
  c: C,
  java: JAVA,
};

const ALIASES: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  typescript: 'ts',
  tsx: 'ts',
  python: 'py',
  python3: 'py',
  golang: 'go',
  rust: 'rs',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  fish: 'sh',
  console: 'sh',
  ps1: 'sh',
  powershell: 'sh',
  cpp: 'c',
  'c++': 'c',
  cc: 'c',
  h: 'c',
  hpp: 'c',
  cs: 'java',
  csharp: 'java',
  kotlin: 'java',
  kt: 'java',
  scala: 'java',
  swift: 'java',
  dart: 'java',
  postgres: 'sql',
  sqlite: 'sql',
  mysql: 'sql',
  yml: 'yaml',
  jsonc: 'json',
  json5: 'json',
  rb: 'py',
  ruby: 'py',
  patch: 'diff',
};

export function normalizeLang(lang: string | undefined): string {
  const l = (lang ?? '').toLowerCase().trim();
  return ALIASES[l] ?? l;
}

const keywordCache = new Map<string, Set<string>>();
function keywordsFor(lang: string): Set<string> {
  let set = keywordCache.get(lang);
  if (!set) {
    const words = LANG_KEYWORDS[lang] ?? `${JS} ${PY} ${GO} ${RUST}`;
    set = new Set(`${words} ${CONTROL}`.split(/\s+/).filter(Boolean));
    keywordCache.set(lang, set);
  }
  return set;
}
const CONTROL_SET = new Set(CONTROL.split(' '));

function lineCommentFor(lang: string): string[] {
  if (['py', 'sh', 'yaml', 'toml', 'ini', 'dockerfile', 'makefile', 'r', 'conf', 'nix'].includes(lang)) return ['#'];
  if (['sql', 'lua', 'haskell'].includes(lang)) return ['--'];
  if (lang === 'json') return [];
  return ['//', '#'];
}

/** Highlight one line. Block comments are tracked with the returned state. */
export function highlightLine(line: string, lang: string, p: Painter, state: { inBlock?: boolean } = {}): string {
  const l = normalizeLang(lang);
  if (!p.enabled) return line;
  if (l === 'diff') {
    if (/^(\+\+\+|---)/.test(line)) return p.bold(p.fg(CODE_COLORS.meta)(line));
    if (line.startsWith('+')) return p.fg(CODE_COLORS.add)(line);
    if (line.startsWith('-')) return p.fg(CODE_COLORS.del)(line);
    if (line.startsWith('@@')) return p.fg(CODE_COLORS.keyword)(line);
    return line;
  }
  if (l === 'text' || l === 'txt' || l === 'plain' || l === 'markdown' || l === 'md' || l === 'output') return line;
  const kw = keywordsFor(l);
  const lineComments = lineCommentFor(l);
  // In C-like languages '#' is a preprocessor or private-field marker, only a comment at line start.
  const hashOnlyAtStart = !['py', 'sh', 'yaml', 'toml', 'ini', 'dockerfile', 'makefile', 'r', 'conf', 'nix'].includes(l);
  const c = CODE_COLORS;
  let out = '';
  let i = 0;
  if (state.inBlock) {
    const end = line.indexOf('*/');
    if (end < 0) return p.fg(c.comment)(line);
    out += p.fg(c.comment)(line.slice(0, end + 2));
    i = end + 2;
    state.inBlock = false;
  }
  while (i < line.length) {
    const ch = line[i];
    const rest = line.slice(i);
    // comments
    if (rest.startsWith('/*') && l !== 'py' && l !== 'sh') {
      const end = line.indexOf('*/', i + 2);
      if (end < 0) {
        out += p.fg(c.comment)(rest);
        state.inBlock = true;
        return out;
      }
      out += p.fg(c.comment)(line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    const lc = lineComments.find((m) => rest.startsWith(m));
    if (lc && !(lc === '#' && hashOnlyAtStart && line.slice(0, i).trim() !== '') && !(lc === '#' && /^#!?\[/.test(rest) && l === 'rs')) {
      out += p.fg(c.comment)(rest);
      return out;
    }
    // strings
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === '\\') j++;
        j++;
      }
      const s = line.slice(i, Math.min(j + 1, line.length));
      // JSON keys read better in the keyword color.
      const isKey = l === 'json' && /^\s*:/.test(line.slice(j + 1));
      out += p.fg(isKey ? c.keyword : c.string)(s);
      i = j + 1;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch) && !/[A-Za-z_$]/.test(line[i - 1] ?? '')) {
      const m = /^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?[a-zA-Z]*)/.exec(rest);
      if (m) {
        out += p.fg(c.number)(m[0]);
        i += m[0].length;
        continue;
      }
    }
    // words
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = /^[A-Za-z_$@][\w$]*/.exec(rest)!;
      const w = m[0];
      const after = line.slice(i + w.length);
      if (kw.has(w) || (l === 'sql' && kw.has(w.toLowerCase()))) {
        out += p.fg(CONTROL_SET.has(w) ? c.control : c.keyword)(w);
      } else if (/^\s*\(/.test(after)) out += p.fg(c.func)(w);
      else if (/^[A-Z][a-z0-9]/.test(w) && l !== 'sql') out += p.fg(c.type)(w);
      else out += w;
      i += w.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
