/**
 * Argument preview for slash commands, computed in the browser. Uses the
 * hub's own substitution (core/extensions/commands) so the preview matches a
 * real run, but never runs anything: !`cmd` and !{cmd} become "would run",
 * @file and @{file} become "would read".
 *
 * Styles: Claude ($ARGUMENTS, zero-based $0 $1), Codex ($1..$9 one-based),
 * OpenCode (one-based, the last placeholder takes the rest, args appended
 * when there is none), Gemini ({{args}}, appended when missing).
 */
import type { CommandArgStyle } from '@conclave/core/extensions/types';
import { splitArgs, substituteArgsStyled } from '@conclave/core/extensions/commands';

export type Segment = { text: string; kind?: 'run' | 'read' };

export interface Preview {
  segments: Segment[];
  runs: string[];
  reads: string[];
  tokens: string[];
  raw: string;
}

export const STYLE_WORD: Record<CommandArgStyle, string> = {
  claude: 'Claude style',
  numbered: 'Codex style',
  opencode: 'OpenCode style',
  gemini: 'Gemini style',
};

export const STYLE_HELP: Record<CommandArgStyle, string> = {
  claude: '$ARGUMENTS is everything you type after the name. $0, $1 and so on are single words, counting from 0. $ARGUMENTS[1] is the same as $1.',
  numbered: '$1 to $9 are single words, counting from 1. $ARGUMENTS is everything you type. $$ is a plain dollar sign.',
  opencode: '$1, $2 and so on count from 1, and the highest one takes the rest of the line. $ARGUMENTS is everything. With no placeholder, your text is added at the end.',
  gemini: '{{args}} is everything you type. Inside !{...} it is quoted for the shell. With no {{args}}, the whole command you typed is added at the end.',
};

/** Find !{...} blocks with balanced braces, as Gemini CLI does. */
function geminiShellBlocks(body: string): Array<{ start: number; end: number; inner: string }> {
  const out: Array<{ start: number; end: number; inner: string }> = [];
  let i = 0;
  while ((i = body.indexOf('!{', i)) !== -1) {
    let depth = 1;
    let j = i + 2;
    for (; j < body.length && depth > 0; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') depth--;
    }
    if (depth !== 0) break;
    out.push({ start: i, end: j, inner: body.slice(i + 2, j - 1) });
    i = j;
  }
  return out;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Expand a template with sample arguments. Snippets are listed, never run. */
export function previewCommand(body: string, args: string, style: CommandArgStyle = 'claude', name = ''): Preview {
  const holes: Segment[] = [];
  const hole = (s: Segment) => `\u0001${holes.push(s) - 1}\u0002`;
  const raw = args.trim();
  let out = body;

  if (style === 'gemini') {
    out = out.replace(/@\{([^}]+)\}/g, (_, p: string) => hole({ text: p.trim(), kind: 'read' }));
    const blocks = geminiShellBlocks(out);
    let rebuilt = '';
    let pos = 0;
    for (const b of blocks) {
      rebuilt += out.slice(pos, b.start) + hole({ text: b.inner.replace(/\{\{args\}\}/g, shellQuote(raw)), kind: 'run' });
      pos = b.end;
    }
    out = rebuilt + out.slice(pos);
    if (out.includes('{{args}}')) out = out.replace(/\{\{args\}\}/g, raw);
    else if (raw) out = `${out}\n\n/${name} ${raw}`.trimEnd();
  } else {
    out = out.replace(/!`([^`]+)`/g, (_, c: string) => hole({ text: c, kind: 'run' }));
    out = out.replace(/(^|[\s(])@([^\s)]+)/g, (_, pre: string, p: string) => `${pre}${hole({ text: p, kind: 'read' })}`);
    out = substituteArgsStyled(out, args, style);
  }

  const segments: Segment[] = [];
  for (const part of out.split(/(\u0001\d+\u0002)/)) {
    const m = /^\u0001(\d+)\u0002$/.exec(part);
    if (m) segments.push(holes[Number(m[1])]);
    else if (part) segments.push({ text: part });
  }
  return {
    segments,
    runs: holes.filter((h) => h.kind === 'run').map((h) => h.text),
    reads: holes.filter((h) => h.kind === 'read').map((h) => h.text),
    tokens: splitArgs(args),
    raw,
  };
}

/** Which placeholders a template uses, for the "what you type fills" lines. */
export function placeholders(body: string, style: CommandArgStyle): string[] {
  if (style === 'gemini') return body.includes('{{args}}') ? ['{{args}}'] : [];
  const found = new Set<string>();
  for (const m of body.matchAll(/\$ARGUMENTS(\[\d+\])?|\$(\d)/g)) found.add(m[0]);
  return [...found].sort();
}
