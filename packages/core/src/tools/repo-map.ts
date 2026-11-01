import type { Tool, ToolContext } from './types';
import { displayPath, extname, fail, resolveLoose } from './util';

export interface RepoMapInput {
  path?: string;
  max_files?: number;
  focus?: string;
}

/**
 * Aider-style repository map: the most central source files and their
 * top-level symbols, ranked by how often those symbols are used in other
 * files. Everything goes through the Machine, so it works on remote devices.
 */

const SOURCE_EXT = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'cs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'rb', 'php', 'swift'];
const SOURCE_GLOB = `**/*.{${SOURCE_EXT.join(',')}}`;
const SKIP_DIR_RE = /(^|\/)(node_modules|vendor|third_party|third-party|dist|build|out|target|\.next|\.nuxt|\.svelte-kit|__pycache__|\.venv|venv|coverage|\.git|Pods|DerivedData|bower_components|site-packages|\.gradle|\.cache|generated|__generated__)\//;
const SKIP_FILE_RE = /(\.min\.(js|css)|\.bundle\.js|\.d\.ts|\.pb\.go|_pb2(_grpc)?\.py|\.generated\.\w+|\.g\.dart)$/;
const MAX_CANDIDATES = 5000;
const MAX_PARSE = 600;
const MAX_FILE_BYTES = 256 * 1024;
const BUDGET_CHARS = 24_000;
const MAX_RANK_SYMBOLS = 200;
const MAX_SYMBOLS_PER_FILE = 20;
const DEFAULT_MAX_FILES = 50;

const COMMON_NAMES = new Set([
  'main', 'init', 'test', 'tests', 'setup', 'get', 'set', 'run', 'new', 'data', 'value', 'name', 'type', 'index', 'default',
  'error', 'result', 'config', 'options', 'props', 'state', 'start', 'stop', 'close', 'open', 'read', 'write', 'load', 'save',
  'update', 'create', 'delete', 'remove', 'list', 'item', 'items', 'key', 'keys', 'next', 'self', 'this', 'call', 'apply',
  'handle', 'handler', 'render', 'parse', 'format', 'build', 'string', 'number', 'object', 'array', 'string', 'self', 'from',
  'to', 'map', 'filter', 'reduce', 'push', 'pop', 'size', 'length', 'path', 'file', 'text', 'json', 'emit', 'send', 'request',
  'response', 'Error', 'Object', 'String', 'Array', 'Promise', 'constructor', 'toString', 'valueOf', '__init__', 'New', 'String',
]);

interface Sym {
  name: string;
  line: number;
  sig: string;
  exported: boolean;
  /** 0 for top level, 1 for members. */
  depth: number;
}

interface FileInfo {
  path: string;
  rel: string;
  symbols: Sym[];
  score: number;
  referencedBy: Set<string>;
}

const DESCRIPTION = `Build a compact map of a repository: the most central source files and their top-level symbols (classes, functions, types), ranked by how often their symbols are used elsewhere.

Usage:
- Call it early when you start work in an unfamiliar codebase, to see its structure and where the important code lives, before reading individual files.
- path: repository or subdirectory to map (default: the current working directory).
- focus: optional words related to your task (e.g. "auth session token"); files and symbols matching them rank higher.
- max_files: how many files to show with symbols (default ${DEFAULT_MAX_FILES}). The rest are listed by name.
- The map is a starting point. Read the files that matter before changing them.`;

function sigOf(line: string): string {
  let s = line.trim();
  const brace = s.indexOf('{');
  if (brace > 0) s = s.slice(0, brace).trim();
  s = s.replace(/\s*(=>|:)\s*$/, '').replace(/\s+/g, ' ');
  return s.length > 110 ? s.slice(0, 107) + '...' : s;
}

const JS_TOP = /^(export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const JS_METHOD = /^\s{1,4}(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'new', 'super', 'else', 'do', 'try', 'with', 'yield', 'throw', 'delete', 'void', 'in', 'of', 'elif', 'match', 'sizeof', 'defined']);

