import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type Block } from './harness';

/**
 * HARNESS-REVIEW item 12, end to end: the system prompt is built once per
 * session and sent byte for byte, and every request starts with the bytes of
 * the request before it, so the prompt cache reads the whole history.
 */

/** A request body without cache_control markers: breakpoints move forward each turn by design. */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, strip(x)]));
  return v;
}

const readInput = { file_path: '' };
const read: Block = { tool: 'Read', input: readInput };

describe('cache-stable requests', () => {
  test('the prefix stays byte-identical across turns; a new memory waits, an edited one and a new AGENTS.md rebuild the prompt', async () => {
    const t = await startTestEngine({
      script: [[read], [{ text: 'one' }], [read], [{ text: 'two' }], [{ text: 'three' }], [{ text: 'four' }]],
      overrides: { memory: { enabled: true, autoExtract: false, autoInject: false, injectLimit: 0 } } as never,
    });
    try {
      readInput.file_path = join(t.cwd, 'a.txt');
      writeFileSync(readInput.file_path, 'hello\n'.repeat(50));
      const shown = await t.engine.memory.save({ content: 'The owner indents with tabs.', kind: 'profile', scope: 'global' });
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });

      await t.run(s.id, 'first');
      // memory extraction after a turn adds memories; they wait for the next rebuild
      await t.engine.memory.save({ content: 'The owner runs bun, never npm.', kind: 'profile', scope: 'global' });
      await t.run(s.id, 'second');
      expect(t.requests).toHaveLength(4);

      const bodies = t.requests.map((r) => strip(JSON.parse(r)) as { system: unknown; tools: unknown; messages: unknown[] });
      const sys0 = JSON.stringify(bodies[0].system);
      expect(sys0).toContain('The owner indents with tabs.');
      for (let i = 1; i < bodies.length; i++) {
        expect(JSON.stringify(bodies[i].system)).toBe(sys0);
        expect(JSON.stringify(bodies[i].tools)).toBe(JSON.stringify(bodies[0].tools));
        // every message the previous request sent is sent again, unchanged and in place
        const prev = bodies[i - 1].messages.map((m) => JSON.stringify(m));
        const cur = bodies[i].messages.map((m) => JSON.stringify(m));
        expect(cur.slice(0, prev.length)).toEqual(prev);
      }
      expect(sys0).not.toContain('never npm');

      // an edit to a memory the prompt shows rebuilds it (with the new memory too)
      await t.engine.memory.update(shown.id, { content: 'The owner indents with two spaces.' });
      await t.run(s.id, 'third');
      const sys4 = JSON.stringify((strip(JSON.parse(t.requests[4])) as { system: unknown }).system);
      expect(sys4).toContain('two spaces');
      expect(sys4).toContain('never npm');

      // instruction files are read again once per user turn
      writeFileSync(join(t.cwd, 'AGENTS.md'), 'Run tests with bun test.');
      await t.run(s.id, 'fourth');
      expect(t.requests[5]).toContain('Run tests with bun test.');
    } finally {
      await t.close();
    }
  }, 30_000);
});
