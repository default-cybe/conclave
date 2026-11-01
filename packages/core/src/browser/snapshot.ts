/** Text helpers for page snapshots: compaction, ref parsing, diffs, size caps and the untrusted wrapper. */
import { defuseFrameworkTags } from '../session/untrusted';

export const SNAPSHOT_MAX_CHARS = 12_000;

const TAG = 'untrusted_web_content';

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Wrap page-derived text so the model treats it as data. Any copy of the
 * wrapper tags inside the body is defused so a page cannot close the block,
 * and so is every other framework tag (session/untrusted.ts).
 */
export function wrapUntrusted(source: string, body: string): string {
  const safe = defuseFrameworkTags(body.replace(new RegExp(`<(/?)\\s*${TAG}`, 'gi'), '&lt;$1' + TAG));
  return `<${TAG} source="${escapeAttr(source)}">\n${safe}\n</${TAG}>`;
}

/** Wrapper-only lines such as `- generic [ref=e3]:` add depth but no meaning. */
const WRAPPER_LINE = /^- (?:generic|none|presentation)(?: \[(?:ref=[\w-]+|active)\])*:$/;

/**
 * Drop unnamed wrapper nodes (div soup) and lift their children one level.
 * Keeps everything else verbatim so refs stay valid.
 */
export function compactTree(tree: string): string {
  const out: string[] = [];
  const stack: Array<{ indent: number; dropped: boolean }> = [];
  for (const raw of tree.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const shift = stack.reduce((n, s) => n + (s.dropped ? 2 : 0), 0);
    const line = raw.trimStart();
    const dropped = WRAPPER_LINE.test(line);
    stack.push({ indent, dropped });
    if (dropped) continue;
    out.push(' '.repeat(Math.max(0, indent - shift)) + line);
  }
  return out.join('\n');
}

/** All refs in a snapshot, in order. */
export function extractRefs(tree: string): string[] {
  const refs: string[] = [];
  for (const m of tree.matchAll(/\[ref=([\w-]+)\]/g)) refs.push(m[1]);
  return refs;
}

/** Accept "e12", "[ref=e12]" or "ref=e12". */
export function normalizeRef(ref: string): string {
  return ref.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^ref=/, '').trim();
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'heading',
  'img',
  'cell',
  'row',
]);

export interface RoleRef {
  ref: string;
  role: string;
  name?: string;
  /** Index among elements matched by getByRole(role, name ? { name, exact } : undefined). */
  nth: number;
}

/**
 * Fallback for Playwright builds without AI snapshots: add our own refs to a
 * plain aria snapshot and describe each one as a role locator.
 */
export function annotateRoleRefs(tree: string): { tree: string; refs: RoleRef[] } {
  const counts = new Map<string, number>();
  const refs: RoleRef[] = [];
  let n = 0;
  const lines = tree.split('\n').map((line) => {
    const m = /^(\s*- )([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(line);
    if (!m || !INTERACTIVE_ROLES.has(m[2])) return line;
    const role = m[2];
    const name = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : undefined;
    const key = name !== undefined ? `${role}\u0000${name}` : role;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    // Unnamed lookups match every element of the role, so count named ones too.
    if (name !== undefined) counts.set(role, (counts.get(role) ?? 0) + 1);
    const ref = `e${++n}`;
    refs.push({ ref, role, name, nth });
    const rest = m[4];
    const colon = rest.endsWith(':') ? ':' : '';
    const body = colon ? rest.slice(0, -1) : rest;
    const textIdx = body.indexOf(': ');
    const attrs = textIdx >= 0 ? body.slice(0, textIdx) : body;
    const text = textIdx >= 0 ? body.slice(textIdx) : '';
    return `${m[1]}${role}${name !== undefined ? ` "${m[3]}"` : ''}${attrs} [ref=${ref}]${text}${colon}`;
  });
  return { tree: lines.join('\n'), refs };
}

/** Cut at a line boundary under `max` chars. */
export function capLines(text: string, max = SNAPSHOT_MAX_CHARS): { text: string; truncated: boolean; omittedLines: number } {
  if (text.length <= max) return { text, truncated: false, omittedLines: 0 };
  const lines = text.split('\n');
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    if (used + lines[i].length + 1 > max) break;
    used += lines[i].length + 1;
  }
  return { text: lines.slice(0, i).join('\n'), truncated: true, omittedLines: lines.length - i };
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  /** Lines in the new tree, for deciding when a full snapshot is clearer. */
  total: number;
  /** The newly focused line, when focus moved to an element shown in the tree. */
  focus?: string;
}

/** Line key for diffs. Focus moves are reported once, not as changed lines. */
const diffKey = (l: string) => l.trim().replace(/ \[active\]/g, '');
const focusedLine = (lines: string[]) => lines.find((l) => l.includes('[active]'))?.trim();

/** Multiset line diff. Refs are stable, so changed elements show as removed old and added new. */
export function diffTrees(before: string, after: string): TreeDiff {
  const oldLines = before.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const newLines = after.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const pool = new Map<string, number>();
  for (const l of oldLines) pool.set(diffKey(l), (pool.get(diffKey(l)) ?? 0) + 1);
  const added: string[] = [];
  for (const l of newLines) {
    const k = diffKey(l);
    const c = pool.get(k) ?? 0;
    if (c > 0) pool.set(k, c - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const l of oldLines) {
    const k = diffKey(l);
    const c = pool.get(k) ?? 0;
    if (c > 0) {
      removed.push(l);
      pool.set(k, c - 1);
    }
  }
  const was = focusedLine(oldLines);
  const now = focusedLine(newLines);
  const focus = now && diffKey(now) !== (was ? diffKey(was) : undefined) ? now : undefined;
  return { added, removed, total: newLines.length, focus };
}
