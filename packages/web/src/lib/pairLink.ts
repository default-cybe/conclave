/**
 * The link a pairing QR code carries (packages/server/src/routes.ts,
 * pairDeepLink): the hub's best address, its pairing code, the fingerprint
 * of its key, and other addresses it answers at.
 *
 *   conclave://pair?url=http%3A%2F%2F192.168.1.20%3A7717&code=ABCD-EFGH&fp=6d24...&alt=https%3A%2F%2F...
 */
export interface PairLink {
  /** Addresses to try, best first. */
  urls: string[];
  /** "ABCD-EFGH". */
  code: string;
  /** 32 lowercase hex characters: the key the hub must hold. */
  fp?: string;
}

const trim = (u: string) => u.trim().replace(/\/+$/, '');

/** The pairing link in a scanned text, or undefined when it is something else. */
export function parsePairLink(text: string): PairLink | undefined {
  const raw = text.trim();
  if (!/^conclave:\/\/pair\b/i.test(raw)) return undefined;
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
  } catch {
    return undefined;
  }
  const clean = (q.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 8) return undefined;
  const urls: string[] = [];
  for (const u of [q.get('url'), ...q.getAll('alt')]) {
    if (!u || !/^https?:\/\/[^\s/]+/i.test(u.trim())) continue;
    const t = trim(u);
    if (!urls.includes(t)) urls.push(t);
  }
  if (!urls.length) return undefined;
  const fp = (q.get('fp') ?? '').toLowerCase();
  return { urls, code: `${clean.slice(0, 4)}-${clean.slice(4)}`, ...(/^[0-9a-f]{32}$/.test(fp) ? { fp } : {}) };
}
