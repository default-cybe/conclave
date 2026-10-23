/**
 * Pure checks for the OAuth server: redirect URIs, PKCE values, client names
 * and the warnings the consent screen shows. No storage, easy to test.
 */
import { createHash } from 'node:crypto';
import { safeEqual } from '../auth';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Why a redirect URI cannot be registered, or undefined when it can. */
export function redirectProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return 'Each redirect URI must be a string.';
  if (raw.length > 2000) return 'A redirect URI may be at most 2000 characters.';
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return 'A redirect URI may not hold spaces or control characters.';
  if (raw.includes('#')) return 'A redirect URI may not have a fragment.';
  // URL parsers read a backslash as a slash and fill in a missing host; take neither
  if (raw.includes('\\')) return 'A redirect URI may not hold a backslash.';
  if (/^https?:/i.test(raw) && !/^https?:\/\/[^/?#]/i.test(raw)) return 'A redirect URI needs a host after the two slashes.';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${raw} is not an absolute URL.`;
  }
  if (u.username || u.password) return 'A redirect URI may not carry a user name or password.';
  if (u.protocol === 'https:') return u.hostname ? undefined : 'An https redirect URI needs a host.';
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return undefined;
  return 'Redirect URIs must use https, or http on localhost, 127.0.0.1 or [::1].';
}

/**
 * The registered URI that a requested one matches, or undefined. An exact
 * string match, except that a loopback URI may carry any port (RFC 8252
 * section 7.3). localhost and 127.0.0.1 do not stand in for each other.
 */
export function matchRedirect(registered: readonly string[], requested: string): string | undefined {
  if (registered.includes(requested)) return requested;
  if (redirectProblem(requested)) return undefined;
  const r = new URL(requested);
  // a loopback URI as the client sent it must already be in its plain form, so what we redirect to is what was checked
  if (r.protocol !== 'http:' || !isLoopbackHost(r.hostname) || r.href !== requested) return undefined;
  for (const reg of registered) {
    let g: URL;
    try {
      g = new URL(reg);
    } catch {
      continue;
    }
    if (g.protocol === 'http:' && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search) return requested;
  }
  return undefined;
}

/** Every registered URI is a loopback one: any program on that computer can finish the sign in. */
export function loopbackOnly(uris: readonly string[]): boolean {
  return uris.length > 0 && uris.every((u) => {
    try {
      return isLoopbackHost(new URL(u).hostname);
    } catch {
      return false;
    }
  });
}

/** Host as people read it: punycode stays punycode, so a lookalike shows. */
export function hostOf(uri: string): string {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function validPkceValue(v: unknown): v is string {
  return typeof v === 'string' && PKCE_VALUE.test(v);
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) equals the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const made = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(made, challenge);
}

/**
 * A client name made safe to show: no control, bidi or zero width
 * characters, spaces collapsed, at most 60 characters.
 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 60 ? `${s.slice(0, 59).trimEnd()}...` : s;
}

/** Names that people trust, and where those apps really send you back. */
const BRANDS: Array<{ re: RegExp; word: string; hosts: string[] }> = [
  { re: /claude|anthropic/i, word: 'Claude', hosts: ['claude.ai', 'claude.com', 'anthropic.com'] },
  { re: /chat\s*-?\s*gpt|open\s*ai/i, word: 'ChatGPT', hosts: ['chatgpt.com', 'openai.com'] },
];

function under(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/**
 * The warning the consent screen shows in amber, or undefined. A loopback
 * redirect can be used by any program on that computer; a famous name on
 * another host is most likely not that app.
 */
export function nameWarning(name: string, redirectUri: string, registered: readonly string[]): string | undefined {
  const host = hostOf(redirectUri);
  if (isLoopbackHost(host) && loopbackOnly(registered)) {
    return 'This app finishes signing in on your own computer. Any program there can use this name. Allow it only if you started this sign in yourself just now, for example from Claude Code.';
  }
  for (const b of BRANDS) {
    if (b.re.test(name) && !b.hosts.some((h) => under(host, h))) {
      return `This app calls itself ${name}, but ${b.word} does not send you back to ${host}. Deny unless you set this app up yourself.`;
    }
  }
  return undefined;
}
