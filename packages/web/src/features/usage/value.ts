/**
 * What plan use is worth at API prices, in words (docs/DESIGN.md, Usage and
 * costs). A signed in plan bills $0 per call; the hub keeps what the same
 * tokens cost at the model's API prices beside it. For an API key the two
 * are the same. Pure, so test/usage-value.test.ts checks it.
 */
import { usd } from '@/lib/format';

export interface Valued {
  costUsd: number;
  /** Missing from hubs before values were kept: then it is what was billed. */
  apiValueUsd?: number;
  /** The part priced on read from today's catalog. */
  estimatedUsd?: number;
}

/** What the tokens are worth at API prices: never less than what was billed. */
export function worth(b: Valued): number {
  return Math.max(b.costUsd, b.apiValueUsd ?? b.costUsd);
}

/** What a plan saved on these calls: the API value less what was billed. */
export function saved(b: Valued): number {
  return Math.max(0, worth(b) - b.costUsd);
}

/** A plan served some of these calls (worth more than they billed, by half a cent or more). */
export function planServed(b: Valued): boolean {
  return saved(b) >= 0.005;
}

/** "Billed $0" and "Worth $41.20 at API prices"; the second only when a plan served the calls. */
export function billedWords(b: Valued): { billed: string; worth?: string } {
  return { billed: `Billed ${usd(b.costUsd)}`, ...(planServed(b) ? { worth: `Worth ${usd(worth(b))} at API prices` } : {}) };
}

/** "Your plans saved you about $212 this month", or nothing when they saved under a cent. */
export function savedSentence(b: Valued | undefined, when = 'this month'): string | undefined {
  if (!b || !planServed(b)) return undefined;
  return `Your plans saved you about ${usd(saved(b))} ${when}`;
}

/** The line under it: what the calls were worth, what was billed, and whether older calls are estimates. */
export function savedDetail(b: Valued): string {
  const est = (b.estimatedUsd ?? 0) >= 0.005 ? ' Calls from before the hub kept this are priced from today\'s list prices.' : '';
  return `Worth ${usd(worth(b))} at API prices, billed ${usd(b.costUsd)}.${est}`;
}

/** "worth $1.20 at API prices" beside a session's bill when a plan served it; else nothing. */
export function worthLine(b: Valued | undefined): string | undefined {
  return b && planServed(b) ? `worth ${usd(worth(b))} at API prices` : undefined;
}
