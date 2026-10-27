/**
 * Fails when the web app uses a style docs/DESIGN.md section 13 bans: pills,
 * uppercase labels, gradients, glass, glows, spinners, glyphs as decoration,
 * sparklines, or a raw hex color where a token belongs (tokens live in
 * custom properties in the CSS). Comments are skipped. A justified exception
 * goes in scripts/check-styles.allow.json with a reason and a match (text on
 * the line); an entry that no longer matches anything fails too, so the list
 * stays short. Pills are found in Tailwind classes only: a pill built in a
 * .css file (border-radius on one line, padding on another) is not caught.
 *
 *   bun scripts/check-styles.ts            scans packages/web/src
 *   bun scripts/check-styles.ts <dir>      scans another folder (fixtures)
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type Finding = { file: string; line: number; rule: string; text: string };
export type Allow = { file: string; rule: string; match: string; reason: string };

type Rule = { id: string; what: string; find: (line: string, css: boolean) => string | null };

const first = (re: RegExp, line: string) => re.exec(line)?.[0] ?? null;
// a mask paints nothing, it only fades what is under it, so its value is not checked
const noMask = (line: string) => line.replace(/mask(?:-image)?\s*:[^;\]]*/gi, '');

/** Tailwind classes in one string, without the state-prefixed ones (hov:, active:, light:). */
function baseClasses(s: string): string[] {
  return s.split(/\s+/).filter((c) => c && !c.includes(':'));
}

function pill(line: string): string | null {
  for (const m of line.matchAll(/(['"`])((?:(?!\1).)*\brounded-full\b(?:(?!\1).)*)\1/g)) {
    const cls = baseClasses(m[2]!);
    const filled = cls.some((c) => (c.startsWith('bg-') && c !== 'bg-transparent') || (/^border(-|$)/.test(c) && c !== 'border-transparent' && c !== 'border-0'));
    const padded = cls.some((c) => /^(px|pl|pr)-/.test(c));
    if (filled && padded) return 'rounded-full';
  }
  return null;
}

export const RULES: Rule[] = [
  { id: 'pill', what: 'pill or chip (a filled or bordered rounded-full box with side padding)', find: (l, css) => (css ? null : pill(l)) },
  {
    id: 'uppercase',
    what: 'uppercase label',
    find: (l, css) => (css ? first(/text-transform:\s*uppercase/, l) : first(/(?<![\w-])uppercase(?![\w-])/, l)),
  },
  {
    id: 'gradient',
    what: 'gradient',
    find: (l) => first(/\b(?:repeating-)?(?:linear|radial|conic)-gradient\(|\bbg-(?:gradient|linear|radial|conic)-/, noMask(l)),
  },
  { id: 'glass', what: 'glass (backdrop blur)', find: (l) => first(/backdrop-blur|backdrop-filter/, l) },
  {
    id: 'glow',
    what: 'glow (a blurred shadow around an edge)',
    find: (l) => first(/shadow-\[0_0_[1-9]|\bdrop-shadow\b|text-shadow|textShadow|box-?shadow:\s*['"`]?0(?:px)?\s+0(?:px)?\s+[1-9]/i, l),
  },
  { id: 'spinner', what: 'spinner (state is a word, or the wave)', find: (l) => first(/\banimate-spin\b|\bLoader2\b|\bLoaderCircle\b|@keyframes\s+spin\b/, l) },
  { id: 'glyph', what: 'glyph or emoji used as an icon', find: (l) => first(/[\u2600-\u27BF\u25A0-\u25FF\u2B00-\u2BFF]|[\u{1F300}-\u{1FAFF}]/u, l) },
  { id: 'sparkline', what: 'sparkline or KPI tile', find: (l) => first(/sparkline/i, l) },
  {
    id: 'hex',
    what: 'raw hex color (use a token)',
    find: (l, css) => {
      if (css && /^\s*--[\w-]+\s*:/.test(l)) return null;
      for (const m of noMask(l).matchAll(/(?<![\w&#/-])#([0-9a-fA-F]{3,8})(?![\w-])/g)) if ([3, 4, 6, 8].includes(m[1]!.length)) return m[0];
      return null;
    },
  },
];

/** Cuts a `//` comment off a tsx line, but not a `//` inside a string ('a // b', 'https://x'). */
function cutLineComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/** Blanks comments, keeping line numbers. In tsx a block comment counts only at a line start or after `{`, so a glob like 'src/**' stays code. */
function stripComments(text: string, css: boolean): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  if (css) return text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return text
    .replace(/(^[ \t]*|\{)\/\*[\s\S]*?\*\//gm, (m, lead: string) => lead + blank(m.slice(lead.length)))
    .split('\n')
    .map(cutLineComment)
    .join('\n');
}

export function scanText(file: string, text: string): Finding[] {
  const css = file.endsWith('.css');
  const out: Finding[] = [];
  stripComments(text, css)
    .split('\n')
    .forEach((line, i) => {
      for (const r of RULES) {
        const hit = r.find(line, css);
        if (hit) out.push({ file, line: i + 1, rule: r.id, text: hit });
      }
    });
  return out;
}

/** Splits findings into allowed and not, and lists bad or unused allowlist entries. */
export function applyAllow(findings: Finding[], allow: Allow[], lines: (f: Finding) => string) {
  const used = new Set<Allow>();
  const left = findings.filter((f) => {
    const entry = allow.find((a) => a.file === f.file && a.rule === f.rule && !!a.match && lines(f).includes(a.match));
    if (entry) used.add(entry);
    return !entry;
  });
  const problems = allow.flatMap((a) => {
    if (!RULES.some((r) => r.id === a.rule)) return [`${a.file}: unknown rule "${a.rule}"`];
    if (!a.reason?.trim()) return [`${a.file} (${a.rule}): an allowlist entry needs a reason`];
    if (!a.match?.trim()) return [`${a.file} (${a.rule}): an allowlist entry needs a match, text from the line it allows`];
    if (!used.has(a)) return [`${a.file} (${a.rule}, "${a.match}"): allowlist entry matches nothing, remove it`];
    return [];
  });
  return { left, allowed: used.size, problems };
}

export function run(root: string, dir: string, allow: Allow[]) {
  const texts = new Map<string, string[]>();
  const findings: Finding[] = [];
  for (const path of new Bun.Glob('**/*.{tsx,css}').scanSync(join(root, dir))) {
    const file = relative(root, join(root, dir, path));
    const text = readFileSync(join(root, file), 'utf8');
    texts.set(file, text.split('\n'));
    findings.push(...scanText(file, text));
  }
  return { files: texts.size, ...applyAllow(findings, allow, (f) => texts.get(f.file)![f.line - 1]!) };
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const dir = process.argv[2] ?? 'packages/web/src';
  const allowFile = process.argv[3] ?? join(import.meta.dir, 'check-styles.allow.json');
  const allow = JSON.parse(readFileSync(allowFile, 'utf8')) as Allow[];
  const { files, left, allowed, problems } = run(root, dir, allow);
  const what = new Map(RULES.map((r) => [r.id, r.what]));
  if (left.length || problems.length) {
    if (left.length) console.error(`Styles docs/DESIGN.md section 13 bans:\n${left.map((f) => `  ${f.file}:${f.line}  ${what.get(f.rule)}: ${f.text}`).join('\n')}`);
    if (problems.length) console.error(`Allowlist (${relative(root, allowFile)}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
    console.error('Fix the style, or add an entry with a reason to scripts/check-styles.allow.json.');
    process.exit(1);
  }
  console.log(`check-styles: ${files} files, no banned styles (${allowed} allowed with a reason)`);
}
