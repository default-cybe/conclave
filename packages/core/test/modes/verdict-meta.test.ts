/**
 * Jury and debate store a short verdict on session meta when the verdict is
 * written, so the sidebar shows "verdict Caddy" without loading the transcript.
 *
 *   bun test packages/core/test/modes/verdict-meta.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '../../src/types';
import { startTestEngine } from '../engine/harness';

const VERDICT = `**Use Caddy.** ${'It renews certificates on its own. '.repeat(20)}`;
const A = 'mock/claude-sonnet-5-5';
const B = 'mock/claude-opus-5-5';

describe('verdict on session meta', () => {
  for (const mode of ['jury', 'debate'] as const) {
    test(`${mode}: the verdict's start is on meta and in the update the list gets`, async () => {
      const t = await startTestEngine({ script: [], models: ['claude-sonnet-5-5', 'claude-opus-5-5'], chore: () => [{ text: VERDICT }] } as never);
      try {
        const modeConfig = mode === 'jury' ? { jury: { jurors: [A, B], strategy: 'synthesize' as const, anonymize: true, jurorTools: 'none' as const } } : { debate: { a: A, b: B, rounds: 1 } };
        const s = await t.engine.createSession({ cwd: t.cwd, mode, modeConfig });
        const updates: Session[] = [];
        t.engine.bus.on((e) => {
          if (e.type === 'session.updated' && e.session.id === s.id) updates.push(e.session);
        });
        await t.run(s.id, 'Caddy or nginx?');
        const verdict = t.engine.getSession(s.id)?.meta?.verdict as string;
        expect(verdict.startsWith('**Use Caddy.**')).toBe(true);
        expect(verdict.length).toBe(300);
        expect(updates.at(-1)?.meta?.verdict).toBe(verdict);
      } finally {
        await t.close();
      }
    });
  }
});
