import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startTestEngine, toolResults } from './harness';

/** HARNESS-REVIEW item 11: nested AGENTS.md and path rules load on the first touch of a file under them. */

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe('scoped instructions on file tools', () => {
  test('a nested AGENTS.md and a matching rule ride on the first result that touches their files, once each', async () => {
    const reads = [{ file_path: '' }, { file_path: '' }, { file_path: '' }];
    const t = await startTestEngine({ script: [[{ tool: 'Read', input: reads[0] }], [{ tool: 'Read', input: reads[1] }], [{ tool: 'Read', input: reads[2] }], [{ text: 'done' }]] });
    try {
      put(join(t.cwd, 'pkg', 'AGENTS.md'), 'PKG-RULE: run pnpm in pkg.');
      put(join(t.cwd, '.claude', 'rules', 'api.md'), '---\npaths: src/api/**\n---\nAPI-RULE: validate input.');
      for (const [i, p] of ['pkg/a.ts', 'pkg/b.ts', 'src/api/users.ts'].entries()) {
        reads[i].file_path = join(t.cwd, p);
        put(reads[i].file_path, `file ${i}`);
      }
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      await t.run(s.id, 'read them');
      const r = toolResults(t.engine, s.id);
      expect(r).toHaveLength(3);
      expect(r[0].content).toContain('PKG-RULE: run pnpm in pkg.');
      expect(r[0].content).toContain('<system-reminder>');
      expect(r[0].content).not.toContain('API-RULE');
      expect(r[1].content).not.toContain('PKG-RULE');
      expect(r[2].content).toContain('API-RULE: validate input.');
      // the system prompt does not carry either: they load only on a touch
      expect(t.requests[0]).not.toContain('PKG-RULE');
      expect(t.requests[0]).not.toContain('API-RULE');
      expect(t.engine.getSession(s.id)!.meta?.scopedInstructions).toEqual([join(t.cwd, 'pkg', 'AGENTS.md'), join(t.cwd, '.claude', 'rules', 'api.md')]);
    } finally {
      await t.close();
    }
  }, 30_000);
});
