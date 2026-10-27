import { describe, expect, test } from 'bun:test';
import { startTestEngine, until, type RequestBody, type Step } from './harness';
import { TITLE_SYSTEM, cleanTitle, promptTitle } from '../../src/session/prompt';

/**
 * Session titles. The benchmark saw the small model start on the task
 * ("I'll implement...", "# ...") when the instruction and the task shared one
 * user message, and titles land after a short run had ended.
 */
describe('titles', () => {
  test('cleanTitle keeps the first line and drops heading marks, quotes and end punctuation; an answer is no title', () => {
    expect(cleanTitle('# Fix the cents rounding')).toBe('Fix the cents rounding');
    expect(cleanTitle('"Purge dry run flag".')).toBe('Purge dry run flag');
    expect(cleanTitle('Title: Ledger JSON export\nmore text')).toBe('Ledger JSON export');
    expect(cleanTitle('**Bowling score kata**')).toBe('Bowling score kata');
    expect(cleanTitle("I'll implement the --dry-run flag")).toBe('');
    expect(cleanTitle('Let me start by exploring the repo')).toBe('');
    expect(cleanTitle('')).toBe('');
    expect(cleanTitle('a '.repeat(50)).length).toBeLessThanOrEqual(60);
    expect(cleanTitle('Clone Conclave and finish the members own plans')).toBe('Clone Conclave and finish the members');
    expect(promptTitle('\nYou are working in the repository in the current directory.\n\nFix it.')).toBe('You are working in the repository in the current directory');
  });

  const isTitle = (body: RequestBody) => JSON.stringify(body.system ?? '').includes('You name conversations');
  const titleChores = (t: { chores: string[] }) => t.chores.filter((c) => c.includes('You name conversations'));
  // a message with "Track" makes the turn change the todo list (a big step); others are answered at once
  const route = (body: RequestBody): Step => {
    const last = (body.messages as Array<{ content: string | Array<{ type: string; text?: string }> }>).at(-1)!;
    const parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    return parts.some((p) => p.type === 'text' && p.text?.includes('Track'))
      ? [{ tool: 'TodoWrite', input: { todos: [{ content: 'fix export', status: 'in_progress', activeForm: 'Fixing export' }] } }]
      : [{ text: 'Done.' }];
  };

  test('the first message names the session from the prompt at once, then the model from that message alone, while the turn runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await startTestEngine({
      script: [{ blocks: [{ text: 'Done.' }], gate }],
      chore: (body) => (isTitle(body) ? { blocks: [{ text: '# Cents rounding fix.' }], delayMs: 500 } : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      const text = 'The March report total is one cent short. Please find the cause and fix it.';
      const run = t.run(s.id, text);
      // before the first answer, and before the title model answers
      expect(await until(() => t.engine.getSession(s.id)!.title === promptTitle(text))).toBe(true);
      expect(t.engine.getSession(s.id)!.status).toBe('running');
      expect(await until(() => t.engine.getSession(s.id)!.title === 'Cents rounding fix')).toBe(true);
      expect(t.engine.getSession(s.id)!.status).toBe('running');
      expect(t.engine.getSession(s.id)!.meta?.titleAuto).toBe('Cents rounding fix');
      release();
      await run;
      await Bun.sleep(100);
      // the first answer asks nothing more
      expect(titleChores(t).length).toBe(1);
      const ask = JSON.parse(titleChores(t)[0]);
      expect(ask.system[0].text).toBe(TITLE_SYSTEM);
      expect(ask.stop_sequences).toBeUndefined();
      expect(ask.max_tokens).toBe(60);
      const user = ask.messages[0].content[0].text as string;
      // the owner's message alone
      expect(user).toBe(`<conversation>\nUser: ${text}\n</conversation>\n\nReply with only the title.`);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a model reply that starts on the task keeps the prompt title', async () => {
    const t = await startTestEngine({ script: [[{ text: 'Done.' }]], chore: () => [{ text: "I'll start by reading the report code" }] });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      await t.run(s.id, 'Fix the report.');
      await until(() => titleChores(t).length >= 1, 2_000);
      await Bun.sleep(100);
      expect(t.engine.getSession(s.id)!.title).toBe('Fix the report');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('the title is revised after a big step, with the later messages and the current title, not after a small turn or within the limits', async () => {
    const names = ['Cents rounding fix', 'Ledger export cents rounding', 'Ledger export cents rounding'];
    let n = 0;
    const t = await startTestEngine({ script: [[{ text: 'Done.' }]], route, chore: (body) => (isTitle(body) ? [{ text: names[n++] }] : undefined) });
    const title = () => t.engine.getSession(s.id)!.title;
    const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
    // as if the last title call was long ago
    const later = () => t.engine.patchMeta(s.id, { titleAt: 0 });
    try {
      await t.run(s.id, 'The March report total is one cent short.');
      expect(await until(() => title() === 'Cents rounding fix')).toBe(true);
      // a big step one turn after the last title call: too soon
      await t.run(s.id, 'Track the ledger export.');
      later();
      // three turns on, long after: a small turn asks nothing
      await t.run(s.id, 'It comes from the ledger export.');
      await Bun.sleep(100);
      expect(titleChores(t).length).toBe(1);
      later();
      await t.run(s.id, 'Track the ledger export rounding fix too.');
      expect(await until(() => title() === 'Ledger export cents rounding')).toBe(true);
      const ask = JSON.parse(titleChores(t)[1]).messages[0].content[0].text as string;
      expect(ask).toContain('User: Track the ledger export rounding fix too.');
      expect(ask).toContain('titled "Cents rounding fix" now');
      // three turns on, but within two minutes of the last call: no call for the big step
      for (const text of ['five', 'six', 'Track seven']) await t.run(s.id, text);
      await Bun.sleep(100);
      expect(titleChores(t).length).toBe(2);
      // once the time has passed it asks; the same title is kept as it was
      later();
      await t.run(s.id, 'Track eight');
      expect(await until(() => titleChores(t).length === 3)).toBe(true);
      await Bun.sleep(100);
      expect(title()).toBe('Ledger export cents rounding');
      expect(t.engine.getSession(s.id)!.meta?.titleAuto).toBe('Ledger export cents rounding');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a subagent session is never titled', async () => {
    const t = await startTestEngine({ script: [[{ text: 'Done.' }]], route, chore: (body) => (isTitle(body) ? [{ text: 'Cents rounding fix' }] : undefined) });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      t.engine.patchMeta(s.id, { subagent: true });
      for (const text of ['Fix the report.', 'Track it', 'three', 'Track four']) {
        t.engine.patchMeta(s.id, { titleAt: 0 });
        await t.run(s.id, text);
      }
      await Bun.sleep(100);
      expect(titleChores(t).length).toBe(0);
      expect(t.engine.getSession(s.id)!.title).toBe('New chat');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a title the owner gave is never revised', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'Done.' }]],
      route,
      chore: (body) => (isTitle(body) ? [{ text: 'Cents rounding fix' }] : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      await t.run(s.id, 'The March report total is one cent short.');
      expect(await until(() => t.engine.getSession(s.id)!.title === 'Cents rounding fix')).toBe(true);
      t.engine.updateSession(s.id, { title: 'March report' });
      // big steps, long after the last title call
      for (const text of ['Track two', 'Track three', 'Track four', 'Track five']) {
        t.engine.patchMeta(s.id, { titleAt: 0 });
        await t.run(s.id, text);
      }
      await Bun.sleep(100);
      expect(titleChores(t).length).toBe(1);
      expect(t.engine.getSession(s.id)!.title).toBe('March report');
      // a session created with a title is the owner's too
      const named = await t.engine.createSession({ title: 'Ledger work', cwd: t.cwd });
      for (const text of ['one', 'two', 'three']) await t.run(named.id, text);
      await Bun.sleep(100);
      expect(titleChores(t).length).toBe(1);
      expect(t.engine.getSession(named.id)!.title).toBe('Ledger work');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a headless conclave run is named after its prompt, with no model call', async () => {
    const t = await startTestEngine({ script: [[{ text: 'Done.' }]] });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd, tags: ['cli-run'] });
      await t.run(s.id, 'Add --dry-run to tasksd purge.\n\nMore detail here.');
      expect(await until(() => t.engine.getSession(s.id)!.title !== 'New chat')).toBe(true);
      expect(t.engine.getSession(s.id)!.title).toBe('Add --dry-run to tasksd purge');
      expect(t.chores.some((c) => c.includes('You name conversations'))).toBe(false);
    } finally {
      await t.close();
    }
  }, 30_000);
});
