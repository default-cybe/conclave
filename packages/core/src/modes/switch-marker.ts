/**
 * The switch marker: one hidden line on the first request after a switch,
 * telling the new model it took over, so it continues instead of planning
 * from scratch. The engine records a pending switch on the session
 * (meta.switched) when the model of a session with history changes; the
 * runner adds the line as a reminder on the next user message and clears the
 * mark. The line is stored with that message and never edited, so the cached
 * prefix stays the same.
 */

export interface PendingSwitch {
  /** The model that wrote the replies so far. */
  from: string;
  /** The model the session moved to. */
  to: string;
}

/** The pending switch after another model change: the first model is kept, and a switch back clears it. */
export function nextSwitch(pending: unknown, from: string, to: string): PendingSwitch | undefined {
  const p = pending && typeof pending === 'object' ? (pending as Partial<PendingSwitch>) : undefined;
  const origin = typeof p?.from === 'string' ? p.from : from;
  return origin === to ? undefined : { from: origin, to };
}

/** The pending switch on a session's meta, if any. */
export function pendingSwitch(meta: Record<string, unknown> | undefined): PendingSwitch | undefined {
  const p = meta?.switched as Partial<PendingSwitch> | undefined;
  return p && typeof p.from === 'string' && typeof p.to === 'string' ? { from: p.from, to: p.to } : undefined;
}

/** The line the new model reads. */
export function switchNote(from: string): string {
  return `You took over this conversation from ${from}. Continue from where it stopped instead of planning again; its private reasoning is not available, so check the current state before you repeat an action.`;
}
