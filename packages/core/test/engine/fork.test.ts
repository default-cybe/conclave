import { describe, expect, test } from 'bun:test';
import { startTestEngine } from './harness';

describe('forkSession', () => {
  test('a copy that fails part way leaves no half fork', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd });
      for (const text of ['one', 'two', 'three']) t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text }] });
      const repo = t.engine.repos.messages;
      const insert = repo.insert.bind(repo);
      let calls = 0;
      repo.insert = (m) => {
        if (++calls === 2) throw new Error('disk full');
        insert(m);
      };
      expect(() => t.engine.forkSession(s.id)).toThrow('disk full');
      repo.insert = insert;
      expect(t.engine.listSessions({}).map((x) => x.id)).toEqual([s.id]);
      const fork = t.engine.forkSession(s.id);
      expect(t.engine.getMessages(fork.id).map((m) => m.content[0])).toEqual([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'text', text: 'three' }]);
      expect(fork.stats.messages).toBe(3);
    } finally {
      await t.close();
    }
  });
});
