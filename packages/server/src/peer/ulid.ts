/**
 * ULIDs for peer message ids: 48 bits of time and 80 random bits in
 * Crockford base32. Ids made in the same millisecond count up, so sorting
 * this hub's ids sorts its messages, and the pull cursor (GET
 * /peer/v1/outbox?after=) can stand for "everything up to here arrived".
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(t: number): string {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 16 base32 digits from 10 random bytes. */
function randomDigits(): number[] {
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const out: number[] = [];
  for (let i = 0; i < 16; i++) {
    out.unshift(Number(bits & 31n));
    bits >>= 5n;
  }
  return out;
}

export function ulid(now = Date.now()): string {
  if (now <= lastTime) {
    // same millisecond (or the clock went back): count up from the last id
    const next = [...lastRandom];
    let i = next.length - 1;
    while (i >= 0 && next[i] === 31) next[i--] = 0;
    if (i < 0) throw new Error('ULID random part overflowed in one millisecond');
    next[i]++;
    lastRandom = next;
    now = lastTime;
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  return encodeTime(now) + lastRandom.map((d) => ALPHABET[d]).join('');
}

/** The millisecond a ULID was made. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}
