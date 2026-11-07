/**
 * The notes strip at the top of every Chat and Code conversation: one line
 * ("3 to do: Call the bank") that opens into a short checklist. One list per
 * account, shared by every chat (notes.ts). Hidden until the first note,
 * added from the chat's menu ("Add a note"). Escape folds it back.
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ChevronRight, GripVertical, Pencil, X } from 'lucide-react';
import type { Task } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, removeKey, upsertTask, useHub } from '@/store/store';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/text';
import { useIsMobile, useNow } from '@/lib/hooks';
import { IconButton } from '@/components/ui/Button';
import { Checkbox, Input } from '@/components/ui/Field';
import { NOTE_LABEL, nextOrder, orderAt, stripLine, stripNotes } from './notes';

/** Opens the strip with the add box focused (the chat menus' "Add a note"). */
export const addNote = () => useUi.getState().set({ notes: 'add' });

/** narrow: Chat's 784px column; Code's is 924px. */
export function NotesStrip({ narrow }: { narrow?: boolean }) {
  const tasks = useHub((s) => s.tasks);
  const now = useNow(60_000);
  const notes = stripNotes(Object.values(tasks), now);
  const state = useUi((s) => s.notes);
  return <NotesView notes={notes} state={state} narrow={narrow} />;
}

export function NotesView({ notes, state, narrow }: { notes: Task[]; state: 'closed' | 'open' | 'add'; narrow?: boolean }) {
  const set = useUi((s) => s.set);
  const open = state !== 'closed';
  const line = stripLine(notes);
  const collapse = () => set({ notes: 'closed' });
  // nothing until the first note, unless Add a note opened it
  if (!notes.length && !open) return null;
  return (
    <div
      className="shrink-0 border-b border-rule"
      onKeyDown={(e) => {
        // Escape folds the strip; the chat's own Escape (Stop) checks defaultPrevented
        if (e.key === 'Escape' && open && !e.defaultPrevented) {
          e.preventDefault();
          collapse();
        }
      }}
    >
      <div className={cn('mx-auto w-full px-8 phone:px-4', narrow ? 'max-w-[784px]' : 'max-w-[924px]')}>
        <button type="button" aria-expanded={open} onClick={() => set({ notes: open ? 'closed' : 'open' })} className="group flex h-8 w-full items-center gap-2 text-left text-[12.5px] phone:h-10 phone:text-[14px]">
          <span className="num shrink-0 text-fg-3">{notes.length ? line.count : 'Notes'}</span>
          {line.first && <span className="min-w-0 flex-1 truncate text-fg">{line.first}</span>}
          {!line.first && <span className="flex-1" />}
          <ChevronRight aria-hidden strokeWidth={1.75} className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)] group-hover:text-fg-3', open && 'rotate-90')} />
        </button>
        {open && <NotesList notes={notes} focusAdd={state === 'add'} />}
      </div>
    </div>
  );
}

function NotesList({ notes, focusAdd }: { notes: Task[]; focusAdd: boolean }) {
  const mobile = useIsMobile();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const open = notes.filter((t) => t.status !== 'done');

  const drop = (e: DragEvent, at: number) => {
    e.preventDefault();
    const id = drag;
    setDrag(null);
    setOver(null);
    const t = open.find((n) => n.id === id);
    if (!t) return;
    const from = open.indexOf(t);
    const rest = open.filter((n) => n.id !== id);
    // dropped on a row: it takes that row's place (moving down lands after it, moving up before it)
    if (at === from) return;
    void save(t, { meta: { ...t.meta, noteOrder: orderAt(rest, at) } });
  };

  return (
    <div className="mb-2 border-t border-rule anim-fade">
      <ul aria-label="Notes">
        {notes.map((t, i) => (
          <NoteRow
            key={t.id}
            t={t}
            draggable={!mobile && t.status !== 'done'}
            dragging={drag === t.id}
            over={over === i && drag !== t.id}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              setDrag(t.id);
            }}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!drag || t.status === 'done') return;
              e.preventDefault();
              setOver(i);
            }}
            onDrop={(e) => drop(e, i)}
          />
        ))}
      </ul>
      <AddNote autoFocus={focusAdd} order={nextOrder(open)} />
    </div>
  );
}

async function save(t: Task, patch: Partial<Task>) {
  const next = await attempt(() => api().updateTask(t.id, patch));
  if (next) upsertTask(next);
}

function NoteRow({
  t,
  draggable,
  dragging,
  over,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  t: Task;
  draggable: boolean;
  dragging: boolean;
  over: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const done = t.status === 'done';
  const finish = () => {
    setEditing(false);
    const v = title.trim();
    if (v && v !== t.title) void save(t, { title: v });
  };
  return (
    <li
      draggable={draggable && !editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn('group flex min-h-9 items-center gap-1 border-b border-rule text-[13px] last:border-b-0 phone:min-h-11 phone:text-[14px]', dragging && 'opacity-50', over && 'shadow-[inset_0_2px_0_var(--signal)]')}
    >
      {draggable && <GripVertical aria-hidden strokeWidth={1.75} className="-ml-4 size-3 shrink-0 cursor-grab text-fg-4 opacity-0 group-hover:opacity-100" />}
      {editing ? (
        <Input
          autoFocus
          size="sm"
          value={title}
          aria-label="Edit note"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish();
            } else if (e.key === 'Escape') {
              // cancels the edit only; a second Escape folds the strip
              e.preventDefault();
              e.stopPropagation();
              setTitle(t.title);
              setEditing(false);
            }
          }}
          className="my-1 flex-1"
        />
      ) : (
        <Checkbox
          checked={done}
          onChange={(v) => void save(t, { status: v ? 'done' : 'todo' })}
          label={<span className={cn(done && 'text-fg-3 line-through')}>{t.title}</span>}
          className="min-w-0 flex-1"
        />
      )}
      {!editing && (
        <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 phone:opacity-100">
          {!done && (
            <IconButton
              label="Edit"
              size="sm"
              onClick={() => {
                setTitle(t.title);
                setEditing(true);
              }}
            >
              <Pencil />
            </IconButton>
          )}
          <IconButton
            label="Delete"
            size="sm"
            onClick={async () => {
              if (await attempt(() => api().deleteTask(t.id))) removeKey('tasks', t.id);
            }}
          >
            <X />
          </IconButton>
        </span>
      )}
    </li>
  );
}

function AddNote({ autoFocus, order }: { autoFocus: boolean; order: number }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <form
      className="pt-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const v = title.trim();
        if (!v || busy) return;
        setBusy(true);
        const t = await attempt(() => api().createTask({ title: v, status: 'todo', labels: [NOTE_LABEL], meta: { noteOrder: order } }));
        setBusy(false);
        if (t) {
          upsertTask(t);
          setTitle('');
        }
      }}
    >
      <Input ref={ref} size="sm" value={title} placeholder="Add a note" aria-label="Add a note" onChange={(e) => setTitle(e.target.value)} readOnly={busy} />
    </form>
  );
}
