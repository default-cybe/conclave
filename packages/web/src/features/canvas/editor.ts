/**
 * Canvas mode, PR 2: editing (docs/design/CANVAS-MODE.md 5 and 6). Every
 * edit goes to the file at once through the hub's graph ops; there is no
 * Save button (owner decision on #250). Undo and redo put back the version
 * before or after a step through the hub's restore route, so a step of many
 * ops (a paste, a multi-delete) is one undo. When the file changed on disk
 * since the canvas read it, the hub answers 409: the canvas reloads the
 * file, forgets its undo steps (they would put back versions over someone
 * else's edit) and says so, instead of writing over it.
 *
 * The pure parts (clipboard, paste, delete order) are at the top so tests
 * run them against the real flow parser.
 */
import { useRef, useState } from 'react';
import { ApiError, type FlowOp, type GraphNode, type WorkflowGraph } from '@conclave/core/client';
import { toast } from '@/store/store';
import { History, useHistory } from '../graph/history';

// ---------------------------------------------------------------------------
// Copy, paste and delete for program blocks
// ---------------------------------------------------------------------------

/** One copied block: its kind, its name, and each input as a setting or a wire. */
export interface ClipBlock {
  block: string;
  name?: string;
  args: Record<string, { value: string | number | boolean } | { ref: string; field?: string }>;
}

/** What Ctrl/Cmd+C holds: blocks of one file, in file order. Code is left out: there is no op that writes it. */
export interface Clip {
  file: string;
  blocks: ClipBlock[];
  skipped: number;
}

export function copyClip(file: string, graph: WorkflowGraph, ids: string[]): Clip {
  const picked = graph.nodes.filter((n) => ids.includes(n.id));
  const blocks: ClipBlock[] = [];
  for (const n of picked) {
    if (n.kind !== 'block' || !n.block || Object.values(n.args ?? {}).some((a) => a.locked)) continue;
    const args: ClipBlock['args'] = {};
    for (const [k, a] of Object.entries(n.args ?? {})) {
      if (a.ref) args[k] = { ref: a.ref, ...(a.field ? { field: a.field } : {}) };
      else if (a.value !== undefined) args[k] = { value: a.value };
    }
    blocks.push({ block: n.block, ...(n.declares[0] ? { name: n.declares[0] } : {}), args });
  }
  return { file, blocks, skipped: picked.length - blocks.length };
}

type Send = (op: FlowOp) => Promise<{ nodeId?: string }>;

/**
 * Paste: each block is inserted at the end of the file with a fresh name,
 * then its settings are set and its wires connected. A wire to another
 * pasted block goes to that block's copy; a wire to a block outside the
 * paste goes to the same block, which is above the copy. Returns the new
 * node ids in order.
 */
export async function pasteClip(clip: Clip, send: Send, defaults: (block: string, input: string) => unknown): Promise<string[]> {
  const renamed = new Map<string, string>();
  const out: string[] = [];
  for (const b of clip.blocks) {
    const { nodeId } = await send({ op: 'insert', block: b.block });
    if (!nodeId) continue;
    out.push(nodeId);
    if (b.name) renamed.set(b.name, nodeId);
    for (const [input, a] of Object.entries(b.args)) {
      if ('ref' in a) await send({ op: 'connect', nodeId, input, from: renamed.get(a.ref) ?? a.ref, ...(a.field ? { field: a.field } : {}) });
      else if (a.value !== defaults(b.block, input)) await send({ op: 'set', nodeId, input, value: a.value });
    }
  }
  return out;
}

/** Remove ops for a selection, last block first, so a block is gone before the one it reads. */
export function removeOps(graph: WorkflowGraph, ids: string[]): FlowOp[] {
  return graph.nodes
    .filter((n) => ids.includes(n.id))
    .reverse()
    .map((n) => ({ op: 'remove', nodeId: n.id }));
}

/** A workflow node renames by its label (an agent with a literal label). */
export const workflowRenamable = (n: GraphNode) => n.kind === 'agent' && typeof n.opts?.label?.value === 'string';

/** A program block renames by its variable name. */
export const programRenamable = (n: GraphNode) => n.kind === 'block' && !!n.declares[0];

// ---------------------------------------------------------------------------
// Saving, undo and conflicts
// ---------------------------------------------------------------------------

export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'failed'; reason: string };

