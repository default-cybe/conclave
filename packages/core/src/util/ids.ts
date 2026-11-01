import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Sortable id: 8 chars of base36 time + 10 random chars, with an optional prefix.
 * Sorting ids by string sorts them by creation time.
 */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const bytes = randomBytes(10);
  let r = '';
  for (const b of bytes) r += ALPHABET[b % 36];
  return prefix ? `${prefix}_${t}${r}` : `${t}${r}`;
}

/** Tool use ids must match ^[a-zA-Z0-9_-]+$ for Anthropic. */
export function sanitizeToolId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.length ? clean.slice(0, 64) : newId('toolu');
}