function extractJs(lines: string[]): Sym[] {
  const out: Sym[] = [];
  let inClass = false;
  lines.forEach((line, i) => {
    if (line.startsWith('}')) inClass = false;
    const m = line.match(JS_TOP);
    if (m) {
      const kind = m[2];
      const exported = !!m[1];
      if ((kind === 'const' || kind === 'let' || kind === 'var') && !exported && !/=\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|=\s*(async\s+)?function/.test(line)) return;
      out.push({ name: m[3], line: i + 1, sig: sigOf(line), exported, depth: 0 });
      inClass = kind === 'class' && !line.trim().endsWith('}');
      return;
    }
    if (inClass) {
      const mm = line.match(JS_METHOD);
      if (mm && !KEYWORDS.has(mm[1]) && !mm[1].startsWith('#') && !/^\s*(private|protected)\s/.test(line) && !line.trim().endsWith(';')) {
        out.push({ name: mm[1], line: i + 1, sig: sigOf(line), exported: true, depth: 1 });
      }
    }
  });
  return out;
}

function extractPy(lines: string[]): Sym[] {
  const out: Sym[] = [];
  let inClass = false;
  lines.forEach((line, i) => {
    const top = line.match(/^(class|def|async\s+def)\s+([A-Za-z_]\w*)/);
    if (top) {
      out.push({ name: top[2], line: i + 1, sig: sigOf(line.replace(/:\s*$/, '')), exported: !top[2].startsWith('_'), depth: 0 });
      inClass = top[1] === 'class';
      return;
    }
    if (/^\S/.test(line) && line.trim()) inClass = false;
    if (inClass) {
      const mm = line.match(/^(?: {4}|\t)(?:async\s+)?def\s+([A-Za-z_]\w*)/);
      if (mm && (!mm[1].startsWith('_') || mm[1] === '__init__')) out.push({ name: mm[1], line: i + 1, sig: sigOf(line.replace(/:\s*$/, '')), exported: true, depth: 1 });
    }
  });
  return out;
}

function extractGo(lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((line, i) => {
    let m = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/);
    if (m) {
      out.push({ name: m[1], line: i + 1, sig: sigOf(line), exported: /^[A-Z]/.test(m[1]), depth: /^func\s+\(/.test(line) ? 1 : 0 });
      return;
    }
    m = line.match(/^type\s+([A-Za-z_]\w*)\s/);
    if (m) {
      out.push({ name: m[1], line: i + 1, sig: sigOf(line), exported: /^[A-Z]/.test(m[1]), depth: 0 });
      return;
    }
    m = line.match(/^(?:var|const)\s+([A-Z]\w*)/);
    if (m) out.push({ name: m[1], line: i + 1, sig: sigOf(line), exported: true, depth: 0 });
  });
  return out;
}

function extractRust(lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s{0,4})(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"\w+"\s+)?(fn|struct|enum|trait|type|mod|const|static|union)\s+([A-Za-z_]\w*)/);
    if (m) {
      if (m[3] === 'mod' && line.trim().endsWith(';')) return;
      out.push({ name: m[4], line: i + 1, sig: sigOf(line), exported: !!m[2], depth: m[1].length ? 1 : 0 });
      return;
    }
    const impl = line.match(/^impl(?:<[^>]*>)?\s+(?:([\w:<>, ]+?)\s+for\s+)?([\w:]+)/);
    if (impl) out.push({ name: impl[2], line: i + 1, sig: sigOf(line), exported: false, depth: 0 });
  });
  return out;
}

