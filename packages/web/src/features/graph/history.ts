/**
 * Undo and redo for canvas edits (docs/design/VISUAL-PROGRAMMING.md 9.2),
 * built here because React Flow's is Pro-only. A step knows how to go back
 * and forward: a move puts the layout back, a script edit asks the hub to
 * put back the version it wrote (POST /graph/restore). Steps run one at a
 * time; a new edit clears what could be redone. Ctrl+Z (Cmd+Z) undoes,
 * Ctrl+Shift+Z or Ctrl+Y redoes, not while typing in a field.
 */
import { useEffect, useRef, useState } from 'react';
import { attempt } from '@/store/store';

export interface Step {
  /** What it did, for the button's title: "move", "prompt". */
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

const MAX = 100;

export class History {
  past: Step[] = [];
  future: Step[] = [];
  busy = false;

  push(s: Step): void {
    this.past.push(s);
    if (this.past.length > MAX) this.past.shift();
    this.future = [];
  }

  /** Undo the last step. A step that fails stays where it was, so nothing is lost. */
  async undo(): Promise<Step | undefined> {
    return this.run(this.past, this.future, 'undo');
  }

  async redo(): Promise<Step | undefined> {
    return this.run(this.future, this.past, 'redo');
  }

  private async run(from: Step[], to: Step[], how: 'undo' | 'redo'): Promise<Step | undefined> {
    const s = from[from.length - 1];
    if (!s || this.busy) return undefined;
    this.busy = true;
    try {
      await s[how]();
      from.pop();
      to.push(s);
      return s;
    } finally {
      this.busy = false;
    }
  }
}

type Positions = Record<string, { x: number; y: number }>;

/**
 * The step for a node added from the search. The hub renumbered the saved
 * positions for the insert (shiftLayout), so with a layout, undo puts the
 * old keys back after the old script and redo the shifted ones after the new.
 */
export function insertStep(restore: (sha: string) => Promise<unknown>, saveLayout: (p: Positions) => Promise<unknown>, before: { sha: string; layout: Positions }, after: { sha: string; layout?: Positions }): Step {
  const shifted = after.layout;
  if (!shifted) return { label: 'new node', undo: () => restore(before.sha), redo: () => restore(after.sha) };
  return {
    label: 'new node',
    undo: async () => {
      await restore(before.sha);
      await saveLayout(before.layout);
    },
    redo: async () => {
      await restore(after.sha);
      await saveLayout(shifted);
    },
  };
}

/** A History for one canvas, with the keys bound while it is mounted. */
export function useHistory(enabled: boolean) {
  const h = useRef(new History()).current;
  const [, tick] = useState(0);
  const bump = () => tick((n) => n + 1);
  // a failed step (the file changed, the hub restarted) says why in a toast and stays on its stack
  const undo = () => void attempt(() => h.undo()).finally(bump);
  const redo = () => void attempt(() => h.redo()).finally(bump);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || (k === 'y' && !e.metaKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return {
    push: (s: Step) => {
      h.push(s);
      bump();
    },
    undo,
    redo,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    nextUndo: h.past[h.past.length - 1]?.label,
    nextRedo: h.future[h.future.length - 1]?.label,
  };
}
