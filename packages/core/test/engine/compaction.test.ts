import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_NOTE } from '../../src/session/compaction';
import { SUMMARY_HEADINGS } from '../../src/session/prompt';
import type { Engine } from '../../src/engine/engine';
import type { Message, TextBlock } from '../../src/types';
import { startTestEngine, type Block } from './harness';

/**
 * Compaction cannot fail the turn: a summary model that errors, or returns
 * something no smaller than the region, gives a summary written without the
 * model; failures latch auto compaction onto that fallback for a while.
 */

const SUMMARIZE = 'Conversation to summarize';
// compact on every step: the mock model has a 1M window
const always = { context: { compactAt: 0.00001 }, limits: { maxRetries: 0 } } as never;
const filler = (c: string) => c.repeat(30_000);
// a 200k window keeps a 10k-token tail (2.5 percent, clamped), so 30k-char messages compact
const small = { 'claude-sonnet-5-5': { contextWindow: 200_000 } };
/** A summary in the template's shape, so the audit passes. */
const shaped = (lead: string) => `${lead}\n\n${SUMMARY_HEADINGS.map((h) => `## ${h}\nnone`).join('\n')}`;

function seed(engine: Engine, id: string, texts: Array<[role: 'user' | 'assistant', text: string]>): void {
  for (const [role, text] of texts) engine.addMessage(id, { role, kind: 'normal', content: [{ type: 'text', text }] });
}

const summaries = (engine: Engine, id: string) => engine.getMessages(id).filter((m) => m.kind === 'summary');
const textOf = (m: Message) => (m.content[0] as TextBlock).text;

