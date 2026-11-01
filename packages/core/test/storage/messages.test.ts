import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import type { Message, Session } from '../../src/types';

function setup() {
  const repos = new Repos(openDb(':memory:'));
  const now = Date.now();
  const session = { id: 'ses_1', title: 't', agent: 'coder', model: 'm', mode: 'agent', permissionMode: 'default', cwd: '/w', device: 'local', status: 'idle', tags: [], pinned: false, archived: false, createdAt: now, updatedAt: now, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } } as Session;
  repos.sessions.insert(session);
  const msg = (seq: number, text: string): Message => ({ id: `msg_${seq}`, sessionId: 'ses_1', seq, role: 'assistant', kind: 'normal', content: text ? [{ type: 'text', text }] : [], createdAt: now });
  const hits = (q: string) => repos.messages.search(q).map((h) => h.messageId);
  return { repos, msg, hits };
}

describe('message search index', () => {
  test('follows an update only when the text changed', () => {
    const { repos, msg, hits } = setup();
    // the runner creates the reply empty and fills it at the end of the stream
    repos.messages.insert(msg(1, ''));
    repos.messages.update(msg(1, 'walrus migration plan'));
    expect(hits('walrus')).toEqual(['msg_1']);
    repos.messages.update({ ...msg(1, 'walrus migration plan'), stopReason: 'end_turn' });
    expect(hits('walrus')).toEqual(['msg_1']);
    repos.messages.update(msg(1, 'narwhal plan'));
    expect(hits('walrus')).toEqual([]);
    expect(hits('narwhal')).toEqual(['msg_1']);
    repos.messages.update({ ...msg(1, 'narwhal plan'), kind: 'notice' });
    expect(hits('narwhal')).toEqual([]);
  });

  test('a rewind drops the index rows of the messages it removes', () => {
    const { repos, msg, hits } = setup();
    for (const [seq, text] of [[1, 'keep otter'], [2, 'drop otter'], [3, 'drop otter again']] as const) repos.messages.insert(msg(seq, text));
    repos.messages.truncateAfter('ses_1', 1);
    expect(repos.messages.list('ses_1').map((m) => m.seq)).toEqual([1]);
    expect(hits('otter')).toEqual(['msg_1']);
  });
});

describe('transcript pages', () => {
  const seqs = (ms: Message[]) => ms.map((m) => m.seq);
  function filled(n: number) {
    const t = setup();
    for (let i = 1; i <= n; i++) t.repos.messages.insert(t.msg(i, `m${i}`));
    return t.repos;
  }

  test('no page reads the whole transcript, oldest first', () => {
    expect(seqs(filled(5).messages.page('ses_1'))).toEqual([1, 2, 3, 4, 5]);
  });

  test('a limit reads the newest page; beforeSeq walks back to the start', () => {
    const repos = filled(5);
    expect(seqs(repos.messages.page('ses_1', { limit: 2 }))).toEqual([4, 5]);
    expect(seqs(repos.messages.page('ses_1', { beforeSeq: 4, limit: 2 }))).toEqual([2, 3]);
    expect(seqs(repos.messages.page('ses_1', { beforeSeq: 2, limit: 2 }))).toEqual([1]);
    expect(seqs(repos.messages.page('ses_1', { beforeSeq: 1, limit: 2 }))).toEqual([]);
    expect(seqs(repos.messages.page('ses_1', { beforeSeq: 3 }))).toEqual([1, 2]);
    expect(seqs(repos.messages.page('ses_1', { limit: 50 }))).toEqual([1, 2, 3, 4, 5]);
  });

  test('afterSeq still reads forward (a reconnect catches up), within beforeSeq and limit', () => {
    const repos = filled(5);
    expect(seqs(repos.messages.page('ses_1', { afterSeq: 3 }))).toEqual([4, 5]);
    expect(seqs(repos.messages.page('ses_1', { afterSeq: 1, limit: 2 }))).toEqual([2, 3]);
    expect(seqs(repos.messages.page('ses_1', { afterSeq: 1, beforeSeq: 4 }))).toEqual([2, 3]);
    expect(seqs(repos.messages.page('ses_1', { afterSeq: 5 }))).toEqual([]);
  });

  test('both page queries search the (session_id, seq) index, never scan', () => {
    const repos = filled(3);
    // record the SQL the repo really runs for each kind of page
    const db = repos.db;
    const query = db.query.bind(db);
    const seen: string[] = [];
    db.query = ((sql: string) => (seen.push(sql), query(sql))) as typeof db.query;
    repos.messages.page('ses_1', { limit: 2 });
    repos.messages.page('ses_1', { afterSeq: 1 });
    db.query = query;
    expect(seen).toHaveLength(2);
    for (const sql of seen) {
      const named = sql.includes('$sid') ? { sid: 'ses_1', after: 0, before: 9, limit: 5 } : undefined;
      const rows = (named ? query(`EXPLAIN QUERY PLAN ${sql}`).all(named) : query(`EXPLAIN QUERY PLAN ${sql}`).all('ses_1', 9, 5)) as Array<{ detail: string }>;
      const plan = rows.map((r) => r.detail).join(' | ');
      expect(plan).toContain('USING INDEX messages_session_seq (session_id=? AND seq');
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });
});
