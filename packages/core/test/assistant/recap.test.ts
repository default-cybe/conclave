import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb, type Db } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { WorkflowStore } from '../../src/workflows/store';
import { buildRecap, recapRange } from '../../src/assistant/recap';
import { atLocal } from '../../src/assistant/time';

let db: Db;
const now = Date.parse('2026-11-05T18:00:00Z');
const at = (day: string, hour = '12:00') => atLocal(day, hour, 'America/Los_Angeles');
beforeEach(() => { db = openDb(':memory:'); new Repos(db); new WorkflowStore(db); });
afterEach(() => db.close());
function session(id: string, account = 'owner', ts = at('2026-11-03'), kind: string | null = null, parent: string | null = null) {
  db.query(`INSERT INTO sessions (id, title, agent, model, mode, permission_mode, cwd, status, created_at, updated_at, account_id, kind, parent_id)
    VALUES (?, ?, 'coder', 'test/model', 'single', 'ask', '/work/conclave', 'idle', ?, ?, ?, ?, ?)`).run(id, 'Conclave account isolation', ts, ts, account, kind, parent);
}
function memory(id: string, content: string, tags: string[], ts: number, account = 'owner', meta = {}) {
  db.query(`INSERT INTO memories (id, scope, kind, content, tags, created_at, updated_at, account_id, meta) VALUES (?, 'global', 'fact', ?, ?, ?, ?, ?, ?)`)
    .run(id, content, JSON.stringify(tags), ts, ts, account, JSON.stringify(meta));
}
function usage(id: string, account = 'owner', ts = at('2026-11-03')) {
  db.query(`INSERT INTO usage (id, ts, source, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, account_id)
    VALUES (?, ?, 'api', 'test', 'model', 100, 20, 30, 5, 10, 0.25, ?)`).run(id, ts, account);
}

describe('Reflect recap', () => {
  test('calendar boundaries use Monday and account timezone across DST and year rollover', () => {
    expect(recapRange('week', now, 'America/Los_Angeles').start).toBe(at('2026-11-02', '00:00'));
    expect(recapRange('month', now, 'America/Los_Angeles').start).toBe(at('2026-11-01', '00:00'));
    expect(recapRange('year', now, 'America/Los_Angeles').start).toBe(at('2026-01-01', '00:00'));
    expect(recapRange('week', Date.parse('2027-01-01T20:00Z'), 'UTC').start).toBe(Date.parse('2026-12-28T00:00Z'));
    expect(recapRange('week', now, 'UTC').end).toBe(now + 1);
  });

  test('counts active conversations, not subagents, and scopes every table to its account', () => {
    session('owner-code'); session('owner-chat', 'owner', at('2026-11-02'), 'chat');
    session('owner-child', 'owner', at('2026-11-03'), null, 'owner-code');
    session('old-chat', 'owner', at('2026-10-01'), 'chat');
    db.query(`INSERT INTO messages (id, session_id, seq, role, kind, content, created_at) VALUES ('msg', 'old-chat', 1, 'user', 'text', 'hello', ?)`).run(at('2026-11-04'));
    session('member-code', 'member'); usage('u'); usage('member-u', 'member'); usage('old', 'owner', at('2026-10-01'));
    db.query(`INSERT INTO workflow_runs (id, name, source, script, script_sha, device, cwd, status, session_id, created_at)
      VALUES ('w', 'review', 'inline', '', '', 'local', '', 'done', 'owner-code', ?), ('mw', 'private', 'inline', '', '', 'local', '', 'done', 'member-code', ?)`).run(at('2026-11-03'), at('2026-11-03'));
    const r = buildRecap(db, 'owner', 'week', 'America/Los_Angeles', now);
    expect(r.totals).toEqual({ chats: 2, sessions: 1, workflows: 1, tokens: 155, costUsd: 0.25, models: 1 });
    expect(r.models).toEqual([{ name: 'test/model', count: 1, tokens: 155, costUsd: 0.25 }]);
    expect(r.projects).toEqual([{ name: '/work/conclave', count: 3 }]);
    expect(r.topics).toContainEqual({ name: 'conclave', count: 3 });
    expect(r.rhythm).toMatchObject({ activeDays: 3, longestStreak: 3 });
    expect(buildRecap(db, 'member', 'week', 'America/Los_Angeles', now).totals).toMatchObject({ chats: 0, sessions: 1, workflows: 1, tokens: 155 });
  });

  test('people use earliest local memory, dedupe, and recognize imported people paths; preferences remain verbatim', () => {
    memory('old-ada', 'Ada: Research collaborator', ['person'], at('2026-10-01'));
    memory('ada', 'Ada: New note, not a new person', ['person'], at('2026-11-03'));
    memory('rosa', 'Rosa: Works on security', ['entity:person'], at('2026-11-03'));
    memory('imported', 'Lin: Project collaborator', ['imported', 'source:bm'], at('2026-11-04'));
    db.query(`INSERT INTO kv (key, value, updated_at) VALUES ('memory.import.bm', ?, ?)`).run(JSON.stringify({ 'main/entities/people/lin': { id: 'imported', hash: 'x' } }), now);
    memory('pref', 'Prefers short replies; dislikes filler.', ['kind:preference'], at('2026-11-03'));
    memory('meta-pref', 'No gradients.', [], at('2026-11-03'), 'owner', { learnedKind: 'preference' });
    memory('pending', 'Unconfirmed preference', ['preference'], at('2026-11-03'), 'owner', { review: 'pending' });
    memory('superseded', 'Old preference', ['preference'], at('2026-11-03'), 'owner', { supersededBy: 'pref' });
    memory('secret', 'Private member person', ['person'], at('2026-11-03'), 'member');
    memory('secret-pref', 'Private member preference', ['preference'], at('2026-11-03'), 'member');
    const r = buildRecap(db, 'owner', 'week', 'America/Los_Angeles', now);
    expect(r.people.map((p) => p.content)).toEqual(['Rosa: Works on security', 'Lin: Project collaborator']);
    expect(r.preferences.map((p) => p.content).sort()).toEqual(['No gradients.', 'Prefers short replies; dislikes filler.']);
    expect(JSON.stringify(r)).not.toContain('Private member');
  });

  test('empty periods have no invented rhythm or fun facts; bounds exclude future data', () => {
    session('future', 'owner', now + 1); usage('future-u', 'owner', now + 1);
    const r = buildRecap(db, 'owner', 'week', 'UTC', now);
    expect(Object.values(r.totals).every((n) => n === 0)).toBe(true);
    expect(r.rhythm).toEqual({ activeDays: 0, longestStreak: 0 });
    expect(r.facts).toEqual([]);
  });

  test('month and year include older data, week does not', () => {
    session('sunday', 'owner', at('2026-11-01'));
    session('january', 'owner', at('2026-01-15'));
    expect(buildRecap(db, 'owner', 'week', 'America/Los_Angeles', now).totals.sessions).toBe(0);
    expect(buildRecap(db, 'owner', 'month', 'America/Los_Angeles', now).totals.sessions).toBe(1);
    expect(buildRecap(db, 'owner', 'year', 'America/Los_Angeles', now).totals.sessions).toBe(2);
  });
});
