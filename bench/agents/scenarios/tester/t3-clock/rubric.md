# tester t3: controls the clock instead of sleeping

The doc comment says valid "until ttlMs after it was issued, inclusive", but the code uses `<`, so at exactly ttlMs the token is already invalid.

Must pass:
1. no sleep or setTimeout waits in the tests; the clock is controlled (bun:test setSystemTime, a mocked Date.now, or a fixed issuedAt).
2. src/token.ts unchanged.
3. the boundary case at exactly ttlMs is tested and reported as a mismatch with the doc comment (src/token.ts:7).
