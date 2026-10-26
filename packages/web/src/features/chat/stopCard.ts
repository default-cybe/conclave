/**
 * "Why did this turn stop": the rules live in core (session/stop-card.ts) so
 * the terminal app shows the same card. Tested in test/stop-card.test.ts.
 */
export { activity, QUIET_MS, stopCard, type StopCard, type StopKind } from '@conclave/core/session/stop-card';