const JVM_TYPE = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|abstract|final|static|sealed|open|data|inner|partial|override|enum|annotation|value|case)\s+)*(class|interface|enum|record|object|struct|trait)\s+([A-Za-z_]\w*)/;
const JAVA_METHOD = /^\s{2,8}(?:(?:public|protected|static|final|abstract|synchronized|override|virtual|async|internal|default)\s+)+[\w<>[\],.? ]+?\s+([a-zA-Z_]\w*)\s*\(/;
const KOTLIN_FUN = /^\s*(?:(?:public|protected|internal|override|suspend|inline|open|abstract|operator|infix)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([a-zA-Z_]\w*)\s*\(/;
const SCALA_DEF = /^\s*(?:(?:override|final|protected|implicit)\s+)*def\s+([a-zA-Z_]\w*)/;

function extractJvm(lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const t = line.match(JVM_TYPE);
    if (t) {
      out.push({ name: t[2], line: i + 1, sig: sigOf(line), exported: !/\bprivate\b/.test(line), depth: line.match(/^\s*/)![0].length ? 1 : 0 });
      return;
    }
    const m = line.match(JAVA_METHOD) ?? line.match(KOTLIN_FUN) ?? line.match(SCALA_DEF);
    if (m && !KEYWORDS.has(m[1]) && !/\bprivate\b/.test(line)) out.push({ name: m[1], line: i + 1, sig: sigOf(line), exported: true, depth: 1 });
  });
  return out;
}

function extractSwift(lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|static|final|override|mutating|class)\s+)*(func|class|struct|enum|protocol|extension|actor|typealias)\s+([A-Za-z_]\w*)/);
    if (m && !/\b(private|fileprivate)\b/.test(line)) out.push({ name: m[3], line: i + 1, sig: sigOf(line), exported: true, depth: m[1].length ? 1 : 0 });
  });
  return out;
}

