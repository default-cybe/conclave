/**
 * Several keys per web search engine, used in order: when one runs out of
 * credit or is refused, WebSearch marks it and goes on with the next.
 *
 * The keys are secrets named search.<id>, search.<id>#2, search.<id>#3...
 * (the hub's secrets.json values, or a member's own secrets file), so an
 * old single key is key 1 as it is and ${secret:search.brave} still reads
 * it. A label and the state of each key live in kv under search.keys.<id>,
 * by a short hash of the key, so they follow a key when it moves and a new
 * key starts as working. Neither ever holds the key.
 */
import { createHash } from 'node:crypto';

export type KeyStatus = 'working' | 'credit' | 'cooloff' | 'rejected';

/** Why a key is skipped, and until when. rejected has no end: it lasts until the key is replaced. */
export interface KeyMark {
  status: Exclude<KeyStatus, 'working'>;
  until?: number;
  at: number;
}

export interface PoolKey {
  key: string;
  label?: string;
  mark?: KeyMark;
}

/** An engine's keys in order with their labels and marks. */
export interface SearchKeyPool {
  list(id: string): PoolKey[];
  mark(id: string, key: string, mark: KeyMark | undefined): void;
}

/** Secrets by name: the hub's (ConfigStore) or a member's own (AccountSecrets). */
export interface SecretSlots {
  get(name: string): string | undefined;
  set(name: string, value: string | undefined): void;
}

/** KvRepo, or a Map for a hub without a database (tests). */
export interface KeyMetaStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

interface EngineMeta {
  labels: Record<string, string>;
  marks: Record<string, KeyMark>;
}

export const MAX_KEYS = 20;
/** A 429 with no reset header waits this long. */
export const COOLOFF_MS = 60_000;

/** The secret name of an engine's key at 0-based position i. */
export const keySlotName = (id: string, i: number) => (i === 0 ? `search.${id}` : `search.${id}#${i + 1}`);

/** A short hash that names a key in kv and logs without giving it away. */
export const keyFingerprint = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** The last 4 characters, as Settings > Web search shows a key; none for a key too short to show any. */
export const keyLast4 = (key: string) => (key.length >= 12 ? key.slice(-4) : '');

export function readKeys(slots: Pick<SecretSlots, 'get'>, id: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < MAX_KEYS; i++) {
    const v = slots.get(keySlotName(id, i));
    if (!v) break;
    out.push(v);
  }
  return out;
}

/** Write an engine's keys in this order and drop the slots past the end. */
export function writeKeys(slots: SecretSlots, id: string, keys: string[]): void {
  const old = readKeys(slots, id).length;
  for (let i = 0; i < Math.max(old, keys.length); i++) {
    if (slots.get(keySlotName(id, i)) !== keys[i]) slots.set(keySlotName(id, i), keys[i]);
  }
}

const metaKey = (id: string) => `search.keys.${id}`;

export function readMeta(meta: KeyMetaStore, id: string): EngineMeta {
  const m = meta.get<Partial<EngineMeta>>(metaKey(id), {});
  return { labels: { ...(m.labels ?? {}) }, marks: { ...(m.marks ?? {}) } };
}

export function writeMeta(meta: KeyMetaStore, id: string, m: EngineMeta): void {
  meta.set(metaKey(id), m);
}

/** A mark that still holds now; an ended one reads as working. */
export function liveMark(mark: KeyMark | undefined, now = Date.now()): KeyMark | undefined {
  if (!mark) return undefined;
  if (mark.status === 'rejected') return mark;
  return mark.until && mark.until > now ? mark : undefined;
}

export function keyPool(slots: SecretSlots, meta: KeyMetaStore): SearchKeyPool {
  return {
    list(id) {
      const m = readMeta(meta, id);
      return readKeys(slots, id).map((key) => {
        const fp = keyFingerprint(key);
        const mark = liveMark(m.marks[fp]);
        return { key, ...(m.labels[fp] ? { label: m.labels[fp] } : {}), ...(mark ? { mark } : {}) };
      });
    },
    mark(id, key, mark) {
      const m = readMeta(meta, id);
      const fp = keyFingerprint(key);
      if (!mark && !m.marks[fp]) return;
      if (mark) m.marks[fp] = mark;
      else delete m.marks[fp];
      writeMeta(meta, id, m);
    },
  };
}

/** Labels and marks in memory: for a key from config.json or the environment, and for a hub without a database. */
export function memoryMeta(): KeyMetaStore {
  const map = new Map<string, unknown>();
  return { get: <T>(k: string, fb: T) => (map.has(k) ? (map.get(k) as T) : fb), set: (k, v) => void map.set(k, structuredClone(v)) };
}

export class KeyListError extends Error {}

/** A label as typed: trimmed, at most 40 characters, no control characters. Empty drops it. */
export function checkedLabel(label: string | undefined): string | undefined {
  const l = label?.trim();
  if (!l) return undefined;
  if (l.length > 40 || /[\u0000-\u001f\u007f]/.test(l)) throw new KeyListError('A label is up to 40 characters on one line, such as "personal" or "card 2".');
  return l;
}

