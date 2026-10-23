/**
 * Hub identity in the app (docs/design/HUB-LOGIN-AND-IDENTITY.md): the
 * fingerprint in groups of four, the HubIdentityError the shared client
 * throws when an address answers with another key, and the plain error it
 * throws where WebCrypto has no Ed25519 (iOS before 17). A request or the
 * socket that meets another key reports it here, and the app shows the full
 * screen state.
 */
import { formatFingerprint, HubIdentityError } from '@conclave/core/client';

/** The address answered with another key or a bad signature. By name too, for an error from another copy of the client. */
export function isHubIdentityError(e: unknown): e is HubIdentityError {
  return e instanceof HubIdentityError || (e instanceof Error && e.name === 'HubIdentityError');
}

/** "3f2a9c1b..." as ["3f2a", "9c1b", ...]: the fingerprint the way people compare it. */
export function fingerprintGroups(fingerprint: string | undefined): string[] {
  const clean = (fingerprint ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return clean ? formatFingerprint(clean).split(' ') : [];
}

/**
 * The client could not check the hub's key on this platform (no Ed25519 in
 * WebCrypto, or no WebCrypto on a plain http page) and sent nothing. Its
 * error is a plain Error, known by its words.
 */
export function isCannotCheckError(e: unknown): e is Error {
  return e instanceof Error && !(e instanceof TypeError) && /cannot check the hub's key/i.test(e.message);
}

/** What to tell the owner when this platform cannot check the hub: an iPhone's own words, else the client's. */
export function cannotCheckWords(e: Error): string {
  const ios = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios ? 'This iPhone needs iOS 17 or later to check the hub. Conclave did not send your sign-in.' : e.message;
}

const listeners = new Set<(e: HubIdentityError) => void>();

/** Called with each HubIdentityError a request or the socket meets. Returns a function that stops it. */
export function onHubIdentityError(fn: (e: HubIdentityError) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Pass on an error if it is a HubIdentityError. True when it was one. */
export function reportHubError(e: unknown): boolean {
  if (!isHubIdentityError(e)) return false;
  for (const fn of listeners) fn(e);
  return true;
}
