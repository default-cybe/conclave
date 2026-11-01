/**
 * Signed one-tap approval links for notifications (the Allow and Deny
 * buttons on a Web Push notification). The link carries an HMAC over
 * approval id + decision, so it works without a bearer token but cannot be
 * changed or reused for another approval.
 *
 * Algorithm (so other packages can build the same URL without importing
 * this file): secret = repos.kv.get('server.actionSecret'), a random string;
 * sig = base64url(HMAC-SHA256(secret, `${approvalId}:${decision}`)).
 * URL: POST <publicUrl>/api/approvals/<id>/act?decision=<decision>&sig=<sig>
 * (core/notify/channels.ts builds it for Web Push).
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { KvRepo } from '@conclave/core/storage/repos.ts';
import { safeEqual } from './auth';

export const ACTION_SECRET_KEY = 'server.actionSecret';

/** allow = once, session = allow for the session, always = add a rule, deny. */
export type ActionDecision = 'allow' | 'session' | 'always' | 'deny';
export const ACTION_DECISIONS: ActionDecision[] = ['allow', 'session', 'always', 'deny'];

/** Read the signing secret, creating it on first use. */
export function actionSecret(kv: KvRepo): string {
  let secret = kv.get<string | null>(ACTION_SECRET_KEY, null);
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    kv.set(ACTION_SECRET_KEY, secret);
  }
  return secret;
}

export function signActionWith(secret: string, approvalId: string, decision: string): string {
  return createHmac('sha256', secret).update(`${approvalId}:${decision}`).digest('base64url');
}

export function verifyActionWith(secret: string, approvalId: string, decision: string, sig: string | undefined | null): boolean {
  if (!sig) return false;
  return safeEqual(signActionWith(secret, approvalId, decision), sig);
}
