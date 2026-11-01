/**
 * Comments the owner leaves on lines of a diff (Code.tsx Diff, onComment).
 * They collect per session in a tray over the composer (CommentTray.tsx)
 * and go to the agent as one message: file:line, the quoted lines and the
 * comment. Kept in localStorage per session, so a reload keeps them; a
 * deleted session and a sign out drop them.
 */
import { create } from 'zustand';
import { diffSpan, type DiffLine } from '@/lib/text';

export interface LineComment {
  id: string;
  path: string;
  /** The first line's number: the new file's, or the old file's when every line was removed. */
  line?: number;
  endLine?: number;
  /** Every quoted line was removed, so the numbers are the old file's. */
  removed?: boolean;
  /** The lines as the diff shows them, each with its sign ("+", "-" or " "). */
  quote: string;
  text: string;
  /** A workflow branch the diff came from, not the session's own folder. */
  branch?: string;
  /** An element picked in the Preview (PreviewPane.tsx): quote is the hub's text, already inside <untrusted_web_content>. */
  pick?: true;
}

export const COMMENTS_PREFIX = 'diff-comments:';
const EMPTY: LineComment[] = [];

const useComments = create<Record<string, LineComment[]>>(() => ({}));

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function fromDisk(sessionId: string): LineComment[] {
  try {
    const v = JSON.parse(storage()?.getItem(COMMENTS_PREFIX + sessionId) || '[]');
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string' && typeof c.path === 'string' && typeof c.text === 'string' && typeof c.quote === 'string') : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** What storage held at the first read, so a render takes the same array each time without writing the store. */
const read = new Map<string, LineComment[]>();

function current(sessionId: string): LineComment[] {
  const s = useComments.getState();
  if (sessionId in s) return s[sessionId];
  let list = read.get(sessionId);
  if (!list) read.set(sessionId, (list = fromDisk(sessionId)));
  return list;
}

function change(sessionId: string, fn: (list: LineComment[]) => LineComment[]) {
  const next = fn(current(sessionId));
  useComments.setState({ [sessionId]: next });
  try {
    if (next.length) storage()?.setItem(COMMENTS_PREFIX + sessionId, JSON.stringify(next));
    else storage()?.removeItem(COMMENTS_PREFIX + sessionId);
  } catch {
    // a full or blocked storage: the comments stay for this page
  }
}

/** A session's comments, read from storage the first time. */
export function useLineComments(sessionId: string): LineComment[] {
  return useComments((s) => s[sessionId]) ?? current(sessionId);
}

export const addComment = (sessionId: string, c: Omit<LineComment, 'id'>) => change(sessionId, (l) => [...l, { ...c, id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]);
export const editComment = (sessionId: string, id: string, text: string) => change(sessionId, (l) => l.map((c) => (c.id === id ? { ...c, text } : c)));
export const removeComment = (sessionId: string, id: string) => change(sessionId, (l) => l.filter((c) => c.id !== id));
export const clearComments = (sessionId: string) => change(sessionId, () => EMPTY);
/** After a send: only the comments that went, so one added meanwhile stays. */
export const removeComments = (sessionId: string, ids: string[]) => change(sessionId, (l) => l.filter((c) => !ids.includes(c.id)));

// another tab changed a session's comments: take its list, so this tab does not write over it
if (typeof addEventListener === 'function')
  addEventListener('storage', (e) => {
    if (e.key === null) {
      read.clear();
      useComments.setState(() => ({}), true);
    } else if (e.key.startsWith(COMMENTS_PREFIX)) {
      const id = e.key.slice(COMMENTS_PREFIX.length);
      read.delete(id);
      useComments.setState({ [id]: fromDisk(id) });
    }
  });

/** Sign out: every session's comments go (they quote code). */
export function dropAllComments() {
  read.clear();
  useComments.setState(() => ({}), true);
  const s = storage();
  if (!s) return;
  const keys = Array.from({ length: s.length }, (_, i) => s.key(i) ?? '');
  for (const k of keys) if (k.startsWith(COMMENTS_PREFIX)) s.removeItem(k);
}

const SIGN = { add: '+', del: '-', ctx: ' ' } as const;

/** A comment on these lines of a diff (hunk and meta rows are left out). */
export function commentOn(path: string, lines: DiffLine[], text: string, branch?: string): Omit<LineComment, 'id'> {
  const body = lines.filter((l) => l.type === 'add' || l.type === 'del' || l.type === 'ctx');
  return {
    path,
    ...diffSpan(body),
    quote: body.map((l) => `${SIGN[l.type as keyof typeof SIGN]}${l.text}`).join('\n'),
    text: text.trim(),
    ...(branch ? { branch } : {}),
  };
}

/** "src/a.ts:12-14", "(removed)" when the numbers are the old file's, "on branch x" for a workflow branch. */
export function commentPlace(c: Pick<LineComment, 'path' | 'line' | 'endLine' | 'removed' | 'branch'>): string {
  const at = c.line === undefined ? '' : c.endLine !== undefined ? `:${c.line}-${c.endLine}` : `:${c.line}`;
  return `${c.path}${at}${c.removed ? ' (removed)' : ''}${c.branch ? ` on branch ${c.branch}` : ''}`;
}

/** The one message the agent gets: each place, the quoted lines in a diff block, then the comment. */
export function formatComments(list: LineComment[]): string {
  const parts = list.map((c) => {
    // a pick's quote is page data the hub fenced as untrusted; it goes as it came
    if (c.pick) return `${c.text}\n${c.quote}`;
    let fence = '```';
    while (c.quote.includes(fence)) fence += '`';
    return `${commentPlace(c)}\n${fence}diff\n${c.quote}\n${fence}\n${c.text}`;
  });
  const where = list.every((c) => c.pick) ? 'on the Preview' : list.some((c) => c.pick) ? 'on the diff and the Preview' : 'on the diff';
  return `${list.length === 1 ? 'A comment' : `${list.length} comments`} ${where}:\n\n${parts.join('\n\n')}`;
}
