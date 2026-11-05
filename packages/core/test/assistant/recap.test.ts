/** Reflect's report numbers (assistant/recap.ts): ranges, per-account scoping, what is left out. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb, type Db } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { WorkflowStore } from '../../src/workflows/store';
import { buildReport, reflectRange } from '../../src/assistant/recap';
import { atLocal } from '../../src/assistant/time';

let db: Db;
const TZ = 'America/Los_Angeles';
const now = Date.parse('2026-11-05T18:00:00Z');
const at = (day: string, hour = '12:00') => atLocal(day, hour, TZ);
let seq = 0;
beforeEach(() => {
  db = openDb(':memory:');
  new Repos(db);
  new WorkflowStore(db);
});
afterEach(() => db.close());

function session(id: string, o: { account?: string; ts?: number; kind?: string | null; parent?: string | null; title?: string; agent?: string; cwd?: string } = {}) {
  const ts = o.ts ?? at('2026-11-03');
  db.query(
    `INSERT INTO sessions (id, title, agent, model, mode, permission_mode, cwd, status, created_at, updated_at, account_id, kind, parent_id)
     VALUES (?, ?, ?, 'test/model', 'single', 'ask', ?, 'idle', ?, ?, ?, ?, ?)`,
  ).run(id, o.title ?? 'Conclave account isolation', o.agent ?? 'coder', o.cwd ?? '/work/conclave', ts, ts, o.account ?? 'owner', o.kind ?? null, o.parent ?? null);
}
function say(sessionId: string, text: string, ts = at('2026-11-03'), role = 'user') {
  db.query(`INSERT INTO messages (id, session_id, seq, role, kind, content, created_at) VALUES (?, ?, ?, ?, 'normal', ?, ?)`).run(`m${++seq}`, sessionId, seq, role, JSON.stringify([{ type: 'text', text }]), ts);
}
function toolResult(sessionId: string, ts = at('2026-11-03')) {
  db.query(`INSERT INTO messages (id, session_id, seq, role, kind, content, created_at) VALUES (?, ?, ?, 'user', 'normal', ?, ?)`).run(`m${++seq}`, sessionId, seq, JSON.stringify([{ type: 'tool_result', tool_use_id: 't', content: 'mail body' }]), ts);
}
function usage(id: string, account = 'owner', ts = at('2026-11-03'), sessionId: string | null = null) {
  db.query(
    `INSERT INTO usage (id, ts, session_id, source, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, account_id)
     VALUES (?, ?, ?, 'api', 'test', 'model', 100, 20, 30, 5, 10, 0.25, ?)`,
  ).run(id, ts, sessionId, account);
}
function memory(id: string, content: string, tags: string[], ts: number, account = 'owner', kind = 'fact', src: string | null = null) {
  db.query(`INSERT INTO memories (id, scope, kind, content, tags, created_at, updated_at, account_id, meta, source_session_id) VALUES (?, 'global', ?, ?, ?, ?, ?, ?, '{}', ?)`).run(id, kind, content, JSON.stringify(tags), ts, ts, account, src);
}
const report = (account = 'owner', range: Parameters<typeof buildReport>[2] = 'week') => buildReport(db, account, range, TZ, now);

describe('Reflect report numbers', () => {
  test('ranges are rolling and end now, from local midnight', () => {
    expect(reflectRange('week', now, TZ).start).toBe(at('2026-10-30', '00:00'));
    expect(reflectRange('month', now, TZ).start).toBe(at('2026-10-07', '00:00'));
    expect(reflectRange('3m', now, TZ).start).toBe(at('2026-08-06', '00:00'));
    expect(reflectRange('12m', now, TZ).start).toBe(at('2025-11-06', '00:00'));
    // 31 May back 3 months: no 31 Feb, so from 1 Mar
    expect(reflectRange('3m', Date.parse('2026-05-31T12:00Z'), 'UTC').start).toBe(Date.parse('2026-03-01T00:00Z'));
    expect(reflectRange('week', now, TZ).end).toBe(now + 1);
  });

  test('every number is the account\'s own; a member sees none of the owner\'s', () => {
    session('o1', { title: 'Owner secret roadmap' });
    session('o2', { kind: 'chat', ts: at('2026-11-02') });
    session('child', { parent: 'o1', agent: 'reviewer' });
    say('o1', 'start the roadmap');
    say('o1', 'no, use the other branch', at('2026-11-03', '23:30'));
    toolResult('o1');
    usage('u1', 'owner', at('2026-11-03'), 'o1');
    session('m1', { account: 'mia', title: 'Mia garden planning', cwd: '/home/mia/garden' });
    say('m1', 'plan the tomatoes');
    usage('u2', 'mia', at('2026-11-03'), 'm1');
    memory('mp', 'Ada: Mia\'s neighbour', ['person'], at('2026-11-03'), 'mia');

    const own = report().report;
    expect(own.totals).toMatchObject({ chats: 1, sessions: 1, tokens: 155, costUsd: 0.25, projects: 1 });
    expect(own.rhythm.messages).toBe(2); // the tool result is not a message you typed
    expect(own.rhythm.lateNightShare).toBe(0.5);
    expect(own.habits.map((h) => h.key)).toContain('discernment');
    expect(own.habits.find((h) => h.key === 'delegation')?.example).toContain('reviewer');
    expect(JSON.stringify(own)).not.toMatch(/Mia|garden|tomatoes|Ada/);

    const { report: hers, material } = report('mia');
    expect(hers.totals).toMatchObject({ chats: 0, sessions: 1, tokens: 155 });
    expect(hers.fun.newPeople).toEqual(['Ada']);
    expect(JSON.stringify(hers) + material).not.toMatch(/roadmap|other branch/);
  });

  test('health sessions and their subagents are left out and counted for the footnote', () => {
    session('h', { title: 'Night skincare and hair', kind: 'chat' });
    session('hc', { parent: 'h' });
    session('ok', { title: 'Proxmox health check script' });
    say('h', 'which serum');
    usage('hu', 'owner', at('2026-11-03'), 'h');
    const { report: r, material } = report();
    expect(r.excluded.health).toBe(1);
    expect(r.totals).toMatchObject({ chats: 0, sessions: 1, tokens: 0 });
    expect(material).not.toMatch(/skincare|serum/);
    expect(material).toContain('Proxmox health check');
  });

  test('incognito sessions are left out when the column exists', () => {
    db.exec('ALTER TABLE sessions ADD COLUMN incognito INTEGER');
    session('secret', { title: 'Private thing', kind: 'chat' });
    db.exec(`UPDATE sessions SET incognito = 1 WHERE id = 'secret'`);
    say('secret', 'hush');
    session('open', { title: 'Open thing' });
    const { report: r, material } = report();
    expect(r.excluded.incognito).toBe(1);
    expect(r.totals.chats).toBe(0);
    expect(material).not.toContain('Private thing');
  });

  test('ranges: a week leaves out older work, 12 months keeps it', () => {
    session('recent');
    session('old', { ts: at('2026-03-10'), title: 'Old canvas work' });
    say('old', 'hi', at('2026-03-10'));
    expect(report('owner', 'week').report.totals.sessions).toBe(1);
    expect(report('owner', 'month').report.totals.sessions).toBe(1);
    expect(report('owner', '12m').report.totals.sessions).toBe(2);
    expect(report('owner', '12m').report.rhythm.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('an empty range has no invented habits, suggestions or fun', () => {
    session('future', { ts: now + 10 });
    const r = report().report;
    expect(r.totals).toMatchObject({ chats: 0, sessions: 0, tokens: 0 });
    expect(r.habits).toEqual([]);
    expect(r.suggestions).toEqual([]);
    expect(r.headline).toContain('nothing yet');
  });

  test('summaries of a mail-reading agent never reach the model', () => {
    session('mail', { agent: 'email', title: 'Inbox triage' });
    session('code', { title: 'Fix tests' });
    say('mail', 'triage');
    say('code', 'go');
    memory('e1', 'Read mail from bob about the merger', [], at('2026-11-03'), 'owner', 'episode', 'mail');
    memory('e2', 'Fixed the flaky test', [], at('2026-11-03'), 'owner', 'episode', 'code');
    const { material } = buildReport(db, 'owner', 'week', TZ, now, { untrustedAgent: (n) => n === 'email' });
    expect(material).toContain('Inbox triage');
    expect(material).not.toContain('merger');
    expect(material).toContain('Fixed the flaky test');
  });
});