function setLabel(m: EngineMeta, key: string, label: string | undefined): void {
  const fp = keyFingerprint(key);
  if (label) m.labels[fp] = label;
  else delete m.labels[fp];
}

function forget(m: EngineMeta, key: string): void {
  const fp = keyFingerprint(key);
  delete m.labels[fp];
  delete m.marks[fp];
}

/** The ways Settings > Web search and `conclave secret search.<id>` change an engine's list. */
export function editKeys(
  slots: SecretSlots,
  meta: KeyMetaStore,
  id: string,
  op: { add: string; label?: string } | { replace: number; key: string; label?: string } | { remove: number | 'all' } | { order: number[] } | { relabel: number; label?: string },
): void {
  const keys = readKeys(slots, id);
  const m = readMeta(meta, id);
  const at = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= keys.length) throw new KeyListError(`There is no key ${i + 1}; this engine has ${keys.length}.`);
    return i;
  };
  if ('add' in op) {
    if (keys.includes(op.add)) throw new KeyListError('That key is already in the list.');
    if (keys.length >= MAX_KEYS) throw new KeyListError(`An engine takes up to ${MAX_KEYS} keys.`);
    keys.push(op.add);
    setLabel(m, op.add, checkedLabel(op.label));
  } else if ('replace' in op) {
    const old = keys[at(op.replace)]!;
    if (old !== op.key && keys.includes(op.key)) throw new KeyListError('That key is already in the list.');
    // a new key starts as working; the label stays unless a new one is given
    const label = op.label !== undefined ? checkedLabel(op.label) : m.labels[keyFingerprint(old)];
    forget(m, old);
    keys[op.replace] = op.key;
    setLabel(m, op.key, label);
  } else if ('remove' in op) {
    const gone = op.remove === 'all' ? keys.splice(0) : keys.splice(at(op.remove), 1);
    for (const k of gone) forget(m, k);
  } else if ('order' in op) {
    const o = op.order;
    if (o.length !== keys.length || new Set(o).size !== o.length || o.some((i) => at(i) !== i)) throw new KeyListError('order must list every key index once.');
    const moved = o.map((i) => keys[i]!);
    keys.splice(0, keys.length, ...moved);
  } else {
    setLabel(m, keys[at(op.relabel)]!, checkedLabel(op.label));
  }
  writeKeys(slots, id, keys);
  writeMeta(meta, id, m);
}

/** The next 00:00 UTC. */
export function nextUtcDay(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** A reset time from Retry-After, X-RateLimit-Reset or RateLimit-Reset: seconds from now, an epoch, or an HTTP date. */
export function resetFrom(headers: Headers | undefined, pick: 'min' | 'max', now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const times: number[] = [];
  for (const name of ['retry-after', 'x-ratelimit-reset', 'ratelimit-reset']) {
    const raw = headers.get(name);
    if (!raw) continue;
    // Brave sends one value per window, "1, 1419704"
    for (const part of raw.split(',')) {
      const t = part.trim();
      if (/^\d+(\.\d+)?$/.test(t)) {
        const n = Number(t);
        times.push(n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000);
      } else {
        const d = Date.parse(t);
        if (!Number.isNaN(d)) times.push(d);
      }
    }
  }
  const future = times.filter((t) => t > now);
  if (!future.length) return undefined;
  return pick === 'min' ? Math.min(...future) : Math.max(...future);
}

const INVALID = /invalid[^.]{0,30}(api[ _-]?key|token|subscription|credential)|(api[ _-]?key|token)[^.]{0,30}(invalid|not valid|revoked|unknown)|unauthori[sz]ed|invalid_api_key|authentication failed/i;
const CREDIT = /credit|quota|limit exceeded|exceeded your|insufficient|balance|billing|payment|usage limit|monthly|limit reached|top.?up/i;

/**
 * What a refused call says about its key, or undefined when the key is not
 * to blame (a server error, a bad query). 401 or an invalid key: rejected.
 * 402, a 403 or 4xx about credit: out of credit until the reset header or
 * the next UTC day. 429: a short cool-off, unless it is about the quota.
 */
export function classifyKeyError(status: number, body: string, headers?: Headers, now = Date.now()): KeyMark | undefined {
  // Brave answers a bad token with 422 SUBSCRIPTION_TOKEN_INVALID
  if (status === 401 || (status >= 400 && status < 500 && INVALID.test(body))) return { status: 'rejected', at: now };
  if (status === 429 && !/quota|credit|monthly|insufficient|balance|usage/i.test(body)) return { status: 'cooloff', until: resetFrom(headers, 'min', now) ?? now + COOLOFF_MS, at: now };
  if (status === 402 || status === 403 || status === 429 || (status >= 400 && status < 500 && CREDIT.test(body))) return { status: 'credit', until: resetFrom(headers, 'max', now) ?? nextUtcDay(now), at: now };
  return undefined;
}

const WORDS: Record<KeyMark['status'], string> = { credit: 'out of credit', cooloff: 'rate limited', rejected: 'rejected' };

/** "out of credit", or "out of credit or rejected" when the keys differ. */
export function downWords(marks: KeyMark[]): string {
  return [...new Set(marks.map((m) => WORDS[m.status]))].join(' or ');
}