function extractC(lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((line, i) => {
    let m = line.match(/^(?:typedef\s+)?(struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)/);
    if (m && !line.trim().endsWith(';')) {
      out.push({ name: m[2], line: i + 1, sig: sigOf(line), exported: true, depth: 0 });
      return;
    }
    if (!/^[A-Za-z_]/.test(line) || /^(return|if|else|while|for|switch|case|do|goto|typedef|using|extern\s+"C"|#)/.test(line) || line.trim().endsWith(';')) return;
    m = line.match(/^(?:static\s+|inline\s+|extern\s+|const\s+|virtual\s+|unsigned\s+|signed\s+)*[A-Za-z_][\w:<>,*& ]*?[\s*&]+([A-Za-z_~][\w:~]*)\s*\(/);
    if (m && !KEYWORDS.has(m[1])) out.push({ name: m[1].split('::').pop()!, line: i + 1, sig: sigOf(line), exported: !line.startsWith('static'), depth: 0 });
  });
  return out;
}

function extractRuby(lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((line, i) => {
    let m = line.match(/^(\s*)(class|module)\s+([A-Z][\w:]*)/);
    if (m) {
      out.push({ name: m[3].split('::').pop()!, line: i + 1, sig: sigOf(line), exported: true, depth: m[1].length ? 1 : 0 });
      return;
    }
    m = line.match(/^(\s*)def\s+(self\.)?([\w?!=]+)/);
    if (m) out.push({ name: m[3], line: i + 1, sig: sigOf(line), exported: true, depth: m[1].length ? 1 : 0 });
  });
  return out;
}

function extractPhp(lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((line, i) => {
    let m = line.match(/^\s*(?:abstract\s+|final\s+|readonly\s+)*(class|interface|trait|enum)\s+(\w+)/);
    if (m) {
      out.push({ name: m[2], line: i + 1, sig: sigOf(line), exported: true, depth: 0 });
      return;
    }
    m = line.match(/^(\s*)(?:(?:public|protected|static|abstract|final)\s+)*function\s+&?(\w+)/);
    if (m && !/\bprivate\b/.test(line)) out.push({ name: m[2], line: i + 1, sig: sigOf(line), exported: true, depth: m[1].length ? 1 : 0 });
  });
  return out;
}

export function extractSymbols(path: string, text: string): Sym[] {
  const lines = text.split('\n');
  switch (extname(path)) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return extractJs(lines);
    case 'py':
      return extractPy(lines);
    case 'go':
      return extractGo(lines);
    case 'rs':
      return extractRust(lines);
    case 'java':
    case 'kt':
    case 'kts':
    case 'scala':
    case 'cs':
      return extractJvm(lines);
    case 'swift':
      return extractSwift(lines);
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hpp':
    case 'hh':
      return extractC(lines);
    case 'rb':
      return extractRuby(lines);
    case 'php':
      return extractPhp(lines);
    default:
      return [];
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Count cross-file references to candidate symbols with one ripgrep pass. */
async function countReferences(ctx: ToolContext, root: string, names: string[]): Promise<Map<string, Map<string, number>>> {
  const refs = new Map<string, Map<string, number>>();
  if (!names.length) return refs;
  const alternation = names.map(escapeRe).join('|');
  let output = '';
  try {
    const res = await ctx.machine.grep({ pattern: `\\b(?:${alternation})\\b`, path: root, glob: SOURCE_GLOB, outputMode: 'content', lineNumbers: false, limit: 40_000 });
    output = res.output;
  } catch {
    return refs;
  }
  const re = new RegExp(`(?<![\\w$])(${alternation})(?![\\w$])`, 'g');
  for (const line of output.split('\n')) {
    const colon = line.indexOf(':', line.startsWith('/') ? 1 : 3);
    if (colon === -1) continue;
    const file = line.slice(0, colon);
    const content = line.slice(colon + 1);
    for (const m of content.matchAll(re)) {
      let byFile = refs.get(m[1]);
      if (!byFile) refs.set(m[1], (byFile = new Map()));
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    }
  }
  return refs;
}

export const RepoMapTool: Tool<RepoMapInput> = {
  name: 'RepoMap',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to map (default: current working directory)' },
      max_files: { type: 'integer', description: `Files to show with symbols (default ${DEFAULT_MAX_FILES})`, minimum: 1, maximum: 300 },
      focus: { type: 'string', description: 'Words related to the task; matching files rank higher' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  ruleContent: (input, ctx) => resolveLoose(ctx, input.path),
  summarize: (input) => `Map repository${input.path ? ` ${input.path}` : ''}${input.focus ? ` (focus: ${input.focus})` : ''}`,
  async run(input, ctx) {
    const root = resolveLoose(ctx, input.path);
    const st = await ctx.machine.stat(root);
    if (!st || st.type !== 'dir') return fail(`Not a directory: ${root}`);
    const maxFiles = Math.min(300, Math.max(1, Math.floor(input.max_files ?? DEFAULT_MAX_FILES)));
    const focusWords = (input.focus ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 2)
      // crude stemming so "permissions" also matches "permission"
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));

    let found: string[];
    try {
      found = await ctx.machine.glob(SOURCE_GLOB, { cwd: root, limit: MAX_CANDIDATES });
    } catch (err) {
      return fail(`Could not list files: ${(err as Error).message}`);
    }
    const all = found.filter((p) => {
      const rel = displayPath(p, root);
      return !SKIP_DIR_RE.test(rel) && !SKIP_FILE_RE.test(rel);
    });
    if (!all.length) return { content: `No source files found under ${root}.` };

    // Parse the most recently touched files first; very large repos only get partial symbol coverage.
    const toParse = all.slice(0, MAX_PARSE);
    const files: FileInfo[] = (
      await mapLimit(toParse, 16, async (path) => {
        try {
          const s = await ctx.machine.stat(path);
          if (!s || s.size > MAX_FILE_BYTES) return { path, rel: displayPath(path, root), symbols: [], score: 0, referencedBy: new Set<string>() };
          const text = await ctx.machine.readText(path);
          return { path, rel: displayPath(path, root), symbols: extractSymbols(path, text), score: 0, referencedBy: new Set<string>() };
        } catch {
          return { path, rel: displayPath(path, root), symbols: [], score: 0, referencedBy: new Set<string>() };
        }
      })
    ).filter(Boolean);

    // Pick symbols worth counting: distinctive names defined in at most two files.
    const definedIn = new Map<string, Set<string>>();
    for (const f of files) for (const s of f.symbols) {
      if (!definedIn.has(s.name)) definedIn.set(s.name, new Set());
      definedIn.get(s.name)!.add(f.path);
    }
    const candidates = new Map<string, { exported: boolean; top: boolean }>();
    for (const f of files) for (const s of f.symbols) {
      if (s.name.length < 4 || COMMON_NAMES.has(s.name) || (definedIn.get(s.name)?.size ?? 0) > 2) continue;
      const prev = candidates.get(s.name);
      candidates.set(s.name, { exported: (prev?.exported ?? false) || s.exported, top: (prev?.top ?? false) || s.depth === 0 });
    }
    const ranked = [...candidates.entries()]
      .sort((a, b) => Number(b[1].exported) - Number(a[1].exported) || Number(b[1].top) - Number(a[1].top) || b[0].length - a[0].length)
      .slice(0, MAX_RANK_SYMBOLS)
      .map(([name]) => name);
    const refs = await countReferences(ctx, root, ranked);

    for (const f of files) {
      let score = 0;
      for (const s of f.symbols) {
        const byFile = refs.get(s.name);
        if (!byFile) continue;
        let cross = 0;
        for (const [file, n] of byFile) {
          if (file === f.path || definedIn.get(s.name)?.has(file)) continue;
          cross += n;
          f.referencedBy.add(file);
        }
        score += Math.sqrt(cross) * (s.exported ? 1 : 0.5);
      }
      score += 1.5 * f.referencedBy.size;
      score += Math.min(f.symbols.length, 20) * 0.05;
      const base = f.rel.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
      if (['index', 'main', 'app', 'server', 'cli', 'lib', 'mod', '__init__', 'types'].includes(base)) score += 1;
      if (/(^|\/)(test|tests|__tests__|spec|e2e)\/|\.(test|spec)\.\w+$|_test\.\w+$/.test(f.rel)) score *= 0.3;
      f.score = score;
    }
    if (focusWords.length) {
      // Boosts are relative to the most central file so a focused file can outrank a hub like types.ts.
      const top = Math.max(1, ...files.map((f) => f.score));
      for (const f of files) {
        const rel = f.rel.toLowerCase();
        let boost = 0;
        for (const w of focusWords) {
          if (rel.includes(w)) boost += 1.5;
          boost += 0.6 * Math.min(2, f.symbols.filter((s) => s.name.toLowerCase().includes(w)).length);
        }
        f.score += top * boost;
      }
    }
    files.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

    const header = `Repository map of ${root}: ${all.length}${found.length >= MAX_CANDIDATES ? '+' : ''} source files${all.length > files.length ? ` (${files.length} most recently changed were analyzed)` : ''}, ranked by cross-file references${focusWords.length ? ` and focus "${input.focus}"` : ''}.`;
    const out: string[] = [header, ''];
    let used = header.length;
    let detailed = 0;
    const shown = new Set<string>();
    for (const f of files) {
      if (detailed >= maxFiles || used > BUDGET_CHARS * 0.85) break;
      if (!f.symbols.length) continue;
      const syms = [...f.symbols].sort((a, b) => a.line - b.line);
      // Exported API first; private top-level helpers only when the file exports little.
      const exported = syms.filter((s) => s.exported);
      const keep = (exported.length >= 3 ? exported : syms.filter((s) => s.depth === 0 || s.exported)).slice(0, MAX_SYMBOLS_PER_FILE);
      const block = [`${f.rel}${f.referencedBy.size ? `  (used by ${f.referencedBy.size} file${f.referencedBy.size === 1 ? '' : 's'})` : ''}`];
      for (const s of keep) block.push(`${s.depth ? '    ' : '  '}${s.line}: ${s.sig}`);
      if (syms.length > keep.length) block.push(`  ... ${syms.length - keep.length} more symbols`);
      const text = block.join('\n');
      if (used + text.length > BUDGET_CHARS && detailed > 0) break;
      out.push(text);
      used += text.length + 1;
      detailed++;
      shown.add(f.path);
    }

    // Remaining files, grouped by directory, as long as the budget allows.
    const rest = all.filter((p) => !shown.has(p));
    if (rest.length) {
      const byDir = new Map<string, string[]>();
      for (const p of rest) {
        const rel = displayPath(p, root);
        const slash = rel.lastIndexOf('/');
        const dir = slash === -1 ? '.' : rel.slice(0, slash);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir)!.push(rel.slice(slash + 1));
      }
      out.push('', `Other files (${rest.length}):`);
      const dirs = [...byDir.keys()].sort();
      let omitted = 0;
      for (const dir of dirs) {
        const names = byDir.get(dir)!.sort();
        let line = `${dir}/: ${names.join(' ')}`;
        if (line.length > 400) line = `${dir}/: ${names.slice(0, 15).join(' ')} ... (${names.length} files)`;
        if (used + line.length > BUDGET_CHARS) {
          omitted += names.length;
          continue;
        }
        out.push(line);
        used += line.length + 1;
      }
      if (omitted) out.push(`(${omitted} more files not listed; use Glob to explore further.)`);
    }
    return { content: out.join('\n'), meta: { files: all.length, detailed } };
  },
};
