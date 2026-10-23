import { describe, expect, test } from 'bun:test';
import { startTestEngine, until } from './harness';
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

  test('the title call puts the instruction in system and wraps the text, with no stop sequence (the API rejects a whitespace one)', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'Done.' }]],
      chore: (body) => (JSON.stringify(body.system ?? '').includes('You name conversations') ? [{ text: '# Cents rounding fix.' }] : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      await t.run(s.id, 'The March report total is one cent short. Please find the cause and fix it.');
      expect(await until(() => t.engine.getSession(s.id)!.title !== 'New chat')).toBe(true);
      expect(t.engine.getSession(s.id)!.title).toBe('Cents rounding fix');
      const ask = JSON.parse(t.chores.find((c) => c.includes('You name conversations'))!);
      expect(ask.system[0].text).toBe(TITLE_SYSTEM);
      expect(ask.stop_sequences).toBeUndefined();
      expect(ask.max_tokens).toBe(60);
      const user = ask.messages[0].content[0].text as string;
      // the first exchange: the owner's message and the first answer
      expect(user.startsWith('<conversation>\nUser: The March report')).toBe(true);
      expect(user).toContain('\n\nAssistant: Done.\n</conversation>');
      expect(user.endsWith('</conversation>\n\nReply with only the title.')).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a reply that starts on the task keeps New chat', async () => {
    const t = await startTestEngine({ script: [[{ text: 'Done.' }]], chore: () => [{ text: "I'll start by reading the report code" }] });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      await t.run(s.id, 'Fix the report.');
      await until(() => t.chores.length >= 2, 2_000);
      await Bun.sleep(100);
      expect(t.engine.getSession(s.id)!.title).toBe('New chat');
    } finally {
      await t.close();
    }
  }, 30_000);

  const titleChores = (t: { chores: string[] }) => t.chores.filter((c) => c.includes('You name conversations'));

  test('the title is revised once after turn 3, with the later messages and the current title', async () => {
    const names = ['Cents rounding fix', 'Ledger export cents rounding', 'Third title never asked'];
    let n = 0;
    const t = await startTestEngine({
      script: [[{ text: 'Done.' }]],
      chore: (body) => (JSON.stringify(body.system ?? '').includes('You name conversations') ? [{ text: names[n++] }] : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      await t.run(s.id, 'The March report total is one cent short.');
      expect(await until(() => t.engine.getSession(s.id)!.title === 'Cents rounding fix')).toBe(true);
      await t.run(s.id, 'It comes from the ledger export.');
      await Bun.sleep(100);
      expect(titleChores(t).length).toBe(1);
      await t.run(s.id, 'Fix the ledger export rounding too.');
      expect(await until(() => t.engine.getSession(s.id)!.title === 'Ledger export cents rounding')).toBe(true);
      const ask = JSON.parse(titleChores(t)[1]).messages[0].content[0].text as string;
      expect(ask).toContain('User: Fix the ledger export rounding too.');
      expect(ask).toContain('titled "Cents rounding fix" now');
      await t.run(s.id, 'Thanks.');
      await Bun.sleep(100);
      expect(titleChores(t).length).toBe(2);
      expect(t.engine.getSession(s.id)!.title).toBe('Ledger export cents rounding');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a title the owner gave is never revised', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'Done.' }]],
      chore: (body) => (JSON.stringify(body.system ?? '').includes('You name conversations') ? [{ text: 'Cents rounding fix' }] : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'New chat', cwd: t.cwd });
      await t.run(s.id, 'The March report total is one cent short.');
      expect(await until(() => t.engine.getSession(s.id)!.title === 'Cents rounding fix')).toBe(true);
      t.engine.updateSession(s.id, { title: 'March report' });
      for (const text of ['two', 'three', 'four']) await t.run(s.id, text);
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
