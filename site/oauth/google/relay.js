/*
 * The rules of the Google sign-in relay (index.html), apart from the page so
 * they have tests (packages/web/test/oauth-relay-page.test.ts).
 *
 * A hub with no https address of its own signs in with the project's shared
 * Web client, whose only redirect is this page. Google sends the browser here
 * with ?code&state (or ?error&state). The hub wrote the state as
 * "<random flow id>.<base64url of the hub callback>" (relayState in
 * packages/core/src/pim/oauth-flows.ts). The page sends the browser on to
 * that callback only when it is exactly an http or https origin followed by
 * /api/pim/oauth/google/callback, with no user name or password, and only
 * after the owner presses Continue, so the page never forwards a code by
 * itself. The code alone is useless: the PKCE verifier stays on the hub.
 * Nothing is stored and nothing is loaded from anywhere else.
 */

export const CALLBACK_PATH = '/api/pim/oauth/google/callback';

const MAX = 2048;

/** The callback as a URL when it is exactly <http or https origin> + CALLBACK_PATH; else null. */
export function checkReturn(text) {
  // printable ASCII only: a URL the hub wrote is already in its serialized form
  if (typeof text !== 'string' || text.length > MAX || !/^[\x21-\x7e]+$/.test(text)) return null;
  let u;
  try {
    u = new URL(text);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  // nothing but the origin and the path: no other path, query, fragment, or a spelling that only parses the same
  if (text !== u.origin + CALLBACK_PATH) return null;
  return u;
}

/** The hub callback a state names, or null. */
export function returnUrl(state) {
  if (typeof state !== 'string' || state.length > MAX) return null;
  const m = /^[A-Za-z0-9_-]{16,}\.([A-Za-z0-9_-]+)$/.exec(state);
  if (!m) return null;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) return null;
  let text;
  try {
    text = atob(b64 + '=='.slice(0, (4 - (b64.length % 4)) % 4));
  } catch (e) {
    return null;
  }
  return checkReturn(text);
}

/**
 * What the page does with the query Google sent: the hub to name and the
 * address Continue goes to ({ host, origin, href, error? }), or why not
 * ({ why: 'missing' | 'address' }).
 */
export function relayTarget(search) {
  const q = new URLSearchParams(search);
  const state = q.get('state');
  const code = q.get('code');
  const error = q.get('error');
  if (!state || (!code && !error)) return { why: 'missing' };
  if ((code && code.length > MAX) || (error && error.length > 256)) return { why: 'missing' };
  const back = returnUrl(state);
  if (!back) return { why: 'address' };
  // only what the hub's callback reads goes on
  const out = new URLSearchParams();
  out.set('state', state);
  if (code) out.set('code', code);
  if (error) out.set('error', error);
  return { host: back.host, origin: back.origin, href: back.href + '?' + out.toString(), ...(error ? { error } : {}) };
}
