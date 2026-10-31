/**
 * A meeting's notes after the wrap-up (docs/design/MEETING-MODE.md 1.4):
 * summary, decisions, action items (the owner's link to their tasks), open
 * questions, where the notes file was written, and the .gitignore hint once.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { Section } from '@/components/ui/Section';
import { InlineCode } from '@/components/ui/Code';
import type { Meeting, MeetingNotes } from '@/overlay/wire';

const GITIGNORE_KEY = 'conclave.meeting.gitignoreHint';

/** Shown once per browser: the hub cannot tell this page whether .gitignore lists .conclave/ yet. */
function useOnce(key: string): boolean {
  const [show] = useState(() => {
    try {
      if (localStorage.getItem(key) === '1') return false;
      localStorage.setItem(key, '1');
      return true;
    } catch {
      return false;
    }
  });
  return show;
}

export function Notes({ meeting, notes }: { meeting: Meeting; notes: MeetingNotes }) {
  const hint = useOnce(GITIGNORE_KEY);
  const mine = notes.actionItems.filter((a) => a.who === 'me');
  const theirs = notes.actionItems.filter((a) => a.who !== 'me');
  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-[var(--read-measure)] text-[15px] leading-[1.6] text-fg">{notes.summary}</p>
      {mine.length > 0 && (
        <Section title="My action items" count={mine.length}>
          {mine.map((a, i) => (
            <div key={i} className="flex items-baseline gap-3 py-2 text-[14px]">
              <span className="min-w-0 flex-1 text-fg">{a.what}</span>
              {a.due && <span className="num shrink-0 text-fg-3">{a.due}</span>}
              {a.taskId && (
                <Link href={`/tasks/${a.taskId}`} className="link shrink-0 text-[13px]">
                  Task
                </Link>
              )}
            </div>
          ))}
        </Section>
      )}
      {theirs.length > 0 && (
        <Section title="Others' action items" count={theirs.length}>
          {theirs.map((a, i) => (
            <div key={i} className="py-2 text-[14px] text-fg-2">
              <span className="text-fg">{a.who}</span>: {a.what}
              {a.due ? `, by ${a.due}` : ''}
            </div>
          ))}
        </Section>
      )}
      {notes.decisions.length > 0 && (
        <Section title="Decisions" count={notes.decisions.length}>
          {notes.decisions.map((d, i) => (
            <p key={i} className="py-2 text-[14px] text-fg">
              {d}
            </p>
          ))}
        </Section>
      )}
      {notes.openQuestions.length > 0 && (
        <Section title="Open questions" count={notes.openQuestions.length}>
          {notes.openQuestions.map((q, i) => (
            <p key={i} className="py-2 text-[14px] text-fg">
              {q}
            </p>
          ))}
        </Section>
      )}
      {meeting.notesPath && (
        <p className="text-[13px] text-fg-3">
          Notes file: <InlineCode>{meeting.notesPath}</InlineCode>
        </p>
      )}
      {hint && meeting.notesPath && (
        <p className="text-[13px] text-fg-3">
          Add <InlineCode>.conclave/</InlineCode> to .gitignore to keep meeting notes out of git.
        </p>
      )}
    </div>
  );
}
