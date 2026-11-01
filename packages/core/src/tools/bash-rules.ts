/**
 * Shell command analysis for the Bash tool: a small quote-aware parser, a
 * conservative read-only classifier, and "always allow" rule suggestions.
 *
 * The classifier only says "read-only" when it is sure. Anything it does not
 * understand (command substitution, subshells, redirects to files, unknown
 * commands, env assignments) counts as not read-only and goes through the
 * normal approval flow.
 */

export interface ParsedCommand {
  /** Words of each simple command, split on | || && ; & and newlines. */
  segments: string[][];
  /** Separators between segments. */
  separators: string[];
  /** Constructs that make static analysis unreliable. */
  unsafe: string[];
}

function readTarget(cmd: string, k: number): [string, number] {
  while (k < cmd.length && (cmd[k] === ' ' || cmd[k] === '\t')) k++;
  let t = '';
  while (k < cmd.length && !/[\s;|&<>()]/.test(cmd[k])) {
    const c = cmd[k];
    if (c === "'" || c === '"') {
      const j = cmd.indexOf(c, k + 1);
      if (j === -1) return [t + cmd.slice(k + 1), cmd.length];
      t += cmd.slice(k + 1, j);
      k = j + 1;
      continue;
    }
    t += c;
    k++;
  }
  return [t, k];
}

/**
 * Index just past the quoted text that starts at i: '...', "..." or $'...'.
 * -1 when it never closes. Only "..." and $'...' read a backslash as an escape.
 */
export function quoteEnd(cmd: string, i: number): number {
  const ansi = cmd[i] === '$';
  const q = ansi ? "'" : cmd[i];
  const escapes = ansi || q === '"';
  for (let k = ansi ? i + 2 : i + 1; k < cmd.length; k++) {
    if (escapes && cmd[k] === '\\') k++;
    else if (cmd[k] === q) return k + 1;
  }
  return -1;
}

/** Whether a # at i starts a comment: it begins a word. */
export function startsComment(cmd: string, i: number): boolean {
  return i === 0 || /[\s;|&()]/.test(cmd[i - 1]);
}

export interface Heredoc {
  delim: string;
  /** <<- strips leading tabs from body lines. */
  strip: boolean;
  /** A quoted delimiter keeps the body literal; otherwise the shell expands $( ) and backticks in it. */
  quoted: boolean;
}

