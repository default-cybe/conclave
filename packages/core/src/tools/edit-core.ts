/**
 * String replacement shared by Edit and MultiEdit. Works on LF text.
 *
 * Exact match first. When that finds nothing, a few forgiving strategies are
 * tried in order (line-number prefixes copied from Read, curly quotes and
 * dashes, trailing whitespace, indentation). Each must still be unique unless
 * replace_all is set, and the result says which one was used.
 */

export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export type EditOutcome =
  | {
      ok: true;
      content: string;
      count: number;
      /** Char offset in the new content where the first replacement starts. */
      firstStart: number;
      /** Char offset in the new content where the first replacement ends. */
      firstEnd: number;
      note?: string;
    }
  | { ok: false; error: string };

interface Match {
  start: number;
  end: number;
  replacement: string;
}

const TYPO_MAP: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u00a0': ' ',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
};
const TYPO_RE = /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u00a0\u2010-\u2014]/g;

/** Same-length normalization of typographic characters, so indexes map 1:1. */
export function normalizeTypography(s: string): string {
  return s.replace(TYPO_RE, (c) => TYPO_MAP[c] ?? c);
}

function exactMatches(content: string, needle: string, replacement: string): Match[] {
  const out: Match[] = [];
  if (!needle) return out;
  let i = content.indexOf(needle);
  while (i !== -1) {
    out.push({ start: i, end: i + needle.length, replacement });
    i = content.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Give new text the same curly quote style as the text it replaces. */
function matchQuoteStyle(replacement: string, original: string): string {
  const dbl = /[\u201c\u201d]/.test(original);
  const sgl = /[\u2018\u2019]/.test(original);
  if (!dbl && !sgl) return replacement;
  let out = '';
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i];
    const prev = i > 0 ? replacement[i - 1] : '';
    const opening = !prev || /[\s([{<\u2014\u2013-]/.test(prev);
    if (ch === '"' && dbl) out += opening ? '\u201c' : '\u201d';
    else if (ch === "'" && sgl) out += opening ? '\u2018' : '\u2019';
    else out += ch;
  }
  return out;
}

function typographyMatches(content: string, oldStr: string, newStr: string): Match[] {
  const normContent = normalizeTypography(content);
  const normOld = normalizeTypography(oldStr);
  if (normContent === content && normOld === oldStr) return [];
  return exactMatches(normContent, normOld, newStr).map((m) => {
    const original = content.slice(m.start, m.end);
    return { ...m, replacement: matchQuoteStyle(newStr, original) };
  });
}

const LINE_NO_PREFIX = /^\s*\d+(\t|\u2192)/;

function stripLineNumbers(s: string): string | undefined {
  const lines = s.split('\n');
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (!nonEmpty.length || !nonEmpty.every((l) => LINE_NO_PREFIX.test(l))) return undefined;
  return lines.map((l) => l.replace(LINE_NO_PREFIX, '')).join('\n');
}

function leadingWs(s: string): string {
  return s.match(/^[ \t]*/)?.[0] ?? '';
}

/**
 * Whole-line window match where each line is compared through `norm`.
 * With reindent, the indentation difference between old_string and the file
 * is applied to new_string too.
 */
function lineWindowMatches(content: string, oldStr: string, newStr: string, norm: (l: string) => string, reindent: boolean): Match[] {
  const endsWithNl = oldStr.endsWith('\n');
  const oldLines = (endsWithNl ? oldStr.slice(0, -1) : oldStr).split('\n');
  if (!oldLines.some((l) => l.trim())) return [];
  const fileLines = content.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const l of fileLines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const normOld = oldLines.map(norm);
  const normFile = fileLines.map(norm);
  const out: Match[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let hit = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normFile[i + j] !== normOld[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    const last = i + oldLines.length - 1;
    const start = starts[i];
    let end = starts[last] + fileLines[last].length;
    if (endsWithNl && end < content.length) end += 1;
    let replacement = newStr;
    if (reindent) {
      const firstOld = oldLines.findIndex((l) => l.trim());
      const fileIndent = leadingWs(fileLines[i + firstOld]);
      const oldIndent = leadingWs(oldLines[firstOld]);
      if (fileIndent !== oldIndent) {
        replacement = newStr
          .split('\n')
          .map((l) => (l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l))
          .join('\n');
      }
    }
    out.push({ start, end, replacement });
    i = last;
  }
  return out;
}

function lineNumbersOf(content: string, matches: Match[]): number[] {
  const out: number[] = [];
  let line = 1;
  let idx = 0;
  for (const m of matches) {
    for (; idx < m.start; idx++) if (content.charCodeAt(idx) === 10) line++;
    out.push(line);
  }
  return out;
}

function notFoundHint(content: string, oldStr: string): string {
  const first = oldStr.split('\n').find((l) => l.trim())?.trim();
  if (!first) return '';
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.includes(first));
  if (idx === -1) return '';
  if (oldStr.trim().includes('\n')) return ` The first line of old_string appears at line ${idx + 1}, but the lines after it do not match.`;
  return ` Similar text appears at line ${idx + 1}; check whitespace and surrounding characters.`;
}

export function applyEdit(content: string, spec: EditSpec, path: string): EditOutcome {
  if (typeof spec.old_string !== 'string' || typeof spec.new_string !== 'string') {
    return { ok: false, error: 'old_string and new_string must both be strings.' };
  }
  const oldStr = spec.old_string.replace(/\r\n/g, '\n');
  let newStr = spec.new_string.replace(/\r\n/g, '\n');
  if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are identical, so there is nothing to change.' };

  if (oldStr === '') {
    if (content.trim() === '') return { ok: true, content: newStr, count: 1, firstStart: 0, firstEnd: newStr.length };
    return { ok: false, error: `old_string is empty but ${path} already has content. Give the exact text to replace, or use Write to replace the whole file.` };
  }

  let matches = exactMatches(content, oldStr, newStr);
  let note: string | undefined;

  if (!matches.length) {
    const strippedOld = stripLineNumbers(oldStr);
    if (strippedOld !== undefined) {
      const strippedNew = stripLineNumbers(newStr) ?? newStr;
      matches = exactMatches(content, strippedOld, strippedNew);
      if (matches.length) {
        note = 'old_string contained line-number prefixes from Read output; they were removed before matching.';
        newStr = strippedNew;
      }
    }
  }
  if (!matches.length) {
    matches = typographyMatches(content, oldStr, newStr);
    if (matches.length) note = 'old_string matched only after treating curly quotes, dashes and non-breaking spaces as their plain forms. The file\'s quote style was kept.';
  }
  if (!matches.length) {
    matches = lineWindowMatches(content, oldStr, newStr, (l) => normalizeTypography(l).trimEnd(), false);
    if (matches.length) note = 'old_string matched only after ignoring trailing whitespace. Check the result.';
  }
  if (!matches.length) {
    matches = lineWindowMatches(content, oldStr, newStr, (l) => normalizeTypography(l).trim().replace(/\s+/g, ' '), true);
    if (matches.length) note = 'old_string matched only after ignoring indentation and whitespace differences; new_string was re-indented to fit. Check the result.';
  }

  if (!matches.length) {
    return {
      ok: false,
      error: `old_string was not found in ${path}. It must match the file exactly, including whitespace, indentation and line breaks. Read the file again and copy the text exactly (without the line-number prefix).${notFoundHint(content, oldStr)}`,
    };
  }
  if (matches.length > 1 && !spec.replace_all) {
    const lines = lineNumbersOf(content, matches).slice(0, 10);
    return {
      ok: false,
      error: `old_string matches ${matches.length} places in ${path} (lines ${lines.join(', ')}${matches.length > 10 ? ', ...' : ''}). Add more surrounding lines to old_string so it matches exactly one place, or set replace_all to true to change all of them.`,
    };
  }

  let out = '';
  let pos = 0;
  let firstStart = 0;
  let firstEnd = 0;
  matches.forEach((m, i) => {
    out += content.slice(pos, m.start);
    if (i === 0) firstStart = out.length;
    out += m.replacement;
    if (i === 0) firstEnd = out.length;
    pos = m.end;
  });
  out += content.slice(pos);
  return { ok: true, content: out, count: matches.length, firstStart, firstEnd, note };
}
