/**
 * The plan above the composer when the context panel is not on screen: one
 * line ("4 of 5  Pinning HS256 and handling empty tokens"), expanding to the
 * numbered steps. No ring, no box.
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Todo } from '@conclave/core/types';
import { cn } from '@/lib/text';

export function TodoStrip({ todos, className }: { todos: Todo[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  if (!todos.length || done === todos.length) return null;
  return (
    <div className={cn('mx-auto w-full max-w-[924px] px-8 phone:px-4', className)}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="group flex h-8 w-full items-center gap-3 text-left text-[12.5px] phone:h-10 phone:text-[14px]">
        <span className="num shrink-0 text-fg-3">
          {done} of {todos.length}
        </span>
        <span className={cn('min-w-0 flex-1 truncate', active ? 'text-fg' : 'text-fg-3')}>{active ? (active.activeForm ?? active.content) : 'Next step queued'}</span>
        <ChevronRight aria-hidden strokeWidth={1.75} className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)] group-hover:text-fg-3', open && 'rotate-90')} />
      </button>
      {open && (
        <ol className="mb-2 border-t border-rule anim-fade">
          {todos.map((t, i) => (
            <li key={i} className="grid grid-cols-[20px_minmax(0,1fr)_auto] gap-2 border-b border-rule py-1.5 text-[13px] last:border-b-0 phone:text-[14px]">
              <span className="num font-mono text-[11px] leading-[20px] text-fg-3">{i + 1}</span>
              <span className={cn(t.status === 'completed' ? 'text-fg-3' : 'text-fg')}>{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
              <span className={cn('text-[12px]', t.status === 'in_progress' ? 'text-signal' : 'text-fg-3')}>{t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'now' : ''}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