/** The heredoc a `<<` at i opens (a `<<<` here-string is none), and the index after its delimiter word. */
export function readHeredoc(cmd: string, i: number): { doc: Heredoc; next: number } | undefined {
  if (cmd[i] !== '<' || cmd[i + 1] !== '<' || cmd[i + 2] === '<' || cmd[i - 1] === '<') return undefined;
  let k = i + 2;
  const strip = cmd[k] === '-';
  if (strip) k++;
  while (cmd[k] === ' ' || cmd[k] === '\t') k++;
  const [word, next] = readTarget(cmd, k);
  const delim = word.replace(/\\(.)/g, '$1');
  return delim ? { doc: { delim, strip, quoted: /['"\\]/.test(cmd.slice(k, next)) }, next } : undefined;
}

/**
 * The body lines of the heredocs opened on the line that ended just before
 * `start`, and where the command goes on after the last delimiter line. The
 * body is text, so a quote in it must not hide the lines after it.
 */
export function heredocLines(cmd: string, start: number, docs: Heredoc[]): { lines: Array<{ text: string; expanded: boolean }>; next: number } {
  const lines: Array<{ text: string; expanded: boolean }> = [];
  let k = start;
  for (const doc of docs) {
    while (k < cmd.length) {
      const nl = cmd.indexOf('\n', k);
      const text = cmd.slice(k, nl === -1 ? cmd.length : nl);
      k = nl === -1 ? cmd.length : nl + 1;
      if ((doc.strip ? text.replace(/^\t+/, '') : text) === doc.delim) break;
      lines.push({ text, expanded: !doc.quoted });
    }
  }
  return { lines, next: k };
}

export function parseCommand(cmd: string): ParsedCommand {
  const segments: string[][] = [[]];
  const separators: string[] = [];
  const unsafe: string[] = [];
  let word = '';
  let inWord = false;
  const pushWord = () => {
    if (inWord) segments[segments.length - 1].push(word);
    word = '';
    inWord = false;
  };
  const newSeg = (sep: string) => {
    pushWord();
    segments.push([]);
    separators.push(sep);
  };
  let docs: Heredoc[] = [];
  const n = cmd.length;
  for (let i = 0; i < n; i++) {
    const c = cmd[i];
    if (c === '\\') {
      if (i + 1 < n) {
        if (cmd[i + 1] !== '\n') {
          word += cmd[i + 1];
          inWord = true;
        }
        i++;
      }
      continue;
    }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j === -1) {
        unsafe.push('unterminated quote');
        word += cmd.slice(i + 1);
        inWord = true;
        break;
      }
      word += cmd.slice(i + 1, j);
      inWord = true;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < n && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < n) {
          buf += cmd[j + 1];
          j += 2;
          continue;
        }
        if (cmd[j] === '`' || (cmd[j] === '$' && cmd[j + 1] === '(')) unsafe.push('command substitution');
        buf += cmd[j];
        j++;
      }
      if (j >= n) unsafe.push('unterminated quote');
      word += buf;
      inWord = true;
      i = j;
      continue;
    }
    if (c === '`') {
      unsafe.push('command substitution');
      continue;
    }
    if (c === '$' && cmd[i + 1] === "'") {
      // $'...' reads \' as a quote inside; a scanner that does not would end it early
      unsafe.push('ansi-c quote');
      const end = quoteEnd(cmd, i);
      if (end === -1) unsafe.push('unterminated quote');
      word += cmd.slice(i + 2, end === -1 ? n : end - 1);
      inWord = true;
      i = end === -1 ? n : end - 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      unsafe.push('command substitution');
      word += c;
      inWord = true;
      continue;
    }
    if (c === '#' && !inWord) {
      const j = cmd.indexOf('\n', i);
      if (j === -1) break;
      i = j - 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      continue;
    }
    if (c === '\n' || c === ';') {
      newSeg(';');
      if (c === '\n' && docs.length) {
        // each body line stays a segment of its own, split on blanks only
        const body = heredocLines(cmd, i + 1, docs);
        for (const line of body.lines) {
          segments[segments.length - 1].push(...line.text.split(/\s+/).filter(Boolean));
          if (line.expanded && /\$\(|`/.test(line.text)) unsafe.push('command substitution');
          newSeg(';');
        }
        docs = [];
        i = body.next - 1;
      }
      continue;
    }
    if (c === '|') {
      if (cmd[i + 1] === '|') {
        newSeg('||');
        i++;
      } else if (cmd[i + 1] === '&') {
        newSeg('|&');
        i++;
      } else newSeg('|');
      continue;
    }
    if (c === '&') {
      if (cmd[i + 1] === '&') {
        newSeg('&&');
        i++;
        continue;
      }
      if (cmd[i + 1] === '>') {
        // &> file or &>> file
        pushWord();
        let k = i + 2;
        if (cmd[k] === '>') k++;
        const [target, next] = readTarget(cmd, k);
        if (target !== '/dev/null') unsafe.push('redirect to file');
        i = next - 1;
        continue;
      }
      unsafe.push('background job');
      newSeg('&');
      continue;
    }
    const doc = c === '<' ? readHeredoc(cmd, i) : undefined;
    if (doc) {
      pushWord();
      unsafe.push('heredoc');
      docs.push(doc.doc);
      i = doc.next - 1;
      continue;
    }
    if (c === '>' || c === '<') {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else pushWord();
      let k = i + 1;
      if (c === '<') {
        if (cmd[k] === '(') unsafe.push('process substitution');
        else if (cmd[k] === '<') unsafe.push('heredoc');
        else if (cmd[k] === '>') unsafe.push('read-write redirect');
        if (cmd[k] === '&') {
          k++;
          while (k < n && /[\d-]/.test(cmd[k])) k++;
          i = k - 1;
          continue;
        }
        const [, next] = readTarget(cmd, k);
        i = next - 1;
        continue;
      }
      if (cmd[k] === '(') {
        unsafe.push('process substitution');
        continue;
      }
      if (cmd[k] === '>' || cmd[k] === '|') k++;
      if (cmd[k] === '&') {
        k++;
        const start = k;
        while (k < n && /[\d-]/.test(cmd[k])) k++;
        if (k === start) {
          const [target, next] = readTarget(cmd, k);
          if (target !== '/dev/null') unsafe.push('redirect to file');
          k = next;
        }
        i = k - 1;
        continue;
      }
      const [target, next] = readTarget(cmd, k);
      if (target !== '/dev/null') unsafe.push('redirect to file');
      i = next - 1;
      continue;
    }
    if (c === '(' || c === ')') {
      unsafe.push('subshell');
      continue;
    }
    word += c;
    inWord = true;
  }
  pushWord();
  return { segments, separators, unsafe };
}

/**
 * Constructs a prefix rule such as Bash(git status:*) never covers: they run
 * other commands or write files that the rule's prefix says nothing about.
 * Only a rule naming the exact command (or a bare "Bash" rule) allows them.
 */
export const GATED_CONSTRUCTS = [
  'command substitution',
  'process substitution',
  'redirect to file',
  'read-write redirect',
  'subshell',
  'background job',
  'unterminated quote',
  'ansi-c quote',
] as const;

/** Stands in for a `$(cat <<'EOF' ... EOF)` substitution in the text the rules look at. */
export const HEREDOC_WORD = '_heredoc_';

/** `$(cat <<'EOF'` (or <<"EOF", <<\EOF, <<-'EOF') with nothing after it on its line. */
const SAFE_HEREDOC_OPEN = /^\$\([ \t]*cat[ \t]*<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\([A-Za-z_]\w*))[ \t]*\n/;
/** Text before a substitution after which the scanner may read quotes differently from the shell. */
const UNSURE_PREFIX = /#|<<|\$'|`|\$\(|\$\{|[<>]\(/;

/** End (exclusive) of a quoted-delimiter heredoc substitution that starts at i, or -1. */
function safeHeredocEnd(cmd: string, i: number): number {
  const m = SAFE_HEREDOC_OPEN.exec(cmd.slice(i));
  if (!m) return -1;
  const delim = m[2] ?? m[3] ?? m[4];
  const stripTabs = m[1] === '-';
  let k = i + m[0].length;
  for (;;) {
    const nl = cmd.indexOf('\n', k);
    const lineEnd = nl === -1 ? cmd.length : nl;
    const line = cmd.slice(k, lineEnd);
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) {
      // the first delimiter line ends the body; only blank space may come before the closing paren
      const close = /^[ \t\n]*\)/.exec(cmd.slice(lineEnd));
      if (!close) return -1;
      const end = lineEnd + close[0].length;
      // a shell that scans $( ) for a closing paren without reading heredocs must not stop inside the body
      const scanned = closeParen(cmd, i + 2);
      return scanned !== -1 && scanned < end - 1 ? -1 : end;
    }
    if (nl === -1) return -1;
    k = nl + 1;
  }
}

/**
 * The command with each `$(cat <<'EOF' ... EOF)` replaced by HEREDOC_WORD.
 * With a quoted delimiter the body is literal text, so the substitution runs
 * only cat. Claude Code treats this form as safe, and the Bash tool tells the
 * model to pass commit messages this way. A substitution is replaced only
 * when the text before it uses plain quoting: after a comment, another
 * heredoc, $'...', a backtick or another substitution this scanner could read
 * quotes differently from the shell, so the command stays as it is.
 */
export function maskSafeHeredocs(cmd: string): string {
  if (typeof cmd !== 'string' || !cmd.includes('<<')) return cmd;
  let out = '';
  let inDouble = false;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\') {
      out += cmd.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'" && !inDouble) {
      const j = cmd.indexOf("'", i + 1);
      const stop = j === -1 ? cmd.length : j + 1;
      out += cmd.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') inDouble = !inDouble;
    else if (c === '$' && cmd[i + 1] === '(' && !UNSURE_PREFIX.test(out)) {
      const end = safeHeredocEnd(cmd, i);
      if (end !== -1) {
        out += HEREDOC_WORD;
        i = end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Gated constructs present in a command, in the order the parser met them, without repeats. */
export function gatedConstructs(cmd: string): string[] {
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  cmd = maskSafeHeredocs(cmd);
  const gated = new Set<string>(GATED_CONSTRUCTS);
  const found = new Set(parseCommand(cmd).unsafe.filter((u) => gated.has(u)));
  // the parser also reads the parentheses of $( ) and <( ) as a subshell; keep it only for real ( ) groups
  if (found.has('subshell') && !parseCommand(scanSubstitutions(cmd).masked).unsafe.includes('subshell')) found.delete('subshell');
  return [...found];
}

/** Index of the ")" that closes the "(" just before `start`, quote aware; -1 when unclosed. */
function closeParen(cmd: string, start: number): number {
  let depth = 1;
  let k = start;
  while (k < cmd.length) {
    const ch = cmd[k];
    if (ch === '\\') {
      k += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === '$' && cmd[k + 1] === "'")) {
      const end = quoteEnd(cmd, k);
      if (end === -1) return -1;
      k = end;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return k;
    k++;
  }
  return -1;
}

/**
 * Top-level $( ), backtick and <( ) >( ) substitutions of a command: their
 * bodies, and the command with each one replaced by a placeholder word.
 */
function scanSubstitutions(cmd: string): { bodies: string[]; masked: string } {
  const bodies: string[] = [];
  let masked = '';
  const n = cmd.length;
  let inDouble = false;
  let docs: Heredoc[] = [];
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    if (c === '\\') {
      masked += cmd.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (!inDouble && (c === "'" || (c === '$' && cmd[i + 1] === "'"))) {
      const end = quoteEnd(cmd, i);
      const stop = end === -1 ? n : end;
      masked += cmd.slice(i, stop);
      i = stop;
      continue;
    }
    if (!inDouble && c === '#' && startsComment(cmd, i)) {
      const nl = cmd.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      masked += cmd.slice(i, stop);
      i = stop;
      continue;
    }
    const doc = !inDouble && c === '<' ? readHeredoc(cmd, i) : undefined;
    if (doc) {
      docs.push(doc.doc);
      masked += cmd.slice(i, doc.next);
      i = doc.next;
      continue;
    }
    if (c === '\n' && !inDouble && docs.length) {
      // the body stays as text; in an expanded one only $( ) and backticks run
      const body = heredocLines(cmd, i + 1, docs);
      for (const line of body.lines) if (line.expanded) bodies.push(...expansionBodies(line.text));
      masked += cmd.slice(i, body.next);
      docs = [];
      i = body.next;
      continue;
    }
    if (c === '"') {
      inDouble = !inDouble;
      masked += c;
      i++;
      continue;
    }
    if ((c === '$' || (!inDouble && (c === '<' || c === '>'))) && cmd[i + 1] === '(') {
      const close = closeParen(cmd, i + 2);
      bodies.push(cmd.slice(i + 2, close === -1 ? n : close));
      masked += '_sub_';
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && cmd[j] !== '`') j += cmd[j] === '\\' ? 2 : 1;
      bodies.push(cmd.slice(i + 1, Math.min(j, n)));
      masked += '_sub_';
      i = j + 1;
      continue;
    }
    masked += c;
    i++;
  }
  return { bodies, masked };
}

/** $( ) and backtick bodies in heredoc text, where quotes are plain characters. */
function expansionBodies(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '(') {
      const close = closeParen(text, i + 2);
      out.push(text.slice(i + 2, close === -1 ? text.length : close));
      i = close === -1 ? text.length : close;
    } else if (text[i] === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

/**
 * Bodies of $( ), backtick and <( ) >( ) substitutions, nested ones included,
 * so deny and ask rules can see the commands they would run.
 */
export function substitutionBodies(cmd: string): string[] {
  if (typeof cmd !== 'string') return [];
  const out: string[] = [];
  for (const body of scanSubstitutions(cmd).bodies) out.push(body, ...substitutionBodies(body));
  return out.map((b) => b.trim()).filter(Boolean);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function base(cmd: string): string {
  const parts = cmd.split('/');
  return parts[parts.length - 1];
}

/** Commands that never write, whatever their arguments. */
const ALWAYS_READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'pwd', 'echo', 'printf', 'which', 'wc', 'stat', 'du', 'df',
  'uname', 'realpath', 'readlink', 'basename', 'dirname', 'whoami', 'id', 'true', 'false', 'cut', 'nl', 'cd', 'printenv',
  'jq', 'diff', 'cmp', 'comm', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'nproc', 'arch', 'uptime', 'free', 'ps', 'type',
  'column', 'tac', 'rev', 'od', 'hexdump', 'strings', 'test', '[', 'seq', 'locale', 'groups', 'tty', 'cksum', 'expand', 'fold',
]);

function hasShortFlag(args: string[], letters: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && [...a.slice(1)].some((ch) => letters.includes(ch)));
}

function hasLong(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(n + '=')));
}

const FIND_WRITES = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep', 'cat-file',
  'show-ref', 'merge-base', 'rev-list', 'whatchanged', 'count-objects', 'name-rev', 'check-ignore', 'diff-tree', 'diff-files', 'diff-index',
]);

function gitBranchReadOnly(rest: string[]): boolean {
  if (hasLong(rest, '--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog')) return false;
  if (hasShortFlag(rest, 'dDmMcCfut')) return false;
  const listing = rest.some((a) => ['-l', '--list', '-a', '--all', '-r', '--remotes', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current'].includes(a.split('=')[0]));
  const positional = rest.filter((a) => !a.startsWith('-'));
  return positional.length === 0 || listing;
}

function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks') {
      i++;
      continue;
    }
    if (a === '-C') {
      i += 2;
      continue;
    }
    return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return false;
  if (hasLong(rest, '--output', '--ext-diff')) return false;
  // git grep -O<cmd> runs <cmd> on the matching files
  if (sub === 'grep' && rest.some((a) => /^-[^-]*O/.test(a) || a.startsWith('--open-files-in-pager'))) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  switch (sub) {
    case 'branch':
      return gitBranchReadOnly(rest);
    case 'remote':
      return rest.length === 0 || rest.every((a) => a === '-v' || a === '--verbose') || rest[0] === 'get-url' || rest[0] === 'show';
    case 'tag':
      return rest.length === 0 || ((rest.includes('-l') || rest.includes('--list')) && !hasShortFlag(rest, 'dasfmu') && !hasLong(rest, '--delete', '--annotate', '--sign', '--force', '--message'));
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show';
    case 'worktree':
      return rest[0] === 'list';
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show';
    case 'config':
      return hasLong(rest, '--get', '--get-all', '--get-regexp', '--list') || rest.includes('-l');
    default:
      return false;
  }
}

/** True when this one simple command (already split into words) never writes. */
export function isReadOnlySegment(tokens: string[]): boolean {
  if (!tokens.length) return true;
  // VAR=value prefixes can change what a program runs (PAGER, GIT_EXTERNAL_DIFF, LD_PRELOAD...).
  if (ASSIGNMENT.test(tokens[0])) return false;
  const cmd = base(tokens[0]);
  const rest = tokens.slice(1);
  if (ALWAYS_READ_ONLY.has(cmd)) return true;
  switch (cmd) {
    case 'find':
      return !rest.some((a) => FIND_WRITES.has(a));
    case 'rg':
      return !hasLong(rest, '--pre', '--hostname-bin');
    case 'git':
      return gitReadOnly(rest);
    case 'file':
      return !rest.includes('-C') && !hasLong(rest, '--compile');
    case 'env':
      return rest.length === 0;
    case 'date':
      return !hasShortFlag(rest, 's') && !hasLong(rest, '--set');
    case 'sort':
      return !hasShortFlag(rest, 'o') && !hasLong(rest, '--output', '--compress-program');
    case 'uniq':
      return rest.filter((a) => !a.startsWith('-')).length <= 1;
    case 'tree':
      return !rest.includes('-o');
    case 'hostname':
      return rest.length === 0 || rest.every((a) => a.startsWith('-') && !hasShortFlag([a], 'bF'));
    default:
      return false;
  }
}

/** Conservative check used as the Bash tool's readOnly. */
export function isReadOnlyCommand(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const parsed = parseCommand(command);
  if (parsed.unsafe.length) return false;
  const segs = parsed.segments.filter((s) => s.length);
  if (!segs.length) return false;
  return segs.every(isReadOnlySegment);
}

/** Tools whose second word picks a subcommand ("git commit", "npm test"). */
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'cargo', 'go', 'docker', 'docker-compose', 'podman', 'kubectl', 'pip', 'pip3',
  'uv', 'poetry', 'pipenv', 'make', 'gh', 'terraform', 'dotnet', 'mvn', 'gradle', 'gradlew', './gradlew', 'deno', 'brew', 'apt',
  'apt-get', 'systemctl', 'helm', 'aws', 'gcloud', 'az', 'rustup', 'composer', 'bundle', 'rake', 'rails', 'mix', 'swift',
  'flutter', 'dart', 'nx', 'turbo', 'conda', 'just', 'task', 'firebase', 'vercel', 'wrangler', 'supabase', 'prisma', 'node',
  'python', 'python3', 'ruby', 'perl', 'php', 'java', 'tsx', 'ts-node', 'zig', 'mise', 'nix', 'hatch', 'pdm', 'rye',
]);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'pipenv', 'cargo', 'pdm', 'rye', 'hatch']);
const RUN_WORDS = new Set(['run', 'exec', 'x', 'dlx']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bun', 'deno', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh']);
/** Commands too risky for a prefix rule; suggest the exact command instead. */
const EXACT_ONLY = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'doas', 'dd', 'mkfs', 'chmod', 'chown', 'chgrp', 'kill', 'killall', 'pkill', 'shutdown', 'reboot',
  'curl', 'wget', 'eval', 'exec', 'sh', 'bash', 'zsh', 'ssh', 'scp', 'rsync', 'mv', 'truncate', 'shred', 'xargs', 'nc', 'ncat',
]);