describe('compaction that cannot fail the turn', () => {
  test('a failing summary model gives a fallback summary with the verbatim section, and the turn finishes', async () => {
    const t = await startTestEngine({ modelOverrides: small, script: [[{ text: 'done' }]], chore: (_b, text) => (text.includes(SUMMARIZE) ? 500 : undefined), overrides: always });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      seed(t.engine, s.id, [['user', 'HEAD-ASK please keep the API stable'], ['assistant', filler('a')], ['user', 'second ask'], ['assistant', filler('b')]]);
      await t.run(s.id, 'go on');

      const [sum] = summaries(t.engine, s.id);
      expect(sum).toBeDefined();
      expect(sum.meta).toMatchObject({ qualityDegraded: true, fallback: 'no_llm', trigger: 'auto', userMessages: 1 });
      expect(textOf(sum).startsWith(FALLBACK_NOTE)).toBe(true);
      expect(textOf(sum)).toContain('## User messages (verbatim, newest first)');
      expect(textOf(sum)).toContain('HEAD-ASK please keep the API stable');
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
      expect(t.requests).toHaveLength(1);
      expect(t.requests[0]).toContain('not a message from the user');
      expect(t.requests[0]).not.toContain(filler('a').slice(0, 1000));
      const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map(textOf);
      expect(notices.some((n) => n.startsWith('Compacted 2 messages without a summary'))).toBe(true);
      const latch = t.engine.getSession(s.id)!.meta?.compaction as { latchedUntil: number };
      expect(latch.latchedUntil).toBeGreaterThan(Date.now());
      const audit = t.engine.listAudit({ sessionId: s.id }).map((a) => a.action);
      expect(audit).toContain('compaction:start');
      expect(audit).toContain('compaction:end');

      // inside the latch the next auto compaction skips the model
      const asked = t.chores.filter((c) => c.includes(SUMMARIZE)).length;
      expect(asked).toBe(1);
      seed(t.engine, s.id, [['assistant', filler('c')], ['user', 'third ask'], ['assistant', filler('d')]]);
      await t.run(s.id, 'and again');
      expect(t.chores.filter((c) => c.includes(SUMMARIZE)).length).toBe(asked);
      const all = summaries(t.engine, s.id);
      expect(all).toHaveLength(2);
      expect(all[1].meta?.qualityDegraded).toBe(true);
      // the earlier fallback is carried and its quoted messages too
      expect(textOf(all[1])).toContain('HEAD-ASK please keep the API stable');
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('manual compaction tries the model even while latched, and a good summary clears the latch', async () => {
    let fail = true;
    const t = await startTestEngine({
      modelOverrides: small,
      script: [[{ text: 'done' }]],
      chore: (_b, text) => (text.includes(SUMMARIZE) ? (fail ? 500 : [{ text: shaped('GOOD SUMMARY of the work') }]) : undefined),
      overrides: always,
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      seed(t.engine, s.id, [['user', 'first ask'], ['assistant', filler('a')], ['user', 'second ask'], ['assistant', filler('b')]]);
      await t.run(s.id, 'go');
      expect(summaries(t.engine, s.id)[0].meta?.qualityDegraded).toBe(true);
      fail = false;
      seed(t.engine, s.id, [['user', 'third ask'], ['assistant', filler('c')], ['user', 'fourth ask'], ['assistant', filler('d')]]);
      await t.engine.compact(s.id);
      const last = summaries(t.engine, s.id).at(-1)!;
      expect(last.meta?.qualityDegraded).toBeUndefined();
      expect(last.meta?.trigger).toBe('manual');
      expect(textOf(last).startsWith('GOOD SUMMARY of the work')).toBe(true);
      expect(textOf(last)).toContain('## User messages (verbatim, newest first)');
      expect(t.engine.getSession(s.id)!.meta?.compaction).toBeUndefined();
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a summary no smaller than the region is rejected', async () => {
    const t = await startTestEngine({
      modelOverrides: small,
      script: [[{ text: 'done' }]],
      chore: (_b, text) => (text.includes(SUMMARIZE) ? [{ text: 'S'.repeat(200_000) }] : undefined),
      overrides: always,
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      seed(t.engine, s.id, [['user', 'first ask'], ['assistant', filler('a')], ['user', 'second ask'], ['assistant', filler('b')]]);
      await t.run(s.id, 'go');
      const [sum] = summaries(t.engine, s.id);
      expect(sum.meta?.qualityDegraded).toBe(true);
      expect(textOf(sum)).not.toContain('SSSS');
      const end = t.engine.listAudit({ sessionId: s.id }).find((a) => a.action === 'compaction:end')!;
      expect(end.detail).toContain('was not smaller than what it replaces');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('only the region between the last summary and the kept tail reaches the summarizer', async () => {
    const t = await startTestEngine({ modelOverrides: small, script: [[{ text: 'done' }]], chore: (_b, text) => (text.includes(SUMMARIZE) ? [{ text: shaped('new summary') }] : undefined), overrides: always });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      seed(t.engine, s.id, [['user', 'HEAD-SENTINEL ask'], ['assistant', 'HEAD-SENTINEL answer']]);
      const covered = t.engine.getMessages(s.id).at(-1)!.seq;
      t.engine.addMessage(s.id, { role: 'user', kind: 'summary', content: [{ type: 'text', text: 'old summary text' }], meta: { coversThroughSeq: covered } });
      seed(t.engine, s.id, [['user', 'MID-SENTINEL ask'], ['assistant', `MID-SENTINEL ${filler('m')}`], ['user', 'TAIL-SENTINEL ask'], ['assistant', `TAIL-SENTINEL ${filler('t')}`]]);
      await t.run(s.id, 'go');
      const req = t.chores.find((c) => c.includes(SUMMARIZE))!;
      // the transcript part holds the region only; the kept tail's newest reply rides apart, as the state anchor
      const [head, anchor] = req.split('<recent-state-anchor>');
      expect(head).toContain('MID-SENTINEL');
      expect(head).toContain('<previous-summary>\\nold summary text\\n</previous-summary>');
      expect(req).not.toContain('HEAD-SENTINEL');
      expect(head).not.toContain('TAIL-SENTINEL');
      expect(anchor).toContain('TAIL-SENTINEL');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a long tool loop compacts up to three times in one turn', async () => {
    let cwd = '';
    let n = 0;
    const t = await startTestEngine({
      modelOverrides: small,
      script: [[{ text: 'unused' }]],
      // read eight large, different files, then stop
      route: () => (n < 8 ? [{ tool: 'Read', input: { file_path: join(cwd, `big${n++}.txt`) } } as Block] : [{ text: 'all read' }]),
      chore: (_b, text) => (text.includes(SUMMARIZE) ? [{ text: shaped('short summary') }] : undefined),
      overrides: always,
    });
    try {
      cwd = t.cwd;
      for (let i = 0; i < 8; i++) writeFileSync(join(cwd, `big${i}.txt`), `${`file ${i} `.repeat(5)}\n`.repeat(700));
      const s = await t.engine.createSession({ title: 't', cwd });
      await t.run(s.id, 'read them all');
      expect(summaries(t.engine, s.id)).toHaveLength(3);
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
      const last = [...t.engine.getMessages(s.id)].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')!;
      expect(textOf(last)).toBe('all read');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('repeated fallback summaries', () => {
  test('carry the last model summary once and do not grow with each fallback', async () => {
    let fail = false;
    const t = await startTestEngine({
      modelOverrides: small,
      script: [[{ text: 'done' }]],
      chore: (_b, text) => (text.includes(SUMMARIZE) ? (fail ? 500 : [{ text: shaped('MODEL-SUMMARY-ONE of the work') }]) : undefined),
      overrides: { limits: { maxRetries: 0 } } as never,
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      let n = 0;
      const round = async () => {
        n++;
        seed(t.engine, s.id, [['user', `ask ${n} ${'u'.repeat(3_000)}`], ['assistant', filler('a')], ['user', `more ${n}`], ['assistant', filler('b')]]);
        const before = summaries(t.engine, s.id).length;
        await t.engine.compact(s.id);
        expect(summaries(t.engine, s.id).length).toBe(before + 1);
        return summaries(t.engine, s.id).at(-1)!;
      };
      const first = await round();
      expect(first.meta?.qualityDegraded).toBeUndefined();
      fail = true;
      const sizes: number[] = [];
      for (let i = 0; i < 10; i++) {
        const sum = await round();
        expect(sum.meta?.qualityDegraded).toBe(true);
        const text = textOf(sum);
        expect(text.split('MODEL-SUMMARY-ONE').length - 1).toBe(1);
        expect(text.split('## Earlier summary').length - 1).toBe(1);
        expect(text.split('## User messages (verbatim').length - 1).toBe(1);
        sizes.push(text.length);
      }
      // the verbatim section is capped, so the text stops growing once it is full
      expect(Math.max(...sizes)).toBeLessThan(40_000);
      expect(sizes.at(-1)).toBeLessThanOrEqual(sizes.at(-2)! + 100);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('token count anchored on the last real usage (item 8)', () => {
  test('a reply that reports 190k input tokens on a 200k window compacts before the next request, though chars/4 is small', async () => {
    const readInput = { file_path: '' };
    const t = await startTestEngine({
      modelOverrides: small,
      script: [{ blocks: [{ tool: 'Read', input: readInput }], usage: { input: 190_000 } }, [{ text: 'done' }]],
      chore: (_b, text) => (text.includes(SUMMARIZE) ? [{ text: shaped('Read a.txt.') }] : undefined),
    });
    try {
      readInput.file_path = join(t.cwd, 'a.txt');
      writeFileSync(readInput.file_path, 'hello');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      seed(t.engine, s.id, [['user', 'earlier ask'], ['assistant', filler('a')], ['user', 'another ask'], ['assistant', filler('b')]]);
      await t.run(s.id, 'read the file');
      expect(t.requests).toHaveLength(2);
      // chars/4 of the second request is about 15k tokens; the meter says 190k plus the result
      expect(t.chores.filter((c) => c.includes(SUMMARIZE))).toHaveLength(1);
      expect(summaries(t.engine, s.id)).toHaveLength(1);
      expect(t.requests[1]).toContain('<conversation_summary>');
    } finally {
      await t.close();
    }
  }, 30_000);
});

describe('structured compaction (item 13)', () => {
  test('a compaction keeps the pending user asks and the file names; the audit retries once; the next one updates the summary', async () => {
    const asks = ['ASK-1 rename the loader to loadConfig in /srv/app/src/config.ts', 'ASK-2 add a --retry flag to /srv/app/src/cli.ts', 'ASK-3 then update /srv/app/README.md'];
    let calls = 0;
    const t = await startTestEngine({
      modelOverrides: small,
      script: [[{ text: 'done' }]],
      chore: (_b, text) => {
        if (!text.includes(SUMMARIZE)) return undefined;
        calls++;
        // a weak first draft without the identifiers, then the full one the audit asks for
        if (calls === 1) return [{ text: shaped('Renamed the loader.') }];
        return [{ text: shaped(`FULL-SUMMARY ${calls}. Done: /srv/app/src/config.ts. Pending: /srv/app/src/cli.ts, /srv/app/README.md.`) }];
      },
      overrides: always,
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: asks[0] }] });
      t.engine.addMessage(s.id, { role: 'assistant', kind: 'normal', content: [{ type: 'tool_use', id: 'toolu_e1', name: 'Edit', input: { file_path: '/srv/app/src/config.ts', old_string: 'load', new_string: 'loadConfig' } }] });
      t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'tool_result', toolUseId: 'toolu_e1', content: 'The file /srv/app/src/config.ts has been updated.' }] });
      seed(t.engine, s.id, [['assistant', filler('a')], ['user', asks[1]], ['assistant', filler('b')], ['user', asks[2]], ['assistant', filler('c')]]);
      await t.run(s.id, 'go on');

      const first = t.chores.filter((c) => c.includes(SUMMARIZE));
      expect(first).toHaveLength(2);
      expect(first[1]).toContain('Your last summary missed');
      expect(first[1]).toContain('missing identifier /srv/app/src/cli.ts');
      const [sum] = summaries(t.engine, s.id);
      const text = textOf(sum);
      expect(sum.meta?.qualityDegraded).toBeUndefined();
      expect(text.startsWith('FULL-SUMMARY 2.')).toBe(true);
      for (const h of SUMMARY_HEADINGS) expect(text).toContain(`## ${h}`);
      // the pending asks in the user's words and the files, whatever the model wrote
      expect(text).toContain(asks[1]);
      expect(text).toContain(asks[0]);
      expect(text).toContain('## Files touched\n\n- /srv/app/src/config.ts');
      expect(text).toContain('## Anchor index');
      expect(text).toContain('/srv/app/README.md');

      // the next compaction merges into this summary instead of summarizing it again as transcript
      seed(t.engine, s.id, [['user', 'ASK-4 run the tests'], ['assistant', filler('d')], ['user', 'ASK-5 report back'], ['assistant', filler('e')]]);
      await t.engine.compact(s.id);
      const update = t.chores.filter((c) => c.includes(SUMMARIZE)).at(-1)!;
      expect(update).toContain('<previous-summary>\\nFULL-SUMMARY 2.');
      expect(update).toContain('Update the previous summary');
      expect(update).toContain('ASK-4 run the tests');
    } finally {
      await t.close();
    }
  }, 60_000);
});
