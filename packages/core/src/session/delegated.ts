/**
 * Delegated work (docs/DESIGN.md 43): a session a Delegate call started. It
 * runs under its caller (parentId), marked as a subagent and tagged
 * `delegated`, with `meta.delegate` saying where it ran. The apps list it in
 * a "Delegated work" group of its own, and the owner can move one to the
 * main list: the subagent and delegated marks go, `parentId` stays for
 * history, and `meta.delegate` is kept as `meta.movedFrom`. From then on it
 * is a normal session of its kind (Code or Assistant).
 *
 * Pure, so the hub, the web app and the tests share it.
 */
import type { Session } from '../types';

type Marked = Pick<Session, 'parentId' | 'tags' | 'meta'>;

/** Where a delegated job ran, as the Delegate call set it (tools/delegate.ts DelegatePlace plus the call id). */
export interface DelegateMark {
  to?: 'code' | 'assistant';
  device?: string;
  deviceName?: string;
  folder?: string;
  readOnly?: boolean;
  permissionMode?: Session['permissionMode'];
  toolUseId?: string;
}

/** meta.movedFrom: the delegate mark it had, and when it moved to the main list. */
export interface MovedFrom extends DelegateMark {
  at: number;
}

function obj<T>(v: unknown): T | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : undefined;
}

/** It moved to the main list: a normal session now, whatever its parentId says. */
export function movedToMain(s: Pick<Session, 'meta'>): boolean {
  return !!obj(s.meta?.movedFrom);
}

/** A Delegate call's session that is still in Delegated work (not moved to the main list). */
export function isDelegated(s: Marked): boolean {
  if (movedToMain(s)) return false;
  return !!obj(s.meta?.delegate) || (s.tags ?? []).includes('delegated');
}

/**
 * The session runs under another one: a subagent, a workflow's agent or
 * delegated work. A session moved to the main list keeps its parentId for
 * history but stands on its own.
 */
export function underParent(s: Pick<Session, 'parentId' | 'meta'>): boolean {
  return !!s.parentId && !movedToMain(s);
}

/** Where its job ran: meta.delegate, or meta.movedFrom once it moved. */
export function delegateMark(s: Pick<Session, 'meta'> | undefined): DelegateMark | undefined {
  return obj<DelegateMark>(s?.meta?.delegate) ?? obj<DelegateMark>(s?.meta?.movedFrom);
}

/** The marks a subagent carries, in its tags. */
const MARK_TAGS = new Set(['subagent', 'delegated']);

/**
 * The session as it is once moved to the main list: no subagent or
 * delegated tag, no meta.subagent, meta.delegate kept as meta.movedFrom, and
 * updatedAt now so it sits at the top of its list. parentId stays.
 */
export function movedSession(s: Session, now = Date.now()): Session {
  const meta: Record<string, unknown> = { ...(s.meta ?? {}) };
  const mark = obj<DelegateMark>(meta.delegate) ?? {};
  delete meta.subagent;
  delete meta.delegate;
  meta.movedFrom = { ...mark, at: now } satisfies MovedFrom;
  return { ...s, tags: (s.tags ?? []).filter((t) => !MARK_TAGS.has(t)), meta, updatedAt: now };
}
