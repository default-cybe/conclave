import { describe, expect, test } from 'bun:test';
import { activeMessages, activeStored } from '../../src/session/transcript';
import { applyClearing } from '../../src/session/context-edit';
import { maybeCompact } from '../../src/session/compaction';
import { SUMMARY_HEADINGS } from '../../src/session/prompt';
import { startTestEngine } from '../engine/harness';
import type { ContentBlock, Message } from '../../src/types';

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], extra: Partial<Message> = {}): Message {
  seq++;
  return { id: `msg_${seq}`, sessionId: 'ses_x', seq, role, kind: 'normal', content, createdAt: seq, ...extra };
}

describe('activeStored', () => {
  test('reads from the last summary coversThroughSeq, not seq 0, and picks the same active messages', () => {
    const all: Message[] = [
      msg('user', [{ type: 'text', text: 'old turn' }]),
      msg('assistant', [{ type: 'text', text: 'old reply' }]),
      msg('user', [{ type: 'text', text: 'later turn' }]),
    ];
    const covers = all[all.length - 1].seq;
    const summary = msg('user', [{ type: 'text', text: 'summary of the first turns' }], { kind: 'summary', meta: { coversThroughSeq: covers } });
    all.push(summary, msg('assistant', [{ type: 'text', text: 'after the summary' }]), msg('user', [{ type: 'text', text: 'newest' }]), msg('assistant', [{ type: 'text', text: 'note' }], { kind: 'notice' }));

    const afterSeqs: number[] = [];
    const repo = {
      lastSummary: (id: string) => (id === 'ses_x' ? summary : undefined),
      list: (id: string, opts: { afterSeq?: number } = {}) => {
        expect(id).toBe('ses_x');
        afterSeqs.push(opts.afterSeq ?? 0);
        return all.filter((m) => m.seq > (opts.afterSeq ?? 0));
      },
    };
    const active = activeMessages(activeStored(repo, 'ses_x'));
    expect(afterSeqs).toEqual([covers]);
    expect(active.map((m) => m.id)).toEqual(activeMessages(all).map((m) => m.id));
  });

  test('without a summary the read stays from seq 0', () => {
    const all = [msg('user', [{ type: 'text', text: 'hi' }]), msg('assistant', [{ type: 'text', text: 'ho' }])];
    const afterSeqs: number[] = [];
    const repo = {
      lastSummary: () => undefined,
      list: (_id: string, opts: { afterSeq?: number } = {}) => {
        afterSeqs.push(opts.afterSeq ?? 0);
        return all.filter((m) => m.seq > (opts.afterSeq ?? 0));
      },
    };
    expect(activeStored(repo, 'ses_x').length).toBe(2);
    expect(afterSeqs).toEqual([0]);
  });

  test('a step reads the transcript from the summary on, and the clearing pass shares that read', async () => {
    const t = await startTestEngine({ script: [[{ text: 'done' }]] });
    try {
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'OLD-HIDDEN-BEFORE-SUMMARY' }] });
      t.engine.addMessage(s.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'OLD-REPLY' }] });
      const covered = t.engine.getMessages(s.id).slice(-1)[0].seq;
      t.engine.addMessage(s.id, { role: 'user', kind: 'summary', content: [{ type: 'text', text: 'SUMMARY-TEXT of earlier turns' }], meta: { coversThroughSeq: covered } });
      t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'NEW-AFTER-SUMMARY' }] });

      const reads: number[] = [];
      const repo = t.engine.repos.messages;
      const orig = repo.list.bind(repo);
      (repo as { list: typeof repo.list }).list = (id, opts = {}) => {
        if (id === s.id) reads.push(opts.afterSeq ?? 0);
        return orig(id, opts);
      };
      await t.run(s.id, 'go');
      (repo as { list: typeof repo.list }).list = orig;

      // the step's transcript read starts at the summary's coversThroughSeq, not seq 0
      expect(reads).toContain(covered);
      // the request carried the summary and what followed it, not the covered turns
      const body = t.requests[0];
      expect(body).toContain('SUMMARY-TEXT');
      expect(body).toContain('NEW-AFTER-SUMMARY');
      expect(body).not.toContain('OLD-HIDDEN');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a compaction after an earlier summary reads from that summary on, not the whole history', async () => {
    const SUMMARIZE = 'Conversation to summarize';
    const requests: string[] = [];
    const shaped = `summary\n\n${SUMMARY_HEADINGS.map((h) => `## ${h}\nnone`).join('\n')}`;
    const t = await startTestEngine({
      models: ['claude-sonnet-5-5'],
      modelOverrides: { 'claude-sonnet-5-5': { contextWindow: 200_000 } },
      script: [[{ text: 'done' }]],
      overrides: { limits: { maxRetries: 0 } } as never,
      chore: (_body, text) => {
        if (!text.includes(SUMMARIZE)) return undefined;
        requests.push(text);
        return [{ text: shaped }];
      },
    });
    try {
      const s = await t.engine.createSession({ title: 'c', cwd: t.cwd });
      const seed = (tag: string) => {
        for (const [role, text] of [['user', `${tag} ask`], ['assistant', tag.repeat(30_000)], ['user', `${tag} again`], ['assistant', tag.repeat(30_000)]] as const) t.engine.addMessage(s.id, { role, kind: 'normal', content: [{ type: 'text', text }] });
      };
      seed('a');
      expect(await maybeCompact(t.engine, s.id, s.model, AbortSignal.timeout(3_000), 'manual')).toBe(true);
      const covered = t.engine.repos.messages.lastSummary(s.id)!.meta!.coversThroughSeq as number;
      seed('b');
      const reads: number[] = [];
      const repo = t.engine.repos.messages;
      const orig = repo.list.bind(repo);
      (repo as { list: typeof repo.list }).list = (id, opts = {}) => {
        if (id === s.id) reads.push(opts.afterSeq ?? 0);
        return orig(id, opts);
      };
      try {
        expect(await maybeCompact(t.engine, s.id, s.model, AbortSignal.timeout(3_000), 'manual')).toBe(true);
      } finally {
        (repo as { list: typeof repo.list }).list = orig;
      }
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((r) => r >= covered)).toBe(true);
      // update mode still merges the earlier summary
      expect(requests[1]).toContain('<previous-summary>');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('applyClearing plans and marks from a shared list without reading again', async () => {
    const t = await startTestEngine({ script: [[{ text: 'done' }]] });
    try {
      const s = await t.engine.createSession({ title: 'p', cwd: t.cwd });
      const all = [msg('user', [{ type: 'text', text: 'go' }])];
      let calls = 0;
      const repo = t.engine.repos.messages;
      const orig = repo.list.bind(repo);
      (repo as { list: typeof repo.list }).list = (...a: Parameters<typeof repo.list>) => {
        calls++;
        return orig(...a);
      };
      // nothing past the threshold: no store writes, and the shared list was the only input
      expect(applyClearing(t.engine, s.id, { protectTokens: 0, batchTokens: 0 }, all)).toBe(0);
      (repo as { list: typeof repo.list }).list = orig;
      expect(calls).toBe(0);
    } finally {
      await t.close();
    }
  }, 60_000);
});
