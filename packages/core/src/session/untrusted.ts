/**
 * Sessions that read untrusted input (DESIGN.md, Security): a session of an
 * agent marked untrusted (email, web pages), a subagent one of them started,
 * and a routine run that a webhook payload reached. Text from outside can try
 * to steer the model, so such a session:
 *
 * - is offered only the tools its routine or its agent names (tools/index.ts filterTools),
 * - asks before every call that no routine allow rule covers, read-only ones too,
 *   and nobody can answer "always allow" for it (engine.resolveApproval),
 * - leaves no trace in memory and is never searched (no profile, no recall, no extraction),
 * - gets framework tags in outside text defused before the text reaches a turn.
 */
import type { Session } from '../types';

/** True for a session marked untrusted itself; pass the agent's flag for the full answer. */
export function isUntrusted(session: Pick<Session, 'meta'>, agentUntrusted?: boolean): boolean {
  return session.meta?.untrusted === true || !!agentUntrusted;
}

/**
 * Tags the framework uses to frame text for the model. Copies of them inside
 * outside text could close a block early or pass text off as the harness.
 */
export const FRAMEWORK_TAGS = [
  'system-reminder',
  'conversation_summary',
  'aside',
  'subagent_result',
  'routine-payload',
  'hub-data',
  'untrusted_web_content',
  'untrusted_mail_content',
  'past-sessions',
  'past-session',
  'memories',
  'prior_conversation',
  'agent-profile',
  'task-notification',
  'shared-history',
  'friend-shared-context',
  // meeting mode: what people said in a call (meeting/answer.ts)
  'meeting-transcript',
];

const TAG_RE = new RegExp(`<(\\s*\\/?\\s*)(${FRAMEWORK_TAGS.join('|')})(?=[\\s>/]|$)`, 'gi');

/** Turn each framework tag in outside text into "&lt;tag", so it reads as text, not as a block. */
export function defuseFrameworkTags(text: string): string {
  return text.replace(TAG_RE, '&lt;$1$2');
}
