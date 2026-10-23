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
