/**
 * Reflect's Learnings (assistant/learnings.ts): the quick check, the batched
 * model check with a scripted model, dedupe against memory and repeats,
 * per-account queues, and nothing written before Save.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BATCH, LearningsService, STALE_MS, candidatesFrom, cueOf, diffLines, likeness, parseCheck, parseIdeas, type LearnHost } from '../../src/assistant/learnings';
import { LearnedSkills } from '../../src/extensions/learned';
import { SqliteMemory } from '../../src/memory/store';
import { accountKv } from '../../src/people/scoped';
import type { Message } from '../../src/types';
import { makeAssistant } from './helpers';
import { tempHome } from '../memory/helpers';

let env: ReturnType<typeof makeAssistant>;
let home: ReturnType<typeof tempHome>;
afterEach(() => {
  env?.cleanup();
  home?.cleanup();
});

let seq = 0;
const user = (sessionId: string, text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++seq}`, sessionId, seq, role: 'user', kind: 'normal', content: [{ type: 'text', text }], createdAt: 1, ...extra });
const bot = (sessionId: string, text: string, skill?: string): Message => ({
  id: `m${++seq}`,
  sessionId,
  seq,
  role: 'assistant',
  kind: 'normal',
  content: [{ type: 'text', text }, ...(skill ? [{ type: 'tool_use' as const, id: 't', name: 'Skill', input: { skill } }] : [])],
  createdAt: 1,
});

function setup(script: (prompt: string) => string, accountId = 'owner') {
  let clock = Date.parse('2026-11-05T18:00:00Z');
  env = makeAssistant({ now: () => clock });
  home = tempHome();
  const calls: string[] = [];
  const agents: Record<string, string> = { coder: 'You write code.' };
  const files: Record<string, string> = {};
  const skills = new LearnedSkills(home.dir);
  skills.create({ name: 'pbs-restore-test', description: 'Restore a PBS backup into a scratch CT and check it boots.', body: '## Steps\n\n1. Restore.\n\n## Pitfalls\n\n- Old pitfall.' });
  const trusted = new Set(['/w/app']);
  const learn: LearnHost = {
    skills: () => skills,
    agentPrompt: (n) => agents[n],
    saveAgentPrompt: async (n, p) => void (agents[n] = p),
    projectRefusal: (cwd) => (trusted.has(cwd) ? undefined : 'Trust this folder first.'),
    projectFile: (cwd) => ({ path: join(cwd, 'CONCLAVE.md'), read: async () => files[cwd], write: async (t) => void (files[cwd] = t) }),
  };
  const memory = accountId === 'owner' ? env.memory : new SqliteMemory({ db: env.db, bus: env.bus, config: env.config, complete: async () => '{}', now: () => clock, accountId });
  const svc = new LearningsService({ db: env.db, kv: accountKv(env.repos.kv, accountId), accountId, memory, routines: env.routines, learn, now: () => clock, complete: async (o) => (calls.push(o.prompt), script(o.prompt)) });
  return { svc, calls, agents, files, skills, memory, tick: (ms: number) => (clock += ms) };
}

const reply = (items: unknown[]) => JSON.stringify({ items });

describe('quick check', () => {
  test('catches corrections, preferences, remember and praise; lets plain requests and questions through without a model', () => {
    expect(cueOf('no, use pnpm not npm')).toBe('correction');
    expect(cueOf('actually the tests live in packages/core/test')).toBe('correction');
    expect(cueOf('remember: my hub is called conclave')).toBe('remember');
    expect(cueOf('from now on write commit messages in English')).toBe('remember');
    expect(cueOf('I prefer short answers')).toBe('preference');
    expect(cueOf('perfect, exactly like that')).toBe('positive');
    expect(cueOf('nein, bitte immer pnpm')).toBe('correction');
    expect(cueOf('いつも日本語で答えて')).toBe('other'); // another script: the model reads it
    expect(cueOf('fix the failing test in auth.ts')).toBeUndefined();
    expect(cueOf('what does this function do?')).toBeUndefined();
    expect(cueOf('/compact')).toBeUndefined();
  });

  test('reads only what the account typed: no tool results, reminders, quoted or other accounts\' messages; notes the running skill', () => {
    const msgs = [
      bot('s1', 'Restoring now.', 'pbs-restore-test'),
      user('s1', 'no, always restore into CT 9000'),
      user('s1', 'no, this is a tool result', { content: [{ type: 'tool_result', toolUseId: 't', content: 'no, x' }] as never }),
      user('s1', '<system-reminder>no, never</system-reminder>'),
      user('s1', 'no, from a member', { sender: 'account:bob' }),
      user('s1', 'no, quoted', { meta: { quoted: { from: "Alice's hub", fingerprint: 'f', shareId: 'x', role: 'user', kind: 'normal' } } }),
    ];
    const c = candidatesFrom(msgs, { afterSeq: -1, accountId: 'owner', now: 1 });
    expect(c.map((x) => x.text)).toEqual(['no, always restore into CT 9000']);
    expect(c[0]).toMatchObject({ cue: 'correction', skill: 'pbs-restore-test', before: 'Restoring now.' });
  });

  test('the model check drops one-off items, orders become facts, secrets and health stay out', () => {
    const cands = candidatesFrom([user('s', 'no, always use pnpm'), user('s', 'no, the other file'), user('s', 'remember my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789'), user('s', 'never mention my diet')], { afterSeq: -1, accountId: 'owner', now: 1 });
    const out = parseCheck(
      reply([
        { i: 0, kind: 'correction', fact: 'Always use pnpm.', rule: 'Use pnpm, not npm.', confidence: 0.9 },
        { i: 1, kind: 'correction', fact: 'The user wanted the other file.', rule: 'x', confidence: 0.2 },
        { i: 2, kind: 'remember', fact: 'The user keeps a GitHub token.', rule: 'x', confidence: 0.9 },
        { i: 3, kind: 'preference', fact: 'The user does not want diet talk.', rule: 'x', confidence: 0.9 },
        { i: 9, kind: 'remember', fact: 'Out of range index item.', rule: 'x', confidence: 0.9 },
      ]),
      cands,
    )!;
    expect(out).toHaveLength(1);
    expect(out[0].fact).toMatch(/^The user /);
    expect(out[0].rule).toBe('Use pnpm, not npm.');
    expect(parseCheck('not json', cands)).toBeUndefined();
  });
});

describe('queue', () => {
  test('one model call per batch, never per message; repeats merge with a count', async () => {
    const { svc, calls } = setup(() => reply([{ i: 0, kind: 'correction', fact: 'The user prefers pnpm over npm.', rule: 'Use pnpm, not npm.', confidence: 0.9 }]));
    for (let i = 0; i < BATCH - 1; i++) svc.capture('s1', [user('s1', `no, use pnpm not npm (${i})`)]);
    expect(calls).toHaveLength(0);
    svc.capture('s1', [user('s1', 'no, use pnpm not npm again')]);
    await svc.check();
    expect(calls).toHaveLength(1);
    expect((await svc.list()).items).toHaveLength(1);
    // the same lesson in another batch adds to the count
    for (let i = 0; i < BATCH; i++) svc.capture('s2', [user('s2', `no, pnpm please (${i})`)]);
    await svc.check();
    const l = await svc.list();
    expect(l.items).toHaveLength(1);
    expect(l.items[0].count).toBe(2);
    expect(l.items[0].quote).toContain('pnpm');
    expect(l.items[0].targets.map((t) => t.target)).toEqual(['memory']);
  });

  test('a quiet session is checked after STALE_MS; the same message is never captured twice', async () => {
    const { svc, calls, tick } = setup(() => reply([]));
    const m = user('s1', 'remember: the hub is called conclave');
    svc.capture('s1', [m]);
    svc.capture('s1', [m]);
    expect(svc.due()).toBe(false);
    tick(STALE_MS);
    expect(svc.due()).toBe(true);
    await svc.check();
    expect(calls).toHaveLength(1);
    expect(calls[0].match(/the hub is called conclave/g)).toHaveLength(1);
  });

  test('what auto-extraction or memory already holds is not queued again', async () => {
    const { svc, memory, calls } = setup(() => reply([{ i: 0, kind: 'preference', fact: 'The user prefers short answers.', rule: 'Answer briefly.', confidence: 0.9 }]));
    await memory.save({ content: 'The user prefers short answers.', kind: 'profile', sourceSessionId: 's1' });
    for (let i = 0; i < BATCH; i++) svc.capture('s1', [user('s1', `I prefer short answers ${i}`)]);
    await svc.check();
    expect(calls[0]).toContain('<already-saved>\n- The user prefers short answers.');
    expect((await svc.list()).items).toHaveLength(0);
  });

  test('each account has its own queue', async () => {
    const owner = setup(() => reply([{ i: 0, kind: 'correction', fact: 'The user prefers tabs over spaces.', rule: 'Use tabs.', confidence: 0.9 }]));
    for (let i = 0; i < BATCH; i++) owner.svc.capture('s1', [user('s1', `no, tabs ${i}`)]);
    await owner.svc.check();
    const bob = new LearningsService({ db: env.db, kv: accountKv(env.repos.kv, 'acct_bob'), accountId: 'acct_bob', memory: owner.memory, now: Date.now });
    expect(bob.count()).toBe(0);
    expect(owner.svc.count()).toBe(1);
    // the owner's message as seen from bob's account is not bob's words
    expect(candidatesFrom([user('s1', 'no, tabs', { sender: 'account:owner' })], { afterSeq: -1, accountId: 'acct_bob', now: 1 })).toHaveLength(0);
  });
});

describe('review', () => {
  async function withItem(extra: { agent?: string; cwd?: string; skill?: boolean } = {}) {
    const s = setup(() => reply([{ i: 0, kind: 'correction', fact: 'The user restores PBS backups into CT 9000.', rule: 'Restore into CT 9000.', confidence: 0.9 }]));
    const msgs: Message[] = [];
    if (extra.skill) msgs.push(bot('s1', 'Restoring.', 'pbs-restore-test'));
    for (let i = 0; i < BATCH; i++) msgs.push(user('s1', `no, restore into CT 9000 (${i})`));
    s.svc.capture('s1', msgs, { agent: extra.agent, cwd: extra.cwd, title: 'Restore test' });
    await s.svc.check();
    const id = (await s.svc.list()).items[0].id;
    return { ...s, id };
  }

  test('nothing is written before Save; Skip writes nothing', async () => {
    const { svc, id, memory, agents, files, skills } = await withItem({ agent: 'coder', cwd: '/w/app', skill: true });
    const before = memory.stats().total;
    const skillBody = skills.get('pbs-restore-test')!.body;
    const l = await svc.list();
    expect(l.items[0].targets.map((t) => t.target)).toEqual(['memory', 'agent', 'project', 'skill']);
    const p = await svc.preview(id, { target: 'project' });
    expect(p.path).toBe('/w/app/CONCLAVE.md');
    expect(p.diff).toContain('+ - Restore into CT 9000.');
    await svc.skip(id);
    expect(memory.stats().total).toBe(before);
    expect(agents.coder).toBe('You write code.');
    expect(files['/w/app']).toBeUndefined();
    expect(skills.get('pbs-restore-test')!.body).toBe(skillBody);
    expect(svc.count()).toBe(0);
    await expect(svc.save(id, { target: 'memory' })).rejects.toThrow('already skipped');
  });

  test('Save to memory writes a fact; a simple order is rewritten, any other refused; the item leaves the queue', async () => {
    const { svc, id, memory } = await withItem();
    await expect(svc.save(id, { target: 'memory', text: 'Always restore into CT 9000.' })).rejects.toThrow('Write it as a fact');
    expect(svc.count()).toBe(1);
    await svc.save(id, { target: 'memory', text: 'Always use CT 9000 for restores.' });
    const saved = memory.list({ kind: 'fact' }).find((m) => m.tags.includes('learning'))!;
    expect(saved.content).toMatch(/^The user /);
    expect(saved.sourceSessionId).toBe('s1');
    expect(svc.count()).toBe(0);
  });

  test('Save to the agent, the project or the skill appends under the right heading', async () => {
    let s = await withItem({ agent: 'coder', cwd: '/w/app', skill: true });
    await s.svc.save(s.id, { target: 'agent' });
    expect(s.agents.coder).toBe('You write code.\n\n## Learned\n\n- Restore into CT 9000.\n');
    s = await withItem({ cwd: '/w/app', skill: true });
    await s.svc.save(s.id, { target: 'project' });
    expect(s.files['/w/app']).toBe('## Learned\n\n- Restore into CT 9000.\n');
    s = await withItem({ skill: true });
    await s.svc.save(s.id, { target: 'skill' });
    expect(readFileSync(s.skills.get('pbs-restore-test')!.path, 'utf8')).toContain('- Old pitfall.\n- Restore into CT 9000.');
  });

  test('an untrusted folder is refused, even on a direct call', async () => {
    const { svc, id, files } = await withItem({ cwd: '/w/untrusted' });
    expect((await svc.list()).items[0].targets.find((t) => t.target === 'project')!.refused).toContain('Trust');
    await expect(svc.save(id, { target: 'project' })).rejects.toThrow('Trust');
    expect(files['/w/untrusted']).toBeUndefined();
  });

  test('a near memory is offered for merge, and merge updates it instead of adding one', async () => {
    const { svc, id, memory } = await withItem();
    const old = await memory.save({ content: 'The user restores PBS backups into a scratch CT.', kind: 'fact' });
    const l = await svc.list();
    expect(l.items[0].similar.map((x) => x.ref)).toContain(old.id);
    const total = memory.stats().total;
    await svc.save(id, { target: 'memory', mergeInto: old.id, text: 'The user restores PBS backups into CT 9000.' });
    expect(memory.stats().total).toBe(total);
    expect(memory.get(old.id)!.content).toBe('The user restores PBS backups into CT 9000.');
  });
});

describe('skill ideas', () => {
  test('ideas need three sessions and a valid skill; Save writes the skill, only on the press', async () => {
    const list = [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }];
    const good = { kind: 'skill', name: 'weekly-expense-sum', description: 'Sum the week\'s expenses from mail into one line.', body: '## Steps\n\n1. Search mail for receipts.\n2. Sum them.', sessions: [0, 1, 2] };
    const ideas = parseIdeas(JSON.stringify({ ideas: [good, { ...good, name: 'too-few', sessions: [0, 1] }, { ...good, name: 'Bad Name' }] }), list);
    expect(ideas.map((i) => i.name)).toEqual(['weekly-expense-sum']);
    expect(ideas[0].examples).toEqual(['a', 'b', 'c']);

    const s = setup(() => JSON.stringify({ ideas: [good] }));
    const now = Date.parse('2026-11-05T18:00:00Z');
    for (let i = 0; i < 6; i++) {
      env.db.query(`INSERT INTO sessions (id, title, agent, model, mode, permission_mode, cwd, status, created_at, updated_at, account_id, kind) VALUES (?, ?, 'chat', 'm', 'single', 'ask', '/w', 'idle', ?, ?, 'owner', 'chat')`).run(`x${i}`, `Expenses ${i}`, now - 3600_000, now);
      env.db.query(`INSERT INTO messages (id, session_id, seq, role, kind, content, created_at) VALUES (?, ?, 1, 'user', 'normal', ?, ?)`).run(`xm${i}`, `x${i}`, JSON.stringify([{ type: 'text', text: 'sum my expenses this week' }]), now);
    }
    const found = await s.svc.findIdeas();
    expect(s.calls[0]).toContain('Expenses 0 | sum my expenses this week');
    expect(found.ideas).toHaveLength(1);
    expect(s.skills.get('weekly-expense-sum')).toBeUndefined();
    const after = await s.svc.saveIdea(found.ideas[0].id);
    expect(s.skills.get('weekly-expense-sum')).toBeDefined();
    expect(after.ideas).toHaveLength(0);
  });
});

test('likeness and diff', () => {
  expect(likeness('The user prefers pnpm over npm.', 'The user prefers pnpm, not npm')).toBeGreaterThanOrEqual(0.6);
  expect(likeness('The user prefers pnpm.', 'The hub runs Proxmox.')).toBe(0);
  expect(diffLines('a\nb', 'a\nb\n\n## Learned\n\n- x')).toEqual(['  a', '  b', '+ ', '+ ## Learned', '+ ', '+ - x']);
});
