/**
 * Asking the owner for an approval grant (docs/design/SECURITY-MODE.md 4.3):
 * lib.approve({ grant }) in a workflow started from a Security mode session.
 *
 * - The grant is stored on the hunt (the topmost scope-guard session), so one
 *   grant covers every lead and Task child of that hunt.
 * - A live grant that already covers the hosts answers yes without a card.
 * - Otherwise a SecurityGrant card: "Allow live requests to <host>?", Grant
 *   for 24 hours or Deny, never "always". A member's session gets no grant
 *   (lab only in v1) and an unattended run never asks (it stays lab-only).
 */
import type { Engine } from '../engine/engine';
import type { Session } from '../types';
import { addGrant, checkGrant, coveringGrant, grantCardText, grantsOf } from '../security/grants';
import { GRANT_MAX_MS } from '../security/scope';
import { guardAnchor, loadScope } from './scope-guard';

export type GrantOutcome = { granted: true; grantId: string; asked: boolean } | { granted: false; why: string };

export async function requestGrant(engine: Engine, session: Session, raw: unknown, signal: AbortSignal, label = 'Security mode'): Promise<GrantOutcome> {
  const anchor = guardAnchor(engine, session);
  if (!anchor) return { granted: false, why: 'approval grants exist only in a Security mode session (an agent with the scope-guard recipe)' };
  if (engine.isMemberSession(anchor) || engine.isMemberSession(session)) return { granted: false, why: 'Security mode is lab-only for members in v1: no grant' };
  const st = await loadScope(engine.machineFor(anchor), anchor.cwd);
  if (st.kind !== 'ok') return { granted: false, why: st.kind === 'bad' ? `the scope file is not usable: ${st.why}` : 'no scope.yaml in the hunt folder' };
  const c = checkGrant(raw, st.scopes, st.files);
  if (!c.ok) return { granted: false, why: c.why };
  const have = coveringGrant(grantsOf(engine.repos.kv, anchor.id), c.grant.hosts);
  if (have) return { granted: true, grantId: have.id, asked: false };
  const host = c.grant.hosts.length > 1 ? `${c.grant.hosts[0]} and ${c.grant.hosts.length - 1} more` : c.grant.hosts[0];
  // asked where the call came from; the card shows in the hunt's chat too (engine/ask-origin.ts)
  const res = await engine.requestApproval(
    session.id,
    {
      toolUseId: `grant_${Date.now().toString(36)}`,
      tool: 'SecurityGrant',
      input: { host, hosts: c.grant.hosts, content: grantCardText(c, Date.now() + GRANT_MAX_MS), ...(c.grant.reason ? { reason: c.grant.reason } : {}) },
      summary: `${label}: grant live requests to ${host}`,
      noAlways: true,
    },
    signal,
  );
  if (res.decision !== 'allow') return { granted: false, why: 'the owner did not grant it' };
  const g = addGrant(engine.repos.kv, anchor.id, c.grant);
  engine.audit(anchor.id, 'security.grant', `${g.id} ${g.hosts.join(',')} budget ${g.requestBudget} rate ${g.rateRps}/s until ${new Date(g.expiresAt).toISOString()}`);
  return { granted: true, grantId: g.id, asked: true };
}
