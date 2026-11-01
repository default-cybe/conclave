/**
 * Whose a bus event is (docs/design/ACCOUNTS.md 4, Sockets). The bus stamps
 * every event with the account this returns when it is emitted; the server
 * sends an event only to sockets of that account. '*' is for everyone (hub
 * wide events). undefined means it could not be placed: the owner only.
 */
import type { EngineEvent } from '../types';
import { OWNER_ID } from './context';

/** Events every signed in account may get. */
export const HUB_WIDE_EVENTS = new Set<EngineEvent['type']>(['remote.updated', 'config.updated', 'models.updated']);

/** Events that are the owner's: hub settings, provider accounts, friends. */
const OWNER_EVENTS = new Set<EngineEvent['type']>([
  'limit.updated',
  'subscriptions.updated',
  'accounts.updated',
  'friend.updated',
  'friend.message',
  'friend.share',
  'friend.share.sent',
  // shared projects are between the owner's hub and friends' hubs
  'friend.project',
]);

export interface AccountLookup {
  session(id: string): string | undefined;
  workflowRun?(id: string): string | undefined;
  routine?(id: string): string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** The session id an event is about, wherever the event keeps it. */
function sessionOf(e: Record<string, any>): string | undefined {
  return (
    str(e.sessionId) ??
    str(e.session?.id) ??
    str(e.message?.sessionId) ??
    str(e.approval?.sessionId) ??
    str(e.question?.sessionId) ??
    str(e.notice?.sessionId) ??
    str(e.alert?.sessionId) ??
    str(e.record?.sessionId) ??
    str(e.run?.sessionId)
  );
}

/** The owner's plan events, unless one says it is a member's own plans (server/src/cliproxy/member.ts): then that member's only. */
const PLAN_EVENTS = new Set<EngineEvent['type']>(['subscriptions.updated', 'accounts.updated']);

export function eventAccount(e: EngineEvent, lookup: AccountLookup): string | undefined {
  if (HUB_WIDE_EVENTS.has(e.type)) return '*';
  const any = e as Record<string, any>;
  if (PLAN_EVENTS.has(e.type)) return str(any.accountId) ?? OWNER_ID;
  if (OWNER_EVENTS.has(e.type)) return OWNER_ID;
  // an object that says whose it is: the event, a session, routine, task, memory, device, app, notice, usage row, batch or project
  const own =
    str(any.accountId) ??
    str(any.session?.accountId) ??
    str(any.routine?.accountId) ??
    str(any.task?.accountId) ??
    str(any.entry?.accountId) ??
    str(any.device?.accountId) ??
    str(any.app?.accountId) ??
    str(any.notice?.accountId) ??
    str(any.record?.accountId) ??
    str(any.batch?.accountId) ??
    str(any.project?.accountId) ??
    str(any.run?.accountId) ??
    str(any.delta?.accountId);
  if (own) return own;
  if (e.type === 'routine.run' && lookup.routine) return lookup.routine(e.run.routineId);
  const sid = sessionOf(any);
  if (sid) return lookup.session(sid);
  const runId = str(any.runId) ?? str(any.call?.runId);
  if (runId && lookup.workflowRun) return lookup.workflowRun(runId);
  return undefined;
}

/** May a socket of `accountId` get an event stamped `stamp`? */
export function eventVisibleTo(stamp: string | undefined, accountId: string): boolean {
  if (stamp === '*') return true;
  return (stamp ?? OWNER_ID) === accountId;
}