function prefixOf(words: string[]): string {
  let w = words;
  const first = base(w[0]);
  if (first === 'git' && w[1] === '-C' && w[2]) w = [w[0], ...w.slice(3)];
  if ((first === 'python' || first === 'python3') && w[1] === '-m' && w[2]) return `${w[0]} -m ${w[2]}`;
  let n = 1;
  if (SUBCOMMAND_TOOLS.has(first) && w[1] && !w[1].startsWith('-')) n = 2;
  if (n === 2 && RUNNERS.has(first) && RUN_WORDS.has(w[1]) && w[2] && !w[2].startsWith('-')) n = 3;
  if (n === 2 && (first === 'docker' || first === 'podman') && w[1] === 'compose' && w[2] && !w[2].startsWith('-')) n = 3;
  return w.slice(0, n).join(' ');
}

/**
 * Suggested "always allow" rule for a command, e.g. "Bash(npm test:*)".
 * Leading `cd dir &&` is ignored, and trailing read-only pipes (| tail, | grep)
 * do not block a suggestion. Risky programs get an exact-command rule.
 */
export function suggestBashRule(command: string): string | undefined {
  if (typeof command !== 'string' || !command.trim()) return undefined;
  // a prefix rule would not cover these (see GATED_CONSTRUCTS), so suggest the exact command
  if (gatedConstructs(command).length) return `Bash(${command.trim()})`;
  // a commit message passed through $(cat <<'EOF' ... EOF) is one word for the suggestion
  const parsed = parseCommand(maskSafeHeredocs(command));
  let segs = parsed.segments.filter((s) => s.length);
  while (segs.length > 1 && segs[0][0] === 'cd') segs = segs.slice(1);
  if (!segs.length) return undefined;
  const [first, ...others] = segs;
  if (!others.every(isReadOnlySegment)) return `Bash(${command.trim()})`;
  let i = 0;
  while (i < first.length && ASSIGNMENT.test(first[i])) i++;
  const words = first.slice(i);
  if (!words.length) return undefined;
  const name = base(words[0]);
  if (EXACT_ONLY.has(name)) return `Bash(${command.trim()})`;
  if (INTERPRETERS.has(name) && words.some((w) => w === '-c' || w === '-e' || w === '--eval')) return `Bash(${command.trim()})`;
  return `Bash(${prefixOf(words)}:*)`;
}
