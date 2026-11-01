/**
 * Connection errors that explain (spec 0.3 graft 10, 11.11 step 1): what
 * happened and what to do, in two short sentences.
 */
import type { ReactNode } from 'react';
import { ApiError } from '@conclave/core/client';
import { cannotCheckWords, isCannotCheckError, isHubIdentityError } from '@/lib/identity';

/** Add a scheme when the owner typed only a host ("madx:7420"). */
export function normalizeHubUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return v;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?[0-9a-f:]+\]?(:\d+)?$)/i.test(v);
  return `${local ? 'http' : 'https'}://${v}`;
}

/**
 * What was typed could be a hub address: a URL with its scheme, a dotted name,
 * localhost, an IP, or a name with a port. A bare word ("kaivalya") is a name
 * typed in the wrong field, often by a password manager.
 */
export function looksLikeHubUrl(raw: string): boolean {
  const v = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return true;
  try {
    const u = new URL(normalizeHubUrl(v));
    return u.hostname === 'localhost' || u.hostname.includes('.') || u.hostname.startsWith('[') || !!u.port;
  } catch {
    return false;
  }
}

export function hubHost(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function hubPort(url: string): string {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return '';
  }
}

const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

export function explainConnectError(e: unknown, url: string, kind: 'token' | 'code' | 'password'): ReactNode {
  let valid = true;
  try {
    new URL(url);
  } catch {
    valid = false;
  }
  if (!valid)
    return (
      <>
        That address is not a URL. Use the form <Mono>https://hub.example.com</Mono> or <Mono>http://192.168.1.20:7717</Mono>.
      </>
    );
  const host = hubHost(url).replace(/:\d+$/, '');
  // an address that holds another key; nothing was sent
  if (isHubIdentityError(e)) return e.message;
  // no Ed25519 here (iOS before 17): the client could not check the hub, so it sent nothing
  if (isCannotCheckError(e)) return cannotCheckWords(e);
  if (kind === 'password') {
    // an older hub has no password login
    if (e instanceof ApiError && e.status === 404) return <>{host} does not take a password. Update the hub, or pair with a code from its Devices page.</>;
    // the hub's own words ("Wrong password, or no password is set on this hub."), or the client's
    // ("Use the https address of your hub to log in with a password."); a TypeError is no answer at all
    if (e instanceof ApiError || (e instanceof Error && !(e instanceof TypeError) && e.message)) return e.message.replace(/\.?$/, '.');
  }
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403)
      return kind === 'token' ? (
        <>
          {host} refused this token. Copy it again from <Mono>server.token</Mono> in <Mono>~/.conclave/config.json</Mono>.
        </>
      ) : (
        <>{host} refused the pairing. Make a new code and try again.</>
      );
    if (kind === 'code' && (e.status === 400 || e.status === 404 || e.status === 410))
      return (
        <>
          That code is wrong or has expired. Make a new one under Devices, Pair a device, App or browser (a code made under Computer, command line only works with the conclave command), or run <Mono>conclave pair-phone</Mono> on the hub.
        </>
      );
    if (e.status === 404)
      return (
        <>
          {host} answered, but it is not a Conclave hub. Check the port; the hub prints its address when <Mono>conclave serve</Mono> starts.
        </>
      );
    return (
      <>
        {host} answered with {e.status}. {e.message.replace(/\.?$/, '.')}
      </>
    );
  }
  return (
    <>
      Could not reach {host} on port {hubPort(url)}. Check that <Mono>conclave serve</Mono> is running. A quick tunnel address changes when the hub restarts, so scan a new code.
    </>
  );
}
