/** Reflect's report in the service: the model pass with a scripted model, and the cache per range. */
import { afterEach, describe, expect, test } from 'bun:test';
import { AssistantService } from '../../src/assistant';
import { makeAssistant } from './helpers';

let env: ReturnType<typeof makeAssistant>;
afterEach(() => env?.cleanup());

function setup(answer: (prompt: string) => string | Promise<string>, o: { thin?: boolean } = {}) {
  let clock = Date.parse('2026-11-05T18:00:00Z');
  env = makeAssistant({ now: () => clock });
  const calls: string[] = [];
  const svc = new AssistantService({
    db: env.db,
    kv: env.repos.kv,
    repos: env.repos,
    memory: env.memory,
    routines: env.routines,
    createTask: env.createTask,
    now: () => clock,
    hubZone: () => 'UTC',
    complete: async (o) => (calls.push(o.prompt), answer(o.prompt)),
  });
  const ts = clock - 86_400_000;
  env.db.query(`INSERT INTO sessions (id, title, agent, model, mode, permission_mode, cwd, status, created_at, updated_at, account_id, kind) VALUES ('s1', 'Canvas grading rubric', 'chat', 'm', 'single', 'ask', '/w/cmu', 'idle', ?, ?, 'owner', 'chat')`).run(ts, ts);
  env.db.query(`INSERT INTO messages (id, session_id, seq, role, kind, content, created_at) VALUES ('m1', 's1', 1, 'user', 'normal', ?, ?)`).run(JSON.stringify([{ type: 'text', text: 'actually, use the 2026 rubric' }]), ts);
  // enough to reflect on: three sessions you started, six messages you typed
  if (!o.thin)
    for (const [id, title] of [['s2', 'Grade lab 4'], ['s3', 'Rubric for lab 5']]) {
      env.db.query(`INSERT INTO sessions (id, title, agent, model, mode, permission_mode, cwd, status, created_at, updated_at, account_id, kind) VALUES (?, ?, 'chat', 'm', 'single', 'ask', '/w/cmu', 'idle', ?, ?, 'owner', 'chat')`).run(id, title, ts, ts);
      for (const n of [1, 2, 3]) env.db.query(`INSERT INTO messages (id, session_id, seq, role, kind, content, created_at) VALUES (?, ?, ?, 'user', 'normal', ?, ?)`).run(`${id}m${n}`, id, n, JSON.stringify([{ type: 'text', text: `grading step ${n}` }]), ts);
    }
  return { svc, calls, tick: (ms: number) => (clock += ms) };
}

const ANSWER = JSON.stringify({
  headline: 'A short week on Canvas grading — one chat.',
  topics: [{ name: 'Grading', example: 'Canvas grading rubric' }],
  habits: [
    { key: 'discernment', observation: 'You corrected the rubric year once.', example: 'You said to use the 2026 rubric.' },
    { key: 'delegation', observation: 'Invented: you delegated a lot.' },
  ],
  suggestions: [
    { text: 'Start a Canvas project.', why: 'Grading came up again.' },
    { text: 'Save the rubric year as a note.', why: 'You corrected it.' },
  ],
  question: 'What part of grading do you want to keep doing yourself?',
});

describe('Reflect report', () => {
  test('one model pass on titles and summaries fills the insights; the numbers stay; unsupported habits stay out', async () => {
    const { svc, calls } = setup(() => `Here you go:\n${ANSWER}`);
    const r = await svc.report('week');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Canvas grading rubric');
    // raw messages never go to the model
    expect(calls[0]).not.toContain('actually, use the 2026 rubric');
    expect(calls[0]).not.toContain('grading step');
    expect(r.insights).toBe('model');
    expect(r.headline).toBe('A short week on Canvas grading, one chat.');
    expect(r.work.topics).toEqual([{ name: 'Grading', example: 'Canvas grading rubric' }]);
    // delegation stays out: nothing was handed to another agent
    expect(r.habits.map((h) => h.key)).toEqual(['description', 'discernment']);
    expect(r.habits.find((h) => h.key === 'discernment')?.observation).toBe('You corrected the rubric year once.');
    expect(r.suggestions).toHaveLength(2);
    expect(r.question).toContain('grading');
    expect(r.totals.chats).toBe(3);
  });

  test('the report is cached per range until Refresh or a week passes', async () => {
    const { svc, calls, tick } = setup(() => ANSWER);
    const a = await svc.report('week');
    expect((await svc.report('week')).generatedAt).toBe(a.generatedAt);
    expect(calls).toHaveLength(1);
    await svc.report('3m');
    expect(calls).toHaveLength(2);
    tick(60_000);
    expect((await svc.report('week', { refresh: true })).generatedAt).toBe(a.generatedAt + 60_000);
    expect(calls).toHaveLength(3);
    tick(8 * 86_400_000);
    // a week later the cached 3 months report is made again
    const later = await svc.report('3m');
    expect(later.generatedAt).toBe(a.generatedAt + 60_000 + 8 * 86_400_000);
    expect(calls).toHaveLength(4);
  });

  test('two Refreshes at once make one call', async () => {
    let release: () => void = () => {};
    const { svc, calls } = setup(() => new Promise((ok) => (release = () => ok(ANSWER))));
    const one = svc.report('week', { refresh: true });
    const two = svc.report('week', { refresh: true });
    await Bun.sleep(0);
    release();
    expect((await one).generatedAt).toBe((await two).generatedAt);
    expect(calls).toHaveLength(1);
  });

  test('a thin range makes no model call, so no padded headline, suggestions or question', async () => {
    const { svc, calls } = setup(() => ANSWER, { thin: true });
    const r = await svc.report('week');
    expect(calls).toHaveLength(0);
    expect(r.insights).toBe('basic');
    expect(r.insightsNote).toBeUndefined();
    expect(r.question).toBe('');
    expect(r.suggestions).toEqual([]);
  });

  test('one grounded suggestion from the model is kept; it is not asked to pad to two', async () => {
    const { svc } = setup(() => JSON.stringify({ headline: 'Three grading chats.', suggestions: [{ text: 'Start a Canvas project.', why: 'Three chats on grading.' }] }));
    expect((await svc.report('week')).suggestions).toEqual([{ text: 'Start a Canvas project.', why: 'Three chats on grading.' }]);
  });

  test('a failed or unreadable model pass keeps the numbers-only report and says so', async () => {
    const bad = setup(() => 'not json at all {');
    const r = await bad.svc.report('week');
    expect(r.insights).toBe('basic');
    expect(r.insightsNote).toContain('could not read');
    expect(r.habits.map((h) => h.key)).toEqual(['description', 'discernment']);
    env.cleanup();
    const down = setup(() => Promise.reject(new Error('429')));
    expect((await down.svc.report('week')).insightsNote).toContain('failed');
  });
});
