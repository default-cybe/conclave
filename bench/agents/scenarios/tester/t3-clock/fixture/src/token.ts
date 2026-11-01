export interface Token { value: string; issuedAt: number; ttlMs: number }

export function issue(value: string, ttlMs = 60_000): Token {
  return { value, issuedAt: Date.now(), ttlMs };
}

/** A token is valid until ttlMs after it was issued, inclusive. */
export function isValid(t: Token): boolean {
  return Date.now() - t.issuedAt < t.ttlMs;
}
