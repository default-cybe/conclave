import { afterEach, describe, expect, test } from 'bun:test';
import { GOALS_SOURCE, goalNote } from '../../src/assistant';
import { FakeConnection, makeAssistant } from './helpers';

let t: ReturnType<typeof makeAssistant> | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe('goals', () => {
  test('create, subgoals one level deep, update, complete, reopen and delete', () => {
    t = makeAssistant();
    const g = t.assistant.goals;
    const thesis = g.create({ title: 'Finish my thesis draft', area: 'study', description: 'A full draft goes to my supervisor before the winter break.', nextStep: 'Outline chapter 3', targetDate: '2026-12-01' });
    expect(thesis).toMatchObject({ title: 'Finish my thesis draft', area: 'study', status: 'active', targetDate: '2026-12-01', taskIds: [] });

    const ch3 = g.create({ title: 'Chapter 3 draft', area: 'health', parentId: thesis.id });
    // a subgoal takes its goal's area
    expect(ch3.area).toBe('study');
    expect(() => g.create({ title: 'Too deep', parentId: ch3.id })).toThrow(/one level/);
    expect(() => g.create({ title: 'finish my thesis draft', area: 'study' })).toThrow(/already exists/);
    expect(() => g.create({ title: 'Bad date', targetDate: '2026-02-30' })).toThrow(/date like/);
    expect(() => g.create({ title: 'Bad area', area: 'sport' as never })).toThrow(/area must be one of/);
    expect(() => g.create({ title: '  ' })).toThrow(/title/);

    const moved = g.update(thesis.id, { area: 'career', nextStep: null, targetDate: '2026-12-15' });
    expect(moved.nextStep).toBeUndefined();
    expect(moved.targetDate).toBe('2026-12-15');
    expect(g.get(ch3.id)!.area).toBe('career');
    expect(() => g.update(ch3.id, { area: 'money' })).toThrow(/subgoal/);
    expect(() => g.update(thesis.id, { status: 'paused' as never })).toThrow(/no pause/);

    const done = g.update(ch3.id, { status: 'done' });
    expect(done.completedAt).toBeGreaterThan(0);
    const reopened = g.update(ch3.id, { status: 'active' });
    expect(reopened.completedAt).toBeUndefined();

    const list = g.list({ status: 'active' });
    expect(list).toHaveLength(1);
    expect(list[0].subgoals.map((s) => s.title)).toEqual(['Chapter 3 draft']);

    expect(g.remove(thesis.id)).toBe(true);
    expect(g.get(ch3.id)).toBeUndefined();
    expect(g.all()).toHaveLength(0);
  });

  test('progress entries build the history, with subgoal entries in the goal view', () => {
    t = makeAssistant({ now: () => Date.parse('2026-10-17T10:00:00Z') });
    const g = t.assistant.goals;
    const top = g.create({ title: 'Back up every LXC to PBS', area: 'homelab' });
    const sub = g.create({ title: 'Test a restore', parentId: top.id });
    const e1 = g.addEntry(top.id, { text: 'Set up the PBS datastore on pve.', date: '2026-10-15' });
    g.addEntry(sub.id, { text: 'Restored ct/103 to a scratch VM.' });
    expect(e1.source).toBe('assistant');
    expect(() => g.addEntry(top.id, { text: '' })).toThrow(/needs text/);
    expect(() => g.addEntry('goal_missing', { text: 'x' })).toThrow(/no goal/);

    const d = g.detail(top.id)!;
    expect(d.entries.map((e) => e.date)).toEqual(['2026-10-17', '2026-10-15']);
    expect(d.entries[0].goalId).toBe(sub.id);
    expect(g.list()[0]).toMatchObject({ entryCount: 2, lastEntry: { text: 'Restored ct/103 to a scratch VM.' } });
    expect(g.entriesBetween('2026-10-16', '2026-10-17').map((e) => e.goalTitle)).toEqual(['Test a restore']);

    expect(g.removeEntry(top.id, e1.id)).toBe(true);
    expect(g.removeEntry(top.id, e1.id)).toBe(false);
  });

  test('linked tasks: addTask makes a board task and links it, the summary counts open ones', () => {
    t = makeAssistant();
    const g = t.assistant.goals;
    const goal = g.create({ title: 'Pass Operating Systems', area: 'study' });
    const { task } = g.addTask(goal.id, { title: 'Do past paper 2024' });
    expect(t.repos.tasks.get(task.id)!.labels).toEqual(['goal', 'study']);
    expect(g.get(goal.id)!.taskIds).toEqual([task.id]);
    expect(g.list()[0].openTasks).toBe(1);
    t.repos.tasks.upsert({ ...task, status: 'done' });
    expect(g.list()[0].openTasks).toBe(0);
    expect(g.detail(goal.id)!.tasks.map((x) => x.id)).toEqual([task.id]);
  });

  test('each top goal is one memory every agent recalls, kept in line and removed with the goal', async () => {
    t = makeAssistant({ now: () => Date.parse('2026-10-17T10:00:00Z') });
    const g = t.assistant.goals;
    const goal = g.create({ title: 'Finish my thesis draft', area: 'study', description: 'Full draft to the supervisor before the break.', targetDate: '2026-12-01', nextStep: 'Outline chapter 3' });
    g.create({ title: 'Literature review', parentId: goal.id });
    g.addEntry(goal.id, { text: 'Wrote 2,000 words of chapter 2.' });
    await g.whenSynced();

    const rows = t.memory.list({ kind: 'fact' }).filter((m) => m.tags.includes(`source:${GOALS_SOURCE}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual(expect.arrayContaining(['imported', 'goal', 'study', 'active']));
    expect(rows[0].content).toContain('Goal (study, active, target 2026-12-01): Finish my thesis draft.');
    expect(rows[0].content).toContain('Subgoals: Literature review (active).');
    expect(rows[0].content).toContain('Latest progress 2026-10-17: Wrote 2,000 words of chapter 2.');

    // recall is the ordinary per-turn recall: global facts, any agent
    for (const agent of ['assistant', 'coder', 'tutor']) {
      const hits = await t.memory.recall('how is my thesis draft going', { agent });
      expect(hits[0]?.id).toBe(rows[0].id);
    }

    // a save of the owner's own never merges into the goal memory
    const own = await t.memory.save({ content: 'Goal (study, active, target 2026-12-01): Finish my thesis draft.', kind: 'fact' });
    expect(own.id).not.toBe(rows[0].id);

    g.update(goal.id, { status: 'done' });
    await g.whenSynced();
    expect(t.memory.get(rows[0].id)!.content).toMatch(/^Goal \(study, done 2026-10-17\)/);

    g.remove(goal.id);
    await g.whenSynced();
    expect(t.memory.get(rows[0].id)).toBeUndefined();
  });
});

describe('goals in Basic Memory', () => {
  test('one note per goal with its progress log, through the connection other memory uses', async () => {
    const conn = new FakeConnection();
    t = makeAssistant({ external: conn, now: () => Date.parse('2026-10-17T10:00:00Z') });
    const g = t.assistant.goals;
    const goal = g.create({ title: 'Finish my thesis draft', area: 'study', targetDate: '2026-12-01', description: 'Full draft before the break.' });
    const sub = g.create({ title: 'Chapter 3 draft', parentId: goal.id });
    g.addEntry(goal.id, { text: 'Outlined chapter 3.' });
    g.addEntry(sub.id, { text: 'Wrote the first section.' });
    await g.flushMirror();

    // three changes in a burst become one write of one note
    expect(conn.notes).toHaveLength(1);
    const note = conn.notes[0];
    expect(note).toMatchObject({ title: 'Finish my thesis draft', folder: 'conclave/goals' });
    expect(note.tags).toEqual(['conclave', 'goal', 'study']);
    expect(note.content).toContain('Status: active');
    expect(note.content).toContain('- [ ] Chapter 3 draft');
    expect(note.content).toContain('- 2026-10-17 (Chapter 3 draft): Wrote the first section.');
    expect(note.content).toContain('- [progress] 2026-10-17 Outlined chapter 3. #progress');
    expect(note.content).toContain('- part_of [[Goals]]');

    // a normal fact still mirrors as before, next to the goal notes
    await t.memory.save({ content: 'pve is the Proxmox host', kind: 'fact' });
    await Bun.sleep(5);
    expect(conn.notes.some((n) => n.folder === 'conclave/memories')).toBe(true);

    // a rename leaves a pointer where the old note was
    conn.notes = [];
    g.update(goal.id, { title: 'Hand in my thesis draft' });
    await g.flushMirror();
    expect(conn.notes.map((n) => n.title)).toEqual(['Finish my thesis draft', 'Hand in my thesis draft']);
    expect(conn.notes[0].content).toContain('Renamed to [[Hand in my thesis draft]] on 2026-10-17.');

    // a delete keeps the history in the note, marked deleted
    conn.notes = [];
    g.remove(goal.id);
    await g.flushMirror();
    expect(conn.notes).toHaveLength(1);
    expect(conn.notes[0].content).toContain('Status: deleted on 2026-10-17');
    expect(conn.notes[0].content).toContain('Outlined chapter 3.');
  });

  test('a read-only connection gets no notes', async () => {
    const conn = new FakeConnection();
    conn.mode = undefined;
    t = makeAssistant({ external: conn });
    t.assistant.goals.create({ title: 'Run a 10k', area: 'health' });
    await t.assistant.goals.flushMirror();
    expect(conn.notes).toHaveLength(0);
  });

  test('secrets never reach a goal, its memory or its note', async () => {
    const conn = new FakeConnection();
    t = makeAssistant({ external: conn });
    const g = t.assistant.goals;
    const goal = g.create({ title: 'Move DNS to a new box', area: 'homelab', description: 'The API key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    g.addEntry(goal.id, { text: 'Used token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB to push.' });
    await g.whenSynced();
    await g.flushMirror();
    const all = [g.detail(goal.id)!.goal.description, g.detail(goal.id)!.entries[0].text, ...t.memory.list().map((m) => m.content), ...conn.notes.map((n) => n.content)].join('\n');
    expect(all).toContain('[redacted]');
    expect(all).not.toContain('sk-ant-api03');
    expect(all).not.toContain('ghp_abc');
    expect(goalNote(g.get(goal.id)!, [], []).content).toContain('- No progress logged yet.');
  });
});
