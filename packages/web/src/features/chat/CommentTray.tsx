/**
 * The comments left on diff lines (lineComments.ts), over the composer like
 * the /btw cards: one quiet line ("3 comments", Send to agent) that opens to
 * the list, each comment editable and removable. Send to agent posts them as
 * one message through the composer's path: queued while a turn runs.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import type { Session } from '@conclave/core/types';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { useEscape } from '@/components/ui/Overlay';
import { plural } from '@/lib/format';
import { sendTo } from '@/features/conversation/actions';
import { addComment, commentOn, commentPlace, editComment, formatComments, removeComment, removeComments, useLineComments, type LineComment } from './lineComments';
import type { DiffLine } from '@/lib/text';

/** What a Diff's onComment calls, for this session's tray; `branch` for a workflow branch's diff. */
export const commentTo = (sessionId: string, branch?: string) => (path: string, lines: DiffLine[], text: string) => addComment(sessionId, commentOn(path, lines, text, branch));

export function CommentTray({ session }: { session: Session }) {
  const list = useLineComments(session.id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!list.length) return null;
  const send = async () => {
    const sent = list;
    setBusy(true);
    const ok = await sendTo(session, { text: formatComments(sent), attachments: [] });
    setBusy(false);
    if (ok) {
      // only what went: a comment added while the send was out stays for the next one
      removeComments(session.id, sent.map((c) => c.id));
      setOpen(false);
    }
  };
  const running = session.status === 'running' || session.status === 'waiting_approval' || session.status === 'waiting_input';
  return (
    <section aria-label="Comments on the diff" data-comment-tray className="mb-2 rounded-[var(--r-2)] border border-rule bg-raise text-[13px] phone:text-[14px]">
      <div className="flex items-center gap-2 py-1 pr-1 pl-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-w-0 flex-1 truncate py-1 text-left text-fg-2 hov:text-fg">
          {plural(list.length, 'comment')} {list.every((c) => c.pick) ? 'on the Preview' : 'on the diff'}
        </button>
        <Button variant="solid" size="sm" busy={busy ? 'Sending' : false} onClick={() => void send()}>
          {running ? 'Queue for agent' : 'Send to agent'}
        </Button>
      </div>
      {open && (
        <ul className="m-0 max-h-[40vh] list-none overflow-y-auto border-t border-rule p-0 px-3">
          {list.map((c) => (
            <Item key={c.id} sessionId={session.id} c={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Item({ sessionId, c }: { sessionId: string; c: LineComment }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.text);
  const save = () => {
    if (text.trim()) editComment(sessionId, c.id, text.trim());
    setEditing(false);
  };
  const cancel = () => {
    setText(c.text);
    setEditing(false);
  };
  // the box is the top layer: Esc cancels the edit, not the dialog around the tray
  useEscape(editing, cancel);
  return (
    <li className="border-b border-rule py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="mono min-w-0 flex-1 truncate text-[12px] text-fg-3" title={commentPlace(c)}>
          {commentPlace(c)}
        </span>
        {!editing && (
          <button type="button" aria-label={`Edit the comment on ${commentPlace(c)}`} onClick={() => setEditing(true)} className="tap shrink-0 text-[12px] text-fg-3 hov:text-fg">
            Edit
          </button>
        )}
        <button type="button" aria-label={`Remove the comment on ${commentPlace(c)}`} title="Remove" onClick={() => removeComment(sessionId, c.id)} className="tap grid size-6 shrink-0 place-items-center self-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
          <X aria-hidden strokeWidth={1.75} className="size-3.5" />
        </button>
      </div>
      {editing ? (
        <div className="mt-1">
          <Textarea
            autoFocus
            minRows={2}
            maxRows={8}
            value={text}
            aria-label={`Comment on ${commentPlace(c)}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            className="w-full"
          />
          <div className="mt-1.5 flex gap-1">
            <Button variant="outline" size="sm" onClick={save}>
              Save
            </Button>
            <Button variant="quiet" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 mt-0.5 whitespace-pre-wrap text-fg">{c.text}</p>
      )}
    </li>
  );
}