/** The status words in the top bar. */
export function saveWords(s: SaveState): { word: string; tone: string } {
  if (s.kind === 'saving') return { word: 'Saving', tone: 'text-fg-3' };
  if (s.kind === 'failed') return { word: `Not saved: ${s.reason}`, tone: 'text-fault' };
  return { word: 'Saved', tone: 'text-fg-3' };
}

export const CONFLICT = 'the file changed on disk, so the canvas reloaded it';

const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409;
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');

export interface EditorIo<V extends { sha: string }> {
  /** Show a version of the file. */
  show: (v: V) => void;
  /** Put back a version the hub wrote: the file must still be `base`. */
  restore: (sha: string, base: string) => Promise<V>;
  /** Read the file again (after a conflict). */
  reload: () => Promise<V>;
  /** The save status changed. */
  status: (s: SaveState) => void;
}

/**
 * The editor of one file, without React (tests drive it directly).
 * `edit(label, run)` runs one step: `run` sends its ops with `base()` (the
 * version the canvas shows now) and hands each result to `took`. A step that
 * wrote something is one undo, even when a later op of it failed.
 */
export class FileEditor<V extends { sha: string }> {
  sha = '';
  busy = false;
  readonly history = new History();
  constructor(public io: EditorIo<V>) {}

  /** The version the canvas shows; ignored while a step runs (it may not have handed back its last write yet). */
  shows(sha: string): void {
    if (!this.busy) this.sha = sha;
  }

  private take = (v: V) => {
    this.sha = v.sha;
    this.io.show(v);
  };

  /** A conflict: show the file as it is now, drop the undo steps, say so. Other errors keep the canvas as it is. */
  private async failed(e: unknown): Promise<void> {
    if (isConflict(e)) {
      const v = await this.io.reload().catch(() => undefined);
      if (v) this.take(v);
      this.history.clear();
      this.io.status({ kind: 'failed', reason: CONFLICT });
      toast({ title: 'The file changed on disk', body: 'The canvas reloaded it and did not write your edit. Undo starts again from here.', level: 'warning' });
      return;
    }
    this.io.status({ kind: 'failed', reason: reasonOf(e) });
  }

  private async go(target: string): Promise<void> {
    this.busy = true;
    this.io.status({ kind: 'saving' });
    try {
      this.take(await this.io.restore(target, this.sha));
      this.io.status({ kind: 'saved' });
    } catch (e) {
      await this.failed(e);
      // a conflict is said and handled; anything else keeps the step on its stack
      if (!isConflict(e)) throw e;
    } finally {
      this.busy = false;
    }
  }

  async edit<T>(label: string, run: (base: () => string, took: (v: V) => void) => Promise<T>, extra?: { undo: () => Promise<unknown>; redo: () => Promise<unknown> }): Promise<T | undefined> {
    const before = this.sha;
    this.busy = true;
    this.io.status({ kind: 'saving' });
    let out: T | undefined;
    let err: unknown;
    try {
      out = await run(() => this.sha, this.take);
    } catch (e) {
      err = e;
    } finally {
      this.busy = false;
    }
    const after = this.sha;
    if (after !== before && !isConflict(err))
      this.history.push({
        label,
        undo: async () => {
          await this.go(before);
          await extra?.undo();
        },
        redo: async () => {
          await this.go(after);
          await extra?.redo();
        },
      });
    if (err === undefined) this.io.status({ kind: 'saved' });
    else {
      await this.failed(err);
      if (!isConflict(err)) toast({ title: reasonOf(err), level: 'error' });
    }
    return out;
  }
}

/** A FileEditor for one open file, with Ctrl/Cmd+Z and Shift+Z bound while there is a view. */
export function useEditor<V extends { sha: string }>({ view, setView, restore, reload }: { view: V | undefined; setView: (v: V) => void } & Omit<EditorIo<V>, 'show' | 'status'>) {
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const ed = useRef<FileEditor<V>>(undefined);
  ed.current ??= new FileEditor<V>({ show: setView, restore, reload, status: setState });
  // the newest callbacks: they close over this render's session and name
  ed.current.io = { show: setView, restore, reload, status: setState };
  if (view) ed.current.shows(view.sha);
  const history = useHistory(!!view, ed.current.history);
  const e = ed.current;
  return {
    state,
    history,
    edit: e.edit.bind(e) as FileEditor<V>['edit'],
    /** A step that is not a script write (a node moved): it goes on the same undo stack. */
    push: (label: string, undo: () => Promise<unknown>, redo: () => Promise<unknown>) => history.push({ label, undo, redo }),
  };
}
