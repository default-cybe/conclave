/**
 * "Same model for all work" (chat.sameModel, the switch in the model picker):
 * work a session hands off (Delegate, Task, workflow agents, their nested
 * subagents) runs on the chat's current model instead of each agent
 * profile's own model or tier word. A provider/model ref passed as a tool
 * argument still wins: that is how the owner names another model.
 *
 * Children carry the switch (subagent.ts), and the pin is the model of the
 * topmost session in the chain that has it on, read at hand-off time, so a
 * switch in the picker moves the pin for new hand-offs. Routines start fresh
 * sessions and never inherit it.
 */
import type { Engine } from '../engine/engine';
import type { Session } from '../types';
import { isMember } from '../people/context';
import { memberCanUse } from './member-fallbacks';

/** The model hand-offs from this session are pinned to, or undefined when the switch is off. */
export function modelPin(engine: Engine, s: Session): string | undefined {
  if (!s.chat?.sameModel) return undefined;
  let root = s;
  // up through subagents and delegated work (a session moved to the main list has no meta.subagent) while the parent pins too
  for (let i = 0; i < 32 && root.parentId && root.meta?.subagent; i++) {
    const p = engine.getSession(root.parentId);
    if (!p?.chat?.sameModel) break;
    root = p;
  }
  // a member pins only to a model their account may use, never the owner's plans
  const acct = engine.accountOf(root);
  if (isMember(acct) && !memberCanUse(engine, acct, root.model)) return undefined;
  return root.model;
}
